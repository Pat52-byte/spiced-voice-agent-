// ============================================================
// QUALITY CHECK AGENT — gira ogni notte
// Trova deals con SPICED gaps critici aperti da troppo tempo
// e manda un digest ai manager con priorità di coaching
// ============================================================

import db from "../db.js";
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function runSpicedQualityCheck() {
  // 1. Trova deals in stage avanzato (3+) con gap SPICED critici
  //    che non sono stati aggiornati nelle ultime note
  const result = await db.query(`
    SELECT
      d.id, d.name, d.amount, d.stage_name, d.stage_order,
      u.name AS rep_name, u.id AS rep_id, u.slack_user_id,
      v.economic_buyer, v.critical_event, v.decision_process,
      v.last_updated,
      CURRENT_DATE - v.last_updated::date AS days_since_update
    FROM deals d
    JOIN users u ON u.id = d.owner_id
    LEFT JOIN v_deal_spiced_current v ON v.deal_id = d.id
    WHERE d.stage_name NOT IN ('Closed Won','Closed Lost')
      AND d.stage_order >= 3
      AND (
        v.economic_buyer IS NULL
        OR v.critical_event IS NULL
        OR v.decision_process IS NULL
      )
    ORDER BY d.amount DESC
  `);

  const dealsWithGaps = result.rows;

  if (dealsWithGaps.length === 0) {
    console.log("✅ Nessun gap SPICED critico in stage avanzato");
    return;
  }

  // 2. Raggruppa per rep per il digest
  const byRep = {};
  for (const deal of dealsWithGaps) {
    byRep[deal.rep_id] = byRep[deal.rep_id] || {
      rep_name: deal.rep_name,
      slack_user_id: deal.slack_user_id,
      deals: [],
    };
    byRep[deal.rep_id].deals.push(deal);
  }

  // 3. Manda nudge personalizzato a ogni rep (non al manager — diretto)
  for (const [repId, data] of Object.entries(byRep)) {
    await sendCoachingNudge(data);
  }

  // 4. Manda summary aggregato al manager
  await sendManagerDigest(dealsWithGaps, byRep);

  console.log(`✅ Quality check completato: ${dealsWithGaps.length} deals con gap, ${Object.keys(byRep).length} rep notificati`);
}

// ============================================================
// NUDGE diretto al rep — suggerisce domande specifiche
// ============================================================
async function sendCoachingNudge({ rep_name, slack_user_id, deals }) {
  if (!slack_user_id) return;

  const dealList = deals
    .map((d) => {
      const gaps = [];
      if (!d.economic_buyer) gaps.push("Economic Buyer");
      if (!d.critical_event) gaps.push("Critical Event");
      if (!d.decision_process) gaps.push("Decision Process");
      return `• *${d.name}* (€${Number(d.amount).toLocaleString("it-IT")}) — manca: ${gaps.join(", ")}`;
    })
    .join("\n");

  const text = [
    `👋 ${deals.length === 1 ? "Un deal" : `${deals.length} deals`} in stage avanzato ${deals.length === 1 ? "ha" : "hanno"} ancora gap SPICED critici:`,
    ``,
    dealList,
    ``,
    `💡 Detta una nota vocale dopo la prossima call con queste info, oppure aggiorna manualmente nel CRM.`,
  ].join("\n");

  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel: slack_user_id, text }),
  });
}

// ============================================================
// DIGEST al manager — vista aggregata per 1:1 e coaching
// ============================================================
async function sendManagerDigest(deals, byRep) {
  const totalARR = deals.reduce((sum, d) => sum + Number(d.amount), 0);

  const repSummary = Object.values(byRep)
    .map((r) => `${r.rep_name}: ${r.deals.length} deals con gap`)
    .join(" · ");

  const blocks = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "🔍 SPICED Quality Check — gap critici in stage avanzato",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${deals.length} deals* in stage 3+ hanno gap SPICED critici (Economic Buyer, Critical Event, o Decision Process mancanti).\nARR coinvolto: *€${totalARR.toLocaleString("it-IT")}*`,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Per rep:* ${repSummary}` },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Ogni rep ha già ricevuto un nudge diretto. Usa questo per il prossimo 1:1.",
        },
      ],
    },
  ];

  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({
      channel: process.env.SLACK_MANAGER_CHANNEL || "#revops-alerts",
      blocks,
      text: `SPICED Quality Check: ${deals.length} deals con gap critici`,
    }),
  });
}
