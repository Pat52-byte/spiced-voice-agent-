-- ============================================================
-- SPICED VOICE AGENT — Schema e tracking
-- ============================================================

-- Tabella per ogni nota vocale processata (audit trail)
CREATE TABLE IF NOT EXISTS spiced_notes (
  id                  SERIAL PRIMARY KEY,
  deal_id             TEXT NOT NULL,
  rep_id              TEXT NOT NULL,
  source              TEXT NOT NULL,        -- 'slack_voice' | 'zoom_capture' | 'meet_capture'
  raw_transcript      TEXT,
  audio_duration_sec  INTEGER,

  -- Campi SPICED estratti
  situation           TEXT,
  pain                TEXT,
  impact               TEXT,
  critical_event       TEXT,
  decision_process      TEXT,
  economic_buyer        TEXT,
  champion              TEXT,
  mutual_close_plan     TEXT,

  -- Quality check
  missing_fields        TEXT[],            -- array dei campi critici mancanti
  quality_score          INTEGER,           -- 0-100
  needs_followup          BOOLEAN DEFAULT false,

  -- CRM sync
  crm_synced              BOOLEAN DEFAULT false,
  crm_sync_at              TIMESTAMPTZ,
  crm_record_id            TEXT,

  created_at               TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_spiced_deal   ON spiced_notes(deal_id);
CREATE INDEX IF NOT EXISTS idx_spiced_rep    ON spiced_notes(rep_id, created_at);
CREATE INDEX IF NOT EXISTS idx_spiced_needs  ON spiced_notes(needs_followup) WHERE needs_followup = true;

-- View: storico SPICED per deal (merge di tutte le note nel tempo)
-- L'ultima nota per ogni campo "vince" se non è null
CREATE OR REPLACE VIEW v_deal_spiced_current AS
SELECT
  deal_id,
  (array_agg(situation         ORDER BY created_at DESC) FILTER (WHERE situation IS NOT NULL))[1]         AS situation,
  (array_agg(pain               ORDER BY created_at DESC) FILTER (WHERE pain IS NOT NULL))[1]               AS pain,
  (array_agg(impact             ORDER BY created_at DESC) FILTER (WHERE impact IS NOT NULL))[1]             AS impact,
  (array_agg(critical_event     ORDER BY created_at DESC) FILTER (WHERE critical_event IS NOT NULL))[1]     AS critical_event,
  (array_agg(decision_process   ORDER BY created_at DESC) FILTER (WHERE decision_process IS NOT NULL))[1]   AS decision_process,
  (array_agg(economic_buyer     ORDER BY created_at DESC) FILTER (WHERE economic_buyer IS NOT NULL))[1]     AS economic_buyer,
  (array_agg(champion           ORDER BY created_at DESC) FILTER (WHERE champion IS NOT NULL))[1]           AS champion,
  (array_agg(mutual_close_plan  ORDER BY created_at DESC) FILTER (WHERE mutual_close_plan IS NOT NULL))[1]  AS mutual_close_plan,
  MAX(created_at)                                                                                            AS last_updated,
  COUNT(*)                                                                                                    AS total_notes
FROM spiced_notes
GROUP BY deal_id;
