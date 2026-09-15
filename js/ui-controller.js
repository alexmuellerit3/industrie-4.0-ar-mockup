/**
 * UIController - Steuert die schlanke, funktionale HMI-Benutzeroberfläche.
 * Aktualisiert Messwert-Zellen, Status-Tags, Störungsanzeigen und Zoom-Button.
 */

export class UIController {
  constructor({ onNextStation, onToggleFault, onToggleSim, onZoomCycle }) {
    // Callbacks
    this.onNextStation = onNextStation;
    this.onToggleFault = onToggleFault;
    this.onToggleSim = onToggleSim;
    this.onZoomCycle = onZoomCycle;

    // DOM-Elemente
    this.viewfinder = document.getElementById("viewfinder");
    this.stationCard = document.getElementById("station-card");
    this.statusDot = document.getElementById("status-dot");
    this.stName = document.getElementById("st-name");
    this.stTag = document.getElementById("st-tag");
    this.alertStrip = document.getElementById("alert-strip");

    // Werte-Spalten
    this.v1Lbl = document.getElementById("v1-lbl");
    this.v1Val = document.getElementById("v1-val");
    this.v1Unit = document.getElementById("v1-unit");

    this.v2Lbl = document.getElementById("v2-lbl");
    this.v2Val = document.getElementById("v2-val");
    this.v2Unit = document.getElementById("v2-unit");
    this.cellV2 = document.getElementById("cell-v2");

    this.v3Lbl = document.getElementById("v3-lbl");
    this.v3Val = document.getElementById("v3-val");
    this.v3Unit = document.getElementById("v3-unit");

    // Buttons
    this.btnNext = document.getElementById("btn-next");
    this.btnFault = document.getElementById("btn-fault");
    this.btnSim = document.getElementById("btn-sim");
    this.btnZoom = document.getElementById("btn-zoom");

    this.bindEvents();
  }

  bindEvents() {
    if (this.btnNext) {
      this.btnNext.addEventListener("click", () => {
        if (this.onNextStation) this.onNextStation();
      });
    }

    if (this.btnFault) {
      this.btnFault.addEventListener("click", () => {
        if (this.onToggleFault) this.onToggleFault();
      });
    }

    if (this.btnSim) {
      this.btnSim.addEventListener("click", () => {
        if (this.onToggleSim) this.onToggleSim();
      });
    }

    if (this.btnZoom) {
      this.btnZoom.addEventListener("click", () => {
        if (this.onZoomCycle) this.onZoomCycle();
      });
    }
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

    // Spalte 2
    this.v2Lbl.textContent = station.v2.label;
    this.v2Unit.textContent = station.v2.unit;

    // Spalte 3
    this.v3Lbl.textContent = station.v3.label;
    this.v3Val.textContent = station.v3.val;
    this.v3Unit.textContent = station.v3.unit;
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
