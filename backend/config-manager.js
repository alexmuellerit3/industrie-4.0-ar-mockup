/**
 * ConfigManager - Zentrale persistente Konfigurationsverwaltung für CPS-i40
 * 
 * Ermöglicht:
 * 1. Dynamisches Setzen der MQTT Broker URL zur Laufzeit
 * 2. Anpassen von Stations-Parametern, Grenzwerten & Toleranzen
 * 3. Persistenz in config/app-config.json
 * 4. Benachrichtigung von Listenern bei Konfigurationsänderungen
 */

import fs from "fs";
import path from "path";

export const DEFAULT_STATIONS_CONFIG = [
  {
    id: "ST-010",
    name: "Modul 1: Dosen-Zuführung",
    description: "Vakuum- und Magazinförderung",
    plcIp: "192.168.10.11",
    mqttTopic: "cps-i40/ST-010/telemetry",
    wsNodeId: "",
    v1: { id: "magazine_level", label: "Magazin", unit: "%", min: 82, max: 86, defaultVal: 84 },
    v2: { id: "vacuum_pressure", label: "Vakuum", unit: "bar", min: -0.85, max: -0.78, defaultVal: -0.8 },
    v3: { id: "part_counter", label: "Zähler", unit: "Stk", isFixed: true, defaultVal: 1684 }
  },
  {
    id: "ST-020",
    name: "Modul 2: Dosierung & Befüllung",
    description: "Präzisions-Dosierung & Befüllungsdruck",
    plcIp: "192.168.10.12",
    mqttTopic: "cps-i40/ST-020/telemetry",
    wsNodeId: "",
    v1: { id: "fill_weight", label: "Füllgewicht", unit: "g", min: 249.7, max: 250.6, defaultVal: 250.3 },
    v2: { id: "pressure", label: "Druck", unit: "bar", min: 5.1, max: 5.3, defaultVal: 5.2 },
    v3: { id: "throughput", label: "Takt", unit: "D/min", min: 31, max: 33, defaultVal: 32 }
  },
  {
    id: "ST-030",
    name: "Modul 3: Verschluss & Bördelung",
    description: "Bördeldruck & Schließmoment",
    plcIp: "192.168.10.13",
    mqttTopic: "cps-i40/ST-030/telemetry",
    wsNodeId: "",
    v1: { id: "press_force", label: "Anpressdruck", unit: "bar", min: 5.1, max: 5.3, defaultVal: 5.2 },
    v2: { id: "torque", label: "Drehmoment", unit: "Nm", min: 3.8, max: 4.1, defaultVal: 3.9 },
    v3: { id: "seal_check", label: "Prüfung", unit: "%", isFixed: true, defaultVal: 100 }
  },
  {
    id: "ST-040",
    name: "Modul 4: Qualitätskontrolle & Waage",
    description: "Kontrollwägung & Ausschussüberwachung",
    plcIp: "192.168.10.14",
    mqttTopic: "cps-i40/ST-040/telemetry",
    wsNodeId: "",
    v1: { id: "check_weight", label: "Kontrollgewicht", unit: "g", min: 249.8, max: 250.4, defaultVal: 250.1 },
    v2: { id: "reject_rate", label: "Ausschuss", unit: "%", min: 0.3, max: 0.5, defaultVal: 0.4 },
    v3: { id: "oee", label: "OEE", unit: "%", isFixed: true, defaultVal: 93 }
  }
];

export class ConfigManager {
  /**
   * @param {string} filePath - Absoluter Pfad zur persistenten JSON-Konfigurationsdatei
   * @param {Object} [initialDefaults] - Optionale Standardwerte
   */
  constructor(filePath, initialDefaults = {}) {
    this.filePath = filePath;
    this.listeners = new Set();
    this.defaults = this.createDefaultConfig(initialDefaults);
    this.config = this.load();
  }

