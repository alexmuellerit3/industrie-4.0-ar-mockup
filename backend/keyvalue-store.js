/**
 * KeyValueStore - 5-Minuten Zeitreihen In-Memory Store für Industrie 4.0 Telemetrie
 * 
 * Speichert Messwerte für alle Stationen der CPS-i40 Anlage mit einem strikten
 * 5-Minuten-Zeitfenster (TTL = 300.000 ms). Berechnet Aggregationen (Min, Max, Avg, Trend).
 */

export class KeyValueStore {
  /**
   * @param {number} ttlMs - Zeitfenster in Millisekunden (Standard: 300.000 ms = 5 Minuten)
   */
  constructor(ttlMs = 5 * 60 * 1000) {
    this.ttlMs = ttlMs;
    // Map: stationId -> Array<{ timestamp: number, v1: number, v2: number, v3: number, isFault: boolean, raw?: any }>
    this.series = new Map();
    // Generischer Key-Value Speicher für Metadaten & Anlagen-Zustand
    this.meta = new Map();
    // Permanente Historische Störungs- & Ausfall-Datenbank (wird NICHT durch TTL 300s verworfen)
    this.incidents = this.initDefaultIncidents();
  }

  /**
   * Fügt einen neuen Messwert-Datensatz für eine Station hinzu
   * @param {string} stationId - z. B. 'ST-010', 'ST-020'
   * @param {Object} sample - Messwerte { v1, v2, v3, isFault, status }
   * @param {number} [timestamp] - Unix-Zeitstempel in ms (Standard: Date.now())
   */
  push(stationId, sample, timestamp = Date.now()) {
    if (!this.series.has(stationId)) {
      this.series.set(stationId, []);
    }

    const isLiveSample = Boolean(sample.isLive || (!sample.isDemo && !sample.simulated));
    let list = this.series.get(stationId);

    // Wenn echte Live-Telemetriedaten eintreffen, ersetze eventuell vorherige Demo-/Mock-Einträge
    if (isLiveSample) {
      const filtered = list.filter(item => !item.isDemo && !item.simulated);
      if (filtered.length !== list.length) {
        list = filtered;
        this.series.set(stationId, list);
      }
    }

    const entry = {
      timestamp,
      v1: typeof sample.v1 === 'number' ? sample.v1 : sample.v1?.val ?? 0,
      v2: typeof sample.v2 === 'number' ? sample.v2 : sample.v2?.val ?? 0,
      v3: typeof sample.v3 === 'number' ? sample.v3 : sample.v3?.val ?? 0,
      isFault: Boolean(sample.isFault),
      status: sample.status || (sample.isFault ? 'FAULT' : 'NORMAL'),
      isLive: isLiveSample,
      isDemo: Boolean(sample.isDemo || sample.simulated),
      simulated: Boolean(sample.simulated)
    };

    list.push(entry);
    this.pruneStation(stationId, timestamp);
    return entry;
  }

  /**
   * Löscht alle vorbefüllten Demo- bzw. Simulationsdaten
   * @param {string} [stationId] - Optional: Nur für eine bestimmte Station
   */
  clearDemoData(stationId) {
    if (stationId) {
      const list = this.series.get(stationId);
      if (list) {
        this.series.set(stationId, list.filter(item => !item.isDemo && !item.simulated));
      }
    } else {
      for (const [sId, list] of this.series.entries()) {
        this.series.set(sId, list.filter(item => !item.isDemo && !item.simulated));
      }
    }
  }

  /**
   * Löscht alle Demo- und Simulationsdaten über alle Stationen hinweg
   */
  clearAllDemoData() {
    this.clearDemoData();
  }

  /**
   * Prüft, ob für eine Station bereits echte Live-Telemetriedaten empfangen wurden
   * @param {string} stationId
   * @returns {boolean}
   */
  hasLiveTelemetry(stationId) {
    const list = this.series.get(stationId);
    return list ? list.some(item => item.isLive && !item.isDemo && !item.simulated) : false;
  }

