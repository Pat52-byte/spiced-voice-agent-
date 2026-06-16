// ============================================================
// SPICED PROCESSOR — Il cuore del sistema
// Prende una trascrizione (voice note o call) e:
// 1. Identifica il deal (se non già noto)
// 2. Estrae i campi SPICED in formato strutturato
// 3. Calcola quality score e flag campi mancanti
// 4. Scrive nel CRM
// ============================================================

import Anthropic from "@anthropic-ai/sdk";
import db from "../db.js";
import { writeSpicedToCRM } from "../crm/spiced_writeback.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ============================================================
// CAMPI CRITICI — se mancano, quality check fallisce
// (basato sui pattern del tuo Commit Slip Agent)
// ============================================================
const CRITICAL_FIELDS = [
  "economic_buyer",
  "critical_event",
  "decision_process",
];

const ALL_FIELDS = [
  "situation",
  "pain",
  "impact",
  "critical_event",
  "decision_process",
  "economic_buyer",
  "champion",
  "mutual_close_plan",
];

// ============================================================
// TOOL: structured extraction via tool use
// Forziamo Claude a ritornare JSON strutturato usando un tool
// invece di chiedere "rispondi in JSON" (molto più affidabile)
// ============================================================
const EXTRACTION_TOOL = {
  name: "submit_spiced_extraction",
  description:
    "Sottometti l'estrazione strutturata dei campi SPICED dalla trascrizione analizzata.",
  input_schema: {
    type: "object",
    properties: {
      deal_identification: {
        type: "object",
        description:
          "Informazioni per identificare di quale deal si sta parlando",
        properties: {
          account_name: { type: "string" },
          confidence: {
            type: "string",
            enum: ["high", "medium", "low"],
          },
        },
        required: ["account_name", "confidence"],
      },
      situation: {
        type: "string",
        description:
          "Contesto attuale del prospect: che strumenti usa, come funziona oggi il processo. Null se non menzionato.",
      },
      pain: {
        type: "string",
        description:
          "Il problema specifico che il prospect sta vivendo. Null se non menzionato.",
      },
      impact: {
        type: "string",
        description:
          "Impatto quantificato del problema (tempo perso, costo, rischio). Deve essere specifico e numerico se possibile. Null se non menzionato o vago.",
      },
      critical_event: {
        type: "string",
        description:
          "L'evento esterno con scadenza che forza la decisione (es. scadenza contratto attuale, audit, lancio prodotto). Null se non c'è un vero forcing event esterno (NON contare 'fine quarter' come critical event valido se è solo una pressione interna del rep).",
      },
      decision_process: {
        type: "string",
        description:
          "Come l'organizzazione del prospect prenderà la decisione: chi è coinvolto, quali step, su che timeline. Null se non chiaro.",
      },
      economic_buyer: {
        type: "string",
        description:
          "Nome e ruolo della persona con budget authority che deve approvare l'acquisto. Null se non identificato o se identificato solo per nome senza conferma di coinvolgimento attivo.",
      },
      champion: {
        type: "string",
        description:
          "Nome e ruolo della persona interna che sta sponsorizzando l'acquisto. Null se non identificato.",
      },
      mutual_close_plan: {
        type: "string",
        description:
          "Step concreti e date per arrivare alla firma, concordati con il prospect. Null se non esiste un piano con date specifiche.",
      },
      call_signals: {
        type: "object",
        description: "Segnali qualitativi dalla call",
        properties: {
          buyer_engagement: {
            type: "string",
            enum: ["high", "medium", "low", "unclear"],
          },
          objections_raised: {
            type: "array",
            items: { type: "string" },
          },
          next_step_committed: { type: "string" },
        },
      },
    },
    required: ["deal_identification", "call_signals"],
  },
};

