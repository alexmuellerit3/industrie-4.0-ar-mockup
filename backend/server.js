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
import https from "https";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import express from "express";

import { KeyValueStore } from "./keyvalue-store.js";
import { MqttClientService } from "./mqtt-client.js";
import { WebSocketServerService } from "./websocket-server.js";
import { WebSocketClientService } from "./websocket-client.js";
import { createApiRouter } from "./routes/api.js";
import { ConfigManager, DEFAULT_STATIONS_CONFIG } from "./config-manager.js";
import { AuthManager } from "./auth-manager.js";
import { TelemetryInterpreter } from "./telemetry-interpreter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");

export const STATIONS_CONFIG = DEFAULT_STATIONS_CONFIG;

export function createApp(options = {}) {
  const app = express();
  const configFilePath = options.configFilePath || path.join(ROOT_DIR, "config", "app-config.json");
  const configManager = new ConfigManager(configFilePath);
  const activeConfig = configManager.getConfig();

  // Sicherheits- & Authentifizierungsdienste
  const authFilePath = options.authFilePath || path.join(ROOT_DIR, "config", "auth-config.json");
  const authManager = new AuthManager(authFilePath);
  const telemetryInterpreter = new TelemetryInterpreter({ stations: activeConfig.stations });

  // Middleware
  app.enable("trust proxy");
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Sicherheits-Header (Hardening)
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("X-XSS-Protection", "1; mode=block");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=*, microphone=()");
    next();
  });

  // CORS Header für Industrie-Netzwerke & Entwickler-Clients
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
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

  // Vorbefüllung mit plausiblen historischen Datenpunkten der letzten 5 Minuten (als Demo markiert)
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
        isFault: false,
        isDemo: true,
        simulated: true
      }, t);
    });
  }

  // 2. Initialisiere MQTT-Client
  const isWsPrimary = activeConfig.dataSource === "websocket";
  const mqttClient = new MqttClientService({
    brokerUrl: activeConfig.mqtt?.brokerUrl || process.env.MQTT_BROKER_URL || "mqtt://localhost:1883",
    allowSimulator: !isWsPrimary,
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

  // 3. Upstream WebSocket-Client (für externe WebSocket Datenquellen z. B. Node-RED / OPC UA)
  const wsClient = new WebSocketClientService({
    url: activeConfig.websocket?.url,
    telemetryInterpreter,
    onTelemetry: (stationId, payload, meta) => {
      // Wenn Live-Daten vom Upstream-WebSocket eintreffen: Demo-Simulator stoppen
      if (mqttClient.isSimulatorActive || mqttClient.allowSimulator) {
        mqttClient.disableSimulator();
      }
      const entry = store.push(stationId, {
        ...payload,
        isLive: true,
        isDemo: false
      });
      if (app.locals.wsServer) {
        app.locals.wsServer.broadcastTelemetry(stationId, entry, meta);
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
      if (status.connected) {
        // Bei hergestellter Verbindung zum Upstream-WebSocket: Simulator stoppen
        mqttClient.disableSimulator();
      }
      if (app.locals.wsServer) {
        app.locals.wsServer.broadcastStatus({ wsUpstream: status });
      }
    }
  });

  // 4. REST-API Router registrieren
  app.use("/api", createApiRouter({
    store,
    mqttClient,
    wsClient,
    get wsServer() { return app.locals.wsServer; },
    stationsConfig: activeConfig.stations,
    configManager,
    authManager,
    telemetryInterpreter
  }));

  // Intelligente Geräteerkennung & automatischer Einstiegs-Redirect:
  // - Smartphone oder Tablet -> Direkt in den AR-Kameramodus (/index.html)
  // - Desktop / Laptop -> Direkt in das SCADA-Overview Panel (/overview.html)
  // - Manueller Override über Query-Parameter (?view=ar oder ?view=desktop)
  app.get("/", (req, res) => {
    const view = req.query.view;
    if (view === "ar" || view === "camera") {
      return res.redirect("/index.html");
    }
    if (view === "desktop" || view === "overview" || view === "scada") {
      return res.redirect("/overview.html");
    }

    const userAgent = req.headers["user-agent"] || "";
    const isMobileOrTablet = /(Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Tablet|Mobile|Silk)/i.test(userAgent);

    if (isMobileOrTablet) {
      res.redirect("/index.html");
    } else {
      res.redirect("/overview.html");
    }
  });

  // Direktrouten zu HTML-Seiten
  app.get("/overview", (req, res) => {
    res.sendFile(path.join(ROOT_DIR, "overview.html"));
  });

  app.get("/overview.html", (req, res) => {
    res.sendFile(path.join(ROOT_DIR, "overview.html"));
  });

  app.get("/ar", (req, res) => {
    res.redirect("/index.html");
  });

  // Statische Web-Dateien ausliefern (index.html, css/, js/, assets/)
  app.use(express.static(ROOT_DIR));

  return { app, store, mqttClient, wsClient, configManager, authManager, telemetryInterpreter };
}

// Ermittelt SSL-Zertifikate für HTTPS & WSS (Secure WebSocket)
export function resolveSslConfig(options = {}) {
  // 1. Direkt übergebene Optionen (z.B. in Tests)
  if (options.ssl && options.ssl.key && options.ssl.cert) {
    return {
      key: options.ssl.key,
      cert: options.ssl.cert,
      ca: options.ssl.ca,
      source: "options"
    };
  }

  // 2. Über Inline-Umgebungsvariablen
  if (process.env.SSL_KEY && process.env.SSL_CERT) {
    return {
      key: process.env.SSL_KEY,
      cert: process.env.SSL_CERT,
      source: "env_inline"
    };
  }

  // 3. Über Dateipfade in Umgebungsvariablen
  if (process.env.SSL_KEY_PATH && process.env.SSL_CERT_PATH) {
    if (fs.existsSync(process.env.SSL_KEY_PATH) && fs.existsSync(process.env.SSL_CERT_PATH)) {
      return {
        key: fs.readFileSync(process.env.SSL_KEY_PATH),
        cert: fs.readFileSync(process.env.SSL_CERT_PATH),
        source: "env_paths"
      };
    }
  }

  // 4. Standard certs-Ordner
  const defaultKeyPath = path.join(ROOT_DIR, "certs", "server.key");
  const defaultCertPath = path.join(ROOT_DIR, "certs", "server.crt");
  const defaultKeyPem = path.join(ROOT_DIR, "certs", "key.pem");
  const defaultCertPem = path.join(ROOT_DIR, "certs", "cert.pem");

  if (fs.existsSync(defaultKeyPath) && fs.existsSync(defaultCertPath)) {
    return {
      key: fs.readFileSync(defaultKeyPath),
      cert: fs.readFileSync(defaultCertPath),
      source: "default_files"
    };
  }
  if (fs.existsSync(defaultKeyPem) && fs.existsSync(defaultCertPem)) {
    return {
      key: fs.readFileSync(defaultKeyPem),
      cert: fs.readFileSync(defaultCertPem),
      source: "default_files"
    };
  }

  // 5. Explizit aktiviertes WSS/HTTPS ohne vorhandene Dateien -> Auto-Generierung
  const isExplicitWss = (
    process.env.ENABLE_WSS === "true" ||
    process.env.HTTPS === "true" ||
    process.env.WSS === "true" ||
    options.enableWss === true ||
    options.https === true
  );

  if (isExplicitWss) {
    try {
      const certsDir = path.join(ROOT_DIR, "certs");
      if (!fs.existsSync(certsDir)) {
        fs.mkdirSync(certsDir, { recursive: true });
      }
      const autoKeyPath = path.join(certsDir, "server.key");
      const autoCertPath = path.join(certsDir, "server.crt");

      if (!fs.existsSync(autoKeyPath) || !fs.existsSync(autoCertPath)) {
        console.info("[Server] WSS/HTTPS aktiviert: Generiere temporäres Self-Signed SSL-Zertifikat für Entwicklungs-/Industriebetrieb...");
        execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout "${autoKeyPath}" -out "${autoCertPath}" -days 365 -subj "/CN=localhost/O=CPS-i40/OU=Automation"`, {
          stdio: "pipe"
        });
      }

      return {
        key: fs.readFileSync(autoKeyPath),
        cert: fs.readFileSync(autoCertPath),
        source: "generated_self_signed"
      };
    } catch (err) {
      console.warn("[Server] Konnte kein Self-Signed Zertifikat via openssl erzeugen:", err.message);
    }
  }

  return null;
}

// Start-Funktion
export function startServer(port = process.env.PORT || process.env.HTTP_PORT || 80, options = {}) {
  const parsedPort = parseInt(port, 10) || 80;
  const { app, store, mqttClient, wsClient, configManager, authManager, telemetryInterpreter } = createApp(options);
  
  const sslConfig = resolveSslConfig(options);
  const isHttps = Boolean(sslConfig);
  const server = isHttps
    ? https.createServer({ key: sslConfig.key, cert: sslConfig.cert, ca: sslConfig.ca }, app)
    : http.createServer(app);

  // WebSocket-Server an Server binden (unterstützt ws:// und wss://)
  const wsServer = new WebSocketServerService({
    server,
    store,
    mqttClient,
    telemetryInterpreter,
    authManager,
    path: "/ws/telemetry",
    isSecure: isHttps
  });
  app.locals.wsServer = wsServer;

  // Datenquellen gemäß aktiver Konfiguration verbinden
  const activeDataSource = configManager.getConfig().dataSource || "websocket";
  if (activeDataSource === "websocket") {
    console.info(`[Server] Primäre Datenquelle ist Upstream-WebSocket: ${wsClient.url}`);
    mqttClient.disableSimulator();
    wsClient.connect();
    // MQTT parallel ohne Simulator versuchen (für hybride Anlagen)
    mqttClient.connect();
  } else if (activeDataSource === "mqtt") {
    console.info(`[Server] Primäre Datenquelle ist MQTT Broker: ${mqttClient.brokerUrl}`);
    mqttClient.connect();
  } else {
    console.info("[Server] Primäre Datenquelle ist interner SPS-Simulator.");
    mqttClient.startSimulator();
  }

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && !process.env.PORT && parsedPort === 80) {
      console.warn(`[Server] Port 80 ist belegt. Wechsle automatisch auf Fallback-Port 8080...`);
      server.listen(8080);
      return;
    }
    console.error(`[Server] Fehler auf Port ${parsedPort}:`, err.message);
  });

  server.listen(parsedPort, () => {
    const proto = isHttps ? "https" : "http";
    const wsProto = isHttps ? "wss" : "ws";
    console.info("=================================================");
    console.info(`CPS-i40 Backend Server läuft auf Port ${parsedPort} (${isHttps ? "HTTPS & WSS aktiv" : "HTTP & WS aktiv"})`);
    console.info(`- Anlagenübersicht (ohne Hiro): ${proto}://localhost:${parsedPort}/overview.html`);
    console.info(`- AR WebApp:                  ${proto}://localhost:${parsedPort}/index.html`);
    console.info(`- REST API Endpunkt:          ${proto}://localhost:${parsedPort}/api/stations`);
    console.info(`- REST Konfiguration:         ${proto}://localhost:${parsedPort}/api/config`);
    console.info(`- WebSocket Stream:           ${wsProto}://localhost:${parsedPort}/ws/telemetry`);
    console.info(`- MQTT Broker:                ${mqttClient.brokerUrl}`);
    console.info(`- 5-Minuten KeyValueStore:    TTL = 300s (aktiv)`);
    console.info("=================================================");
  });

  const shutdown = () => {
    console.info("[Server] Fahre Dienste ordnungsgemäß herunter...");
    if (wsServer) wsServer.close();
    if (wsClient) wsClient.close();
    if (mqttClient) mqttClient.disconnect();
    server.close(() => {
      console.info("[Server] Beendet.");
      process.exit(0);
    });
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return { server, app, store, mqttClient, wsClient, wsServer, configManager, authManager, telemetryInterpreter };
}

// Direktstart bei Aufruf von node backend/server.js (unterstützt CLI-Port z.B. node backend/server.js 8080)
if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const argPort = process.argv[2] ? parseInt(process.argv[2], 10) : null;
  startServer(argPort || process.env.PORT || process.env.HTTP_PORT || 80);
}
