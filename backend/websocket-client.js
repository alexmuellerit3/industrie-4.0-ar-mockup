/**
 * WebSocketClientService - Upstream WebSocket-Client für CPS-i40
 * 
 * Ermöglicht es dem Backend, Telemetriedaten von einem externen WebSocket-Server
 * (z. B. Node-RED, Siemens IOT2050, oder Cloud-Gateway) als Datenquelle zu abonnieren.
 */

import { WebSocket } from "ws";

/**
 * Normalisiert WebSocket-URLs und korrigiert typische Tippfehler (z. B. tobin-w.de -> robin-w.de)
 * @param {string} url
 * @returns {string}
 */
export function normalizeWsUrl(url) {
  if (!url || typeof url !== "string") return url;
  let normalized = url.trim();
  if (normalized.includes("tobin-w.de")) {
    console.warn(`[WS-Client] Normalisiere Tippfehler in Domain: ${normalized} -> ${normalized.replace(/tobin-w\.de/g, "robin-w.de")}`);
    normalized = normalized.replace(/tobin-w\.de/g, "robin-w.de");
  }
  return normalized;
}

export class WebSocketClientService {
  /**
   * @param {Object} options
   * @param {string} [options.url] - WebSocket Server URL (z.B. wss://nodered.bbk.robin-w.de/ws/opcua)
   * @param {string} [options.clientId] - Eindeutige Client-ID
   * @param {number} [options.reconnectPeriod=3500] - Wiederverbindungsintervall in ms
   * @param {import('./telemetry-interpreter.js').TelemetryInterpreter} [options.telemetryInterpreter] - Semantischer Interpreter
   * @param {Function} [options.onTelemetry] - fn(stationId, payload, meta)
   * @param {Function} [options.onFault] - fn(stationId, isFault)
   * @param {Function} [options.onStatusChange] - fn(statusObj)
   */
  constructor(options = {}) {
    this.url = normalizeWsUrl(options.url || process.env.WS_SERVER_URL || "ws://localhost:3000/ws/telemetry");
    this.clientId = options.clientId || `cps-ws-client-${Math.random().toString(16).substring(2, 8)}`;
    this.reconnectPeriod = options.reconnectPeriod || 3500;
    this.interpreter = options.telemetryInterpreter || null;
    this.onTelemetry = options.onTelemetry || (() => {});
    this.onFault = options.onFault || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});
    this.rejectUnauthorized = options.rejectUnauthorized !== undefined ? Boolean(options.rejectUnauthorized) : false;

    this.client = null;
    this.isConnected = false;
    this.reconnectTimer = null;
    this.isManualClosed = false;

    // Statistiken & Metriken für Status-Endpoints
    this.messagesReceived = 0;
    this.lastMessageTime = null;
    this.lastTopic = null;
  }

  /**
   * Startet die Verbindung zum WebSocket-Server
   */
  connect() {
    this.isManualClosed = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.client) {
      const oldClient = this.client;
      this.client = null;
      try {
        oldClient.removeAllListeners();
        oldClient.on("error", () => {});
        oldClient.close();
      } catch (_) {}
    }

    const trimmed = normalizeWsUrl(String(this.url || "").trim());
    this.url = trimmed;

    if (!/^(ws|wss):\/\/.+/i.test(trimmed)) {
      console.warn(`[WS-Client] Ungültige WebSocket-URL: ${this.url}`);
      this.isConnected = false;
      this.onStatusChange({ connected: false, url: this.url, error: "Ungültiges Protokoll", isSecure: false, protocol: "ws" });
      return;
    }

    const isWss = /^wss:\/\//i.test(trimmed);
    console.info(`[WS-Client] Verbinde mit Upstream-WebSocket (${isWss ? "WSS / TLS" : "WS"}): ${trimmed}`);

    try {
      const wsOptions = {
        handshakeTimeout: 5000
      };

      if (isWss) {
        // Tolerante TLS-Validierung für industrielle Edge-Gateways & Node-RED mit internen Zertifikaten
        wsOptions.rejectUnauthorized = this.rejectUnauthorized;
      }

      this.client = new WebSocket(trimmed, wsOptions);

      this.client.on("open", () => {
        this.isConnected = true;
        console.info(`[WS-Client] Erfolgreich verbunden mit ${trimmed} (${isWss ? "WSS / TLS gesichert" : "WS"})`);
        this.onStatusChange({
          connected: true,
          url: this.url,
          protocol: isWss ? "wss" : "ws",
          isSecure: isWss,
          messagesReceived: this.messagesReceived
        });
      });

      this.client.on("message", (data) => {
        this.handleMessage(data.toString());
      });

      this.client.on("error", (err) => {
        console.warn(`[WS-Client] Verbindungsfehler (${trimmed}):`, err.message);
        this.handleDisconnect(err.message);
      });

      this.client.on("close", () => {
        if (this.isConnected) {
          console.info("[WS-Client] Verbindung geschlossen.");
        }
        this.handleDisconnect();
      });
    } catch (err) {
      console.warn("[WS-Client] Initialisierungsfehler:", err.message);
      this.handleDisconnect(err.message);
    }
  }

  handleDisconnect(errorMsg = null) {
    this.isConnected = false;
    const isWss = /^wss:\/\//i.test(String(this.url || "").trim());
    this.onStatusChange({
      connected: false,
      url: this.url,
      protocol: isWss ? "wss" : "ws",
      isSecure: isWss,
      error: errorMsg,
      messagesReceived: this.messagesReceived
    });

    if (!this.isManualClosed && !this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, this.reconnectPeriod);
    }
  }

  /**
   * Verarbeitet eintreffende Telemetrienachrichten vom externen WebSocket
   */
  handleMessage(messageStr) {
    try {
      this.messagesReceived++;
      this.lastMessageTime = Date.now();
      const msg = JSON.parse(messageStr);
      if (msg.topic) {
        this.lastTopic = msg.topic;
      }

      const type = msg.type || msg.action;

      // 1. Direktes CPS-i40 Standard-Paket
      if (type === "telemetry" || type === "publish_telemetry") {
        const stationId = msg.stationId || msg.id;
        const payload = msg.sample || msg.data || msg;
        if (stationId && payload) {
          return this.onTelemetry(stationId, {
            ...payload,
            isLive: true,
            isDemo: false
          });
        }
      } else if (type === "fault_change") {
        if (msg.stationId) {
          return this.onFault(msg.stationId, Boolean(msg.isFault));
        }
      } else if (msg.stationId && (msg.v1 !== undefined || msg.data)) {
        return this.onTelemetry(msg.stationId, {
          ...(msg.data || msg),
          isLive: true,
          isDemo: false
        });
      }

      // 2. Semantische Interpretation (Node-RED OPC UA, Milo, Prosys, beliebiges IoT JSON)
      if (this.interpreter) {
        const interpreted = this.interpreter.interpret(msg);
        if (interpreted && interpreted.stationId) {
          const sample = {
            v1: interpreted.metrics?.v1?.value ?? interpreted.mappedValues?.v1?.val ?? 0,
            v2: interpreted.metrics?.v2?.value ?? interpreted.mappedValues?.v2?.val ?? 0,
            v3: interpreted.metrics?.v3?.value ?? interpreted.mappedValues?.v3?.val ?? 0,
            isFault: Boolean(interpreted.isFault),
            isLive: true,
            isDemo: false,
            timestamp: interpreted.timestamp || Date.now(),
            opcuaTopic: msg.topic || null,
            interpretation: interpreted.summaryText || interpreted.summary || null
          };

          this.onTelemetry(interpreted.stationId, sample, interpreted);

          if (interpreted.isFault !== undefined) {
            this.onFault(interpreted.stationId, Boolean(interpreted.isFault));
          }
        }
      }
    } catch (_) {
      // Ignoriere unparsebare Frames
    }
  }

  /**
   * Liefert aktuellen Verbindungs- und Streamingstatus
   */
  getStatus() {
    return {
      connected: this.isConnected,
      url: this.url,
      messagesReceived: this.messagesReceived,
      lastMessageTime: this.lastMessageTime,
      lastTopic: this.lastTopic
    };
  }

  /**
   * Aktualisiert die Ziel-URL und verbindet neu
   */
  updateUrl(newUrl) {
    if (!newUrl) return;
    const normalized = normalizeWsUrl(newUrl);
    if (normalized === this.url && this.isConnected) return;
    this.url = normalized;
    this.connect();
  }

  /**
   * Schließt die Verbindung dauerhaft
   */
  close() {
    this.isManualClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client) {
      const oldClient = this.client;
      this.client = null;
      try {
        oldClient.removeAllListeners();
        oldClient.on("error", () => {});
        oldClient.close();
      } catch (_) {}
    }
    this.isConnected = false;
    this.onStatusChange({ connected: false, url: this.url });
  }
}
