/**
 * ARController - Verwaltet die A-Frame AR-Szene, Marker-Ereignisse
 * und die Kamera-Stabilität auf Mobilgeräten (insb. iPhone / iOS WebKit).
 */

export class ARController {
  constructor({ onMarkerFound, onMarkerLost }) {
    this.onMarkerFound = onMarkerFound;
    this.onMarkerLost = onMarkerLost;
    this.isMarkerVisible = false;
    this.isSimulationActive = false;

    // DOM-Referenzen
    this.hiroMarker = document.getElementById("hiro-marker");
    this.tinBody = document.getElementById("tin-body");
    this.arTextTitle = document.getElementById("ar-text-title");
    this.arTextData = document.getElementById("ar-text-data");

    this.initEventListeners();
    this.applyIosCameraStreamFix();
  }

  initEventListeners() {
    if (!this.hiroMarker) {
      console.warn("[ARController] #hiro-marker Element nicht gefunden.");
      return;
    }

    this.hiroMarker.addEventListener("markerFound", () => {
      console.debug("[ARController] Hiro-Marker im Sichtfeld erkannt.");
      this.isMarkerVisible = true;
      if (this.onMarkerFound) this.onMarkerFound();
    });

    this.hiroMarker.addEventListener("markerLost", () => {
      console.debug("[ARController] Hiro-Marker verloren.");
      this.isMarkerVisible = false;
      if (this.onMarkerLost && !this.isSimulationActive) {
        this.onMarkerLost();
      }
    });

    // Globale Debug-Trigger im Browser-Window
    window.fireEventMarkerFound = () => {
      this.hiroMarker.dispatchEvent(new CustomEvent("markerFound"));
    };
    window.fireEventMarkerLost = () => {
      this.hiroMarker.dispatchEvent(new CustomEvent("markerLost"));
    };
  }

  /**
   * iPhone 17 Pro / iOS Safari Autoplay & Inline-Video Fix
   * Verhindert das Einfrieren des Videostreams auf iOS Geräten.
   */
  applyIosCameraStreamFix() {
    const ensurePlaysinline = () => {
      const video = document.querySelector("video") || document.getElementById("arjs-video");
      if (video) {
        video.setAttribute("playsinline", "true");
        video.setAttribute("webkit-playsinline", "true");
        video.setAttribute("muted", "true");
        video.muted = true;
        if (video.paused) {
          video.play().catch(err => {
            console.debug("[ARController] Video wartet auf Touch-Interaktion:", err);
          });
        }
      }
    };

    // Mehrstufige Prüfung bei Seitenstart
    const checkInterval = setInterval(() => {
      const v = document.querySelector("video");
      if (v) {
        ensurePlaysinline();
        clearInterval(checkInterval);
      }
    }, 200);

    window.addEventListener("load", ensurePlaysinline);
    document.body.addEventListener("touchstart", () => {
      const video = document.querySelector("video");
      if (video && video.paused) video.play();
    }, { once: true });
  }

  /**
   * Aktualisiert die 3D-Beschriftung und das Modell über dem Marker
   * @param {Object} station - Aktuelle Stationsdaten
   * @param {boolean} isFault - Störungszustand
   */
  update3DOverlay(station, isFault) {
    if (!station) return;

    if (isFault) {
      if (this.tinBody) this.tinBody.setAttribute("color", "#ef4444");
      if (this.arTextTitle) this.arTextTitle.setAttribute("value", "STÖRUNG: DRUCKABFALL");
      if (this.arTextData) {
        this.arTextData.setAttribute("value", "2.8 bar [HALT]");
        this.arTextData.setAttribute("color", "#fca5a5");
      }
    } else {
      if (this.tinBody) this.tinBody.setAttribute("color", "#a1a1aa");
      if (this.arTextTitle) this.arTextTitle.setAttribute("value", station.name.toUpperCase());
      if (this.arTextData) {
        this.arTextData.setAttribute(
          "value",
          `${station.v1.val} ${station.v1.unit}  |  ${station.v2.val} ${station.v2.unit}`
        );
        this.arTextData.setAttribute("color", "#86efac");
      }
    }
  }

  setSimulationMode(active) {
    this.isSimulationActive = active;
  }
}
