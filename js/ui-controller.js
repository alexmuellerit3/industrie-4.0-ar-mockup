/**
 * UIController - Steuert die schlanke, funktionale HMI-Benutzeroberfläche.
 * Aktualisiert Messwert-Zellen, Status-Tags, Störungsanzeigen und Zoom-Button.
 */

export class UIController {
  constructor({ onNextStation, onToggleFault, onToggleSim, onZoomCycle, onCloseCard }) {
    // Callbacks
    this.onNextStation = onNextStation;
    this.onToggleFault = onToggleFault;
    this.onToggleSim = onToggleSim;
    this.onZoomCycle = onZoomCycle;
    this.onCloseCard = onCloseCard;

    // DOM-Elemente
    this.viewfinder = document.getElementById("viewfinder");
    this.stationCard = document.getElementById("station-card");
    this.statusDot = document.getElementById("status-dot");
    this.stName = document.getElementById("st-name");
    this.stTag = document.getElementById("st-tag");
    this.stSub = document.getElementById("st-sub");
    this.alertStrip = document.getElementById("alert-strip");
    this.btnCloseCard = document.getElementById("btn-close-card");

    // Werte-Spalten
    this.v1Lbl = document.getElementById("v1-lbl");
    this.v1Val = document.getElementById("v1-val");
    this.v1Unit = document.getElementById("v1-unit");
    this.v1Trend = document.getElementById("v1-trend");
    this.v1Spark = document.getElementById("v1-spark");

    this.v2Lbl = document.getElementById("v2-lbl");
    this.v2Val = document.getElementById("v2-val");
    this.v2Unit = document.getElementById("v2-unit");
    this.v2Trend = document.getElementById("v2-trend");
    this.v2Spark = document.getElementById("v2-spark");
    this.cellV2 = document.getElementById("cell-v2");

    this.v3Lbl = document.getElementById("v3-lbl");
    this.v3Val = document.getElementById("v3-val");
    this.v3Unit = document.getElementById("v3-unit");
    this.v3Trend = document.getElementById("v3-trend");
    this.v3Spark = document.getElementById("v3-spark");

    // Tablet-Diagnose DOM-Elemente
    this.tabPlc = document.getElementById("tab-plc");
    this.tabOpc = document.getElementById("tab-opc");
    this.tabTol1 = document.getElementById("tab-tol1");
    this.tabTol2 = document.getElementById("tab-tol2");
    this.tabNode = document.getElementById("tab-node");
    this.tabTrendText = document.getElementById("tab-trend-text");
    this.tabTrendDot = document.getElementById("tab-trend-dot");
    this.tab5mMin = document.getElementById("tab-5m-min");
    this.tab5mMax = document.getElementById("tab-5m-max");
    this.tab5mAvg = document.getElementById("tab-5m-avg");
    this.tab5mRate = document.getElementById("tab-5m-rate");

    // Buttons
    this.btnNext = document.getElementById("btn-next");
    this.btnFault = document.getElementById("btn-fault");
    this.btnSim = document.getElementById("btn-sim");
    this.btnZoom = document.getElementById("btn-zoom");

    // Modal & Konfiguration
    this.btnOpenConfig = document.getElementById("btn-open-config");
    this.modalBackdrop = document.getElementById("config-modal-backdrop");
    this.btnCloseConfig = document.getElementById("btn-close-config");
    this.btnCancelConfig = document.getElementById("ar-btn-cancel-config");
    this.btnSaveConfig = document.getElementById("ar-btn-save-config");
    this.btnTestMqtt = document.getElementById("ar-btn-test-mqtt");
    this.btnResetDefaults = document.getElementById("ar-btn-reset-defaults");
    this.inputMqttUrl = document.getElementById("ar-cfg-mqtt-url");
    this.statusVal = document.getElementById("ar-cfg-status-val");
    this.activeUrl = document.getElementById("ar-cfg-active-url");
    this.testResult = document.getElementById("ar-mqtt-test-result");
    this.stationsList = document.getElementById("ar-cfg-stations-list");
    this.feedbackMsg = document.getElementById("ar-modal-feedback-msg");
    this.historyTtl = document.getElementById("ar-cfg-history-ttl");
    this.pollInterval = document.getElementById("ar-cfg-poll-interval");

    this.bindEvents();
  }

