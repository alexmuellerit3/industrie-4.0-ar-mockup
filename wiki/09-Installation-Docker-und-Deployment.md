# 09. Installation, Docker & Deployment

> **Deployment-Optionen:** Docker & Docker-Compose, lokaler Node.js Prozess oder rein statisches GitHub Pages Hosting.

---

## 🐳 Option 1: Docker Compose (Empfohlen für Produktion & On-Premises)

Der vollständige Stack (Node.js Backend + Mosquitto MQTT Broker) kann mit einem einzigen Befehl gestartet werden:

```bash
# 1. Repository klonen
git clone -b master https://github.com/alexmuellerit3/industrie-4.0-ar-mockup.git
cd industrie-4.0-ar-mockup

# 2. Stack im Hintergrund starten
docker compose up -d
```

### Beliebige Port-Bindung über Umgebungsvariablen:
Standardmäßig bindet der Container auf Port `80` (oder `3000`). Sie können den Host-Port über die Umgebungsvariable `HOST_PORT` oder `PORT` beliebig anpassen:

```bash
# Beispiel: WebApp auf Port 8080 exponieren
HOST_PORT=8080 docker compose up -d
```

---

## 💻 Option 2: Lokale Node.js Entwicklung

Für Entwicklungs- und Testzwecke ohne Docker:

```bash
# Node.js Version 20+ erforderlich
npm install

# Startet den Server auf Port 3000 (oder definiertem PORT)
PORT=3000 npm start
```

Anschließend im Browser öffnen:
* **Leitstand:** `http://localhost:3000/overview.html`
* **AR-App:** `http://localhost:3000/index.html?view=ar`

---

## 🌐 Option 3: GitHub Pages Deployment (Serverless)

Das Projekt ist vollständig GitHub-Pages-fähig und wird über GitHub Actions automatisiert gebaut:

* **Workflow-Datei:** [`.github/workflows/pages.yml`](file:///root/bbk_cpr/.github/workflows/pages.yml)
* **Trigger-Branch:** Exklusiv bei Pushes auf den **`master`-Branch** (oder via `workflow_dispatch`).
* **Live-URL:** `https://alexmuellerit3.github.io/industrie-4.0-ar-mockup/`

### Einrichtung in GitHub:
1. Navigieren Sie im GitHub-Repository zu **Settings** $\rightarrow$ **Pages**.
2. Wählen Sie unter **Build and deployment** als Source: **GitHub Actions**.
3. Nach einem Push auf den `master`-Branch wird die Seite innerhalb von ~60 Sekunden weltweit bereitgestellt.

---

## ⚙️ Konfigurationsdateien im Überblick

| Datei | Beschreibung |
| :--- | :--- |
| [`Dockerfile`](file:///root/bbk_cpr/Dockerfile) | Minimales Alpine Node:20 Image, unprivilegierter User `node`, Healthcheck auf `/health`. |
| [`docker-compose.yml`](file:///root/bbk_cpr/docker-compose.yml) | Multi-Service Stack: `backend` und `mosquitto` mit isoliertem Bridge-Netzwerk. |
| [`.env.example`](file:///root/bbk_cpr/.env.example) | Vorlage für Umgebungsvariablen (`PORT`, `HOST_PORT`, `WS_SERVER_URL`, `JWT_SECRET`). |
| [`config/app-config.json`](file:///root/bbk_cpr/config/app-config.json) | Zentrale Konfiguration für SPS-Adressen, Toleranzbereiche und Broker-URLs. |
