# System-Audit: Natur Vitale / Agent-Dashboard

**Stand:** 8. November 2026

**Gesamteinschätzung:** Die frühere Schätzung von **77 %** bezeichnet den damaligen begrenzten Portal-/Admin-Umfang, nicht den aktuellen Live-Zustand: Die produktiven Generatoren sind derzeit abgeschaltet (Abschnitt 10). Die lokalen Ersatzvorlagen sind noch nicht ausgerollt. Eine isolierte Notfall-Wiederherstellungsübung für das Portal wurde erfolgreich durchgeführt; die vollständige Plattform-Recovery und Offsite-Übertragung sind noch nicht abgenommen.

## Kurzfazit

Das öffentliche Portal enthält E-Mail-Verifizierung, Passwort-Reset/-wechsel, Sitzungswiderruf, persistente IP-/Nutzer-/E-Mail-Ratenbegrenzung, Datenexport/-löschung sowie Bearbeiten/Löschen eigener Entwürfe. Die bisher modellbasierten Ideen-, Social- und Workflow-Generatoren sind produktiv derzeit unterbrochen; der lokale Ersatz ist in Abschnitt 11 beschrieben. Geschäftsideen nutzen Branchenprofile; nach ausdrücklicher Einwilligung kann ein konfigurierter Marktdatenanbieter nur Land und Branche erhalten. Herkunft, Aktualität und Kennzahlen werden validiert und nutzergebunden gespeichert. Steuerprofile sind ausdrücklich unverbindliche Referenzen und fließen nicht in Berechnungen ein. Gespeicherte Social- und Werbetexte sind private Entwürfe; es gibt im Portal weder Nutzer-OAuth noch Veröffentlichung. Stripe-Einmalkäufe und Abos sind mit idempotenter Fulfillment-, Rechnungs-, Refund- und Ausfallverarbeitung verbunden; Stripe Connect bleibt deaktiviert. Ein täglicher AES-256-GCM-Portal-Backupdienst mit Rotation und Healthcheck sowie versionierte Datenbankmigrationen und eine geschützte Fehlerübersicht sind vorbereitet.

Im Repository liegen außerdem eine separate Agent-Dashboard-App und ein internes React-/Backend-Projekt. Sie sind nicht Bestandteil der produktiven Compose-Runtime. Das Root-Admin-Dashboard wird unter `/agenten-intern/` durch Caddy Basic Auth geschützt; API-Aufrufe nutzen einen separaten, zwischen Proxy und App geteilten Token. Pause-/Fortsetzen-Aktionen werden vor Ausführung und mit ihrem Ergebnis samt Actor dauerhaft protokolliert. Freie Parameter- und Budgetänderungen sind nicht verfügbar und deshalb auch keine Admin-Funktion. Vor einer weiteren Integration sollten eine verbindliche Zielarchitektur und ein klar abgegrenztes Nutzerprodukt festgelegt werden.

**Produkturteil:** Die genannten Funktionen sind lokal durch Tests abgedeckt. Eine isolierte Portal-Wiederherstellung mit einer frischen Produktionssicherung und erfolgreichem Portalstart wurde am 8. November 2026 geprobt; vollständige Plattform-/Offsite-Wiederherstellung, Alarmierungsproben, produktive Zahlungs-/E-Mail-Abnahme und Rechtsprüfung stehen weiterhin aus. Das ist kein Nachweis für 100 % Produktionsreife oder sichere Live-Schaltung. Die Prozentwerte bewerten Funktionsumfang und Betriebsreife, nicht die Anzahl geschriebener Codezeilen.

## 1. Prozentualer Fertigstellungsgrad

Die folgende Tabelle ist eine historische qualitative Einschätzung vor Abschaltung der produktiven Generatoren; sie bewertet nicht den aktuellen Live-Zustand oder den nicht ausgerollten Ersatz.

| Komponente | Reifegrad | Begründung |
|---|---:|---|
| Frontend & User Experience | **86 %** | Konto-, Ideen-, Validierungsplan-, Umsatz-, Social-Entwurfs- und Billing-Flüsse vorhanden. Ein mobiler Darstellungs-Smoke-Test bei 320/375/768/1280 px zeigte keinen horizontalen Überlauf; breite Browser-, Screenreader- und Usability-Abnahme fehlt. |
| KI & Agenten | **80 %** | Strukturierte, validierte KI-Ausgaben mit Nutzungsbudgets; begrenzte Runner-Steuerung mit Authentifizierung und Resume-Sicherheitsprüfungen. Modell-/Prompt-Versionierung, Provider-Kostenkontrollen und Mehrinstanzbetrieb fehlen. |
| Branchen & Marktdaten | **77 %** | Branchenprofile liefern Kennzahlen und persistente, nutzergebundene Validierungsaufgaben mit Status, Termin und Ergebnisnotiz. Ein optionaler, zustimmungspflichtiger Marktanbieter ist mit Herkunfts-/Kennzahlenvalidierung und tenant-gebundenem Snapshot vorbereitet; es ist kein realer Anbieter produktiv konfiguriert oder fachlich verifiziert. |
| Steuern & Compliance | **55 %** | Referenzprofile mit Prüfstelle, Datum und HTTPS-Quelle, explizite Hinweise sowie bestehender Export-/Löschpfad. Steuern werden nicht berechnet; Rechtsberatung, Datenschutz-Folgenprüfung und Länderprüfung fehlen. |
| Marketing & Social | **72 %** | Plattformgerechte Inhalte und Werbe-Copy werden je Idee erstellt, nutzergebunden gespeichert und können manuell freigegeben/terminiert werden. Die Terminierung veröffentlicht nicht: Nutzer-OAuth, Scheduler, Live-APIs, Attribution und Anzeigenbuchung fehlen. |
| Monetarisierung & Business-Logik | **70 %** | Portal-Checkout unterstützt Einmal- und wiederkehrende Preise. Connect-Datenstrukturen sind vorbereitet, aber Händler-Onboarding, Transfers und Auszahlungen sind deaktiviert; Live-Steuer-/Rechtsabläufe und Leistungserbringung bleiben abzunehmen. |
| Admin- & Betriebssicherheit | **78 %** | Admin-API ist hinter dem Caddy-Login zusätzlich per Proxy-Token gebunden; Runner-Aktionen werden mit Actor und Ergebnis protokolliert. Verschlüsselte Portal-Backups/Rotation und eine isolierte Portal-Wiederherstellung sind getestet; Offsite-/Agenten-Backups, vollständige Plattform-Recovery und Alarmierung fehlen. |
| **Gesamtsystem** | **77 %** | Qualitative Einschätzung des begrenzten Produktumfangs, kein arithmetischer Code-Fertigstellungsgrad. Nicht konfigurierte Live-Integrationen, externe Rechts-/Steuerabnahme, Produktionsrestore, Cross-Browser-/Lasttests und reale Betriebsabnahmen bleiben Release-Blocker. |

