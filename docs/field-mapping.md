# Mapping Custom Field — Salesforce / HubSpot

Riferimento completo per la creazione dei campi nel CRM prima del primo deploy. Vedi anche `crm/spiced_writeback.js` per il codice che usa questi nomi.

## Salesforce

Setup → Object Manager → Opportunity → Fields & Relationships → New

| Campo SPICED interno | Label suggerita | Tipo Salesforce | API Name |
|---|---|---|---|
| `situation` | SPICED Situation | Long Text Area (32768) | `SPICED_Situation__c` |
| `pain` | SPICED Pain | Long Text Area (32768) | `SPICED_Pain__c` |
| `impact` | SPICED Impact | Long Text Area (32768) | `SPICED_Impact__c` |
| `critical_event_external` | SPICED Critical Event | Long Text Area (32768) | `SPICED_Critical_Event__c` |
| `decision_makers` | SPICED Decision Makers | Long Text Area (32768) | `SPICED_Decision_Makers__c` |
| `decision_criteria` | SPICED Decision Criteria | Long Text Area (32768) | `SPICED_Decision_Criteria__c` |
| `decision_timeline` | SPICED Decision Timeline | Long Text Area (32768) | `SPICED_Decision_Timeline__c` |
| `economic_buyer.name` + `.role` | SPICED Economic Buyer | Text (255) | `SPICED_Economic_Buyer__c` |
| `champion.name` + `.role` | SPICED Champion | Text (255) | `SPICED_Champion__c` |
| `mutual_close_plan` | SPICED Mutual Close Plan | Long Text Area (32768) | `SPICED_Mutual_Close_Plan__c` |
| `primary_competitor` | Primary Competitor | Text (255) | `SPICED_Primary_Competitor__c` |
| `quality_score` (calcolato) | SPICED Quality Score | Number (3,0) | `SPICED_Quality_Score__c` |

> I campi `confirmation_level` e `competitor_status` non hanno un campo CRM dedicato di default nello schema attuale — vivono nella tabella `spiced_notes` di Postgres come audit trail. Se serve visibilità diretta nel CRM, aggiungili come Picklist con i valori dell'enum corrispondente.

## HubSpot

Settings → Properties → Deal properties → Create property

Stessa struttura, naming convention snake_case:

| Campo SPICED interno | Internal name HubSpot |
|---|---|
| `situation` | `spiced_situation` |
| `pain` | `spiced_pain` |
| `impact` | `spiced_impact` |
| `critical_event_external` | `spiced_critical_event` |
| `decision_makers` | `spiced_decision_makers` |
| `decision_criteria` | `spiced_decision_criteria` |
| `decision_timeline` | `spiced_decision_timeline` |
| `economic_buyer` | `spiced_economic_buyer` |
| `champion` | `spiced_champion` |
| `mutual_close_plan` | `spiced_mutual_close_plan` |
| `primary_competitor` | `spiced_primary_competitor` |

## Aggiornare il mapping nel codice

Se la tua org usa nomi diversi da questi default, aggiorna le costanti in cima a `crm/spiced_writeback.js`:

```javascript
const SALESFORCE_FIELD_MAP = {
  situation: "Il_Tuo_Nome_Campo__c",
  // ...
};
```

Nessun altro file deve essere toccato — `spiced_processor.js` lavora sempre sui nomi interni (`situation`, `pain`, ecc.), il mapping ai nomi CRM avviene solo al momento del write-back.
