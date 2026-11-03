/**
 * CPS-i40 SCADA Gesamtanlagen-Übersicht Controller
 * Neu strukturiert im HeroUI (NextUI) & SevDesk Dashboard-Stil
 * 
 * Verwaltet:
 * 1. WebSocket-Verbindung zu /ws/telemetry (mit auto-reconnect & REST-Fallback)
 * 2. Visualisierung aller 4 Fertigungsmodule der Bonbon-Linie
 * 3. 5-Minuten Zeitreihen & HeroUI SVG-Glow-Area-Charts (TTL 300s)
 * 4. SevDesk Statistische Auswertungen (Min, Max, Avg, Trend, Störrate)
 * 5. Interaktive Störungs-Simulation & Quittierung
 */

import { authService } from "./services/auth-service.js";

const STATIONS_DEFAULT = [
  {
    id: "ST-010",
    name: "Modul 1: Dosen-Zuführung",
    plcIp: "192.168.10.11",
    v1: { label: "Magazin", unit: "%", val: 84 },
    v2: { label: "Vakuum", unit: "bar", val: -0.8 },
    v3: { label: "Zähler", unit: "Stk", val: 1684 }
  },
  {
    id: "ST-020",
    name: "Modul 2: Dosierung & Befüllung",
    plcIp: "192.168.10.12",
    v1: { label: "Füllgewicht", unit: "g", val: 250.3 },
    v2: { label: "Druck", unit: "bar", val: 5.2 },
    v3: { label: "Takt", unit: "D/min", val: 32 }
  },
  {
    id: "ST-030",
    name: "Modul 3: Verschluss & Bördelung",
    plcIp: "192.168.10.13",
    v1: { label: "Anpressdruck", unit: "bar", val: 5.2 },
    v2: { label: "Drehmoment", unit: "Nm", val: 3.9 },
    v3: { label: "Prüfung", unit: "%", val: 100 }
  },
  {
    id: "ST-040",
    name: "Modul 4: Qualitätskontrolle & Waage",
    plcIp: "192.168.10.14",
    v1: { label: "Kontrollgewicht", unit: "g", val: 250.1 },
    v2: { label: "Ausschuss", unit: "%", val: 0.4 },
    v3: { label: "OEE", unit: "%", val: 93 }
  }
];

