# Deployment des NV-Agenten-Systems

## Empfohlene Zielarchitektur

Für einen eigenen Linux-Cloud-Server ist `Docker Compose + Caddy` der bevorzugte Weg. Caddy übernimmt HTTPS-Zertifikate, Docker startet den Dienst nach Serverneustarts neu, und benannte Volumes bewahren Datei- und SQLite-Zustände.

Wichtig: Das System darf nur mit **einer App-Instanz** laufen. Der Kontrollzustand ist dateibasiert; die Mission-Queue wird in SQLite gespeichert. Horizontales Multi-Host-Clustering oder Peer-to-Peer-Konsens sind nicht implementiert.

Das Docker-Image startet das Root-Dashboard samt internem Runner standardmäßig im lokalen, deterministischen Ausführungsmodus und speichert SQLite unter `/app/data/dashboard.sqlite`. Dieser Modus benötigt keinen Modellschlüssel und ruft weder OpenAI noch Ollama auf; er führt nur die unten dokumentierten, begrenzten Datenoperationen aus. Modellbasierte autonome Ideen-Generierung bleibt separat und standardmäßig deaktiviert. Bestehende Kontrollzustände im Volume werden nicht durch Umgebungsvariablen überschrieben.

## 1. Vorbereitung

Du benötigst:

- einen privaten Git-Remote mit diesem Projekt,
- einen Linux-Server mit mindestens 1 CPU, 1 GB RAM und persistentem Speicher,
- die Domain `naturvitale.tech` mit DNS-Einträgen auf die öffentliche IP des Servers,
- einen DNS-A/AAAA-Eintrag auf die öffentliche IP des Servers,
- die vorhandenen Secret-Werte aus der lokalen `.env`.

Die echte `.env` darf niemals committed oder in ein Container-Image kopiert werden. Sie ist durch `.gitignore` und `.dockerignore` ausgeschlossen.

Vor dem Upload lokal ausführen:

```powershell
npm ci
npm run test:mission-bridge
```

Falls dieses Verzeichnis noch kein Git-Repository ist:

```powershell
git init
git add .
git commit -m "Prepare cloud deployment"
git branch -M main
git remote add origin <PRIVATE-GIT-URL>
git push -u origin main
```

Vor `git add` kontrollieren, dass `.env` nicht erscheint:

```powershell
git status --short
git check-ignore .env
```

## 2. Variante A: Eigener Server mit Docker Compose

### Server vorbereiten

Die folgenden Befehle gelten für Ubuntu 24.04:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"
```

Danach einmal ab- und wieder anmelden und prüfen:

```bash
docker version
docker compose version
```

Firewall öffnen:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

### Projekt installieren

```bash
sudo mkdir -p /opt/agent-dashboard
sudo chown "$USER":"$USER" /opt/agent-dashboard
git clone <PRIVATE-GIT-URL> /opt/agent-dashboard
cd /opt/agent-dashboard
cp .env.example .env
chmod 600 .env
nano .env
```

Mindestens diese Werte eintragen:

```dotenv
OPENAI_API_KEY=<secret>
STRIPE_SECRET_KEY=<secret>
STRIPE_PUBLISHABLE_KEY=<secret>
STRIPE_WEBHOOK_SECRET=<secret>
STRIPE_PRODUCT_CATALOG='[{"id":"premium","name":"Premium-Zugang","description":"Leistungsumfang und Bedingungen festlegen","unitAmountCents":9900}]'
BREVO_API_KEY=<secret>
SENDER_EMAIL=kontakt@example.com
PORTAL_BACKUP_KEY=<64-hex-zeichen-aus-kryptografischem-zufall>
PORTAL_ERROR_TOKEN=<mindestens-32-zufällige-zeichen>
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=<eigenes-langes-passwort>
CADDY_PASSWORD_HASH=<mit-caddy-hash-password-generiert>
DASHBOARD_PROXY_TOKEN=<64-hex-zeichen-aus-kryptografischem-zufall>
DOMAIN=naturvitale.tech
PRODUCTION_APP_URL=https://naturvitale.tech
DASHBOARD_URL=https://naturvitale.tech
PUBLIC_BASE_URL=https://naturvitale.tech
NODE_ENV=production
PORT=3000
```

Für `naturvitale.tech` müssen die DNS-Einträge `A` (und nur bei korrekt eingerichteter IPv6-Adresse auch `AAAA`) auf den Server zeigen. Optional kann `www.naturvitale.tech` per `A`-Record auf dieselbe Server-IP zeigen; Caddy bedient dann beide Hostnamen und stellt HTTPS-Zertifikate automatisch aus. Eingehende Verbindungen auf TCP 80 und 443 müssen erlaubt sein. Danach im Projektverzeichnis ausführen:

```bash
docker compose config
docker compose up -d --build
docker compose ps
curl -fsS -u "$DASHBOARD_USERNAME:$DASHBOARD_PASSWORD" https://naturvitale.tech/health
```

### Öffentliches Portal, E-Mail und Stripe Billing

Das Portal verwendet `OPENAI_API_KEY` und optional `OPENAI_MODEL` für personalisierte Ideenentwürfe. Der Premium-Workflow-Generator wird erst nach bestätigter Stripe-Zahlung freigeschaltet. Die KI führt keine externen Aktionen aus. Ohne Schlüssel gibt die API einen sichtbaren Konfigurationsfehler zurück und wechselt nicht auf statische Vorlagen.

Registrierung und Passwort-Reset erfordern `BREVO_API_KEY`, `SENDER_EMAIL` (optional `SENDER_NAME`) sowie eine gültige `PUBLIC_BASE_URL`. Eine Testzustellung und der Klick auf Verifizierungs-/Reset-Links sind vor der Live-Schaltung zu prüfen. Tokens werden nur gehasht gespeichert und laufen ab. Ohne E-Mail-Konfiguration wird kein unbestätigter Account nutzbar.

Für Portal-Käufe wird der serverseitige `STRIPE_PRODUCT_CATALOG` verwendet. Produkt-IDs, Preise und Beschreibungen werden ausschließlich serverseitig bestimmt. Für Einmalkäufe kann beispielsweise Folgendes verwendet werden:

```dotenv
STRIPE_PRODUCT_CATALOG='[{"id":"premium","name":"Premium-Zugang","description":"Leistungsumfang und Bedingungen festlegen","unitAmountCents":9900}]'
```

Wiederkehrende Preise können mit `"recurringInterval":"month"` oder `"recurringInterval":"year"` angegeben werden. Das Portal legt dann eine Stripe Subscription an und zeigt Rechnungen sowie den Stripe Billing Portal-Link im Nutzerkonto an. Der interne Root-Dashboard-Checkout bleibt auf Einmalkäufe beschränkt.

Registriere `https://<deine-domain>/api/portal/stripe-webhook` im Stripe-Dashboard für:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`
- `charge.refunded`

