/**
 * CPS-i40 Industrie 4.0 Backend Server
 * 
 * Beinhaltet:
 * 1. Express Webserver für Anlagenübersicht (/overview.html) & AR-App (/index.html)
 * 2. 5-Minuten In-Memory KeyValueStore (TTL 300s) mit automatischer Aggregation
 * 3. MQTT Client Service (Empfang von SPS-Daten / Fallback-Simulator)
 * 4. WebSocket Server Service (/ws/telemetry) für Echtzeit-Push an Browser-Clients
 * 5. REST-API (/api/stations, /api/history, /api/status, /api/fault)
 */

import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";

import { KeyValueStore } from "./keyvalue-store.js";
import { MqttClientService } from "./mqtt-client.js";
import { WebSocketServerService } from "./websocket-server.js";
import { createApiRouter } from "./routes/api.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");

export const STATIONS_CONFIG = [
  {
    id: "ST-010",
    name: "Modul 1: Dosen-Zuführung",
    plcIp: "192.168.10.11",
    v1: { id: "magazine_level", label: "Magazin", unit: "%", min: 82, max: 86, defaultVal: 84 },
    v2: { id: "vacuum_pressure", label: "Vakuum", unit: "bar", min: -0.85, max: -0.78, defaultVal: -0.8 },
    v3: { id: "part_counter", label: "Zähler", unit: "Stk", isFixed: true, defaultVal: 1684 }
  },
  {
    id: "ST-020",
    name: "Modul 2: Dosierung & Befüllung",
    plcIp: "192.168.10.12",
    v1: { id: "fill_weight", label: "Füllgewicht", unit: "g", min: 249.7, max: 250.6, defaultVal: 250.3 },
    v2: { id: "pressure", label: "Druck", unit: "bar", min: 5.1, max: 5.3, defaultVal: 5.2 },
    v3: { id: "throughput", label: "Takt", unit: "D/min", min: 31, max: 33, defaultVal: 32 }
  },
  {
    id: "ST-030",
    name: "Modul 3: Verschluss & Bördelung",
    plcIp: "192.168.10.13",
    v1: { id: "press_force", label: "Anpressdruck", unit: "bar", min: 5.1, max: 5.3, defaultVal: 5.2 },
    v2: { id: "torque", label: "Drehmoment", unit: "Nm", min: 3.8, max: 4.1, defaultVal: 3.9 },
    v3: { id: "seal_check", label: "Prüfung", unit: "%", isFixed: true, defaultVal: 100 }
  },
  {
    id: "ST-040",
    name: "Modul 4: Qualitätskontrolle & Waage",
    plcIp: "192.168.10.14",
    v1: { id: "check_weight", label: "Kontrollgewicht", unit: "g", min: 249.8, max: 250.4, defaultVal: 250.1 },
    v2: { id: "reject_rate", label: "Ausschuss", unit: "%", min: 0.3, max: 0.5, defaultVal: 0.4 },
    v3: { id: "oee", label: "OEE", unit: "%", isFixed: true, defaultVal: 93 }
  }
];

export function createApp() {
  const app = express();

  // Middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // CORS Header für Industrie-Netzwerke & Entwickler-Clients
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // Healthcheck Endpunkt für Docker & Orchestrierung
  app.get("/health", (req, res) => {
    res.status(200).json({ status: "ok", timestamp: Date.now() });
  });

  // 1. Initialisiere 5-Minuten In-Memory KeyValueStore (300.000 ms)
  const store = new KeyValueStore(5 * 60 * 1000);

  // Vorbefüllung mit plausiblen historischen Datenpunkten der letzten 5 Minuten
  const now = Date.now();
  const stepMs = 15000; // alle 15 Sekunden ein Datenpunkt = 20 Punkte
  for (let i = 20; i >= 0; i--) {
    const t = now - (i * stepMs);
    STATIONS_CONFIG.forEach(st => {
      const v1Delta = (Math.sin(i * 0.4) * 0.04);
      const v2Delta = (Math.cos(i * 0.3) * 0.03);
      store.push(st.id, {
        v1: +(st.v1.defaultVal + v1Delta).toFixed(1),
        v2: +(st.v2.defaultVal + v2Delta).toFixed(1),
        v3: st.v3.defaultVal,
        isFault: false
      }, t);
    });
  }

  // 2. Initialisiere MQTT-Client
  const mqttClient = new MqttClientService({
    brokerUrl: process.env.MQTT_BROKER_URL || "mqtt://localhost:1883",
    onTelemetry: (stationId, payload) => {
      const entry = store.push(stationId, payload);
      if (app.locals.wsServer) {
        app.locals.wsServer.broadcastTelemetry(stationId, entry);
      }
    },
    onFault: (stationId, isFault) => {
      store.setMeta(`fault_${stationId}`, isFault);
      if (app.locals.wsServer) {
        app.locals.wsServer.broadcast({
          type: "fault_change",
          stationId,
          isFault,
          timestamp: Date.now()
        });
      }
    },
    onStatusChange: (status) => {
      if (app.locals.wsServer) {
        app.locals.wsServer.broadcastStatus(status);
      }
    }
  });

  // 3. REST-API Router registrieren
  app.use("/api", createApiRouter({
    store,
    mqttClient,
    get wsServer() { return app.locals.wsServer; },
    stationsConfig: STATIONS_CONFIG
  }));

  // Direktrouten zu HTML-Seiten
  app.get("/overview", (req, res) => {
    res.sendFile(path.join(ROOT_DIR, "overview.html"));
  });

  app.get("/overview.html", (req, res) => {
    res.sendFile(path.join(ROOT_DIR, "overview.html"));
  });

  // Statische Web-Dateien ausliefern (index.html, css/, js/, assets/)
  app.use(express.static(ROOT_DIR));

  return { app, store, mqttClient };
}

// Start-Funktion
export function startServer(port = process.env.PORT || 3000) {
  const { app, store, mqttClient } = createApp();
  const server = http.createServer(app);

  // WebSocket-Server an HTTP-Server binden
  const wsServer = new WebSocketServerService({
    server,
    store,
    mqttClient,
    path: "/ws/telemetry"
  });
  app.locals.wsServer = wsServer;

  // Mit MQTT verbinden (oder internem Fallback-Simulator)
  mqttClient.connect();

  server.listen(port, () => {
    console.info("=================================================");
    console.info(`CPS-i40 Backend Server läuft auf Port ${port}`);
    console.info(`- Anlagenübersicht (ohne Hiro): http://localhost:${port}/overview.html`);
    console.info(`- AR WebApp:                  http://localhost:${port}/index.html`);
    console.info(`- REST API Endpunkt:          http://localhost:${port}/api/stations`);
    console.info(`- WebSocket Stream:           ws://localhost:${port}/ws/telemetry`);
    console.info(`- 5-Minuten KeyValueStore:    TTL = 300s (aktiv)`);
    console.info("=================================================");
  });

  const shutdown = () => {
    console.info("[Server] Fahre Dienste ordnungsgemäß herunter...");
    if (wsServer) wsServer.close();
    if (mqttClient) mqttClient.disconnect();
    server.close(() => {
      console.info("[Server] Beendet.");
      process.exit(0);
    });
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return { server, app, store, mqttClient, wsServer };
}

// Direktstart bei Aufruf von node backend/server.js
if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  startServer();
}
