# 03. AR-WebApp & Computer Vision

> **Kerntechnologien:** A-Frame 1.4.0, AR.js 3.4.5 (Marker-based Tracking), WebXR / HTML5 Canvas  
> **Zielgeräte:** Smartphones (iOS Safari, Android Chrome) und Industrie-Tablets.

---

## 📷 Optisches Tracking mit Hiro-Marker

Die AR-Komponente ermöglicht das präzise Einblenden virtueller Maschinendaten im Raum ohne teure Spezialbrillen (wie HoloLens). Stattdessen wird die Standard-Kamera von Handheld-Geräten genutzt.

```
       ┌────────────────────────┐
       │   Kamera-Videostream   │  (WebRTC getUserMedia)
       └───────────┬────────────┘
                   ▼
       ┌────────────────────────┐
       │ AR.js Computer Vision  │  (60 Hz Matrix-Erkennung)
       └───────────┬────────────┘
                   ▼
     ┌─────────────┴─────────────┐
     │                           │
[Marker erkannt]          [Marker verloren]
     │                           │
     ▼                           ▼
Station Card einblenden     Popup bleibt persistent
(Messwerte & Trends)        (schließt erst bei ✕)
```

### Der Hiro-Marker:
* **Muster:** Standard-Hiro-Pattern (hoher Kontrast, asymmetrischer Kern, fehlertolerante Eckenerkennung).
* **Konfiguration in `index.html`:**
  ```html
  <a-scene
    vr-mode-ui="enabled: false"
    renderer="logarithmicDepthBuffer: true; alpha: true"
    embedded
    arjs="sourceType: webcam; facingMode: environment; maxDetectionRate: 60; debugUIEnabled: false;">
    
    <a-marker
      preset="hiro"
      id="hiro-marker"
      smooth="true"
      smoothCount="2"
      smoothTolerance="0.05"
      smoothThreshold="3">
    </a-marker>

    <a-entity camera></a-entity>
  </a-scene>
  ```

---

## 🖥️ Schichten- & Stacking-Architektur (CSS Z-Index)

Ein kritischer Aspekt bei markerbasiertem WebAR ist das Stacking von Kamera-Videostream, 3D-Canvas und 2D-Overlay:

1. **Ebene 0 (Hintergrund):** Der `body` muss transparent sein (`background: transparent !important`). AR.js injiziert das `<video>`-Element der Webcam mit `z-index: -2`.
2. **Ebene 1 (3D WebGL Canvas):** A-Frame rendert die `<canvas class="a-canvas">` mit `z-index: -1`, sodass 3D-Anker exakt über dem Live-Video liegen.
3. **Ebene 2 (HMI HUD Overlay):** Das 2D-Interfacedesign (`.ar-frame`, `.top-bar`, `.viewfinder`, `.station-card`) liegt bei `z-index: 10 bis 100`, um Touch-Events abzufangen.

---

## 📱 Mobile HMI HUD & Tablet Cockpit

### 1. Viewfinder (Zielsucher)
* Zentrale Anvisier-Hilfe mit Eckenmarkierungen (`c-tl`, `c-tr`, `c-bl`, `c-br`).
* Gibt dem Werker sofort optisches Feedback, in welchem Bereich der Marker gehalten werden muss.

### 2. Persistente Stations-Karte (`.station-card`)
* Sobald der Marker einmal erfasst wurde, gleitet die Stationskarte im HeroUI-Glasmorphismus von unten ins Bild.
* **Persistenz-Logik:** Um Frust durch kurzes Verwackeln der Kamera zu vermeiden, schließt sich die Karte **nicht**, wenn der Marker kurz aus dem Blickfeld gerät. Sie bleibt stabil geöffnet, bis der Werker auf **✕** tippt oder ein neuer Marker gescannt wird.

### 3. Tablet Cockpit (ab 768px Viewport)
* Auf Tablets schaltet die UI automatisch auf ein erweitertes Cockpit um:
  * Zwei-Spalten-Raster für Haupt- und Nebenmetriken.
  * Inline-Sparklines mit historischen Trend-Pfeilen (`↗`, `↘`, `→`).
  * Erweiterte Diagnoseangaben (SPS-IP, Toleranzgrenzen, OPC UA Node-IDs).

---

## 🔍 Native Kamera-Zoom-Steuerung

In industriellen Umgebungen kann der Marker an einer Maschine angebracht sein, die aus Sicherheitsgründen (z. B. Schutzzäune) nicht unmittelbar betreten werden darf.

* **3-Stufiger Zoom-Zyklus:** `1.0×` $\rightarrow$ `1.5×` $\rightarrow$ `2.0×` $\rightarrow$ `1.0×`.
* **Hardware-Zoom:** Wenn der Browser `MediaStreamTrack.applyConstraints({ advanced: [{ zoom }] })` unterstützt, wird die physische Tele-Linse des Smartphones angesteuert.
* **CSS-Canvas-Fallback:** Sollte das Betriebssystem keinen direkten Hardware-Zugriff erlauben, zoomt ein hardwarebeschleunigter CSS-Matrix-Transform (`transform: scale(...)`) verlustarm in den Videostream.

---

## 💻 Integrierter Desktop-Simulationsmodus

Für Schulungen, Vorführungen oder Entwicklungsumgebungen ohne Webcam:
* Über den Schalter `Desktop-Sim` wird ein synthetischer Hiro-Marker im Sichtfeld simuliert.
* Das System reagiert identisch wie bei einer echten Kameraerkennung und blendet alle Werte und Störmeldungen ein.
* Auf echten Touchscreens blendet ein CSS-Media-Query (`@media (hover: none) and (pointer: coarse)`) den Schalter automatisch aus, um das mobile Interface clean zu halten.
