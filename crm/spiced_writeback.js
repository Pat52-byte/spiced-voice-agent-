// ============================================================
// SPICED CRM WRITE-BACK
// Scrive i campi estratti direttamente nei custom fields
// SPICED di Salesforce o HubSpot. Fa merge intelligente:
// non sovrascrive un campo già pieno con null.
// ============================================================

const CRM_TYPE = process.env.CRM_TYPE || "salesforce";
const SF_INSTANCE_URL = process.env.SALESFORCE_INSTANCE_URL;
const SF_ACCESS_TOKEN = process.env.SALESFORCE_ACCESS_TOKEN;
const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY;

// ============================================================
// MAPPING: campi SPICED -> custom field API names nel CRM
// Personalizza questi nomi in base al setup del tuo Salesforce/HubSpot
// ============================================================
const SALESFORCE_FIELD_MAP = {
  situation: "SPICED_Situation__c",
  pain: "SPICED_Pain__c",
  impact: "SPICED_Impact__c",
  critical_event: "SPICED_Critical_Event__c",
  decision_process: "SPICED_Decision_Process__c",
  economic_buyer: "SPICED_Economic_Buyer__c",
  champion: "SPICED_Champion__c",
  mutual_close_plan: "SPICED_Mutual_Close_Plan__c",
};

const HUBSPOT_FIELD_MAP = {
  situation: "spiced_situation",
  pain: "spiced_pain",
  impact: "spiced_impact",
  critical_event: "spiced_critical_event",
  decision_process: "spiced_decision_process",
  economic_buyer: "spiced_economic_buyer",
  champion: "spiced_champion",
  mutual_close_plan: "spiced_mutual_close_plan",
};

// ============================================================
// MAIN EXPORT
// ============================================================
export async function writeSpicedToCRM(dealId, extraction) {
  // Recupera i valori attuali nel CRM per fare merge (non sovrascrivere
  // un campo pieno con uno vuoto se la nuova call non l'ha menzionato)
  const current = await getCurrentSpicedFields(dealId);

  const merged = mergeFields(current, extraction);

  if (CRM_TYPE === "salesforce") {
    return await updateSalesforceOpportunity(dealId, merged);
  } else {
    return await updateHubspotDeal(dealId, merged);
  }
}

// ============================================================
// MERGE LOGIC — la nuova nota arricchisce, non sostituisce a vuoto
// ============================================================
function mergeFields(current, extraction) {
  const merged = {};
  const fields = [
    "situation",
    "pain",
    "impact",
    "critical_event",
    "decision_process",
    "economic_buyer",
    "champion",
    "mutual_close_plan",
  ];

  for (const field of fields) {
    // Se la nuova estrazione ha un valore, usalo (aggiornamento più recente)
    // Altrimenti mantieni quello che c'è già nel CRM
    merged[field] = extraction[field] || current[field] || null;
  }

  return merged;
}

// ============================================================
// SALESFORCE — aggiorna Opportunity custom fields
// ============================================================
async function getCurrentSpicedFields(dealId) {
  if (CRM_TYPE === "salesforce") {
    const fieldsToQuery = Object.values(SALESFORCE_FIELD_MAP).join(",");
    const response = await fetch(
      `${SF_INSTANCE_URL}/services/data/v59.0/sobjects/Opportunity/${dealId}?fields=${fieldsToQuery}`,
      { headers: { Authorization: `Bearer ${SF_ACCESS_TOKEN}` } }
    );
    const data = await response.json();

    const reversedMap = Object.fromEntries(
      Object.entries(SALESFORCE_FIELD_MAP).map(([k, v]) => [v, k])
    );
    const current = {};
    for (const [sfField, value] of Object.entries(data)) {
      if (reversedMap[sfField]) current[reversedMap[sfField]] = value;
    }
    return current;
  }
  return {}; // HubSpot: implementazione analoga se necessario
}

async function updateSalesforceOpportunity(dealId, fields) {
  const payload = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null) {
      payload[SALESFORCE_FIELD_MAP[key]] = value;
    }
  }

  const response = await fetch(
    `${SF_INSTANCE_URL}/services/data/v59.0/sobjects/Opportunity/${dealId}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SF_ACCESS_TOKEN}`,
      },
      body: JSON.stringify(payload),
    }
  );

  if (!response.ok && response.status !== 204) {
    const err = await response.text();
    throw new Error(`Salesforce update failed: ${err}`);
  }

  // Logga anche una Task/Chatter post per visibilità nel feed del deal
  await postChatterUpdate(dealId, fields);

  return { id: dealId, updated: true };
}

async function postChatterUpdate(dealId, fields) {
  const summary = Object.entries(fields)
    .filter(([_, v]) => v)
    .map(([k, v]) => `*${k}*: ${v}`)
    .join("\n");

  await fetch(
    `${SF_INSTANCE_URL}/services/data/v59.0/chatter/feed-elements`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SF_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({
        body: {
          messageSegments: [
            {
              type: "Text",
              text: `🎙️ SPICED aggiornato da nota vocale:\n${summary}`,
            },
          ],
        },
        subjectId: dealId,
      }),
    }
  );
}

// ============================================================
// HUBSPOT — aggiorna Deal custom properties
// ============================================================
async function updateHubspotDeal(dealId, fields) {
  const properties = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null) {
      properties[HUBSPOT_FIELD_MAP[key]] = value;
    }
  }

  const response = await fetch(
    `https://api.hubapi.com/crm/v3/objects/deals/${dealId}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${HUBSPOT_API_KEY}`,
      },
      body: JSON.stringify({ properties }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`HubSpot update failed: ${err}`);
  }

  return await response.json();
}
