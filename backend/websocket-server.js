/**
 * WebSocketServerService - Industrie 4.0 Echtzeit-Streaming für CPS-i40
 * 
 * Verwaltet WebSocket-Verbindungen von Web-Clients (SCADA Anlagenübersicht & AR HUD).
 * Unterstützt bidirektionalen Datenaustausch:
 * - Server -> Client: Push von Live-Telemetriedaten und 5-Minuten-Historien
 * - Client -> Server: Empfang externer Telemetrie, Störungssimulation und Steuerungsbefehle
 */

import { WebSocketServer, WebSocket } from "ws";
import { normalizeWsUrl } from "./websocket-client.js";

export class WebSocketServerService {
  /**
   * @param {Object} options
   * @param {import('http').Server} options.server - HTTP-Server für Upgrade
   * @param {import('./keyvalue-store.js').KeyValueStore} options.store - 5-Minuten KeyValueStore
   * @param {import('./mqtt-client.js').MqttClientService} [options.mqttClient] - MQTT-Client Service
   * @param {string} [options.path] - Pfad (Standard: '/ws/telemetry')
   */
  constructor(options = {}) {
    this.httpServer = options.server || null;
    this.store = options.store;
    this.mqttClient = options.mqttClient || null;
    this.telemetryInterpreter = options.telemetryInterpreter || null;
    this.authManager = options.authManager || null;
    this.path = options.path || "/ws/telemetry";
    this.isSecureOption = Boolean(options.isSecure);
    this.wss = null;
    this.clients = new Set();
    this.heartbeatInterval = null;

    if (this.httpServer) {
      this.init();
    }
  }

  /**
   * Prüft, ob der WebSocket-Server über eine sichere Verbindung (WSS / TLS) betrieben wird
   * @returns {boolean}
   */
  isSecure() {
    if (this.isSecureOption) return true;
    if (this.httpServer) {
      // Prüfe auf https.Server Instanz oder Zertifikatseigenschaften
      if (this.httpServer.cert || this.httpServer.key) return true;
      if (this.httpServer.constructor && this.httpServer.constructor.name === "Server") {
        // Falls _sharedCreds oder tls vorhanden
        if (this.httpServer._sharedCreds || this.httpServer.pfx || this.httpServer.key) return true;
      }
    }
    return false;
  }

  /**
   * Gibt das aktive WebSocket-Protokoll zurück ('wss' oder 'ws')
   * @returns {"wss" | "ws"}
   */
  getProtocol() {
    return this.isSecure() ? "wss" : "ws";
  }

  /**
   * Initialisiert den WebSocket-Server und bindet ihn an den HTTP-Server
   */
  init(server = this.httpServer) {
    this.httpServer = server;
    this.wss = new WebSocketServer({
      server: this.httpServer,
      path: this.path
    });

    this.wss.on("connection", (ws, req) => {
      this.handleConnection(ws, req);
    });

    this.wss.on("error", (err) => {
      console.warn("[WebSocket] Server-Fehler:", err.message);
    });

    // Regelmäßiger Heartbeat zur Erkennung toter Sockets
    this.heartbeatInterval = setInterval(() => {
      for (const ws of this.clients) {
        if (ws.isAlive === false) {
          this.clients.delete(ws);
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        try {
          ws.ping();
        } catch (_) {}
      }
    }, 30000);

    console.info(`[WebSocket] Server initialisiert auf Pfad ${this.path}`);
  }

  /**
   * Behandelt neue Client-Verbindungen
   */
  handleConnection(ws, req) {
    ws.isAlive = true;
    ws.ip = req?.socket?.remoteAddress;
    this.clients.add(ws);

    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", (messageBuffer) => {
      this.handleClientMessage(ws, messageBuffer.toString());
    });

    ws.on("close", () => {
      this.clients.delete(ws);
    });

    ws.on("error", (err) => {
      console.warn("[WebSocket] Client-Fehler:", err.message);
      this.clients.delete(ws);
    });

    // Initiales Willkommens-Paket mit aktuellem Stand & 5-Minuten Zusammenfassungen senden
    const initialPayload = {
      type: "init",
      timestamp: Date.now(),
      protocol: this.getProtocol(),
      isSecure: this.isSecure(),
      mqttConnected: this.mqttClient ? this.mqttClient.isConnected : false,
      mqttSimulated: this.mqttClient ? this.mqttClient.isSimulatorActive : true,
      summaries: this.store ? this.store.getAllSummaries() : {},
      history: this.store ? this.store.getAllHistory() : {}
    };

