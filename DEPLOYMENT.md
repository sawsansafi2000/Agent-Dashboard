# Deployment des NV-Agenten-Systems

## Empfohlene Zielarchitektur

Für einen eigenen Linux-Cloud-Server ist `Docker Compose + Caddy` der bevorzugte Weg. Caddy übernimmt HTTPS-Zertifikate, Docker startet den Dienst nach Serverneustarts neu, und das benannte Volume bewahrt den dateibasierten Zustand.

Wichtig: Das System darf nur mit **einer App-Instanz** laufen. Kontrollzustand und Task-Queue sind dateibasiert und unterstützen derzeit kein horizontales Multi-Host-Clustering.

Das Deployment startet den Agentenprozess, aber der Kontrollzustand bleibt standardmäßig pausiert. Dadurch entstehen nach dem Umzug nicht automatisch API-Kosten.

## 1. Vorbereitung

Du benötigst:

- einen privaten Git-Remote mit diesem Projekt,
- einen Linux-Server mit mindestens 1 CPU, 1 GB RAM und persistentem Speicher,
- eine Domain oder Subdomain, beispielsweise `agents.example.com`,
- einen DNS-A/AAAA-Eintrag auf die öffentliche IP des Servers,
- die vorhandenen Secret-Werte aus der lokalen `.env`.

Die echte `.env` darf niemals committed oder in ein Container-Image kopiert werden. Sie ist durch `.gitignore` und `.dockerignore` ausgeschlossen.

Vor dem Upload lokal ausführen:

```powershell
npm run build
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
sudo mkdir -p /opt/nv-agenten
sudo chown "$USER":"$USER" /opt/nv-agenten
git clone <PRIVATE-GIT-URL> /opt/nv-agenten
cd /opt/nv-agenten
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
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=<eigenes-langes-passwort>
DOMAIN=agents.example.com
PRODUCTION_APP_URL=https://agents.example.com
DASHBOARD_URL=https://agents.example.com/dashboard
NODE_ENV=production
PORT=3000
```

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
curl -fsS https://agents.example.com/health
export DASHBOARD_USERNAME=admin
read -s DASHBOARD_PASSWORD
export DASHBOARD_PASSWORD
npm run verify:deployment -- https://agents.example.com
```

Der zweite Befehl kann lokal im Projektverzeichnis ausgeführt werden.

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

Erst nach vollständiger fachlicher Freigabe mit einem festen Cent-Budget aktivieren. Beispiel für 5 EUR:

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
npm run verify:deployment -- https://agents.example.com
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
npm --prefix agent-dashboard ci
npm run build
mkdir -p data/logs
pm2 start ecosystem.config.cjs --env production
pm2 save
pm2 startup systemd -u "$USER" --hp "$HOME"
```

`pm2 startup` gibt einen weiteren `sudo`-Befehl aus. Diesen exakt einmal ausführen und danach erneut `pm2 save` aufrufen.

Prüfen:

```bash
pm2 status
pm2 logs nv-agenten --lines 100
curl -i http://127.0.0.1:3000/health
```

### HTTPS mit Caddy

Caddy nach der offiziellen Anleitung installieren. Danach in `deploy/Caddyfile.pm2` `agents.example.com` durch die echte Domain ersetzen und installieren:

```bash
sudo cp deploy/Caddyfile.pm2 /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

PM2-Update:

```bash
cd /opt/nv-agenten
git pull --ff-only
npm ci
npm --prefix agent-dashboard ci
npm run build
pm2 reload ecosystem.config.cjs --update-env
npm run verify:deployment -- https://agents.example.com
```

Für Pause, Not-Aus und Freigabe dieselben `npm run control -- ...`-Befehle ohne `docker compose exec app` verwenden.

## 4. Variante C: Render

Die Datei `render.yaml` definiert einen Docker-Webservice mit genau einer Instanz, persistentem Datenträger und Health Check.

1. Projekt in ein privates GitHub- oder GitLab-Repository pushen.
2. In Render **New > Blueprint** wählen.
3. Repository verbinden und `render.yaml` auswählen.
4. Für die als `sync: false` markierten Variablen die echten Werte setzen.
5. `PRODUCTION_APP_URL` auf die Render-URL oder eigene Domain setzen.
6. `DASHBOARD_URL` auf `<PRODUCTION_APP_URL>/dashboard` setzen.
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
fly secrets set DASHBOARD_URL=https://<APP-NAME>.fly.dev/dashboard
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
- `/health`, `/dashboard` und `/api/status` liefern HTTP 200.
- `/dashboard/chat` ist nach Browser-Anmeldung erreichbar und kann einen wartenden Task speichern.
- Persistenter Datenträger ist gemountet.
- Neustartverhalten wurde einmal getestet.
- Backup wurde erstellt und Wiederherstellung dokumentiert.
- System ist bis zur bewussten Budgetfreigabe pausiert.
- Stripe verwendet ausschließlich die öffentliche HTTPS-URL.
- Das mobile Dashboard ist mit eigenem Benutzernamen und starkem Passwort geschützt.
- Cloud-Kosten- und API-Budgetalarme sind beim Anbieter aktiviert.

## 8. Was beim ausgeschalteten Laptop gilt

Nach erfolgreichem Docker-, Render- oder Fly-Deployment läuft das System auf dem externen Host weiter, auch wenn der Laptop ausgeschaltet ist. PM2 erfüllt dies ebenfalls, wenn PM2 auf dem externen Server installiert und als `systemd`-Dienst eingerichtet wurde. Die lokale VS-Code-Sitzung selbst läuft nicht in der Cloud weiter; autonom weiterlaufen kann nur die im Repository implementierte Server- und Agenten-Runtime.
