/**
 * MySqlStore - 24-Stunden Zeitreihen- & Zabbix-Archiv für Industrie 4.0 Telemetrie
 * 
 * Beinhaltet:
 * 1. Automatisches Tabellen-Setup (Auto-DDL) für:
 *    - zabbix_hosts (Module/Stationen)
 *    - zabbix_items (Messwert-Definitionen & Schlüssel)
 *    - zabbix_problems (Störungs- & Alarm-Historie)
 *    - telemetry_history_24h (Zentraler 24h-Messwertspeicher)
 *    - telemetry_<station_id> (Dedizierte Tabellen pro Modul)
 * 2. Asynchrone Messwert-Persistenz & automatische 24h-Retention (Housekeeping)
 * 3. 24h-Aggregationen (Min, Max, Avg, Stunden-Buckets) für 1h/6h/24h-Trends
 * 4. Resiliente Fallback-Logik (kein App-Crash, wenn MySQL nicht erreichbar ist)
 */

import mysql from "mysql2/promise";

export class MySqlStore {
  /**
   * @param {Object} [options]
   */
  constructor(options = {}) {
    this.host = options.host || process.env.MYSQL_HOST || "localhost";
    this.port = parseInt(options.port || process.env.MYSQL_PORT || 3306, 10);
    this.user = options.user || process.env.MYSQL_USER || "cps_user";
    this.password = options.password || process.env.MYSQL_PASSWORD || "cps_pass_2026";
    this.database = options.database || process.env.MYSQL_DATABASE || "cps_telemetry";
    this.retentionHours = parseInt(options.retentionHours || 24, 10);

    this.pool = null;
    this.isConnected = false;
    this.isInitializing = false;
    this.knownStationTables = new Set();
    this.lastError = null;
    this.lastPrunedAt = null;
    this.pruneTimer = null;

    // In-Memory Fallback-Puffer für die letzten 24h, falls MySQL offline ist
    this.fallbackSeries24h = new Map();
  }