Die signaturgeprüfte Portal-Webhook-Route speichert Events idempotent und aktualisiert Bestellung, Rechnung, Abo und Zugangsberechtigung transaktional. Zahlungsausfall, Kündigung oder Refund widerrufen den Zugang; ein später erfolgreich bezahltes Abo kann wieder aktiviert werden. Der Checkout-Erfolgsredirect allein erteilt keinen Zugriff.

### Limits, Datenschutz und Fehlerübersicht

Die persistenten DB-Limits sind konfigurierbar: `PORTAL_API_RATE_LIMIT` (Standard 240 API-Anfragen pro IP und 15 Minuten), `PORTAL_LLM_RATE_LIMIT` (Standard 8 LLM-Anfragen je Nutzer und 15 Minuten; IP-Limit ist dreifach), Loginversuche werden zusätzlich je gehashter E-Mail begrenzt. Das Monatsbudget beträgt standardmäßig 50.000 Tokens im Basistarif (`PORTAL_MONTHLY_TOKEN_LIMIT`) und 200.000 im Premium-Tarif (`PORTAL_PREMIUM_MONTHLY_TOKEN_LIMIT`). Premium muss dafür aktiv freigeschaltet sein. Es läuft nur eine Portal-Instanz; für horizontale Skalierung ist ein verteilter Limiter erforderlich.

Angemeldete Nutzer können `/api/account/export` für einen JSON-Export und `DELETE /api/account` zur endgültigen Kontolöschung verwenden. Vorhandene aktive Stripe-Abos werden zunächst gekündigt; wenn Stripe die Kündigung nicht bestätigt, wird die Kontolöschung abgebrochen. Aufbewahrungspflichten und Rechtsgrundlagen für Zahlungen, Rechnungen und Kontodaten müssen vor Produktivbetrieb rechtlich festgelegt werden.

Portalfehler sind im internen Dashboard unter „Portal-Fehler“ sichtbar. Dafür muss ein zufälliger, mindestens 32 Zeichen langer `PORTAL_ERROR_TOKEN` in `.env` gesetzt sein. Derselbe Wert wird dem Portal und Caddy übergeben; Caddy schützt den internen Pfad zusätzlich mit Basic Auth. Ereignisse werden standardmäßig nach 90 Tagen gelöscht (`PORTAL_ERROR_RETENTION_DAYS`); die Fehlerübersicht ersetzt kein externes Error-Tracking oder Alarmierung. Login-Nutzer können Passwort ändern und andere Sitzungen abmelden; gespeicherte Ideen und Workflows können nutzergebunden bearbeitet oder gelöscht werden.

