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

    // Multi-Kamera Hardware (iOS Safari Linsen: Weitwinkel vs. Telephoto)
    this.nativeCameras = {
      wide: null,
      telephoto: null,
      ultraWide: null,
      allBack: []
    };
    this.currentDeviceId = null;

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
          this.discoverNativeCameras();
          this.setZoom(this.currentZoom);
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

    window.addEventListener("resize", () => {
      this.setZoom(this.currentZoom);
    });
  }

  /**
   * Erkennt physische Kameralinsen (iOS Safari 16.3+ Multi-Kamera Unterstützung)
   */
  async discoverNativeCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      return;
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter(d => d.kind === "videoinput");
      console.info("[ARController] Erkannte Videogeräte:", videoDevices.map(d => ({ label: d.label, id: d.deviceId })));

      // Filtern nach Rückkameras
      const backCameras = videoDevices.filter(d => {
        const label = (d.label || "").toLowerCase();
        return label.includes("back") || label.includes("hinten") || label.includes("rück") || label.includes("environment");
      });

      this.nativeCameras = {
        wide: null,
        telephoto: null,
        ultraWide: null,
        allBack: backCameras
      };

      // Heuristische Zuordnung nach Label
      backCameras.forEach(cam => {
        const lbl = (cam.label || "").toLowerCase();
        if (lbl.includes("tele") || lbl.includes("zoom")) {
          this.nativeCameras.telephoto = cam;
        } else if (lbl.includes("ultra") || lbl.includes("weit")) {
          this.nativeCameras.ultraWide = cam;
        } else if (!this.nativeCameras.wide) {
          this.nativeCameras.wide = cam;
        }
      });

      // Fallback: Wenn mehrere Rückkameras existieren, aber generisch benannt sind (z.B. "Camera 1", "Camera 2")
      if (!this.nativeCameras.telephoto && backCameras.length >= 2) {
        this.nativeCameras.wide = backCameras[0];
        this.nativeCameras.telephoto = backCameras[backCameras.length - 1];
      }

      console.info("[ARController] Multi-Kamera Profil aktiv:", {
        wide: this.nativeCameras.wide?.label || "Standard",
        telephoto: this.nativeCameras.telephoto?.label || "Keine Tele-Linse gefunden"
      });
    } catch (err) {
      console.debug("[ARController] enumerateDevices Fehler:", err);
    }
  }

  /**
   * Schaltet auf eine physische Kameralinse um (z.B. iPhone Telephoto-Linse)
   */
  async switchCameraLens(targetDeviceId) {
    if (!targetDeviceId || targetDeviceId === this.currentDeviceId) return;

    try {
      const constraints = {
        video: {
          deviceId: { exact: targetDeviceId }
        }
      };

      const newStream = await navigator.mediaDevices.getUserMedia(constraints);
      const video = document.querySelector("video") || document.getElementById("arjs-video");

      if (video) {
        if (video.srcObject && video.srcObject.getVideoTracks) {
          video.srcObject.getVideoTracks().forEach(t => t.stop());
        }

        video.srcObject = newStream;
        await video.play().catch(e => console.debug("[ARController] Play nach Linsenwechsel:", e));

        const newTracks = newStream.getVideoTracks();
        if (newTracks.length > 0) {
          this.activeVideoTrack = newTracks[0];
          this.currentDeviceId = targetDeviceId;
          this.detectZoomCapabilities(this.activeVideoTrack);
          console.info(`[ARController] Nativ auf optische Linse gewechselt: ${targetDeviceId}`);
        }
      }
    } catch (err) {
      console.warn("[ARController] Linsen-Umschaltung fehlgeschlagen:", err);
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

    const zoom = this.currentZoom;
    const w = Math.round(window.innerWidth * zoom);
    const h = Math.round(window.innerHeight * zoom);

    // 1. CSS Custom Property global setzen
    document.documentElement.style.setProperty("--camera-zoom", zoom);

    // 2. Direkte Skalierung auf Video-Elementen (Funktioniert zu 100% in iOS Safari & WebKit)
    const videos = document.querySelectorAll("video");
    videos.forEach((video) => {
      video.style.setProperty("--camera-zoom", zoom);
      video.style.setProperty("width", `${w}px`, "important");
      video.style.setProperty("height", `${h}px`, "important");
      video.style.setProperty("min-width", `${w}px`, "important");
      video.style.setProperty("min-height", `${h}px`, "important");
      video.style.setProperty("max-width", "none", "important");
      video.style.setProperty("max-height", "none", "important");
      video.style.setProperty("top", "50%", "important");
      video.style.setProperty("left", "50%", "important");
      video.style.setProperty("transform", "translate(-50%, -50%)", "important");
      video.style.setProperty("-webkit-transform", "translate(-50%, -50%)", "important");
    });

    // 3. Nativer WebRTC Hardware-Zoom (falls vom Gerät & Browser unterstützt)
    if (this.activeVideoTrack) {
      try {
        await this.activeVideoTrack.applyConstraints({
          advanced: [{ zoom: zoom }]
        });
      } catch (err) {
        // Fallback greift transparent über die CSS-Skalierung
      }
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

    // Physische Kameralinse auf iOS/Safari umschalten, falls Telephoto-Linse existiert
    if (nextZoom >= 2.5 && this.nativeCameras?.telephoto) {
      this.switchCameraLens(this.nativeCameras.telephoto.deviceId);
    } else if (nextZoom < 2.0 && this.nativeCameras?.wide && this.currentDeviceId === this.nativeCameras.telephoto?.deviceId) {
      this.switchCameraLens(this.nativeCameras.wide.deviceId);
    }

    return this.setZoom(nextZoom);
  }

  /**
   * Natürliche Zwei-Finger-Geste (Pinch-to-Zoom)
   * Verhindert das Skalieren der Webseite (bleibt fix auf 100%)
   * und leitet die Geste exklusiv an den Hardware-Kamerazoom weiter.
   */
  initPinchToZoom() {
    const checkPinchLensSwitch = () => {
      if (this.currentZoom >= 2.5 && this.nativeCameras?.telephoto) {
        this.switchCameraLens(this.nativeCameras.telephoto.deviceId);
      } else if (this.currentZoom < 2.0 && this.nativeCameras?.wide && this.currentDeviceId === this.nativeCameras.telephoto?.deviceId) {
        this.switchCameraLens(this.nativeCameras.wide.deviceId);
      }
    };

    // 1. Nativer iOS Safari Gesten-Handler (WebKit gesturestart / gesturechange / gestureend)
    let gestureBaseZoom = 1.0;

    document.addEventListener("gesturestart", (e) => {
      e.preventDefault();
      gestureBaseZoom = this.currentZoom;
    }, { passive: false });

    document.addEventListener("gesturechange", (e) => {
      e.preventDefault();
      if (typeof e.scale === "number" && !isNaN(e.scale)) {
        const target = gestureBaseZoom * e.scale;
        this.setZoom(target);
      }
    }, { passive: false });

    document.addEventListener("gestureend", (e) => {
      e.preventDefault();
      checkPinchLensSwitch();
    }, { passive: false });

    // 2. Touch-Berechnung für Android & Standard Touch-Browser
    const getTouchDist = (e) => {
      if (!e.touches || e.touches.length < 2) return null;
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      return Math.hypot(dx, dy);
    };

    let isPinching = false;
    let lastZoomTime = 0;

    document.addEventListener("touchstart", (e) => {
      if (e.touches && e.touches.length === 2) {
        e.preventDefault();
        isPinching = true;
        this.initialPinchDistance = getTouchDist(e);
        this.initialPinchZoom = this.currentZoom;
      }
    }, { passive: false });

    document.addEventListener("touchmove", (e) => {
      if (e.touches && e.touches.length === 2) {
        e.preventDefault();

        if (isPinching && this.initialPinchDistance) {
          const currentDist = getTouchDist(e);
          if (currentDist && this.initialPinchDistance > 0) {
            const factor = currentDist / this.initialPinchDistance;
            const target = this.initialPinchZoom * factor;

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
      if (!e.touches || e.touches.length < 2) {
        if (isPinching) {
          checkPinchLensSwitch();
        }
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
