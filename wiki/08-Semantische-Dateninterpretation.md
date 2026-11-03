# 08. Semantische Dateninterpretation

> **Kernkomponente:** [`backend/telemetry-interpreter.js`](file:///root/bbk_cpr/backend/telemetry-interpreter.js)  
> **Aufgabe:** Automatische Rekonstruktion, Toleranzprüfung und natürlichsprachliche Interpretation beliebiger JSON-Datenstrukturen.

---

## 🧠 Warum semantische Interpretation?

In realen Industrie-4.0-Umgebungen liefern unterschiedliche Hersteller und Gateways Daten in heterogenen JSON-Formaten:
* Node-RED sendet oft verschachtelte Objekte (`{ msg: { payload: { ... } } }`).
* OPC UA liefert Arrays von Nodes (`[{ id: "ns=2;s=FillWeight", value: 250.3 }]`).
* Sensoren senden flache Key-Value-Paare (`{ "temp": 24.1, "bar": 5.2 }`).

Der **TelemetryInterpreter** verarbeitet diese Pakete vollautomatisch, ohne dass für jedes neue Format Quellcode angepasst werden muss!

```
 Beliebiges JSON-Paket (Node-RED, OPC UA, IoT)
                     │
                     ▼
       ┌───────────────────────────┐
       │ 1. Rekursive Endpunkt-    │
       │    Extraktion (Key-Paths) │
       └─────────────┬─────────────┘
                     ▼
       ┌───────────────────────────┐
       │ 2. Automatische Stations- │  (Prüft stationId, plcIp,
       │    Erkennung (ST-010..040)│   Modulnamen & Tag-Muster)
       └─────────────┬─────────────┘
                     ▼
       ┌───────────────────────────┐
       │ 3. Semantisches Mapping   │  (Zuordnung zu v1, v2, v3,
       │    & Toleranzprüfung      │   Min/Max Grenzwerte)
       └─────────────┬─────────────┘
                     ▼
       ┌───────────────────────────┐
       │ 4. Natürliche deutsche    │  ("✅ Modul arbeitet optimal"
       │    Klartext-Synthese      │   oder "⚠️ Überdruckwarnung")
       └───────────────────────────┘
```

---

## 🔍 Die 4 Verarbeitungsschritte

### 1. Rekursive Endpunkt-Extraktion (`extractEndpoints`)
Durchwandert jedes ankommende Objekt bis zu den primitiven Blattknoten (`string`, `number`, `boolean`).
* Pfad-Notation: z. B. `telemetry.sensors.pressure_bar` oder `payload.nodes[0].value`.
* Globales Register: Das Backend pflegt ein internes Register aller im laufenden Betrieb jemals gesehenen Datenpfade (`knownEndpoints`).

### 2. Automatische Modul-Erkennung (`detectStationId`)
Erkennt die Zielstation über mehrstufige Heuristiken:
* Direkte Felder: `stationId`, `id`, `station`.
* IP-Adressabgleich: z. B. `192.168.10.12` $\rightarrow$ `ST-020`.
* Semantische Schlagworte: `Vakuum` oder `Magazin` $\rightarrow$ `ST-010`; `Bördel` oder `Drehmoment` $\rightarrow$ `ST-030`; `Waage` oder `OEE` $\rightarrow$ `ST-040`.

### 3. Toleranzprüfung & Statusbewertung
Vergleicht Messwerte mit den hinterlegten Grenzwerten:
* **OPTIMAL / NORMAL:** Alle Messwerte innerhalb der definierten Schranken.
* **WARNUNG:** Wert liegt in der Randtoleranz (z. B. $90\dots 95\%$ des Höchstwertes).
* **KRITISCH / STÖRUNG:** Wert überschreitet Sicherheitsgrenze (z. B. Druck $> 8.0\text{ bar}$ oder Füllgewicht $< 240\text{ g}$).

### 4. Menschlich verständliche Sprachsynthese
Generiert automatisch prägnante Statusberichte in natürlicher deutscher Sprache:
* *Beispiel Normal:* `✅ Modul 'Modul 2: Dosierung & Befüllung' arbeitet im optimalen Sollbereich. Füllgewicht liegt bei 250.3 g (Soll: 250.0 g).`
* *Beispiel Störung:* `⛔ Akute Störung an Modul 3: Pneumatikdruck (8.5 bar) überschreitet den maximal zulässigen Anpressdruck (5.3 bar) signifikant!`

---

## 🧪 Interaktiver JSON-Interpreter im SCADA-Cockpit

Im SCADA-Leitstand ([`overview.html`](file:///root/bbk_cpr/overview.html)) befindet sich der Bereich **"Intelligente Daten-Endpunkt Interpretation"**:
* Entwickler und Ingenieure können dort beliebiges JSON hineinkopieren.
* Ein Klick auf `Paket interpretieren` zeigt sofort die erkannte Station, die extrahierten Endpunkte und den generierten Klartextbericht an.
* Ein Klick auf `In Live-Store einspeisen` übernimmt die Daten direkt in die 5-Minuten-Zeitreihe der Fertigungslinie.
