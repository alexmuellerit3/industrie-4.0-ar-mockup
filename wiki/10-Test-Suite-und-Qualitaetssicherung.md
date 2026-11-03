# 10. Test-Suite & Qualitätssicherung

> **Test-Framework:** Python `unittest` Suite (53 automatisierte Tests) + Browserbasierte AR-Stufentestsuite  
> **Status:** 100% grün (`Ran 53 tests, OK`)

---

## 🧪 Struktur der Test-Suite

Die Qualitätssicherung umfasst sowohl Backend- als auch Frontend-Integritätsprüfungen:

```
tests/
├── test_backend.py      # 27 Backend- & Schnittstellentests (Live-Server, REST, RBAC, Store)
├── test_webapp.py       # 26 Frontend-, AR- & Styling-Tests (A-Frame, HeroUI, Pages)
└── index.html           # 6-stufige interaktive Browser-AR-Testsuite
```

---

## 📋 Übersicht der Test-Klassen

### 1. `TestBackendServerLive` ([`tests/test_backend.py`](file:///root/bbk_cpr/tests/test_backend.py))
* Startet einen echten isolierten Node.js Backend-Server auf einem dynamischen Port.
* Testet alle REST-Endpunkte (`/health`, `/api/status`, `/api/stations`, `/api/history`, `/api/config`).
* Prüft das **Brute-Force Rate Limiting** und die **Rollenverwaltung (RBAC)**.
* Validiert die **Tippfehler-Korrektur** für WebSocket-URLs (`tobin-w.de` $\rightarrow$ `robin-w.de`).
* Verifiziert die **WSS / TLS-Unterstützung** und HTTP Security Headers.

### 2. `TestKeyValueStoreNode` ([`tests/test_backend.py`](file:///root/bbk_cpr/tests/test_backend.py))
* Prüft das exakte **5-Minuten Sliding Window (TTL = 300.000 ms)**.
* Stellt sicher, dass alte Datenpunkte verlässlich gepruned werden.
* Validiert die mathematischen Aggregationen (Min, Max, Avg, Quartils-Trend).

### 3. `TestARSceneConfiguration` & `TestCameraAndCSSStacking` ([`tests/test_webapp.py`](file:///root/bbk_cpr/tests/test_webapp.py))
* Stellt sicher, dass `<a-scene>` mit korrekten AR.js Parametern eingebunden ist.
* Überprüft das transparente Body-Styling und die Z-Index-Stacking-Reihenfolge.
* Verifiziert die Existenz und Persistenz der Stations-Popup-Karte.

### 4. `TestHeroUiAndSevDeskStyle` ([`tests/test_webapp.py`](file:///root/bbk_cpr/tests/test_webapp.py))
* Prüft die HeroUI Farb-Tokens (Titan/Graphit statt grellem Blau/Cyan).
* Verifiziert das SevDesk Dashboard-Grid und die SVG-Glow-Charts.

### 5. `TestGitHubPagesAndOfflineCompatibility` ([`tests/test_webapp.py`](file:///root/bbk_cpr/tests/test_webapp.py))
* Prüft das intelligente Client-Routing (Desktop $\rightarrow$ Leitstand, Mobil $\rightarrow$ AR).
* Stellt sicher, dass die Pages-Workflow-Datei exklusiv auf den `master`-Branch hört.
* Validiert die autarke Standalone-SPS-Simulation im Offline-Betrieb.

---

## ▶️ Testausführung

Die gesamte Suite kann jederzeit lokal oder in einer CI-Pipeline ausgeführt werden:

```bash
# Alle 53 Tests ausführen
python3 -m unittest discover tests -v
```

Ausgabebeispiel:
```text
test_api_config_get_endpoint ... ok
test_auth_login_sessions_and_rate_limiting ... ok
test_device_detection_routing ... ok
test_opcua_websocket_ingestion_and_demo_replacement ... ok
test_github_pages_workflow_exists ... ok
...
----------------------------------------------------------------------
Ran 53 tests in 4.738s

OK
```

---

## 🌐 6-stufige Browser AR-Testsuite (`tests/index.html`)

Für manuelle Tests auf physischen Mobilgeräten existiert eine 6-stufige Diagnose-Webseite:
1. **Stufe 1:** WebRTC Kamera-Berechtigungscheck.
2. **Stufe 2:** AR.js Video-Stream Initialisierung.
3. **Stufe 3:** Hiro-Marker Erkennungstest mit synthetischem Testbild.
4. **Stufe 4:** A-Frame 3D-Matrix Rendering.
5. **Stufe 5:** DOM-Overlay & Touch-Event Validierung.
6. **Stufe 6:** Live-WebSocket Latenztest zu Node-RED.
