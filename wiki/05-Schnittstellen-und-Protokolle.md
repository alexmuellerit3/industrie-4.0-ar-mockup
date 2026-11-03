# 05. Schnittstellen & Protokolle

> **Industrielle Kommunikationsstandards:** OPC UA, WebSocket (WS / WSS), MQTT v5, REST / JSON  
> **Referenz-Endpunkt:** `wss://nodered.bbk.robin-w.de/ws/opcua`

---

## 🏭 1. OPC UA Adressraum (Feldebene)

Alle 4 Fertigungsmodule sind im OPC UA Server unter dem Namespace **`ns=2`** strukturiert abgebildet:

| Modul | Parameter | OPC UA Node-ID | Typ | Einheit | Toleranzbereich |
| :--- | :--- | :--- | :---: | :---: | :---: |
| **ST-010** | Magazinfüllstand | `ns=2;s=Modul1.MagazineLevel` | Float | % | 82.0 – 86.0 |
| | Unterdruck / Vakuum | `ns=2;s=Modul1.VacuumPressure` | Float | bar | -0.85 – -0.78 |
| | Stückzähler | `ns=2;s=Modul1.PartCounter` | Int32 | Stk | fortlaufend |
| **ST-020** | Füllgewicht Istwert | `ns=2;s=Modul2.FillWeight_Actual` | Float | g | 249.7 – 250.6 |
| | Betriebsdruck | `ns=2;s=Modul2.OperatingPressure` | Float | bar | 5.1 – 5.3 |
| | Taktrate | `ns=2;s=Modul2.ThroughputRate` | Int32 | D/min | 31 – 33 |
| **ST-030** | Anpressdruck | `ns=2;s=Modul3.PressForce` | Float | bar | 5.1 – 5.3 |
| | Bördeldrehmoment | `ns=2;s=Modul3.TighteningTorque` | Float | Nm | 3.8 – 4.0 |
| | Dichtigkeitsprüfung | `ns=2;s=Modul3.SealInspectionOK` | Bool | % | 100 |
| **ST-040** | Kontrollgewicht | `ns=2;s=Modul4.CheckWeigherWeight` | Float | g | 249.8 – 250.4 |
| | Ausschussquote | `ns=2;s=Modul4.RejectionRate` | Float | % | 0.0 – 1.0 |
| | OEE Anlageneffektivität| `ns=2;s=Modul4.OverallEquipmentEfficiency`| Float | % | 90 – 98 |

---

## ⚡ 2. Node-RED Live-WebSocket-Kopplung

Der primäre Live-Datenstrom für die Bonbon-Fertigung wird über **Node-RED** bereitgestellt:

* **URL:** `wss://nodered.bbk.robin-w.de/ws/opcua`
* **Transparente Tippfehler-Korrektur:** Sollte in der Konfiguration oder URL versehentlich `tobin-w.de` eingegeben werden, normalisiert der Backend- und Frontend-Client diese Eingabe automatisch zu `robin-w.de`.
* **Automatische Frame-Erkennung:** Eintreffende Node-RED Pakete werden sowohl in nativen CPS-Formaten als auch als rohe OPC UA JSON-Objekte interpretiert.

---

## 📡 3. Eclipse Mosquitto MQTT Broker

Für industrielle IoT-Gateways bietet das Backend eine vollwertige MQTT-Kopplung ([`backend/mqtt-service.js`](file:///root/bbk_cpr/backend/mqtt-service.js)):

* **Broker-Ports:** Port `1883` (TCP) und Port `9001` (WebSocket)
* **Topic-Hierarchie:**
  * `cps-i40/<StationID>/telemetry`: Messwert-Publishing (z. B. `{ v1: 250.2, v2: 5.2, v3: 32 }`)
  * `cps-i40/<StationID>/status`: Lebenszeichen & Zustände (`NORMAL`, `ALERT`)
  * `cps-i40/<StationID>/fault`: Störungsmeldungen (`{ isFault: true }`)
  * `cps-i40/<StationID>/command`: Steuerbefehle von Werker/Leitstand

---

## 🔌 4. Express REST API

Das Backend stellt standardisierte REST-Endpunkte für Statusabfragen und Systemkonfiguration bereit:

| Methode | Endpunkt | Beschreibung | Authentifizierung |
| :--- | :--- | :--- | :---: |
| `GET` | `/health` | Healthcheck (Status `ok`, Uptime, Timestamp) | öffentlich |
| `GET` | `/api/status` | Systemstatus (MQTT-, WS- & Store-Statistiken) | öffentlich |
| `GET` | `/api/stations` | Alle 4 Stationen inkl. 5-Minuten-Aggregationen | öffentlich |
| `GET` | `/api/history` | Zeitreihen der letzten 5 Minuten für alle Stationen | öffentlich |
| `POST` | `/api/fault` | Störung simulieren oder quittieren (`stationId`, `isFault`) | optional |
| `GET` | `/api/config` | Aktuelle Schnittstellen-Konfiguration abrufen | öffentlich |
| `POST` | `/api/config` | MQTT/WS-URLs, Ports oder Grenzwerte anpassen | Operator / Admin |
| `POST` | `/api/config/test-websocket` | Testet Erreichbarkeit einer WebSocket-URL | öffentlich |
| `POST` | `/api/config/test-mqtt` | Testet Erreichbarkeit eines MQTT-Brokers | öffentlich |

---

## 🔄 5. WebSocket Telemetrie-Server (`/ws/telemetry`)

Das Backend betreibt einen bidirektionalen WebSocket-Server zur Echtzeit-Synchronisation aller Clients:

* **Frame-Typen:**
  1. `init`: Sendet beim Client-Verbindungsaufbau die komplette 5-Minuten-Historie und aktuelle Aggregationen.
  2. `telemetry`: Pusht jeden neuen Messwert sofort an alle verbundenen Dashboards.
  3. `fault_change`: Signalisiert Störungsereignisse und Quittierungen.
  4. `status`: Informiert über MQTT-Verbindungsstatus (`connected: true/false`).
  5. `config_updated`: Verteilt Konfigurationsänderungen synchron an alle Clients.
