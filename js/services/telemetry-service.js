/**
 * TelemetryService - Abstraktionsschicht für industrielle Sensordaten
 * 
 * Ermöglicht den nahtlosen Wechsel zwischen:
 * 1. Mock-Modus (Simulation für Präsentationen / Unterricht)
 * 2. WebSocket-Stream (Echtzeit-Push vom Edge-Gateway / Node-RED)
 * 3. REST-API Polling (HTTP GET von SPS / OPC UA REST Gateway)
 */

export class TelemetryService {
  constructor(config) {
    this.config = config;
    this.stations = JSON.parse(JSON.stringify(config.stations)); // Deep clone
    this.currentIndex = config.defaultStationIndex || 0;
    this.isFaultSimulated = false;
    this.subscribers = new Set();
    this.timerId = null;
    this.wsConnection = null;
  }

  /**
   * Registriert einen Observer / Callback für Datenaktualisierungen
   * @param {Function} callback - fn(stationData, isFault)
   */
  subscribe(callback) {
    this.subscribers.add(callback);
    // Sofortiger initialer Aufruf mit aktuellem Stand
    callback(this.getCurrentStation(), this.isFaultSimulated);
    return () => this.subscribers.delete(callback);
  }

  /**
   * Benachrichtigt alle registrierten Listener über Datenänderungen
   */
  notify() {
    const current = this.getCurrentStation();
    for (const callback of this.subscribers) {
      try {
        callback(current, this.isFaultSimulated);
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
    } else {
      mod3.v1.val = 5.2; // Normalwert
    }

    this.notify();
    return this.isFaultSimulated;
  }

  /**
   * Startet die Telemetrie-Engine (Mock oder Live je nach Konfiguration)
   */
  start() {
    if (this.config.api.mode === "websocket") {
      this.connectWebSocket(this.config.api.wsEndpoint);
    } else if (this.config.api.mode === "rest") {
      this.startRestPolling(this.config.api.restEndpoint);
    } else {
      this.startMockSimulation();
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
   * 1. MOCK-SIMULATION
   * Erzeugt realistische kleine Prozessschwankungen
   */
  startMockSimulation() {
    if (this.timerId) clearInterval(this.timerId);

    this.timerId = setInterval(() => {
      if (this.isFaultSimulated) return;

      const current = this.getCurrentStation();
      ['v1', 'v2', 'v3'].forEach(key => {
        const item = current[key];
        if (item && !item.isFixed && item.min !== undefined && item.max !== undefined) {
          const delta = (Math.random() - 0.5) * 0.1;
          let val = +(item.val + delta).toFixed(1);
          if (val >= item.min && val <= item.max) {
            item.val = val;
          }
        }
      });

      this.notify();
    }, this.config.api.pollIntervalMs || 1500);
  }

  /**
   * 2. WEBSOCKET SCHNITTSTELLE (Für spätere Edge-Gateway Anbindung)
   * Protokollbeispiel: JSON-Stream von Node-RED / OPC UA Gateway
   */
  connectWebSocket(url) {
    console.info(`[TelemetryService] Verbinde mit WebSocket: ${url}`);
    try {
      this.wsConnection = new WebSocket(url);
      
      this.wsConnection.onopen = () => {
        console.info("[TelemetryService] WebSocket-Verbindung hergestellt.");
      };

      this.wsConnection.onmessage = (event) => {
        try {
          const incomingData = JSON.parse(event.data);
          this.applyExternalData(incomingData);
        } catch (e) {
          console.warn("[TelemetryService] Ungültiges Telemetrie-Paket:", e);
        }
      };

      this.wsConnection.onerror = (err) => {
        console.warn("[TelemetryService] WebSocket-Fehler, wechsle auf Fallback-Simulation:", err);
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
    if (!data || !data.stationId) return;
    const target = this.stations.find(s => s.id === data.stationId);
    if (target) {
      if (data.v1 !== undefined) target.v1.val = data.v1;
      if (data.v2 !== undefined) target.v2.val = data.v2;
      if (data.v3 !== undefined) target.v3.val = data.v3;
      this.notify();
    }
  }
}
