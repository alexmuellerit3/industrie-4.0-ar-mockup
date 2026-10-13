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
import { ConfigManager, DEFAULT_STATIONS_CONFIG } from "./config-manager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");

export const STATIONS_CONFIG = DEFAULT_STATIONS_CONFIG;

export function createApp(options = {}) {
  const app = express();
  const configFilePath = options.configFilePath || path.join(ROOT_DIR, "config", "app-config.json");
  const configManager = new ConfigManager(configFilePath);
  const activeConfig = configManager.getConfig();

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
  const store = new KeyValueStore(activeConfig.api?.historyTtlMs || 5 * 60 * 1000);

  // Vorbefüllung mit plausiblen historischen Datenpunkten der letzten 5 Minuten
  const now = Date.now();
  const stepMs = 15000; // alle 15 Sekunden ein Datenpunkt = 20 Punkte
  for (let i = 20; i >= 0; i--) {
    const t = now - (i * stepMs);
    activeConfig.stations.forEach(st => {
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
    brokerUrl: activeConfig.mqtt?.brokerUrl || process.env.MQTT_BROKER_URL || "mqtt://localhost:1883",
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
    stationsConfig: activeConfig.stations,
    configManager
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

  return { app, store, mqttClient, configManager };
}

// Start-Funktion
export function startServer(port = process.env.PORT || process.env.HTTP_PORT || 80, options = {}) {
  const { app, store, mqttClient, configManager } = createApp(options);
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

  server.on("error", (err) => {
    console.error(`[Server] Fehler auf Port ${port}:`, err.message);
  });

  server.listen(port, () => {
    console.info("=================================================");
    console.info(`CPS-i40 Backend Server läuft auf Port ${port}`);
    console.info(`- Anlagenübersicht (ohne Hiro): http://localhost:${port}/overview.html`);
    console.info(`- AR WebApp:                  http://localhost:${port}/index.html`);
    console.info(`- REST API Endpunkt:          http://localhost:${port}/api/stations`);
    console.info(`- REST Konfiguration:         http://localhost:${port}/api/config`);
    console.info(`- WebSocket Stream:           ws://localhost:${port}/ws/telemetry`);
    console.info(`- MQTT Broker:                ${mqttClient.brokerUrl}`);
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

  return { server, app, store, mqttClient, wsServer, configManager };
}

// Direktstart bei Aufruf von node backend/server.js
if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  startServer();
}
