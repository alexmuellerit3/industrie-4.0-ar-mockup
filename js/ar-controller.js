/**
 * ARController - Verwaltet die A-Frame AR-Szene, Marker-Ereignisse,
 * die Kamera-Stabilität auf Mobilgeräten (insb. iPhone / iOS WebKit)
 * sowie die native Hardware-Kamerazoom-Funktionalität.
 */

export class ARController {
  constructor({ onMarkerFound, onMarkerLost, onZoomChange }) {
    this.onMarkerFound = onMarkerFound;
    this.onMarkerLost = onMarkerLost;
    this.onZoomChange = onZoomChange;

    this.isMarkerVisible = false;
    this.isSimulationActive = false;

    // Zoom-Zustand
    this.currentZoom = 1.0;
    this.minZoom = 1.0;
    this.maxZoom = 4.0;
    this.zoomStep = 0.1;
    this.hasNativeZoom = false;
    this.activeVideoTrack = null;
    this.initialPinchDistance = null;
    this.initialPinchZoom = 1.0;

    // DOM-Referenzen
    this.hiroMarker = document.getElementById("hiro-marker");

    this.initEventListeners();
    this.applyIosCameraStreamFix();
    this.initCameraStreamWatcher();
    this.initPinchToZoom();
  }

  initEventListeners() {
    if (!this.hiroMarker) {
      console.warn("[ARController] #hiro-marker Element nicht gefunden.");
      return;
    }

    this.hiroMarker.addEventListener("markerFound", () => {
      this.isMarkerVisible = true;
      if (this.onMarkerFound) this.onMarkerFound();
    });

    this.hiroMarker.addEventListener("markerLost", () => {
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
   * Überwacht die Initialisierung des WebRTC-Kamerastreams
   * und bindet die native Hardware-Zoomsteuerung an.
   */
  initCameraStreamWatcher() {
    const bindTrack = () => {
      const video = document.querySelector("video") || document.getElementById("arjs-video");
      if (video && video.srcObject && video.srcObject.getVideoTracks) {
        const tracks = video.srcObject.getVideoTracks();
        if (tracks && tracks.length > 0) {
          this.activeVideoTrack = tracks[0];
          this.detectZoomCapabilities(this.activeVideoTrack);
          return true;
        }
      }
      return false;
    };

    if (!bindTrack()) {
      const pollTimer = setInterval(() => {
        if (bindTrack()) clearInterval(pollTimer);
      }, 300);
      window.addEventListener("load", bindTrack);
    }
  }

  /**
   * Prüft native Zoom-Fähigkeiten des Kamerasensors (z.B. iPhone 17 Pro, Android)
   */
  detectZoomCapabilities(track) {
    if (!track) return;

    try {
      const capabilities = track.getCapabilities ? track.getCapabilities() : {};
      if ("zoom" in capabilities) {
        this.hasNativeZoom = true;
        this.minZoom = capabilities.zoom.min || 1.0;
        this.maxZoom = Math.min(capabilities.zoom.max || 5.0, 5.0);
        this.zoomStep = capabilities.zoom.step || 0.1;
        console.info(`[ARController] Nativer Hardware-Zoom aktiv (Min: ${this.minZoom}x, Max: ${this.maxZoom}x)`);
      } else {
        console.info("[ARController] Nativer Zoom nicht direkt im Treiber, nutze nahtlosen Zoom-Fallback.");
      }
    } catch (e) {
      console.debug("[ARController] Fehler beim Lesen der Zoom-Capabilities:", e);
    }
  }

  /**
   * Setzt den Kamerazoom (bevorzugt hardware-nativ via WebRTC MediaStreamTrack,
   * mit optischem Fallback falls vom Browser limitiert).
   * @param {number} targetLevel - z. B. 1.0, 2.0, 3.0
   */
  async setZoom(targetLevel) {
    const clamped = Math.max(this.minZoom, Math.min(this.maxZoom, +targetLevel.toFixed(1)));
    this.currentZoom = clamped;

    // 1. Nativer WebRTC Hardware-Zoom
    if (this.hasNativeZoom && this.activeVideoTrack) {
      try {
        await this.activeVideoTrack.applyConstraints({
          advanced: [{ zoom: this.currentZoom }]
        });
      } catch (err) {
        console.debug("[ARController] Hardware-Zoom applyConstraints fehlgeschlagen:", err);
      }
    }

    // 2. Optischer Viewport-Fallback (skaliert zusätzlich das Video-Element geschmeidig)
    const video = document.querySelector("video") || document.getElementById("arjs-video");
    if (video && (!this.hasNativeZoom || this.currentZoom > 1.0)) {
      const scaleVal = this.hasNativeZoom ? 1 : this.currentZoom;
      video.style.transform = `translate(-50%, -50%) scale(${scaleVal})`;
      video.style.webkitTransform = `translate(-50%, -50%) scale(${scaleVal})`;
    }

    if (this.onZoomChange) {
      this.onZoomChange(this.currentZoom);
    }

    return this.currentZoom;
  }

  /**
   * Schaltet zyklisch durch Standard-Zoomstufen: 1.0x -> 2.0x -> 3.0x -> 1.0x
   */
  cycleZoom() {
    let nextZoom = 1.0;
    if (this.currentZoom < 1.8) {
      nextZoom = 2.0;
    } else if (this.currentZoom < 2.8) {
      nextZoom = 3.0;
    } else {
      nextZoom = 1.0;
    }
    return this.setZoom(nextZoom);
  }

  /**
   * Natürliche Zwei-Finger-Geste (Pinch-to-Zoom)
   * Verhindert das Skalieren der Webseite (bleibt fix auf 100%)
   * und leitet die Geste exklusiv an den Hardware-Kamerazoom weiter.
   */
  initPinchToZoom() {
    // 1. Safari WebKit Gesten-Zoom auf der Seite blockieren
    const blockGesture = (e) => {
      e.preventDefault();
    };
    document.addEventListener("gesturestart", blockGesture, { passive: false });
    document.addEventListener("gesturechange", blockGesture, { passive: false });
    document.addEventListener("gestureend", blockGesture, { passive: false });

    // 2. Touch-Berechnung für Kamerazoom
    const getTouchDist = (e) => {
      if (e.touches.length < 2) return null;
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      return Math.hypot(dx, dy);
    };

    let isPinching = false;
    let lastZoomTime = 0;

    document.addEventListener("touchstart", (e) => {
      if (e.touches.length === 2) {
        isPinching = true;
        this.initialPinchDistance = getTouchDist(e);
        this.initialPinchZoom = this.currentZoom;
      }
    }, { passive: false });

    document.addEventListener("touchmove", (e) => {
      if (e.touches.length === 2) {
        // WICHTIG: Verhindert, dass der Browser die Seite zoomt/verzerrt!
        e.preventDefault();

        if (isPinching && this.initialPinchDistance) {
          const currentDist = getTouchDist(e);
          if (currentDist && this.initialPinchDistance > 0) {
            const factor = currentDist / this.initialPinchDistance;
            const target = this.initialPinchZoom * factor;

            // Throttling für flüssige Hardware-Kamera-Ansteuerung
            const now = performance.now();
            if (now - lastZoomTime > 30) {
              lastZoomTime = now;
              this.setZoom(target);
            }
          }
        }
      }
    }, { passive: false });

    const resetPinch = (e) => {
      if (e.touches.length < 2) {
        isPinching = false;
        this.initialPinchDistance = null;
      }
    };

    document.addEventListener("touchend", resetPinch, { passive: true });
    document.addEventListener("touchcancel", resetPinch, { passive: true });
  }

  /**
   * iPhone 17 Pro / iOS Safari Autoplay & Inline-Video Fix
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

  setSimulationMode(active) {
    this.isSimulationActive = active;
  }
}
