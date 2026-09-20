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

    // Buttons
    this.btnNext = document.getElementById("btn-next");
    this.btnFault = document.getElementById("btn-fault");
    this.btnSim = document.getElementById("btn-sim");
    this.btnZoom = document.getElementById("btn-zoom");

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
  }

  /**
   * Rendert den aktuellen Datensatz in das HUD
   * @param {Object} station - Stationsdaten
   * @param {boolean} isFault - Störungszustand
   */
  render(station, isFault) {
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
}