  /**
   * Gibt den detaillierten Telemetrie- und Datenzustand einer Station zurück
   * @param {string} stationId
   */
  getStationState(stationId) {
    const list = this.series.get(stationId) || [];
    const liveItems = list.filter(item => item.isLive && !item.isDemo && !item.simulated);
    const demoItems = list.filter(item => item.isDemo || item.simulated);
    const lastSample = list.length > 0 ? list[list.length - 1] : null;
    return {
      stationId,
      hasLive: liveItems.length > 0,
      hasDemo: demoItems.length > 0,
      liveCount: liveItems.length,
      demoCount: demoItems.length,
      totalCount: list.length,
      lastSample,
      lastTimestamp: lastSample ? lastSample.timestamp : null
    };
  }

  /**
   * Löscht alle Datenpunkte für eine bestimmte Station
   * @param {string} stationId
   */
  clearStation(stationId) {
    this.series.delete(stationId);
  }

  /**
   * Prüft, ob noch Demo-Daten im Speicher vorhanden sind
   * @param {string} [stationId]
   * @returns {boolean}
   */
  hasDemoData(stationId) {
    if (stationId) {
      const list = this.series.get(stationId);
      return list ? list.some(item => item.isDemo || item.simulated) : false;
    }
    for (const list of this.series.values()) {
      if (list.some(item => item.isDemo || item.simulated)) return true;
    }
    return false;
  }

  /**
   * Setzt einen generischen Metadaten-Schlüssel
   */
  setMeta(key, value) {
    this.meta.set(key, { value, updatedAt: Date.now() });
  }

  getMeta(key) {
    const item = this.meta.get(key);
    return item ? item.value : null;
  }

  /**
   * Entfernt veraltete Datenpunkte außerhalb des 5-Minuten-Zeitfensters
   */
  pruneStation(stationId, now = Date.now()) {
    const list = this.series.get(stationId);
    if (!list) return;

    const cutoff = now - this.ttlMs;
    // Da Zeitstempel monoton steigen, können alte Einträge von vorne abgeschnitten werden
    while (list.length > 0 && list[0].timestamp < cutoff) {
      list.shift();
    }
  }

  /**
   * Entfernt veraltete Einträge in allen Stationen
   */
  pruneAll(now = Date.now()) {
    for (const stationId of this.series.keys()) {
      this.pruneStation(stationId, now);
    }
  }

  /**
   * Gibt alle Datenpunkte der letzten 5 Minuten für eine Station zurück
   * @param {string} stationId
   * @param {number} [windowMs]
   * @param {number} [now]
   */
  getHistory(stationId, windowMs = this.ttlMs, now = Date.now()) {
    const list = this.series.get(stationId) || [];
    const cutoff = now - windowMs;
    return list.filter(entry => entry.timestamp >= cutoff);
  }

  /**
   * Gibt die Historie aller Stationen gebündelt zurück
   */
  getAllHistory(windowMs = this.ttlMs, now = Date.now()) {
    const result = {};
    for (const stationId of this.series.keys()) {
      result[stationId] = this.getHistory(stationId, windowMs, now);
    }
    return result;
  }