### Bewertete Laufzeitflächen

- **Produktiv verbundene Root-Runtime:** [compose.yaml](./compose.yaml), [deploy/Caddyfile](./deploy/Caddyfile), [Dockerfile](./Dockerfile), [src/server.cjs](./src/server.cjs)
- **Öffentliches Portal:** [portal/server.cjs](./portal/server.cjs), [portal/index.html](./portal/index.html)
- **Agenten-Runner:** [src/runAgentLoop.ts](./src/runAgentLoop.ts), [src/agentLoop.ts](./src/agentLoop.ts), [src/taskApi.ts](./src/taskApi.ts), [src/taskQueue.ts](./src/taskQueue.ts), [src/localTaskExecutor.ts](./src/localTaskExecutor.ts), [src/controlPlane.ts](./src/controlPlane.ts)
- **Weitere, getrennte Projekte:** [agent-dashboard/](./agent-dashboard/), [naturvitale-internal-app/](./naturvitale-internal-app/), [kill-switch-project/](./kill-switch-project/)

## 2. Kritische Sicherheits- und Funktionslücken

### A. Nutzerkonten und Alltagstauglichkeit

1. **E-Mail-Zustellung ist anbieterkonfiguriert:** Verifizierung und Passwort-Reset sind implementiert; Zustellung benötigt produktive Brevo-/Sender-Konfiguration und eine Zustellprobe.
2. **Kontowiederherstellung und Datenverwaltung:** Export, Passwort-Reset und Kontolöschung sind implementiert. Abo-Kündigungen erfolgen vor dem Löschen; Aufbewahrungs-/Löschfristen, Supportprozess und Rechtsgrundlagen müssen fachlich und rechtlich festgelegt werden.
3. **Datenlebenszyklus:** Export, Kontolöschung und Bearbeiten/Löschen von Entwürfen sind implementiert. Datenschutz-/Nutzungsbedingungen, gesetzliche Aufbewahrung und Supportprozess müssen fachlich/rechtlich abgenommen werden.
4. **Begrenzter Produktumfang:** Nutzer können KI-Entwürfe speichern und verwalten sowie branchenspezifische Validierungsschritte mit Status, Termin und Ergebnisnotiz verfolgen. Projektziele/-meilensteine, Teamzugriff, Erinnerungen, verifizierte Ergebnisse und echte Workflow-Ausführung fehlen weiterhin.
5. **Betriebsgrenze:** API-/Generierungs-/Login-Limits sind DB-persistent und greifen pro IP/Nutzer/gehashter E-Mail. Das Portal unterstützt eine App-Instanz; verteilte Rate-Limits, Abuse-Alarme und produktionsnahe Lasttests fehlen.
6. **Begrenztes Tarifmodell:** Baseline- und Premium-Monatsbudgets sind konfigurierbar. Rollen, Organisationskonten und feinere Tarifstaffelung sind nicht implementiert.

### B. KI, Agenten und echter Nutzermehrwert

- Der lokale Entwicklungsstand erzeugt Ideen, Social- und Workflow-Entwürfe ausschließlich mit regelbasierten Vorlagen in [portal/local-generation.cjs](./portal/local-generation.cjs). Die Ausgabevalidierung und DB-gestützte IP-/Nutzerlimits bleiben erhalten; neue Vorlagen reservieren oder verbrauchen keine Modell-Tokens. Produktiv ist dieser Ersatz noch nicht ausgerollt.
- Der Portal-Ideenfluss fragt jetzt pro Entwurf Land, Währung und finanzielle Nutzerschätzungen ab und erzeugt zusätzlich einen begrenzten Pilot-Angebotsentwurf. Umsatz, Kostenbeitrag und Break-even werden deterministisch aus den Annahmen berechnet; das Modell bekommt keine persönlichen Finanzannahmen und soll keine Markt- oder Umsatzzahlen erfinden. Das ist keine Marktprognose, Steuerberechnung oder Rechts-/Finanzberatung.
- Ideen können einer Branche (Gastronomie, Handwerk, E-Commerce, Dienstleistung, Software oder Andere) zugeordnet werden. Kennzahlen und Validierungsschritte werden aus serverseitigen Profilen ergänzt; sie sind zu prüfende Vorschläge, keine extern verifizierten Benchmarks. Zielmarkt und Währung bleiben nutzerwählbar. Steuern, lokale Genehmigungen und branchenspezifische Regulierung werden nicht geprüft.
- Aus einer gespeicherten Idee lassen sich Instagram-, Facebook-, TikTok-, LinkedIn- und X-Entwürfe mit separater Werbe-Headline, Copy und Handlungsaufforderung generieren. Entwürfe sind dem Eigentümerkonto und der Idee zugeordnet, werden exportiert/löschbar verwaltet und niemals automatisch veröffentlicht. Die menschliche Prüfung vor Nutzung ist erforderlich; Marken-/Bildrechte, Plattformregeln und Werbeaussagen werden nicht extern geprüft.
- Manuelle Zahlungseingänge lassen sich pro eigener Idee erfassen, anzeigen, entfernen und exportieren. Diese Einträge werden nicht von einem Zahlungsanbieter verifiziert. Die vorhandenen Nutzerkonten bleiben voneinander getrennt; automatische Kundenzahlungen für Portalnutzer sind nicht aktiviert.
- Der Root-Agentenprozess hat eine optionale OpenAI-Ideenpipeline und einen textbasierten Orchestrator in [src/agentLoop.ts](./src/agentLoop.ts). Diese Funktion ist nicht Bestandteil des Portal-API-Flows und nicht gleichbedeutend mit einer automatisierten Ausführung.
- [src/localTaskExecutor.ts](./src/localTaskExecutor.ts) unterstützt nur begrenzte Status-/Listen-/Leseoperationen und das Anlegen neuer Dateien in einem freigegebenen Ausgabebereich. Shell-, Code-, Build-, Git- und externe Aktionen sind absichtlich nicht enthalten. Die Anwendungspfadgrenzen sind keine Betriebssystem-Sandbox.
- Der Compose-Standard des internen Agenten-Runners bleibt lokaler deterministischer Betrieb; modellbasierter Autostart ist standardmäßig aus. Der Runner ist vom Portal getrennt. Eine netzwerkseitige Sperre für zukünftige Portal-Modellaufrufe existiert nicht.
- Der Root-Admin-Bereich liegt unter `/agenten-intern/`; Caddy schützt UI und API mit Basic Auth und reicht einen separaten `DASHBOARD_PROXY_TOKEN` sowie den authentifizierten Actor an die App weiter. Runner-Pause/Fortsetzen schreibt zuerst einen Audit-Intent und danach Ergebnis/Fehler in `runner_control_audit`; `/api/audit-log` zeigt diese Einträge nur nach Admin-Authentifizierung. Das Protokoll ist nicht manipulationssicher gegen Datenbank-Admins. Fortsetzen wird bei aktivem Not-Aus, fehlender Infrastrukturfreigabe, blockiertem Anbieter oder aufgebrauchtem API-Budget abgelehnt. Web-Steuerung ändert weder Budget noch Secrets, Prompt-Parameter oder Agentenrechte; Parameteränderungen sind keine verfügbare Admin-Funktion.
- Business-Scores und Vertriebs-/Projektvorschläge in [src/businessAgents.ts](./src/businessAgents.ts) sind heuristische Regeln und ersetzen weder Kundenvalidierung noch Markt-, Rechts- oder Finanzprüfung.

