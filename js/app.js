/**
 * App.js - Zentraler Einstiegspunkt der modularen WebApp
 * 
 * Verknüpft:
 * - TelemetryService (Schnittstellen & Sensordaten)
 * - ARController (Marker Tracking, iOS Kamera & Native Zoom)
 * - UIController (HMI HUD Darstellung)
 */

import { APP_CONFIG } from "./config.js";
import { TelemetryService } from "./services/telemetry-service.js";
import { ARController } from "./ar-controller.js";
import { UIController } from "./ui-controller.js";

class CandyArApp {
  constructor() {
    this.isDesktopSimActive = false;

    // 1. Telemetrie-Dienst initialisieren
    this.telemetryService = new TelemetryService(APP_CONFIG);

    // 2. UI-Controller initialisieren
    this.ui = new UIController({
      onNextStation: () => this.telemetryService.nextStation(),
      onToggleFault: () => this.telemetryService.toggleFaultSimulation(),
      onToggleSim: () => this.toggleDesktopSimulation(),
      onZoomCycle: () => this.ar.cycleZoom()
    });

    // 3. AR-Controller initialisieren (inkl. Kamera-Zoom)
    this.ar = new ARController({
      onMarkerFound: () => this.handleMarkerFound(),
      onMarkerLost: () => this.handleMarkerLost(),
      onZoomChange: (level) => this.ui.updateZoomDisplay(level)
    });

    // 4. Observer-Verbindung herstellen
    this.telemetryService.subscribe((stationData, isFault) => {
      this.ui.render(stationData, isFault);
    });

    // 5. Telemetrie-Stream starten
    this.telemetryService.start();

    console.info(`[CandyArApp] Erfolgreich gestartet (${APP_CONFIG.appName} v${APP_CONFIG.version})`);
  }

  handleMarkerFound() {
    this.ui.showStationCard();
  }

  handleMarkerLost() {
    if (!this.isDesktopSimActive) {
      this.ui.hideStationCard();
    }
  }

  toggleDesktopSimulation() {
    this.isDesktopSimActive = !this.isDesktopSimActive;
    this.ar.setSimulationMode(this.isDesktopSimActive);
    this.ui.updateSimButton(this.isDesktopSimActive);

    if (this.isDesktopSimActive) {
      this.ui.showStationCard();
    } else if (!this.ar.isMarkerVisible) {
      this.ui.hideStationCard();
    }
  }
}

// Start bei geladenem DOM
window.addEventListener("DOMContentLoaded", () => {
  window.__candyArApp = new CandyArApp();
});
