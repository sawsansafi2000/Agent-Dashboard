# Natur Vitale Agenten-Architektur

## Quellenlage

Ein ursprüngliches Inhaltsverzeichnis oder eine verbindliche Liste geplanter Agenten ist in diesem Workspace nicht vorhanden. Die Bestandsaufnahme fand nur generische README-Strukturen, einen produktiv laufenden Innovations-Loop sowie unverbundene Gerüste für Dashboard, Kill-Switch und interne App. Die folgende operative Pipeline rekonstruiert die für den angeforderten Geschäftsprozess notwendigen Rollen.

## Agentenpipeline

1. **Innovation Agent** (vorhanden, erweitert)
   - Erzeugt strukturierte Geschäftsideen unter Guardrails.
   - Implementierung: `src/agentLoop.ts`
2. **Feasibility Agent** (neu)
   - Bewertet technische, regulatorische und operative Machbarkeit.
   - Liefert Score, Entscheidung, Risiken und fehlende Voraussetzungen.
3. **Sales Agent** (neu)
   - Definiert Zielkunden, Kanäle, Preislogik und Validierungs-KPIs.
4. **Project Delivery Agent** (neu)
   - Überführt Ideen in Discovery, Validierung oder Wartestatus.
   - Verwaltet Fortschritt, nächsten Meilenstein und Verkaufsmetriken.

Die drei neuen Stufen sind in `src/businessAgents.ts` implementiert und werden für neue sowie bisher unbewertete Ideen durch `src/agentLoop.ts` ausgeführt.

## Datenfluss

`Idee -> Machbarkeit -> Vertrieb -> Projekt -> Dashboard`

Der gemeinsame JSON-Speicher `data/ideas.json` enthält die Analyse direkt an jeder Idee. Das Dashboard liest daraus Agentenstatus und Projektportfolio. Jeder Agent und jedes analysierte Projekt besitzt eine eigene Route unter `/dashboard/agents/:id` beziehungsweise `/dashboard/projects/:slug`.

## Realistische Betriebsgrenzen

- Umsatz und Bestellungen bleiben bei `0` und Quelle `not-connected`, bis ein reales Shop-, Payment- oder CRM-System angebunden ist.
- Scores sind regelbasierte Vorbewertungen und ersetzen keine Rechts-, Medizinprodukt-, Lebensmittel- oder Finanzprüfung.
- Vor Investitionen sind Kundeninterviews, Zahlungsbereitschaft, Unit Economics, Datenschutz und marktbezogene Compliance nachzuweisen.
- Das Kill-Switch-Gerüst ist nicht in den Produktionsloop integriert und enthält widersprüchliche, teilweise nicht kompilierbare Altimplementierungen. Es darf nicht als aktiver Not-Aus betrachtet werden.
- Die interne App ist ein separates, unvollständiges Gerüst und derzeit keine verlässliche Datenquelle für das Operations-Dashboard.