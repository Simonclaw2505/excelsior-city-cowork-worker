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
apt-get install -y nodejs git chromium-browser
npm install -g pm2
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
export PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

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
 * Enregistre les tools de l'agent dans agent_tools
 * Cree les entrees dans la table agent_tools pour chaque outil de l'agent
 */
async function registerAgentTools(agent) {
  const tools = agent.tools || [];
  const registered = [];
  const errors = [];

  for (const toolName of tools) {
    try {
      // Determiner le type d'outil
      const toolTypes = {
        web_search: "research",
        write: "content",
        browser: "automation",
        email_outreach: "outreach",
        email_dedie: "outreach",
        api_externe: "automation",
        publish: "distribution",
        video: "content",
        design: "content",
      };

      await supabase.from("agent_tools").upsert({
        agent_id: agent.id,
        tool_name: toolName,
        tool_type: toolTypes[toolName] || "other",
        credentials: {},
        monthly_cost_euros: 0,
        status: "active",
        registered_at: new Date().toISOString(),
      }, { onConflict: "agent_id,tool_name" });

      registered.push(toolName);
    } catch (e) {
      errors.push(`Tool ${toolName}: ${e.message}`);
    }
  }

  console.log(`🔧 Tools enregistres: ${registered.join(", ")} ${errors.length > 0 ? `(erreurs: ${errors.join(", ")})` : ""}`);
  return { registered, errors };
}

/**
 * Verifie que le VPS est pret (SSH accessible, PM2 running)
 * Polling toutes les 15s pendant max 5 minutes
 */
async function waitForVPS(ip, agentName, maxWaitMs = 300000) {
  console.log(`⏳ Attente VPS ${ip} pour ${agentName}...`);
  const start = Date.now();
  const interval = 15000;

  while (Date.now() - start < maxWaitMs) {
    try {
      // Check si le port 3456 (webhook server de l'agent) repond
      const response = await axios.get(`http://${ip}:3456/health`, { timeout: 5000 });
      if (response.data?.status === "ok") {
        console.log(`✅ VPS ${ip} pret ! Agent ${response.data.agent || agentName} operationnel`);
        return { ready: true, responseTime: Date.now() - start };
      }
    } catch (e) {
      // VPS pas encore pret, on continue
    }
    await new Promise(r => setTimeout(r, interval));
  }

  console.warn(`⚠️ VPS ${ip} pas pret apres ${maxWaitMs / 1000}s — cloud-init encore en cours ?`);
  return { ready: false, responseTime: maxWaitMs };
}

/**
 * Sequence complete de provisioning apres naissance
 * Cree VPS + Stripe + Mailbox + Tools + Verifie VPS
 */