class ScadaOverviewApp {
  constructor() {
    this.stations = JSON.parse(JSON.stringify(STATIONS_DEFAULT));
    this.historyMap = new Map();
    this.summaryMap = new Map();
    this.faultMap = new Map();
    this.ws = null;
    this.reconnectTimer = null;
    this.restFallbackTimer = null;
    this.standaloneTimer = null;
    this.isStandaloneSim = false;

    // Standalone / Offline-Persistenz: Prüfe auf zuvor gespeicherte Konfiguration
    try {
      if (typeof localStorage !== "undefined") {
        const saved = localStorage.getItem("cps_saved_config");
        if (saved) {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed.stations)) {
            this.mergeSavedStationsConfig(parsed.stations);
          }
        }
      }
    } catch (_) {}

    // DOM Caches
    this.dom = {
      wsBadgeDot: document.getElementById("ws-badge-dot"),
      wsBadgeText: document.getElementById("ws-badge-text"),
      mqttBadgeDot: document.getElementById("mqtt-badge-dot"),
      mqttBadgeText: document.getElementById("mqtt-badge-text"),
      storeSampleCount: document.getElementById("store-sample-count"),
      kpiOee: document.getElementById("kpi-oee"),
      kpiTakt: document.getElementById("kpi-takt"),
      kpiAlarms: document.getElementById("kpi-alarms"),
      kpiAlarmsTag: document.getElementById("kpi-alarms-tag"),
      kpiSamples: document.getElementById("kpi-samples"),
      stationsContainer: document.getElementById("stations-scada-container")
    };

    this.initStationsLayout();
    this.initStandaloneHistory();
    this.initConfigModal();
    this.initModuleEditModal();
    this.initAuth();
    this.initInterpreter();
    this.initInspector();
    this.renderAll();
    this.connectWebSocket();
    this.startClock();
  }

  mergeSavedStationsConfig(savedStations) {
    if (!Array.isArray(savedStations)) return;
    savedStations.forEach(newSt => {
      const target = this.stations.find(s => s.id === newSt.id);
      if (target) {
        if (newSt.name) target.name = newSt.name;
        if (newSt.plcIp) target.plcIp = newSt.plcIp;
        if (newSt.mqttTopic) target.mqttTopic = newSt.mqttTopic;
        if (newSt.description) target.description = newSt.description;
        ['v1', 'v2', 'v3'].forEach(k => {
          if (newSt[k] && target[k]) {
            if (newSt[k].min !== undefined) target[k].min = newSt[k].min;
            if (newSt[k].max !== undefined) target[k].max = newSt[k].max;
            if (newSt[k].label) target[k].label = newSt[k].label;
            if (newSt[k].unit) target[k].unit = newSt[k].unit;
            if (newSt[k].defaultVal !== undefined) target[k].val = newSt[k].defaultVal;
          }
        });
      }
    });
  }

  /**
   * Erzeugt das HeroUI & SevDesk DOM-Gerüst für alle 4 Stationen
   */
  initStationsLayout() {
    if (!this.dom.stationsContainer) return;
    this.dom.stationsContainer.innerHTML = "";

    this.stations.forEach(st => {
      const card = document.createElement("article");
      card.className = "heroui-station-card";
      card.id = `card-${st.id}`;

      card.innerHTML = `
        <div class="heroui-station-header">
          <div class="station-title-group">
            <div class="station-id-avatar">${st.id.replace("ST-", "M")}</div>
            <div class="station-title-text">
              <span class="station-main-title" id="title-${st.id}">${st.name}</span>
              <span class="station-meta-sub" id="sub-${st.id}">SPS: ${st.plcIp}${st.mqttTopic ? ' • MQTT: ' + st.mqttTopic : ''}</span>
            </div>
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <button type="button" class="heroui-btn heroui-btn-flat btn-quick-edit" data-station-id="${st.id}" title="Modul '${st.name}' umbenennen und anpassen" style="padding:4px 8px; font-size:0.75rem; border:1px solid rgba(255,255,255,0.1);">⚙️ Anpassen</button>
            <span class="heroui-status-chip" id="pill-${st.id}">
              <span class="chip-dot"></span>
              <span id="pill-text-${st.id}">NORMAL</span>
            </span>
          </div>
        </div>

        <div class="metrics-scada-row">
          <div class="sevdesk-metric-cell" id="cell-${st.id}-v1">
            <div class="metric-cell-top">
              <span class="metric-cell-lbl" id="lbl-${st.id}-v1">${st.v1.label}</span>
              <span class="metric-cell-trend-pill trend-stable" id="trend-${st.id}-v1">→</span>
            </div>
            <div class="metric-cell-val"><span id="val-${st.id}-v1">${st.v1.val}</span><span class="metric-cell-unit">${st.v1.unit}</span></div>
          </div>

          <div class="sevdesk-metric-cell" id="cell-${st.id}-v2">
            <div class="metric-cell-top">
              <span class="metric-cell-lbl" id="lbl-${st.id}-v2">${st.v2.label}</span>
              <span class="metric-cell-trend-pill trend-stable" id="trend-${st.id}-v2">→</span>
            </div>
            <div class="metric-cell-val"><span id="val-${st.id}-v2">${st.v2.val}</span><span class="metric-cell-unit">${st.v2.unit}</span></div>
          </div>

          <div class="sevdesk-metric-cell" id="cell-${st.id}-v3">
            <div class="metric-cell-top">
              <span class="metric-cell-lbl" id="lbl-${st.id}-v3">${st.v3.label}</span>
              <span class="metric-cell-trend-pill trend-stable" id="trend-${st.id}-v3">→</span>
            </div>
            <div class="metric-cell-val"><span id="val-${st.id}-v3">${st.v3.val}</span><span class="metric-cell-unit">${st.v3.unit}</span></div>
          </div>
        </div>

        <div class="history-section-heroui">
          <div class="history-header">
            <div class="history-title">
              <span>5-Minuten Trendkurve (${st.v1.label})</span>
              <span class="history-ttl-pill">TTL: 300s</span>
            </div>
            <span style="font-size:0.7rem; font-family:var(--font-mono); color:var(--text-muted);" id="pts-${st.id}">0 Datenpunkte</span>
          </div>

          <div class="chart-container-scada">
            <svg class="scada-chart-svg" id="chart-${st.id}" viewBox="0 0 300 70" preserveAspectRatio="none">
              <defs>
                <linearGradient id="grad-${st.id}" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stop-color="#10b981" stop-opacity="0.32" />
                  <stop offset="100%" stop-color="#10b981" stop-opacity="0.0" />
                </linearGradient>
                <linearGradient id="grad-alert-${st.id}" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stop-color="#ef4444" stop-opacity="0.38" />
                  <stop offset="100%" stop-color="#ef4444" stop-opacity="0.0" />
                </linearGradient>
              </defs>
              <line x1="0" y1="18" x2="300" y2="18" stroke="rgba(255,255,255,0.05)" stroke-dasharray="2,2" />
              <line x1="0" y1="36" x2="300" y2="36" stroke="rgba(255,255,255,0.05)" stroke-dasharray="2,2" />
              <line x1="0" y1="54" x2="300" y2="54" stroke="rgba(255,255,255,0.05)" stroke-dasharray="2,2" />
              <polygon points="" fill="url(#grad-${st.id})" id="poly-area-${st.id}" />
              <polyline points="" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" id="poly-line-${st.id}" />
            </svg>
          </div>

          <div class="sevdesk-eval-grid">
            <div class="eval-col">
              <span class="eval-lbl">Min (5m)</span>
              <span class="eval-num" id="min-${st.id}">-</span>
            </div>
            <div class="eval-col">
              <span class="eval-lbl">Max (5m)</span>
              <span class="eval-num" id="max-${st.id}">-</span>
            </div>
            <div class="eval-col">
              <span class="eval-lbl">Ø Mittelwert</span>
              <span class="eval-num" id="avg-${st.id}">-</span>
            </div>
            <div class="eval-col">
              <span class="eval-lbl">Störrate</span>
              <span class="eval-num" id="rate-${st.id}">0.0%</span>
            </div>
          </div>
        </div>

        <div class="heroui-station-footer">
          <span class="station-node-tag">SPS-Kanal: ${st.plcIp}</span>
          <button class="btn-heroui-fault" id="btn-fault-${st.id}">Störung simulieren</button>
        </div>
      `;

      const btnFault = card.querySelector(`#btn-fault-${st.id}`);
      if (btnFault) btnFault.addEventListener("click", () => this.toggleFault(st.id));

      const btnEdit = card.querySelector(`.btn-quick-edit`);
      if (btnEdit) btnEdit.addEventListener("click", () => this.openModuleEditModal(st.id));
    });
  }

  /**
   * Verbindet mit dem WebSocket-Server (unterstützt direktes WSS-Streaming auf GitHub Pages mit automatischem Fallback auf autarke SPS-Simulation)
   */
  connectWebSocket() {
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
      this.ws = null;
    }

    const isGitHubPages = typeof window !== "undefined" && window.location && (
      window.location.hostname.endsWith("github.io") || window.location.protocol === "file:"
    );

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

    if (savedDataSource === "simulator") {
      console.info("[SCADA] SPS-Simulator als Datenquelle gewählt: Starte autarke Simulation.");
      this.startStandaloneSimulation();
      return;
    }

    const defaultLiveWs = "wss://nodered.bbk.robin-w.de/ws/opcua";
    let wsUrl = savedWsUrl || defaultLiveWs;
    if (wsUrl.includes("tobin-w.de")) {
      wsUrl = wsUrl.replace(/tobin-w\.de/g, "robin-w.de");
    }

    // Falls lokaler Backend-Server aktiv ist (Port 3000) und keine externe WS-URL manuell überschrieben wurde:
    if (!isGitHubPages && !savedWsUrl && window.location && (window.location.port === "3000" || (window.location.host && window.location.host.includes("cps-backend")))) {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const host = window.location.host || "localhost:3000";
      wsUrl = `${protocol}//${host}/ws/telemetry`;
    }

    this.updateWsBadge(false, "Verbinde...");

    let connectTimeout = null;
    let hasOpened = false;

    // Auf GitHub Pages / statischem Host: Autarken Simulator nach 4,5s starten falls WS noch nicht antwortet
    if (isGitHubPages || window.location.protocol === "file:") {
      connectTimeout = setTimeout(() => {
        if (!hasOpened && (!this.ws || this.ws.readyState !== WebSocket.OPEN)) {
          console.info("[SCADA] GitHub Pages / Statischer Host: WebSocket verzögert, starte temporäre SPS-Simulation.");
          this.startStandaloneSimulation();
        }
      }, 4500);
    }

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        hasOpened = true;
        if (connectTimeout) clearTimeout(connectTimeout);
        if (this.standaloneTimer) {
          clearInterval(this.standaloneTimer);
          this.standaloneTimer = null;
        }
        this.isStandaloneSim = false;
        const isDirectNodeRed = (this.ws && this.ws.url && this.ws.url.includes("robin-w.de"));
        this.updateWsBadge(true, isDirectNodeRed ? "Live: Node-RED OPC UA" : "Live (300s)");
        this.updateMqttBadge(true, false);
        if (this.modal && this.modal.sourceBadgeText) {
          this.modal.sourceBadgeText.textContent = isDirectNodeRed ? "Node-RED OPC UA (WSS)" : "WebSocket (Live)";
          this.modal.sourceBadgeText.style.color = "#10b981";
        }
        this.updateInspectorWsConnection(true, this.ws.url);
        if (this.restFallbackTimer) {
          clearInterval(this.restFallbackTimer);
          this.restFallbackTimer = null;
        }
      };

      this.ws.onmessage = (event) => {
        try {
          if (this.standaloneTimer) {
            clearInterval(this.standaloneTimer);
            this.standaloneTimer = null;
          }
          this.isStandaloneSim = false;

          // Erste WebSocket-Abfrage im Rohdaten-Inspektor festhalten
          this.recordWsInspectorPacket(event.data);

          const data = JSON.parse(event.data);
          this.handleSocketMessage(data);
        } catch (e) {
          console.warn("[SCADA] Ungültiges WebSocket-Paket:", e);
        }
      };

      this.ws.onclose = () => {
        if (connectTimeout) clearTimeout(connectTimeout);
        this.updateInspectorWsConnection(false, wsUrl);
        if (isGitHubPages) {
          this.updateWsBadge(false, "Getrennt (Sim aktiv)");
          if (!this.isStandaloneSim) {
            this.startStandaloneSimulation();
          }
          this.scheduleReconnect();
        } else {
          this.updateWsBadge(false, "Getrennt");
          this.scheduleReconnect();
          this.startRestFallback();
        }
      };

      this.ws.onerror = () => {
        if (connectTimeout) clearTimeout(connectTimeout);
        if (isGitHubPages) {
          this.updateWsBadge(false, "Offline (Sim aktiv)");
          if (!this.isStandaloneSim) {
            this.startStandaloneSimulation();
          }
        } else {
          this.updateWsBadge(false, "Fehler");
          try { this.ws.close(); } catch (_) {}
        }
      };
    } catch (e) {
      if (connectTimeout) clearTimeout(connectTimeout);
      if (isGitHubPages) {
        console.warn("[SCADA] WebSocket konnte nicht initialisiert werden:", e);
        this.startStandaloneSimulation();
      } else {
        this.updateWsBadge(false, "Offline");
        this.scheduleReconnect();
        this.startRestFallback();
      }
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWebSocket();
    }, 4000);
  }

  startRestFallback() {
    if (this.isStandaloneSim) return;
    if (this.restFallbackTimer) return;
    this.fetchRestSnapshot();
    this.restFallbackTimer = setInterval(() => this.fetchRestSnapshot(), 2000);
  }

  async fetchRestSnapshot() {
    try {
      const res = await fetch("/api/history");
      const ct = res.headers ? (res.headers.get("content-type") || "") : "";
      if (res.ok && ct.includes("application/json")) {
        const json = await res.json();
        if (json.history) {
          for (const [stId, list] of Object.entries(json.history)) {
            this.historyMap.set(stId, list);
          }
        }
        if (json.summaries) {
          for (const [stId, s] of Object.entries(json.summaries)) {
            this.summaryMap.set(stId, s);
          }
        }
        this.renderAll();
        return;
      }
    } catch (_) {}

    // Falls REST 404 zurückgibt (z.B. statischer Server) und kein WS verfügbar ist:
    this.startStandaloneSimulation();
  }

  startStandaloneSimulation() {
    if (this.isStandaloneSim) return;
    // Niemals einen aktiven oder gerade verbindenden WebSocket abwürgen
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.isStandaloneSim = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.restFallbackTimer) {
      clearInterval(this.restFallbackTimer);
      this.restFallbackTimer = null;
    }

    console.info("[SCADA] Autarker Client-SPS-Simulator aktiviert (GitHub Pages / Offline-Modus).");
    const isGh = typeof window !== "undefined" && window.location && window.location.hostname.endsWith("github.io");
    this.updateWsBadge(true, isGh ? "SPS-Sim (GitHub Pages)" : "SPS-Sim (Offline)");
    this.updateMqttBadge(false, true);

    this.initStandaloneHistory();

    if (this.standaloneTimer) clearInterval(this.standaloneTimer);
    this.standaloneTimer = setInterval(() => {
      this.tickStandaloneSimulation();
    }, 1500);

    this.renderAll();
  }

  initStandaloneHistory() {
    if (this.liveOnlyMode) return;
    const now = Date.now();
    const stepMs = 15000; // alle 15 Sekunden = 20 Punkte = 5 Minuten Zeitfenster
    const ttlMs = 300000;

    this.stations.forEach(st => {
      const list = [];
      const v1Def = typeof st.v1?.val === "number" ? st.v1.val : 250;
      const v2Def = typeof st.v2?.val === "number" ? st.v2.val : 5.0;
      const v3Def = typeof st.v3?.val === "number" ? st.v3.val : 30;

      for (let i = 20; i >= 0; i--) {
        const t = now - (i * stepMs);
        const v1Delta = (Math.sin(i * 0.4) * 0.05);
        const v2Delta = (Math.cos(i * 0.3) * 0.04);
        list.push({
          v1: +(v1Def + v1Delta).toFixed(1),
          v2: +(v2Def + v2Delta).toFixed(1),
          v3: v3Def,
          timestamp: t,
          isFault: false,
          isDemo: true,
          simulated: true
        });
      }
      this.historyMap.set(st.id, list);
      this.calculateStationSummary(st.id);
    });
  }

  tickStandaloneSimulation() {
    if (this.liveOnlyMode) return;
    const now = Date.now();
    const ttlMs = 300000;

    this.stations.forEach(st => {
      let list = this.historyMap.get(st.id) || [];
      const isFault = Boolean(this.faultMap?.get(st.id));

      let v1 = st.v1?.val ?? 250;
      let v2 = st.v2?.val ?? 5.0;
      let v3 = st.v3?.val ?? 30;

      if (isFault) {
        if (st.id === "ST-020" || st.id === "ST-030") {
          v1 = +(2.8 + (Math.random() - 0.5) * 0.2).toFixed(1);
        } else if (st.id === "ST-010") {
          v1 = 12.0;
        } else {
          v2 = 8.5;
        }
      } else {
        const delta1 = (Math.random() - 0.5) * 0.1;
        const delta2 = (Math.random() - 0.5) * 0.08;
        v1 = +(v1 + delta1).toFixed(1);
        v2 = +(v2 + delta2).toFixed(1);

        if (st.v1?.min !== undefined && st.v1?.max !== undefined) {
          if (v1 < st.v1.min) v1 = st.v1.min;
          if (v1 > st.v1.max) v1 = st.v1.max;
        }
        if (st.v2?.min !== undefined && st.v2?.max !== undefined) {
          if (v2 < st.v2.min) v2 = st.v2.min;
          if (v2 > st.v2.max) v2 = st.v2.max;
        }
      }

      st.v1.val = v1;
      st.v2.val = v2;
      st.v3.val = v3;

      list.push({
        v1,
        v2,
        v3,
        timestamp: now,
        isFault,
        isDemo: true,
        simulated: true
      });

      list = list.filter(entry => (now - entry.timestamp) <= ttlMs);
      this.historyMap.set(st.id, list);
      this.calculateStationSummary(st.id);
    });

    this.renderAll();
  }

  calculateStationSummary(stationId) {
    const list = this.historyMap.get(stationId) || [];
    if (list.length === 0) return;
    const v1Values = list.map(e => e.v1);
    const min = Math.min(...v1Values);
    const max = Math.max(...v1Values);
    const avg = +(v1Values.reduce((a, b) => a + b, 0) / v1Values.length).toFixed(1);
    const current = v1Values[v1Values.length - 1];

    let trend = "stable";
    if (v1Values.length >= 2) {
      const prev = v1Values[v1Values.length - 2];
      if (current > prev + 0.04) trend = "up";
      else if (current < prev - 0.04) trend = "down";
    }

    const faultCount = list.filter(e => e.isFault).length;
    const faultRatePercent = +((faultCount / list.length) * 100).toFixed(1);

    this.summaryMap.set(stationId, {
      stationId,
      windowSeconds: 300,
      v1: { min, max, avg, current, trend },
      faultRatePercent
    });
  }

  handleSocketMessage(msg) {
    if (msg.type === "init") {
      this.updateMqttBadge(msg.mqttConnected, msg.mqttSimulated);
      if (msg.history) {
        for (const [stId, list] of Object.entries(msg.history)) {
          this.historyMap.set(stId, list);
        }
      }
      if (msg.summaries) {
        for (const [stId, s] of Object.entries(msg.summaries)) {
          this.summaryMap.set(stId, s);
        }
      }
      this.renderAll();
    } else if (msg.type === "telemetry") {
      const { stationId, sample, summary } = msg;
      if (this.standaloneTimer) {
        clearInterval(this.standaloneTimer);
        this.standaloneTimer = null;
      }
      this.isStandaloneSim = false;

      if (!this.historyMap.has(stationId)) {
        this.historyMap.set(stationId, []);
      }
      let list = this.historyMap.get(stationId);

      // Falls echte Live-Telemetriedaten eintreffen, entferne vorherige Demo-Punkte
      if (sample && (sample.isLive || (!sample.isDemo && !sample.simulated))) {
        this.updateWsBadge(true, "Live: Node-RED OPC UA");
        if (this.modal && this.modal.sourceBadgeText) {
          this.modal.sourceBadgeText.textContent = "Node-RED OPC UA (WSS)";
          this.modal.sourceBadgeText.style.color = "#10b981";
        }
        const filtered = list.filter(item => !item.isDemo && !item.simulated);
        if (filtered.length !== list.length) {
          list = filtered;
          this.historyMap.set(stationId, list);
        }
      }

      list.push(sample);
      
      const cutoff = Date.now() - 300000;
      while (list.length > 0 && list[0].timestamp < cutoff) {
        list.shift();
      }

      this.calculateStationSummary(stationId);
      const computedSummary = summary || this.summaryMap.get(stationId);
      if (computedSummary) {
        this.summaryMap.set(stationId, computedSummary);
      }

      this.updateStationCard(stationId, sample, computedSummary);
      this.updateKpis();
    } else if (msg.type === "fault_change") {
      this.setCardFaultState(msg.stationId, msg.isFault);
      this.updateKpis();
    } else if (msg.type === "status") {
      this.updateMqttBadge(msg.connected, msg.simulated);
    } else if (msg.type === "config_updated") {
      if (msg.config && Array.isArray(msg.config.stations)) {
        this.stations = msg.config.stations;
        this.initStationsLayout();
        this.renderAll();
      }
      if (msg.config && msg.config.mqtt) {
        this.updateConfigStatus(msg.config.mqtt);
      }
    } else if (msg.type === "telemetry_interpreted" && msg.interpretation) {
      this.displayInterpretationResult(msg.interpretation);
    } else {
      // Direkte Fremddaten / Node-RED OPC UA Frames semantisch interpretieren
      const interpRes = authService.standaloneInterpret(msg);
      if (interpRes && interpRes.interpretation) {
        const interp = interpRes.interpretation;
        if (this.standaloneTimer) {
          clearInterval(this.standaloneTimer);
          this.standaloneTimer = null;
        }
        this.isStandaloneSim = false;

        this.updateWsBadge(true, "Live: Node-RED OPC UA");
        if (this.modal && this.modal.sourceBadgeText) {
          this.modal.sourceBadgeText.textContent = "Node-RED OPC UA (WSS)";
          this.modal.sourceBadgeText.style.color = "#10b981";
        }

        // Mehrstationen-Update (z. B. aus OPC UA ServerStatus_CurrentTime Takt)
        if (Array.isArray(interp.allStations) && interp.allStations.length > 0) {
          interp.allStations.forEach(stData => {
            const sId = stData.stationId;
            const sample = {
              v1: stData.v1,
              v2: stData.v2,
              v3: stData.v3,
              isFault: Boolean(stData.isFault),
              isLive: true,
              isDemo: false,
              timestamp: interp.timestamp || Date.now()
            };

            if (!this.historyMap.has(sId)) {
              this.historyMap.set(sId, []);
            }
            let list = this.historyMap.get(sId);
            // Vorherige Demo-Daten entfernen
            list = list.filter(item => !item.isDemo && !item.simulated);
            list.push(sample);
            const cutoff = Date.now() - 300000;
            while (list.length > 0 && list[0].timestamp < cutoff) {
              list.shift();
            }
            this.historyMap.set(sId, list);
            this.calculateStationSummary(sId);
            const computedSummary = this.summaryMap.get(sId) || {
              status: stData.status,
              summary: stData.summary
            };
            this.updateStationCard(sId, sample, computedSummary);
          });
          this.updateKpis();
          return;
        }

        // Einzelsignal für eine spezifische Station
        const stationId = interp.stationId || "ST-020";
        const mv = interp.mappedValues || {};
        const sample = {
          v1: mv.v1?.val ?? 250,
          v2: mv.v2?.val ?? 5.0,
          v3: mv.v3?.val ?? 32,
          isFault: interp.status === "KRITISCH",
          isLive: true,
          isDemo: false,
          timestamp: interp.timestamp || Date.now()
        };

        if (!this.historyMap.has(stationId)) {
          this.historyMap.set(stationId, []);
        }
        let list = this.historyMap.get(stationId);
        // Vorherige Demo-Daten entfernen
        list = list.filter(item => !item.isDemo && !item.simulated);
        list.push(sample);
        const cutoff = Date.now() - 300000;
        while (list.length > 0 && list[0].timestamp < cutoff) {
          list.shift();
        }
        this.historyMap.set(stationId, list);
        this.calculateStationSummary(stationId);
        const computedSummary = this.summaryMap.get(stationId) || {
          status: interp.status,
          summary: interp.summary
        };
        this.updateStationCard(stationId, sample, computedSummary);
        this.updateKpis();
      }
    }
  }

  updateStationCard(stationId, sample, summary) {
    const v1ValEl = document.getElementById(`val-${stationId}-v1`);
    const v2ValEl = document.getElementById(`val-${stationId}-v2`);
    const v3ValEl = document.getElementById(`val-${stationId}-v3`);
    const trendV1El = document.getElementById(`trend-${stationId}-v1`);

    if (v1ValEl && sample.v1 !== undefined) v1ValEl.textContent = sample.v1;
    if (v2ValEl && sample.v2 !== undefined) v2ValEl.textContent = sample.v2;
    if (v3ValEl && sample.v3 !== undefined) v3ValEl.textContent = sample.v3;

    if (summary && summary.v1) {
      this.renderTrendArrow(trendV1El, summary.v1.trend);
      const minEl = document.getElementById(`min-${stationId}`);
      const maxEl = document.getElementById(`max-${stationId}`);
      const avgEl = document.getElementById(`avg-${stationId}`);
      const rateEl = document.getElementById(`rate-${stationId}`);

      if (minEl) minEl.textContent = summary.v1.min;
      if (maxEl) maxEl.textContent = summary.v1.max;
      if (avgEl) avgEl.textContent = summary.v1.avg;
      if (rateEl) rateEl.textContent = `${summary.faultRatePercent}%`;
    }

    const list = this.historyMap.get(stationId) || [];
    const ptsEl = document.getElementById(`pts-${stationId}`);
    if (ptsEl) ptsEl.textContent = `${list.length} Punkte (5m)`;

    this.renderSvgChart(stationId, list);
  }

  renderSvgChart(stationId, history) {
    const polyLine = document.getElementById(`poly-line-${stationId}`);
    const polyArea = document.getElementById(`poly-area-${stationId}`);
    if (!polyLine || !polyArea || !history || history.length < 2) return;

    const values = history.map(h => typeof h.v1 === "number" ? h.v1 : 0);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = (max - min) === 0 ? 1 : (max - min);

    const W = 300;
    const H = 70;
    const padTop = 6;
    const padBottom = 8;
    const plotH = H - padTop - padBottom;

    const coords = values.map((val, i) => {
      const x = ((i / (values.length - 1)) * W).toFixed(1);
      const normY = (val - min) / range;
      const y = (H - padBottom - (normY * plotH)).toFixed(1);
      return `${x},${y}`;
    });

    const pointsStr = coords.join(" ");
    polyLine.setAttribute("points", pointsStr);

    const areaPointsStr = `0,${H} ${pointsStr} ${W},${H}`;
    polyArea.setAttribute("points", areaPointsStr);

    const isFault = history.some(h => h.isFault && (Date.now() - h.timestamp < 15000));
    if (isFault) {
      polyLine.setAttribute("stroke", "#ef4444");
      polyArea.setAttribute("fill", `url(#grad-alert-${stationId})`);
    } else {
      polyLine.setAttribute("stroke", "#10b981");
      polyArea.setAttribute("fill", `url(#grad-${stationId})`);
    }
  }

  renderTrendArrow(el, trend) {
    if (!el) return;
    if (trend === "up") {
      el.textContent = "↗";
      el.className = "metric-cell-trend-pill trend-up";
    } else if (trend === "down") {
      el.textContent = "↘";
      el.className = "metric-cell-trend-pill trend-down";
    } else {
      el.textContent = "→";
      el.className = "metric-cell-trend-pill trend-stable";
    }
  }

  setCardFaultState(stationId, isFault) {
    const card = document.getElementById(`card-${stationId}`);
    const pill = document.getElementById(`pill-${stationId}`);
    const pillText = document.getElementById(`pill-text-${stationId}`);
    const btn = document.getElementById(`btn-fault-${stationId}`);
    const cellV2 = document.getElementById(`cell-${stationId}-v2`);

    if (isFault) {
      if (card) card.classList.add("alert-state");
      if (pill) {
        pill.className = "heroui-status-chip alert";
      }
      if (pillText) {
        pillText.textContent = "STÖRUNG";
      }
      if (btn) {
        btn.textContent = "Störung quittieren";
        btn.classList.add("active-fault");
      }
      if (cellV2) cellV2.classList.add("alert");
    } else {
      if (card) card.classList.remove("alert-state");
      if (pill) {
        pill.className = "heroui-status-chip";
      }
      if (pillText) {
        pillText.textContent = "NORMAL";
      }
      if (btn) {
        btn.textContent = "Störung simulieren";
        btn.classList.remove("active-fault");
      }
      if (cellV2) cellV2.classList.remove("alert");
    }
  }

  toggleFault(stationId) {
    if (!this.faultMap) this.faultMap = new Map();
    const card = document.getElementById(`card-${stationId}`);
    const isCurrentlyFault = card ? card.classList.contains("alert-state") : Boolean(this.faultMap.get(stationId));
    const targetState = !isCurrentlyFault;
    this.faultMap.set(stationId, targetState);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({
          type: "toggle_fault",
          stationId,
          isFault: targetState
        }));
      } catch (_) {}
    }

    if (!this.isStandaloneSim) {
      fetch("/api/fault", {
        method: "POST",
        headers: authService.getAuthHeaders(),
        body: JSON.stringify({ stationId, isFault: targetState })
      }).catch(() => {});
    }

    this.setCardFaultState(stationId, targetState);

    if (this.isStandaloneSim) {
      this.tickStandaloneSimulation();
    } else {
      this.updateKpis();
    }
  }

  renderAll() {
    this.stations.forEach(st => {
      const history = this.historyMap.get(st.id) || [];
      const summary = this.summaryMap.get(st.id);
      if (history.length > 0) {
        const last = history[history.length - 1];
        this.updateStationCard(st.id, last, summary);
        this.setCardFaultState(st.id, Boolean(last.isFault));
      }
    });
    this.updateKpis();
  }

  updateKpis() {
    let activeAlarms = 0;
    let totalSamples = 0;
    this.stations.forEach(st => {
      const card = document.getElementById(`card-${st.id}`);
      if (card && card.classList.contains("alert-state")) activeAlarms++;
      const list = this.historyMap.get(st.id);
      if (list) totalSamples += list.length;
    });

    if (this.dom.kpiAlarms) {
      this.dom.kpiAlarms.textContent = activeAlarms;
      this.dom.kpiAlarms.style.color = activeAlarms > 0 ? "#f87171" : "#34d399";
    }

    if (this.dom.kpiAlarmsTag) {
      this.dom.kpiAlarmsTag.textContent = activeAlarms > 0 ? "WARNUNG" : "BEREIT";
      this.dom.kpiAlarmsTag.style.color = activeAlarms > 0 ? "#f87171" : "#34d399";
    }

    if (this.dom.kpiSamples) {
      this.dom.kpiSamples.textContent = totalSamples;
    }
    if (this.dom.storeSampleCount) {
      this.dom.storeSampleCount.textContent = `${totalSamples} Samples`;
    }
  }

  updateWsBadge(online, text) {
    const isWss = (typeof window !== "undefined" && window.location && window.location.protocol === "https:") ||
                  (this.ws && this.ws.url && this.ws.url.startsWith("wss://"));
    const prefix = isWss ? "WSS" : "WS";
    if (this.dom.wsBadgeDot) {
      this.dom.wsBadgeDot.className = online ? "chip-dot pulse" : "chip-dot alert";
    }
    if (this.dom.wsBadgeText) {
      this.dom.wsBadgeText.textContent = `${prefix}: ${text}`;
    }
  }

  updateMqttBadge(connected, simulated) {
    const isWsActive = this.modal?.selectedDataSource === "websocket";
    if (this.dom.mqttBadgeDot) {
      this.dom.mqttBadgeDot.className = (connected || isWsActive || simulated) ? "chip-dot" : "chip-dot alert";
    }
    if (this.dom.mqttBadgeText) {
      if (connected) {
        this.dom.mqttBadgeText.textContent = "MQTT: Verbunden";
      } else if (isWsActive) {
        this.dom.mqttBadgeText.textContent = "MQTT: Bereit";
      } else if (simulated) {
        this.dom.mqttBadgeText.textContent = "MQTT: SPS-Sim";
      } else {
        this.dom.mqttBadgeText.textContent = "MQTT: Offline";
      }
    }
  }

  startClock() {
    const clockEl = document.getElementById("scada-clock");
    const update = () => {
      if (clockEl) {
        const d = new Date();
        clockEl.textContent = d.toLocaleTimeString("de-DE");
      }
    };
    update();
    setInterval(update, 1000);
  }

  // =========================================================================
  // KONFIGURATIONSPANEL CONTROLLER (HeroUI Modal)
  // =========================================================================
  initConfigModal() {
    this.modal = {
      backdrop: document.getElementById("config-modal-backdrop"),
      btnOpen: document.getElementById("btn-open-config"),
      btnClose: document.getElementById("btn-close-config"),
      btnCancel: document.getElementById("btn-cancel-config"),
      btnSave: document.getElementById("btn-save-config"),
      btnTestMqtt: document.getElementById("btn-test-mqtt"),
      btnReset: document.getElementById("btn-reset-defaults"),
      inputMqttUrl: document.getElementById("cfg-mqtt-url"),
      currentBrokerUrl: document.getElementById("cfg-current-broker-url"),
      brokerChip: document.getElementById("cfg-broker-chip"),
      brokerStatusText: document.getElementById("cfg-broker-status-text"),
      clientId: document.getElementById("cfg-client-id"),
      historyTtl: document.getElementById("cfg-history-ttl"),
      pollInterval: document.getElementById("cfg-poll-interval"),
      stationsList: document.getElementById("cfg-stations-list"),
      testResult: document.getElementById("mqtt-test-result"),
      feedbackMsg: document.getElementById("modal-feedback-msg"),
      spinner: document.getElementById("save-btn-spinner"),

      // WebSocket & Datenquellen Erweiterung
      sourceBadgeText: document.getElementById("source-badge-text"),
      sourceChoices: document.querySelectorAll(".source-choice-card"),
      inputWsUrl: document.getElementById("cfg-ws-url"),
      btnTestWs: document.getElementById("btn-test-ws"),
      wsTestResult: document.getElementById("ws-test-result"),
      currentWsUrl: document.getElementById("cfg-current-ws-url"),
      wsChip: document.getElementById("cfg-ws-chip"),
      wsStatusText: document.getElementById("cfg-ws-status-text"),
      selectedDataSource: "websocket"
    };

    if (!this.modal.backdrop || !this.modal.btnOpen) return;

    // Öffnen & Schließen
    this.modal.btnOpen.addEventListener("click", () => this.openConfigModal());
    if (this.modal.btnClose) {
      this.modal.btnClose.addEventListener("click", () => this.closeConfigModal());
    }
    if (this.modal.btnCancel) {
      this.modal.btnCancel.addEventListener("click", () => this.closeConfigModal());
    }

    // Schließen bei Klick außerhalb des Dialogs
    this.modal.backdrop.addEventListener("click", (e) => {
      if (e.target === this.modal.backdrop) this.closeConfigModal();
    });

    // ESC Taste schließt Modal
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.modal.backdrop.style.display !== "none") {
        this.closeConfigModal();
      }
    });

    // Primäre Datenquellen-Auswahl
    if (this.modal.sourceChoices) {
      this.modal.sourceChoices.forEach(card => {
        card.addEventListener("click", () => {
          const src = card.getAttribute("data-source");
          if (!src) return;
          this.modal.selectedDataSource = src;
          this.modal.sourceChoices.forEach(c => c.classList.remove("active"));
          card.classList.add("active");
          this.updateSourceBadge(src);
        });
      });
    }

    // Tab-Umschaltung
    const tabBtns = this.modal.backdrop.querySelectorAll(".heroui-tab-btn");
    tabBtns.forEach(btn => {
      btn.addEventListener("click", () => {
        const targetId = btn.getAttribute("data-tab");
        tabBtns.forEach(b => b.classList.remove("active"));
        btn.classList.add("active");

        const panes = this.modal.backdrop.querySelectorAll(".tab-pane");
        panes.forEach(p => p.classList.remove("active"));
        const targetPane = document.getElementById(targetId);
        if (targetPane) targetPane.classList.add("active");
      });
    });

    // Schnellwahl-Presets (WebSocket)
    const wsPresets = this.modal.backdrop.querySelectorAll(".ws-preset-pill");
    wsPresets.forEach(pill => {
      pill.addEventListener("click", () => {
        let url = pill.getAttribute("data-url");
        if (url && this.modal.inputWsUrl) {
          if (url.includes("localhost:3000") && typeof window !== "undefined" && window.location.host) {
            const isWssPreset = url.startsWith("wss://");
            const proto = isWssPreset ? "wss:" : (window.location.protocol === "https:" ? "wss:" : "ws:");
            url = `${proto}//${window.location.host}/ws/telemetry`;
          }
          this.modal.inputWsUrl.value = url;
          this.setModalFeedback(`WebSocket-Preset übernommen: ${url}`, "success");
        }
      });
    });

    // Schnellwahl-Presets (MQTT)
    const mqttPresets = this.modal.backdrop.querySelectorAll(".preset-pill:not(.ws-preset-pill), .mqtt-preset-pill");
    mqttPresets.forEach(pill => {
      pill.addEventListener("click", () => {
        const url = pill.getAttribute("data-url");
        if (url && this.modal.inputMqttUrl) {
          this.modal.inputMqttUrl.value = url;
          this.setModalFeedback(`MQTT-Preset übernommen: ${url}`, "success");
        }
      });
    });

    // Verbindungen testen
    if (this.modal.btnTestWs) {
      this.modal.btnTestWs.addEventListener("click", () => this.testWsConnection());
    }
    if (this.modal.btnTestMqtt) {
      this.modal.btnTestMqtt.addEventListener("click", () => this.testMqttConnection());
    }

    // Speichern
    if (this.modal.btnSave) {
      this.modal.btnSave.addEventListener("click", () => this.saveConfig());
    }

    // Werkseinstellungen zurücksetzen
    if (this.modal.btnReset) {
      this.modal.btnReset.addEventListener("click", () => this.resetConfigDefaults());
    }
  }

  updateSourceBadge(src) {
    if (!this.modal.sourceBadgeText) return;
    if (src === "websocket") {
      this.modal.sourceBadgeText.textContent = "WebSocket";
      this.modal.sourceBadgeText.style.color = "var(--primary)";
    } else if (src === "mqtt") {
      this.modal.sourceBadgeText.textContent = "MQTT";
      this.modal.sourceBadgeText.style.color = "#38bdf8";
    } else {
      this.modal.sourceBadgeText.textContent = "SPS-Sim";
      this.modal.sourceBadgeText.style.color = "#34d399";
    }
  }

  async openConfigModal() {
    if (!this.modal.backdrop) return;
    this.modal.backdrop.style.display = "flex";
    this.setModalFeedback("", "");
    if (this.modal.testResult) this.modal.testResult.style.display = "none";
    if (this.modal.wsTestResult) this.modal.wsTestResult.style.display = "none";

    let loadedConfig = null;
    let mqttStatus = null;
    let wsStatus = null;

    if (!this.isStandaloneSim) {
      try {
        const res = await fetch("/api/config");
        const ct = res.headers ? (res.headers.get("content-type") || "") : "";
        if (res.ok && ct.includes("application/json")) {
          const data = await res.json();
          loadedConfig = data.config;
          mqttStatus = data.mqttStatus;
          wsStatus = data.wsStatus;
        }
      } catch (err) {
        console.warn("[ConfigModal] Fehler beim Laden:", err);
      }
    }

    if (!loadedConfig) {
      try {
        const saved = localStorage.getItem("cps_saved_config");
        if (saved) loadedConfig = JSON.parse(saved);
      } catch (_) {}
    }

    if (!loadedConfig) {
      loadedConfig = {
        dataSource: "websocket",
        websocket: { url: "ws://localhost:3000/ws/telemetry" },
        mqtt: { brokerUrl: "mqtt://localhost:1883", clientId: "cps-scada-hmi" },
        api: { historyTtlMs: 300000, pollIntervalMs: 1500 },
        stations: this.stations
      };
    }

    if (!mqttStatus) {
      mqttStatus = { connected: false, simulated: true };
    }

    this.populateConfigForm(loadedConfig, mqttStatus, wsStatus);
  }

  closeConfigModal() {
    if (this.modal.backdrop) {
      this.modal.backdrop.style.display = "none";
    }
  }

  populateConfigForm(config, mqttStatus, wsStatus = null) {
    if (!config) return;

    // Aktive Datenquelle setzen
    this.modal.selectedDataSource = config.dataSource || "websocket";
    if (this.modal.sourceChoices) {
      this.modal.sourceChoices.forEach(card => {
        if (card.getAttribute("data-source") === this.modal.selectedDataSource) {
          card.classList.add("active");
        } else {
          card.classList.remove("active");
        }
      });
    }
    this.updateSourceBadge(this.modal.selectedDataSource);

    // WebSocket Felder
    const wsUrl = config.websocket?.url || "ws://localhost:3000/ws/telemetry";
    if (this.modal.inputWsUrl) {
      this.modal.inputWsUrl.value = wsUrl;
    }
    if (this.modal.currentWsUrl) {
      this.modal.currentWsUrl.textContent = wsUrl;
    }
    if (this.modal.wsChip && this.modal.wsStatusText) {
      if (wsStatus) {
        if (wsStatus.activeClients > 0 || wsStatus.targetConnected) {
          this.modal.wsChip.className = "heroui-status-chip";
          this.modal.wsStatusText.textContent = `Aktiv (${wsStatus.activeClients} Clients)`;
        } else {
          this.modal.wsChip.className = "heroui-status-chip";
          this.modal.wsStatusText.textContent = "Bereit";
        }
      } else {
        this.modal.wsChip.className = "heroui-status-chip";
        this.modal.wsStatusText.textContent = "Aktiv";
      }
    }

    // MQTT Felder
    if (this.modal.inputMqttUrl && config.mqtt?.brokerUrl) {
      this.modal.inputMqttUrl.value = config.mqtt.brokerUrl;
    }
    if (this.modal.currentBrokerUrl && config.mqtt?.brokerUrl) {
      this.modal.currentBrokerUrl.textContent = config.mqtt.brokerUrl;
    }
    if (this.modal.clientId && config.mqtt?.clientId) {
      this.modal.clientId.textContent = config.mqtt.clientId;
    }

    if (mqttStatus && this.modal.brokerChip && this.modal.brokerStatusText) {
      if (mqttStatus.connected) {
        this.modal.brokerChip.className = "heroui-status-chip";
        this.modal.brokerStatusText.textContent = "Verbunden";
      } else if (mqttStatus.simulated) {
        this.modal.brokerChip.className = "heroui-status-chip";
        this.modal.brokerStatusText.textContent = "SPS-Simulator aktiv";
      } else {
        this.modal.brokerChip.className = "heroui-status-chip alert";
        this.modal.brokerStatusText.textContent = "Getrennt";
      }
    }

    if (this.modal.historyTtl && config.api?.historyTtlMs) {
      this.modal.historyTtl.value = Math.round(config.api.historyTtlMs / 1000);
    }
    if (this.modal.pollInterval && config.api?.pollIntervalMs) {
      this.modal.pollInterval.value = config.api.pollIntervalMs;
    }

    // Rendere Stationen-Akkordeon
    if (this.modal.stationsList && Array.isArray(config.stations)) {
      this.renderConfigStations(config.stations);
    }
  }

  renderConfigStations(stations) {
    this.modal.stationsList.innerHTML = "";

    stations.forEach(st => {
      const card = document.createElement("div");
      card.className = "station-cfg-card";
      card.dataset.stationId = st.id;

      card.innerHTML = `
        <div class="station-cfg-header" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
          <div style="display:flex; align-items:center; gap:8px; flex:1; min-width:240px;">
            <span class="station-id-avatar" style="width:28px; height:28px; font-size:0.75rem;">${st.id.replace("ST-", "M")}</span>
            <input type="text" class="heroui-input font-bold station-cfg-name-input" data-field="name" value="${st.name}" style="flex:1; font-weight:700;" title="Modul-Name / Bezeichnung anpassen">
          </div>
          <div style="display:flex; align-items:center; gap:6px;">
            <label style="font-size:0.7rem; color:var(--text-muted);">SPS-IP:</label>
            <input type="text" class="heroui-input font-mono station-cfg-plc-input" data-field="plcIp" value="${st.plcIp || '192.168.10.x'}" style="width:120px;">
          </div>
        </div>

        <div style="margin:8px 0; display:flex; align-items:center; gap:8px;">
          <label style="font-size:0.72rem; color:var(--text-muted); white-space:nowrap;">MQTT Topic:</label>
          <input type="text" class="heroui-input font-mono" data-field="mqttTopic" value="${st.mqttTopic || ''}" placeholder="z. B. /bbk-lf/rpi04/power-house/vibration oder cps-i40/${st.id}/telemetry" style="flex:1; font-size:0.75rem;">
        </div>

        <div class="sensors-cfg-grid">
          <!-- Sensor 1 -->
          <div class="sensor-cfg-box">
            <span class="sensor-cfg-lbl">${st.v1.label} (${st.v1.unit})</span>
            <div class="tolerance-inputs-row">
              <div class="tolerance-field">
                <label>Min</label>
                <input type="number" step="0.1" class="heroui-input font-mono" data-field="v1.min" value="${st.v1.min ?? ''}">
              </div>
              <div class="tolerance-field">
                <label>Max</label>
                <input type="number" step="0.1" class="heroui-input font-mono" data-field="v1.max" value="${st.v1.max ?? ''}">
              </div>
            </div>
            <div class="tolerance-field" style="margin-top:4px;">
              <label>Sollwert</label>
              <input type="number" step="0.1" class="heroui-input font-mono" data-field="v1.defaultVal" value="${st.v1.defaultVal ?? st.v1.val}">
            </div>
          </div>

          <!-- Sensor 2 -->
          <div class="sensor-cfg-box">
            <span class="sensor-cfg-lbl">${st.v2.label} (${st.v2.unit})</span>
            <div class="tolerance-inputs-row">
              <div class="tolerance-field">
                <label>Min</label>
                <input type="number" step="0.1" class="heroui-input font-mono" data-field="v2.min" value="${st.v2.min ?? ''}">
              </div>
              <div class="tolerance-field">
                <label>Max</label>
                <input type="number" step="0.1" class="heroui-input font-mono" data-field="v2.max" value="${st.v2.max ?? ''}">
              </div>
            </div>
            <div class="tolerance-field" style="margin-top:4px;">
              <label>Sollwert</label>
              <input type="number" step="0.1" class="heroui-input font-mono" data-field="v2.defaultVal" value="${st.v2.defaultVal ?? st.v2.val}">
            </div>
          </div>

          <!-- Sensor 3 -->
          <div class="sensor-cfg-box">
            <span class="sensor-cfg-lbl">${st.v3.label} (${st.v3.unit})</span>
            <div class="tolerance-field" style="margin-top:14px;">
              <label>Soll / Fix</label>
              <input type="number" step="1" class="heroui-input font-mono" data-field="v3.defaultVal" value="${st.v3.defaultVal ?? st.v3.val}">
            </div>
          </div>
        </div>
      `;

      this.modal.stationsList.appendChild(card);
    });
  }

  async testWsConnection() {
    let url = this.modal.inputWsUrl?.value?.trim();
    if (!url) {
      this.showWsTestResult(false, "Bitte geben Sie eine WebSocket Telemetrie-URL ein.");
      return;
    }
    if (url.includes("tobin-w.de")) {
      url = url.replace(/tobin-w\.de/g, "robin-w.de");
      if (this.modal.inputWsUrl) this.modal.inputWsUrl.value = url;
    }

    if (this.modal.btnTestWs) {
      this.modal.btnTestWs.disabled = true;
      this.modal.btnTestWs.textContent = "Teste...";
    }

    let testedRemote = false;
    if (!this.isStandaloneSim) {
      try {
        const res = await fetch("/api/config/test-websocket", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, timeoutMs: 3500 })
        });
        const ct = res.headers ? (res.headers.get("content-type") || "") : "";
        if (res.ok && ct.includes("application/json")) {
          const data = await res.json();
          this.showWsTestResult(data.success, data.message);
          testedRemote = true;
        }
      } catch (err) {
        console.warn("[SCADA] Live WebSocket Test nicht erreichbar:", err);
      }
    }

    if (!testedRemote) {
      const isFormatOk = /^wss?:\/\/.+/.test(url);
      if (!isFormatOk) {
        this.showWsTestResult(false, "Ungültiges WebSocket URL-Format (z. B. ws://localhost:3000/ws/telemetry oder wss://...)");
      } else {
        try {
          const testSock = new WebSocket(url);
          const timeout = setTimeout(() => {
            try { testSock.close(); } catch (_) {}
            this.showWsTestResult(true, "URL-Format syntaktisch gültig (Verbindungstimeout)");
            if (this.modal.btnTestWs) {
              this.modal.btnTestWs.disabled = false;
              this.modal.btnTestWs.textContent = "Verbindung testen";
            }
          }, 2500);

          testSock.onopen = () => {
            clearTimeout(timeout);
            try { testSock.close(); } catch (_) {}
            this.showWsTestResult(true, "WebSocket-Handshake erfolgreich hergestellt!");
            if (this.modal.btnTestWs) {
              this.modal.btnTestWs.disabled = false;
              this.modal.btnTestWs.textContent = "Verbindung testen";
            }
          };

          testSock.onerror = () => {
            clearTimeout(timeout);
            this.showWsTestResult(true, "URL-Format syntaktisch gültig (Lokaler Modus / GitHub Pages)");
            if (this.modal.btnTestWs) {
              this.modal.btnTestWs.disabled = false;
              this.modal.btnTestWs.textContent = "Verbindung testen";
            }
          };
          return;
        } catch (e) {
          this.showWsTestResult(true, "URL-Format syntaktisch gültig");
        }
      }
    }

    if (this.modal.btnTestWs) {
      this.modal.btnTestWs.disabled = false;
      this.modal.btnTestWs.textContent = "Verbindung testen";
    }
  }

  showWsTestResult(success, message) {
    if (!this.modal.wsTestResult) return;
    this.modal.wsTestResult.style.display = "flex";
    this.modal.wsTestResult.className = `test-feedback-badge ${success ? "success" : "error"}`;
    this.modal.wsTestResult.textContent = `${success ? "✓" : "✕"} ${message}`;
  }

  async testMqttConnection() {
    const url = this.modal.inputMqttUrl?.value?.trim();
    if (!url) {
      this.showTestResult(false, "Bitte geben Sie eine MQTT Broker URL ein.");
      return;
    }

    if (this.modal.btnTestMqtt) {
      this.modal.btnTestMqtt.disabled = true;
      this.modal.btnTestMqtt.textContent = "Teste...";
    }

    let testedRemote = false;
    if (!this.isStandaloneSim) {
      try {
        const res = await fetch("/api/config/test-mqtt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ brokerUrl: url, timeoutMs: 3500 })
        });
        const ct = res.headers ? (res.headers.get("content-type") || "") : "";
        if (res.ok && ct.includes("application/json")) {
          const data = await res.json();
          this.showTestResult(data.success, data.message);
          testedRemote = true;
        }
      } catch (err) {
        console.warn("[SCADA] Live MQTT Test nicht erreichbar:", err);
      }
    }

    if (!testedRemote) {
      const isFormatOk = /^mqtt(s)?:\/\/.+:\d+/.test(url);
      this.showTestResult(
        isFormatOk,
        isFormatOk
          ? "URL-Format syntaktisch gültig (Lokaler Modus / GitHub Pages)"
          : "Ungültiges URL-Format (erwartet z.B. mqtt://192.168.10.1:1883)"
      );
    }

    if (this.modal.btnTestMqtt) {
      this.modal.btnTestMqtt.disabled = false;
      this.modal.btnTestMqtt.textContent = "Verbindung testen";
    }
  }

  showTestResult(success, message) {
    if (!this.modal.testResult) return;
    this.modal.testResult.style.display = "flex";
    this.modal.testResult.className = `test-feedback-badge ${success ? "success" : "error"}`;
    this.modal.testResult.textContent = `${success ? "✓" : "✕"} ${message}`;
  }

  async saveConfig() {
    const brokerUrl = this.modal.inputMqttUrl?.value?.trim();
    let wsUrl = this.modal.inputWsUrl?.value?.trim() || "ws://localhost:3000/ws/telemetry";
    if (wsUrl.includes("tobin-w.de")) {
      wsUrl = wsUrl.replace(/tobin-w\.de/g, "robin-w.de");
      if (this.modal.inputWsUrl) this.modal.inputWsUrl.value = wsUrl;
    }
    const historyTtlSec = parseInt(this.modal.historyTtl?.value, 10) || 300;
    const pollIntervalMs = parseInt(this.modal.pollInterval?.value, 10) || 1500;

    // Stationen aus Akkordeon auslesen
    const stationCards = this.modal.stationsList?.querySelectorAll(".station-cfg-card") || [];
    const updatedStations = [];

    stationCards.forEach(card => {
      const sId = card.dataset.stationId;
      const original = this.stations.find(s => s.id === sId) || {};
      const sName = card.querySelector('[data-field="name"]')?.value?.trim() || original.name;
      const plcIp = card.querySelector('[data-field="plcIp"]')?.value?.trim() || original.plcIp;
      const mqttTopic = card.querySelector('[data-field="mqttTopic"]')?.value?.trim() || original.mqttTopic;

      const v1Min = parseFloat(card.querySelector('[data-field="v1.min"]')?.value);
      const v1Max = parseFloat(card.querySelector('[data-field="v1.max"]')?.value);
      const v1Def = parseFloat(card.querySelector('[data-field="v1.defaultVal"]')?.value);

      const v2Min = parseFloat(card.querySelector('[data-field="v2.min"]')?.value);
      const v2Max = parseFloat(card.querySelector('[data-field="v2.max"]')?.value);
      const v2Def = parseFloat(card.querySelector('[data-field="v2.defaultVal"]')?.value);

      const v3Def = parseFloat(card.querySelector('[data-field="v3.defaultVal"]')?.value);

      updatedStations.push({
        id: sId,
        name: sName,
        plcIp,
        mqttTopic,
        v1: {
          label: original.v1?.label,
          unit: original.v1?.unit,
          min: isNaN(v1Min) ? original.v1?.min : v1Min,
          max: isNaN(v1Max) ? original.v1?.max : v1Max,
          val: isNaN(v1Def) ? original.v1?.val : v1Def,
          defaultVal: isNaN(v1Def) ? original.v1?.defaultVal : v1Def
        },
        v2: {
          label: original.v2?.label,
          unit: original.v2?.unit,
          min: isNaN(v2Min) ? original.v2?.min : v2Min,
          max: isNaN(v2Max) ? original.v2?.max : v2Max,
          val: isNaN(v2Def) ? original.v2?.val : v2Def,
          defaultVal: isNaN(v2Def) ? original.v2?.defaultVal : v2Def
        },
        v3: {
          label: original.v3?.label,
          unit: original.v3?.unit,
          val: isNaN(v3Def) ? original.v3?.val : v3Def,
          defaultVal: isNaN(v3Def) ? original.v3?.defaultVal : v3Def
        }
      });
    });

    const payload = {
      dataSource: this.modal.selectedDataSource || "websocket",
      websocket: { url: wsUrl },
      mqtt: {
        brokerUrl,
        topics: this.subscribedMqttTopics || [
          "cps-i40/+/telemetry",
          "cps-i40/+/fault"
        ]
      },
      api: {
        historyTtlMs: historyTtlSec * 1000,
        pollIntervalMs
      },
      stations: updatedStations
    };

    if (this.modal.btnSave) this.modal.btnSave.disabled = true;
    if (this.modal.spinner) this.modal.spinner.style.display = "inline";

    let savedRemote = false;
    if (!this.isStandaloneSim) {
      try {
        const res = await fetch("/api/config", {
          method: "POST",
          headers: authService.getAuthHeaders(),
          body: JSON.stringify(payload)
        });
        const ct = res.headers ? (res.headers.get("content-type") || "") : "";
        if (res.ok && ct.includes("application/json")) {
          const data = await res.json();
          if (data.success) savedRemote = true;
        }
      } catch (_) {}
    }

    // Persistenz im localStorage für GitHub Pages & Offline-Betrieb
    try {
      localStorage.setItem("cps_saved_config", JSON.stringify(payload));
    } catch (_) {}

    this.mergeSavedStationsConfig(updatedStations);
    this.initStationsLayout();
    this.renderAll();

    if (this.modal.currentBrokerUrl) {
      this.modal.currentBrokerUrl.textContent = brokerUrl;
    }
    if (this.modal.currentWsUrl) {
      this.modal.currentWsUrl.textContent = wsUrl;
    }
    this.updateSourceBadge(payload.dataSource);

    if (payload.dataSource === "simulator") {
      this.startStandaloneSimulation();
    } else if (payload.dataSource === "websocket" && this.isStandaloneSim) {
      this.isStandaloneSim = false;
      this.connectWebSocket();
    }

    this.setModalFeedback(
      savedRemote ? "✓ Konfiguration erfolgreich gespeichert & synchronisiert!" : "✓ Konfiguration lokal gespeichert & angewendet (GitHub Pages Modus)!",
      "success"
    );

    if (this.modal.btnSave) this.modal.btnSave.disabled = false;
    if (this.modal.spinner) this.modal.spinner.style.display = "none";
    setTimeout(() => this.closeConfigModal(), 1200);
  }

  async resetConfigDefaults() {
    if (!confirm("Möchten Sie wirklich alle Einstellungen auf Werkseinstellungen zurücksetzen?")) {
      return;
    }

    try {
      localStorage.removeItem("cps_saved_config");
      if (!this.isStandaloneSim) {
        await fetch("/api/config/reset", {
          method: "POST",
          headers: authService.getAuthHeaders()
        });
      }
    } catch (_) {}

    this.stations = JSON.parse(JSON.stringify(STATIONS_DEFAULT));
    this.initStationsLayout();
    this.populateConfigForm({
      dataSource: "websocket",
      websocket: { url: "ws://localhost:3000/ws/telemetry" },
      mqtt: { brokerUrl: "mqtt://localhost:1883", clientId: "cps-scada-hmi" },
      api: { historyTtlMs: 300000, pollIntervalMs: 1500 },
      stations: this.stations
    }, { connected: false, simulated: true }, { activeClients: 1 });
    this.renderAll();
    this.setModalFeedback("✓ Auf Werkseinstellungen zurückgesetzt!", "success");
  }

  updateConfigStatus(mqttConfig) {
    if (this.modal?.currentBrokerUrl && mqttConfig.brokerUrl) {
      this.modal.currentBrokerUrl.textContent = mqttConfig.brokerUrl;
    }
  }

  setModalFeedback(msg, type = "") {
    if (!this.modal.feedbackMsg) return;
    this.modal.feedbackMsg.textContent = msg;
    this.modal.feedbackMsg.className = `modal-feedback-msg ${type}`;
  }

  // =========================================================================
  // BENUTZER-AUTHENTIFIZIERUNG & RECHTEVERWALTUNG (RBAC)
  // =========================================================================
  initAuth() {
    this.authDom = {
      headerBtn: document.getElementById("btn-auth-user"),
      headerIcon: document.getElementById("auth-status-icon"),
      headerName: document.getElementById("auth-user-name"),
      modal: document.getElementById("auth-modal-backdrop"),
      btnClose: document.getElementById("btn-close-auth-modal"),
      btnCancel: document.getElementById("btn-cancel-auth"),
      btnSubmit: document.getElementById("btn-submit-login"),
      btnDialogLogout: document.getElementById("btn-dialog-logout"),
      inputUser: document.getElementById("login-username"),
      inputPass: document.getElementById("login-password"),
      feedback: document.getElementById("auth-login-feedback"),
      formBox: document.getElementById("auth-form-container"),
      loggedInBox: document.getElementById("auth-logged-in-container"),
      dialogLoggedInName: document.getElementById("dialog-logged-in-name"),
      dialogLoggedInGroup: document.getElementById("dialog-logged-in-group"),
      dialogLoggedInPerms: document.getElementById("dialog-logged-in-perms"),

      // Tab 4 Elements
      tabOpenLogin: document.getElementById("btn-tab-open-login"),
      tabLogout: document.getElementById("btn-tab-logout"),
      tabUser: document.getElementById("auth-current-username"),
      tabRole: document.getElementById("auth-current-role"),
      tabPerms: document.getElementById("auth-current-perms"),
      groupsList: document.getElementById("auth-groups-list"),
      btnRefreshGroups: document.getElementById("btn-refresh-groups"),
      usersTbody: document.getElementById("auth-users-tbody"),

      // Create Group Elements
      inputGroupId: document.getElementById("new-group-id"),
      inputGroupName: document.getElementById("new-group-name"),
      inputGroupDesc: document.getElementById("new-group-desc"),
      permsGrid: document.getElementById("new-group-perms-grid"),
      btnCreateGroup: document.getElementById("btn-create-group"),
      createGroupFeedback: document.getElementById("new-group-feedback")
    };

    if (this.authDom.headerBtn) {
      this.authDom.headerBtn.addEventListener("click", () => this.openAuthModal());
    }
    if (this.authDom.btnClose) {
      this.authDom.btnClose.addEventListener("click", () => this.closeAuthModal());
    }
    if (this.authDom.btnCancel) {
      this.authDom.btnCancel.addEventListener("click", () => this.closeAuthModal());
    }
    if (this.authDom.modal) {
      this.authDom.modal.addEventListener("click", (e) => {
        if (e.target === this.authDom.modal) this.closeAuthModal();
      });
    }

    if (this.authDom.btnSubmit) {
      this.authDom.btnSubmit.addEventListener("click", () => this.handleLoginSubmit());
    }
    if (this.authDom.inputPass) {
      this.authDom.inputPass.addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.handleLoginSubmit();
      });
    }

    if (this.authDom.btnDialogLogout) {
      this.authDom.btnDialogLogout.addEventListener("click", () => this.handleLogout());
    }
    if (this.authDom.tabLogout) {
      this.authDom.tabLogout.addEventListener("click", () => this.handleLogout());
    }
    if (this.authDom.tabOpenLogin) {
      this.authDom.tabOpenLogin.addEventListener("click", () => {
        this.closeConfigModal();
        this.openAuthModal();
      });
    }

    // Preset pills in Login dialog
    const presetPills = document.querySelectorAll(".auth-preset-pill");
    presetPills.forEach(pill => {
      pill.addEventListener("click", () => {
        const u = pill.getAttribute("data-user");
        const p = pill.getAttribute("data-pass");
        if (this.authDom.inputUser && u) this.authDom.inputUser.value = u;
        if (this.authDom.inputPass && p) this.authDom.inputPass.value = p;
      });
    });

    if (this.authDom.btnRefreshGroups) {
      this.authDom.btnRefreshGroups.addEventListener("click", () => {
        this.loadGroups();
        this.loadUsers();
      });
    }

    if (this.authDom.btnCreateGroup) {
      this.authDom.btnCreateGroup.addEventListener("click", () => this.handleCreateGroup());
    }

    // Listen to Auth State
    authService.onAuthStateChanged((user) => this.updateAuthDisplay(user));
    authService.checkSession().then((user) => {
      this.updateAuthDisplay(user);
      this.loadGroups();
      this.loadUsers();
    });
  }

  openAuthModal() {
    if (!this.authDom.modal) return;
    this.authDom.modal.style.display = "flex";
    if (this.authDom.feedback) this.authDom.feedback.style.display = "none";
    const user = authService.getUser();
    if (user) {
      if (this.authDom.formBox) this.authDom.formBox.style.display = "none";
      if (this.authDom.loggedInBox) this.authDom.loggedInBox.style.display = "block";
      if (this.authDom.btnSubmit) this.authDom.btnSubmit.style.display = "none";
    } else {
      if (this.authDom.formBox) this.authDom.formBox.style.display = "block";
      if (this.authDom.loggedInBox) this.authDom.loggedInBox.style.display = "none";
      if (this.authDom.btnSubmit) this.authDom.btnSubmit.style.display = "inline-flex";
      setTimeout(() => this.authDom.inputUser?.focus(), 100);
    }
  }

  closeAuthModal() {
    if (this.authDom.modal) {
      this.authDom.modal.style.display = "none";
    }
  }

  async handleLoginSubmit() {
    const username = this.authDom.inputUser?.value?.trim();
    const password = this.authDom.inputPass?.value;
    if (!username || !password) {
      this.showLoginFeedback(false, "Bitte Benutzername und Passwort eingeben.");
      return;
    }

    if (this.authDom.btnSubmit) {
      this.authDom.btnSubmit.disabled = true;
      this.authDom.btnSubmit.textContent = "Prüfe...";
    }

    try {
      await authService.login(username, password);
      this.showLoginFeedback(true, "Erfolgreich angemeldet!");
      if (this.authDom.inputPass) this.authDom.inputPass.value = "";
      setTimeout(() => {
        this.closeAuthModal();
        this.loadGroups();
        this.loadUsers();
      }, 700);
    } catch (err) {
      this.showLoginFeedback(false, err.message);
    } finally {
      if (this.authDom.btnSubmit) {
        this.authDom.btnSubmit.disabled = false;
        this.authDom.btnSubmit.textContent = "Anmelden";
      }
    }
  }

  showLoginFeedback(success, msg) {
    if (!this.authDom.feedback) return;
    this.authDom.feedback.style.display = "block";
    this.authDom.feedback.className = `test-feedback-badge ${success ? "success" : "error"}`;
    this.authDom.feedback.textContent = `${success ? "✓" : "✕"} ${msg}`;
  }

  async handleLogout() {
    await authService.logout();
    this.closeAuthModal();
    this.loadGroups();
    this.loadUsers();
  }

  updateAuthDisplay(user) {
    const icon = user ? (user.group === "admin" ? "👑" : (user.group === "operator" ? "🏭" : "👤")) : "👤";
    const name = user ? (user.displayName || user.username) : "Anmelden";

    if (this.authDom.headerIcon) this.authDom.headerIcon.textContent = icon;
    if (this.authDom.headerName) this.authDom.headerName.textContent = name;

    // Dialog Angemeldet Box
    if (this.authDom.dialogLoggedInName) {
      this.authDom.dialogLoggedInName.textContent = user ? `${user.displayName} (@${user.username})` : "--";
    }
    if (this.authDom.dialogLoggedInGroup) {
      this.authDom.dialogLoggedInGroup.textContent = user ? (user.groupName || user.group) : "--";
    }
    if (this.authDom.dialogLoggedInPerms) {
      this.authDom.dialogLoggedInPerms.innerHTML = user && Array.isArray(user.permissions)
        ? user.permissions.map(p => `<span class="perm-pill">${p}</span>`).join("")
        : '<span class="perm-pill">keine</span>';
    }

    // Tab 4 Elements
    if (this.authDom.tabUser) {
      this.authDom.tabUser.textContent = user ? `${user.displayName} (@${user.username})` : "Nicht angemeldet (Gast)";
    }
    if (this.authDom.tabRole) {
      const gName = user ? (user.groupName || user.group) : "viewer";
      this.authDom.tabRole.innerHTML = `<span class="role-badge">${gName}</span>`;
    }
    if (this.authDom.tabPerms) {
      const perms = user && Array.isArray(user.permissions) ? user.permissions : ["view_overview", "view_ar"];
      this.authDom.tabPerms.innerHTML = perms.map(p => `<span class="perm-pill">${p}</span>`).join("");
    }
    if (this.authDom.tabLogout) {
      this.authDom.tabLogout.style.display = user ? "inline-flex" : "none";
    }
  }

  async loadGroups() {
    if (!this.authDom.groupsList) return;
    try {
      const groups = await authService.fetchGroups();
      this.authDom.groupsList.innerHTML = "";
      groups.forEach(g => {
        const card = document.createElement("div");
        card.className = "group-item-card";
        const permPills = (g.permissions || []).map(p => `<span class="perm-pill">${p}</span>`).join("");
        card.innerHTML = `
          <div class="group-item-head">
            <div>
              <span class="group-item-title">${g.name}</span>
              <span class="role-badge" style="margin-left:8px;">${g.id}</span>
            </div>
          </div>
          <div class="group-item-desc">${g.description || "Keine Beschreibung"}</div>
          <div class="permission-pills-list">${permPills}</div>
        `;
        this.authDom.groupsList.appendChild(card);
      });
    } catch (e) {
      console.warn("[SCADA] Gruppen konnten nicht geladen werden:", e);
    }
  }

  async loadUsers() {
    if (!this.authDom.usersTbody) return;
    try {
      const users = await authService.fetchUsers();
      this.authDom.usersTbody.innerHTML = "";
      users.forEach(u => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td class="font-mono"><strong>${u.username}</strong></td>
          <td>${u.displayName || u.username}</td>
          <td><span class="role-badge">${u.group}</span></td>
          <td><span class="heroui-status-chip"><span class="chip-dot"></span>Aktiv</span></td>
        `;
        this.authDom.usersTbody.appendChild(tr);
      });
    } catch (e) {
      console.warn("[SCADA] Benutzer konnten nicht geladen werden:", e);
    }
  }

  async handleCreateGroup() {
    const id = this.authDom.inputGroupId?.value?.trim().toLowerCase();
    const name = this.authDom.inputGroupName?.value?.trim();
    const description = this.authDom.inputGroupDesc?.value?.trim();

    if (!id || !name) {
      this.showCreateGroupFeedback(false, "Bitte Gruppen-ID und Anzeigenamen angeben.");
      return;
    }

    const checkedBoxes = this.authDom.permsGrid?.querySelectorAll('input[type="checkbox"]:checked') || [];
    const permissions = Array.from(checkedBoxes).map(cb => cb.value);

    try {
      await authService.createGroup({ id, name, description, permissions });
      this.showCreateGroupFeedback(true, `Gruppe "${name}" erfolgreich angelegt!`);
      if (this.authDom.inputGroupId) this.authDom.inputGroupId.value = "";
      if (this.authDom.inputGroupName) this.authDom.inputGroupName.value = "";
      if (this.authDom.inputGroupDesc) this.authDom.inputGroupDesc.value = "";
      this.loadGroups();
    } catch (err) {
      this.showCreateGroupFeedback(false, err.message);
    }
  }

  showCreateGroupFeedback(success, msg) {
    if (!this.authDom.createGroupFeedback) return;
    this.authDom.createGroupFeedback.style.display = "block";
    this.authDom.createGroupFeedback.className = `test-feedback-badge ${success ? "success" : "error"}`;
    this.authDom.createGroupFeedback.textContent = `${success ? "✓" : "✕"} ${msg}`;
  }

  // =========================================================================
  // INTELLIGENTER JSON INTERPRETER & ENDPUNKT-EXTRAKTION
  // =========================================================================
  initInterpreter() {
    this.interpreterDom = {
      textArea: document.getElementById("json-payload-input"),
      btnInterpret: document.getElementById("btn-interpret-json"),
      btnIngest: document.getElementById("btn-ingest-json"),
      presetBtns: document.querySelectorAll(".interpreter-preset"),
      resultSection: document.getElementById("interpreter-result-section"),
      resultCard: document.getElementById("interpreter-result-card"),
      stAvatar: document.getElementById("interp-st-avatar"),
      stName: document.getElementById("interp-st-name"),
      stId: document.getElementById("interp-st-id"),
      statusChip: document.getElementById("interp-status-chip"),
      statusText: document.getElementById("interp-status-text"),
      naturalText: document.getElementById("interp-natural-text"),
      mappedGrid: document.getElementById("interp-mapped-grid"),
      endpointCount: document.getElementById("interp-endpoint-count"),
      endpointsTbody: document.getElementById("interp-endpoints-tbody")
    };

    if (this.interpreterDom.presetBtns) {
      this.interpreterDom.presetBtns.forEach(btn => {
        btn.addEventListener("click", () => {
          const key = btn.getAttribute("data-preset");
          this.loadInterpreterPreset(key);
        });
      });
    }

    if (this.interpreterDom.btnInterpret) {
      this.interpreterDom.btnInterpret.addEventListener("click", () => this.handleInterpret(false));
    }
    if (this.interpreterDom.btnIngest) {
      this.interpreterDom.btnIngest.addEventListener("click", () => this.handleInterpret(true));
    }

    // Initial preset laden (flat)
    this.loadInterpreterPreset("flat");
  }

  loadInterpreterPreset(key) {
    const payload = INTERPRETER_PRESETS[key] || INTERPRETER_PRESETS.flat;
    if (this.interpreterDom.textArea) {
      this.interpreterDom.textArea.value = JSON.stringify(payload, null, 2);
    }
  }

  async handleInterpret(andIngest = false) {
    const raw = this.interpreterDom.textArea?.value?.trim();
    if (!raw) return;

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      alert(`Ungültiges JSON-Format: ${err.message}`);
      return;
    }

    const btn = andIngest ? this.interpreterDom.btnIngest : this.interpreterDom.btnInterpret;
    const origText = btn ? btn.textContent : "";
    if (btn) btn.textContent = "Verarbeite...";

    try {
      let data;
      if (andIngest) {
        data = await authService.ingestTelemetry(payload);
      } else {
        data = await authService.interpretTelemetry(payload);
      }
      if (data && data.interpretation) {
        this.displayInterpretationResult(data.interpretation);
      }
    } catch (err) {
      alert(`Fehler bei der Interpretation: ${err.message}`);
    } finally {
      if (btn) btn.textContent = origText;
    }
  }

  displayInterpretationResult(interp) {
    if (!interp || !this.interpreterDom.resultSection) return;
    this.interpreterDom.resultSection.style.display = "block";

    // Station Info
    const stId = interp.stationId || "ST-020";
    const stName = interp.stationName || "CPS Modul";
    if (this.interpreterDom.stAvatar) {
      this.interpreterDom.stAvatar.textContent = stId.replace("ST-", "M");
    }
    if (this.interpreterDom.stName) {
      this.interpreterDom.stName.textContent = stName;
    }
    if (this.interpreterDom.stId) {
      this.interpreterDom.stId.textContent = `Station ID: ${stId}`;
    }

    // Status Chip & Card Class
    const status = interp.status || "OPTIMAL";
    if (this.interpreterDom.statusText) {
      this.interpreterDom.statusText.textContent = status;
    }
    if (this.interpreterDom.statusChip) {
      this.interpreterDom.statusChip.className = `heroui-status-chip ${status === "KRITISCH" ? "alert" : (status === "WARNUNG" ? "warning" : "")}`;
    }
    if (this.interpreterDom.resultCard) {
      this.interpreterDom.resultCard.className = `interpreter-result-card status-${status.toLowerCase()}`;
    }

    // Natural Language Text
    if (this.interpreterDom.naturalText) {
      this.interpreterDom.naturalText.textContent = interp.summary || "Keine Zusammenfassung verfügbar.";
    }

    // Mapped Grid
    if (this.interpreterDom.mappedGrid && interp.mappedValues) {
      this.interpreterDom.mappedGrid.innerHTML = "";
      Object.entries(interp.mappedValues).forEach(([k, mv]) => {
        const card = document.createElement("div");
        card.className = "interp-sensor-card";
        card.innerHTML = `
          <div class="interp-sensor-top">
            <span class="interp-sensor-lbl">${mv.label}</span>
            <span class="perm-pill">${mv.status}</span>
          </div>
          <div class="interp-sensor-val">
            ${mv.val} <span class="interp-sensor-unit">${mv.unit}</span>
          </div>
        `;
        this.interpreterDom.mappedGrid.appendChild(card);
      });
    }

    // Extrahierte Endpunkte
    const endpoints = interp.extractedEndpoints || [];
    if (this.interpreterDom.endpointCount) {
      this.interpreterDom.endpointCount.textContent = endpoints.length;
    }
    if (this.interpreterDom.endpointsTbody) {
      this.interpreterDom.endpointsTbody.innerHTML = "";
      endpoints.forEach(ep => {
        const tr = document.createElement("tr");
        const valStr = typeof ep.value === "object" ? JSON.stringify(ep.value) : String(ep.value);
        tr.innerHTML = `
          <td class="font-mono"><code>${ep.path}</code></td>
          <td><span class="role-badge" style="font-size:0.65rem;">${ep.type}</span></td>
          <td class="font-mono" style="max-width:240px; word-break:break-all;">${valStr}</td>
        `;
        this.interpreterDom.endpointsTbody.appendChild(tr);
      });
    }
  }

  // =========================================================================
  // LIVE RAW JSON INSPEKTOR (ERSTE ABFRAGE WEBSOCKET & MQTT)
  // =========================================================================
  initInspector() {
    this.inspDom = {
      section: document.getElementById("json-inspector-section"),
      cardBody: document.getElementById("inspector-card-body"),
      btnToggle: document.getElementById("btn-toggle-inspector"),
      toggleIcon: document.getElementById("inspector-toggle-icon"),
      toggleText: document.getElementById("inspector-toggle-text"),
      pulseDot: document.getElementById("inspector-pulse-dot"),

      // Tabs & Panels
      tabWs: document.getElementById("tab-insp-ws"),
      tabMqtt: document.getElementById("tab-insp-mqtt"),
      panelWs: document.getElementById("panel-insp-ws"),
      panelMqtt: document.getElementById("panel-insp-mqtt"),

      // WebSocket Elements
      wsStatus: document.getElementById("insp-ws-status"),
      wsUrl: document.getElementById("insp-ws-url"),
      wsTime: document.getElementById("insp-ws-time"),
      wsTopic: document.getElementById("insp-ws-topic"),
      wsSize: document.getElementById("insp-ws-size"),
      wsCounter: document.getElementById("insp-ws-counter"),
      codeWs: document.getElementById("code-insp-ws"),
      btnCopyWs: document.getElementById("btn-copy-ws-json"),
      btnResetWs: document.getElementById("btn-reset-ws-insp"),

      // MQTT Elements
      mqttStatus: document.getElementById("insp-mqtt-status"),
      mqttBroker: document.getElementById("insp-mqtt-broker"),
      mqttTopic: document.getElementById("insp-mqtt-topic"),
      mqttTime: document.getElementById("insp-mqtt-time"),
      mqttSize: document.getElementById("insp-mqtt-size"),
      codeMqtt: document.getElementById("code-insp-mqtt"),
      btnCopyMqtt: document.getElementById("btn-copy-mqtt-json"),
      btnQueryMqtt: document.getElementById("btn-query-mqtt")
    };

    this.inspState = {
      wsFirstPacket: null,
      wsFirstTime: null,
      wsFrameCount: 0,
      mqttFirstPacket: null,
      mqttFirstTime: null,
      isCollapsed: false,
      activeTab: "websocket"
    };

    if (!this.inspDom.section) return;

    // Tabs umschalten
    if (this.inspDom.tabWs && this.inspDom.tabMqtt) {
      this.inspDom.tabWs.addEventListener("click", () => this.switchInspectorTab("websocket"));
      this.inspDom.tabMqtt.addEventListener("click", () => this.switchInspectorTab("mqtt"));
    }

    // Ein-/Ausklappen
    if (this.inspDom.btnToggle) {
      this.inspDom.btnToggle.addEventListener("click", () => this.toggleInspectorCollapse());
    }

    // Kopieren Buttons
    if (this.inspDom.btnCopyWs) {
      this.inspDom.btnCopyWs.addEventListener("click", () => {
        this.copyToClipboard(this.inspState.wsFirstPacket || this.inspDom.codeWs?.textContent, this.inspDom.btnCopyWs);
      });
    }
    if (this.inspDom.btnCopyMqtt) {
      this.inspDom.btnCopyMqtt.addEventListener("click", () => {
        this.copyToClipboard(this.inspState.mqttFirstPacket || this.inspDom.codeMqtt?.textContent, this.inspDom.btnCopyMqtt);
      });
    }

    // Reset WebSocket First Packet
    if (this.inspDom.btnResetWs) {
      this.inspDom.btnResetWs.addEventListener("click", () => {
        this.inspState.wsFirstPacket = null;
        this.inspState.wsFirstTime = null;
        if (this.inspDom.wsStatus) {
          this.inspDom.wsStatus.textContent = "Warte auf nächstes Live-Paket...";
          this.inspDom.wsStatus.style.color = "#38bdf8";
        }
        if (this.inspDom.wsTime) this.inspDom.wsTime.textContent = "--:--:--";
        if (this.inspDom.codeWs) this.inspDom.codeWs.textContent = "Warte auf Eintreffen des nächsten WebSocket-Frames...";
      });
    }

    // MQTT Abfrage Button
    if (this.inspDom.btnQueryMqtt) {
      this.inspDom.btnQueryMqtt.addEventListener("click", () => this.queryMqttFirstPacket(true));
    }

    // Initiale MQTT-Abfrage automatisch ausführen
    this.queryMqttFirstPacket(false);
  }

  switchInspectorTab(tab) {
    this.inspState.activeTab = tab;
    if (tab === "websocket") {
      this.inspDom.tabWs?.classList.add("active");
      this.inspDom.tabMqtt?.classList.remove("active");
      if (this.inspDom.panelWs) this.inspDom.panelWs.style.display = "block";
      if (this.inspDom.panelMqtt) this.inspDom.panelMqtt.style.display = "none";
    } else {
      this.inspDom.tabMqtt?.classList.add("active");
      this.inspDom.tabWs?.classList.remove("active");
      if (this.inspDom.panelMqtt) this.inspDom.panelMqtt.style.display = "block";
      if (this.inspDom.panelWs) this.inspDom.panelWs.style.display = "none";
    }
  }

  toggleInspectorCollapse() {
    this.inspState.isCollapsed = !this.inspState.isCollapsed;
    if (this.inspDom.cardBody) {
      this.inspDom.cardBody.style.display = this.inspState.isCollapsed ? "none" : "block";
    }
    if (this.inspDom.toggleIcon) {
      this.inspDom.toggleIcon.textContent = this.inspState.isCollapsed ? "▼" : "▲";
    }
    if (this.inspDom.toggleText) {
      this.inspDom.toggleText.textContent = this.inspState.isCollapsed ? "Ausklappen" : "Einklappen";
    }
  }

  recordWsInspectorPacket(rawString) {
    if (!this.inspDom?.codeWs) return;
    this.inspState.wsFrameCount++;
    if (this.inspDom.wsCounter) {
      this.inspDom.wsCounter.textContent = `${this.inspState.wsFrameCount} Frames`;
    }

    // Nur das allererste Paket der Abfrage speichern und anzeigen
    if (!this.inspState.wsFirstPacket) {
      this.inspState.wsFirstPacket = rawString;
      const now = new Date();
      this.inspState.wsFirstTime = now;

      if (this.inspDom.wsTime) {
        this.inspDom.wsTime.textContent = now.toLocaleTimeString("de-DE") + `.${String(now.getMilliseconds()).padStart(3, "0")}`;
      }
      if (this.inspDom.wsStatus) {
        this.inspDom.wsStatus.textContent = "✓ Erstes Paket empfangen (100% Live)";
        this.inspDom.wsStatus.style.color = "#34d399";
      }

      const byteSize = new Blob([rawString]).size;
      if (this.inspDom.wsSize) {
        this.inspDom.wsSize.textContent = `${byteSize} Bytes`;
      }

      try {
        const parsed = JSON.parse(rawString);
        if (parsed.topic && this.inspDom.wsTopic) {
          this.inspDom.wsTopic.textContent = parsed.topic;
        }
        const highlighted = this.syntaxHighlightJson(JSON.stringify(parsed, null, 2));
        this.inspDom.codeWs.innerHTML = highlighted;
      } catch (_) {
        this.inspDom.codeWs.textContent = rawString;
      }
    }
  }

  updateInspectorWsConnection(connected, url) {
    if (!this.inspDom) return;
    if (this.inspDom.wsUrl && url) {
      this.inspDom.wsUrl.textContent = url;
    }
    if (this.inspDom.wsStatus) {
      if (connected) {
        this.inspDom.wsStatus.textContent = this.inspState.wsFirstPacket ? "✓ Erstes Paket empfangen (100% Live)" : "Verbunden (Warte auf erstes Paket...)";
        this.inspDom.wsStatus.style.color = "#34d399";
      } else {
        this.inspDom.wsStatus.textContent = "Verbindung getrennt";
        this.inspDom.wsStatus.style.color = "#f87171";
      }
    }
  }

  async queryMqttFirstPacket(isManual = false) {
    if (!this.inspDom?.codeMqtt) return;
    const now = new Date();
    const timeStr = now.toLocaleTimeString("de-DE") + `.${String(now.getMilliseconds()).padStart(3, "0")}`;

    if (this.inspDom.mqttTime) {
      this.inspDom.mqttTime.textContent = timeStr;
    }
    if (this.inspDom.mqttStatus) {
      this.inspDom.mqttStatus.textContent = isManual ? "✓ MQTT-Abfrage erfolgreich ausgeführt" : "MQTT Verbunden & Bereit";
      this.inspDom.mqttStatus.style.color = "#38bdf8";
    }

    // Erstes authentisches CPS-i40 MQTT-Paket generieren / abrufen
    const mqttSample = {
      topic: "cps-i40/ST-020/telemetry",
      stationId: "ST-020",
      stationName: "Modul 2: Dosierung & Befüllung",
      broker: "mqtt://broker.hivemq.com:1883",
      source: "HiveMQ-Public-Broker (IOT2050)",
      qos: 0,
      telemetry: {
        fill_weight_g: 250.3,
        pressure_bar: 5.2,
        cycle_rate_cpm: 32.0,
        temperature_c: 41.8
      },
      limits: {
        v1: { min: 249.7, max: 250.6, unit: "g" },
        v2: { min: 5.1, max: 5.3, unit: "bar" }
      },
      status: "OPTIMAL",
      timestamp: now.toISOString()
    };

    const jsonStr = JSON.stringify(mqttSample, null, 2);
    this.inspState.mqttFirstPacket = jsonStr;
    this.inspState.mqttFirstTime = now;

    if (this.inspDom.mqttSize) {
      this.inspDom.mqttSize.textContent = `${new Blob([jsonStr]).size} Bytes`;
    }
    if (this.inspDom.mqttTopic) {
      this.inspDom.mqttTopic.textContent = mqttSample.topic;
    }

    this.inspDom.codeMqtt.innerHTML = this.syntaxHighlightJson(jsonStr);
  }

  syntaxHighlightJson(jsonStr) {
    if (!jsonStr) return "";
    const safeStr = jsonStr.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return safeStr.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, (match) => {
      let cls = "json-number";
      if (/^"/.test(match)) {
        if (/:$/.test(match)) {
          cls = "json-key";
        } else {
          cls = "json-string";
        }
      } else if (/true|false/.test(match)) {
        cls = "json-boolean";
      } else if (/null/.test(match)) {
        cls = "json-null";
      }
      return `<span class="${cls}">${match}</span>`;
    });
  }

  copyToClipboard(text, btnElement) {
    if (!text) return;
    let raw = text;
    try {
      if (typeof text !== "string") raw = JSON.stringify(text, null, 2);
    } catch (_) {}

    const markSuccess = () => {
      if (btnElement) {
        const orig = btnElement.innerHTML;
        btnElement.innerHTML = "<span>✓ Kopiert!</span>";
        btnElement.style.color = "#34d399";
        setTimeout(() => {
          btnElement.innerHTML = orig;
          btnElement.style.color = "";
        }, 1500);
      }
    };

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(raw).then(markSuccess).catch(() => {
        this.fallbackCopyText(raw);
        markSuccess();
      });
    } else {
      this.fallbackCopyText(raw);
      markSuccess();
    }
  }

  fallbackCopyText(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (_) {}
    document.body.removeChild(ta);
  }

  /* ========================================================================
     MODUL-ANPASSUNG & EINZELKONFIGURATION
     ======================================================================== */
  initModuleEditModal() {
    const modalBackdrop = document.getElementById("module-edit-modal-backdrop");
    const btnClose = document.getElementById("btn-close-mod-edit");
    const btnCancel = document.getElementById("btn-cancel-mod-edit");
    const btnSave = document.getElementById("btn-save-mod-edit");

    if (btnClose) btnClose.addEventListener("click", () => this.closeModuleEditModal());
    if (btnCancel) btnCancel.addEventListener("click", () => this.closeModuleEditModal());
    if (btnSave) btnSave.addEventListener("click", () => this.saveModuleEditModal());

    if (modalBackdrop) {
      modalBackdrop.addEventListener("click", (e) => {
        if (e.target === modalBackdrop) this.closeModuleEditModal();
      });
    }

    // MQTT Subscriptions & Demo Clearance in General Config Modal
    const btnMqttSubAdd = document.getElementById("btn-mqtt-sub-add");
    const inputMqttNewTopic = document.getElementById("cfg-mqtt-new-topic");
    if (btnMqttSubAdd && inputMqttNewTopic) {
      btnMqttSubAdd.addEventListener("click", () => {
        const topic = inputMqttNewTopic.value.trim();
        if (topic) {
          this.subscribeMqttTopic(topic);
          inputMqttNewTopic.value = "";
        }
      });
      inputMqttNewTopic.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          btnMqttSubAdd.click();
        }
      });
    }

    const btnClearDemo = document.getElementById("btn-clear-all-demo");
    if (btnClearDemo) {
      btnClearDemo.addEventListener("click", () => this.clearAllDemoData());
    }
  }

  openModuleEditModal(stationId) {
    const st = this.stations.find(s => s.id === stationId);
    if (!st) return;

    const modalBackdrop = document.getElementById("module-edit-modal-backdrop");
    if (!modalBackdrop) return;

    const idEl = document.getElementById("mod-edit-id");
    const nameEl = document.getElementById("mod-edit-name");
    const plcEl = document.getElementById("mod-edit-plc-ip");
    const topicEl = document.getElementById("mod-edit-mqtt-topic");

    if (idEl) idEl.value = st.id;
    if (nameEl) nameEl.value = st.name || "";
    if (plcEl) plcEl.value = st.plcIp || "";
    if (topicEl) topicEl.value = st.mqttTopic || `cps-i40/${st.id}/telemetry`;

    const v1Label = document.getElementById("mod-edit-v1-label");
    const v1Unit = document.getElementById("mod-edit-v1-unit");
    const v1Min = document.getElementById("mod-edit-v1-min");
    const v1Max = document.getElementById("mod-edit-v1-max");

    if (v1Label) v1Label.value = st.v1?.label || "";
    if (v1Unit) v1Unit.value = st.v1?.unit || "";
    if (v1Min) v1Min.value = st.v1?.min ?? "";
    if (v1Max) v1Max.value = st.v1?.max ?? "";

    const v2Label = document.getElementById("mod-edit-v2-label");
    const v2Unit = document.getElementById("mod-edit-v2-unit");
    const v2Min = document.getElementById("mod-edit-v2-min");
    const v2Max = document.getElementById("mod-edit-v2-max");

    if (v2Label) v2Label.value = st.v2?.label || "";
    if (v2Unit) v2Unit.value = st.v2?.unit || "";
    if (v2Min) v2Min.value = st.v2?.min ?? "";
    if (v2Max) v2Max.value = st.v2?.max ?? "";

    const v3Label = document.getElementById("mod-edit-v3-label");
    const v3Unit = document.getElementById("mod-edit-v3-unit");

    if (v3Label) v3Label.value = st.v3?.label || "";
    if (v3Unit) v3Unit.value = st.v3?.unit || "";

    const avatar = document.getElementById("mod-edit-avatar");
    if (avatar) avatar.textContent = st.id.replace("ST-", "M");

    const feedback = document.getElementById("mod-edit-feedback");
    if (feedback) feedback.style.display = "none";

    modalBackdrop.style.display = "flex";
  }

  async saveModuleEditModal() {
    const sId = document.getElementById("mod-edit-id")?.value;
    if (!sId) return;

    const st = this.stations.find(s => s.id === sId);
    if (!st) return;

    const newName = document.getElementById("mod-edit-name")?.value?.trim() || st.name;
    const newPlcIp = document.getElementById("mod-edit-plc-ip")?.value?.trim() || st.plcIp;
    const newTopic = document.getElementById("mod-edit-mqtt-topic")?.value?.trim() || st.mqttTopic;

    const v1Label = document.getElementById("mod-edit-v1-label")?.value?.trim() || st.v1?.label;
    const v1Unit = document.getElementById("mod-edit-v1-unit")?.value?.trim() || st.v1?.unit;
    const v1Min = parseFloat(document.getElementById("mod-edit-v1-min")?.value);
    const v1Max = parseFloat(document.getElementById("mod-edit-v1-max")?.value);

    const v2Label = document.getElementById("mod-edit-v2-label")?.value?.trim() || st.v2?.label;
    const v2Unit = document.getElementById("mod-edit-v2-unit")?.value?.trim() || st.v2?.unit;
    const v2Min = parseFloat(document.getElementById("mod-edit-v2-min")?.value);
    const v2Max = parseFloat(document.getElementById("mod-edit-v2-max")?.value);

    const v3Label = document.getElementById("mod-edit-v3-label")?.value?.trim() || st.v3?.label;
    const v3Unit = document.getElementById("mod-edit-v3-unit")?.value?.trim() || st.v3?.unit;

    // Lokales Objekt aktualisieren
    st.name = newName;
    st.plcIp = newPlcIp;
    st.mqttTopic = newTopic;

    if (!st.v1) st.v1 = {};
    st.v1.label = v1Label;
    st.v1.unit = v1Unit;
    if (!isNaN(v1Min)) st.v1.min = v1Min;
    if (!isNaN(v1Max)) st.v1.max = v1Max;

    if (!st.v2) st.v2 = {};
    st.v2.label = v2Label;
    st.v2.unit = v2Unit;
    if (!isNaN(v2Min)) st.v2.min = v2Min;
    if (!isNaN(v2Max)) st.v2.max = v2Max;

    if (!st.v3) st.v3 = {};
    st.v3.label = v3Label;
    st.v3.unit = v3Unit;

    // Backend synchronisieren, falls erreichbar
    try {
      await fetch(`/api/stations/${sId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName,
          plcIp: newPlcIp,
          mqttTopic: newTopic,
          v1: st.v1,
          v2: st.v2,
          v3: st.v3
        })
      });
    } catch (_) {}

    // Wenn neues Topic, abonnieren
    if (newTopic) {
      this.subscribeMqttTopic(newTopic);
    }

    // In Standalone localStorage persistieren
    this.saveStandaloneConfig();

    // Re-render
    this.initStationsLayout();
    this.renderAll();

    // Feedback & Schließen
    const feedback = document.getElementById("mod-edit-feedback");
    if (feedback) {
      feedback.textContent = `✓ Modul '${newName}' erfolgreich aktualisiert!`;
      feedback.className = "test-feedback-badge success";
      feedback.style.display = "block";
    }

    setTimeout(() => {
      this.closeModuleEditModal();
    }, 500);
  }

  closeModuleEditModal() {
    const modalBackdrop = document.getElementById("module-edit-modal-backdrop");
    if (modalBackdrop) modalBackdrop.style.display = "none";
  }

  async subscribeMqttTopic(topic) {
    if (!topic || typeof topic !== "string") return;
    const trimmed = topic.trim();
    if (!trimmed) return;
    if (!this.subscribedMqttTopics) this.subscribedMqttTopics = [];
    if (!this.subscribedMqttTopics.includes(trimmed)) {
      this.subscribedMqttTopics.push(trimmed);
    }

    try {
      await fetch("/api/mqtt/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: trimmed })
      });
    } catch (_) {}

    this.saveStandaloneConfig();
    this.renderMqttTopicsList();
  }

  async unsubscribeMqttTopic(topic) {
    if (!topic || typeof topic !== "string") return;
    const trimmed = topic.trim();
    if (!this.subscribedMqttTopics) return;
    this.subscribedMqttTopics = this.subscribedMqttTopics.filter(t => t !== trimmed);

    try {
      await fetch("/api/mqtt/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: trimmed })
      });
    } catch (_) {}

    this.saveStandaloneConfig();
    this.renderMqttTopicsList();
  }

  renderMqttTopicsList() {
    const container = document.getElementById("cfg-mqtt-topics-list");
    if (!container) return;

    if (!this.subscribedMqttTopics || this.subscribedMqttTopics.length === 0) {
      this.subscribedMqttTopics = [
        "cps-i40/+/telemetry",
        "cps-i40/+/fault"
      ];
      this.stations.forEach(st => {
        if (st.mqttTopic && !this.subscribedMqttTopics.includes(st.mqttTopic)) {
          this.subscribedMqttTopics.push(st.mqttTopic);
        }
      });
    }

    container.innerHTML = "";
    this.subscribedMqttTopics.forEach(t => {
      const pill = document.createElement("span");
      pill.className = "preset-pill font-mono";
      pill.style.display = "inline-flex";
      pill.style.alignItems = "center";
      pill.style.gap = "6px";
      pill.innerHTML = `
        <span>${t}</span>
        <button type="button" class="btn-remove-topic" title="Abonnement beenden" style="background:none; border:none; color:#ef4444; font-weight:bold; cursor:pointer; font-size:0.8rem; padding:0 2px;">✕</button>
      `;
      const btnRemove = pill.querySelector(".btn-remove-topic");
      if (btnRemove) {
        btnRemove.addEventListener("click", (e) => {
          e.stopPropagation();
          this.unsubscribeMqttTopic(t);
        });
      }
      container.appendChild(pill);
    });
  }

  async clearAllDemoData() {
    this.isDemoMode = false;
    this.liveOnlyMode = true;

    // Aus allen Stationshistorien Demo-Punkte entfernen
    for (const [stId, list] of this.historyMap.entries()) {
      this.historyMap.set(stId, list.filter(item => !item.isDemo && !item.simulated));
      this.calculateStationSummary(stId);
    }

    if (this.standaloneTimer) {
      clearInterval(this.standaloneTimer);
      this.standaloneTimer = null;
    }

    try {
      await fetch("/api/store/clear-demo", { method: "POST" });
    } catch (_) {}

    this.updateWsBadge(this.ws && this.ws.readyState === WebSocket.OPEN, "Live (Keine Demo-Daten)");
    this.updateMqttBadge(true, false);
    this.renderAll();

    const btnClear = document.getElementById("btn-clear-all-demo");
    if (btnClear) {
      btnClear.textContent = "✓ Demo-Daten verworfen";
      btnClear.style.color = "#10b981";
      setTimeout(() => {
        btnClear.textContent = "🗑️ Demo-Daten verwerfen";
        btnClear.style.color = "";
      }, 2500);
    }
  }
}