  createDefaultConfig(overrides = {}) {
    const envMqtt = process.env.MQTT_BROKER_URL || "mqtt://localhost:1883";
    const envWs = process.env.WS_SERVER_URL || "wss://nodered.bbk.robin-w.de/ws/opcua";
    return {
      dataSource: overrides.dataSource || "websocket",
      websocket: {
        url: overrides.websocket?.url || envWs,
        clientId: overrides.websocket?.clientId || "cps-backend-ws",
        reconnectPeriod: 3500,
        connectTimeout: 4000
      },
      mqtt: {
        brokerUrl: overrides.mqtt?.brokerUrl || envMqtt,
        clientId: overrides.mqtt?.clientId || "cps-backend",
        reconnectPeriod: 5000,
        connectTimeout: 4000,
        topics: [
          "cps-i40/+/telemetry",
          "cps-i40/+/status",
          "cps-i40/+/fault",
          "cps-i40/+/command"
        ]
      },
      api: {
        mode: "websocket",
        pollIntervalMs: 1500,
        historyTtlMs: 300000
      },
      mysql: {
        enabled: overrides.mysql?.enabled !== undefined ? overrides.mysql.enabled : true,
        host: overrides.mysql?.host || process.env.MYSQL_HOST || "localhost",
        port: parseInt(overrides.mysql?.port || process.env.MYSQL_PORT || 3306, 10),
        database: overrides.mysql?.database || process.env.MYSQL_DATABASE || "cps_telemetry",
        user: overrides.mysql?.user || process.env.MYSQL_USER || "cps_user",
        password: overrides.mysql?.password || process.env.MYSQL_PASSWORD || "cps_pass_2026",
        retentionHours: parseInt(overrides.mysql?.retentionHours || 24, 10)
      },
      stations: JSON.parse(JSON.stringify(overrides.stations || DEFAULT_STATIONS_CONFIG))
    };
  }