### C. Zahlung, Monetarisierung und Erfüllung

- Der öffentliche Portal-Checkout verwendet den serverseitigen Produktkatalog. Einträge mit `recurringInterval` (`month` oder `year`) erzeugen Abo-Checkout; andere Einträge bleiben Einmalkäufe. `/api/portal/stripe-webhook` prüft die Stripe-Signatur und verarbeitet Checkout, Subscription-, Invoice- und Refund-Ereignisse transaktional und idempotent.
- Dieser Checkout verkauft Portal-Abos an die Plattformnutzer, nicht deren eigene Angebote an ihre Kunden. Nutzer können Zahlungseingänge zunächst manuell verbuchen. Connect-Konto- und Marketplace-Transaktionsschemas sind als inaktive Vorbereitung angelegt; es gibt keine Connect-Onboarding-, Checkout-, Transfer- oder Auszahlungsroute. `PORTAL_STRIPE_CONNECT_ENABLED=true` lässt den Dienst bewusst beim Start abbrechen. Bis Händler-/Auszahlungsmodell, Verkäuferrolle, Steuern, Rückerstattungen und Fulfillment abgenommen sind, bleiben diese Wege gesperrt.
- Der separate Root-Dashboard-Webhook `/api/stripe-webhook` erfasst weiterhin Admin-Bestellungen mit `pending`-Fulfillment; er erteilt keine Portal-Berechtigungen. Caddy leitet den Portal-Webhook an den Portal-Dienst und den Dashboard-Webhook an den Root-Dienst.
- Portal-Freischaltungen ermöglichen derzeit den manuellen Workflow-Generator, keine externe Ausführung oder individuelle Datei-/Dienstlieferung. Zahlungsausfälle und Refunds widerrufen Berechtigungen; Nutzer können Rechnungen einsehen und über das Stripe Billing Portal Abos verwalten. Ein Erfolgsredirect allein ist kein Zahlungsnachweis.
- Preis, Leistungsumfang, Support, Kündigung, Steuerbehandlung und Rückerstattungsprozess müssen als reales Angebot definiert sein, bevor Zahlungen live aktiviert werden.

### D. Betrieb, Backups und Fehlerbehandlung

- Portalfehler werden in `portal_error_events` persistiert und im internen Dashboard über Caddy-Basic-Auth plus `PORTAL_ERROR_TOKEN` angezeigt. Es gibt keine externe Fehleralarmierung oder unabhängiges Error-Tracking; ein externer Uptime-Workflow ist vorbereitet, aber noch nicht im Standardbranch aktiv.
- `portal-backup` erstellt täglich AES-256-GCM-verschlüsselte SQLite-Backups und rotiert auf die konfigurierte Anzahl. `PORTAL_BACKUP_KEY` ist verpflichtend; es gibt keinen unverschlüsselten Fallback. Eine isolierte Portal-Restore- und Startprobe mit einer frischen Produktionssicherung ist in Abschnitt 8 belegt. Offsite-Restore sowie Wiederherstellung von Agenten-/Caddy-Zustand und kompletter Plattform bleiben offen.
- Kritische Runner-Pause-/Fortsetzen-Aufrufe werden mit Actor, Aktion, vorab gespeichertem Intent und Ergebnis/Fehler protokolliert. Das ist ein nachvollziehbarer Datenbank-Audit-Trail, kein WORM-/unveränderliches Log; es gibt keine Rollenverwaltung oder Audit-Alarmierung.
- Der Backup-Schlüssel muss außerhalb des Backup-Volumes sicher verwahrt werden. Verlust des Schlüssels macht Backups unlesbar; kompromittierter Schlüssel erfordert Rotation und Neubackups.

### E. Betrieb, Daten und Release-Sicherheit

