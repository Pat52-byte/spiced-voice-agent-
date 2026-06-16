// ============================================================
// SLACK VOICE NOTE HANDLER
// Il rep manda un voice note su Slack dopo una call.
// Slack lo trascrive automaticamente, noi prendiamo il testo.
// ============================================================

import { processSpicedNote } from "../agent/spiced_processor.js";

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

// ============================================================
// SLACK EVENTS API — listener per messaggi audio
// Endpoint: POST /slack/events
// ============================================================
export async function handleSlackEvent(req, res) {
  const { event } = req.body;

  // Slack manda un evento "message" con files quando viene
  // condiviso un voice clip (subtype: file_share, mimetype: audio/*)
  if (event?.type !== "message" || !event.files) {
    return res.status(200).send("ok");
  }

  const audioFile = event.files.find((f) =>
    f.mimetype?.startsWith("audio/")
  );

  if (!audioFile) {
    return res.status(200).send("ok");
  }

  // Risposta immediata a Slack (richiede <3s) — processiamo async
  res.status(200).send("ok");

  try {
    await handleVoiceNote({
      audioUrl: audioFile.url_private,
      slackUserId: event.user,
      channelId: event.channel,
      threadTs: event.ts,
      // Slack a volte fornisce trascrizione automatica nel campo transcription
      slackTranscript: audioFile.transcription?.preview?.content,
    });
  } catch (err) {
    console.error("❌ Errore processing voice note:", err);
    await postSlackMessage(
      event.channel,
      `⚠️ Non sono riuscito a processare la nota vocale: ${err.message}`,
      event.ts
    );
  }
}

// ============================================================
// PIPELINE: download audio → trascrivi (se serve) → identifica deal
// → estrai SPICED → quality check → CRM write-back → risposta
// ============================================================
async function handleVoiceNote({
  audioUrl,
  slackUserId,
  channelId,
  threadTs,
  slackTranscript,
}) {
  // 1. Mappa Slack user ID → rep nel CRM
  const rep = await getRepBySlackId(slackUserId);
  if (!rep) {
    throw new Error(
      "Rep non trovato. Collega il tuo account Slack al CRM con /link-crm"
    );
  }

  // 2. Reazione "in lavorazione" per dare feedback immediato
  await addSlackReaction(channelId, threadTs, "hourglass_flowing_sand");

  // 3. Trascrizione: usa quella di Slack se c'è, altrimenti Whisper
  const transcript =
    slackTranscript || (await transcribeAudio(audioUrl));

  // 4. Identifica il deal di cui si sta parlando
  //    (l'agente Claude lo fa leggendo il contesto della trascrizione)
  const result = await processSpicedNote({
    transcript,
    repId: rep.id,
    repName: rep.name,
    source: "slack_voice",
  });

  // 5. Rimuovi reazione "in lavorazione", aggiungi "fatto"
  await removeSlackReaction(channelId, threadTs, "hourglass_flowing_sand");
  await addSlackReaction(channelId, threadTs, "white_check_mark");

  // 6. Rispondi nel thread con il riepilogo
  await postSpicedSummary(channelId, threadTs, result);
}

// ============================================================
// TRASCRIZIONE AUDIO (fallback se Slack non la fornisce)
// ============================================================
async function transcribeAudio(audioUrl) {
  // Scarica il file da Slack (richiede auth header)
  const audioResponse = await fetch(audioUrl, {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
  });
  const audioBuffer = await audioResponse.arrayBuffer();

  // Manda a OpenAI Whisper (o servizio equivalente)
  const formData = new FormData();
  formData.append(
    "file",
    new Blob([audioBuffer], { type: "audio/mp4" }),
    "voice_note.mp4"
  );
  formData.append("model", "whisper-1");
  formData.append("language", "it");

  const whisperResponse = await fetch(
    "https://api.openai.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: formData,
    }
  );

  const data = await whisperResponse.json();
  return data.text;
}

// ============================================================
// RISPOSTA SLACK — riepilogo con quality check visibile
// ============================================================
async function postSpicedSummary(channelId, threadTs, result) {
  const { deal_name, spiced, missing_fields, quality_score } = result;

  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `✅ *Nota aggiornata per ${deal_name}*\n_Quality score: ${quality_score}/100_`,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Situation:*\n${spiced.situation || "—"}` },
        { type: "mrkdwn", text: `*Pain:*\n${spiced.pain || "—"}` },
        { type: "mrkdwn", text: `*Impact:*\n${spiced.impact || "—"}` },
        {
          type: "mrkdwn",
          text: `*Critical Event:*\n${spiced.critical_event || "—"}`,
        },
        {
          type: "mrkdwn",
          text: `*Economic Buyer:*\n${spiced.economic_buyer || "⚠️ Non specificato"}`,
        },
        {
          type: "mrkdwn",
          text: `*Decision Process:*\n${spiced.decision_process || "⚠️ Non specificato"}`,
        },
      ],
    },
  ];

  // Se manca qualcosa di critico, aggiungi alert visibile
  if (missing_fields.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `🟠 *Campi critici mancanti:* ${missing_fields.join(", ")}\nConsiglio: chiarisci questi punti nella prossima call.`,
      },
    });
  }

  blocks.push({
    type: "context",
    elements: [
      { type: "mrkdwn", text: "Sincronizzato automaticamente nel CRM ✓" },
    ],
  });

  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({
      channel: channelId,
      thread_ts: threadTs,
      blocks,
      text: `Nota SPICED aggiornata per ${deal_name}`,
    }),
  });
}

// ============================================================
// HELPERS
// ============================================================
async function addSlackReaction(channel, timestamp, name) {
  await fetch("https://slack.com/api/reactions.add", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel, timestamp, name }),
  });
}

async function removeSlackReaction(channel, timestamp, name) {
  await fetch("https://slack.com/api/reactions.remove", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel, timestamp, name }),
  });
}

async function postSlackMessage(channel, text, threadTs) {
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({ channel, text, thread_ts: threadTs }),
  });
}

async function getRepBySlackId(slackUserId) {
  // Query al tuo DB: mappa slack_user_id -> rep CRM record
  const { default: db } = await import("../db.js");
  const result = await db.query(
    "SELECT id, name, crm_owner_id FROM users WHERE slack_user_id = $1",
    [slackUserId]
  );
  return result.rows[0] || null;
}