  /**
   * Lädt die Konfiguration von der Festplatte oder initialisiert Defaults
   */
  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        const parsed = JSON.parse(raw);
        // Stelle sicher, dass essentielle Schlüssel existieren
        return {
          dataSource: parsed.dataSource || this.defaults.dataSource,
          websocket: { ...this.defaults.websocket, ...(parsed.websocket || {}) },
          mqtt: { ...this.defaults.mqtt, ...(parsed.mqtt || {}) },
          api: { ...this.defaults.api, ...(parsed.api || {}) },
          mysql: { ...this.defaults.mysql, ...(parsed.mysql || {}) },
          stations: parsed.stations && Array.isArray(parsed.stations) ? parsed.stations : this.defaults.stations
        };
      }
    } catch (err) {
      console.warn(`[ConfigManager] Konnte Konfigurationsdatei nicht lesen (${this.filePath}):`, err.message);
    }

    const fallback = JSON.parse(JSON.stringify(this.defaults));
    this.save(fallback);
    return fallback;
  }

  /**
   * Speichert die Konfiguration atomar auf die Festplatte
   */
  save(configToSave = this.config) {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(configToSave, null, 2), "utf-8");
      return true;
    } catch (err) {
      console.error(`[ConfigManager] Fehler beim Speichern der Konfiguration:`, err);
      return false;
    }
  }

  /**
   * Gibt eine Kopie der aktuellen Konfiguration zurück
   */
  getConfig() {
    return JSON.parse(JSON.stringify(this.config));
  }

  /**
   * Aktualisiert Teile der Konfiguration, speichert sie und benachrichtigt Listener
   * @param {Object} partial - Partielle Konfiguration
   */
  updateConfig(partial = {}) {
    const updated = JSON.parse(JSON.stringify(this.config));

    if (partial.dataSource && typeof partial.dataSource === "string") {
      const src = partial.dataSource.toLowerCase().trim();
      if (["websocket", "mqtt", "simulator", "mock"].includes(src)) {
        updated.dataSource = src === "mock" ? "simulator" : src;
      }
    }

    if (partial.websocket) {
      if (!updated.websocket) updated.websocket = {};
      if (partial.websocket.url && typeof partial.websocket.url === "string") {
        updated.websocket.url = partial.websocket.url.trim();
      }
      if (partial.websocket.clientId) updated.websocket.clientId = String(partial.websocket.clientId);
      if (partial.websocket.reconnectPeriod) updated.websocket.reconnectPeriod = Number(partial.websocket.reconnectPeriod);
      if (partial.websocket.connectTimeout) updated.websocket.connectTimeout = Number(partial.websocket.connectTimeout);
    }

    if (partial.mqtt) {
      if (partial.mqtt.brokerUrl && typeof partial.mqtt.brokerUrl === "string") {
        updated.mqtt.brokerUrl = partial.mqtt.brokerUrl.trim();
      }
      if (partial.mqtt.clientId) updated.mqtt.clientId = String(partial.mqtt.clientId);
      if (partial.mqtt.reconnectPeriod) updated.mqtt.reconnectPeriod = Number(partial.mqtt.reconnectPeriod);
      if (partial.mqtt.connectTimeout) updated.mqtt.connectTimeout = Number(partial.mqtt.connectTimeout);
      if (Array.isArray(partial.mqtt.topics)) {
        updated.mqtt.topics = [...new Set(partial.mqtt.topics.map(t => String(t).trim()).filter(Boolean))];
      }
      if (partial.mqtt.subscribeTopic && typeof partial.mqtt.subscribeTopic === "string") {
        const top = partial.mqtt.subscribeTopic.trim();
        if (top && !updated.mqtt.topics.includes(top)) {
          updated.mqtt.topics.push(top);
        }
      }
      if (partial.mqtt.unsubscribeTopic && typeof partial.mqtt.unsubscribeTopic === "string") {
        const top = partial.mqtt.unsubscribeTopic.trim();
        updated.mqtt.topics = updated.mqtt.topics.filter(t => t !== top);
      }
    }

    if (partial.api) {
      if (partial.api.mode) updated.api.mode = String(partial.api.mode);
      if (partial.api.pollIntervalMs) updated.api.pollIntervalMs = Number(partial.api.pollIntervalMs);
      if (partial.api.historyTtlMs) updated.api.historyTtlMs = Number(partial.api.historyTtlMs);
    }

    if (partial.mysql) {
      if (!updated.mysql) updated.mysql = {};
      if (partial.mysql.enabled !== undefined) updated.mysql.enabled = Boolean(partial.mysql.enabled);
      if (partial.mysql.host) updated.mysql.host = String(partial.mysql.host).trim();
      if (partial.mysql.port) updated.mysql.port = parseInt(partial.mysql.port, 10);
      if (partial.mysql.database) updated.mysql.database = String(partial.mysql.database).trim();
      if (partial.mysql.user) updated.mysql.user = String(partial.mysql.user).trim();
      if (partial.mysql.password !== undefined) updated.mysql.password = String(partial.mysql.password);
      if (partial.mysql.retentionHours) updated.mysql.retentionHours = parseInt(partial.mysql.retentionHours, 10);
    }

    if (Array.isArray(partial.stations)) {
      // Map Stations
      updated.stations = partial.stations.map((newSt, idx) => {
        const existing = updated.stations.find(s => s.id === newSt.id) || updated.stations[idx] || {};
        return {
          ...existing,
          ...newSt,
          v1: { ...(existing.v1 || {}), ...(newSt.v1 || {}) },
          v2: { ...(existing.v2 || {}), ...(newSt.v2 || {}) },
          v3: { ...(existing.v3 || {}), ...(newSt.v3 || {}) }
        };
      });

      // Wenn Stationen ein eigenes mqttTopic haben, stelle sicher, dass dieses abonniert wird
      if (!updated.mqtt.topics) updated.mqtt.topics = [];
      updated.stations.forEach(st => {
        if (st.mqttTopic && !updated.mqtt.topics.includes(st.mqttTopic)) {
          updated.mqtt.topics.push(st.mqttTopic);
        }
      });
    }

    this.config = updated;
    this.save(this.config);
    this.notify(this.config);
    return this.getConfig();
  }

  /**
   * Aktualisiert oder konfiguriert ein einzelnes Modul / Station
   * @param {string} stationId - ID der Station (z. B. 'ST-010')
   * @param {Object} stationData - Konfigurationsdaten (name, v1, v2, v3, mqttTopic, etc.)
   */
  updateStation(stationId, stationData = {}) {
    const updated = JSON.parse(JSON.stringify(this.config));
    if (!Array.isArray(updated.stations)) updated.stations = [];

    let stationIdx = updated.stations.findIndex(s => s.id === stationId);
    let target = stationIdx >= 0 ? updated.stations[stationIdx] : { id: stationId };

    const merged = {
      ...target,
      ...stationData,
      id: stationData.id || target.id || stationId,
      name: stationData.name !== undefined ? String(stationData.name).trim() : target.name,
      description: stationData.description !== undefined ? String(stationData.description).trim() : target.description,
      plcIp: stationData.plcIp !== undefined ? String(stationData.plcIp).trim() : target.plcIp,
      mqttTopic: stationData.mqttTopic !== undefined ? String(stationData.mqttTopic).trim() : target.mqttTopic,
      wsNodeId: stationData.wsNodeId !== undefined ? String(stationData.wsNodeId).trim() : target.wsNodeId,
      v1: { ...(target.v1 || {}), ...(stationData.v1 || {}) },
      v2: { ...(target.v2 || {}), ...(stationData.v2 || {}) },
      v3: { ...(target.v3 || {}), ...(stationData.v3 || {}) }
    };

    if (stationIdx >= 0) {
      updated.stations[stationIdx] = merged;
    } else {
      updated.stations.push(merged);
    }

    // Wenn neues MQTT-Topic definiert wurde, in mqtt.topics aufnehmen
    if (merged.mqttTopic) {
      if (!updated.mqtt) updated.mqtt = {};
      if (!Array.isArray(updated.mqtt.topics)) updated.mqtt.topics = [];
      if (!updated.mqtt.topics.includes(merged.mqttTopic)) {
        updated.mqtt.topics.push(merged.mqttTopic);
      }
    }

    this.config = updated;
    this.save(this.config);
    this.notify(this.config);
    return merged;
  }

  /**
   * Liefert alle konfigurierten Stationen
   * @returns {Array}
   */
  getStations() {
    return Array.isArray(this.config?.stations) ? this.config.stations : [];
  }

  /**
   * Liefert eine Station anhand ihrer ID
   * @param {string} stationId 
   * @returns {Object|null}
   */
  getStation(stationId) {
    return this.getStations().find(s => s.id === stationId) || null;
  }

  /**
   * Fügt ein neues Modul / Station hinzu
   * @param {Object} stationData
   */
  addStation(stationData) {
    const sId = stationData.id || `ST-${String(this.config.stations.length + 1).padStart(3, "0")}0`;
    return this.updateStation(sId, { ...stationData, id: sId });
  }

  /**
   * Löscht ein Modul / Station aus der Konfiguration
   * @param {string} stationId
   */
  deleteStation(stationId) {
    const updated = JSON.parse(JSON.stringify(this.config));
    if (!Array.isArray(updated.stations)) return false;

    const beforeLen = updated.stations.length;
    updated.stations = updated.stations.filter(s => s.id !== stationId);
    if (updated.stations.length !== beforeLen) {
      this.config = updated;
      this.save(this.config);
      this.notify(this.config);
      return true;
    }
    return false;
  }

  /**
   * Abonniert ein MQTT-Topic persistent
   * @param {string} topic
   */
  subscribeTopic(topic) {
    if (!topic || typeof topic !== "string") return false;
    const top = topic.trim();
    return this.updateConfig({
      mqtt: { subscribeTopic: top }
    });
  }

  /**
   * De-abonniert ein MQTT-Topic persistent
   * @param {string} topic
   */
  unsubscribeTopic(topic) {
    if (!topic || typeof topic !== "string") return false;
    const top = topic.trim();
    return this.updateConfig({
      mqtt: { unsubscribeTopic: top }
    });
  }

  /**
   * Setzt die Konfiguration auf Standardwerte zurück
   */
  resetConfig() {
    this.config = JSON.parse(JSON.stringify(this.defaults));
    this.save(this.config);
    this.notify(this.config);
    return this.getConfig();
  }

  /**
   * Registriert einen Listener für Konfigurationsänderungen
   * @param {Function} callback - fn(newConfig)
   */
  onChange(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  notify(newConfig) {
    for (const listener of this.listeners) {
      try {
        listener(newConfig);
      } catch (err) {
        console.error("[ConfigManager] Listener Fehler:", err);
      }
    }
  }
}
