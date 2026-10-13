/**
 * WebSocketClientService - Upstream WebSocket-Client für CPS-i40
 * 
 * Ermöglicht es dem Backend, Telemetriedaten von einem externen WebSocket-Server
 * (z. B. Node-RED, Siemens IOT2050, oder Cloud-Gateway) als Datenquelle zu abonnieren.
 */

import { WebSocket } from "ws";

export class WebSocketClientService {
  /**
   * @param {Object} options
   * @param {string} [options.url] - WebSocket Server URL (z.B. ws://localhost:3000/ws/telemetry)
   * @param {string} [options.clientId] - Eindeutige Client-ID
   * @param {number} [options.reconnectPeriod=3500] - Wiederverbindungsintervall in ms
   * @param {Function} [options.onTelemetry] - fn(stationId, payload)
   * @param {Function} [options.onFault] - fn(stationId, isFault)
   * @param {Function} [options.onStatusChange] - fn(statusObj)
   */
  constructor(options = {}) {
    this.url = options.url || process.env.WS_SERVER_URL || "ws://localhost:3000/ws/telemetry";
    this.clientId = options.clientId || `cps-ws-client-${Math.random().toString(16).substring(2, 8)}`;
    this.reconnectPeriod = options.reconnectPeriod || 3500;
    this.onTelemetry = options.onTelemetry || (() => {});
    this.onFault = options.onFault || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});

    this.client = null;
    this.isConnected = false;
    this.reconnectTimer = null;
    this.isManualClosed = false;
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

    const trimmed = String(this.url || "").trim();
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
        handshakeTimeout: 4000
      };

      if (isWss) {
        // Tolerante TLS-Validierung für industrielle Edge-Gateways & Intranets mit internen Zertifikaten
        wsOptions.rejectUnauthorized = this.rejectUnauthorized !== undefined
          ? Boolean(this.rejectUnauthorized)
          : (process.env.WS_REJECT_UNAUTHORIZED === "true");
      }

      this.client = new WebSocket(trimmed, wsOptions);

      this.client.on("open", () => {
        this.isConnected = true;
        console.info(`[WS-Client] Erfolgreich verbunden mit ${trimmed} (${isWss ? "WSS / TLS gesichert" : "WS"})`);
        this.onStatusChange({ connected: true, url: this.url, protocol: isWss ? "wss" : "ws", isSecure: isWss });
      });

      this.client.on("message", (data) => {
        this.handleMessage(data.toString());
      });

      this.client.on("error", (err) => {
        console.warn(`[WS-Client] Verbindungsfehler (${trimmed}):`, err.message);
        this.handleDisconnect();
      });

      this.client.on("close", () => {
        if (this.isConnected) {
          console.info("[WS-Client] Verbindung geschlossen.");
        }
        this.handleDisconnect();
      });
    } catch (err) {
      console.warn("[WS-Client] Initialisierungsfehler:", err.message);
      this.handleDisconnect();
    }
  }

  handleDisconnect() {
    this.isConnected = false;
    const isWss = /^wss:\/\//i.test(String(this.url || "").trim());
    this.onStatusChange({ connected: false, url: this.url, protocol: isWss ? "wss" : "ws", isSecure: isWss });

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
      const msg = JSON.parse(messageStr);
      const type = msg.type || msg.action;

      if (type === "telemetry" || type === "publish_telemetry") {
        const stationId = msg.stationId || msg.id;
        const payload = msg.sample || msg.data || msg;
        if (stationId && payload) {
          this.onTelemetry(stationId, payload);
        }
      } else if (type === "fault_change") {
        if (msg.stationId) {
          this.onFault(msg.stationId, Boolean(msg.isFault));
        }
      } else if (msg.stationId && (msg.v1 !== undefined || msg.data)) {
        // Direktes flaches oder verschachteltes Telemetrie-Paket
        this.onTelemetry(msg.stationId, msg.data || msg);
      }
    } catch (_) {}
  }

  /**
   * Aktualisiert die Ziel-URL und verbindet neu
   */
  updateUrl(newUrl) {
    if (!newUrl || newUrl === this.url) return;
    this.url = newUrl;
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
