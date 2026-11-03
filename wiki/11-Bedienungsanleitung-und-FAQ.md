# 11. Bedienungsanleitung & FAQ

> **Zielgruppe:** Werker vor Ort, Instandhalter, Schichtleiter und Systemintegratoren.

---

## 📱 Schnellstart: Vor-Ort-Bedienung mit AR (Smartphone/Tablet)

1. **Öffnen der Anwendung:**
   * Scannen Sie den QR-Code an der Anlage oder öffnen Sie im mobilen Browser (Safari/Chrome):  
     `https://alexmuellerit3.github.io/industrie-4.0-ar-mockup/index.html?view=ar`
2. **Kamerazugriff erlauben:**
   * Bestätigen Sie die Browserabfrage *"Darf diese Webseite auf Ihre Kamera zugreifen?"* mit **Erlauben**.
3. **Marker scannen:**
   * Richten Sie die Kamera so aus, dass sich der schwarz-weiße **Hiro-Marker** der Station im Fadenkreuz (Viewfinder) befindet.
4. **Werte ablesen:**
   * Sobald der Marker erfasst wird, gleitet die Stationskarte von unten ins Bild.
   * Sie sehen sofort die aktuellen Messwerte, Toleranzbereiche und historische Trends.
5. **Kamera-Zoom nutzen:**
   * Tippen Sie oben rechts auf den Zoom-Button (`1.0×`, `1.5×`, `2.0×`), falls Sie sich nicht direkt an die Gefahrenzone der Maschine annähern können.
6. **Schließen:**
   * Die Karte bleibt persistent geöffnet, auch wenn Sie den Blick abwenden. Erst durch Antippen des **✕**-Symbols oben rechts schließt sich das Popup.

---

## 🖥️ Schnellstart: SCADA-Leitstand (Desktop-Monitor)

1. **Öffnen:**
   * Rufen Sie im Browser auf: `https://alexmuellerit3.github.io/industrie-4.0-ar-mockup/overview.html`
2. **Anlagen-Cockpit:**
   * **Obere Leiste (KPIs):** OEE-Gesamteffektivität, Gesamttakt der Linie, Alarmanzahl.
   * **Modulkarten 1–4:** Alle Stationen nebeneinander mit Messwerten und SVG-Glow-Trendkurven der letzten 5 Minuten.
3. **Störungssimulation (Demo-Modus):**
   * Klicken Sie an Modul 2 auf `Störung simulieren`.
   * Beobachten Sie, wie die Karte rot aufleuchtet, die Trendkurve auf Alert wechselt und der Alarmzähler nach oben zählt.
   * Klicken Sie auf `Störung quittieren`, um den Normalzustand wiederherzustellen.

---

## ❓ Häufige Fragen & Fehlerbehebung (FAQ)

### F1: Die Kamera öffnet sich auf dem Smartphone nicht oder bleibt schwarz.
* **Ursache:** Fehlende HTTPS-Verbindung oder verweigerte Berechtigung.
* **Lösung:** WebAR erfordert zwingend eine sichere HTTPS-Verbindung (auf GitHub Pages automatisch aktiv). Prüfen Sie in den Browser-Einstellungen unter *Website-Einstellungen $\rightarrow$ Kamera*, ob der Zugriff gestattet ist.

### F2: Warum zeigt die GitHub Pages Version Live-Daten an, obwohl kein Node.js Server dahinter läuft?
* **Erklärung:** Moderne Web-Browser können über `https://` verschlüsselte WebSocket-Verbindungen (`wss://`) direkt zu externen Hosts aufbauen. Die WebApp verbindet sich direkt von Ihrem Browser aus mit `wss://nodered.bbk.robin-w.de/ws/opcua`.

### F3: Was passiert, wenn die Internetverbindung abreißt oder die Node-RED-Adresse offline ist?
* **Erklärung:** Die WebApp schaltet nach einem Timeout von 3,5 Sekunden automatisch und ununterbrochen in die **autarke SPS-Simulation**. Weder das Dashboard noch die AR-App bleiben leer oder hängen.

### F4: Ich habe mich bei der WebSocket-Adresse vertippt (`tobin-w.de`).
* **Erklärung:** Das System verfügt über eine automatische Normalisierung und korrigiert typische Tippfehler (`tobin-w.de` $\rightarrow$ `robin-w.de`) vollautomatisch im Hintergrund.

### F5: Wie lauten die Standard-Zugangsdaten für die Benutzerverwaltung?
* **Administrator:** `admin` / `admin123`
* **Operator / Instandhalter:** `operator` / `operator123`
* **Viewer / Werker:** `viewer` / `viewer123`

### F6: Wie kann ich Module individuell umbenennen oder an ein spezifisches MQTT-Topic binden?
* **Anleitung:**
  1. Klicken Sie im Leitstand ([`overview.html`](file:///root/bbk_cpr/overview.html)) in der Kopfzeile der gewünschten Stationskarte auf **`⚙️ Anpassen`** (oder öffnen Sie den Reiter *Fertigungsmodule* in den Einstellungen).
  2. Ändern Sie den Namen (z. B. auf *"PowerHouse Vibration"*), tragen Sie die SPS-IP ein und geben Sie das gewünschte MQTT-Topic ein (z. B. `/bbk-lf/rpi04/power-house/vibration`).
  3. Bei Bedarf können Sie auch Bezeichnungen, Einheiten und Toleranzen für die 3 Messwerte konfigurieren.
  4. Klicken Sie auf **`💾 Änderungen speichern`**. Das System abonniert das Topic sofort und ordnet eintreffende Daten diesem Modul zu.

### F7: Wie kann ich neue MQTT-Topics abonnieren und Demo-Daten verwerfen?
* **Anleitung:**
  1. Öffnen Sie oben rechts **`⚙️ Konfiguration`** und wählen Sie den Reiter **MQTT & Broker**.
  2. Im Bereich **Dynamische MQTT-Topics** geben Sie das gewünschte Topic ein (z. B. `/bbk-lf/rpi04/power-house/vibration`) und klicken auf **`+ Abonnieren`**.
  3. Im Reiter **Fertigungsmodule** finden Sie die rote Schaltfläche **`🗑️ Demo-Daten verwerfen`**. Ein Klick darauf entfernt sofort alle simulierten Werte aus dem Speicher, sodass nur noch echte Felddaten sichtbar sind.
