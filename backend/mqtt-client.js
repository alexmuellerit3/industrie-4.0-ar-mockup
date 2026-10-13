/**
 * MqttClientService - MQTT Anbindung für CPS-i40 Industrie 4.0 Telemetrie
 * 
 * Abonniert Topics (z. B. cps-i40/+/telemetry) von realen SPS-Gateways (IOT2050 / Node-RED).
 * Bietet automatischen Reconnect und einen integrierten SPS-Simulator falls kein Broker läuft.
 */

import mqtt from "mqtt";

export class MqttClientService {
  constructor(options = {}) {
    this.brokerUrl = options.brokerUrl || process.env.MQTT_BROKER_URL || "mqtt://localhost:1883";
    this.clientId = options.clientId || `cps-backend-${Math.random().toString(16).substring(2, 8)}`;
    this.client = null;
    this.isConnected = false;
    this.isSimulatorActive = false;
    this.simulatorTimer = null;
    
    // Callbacks
    this.onTelemetry = options.onTelemetry || (() => {});
    this.onFault = options.onFault || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});

    // Topic Patterns
    this.topics = [
      "cps-i40/+/telemetry",
      "cps-i40/+/status",
      "cps-i40/+/fault",
      "cps-i40/+/command"
    ];
  }

  /**
   * Verbindet mit dem MQTT-Broker
   */
  connect() {
    console.info(`[MQTT] Verbinde mit Broker: ${this.brokerUrl}`);

    try {
      this.client = mqtt.connect(this.brokerUrl, {
        clientId: this.clientId,
        clean: true,
        connectTimeout: 4000,
        reconnectPeriod: 5000,
        rejectUnauthorized: false
      });

      this.client.on("connect", () => {
        this.isConnected = true;
        this.stopSimulator();
        console.info(`[MQTT] Erfolgreich verbunden mit ${this.brokerUrl}`);

        this.topics.forEach(t => {
          this.client.subscribe(t, (err) => {
            if (!err) {
              console.info(`[MQTT] Topic abonniert: ${t}`);
            }
          });
        });

        this.onStatusChange({ connected: true, brokerUrl: this.brokerUrl, simulated: false });
      });

      this.client.on("message", (topic, messageBuffer) => {
        this.handleMessage(topic, messageBuffer.toString());
      });

      this.client.on("error", (err) => {
        console.warn(`[MQTT] Verbindungsfehler (${this.brokerUrl}):`, err.message);
        this.handleDisconnect();
      });

      this.client.on("close", () => {
        if (this.isConnected) {
          console.warn("[MQTT] Verbindung geschlossen.");
          this.handleDisconnect();
        }
      });
    } catch (err) {
      console.warn("[MQTT] Fehler beim Initialisieren des MQTT-Clients:", err);
      this.handleDisconnect();
    }

    // Fallback: Wenn nach 3 Sekunden kein Broker antwortet, Simulator aktivieren
    setTimeout(() => {
      if (!this.isConnected && !this.isSimulatorActive) {
        console.info("[MQTT] Kein externer Broker erreichbar - aktiviere internen CPS-SPS-Simulator.");
        this.startSimulator();
      }
    }, 2500);
  }

  handleDisconnect() {
    this.isConnected = false;
    this.onStatusChange({ connected: false, brokerUrl: this.brokerUrl, simulated: this.isSimulatorActive });
    if (!this.isSimulatorActive) {
      this.startSimulator();
    }
  }

  /**
   * Verarbeitet eintreffende MQTT-Nachrichten
   */
  handleMessage(topic, payloadString) {
    try {
      const parts = topic.split("/");
      const stationId = parts[1]; // cps-i40/{stationId}/...
      const subType = parts[2];   // telemetry | status | fault | command

      const payload = JSON.parse(payloadString);

      if (subType === "telemetry") {
        this.onTelemetry(stationId, payload);
      } else if (subType === "fault") {
        this.onFault(stationId, Boolean(payload.isFault), payload);
      } else if (subType === "command") {
        console.info(`[MQTT] Steuerungsbefehl empfangen für ${stationId}:`, payload);
      }
    } catch (e) {
      console.warn(`[MQTT] Konnte Payload nicht parsen (${topic}):`, e.message);
    }
  }

  /**
   * Sendet eine Nachricht an den MQTT-Broker
   */
  publish(topic, data) {
    if (!this.client || !this.isConnected) return false;
    const payload = typeof data === "string" ? data : JSON.stringify(data);
    this.client.publish(topic, payload, { qos: 1 });
    return true;
  }

  /**
   * Sendet einen Befehl an eine Station (z. B. Störung simulieren / quittieren)
   */
  publishCommand(stationId, command) {
    return this.publish(`cps-i40/${stationId}/command`, {
      command,
      timestamp: Date.now()
    });
  }

  /**
   * INTERNER SIMULATOR (Falls kein MQTT-Broker existiert)
   * Garantiert 100% autarke Funktionalität in Test- & Demo-Umgebungen
   */
  startSimulator(stationsConfig) {
    if (this.isSimulatorActive) return;
    this.isSimulatorActive = true;
    this.onStatusChange({ connected: false, brokerUrl: this.brokerUrl, simulated: true });

    const stations = stationsConfig || [
      { id: "ST-010", v1: { val: 84, min: 82, max: 86 }, v2: { val: -0.8, min: -0.85, max: -0.78 }, v3: { val: 1684 } },
      { id: "ST-020", v1: { val: 250.3, min: 249.7, max: 250.6 }, v2: { val: 5.2, min: 5.1, max: 5.3 }, v3: { val: 32, min: 31, max: 33 } },
      { id: "ST-030", v1: { val: 5.2, min: 5.1, max: 5.3 }, v2: { val: 3.9, min: 3.8, max: 4.1 }, v3: { val: 100 } },
      { id: "ST-040", v1: { val: 250.1, min: 249.8, max: 250.4 }, v2: { val: 0.4, min: 0.3, max: 0.5 }, v3: { val: 93 } }
    ];

    let tick = 0;
    this.simulatorTimer = setInterval(() => {
      tick++;
      stations.forEach(st => {
        // Leichte Fluktuation
        ['v1', 'v2', 'v3'].forEach(k => {
          const item = st[k];
          if (item && item.min !== undefined && item.max !== undefined) {
            const delta = (Math.random() - 0.5) * 0.08;
            let val = +(item.val + delta).toFixed(1);
            if (val >= item.min && val <= item.max) {
              item.val = val;
            }
          }
        });

        // Telemetrie einspeisen
        this.onTelemetry(st.id, {
          v1: st.v1.val,
          v2: st.v2.val,
          v3: st.v3.val,
          timestamp: Date.now(),
          simulated: true
        });
      });
    }, 1500);
  }

  stopSimulator() {
    if (this.simulatorTimer) {
      clearInterval(this.simulatorTimer);
      this.simulatorTimer = null;
    }
    this.isSimulatorActive = false;
  }

  disconnect() {
    this.stopSimulator();
    if (this.client) {
      this.client.end(true);
      this.client = null;
    }
    this.isConnected = false;
  }

  /**
   * Ändert die MQTT-Broker URL dynamisch zur Laufzeit und verbindet neu
   * @param {string} newBrokerUrl - Neue MQTT URL (z.B. mqtt://192.168.10.1:1883)
   */
  updateBroker(newBrokerUrl) {
    if (!newBrokerUrl || typeof newBrokerUrl !== "string") return false;
    const cleanUrl = newBrokerUrl.trim();
    console.info(`[MQTT] Aktualisiere Broker URL: ${this.brokerUrl} -> ${cleanUrl}`);
    
    this.disconnect();
    this.brokerUrl = cleanUrl;
    this.connect();
    return true;
  }

  /**
   * Testet die Erreichbarkeit eines MQTT-Brokers ohne den aktiven Dienst zu stören
   * @param {string} brokerUrl - Zu testende Broker URL
   * @param {number} [timeoutMs=3500] - Timeout in Millisekunden
   * @returns {Promise<{success: boolean, message: string}>}
   */
  static testConnection(brokerUrl, timeoutMs = 3500) {
    return new Promise((resolve) => {
      if (!brokerUrl || typeof brokerUrl !== "string") {
        return resolve({ success: false, message: "Ungültige oder leere Broker-URL angegeben." });
      }

      let client = null;
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          if (client) {
            try { client.end(true); } catch (_) {}
          }
          resolve({ success: false, message: `Zeitüberschreitung beim Verbindungsaufbau zu ${brokerUrl} (${timeoutMs}ms).` });
        }
      }, timeoutMs);

      try {
        const testId = `test-${Math.random().toString(16).substring(2, 8)}`;
        client = mqtt.connect(brokerUrl.trim(), {
          clientId: testId,
          clean: true,
          connectTimeout: timeoutMs,
          reconnectPeriod: 0,
          rejectUnauthorized: false
        });

        client.on("connect", () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            try { client.end(true); } catch (_) {}
            resolve({ success: true, message: `Erfolgreich mit Broker verbunden: ${brokerUrl}` });
          }
        });

        client.on("error", (err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            try { client.end(true); } catch (_) {}
            resolve({ success: false, message: `Verbindungsfehler: ${err.message}` });
          }
        });
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ success: false, message: `Fehler: ${err.message}` });
        }
      }
    });
  }
}
