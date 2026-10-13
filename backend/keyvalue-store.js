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

    const list = this.series.get(stationId);
    const entry = {
      timestamp,
      v1: typeof sample.v1 === 'number' ? sample.v1 : sample.v1?.val ?? 0,
      v2: typeof sample.v2 === 'number' ? sample.v2 : sample.v2?.val ?? 0,
      v3: typeof sample.v3 === 'number' ? sample.v3 : sample.v3?.val ?? 0,
      isFault: Boolean(sample.isFault),
      status: sample.status || (sample.isFault ? 'FAULT' : 'NORMAL')
    };

    list.push(entry);
    this.pruneStation(stationId, timestamp);
    return entry;
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
}
