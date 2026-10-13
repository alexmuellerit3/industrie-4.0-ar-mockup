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
    this.ws = null;
    this.reconnectTimer = null;
    this.restFallbackTimer = null;

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
    this.connectWebSocket();
    this.startClock();
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
              <span class="station-main-title">${st.name}</span>
              <span class="station-meta-sub">SPS: ${st.plcIp} • OPC UA ns=2</span>
            </div>
          </div>
          <span class="heroui-status-chip" id="pill-${st.id}">
            <span class="chip-dot"></span>
            <span id="pill-text-${st.id}">NORMAL</span>
          </span>
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

      this.dom.stationsContainer.appendChild(card);

      const btnFault = card.querySelector(`#btn-fault-${st.id}`);
      btnFault.addEventListener("click", () => this.toggleFault(st.id));
    });
  }

  /**
   * Verbindet mit dem WebSocket-Server
   */
  connectWebSocket() {
    if (this.ws) {
      try { this.ws.close(); } catch (_) {}
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host || "localhost:3000";
    const wsUrl = `${protocol}//${host}/ws/telemetry`;

    this.updateWsBadge(false, "Verbinde...");

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.updateWsBadge(true, "Live (300s)");
        if (this.restFallbackTimer) {
          clearInterval(this.restFallbackTimer);
          this.restFallbackTimer = null;
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.handleSocketMessage(data);
        } catch (e) {
          console.warn("[SCADA] Ungültiges WebSocket-Paket:", e);
        }
      };

      this.ws.onclose = () => {
        this.updateWsBadge(false, "Getrennt");
        this.scheduleReconnect();
        this.startRestFallback();
      };

      this.ws.onerror = () => {
        this.updateWsBadge(false, "Fehler");
        this.ws.close();
      };
    } catch (e) {
      this.updateWsBadge(false, "Offline");
      this.scheduleReconnect();
      this.startRestFallback();
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWebSocket();
    }, 3500);
  }

  startRestFallback() {
    if (this.restFallbackTimer) return;
    this.fetchRestSnapshot();
    this.restFallbackTimer = setInterval(() => this.fetchRestSnapshot(), 2000);
  }

  async fetchRestSnapshot() {
    try {
      const res = await fetch("/api/history");
      if (res.ok) {
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
      }
    } catch (_) {}
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
      if (!this.historyMap.has(stationId)) {
        this.historyMap.set(stationId, []);
      }
      const list = this.historyMap.get(stationId);
      list.push(sample);
      
      const cutoff = Date.now() - 300000;
      while (list.length > 0 && list[0].timestamp < cutoff) {
        list.shift();
      }

      if (summary) {
        this.summaryMap.set(stationId, summary);
      }

      this.updateStationCard(stationId, sample, summary);
      this.updateKpis();
    } else if (msg.type === "fault_change") {
      this.setCardFaultState(msg.stationId, msg.isFault);
      this.updateKpis();
    } else if (msg.type === "status") {
      this.updateMqttBadge(msg.connected, msg.simulated);
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
    const card = document.getElementById(`card-${stationId}`);
    const isCurrentlyFault = card ? card.classList.contains("alert-state") : false;
    const targetState = !isCurrentlyFault;

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        type: "toggle_fault",
        stationId,
        isFault: targetState
      }));
    }

    fetch("/api/fault", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stationId, isFault: targetState })
    }).catch(() => {});

    this.setCardFaultState(stationId, targetState);
    this.updateKpis();
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
    if (this.dom.wsBadgeDot) {
      this.dom.wsBadgeDot.className = online ? "chip-dot pulse" : "chip-dot alert";
    }
    if (this.dom.wsBadgeText) {
      this.dom.wsBadgeText.textContent = `WS: ${text}`;
    }
  }

  updateMqttBadge(connected, simulated) {
    if (this.dom.mqttBadgeDot) {
      this.dom.mqttBadgeDot.className = (connected || simulated) ? "chip-dot" : "chip-dot alert";
    }
    if (this.dom.mqttBadgeText) {
      this.dom.mqttBadgeText.textContent = connected
        ? "MQTT: Verbunden"
        : (simulated ? "MQTT: SPS-Sim" : "MQTT: Offline");
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
}

window.addEventListener("DOMContentLoaded", () => {
  window.__scadaApp = new ScadaOverviewApp();
});