  /**
   * Initialisiert den Verbindungspool und führt Auto-DDL aus
   */
  async init() {
    if (this.isInitializing) return;
    this.isInitializing = true;

    try {
      // 1. Zuerst Verbindung ohne DB-Auswahl aufbauen, um DB bei Bedarf zu erzeugen
      const rootConn = await mysql.createConnection({
        host: this.host,
        port: this.port,
        user: this.user,
        password: this.password,
        connectTimeout: 4000
      });

      await rootConn.query(`CREATE DATABASE IF NOT EXISTS \`${this.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
      await rootConn.end();

      // 2. Pool zur Zieldatenbank erstellen
      this.pool = mysql.createPool({
        host: this.host,
        port: this.port,
        user: this.user,
        password: this.password,
        database: this.database,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        connectTimeout: 4000
      });

      await this.runAutoDdl();
      this.isConnected = true;
      this.lastError = null;
      console.info(`[MySqlStore] ✓ Verbindung zu MySQL '${this.host}:${this.port}/${this.database}' hergestellt (Auto-DDL aktiv).`);

      // 3. Housekeeping-Intervall für 24h-Retention (alle 10 Minuten)
      if (!this.pruneTimer) {
        this.pruneTimer = setInterval(() => {
          this.pruneOldData(this.retentionHours).catch(() => {});
        }, 10 * 60 * 1000);
      }
    } catch (err) {
      this.isConnected = false;
      this.lastError = err.message;
      console.warn(`[MySqlStore] MySQL nicht erreichbar (${err.message}). Verwende integrierten 24h In-Memory Fallback.`);
    } finally {
      this.isInitializing = false;
    }
  }

  /**
   * Erstellt alle erforderlichen Tabellen vollautomatisch
   */
  async runAutoDdl() {
    if (!this.pool) return;

    // 1. Zabbix Hosts (Stationen & Fertigungsmodule)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS zabbix_hosts (
        host_id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(128) NOT NULL,
        description TEXT,
        host_group VARCHAR(64) DEFAULT 'CPS-Candy-Line',
        plc_ip VARCHAR(64),
        mqtt_topic VARCHAR(128),
        ws_node_id VARCHAR(128),
        status VARCHAR(32) DEFAULT 'MONITORED',
        is_active TINYINT(1) DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 2. Zabbix Items (Messwert-Definitionen & Sensorschlüssel)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS zabbix_items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        host_id VARCHAR(64) NOT NULL,
        item_key VARCHAR(64) NOT NULL,
        name VARCHAR(128) NOT NULL,
        unit VARCHAR(32) DEFAULT '',
        min_val DOUBLE NULL,
        max_val DOUBLE NULL,
        severity VARCHAR(32) DEFAULT 'WARNING',
        value_type VARCHAR(32) DEFAULT 'FLOAT',
        last_value DOUBLE NULL,
        last_clock TIMESTAMP NULL,
        UNIQUE KEY uk_host_item (host_id, item_key),
        INDEX idx_host_items (host_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 3. Zabbix Problems / Triggers (Störungs- & Alarmprotokoll)
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS zabbix_problems (
        problem_id VARCHAR(64) PRIMARY KEY,
        host_id VARCHAR(64) NOT NULL,
        item_key VARCHAR(64),
        severity VARCHAR(32) DEFAULT 'HIGH',
        title VARCHAR(255) NOT NULL,
        status VARCHAR(32) DEFAULT 'PROBLEM',
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        resolved_at TIMESTAMP NULL,
        duration_sec INT DEFAULT 0,
        operator VARCHAR(64) DEFAULT 'SCADA-Automatik',
        notes TEXT,
        INDEX idx_problem_status (status),
        INDEX idx_problem_host (host_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);

    // 4. Zentraler 24h-Messwertspeicher
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS telemetry_history_24h (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        station_id VARCHAR(64) NOT NULL,
        v1 DOUBLE DEFAULT 0,
        v2 DOUBLE DEFAULT 0,
        v3 DOUBLE DEFAULT 0,
        is_fault TINYINT(1) DEFAULT 0,
        raw_json JSON NULL,
        recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_station_time (station_id, recorded_at),
        INDEX idx_recorded_at (recorded_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
  }

  /**
   * Legt bei Bedarf dynamisch eine eigene Tabelle für ein neues Modul an
   * z.B. telemetry_st_010, telemetry_st_powerhouse
   */
  async ensureStationTable(stationId) {
    if (!stationId) return null;
    const cleanId = String(stationId).toLowerCase().replace(/[^a-z0-9_]/g, "_");
    const tableName = `telemetry_${cleanId}`;

    if (this.knownStationTables.has(tableName)) {
      return tableName;
    }

    if (this.pool && this.isConnected) {
      try {
        await this.pool.query(`
          CREATE TABLE IF NOT EXISTS \`${tableName}\` (
            id BIGINT AUTO_INCREMENT PRIMARY KEY,
            v1 DOUBLE DEFAULT 0,
            v2 DOUBLE DEFAULT 0,
            v3 DOUBLE DEFAULT 0,
            is_fault TINYINT(1) DEFAULT 0,
            recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_rec_at (recorded_at)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);
        this.knownStationTables.add(tableName);
        return tableName;
      } catch (err) {
        console.warn(`[MySqlStore] Konnte Tabelle '${tableName}' nicht anlegen:`, err.message);
      }
    }
    return null;
  }

  /**
   * Schreibt einen Messwert-Datensatz in die MySQL-Datenbank
   */
  async recordSample(stationId, sample, timestamp = Date.now()) {
    const v1 = typeof sample.v1 === "number" ? sample.v1 : sample.v1?.val ?? 0;
    const v2 = typeof sample.v2 === "number" ? sample.v2 : sample.v2?.val ?? 0;
    const v3 = typeof sample.v3 === "number" ? sample.v3 : sample.v3?.val ?? 0;
    const isFault = sample.isFault ? 1 : 0;
    const recDate = new Date(timestamp);

    // In-Memory Fallback immer mitführen (für Resilienz bei kurzzeitigen DB-Lags)
    if (!this.fallbackSeries24h.has(stationId)) {
      this.fallbackSeries24h.set(stationId, []);
    }
    const memList = this.fallbackSeries24h.get(stationId);
    memList.push({ timestamp, v1, v2, v3, isFault: Boolean(isFault) });
    const cutoff24h = timestamp - (this.retentionHours * 3600 * 1000);
    while (memList.length > 0 && memList[0].timestamp < cutoff24h) {
      memList.shift();
    }

    // Wenn MySQL nicht verbunden ist, abbrechen
    if (!this.pool || !this.isConnected) {
      return { inMemory: true, timestamp, v1, v2, v3 };
    }

    try {
      // 1. In zentrale 24h-Tabelle schreiben
      await this.pool.query(`
        INSERT INTO telemetry_history_24h (station_id, v1, v2, v3, is_fault, raw_json, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        stationId,
        v1,
        v2,
        v3,
        isFault,
        JSON.stringify(sample),
        recDate
      ]);

      // 2. In stations-spezifische Tabelle schreiben
      const stationTable = await this.ensureStationTable(stationId);
      if (stationTable) {
        await this.pool.query(`
          INSERT INTO \`${stationTable}\` (v1, v2, v3, is_fault, recorded_at)
          VALUES (?, ?, ?, ?, ?)
        `, [v1, v2, v3, isFault, recDate]);
      }

      // 3. Zabbix Item-Werte aktualisieren
      await this.pool.query(`
        UPDATE zabbix_items 
        SET last_value = ?, last_clock = ? 
        WHERE host_id = ? AND item_key = 'v1'
      `, [v1, recDate, stationId]).catch(() => {});

      await this.pool.query(`
        UPDATE zabbix_items 
        SET last_value = ?, last_clock = ? 
        WHERE host_id = ? AND item_key = 'v2'
      `, [v2, recDate, stationId]).catch(() => {});

      return { success: true, stationId, timestamp };
    } catch (err) {
      console.warn(`[MySqlStore] Fehler beim Schreiben von Telemetrie für '${stationId}':`, err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Synchronisiert Zabbix Hosts & Items anhand der aktuellen Stationskonfiguration
   */
  async syncHostsAndItems(stations = []) {
    if (!this.pool || !this.isConnected || !Array.isArray(stations)) return;

    for (const st of stations) {
      try {
        // Host anlegen oder aktualisieren
        await this.pool.query(`
          INSERT INTO zabbix_hosts (host_id, name, description, plc_ip, mqtt_topic, ws_node_id, status)
          VALUES (?, ?, ?, ?, ?, ?, 'MONITORED')
          ON DUPLICATE KEY UPDATE 
            name = VALUES(name),
            description = VALUES(description),
            plc_ip = VALUES(plc_ip),
            mqtt_topic = VALUES(mqtt_topic),
            ws_node_id = VALUES(ws_node_id);
        `, [
          st.id,
          st.name || st.id,
          st.description || "",
          st.plcIp || "",
          st.mqttTopic || "",
          st.wsNodeId || ""
        ]);

        // Items anlegen / aktualisieren (v1, v2, v3)
        const items = [
          { key: "v1", obj: st.v1, defaultSeverity: "WARNING" },
          { key: "v2", obj: st.v2, defaultSeverity: "AVERAGE" },
          { key: "v3", obj: st.v3, defaultSeverity: "INFORMATION" }
        ];

        for (const item of items) {
          if (item.obj) {
            await this.pool.query(`
              INSERT INTO zabbix_items (host_id, item_key, name, unit, min_val, max_val, severity)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON DUPLICATE KEY UPDATE 
                name = VALUES(name),
                unit = VALUES(unit),
                min_val = VALUES(min_val),
                max_val = VALUES(max_val);
            `, [
              st.id,
              item.key,
              item.obj.label || item.key,
              item.obj.unit || "",
              item.obj.min !== undefined ? item.obj.min : null,
              item.obj.max !== undefined ? item.obj.max : null,
              item.defaultSeverity
            ]);
          }
        }

        await this.ensureStationTable(st.id);
      } catch (err) {
        console.warn(`[MySqlStore] Fehler beim Sync von Host '${st.id}':`, err.message);
      }
    }
  }

  /**
   * Fragt Zeitreihen der letzten X Stunden ab
   */
  async getHistory(stationId, hours = 24) {
    const hoursNum = Math.min(168, Math.max(1, parseInt(hours, 10) || 24));

    if (this.pool && this.isConnected) {
      try {
        let query = `
          SELECT station_id, v1, v2, v3, is_fault, UNIX_TIMESTAMP(recorded_at) * 1000 AS timestamp
          FROM telemetry_history_24h
          WHERE recorded_at >= NOW() - INTERVAL ? HOUR
        `;
        const params = [hoursNum];

        if (stationId && stationId !== "all") {
          query += " AND station_id = ?";
          params.push(stationId);
        }

        query += " ORDER BY recorded_at ASC LIMIT 5000";
        const [rows] = await this.pool.query(query, params);
        return rows.map(r => ({
          stationId: r.station_id,
          v1: r.v1,
          v2: r.v2,
          v3: r.v3,
          isFault: Boolean(r.is_fault),
          timestamp: r.timestamp
        }));
      } catch (err) {
        console.warn("[MySqlStore] getHistory fehlgeschlagen, nutze Fallback:", err.message);
      }
    }

    // Fallback aus Memory
    const cutoff = Date.now() - (hoursNum * 3600 * 1000);
    if (stationId && stationId !== "all") {
      const list = this.fallbackSeries24h.get(stationId) || [];
      return list.filter(item => item.timestamp >= cutoff);
    }

    const all = [];
    for (const [sId, list] of this.fallbackSeries24h.entries()) {
      list.filter(item => item.timestamp >= cutoff).forEach(item => {
        all.push({ ...item, stationId: sId });
      });
    }
    all.sort((a, b) => a.timestamp - b.timestamp);
    return all;
  }

  /**
   * Liefert statistische Aggregationen über 1h, 6h oder 24h
   */
  async getAggregates(stationId, hours = 24) {
    const history = await this.getHistory(stationId, hours);
    if (history.length === 0) {
      return {
        stationId,
        hours,
        count: 0,
        v1: { min: 0, max: 0, avg: 0, current: 0 },
        v2: { min: 0, max: 0, avg: 0, current: 0 },
        v3: { min: 0, max: 0, avg: 0, current: 0 },
        faultCount: 0,
        faultRatePercent: 0,
        buckets: []
      };
    }

    const calcMetric = (key) => {
      const vals = history.map(h => h[key]).filter(v => typeof v === "number" && !isNaN(v));
      if (vals.length === 0) return { min: 0, max: 0, avg: 0, current: 0 };
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      const sum = vals.reduce((a, b) => a + b, 0);
      const avg = +(sum / vals.length).toFixed(2);
      const current = vals[vals.length - 1];
      return { min, max, avg, current };
    };

    const faultCount = history.filter(h => h.isFault).length;
    const faultRatePercent = +((faultCount / history.length) * 100).toFixed(1);

    // Bis zu 24 Stunden-Buckets für Trendkurven
    const bucketCount = Math.min(24, Math.max(6, parseInt(hours, 10) || 24));
    const now = Date.now();
    const spanMs = (parseInt(hours, 10) || 24) * 3600 * 1000;
    const bucketSize = spanMs / bucketCount;

    const buckets = [];
    for (let b = 0; b < bucketCount; b++) {
      const start = now - spanMs + (b * bucketSize);
      const end = start + bucketSize;
      const bucketItems = history.filter(h => h.timestamp >= start && h.timestamp < end);
      if (bucketItems.length > 0) {
        const v1Avg = bucketItems.reduce((acc, cur) => acc + cur.v1, 0) / bucketItems.length;
        const v2Avg = bucketItems.reduce((acc, cur) => acc + cur.v2, 0) / bucketItems.length;
        buckets.push({
          timestamp: Math.round(start + (bucketSize / 2)),
          count: bucketItems.length,
          v1: +v1Avg.toFixed(2),
          v2: +v2Avg.toFixed(2),
          hasFault: bucketItems.some(i => i.isFault)
        });
      }
    }

    return {
      stationId,
      hours,
      count: history.length,
      v1: calcMetric("v1"),
      v2: calcMetric("v2"),
      v3: calcMetric("v3"),
      faultCount,
      faultRatePercent,
      buckets
    };
  }

  /**
   * Löscht Datensätze, die älter als retentionHours sind (Housekeeping)
   */
  async pruneOldData(retentionHours = this.retentionHours) {
    if (!this.pool || !this.isConnected) return 0;
    try {
      const [res] = await this.pool.query(`
        DELETE FROM telemetry_history_24h 
        WHERE recorded_at < NOW() - INTERVAL ? HOUR
      `, [retentionHours]);

      for (const tName of this.knownStationTables) {
        await this.pool.query(`
          DELETE FROM \`${tName}\` 
          WHERE recorded_at < NOW() - INTERVAL ? HOUR
        `, [retentionHours]).catch(() => {});
      }

      this.lastPrunedAt = Date.now();
      return res.affectedRows || 0;
    } catch (err) {
      console.warn("[MySqlStore] Prune fehlgeschlagen:", err.message);
      return 0;
    }
  }

  /**
   * Testet eine Verbindung mit den übergebenen Parametern
   */
  static async testConnection(cfg = {}) {
    const host = cfg.host || "localhost";
    const port = parseInt(cfg.port || 3306, 10);
    const user = cfg.user || "cps_user";
    const password = cfg.password || "cps_pass_2026";
    const database = cfg.database || "cps_telemetry";

    try {
      const conn = await mysql.createConnection({
        host,
        port,
        user,
        password,
        database,
        connectTimeout: 3500
      });
      const [tables] = await conn.query("SHOW TABLES;");
      const [res] = await conn.query("SELECT COUNT(*) AS total FROM telemetry_history_24h;").catch(() => [[{ total: 0 }]]);
      await conn.end();

      return {
        success: true,
        host,
        port,
        database,
        tablesCount: Array.isArray(tables) ? tables.length : 0,
        totalSamples: res[0]?.total || 0,
        message: `✓ Verbindung zu MySQL '${host}:${port}/${database}' erfolgreich.`
      };
    } catch (err) {
      return {
        success: false,
        host,
        port,
        database,
        message: `Verbindungsfehler: ${err.message}`
      };
    }
  }

  /**
   * Liefert den aktuellen Status der MySQL-Speicherschicht
   */
  async getStatus() {
    let totalSamples = 0;
    let tablesCount = 0;

    if (this.pool && this.isConnected) {
      try {
        const [rows] = await this.pool.query("SELECT COUNT(*) AS cnt FROM telemetry_history_24h;");
        totalSamples = rows[0]?.cnt || 0;
        const [tbls] = await this.pool.query("SHOW TABLES;");
        tablesCount = tbls.length;
      } catch (_) {}
    } else {
      for (const list of this.fallbackSeries24h.values()) {
        totalSamples += list.length;
      }
    }

    return {
      connected: this.isConnected,
      host: this.host,
      port: this.port,
      database: this.database,
      retentionHours: this.retentionHours,
      totalSamples24h: totalSamples,
      tablesCount,
      lastPrunedAt: this.lastPrunedAt,
      lastError: this.lastError
    };
  }

  async close() {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    if (this.pool) {
      await this.pool.end().catch(() => {});
      this.isConnected = false;
    }
  }
}