1. **Backups sind noch nicht vollständig:** Das Portal-Volume `portal_data` wird automatisiert täglich verschlüsselt gesichert und wurde isoliert aus einer frischen Produktionssicherung wiederhergestellt. Offsite-Übertragung sowie Sicherung/Wiederherstellung von `agent_data` und Caddy-Zustand fehlen; es wurde keine produktive Wiederherstellung in die Live-Volumes vorgenommen.
2. **Schema-/Betriebsreife:** Portal-Schemastände werden versioniert und Startmigrationen sind idempotent. Ein versionierter Rollbackpfad, externe Fehleralarme, Metriken und ein überprüfter Disaster-Recovery-Zeitplan fehlen.
3. **Lokale Datenartefakte:** Lokale `*.db`-, `*.sqlite*`-Dateien, `src/database.json`, `src/systemState.json`, `.env.*`, `*.env`, Schlüsseldateien und `guardrails.env` sind nun in [.dockerignore](./.dockerignore) ausgeschlossen; Datenbankdateien und lokale Statusdateien sind außerdem in [.gitignore](./.gitignore) ausgeschlossen. Das Dockerfile kopiert `src/`, die Ignore-Regeln schließen diese Artefakte jedoch aus dem Buildkontext aus. Die Datenbankinhalte wurden nicht geöffnet; ein Docker-Build konnte mangels laufendem Docker-Daemon nicht praktisch auf Image-Inhalt geprüft werden.
4. **Unklare Release-Quelle:** Der Arbeitsbaum enthält zahlreiche uncommittete Änderungen und ungetrackte Skripte/Datenartefakte. Das ist kein reproduzierbarer Release-Stand. Vor Veröffentlichung müssen Quellumfang, kanonischer Einstiegspunkt und enthaltene Dateien geprüft werden; keine lokalen Datenbanken oder Secrets unbesehen einchecken.
5. **Schutzumfang:** Caddy-Basic-Auth und Coraza/OWASP CRS schützen das Admin-Routing. Das ersetzt keine getrennten Administratorrollen, Audit-Review, sichere Geheimnisrotation, Backups oder eine Prüfung der WAF-Fehlalarme. Das Portal nutzt davon getrennte Nutzerpasswörter.

### F. Architektur- und Integrationslücken in Nebenprojekten

- **`naturvitale-internal-app`:** Nicht an Compose angebunden. Compiler und Node-Typdefinitionen wurden auf kompatible Versionen aktualisiert; damit sind die Parserfehler aus der inkompatiblen Kombination behoben. Der vollständige Backend-Build bleibt dennoch wegen fehlender Module und unabhängiger Schnittstellen-/Exportabweichungen in diesem Prototyp fehlerhaft; diese App ist nicht Teil des produktiven Root-Builds oder Images. Im Frontend fehlen weiterhin Build-Einstiegspunkte und einzelne Dateien.
- **`agent-dashboard`:** Das separate Projekt besitzt einen TypeScript-/EJS-Stack und `npm --prefix agent-dashboard run build` kompiliert. Es wird aber vom Root-Dockerfile nicht gebaut oder gestartet und ist nicht die produktive Admin-Runtime. Seine Existenz darf nicht als ausgelieferte Portal-Funktion gezählt werden.
- **`kill-switch-project`:** Separates Projekt und nicht in Compose eingebunden. Ein davon unabhängiger Pause-/Not-Aus-Mechanismus ist im Root-`ControlPlane` vorhanden und getestet; das eigenständige Projekt ist kein zusätzlicher produktiver Schutzlayer.
- Mehrere Einstiegspunkte, ungenutzte Subprojekte und uneinheitliche Dokumentation erhöhen das Risiko, Änderungen an der falschen Anwendung vorzunehmen.

## 3. Praxis-Roadmap zur 100%-Vollständigkeit

„100 %“ sollte sich auf einen **versionierten und abgenommenen Produktumfang** beziehen, nicht auf ein unbegrenztes Versprechen, jede denkbare Funktion zu bauen. Empfohlene Reihenfolge:

### P0 — Release-Grundlage und Daten absichern

1. **Kanonische Architektur festschreiben:** Root-Portal als öffentliche App, Root-App als internes Admin-/Runner-System und Caddy als Zonenrouter verbindlich dokumentieren. Unverbundene Apps entweder ausdrücklich als Prototyp markieren oder in einem separaten Projekt-/Buildpfad fortführen.
2. **Build-/Git-Kontext bereinigen:** Lokale Datenbanken und Statusartefakte inspizieren, sensible Daten aus Images und Commits entfernen, geeignete `.gitignore`-/`.dockerignore`-Regeln ergänzen und einen sauberen, reproduzierbaren Release-Commit definieren.
3. **Datensicherung vervollständigen:** `portal_data`, `agent_data` und Caddy-Zustand entsprechend der Wiederherstellungsanforderung offsite sichern; Backups verschlüsseln und außerhalb des Servers speichern. Die isolierte Portal-Wiederherstellung mit einer frischen Produktionssicherung wurde am 8. November 2026 geprüft. Die Wiederherstellung von Agenten-/Caddy-Daten und der Gesamtplattform ist noch nachzuweisen.
4. **Laufzeitstatus dokumentieren:** Deployment-SHA, Compose-Services, Healthchecks, TLS-/WAF-Status und den `AGENT_EXECUTION_MODE` nachvollziehbar und ohne Geheimnisse prüfbar machen.

**Abnahme:** Ein sauberer Checkout baut reproduzierbar; keine lokalen DB-/Secret-Artefakte gelangen unbeabsichtigt ins Image; Restore bringt Portal- und Admin-Daten nachweislich zurück.

### P1 — Konten und Datenschutz alltagstauglich machen

1. **Umgesetzt:** E-Mail-Verifizierung und Passwort-Reset mit kurzlebigen, einmalig verwendbaren Token-Hashes.
2. **Umgesetzt:** Passwortwechsel, Sitzungswiderruf, Kontolöschung, Nutzer-Datenexport sowie Entwurfsbearbeitung/-löschung.
3. **Umgesetzt:** Versionierte Schema-Migrationen. Datenaufbewahrung und verlässlicher Rollbackpfad bleiben festzulegen.
4. Datenschutz-/Nutzungsinformationen und Supportprozess vor öffentlichem Betrieb fachlich/rechtlich abnehmen.
5. **Umgesetzt:** Persistente IP-/Nutzer-/E-Mail-Ratenlimits sind vorhanden. Rate-Limit-/Abuse-Alarme und Mehrinstanz-Unterstützung bleiben offen.

**Abnahme:** Nutzer können ihren Kontozugriff selbst wiederherstellen und ihre gespeicherten Daten verwalten; kritische Auth- und Datenlebenszyklusflüsse sind automatisiert getestet.

### P2 — Einen klaren, echten Kernnutzen liefern

