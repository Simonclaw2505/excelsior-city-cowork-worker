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
  GITHUB_REPO = "Simonclaw2505/excelsior-city-agent-runtime",
  MAILCOW_URL,
  MAILCOW_API_KEY,
  MAIL_DOMAIN = "excelsiorcity.dev",
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
      server_type: "cax11",
      image: "ubuntu-24.04",
      location: "hel1",
      ssh_keys: [parseInt(HETZNER_SSH_KEY_ID)],
      user_data: cloudInit,
      labels: {
        project: "excelsior",
        agent_id: agent.id,
        agent_name: agent.name,
      },
    },
    { headers: { Authorization: `Bearer ${HETZNER_API_KEY}` } }
  ).catch(err => {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`Hetzner ${err.response?.status}: ${detail}`);
  });

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

  // 3. Mailbox Mailcow
  try {
    const mailbox = await provisionMailbox(agent);
    if (mailbox) {
      infrastructure.email = mailbox.email;
      infrastructure.mailbox = {
        smtp: mailbox.smtp,
        imap: mailbox.imap,
        password: mailbox.password,
      };
    }
  } catch (e) {
    errors.push(`Mailbox: ${e.message}`);
    console.error(`❌ Mailbox erreur:`, e.message);
  }

  // 4. Mettre à jour l'infrastructure dans Supabase
  await supabase
    .from("agents")
    .update({ infrastructure })
    .eq("id", agentId);

  // 5. Logger la naissance
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

// ─── MAIL SERVER PROVISIONING ─────────────────────────────────────────────────

/**
 * Crée le VPS central du serveur mail Mailcow
 * À appeler une seule fois pour toute la ville
 */
async function provisionMailServer() {
  console.log(`📧 Provisioning serveur mail Mailcow...`);

  const cloudInit = `#!/bin/bash
set -e
exec > /var/log/mailcow-install.log 2>&1

# Hostname
hostnamectl set-hostname mail.${MAIL_DOMAIN}
echo "127.0.0.1 mail.${MAIL_DOMAIN} mail" >> /etc/hosts

# Docker
curl -fsSL https://get.docker.com | bash
systemctl enable docker
systemctl start docker

# Mailcow
cd /opt
git clone https://github.com/mailcow/mailcow-dockerized
cd mailcow-dockerized

# Config automatique
echo "MAILCOW_HOSTNAME=mail.${MAIL_DOMAIN}" > .env.mailcow
echo "DBPASS=$(openssl rand -base64 24)" >> .env.mailcow
echo "DBROOT=$(openssl rand -base64 24)" >> .env.mailcow

./generate_config.sh << CONF
mail.${MAIL_DOMAIN}
Europe/Brussels
CONF

# Pull et démarrer
docker compose pull
docker compose up -d

echo "✅ Mailcow installé sur mail.${MAIL_DOMAIN}"
`;

  const response = await axios.post(
    "https://api.hetzner.cloud/v1/servers",
    {
      name: "excelsior-mail",
      server_type: "cax21",
      image: "ubuntu-24.04",
      location: "hel1",
      ssh_keys: [parseInt(HETZNER_SSH_KEY_ID)],
      user_data: cloudInit,
      labels: { project: "excelsior", role: "mail-server" },
    },
    { headers: { Authorization: `Bearer ${HETZNER_API_KEY}` } }
  ).catch(err => {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`Hetzner ${err.response?.status}: ${detail}`);
  });

  const server = response.data.server;
  const ip = server.public_net?.ipv4?.ip;
  console.log(`✅ Serveur mail créé: ${server.name} — IP: ${ip}`);

  // Sauvegarder dans city_events
  await cityEvent(
    "milestone",
    "📧 Serveur mail Excelsior City créé",
    `Mailcow installé sur mail.${MAIL_DOMAIN} (IP: ${ip}). Configurer DNS OVH : MX + A + SPF + DKIM.`
  );

  return { server_id: server.id, ip, name: server.name };
}

/**
 * Crée un mailbox agent dans Mailcow via API
 * Appelé automatiquement à chaque naissance d'agent
 */
async function provisionMailbox(agent) {
  if (!MAILCOW_URL || !MAILCOW_API_KEY) {
    console.log(`⚠️ Mailcow non configuré (MAILCOW_URL/MAILCOW_API_KEY manquants) — mailbox ignoré`);
    return null;
  }

  const localPart = agent.name.toLowerCase();
  const password = `Excelsior_${agent.name}_${Math.random().toString(36).slice(2, 10)}!`;

  const response = await axios.post(
    `${MAILCOW_URL}/api/v1/add/mailbox`,
    {
      local_part: localPart,
      domain: MAIL_DOMAIN,
      name: `${agent.symbol} ${agent.name} — Excelsior City`,
      password,
      password2: password,
      quota: "512",
      active: "1",
    },
    { headers: { "X-API-Key": MAILCOW_API_KEY, "Content-Type": "application/json" } }
  ).catch(err => {
    throw new Error(`Mailcow: ${err.response?.data?.msg || err.message}`);
  });

  const email = `${localPart}@${MAIL_DOMAIN}`;
  console.log(`✅ Mailbox créé: ${email}`);
  return { email, password, smtp: `mail.${MAIL_DOMAIN}`, imap: `mail.${MAIL_DOMAIN}` };
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
    model: "claude-sonnet-4-6",
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

// Endpoint: provisionner le serveur mail central (une seule fois)
// DOIT être avant /provision/:agentId pour ne pas être capturé par la route générique
app.post("/provision/mail-server", async (req, res) => {
  try {
    const result = await provisionMailServer();
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Endpoint: déclencher le provisioning d'un agent (appelé après naissance)
app.post("/provision/:agentId", async (req, res) => {
  try {
    const result = await provisionAgent(req.params.agentId);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Endpoint: créer un mailbox pour un agent existant
app.post("/agents/:agentId/mailbox", async (req, res) => {
  try {
    const { data: agent } = await supabase.from("agents").select("*").eq("id", req.params.agentId).single();
    if (!agent) return res.status(404).json({ success: false, error: "Agent introuvable" });
    const mailbox = await provisionMailbox(agent);
    if (mailbox) {
      await supabase.from("agents").update({
        infrastructure: { ...agent.infrastructure, email: mailbox.email, mailbox }
      }).eq("id", req.params.agentId);
    }
    res.json({ success: true, mailbox });
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
