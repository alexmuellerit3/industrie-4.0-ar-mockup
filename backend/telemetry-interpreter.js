/**
 * TelemetryInterpreter - Intelligente Analyse, Endpunkt-Erkennung & Semantische Interpretation beliebiger JSON-Pakete
 * 
 * Beinhaltet:
 * 1. Rekursive Endpunkt-Extraktion (Auslesen aller Datenpfade in ankommenden JSON-Objekten)
 * 2. Automatische Erkennung der Zielstation (ST-010 bis ST-040)
 * 3. Semantisches Mapping von Messwerten auf Einheiten und Grenzwerte
 * 4. Toleranzprüfung & Bewertung (OPTIMAL, NORMAL, WARNUNG, KRITISCH / STÖRUNG)
 * 5. Generierung von menschlich verständlichen Klartext-Interpretationen in natürlicher deutscher Sprache
 * 6. Globales Register aller im laufenden Betrieb erkannten Daten-Endpoints
 */

import { DEFAULT_STATIONS_CONFIG } from "./config-manager.js";

export class TelemetryInterpreter {
  /**
   * @param {Object} [options]
   * @param {Array} [options.stations] - Stationsdefinitionen mit Toleranzen
   */
  constructor(options = {}) {
    this.stations = options.stations || DEFAULT_STATIONS_CONFIG;
    // Registry aller bisher empfangenen Daten-Endpoints
    // endpointPath -> { firstSeen: number, lastSeen: number, lastValue: any, sampleType: string, stationId?: string }
    this.knownEndpoints = new Map();
  }

  /**
   * Aktualisiert die Stationskonfiguration
   */
  updateStations(stations) {
    if (Array.isArray(stations)) {
      this.stations = stations;
    }
  }

  /**
   * Extrahiert rekursiv alle Daten-Endpoints aus einem beliebigen JSON-Objekt
   * @param {any} obj - Beliebiges JSON-Objekt
   * @param {string} [prefix] - Aktueller Pfad-Präfix
   * @returns {Array<{ path: string, value: any, type: string }>}
   */
  extractEndpoints(obj, prefix = "") {
    const results = [];
    if (obj === null || obj === undefined) return results;

    if (Array.isArray(obj)) {
      // Prüfe auf Tag-Listen wie [{ name: "temp", value: 24.5 }, ...]
      const isTagArray = obj.every(item => item && typeof item === "object" && ("name" in item || "key" in item) && "value" in item);
      if (isTagArray) {
        for (const item of obj) {
          const keyName = item.name || item.key;
          const subPath = prefix ? `${prefix}.${keyName}` : keyName;
          results.push({
            path: subPath,
            value: item.value,
            unit: item.unit,
            type: typeof item.value
          });
        }
        return results;
      }

      obj.forEach((val, idx) => {
        const subPath = prefix ? `${prefix}[${idx}]` : `[${idx}]`;
        if (typeof val === "object" && val !== null) {
          results.push(...this.extractEndpoints(val, subPath));
        } else {
          results.push({ path: subPath, value: val, type: typeof val });
        }
      });
      return results;
    }

    if (typeof obj === "object") {
      for (const [key, val] of Object.entries(obj)) {
        const subPath = prefix ? `${prefix}.${key}` : key;
        if (typeof val === "object" && val !== null && !Array.isArray(val)) {
          results.push(...this.extractEndpoints(val, subPath));
        } else if (Array.isArray(val)) {
          results.push(...this.extractEndpoints(val, subPath));
        } else {
          results.push({ path: subPath, value: val, type: typeof val });
        }
      }
      return results;
    }

    results.push({ path: prefix || "root", value: obj, type: typeof obj });
    return results;
  }

