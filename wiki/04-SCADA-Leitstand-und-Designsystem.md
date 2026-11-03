# 04. SCADA-Leitstand & Designsystem

> **Design-Philosophie:** Fusion aus **HeroUI (NextUI)** Glasmorphismus und **SevDesk** KPI-Klarheit  
> **Einstiegspunkt:** [`overview.html`](file:///root/bbk_cpr/overview.html) • Steuerung via [`js/overview.js`](file:///root/bbk_cpr/js/overview.js)

---

## 🎨 HeroUI & SevDesk Designsystem

Anstelle antiquierter, grauer Industrie-Softwareoberflächen nutzt das Projekt moderne europäische SaaS-Designstandards:

```
┌────────────────────────────────────────────────────────────────────────┐
│  HEROUI TOP-BAR: Anlagenstatus • Live-Uhr • Modale Konfiguration ⚙️   │
├────────────────────────────────────────────────────────────────────────┤
│  SEVDESK KPI-ROW:  [ OEE: 93% ]  [ Takt: 32 D/m ]  [ Alarme: 0 ]       │
├──────────────────┬──────────────────┬──────────────────┬───────────────┤
│ MODUL 1:         │ MODUL 2:         │ MODUL 3:         │ MODUL 4:      │
│ Dosen-Zuführung  │ Dosierung/Füll   │ Deckel-Verschluss│ Endprüfung    │
│ [Normal]         │ [Normal]         │ [Normal]         │ [Normal]      │
│                  │                  │                  │               │
│ 84 %  Magazin    │ 250.3 g Gewicht  │ 5.2 bar Druck    │ 250.1 g Gew.  │
│ -0.8 bar Vakuum  │ 5.2 bar Druck    │ 3.9 Nm Moment    │ 0.4 % Aussch. │
│                  │                  │                  │               │
│ [SVG Glow Chart] │ [SVG Glow Chart] │ [SVG Glow Chart] │ [SVG Chart]   │
│ Min: 249.7 g     │ Min: 249.8 g     │ Min: 5.1 bar     │ Min: 249.6 g  │
│ Max: 250.6 g     │ Max: 250.6 g     │ Max: 5.3 bar     │ Max: 250.4 g  │
│ Ø:   250.3 g     │ Ø:   250.2 g     │ Ø:   5.2 bar     │ Ø:   250.1 g  │
│ [Störung simul.] │ [Störung simul.] │ [Störung simul.] │ [Stör. sim.]  │
└──────────────────┴──────────────────┴──────────────────┴───────────────┘
```

### Die zwei Säulen des Designs:

1. **HeroUI Komponenten:**
   * **Glasmorphismus:** Transluzente Container mit `background: rgba(18, 20, 26, 0.75)` und `backdrop-filter: blur(24px)`.
   * **Farb-Tokens:** Titan-/Graphit-Dunkeltöne (`#12141a`), Tiefschwarz (`#0a0b0e`), Smaragdgrün (`#10b981`) für fehlerfreien Betrieb, Rubinrot (`#ef4444`) für Störungen.
   * **Status-Chips:** Abgerundete Badges mit pulsierendem Glow-Punkt für den aktuellen Verbindungsstatus (`Live (WSS)`, `SPS-Sim`, `Getrennt`).

2. **SevDesk Dashboard-Stil:**
   * **KPI-Header:** Große, aufgeräumte Zahlenkarten am oberen Bildschirmrand für OEE (Gesamtanlageneffektivität), Gesamttakt, aktive Alarme und Stichprobenzahl.
   * **Monospace-Metriken:** Typografisch sauber ausgerichtete Ziffern mit klaren Maßeinheiten (`g`, `bar`, `%`, `Nm`, `D/min`).
   * **5-Minuten Auswertungs-Footer:** Jede Karte enthält eine SevDesk-Tabelle mit statischer Auswertung: **Min**, **Max**, **Durchschnitt ($\varnothing$)** und **Störungsquote (%)**.

---

## 📈 Dynamische SVG-Glow-Area-Charts

Jedes Fertigungsmodul visualisiert seinen Hauptprozesswert über ein integriertes Vektordiagramm:

* **Auflösung & Skalierung:** Ein SVG-ViewBox (`300 × 70`), das sich verlustfrei an jede Bildschirmbreite anpasst.
* **Farbverläufe (Glow-Effekt):**
  * Normalzustand: Smaragdgrüner Vektorzug mit linearem Gradienten von `rgba(16, 185, 129, 0.28)` nach transparent.
  * Störungszustand: Schlägt sofort auf Rubinrot (`#ef4444`) und Alert-Gradient (`url(#grad-alert-ST-xxx)`) um.
* **Keine externen Chart-Bibliotheken:** Extrem hohe Performance und null Ladezeit, da direkt im nativen SVG-DOM berechnet (`polyLine.setAttribute("points", ...)`).

---

## ⚠️ Interaktive Störungssimulation & Quittierung

Für Schulungs- und Präsentationszwecke kann jede Station interaktiv in einen Störzustand versetzt werden:

1. **Simulation auslösen:**
   * Klick auf `Störung simulieren` an einer beliebigen Station.
   * Das Backend (oder der lokale Simulator) setzt den Prozesswert außerhalb der Toleranzgrenze (z. B. Füllgewicht fällt unter 240 g oder Druck steigt auf 8.5 bar).
2. **Optische Alarmierung:**
   * Die Modulkarte erhält eine pulsierende rote Umrandung (`.alert-state`).
   * Der Status-Chip wechselt von grün `NORMAL` auf rot `STÖRUNG`.
   * Die SevDesk-Zelle der betroffenen Metrik färbt sich rubinrot.
   * Der Zähler für aktive Alarme im SevDesk-KPI-Header inkrementiert sofort.
3. **Quittierung:**
   * Ein Klick auf `Störung quittieren` setzt den Störstatus zurück, normalisiert die Messwerte und aktualisiert die Störungsquote.

---

## ⚙️ 4. Individuelle Modul-Konfiguration & Umbenennung

Jedes Modul kann direkt aus der Stationskarte heraus über die Schaltfläche **`⚙️ Anpassen`** (`.btn-quick-edit`) oder über das Konfigurationsmenü editiert werden:

* **Modulname & Bezeichnung:** Freie Vergabe eines individuellen Stationsnamens (z. B. *"PowerHouse Vibration"* statt *"Modul 1: Dosen-Zuführung"*).
* **SPS IP-Adresse:** Hinterlegung der konkreten Steuerungs-IP.
* **MQTT-Topic Bindung:** Direkte Zuordnung eines MQTT-Topics (z. B. `/bbk-lf/rpi04/power-house/vibration`). Eintreffende Messwerte auf diesem Topic werden gezielt diesem Modul zugeordnet und ersetzen dessen Demo-Werte.
* **Sensor-Metriken & Grenzwerte (v1, v2, v3):** Anpassung der Bezeichnungen (z. B. "Vibration", "Druck", "Drehzahl"), Maßeinheiten (`mm/s`, `bar`, `U/min`) und Toleranz-Schwellwerte für die automatische Grenzwertüberwachung.

---

## 🗑️ 5. Striktes Datenmanagement (Live- vs. Demo-Daten)

Das Gesamtsystem trennt strikt zwischen echten Feldwerten (**LIVE**) und simulierten Demodaten (**DEMO**):

* **Live-Ersetzungslogik:** Sobald ein Modul echte Telemetriepakete über den konfigurierten WebSocket (`wss://nodered.bbk.robin-w.de/ws/opcua`) oder ein abonniertes MQTT-Topic empfängt, werden die simulierten Werte im 5-Minuten-Puffer vollständig durch die echten Live-Werte ersetzt.
* **Status-Kennzeichnung:** Jede Modulkarte zeigt mit einem dezidierten Badge an, ob aktuell Live-Daten (`LIVE`) oder synthetische Demodaten (`DEMO`) dargestellt werden.
* **Demo-Daten verwerfen:** Über die Schaltfläche **`🗑️ Demo-Daten verwerfen`** im Konfigurationsdialog (`#btn-clear-all-demo`) können sämtliche Demo- und Simulationswerte auf Knopfdruck aus dem Speicher gelöscht werden. Module ohne Live-Signal zeigen anschließend den Wartezustand `Warte auf Telemetrie...` an.