### Verschlüsselte Portal-Backups

Compose startet `portal-backup` als Sidecar. Es erzeugt sofort beim Start und anschließend standardmäßig täglich ein konsistentes SQLite-Backup und verschlüsselt es mit AES-256-GCM. Vor Veröffentlichung und Rotation auf 30 Dateien wird jedes neue Backup entschlüsselt und mit `PRAGMA integrity_check` überprüft; bei einem Fehler bleibt das letzte vorhandene Backup erhalten. Der Healthcheck erwartet eine gültig benannte, nicht leere Datei, deren Alter höchstens das konfigurierte Intervall plus 10 % (mindestens zehn Minuten) beträgt. Er prüft nicht bei jedem Aufruf die Entschlüsselbarkeit; das geschieht beim Erstellen. Das Portal-Datenvolume wird im Backup-Container nur lesend gemountet; verschlüsselte Dateien liegen im persistenten Volume `portal_backups`. Der verschlüsselte Snapshot und seine temporäre Klartextkopie zur Integritätsprüfung benötigen ausreichend Platz im temporären Verzeichnis des Containers.

Generiere vor dem Start zwei voneinander unabhängige Werte und bewahre insbesondere den Backup-Schlüssel in einem Passwortmanager/Secret-Store außerhalb des Servers auf:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Setze den ersten Wert als `PORTAL_BACKUP_KEY` (64 Hex-Zeichen, zwingend) und den zweiten als `PORTAL_ERROR_TOKEN` in `.env`. Ohne Backup-Schlüssel startet Compose absichtlich nicht; es gibt keinen unverschlüsselten Fallback. Beobachte den Sidecar mit `docker compose logs --tail=100 portal-backup` und kontrolliere regelmäßig, dass neue `.sqlite.enc`-Dateien im Backup-Volume entstehen.

#### Offsite-Kopie nach Hetzner Object Storage

Das optionale Compose-Profil `offsite` verwendet das auf `rclone` 1.76.0 festgelegte Image und lädt ausschließlich bereits AES-256-GCM-verschlüsselte `portal-*.sqlite.enc`-Dateien hoch. Es mountet das lokale Backup-Volume nur lesend, verwendet private Objekte und `--immutable`; es löscht oder überschreibt keine Remote-Backups. Ohne aktiviertes Profil läuft kein Upload-Dienst.

1. Erstelle im Hetzner Object-Storage-Projekt einen privaten Bucket, vorzugsweise in einer anderen Region als der Cloud-Server. Erzeuge separate S3-Zugangsdaten nur für diesen Zweck und sichere sie unmittelbar in einem Passwortmanager; Hetzner zeigt den Secret Key nach der Erstellung nicht erneut an. Verwende den zum Bucket passenden Endpunkt, z. B. `https://nbg1.your-objectstorage.com` oder `https://fsn1.your-objectstorage.com`.
2. Setze in der nur für root lesbaren Serverdatei `/opt/agent-dashboard/.env` `PORTAL_OFFSITE_BUCKET`, `PORTAL_OFFSITE_ENDPOINT`, `PORTAL_OFFSITE_REGION`, `PORTAL_OFFSITE_ACCESS_KEY_ID` und `PORTAL_OFFSITE_SECRET_ACCESS_KEY`. Die S3-Zugangsdaten nicht committen, in Chatnachrichten senden oder in Shell-Ausgaben protokollieren. Für den gewählten Schlüssel-Notfallplan zusätzlich eine manuell zugängliche, zugriffsbeschränkte 1Password-Secure-Note mit dem bestehenden `PORTAL_BACKUP_KEY` als Recovery-Eintrag pflegen. Den aktiven Schlüssel nicht austauschen, solange nicht alle existierenden Backups mit einem neuen Schlüssel migriert und Wiederherstellungen erfolgreich geprüft wurden.
3. Prüfe die Compose-Konfiguration und aktiviere nur den Upload-Sidecar:

   ```bash
   docker compose --profile offsite config --quiet
   docker compose --profile offsite up -d portal-offsite-backup
   docker compose logs --tail=100 portal-offsite-backup
   ```

4. Verifiziere, dass ein verschlüsseltes Objekt im Bucket erscheint und sich mit dem separat verwahrten Backup-Schlüssel in einer isolierten Testinstanz wiederherstellen lässt. Richte eine begrenzte Remote-Aufbewahrung erst nach erfolgreichem Restore-Test über eine geprüfte Bucket-Lifecycle-Regel ein. Der Upload-Sidecar löscht Remote-Dateien absichtlich nicht; ohne Lifecycle-Regel wächst der Speicherbedarf.

