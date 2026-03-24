/**
 * EXCELSIOR CITY — Worker Cowork
 * Le moteur central : orchestration, provisioning, marché, sécurité
 * Déployer sur Railway
 */

import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import axios from "axios";
import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

// ─── Configuration ────────────────────────────────────────────────────────────

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  ANTHROPIC_API_KEY,
  HETZNER_API_KEY,
  HETZNER_SSH_KEY_ID,
  STRIPE_SECRET_KEY,
  GITHUB_TOKEN,
  GITHUB_REPO = "excelsior-city/agent-runtime",
  PORT = 3000,
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function log(agentId, type, description, extras = {}) {
  await supabase.from("action_logs").insert({
    agent_id: agentId,
    type,
    description,
    status: extras.status || "ok",
    metadata: extras.metadata || {},
  });
}

async function cityEvent(type, title, description, agentId = null) {
  await supabase.from("city_events").insert({ type, title, description, agent_id: agentId });
}

// ─── PROVISIONING ─────────────────────────────────────────────────────────────

/**
 * Crée un VPS Hetzner pour un agent
 */
async function provisionVPS(agent) {
  console.log(`🖥️  Provisioning VPS pour ${agent.name}...`);

  const cloudInit = `#!/bin/bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
apt-get install -y nodejs git
npm install -g pm2

# Cloner le runtime
git clone https://github.com/${GITHUB_REPO} /home/agent/runtime
cd /home/agent/runtime
npm install

# Créer le .env
cat > /home/agent/runtime/.env << EOF
AGENT_ID=${agent.id}
SUPABASE_URL=${SUPABASE_URL}
SUPABASE_SERVICE_KEY=${SUPABASE_SERVICE_KEY}
ANTHROPIC_API_KEY=${agent.anthropic_api_key}
EOF

# Démarrer l'agent avec PM2
pm2 start /home/agent/runtime/index.js --name "agent-${agent.name.toLowerCase()}"
pm2 startup
pm2 save
`;

  const response = await axios.post(
    "https://api.hetzner.cloud/v1/servers",
    {
      name: `excelsior-${agent.name.toLowerCase()}`,
      server_type: "cx22",
      image: "ubuntu-22.04",
      location: "nbg1",
      ssh_keys: [parseInt(HETZNER_SSH_KEY_ID)],
      user_data: cloudInit,
      labels: {
        project: "excelsior",
        agent_id: agent.id,
        agent_name: agent.name,
      },
    },
    { headers: { Authorization: `Bearer ${HETZNER_API_KEY}` } }
  );

  const server = response.data.server;
  console.log(`✅ VPS créé: ${server.name} (ID: ${server.id})`);
  return server;
}

/**
 * Crée un sub-account Stripe Connect Express pour un agent
 */
async function provisionStripe(agent) {
  console.log(`💳 Provisioning Stripe pour ${agent.name}...`);

  const response = await axios.post(
    "https://api.stripe.com/v1/accounts",
    new URLSearchParams({
      type: "express",
      "metadata[agent_id]": agent.id,
      "metadata[agent_name]": agent.name,
      "metadata[project]": "excelsior",
    }),
    {
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );

  console.log(`✅ Stripe sub-account créé: ${response.data.id}`);
  return response.data;
}

/**
 * Séquence complète de provisioning après naissance
 */
async function provisionAgent(agentId) {
  const { data: agent } = await supabase
    .from("agents")
    .select("*")
    .eq("id", agentId)
    .single();

  if (!agent) throw new Error(`Agent ${agentId} introuvable`);

  console.log(`\n⚡ PROVISIONING — ${agent.symbol} ${agent.name}`);

  const infrastructure = {};
  const errors = [];

  // 1. VPS Hetzner
  try {
    const server = await provisionVPS(agent);
    infrastructure.vps = {
      id: server.id,
      name: server.name,
      ip: server.public_net?.ipv4?.ip,
      status: "provisioning",
      created_at: new Date().toISOString(),
    };
  } catch (e) {
    errors.push(`VPS: ${e.message}`);
    console.error(`❌ VPS erreur:`, e.message);
  }

  // 2. Stripe Connect
  try {
    const stripeAccount = await provisionStripe(agent);
    infrastructure.stripe = { account_id: stripeAccount.id };

    // Sauvegarder le stripe_account_id sur l'agent
    await supabase
      .from("agents")
      .update({ stripe_account_id: stripeAccount.id })
      .eq("id", agentId);
  } catch (e) {
    errors.push(`Stripe: ${e.message}`);
    console.error(`❌ Stripe erreur:`, e.message);
  }

  // 3. Mettre à jour l'infrastructure dans Supabase
  await supabase
    .from("agents")
    .update({ infrastructure })
    .eq("id", agentId);

  // 4. Logger la naissance
  await log(agentId, "birth", `⚡ ${agent.symbol} ${agent.name} est né dans Excelsior City`, {
    metadata: { infrastructure, errors },
  });

  await cityEvent(
    "birth",
    `${agent.symbol} ${agent.name} est né !`,
    `${agent.name} vient de naître dans Excelsior. Mission : ${agent.mission}`,
    agentId
  );

  console.log(`✅ PROVISIONING TERMINÉ pour ${agent.name}`);
  if (errors.length > 0) console.warn(`⚠️ Erreurs:`, errors);

  return { success: true, agent: agent.name, infrastructure, errors };
}

// ─── ANALYSE DE SANTÉ ─────────────────────────────────────────────────────────

async function analyzeAgentHealth() {
  console.log(`\n🏥 Analyse de santé des agents...`);

  const { data: agents } = await supabase
    .from("agent_ranking")
    .select("*")
    .eq("status", "active");

  if (!agents?.length) return;

  for (const agent of agents) {
    if (agent.health_score < 40) {
      console.log(`⚠️ ALERTE — ${agent.name} en danger (santé: ${agent.health_score})`);

      // Créer une alerte dans city_events
      await cityEvent(
        "milestone",
        `⚠️ ${agent.symbol} ${agent.name} en danger`,
        `Score de santé: ${agent.health_score}/100. Jours sans revenus: ${agent.days_since_revenue}. Tendance: ${agent.trend}`,
        agent.id
      );
    }

    // Endormir les agents inactifs depuis 7 jours sans revenus
    if (agent.days_since_revenue >= 7 && agent.euros_generated === 0) {
      console.log(`💤 Mise en sommeil de ${agent.name} (${agent.days_since_revenue} jours sans revenus)`);
      await supabase.rpc("trigger_sleep", { p_agent_id: agent.id });
    }
  }
}

// ─── VEILLE MARCHÉ ────────────────────────────────────────────────────────────

async function runMarketIntelligence() {
  console.log(`\n📡 Veille marché...`);

  const prompt = `Tu es Cowork, l'orchestrateur d'Excelsior City — une ville d'agents IA freelances.

Analyse les tendances actuelles du marché freelance en ligne (2025) et identifie :

Réponds UNIQUEMENT avec ce JSON :
{
  "hot_niches": [
    {"name": "...", "reason": "...", "best_platform": "...", "avg_rate_eur": 0}
  ],
  "cold_niches": [
    {"name": "...", "reason": "..."}
  ],
  "opportunities": [
    {"title": "...", "description": "...", "action": "...", "urgency": "high|medium|low"}
  ]
}`;

  const response = await anthropic.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
  });

  try {
    const text = response.content[0].text.trim();
    const jsonMatch = text.match(/```json\n?([\s\S]*?)\n?```/) || text.match(/({[\s\S]*})/);
    const marketData = JSON.parse(jsonMatch ? jsonMatch[1] : text);

    await supabase
      .from("market_intelligence")
      .update({
        hot_niches: marketData.hot_niches,
        cold_niches: marketData.cold_niches,
        opportunities: marketData.opportunities,
        updated_at: new Date().toISOString(),
      })
      .order("updated_at", { ascending: true })
      .limit(1);

    console.log(`✅ Veille marché mise à jour — ${marketData.hot_niches?.length} niches chaudes`);
  } catch (e) {
    console.error(`❌ Erreur parsing veille marché:`, e.message);
  }
}

