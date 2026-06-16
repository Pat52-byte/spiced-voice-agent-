// ============================================================
// ZOOM / GOOGLE MEET AUTO-CAPTURE
// Un bot si unisce automaticamente alle call dei rep (via
// Recall.ai o simile), registra, trascrive, e a fine call
// triggera l'estrazione SPICED automaticamente — zero sforzo
// per il rep.
// ============================================================

// Usiamo Recall.ai come orchestratore (supporta Zoom, Meet, Teams)
// Alternative: Fireflies.ai, Otter.ai webhook, o bot custom
const RECALL_API_KEY = process.env.RECALL_API_KEY;

// ============================================================
// STEP 1 — Il bot si unisce automaticamente alla call
// Triggerato quando rilevi un evento calendario con link Zoom/Meet
// (gira come job collegato al sync calendario, non per ogni call)
// ============================================================
export async function scheduleBotForMeeting({ meetingUrl, dealId, repId, startTime }) {
  const response = await fetch("https://api.recall.ai/api/v1/bot", {
    method: "POST",
    headers: {
      Authorization: `Token ${RECALL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      meeting_url: meetingUrl,
      join_at: startTime,
      transcription_options: { provider: "assembly_ai" },
      metadata: { deal_id: dealId, rep_id: repId },
    }),
  });

  const bot = await response.json();
  console.log(`🤖 Bot schedulato per deal ${dealId}: ${bot.id}`);
  return bot;
}

// ============================================================
// STEP 2 — Webhook: Recall.ai notifica quando la trascrizione
// è pronta (di solito 1-2 minuti dopo la fine della call)
// Endpoint: POST /webhooks/recall/transcript-ready
// ============================================================
export async function handleTranscriptReady(req, res) {
  const { bot_id, status } = req.body;

  if (status !== "done") {
    return res.status(200).send("ok");
  }

  res.status(200).send("ok"); // ack immediato, processa async

  try {
    await processCallTranscript(bot_id);
  } catch (err) {
    console.error(`❌ Errore processing call ${bot_id}:`, err);
  }
}

async function processCallTranscript(botId) {
  // 1. Recupera bot info + metadata (deal_id, rep_id)
  const botResponse = await fetch(
    `https://api.recall.ai/api/v1/bot/${botId}`,
    { headers: { Authorization: `Token ${RECALL_API_KEY}` } }
  );
  const bot = await botResponse.json();
  const { deal_id, rep_id } = bot.metadata;

  // 2. Recupera trascrizione completa
  const transcriptResponse = await fetch(
    `https://api.recall.ai/api/v1/bot/${botId}/transcript`,
    { headers: { Authorization: `Token ${RECALL_API_KEY}` } }
  );
  const transcriptData = await transcriptResponse.json();

  // Combina i segmenti in testo continuo con speaker labels
  const fullTranscript = transcriptData.segments
    .map((s) => `${s.speaker}: ${s.text}`)
    .join("\n");

  // 3. Recupera info rep
  const { default: db } = await import("../db.js");
  const repResult = await db.query(
    "SELECT id, name FROM users WHERE id = $1",
    [rep_id]
  );
  const rep = repResult.rows[0];

  // 4. Processa con l'agente SPICED (stesso pipeline della voice note)
  const { processSpicedNote } = await import(
    "../agent/spiced_processor.js"
  );

  const result = await processSpicedNote({
    transcript: fullTranscript,
    repId: rep.id,
    repName: rep.name,
    dealId: deal_id, // qui lo conosciamo già, niente da indovinare
    source: "call_auto_capture",
    audioDurationSec: bot.recording_duration,
  });

  // 5. Notifica il rep su Slack — passivo, non richiede azione
  await notifyRepOfAutoCapture(rep_id, result);

  console.log(`✅ Call processata per deal ${deal_id}, quality: ${result.quality_score}`);
}

// ============================================================
// NOTIFICA passiva al rep — "ho aggiornato il deal da solo"
// ============================================================
async function notifyRepOfAutoCapture(repId, result) {
  const { default: db } = await import("../db.js");
  const repResult = await db.query(
    "SELECT slack_user_id FROM users WHERE id = $1",
    [repId]
  );
  const slackUserId = repResult.rows[0]?.slack_user_id;
  if (!slackUserId) return;

  const text = result.missing_fields.length > 0
    ? `📝 Ho aggiornato *${result.deal_name}* dalla tua call. Quality: ${result.quality_score}/100.\n⚠️ Manca ancora: ${result.missing_fields.join(", ")} — verifica nel CRM o dettami una nota veloce.`
    : `📝 Ho aggiornato *${result.deal_name}* dalla tua call. Quality: ${result.quality_score}/100. Tutto a posto ✅`;

  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel: slackUserId, text }),
  });
}

// ============================================================
// AUTO-SCHEDULING: gira ogni ora, guarda il calendario dei rep
// e schedula il bot per le call con prospect/clienti nelle
// prossime 2 ore (esclude meeting interni)
// ============================================================
export async function autoScheduleBotsForUpcomingCalls() {
  const { default: db } = await import("../db.js");

  // Recupera eventi calendario sincronizzati (Google Calendar API)
  const events = await getUpcomingExternalMeetings(); // 2h window

  for (const event of events) {
    const dealId = await matchEventToDeal(event); // match by attendee email/account
    if (!dealId) continue; // meeting interno, skip

    const alreadyScheduled = await db.query(
      "SELECT 1 FROM scheduled_bots WHERE meeting_id = $1",
      [event.id]
    );
    if (alreadyScheduled.rows.length > 0) continue;

    await scheduleBotForMeeting({
      meetingUrl: event.meetingUrl,
      dealId,
      repId: event.organizerRepId,
      startTime: event.startTime,
    });

    await db.query(
      "INSERT INTO scheduled_bots (meeting_id, deal_id) VALUES ($1, $2)",
      [event.id, dealId]
    );
  }
}

async function getUpcomingExternalMeetings() {
  // Implementazione: Google Calendar API
  // calendar.events.list con timeMin/timeMax, filtra per
  // attendees con dominio email diverso dal tuo
  throw new Error("Implementa con Google Calendar API — vedi README");
}

async function matchEventToDeal(event) {
  // Match basato su: dominio email attendee esterno -> account -> deal aperto
  const { default: db } = await import("../db.js");
  const externalDomain = event.attendees
    .map((a) => a.email.split("@")[1])
    .find((d) => d !== process.env.COMPANY_DOMAIN);

  const result = await db.query(
    `SELECT d.id FROM deals d
     JOIN accounts a ON a.id = d.account_id
     WHERE a.domain = $1
       AND d.stage_name NOT IN ('Closed Won','Closed Lost')
     ORDER BY d.amount DESC LIMIT 1`,
    [externalDomain]
  );
  return result.rows[0]?.id || null;
}