  /**
   * Ermittelt automatisch die Stations-ID aus dem ankommenden Paket
   */
  detectStationId(payload, endpoints) {
    if (!payload || typeof payload !== "object") return "ST-010";

    // 1. Direkte Top-Level Felder
    const directCandidates = [
      payload.stationId,
      payload.station_id,
      payload.station,
      payload.id,
      payload.deviceId,
      payload.device_id,
      payload.machineId,
      payload.unit
    ];

    for (const cand of directCandidates) {
      if (cand && typeof cand === "string") {
        const match = this.stations.find(s => s.id.toLowerCase() === cand.toLowerCase() || cand.toUpperCase().includes(s.id));
        if (match) return match.id;
      }
    }

    // 2. Suche in extrahierten Endpunkten
    for (const ep of endpoints) {
      if (typeof ep.value === "string") {
        const valUpper = ep.value.toUpperCase();
        for (const st of this.stations) {
          if (valUpper === st.id || valUpper.includes(st.id)) {
            return st.id;
          }
        }
      }
    }

    // 3. Heuristische Erkennung anhand von Messwert-Namen
    const allPaths = endpoints.map(e => e.path.toLowerCase()).join(" ");
    if (allPaths.includes("fill") || allPaths.includes("gewicht") || allPaths.includes("dosier") || allPaths.includes("throughput")) {
      return "ST-020";
    }
    if (allPaths.includes("verschluss") || allPaths.includes("torque") || allPaths.includes("bördel") || allPaths.includes("press")) {
      return "ST-030";
    }
    if (allPaths.includes("qualit") || allPaths.includes("reject") || allPaths.includes("ausschuss") || allPaths.includes("waage")) {
      return "ST-040";
    }
    if (allPaths.includes("magazin") || allPaths.includes("vakuum") || allPaths.includes("dosen") || allPaths.includes("zuführ")) {
      return "ST-010";
    }

    return "ST-010"; // Fallback auf erste Station
  }

  /**
   * Mappt die extrahierten Endpunkte auf die Kernvariablen (v1, v2, v3) der Station
   */
  mapMetricsToStation(stationConfig, endpoints) {
    const values = {
      v1: null,
      v2: null,
      v3: null,
      isFault: false,
      mappedEndpoints: {}
    };

    // Störungs-Erkennung
    for (const ep of endpoints) {
      const p = ep.path.toLowerCase();
      if (p.includes("fault") || p.includes("error") || p.includes("stoerung") || p.includes("alarm")) {
        if (typeof ep.value === "boolean") values.isFault = ep.value;
        else if (typeof ep.value === "number") values.isFault = ep.value > 0;
        else if (typeof ep.value === "string") values.isFault = /true|fault|error|alarm|1/i.test(ep.value);
      }
    }

    // Direkte Zuordnung, falls im Paket bereits v1, v2, v3 existieren
    const v1Ep = endpoints.find(e => e.path === "v1" || e.path.endsWith(".v1"));
    const v2Ep = endpoints.find(e => e.path === "v2" || e.path.endsWith(".v2"));
    const v3Ep = endpoints.find(e => e.path === "v3" || e.path.endsWith(".v3"));

    if (v1Ep && typeof v1Ep.value === "number") {
      values.v1 = v1Ep.value;
      values.mappedEndpoints.v1 = v1Ep.path;
    }
    if (v2Ep && typeof v2Ep.value === "number") {
      values.v2 = v2Ep.value;
      values.mappedEndpoints.v2 = v2Ep.path;
    }
    if (v3Ep && typeof v3Ep.value === "number") {
      values.v3 = v3Ep.value;
      values.mappedEndpoints.v3 = v3Ep.path;
    }

    // Semantische Zuordnung basierend auf Kennwörtern der Station
    const numericEndpoints = endpoints.filter(e => typeof e.value === "number");

    const assignIfEmpty = (targetVar, configVar, keywords) => {
      if (values[targetVar] !== null) return;
      for (const ep of numericEndpoints) {
        const p = ep.path.toLowerCase();
        const matchesKeyword = keywords.some(kw => p.includes(kw));
        const matchesId = configVar?.id && p.includes(configVar.id.toLowerCase());
        const matchesLabel = configVar?.label && p.includes(configVar.label.toLowerCase());

        if (matchesKeyword || matchesId || matchesLabel) {
          values[targetVar] = ep.value;
          values.mappedEndpoints[targetVar] = ep.path;
          break;
        }
      }
    };

    // Modul-spezifische Schlüsselwörter
    if (stationConfig.id === "ST-010") {
      assignIfEmpty("v1", stationConfig.v1, ["magazin", "level", "füll", "fill", "capacity"]);
      assignIfEmpty("v2", stationConfig.v2, ["vakuum", "vacuum", "bar", "pressure", "druck"]);
      assignIfEmpty("v3", stationConfig.v3, ["zähler", "counter", "count", "parts", "dosen"]);
    } else if (stationConfig.id === "ST-020") {
      assignIfEmpty("v1", stationConfig.v1, ["gewicht", "weight", "gramm", "fill"]);
      assignIfEmpty("v2", stationConfig.v2, ["druck", "pressure", "bar", "press"]);
      assignIfEmpty("v3", stationConfig.v3, ["takt", "throughput", "speed", "rpm", "cpm"]);
    } else if (stationConfig.id === "ST-030") {
      assignIfEmpty("v1", stationConfig.v1, ["anpress", "force", "kraft", "druck", "pressure"]);
      assignIfEmpty("v2", stationConfig.v2, ["drehmoment", "torque", "nm"]);
      assignIfEmpty("v3", stationConfig.v3, ["prüfung", "check", "seal", "ok"]);
    } else if (stationConfig.id === "ST-040") {
      assignIfEmpty("v1", stationConfig.v1, ["kontroll", "weight", "gewicht", "gramm"]);
      assignIfEmpty("v2", stationConfig.v2, ["ausschuss", "reject", "scrap", "rate"]);
      assignIfEmpty("v3", stationConfig.v3, ["oee", "effizienz", "avail"]);
    }

    // Fallbacks falls nicht zuordenbar: erste verfügbare Zahlenwerte oder Standardwerte
    if (values.v1 === null) values.v1 = numericEndpoints[0]?.value ?? stationConfig.v1.defaultVal;
    if (values.v2 === null) values.v2 = numericEndpoints[1]?.value ?? stationConfig.v2.defaultVal;
    if (values.v3 === null) values.v3 = numericEndpoints[2]?.value ?? stationConfig.v3.defaultVal;

    return values;
  }