Die Offsite-Kopie schützt vor dem Verlust des Cloud-Servers, aber nicht vor dem Verlust des Hetzner-Projekts oder vor kompromittierten S3-Zugangsdaten. Für eine unabhängige Fehlerdomäne und echte Restore-Unabhängigkeit zusätzlich einen zweiten Anbieter bzw. ein getrenntes Konto sowie regelmäßige Restore-Proben verwenden. Secret-Manager-Zugriff ist in dieser Konfiguration nicht automatisiert: 1Password dient als manuell gepflegter Notfall-Schlüsselbestand; der Schlüssel bleibt für die planmäßige Verschlüsselung zusätzlich in der geschützten Serverkonfiguration.

Für eine Wiederherstellung müssen Portal und Backup-Sidecar gestoppt sein. Nutze das mit Compose gesetzte Backup-Volume und Portal-Datenvolume; der Restore-Befehl erstellt eine neue Zieldatei, prüft AES-GCM-Authentizität und `PRAGMA integrity_check`, und überschreibt keine vorhandene Datei:

```bash
docker compose stop portal portal-backup
docker volume ls
docker compose run --rm --entrypoint node \
  -v <portal-backup-volume>:/app/backups:ro \
  -v <portal-data-volume>:/restore \
  portal-backup /app/scripts/restore-portal-backup.cjs \
  /app/backups/<backup-datei.sqlite.enc> /restore/portal.sqlite.restored
```

Nach erfolgreicher Prüfung die bestehende Datenbank zunächst sichern und die geprüfte Datei im gestoppten Zustand als `portal.sqlite` einsetzen:

```bash
docker compose run --rm --entrypoint sh \
  -v <portal-data-volume>:/restore \
  portal-backup -c 'cp -p /restore/portal.sqlite /restore/portal.sqlite.pre-restore && mv /restore/portal.sqlite.restored /restore/portal.sqlite'
docker compose up -d portal portal-backup
```

Anschließend Login, Rechnungen und Freischaltungen kontrollieren. Eine Restore-Probe mit echten Produktionsbackups ist vor Live-Schaltung und danach regelmäßig durchzuführen.

### Root-Dashboard-Checkout (`node src/server.cjs`)

The root Express dashboard uses a server-side product catalog. Configure its environment before starting the process; the browser can select catalog IDs but cannot set prices. Prices are one-time EUR amounts between 99 EUR and 30,000 EUR, expressed in cents. Use only offers whose scope, delivery, support and cancellation terms are ready to honor.

Example in PowerShell (replace the placeholders with your own values; never commit credentials):

```powershell
$env:STRIPE_SECRET_KEY = "<Stripe test or live secret key>"
$env:STRIPE_WEBHOOK_SECRET = "<Stripe webhook signing secret for this endpoint>"
$env:PUBLIC_BASE_URL = "https://shop.example.com"
$env:STRIPE_PRODUCT_CATALOG = '[{"id":"starter","name":"Digital Starter","description":"Describe the actual deliverable and terms","unitAmountCents":9900},{"id":"consulting","name":"Consulting Package","description":"Describe the actual service and scope","unitAmountCents":3000000}]'
node src/server.cjs
```

For local development, use a Stripe test secret key (`sk_test_…`), a webhook signing secret (`whsec_…`) and `PUBLIC_BASE_URL=http://localhost:3000`. Production checkout requires a live secret key (`sk_live_…`) and a public HTTPS URL. For `.env` files, start Node with `node --env-file=.env src/server.cjs` (Node 20.6 or newer), or export the variables in the process environment. Node does not override variables already present in its parent environment; set the intended `NODE_ENV` and `PUBLIC_BASE_URL` explicitly when launching the server. Restart the server after changing configuration. `GET /api/products` reports checkout readiness and safe configuration diagnostics without returning any key material.

In the Stripe Dashboard, register `https://<your-public-domain>/api/stripe-webhook` (or your reachable local test tunnel) for `checkout.session.completed` and `checkout.session.async_payment_succeeded`; set `STRIPE_WEBHOOK_SECRET` to that endpoint's signing secret. The endpoint verifies Stripe's signature against the raw request body, validates the paid amount and currency against the configured catalog, and records each event/session only once. The dashboard's confirmed-EUR revenue is calculated from those records. Test with Stripe test keys and test events first. This root-dashboard endpoint remains separate from the public portal fulfillment endpoint.

This root dashboard records paid orders with `fulfillment_status=pending`. It does not create customer accounts, issue or deliver license keys, grant authenticated product access, process refunds, or fulfill coaching/services. Those operations require an actual fulfillment/authentication workflow and must be completed and verified separately; a success redirect is not proof of payment.

### Öffentliches Nutzerportal (MVP)