  bindEvents() {
    const bindTap = (elem, handler) => {
      if (!elem) return;
      let lastTime = 0;
      const onAction = (e) => {
        const now = Date.now();
        if (now - lastTime < 300) return;
        lastTime = now;
        e.stopPropagation();
        handler();
      };
      elem.addEventListener("click", onAction);
      elem.addEventListener("touchend", onAction);
    };

    bindTap(this.btnCloseCard, () => {
      if (this.onCloseCard) this.onCloseCard();
    });

    bindTap(this.btnNext, () => {
      if (this.onNextStation) this.onNextStation();
    });

    bindTap(this.btnFault, () => {
      if (this.onToggleFault) this.onToggleFault();
    });

    bindTap(this.btnSim, () => {
      if (this.onToggleSim) this.onToggleSim();
    });

    bindTap(this.btnZoom, () => {
      if (this.onZoomCycle) this.onZoomCycle();
    });

    bindTap(this.btnOpenConfig, () => this.openConfigModal());
    bindTap(this.btnCloseConfig, () => this.closeConfigModal());
    bindTap(this.btnCancelConfig, () => this.closeConfigModal());
    bindTap(this.btnTestMqtt, () => this.testMqtt());
    bindTap(this.btnSaveConfig, () => this.saveConfig());
    bindTap(this.btnResetDefaults, () => this.resetDefaults());

    if (this.modalBackdrop) {
      this.modalBackdrop.addEventListener("click", (e) => {
        if (e.target === this.modalBackdrop) this.closeConfigModal();
      });

      // Tabs
      const tabBtns = this.modalBackdrop.querySelectorAll(".heroui-tab-btn");
      tabBtns.forEach(btn => {
        btn.addEventListener("click", () => {
          const targetId = btn.getAttribute("data-tab");
          tabBtns.forEach(b => b.classList.remove("active"));
          btn.classList.add("active");

          const panes = this.modalBackdrop.querySelectorAll(".tab-pane");
          panes.forEach(p => p.classList.remove("active"));
          const targetPane = document.getElementById(targetId);
          if (targetPane) targetPane.classList.add("active");
        });
      });

      // Presets
      const presetPills = this.modalBackdrop.querySelectorAll(".preset-pill");
      presetPills.forEach(pill => {
        pill.addEventListener("click", () => {
          const url = pill.getAttribute("data-url");
          if (url && this.inputMqttUrl) {
            this.inputMqttUrl.value = url;
          }
        });
      });
    }
  }

