/**
 * WebSocketServerService - Industrie 4.0 Echtzeit-Streaming für CPS-i40
 * 
 * Verwaltet WebSocket-Verbindungen von Web-Clients (SCADA Anlagenübersicht & AR HUD).
 * Unterstützt bidirektionalen Datenaustausch:
 * - Server -> Client: Push von Live-Telemetriedaten und 5-Minuten-Historien
 * - Client -> Server: Empfang externer Telemetrie, Störungssimulation und Steuerungsbefehle
 */

import { WebSocketServer, WebSocket } from "ws";

export class WebSocketServerService {
  /**
   * @param {Object} options
   * @param {import('http').Server} options.server - HTTP-Server für Upgrade
   * @param {import('./keyvalue-store.js').KeyValueStore} options.store - 5-Minuten KeyValueStore
   * @param {import('./mqtt-client.js').MqttClientService} [options.mqttClient] - MQTT-Client Service
   * @param {string} [options.path] - Pfad (Standard: '/ws/telemetry')
   */
  constructor(options = {}) {
    this.httpServer = options.server;
    this.store = options.store;
    this.mqttClient = options.mqttClient || null;
    this.path = options.path || "/ws/telemetry";
    this.wss = null;
    this.clients = new Set();
    this.heartbeatInterval = null;

    if (this.httpServer) {
      this.init();
    }
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