1. Mit Zielnutzern ein konkretes Problem und ein messbares Ergebnis festlegen, statt „Business-Ideen“ oder „Einkommen“ allgemein zu versprechen.
2. **Teilweise umgesetzt:** Ideenentwürfe erfassen Branche, nutzerdefinierten Zielmarkt/Währung und finanzielle Annahmen und liefern Profil-Kennzahlen, Validierungsschritte sowie eine transparente Rechenhilfe mit Unit Economics, Break-even und manueller Umsatzmessung. Die branchenspezifischen Validierungsschritte werden je Idee als private Aufgaben gespeichert; Nutzer können Status, Termin und Ergebnisnotiz aktualisieren. Ein optionaler Anbieteradapter ruft nach expliziter Einwilligung ausschließlich Land und Branche ab und validiert Quelle, Datum, Kennzahlen sowie die zurückgegebene Branche/Region. Es ist kein Anbieter produktiv konfiguriert; die Daten sind keine geprüfte Marktprognose. Steuerprofile sind Referenzhinweise und ändern `taxStatus: not_calculated` nicht. Stripe Connect, Plattformverkauf und Steuerlogik bleiben deaktiviert. Die produktive Generierung ist vorübergehend abgeschaltet; zum lokalen Ersatz und seinen Grenzen siehe Abschnitt 11.
3. **Umgesetzt als Entwurf/Freigabe:** Je Geschäftsidee können Social-/Werbeentwürfe erstellt und mit menschlicher Freigabe und zukünftigem Zeitpunkt gespeichert werden. Der Status bleibt `awaiting_oauth_integration`: Es existieren keine portalgebundenen OAuth-Tokens, kein Veröffentlichungs-Scheduler und keine Live-API-Verbindung; der Zeitpunkt löst kein Posting aus. Kampagnen-/Umsatzattribution und Anzeigenbuchung fehlen.
4. Tenant-Isolation, Kostenreservierung und Fehlerbehandlung sind für die aktuellen synchronen Generierungsflüsse vorhanden; Prompt-Versionierung und idempotente Hintergrundjobs bleiben offen.
5. Vor externen Aktionen eine explizite menschliche Freigabe und einen nachvollziehbaren Audit-Verlauf verlangen. Erst nach fachlicher Freigabe einzelne, nicht-destruktive Integrationen anbieten.

**Abnahme:** Ein eingeloggter Testnutzer erhält ein personalisiertes, nachvollziehbares Ergebnis; ein zweiter Nutzer kann weder Daten noch Tasks des ersten lesen; Kosten und Wiederholungen bleiben innerhalb dokumentierter Grenzwerte.

### P3 — Nutzererlebnis und Produktbetrieb vervollständigen

1. Datenexport sowie Bearbeiten und Löschen von Ideen/Workflows sind umgesetzt. Branchenschritte bilden nun einen Fortschrittsplan je Idee; Ziele, Meilensteine, Erinnerungen, Teamfunktionen und verifizierte Ergebnisse bleiben offen.
2. Ein erster Responsive-Smoke-Test bei 320, 375, 768 und 1280 CSS-Pixeln zeigte keinen horizontalen Überlauf. Cross-Browser-, Tastatur-/Screenreader-, Last- und Usability-Prüfungen sowie Support-/Feedbackpfade bleiben offen.
3. Produktanalytik datensparsam einführen: Aktivierung, wiederkehrende Nutzung, erfolgreiche Ergebnisse und Abbruchstellen messen.
4. Für den Adminbereich Rollen, privilegierte Aktionen, regelmäßigen Audit-Review und getrennte Operator-/Nutzeroberflächen definieren. Der aktuelle Audit-Trail umfasst nur vorhandene Runner-Aktionen; Parameteränderungen sind nicht implementiert.

**Abnahme:** Kernaufgaben sind ohne Entwickler-/SSH-Hilfe durchführbar; Portal- und Runner-Integrationstests decken Konto-Isolation, Fehlerzustände und Freigabegrenzen ab. Mobile-/Screenreader-Verhalten ist separat im Browser zu prüfen.

### P4 — Zahlungen mit Leistungserbringung koppeln

1. Konkrete Tarife, Leistungsumfang, Preis, Kündigung, Support und Erstattungsregeln fachlich festlegen.
2. **Implementiert:** Abo-, Rechnungs-, Zahlungsausfall- und Refund-Webhookzustände; Rechnungs-/Steuerabläufe fachlich abnehmen.
3. Test- und Live-Schlüssel strikt trennen und den realen Stripe-Testkauf mit separatem Test-Webhook verifizieren.

**Abnahme:** Ein Testkauf führt genau einmal zum richtigen Konto-/Leistungszugang; Refund und Webhook-Wiederholung hinterlassen einen konsistenten Zustand.

### P5 — Produktionsreife kontinuierlich nachweisen

1. **Teilweise umgesetzt:** GitHub Actions führt `npm ci`, Build/Typecheck, `npm test`, Compose-Konfigurationsprüfung und Docker-Image-Build für Pushes und Pull Requests aus. Ein mobiler Darstellungs-Smoke-Test wurde manuell ausgeführt; dedizierte Cross-Browser-, Security- und Accessibility-Prüfungen fehlen.
2. **Teilweise umgesetzt:** Isolierte Portal-Wiederherstellung ist in Abschnitt 8 belegt; ein externer GitHub-Actions-Uptime-Check ist als 15-Minuten-Workflow vorbereitet. Er läuft erst nach Aufnahme in den Standardbranch; Benachrichtigungs- und Fehleralarme sowie Queue-, Backup- und Kostenalarme sind noch zu konfigurieren und zu testen. Runbooks für Incident, Datenwiederherstellung und Rollback vervollständigen.
3. Vor breiter Öffnung Last-, Abuse-, Wiederherstellungs- und Datenschutzprüfungen durchführen.

**Abnahme:** Reproduzierbare Releases, überwachte Kernflüsse und regelmäßig geprobte Wiederherstellung; keine Blocker der definierten Produkt-/Sicherheits-Checkliste.

## 4. Verifikation und Auditgrenzen

Bei der Aktualisierung wurden lokal erfolgreich ausgeführt:

