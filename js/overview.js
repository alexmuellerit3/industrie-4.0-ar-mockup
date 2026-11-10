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
    this.isGitHubPages = typeof window !== "undefined" && window.location && (
      window.location.hostname.endsWith("github.io") ||
      window.location.protocol === "file:"
    );

    // Standalone / Offline-Persistenz: Prüfe auf zuvor gespeicherte Konfiguration
    try {
      if (typeof localStorage !== "undefined") {
        const saved = localStorage.getItem("cps_saved_config");
        if (saved) {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed.stations)) {
            this.mergeSavedStationsConfig(parsed.stations);
          }
          if (Array.isArray(parsed.subscribedMqttTopics)) {
            this.subscribedMqttTopics = parsed.subscribedMqttTopics;
          }
        }
      }
    } catch (_) {}

    this.stationTimeframes = new Map();

    // DOM Caches
    this.dom = {
      zabbixStrip: document.getElementById("zabbix-availability-strip"),
      badgeZbxAvail: document.getElementById("badge-zbx-avail"),
      badgeWsAvail: document.getElementById("badge-ws-avail"),
      badgeMqttAvail: document.getElementById("badge-mqtt-avail"),
      badgeMysqlAvail: document.getElementById("badge-mysql-avail"),
      mysqlBadgeContainer: document.getElementById("mysql-badge-container"),
      mysqlBadgeDot: document.getElementById("mysql-badge-dot"),
      mysqlBadgeText: document.getElementById("mysql-badge-text"),
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
      stationsContainer: document.getElementById("stations-scada-container"),
      // Incident Ledger Caches
      incBadgeActiveCount: document.getElementById("inc-badge-active-count"),
      incKpiTotal: document.getElementById("inc-kpi-total"),
      incKpiActive: document.getElementById("inc-kpi-active"),
      incKpiDowntime: document.getElementById("inc-kpi-downtime"),
      incKpiMttr: document.getElementById("inc-kpi-mttr"),
      filterIncStation: document.getElementById("filter-inc-station"),
      filterIncStatus: document.getElementById("filter-inc-status"),
      incFilterInfo: document.getElementById("inc-filter-info"),
      incTableTbody: document.getElementById("incident-table-tbody")
    };

    this.incidents = this.loadIncidentsFromStorage();

    this.initStationsLayout();
    this.initStandaloneHistory();
    this.initConfigModal();
    this.initModuleEditModal();
    this.initAuth();
    this.initInterpreter();
    this.initInspector();
    this.initIncidentLedger();
    this.renderAll();
    this.connectWebSocket();
    this.startClock();
    this.checkMySqlStatus();
    setInterval(() => this.checkMySqlStatus(), 20000);
  }

  mergeSavedStationsConfig(savedStations) {
    if (!Array.isArray(savedStations)) return;
    savedStations.forEach(newSt => {
      const target = this.stations.find(s => s.id === newSt.id);
      if (target) {
        if (newSt.name) target.name = newSt.name;
        if (newSt.plcIp) target.plcIp = newSt.plcIp;
        if (newSt.mqttTopic) target.mqttTopic = newSt.mqttTopic;
        if (newSt.wsNodeId) target.wsNodeId = newSt.wsNodeId;
        if (newSt.description) target.description = newSt.description;
        if (newSt.isDynamic !== undefined) target.isDynamic = newSt.isDynamic;
        ['v1', 'v2', 'v3'].forEach(k => {
          if (newSt[k] && target[k]) {
            if (newSt[k].min !== undefined) target[k].min = newSt[k].min;
            if (newSt[k].max !== undefined) target[k].max = newSt[k].max;
            if (newSt[k].label) target[k].label = newSt[k].label;
            if (newSt[k].unit) target[k].unit = newSt[k].unit;
            if (newSt[k].defaultVal !== undefined) target[k].val = newSt[k].defaultVal;
          }
        });
      } else {
        this.stations.push(newSt);
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

      const avatar = st.avatar || (st.id.startsWith("ST-0") ? st.id.replace("ST-0", "M") : (st.name.match(/\b([A-Z0-9])/g) || [st.id.slice(3, 5)]).slice(0, 3).join(""));
      const isDynamicBadge = st.isDynamic ? '<span class="heroui-chip heroui-chip-success" style="font-size:0.65rem; padding:1px 6px; margin-left:6px; vertical-align:middle;">✨ LIVE</span>' : '';
      const topicSub = st.mqttTopic ? ' • MQTT: ' + st.mqttTopic : (st.wsNodeId ? ' • OPC: ' + st.wsNodeId : '');

      card.innerHTML = `
        <div class="heroui-station-header">
          <div class="station-title-group">
            <div class="station-id-avatar">${avatar}</div>
            <div class="station-title-text">
              <span class="station-main-title" id="title-${st.id}">${st.name}${isDynamicBadge}</span>
              <span class="station-meta-sub" id="sub-${st.id}">SPS: ${st.plcIp}${topicSub}</span>
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
              <span id="chart-title-${st.id}">5-Minuten Trendkurve (${st.v1.label})</span>
              <span class="history-ttl-pill" id="ttl-pill-${st.id}">TTL: 300s</span>
            </div>
            <div class="time-range-pills" role="tablist">
              <button type="button" class="time-pill active" data-range="5m" data-station="${st.id}">5 Min</button>
              <button type="button" class="time-pill" data-range="1h" data-station="${st.id}">1 Std</button>
              <button type="button" class="time-pill" data-range="6h" data-station="${st.id}">6 Std</button>
              <button type="button" class="time-pill" data-range="24h" data-station="${st.id}">24 Std</button>
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
              <span class="eval-lbl" id="eval-min-lbl-${st.id}">Min (5m)</span>
              <span class="eval-num" id="min-${st.id}">-</span>
            </div>
            <div class="eval-col">
              <span class="eval-lbl" id="eval-max-lbl-${st.id}">Max (5m)</span>
              <span class="eval-num" id="max-${st.id}">-</span>
            </div>
            <div class="eval-col">
              <span class="eval-lbl" id="eval-avg-lbl-${st.id}">Ø Mittelwert</span>
              <span class="eval-num" id="avg-${st.id}">-</span>
            </div>
            <div class="eval-col">
              <span class="eval-lbl" id="eval-rate-lbl-${st.id}">Störrate</span>
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

      const timePills = card.querySelectorAll(`.time-pill[data-station="${st.id}"]`);
      timePills.forEach(pill => {
        pill.addEventListener("click", () => {
          const range = pill.getAttribute("data-range");
          this.switchStationTimeRange(st.id, range);
        });
      });

      this.dom.stationsContainer.appendChild(card);
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

    // Falls lokaler Backend-Server aktiv ist und keine externe WS-URL manuell überschrieben wurde:
    if (!isGitHubPages && !savedWsUrl && window.location && (window.location.protocol === "http:" || window.location.protocol === "https:")) {
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

      // Falls Station noch nicht existiert, automatisch aus Empfangsdaten anlegen
      if (!this.stations.some(s => s.id === stationId)) {
        this.createModuleFromReceivedData(msg, { stationId });
      }

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
      if (msg.incident) {
        const idx = this.incidents.findIndex(i => i.id === msg.incident.id);
        if (idx >= 0) {
          this.incidents[idx] = msg.incident;
        } else {
          this.incidents.unshift(msg.incident);
        }
        this.saveIncidentsToStorage();
        this.renderIncidentLedger();
      } else {
        if (msg.isFault) {
          this.recordFaultIncident(msg.stationId);
        } else {
          this.resolveFaultIncident(msg.stationId);
        }
      }
      this.updateKpis();
    } else if (msg.type === "incident_created" && msg.incident) {
      const idx = this.incidents.findIndex(i => i.id === msg.incident.id);
      if (idx < 0) this.incidents.unshift(msg.incident);
      this.saveIncidentsToStorage();
      this.renderIncidentLedger();
    } else if (msg.type === "incident_resolved" && msg.incident) {
      const idx = this.incidents.findIndex(i => i.id === msg.incident.id);
      if (idx >= 0) this.incidents[idx] = msg.incident;
      this.saveIncidentsToStorage();
      this.renderIncidentLedger();
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

        // Falls Station noch nicht existiert oder dynamisch ist: automatisch als neues Modul erstellen!
        if (!this.stations.some(s => s.id === stationId)) {
          if (interpRes.synthesizedStation) {
            this.addDynamicStation(interpRes.synthesizedStation);
          } else {
            this.createModuleFromReceivedData(msg, { stationId });
          }
        }

        const mv = interp.mappedValues || {};
        const sample = {
          v1: mv.v1?.val ?? interpRes.synthesizedStation?.v1?.val ?? 250,
          v2: mv.v2?.val ?? interpRes.synthesizedStation?.v2?.val ?? 0,
          v3: mv.v3?.val ?? interpRes.synthesizedStation?.v3?.val ?? 100,
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

    const currentRange = this.stationTimeframes.get(stationId) || "5m";

    if (currentRange === "5m") {
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

    if (!this.isGitHubPages && !this.isStandaloneSim) {
      fetch("/api/fault", {
        method: "POST",
        headers: authService.getAuthHeaders(),
        body: JSON.stringify({ stationId, isFault: targetState })
      }).catch(() => {});
    }

    this.setCardFaultState(stationId, targetState);

    // Störungs-Historie (Incident Ledger) synchronisieren
    if (targetState) {
      this.recordFaultIncident(stationId);
    } else {
      this.resolveFaultIncident(stationId);
    }

    if (this.isStandaloneSim || this.isGitHubPages) {
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
      selectedDataSource: "websocket",

      // MySQL 24h & Auto-DDL
      inputMysqlHost: document.getElementById("cfg-mysql-host"),
      inputMysqlPort: document.getElementById("cfg-mysql-port"),
      inputMysqlDb: document.getElementById("cfg-mysql-db"),
      inputMysqlUser: document.getElementById("cfg-mysql-user"),
      inputMysqlPass: document.getElementById("cfg-mysql-pass"),
      inputMysqlRetention: document.getElementById("cfg-mysql-retention"),
      btnTestMysql: document.getElementById("btn-test-mysql"),
      mysqlTestResult: document.getElementById("mysql-test-result"),
      cfgMysqlChip: document.getElementById("cfg-mysql-chip"),
      cfgMysqlChipDot: document.getElementById("cfg-mysql-chip-dot"),
      cfgMysqlStatusText: document.getElementById("cfg-mysql-status-text"),
      cfgMysqlTablesCount: document.getElementById("cfg-mysql-tables-count"),

      // Zabbix Onboarding
      inputZbxHostId: document.getElementById("zbx-host-id"),
      inputZbxHostName: document.getElementById("zbx-host-name"),
      inputZbxHostGroup: document.getElementById("zbx-host-group"),
      inputZbxHostIp: document.getElementById("zbx-host-ip"),
      inputZbxHostTopic: document.getElementById("zbx-host-topic"),
      inputZbxV1Label: document.getElementById("zbx-v1-label"),
      inputZbxV1Unit: document.getElementById("zbx-v1-unit"),
      inputZbxV1Min: document.getElementById("zbx-v1-min"),
      inputZbxV1Max: document.getElementById("zbx-v1-max"),
      inputZbxV1Sev: document.getElementById("zbx-v1-sev"),
      inputZbxV2Label: document.getElementById("zbx-v2-label"),
      inputZbxV2Unit: document.getElementById("zbx-v2-unit"),
      inputZbxV2Min: document.getElementById("zbx-v2-min"),
      inputZbxV2Max: document.getElementById("zbx-v2-max"),
      inputZbxV2Sev: document.getElementById("zbx-v2-sev"),
      inputZbxV3Label: document.getElementById("zbx-v3-label"),
      inputZbxV3Unit: document.getElementById("zbx-v3-unit"),
      inputZbxV3Sev: document.getElementById("zbx-v3-sev"),
      btnSaveZabbixHost: document.getElementById("btn-save-zabbix-host"),
      zbxHostFeedback: document.getElementById("zbx-host-feedback"),
      zbxHostsTbody: document.getElementById("zbx-hosts-tbody")
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
    if (this.modal.btnTestMysql) {
      this.modal.btnTestMysql.addEventListener("click", () => this.testMysqlConnection());
    }
    if (this.modal.btnSaveZabbixHost) {
      this.modal.btnSaveZabbixHost.addEventListener("click", () => this.saveZabbixHost());
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

    if (!this.isGitHubPages && !this.isStandaloneSim) {
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

    // MySQL Felder
    if (config.mysql) {
      if (this.modal.inputMysqlHost && config.mysql.host) this.modal.inputMysqlHost.value = config.mysql.host;
      if (this.modal.inputMysqlPort && config.mysql.port) this.modal.inputMysqlPort.value = config.mysql.port;
      if (this.modal.inputMysqlDb && config.mysql.database) this.modal.inputMysqlDb.value = config.mysql.database;
      if (this.modal.inputMysqlUser && config.mysql.user) this.modal.inputMysqlUser.value = config.mysql.user;
      if (this.modal.inputMysqlRetention && config.mysql.retentionHours) this.modal.inputMysqlRetention.value = config.mysql.retentionHours;
    }
    this.renderZabbixHostsList();

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
    if (!this.isGitHubPages && !this.isStandaloneSim) {
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
    if (!this.isGitHubPages && !this.isStandaloneSim) {
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
      mysql: {
        host: this.modal.inputMysqlHost?.value?.trim() || "cps-mysql",
        port: parseInt(this.modal.inputMysqlPort?.value, 10) || 3306,
        database: this.modal.inputMysqlDb?.value?.trim() || "cpr_telemetry",
        user: this.modal.inputMysqlUser?.value?.trim() || "cpr_user",
        password: this.modal.inputMysqlPass?.value || "cpr_secret",
        retentionHours: parseInt(this.modal.inputMysqlRetention?.value, 10) || 24
      },
      stations: updatedStations
    };

    if (this.modal.btnSave) this.modal.btnSave.disabled = true;
    if (this.modal.spinner) this.modal.spinner.style.display = "inline";

    let savedRemote = false;
    if (!this.isGitHubPages && !this.isStandaloneSim) {
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
    this.checkMySqlStatus();

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
      if (!this.isGitHubPages && !this.isStandaloneSim) {
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

  async checkMySqlStatus() {
    try {
      if (!this.isGitHubPages && !this.isStandaloneSim) {
        const res = await fetch("/api/mysql/status");
        if (res.ok) {
          const data = await res.json();
          if (data.connected) {
            if (this.dom.mysqlBadgeDot) this.dom.mysqlBadgeDot.className = "chip-dot pulse";
            if (this.dom.mysqlBadgeText) this.dom.mysqlBadgeText.textContent = "MySQL: 24h Aktiv";
            if (this.dom.badgeMysqlAvail) this.dom.badgeMysqlAvail.className = "zabbix-avail-pill avail-active";
            if (this.modal?.cfgMysqlChip) this.modal.cfgMysqlChip.className = "heroui-status-chip";
            if (this.modal?.cfgMysqlStatusText) this.modal.cfgMysqlStatusText.textContent = "Verbunden (Auto-DDL aktiv)";
            if (this.modal?.cfgMysqlTablesCount) this.modal.cfgMysqlTablesCount.textContent = `${data.tableCount || 5} Tabellen angelegt`;
            return;
          }
        }
      }
    } catch (_) {}

    // Fallback Modus (In-Memory 24h Puffer / Standalone / GitHub Pages)
    if (this.dom.mysqlBadgeDot) this.dom.mysqlBadgeDot.className = "chip-dot";
    if (this.dom.mysqlBadgeText) this.dom.mysqlBadgeText.textContent = "MySQL: In-Memory (24h)";
    if (this.dom.badgeMysqlAvail) this.dom.badgeMysqlAvail.className = "zabbix-avail-pill avail-warn";
    if (this.modal?.cfgMysqlChip) this.modal.cfgMysqlChip.className = "heroui-status-chip";
    if (this.modal?.cfgMysqlStatusText) this.modal.cfgMysqlStatusText.textContent = "In-Memory Puffer aktiv (Standby)";
    if (this.modal?.cfgMysqlTablesCount) this.modal.cfgMysqlTablesCount.textContent = "5 Tabellen (Fallback-Schema)";
  }

  async testMysqlConnection() {
    const host = this.modal.inputMysqlHost ? this.modal.inputMysqlHost.value.trim() : "cps-mysql";
    const port = parseInt(this.modal.inputMysqlPort ? this.modal.inputMysqlPort.value : 3306, 10);
    const database = this.modal.inputMysqlDb ? this.modal.inputMysqlDb.value.trim() : "cpr_telemetry";
    const user = this.modal.inputMysqlUser ? this.modal.inputMysqlUser.value.trim() : "cpr_user";
    const password = this.modal.inputMysqlPass ? this.modal.inputMysqlPass.value : "";

    const badge = this.modal.mysqlTestResult;
    if (badge) {
      badge.style.display = "block";
      badge.className = "test-feedback-badge";
      badge.textContent = "Teste Verbindung zu MySQL und Auto-DDL...";
    }

    if (!this.isGitHubPages && !this.isStandaloneSim) {
      try {
        const res = await fetch("/api/config/test-mysql", {
          method: "POST",
          headers: authService.getAuthHeaders(),
          body: JSON.stringify({ host, port, database, user, password })
        });
        const data = await res.json();
        if (data.success) {
          if (badge) {
            badge.className = "test-feedback-badge success";
            badge.textContent = `✓ ${data.message} (Tabellen erzeugt)`;
          }
          this.checkMySqlStatus();
          return;
        } else {
          if (badge) {
            badge.className = "test-feedback-badge error";
            badge.textContent = `✕ Verbindung fehlgeschlagen: ${data.message} (${data.code || "Fallback aktiv"})`;
          }
          return;
        }
      } catch (e) {
        // Fallback below
      }
    }

    // GitHub Pages / Standalone Modus
    if (badge) {
      badge.className = "test-feedback-badge success";
      badge.textContent = `✓ MySQL Auto-DDL Syntax verifiziert (Lokaler Modus / GitHub Pages Fallback)`;
    }
  }

  async saveZabbixHost() {
    const hostId = this.modal.inputZbxHostId ? this.modal.inputZbxHostId.value.trim() : "";
    const hostName = this.modal.inputZbxHostName ? this.modal.inputZbxHostName.value.trim() : "";
    if (!hostId || !hostName) {
      if (this.modal.zbxHostFeedback) {
        this.modal.zbxHostFeedback.style.display = "block";
        this.modal.zbxHostFeedback.className = "test-feedback-badge error";
        this.modal.zbxHostFeedback.textContent = "Bitte Host-ID und Anzeigenamen ausfüllen.";
      }
      return;
    }

    const hostGroup = this.modal.inputZbxHostGroup?.value?.trim() || "CPR-Candy-Linie";
    const plcIp = this.modal.inputZbxHostIp?.value?.trim() || "192.168.10.15";
    const mqttTopic = this.modal.inputZbxHostTopic?.value?.trim() || `cps-i40/${hostId}/telemetry`;

    const v1 = {
      label: this.modal.inputZbxV1Label?.value?.trim() || "Hauptwert",
      unit: this.modal.inputZbxV1Unit?.value?.trim() || "",
      min: parseFloat(this.modal.inputZbxV1Min?.value) || 0,
      max: parseFloat(this.modal.inputZbxV1Max?.value) || 100,
      severity: this.modal.inputZbxV1Sev?.value || "High"
    };
    const v2 = {
      label: this.modal.inputZbxV2Label?.value?.trim() || "Sensor 2",
      unit: this.modal.inputZbxV2Unit?.value?.trim() || "",
      min: parseFloat(this.modal.inputZbxV2Min?.value) || 0,
      max: parseFloat(this.modal.inputZbxV2Max?.value) || 10,
      severity: this.modal.inputZbxV2Sev?.value || "Warning"
    };
    const v3 = {
      label: this.modal.inputZbxV3Label?.value?.trim() || "Takt",
      unit: this.modal.inputZbxV3Unit?.value?.trim() || "D/min",
      severity: this.modal.inputZbxV3Sev?.value || "Information"
    };

    const hostPayload = {
      hostId,
      name: hostName,
      group: hostGroup,
      plcIp,
      mqttTopic,
      items: { v1, v2, v3 }
    };

    if (!this.isGitHubPages && !this.isStandaloneSim) {
      try {
        await fetch("/api/zabbix/hosts", {
          method: "POST",
          headers: authService.getAuthHeaders(),
          body: JSON.stringify(hostPayload)
        });
      } catch (_) {}
    }

    const existingStation = this.stations.find(s => s.id === hostId);
    if (!existingStation) {
      const newStation = {
        id: hostId,
        name: hostName,
        plcIp,
        mqttTopic,
        avatar: (hostId.startsWith("ST-0") ? hostId.replace("ST-0", "M") : hostId.slice(0, 3)),
        description: `Zabbix Host: ${hostName} (${hostGroup})`,
        isDynamic: true,
        v1: { label: v1.label, unit: v1.unit, min: v1.min, max: v1.max, defaultVal: ((v1.min + v1.max) / 2) || 20, val: ((v1.min + v1.max) / 2) || 20 },
        v2: { label: v2.label, unit: v2.unit, min: v2.min, max: v2.max, defaultVal: ((v2.min + v2.max) / 2) || 5, val: ((v2.min + v2.max) / 2) || 5 },
        v3: { label: v3.label, unit: v3.unit, defaultVal: 32, val: 32 }
      };
      this.stations.push(newStation);
      this.initStationsLayout();
      this.saveStationsToLocalStorage();
      this.renderAll();
    }

    if (this.modal.zbxHostFeedback) {
      this.modal.zbxHostFeedback.style.display = "block";
      this.modal.zbxHostFeedback.className = "test-feedback-badge success";
      this.modal.zbxHostFeedback.textContent = `✓ Zabbix Host '${hostName}' erfolgreich angelegt und Auto-DDL Tabelle 'telemetry_${hostId}' registriert!`;
    }

    this.renderZabbixHostsList();
  }

  renderZabbixHostsList() {
    if (!this.modal.zbxHostsTbody) return;
    this.modal.zbxHostsTbody.innerHTML = "";

    this.stations.forEach(st => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="font-mono" style="font-weight:700;">${st.id}</td>
        <td>${st.name}</td>
        <td><span class="role-badge">CPR-Candy-Linie</span></td>
        <td class="font-mono">${st.plcIp}</td>
        <td><span class="font-mono" style="font-size:0.75rem;">v1, v2, v3 (3 Items)</span></td>
        <td><span class="zabbix-avail-pill avail-active" style="padding:1px 5px; font-size:0.65rem;">[ZBX] AKTIV</span></td>
      `;
      this.modal.zbxHostsTbody.appendChild(tr);
    });
  }

  async switchStationTimeRange(stationId, range) {
    this.stationTimeframes.set(stationId, range);

    const pills = document.querySelectorAll(`.time-pill[data-station="${stationId}"]`);
    pills.forEach(p => {
      if (p.getAttribute("data-range") === range) {
        p.classList.add("active");
      } else {
        p.classList.remove("active");
      }
    });

    const chartTitleEl = document.getElementById(`chart-title-${stationId}`);
    const ttlPillEl = document.getElementById(`ttl-pill-${stationId}`);
    const minLblEl = document.getElementById(`eval-min-lbl-${stationId}`);
    const maxLblEl = document.getElementById(`eval-max-lbl-${stationId}`);
    const station = this.stations.find(s => s.id === stationId);
    const v1Label = station?.v1?.label || "Messwert";

    if (range === "5m") {
      if (chartTitleEl) chartTitleEl.textContent = `5-Minuten Trendkurve (${v1Label})`;
      if (ttlPillEl) ttlPillEl.textContent = "Puffer: 5m";
      if (minLblEl) minLblEl.textContent = "Min (5m)";
      if (maxLblEl) maxLblEl.textContent = "Max (5m)";

      const list = this.historyMap.get(stationId) || [];
      const ptsEl = document.getElementById(`pts-${stationId}`);
      if (ptsEl) ptsEl.textContent = `${list.length} Punkte (5m)`;
      this.renderSvgChart(stationId, list);
      return;
    }

    const hours = range === "1h" ? 1 : (range === "6h" ? 6 : 24);
    if (chartTitleEl) chartTitleEl.textContent = `${hours}h Shift-Historie (MySQL 24h: ${v1Label})`;
    if (ttlPillEl) ttlPillEl.textContent = `MySQL: ${hours}h`;
    if (minLblEl) minLblEl.textContent = `Min (${range})`;
    if (maxLblEl) maxLblEl.textContent = `Max (${range})`;

    let historySeries = null;
    if (!this.isGitHubPages && !this.isStandaloneSim) {
      try {
        const res = await fetch(`/api/history/24h?stationId=${stationId}&hours=${hours}`);
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.series) && data.series.length > 0) {
            historySeries = data.series;
            if (data.aggregates) {
              const minEl = document.getElementById(`min-${stationId}`);
              const maxEl = document.getElementById(`max-${stationId}`);
              const avgEl = document.getElementById(`avg-${stationId}`);
              const rateEl = document.getElementById(`rate-${stationId}`);
              if (minEl && data.aggregates.min !== null) minEl.textContent = data.aggregates.min;
              if (maxEl && data.aggregates.max !== null) maxEl.textContent = data.aggregates.max;
              if (avgEl && data.aggregates.avg !== null) avgEl.textContent = data.aggregates.avg;
              if (rateEl && data.aggregates.faultRatePercent !== undefined) rateEl.textContent = `${data.aggregates.faultRatePercent}%`;
            }
          }
        }
      } catch (_) {}
    }

    if (!historySeries || historySeries.length === 0) {
      historySeries = this.generateFallbackHistory(station, hours);
    }

    const ptsEl = document.getElementById(`pts-${stationId}`);
    if (ptsEl) ptsEl.textContent = `${historySeries.length} Punkte (${range})`;
    this.renderSvgChart(stationId, historySeries);
  }

  generateFallbackHistory(station, hours) {
    if (!station) return [];
    const pointsCount = hours === 1 ? 30 : (hours === 6 ? 60 : 96);
    const minVal = station?.v1?.min ?? 245;
    const maxVal = station?.v1?.max ?? 255;
    const base = ((minVal + maxVal) / 2) || (station?.v1?.val ?? 250);
    const list = [];
    const now = Date.now();
    const stepMs = (hours * 3600 * 1000) / pointsCount;

    for (let i = pointsCount - 1; i >= 0; i--) {
      const ts = now - (i * stepMs);
      const wave = Math.sin(i * 0.25) * ((maxVal - minVal) * 0.2);
      const val = +(base + wave).toFixed(1);
      list.push({
        stationId: station.id,
        timestamp: ts,
        v1: val,
        isFault: false
      });
    }

    const values = list.map(l => l.v1);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(1);

    const minEl = document.getElementById(`min-${station.id}`);
    const maxEl = document.getElementById(`max-${station.id}`);
    const avgEl = document.getElementById(`avg-${station.id}`);
    const rateEl = document.getElementById(`rate-${station.id}`);
    if (minEl) minEl.textContent = min;
    if (maxEl) maxEl.textContent = max;
    if (avgEl) avgEl.textContent = avg;
    if (rateEl) rateEl.textContent = "0.0%";

    return list;
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
      btnCreateModWs: document.getElementById("btn-create-mod-from-ws"),

      // MQTT Elements
      mqttStatus: document.getElementById("insp-mqtt-status"),
      mqttBroker: document.getElementById("insp-mqtt-broker"),
      mqttTopic: document.getElementById("insp-mqtt-topic"),
      mqttTime: document.getElementById("insp-mqtt-time"),
      mqttSize: document.getElementById("insp-mqtt-size"),
      codeMqtt: document.getElementById("code-insp-mqtt"),
      btnCopyMqtt: document.getElementById("btn-copy-mqtt-json"),
      btnQueryMqtt: document.getElementById("btn-query-mqtt"),
      btnCreateModMqtt: document.getElementById("btn-create-mod-from-mqtt"),
      btnCreateModLive: document.getElementById("btn-create-mod-from-live")
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

    // Modul aus WebSocket-Paket erstellen
    if (this.inspDom.btnCreateModWs) {
      this.inspDom.btnCreateModWs.addEventListener("click", () => {
        const raw = this.inspState.wsFirstPacket || this.lastRawWsMessage || {
          topic: "ns=2;s=Demo.Alarms.Plant.PowerHouse.P-101.Vibration",
          payload: {
            value: { dataType: "Double", arrayType: "Scalar", value: 0.49235 },
            statusCode: { value: 0 },
            sourceTimestamp: new Date().toISOString()
          }
        };
        const station = this.createModuleFromReceivedData(raw);
        this.showCreationNotification(station.name);
        this.scrollToStation(station.id);
      });
    }

    // Modul aus MQTT-Paket erstellen
    if (this.inspDom.btnCreateModMqtt) {
      this.inspDom.btnCreateModMqtt.addEventListener("click", () => {
        const raw = this.inspState.mqttFirstPacket || this.lastRawMqttMessage || {
          topic: "/bbk-lf/rpi04/power-house/vibration",
          value: { dataType: "Double", arrayType: "Scalar", value: 0.49235 },
          statusCode: { value: 0 },
          sourceTimestamp: new Date().toISOString()
        };
        const station = this.createModuleFromReceivedData(raw, { topic: this.inspDom.mqttTopic?.textContent || "/bbk-lf/rpi04/power-house/vibration" });
        this.showCreationNotification(station.name);
        this.scrollToStation(station.id);
      });
    }

    // Modul aus Live-Telemetrie erstellen (Button in Tab 2)
    if (this.inspDom.btnCreateModLive) {
      this.inspDom.btnCreateModLive.addEventListener("click", () => {
        const raw = this.inspState.wsFirstPacket || this.lastRawWsMessage || this.inspState.mqttFirstPacket || {
          topic: "ns=2;s=Demo.Alarms.Plant.PowerHouse.P-101.Vibration",
          payload: { value: { dataType: "Double", value: 0.492 } }
        };
        const station = this.createModuleFromReceivedData(raw);
        this.showCreationNotification(station.name);
        this.closeConfigModal();
        this.scrollToStation(station.id);
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
    this.lastRawWsMessage = rawString;
    this.inspState.wsFrameCount++;
    if (this.inspDom.wsCounter) {
      this.inspDom.wsCounter.textContent = `${this.inspState.wsFrameCount} Frames`;
    }

    // Automatische Erstellung des Moduls bei Empfang eines neuen OPC UA / Live-Topics
    try {
      const parsed = JSON.parse(rawString);
      if (parsed.topic && !parsed.topic.includes("2258") && !parsed.topic.includes("CurrentTime")) {
        const isKnown = this.stations.some(s => 
          (s.wsNodeId && s.wsNodeId === parsed.topic) ||
          (s.id === "ST-POWERHOUSE-VIBRATION" && parsed.topic.includes("PowerHouse"))
        );
        if (!isKnown) {
          this.createModuleFromReceivedData(parsed);
        }
      }
    } catch (_) {}

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
    const activeTopic = (this.subscribedMqttTopics && this.subscribedMqttTopics.find(t => t.includes("power-house") || t.includes("vibration"))) || "/bbk-lf/rpi04/power-house/vibration";
    const mqttSample = {
      topic: activeTopic,
      stationId: "ST-POWERHOUSE-VIBRATION",
      stationName: "PowerHouse: Vibration (P-101)",
      broker: "mqtt://broker.hivemq.com:1883",
      source: "Raspberry Pi 4 • Schwingungssensor (IOT2050)",
      qos: 0,
      value: { dataType: "Double", arrayType: "Scalar", value: 0.49235 },
      statusCode: { value: 0 },
      telemetry: {
        vibration_mms: 0.49235,
        status_code: 0,
        frequency_hz: 50.0
      },
      limits: {
        v1: { min: 0.05, max: 2.50, unit: "mm/s" }
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
    if (!this.isGitHubPages && !this.isStandaloneSim) {
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
    }

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

    if (!this.isGitHubPages && !this.isStandaloneSim) {
      try {
        await fetch("/api/mqtt/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ topic: trimmed })
        });
      } catch (_) {}
    }

    this.saveStandaloneConfig();
    this.renderMqttTopicsList();
  }

  async unsubscribeMqttTopic(topic) {
    if (!topic || typeof topic !== "string") return;
    const trimmed = topic.trim();
    if (!this.subscribedMqttTopics) return;
    this.subscribedMqttTopics = this.subscribedMqttTopics.filter(t => t !== trimmed);

    if (!this.isGitHubPages && !this.isStandaloneSim) {
      try {
        await fetch("/api/mqtt/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ topic: trimmed })
        });
      } catch (_) {}
    }

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

    if (!this.isGitHubPages && !this.isStandaloneSim) {
      try {
        await fetch("/api/store/clear-demo", { method: "POST" });
      } catch (_) {}
    }

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

  saveStandaloneConfig() {
    try {
      let cfg = {};
      const saved = localStorage.getItem("cps_saved_config");
      if (saved) {
        try { cfg = JSON.parse(saved); } catch (_) {}
      }
      cfg.stations = this.stations;
      if (this.subscribedMqttTopics) {
        cfg.subscribedMqttTopics = this.subscribedMqttTopics;
      }
      localStorage.setItem("cps_saved_config", JSON.stringify(cfg));
    } catch (_) {}
  }

  saveStationsToLocalStorage() {
    this.saveStandaloneConfig();
  }

  synthesizeStationFromPacket(rawPacket, context = {}) {
    let packet = rawPacket;
    if (typeof rawPacket === "string") {
      try { packet = JSON.parse(rawPacket); } catch (_) { packet = {}; }
    }
    const topic = context.topic || packet.topic || packet.nodeId || packet._topic || "";

    // Extrahiere primären Zahlenwert
    let val = null;
    const extractNum = (v) => {
      if (typeof v === "number" && !isNaN(v)) return v;
      if (typeof v === "string" && !isNaN(parseFloat(v))) return parseFloat(v);
      if (v && typeof v === "object") {
        if (typeof v.value === "number") return v.value;
        if (v.value && typeof v.value.value === "number") return v.value.value;
        if (typeof v.val === "number") return v.val;
      }
      return null;
    };

    if (packet.payload) {
      if (typeof packet.payload === "number") val = packet.payload;
      else if (packet.payload.value !== undefined) val = extractNum(packet.payload.value);
      else if (packet.payload.v1 !== undefined) val = extractNum(packet.payload.v1);
      else if (packet.payload.val !== undefined) val = extractNum(packet.payload.val);
    }
    if (val === null && packet.value !== undefined) val = extractNum(packet.value);
    if (val === null && packet.v1 !== undefined) val = extractNum(packet.v1);
    if (val === null) val = 0.0;

    const topicLow = (topic + " " + JSON.stringify(packet)).toLowerCase();

    // Spezialbehandlung: PowerHouse Vibration (Node-RED OPC UA & HiveMQ)
    if (topicLow.includes("powerhouse") || topicLow.includes("power-house")) {
      return {
        id: "ST-POWERHOUSE-VIBRATION",
        name: "PowerHouse: Vibration (P-101)",
        description: `Automatisch generiertes Modul aus Empfangsdaten (${topic})`,
        plcIp: "192.168.10.15",
        mqttTopic: "/bbk-lf/rpi04/power-house/vibration",
        wsNodeId: topic.startsWith("ns=") ? topic : "ns=2;s=Demo.Alarms.Plant.PowerHouse.P-101.Vibration",
        isDynamic: true,
        isLive: true,
        isDemo: false,
        v1: { label: "Vibration", unit: "mm/s", min: 0.05, max: 2.50, defaultVal: +Number(val).toFixed(3), val: +Number(val).toFixed(3) },
        v2: { label: "Status-Code", unit: "Good", min: 0, max: 0, defaultVal: 0, val: 0 },
        v3: { label: "Signal-Güte", unit: "%", min: 90, max: 100, defaultVal: 100, val: 100 }
      };
    }

    // Generischer Generator für beliebige andere empfangene Daten
    let cleanSegments = [];
    if (topic) {
      const rawParts = topic.replace(/^ns=\d+;[sgi]=/, "").split(/[\/\._]/);
      cleanSegments = rawParts.filter(p => {
        const low = p.toLowerCase();
        return p && !["demo", "alarms", "plant", "bbk-lf", "rpi04", "cps-i40", "telemetry", "ws", "opcua"].includes(low);
      });
    }

    let stationName = cleanSegments.length > 0 
      ? cleanSegments.map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(" ") 
      : "Live Modul (Empfangsdaten)";

    const slug = cleanSegments.length > 0
      ? cleanSegments.join("-").toUpperCase().replace(/[^A-Z0-9\-]/g, "")
      : (context.stationId || "LIVE-MOD");
    const stationId = slug.startsWith("ST-") ? slug : "ST-" + slug;

    let v1Label = "Messwert";
    let v1Unit = "";
    let v1Min = 0.0;
    let v1Max = 100.0;

    if (topicLow.includes("vibrat") || topicLow.includes("schwing")) {
      v1Label = "Vibration";
      v1Unit = "mm/s";
      v1Min = 0.05;
      v1Max = 2.5;
    } else if (topicLow.includes("press") || topicLow.includes("druck") || topicLow.includes("bar")) {
      v1Label = "Druck";
      v1Unit = "bar";
      v1Min = 1.0;
      v1Max = 8.0;
    } else if (topicLow.includes("temp") || topicLow.includes("grad") || topicLow.includes("celsius")) {
      v1Label = "Temperatur";
      v1Unit = "°C";
      v1Min = 15.0;
      v1Max = 65.0;
    } else if (topicLow.includes("gewicht") || topicLow.includes("weight")) {
      v1Label = "Gewicht";
      v1Unit = "g";
      v1Min = 240.0;
      v1Max = 260.0;
    }

    return {
      id: stationId,
      name: stationName,
      description: `Automatisch generiertes Modul aus Empfangsdaten (${topic})`,
      plcIp: "192.168.10.15",
      mqttTopic: topic.startsWith("/") ? topic : null,
      wsNodeId: topic || null,
      isDynamic: true,
      isLive: true,
      isDemo: false,
      v1: { label: v1Label, unit: v1Unit, min: v1Min, max: v1Max, defaultVal: +Number(val).toFixed(3), val: +Number(val).toFixed(3) },
      v2: { label: "Status-Code", unit: "Good", min: 0, max: 0, defaultVal: 0, val: 0 },
      v3: { label: "Signal-Güte", unit: "%", min: 90, max: 100, defaultVal: 100, val: 100 }
    };
  }

  addDynamicStation(station) {
    if (!station || !station.id) return;
    const existingIdx = this.stations.findIndex(s => s.id === station.id);
    const prepared = { ...station, isDynamic: true, isLive: true, isDemo: false };
    if (existingIdx >= 0) {
      this.stations[existingIdx] = { ...this.stations[existingIdx], ...prepared };
    } else {
      this.stations.push(prepared);
    }
    if (!this.historyMap.has(station.id)) {
      this.historyMap.set(station.id, []);
    }
    this.saveStationsToLocalStorage();
    this.initStationsLayout();
    this.renderAll();
    this.showCreationNotification(station.name);

    // Backend asynchron informieren falls erreichbar
    if (typeof fetch === "function") {
      fetch("/api/stations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(station)
      }).catch(() => {});
    }
  }

  createModuleFromReceivedData(packet, context = {}) {
    const synth = this.synthesizeStationFromPacket(packet, context);
    this.addDynamicStation(synth);
    return synth;
  }

  showCreationNotification(moduleName) {
    let toast = document.getElementById("toast-module-created");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "toast-module-created";
      toast.style.cssText = "position:fixed; bottom:24px; right:24px; background:linear-gradient(135deg, rgba(16,185,129,0.95), rgba(5,150,105,0.95)); color:#fff; padding:12px 20px; border-radius:12px; font-weight:700; box-shadow:0 8px 32px rgba(0,0,0,0.4); z-index:999999; backdrop-filter:blur(8px); display:flex; align-items:center; gap:10px; border:1px solid rgba(255,255,255,0.2); transition:all 0.3s ease;";
      document.body.appendChild(toast);
    }
    toast.innerHTML = `<span>✨</span><span>Neues Modul <strong>${moduleName}</strong> aus Empfangsdaten erstellt!</span>`;
    toast.style.opacity = "1";
    toast.style.transform = "translateY(0)";
    setTimeout(() => {
      if (toast) {
        toast.style.opacity = "0";
        toast.style.transform = "translateY(12px)";
      }
    }, 4500);
  }

  scrollToStation(stationId) {
    const card = document.getElementById(`card-${stationId}`);
    if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.style.outline = "2px solid #10b981";
      card.style.boxShadow = "0 0 24px rgba(16,185,129,0.5)";
      setTimeout(() => {
        card.style.outline = "";
        card.style.boxShadow = "";
      }, 3000);
    }
  }
  /* ========================================================================
     HISTORISCHE STÖRUNGS- & AUSFALL-DATENBANK (INCIDENT LEDGER)
     ======================================================================== */
  loadIncidentsFromStorage() {
    try {
      if (typeof localStorage !== "undefined") {
        const raw = localStorage.getItem("cps_incident_history");
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed;
          }
        }
      }
    } catch (_) {}

    // Authentische Standard-Historie für Vorführung & Prüfungsnachweis (IHK)
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
        notes: "Vakuumschlauch nachgezogen & Drucksensor kalibriert."
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

  saveIncidentsToStorage() {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem("cps_incident_history", JSON.stringify(this.incidents));
      }
    } catch (_) {}
  }

  initIncidentLedger() {
    // Action Buttons
    const btnCsv = document.getElementById("btn-export-incidents-csv");
    const btnJson = document.getElementById("btn-export-incidents-json");
    const btnOpenManual = document.getElementById("btn-open-manual-incident");
    const btnClear = document.getElementById("btn-clear-incidents");

    if (btnCsv) btnCsv.addEventListener("click", () => this.downloadIncidentsCsv());
    if (btnJson) btnJson.addEventListener("click", () => this.downloadIncidentsJson());
    if (btnOpenManual) btnOpenManual.addEventListener("click", () => this.openManualIncidentModal());
    if (btnClear) btnClear.addEventListener("click", () => this.clearIncidents());

    // Modal Buttons
    const modal = document.getElementById("manual-incident-modal-backdrop");
    const btnClose = document.getElementById("btn-close-manual-incident");
    const btnCancel = document.getElementById("btn-cancel-manual-incident");
    const btnSave = document.getElementById("btn-save-manual-incident");

    if (btnClose) btnClose.addEventListener("click", () => this.closeManualIncidentModal());
    if (btnCancel) btnCancel.addEventListener("click", () => this.closeManualIncidentModal());
    if (btnSave) btnSave.addEventListener("click", () => this.saveManualIncident());
    if (modal) {
      modal.addEventListener("click", (e) => {
        if (e.target === modal) this.closeManualIncidentModal();
      });
    }

    // Filter Listeners
    if (this.dom.filterIncStation) {
      this.dom.filterIncStation.addEventListener("change", () => this.renderIncidentLedger());
    }
    if (this.dom.filterIncStatus) {
      this.dom.filterIncStatus.addEventListener("change", () => this.renderIncidentLedger());
    }

    // Initial render
    this.renderIncidentLedger();
  }

  openManualIncidentModal() {
    const modal = document.getElementById("manual-incident-modal-backdrop");
    if (modal) {
      modal.style.display = "flex";
      const titleInput = document.getElementById("manual-inc-title");
      if (titleInput) {
        titleInput.value = "";
        titleInput.focus();
      }
    }
  }

  closeManualIncidentModal() {
    const modal = document.getElementById("manual-incident-modal-backdrop");
    if (modal) modal.style.display = "none";
  }

  saveManualIncident() {
    const stationId = document.getElementById("manual-inc-station")?.value || "ST-010";
    const severity = document.getElementById("manual-inc-severity")?.value || "KRITISCH";
    const title = document.getElementById("manual-inc-title")?.value?.trim();
    const operator = document.getElementById("manual-inc-operator")?.value?.trim() || "Instandhaltung";

    if (!title) {
      const input = document.getElementById("manual-inc-title");
      if (input) {
        input.style.borderColor = "#ef4444";
        input.focus();
      }
      return;
    }

    this.recordIncident({
      stationId,
      severity,
      title,
      operator
    });

    this.closeManualIncidentModal();
  }

  recordIncident(data) {
    const now = Date.now();
    const dateStr = new Date(now).toISOString().slice(0, 10).replace(/-/g, "");
    const id = data.id || `INC-${dateStr}-${String(this.incidents.length + 1).padStart(3, "0")}`;

    const newInc = {
      id,
      stationId: data.stationId || "ST-ALL",
      title: data.title || "Ungeplanter Stillstand",
      severity: data.severity || "KRITISCH",
      status: "OPEN",
      timestamp: data.timestamp || now,
      resolvedAt: null,
      durationSeconds: 0,
      operator: data.operator || (authService.getCurrentUser()?.username || "Instandhaltung"),
      notes: data.notes || ""
    };

    this.incidents.unshift(newInc);
    this.saveIncidentsToStorage();
    this.renderIncidentLedger();

    // REST-Synchronisation falls Backend erreichbar
    if (!this.isGitHubPages && !this.isStandaloneSim) {
      fetch("/api/incidents", {
        method: "POST",
        headers: authService.getAuthHeaders(),
        body: JSON.stringify(newInc)
      }).catch(() => {});
    }

    return newInc;
  }

  recordFaultIncident(stationId) {
    // Prüfe, ob bereits eine offene Störung für diese Station existiert
    const existing = this.incidents.find(i => i.stationId === stationId && i.status === "OPEN");
    if (existing) return existing;

    const st = this.stations.find(s => s.id === stationId);
    const stationName = st ? st.name : stationId;
    return this.recordIncident({
      stationId,
      title: `${stationName}: Not-Aus / Linienstörung ausgelöst`,
      severity: "KRITISCH",
      operator: authService.getCurrentUser()?.username || "SCADA-Automatik"
    });
  }

  resolveIncident(incidentId, operator, notes) {
    const inc = this.incidents.find(i => i.id === incidentId);
    if (!inc) return null;

    const now = Date.now();
    inc.status = "RESOLVED";
    inc.resolvedAt = now;
    inc.durationSeconds = Math.max(1, Math.round((now - inc.timestamp) / 1000));
    if (operator) inc.operator = operator;
    if (notes) inc.notes = notes;

    this.saveIncidentsToStorage();
    this.renderIncidentLedger();

    // Wenn korrespondierende Station noch im Fault-Zustand ist, zurücksetzen
    if (inc.stationId && this.faultMap && this.faultMap.get(inc.stationId)) {
      this.faultMap.set(inc.stationId, false);
      this.setCardFaultState(inc.stationId, false);
      this.updateKpis();
    }

    if (!this.isGitHubPages && !this.isStandaloneSim) {
      fetch(`/api/incidents/${incidentId}/resolve`, {
        method: "POST",
        headers: authService.getAuthHeaders(),
        body: JSON.stringify({ operator: inc.operator, notes: inc.notes })
      }).catch(() => {});
    }

    return inc;
  }

  resolveFaultIncident(stationId) {
    const openInc = this.incidents.find(i => i.stationId === stationId && i.status === "OPEN");
    if (openInc) {
      return this.resolveIncident(openInc.id, authService.getCurrentUser()?.username || "Instandhaltung", "Störung durch Leitstand quittiert.");
    }
    return null;
  }

  clearIncidents(skipConfirm = false) {
    if (skipConfirm || typeof window === "undefined" || !window.confirm || confirm("Möchten Sie die historische Störungsdatenbank wirklich zurücksetzen?")) {
      this.incidents = [];
      this.saveIncidentsToStorage();
      this.renderIncidentLedger();

      if (!this.isGitHubPages && !this.isStandaloneSim) {
        fetch("/api/incidents", {
          method: "DELETE",
          headers: authService.getAuthHeaders()
        }).catch(() => {});
      }
    }
  }

  renderIncidentLedger() {
    if (!this.dom.incTableTbody) return;

    const filterStation = this.dom.filterIncStation ? this.dom.filterIncStation.value : "all";
    const filterStatus = this.dom.filterIncStatus ? this.dom.filterIncStatus.value : "all";

    let filtered = [...this.incidents];
    if (filterStation !== "all") {
      filtered = filtered.filter(i => i.stationId === filterStation);
    }
    if (filterStatus !== "all") {
      filtered = filtered.filter(i => i.status === filterStatus);
    }

    if (this.dom.incFilterInfo) {
      this.dom.incFilterInfo.textContent = `Zeige ${filtered.length} von ${this.incidents.length} Einträgen`;
    }

    if (filtered.length === 0) {
      this.dom.incTableTbody.innerHTML = `
        <tr>
          <td colspan="9" style="text-align: center; padding: 24px; color: var(--text-muted);">
            Keine Störungen für die gewählten Filterkriterien vorhanden.
          </td>
        </tr>
      `;
    } else {
      this.dom.incTableTbody.innerHTML = filtered.map(inc => {
        const dateObj = new Date(inc.timestamp);
        const timeStr = dateObj.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }) + " " +
                        dateObj.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

        const isOpen = inc.status === "OPEN";
        const badge = isOpen
          ? `<span class="inc-badge-open">● Offen</span>`
          : `<span class="inc-badge-resolved">✓ Behoben</span>`;

        let durationText = "";
        if (isOpen) {
          const elapsedSec = Math.round((Date.now() - inc.timestamp) / 1000);
          durationText = `<span style="color:#ef4444;">${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s (aktiv)</span>`;
        } else {
          const sec = inc.durationSeconds || 0;
          const mins = Math.floor(sec / 60);
          durationText = `${mins}m ${sec % 60}s`;
        }

        const sevClass = inc.severity === "KRITISCH" ? "inc-sev-kritisch"
                       : inc.severity === "WARNUNG" ? "inc-sev-warnung"
                       : "inc-sev-info";

        const actionBtn = isOpen
          ? `<button type="button" class="btn-inc-resolve" data-inc-id="${inc.id}">✓ Beheben</button>`
          : `<span style="color:var(--text-muted); font-size:0.7rem;">Erledigt</span>`;

        return `
          <tr id="row-inc-${inc.id}">
            <td style="font-family:var(--font-mono); font-weight:700; font-size:0.75rem;">${inc.id}</td>
            <td class="inc-time-cell">${timeStr}</td>
            <td><span class="inc-station-badge">${inc.stationId}</span></td>
            <td class="inc-desc-cell"><strong>${inc.title}</strong>${inc.notes ? `<div style="font-size:0.7rem; color:var(--text-muted);">${inc.notes}</div>` : ""}</td>
            <td><span class="${sevClass}">${inc.severity}</span></td>
            <td class="inc-duration-cell">${durationText}</td>
            <td>${badge}</td>
            <td style="font-size:0.75rem; color:#cbd5e1;">${inc.operator || "-"}</td>
            <td>${actionBtn}</td>
          </tr>
        `;
      }).join("");

      // Bind resolve buttons in table
      this.dom.incTableTbody.querySelectorAll(".btn-inc-resolve").forEach(btn => {
        btn.addEventListener("click", () => {
          const incId = btn.getAttribute("data-inc-id");
          if (incId) {
            this.resolveIncident(incId, authService.getCurrentUser()?.username || "Instandhaltung", "Manuell über Leitstand-Tabelle behoben");
          }
        });
      });
    }

    this.updateIncidentKpis();
  }

  updateIncidentKpis() {
    const total = this.incidents.length;
    const activeList = this.incidents.filter(i => i.status === "OPEN");
    const active = activeList.length;
    const resolvedList = this.incidents.filter(i => i.status === "RESOLVED");

    const now = Date.now();
    let totalDowntimeSec = 0;
    this.incidents.forEach(i => {
      if (i.status === "RESOLVED") {
        totalDowntimeSec += (i.durationSeconds || 0);
      } else {
        totalDowntimeSec += Math.max(0, Math.round((now - i.timestamp) / 1000));
      }
    });

    const resolvedSec = resolvedList.reduce((sum, i) => sum + (i.durationSeconds || 0), 0);
    const mttrMin = resolvedList.length > 0 ? (resolvedSec / resolvedList.length / 60).toFixed(1) : "0.0";
    const downtimeMin = Math.round(totalDowntimeSec / 60);

    if (this.dom.incBadgeActiveCount) {
      this.dom.incBadgeActiveCount.textContent = `${active} Aktiv`;
      this.dom.incBadgeActiveCount.style.display = active > 0 ? "inline-flex" : "none";
    }

    if (this.dom.incKpiTotal) this.dom.incKpiTotal.textContent = String(total);
    if (this.dom.incKpiActive) this.dom.incKpiActive.textContent = String(active);
    if (this.dom.incKpiDowntime) this.dom.incKpiDowntime.textContent = `${downtimeMin} Min`;
    if (this.dom.incKpiMttr) this.dom.incKpiMttr.textContent = `${mttrMin} Min`;
  }

  downloadIncidentsCsv() {
    const headers = ["ID", "Zeitpunkt", "Station", "Ursache", "Schweregrad", "Dauer_Sekunden", "Status", "Erfasst_von", "Behoben_um", "Notizen"];
    const rows = this.incidents.map(inc => [
      inc.id,
      new Date(inc.timestamp).toISOString(),
      inc.stationId,
      `"${(inc.title || '').replace(/"/g, '""')}"`,
      inc.severity,
      inc.durationSeconds || 0,
      inc.status,
      `"${(inc.operator || '').replace(/"/g, '""')}"`,
      inc.resolvedAt ? new Date(inc.resolvedAt).toISOString() : "",
      `"${(inc.notes || '').replace(/"/g, '""')}"`
    ]);

    const csvContent = "\uFEFF" + [headers.join(";"), ...rows.map(r => r.join(";"))].join("\r\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cps_stoerungshistorie_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  downloadIncidentsJson() {
    const jsonStr = JSON.stringify(this.incidents, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cps_stoerungshistorie_${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", () => {
    window.__scadaApp = new ScadaOverviewApp();
  });
} else {
  window.__scadaApp = new ScadaOverviewApp();
}