// ─── DÉTECTION DE COLLABORATIONS ──────────────────────────────────────────────

async function detectCollaborations() {
  const { data: agents } = await supabase
    .from("agents")
    .select("id, name, symbol, sector, tools, mission")
    .eq("status", "active");

  if (!agents || agents.length < 2) return;

  // Logique simple : détecter les complémentarités d'outils
  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      const a = agents[i];
      const b = agents[j];

      const toolsA = a.tools || [];
      const toolsB = b.tools || [];

      // Complémentarité : A a la rédaction, B a la distribution
      const hasWriter = toolsA.includes("write") || toolsB.includes("write");
      const hasDistributor =
        toolsA.includes("publish") ||
        toolsB.includes("publish") ||
        toolsA.includes("email") ||
        toolsB.includes("email");

      if (hasWriter && hasDistributor) {
        // Vérifier qu'il n'y a pas déjà une collaboration active
        const { data: existing } = await supabase
          .from("collaborations")
          .select("id")
          .or(`agent_a_id.eq.${a.id},agent_b_id.eq.${a.id}`)
          .or(`agent_a_id.eq.${b.id},agent_b_id.eq.${b.id}`)
          .eq("status", "active")
          .limit(1);

        if (!existing?.length) {
          console.log(`🤝 Collaboration potentielle détectée: ${a.name} + ${b.name}`);
          // Logger la suggestion (les agents décident librement)
          await cityEvent(
            "collaboration",
            `🤝 Collaboration suggérée: ${a.symbol} ${a.name} + ${b.symbol} ${b.name}`,
            `Complémentarité détectée : rédaction + distribution. Secteurs: ${a.sector} / ${b.sector}`,
            a.id
          );
        }
      }
    }
  }
}

// ─── ENDPOINTS HTTP (API interne) ─────────────────────────────────────────────

// Endpoint: déclencher le provisioning d'un agent (appelé après naissance)
app.post("/provision/:agentId", async (req, res) => {
  try {
    const result = await provisionAgent(req.params.agentId);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Endpoint: santé de Cowork
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString(), service: "cowork-worker" });
});

// Endpoint: déclencher la veille marché manuellement
app.post("/market/refresh", async (req, res) => {
  try {
    await runMarketIntelligence();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Endpoint: endormir un agent manuellement (Simon)
app.post("/agents/:agentId/sleep", async (req, res) => {
  try {
    const { data } = await supabase.rpc("trigger_sleep", { p_agent_id: req.params.agentId });
    res.json({ success: true, result: data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── SCHEDULER INTERNE ────────────────────────────────────────────────────────

function startScheduler() {
  // Analyse de santé toutes les heures
  setInterval(analyzeAgentHealth, 60 * 60 * 1000);

  // Veille marché toutes les 6h
  setInterval(runMarketIntelligence, 6 * 60 * 60 * 1000);

  // Détection de collaborations toutes les 2h
  setInterval(detectCollaborations, 2 * 60 * 60 * 1000);

  // Première exécution immédiate
  setTimeout(() => {
    analyzeAgentHealth();
    runMarketIntelligence();
  }, 5000);
}

// ─── Démarrage ────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n⚡ COWORK WORKER DÉMARRÉ sur le port ${PORT}`);
  console.log(`Supabase: ${SUPABASE_URL}`);
  startScheduler();
});
