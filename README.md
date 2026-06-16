# spiced-voice-agent-
Trasforma le note vocali dei rep in dati SPICED strutturati, validati e sincronizzati nel CRM
# SPICED Voice Agent

> Trasforma le note vocali dei rep in dati SPICED strutturati, validati e sincronizzati automaticamente nel CRM.

[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Claude API](https://img.shields.io/badge/Claude-Sonnet%204.6-D97757)](https://docs.claude.com)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-production-success)]()

---

## Indice

- [Cos'è](#cosè)
- [Come funziona](#come-funziona)
- [Quick start](#quick-start)
- [Schema SPICED](#schema-spiced)
- [Architettura](#architettura)
- [Configurazione](#configurazione)
- [Custom fields CRM](#custom-fields-crm)
- [Testing](#testing)
- [Anti-gaming e qualità dati](#anti-gaming-e-qualità-dati)
- [Privacy e compliance](#privacy-e-compliance)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)
- [Contributing](#contributing)

---

## Cos'è

I rep odiano scrivere note di vendita strutturate. Le dettano volentieri — parlare due minuti dopo una call è frictionless, scrivere un form con 8 campi non lo è.

Questo sistema prende l'input vocale (un voice note su Slack, oppure la registrazione automatica di una call Zoom/Meet) e lo trasforma in campi [SPICED](#schema-spiced) strutturati, li valida contro una taxonomy rigorosa che evita le ambiguità più comuni del framework, e li scrive direttamente nei custom field di Salesforce o HubSpot — senza che il rep tocchi il CRM.

**Due modalità di input:**

| Modalità | Sforzo del rep | Quando usarla |
|---|---|---|
| **Slack voice note** | Attivo — il rep manda un vocale dopo la call | Lancio iniziale, il rep ha controllo su cosa dire |
| **Auto-capture Zoom/Meet** | Passivo — un bot si unisce alla call e registra | Fase 2, dopo aver validato il flusso Slack |

---

## Come funziona

```
Rep detta nota su Slack          Bot registra call Zoom/Meet
         |                                  |
         +----------------+-----------------+
                           v
                  Trascrizione audio
                           |
                           v
        Agente Claude -- estrazione SPICED
        (tool use forzato, no JSON libero)
                           |
                           v
           Quality check campi critici
                           |
              +------------+------------+
              v                         v
       Write-back CRM              Alert al rep
       (merge, non                 (solo se manca
        overwrite)                  un campo)
```

Il dettaglio di ogni step è in [`agent/spiced_processor.js`](agent/spiced_processor.js).

---

## Quick start

```bash
git clone <questo-repo>
cd spiced-voice-agent
npm install

cp .env.example .env
# Compila .env con le tue API key -- vedi sezione Configurazione

# Estensione Postgres necessaria per il fuzzy match account name
psql $DATABASE_URL -c "CREATE EXTENSION IF NOT EXISTS pg_trgm;"

# Crea schema e custom field nel CRM (vedi sezione dedicata)
psql $DATABASE_URL -f sql/schema.sql

npm start
```

Verifica che sia attivo:
```bash
curl http://localhost:3000/health
# {"status":"ok"}
```

---

## Schema SPICED

> Versione corretta dopo analisi SWOT -- vedi [`docs/swot-analysis.md`](docs/swot-analysis.md) per il razionale completo di ogni scelta.

Lo schema **non** è il framework SPICED da manuale. Tre correzioni strutturali sono state applicate per chiudere le ambiguità più comuni:

```typescript
interface SpicedNote {
  // Situation & Pain -- testo libero, nessuna correzione necessaria
  situation: string;
  pain: string;

  // Impact -- richiede quantificazione obbligatoria
  impact: string;
  impact_quantified: boolean;   // true SOLO se contiene un numero verificabile

  // Critical Event -- diviso per separare urgenza reale da pressione del rep
  critical_event_external: string | null;   // scadenza reale del CLIENTE
  internal_pressure_detected: boolean;       // true se la pressione è solo del rep

  // Decision -- spacchettato in 3 (era un solo campo contenitore)
  decision_makers: string;
  decision_criteria: string;
  decision_timeline: string;

  // Persone -- con livello di conferma esplicito
  economic_buyer: {
    name: string;
    role: string;
    confirmation_level: "confirmed_direct_contact" | "mentioned_by_third_party" | "assumed";
  };
  champion: {
    name: string;
    role: string;
    confirmation_level: "actively_advocating" | "supportive" | "unconfirmed";
  };

  // Competitor -- non esiste in SPICED standard, aggiunto come estensione
  competitor_status: "no_competition" | "evaluating_alternatives" | "active_competition" | "lost_evaluation";
  primary_competitor: string | null;

  mutual_close_plan: string | null;

  // Anti-gaming -- popolato solo se esiste anche la trascrizione della call
  discrepancy_flags: string[];
  cross_validated: boolean;
}
```

### Perché ogni correzione esiste

| Campo originale | Problema | Correzione |
|---|---|---|
| `critical_event` (unico) | Il 70% dei rep scrive "vogliono chiudere entro Q2" -- pressione propria, non del cliente | Diviso in `critical_event_external` + `internal_pressure_detected`. Solo il primo conta per lo score. |
| `economic_buyer` (stringa) | "Probabilmente serve l'ok del CFO" passa come campo pieno | Aggiunto `confirmation_level` -- solo `confirmed_direct_contact` conta come compilato |
| `decision` (unico) | I rep scrivono "decide il management" e considerano il campo completo | Spacchettato in `decision_makers`, `decision_criteria`, `decision_timeline` |
| `impact` (stringa) | "Perdono tempo" non è una quantificazione | Richiede `impact_quantified: true` -- un numero, una percentuale, un'unità di tempo/denaro |
| -- | Nessun campo competitor nativo in SPICED | Aggiunto `competitor_status` come estensione |
| -- | Il voice agent rende più facile "raccontare" che descrivere la realtà | Aggiunto `discrepancy_flags` -- confronto automatico nota vocale vs trascrizione call reale |

### Quality score

```
quality_score = (
  situation_filled + pain_filled + impact_quantified +
  critical_event_external_filled +
  decision_makers_filled + decision_criteria_filled + decision_timeline_filled +
  (economic_buyer.confirmation_level == "confirmed_direct_contact") +
  (champion.confirmation_level == "actively_advocating")
) / 9 * 100
```

> **Nota:** il punteggio medio del team scenderà quando questo schema viene introdotto rispetto a una versione SPICED senza i livelli di conferma. È previsto -- il sistema sta finalmente mostrando quanti campi erano "pieni ma non verificati". Comunicarlo al management prima del rollout evita falsi allarmi.

---

## Architettura

```
spiced-voice-agent/
├── sql/
│   └── schema.sql              # Tabella spiced_notes + view v_deal_spiced_current
├── slack/
│   └── voice_handler.js        # Riceve voice note, trascrive se serve, triggera l'estrazione
├── call-capture/
│   └── zoom_meet_capture.js    # Bot Recall.ai: auto-join, webhook trascrizione, auto-scheduling
├── agent/
│   ├── spiced_processor.js     # Core -- estrazione SPICED via Claude tool use
│   └── quality_check.js        # Job notturno: trova gap critici, notifica rep + manager
├── crm/
│   └── spiced_writeback.js     # Merge intelligente + scrittura Salesforce/HubSpot
├── docs/
│   ├── swot-analysis.md        # Analisi SWOT completa del framework
│   └── field-mapping.md        # Mapping custom field per CRM
├── server.js                   # Express + webhook + cron entry point
├── db.js
└── .env.example
```

### Decisioni tecniche chiave

**Tool use forzato, non prompt JSON.** `spiced_processor.js` usa `tool_choice: {type: "tool", name: "submit_spiced_extraction"}`. Niente parsing fragile di markdown fences, output sempre conforme allo schema.

**Merge, non overwrite.** Se una nuova nota non menziona l'Economic Buyer (magari il rep parla solo di pricing in quella call), il sistema non sovrascrive il valore già confermato nel CRM con `null`. Vedi `mergeFields()` in [`crm/spiced_writeback.js`](crm/spiced_writeback.js).

**Validazione del Critical Event nel prompt, non solo nello schema.** Il prompt istruisce Claude esplicitamente a non accettare "fine quarter" come critical event valido se non c'è un vero evento esterno -- è una regola semantica, non solo un tipo di dato.

---

## Configurazione

### Variabili d'ambiente

Copia `.env.example` in `.env` e compila:

```bash
ANTHROPIC_API_KEY=sk-ant-...
DATABASE_URL=postgresql://user:password@host:5432/revops_db

SLACK_BOT_TOKEN=xoxb-...
SLACK_MANAGER_CHANNEL=#revops-alerts

OPENAI_API_KEY=sk-...          # fallback trascrizione, se Slack non la fornisce
RECALL_API_KEY=...             # solo se usi l'auto-capture Zoom/Meet

CRM_TYPE=salesforce            # oppure: hubspot
SALESFORCE_INSTANCE_URL=https://yourorg.salesforce.com
SALESFORCE_ACCESS_TOKEN=...
HUBSPOT_API_KEY=pat-na1-...

COMPANY_DOMAIN=tuaazienda.com   # per distinguere meeting interni da esterni
```

### Setup Slack

1. Crea una Slack App su [api.slack.com/apps](https://api.slack.com/apps)
2. Abilita **Events API**, sottoscrivi `message.channels` e `message.im`
3. Abilita la **trascrizione automatica dei voice clip** nel workspace (Settings → Messaging) -- riduce drasticamente la dipendenza dal fallback Whisper
4. Punta l'Event Subscription URL a `https://tuo-server.com/slack/events`

### Setup Recall.ai (solo per auto-capture)

1. Crea un account su [recall.ai](https://recall.ai), genera l'API key
2. Configura il webhook: `https://tuo-server.com/webhooks/recall/transcript-ready`
3. **Prima di abilitarlo**: verifica i requisiti di consenso per la registrazione nella tua giurisdizione -- vedi [Privacy e compliance](#privacy-e-compliance)

---

## Custom fields CRM

Prima del primo deploy, crea questi campi nel CRM. Mapping completo in [`docs/field-mapping.md`](docs/field-mapping.md).

<details>
<summary><strong>Salesforce</strong> -- Setup -> Object Manager -> Opportunity -> Fields</summary>

| Campo | Tipo | API Name |
|---|---|---|
| SPICED Situation | Long Text Area | `SPICED_Situation__c` |
| SPICED Pain | Long Text Area | `SPICED_Pain__c` |
| SPICED Impact | Long Text Area | `SPICED_Impact__c` |
| SPICED Critical Event | Long Text Area | `SPICED_Critical_Event__c` |
| SPICED Decision Process | Long Text Area | `SPICED_Decision_Process__c` |
| SPICED Economic Buyer | Text | `SPICED_Economic_Buyer__c` |
| SPICED Champion | Text | `SPICED_Champion__c` |
| SPICED Mutual Close Plan | Long Text Area | `SPICED_Mutual_Close_Plan__c` |

</details>

<details>
<summary><strong>HubSpot</strong> -- Settings -> Properties -> Deal properties</summary>

Stessi campi, naming convention snake_case (`spiced_situation`, `spiced_pain`, ecc.) -- vedi `HUBSPOT_FIELD_MAP` in [`crm/spiced_writeback.js`](crm/spiced_writeback.js).

</details>

Se usi nomi diversi dai default, aggiorna `SALESFORCE_FIELD_MAP` / `HUBSPOT_FIELD_MAP` nel file sopra.

---

## Testing

Test rapido senza Slack o Recall.ai -- chiama direttamente il processor:

```javascript
import { processSpicedNote } from './agent/spiced_processor.js';

const result = await processSpicedNote({
  transcript: `Ho appena finito la call con Acme Corp. Il CFO Marco Bianchi
    era presente e ha confermato che ha lui il budget per questo. Hanno
    bisogno di sostituire il sistema attuale entro fine trimestre perché
    il contratto con il vendor attuale scade il 30 settembre e non vogliono
    rinnovare. Stanno perdendo circa 15 ore a settimana tra i team per
    consolidare i dati manualmente. Non abbiamo ancora parlato di come
    decideranno internamente.`,
  repId: 'rep_123',
  repName: 'Test Rep',
  source: 'manual_test',
});

console.log(result);
```

Output atteso:
```js
{
  economic_buyer: { name: "Marco Bianchi", role: "CFO", confirmation_level: "confirmed_direct_contact" },
  critical_event_external: "Contratto vendor attuale scade il 30 settembre",
  internal_pressure_detected: false,
  impact: "15 ore/settimana per consolidamento manuale",
  impact_quantified: true,
  decision_makers: null,        // mai discusso in questa call
  decision_criteria: null,
  decision_timeline: null,
  quality_score: 56,            // 5/9 campi confermati
  needs_followup: true          // manca il blocco decision
}
```

---

## Anti-gaming e qualità dati

L'automazione vocale riduce l'attrito di compilazione ma non l'incentivo a "raccontare" alla nota quello che si vorrebbe fosse vero. Due meccanismi mitigano questo rischio:

**Cross-validation automatica.** Quando esistono sia la nota vocale del rep sia la trascrizione reale della call (via auto-capture), un controllo confronta le due fonti. Se il rep dichiara "il CFO ha confermato il budget" ma nessun CFO ne parla nella trascrizione, il campo `discrepancy_flags` si popola e diventa visibile al manager.

**Audit a campione.** Indipendentemente dal codice, il manager dovrebbe ascoltare 3-5 call al mese a caso e confrontarle con la nota generata. Il dettaglio del processo di audit è in [`docs/swot-analysis.md`](docs/swot-analysis.md#minacce).

---

## Privacy e compliance

> Le call con prospect/clienti passano attraverso API esterne (trascrizione + Claude). Verifica questi punti prima del primo deploy in produzione.

- [ ] **DPA con Anthropic** verificato per il proprio tier di utilizzo
- [ ] **Disclosure ai partecipanti esterni** se si usa l'auto-capture -- molte giurisdizioni richiedono consenso esplicito alla registrazione
- [ ] **Base legale GDPR** documentata per il trattamento (probabilmente legittimo interesse, ma va formalizzato)
- [ ] **Anonimizzazione** valutata per lo storage a lungo termine di trascrizioni con dati sensibili

Questo sistema non sostituisce una consulenza legale -- verifica con il team legal/compliance interno prima del rollout su clienti reali.

---

## Troubleshooting

<details>
<summary>Il rep manda un voice note ma non succede nulla</summary>

Verifica che l'utente Slack sia mappato nel CRM:
```sql
SELECT * FROM users WHERE slack_user_id = '<id>';
```
Se non esiste, il rep deve collegare il proprio account (vedi messaggio di errore restituito da `voice_handler.js`).
</details>

<details>
<summary>L'estrazione SPICED non trova il deal corretto</summary>

Il matching usa fuzzy search su `pg_trgm` sul nome account. Verifica che l'estensione sia installata:
```sql
SELECT * FROM pg_extension WHERE extname = 'pg_trgm';
```
Se il nome account nella trascrizione differisce molto dal nome nel CRM (es. abbreviazioni), passa `dealId` esplicitamente quando possibile (caso dell'auto-capture, dove il deal è già noto dal matching calendario).
</details>

<details>
<summary>Il quality score è più basso di quanto mi aspettassi</summary>

Probabilmente corretto -- vedi la nota nella sezione [Quality score](#quality-score). Solo i campi con `confirmation_level` massimo contano come pieni.
</details>

---

## Roadmap

- [ ] Slash command Slack `/spiced @rep` per vista self-service del profilo deal
- [ ] Dashboard manager con trend storico quality score per rep
- [ ] Estensione campi opzionali per deal enterprise sopra soglia ARR (Paper Process, Competition formale)
- [ ] Integrazione diretta con Deal Post-Mortem Agent per cross-check automatico Economic Buyer confermato vs coinvolgimento reale nelle call

---

## Contributing

Le modifiche allo schema SPICED vanno discusse prima in un issue -- cambiare un campo qui impatta sia il prompt Claude sia il quality score sia il mapping CRM. Per bug fix su connettori (Slack, Recall.ai, CRM write-back), PR dirette sono benvenute.

```bash
npm run lint
npm test
```

---

## Licenza

MIT -- vedi [LICENSE](LICENSE)