  /**
   * Rendert den aktuellen Datensatz in das HUD
   * @param {Object} station - Stationsdaten
   * @param {boolean} isFault - Störungszustand
   * @param {Object} [summary] - 5-Minuten Aggregation
   */
  render(station, isFault, summary = null) {
    if (!station) return;

    this.stName.textContent = station.name;

    if (isFault) {
      this.stTag.textContent = "STÖRUNG";
      this.stTag.className = "station-status-tag alert-state";
      this.alertStrip.style.display = "block";
      this.statusDot.style.background = "var(--status-fault)";
      this.btnFault.textContent = "Störung beheben";

      // Zweite Spalte als Störungszelle markieren
      this.cellV2.classList.add("alert-active");
      this.v2Val.textContent = "2.8";
    } else {
      this.stTag.textContent = "NORMAL";
      this.stTag.className = "station-status-tag";
      this.alertStrip.style.display = "none";
      this.statusDot.style.background = "var(--status-ok)";
      this.btnFault.textContent = "Störung simulieren";

      this.cellV2.classList.remove("alert-active");
      this.v2Val.textContent = station.v2.val;
    }

    // Spalte 1
    this.v1Lbl.textContent = station.v1.label;
    this.v1Val.textContent = station.v1.val;
    this.v1Unit.textContent = station.v1.unit;
    this.renderTrendArrow(this.v1Trend, station.v1?.trend);
    this.renderSparkline(this.v1Spark, station.v1?.history, false);

    // Spalte 2
    this.v2Lbl.textContent = station.v2.label;
    this.v2Unit.textContent = station.v2.unit;
    this.renderTrendArrow(this.v2Trend, station.v2?.trend);
    this.renderSparkline(this.v2Spark, station.v2?.history, isFault);

    // Spalte 3
    this.v3Lbl.textContent = station.v3.label;
    this.v3Val.textContent = station.v3.val;
    this.v3Unit.textContent = station.v3.unit;
    this.renderTrendArrow(this.v3Trend, station.v3?.trend);
    this.renderSparkline(this.v3Spark, station.v3?.history, false);

    // Tablet-Erweiterung: Detaillierte Diagnosewerte aktualisieren
    if (this.tabPlc) this.tabPlc.textContent = station.plcIp || "192.168.10.x";
    if (this.tabNode) this.tabNode.textContent = station.v1?.nodeId || "ns=2;s=...";
    
    if (this.tabTol1) {
      this.tabTol1.textContent = station.v1?.min !== undefined 
        ? `${station.v1.min} - ${station.v1.max} ${station.v1.unit}` 
        : "Nennbereich fix";
    }
    if (this.tabTol2) {
      this.tabTol2.textContent = station.v2?.min !== undefined 
        ? `${station.v2.min} - ${station.v2.max} ${station.v2.unit}` 
        : "Nennbereich fix";
    }

    if (this.tabOpc && this.tabTrendText && this.tabTrendDot) {
      if (isFault) {
        this.tabOpc.textContent = "Warnung: Toleranzfehler";
        this.tabOpc.className = "detail-val text-fault";
        this.tabTrendText.textContent = "Kritischer Druckabfall (< 4.5 bar) • SPS-Stopp empfohlen";
        this.tabTrendDot.className = "trend-indicator-dot alert-active";
      } else {
        this.tabOpc.textContent = "Verbunden (ns=2)";
        this.tabOpc.className = "detail-val text-ok";
        this.tabTrendText.textContent = "Prozess im Soll • 30s Schwankungsbreite < 0.2%";
        this.tabTrendDot.className = "trend-indicator-dot";
      }
    }

    // 5-Minuten KeyValueStore Aggregationen im Panel darstellen
    if (summary && summary.v1) {
      if (this.tab5mMin) this.tab5mMin.textContent = summary.v1.min;
      if (this.tab5mMax) this.tab5mMax.textContent = summary.v1.max;
      if (this.tab5mAvg) this.tab5mAvg.textContent = summary.v1.avg;
      if (this.tab5mRate) this.tab5mRate.textContent = `${summary.faultRatePercent}%`;
    }
  }

  /**
   * Zeichnet eine saubere, hochauflösende Vektor-Sparkline in ein SVG
   * @param {SVGElement} svg - Das Ziel-SVG-Element
   * @param {Array<number>} history - Historische Messwerte
   * @param {boolean} isAlert - Störungszustand
   */
  renderSparkline(svg, history, isAlert) {
    if (!svg || !history || history.length < 2) return;
    const polyline = svg.querySelector("polyline");
    if (!polyline) return;

    const min = Math.min(...history);
    const max = Math.max(...history);
    const range = (max - min) === 0 ? 1 : (max - min);

    const points = history.map((val, i) => {
      const x = ((i / (history.length - 1)) * 100).toFixed(1);
      // y-Achse invertiert (0 ist oben): 2px Padding oben & unten
      const y = (21 - ((val - min) / range) * 18).toFixed(1);
      return `${x},${y}`;
    }).join(" ");

    polyline.setAttribute("points", points);
    polyline.setAttribute("stroke", isAlert ? "var(--status-fault)" : "var(--status-ok)");
  }

