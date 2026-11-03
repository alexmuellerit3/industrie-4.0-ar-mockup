# 02. Systemarchitektur & Datenfluss

> **Architektur-Typ:** 4-Ebenen-Industrie-4.0-Architektur (Purdue-Modell / RAMI 4.0 konform)  
> **Komponenten:** Feldebene (SPS), Edge-Gateway (Node-RED), Application-Server (Docker) & Multi-Device Web-Clients.

---

## 🏛️ Schichtenmodell & Topologie

```mermaid
graph TB
    subgraph OT_Zone ["Ebene 1 & 2: OT-Netzwerk (Fertigung)"]
        S1["Modul 1: Dosen-Zuführung<br/>IP: 192.168.10.11 • OPC UA ns=2"]
        S2["Modul 2: Dosierung & Befüllung<br/>IP: 192.168.10.12 • OPC UA ns=2"]
        S3["Modul 3: Verschluss & Bördelung<br/>IP: 192.168.10.13 • OPC UA ns=2"]
        S4["Modul 4: Qualitätskontrolle<br/>IP: 192.168.10.14 • OPC UA ns=2"]
    end

    subgraph Edge_Zone ["Ebene 3: Edge- & Vermittlungsschicht"]
        NR["Node-RED Edge Gateway<br/>(Siemens IOT2050 / IPC)"]
        MQ["Eclipse Mosquitto MQTT Broker<br/>Port 1883 (TCP) • Port 9001 (WS)"]
    end

    subgraph Backend_Zone ["Ebene 4: Applikations- & Serverebene (Docker)"]
        BE["Node.js CPS-Backend Server<br/>Port 3000 (HTTP / WS / WSS)"]
        STORE["5-Minuten In-Memory KeyValueStore<br/>TTL: 300.000 ms • Sliding Window"]
        AUTH["Auth- & RBAC-Service<br/>JWT Sessions • Rate Limiting"]
        INTERP["Semantischer Telemetrie-Interpreter<br/>Automatisches Tag-Mapping"]
    end

    subgraph Client_Zone ["Ebene 5: Multi-Client Präsentationsschicht"]
        AR["📱 Mobile AR WebApp (A-Frame / AR.js)<br/>Hiro-Marker Tracking • Live HUD"]
        SCADA["📊 SCADA Leitstand (HeroUI / SevDesk)<br/>KPIs • SVG-Area Charts • Störquittierung"]
    end

    S1 & S2 & S3 & S4 -->|"OPC UA TCP (:4840)"| NR
    NR -->|"WSS (:443) / WS"| BE
    NR -->|"MQTT Publish"| MQ
    MQ -->|"MQTT Subscribe"| BE
    
    BE <--> STORE
    BE <--> AUTH
    BE <--> INTERP
    
    BE -->|"WebSocket Push (/ws/telemetry)"| AR
    BE -->|"WebSocket Push & REST API"| SCADA
```

---

## 🔁 Die drei Betriebs- & Datenflussmodi

Die Plattform ist so ausgelegt, dass sie sich automatisch oder per Konfiguration an drei verschiedene Einsatzszenarien anpasst:

### Modus A: Live Node-RED Streaming (WSS)
1. Die SPSen stellen Prozessvariablen über den integrierten OPC UA Server bereit (`ns=2;s=ModulX.Tag`).
2. **Node-RED** fragt diese zyklisch ab (z. B. alle 500 ms) und transformiert sie in JSON-Objekte.
3. Über den gesicherten WebSocket-Endpunkt `wss://nodered.bbk.robin-w.de/ws/opcua` streamt Node-RED die Pakete direkt an das Backend oder an Web-Clients.
4. Der semantische Interpreter liest die Datenpunkte aus und aktualisiert den KeyValue-Store.

### Modus B: Lokaler Industrie-Docker-Betrieb (MQTT + Backend)
1. Sensordaten werden über das Topic-Schema `cps-i40/<StationID>/telemetry` an den Mosquitto MQTT Broker gesendet.
2. Das Backend abonniert alle Stations-Topics via Wildcard `cps-i40/+/telemetry`.
3. Der In-Memory Store bereinigt rollierend Daten, die älter als 5 Minuten sind, und sendet per WebSocket-Broadcast Aktualisierungen an alle verbundenen Webbrowser (`/ws/telemetry`).

### Modus C: Autarker Betrieb auf GitHub Pages (Serverless / Static Hosting)
1. Beim Aufruf über `https://alexmuellerit3.github.io/industrie-4.0-ar-mockup/` erkennt der Client den statischen Host.
2. Der Browser versucht zuerst, direkt eine sichere Verbindung zu `wss://nodered.bbk.robin-w.de/ws/opcua` aufzubauen.
3. Sollte die externe Quelle nicht erreichbar sein (z. B. Schulnetz-Firewall oder Offline-Betrieb), schaltet der Client nahtlos auf die integrierte **autarke SPS-Simulation**:
   * Eigener 5-Minuten Zeitreihen-Generator im Browser.
   * Lokales Login und Benutzerverwaltung im `localStorage`.
   * Volle visuelle Funktionalität ohne Server-Abhängigkeit.

---

## 🌐 Netzwerk- & Portübersicht

| Port | Protokoll | Dienst / Container | Verwendungszweck |
| :--- | :--- | :--- | :--- |
| **80 / 3000** | HTTP / WS | `backend` (Express) | WebApp Bereitstellung, REST API & WebSocket Telemetrie |
| **443** | HTTPS / WSS | `backend` (optional) | Gesicherte TLS-Kopplung bei direktem SSL-Zertifikat |
| **1883** | MQTT TCP | `mosquitto` | Industrielle Broker-Kommunikation für SPS / Gateways |
| **9001** | MQTT WS | `mosquitto` | MQTT über WebSockets für direkte Browser-Anbindung |
| **4840** | OPC UA TCP | Virtuelle / Physische SPS | Nativer Maschinen-Adressraum (ns=2) |
