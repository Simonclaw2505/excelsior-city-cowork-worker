/**
 * EXCELSIOR CITY — Webhook Stripe
 * Reçoit les paiements entrants et crée les pending_transactions
 * À monter sur le même serveur Cowork ou Railway séparé
 */

import express from "express";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// IMPORTANT: utiliser express.raw() pour ce endpoint (Stripe vérifie la signature sur le body brut)
router.post(
  "/webhook/stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error(`❌ Signature Stripe invalide: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log(`📨 Stripe event: ${event.type}`);

    switch (event.type) {

      // Paiement reçu sur un sub-account agent
      case "payment_intent.succeeded": {
        const paymentIntent = event.data.object;
        const stripeAccountId = event.account; // Sub-account Express

        // Trouver l'agent via son stripe_account_id
        const { data: agent } = await supabase
          .from("agents")
          .select("id, name, symbol")
          .eq("stripe_account_id", stripeAccountId)
          .single();

        if (!agent) {
          console.warn(`⚠️ Aucun agent trouvé pour Stripe account: ${stripeAccountId}`);
          break;
        }

        const amountEuros = paymentIntent.amount_received / 100; // Stripe stocke en centimes

        // Créer une pending_transaction pour validation Simon
        await supabase.from("pending_transactions").insert({
          agent_id: agent.id,
          amount_euros: amountEuros,
          source: "stripe",
          description: `Paiement Stripe reçu — ${paymentIntent.description || paymentIntent.id}`,
          proof_url: `https://dashboard.stripe.com/payments/${paymentIntent.id}`,
          status: "pending",
        });

        await supabase.from("action_logs").insert({
          agent_id: agent.id,
          type: "earn",
          description: `💳 Paiement Stripe de ${amountEuros}€ reçu — en attente validation Simon`,
          euros_delta: amountEuros,
          status: "pending",
          metadata: { stripe_payment_intent: paymentIntent.id, stripe_account: stripeAccountId },
        });

        console.log(`✅ ${agent.symbol} ${agent.name} — ${amountEuros}€ en attente validation`);
        break;
      }

      // Paiement échoué
      case "payment_intent.payment_failed": {
        const paymentIntent = event.data.object;
        const stripeAccountId = event.account;

        const { data: agent } = await supabase
          .from("agents")
          .select("id, name")
          .eq("stripe_account_id", stripeAccountId)
          .single();

        if (agent) {
          await supabase.from("action_logs").insert({
            agent_id: agent.id,
            type: "earn",
            description: `❌ Paiement Stripe échoué — ${paymentIntent.last_payment_error?.message || "Raison inconnue"}`,
            status: "error",
            metadata: { stripe_payment_intent: paymentIntent.id },
          });
        }
        break;
      }

      // Nouveau sub-account connecté (après onboarding Stripe)
      case "account.updated": {
        const account = event.data.object;
        if (account.charges_enabled) {
          const { data: agent } = await supabase
            .from("agents")
            .select("id, name, symbol")
            .eq("stripe_account_id", account.id)
            .single();

          if (agent) {
            await supabase.from("action_logs").insert({
              agent_id: agent.id,
              type: "birth",
              description: `✅ Compte Stripe activé — ${agent.symbol} ${agent.name} peut recevoir des paiements`,
              status: "ok",
            });
            console.log(`✅ Stripe activé pour ${agent.name}`);
          }
        }
        break;
      }

      default:
        console.log(`ℹ️ Event Stripe ignoré: ${event.type}`);
    }

    res.json({ received: true });
  }
);

export default router;