  /**
   * Berechnet eine statistische 5-Minuten-Auswertung (Min, Max, Avg, Trend)
   * @param {string} stationId
   */
  getSummary(stationId, windowMs = this.ttlMs, now = Date.now()) {
    const history = this.getHistory(stationId, windowMs, now);
    if (history.length === 0) {
      return {
        stationId,
        count: 0,
        windowSeconds: Math.round(windowMs / 1000),
        v1: { min: 0, max: 0, avg: 0, current: 0, trend: 'stable' },
        v2: { min: 0, max: 0, avg: 0, current: 0, trend: 'stable' },
        v3: { min: 0, max: 0, avg: 0, current: 0, trend: 'stable' },
        faultCount: 0,
        faultRatePercent: 0
      };
    }

    const calcMetric = (key) => {
      const values = history.map(h => h[key]).filter(v => typeof v === 'number');
      if (values.length === 0) return { min: 0, max: 0, avg: 0, current: 0, trend: 'stable' };

      const min = Math.min(...values);
      const max = Math.max(...values);
      const sum = values.reduce((a, b) => a + b, 0);
      const avg = +(sum / values.length).toFixed(2);
      const current = values[values.length - 1];

      // Trendberechnung: Vergleich des ersten Viertels mit dem letzten Viertel
      let trend = 'stable';
      if (values.length >= 4) {
        const qSize = Math.max(1, Math.floor(values.length / 4));
        const firstAvg = values.slice(0, qSize).reduce((a, b) => a + b, 0) / qSize;
        const lastAvg = values.slice(-qSize).reduce((a, b) => a + b, 0) / qSize;
        const diff = lastAvg - firstAvg;
        if (diff > 0.05) trend = 'up';
        else if (diff < -0.05) trend = 'down';
      }

      return { min, max, avg, current, trend };
    };

    const faultCount = history.filter(h => h.isFault).length;
    const faultRatePercent = +((faultCount / history.length) * 100).toFixed(1);

    return {
      stationId,
      count: history.length,
      windowSeconds: Math.round(windowMs / 1000),
      oldestTimestamp: history[0].timestamp,
      newestTimestamp: history[history.length - 1].timestamp,
      v1: calcMetric('v1'),
      v2: calcMetric('v2'),
      v3: calcMetric('v3'),
      faultCount,
      faultRatePercent
    };
  }

  /**
   * Aggregierte Zusammenfassung für alle Stationen
   */
  getAllSummaries(windowMs = this.ttlMs, now = Date.now()) {
    const result = {};
    for (const stationId of this.series.keys()) {
      result[stationId] = this.getSummary(stationId, windowMs, now);
    }
    return result;
  }

  /**
   * System-Statistiken über den KeyValue-Store
   */
  getStats() {
    let totalSamples = 0;
    for (const list of this.series.values()) {
      totalSamples += list.length;
    }
    return {
      ttlMinutes: Math.round(this.ttlMs / 60000),
      stationsCount: this.series.size,
      totalSamples,
      metaKeysCount: this.meta.size,
      memoryEstimateBytes: totalSamples * 80
    };
  }

  clear() {
    this.series.clear();
    this.meta.clear();
  }

  /* ========================================================================
     PERMANENTE HISTORISCHE STÖRUNGS- & AUSFALL-DATENBANK (INCIDENT LEDGER)
     ======================================================================== */
  initDefaultIncidents() {
    const now = Date.now();
    return [
      {
        id: "INC-20261102-001",
        stationId: "ST-010",
        title: "Vakuumgreifer Unterdruck-Abfall (< -0.4 bar)",
        severity: "KRITISCH",
        status: "RESOLVED",
        timestamp: now - 24 * 3600 * 1000,
        resolvedAt: now - 24 * 3600 * 1000 + 14 * 60 * 1000,
        durationSeconds: 840,
        operator: "Instandhaltung (M. Weber)",
        notes: "Vakuumschlauch nachgezogen & Sensor kalibriert."
      },
      {
        id: "INC-20261103-001",
        stationId: "ST-030",
        title: "Deckel-Verschraubung Drehmoment-Schlupf (> 4.8 Nm)",
        severity: "WARNUNG",
        status: "RESOLVED",
        timestamp: now - 4 * 3600 * 1000,
        resolvedAt: now - 4 * 3600 * 1000 + 8 * 60 * 1000,
        durationSeconds: 480,
        operator: "Bediener A. Müller",
        notes: "Führungsschiene gereinigt und nachjustiert."
      },
      {
        id: "INC-20261103-002",
        stationId: "ST-POWERHOUSE",
        title: "Druckluftabfall Hauptversorgungsleitung (< 5.0 bar)",
        severity: "KRITISCH",
        status: "RESOLVED",
        timestamp: now - 2 * 3600 * 1000,
        resolvedAt: now - 2 * 3600 * 1000 + 22 * 60 * 1000,
        durationSeconds: 1320,
        operator: "Haustechnik",
        notes: "Kompressor Stufe 2 zugeschaltet."
      }
    ];
  }

