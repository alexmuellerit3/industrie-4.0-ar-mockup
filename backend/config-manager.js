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
    return {
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
          mqtt: { ...this.defaults.mqtt, ...(parsed.mqtt || {}) },
          api: { ...this.defaults.api, ...(parsed.api || {}) },
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

    if (partial.mqtt) {
      if (partial.mqtt.brokerUrl && typeof partial.mqtt.brokerUrl === "string") {
        updated.mqtt.brokerUrl = partial.mqtt.brokerUrl.trim();
      }
      if (partial.mqtt.clientId) updated.mqtt.clientId = String(partial.mqtt.clientId);
      if (partial.mqtt.reconnectPeriod) updated.mqtt.reconnectPeriod = Number(partial.mqtt.reconnectPeriod);
      if (partial.mqtt.connectTimeout) updated.mqtt.connectTimeout = Number(partial.mqtt.connectTimeout);
    }

    if (partial.api) {
      if (partial.api.mode) updated.api.mode = String(partial.api.mode);
      if (partial.api.pollIntervalMs) updated.api.pollIntervalMs = Number(partial.api.pollIntervalMs);
      if (partial.api.historyTtlMs) updated.api.historyTtlMs = Number(partial.api.historyTtlMs);
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
    }

    this.config = updated;
    this.save(this.config);
    this.notify(this.config);
    return this.getConfig();
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