- `npm run build` — **TypeScript-Check und Agent-Bundle erfolgreich**
- `npm test` — **58 Tests erfolgreich** (46 TypeScript-/Subsystemtests sowie 12 Portal-, Backup-, Runner- und Deployment-Integrationstests)
- `npm run test:portal` — **Portal-Integration einschließlich Validierungsplan (Erstellung, Status/Termin/Ergebnis, ungültige Eingaben, Export, Tenant-Isolation und Löschkaskade), Marktanbieter-Einwilligung/-Validierung, Steuerreferenz, deaktiviertem Connect sowie Social-Freigabe/Terminierung erfolgreich**
- `node --test test/serverMissions.integration.test.cjs` — **Proxy-Authentifizierung sowie persistente erfolgreiche/fehlgeschlagene Runner-Audit-Einträge erfolgreich**
- JavaScript-Syntaxprüfung der Inline-Skripte in `portal/index.html` und `public/index.html` — **erfolgreich**
- Manueller Responsive-Smoke-Test in integriertem Browser bei 320/375/768/1280 px — **kein horizontaler Überlauf**
- `docker compose config --quiet` — **Konfigurationssyntax erfolgreich mit kurzlebigen Test-Overrides für fehlende lokale Pflicht-Secrets**
- `git diff --check` — **keine Whitespace-Fehler**

Der lokale `.env`-Stand enthält nicht alle verpflichtenden Produktionswerte, einschließlich `DASHBOARD_PROXY_TOKEN` und `PORTAL_BACKUP_KEY`. Der lokale Docker-Daemon war nicht verfügbar; die tatsächliche Containerprüfung auf dem Produktivserver ist nachfolgend separat dokumentiert. Der separate Backend-Build von `naturvitale-internal-app/backend` bleibt wegen der in Abschnitt F genannten Modul-/Schnittstellenfehler außerhalb dieser Laufzeit fehlerhaft.

Nicht als bestanden gelten Cross-Browser-/Accessibility-/Lasttests, Live-LLM-/Brevo-Aufrufe, ein realer Stripe-Kauf, vollständige Plattform-/Offsite-Wiederherstellung, Alarmierungsproben, live konfigurierte Marktvalidierung, Social-OAuth/Veröffentlichung, Stripe-Connect-Onboarding oder produktive Prüfung des internen React-Projekts. Die isolierte Portal-Wiederherstellung aus einer frischen Produktionssicherung ist in Abschnitt 8 dokumentiert. Portal-Integrationstests verwenden lokale LLM-/Brevo-/Marktdaten-Mocks und signierte Stripe-Testpayloads; sie ersetzen keine Live-Abnahme.

## 5. Produktiv-Deployment vom 8. November 2026

- Der ausdrücklich freigegebene lokale Arbeitsstand wurde aus einem abgegrenzten Quellarchiv bereitgestellt; das ursprüngliche Serververzeichnis ist kein Git-Repository. Das damalige Compose-Release lag unter `/opt/agent-dashboard-releases/release-20261107T234557-3233e930`; das anschließend aktive Release ist in Abschnitt 6 dokumentiert. Seine `.env` verweist auf `/opt/agent-dashboard/.env`. Künftige Compose-Befehle müssen im aktiven Release-Verzeichnis ausgeführt werden, nicht mit der älteren Compose-Datei unter `/opt/agent-dashboard`.
- Der Docker-Build auf dem Server durchlief TypeScript-Build und alle 57 Tests. Caddy-Konfiguration und Compose-Konfiguration wurden geprüft; Portal, App und Backup-Sidecar meldeten nach dem Start `healthy`.
- Die Portal-Datenbank wurde vor der Migration verschlüsselt gesichert; eine Kopie wurde erfolgreich entschlüsselt, auf SQLite-Integrität geprüft und in einem isolierten Container auf Schema-Version 6 migriert. Auch ein automatisch vom laufenden Backup-Sidecar erstelltes Backup wurde isoliert entschlüsselt und auf Integrität geprüft. Die produktive Datenbank wurde bei diesen Wiederherstellungstests nicht überschrieben.
- Vor der Umschaltung wurden zudem die gestoppte Agenten-Datenbank und die Control-Plane-Dateien verschlüsselt gesichert; der Datenbank-Restore wurde isoliert auf Integrität geprüft. Die alte Container-Version bleibt mit `rollback-20261107T234557-3233e930` als Image-Tag erhalten. Eine vollständige Wiederanlauf- und Rollbackübung einschließlich Wiederherstellung aller Daten und Dienste steht aus; die spätere isolierte Portal-Probe ist in Abschnitt 8 erfasst.
- Nach einem zuerst fehlgeschlagenen Agenten-Backup wurden die bisherigen Dienste wiederhergestellt und der Sicherungsweg korrigiert. Nach der Umschaltung wurde mit ausdrücklicher Freigabe der Caddy-Passworthash an das vorhandene Server-Passwort angepasst. Portalzugriff, geschützter Adminzugriff, Admin-Missions-/Audit-API und Portal-Fehler-API wurden über HTTPS erfolgreich geprüft. Die Runner-Steuerung wurde bei der Live-Prüfung nicht betätigt.
- Die Schlüssel und Sicherungen liegen weiterhin auf demselben Server. Eine unabhängige sichere Schlüsselablage und Offsite-Backups, regelmäßige Restore-Übungen, Live-Zahlungs-/E-Mail-/LLM-Abnahme, externe Alarmierung sowie fachliche Rechts-/Steuerprüfung bleiben offen. Der Deployment-Smoke-Test ist keine Sicherheitsgarantie.

## 6. Backup-Härtung im lokalen Arbeitsstand