// ============================================================
// FUNZIONE PRINCIPALE
// ============================================================
export async function processSpicedNote({
  transcript,
  repId,
  repName,
  dealId, // opzionale — se non passato, lo identifichiamo noi
  source,
  audioDurationSec,
}) {
  // 1. Se non abbiamo il dealId, identifichiamolo dal contesto
  let resolvedDealId = dealId;
  let dealName;

  const extraction = await extractSpicedFromTranscript(transcript, repId);

  if (!resolvedDealId) {
    const match = await matchDealByAccountName(
      extraction.deal_identification.account_name,
      repId
    );

    if (!match) {
      throw new Error(
        `Non sono riuscito a identificare il deal per "${extraction.deal_identification.account_name}". Specifica il nome account nella nota.`
      );
    }
    resolvedDealId = match.id;
    dealName = match.name;
  } else {
    const deal = await db.query("SELECT name FROM deals WHERE id = $1", [
      resolvedDealId,
    ]);
    dealName = deal.rows[0]?.name;
  }

  // 2. Quality check sui campi critici
  const missingFields = CRITICAL_FIELDS.filter((field) => !extraction[field]);
  const filledFields = ALL_FIELDS.filter((field) => extraction[field]).length;
  const qualityScore = Math.round((filledFields / ALL_FIELDS.length) * 100);
  const needsFollowup = missingFields.length > 0;

  // 3. Salva audit trail nel DB
  const saved = await db.query(
    `INSERT INTO spiced_notes
      (deal_id, rep_id, source, raw_transcript, audio_duration_sec,
       situation, pain, impact, critical_event, decision_process,
       economic_buyer, champion, mutual_close_plan,
       missing_fields, quality_score, needs_followup)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING id`,
    [
      resolvedDealId,
      repId,
      source,
      transcript,
      audioDurationSec || null,
      extraction.situation,
      extraction.pain,
      extraction.impact,
      extraction.critical_event,
      extraction.decision_process,
      extraction.economic_buyer,
      extraction.champion,
      extraction.mutual_close_plan,
      missingFields,
      qualityScore,
      needsFollowup,
    ]
  );

  // 4. Scrivi nel CRM (Salesforce/HubSpot)
  const crmResult = await writeSpicedToCRM(resolvedDealId, extraction);

  await db.query(
    "UPDATE spiced_notes SET crm_synced = true, crm_sync_at = NOW(), crm_record_id = $1 WHERE id = $2",
    [crmResult.id, saved.rows[0].id]
  );

  return {
    deal_id: resolvedDealId,
    deal_name: dealName,
    spiced: extraction,
    missing_fields: missingFieldsToItalian(missingFields),
    quality_score: qualityScore,
    needs_followup: needsFollowup,
    call_signals: extraction.call_signals,
  };
}

// ============================================================
// ESTRAZIONE via Claude con tool use forzato
// ============================================================
async function extractSpicedFromTranscript(transcript, repId) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    tools: [EXTRACTION_TOOL],
    tool_choice: { type: "tool", name: "submit_spiced_extraction" },
    messages: [
      {
        role: "user",
        content: `Sei un analista RevOps esperto nella metodologia SPICED (Situation, Pain, Impact, Critical Event, Decision). Analizza questa trascrizione (nota vocale di un rep o trascrizione di una call con un prospect) ed estrai i campi SPICED in modo rigoroso.

REGOLE IMPORTANTI:
- Estrai solo informazioni esplicitamente presenti o fortemente implicite nel testo. Non inventare.
- Per Critical Event: un vero critical event ha una scadenza esterna concreta (fine contratto attuale, audit regolatorio, evento di business). "Vogliamo chiudere entro fine quarter" detto solo dal rep NON è un critical event valido — è pressione interna.
- Per Economic Buyer: deve essere una persona nominata con autorità di budget confermata, non solo "probabilmente serve l'approvazione del CFO".
- Se un campo non è chiaramente presente nella trascrizione, lascialo null. Non riempire per completezza.
- Sii specifico: "il prospect ha un problema con i report" è debole, "i team perdono 5 ore a settimana a consolidare report manualmente da 3 sistemi diversi" è una buona estrazione.

TRASCRIZIONE:
${transcript}

Estrai i campi SPICED usando il tool submit_spiced_extraction.`,
      },
    ],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse) {
    throw new Error("Claude non ha ritornato un'estrazione strutturata");
  }

  return toolUse.input;
}

// ============================================================
// MATCH DEAL by account name (fuzzy match sui deal aperti del rep)
// ============================================================
async function matchDealByAccountName(accountName, repId) {
  if (!accountName) return null;

  const result = await db.query(
    `SELECT d.id, d.name, a.name as account_name
     FROM deals d
     JOIN accounts a ON a.id = d.account_id
     WHERE d.owner_id = $1
       AND d.stage_name NOT IN ('Closed Won', 'Closed Lost')
       AND similarity(a.name, $2) > 0.4
     ORDER BY similarity(a.name, $2) DESC
     LIMIT 1`,
    [repId, accountName]
  );

  return result.rows[0] || null;
}

function missingFieldsToItalian(fields) {
  const map = {
    economic_buyer: "Economic Buyer",
    critical_event: "Critical Event",
    decision_process: "Decision Process",
  };
  return fields.map((f) => map[f] || f);
}