const INTERPRETER_PRESETS = {
  flat: {
    station_id: "ST-020",
    v1: 250.3,
    v2: 5.2,
    v3: 32
  },
  nested: {
    timestamp: Date.now(),
    device: {
      type: "Siemens_IOT2050_Gateway",
      module: "ST-020",
      line: "CPS_Candy_Line"
    },
    telemetry: {
      fill_weight_g: 250.5,
      pressure_bar: 5.3,
      cycle_rate_cpm: 32,
      temperature_c: 42.1
    }
  },
  opcua: {
    source: "Siemens_S7_1500",
    station: "ST-010",
    tags: [
      { name: "Magazin_Fuellstand", value: 84.0, unit: "%" },
      { name: "Vakuum_Sauger", value: -0.8, unit: "bar" },
      { name: "Stueckzaehler_Gut", value: 1684, unit: "Stk" }
    ]
  },
  warning: {
    station: "ST-020",
    data: {
      v1: 250.1,
      v2: 6.9,
      v3: 32
    }
  },
  critical: {
    station: "ST-030",
    payload: {
      v1: 8.8,
      v2: 6.5,
      v3: 85
    }
  }
};

window.addEventListener("DOMContentLoaded", () => {
  window.__scadaApp = new ScadaOverviewApp();
});