  /**
   * Aktualisiert den Trend-Pfeil (↗, →, ↘)
   */
  renderTrendArrow(el, trend) {
    if (!el) return;
    if (trend === "up") {
      el.textContent = "↗";
      el.className = "sensor-trend trend-up";
    } else if (trend === "down") {
      el.textContent = "↘";
      el.className = "sensor-trend trend-down";
    } else {
      el.textContent = "→";
      el.className = "sensor-trend";
    }
  }

  showStationCard() {
    if (this.viewfinder) this.viewfinder.style.opacity = "0";
    if (this.stationCard) this.stationCard.style.display = "block";
  }

  hideStationCard() {
    if (this.viewfinder) this.viewfinder.style.opacity = "1";
    if (this.stationCard) this.stationCard.style.display = "none";
  }

  updateSimButton(isActive) {
    if (this.btnSim) {
      this.btnSim.textContent = isActive ? "Sim: AN" : "Sim: Kamera";
    }
  }

  updateZoomDisplay(level) {
    if (this.btnZoom) {
      this.btnZoom.textContent = `${level.toFixed(1)}×`;
    }
  }

  // =========================================================================
  // AR MOBILE CONFIG MODAL METHODS
  // =========================================================================
  async openConfigModal() {
    if (!this.modalBackdrop) return;
    this.modalBackdrop.style.display = "flex";
    if (this.feedbackMsg) this.feedbackMsg.textContent = "";
    if (this.testResult) this.testResult.style.display = "none";

    try {
      const res = await fetch("/api/config");
      if (res.ok) {
        const data = await res.json();
        this.populateConfigForm(data.config, data.mqttStatus);
      }
    } catch (_) {}
  }

  closeConfigModal() {
    if (this.modalBackdrop) {
      this.modalBackdrop.style.display = "none";
    }
  }

  populateConfigForm(config, mqttStatus) {
    if (!config) return;
    if (this.inputMqttUrl && config.mqtt?.brokerUrl) {
      this.inputMqttUrl.value = config.mqtt.brokerUrl;
    }
    if (this.activeUrl && config.mqtt?.brokerUrl) {
      this.activeUrl.textContent = config.mqtt.brokerUrl;
    }
    if (this.statusVal && mqttStatus) {
      this.statusVal.textContent = mqttStatus.connected
        ? "Verbunden"
        : (mqttStatus.simulated ? "SPS-Simulator aktiv" : "Getrennt");
      this.statusVal.style.color = mqttStatus.connected ? "#34d399" : "#f87171";
    }
    if (this.historyTtl && config.api?.historyTtlMs) {
      this.historyTtl.value = Math.round(config.api.historyTtlMs / 1000);
    }
    if (this.pollInterval && config.api?.pollIntervalMs) {
      this.pollInterval.value = config.api.pollIntervalMs;
    }

    if (this.stationsList && Array.isArray(config.stations)) {
      this.stationsList.innerHTML = "";
      config.stations.forEach(st => {
        const item = document.createElement("div");
        item.className = "station-cfg-card";
        item.dataset.stationId = st.id;
        item.innerHTML = `
          <div class="station-cfg-header">
            <span class="station-cfg-title">${st.id}: ${st.name}</span>
            <input type="text" class="heroui-input font-mono" data-field="plcIp" value="${st.plcIp || ''}" style="max-width:120px; font-size:0.75rem;">
          </div>
          <div class="sensors-cfg-grid">
            <div class="sensor-cfg-box">
              <span class="sensor-cfg-lbl">${st.v1.label} (${st.v1.unit})</span>
              <div class="tolerance-inputs-row">
                <div class="tolerance-field"><label>Min</label><input type="number" step="0.1" class="heroui-input font-mono" data-field="v1.min" value="${st.v1.min ?? ''}"></div>
                <div class="tolerance-field"><label>Max</label><input type="number" step="0.1" class="heroui-input font-mono" data-field="v1.max" value="${st.v1.max ?? ''}"></div>
              </div>
            </div>
            <div class="sensor-cfg-box">
              <span class="sensor-cfg-lbl">${st.v2.label} (${st.v2.unit})</span>
              <div class="tolerance-inputs-row">
                <div class="tolerance-field"><label>Min</label><input type="number" step="0.1" class="heroui-input font-mono" data-field="v2.min" value="${st.v2.min ?? ''}"></div>
                <div class="tolerance-field"><label>Max</label><input type="number" step="0.1" class="heroui-input font-mono" data-field="v2.max" value="${st.v2.max ?? ''}"></div>
              </div>
            </div>
          </div>
        `;
        this.stationsList.appendChild(item);
      });
    }
  }