    this.sendToClient(ws, initialPayload);
  }

  /**
   * Verarbeitet eintreffende Nachrichten von WebSockets (z. B. externe Telemetrie-Pushes)
   */
  handleClientMessage(ws, messageStr) {
    try {
      const msg = JSON.parse(messageStr);
      const type = msg.type || msg.action;

      switch (type) {
        case "ping":
          this.sendToClient(ws, { type: "pong", timestamp: Date.now() });
          break;

        case "get_history": {
          const stationId = msg.stationId;
          const windowMs = msg.windowMs || 300000;
          const history = stationId
            ? { [stationId]: this.store.getHistory(stationId, windowMs) }
            : this.store.getAllHistory(windowMs);
          const summaries = stationId
            ? { [stationId]: this.store.getSummary(stationId, windowMs) }
            : this.store.getAllSummaries(windowMs);

          this.sendToClient(ws, {
            type: "history_response",
            stationId,
            history,
            summaries,
            timestamp: Date.now()
          });
          break;
        }

        case "publish_telemetry":
        case "telemetry": {
          // Erlaubt das Einspeisen von Sensordaten direkt über WebSocket
          if (msg.stationId && msg.data) {
            const entry = this.store.push(msg.stationId, msg.data, msg.timestamp || Date.now());
            // An alle anderen Clients weiterleiten
            this.broadcast({
              type: "telemetry",
              stationId: msg.stationId,
              sample: entry,
              summary: this.store.getSummary(msg.stationId)
            });

            // Falls MQTT aktiv, auch dort publishen
            if (this.mqttClient && this.mqttClient.isConnected) {
              this.mqttClient.publish(`cps-i40/${msg.stationId}/telemetry`, entry);
            }
          }
          break;
        }

        case "toggle_fault": {
          const stationId = msg.stationId;
          const isFault = Boolean(msg.isFault);
          if (this.store) {
            this.store.setMeta(`fault_${stationId}`, isFault);
          }
          if (this.mqttClient) {
            this.mqttClient.publishCommand(stationId, {
              action: isFault ? "trigger_fault" : "clear_fault",
              isFault
            });
          }
          this.broadcast({
            type: "fault_change",
            stationId,
            isFault,
            timestamp: Date.now()
          });
          break;
        }

        case "ingest":
        case "ingest_telemetry": {
          if (this.telemetryInterpreter && (msg.payload || msg.data)) {
            const raw = msg.payload || msg.data;
            const interpretation = this.telemetryInterpreter.interpret(raw);
            const { station, metrics, isFault } = interpretation;

            const sample = {
              v1: metrics.v1.value,
              v2: metrics.v2.value,
              v3: metrics.v3.value,
              isFault: Boolean(isFault),
              status: interpretation.overallStatus
            };
            const entry = this.store ? this.store.push(station.id, sample) : sample;

            if (this.store && isFault !== undefined) {
              this.store.setMeta(`fault_${station.id}`, Boolean(isFault));
            }

            this.broadcast({
              type: "telemetry_interpreted",
              stationId: station.id,
              entry,
              summary: this.store ? this.store.getSummary(station.id) : null,
              interpretation,
              timestamp: Date.now()
            });

            if (this.mqttClient && this.mqttClient.isConnected) {
              this.mqttClient.publish(`cps-i40/${station.id}/telemetry`, entry);
            }

            this.sendToClient(ws, {
              type: "ingest_ack",
              success: true,
              stationId: station.id,
              interpretation
            });
          }
          break;
        }

        default:
          console.info("[WebSocket] Unbekannter Nachrichtentyp empfangen:", type);
      }
    } catch (e) {
      console.warn("[WebSocket] Fehler beim Parsen von Client-Nachricht:", e.message);
    }
  }

  /**
   * Sendet eine Nachricht an einen einzelnen Client
   */
  sendToClient(ws, data) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  /**
   * Broadcast an alle verbundenen Clients
   */
  broadcast(data) {
    const payload = JSON.stringify(data);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(payload);
        } catch (e) {
          console.warn("[WebSocket] Broadcast-Fehler:", e.message);
        }
      }
    }
  }

  /**
   * Broadcastet einen neuen Telemetriewert an alle Clients
   */
  broadcastTelemetry(stationId, sample) {
    const summary = this.store ? this.store.getSummary(stationId) : null;
    this.broadcast({
      type: "telemetry",
      stationId,
      sample,
      summary,
      timestamp: Date.now()
    });
  }

  /**
   * Broadcastet eine Statusänderung (z. B. MQTT Verbindung)
   */
  broadcastStatus(statusObj) {
    this.broadcast({
      type: "status",
      ...statusObj,
      timestamp: Date.now()
    });
  }

  getClientCount() {
    return this.clients.size;
  }

  /**
   * Testet die Erreichbarkeit eines beliebigen externen WebSocket-Endpunkts (ws:// oder wss://)
   * @param {string} wsUrl - Ziel-URL (z. B. ws://192.168.10.1:1880/ws oder wss://echo.websocket.org)
   * @param {number} [timeoutMs=3500] - Timeout in Millisekunden
   * @param {Object} [options={}] - Optionale Verbindungs- & TLS-Optionen
   * @param {boolean} [options.rejectUnauthorized] - Ob Zertifikate strikt validiert werden sollen
   * @returns {Promise<{success: boolean, message: string, url: string, protocol: string, isSecure: boolean, timestamp: number}>}
   */
  static testConnection(wsUrl, timeoutMs = 3500, options = {}) {
    return new Promise((resolve) => {
      let resolved = false;
      let timer = null;
      let testWs = null;

      const finish = (success, message) => {
        if (resolved) return;
        resolved = true;
        if (timer) clearTimeout(timer);
        if (testWs) {
          try {
            testWs.removeAllListeners();
            testWs.on("error", () => {});
            testWs.close();
          } catch (_) {}
        }
        const isWss = /^wss:\/\//i.test(String(wsUrl || "").trim());
        resolve({
          success,
          message,
          url: wsUrl,
          protocol: isWss ? "wss" : "ws",
          isSecure: isWss,
          timestamp: Date.now()
        });
      };

      try {
        if (!wsUrl || typeof wsUrl !== "string") {
          return finish(false, "Keine WebSocket-URL angegeben.");
        }

        const trimmed = normalizeWsUrl(wsUrl.trim());
        if (!/^(ws|wss):\/\/.+/i.test(trimmed)) {
          return finish(false, "Ungültiges Protokoll. WebSocket-URL muss mit ws:// oder wss:// beginnen.");
        }

        const isWss = /^wss:\/\//i.test(trimmed);

        timer = setTimeout(() => {
          finish(false, `Timeout: WebSocket-Endpunkt (${isWss ? "WSS / TLS" : "WS"}) antwortet nicht innerhalb von ${timeoutMs}ms.`);
        }, timeoutMs);

        const wsOptions = {
          handshakeTimeout: timeoutMs
        };

        if (isWss) {
          // In Industrie-Netzwerken und internen Gateways sind Self-Signed Zertifikate verbreitet
          wsOptions.rejectUnauthorized = options.rejectUnauthorized !== undefined
            ? Boolean(options.rejectUnauthorized)
            : (process.env.WS_REJECT_UNAUTHORIZED === "true");
        }

        testWs = new WebSocket(trimmed, wsOptions);

        testWs.on("open", () => {
          finish(true, `WebSocket-Verbindung erfolgreich aufgebaut: ${trimmed} (${isWss ? "WSS / TLS gesichert" : "WS unverschlüsselt"})`);
        });

        testWs.on("error", (err) => {
          let extraMsg = "";
          if (err.message && (err.message.includes("CERT") || err.message.includes("certificate"))) {
            extraMsg = " (Zertifikatsvalidierung fehlgeschlagen)";
          }
          finish(false, `WebSocket-Verbindungsfehler (${isWss ? "WSS" : "WS"}): ${err.message}${extraMsg}`);
        });
      } catch (err) {
        finish(false, `WebSocket-Initialisierungsfehler: ${err.message}`);
      }
    });
  }

  close() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    for (const ws of this.clients) {
      ws.terminate();
    }
    this.clients.clear();
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }
}
