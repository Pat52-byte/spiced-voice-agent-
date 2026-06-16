# Analisi SWOT — Schema SPICED in questo repo

Questo documento spiega il razionale dietro ogni deviazione dello schema in `agent/spiced_processor.js` rispetto al framework SPICED da manuale. Se stai valutando se modificare lo schema, leggi prima questo.

## Punti di forza del framework di base

- **Linguaggio comune** tra rep, manager e forecast review. Una pipeline review smette di essere "Marco dice che il deal va bene" e diventa verificabile campo per campo.
- **Più leggero di MEDDPICC** (5-7 campi contro 8), pensato per cicli di vendita veloci.
- **Impact e Critical Event** sono i due campi più difficili da compilare senza che sia vero — buon filtro naturale contro i deal di cortesia.

## Debolezze corrette in questo repo

| Debolezza originale | Dove è risolta nel codice |
|---|---|
| Critical Event confuso con pressione interna del rep | `critical_event_external` + `internal_pressure_detected` in `spiced_processor.js` |
| Nessuna distinzione "menzionato" vs "confermato" | `confirmation_level` su `economic_buyer` e `champion` |
| Impact accettato anche se vago | `impact_quantified: boolean`, validato nel prompt |
| Nessun campo Competitor nativo | `competitor_status`, `primary_competitor` |
| Decision come campo contenitore unico | Spacchettato in `decision_makers`, `decision_criteria`, `decision_timeline` |

## Minacce e come questo repo le mitiga

**Diventa burocrazia se il management non lo usa per decidere.** Non risolvibile nel codice — richiede una regola di forecast governance lato organizzazione (declassare automaticamente dal forecast Commit i deal con gap critici). Vedi raccomandazione in `agent/quality_check.js`.

**Gaming del sistema.** Mitigato parzialmente da `discrepancy_flags` e `cross_validated` — il confronto automatico tra nota vocale e trascrizione reale della call. Non sostituisce l'audit periodico umano.

**Il voice agent rende il gaming più facile, non solo la compilazione.** È la minaccia più seria introdotta da questo specifico sistema (rispetto a compilazione manuale via form). La cross-validation è la difesa principale, ma richiede che esista anche la trascrizione automatica della call (quindi richiede l'auto-capture, non solo il flusso Slack).

## Decisione di design: perché non abbiamo adottato MEDDPICC

MEDDPICC ha un campo Competition nativo e separa meglio Decision Criteria da Decision Process. Lo abbiamo scartato come framework completo perché i suoi 8 campi aumentano sensibilmente l'attrito di compilazione — il problema che questo intero sistema cerca di risolvere. Abbiamo preso in prestito la sua granularità solo dove necessario (split di Decision, aggiunta di Competitor) mantenendo la leggerezza di SPICED per il resto.