Compose startet das öffentliche Portal als eigenen `portal`-Dienst aus demselben Image wie das Agent-Dashboard. `/`, `/login`, `/register`, `/dashboard` und die Portal-API unter `/api/*` werden ohne Caddy Basic Auth an diesen Dienst weitergeleitet. Das Portal unterstützt E-Mail-/Passwort-Registrierung, Anmeldung und private, gespeicherte Geschäftsideen-Entwürfe. Passwörter werden mit individuellem Salt und scrypt gehasht; Sitzungen verwenden zufällige, gehashte Tokens in HTTP-only-Cookies. Portal-Konten, Sitzungen und Entwürfe liegen separat im persistenten `portal_data`-Volume.

Angemeldete Nutzer können Ideen mit dem konfigurierten LLM erzeugen und privat speichern. Ein serverseitiger Stripe-Kauf schaltet den Workflow-Entwurfsgenerator frei; die Freischaltung erfolgt ausschließlich nach signaturgeprüfter, idempotenter Webhook-Verarbeitung und wird im Portal-Datenbankvolume gespeichert. Generierte Workflows bleiben manuelle Entwürfe und starten keine externen Aktionen. E-Mail-Verifizierung, Passwort-Wiederherstellung, Refund-/Aboverwaltung, Kontingentierung und nutzerbezogene KI-Kostenlimits fehlen weiterhin; Einnahmen werden nicht garantiert. Die Portal-Anmeldedaten sind unabhängig von den Caddy-Basic-Auth-Zugangsdaten. Das `portal_data`-Volume muss in die Datensicherungen aufgenommen werden.

### Agent-Dashboard und Runner im Compose-Betrieb

Das Compose-Image startet `src/server.cjs` und das Agent-Dashboard aus `public/`; es startet nicht die separate `agent-dashboard`-UI. Das Agent-Dashboard und seine API sind ausschließlich unter `/agenten-intern/` per Caddy Basic Auth erreichbar. Caddy entfernt das Präfix vor dem Proxy-Aufruf; das Dashboard leitet seine `/api/...`-Anfragen auf `/agenten-intern/api/...` um. `/api/stripe-webhook` wird zum Root-Dienst geleitet; `/api/portal/stripe-webhook` bleibt beim Portal. Beide Stripe-Endpunkte prüfen die Signatur gegen den unveränderten Request-Body. Der Server startet `src/runAgentLoop.ts` als überwachten Kindprozess. Die interne Task-API bindet nur an `127.0.0.1:3101` im Container; sie wird nicht nach außen veröffentlicht.

Beim Start erzeugt der Entrypoint ein zufälliges `INTERNAL_AGENT_API_TOKEN`, wenn keines in `.env` gesetzt ist. Der Wert wird nicht protokolliert und an den Kindprozess weitergegeben. `DATABASE_PATH` liegt im persistenten `agent_data`-Volume. Dashboard-Missionen und interne Tasks bleiben in SQLite; Übergaben verwenden Idempotenzschlüssel und exponentiellen Backoff. Task-Status und Audit-Ereignis werden in derselben SQLite-Transaktion gespeichert. Abgelaufene Worker-Leases können nach einem Neustart erneut beansprucht werden.

Im lokalen Modus akzeptiert das Dashboard nur diese ausführbaren Befehle:

```text
/local status
/local list agent-input
/local read agent-input/datei.txt
/local write agent-output/bericht.txt -- Berichtstext
```

Eingaben für `/local read` müssen unter `data/agent-input`, `data/agent-output` oder `data/reports` liegen. Neue Dateien dürfen nur unter `data/agent-output` erstellt werden; Überschreiben, Pfadübertritte, versteckte Pfade, Symlinks, Shell-Befehle und Codeausführung werden blockiert. Dateioperationen sind größenbegrenzt. Diese Anwendungsgrenzen ersetzen keine Betriebssystem-Sandbox. Die Queue selbst ist eine native SQLite-Taskqueue und stellt keine KI-Textgenerierung bereit.

Lokale Eingabedateien können administrativ in das persistente Volume kopiert werden:

```bash
docker compose exec app sh -c 'mkdir -p /app/data/agent-input'
docker compose cp ./source.txt app:/app/data/agent-input/source.txt
```

Für neue Volumes setzt die Beispielkonfiguration `AGENT_EXECUTION_MODE=local` und `AGENT_LOCAL_AUTOSTART=true`. Ein bereits vorhandener pausierter Kontrollzustand bleibt bewusst pausiert; lokale Ausführung dann ausdrücklich freigeben:

```bash
docker compose exec app npm run control -- approve-local
```

Der Developer-Agent im Root-Dashboard reiht ausschließlich begrenzte lokale `/local`-Aufgaben in die persistente Task-Queue ein. Unterstützt werden `/local status`, `/local list`, `/local read` und `/local write` (nur neue Dateien unter `data/agent-output/`). Der Endpunkt ist nur bei `AGENT_EXECUTION_MODE=local` verfügbar und wird im modellbasierten Modus mit HTTP 503 abgelehnt, statt Befehle versehentlich als Modellprompt zu verarbeiten. Es gibt keine Codegenerierung, keine Quellcode-Mutationen und keine Shell-, Build-, Test- oder Git-Ausführung über diesen Endpunkt. Ollama wird für den Developer-Agenten nicht benötigt.