  /**
   * Bewertet einen Messwert gegen die Solltoleranzen
   */
  evaluateMetric(val, def) {
    if (typeof val !== "number" || !def) {
      return { status: "NORMAL", text: "Keine Grenzwerte definiert" };
    }

    const { min, max, unit = "", label = "Wert", defaultVal } = def;

    if (min !== undefined && max !== undefined) {
      if (val < min) {
        const diff = +(min - val).toFixed(2);
        return {
          status: "KRITISCH",
          level: 2,
          text: `${label} (${val} ${unit}) liegt ${diff} ${unit} UNTER dem Mindestwert (${min} ${unit})!`
        };
      }
      if (val > max) {
        const diff = +(val - max).toFixed(2);
        return {
          status: "KRITISCH",
          level: 2,
          text: `${label} (${val} ${unit}) liegt ${diff} ${unit} ÜBER dem Höchstwert (${max} ${unit})!`
        };
      }

      // Prüfe auf optimale Zentrierung
      const center = (min + max) / 2;
      const span = max - min;
      if (Math.abs(val - center) <= span * 0.25) {
        return {
          status: "OPTIMAL",
          level: 0,
          text: `${label} (${val} ${unit}) im optimalen Idealbereich (Soll: ${min} - ${max} ${unit}).`
        };
      }

      return {
        status: "NORMAL",
        level: 1,
        text: `${label} (${val} ${unit}) innerhalb der Fertigungstoleranz (${min} - ${max} ${unit}).`
      };
    }

    return {
      status: "NORMAL",
      level: 0,
      text: `${label}: ${val} ${unit}`
    };
  }

