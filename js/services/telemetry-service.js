/**
 * TelemetryService - Abstraktionsschicht für industrielle Sensordaten
 * 
 * Ermöglicht den nahtlosen Wechsel zwischen:
 * 1. Mock-Modus (Simulation für Präsentationen / Unterricht)
 * 2. WebSocket-Stream (Echtzeit-Push vom Edge-Gateway / Node-RED)
 * 3. REST-API Polling (HTTP GET von SPS / OPC UA REST Gateway)
 */

import { authService } from "./auth-service.js";

export class TelemetryService {
  constructor(config) {
    this.config = config;
    this.stations = JSON.parse(JSON.stringify(config.stations)); // Deep clone
    this.currentIndex = config.defaultStationIndex || 0;
    this.isFaultSimulated = false;
    this.subscribers = new Set();
    this.timerId = null;
    this.wsConnection = null;

    // Initialisiere Trend-Puffer (Historie) für alle Sensoren
    this.initHistoryBuffers();

    // Standalone / Offline-Persistenz: Prüfe auf zuvor gespeicherte Konfiguration im Browser
    try {
      if (typeof localStorage !== "undefined") {
        const saved = localStorage.getItem("cps_saved_config");
        if (saved) {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed.stations)) {
            this.updateStationsConfig(parsed.stations);
          }
        }
      }
    } catch (_) {}
  }

  initHistoryBuffers() {
    this.stations.forEach(st => {
      ['v1', 'v2', 'v3'].forEach(k => {
        const item = st[k];
        if (item) {
          const base = typeof item.val === "number" ? item.val : 0;
          // Erzeuge 15 plausible historische Datenpunkte für saubere Sparklines
          item.history = Array.from({ length: 15 }, (_, i) => {
            if (item.isFixed || item.min === undefined) return base;
            const variance = (Math.sin(i * 0.5) * 0.05);
            return +(base + variance).toFixed(1);
          });
          item.trend = "stable"; // "up" | "down" | "stable"
        }
      });
    });
    this.summaries = new Map();
  }

  getCurrentSummary() {
    const current = this.getCurrentStation();
    if (!current) return null;
    const sId = current.id;
    if (this.summaries && this.summaries.has(sId)) {
      return this.summaries.get(sId);
    }
    const h = current.v1?.history || [];
    if (h.length === 0) return null;
    const min = Math.min(...h);
    const max = Math.max(...h);
    const avg = +(h.reduce((a, b) => a + b, 0) / h.length).toFixed(1);
    return {
      stationId: sId,
      windowSeconds: 300,
      v1: { min, max, avg, current: current.v1?.val ?? 0, trend: current.v1?.trend || "stable" },
      faultRatePercent: this.isFaultSimulated ? 100 : 0
    };
  }

  /**
   * Registriert einen Observer / Callback für Datenaktualisierungen
   * @param {Function} callback - fn(stationData, isFault, summary)
   */
  subscribe(callback) {
    this.subscribers.add(callback);
    // Sofortiger initialer Aufruf mit aktuellem Stand
    callback(this.getCurrentStation(), this.isFaultSimulated, this.getCurrentSummary());
    return () => this.subscribers.delete(callback);
  }

  /**
   * Benachrichtigt alle registrierten Listener über Datenänderungen
   */
  notify() {
    const current = this.getCurrentStation();
    const summary = this.getCurrentSummary();
    for (const callback of this.subscribers) {
      try {
        callback(current, this.isFaultSimulated, summary);
      } catch (err) {
        console.error("[TelemetryService] Fehler in Subscriber-Callback:", err);
      }
    }
  }

  getCurrentStation() {
    return this.stations[this.currentIndex];
  }

  getStationCount() {
    return this.stations.length;
  }

  setCurrentStationIndex(index) {
    if (index >= 0 && index < this.stations.length) {
      this.currentIndex = index;
      this.notify();
    }
  }

  nextStation() {
    this.currentIndex = (this.currentIndex + 1) % this.stations.length;
    this.notify();
    return this.currentIndex;
  }

  /**
   * Simuliert eine Störung an der aktuellen Station (z. B. Pneumatik-Druckabfall)
   * @param {boolean} [toggle] - Optionaler Zielzustand
   */
  toggleFaultSimulation() {
    this.isFaultSimulated = !this.isFaultSimulated;
    
    // An Station 2 (Verschluss/Bördelung) Druckwert manipulieren
    const mod3 = this.stations[2];
    if (this.isFaultSimulated) {
      mod3.v1.val = 2.8; // Kritischer Einbruch unter 4.5 bar
      mod3.v1.trend = "down";
      if (!mod3.v1.history) mod3.v1.history = [];
      mod3.v1.history.push(2.8);
      if (mod3.v1.history.length > 20) mod3.v1.history.shift();
    } else {
      mod3.v1.val = 5.2; // Normalwert
      mod3.v1.trend = "up";
      if (!mod3.v1.history) mod3.v1.history = [];
      mod3.v1.history.push(5.2);
      if (mod3.v1.history.length > 20) mod3.v1.history.shift();
    }

    this.notify();
    return this.isFaultSimulated;
  }

  addDynamicStation(station) {
    if (!station || !station.id) return;
    const existingIdx = this.stations.findIndex(s => s.id === station.id);
    const prepared = {
      ...station,
      isLive: true,
      isDemo: false,
      isDynamic: true,
      v1: { ...station.v1, history: station.v1?.history || [station.v1?.val ?? 0], trend: station.v1?.trend || "stable" },
      v2: { ...station.v2, history: station.v2?.history || [station.v2?.val ?? 0], trend: station.v2?.trend || "stable" },
      v3: { ...station.v3, history: station.v3?.history || [station.v3?.val ?? 0], trend: station.v3?.trend || "stable" }
    };

    if (existingIdx >= 0) {
      this.stations[existingIdx] = prepared;
      this.currentIndex = existingIdx;
    } else {
      this.stations.push(prepared);
      this.currentIndex = this.stations.length - 1;
    }
    this.notify();
  }

  /**
   * Startet die Telemetrie-Engine (Live WebSocket mit automatischer Modul-Erkennung)
   */
  start() {
    let savedWsUrl = null;
    let savedDataSource = null;
    try {
      if (typeof localStorage !== "undefined") {
        const saved = localStorage.getItem("cps_saved_config");
        if (saved) {
          const parsed = JSON.parse(saved);
          if (parsed.websocket?.url) savedWsUrl = parsed.websocket.url;
          if (parsed.dataSource) savedDataSource = parsed.dataSource;
        }
      }
    } catch (_) {}

    // Auto-Erkennung: Falls auf GitHub Pages oder file:
    const isGitHubPages = typeof window !== "undefined" && window.location && (
      window.location.hostname.endsWith("github.io") || window.location.protocol === "file:"
    );

    if (isGitHubPages) {
      const targetWs = savedWsUrl || "wss://nodered.bbk.robin-w.de/ws/opcua";
      this.connectWebSocket(targetWs);
      return;
    }

    // Wenn über Webserver/Docker gehostet:
    if (typeof window !== "undefined" && window.location && (window.location.protocol === "http:" || window.location.protocol === "https:")) {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const targetWs = savedWsUrl || `${proto}//${window.location.host}/ws/telemetry`;
      this.connectWebSocket(targetWs);

      if (typeof fetch === "function") {
        fetch("/api/stations").then(r => r.json()).then(data => {
          if (data && Array.isArray(data.stations) && data.stations.length > 0) {
            this.updateStationsConfig(data.stations);
          }
        }).catch(() => {});
      }
      return;
    }

    if (this.config.api.mode === "websocket") {
      let targetWs = savedWsUrl || this.config.api.wsEndpoint || "wss://nodered.bbk.robin-w.de/ws/opcua";
      this.connectWebSocket(targetWs);
    }
  }

  stop() {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    if (this.wsConnection) {
      this.wsConnection.close();
      this.wsConnection = null;
    }
  }

  /**
   * Mock-Simulation deaktiviert (Demo komplett rausgeschmissen)
   */
  startMockSimulation() {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  /**
   * 2. WEBSOCKET SCHNITTSTELLE (Für Edge-Gateway & CPS-Backend Anbindung)
   * Protokoll: JSON-Stream von Node-RED / CPS Backend
   */
  connectWebSocket(url) {
    let cleanUrl = typeof url === "string" ? url.trim() : "";
    if (cleanUrl.includes("tobin-w.de")) {
      cleanUrl = cleanUrl.replace(/tobin-w\.de/g, "robin-w.de");
    }
    console.info(`[TelemetryService] Verbinde mit WebSocket: ${cleanUrl}`);
    try {
      this.wsConnection = new WebSocket(cleanUrl);
      
      this.wsConnection.onopen = () => {
        console.info("[TelemetryService] WebSocket-Verbindung hergestellt.");
        if (this.timerId) {
          clearInterval(this.timerId);
          this.timerId = null;
        }
      };

      this.wsConnection.onmessage = (event) => {
        try {
          const incoming = JSON.parse(event.data);
          if (incoming.type === "init") {
            if (incoming.summaries) {
              for (const [stId, s] of Object.entries(incoming.summaries)) {
                this.summaries.set(stId, s);
              }
            }
            if (incoming.history) {
              for (const [stId, list] of Object.entries(incoming.history)) {
                const target = this.stations.find(s => s.id === stId);
                if (target && list.length > 0) {
                  const last = list[list.length - 1];
                  target.v1.val = last.v1;
                  target.v2.val = last.v2;
                  target.v3.val = last.v3;
                  target.v1.history = list.map(item => item.v1);
                  target.v2.history = list.map(item => item.v2);
                  target.v3.history = list.map(item => item.v3);
                }
              }
            }
            this.notify();
          } else if (incoming.type === "telemetry") {
            const data = incoming.sample ? { stationId: incoming.stationId, ...incoming.sample } : incoming;
            if (incoming.summary) {
              this.summaries.set(incoming.stationId, incoming.summary);
            }
            this.applyExternalData(data);
          } else if (incoming.type === "fault_change") {
            const current = this.getCurrentStation();
            if (current && incoming.stationId === current.id) {
              this.isFaultSimulated = incoming.isFault;
              this.notify();
            }
          } else if (incoming.type === "config_updated") {
            if (incoming.stationAdded) {
              this.addDynamicStation(incoming.stationAdded);
            }
            if (incoming.config && Array.isArray(incoming.config.stations)) {
              this.updateStationsConfig(incoming.config.stations);
            }
          } else {
            this.applyExternalData(incoming);
          }
        } catch (e) {
          console.warn("[TelemetryService] Ungültiges Telemetrie-Paket:", e);
        }
      };

      this.wsConnection.onerror = (err) => {
        console.warn("[TelemetryService] WebSocket-Fehler, wechsle auf Fallback-Simulation:", err);
        this.startMockSimulation();
      };

      this.wsConnection.onclose = () => {
        console.info("[TelemetryService] WebSocket geschlossen, starte Fallback-Simulation.");
        this.startMockSimulation();
      };
    } catch (e) {
      console.warn("[TelemetryService] WebSocket konnte nicht initialisiert werden:", e);
      this.startMockSimulation();
    }
  }

  /**
   * 3. REST-API POLLING (Alternative für einfache Webserver)
   */
  startRestPolling(url) {
    console.info(`[TelemetryService] Starte REST-Polling: ${url}`);
    this.timerId = setInterval(async () => {
      try {
        const response = await fetch(url);
        if (response.ok) {
          const data = await response.json();
          this.applyExternalData(data);
        }
      } catch (err) {
        console.warn("[TelemetryService] REST-Abruf fehlgeschlagen:", err);
      }
    }, this.config.api.pollIntervalMs || 2000);
  }

  /**
   * Übernimmt externe Daten in das interne Modell
   */
  applyExternalData(data) {
    if (!data) return;

    // Sobald echte Daten eintreffen: Mock-Simulation abschalten
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }

    let targetData = data;
    if (!targetData.stationId) {
      const interp = authService.standaloneInterpret(data);
      if (interp && interp.interpretation) {
        if (interp.synthesizedStation) {
          this.addDynamicStation(interp.synthesizedStation);
        }
        if (Array.isArray(interp.interpretation.allStations) && interp.interpretation.allStations.length > 0) {
          interp.interpretation.allStations.forEach(stData => {
            const target = this.stations.find(s => s.id === stData.stationId);
            if (target) {
              target.isLive = true;
              target.isDemo = false;
              if (stData.v1 !== undefined) {
                const prev1 = target.v1.val;
                target.v1.val = stData.v1;
                if (!target.v1.history) target.v1.history = [];
                target.v1.history.push(stData.v1);
                if (target.v1.history.length > 20) target.v1.history.shift();
                if (stData.v1 > prev1 + 0.04) target.v1.trend = "up";
                else if (stData.v1 < prev1 - 0.04) target.v1.trend = "down";
                else target.v1.trend = "stable";
              }
              if (stData.v2 !== undefined) {
                const prev2 = target.v2.val;
                target.v2.val = stData.v2;
                if (!target.v2.history) target.v2.history = [];
                target.v2.history.push(stData.v2);
                if (target.v2.history.length > 20) target.v2.history.shift();
                if (stData.v2 > prev2 + 0.04) target.v2.trend = "up";
                else if (stData.v2 < prev2 - 0.04) target.v2.trend = "down";
                else target.v2.trend = "stable";
              }
              if (stData.v3 !== undefined) target.v3.val = stData.v3;
              if (stData.isFault !== undefined) this.isFaultSimulated = stData.isFault;
            }
          });
          this.notify();
          return;
        }

        const m = interp.interpretation.mappedValues || {};
        targetData = {
          stationId: interp.interpretation.stationId,
          v1: m.v1?.val,
          v2: m.v2?.val,
          v3: m.v3?.val,
          isFault: interp.interpretation.status === "KRITISCH"
        };
      }
    }
    if (!targetData.stationId) return;

    let target = this.stations.find(s => s.id === targetData.stationId);
    if (!target) {
      if (data.synthesizedStation) {
        this.addDynamicStation(data.synthesizedStation);
        target = this.stations.find(s => s.id === targetData.stationId);
      } else {
        const synth = {
          id: targetData.stationId,
          name: targetData.stationName || targetData.stationId,
          plcIp: targetData.plcIp || "192.168.10.15",
          isDynamic: true,
          isLive: true,
          isDemo: false,
          v1: { label: "Messwert", val: targetData.v1 ?? 0, unit: "", min: 0, max: 100 },
          v2: { label: "Status", val: targetData.v2 ?? 0, unit: "Code", min: 0, max: 0 },
          v3: { label: "Signal", val: targetData.v3 ?? 100, unit: "%", min: 90, max: 100 }
        };
        this.addDynamicStation(synth);
        target = this.stations.find(s => s.id === targetData.stationId);
      }
    } else {
      target.isLive = true;
      target.isDemo = false;
    }

    if (target) {
      if (targetData.v1 !== undefined) {
        const prev1 = target.v1.val;
        target.v1.val = targetData.v1;
        if (!target.v1.history) target.v1.history = [];
        target.v1.history.push(targetData.v1);
        if (target.v1.history.length > 20) target.v1.history.shift();
        if (targetData.v1 > prev1 + 0.04) target.v1.trend = "up";
        else if (targetData.v1 < prev1 - 0.04) target.v1.trend = "down";
        else target.v1.trend = "stable";
      }
      if (targetData.v2 !== undefined) {
        const prev2 = target.v2.val;
        target.v2.val = targetData.v2;
        if (!target.v2.history) target.v2.history = [];
        target.v2.history.push(targetData.v2);
        if (target.v2.history.length > 20) target.v2.history.shift();
        if (targetData.v2 > prev2 + 0.04) target.v2.trend = "up";
        else if (targetData.v2 < prev2 - 0.04) target.v2.trend = "down";
        else target.v2.trend = "stable";
      }
      if (targetData.v3 !== undefined) target.v3.val = targetData.v3;
      if (targetData.isFault !== undefined) this.isFaultSimulated = targetData.isFault;
      this.notify();
    }
  }

  /**
   * Aktualisiert die Stationskonfigurationen (z. B. Toleranzbänder, Sollwerte) live
   * @param {Array} newStations - Neue Stationsdefinitionen
   */
  updateStationsConfig(newStations) {
    if (!Array.isArray(newStations)) return;
    newStations.forEach(newSt => {
      const target = this.stations.find(s => s.id === newSt.id);
      if (target) {
        if (newSt.name) target.name = newSt.name;
        if (newSt.plcIp) target.plcIp = newSt.plcIp;
        ['v1', 'v2', 'v3'].forEach(k => {
          if (newSt[k] && target[k]) {
            if (newSt[k].min !== undefined) target[k].min = newSt[k].min;
            if (newSt[k].max !== undefined) target[k].max = newSt[k].max;
            if (newSt[k].label) target[k].label = newSt[k].label;
            if (newSt[k].unit) target[k].unit = newSt[k].unit;
            if (newSt[k].defaultVal !== undefined) target[k].val = newSt[k].defaultVal;
          }
        });
        if (newSt.isLive) target.isLive = true;
        if (newSt.isDynamic) target.isDynamic = true;
      } else {
        this.stations.push(JSON.parse(JSON.stringify(newSt)));
      }
    });
    this.notify();
  }
}