- Neue verschlüsselte Portal-Sicherungen werden vor der Rotation entschlüsselt und auf SQLite-Integrität geprüft. Fehlerhafte Sicherungen werden nicht als fertiges Backup veröffentlicht; bereits vorhandene Sicherungen bleiben erhalten.
- Der Backup-Healthcheck berücksichtigt das konfigurierte Sicherungsintervall statt einer festen 26-Stunden-Grenze. Er prüft Dateiname, Mindestgröße und Alter, ersetzt aber keinen regelmäßigen externen Restore-Test.
- Tests decken unter anderem falsche Schlüssel, beschädigte Sicherungen, einen fehlerhaften Datenbank-Snapshot und den Erhalt der letzten gültigen Sicherung sowie Intervallgrenzen ab.
- Nach der Härtung wurden `npm test` (**58 Tests erfolgreich**), `npm run build`, der gezielte Backup-Test und `docker compose config --quiet` mit temporären Testwerten erfolgreich ausgeführt.
- Am 8. November 2026 wurde die Backup-Härtung auf Hetzner ausgerollt. Der Server-Build bestand 58 Tests. Eine isolierte Sicherung der produktiven Datenbank und ein Restore wurden vor dem Wechsel geprüft; anschließend wurde nur der Backup-Dienst neu gestartet, seine frisch erstellte Sicherung entschlüsselt und auf Integrität geprüft. Portal, App und Caddy wurden nicht neu gestartet; öffentlicher und authentifizierter Admin-Zugriff waren danach erreichbar.
- Das aktive Release-Verzeichnis ist nun `/opt/agent-dashboard-releases/release-20261108T-backup-hardening`; `/opt/agent-dashboard/ACTIVE_RELEASE` enthält diesen Pfad. Portal und App laufen noch mit dem vorherigen Image, während der Backup-Dienst bereits das neue Image verwendet; ein späteres reguläres Compose-Update kann auch die übrigen Dienste neu erstellen. Das frühere Backup-Image ist unter `nv-agenten:backup-before-hardening-20261108` als Rückfallversion verfügbar.
- Zum Zeitpunkt dieses Backuphärtungs-Rollouts lag die Gesamteinschätzung bei **76 %**. Der danach implementierte Validierungsplan ist in Abschnitt 7 dokumentiert und hebt die aktuelle qualitative Einschätzung auf **77 %**. Offsite-Sicherung, unabhängige Schlüsselverwahrung und eine vollständige Plattform-Wiederanlaufübung bleiben offen.

## 7. Validierungsplan-Release auf Hetzner am 8. November 2026

- Das Release liegt unter `/opt/agent-dashboard-releases/release-20261108T-validation-feature`; `/opt/agent-dashboard/ACTIVE_RELEASE` zeigt auf diesen Pfad. Die `.env` bleibt als Symlink auf `/opt/agent-dashboard/.env`; es wurden keine Secrets in das Release-Archiv kopiert.
- Der Docker-Build auf Hetzner bestand TypeScript-Build und `npm test` mit **58 bestandenen Tests**. Der Portal-Integrationstest deckt dort mit isolierter Testdatenbank die Aktions-Erstellung/-Aktualisierung, Status-/Datumsvalidierung, Tenant-Isolation, Export und Löschkaskade ab.
- Vor dem Portal-Update wurde ein verschlüsseltes Portal-Backup erstellt und isoliert wiederhergestellt; SQLite-Integrität war `ok`, das vorherige Schema war Version 6. Ein Snapshot des vorher laufenden Portal-Images ist als `nv-agenten:portal-before-validation-20261108` für den Rollback erhalten.
- Ausschließlich der Portal-Container wurde aus dem neuen Image neu erstellt. Portal, Agent-App, Caddy und Backup-Sidecar waren anschließend gesund; Agent-App, Caddy und Backup-Sidecar wurden nicht neu gestartet. Beim Portalstart wurde Schema-Version 7 angewendet und `portal_idea_actions` nachgewiesen.
- Der HTTPS-Smoke-Test meldete für `/` und `/health` HTTP 200. Nicht angemeldete Anfragen an `/api/ideas` und `/api/account/export` erhielten HTTP 401. Authentifizierte Export- und Löschkaskaden wurden im Docker-Build gegen die isolierte Integrationstestdatenbank geprüft; es wurden keine produktiven Nutzerkonten für den Smoke-Test verändert.
- Diese Prüfung bestätigt weder Offsite-Sicherung noch Recovery der gesamten Plattform oder Rechts-/Steuerabnahme. Social-OAuth, Live-Veröffentlichung und Stripe Connect bleiben deaktiviert bzw. nicht produktiv integriert.

## 8. Isolierte Portal-Wiederanlaufübung am 8. November 2026

- Eine frische Portal-Sicherung wurde mit dem konfigurierten Produktions-Backupdienst verschlüsselt erstellt und mit `restore-portal-backup.cjs` in ein eigens dafür erzeugtes, separates Docker-Volume wiederhergestellt. Das Backup-Tool bestätigte die SQLite-Integrität.
- Die wiederhergestellte Datenbank wurde mit dem aktuellen Portal-Image gestartet, ausschließlich in einem Container mit `--network none` und ohne Produktionsdatenvolume. Die App erreichte lokal HTTP 200 auf `/health`; unangemeldete Aufrufe von `/api/ideas` und `/api/account/export` wurden mit HTTP 401 abgewiesen. Das wiederhergestellte Datenbankschema war Version 7.
- Der temporäre Container und das nur für diese Übung erstellte Volume wurden anschließend entfernt. Die vier produktiven Container blieben gesund; an Produktivkonten oder Produktivdaten wurde nichts geändert.
- Umfangsgrenze: Die Übung prüfte Portal-Backup, Restore, Start und Authentifizierungsgrenze auf demselben Hetzner-Host. Sie prüfte weder Offsite-Wiederherstellung noch Agenten-/Caddy-Zustand, vollständigen Hostverlust, unabhängige Schlüsselverwahrung oder eine Recovery-Zeitvorgabe.
- `.github/workflows/uptime.yml` prüft die öffentliche Portal-Seite und `/health` im 15-Minuten-Rhythmus via GitHub Actions. Der Workflow ist erst aktiv, wenn er in den Standardbranch übernommen und der erste Lauf erfolgreich war; Benachrichtigungseinstellungen müssen zusätzlich im GitHub-Konto geprüft werden.

## 9. Offsite-Backup-Vorbereitung

- Hetzner Object Storage wurde als Ziel gewählt. `compose.yaml` enthält einen deaktivierten Compose-Profil-Sidecar mit `rclone` 1.76.0, lesendem Zugriff auf das lokale Backup-Volume, privaten Uploads und `--immutable`. Die Replikation löscht keine Remote-Objekte.
- **Noch nicht aktiv:** Für den S3-Bucket und den Sidecar fehlen Region/Endpunkt, Bucketname, Access Key ID und Secret Access Key. Diese Werte wurden weder erstellt noch in `.env` gesetzt; es fand kein Offsite-Upload statt. Zugangsdaten müssen direkt auf dem Server bzw. in einer dafür sicheren Secrets-Verwaltung gesetzt werden, niemals in Chat oder Repository.
- Schlüsselverwahrung: vorgesehen ist ein separater, zugriffsbeschränkter 1Password-Recovery-Eintrag als manuell gepflegte Notfallkopie. Seine Einrichtung und der Abgleich mit dem vorhandenen `PORTAL_BACKUP_KEY` sind nicht verifiziert. Der existierende Backup-Schlüssel bleibt unverändert in der Serverkonfiguration, bis Offsite-Restore mit der separat verwahrten Kopie bestanden ist.
- Remote-Lifecycle/Retention muss im Object-Storage-Bucket eingerichtet und getestet werden; der Sidecar löscht Remote-Backups ausdrücklich nicht. Für Schutz vor Verlust des gesamten Hetzner-Projekts ist zusätzlich ein zweiter Anbieter oder ein unabhängiges Konto erforderlich.
- Eine echte Rechts-/Steuerabnahme für „international inklusive Deutschland“ ist nicht durchgeführt. Das Portal darf deshalb keine länderspezifische Rechts-/Steuerkonformität oder Steuerberechnung behaupten.