  /**
   * Hauptmethode: Analysiert ein beliebiges JSON-Paket, liest Endpunkte aus und interpretiert die Daten
   * @param {Object} rawPayload - Ankommendes JSON-Paket
   * @returns {Object} Detaillierte, verständliche Interpretation
   */
  interpret(rawPayload) {
    const now = Date.now();
    const payload = typeof rawPayload === "string" ? JSON.parse(rawPayload) : rawPayload;

    // 1. Alle Daten-Endpoints extrahieren
    const endpoints = this.extractEndpoints(payload);

    // 2. Registry aktualisieren
    for (const ep of endpoints) {
      const existing = this.knownEndpoints.get(ep.path);
      this.knownEndpoints.set(ep.path, {
        path: ep.path,
        firstSeen: existing ? existing.firstSeen : now,
        lastSeen: now,
        lastValue: ep.value,
        type: ep.type
      });
    }

    // 3. Station ermitteln
    const stationId = this.detectStationId(payload, endpoints);
    const stationConfig = this.stations.find(s => s.id === stationId) || this.stations[0];

    // 4. Metriken mappen
    const mapped = this.mapMetricsToStation(stationConfig, endpoints);

    // 5. Toleranzbewertungen berechnen
    const evalV1 = this.evaluateMetric(mapped.v1, stationConfig.v1);
    const evalV2 = this.evaluateMetric(mapped.v2, stationConfig.v2);
    const evalV3 = this.evaluateMetric(mapped.v3, stationConfig.v3);

    // Gesamtzustand ermitteln
    let overallStatus = "NORMAL";
    let statusBadge = "erfolgreich";
    if (mapped.isFault) {
      overallStatus = "STÖRUNG";
      statusBadge = "kritisch";
    } else if (evalV1.status === "KRITISCH" || evalV2.status === "KRITISCH" || evalV3.status === "KRITISCH") {
      overallStatus = "WARNUNG";
      statusBadge = "warnung";
    } else if (evalV1.status === "OPTIMAL" && evalV2.status === "OPTIMAL") {
      overallStatus = "OPTIMAL";
      statusBadge = "optimal";
    }

    // 6. Verständliche deutsche Klartext-Interpretation formulieren
    const details = [];
    if (evalV1.status !== "OPTIMAL") details.push(evalV1.text);
    if (evalV2.status !== "OPTIMAL") details.push(evalV2.text);

    let summaryText = "";
    if (overallStatus === "STÖRUNG") {
      summaryText = `⛔ Modul '${stationConfig.name}' meldet eine akute STÖRUNG! Sofortige Überprüfung vor Ort erforderlich.`;
    } else if (overallStatus === "WARNUNG") {
      summaryText = `⚠️ Warnung: Modul '${stationConfig.name}' läuft mit Abweichungen: ${details.join("; ")}`;
    } else if (overallStatus === "OPTIMAL") {
      summaryText = `✅ Modul '${stationConfig.name}' arbeitet in optimalem Prozesszustand. Alle Messwerte (${stationConfig.v1.label}: ${mapped.v1} ${stationConfig.v1.unit}, ${stationConfig.v2.label}: ${mapped.v2} ${stationConfig.v2.unit}) liegen exakt im Zentrum der Toleranz.`;
    } else {
      summaryText = `ℹ️ Modul '${stationConfig.name}': Regulärer Fertigungsbetrieb. Werte im zulässigen Toleranzbereich.`;
    }

    return {
      timestamp: now,
      stationId: stationConfig.id,
      stationName: stationConfig.name,
      status: overallStatus,
      summary: summaryText,
      mappedValues: {
        v1: { label: stationConfig.v1.label, val: mapped.v1, unit: stationConfig.v1.unit, status: evalV1.status },
        v2: { label: stationConfig.v2.label, val: mapped.v2, unit: stationConfig.v2.unit, status: evalV2.status },
        v3: { label: stationConfig.v3.label, val: mapped.v3, unit: stationConfig.v3.unit, status: evalV3.status }
      },
      station: {
        id: stationConfig.id,
        name: stationConfig.name,
        plcIp: stationConfig.plcIp
      },
      overallStatus,
      statusBadge,
      summaryText,
      metrics: {
        v1: {
          id: stationConfig.v1.id,
          label: stationConfig.v1.label,
          value: mapped.v1,
          unit: stationConfig.v1.unit,
          status: evalV1.status,
          evaluation: evalV1.text,
          mappedFrom: mapped.mappedEndpoints.v1 || null
        },
        v2: {
          id: stationConfig.v2.id,
          label: stationConfig.v2.label,
          value: mapped.v2,
          unit: stationConfig.v2.unit,
          status: evalV2.status,
          evaluation: evalV2.text,
          mappedFrom: mapped.mappedEndpoints.v2 || null
        },
        v3: {
          id: stationConfig.v3.id,
          label: stationConfig.v3.label,
          value: mapped.v3,
          unit: stationConfig.v3.unit,
          status: evalV3.status,
          evaluation: evalV3.text,
          mappedFrom: mapped.mappedEndpoints.v3 || null
        }
      },
      isFault: mapped.isFault,
      extractedEndpoints: endpoints.map(e => ({
        path: e.path,
        value: e.value,
        type: e.type
      })),
      totalEndpointsCount: endpoints.length
    };
  }

  /**
   * Liefert alle bisher registrierten Daten-Endpoints
   */
  getKnownEndpoints() {
    return Array.from(this.knownEndpoints.values()).sort((a, b) => b.lastSeen - a.lastSeen);
  }
}
