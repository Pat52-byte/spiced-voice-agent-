---
name: Proposta modifica schema SPICED
about: Discuti un cambiamento ai campi SPICED prima di una PR
title: "[SCHEMA] "
labels: schema-change
---

**Campo coinvolto**
Esistente da modificare, oppure nuovo campo da aggiungere.

**Problema che risolve**
Quale ambiguità o gap nell'estrazione attuale motiva questo cambio? Se possibile, cita un esempio reale di trascrizione che lo schema attuale gestisce male.

**Proposta di struttura**
```typescript
nome_campo: tipo  // descrizione
```

**Impatto sui 3 punti sincronizzati**
- [ ] Tool definition in `spiced_processor.js`
- [ ] Schema SQL in `sql/schema.sql`
- [ ] Field mapping CRM in `spiced_writeback.js`
- [ ] Formula `quality_score` (se il campo conta per lo score)

**Effetto previsto sul quality score medio**
Il cambio farà scendere, salire, o non influenzare il quality score medio del team? Se scende, va comunicato al management prima del rollout — vedi nota in README.
