// ============================================================
// SERVER — Entry point con tutti i webhook endpoint
// ============================================================
import express from "express";
import cron from "node-cron";
import { handleSlackEvent } from "./slack/voice_handler.js";
import {
  handleTranscriptReady,
  autoScheduleBotsForUpcomingCalls,
} from "./call-capture/zoom_meet_capture.js";
import { runSpicedQualityCheck } from "./agent/quality_check.js";

const app = express();
app.use(express.json());

// ============================================================
// SLACK — voice note dal rep
// ============================================================
app.post("/slack/events", handleSlackEvent);

// ============================================================
// RECALL.AI — webhook quando una call è trascritta
// ============================================================
app.post("/webhooks/recall/transcript-ready", handleTranscriptReady);

// ============================================================
// HEALTH CHECK
// ============================================================
app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server attivo su porta ${PORT}`));

// ============================================================
// CRON JOBS
// ============================================================

// Ogni ora: controlla calendario e schedula bot per call imminenti
cron.schedule("0 * * * *", async () => {
  console.log("⏰ Auto-scheduling bot per call imminenti...");
  await autoScheduleBotsForUpcomingCalls().catch(console.error);
});

// Ogni notte alle 03:00: quality check sui gap SPICED
cron.schedule("0 3 * * *", async () => {
  console.log("⏰ Running SPICED quality check...");
  await runSpicedQualityCheck().catch(console.error);
});

console.log("⏱  Cron jobs attivi: auto-schedule (ogni ora), quality check (03:00)");