  /**
   * Erfasst eine neue Störung
   * @param {Object} data - { stationId, title, severity, operator, notes, timestamp }
   */
  addIncident(data) {
    const now = Date.now();
    const id = data.id || `INC-${new Date(now).toISOString().slice(0, 10).replace(/-/g, "")}-${String(this.incidents.length + 1).padStart(3, "0")}`;
    const incident = {
      id,
      stationId: data.stationId || "ST-ALL",
      title: data.title || "Unbekannte Prozessabweichung / Störung",
      severity: data.severity || "KRITISCH",
      status: data.status || "OPEN",
      timestamp: data.timestamp || now,
      resolvedAt: data.resolvedAt || null,
      durationSeconds: data.durationSeconds || (data.status === "RESOLVED" && data.resolvedAt ? Math.round((data.resolvedAt - (data.timestamp || now)) / 1000) : 0),
      operator: data.operator || "SCADA-Automatik",
      notes: data.notes || ""
    };

    this.incidents.unshift(incident);
    return incident;
  }

  /**
   * Quittiert / behebt eine Störung per ID
   */
  resolveIncident(id, resolvedAt = Date.now(), operator = "System", notes = "") {
    const inc = this.incidents.find(i => i.id === id);
    if (!inc) return null;

    inc.status = "RESOLVED";
    inc.resolvedAt = resolvedAt;
    inc.durationSeconds = Math.max(1, Math.round((resolvedAt - inc.timestamp) / 1000));
    if (operator && operator !== "System") inc.operator = operator;
    if (notes) inc.notes = notes;
    return inc;
  }

  /**
   * Behebt die aktuellste offene Störung einer Station
   */
  resolveActiveIncidentForStation(stationId, resolvedAt = Date.now(), operator = "Instandhaltung") {
    const inc = this.incidents.find(i => i.stationId === stationId && i.status === "OPEN");
    if (inc) {
      return this.resolveIncident(inc.id, resolvedAt, operator);
    }
    return null;
  }

  /**
   * Ruft Störungen ab (optional gefiltert)
   */
  getIncidents(filter = {}) {
    let list = [...this.incidents];
    if (filter.stationId && filter.stationId !== "all") {
      list = list.filter(i => i.stationId === filter.stationId);
    }
    if (filter.status && filter.status !== "all") {
      list = list.filter(i => i.status === filter.status);
    }
    if (filter.severity && filter.severity !== "all") {
      list = list.filter(i => i.severity === filter.severity);
    }
    return list;
  }

  /**
   * Berechnet Kennzahlen (KPIs) über alle Störungen
   */
  getIncidentKpis(now = Date.now()) {
    const total = this.incidents.length;
    const activeList = this.incidents.filter(i => i.status === "OPEN");
    const active = activeList.length;
    const resolvedList = this.incidents.filter(i => i.status === "RESOLVED");

    let totalDowntimeSec = 0;
    this.incidents.forEach(i => {
      if (i.status === "RESOLVED") {
        totalDowntimeSec += (i.durationSeconds || 0);
      } else {
        totalDowntimeSec += Math.max(0, Math.round((now - i.timestamp) / 1000));
      }
    });

    const resolvedSec = resolvedList.reduce((sum, i) => sum + (i.durationSeconds || 0), 0);
    const mttrMinutes = resolvedList.length > 0 ? +(resolvedSec / resolvedList.length / 60).toFixed(1) : 0;
    const cumulativeDowntimeMinutes = +(totalDowntimeSec / 60).toFixed(1);

    return {
      total,
      active,
      resolved: resolvedList.length,
      cumulativeDowntimeSeconds: totalDowntimeSec,
      cumulativeDowntimeMinutes,
      mttrMinutes
    };
  }

  clearIncidents() {
    this.incidents = [];
  }
}