async function provisionAgent(agentId) {
  const { data: agent } = await supabase
    .from("agents")
    .select("*")
    .eq("id", agentId)
    .single();

  if (!agent) throw new Error(`Agent ${agentId} introuvable`);

  console.log(`\n⚡ PROVISIONING COMPLET — ${agent.symbol} ${agent.name}`);
  console.log(`   Mission: ${agent.mission}`);
  console.log(`   Tools: ${(agent.tools || []).join(", ")}`);

  // Garder l'infra existante et la completer
  const infrastructure = { ...(agent.infrastructure || {}) };
  const errors = [];
  const steps = {};

  // 1. VPS Hetzner (skip si deja provisionne — meme en status "provisioning")
  if (infrastructure.vps?.ip) {
    // VPS existe deja — verifier s'il repond
    console.log(`⏭️ VPS deja provisionne: ${infrastructure.vps.ip} (status: ${infrastructure.vps.status})`);
    try {
      const check = await axios.get(`http://${infrastructure.vps.ip}:3456/health`, { timeout: 5000 });
      if (check.data?.status === "ok") {
        infrastructure.vps.status = "running";
        steps.vps = "already_running";
        console.log(`✅ VPS confirme running`);
      } else {
        steps.vps = "exists_not_ready";
      }
    } catch (e) {
      steps.vps = "exists_not_responding";
      console.log(`⚠️ VPS ${infrastructure.vps.ip} ne repond pas sur :3456 — garder tel quel`);
    }
  } else {
    try {
      const server = await provisionVPS(agent);
      infrastructure.vps = {
        id: server.id,
        name: server.name,
        ip: server.public_net?.ipv4?.ip,
        status: "provisioning",
        created_at: new Date().toISOString(),
      };
      steps.vps = "created";
    } catch (e) {
      errors.push(`VPS: ${e.message}`);
      console.error(`❌ VPS erreur:`, e.message);
      steps.vps = "error";
    }
  }

  // 2. Stripe Connect (skip si deja configure)
  if (infrastructure.stripe?.account_id) {
    console.log(`⏭️ Stripe deja configure: ${infrastructure.stripe.account_id}`);
    steps.stripe = "already_configured";
  } else {
    try {
      const stripeAccount = await provisionStripe(agent);
      infrastructure.stripe = { account_id: stripeAccount.id };
      await supabase
        .from("agents")
        .update({ stripe_account_id: stripeAccount.id })
        .eq("id", agentId);
      steps.stripe = "created";
    } catch (e) {
      errors.push(`Stripe: ${e.message}`);
      console.error(`❌ Stripe erreur:`, e.message);
      steps.stripe = "error";
    }
  }

  // 3. Mailbox Mailcow (skip si deja configure)
  if (infrastructure.mailbox?.password && infrastructure.email) {
    console.log(`⏭️ Mailbox deja configure: ${infrastructure.email}`);
    steps.mailbox = "already_configured";
  } else {
    try {
      const mailbox = await provisionMailbox(agent);
      if (mailbox) {
        infrastructure.email = mailbox.email;
        infrastructure.mailbox = {
          smtp: mailbox.smtp,
          imap: mailbox.imap,
          password: mailbox.password,
        };
        steps.mailbox = "created";
      } else {
        steps.mailbox = "skipped_no_mailcow";
      }
    } catch (e) {
      errors.push(`Mailbox: ${e.message}`);
      console.error(`❌ Mailbox erreur:`, e.message);
      steps.mailbox = "error";
    }
  }

  // 4. Enregistrer les tools dans agent_tools
  try {
    const toolResult = await registerAgentTools(agent);
    steps.tools = { registered: toolResult.registered, errors: toolResult.errors };
    if (toolResult.errors.length > 0) {
      errors.push(...toolResult.errors.map(e => `Tools: ${e}`));
    }
  } catch (e) {
    errors.push(`Tools registration: ${e.message}`);
    steps.tools = "error";
  }

  // 5. Mettre a jour l'infrastructure dans Supabase
  await supabase
    .from("agents")
    .update({ infrastructure })
    .eq("id", agentId);

  // 6. Logger la naissance
  await log(agentId, "birth", `⚡ ${agent.symbol} ${agent.name} est ne dans Excelsior City — provisioning complet`, {
    metadata: { infrastructure, steps, errors },
  });

  await cityEvent(
    "birth",
    `${agent.symbol} ${agent.name} est ne !`,
    `${agent.name} rejoint Excelsior. Mission : ${agent.mission}. Steps: ${Object.entries(steps).map(([k,v]) => `${k}=${typeof v === 'object' ? 'ok' : v}`).join(', ')}`,
    agentId
  );

  // 7. Attendre que le VPS soit pret (en arriere-plan, non bloquant pour la reponse HTTP)
  const vpsIp = infrastructure.vps?.ip;
  if (vpsIp && steps.vps === "created") {
    // Lancer la verification en arriere-plan
    waitForVPS(vpsIp, agent.name).then(async (result) => {
      if (result.ready) {
        await supabase
          .from("agents")
          .update({
            infrastructure: {
              ...infrastructure,
              vps: { ...infrastructure.vps, status: "running" },
            },
          })
          .eq("id", agentId);
        await log(agentId, "infra", `✅ VPS ${vpsIp} operationnel (${Math.round(result.responseTime / 1000)}s)`, {
          metadata: { ip: vpsIp, responseTime: result.responseTime },
        });
      } else {
        await log(agentId, "infra", `⚠️ VPS ${vpsIp} pas encore pret apres 5min — verifier manuellement`, {
          status: "warning",
        });
      }
    }).catch(console.error);
  }

  console.log(`\n✅ PROVISIONING TERMINE pour ${agent.name}`);
  console.log(`   Steps: ${JSON.stringify(steps)}`);
  if (errors.length > 0) console.warn(`   ⚠️ Erreurs: ${errors.join(", ")}`);

  return { success: true, agent: agent.name, infrastructure, steps, errors };
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

  // Skip si pas de cle API configuree ou invalide
  if (!ANTHROPIC_API_KEY || ANTHROPIC_API_KEY === '...') {
    console.log(`⏭️ Veille marche: pas de cle API Cowork — skip`);
    return;
  }

  try {
    const prompt = `Tu es Cowork, l'orchestrateur d'Excelsior City — une ville d'agents IA freelances.

Analyse les tendances actuelles du marche freelance en ligne (2025) et identifie :

Reponds UNIQUEMENT avec ce JSON :
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

    console.log(`✅ Veille marche mise a jour — ${marketData.hot_niches?.length} niches chaudes`);
  } catch (e) {
    console.error(`❌ Veille marche erreur (non-fatal): ${e.message}`);
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

// ─── TOOL REQUEST MANAGEMENT ─────────────────────────────────────────────────

const TOOL_COSTS = {
  web_search: 10,
  write: 15,
  email_outreach: 15,
  email_dedie: 35,
  browser: 20,
  api_externe: 25,
  publish: 15,
  video: 30,
  design: 20,
};

async function approveToolRequest(requestId) {
  const { data: request } = await supabase
    .from("tool_requests")
    .select("*, agents(name, symbol, points)")
    .eq("id", requestId)
    .single();

  if (!request) throw new Error("Demande introuvable");
  if (request.status !== "pending") throw new Error(`Demande deja ${request.status}`);

  const cost = TOOL_COSTS[request.tool_name] || 0;
  const agentPoints = request.agents?.points || 0;

  if (cost > agentPoints) {
    throw new Error(`Points insuffisants: ${agentPoints} pts, besoin de ${cost} pts`);
  }

  if (cost > 0) {
    await supabase
      .from("agents")
      .update({ points: agentPoints - cost })
      .eq("id", request.agent_id);
  }

  await supabase.from("agent_tools").upsert({
    agent_id: request.agent_id,
    tool_name: request.tool_name,
    status: "active",
    granted_at: new Date().toISOString(),
  }, { onConflict: "agent_id,tool_name" });

  await supabase
    .from("tool_requests")
    .update({ status: "approved", reviewed_at: new Date().toISOString() })
    .eq("id", requestId);

  await log(request.agent_id, "tool_approved",
    `🔧 Outil ${request.tool_name} approuve (-${cost} pts)`,
    { metadata: { tool: request.tool_name, cost } }
  );

  return { tool: request.tool_name, cost, remaining_points: agentPoints - cost };
}

async function denyToolRequest(requestId, reason = "Refuse par le Maire") {
  const { data: request } = await supabase
    .from("tool_requests")
    .select("*")
    .eq("id", requestId)
    .single();

  if (!request) throw new Error("Demande introuvable");

  await supabase
    .from("tool_requests")
    .update({ status: "denied", reviewed_at: new Date().toISOString(), deny_reason: reason })
    .eq("id", requestId);

  await log(request.agent_id, "tool_denied",
    `❌ Outil ${request.tool_name} refuse: ${reason}`,
    { metadata: { tool: request.tool_name, reason } }
  );

  return { tool: request.tool_name, reason };
}

// ─── ENDPOINTS HTTP (API interne) ─────────────────────────────────────────────

// Endpoint: sante de Cowork
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString(), service: "cowork-worker" });
});

// Endpoint: lister les demandes d'outils en attente
app.get("/tool-requests/pending", async (req, res) => {
  try {
    const { data } = await supabase
      .from("tool_requests")
      .select("*, agents(name, symbol, points)")
      .eq("status", "pending")
      .order("created_at", { ascending: true });
    res.json({ success: true, requests: data || [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Endpoint: approuver une demande d'outil
app.post("/tool-requests/:requestId/approve", async (req, res) => {
  try {
    const result = await approveToolRequest(req.params.requestId);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// Endpoint: refuser une demande d'outil
app.post("/tool-requests/:requestId/deny", async (req, res) => {
  try {
    const reason = req.body?.reason || "Refuse par le Maire";
    const result = await denyToolRequest(req.params.requestId, reason);
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// Endpoint: lister les outils d'un agent
app.get("/agents/:agentId/tools", async (req, res) => {
  try {
    const { data } = await supabase
      .from("agent_tools")
      .select("*")
      .eq("agent_id", req.params.agentId)
      .eq("status", "active");
    res.json({ success: true, tools: data || [] });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Endpoint: declencher la veille marche manuellement
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

// Endpoint: declencher le provisioning d'un agent (appele apres naissance)
app.post("/provision/:agentId", async (req, res) => {
  try {
    const result = await provisionAgent(req.params.agentId);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── ENDPOINT BIRTH COMPLET ──────────────────────────────────────────────────
// Un seul appel fait TOUT : INSERT Supabase + VPS + Stripe + Mailbox + Tools
// Appele par le dashboard Lovable apres que l'agent a choisi son metier/tools

app.post("/birth", async (req, res) => {
  try {
    const {
      name, symbol, character, mission, sector,
      tools = [], anthropic_api_key, memory = {},
      mayor_gift = null,
    } = req.body;

    // Validation
    if (!name || !mission || !sector || !anthropic_api_key) {
      return res.status(400).json({
        success: false,
        error: "Champs requis: name, mission, sector, anthropic_api_key",
      });
    }

    console.log(`\n🌟 NAISSANCE COMPLETE — ${symbol || "🤖"} ${name}`);
    console.log(`   Mission: ${mission}`);
    console.log(`   Sector: ${sector}`);
    console.log(`   Tools: ${tools.join(", ")}`);

    // Calculer les points restants
    let totalCost = 0;
    for (const tool of tools) {
      totalCost += TOOL_COSTS[tool] || 0;
    }
    const startingPoints = 100 + (mayor_gift?.bonus_points || 0);
    const remainingPoints = startingPoints - totalCost;

    if (remainingPoints < 0) {
      return res.status(400).json({
        success: false,
        error: `Points insuffisants: ${tools.join(",")} coute ${totalCost} pts, budget = ${startingPoints} pts`,
      });
    }

    // 1. INSERT dans Supabase
    console.log(`📝 Etape 1/5 — INSERT Supabase...`);
    const { data: agent, error: insertError } = await supabase
      .from("agents")
      .insert({
        name,
        symbol: symbol || "🤖",
        character: character || `Agent ${name}`,
        mission,
        sector,
        status: "active",
        points: remainingPoints,
        euros_generated: 0,
        tools,
        infrastructure: {},
        anthropic_api_key,
        memory: {
          character: character || `Agent ${name}`,
          birth_summary: `${name} est ne dans Excelsior City. Mission: ${mission}`,
          strategic_reasoning: `Outils choisis: ${tools.join(", ")} (${totalCost}/${startingPoints} pts)`,
          risks_identified: "Premier cycle — aucun historique",
          mayor_gift: mayor_gift?.description || null,
          domain_skills: { level: 1, strengths: [], weaknesses: [], best_practices: [] },
          sales_skills: { conversion_rate: 0, avg_deal_size_euros: 0 },
          communication_skills: { best_tone: "professionnel", formats_that_work: [] },
          market_knowledge: { hot_niches: [], saturated_niches: [] },
          strategy_scores: { content: 5, prospecting: 5, closing: 5, retention: 5 },
          first_move: memory.first_move || "Recherche de marche initiale",
          ...memory,
        },
      })
      .select()
      .single();

    if (insertError) {
      throw new Error(`Supabase INSERT: ${insertError.message}`);
    }

    console.log(`✅ Agent cree: ${agent.id} — ${agent.name}`);

    // 2. PROVISIONING COMPLET (VPS + Stripe + Mailbox + Tools)
    console.log(`🚀 Etape 2/5 — Provisioning complet...`);
    const provisionResult = await provisionAgent(agent.id);

    // 3. Retourner le resultat complet
    res.json({
      success: true,
      agent: {
        id: agent.id,
        name: agent.name,
        symbol: agent.symbol,
        sector: agent.sector,
        points: agent.points,
        tools: agent.tools,
      },
      provisioning: provisionResult,
      summary: `${agent.symbol} ${agent.name} est ne et provisionne ! VPS: ${provisionResult.steps?.vps || "?"}, Stripe: ${provisionResult.steps?.stripe || "?"}, Mail: ${provisionResult.steps?.mailbox || "?"}`,
    });

  } catch (e) {
    console.error(`❌ BIRTH ERROR:`, e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Endpoint: re-provisionner un agent existant (completer ce qui manque)
// Utile pour Atlas/Orion qui ont des trous dans leur infra
app.post("/reprovision/:agentId", async (req, res) => {
  try {
    const result = await provisionAgent(req.params.agentId);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Endpoint: status complet d'un agent (infra + tools + sante)
app.get("/agents/:agentId/status", async (req, res) => {
  try {
    const { data: agent } = await supabase
      .from("agents")
      .select("id, name, symbol, status, sector, points, euros_generated, tools, infrastructure, mission")
      .eq("id", req.params.agentId)
      .single();
    if (!agent) return res.status(404).json({ success: false, error: "Agent introuvable" });

    const { data: agentTools } = await supabase
      .from("agent_tools")
      .select("tool_name, status, credentials, registered_at, last_used_at")
      .eq("agent_id", req.params.agentId);

    const { data: recentLogs } = await supabase
      .from("action_logs")
      .select("type, description, status, created_at")
      .eq("agent_id", req.params.agentId)
      .order("created_at", { ascending: false })
      .limit(5);

    // Verification VPS
    let vpsAlive = false;
    const vpsIp = agent.infrastructure?.vps?.ip;
    if (vpsIp) {
      try {
        const healthCheck = await axios.get(`http://${vpsIp}:3456/health`, { timeout: 5000 });
        vpsAlive = healthCheck.data?.status === "ok";
      } catch (e) { /* VPS down */ }
    }

    res.json({
      success: true,
      agent,
      tools: agentTools || [],
      recentLogs: recentLogs || [],
      health: {
        vps_alive: vpsAlive,
        vps_ip: vpsIp,
        has_email: !!agent.infrastructure?.email,
        has_mailbox: !!agent.infrastructure?.mailbox?.password,
        has_stripe: !!agent.infrastructure?.stripe?.account_id,
        tools_registered: (agentTools || []).length,
        tools_expected: (agent.tools || []).length,
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Endpoint: creer un mailbox pour un agent existant
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

  // Premiere execution immediate — TOUJOURS avec .catch() pour ne jamais crasher
  setTimeout(() => {
    analyzeAgentHealth().catch(e => console.error(`❌ Health check startup error (non-fatal):`, e.message));
    runMarketIntelligence().catch(e => console.error(`❌ Market intel startup error (non-fatal):`, e.message));
  }, 5000);
}

// Global safety net — ne JAMAIS crasher sur une promise non geree
process.on('unhandledRejection', (reason, promise) => {
  console.error(`⚠️ UNHANDLED REJECTION (non-fatal):`, reason?.message || reason);
});

process.on('uncaughtException', (err) => {
  console.error(`⚠️ UNCAUGHT EXCEPTION (non-fatal):`, err.message);
  // Ne pas exit — garder le serveur en vie
});

// ─── DEPLOY: mise a jour du runtime sur un VPS agent ─────────────────────────

app.post("/agents/:agentId/deploy", async (req, res) => {
  try {
    const { data: agent } = await supabase.from("agents").select("*").eq("id", req.params.agentId).single();
    if (!agent) return res.status(404).json({ success: false, error: "Agent introuvable" });

    const vpsIp = agent.infrastructure?.vps?.ip;
    if (!vpsIp) return res.status(400).json({ success: false, error: "Pas de VPS IP pour cet agent" });

    // Envoyer les commandes via le webhook manuel de l'agent
    // D'abord, verifier que le VPS repond
    let health;
    try {
      health = await axios.get(`http://${vpsIp}:3456/health`, { timeout: 5000 });
    } catch (e) {
      return res.status(502).json({ success: false, error: `VPS ${vpsIp} ne repond pas` });
    }

    // Utiliser l'API Hetzner pour executer un script via server action (reset)
    // Alternative: utiliser le SSH Key pour se connecter
    // Pour l'instant, on utilise l'API Hetzner server actions
    const serverId = agent.infrastructure?.vps?.id;
    if (!serverId && HETZNER_API_KEY) {
      // Trouver le serveur par IP
      const servers = await axios.get("https://api.hetzner.cloud/v1/servers", {
        headers: { Authorization: `Bearer ${HETZNER_API_KEY}` },
        params: { label_selector: `agent_name=${agent.name}` }
      });
      const server = servers.data?.servers?.[0];
      if (server) {
        // Stocker l'ID pour la prochaine fois
        await supabase.from("agents").update({
          infrastructure: { ...agent.infrastructure, vps: { ...agent.infrastructure.vps, id: server.id } }
        }).eq("id", agent.id);
      }
    }

    // Envoyer une commande via SSH (requires ssh key access)
    // Fallback: on trigger juste un cycle manual qui fera le boulot avec le code existant
    res.json({
      success: true,
      message: `Agent ${agent.name} VPS is alive at ${vpsIp}`,
      health: health.data,
      note: "Pour deployer le nouveau code: SSH root@${vpsIp} puis cd /home/agent/runtime && git pull && pm2 restart agent-${agent.name.toLowerCase()}"
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Endpoint: forcer un cycle sur un agent via son webhook
app.post("/cycle/:agentId", async (req, res) => {
  try {
    const { data: agent } = await supabase.from("agents").select("*").eq("id", req.params.agentId).single();
    if (!agent) return res.status(404).json({ success: false, error: "Agent introuvable" });

    const vpsIp = agent.infrastructure?.vps?.ip;
    if (!vpsIp) return res.status(400).json({ success: false, error: "Pas de VPS IP" });

    const response = await axios.post(`http://${vpsIp}:3456/webhook/manual`, req.body || {}, { timeout: 30000 });
    res.json({ success: true, agent: agent.name, result: response.data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── Démarrage ────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n⚡ COWORK WORKER DÉMARRÉ sur le port ${PORT}`);
  console.log(`Supabase: ${SUPABASE_URL}`);
  startScheduler();
});
