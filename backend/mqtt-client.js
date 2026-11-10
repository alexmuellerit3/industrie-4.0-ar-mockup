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
    this.allowSimulator = options.allowSimulator !== false;
    this.isSimulatorActive = false;
    this.simulatorTimer = null;
    this.fallbackTimer = null;
    
    // Callbacks
    this.onTelemetry = options.onTelemetry || (() => {});
    this.onFault = options.onFault || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});

    // Semantischer Interpreter & Stationskonfiguration für dynamische Topic-Bindung
    this.interpreter = options.telemetryInterpreter || null;
    this.stations = options.stations || options.stationsConfig || [];

    // Topic Patterns (unterstützt benutzerdefinierte Topics, z. B. /bbk-lf/rpi04/power-house/vibration)
    const initialTopics = Array.isArray(options.topics) && options.topics.length > 0
      ? options.topics
      : [
          "cps-i40/+/telemetry",
          "cps-i40/+/status",
          "cps-i40/+/fault",
          "cps-i40/+/command"
        ];
    this.topics = [...new Set(initialTopics.map(t => String(t).trim()).filter(Boolean))];

    // Automatisches Abonnieren von allen stationsspezifischen MQTT-Topics
    if (Array.isArray(this.stations)) {
      this.stations.forEach(st => {
        if (st.mqttTopic && !this.topics.includes(st.mqttTopic)) {
          this.topics.push(st.mqttTopic);
        }
      });
    }
  }

  /**
   * Abonniert dynamisch ein neues MQTT-Topic zur Laufzeit
   * @param {string} topic - z. B. '/bbk-lf/rpi04/power-house/vibration'
   */
  subscribe(topic) {
    if (!topic || typeof topic !== "string") return false;
    const trimmed = topic.trim();
    if (!this.topics.includes(trimmed)) {
      this.topics.push(trimmed);
    }
    if (this.client && this.isConnected) {
      this.client.subscribe(trimmed, (err) => {
        if (err) {
          console.warn(`[MQTT] Fehler beim Abonnieren von '${trimmed}':`, err.message);
        } else {
          console.info(`[MQTT] Topic erfolgreich live abonniert: ${trimmed}`);
        }
      });
    }
    return true;
  }

  /**
   * De-abonniert ein MQTT-Topic
   * @param {string} topic
   */
  unsubscribe(topic) {
    if (!topic || typeof topic !== "string") return false;
    const trimmed = topic.trim();
    this.topics = this.topics.filter(t => t !== trimmed);
    if (this.client && this.isConnected) {
      this.client.unsubscribe(trimmed, (err) => {
        if (!err) {
          console.info(`[MQTT] Topic de-abonniert: ${trimmed}`);
        }
      });
    }
    return true;
  }

  /**
   * Gibt alle aktuell abonnierten Topics zurück
   * @returns {string[]}
   */
  getSubscribedTopics() {
    return [...this.topics];
  }

  /**
   * Aktualisiert die Stationskonfiguration für Topic-Mappings
   * @param {Array} stations
   */
  updateStations(stations) {
    if (Array.isArray(stations)) {
      this.stations = stations;
      stations.forEach(st => {
        if (st.mqttTopic && !this.topics.includes(st.mqttTopic)) {
          this.subscribe(st.mqttTopic);
        }
      });
    }
  }

  /**
   * Deaktiviert den internen Simulator dauerhaft (z.B. wenn WebSocket primäre Datenquelle ist)
   */
  disableSimulator() {
    this.allowSimulator = false;
    this.stopSimulator();
  }

  /**
   * Erlaubt die Aktivierung des internen Simulators
   */
  enableSimulator() {
    this.allowSimulator = true;
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

    // Fallback: Wenn nach 2,5 Sekunden kein Broker antwortet, Simulator aktivieren (nur falls erlaubt)
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer);
    this.fallbackTimer = setTimeout(() => {
      if (this.allowSimulator && !this.isConnected && !this.isSimulatorActive) {
        console.info("[MQTT] Kein externer Broker erreichbar - aktiviere internen CPS-SPS-Simulator.");
        this.startSimulator();
      }
    }, 2500);
  }

  handleDisconnect() {
    this.isConnected = false;
    this.onStatusChange({ connected: false, brokerUrl: this.brokerUrl, simulated: this.isSimulatorActive });
    if (this.allowSimulator && !this.isSimulatorActive) {
      this.startSimulator();
    }
  }

  /**
   * Verarbeitet eintreffende MQTT-Nachrichten (unterstützt Standard- & beliebige abonnierte Topics)
   */
  handleMessage(topic, payloadString) {
    try {
      let payload;
      try {
        payload = JSON.parse(payloadString);
      } catch (_) {
        const num = parseFloat(payloadString);
        if (!isNaN(num)) {
          payload = { value: num, raw: payloadString };
        } else {
          payload = { value: payloadString, raw: payloadString };
        }
      }

      // 1. Prüfe, ob eine Station direkt an dieses MQTT-Topic gebunden ist
      let targetStation = null;
      if (Array.isArray(this.stations)) {
        targetStation = this.stations.find(s => s.mqttTopic && (s.mqttTopic === topic || topic.endsWith(s.mqttTopic)));
      }

      // 2. Standard CPS-i40 Format: cps-i40/{stationId}/...
      const parts = topic.split("/");
      if (parts[0] === "cps-i40" && parts.length >= 3) {
        const stationId = parts[1];
        const subType = parts[2];
        if (subType === "telemetry") {
          return this.onTelemetry(stationId, {
            ...payload,
            isLive: true,
            isDemo: false
          });
        } else if (subType === "fault") {
          return this.onFault(stationId, Boolean(payload.isFault), payload);
        } else if (subType === "command") {
          console.info(`[MQTT] Steuerungsbefehl empfangen für ${stationId}:`, payload);
          return;
        }
      }

      // 3. Wenn eine Station an dieses Topic gebunden ist
      if (targetStation) {
        if (this.interpreter) {
          const interpreted = this.interpreter.interpret(payload, { stationId: targetStation.id, topic });
          if (interpreted) {
            const v1Val = interpreted.mappedValues?.v1?.val ?? (typeof payload === "number" ? payload : payload?.value ?? 0);
            const sample = {
              v1: v1Val,
              v2: interpreted.mappedValues?.v2?.val ?? targetStation.v2?.defaultVal ?? 0,
              v3: interpreted.mappedValues?.v3?.val ?? targetStation.v3?.defaultVal ?? 0,
              isFault: Boolean(interpreted.isFault),
              isLive: true,
              isDemo: false,
              timestamp: interpreted.timestamp || Date.now(),
              topic,
              interpretation: interpreted.summary
            };
            return this.onTelemetry(targetStation.id, sample, {
              topic,
              interpretation: interpreted.summary
            });
          }
        }
        const numVal = typeof payload === "number" ? payload : (payload.value ?? payload.v1 ?? 0);
        return this.onTelemetry(targetStation.id, {
          v1: numVal,
          isLive: true,
          isDemo: false,
          timestamp: Date.now(),
          topic
        });
      }

      // 4. Beliebiges Topic mit semantischer Telemetrie-Interpretation
      if (this.interpreter) {
        const interpreted = this.interpreter.interpret({ ...payload, topic });
        if (interpreted) {
          const sId = interpreted.stationId || "ST-010";
          const sample = {
            v1: interpreted.mappedValues?.v1?.val ?? 0,
            v2: interpreted.mappedValues?.v2?.val ?? 0,
            v3: interpreted.mappedValues?.v3?.val ?? 0,
            isFault: Boolean(interpreted.isFault),
            isLive: true,
            isDemo: false,
            timestamp: interpreted.timestamp || Date.now(),
            topic,
            interpretation: interpreted.summary
          };
          return this.onTelemetry(sId, sample, {
            topic,
            interpretation: interpreted.summary
          });
        }
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
    if (!this.allowSimulator) return;
    if (this.isSimulatorActive) return;
    this.isSimulatorActive = true;
    this.onStatusChange({ connected: false, brokerUrl: this.brokerUrl, simulated: true });

    const stations = stationsConfig || [
      { id: "ST-010", v1: { val: 0.8, min: 0.05, max: 2.5 }, v2: { val: 0, min: 0, max: 0 }, v3: { val: 100 } }
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
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
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