Patent 6 ist in `docs/invention-disclosures/principle-6-transactional-task-replay.md` als interner, nicht eingereichter Entwurf für transaktionale Task-Persistenz und Wiederanlauf dokumentiert. Es beschreibt keine Inferenz- oder Codegenerierungs-Engine. Die Anwendungsgrenzen des lokalen Executors sind keine Betriebssystem-Sandbox.

Pause und Not-Aus bleiben wirksam. Für den lokalen Task-Runner sind weder `OPENAI_API_KEY` noch ein API-Budget erforderlich. Das bedeutet **keine Anbieter-Tokenkosten für diese lokalen Tasks**, nicht aber null Betriebskosten: Server, Speicher und Strom werden weiterhin benötigt. Das System arbeitet auf einem einzelnen Host; Docker-Neustarts und SQLite-Persistenz helfen bei Prozessausfällen, ersetzen aber kein Backup, keine Hochverfügbarkeit und keine Wiederherstellung nach Datenträgerausfall. Adapter-Training, Fine-Tuning und automatische Selbstkorrektur sind nicht implementiert.

Das öffentliche Portal auf `/` benötigt keine Anmeldung. Das Agent-Dashboard und seine API sind ausschließlich über `/agenten-intern/` mit HTTP Basic Auth und dem Coraza-WAF mit OWASP Core Rule Set geschützt. Caddy reicht Admin-API-Aufrufe nur über den zusätzlich geteilten `DASHBOARD_PROXY_TOKEN` an die App weiter; er muss als zufälliger 64-stelliger Hexwert nur Caddy und der App bekannt sein. Nur der Stripe-Webhook-Pfad ist von der Proxy-Authentifizierung ausgenommen und prüft stattdessen die Stripe-Signatur; der WAF bleibt aktiv. Deshalb müssen `DASHBOARD_USERNAME`, `CADDY_PASSWORD_HASH` und `DASHBOARD_PROXY_TOKEN` in `.env` gesetzt sein. Die Anwendung selbst ist nicht direkt auf dem Host veröffentlicht.

Das Caddy-Image wird lokal mit dem Coraza-Modul gebaut. Der erste Build benötigt daher Internetzugriff und zusätzlichen Speicherplatz für die Go- und Container-Build-Abhängigkeiten. OWASP CRS kann legitime API-Anfragen blockieren; prüfe bei Problemen die Caddy-Logs, bevor Regeln angepasst werden. Den WAF nicht dauerhaft deaktivieren, um einen einzelnen Fehlalarm zu umgehen.

Nach `docker compose up -d` prüfen:

```bash
docker compose ps
docker compose logs --tail=100 app
curl -fsS -u "$DASHBOARD_USERNAME:$DASHBOARD_PASSWORD" https://naturvitale.tech/health
docker compose exec app npm run control -- status
```

Der Health-Endpunkt wird erst gesund, wenn der Runner seine interne Task-API anbietet. Das Docker-Image kompiliert den TypeScript-Runner beim Build vorab, damit der Container nicht erst beim Start den gesamten Runner-Abhängigkeitsbaum mit `tsx` transformieren muss. Ein gesunder Runner kann trotzdem pausiert sein; den Ausführungszustand zusätzlich mit `control status` prüfen. Der Image-Build führt Mission-Bridge-, lokale Queue-, Recovery- und Guardrail-Tests aus.

Der DNS-Eintrag muss bereits auf den Server zeigen. Anschließend:

```bash
docker compose build --pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 app
docker compose logs --tail=100 caddy
```

Prüfen:

```bash
export DASHBOARD_USERNAME=admin
read -s DASHBOARD_PASSWORD
export DASHBOARD_PASSWORD
curl -fsS -u "$DASHBOARD_USERNAME:$DASHBOARD_PASSWORD" https://naturvitale.tech/health
```

Die Health-Route prüft die interne Runner-API und ist durch Caddy-Authentifizierung geschützt.

### Zustand bedienen

Status anzeigen:

```bash
docker compose exec app npm run control -- status
```

Not-Aus aktivieren:

```bash
docker compose exec app npm run control -- stop
```

Not-Aus entfernen, ohne das System automatisch freizugeben:

```bash
docker compose exec app npm run control -- clear-stop
```

System pausieren:

```bash
docker compose exec app npm run control -- pause
```

