/**
 * CollectorService - Entkoppelte Datenerfassungs- und Zabbix-Trigger-Schicht
 * 
 * Trennt die Ingestion-Logik (MQTT, Upstream-WebSocket, Simulator) von Express
 * und steuert den dualen Schreibpfad:
 * 1. 5-Minuten RAM-Store (KeyValueStore für Echtzeit-Dashboards)
 * 2. 24-Stunden MySQL-Store (MySqlStore für Langzeitanalysen & Zabbix-Items)
 */

export class CollectorService {
  /**
   * @param {Object} options
   * @param {KeyValueStore} options.store
   * @param {MySqlStore} options.mysqlStore
   * @param {ConfigManager} options.configManager
   * @param {TelemetryInterpreter} options.telemetryInterpreter
   * @param {Function} [options.onBroadcastTelemetry]
   * @param {Function} [options.onBroadcastProblem]
   * @param {Function} [options.onBroadcastConfig]
   */
  constructor(options = {}) {
    this.store = options.store;
    this.mysqlStore = options.mysqlStore;
    this.configManager = options.configManager;
    this.telemetryInterpreter = options.telemetryInterpreter;
    this.onBroadcastTelemetry = options.onBroadcastTelemetry || (() => {});
    this.onBroadcastProblem = options.onBroadcastProblem || (() => {});
    this.onBroadcastConfig = options.onBroadcastConfig || (() => {});

    this.activeTriggers = new Map(); // stationId:itemKey -> activeProblem
  }

  /**
   * Zentrale Methode zur Ingestion eines Telemetriepakets
   */
  async ingest(stationId, payload, meta = {}) {
    if (!stationId || !payload) return null;

    const round3 = (val) => {
      if (typeof val === "number") return isNaN(val) ? 0 : +val.toFixed(3);
      if (typeof val === "string" && !isNaN(parseFloat(val)) && /^-?\d+(\.\d+)?$/.test(val.trim())) return +parseFloat(val).toFixed(3);
      return val;
    };
    if (payload.v1 !== undefined) payload.v1 = round3(payload.v1);
    if (payload.v2 !== undefined) payload.v2 = round3(payload.v2);
    if (payload.v3 !== undefined) payload.v3 = round3(payload.v3);

    let effectiveId = stationId;
    if (effectiveId === "ST-POWERHOUSE-VIBRATION") {
      const st010 = this.configManager.getStation("ST-010");
      if (st010) effectiveId = "ST-010";
    }

    // 1. Zabbix Low-Level Discovery (LLD) / Auto-Modul-Generierung
    let station = this.configManager.getStation(effectiveId);
    if (!station) {
      // Prüfe ob bereits eine Station mit demselben Namen existiert
      const existingSameName = this.configManager.getStations().find(s => 
        (meta?.stationName && s.name.toLowerCase() === meta.stationName.toLowerCase()) ||
        (meta?.synthesizedStation?.name && s.name.toLowerCase() === meta.synthesizedStation.name.toLowerCase())
      );
      if (existingSameName) {
        effectiveId = existingSameName.id;
        station = existingSameName;
      }
    }

    if (!station) {
      station = meta?.synthesizedStation ||
        this.telemetryInterpreter.synthesizeStationFromPayload(payload, { stationId: effectiveId, topic: meta?.opcuaTopic || meta?.topic }) || {
          id: effectiveId,
          name: meta?.stationName || effectiveId,
          plcIp: "192.168.10.15",
          mqttTopic: meta?.topic || null,
          wsNodeId: meta?.opcuaTopic || null,
          isDynamic: true,
          isLive: true,
          isDemo: false,
          v1: { label: "Messwert", unit: "", min: 0, max: 100, defaultVal: payload.v1, val: payload.v1 },
          v2: { label: "Status-Code", unit: "Good", min: 0, max: 0, defaultVal: 0, val: 0 },
          v3: { label: "Signal-Güte", unit: "%", min: 90, max: 100, defaultVal: 100, val: 100 }
        };

      this.configManager.addStation(station);
      this.telemetryInterpreter.updateStations(this.configManager.getStations());
      if (this.mysqlStore) {
        this.mysqlStore.syncHostsAndItems([station]).catch(() => {});
      }
      this.onBroadcastConfig(this.configManager.getConfig());
    }

    const timestamp = payload.timestamp || Date.now();

    // 2. Dual-Write: 5-Minuten In-Memory KeyValueStore
    const ramEntry = this.store.push(effectiveId, {
      ...payload,
      isLive: true,
      isDemo: false
    }, timestamp);

    // 3. Dual-Write: 24-Stunden MySQL Store
    if (this.mysqlStore) {
      this.mysqlStore.recordSample(effectiveId, payload, timestamp).catch(() => {});
    }

    // 4. Zabbix Trigger-Auswertung (Toleranz- und Schwellenwertprüfung)
    this.evaluateZabbixTriggers(station, payload, timestamp);

    // 5. Broadcast an alle verbundenen WebClients
    this.onBroadcastTelemetry(effectiveId, ramEntry, meta);

    return ramEntry;
  }

  /**
   * Prüft Messwerte gegen Zabbix-Trigger & Schwellenwerte
   */
  evaluateZabbixTriggers(station, payload, timestamp) {
    if (!station) return;

    const checkMetric = (key, metricObj) => {
      if (!metricObj) return;
      const val = typeof payload[key] === "number" ? payload[key] : payload[key]?.val;
      if (val === undefined || isNaN(val)) return;

      const triggerKey = `${station.id}:${key}`;
      const min = metricObj.min;
      const max = metricObj.max;
      const hasViolation = (min !== undefined && val < min) || (max !== undefined && val > max);

      if (hasViolation) {
        if (!this.activeTriggers.has(triggerKey)) {
          const problem = {
            id: `PRB-${Date.now()}-${station.id}-${key}`,
            hostId: station.id,
            hostName: station.name,
            itemKey: key,
            itemLabel: metricObj.label || key,
            value: val,
            unit: metricObj.unit || "",
            min,
            max,
            severity: "HIGH",
            title: `Schwellenwert verletzt: ${metricObj.label || key} = ${val} ${metricObj.unit || ''} (Soll: ${min ?? '-∞'} .. ${max ?? '∞'})`,
            timestamp
          };
          this.activeTriggers.set(triggerKey, problem);
          this.onBroadcastProblem({ type: "problem_opened", problem });
        }
      } else {
        if (this.activeTriggers.has(triggerKey)) {
          const problem = this.activeTriggers.get(triggerKey);
          this.activeTriggers.delete(triggerKey);
          this.onBroadcastProblem({
            type: "problem_resolved",
            problem: {
              ...problem,
              resolvedAt: timestamp,
              durationSec: Math.round((timestamp - problem.timestamp) / 1000)
            }
          });
        }
      }
    };

    checkMetric("v1", station.v1);
    checkMetric("v2", station.v2);
  }
}