## 10. Vorläufige Abschaltung der Portal-Modellaufrufe

- Am 9. November 2026 wurde auf ausdrückliche Freigabe im aktiven Hetzner-Release ausschließlich `OPENAI_API_KEY` für den Portal-Container auf einen leeren Wert gesetzt und nur dieser Container neu erstellt. Der ursprüngliche Compose-Stand liegt dort als `compose.yaml.before-portal-zero-ki` für eine bewusste Wiederherstellung.
- Der laufende Portal-Container meldete anschließend keinen OpenAI-Schlüssel; Brevo- und Stripe-Schlüssel waren weiterhin vorhanden. Portal und `/health` antworteten über HTTPS mit HTTP 200; diese Prüfungen sind keine End-to-End-Abnahme für E-Mail oder Zahlungen.
- **Funktionsunterbrechung produktiv:** Die bisherigen Ideen-, Social- und Workflow-Generatoren geben ohne Modellkonfiguration eine Fehlermeldung aus. Der lokale Ersatz und sein Test sind in Abschnitt 11 beschrieben, aber nicht ausgerollt.
- Diese Sofortmaßnahme verhindert die bestehenden OpenAI-Aufrufpfade im Portal, ist aber keine netzwerkseitige Garantie für zukünftige Codeänderungen und keine allgemeine Garantie für null Infrastruktur- oder Drittanbieterkosten. Der getrennte Agentenprozess wurde nicht umkonfiguriert.

## 11. Lokale Ersatzvorlagen und Lastprüfung

- Der lokale Entwicklungsstand routet die drei bestehenden Generatoren auf deterministische Vorlagen ohne Modell-Client. Sie liefern keine dynamische KI-Analyse, treffen keine Umsatzgarantie und führen keine externen Aktionen aus. Branchenspezifische Schritte stammen aus bestehenden Profilen; historische Modellergebnisse bleiben gespeichert. Premium-Zugriff und reguläre Rate-Limits bleiben bestehen.
- Ein isolierter HTTP-Integrationstest sendete 100 parallele Anfragen an alle drei Generatoren, mit Testkonto, Testdatenbank, sechs Branchen und fünf Social-Plattformen. Bei bewusst auf 1.000 erhöhtem Testlimit waren alle Antworten HTTP 201; am konfigurierten Modell-Mock gingen null Requests ein. Ein isolierter Lauf dauerte 12,5 Sekunden; bei paralleler Ausführung mit der übrigen Suite 27,8 Sekunden. Dies sind Messungen auf diesem Rechner, keine Produktions-SLA oder allgemeine Stabilitätsgarantie. Produktiv sind standardmäßig nur acht Generierungen pro Nutzer und 15 Minuten erlaubt.
- Die Prüfung führte anfänglich zu SQLite-Sperrfehlern; Schreiboperationen und Transaktionen werden nun innerhalb einer Portal-Instanz serialisiert. Der Test umfasst keine zweite Portal-Instanz und keine externe Last. `npm test` bestand zuletzt mit 61 Tests, der isolierte 100er-Lauf dauerte dabei 11,7 Sekunden; `npm run build` und `docker compose config --no-interpolate --quiet` bestanden ebenfalls lokal. Ein Container-Build und ein Rollout wurden mangels laufendem lokalem Docker-Daemon nicht geprüft.
- Die aktuelle Implementierung ist **keine isolierte Netzwerk-Gateway-Architektur** und kann künftige direkte Provider-Aufrufe nicht technisch verhindern. Der Modell-Mock beweist nur, dass die getesteten Pfade diesen konfigurierten Endpunkt nicht kontaktierten. Brevo, Stripe, optionale Marktdaten sowie Infrastruktur sind nicht durch diese Prüfung kostenfrei garantiert. Vor einer belastbaren systemweiten Zusage sind getrennte Netzwerk-Egress-Kontrollen und ein restriktiver, getesteter Zugang zu benötigten Fremddiensten erforderlich.
- Ein produktiver Rollout erfordert unter anderem einen nachvollziehbaren Release-Stand, Container-Build/-Tests, Backup und Rollback sowie Prüfung des aktiven Releases. Keine Bereitstellung ist hier erfolgt. Die frühere Prozentbewertung wurde nicht wegen dieses lokalen Zwischenstands erhöht.

## Referenzen

- Deployment und Betriebsgrenzen: [DEPLOYMENT.md](./DEPLOYMENT.md)
- Laufzeit-/Modulübersicht: [ARCHITECTURE.md](./ARCHITECTURE.md)
- Portal und Authentifizierung: [portal/server.cjs](./portal/server.cjs), [portal/index.html](./portal/index.html), [test/portal.integration.test.cjs](./test/portal.integration.test.cjs)
- Proxy und Dienste: [compose.yaml](./compose.yaml), [deploy/Caddyfile](./deploy/Caddyfile)
- Runner, Datenbegrenzung und Control Plane: [src/agentLoop.ts](./src/agentLoop.ts), [src/taskQueue.ts](./src/taskQueue.ts), [src/localTaskExecutor.ts](./src/localTaskExecutor.ts), [src/controlPlane.ts](./src/controlPlane.ts)
- Zahlung und Produktlogik: [src/server.cjs](./src/server.cjs), [agent-dashboard/src/services/paymentService.ts](./agent-dashboard/src/services/paymentService.ts), [agent-dashboard/src/routes/stripeWebhook.ts](./agent-dashboard/src/routes/stripeWebhook.ts)