Nur im ausdrücklich gewählten modellbasierten Modus (`AGENT_EXECUTION_MODE` ungleich `local`) und nach vollständiger fachlicher Freigabe mit festem Cent-Budget aktivieren. Beispiel für 5 EUR:

```bash
docker compose exec app npm run control -- approve 500
```

Diese Freigabe derzeit noch nicht ausführen, solange die produktive Orchestrierung nicht vollständig abgenommen wurde.

### Aktualisieren und zurückrollen

Vor jedem Update Daten sichern:

```bash
docker run --rm -v nv-agenten_agent_data:/data -v "$PWD":/backup alpine tar czf /backup/nv-agent-data-$(date +%F-%H%M).tar.gz -C /data .
```

Update:

```bash
git pull --ff-only
docker compose build --pull
docker compose up -d
npm run verify:deployment -- https://naturvitale.tech
```

Rollback auf einen bekannten Commit:

```bash
git log --oneline -10
git switch --detach <COMMIT-ID>
docker compose build
docker compose up -d
```

Daten wiederherstellen, während die App gestoppt ist:

```bash
docker compose stop app
docker run --rm -v nv-agenten_agent_data:/data -v "$PWD":/backup alpine sh -c "rm -rf /data/* && tar xzf /backup/<BACKUP-DATEI>.tar.gz -C /data"
docker compose start app
```

## 3. Variante B: Klassischer Node-Host mit PM2

Diese Variante eignet sich, wenn auf dem Zielhost kein Docker verwendet werden soll.

### Node und PM2 installieren

Auf Ubuntu 24.04:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs git
sudo npm install -g pm2
node --version
pm2 --version
```

Projekt installieren:

```bash
git clone <PRIVATE-GIT-URL> /opt/nv-agenten
cd /opt/nv-agenten
cp .env.example .env
chmod 600 .env
nano .env
npm ci
npm run test:mission-bridge
npm run test:local-agent
mkdir -p data/logs
pm2 start ecosystem.config.cjs --env production
pm2 save
pm2 startup systemd -u "$USER" --hp "$HOME"
```

`ecosystem.config.cjs` lädt `.env`, startet `src/server.cjs` samt Runner, erzeugt bei Bedarf ein internes Zufallstoken und setzt den standardmäßigen lokalen deterministischen Modus. `APP_BASIC_AUTH` bleibt aus, weil Caddy den Login übernimmt. `pm2 startup` gibt einen weiteren `sudo`-Befehl aus. Diesen exakt einmal ausführen und danach erneut `pm2 save` aufrufen.

Prüfen:

```bash
pm2 status
pm2 logs nv-agenten --lines 100
curl -i http://127.0.0.1:3000/health
```

### HTTPS mit Caddy

Caddy nach der offiziellen Anleitung installieren. Für den Caddy-Systemdienst separate, nur für root lesbare Zugangsdaten bereitstellen:

```bash
sudo install -m 600 /dev/null /etc/caddy/caddy.env
sudoedit /etc/caddy/caddy.env
```

In `/etc/caddy/caddy.env` eintragen:

```dotenv
DOMAIN=naturvitale.tech
DASHBOARD_USERNAME=admin
CADDY_PASSWORD_HASH=<bcrypt-hash-aus-caddy-hash-password>
DASHBOARD_PROXY_TOKEN=<64-hex-zeichen-aus-kryptografischem-zufall>
```

Den Hash lokal mit `caddy hash-password` erzeugen und nur den Hash, nicht das Klartextpasswort, in die Datei übernehmen. `DASHBOARD_PROXY_TOKEN` mit einem kryptografischen Zufallsgenerator erzeugen und identisch als Umgebungsvariable für die App setzen; der Wert darf nicht in Logs oder öffentliche Konfigurationen gelangen. Caddy den Environment-File-Pfad bekannt machen:

```bash
sudo systemctl edit caddy
```

Im geöffneten Drop-in:

```ini
[Service]
EnvironmentFile=/etc/caddy/caddy.env
```

Danach Caddyfile installieren und den Dienst neu laden:

```bash
sudo cp deploy/Caddyfile.pm2 /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl daemon-reload
sudo systemctl reload caddy
```

PM2-Update:

```bash
cd /opt/nv-agenten
git pull --ff-only
npm ci
pm2 reload ecosystem.config.cjs --update-env
npm run verify:deployment -- https://naturvitale.tech
```

Für Pause, Not-Aus und Freigabe dieselben `npm run control -- ...`-Befehle ohne `docker compose exec app` verwenden.

## 4. Variante C: Render

Die Datei `render.yaml` definiert einen Docker-Webservice mit genau einer Instanz, persistentem Datenträger und Health Check.

1. Projekt in ein privates GitHub- oder GitLab-Repository pushen.
2. In Render **New > Blueprint** wählen.
3. Repository verbinden und `render.yaml` auswählen.
4. Für die als `sync: false` markierten Variablen die echten Werte setzen. Render verwendet `APP_BASIC_AUTH=true`; die App schützt Dashboard und API mit `DASHBOARD_USERNAME` und `DASHBOARD_PASSWORD`. `/health` und der signaturgeprüfte Stripe-Webhook sind ausgenommen.
5. `PRODUCTION_APP_URL` auf die Render-URL oder eigene Domain setzen.
6. `DASHBOARD_URL` auf `<PRODUCTION_APP_URL>` setzen.
7. Deployment starten.
8. Unter **Settings > Custom Domains** die eigene Domain verbinden.
9. `DASHBOARD_USERNAME` und `DASHBOARD_PASSWORD` in der lokalen Shell setzen und mit `npm run verify:deployment -- https://<DOMAIN>` prüfen.