  async testMqtt() {
    const url = this.inputMqttUrl?.value?.trim();
    if (!url) return;
    if (this.btnTestMqtt) this.btnTestMqtt.textContent = "Prüfe...";

    try {
      const res = await fetch("/api/config/test-mqtt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brokerUrl: url, timeoutMs: 3500 })
      });
      const data = await res.json();
      if (this.testResult) {
        this.testResult.style.display = "block";
        this.testResult.className = `test-feedback-badge ${data.success ? "success" : "error"}`;
        this.testResult.textContent = `${data.success ? "✓" : "✕"} ${data.message}`;
      }
    } catch (err) {
      if (this.testResult) {
        this.testResult.style.display = "block";
        this.testResult.className = "test-feedback-badge error";
        this.testResult.textContent = `✕ Fehler: ${err.message}`;
      }
    } finally {
      if (this.btnTestMqtt) this.btnTestMqtt.textContent = "Testen";
    }
  }

  async saveConfig() {
    const brokerUrl = this.inputMqttUrl?.value?.trim();
    const historyTtlSec = parseInt(this.historyTtl?.value, 10) || 300;
    const pollIntervalMs = parseInt(this.pollInterval?.value, 10) || 1500;

    const cards = this.stationsList?.querySelectorAll(".station-cfg-card") || [];
    const updatedStations = [];
    cards.forEach(card => {
      const sId = card.dataset.stationId;
      const plcIp = card.querySelector('[data-field="plcIp"]')?.value?.trim();
      const v1Min = parseFloat(card.querySelector('[data-field="v1.min"]')?.value);
      const v1Max = parseFloat(card.querySelector('[data-field="v1.max"]')?.value);
      const v2Min = parseFloat(card.querySelector('[data-field="v2.min"]')?.value);
      const v2Max = parseFloat(card.querySelector('[data-field="v2.max"]')?.value);

      updatedStations.push({
        id: sId,
        plcIp,
        v1: { min: isNaN(v1Min) ? undefined : v1Min, max: isNaN(v1Max) ? undefined : v1Max },
        v2: { min: isNaN(v2Min) ? undefined : v2Min, max: isNaN(v2Max) ? undefined : v2Max }
      });
    });

    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mqtt: { brokerUrl },
          api: { historyTtlMs: historyTtlSec * 1000, pollIntervalMs },
          stations: updatedStations
        })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        if (this.feedbackMsg) {
          this.feedbackMsg.textContent = "✓ Gespeichert!";
          this.feedbackMsg.className = "modal-feedback-msg success";
        }
        setTimeout(() => this.closeConfigModal(), 1000);
      } else {
        if (this.feedbackMsg) {
          this.feedbackMsg.textContent = `✕ ${data.error || "Fehler"}`;
          this.feedbackMsg.className = "modal-feedback-msg error";
        }
      }
    } catch (err) {
      if (this.feedbackMsg) {
        this.feedbackMsg.textContent = `✕ ${err.message}`;
        this.feedbackMsg.className = "modal-feedback-msg error";
      }
    }
  }

  async resetDefaults() {
    if (!confirm("Auf Standardwerte zurücksetzen?")) return;
    try {
      const res = await fetch("/api/config/reset", { method: "POST" });
      const data = await res.json();
      if (res.ok && data.success) {
        this.populateConfigForm(data.config, { connected: false, simulated: true });
        if (this.feedbackMsg) {
          this.feedbackMsg.textContent = "✓ Zurückgesetzt!";
          this.feedbackMsg.className = "modal-feedback-msg success";
        }
      }
    } catch (_) {}
  }
}