Ein persistenter Render-Datenträger benötigt einen kostenpflichtigen Dienst. Keine zweite Instanz aktivieren.

## 5. Variante D: Fly.io

1. In `fly.toml` den Platzhalter bei `app` durch einen weltweit eindeutigen Namen ersetzen.
2. Fly CLI installieren und anmelden: `fly auth login`.
3. Persistentes Volume in Frankfurt erstellen:

```bash
fly volumes create nv_agent_data --region fra --size 1
```

4. Secrets setzen:

```bash
fly secrets set OPENAI_API_KEY=<secret>
fly secrets set STRIPE_SECRET_KEY=<secret>
fly secrets set STRIPE_PUBLISHABLE_KEY=<secret>
fly secrets set STRIPE_WEBHOOK_SECRET=<secret>
fly secrets set DASHBOARD_USERNAME=admin
fly secrets set DASHBOARD_PASSWORD=<eigenes-langes-passwort>
fly secrets set PRODUCTION_APP_URL=https://<APP-NAME>.fly.dev
fly secrets set DASHBOARD_URL=https://<APP-NAME>.fly.dev
```

5. Deployment und Prüfung:

```bash
fly deploy
fly status
fly logs
fly checks list
```

Danach lokal:

```powershell
npm run verify:deployment -- https://<APP-NAME>.fly.dev
```

`auto_stop_machines` ist deaktiviert und `min_machines_running` steht auf `1`, damit der Dienst auch ohne Benutzeraufruf weiterläuft.

## 6. Lokale Daten übernehmen

Der Ordner `data/` enthält Ideen, Kontrollzustand, Queue und Event-Logs und wird bewusst nicht per Git übertragen.

Vor der Übernahme zuerst lokal pausieren:

```powershell
npm run control -- pause
Compress-Archive -Path data\* -DestinationPath nv-agent-data.zip -Force
```

Für Docker die Dateien nach dem ersten Start in das Volume kopieren:

```bash
docker compose stop app
unzip nv-agent-data.zip -d migrated-data
docker run --rm -v nv-agenten_agent_data:/data -v "$PWD/migrated-data":/source alpine sh -c "cp -a /source/. /data/"
docker compose start app
```

Anschließend Status und Health Check prüfen. Den Zustand nicht gleichzeitig lokal und in der Cloud betreiben, da sonst zwei unabhängige Wahrheiten entstehen.

## 7. Produktions-Checkliste

- DNS zeigt auf den Cloud-Host.
- HTTPS-Zertifikat ist gültig.
- `.env` ist nicht im Git-Repository oder Image enthalten.
- Es läuft genau eine App-Instanz.
- `/health`, `/api/products`, `/api/dashboard-stats` und `/api/missions` liefern authentifiziert HTTP 200; `/health` bestätigt zusätzlich `runnerAvailable=true`.
- Das Root-Dashboard `/` ist nach Browser-Anmeldung erreichbar.
- Persistenter Datenträger ist gemountet.
- Neustartverhalten wurde einmal getestet.
- Backup wurde erstellt und Wiederherstellung dokumentiert.
- System ist bis zur bewussten Budgetfreigabe pausiert.
- Stripe verwendet ausschließlich die öffentliche HTTPS-URL.
- Das mobile Dashboard ist mit eigenem Benutzernamen und starkem Passwort geschützt.
- Cloud-Kosten- und API-Budgetalarme sind beim Anbieter aktiviert.

## 8. Was beim ausgeschalteten Laptop gilt

Nach erfolgreichem Docker-, Render- oder Fly-Deployment läuft das System auf dem externen Host weiter, auch wenn der Laptop ausgeschaltet ist. PM2 erfüllt dies ebenfalls, wenn PM2 auf dem externen Server installiert und als `systemd`-Dienst eingerichtet wurde. Die lokale VS-Code-Sitzung selbst läuft nicht in der Cloud weiter; autonom weiterlaufen kann nur die im Repository implementierte Server- und Agenten-Runtime.
