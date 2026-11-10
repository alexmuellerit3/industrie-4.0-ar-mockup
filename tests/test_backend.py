"""
Umfassende Unit- und Integrationstests für das CPS-i40 Industrie 4.0 Backend:
- 5-Minuten In-Memory KeyValueStore (Pruning, TTL 300s, Min/Max/Avg/Trend Berechnungen)
- MQTT Client Service & SPS-Simulator Fallback
- REST-API Endpunkte (/health, /api/stations, /api/history, /api/status, /api/fault)
- WebSocket Server Protokoll
- Docker & Deployment Pipeline Konfiguration
"""

import unittest
import os
import time
import json
import subprocess
import urllib.request
import urllib.parse
import http.client

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

class TestKeyValueStoreNode(unittest.TestCase):
    """Testet die Logik des 5-Minuten KeyValueStores über Node.js."""

    def test_keyvalue_store_ttl_and_pruning(self):
        """Prüft, dass Messwerte nach Ablauf der TTL von 300.000 ms (5 Min) entfernt werden."""
        script = """
        import { KeyValueStore } from './backend/keyvalue-store.js';
        const store = new KeyValueStore(300000); // 5 Min
        const now = 1000000000;
        
        // Füge Datenpunkt vor 6 Minuten ein (sollte gepruned werden)
        store.push('ST-020', { v1: 250.0, v2: 5.0, v3: 32 }, now - 360000);
        // Füge Datenpunkt vor 4 Minuten ein (sollte erhalten bleiben)
        store.push('ST-020', { v1: 250.2, v2: 5.2, v3: 32 }, now - 240000);
        // Füge aktuellen Datenpunkt ein
        store.push('ST-020', { v1: 250.4, v2: 5.3, v3: 32 }, now);

        store.pruneStation('ST-020', now);
        const history = store.getHistory('ST-020', 300000, now);
        
        console.log(JSON.stringify({
            count: history.length,
            firstTs: history[0].timestamp,
            latestTs: history[history.length - 1].timestamp
        }));
        """
        res = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=BASE_DIR,
            capture_output=True,
            text=True,
            check=True
        )
        data = json.loads(res.stdout)
        self.assertEqual(data["count"], 2, "Der 6 Minuten alte Eintrag muss durch den 5-Minuten TTL Cutoff entfernt werden")

    def test_keyvalue_store_statistical_summary(self):
        """Prüft die statistischen Aggregationen (Min, Max, Avg, Trend, Störrate)."""
        script = """
        import { KeyValueStore } from './backend/keyvalue-store.js';
        const store = new KeyValueStore(300000);
        const now = Date.now();

        // 4 aufsteigende Werte
        store.push('ST-010', { v1: 80.0, v2: -0.8, v3: 1000, isFault: false }, now - 40000);
        store.push('ST-010', { v1: 82.0, v2: -0.8, v3: 1000, isFault: false }, now - 30000);
        store.push('ST-010', { v1: 84.0, v2: -0.8, v3: 1000, isFault: false }, now - 20000);
        store.push('ST-010', { v1: 88.0, v2: -0.8, v3: 1000, isFault: true }, now - 10000);

        const summary = store.getSummary('ST-010');
        console.log(JSON.stringify(summary));
        """
        res = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=BASE_DIR,
            capture_output=True,
            text=True,
            check=True
        )
        summary = json.loads(res.stdout)
        self.assertEqual(summary["count"], 4)
        self.assertEqual(summary["v1"]["min"], 80.0)
        self.assertEqual(summary["v1"]["max"], 88.0)
        self.assertEqual(summary["v1"]["avg"], 83.5)
        self.assertEqual(summary["v1"]["trend"], "up")
        self.assertEqual(summary["faultCount"], 1)
        self.assertEqual(summary["faultRatePercent"], 25.0)

    def test_telemetry_three_decimal_places_rounding(self):
        """Prüft, dass Telemetriedaten in Store und Ingestion durchgängig auf 3 Nachkommastellen gerundet werden."""
        script = """
        import { KeyValueStore } from './backend/keyvalue-store.js';
        import { TelemetryInterpreter } from './backend/telemetry-interpreter.js';
        import { ConfigManager } from './backend/config-manager.js';
        import { CollectorService } from './backend/collector-service.js';

        const store = new KeyValueStore(300000);
        const now = Date.now();

        // 1. Store push runden
        const rawVibration = 2.0054946931373245;
        const entry = store.push('ST-010', { v1: rawVibration, v2: 0.123456, v3: 99.87654 }, now);
        
        // 2. Statistical summary runden
        store.push('ST-010', { v1: 2.006888, v2: 0.123, v3: 100 }, now + 1000);
        const summary = store.getSummary('ST-010');

        // 3. TelemetryInterpreter runden
        const cfg = new ConfigManager('/tmp/test-cfg-round.json');
        const interp = new TelemetryInterpreter(cfg.getStations());
        const mapped = interp.mapMetricsToStation(cfg.getStation('ST-010'), [
          { path: 'Demo.Alarms.Plant.PowerHouse.P-101.Vibration', value: 1.456789, type: 'Double' }
        ]);

        console.log(JSON.stringify({
          entryV1: entry.v1,
          entryV2: entry.v2,
          entryV3: entry.v3,
          sumMin: summary.v1.min,
          sumMax: summary.v1.max,
          sumAvg: summary.v1.avg,
          sumCur: summary.v1.current,
          mappedV1: mapped.v1
        }));
        """
        res = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=BASE_DIR,
            capture_output=True,
            text=True,
            check=True
        )
        data = json.loads(res.stdout)
        self.assertEqual(data["entryV1"], 2.005, "v1 muss auf 3 Nachkommastellen gerundet werden")
        self.assertEqual(data["entryV2"], 0.123, "v2 muss auf 3 Nachkommastellen gerundet werden")
        self.assertEqual(data["entryV3"], 99.877, "v3 muss auf 3 Nachkommastellen gerundet werden")
        self.assertEqual(data["sumMin"], 2.005)
        self.assertEqual(data["sumMax"], 2.007)
        self.assertEqual(data["sumAvg"], 2.006)
        self.assertEqual(data["sumCur"], 2.007)
        self.assertEqual(data["mappedV1"], 1.457, "Interpreter muss Messwerte auf 3 Dezimalstellen runden")


class TestDockerAndPipelineFiles(unittest.TestCase):
    """Prüft Dockerfile, docker-compose.yml und CI/CD Pipeline."""

    def test_dockerfile_syntax_and_contents(self):
        dockerfile_path = os.path.join(BASE_DIR, "Dockerfile")
        self.assertTrue(os.path.isfile(dockerfile_path), "Dockerfile fehlt")
        with open(dockerfile_path, "r") as f:
            content = f.read()
        self.assertIn("node:20-alpine", content, "Muss Node 20 Alpine Basis-Image nutzen")
        self.assertIn("EXPOSE 80", content, "Muss Port 80 exposen")
        self.assertIn("HEALTHCHECK", content, "Muss automatischen Docker Healthcheck definieren")
        self.assertIn("backend/server.js", content, "Muss backend/server.js starten")

    def test_docker_compose_configuration(self):
        compose_path = os.path.join(BASE_DIR, "docker-compose.yml")
        self.assertTrue(os.path.isfile(compose_path), "docker-compose.yml fehlt")
        with open(compose_path, "r") as f:
            content = f.read()
        self.assertIn("cps-backend", content)
        self.assertIn("mqtt-broker", content)
        self.assertIn("eclipse-mosquitto:2", content)
        self.assertTrue("80" in content, "Muss Port 80 mappen")
        self.assertNotIn("443", content, "Darf kein Port 443 mappen")
        self.assertIn("1883:1883", content)
        self.assertIn("ghcr.io", content, "docker-compose.yml muss das Image aus der GitHub Container Registry referenzieren")

    def test_deploy_script_executable(self):
        script_path = os.path.join(BASE_DIR, "scripts", "deploy.sh")
        self.assertTrue(os.path.isfile(script_path), "scripts/deploy.sh fehlt")
        self.assertTrue(os.access(script_path, os.X_OK), "scripts/deploy.sh muss ausführbar sein (chmod +x)")
        with open(script_path, "r") as f:
            content = f.read()
        self.assertIn("pull", content, "scripts/deploy.sh muss das Image aus der Registry pullen")
        self.assertIn("ghcr.io", content)

    def test_github_workflow_pipeline(self):
        wf_path = os.path.join(BASE_DIR, ".github", "workflows", "docker-build.yml")
        self.assertTrue(os.path.isfile(wf_path), ".github/workflows/docker-build.yml fehlt")
        with open(wf_path, "r") as f:
            content = f.read()
        self.assertIn("docker-build", content)
        self.assertIn("unittest", content)
        self.assertIn("packages: write", content, "Workflow benötigt Berechtigung für GitHub Container Registry")
        self.assertIn("ghcr.io", content, "Workflow muss das Image zu ghcr.io pushen")

    def test_mosquitto_config(self):
        conf_path = os.path.join(BASE_DIR, "mosquitto", "mosquitto.conf")
        self.assertTrue(os.path.isfile(conf_path), "mosquitto/mosquitto.conf fehlt")
        with open(conf_path, "r") as f:
            content = f.read()
        self.assertIn("listener 1883", content)
        self.assertIn("listener 9001", content)
        self.assertIn("protocol websockets", content)

    def test_arbitrary_port_binding_and_configuration(self):
        """Prüft, dass Docker, docker-compose und Skripte beliebige Ports via PORT / HOST_PORT unterstützen."""
        compose_path = os.path.join(BASE_DIR, "docker-compose.yml")
        with open(compose_path, "r") as f:
            compose_content = f.read()
        self.assertIn("${PORT", compose_content, "docker-compose.yml muss dynamische Port-Bindung über Umgebungsvariablen unterstützen")
        self.assertIn("${HOST_PORT", compose_content, "docker-compose.yml sollte HOST_PORT unterstützen")
        self.assertIn("${CONTAINER_PORT", compose_content, "docker-compose.yml sollte CONTAINER_PORT unterstützen")

        dockerfile_path = os.path.join(BASE_DIR, "Dockerfile")
        with open(dockerfile_path, "r") as f:
            dockerfile_content = f.read()
        self.assertIn("ARG PORT", dockerfile_content, "Dockerfile sollte ARG PORT unterstützen")
        self.assertIn("ENV PORT", dockerfile_content, "Dockerfile sollte ENV PORT setzen")
        self.assertIn("${PORT:-80}", dockerfile_content, "Dockerfile HEALTHCHECK sollte dynamischen Port unterstützen")

        deploy_script_path = os.path.join(BASE_DIR, "scripts", "deploy.sh")
        with open(deploy_script_path, "r") as f:
            deploy_content = f.read()
        self.assertIn("PORT=", deploy_content, "scripts/deploy.sh muss PORT Variable definieren oder übergeben")

        env_example_path = os.path.join(BASE_DIR, ".env.example")
        self.assertTrue(os.path.isfile(env_example_path), ".env.example sollte existieren")
        with open(env_example_path, "r") as f:
            env_content = f.read()
        self.assertIn("PORT=", env_content, ".env.example sollte PORT Konfiguration enthalten")
        self.assertIn("HOST_PORT=", env_content, ".env.example sollte HOST_PORT Konfiguration enthalten")


class TestBackendServerLive(unittest.TestCase):
    """Startet den Node.js Server temporär und prüft HTTP & REST Schnittstellen."""

    server_process = None
    server_port = 3099

    @classmethod
    def setUpClass(cls):
        cls.config_path = os.path.join(BASE_DIR, "config", "app-config.json")
        if os.path.exists(cls.config_path):
            with open(cls.config_path, "r") as f:
                cls.original_config = f.read()
        else:
            cls.original_config = None

        env = os.environ.copy()
        env["PORT"] = str(cls.server_port)
        cls.server_process = subprocess.Popen(
            ["node", "backend/server.js"],
            cwd=BASE_DIR,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )

        # Warte bis der Server antwortet
        url = f"http://localhost:{cls.server_port}/health"
        ready = False
        for _ in range(25):
            try:
                with urllib.request.urlopen(url, timeout=1) as resp:
                    if resp.status == 200:
                        ready = True
                        break
            except Exception:
                time.sleep(0.2)
        if not ready:
            raise RuntimeError("Backend Server konnte für Live-Tests nicht gestartet werden!")

    @classmethod
    def tearDownClass(cls):
        if cls.server_process:
            cls.server_process.terminate()
            cls.server_process.wait()
        if cls.original_config and os.path.exists(cls.config_path):
            with open(cls.config_path, "w") as f:
                f.write(cls.original_config)

    def test_health_endpoint(self):
        """GET /health liefert 200 OK mit status: ok."""
        url = f"http://localhost:{self.server_port}/health"
        with urllib.request.urlopen(url, timeout=2) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode())
            self.assertEqual(data["status"], "ok")

    def test_api_stations_endpoint(self):
        """GET /api/stations liefert alle 4 Stationen mit 5-Minuten Zusammenfassungen."""
        url = f"http://localhost:{self.server_port}/api/stations"
        with urllib.request.urlopen(url, timeout=2) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode())
            stations = data["stations"]
            self.assertGreaterEqual(len(stations), 1)
            ids = [s["id"] for s in stations]
            self.assertIn("ST-010", ids)

    def test_api_history_endpoint(self):
        """GET /api/history liefert 5-Minuten Zeitreihen."""
        url = f"http://localhost:{self.server_port}/api/history"
        with urllib.request.urlopen(url, timeout=2) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode())
            self.assertIn("history", data)
            self.assertIn("summaries", data)
            self.assertIn("ST-010", data["history"])
            self.assertGreater(len(data["history"]["ST-010"]), 0)

    def test_api_status_endpoint(self):
        """GET /api/status liefert Systemstatus (MQTT, WebSockets, Store)."""
        url = f"http://localhost:{self.server_port}/api/status"
        with urllib.request.urlopen(url, timeout=2) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode())
            self.assertEqual(data["status"], "operational")
            self.assertIn("mqtt", data)
            self.assertIn("store", data)
            self.assertIn("websockets", data)

    def test_api_fault_post_endpoint(self):
        """POST /api/fault simuliert und quittiert Störungen."""
        url = f"http://localhost:{self.server_port}/api/fault"
        payload = json.dumps({"stationId": "ST-030", "isFault": True}).encode()
        req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=2) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode())
            self.assertTrue(data["success"])
            self.assertTrue(data["isFault"])

    def test_overview_html_served_without_hiro(self):
        """GET /overview.html liefert die vollständige SCADA-Seite ohne Hiro-Marker."""
        url = f"http://localhost:{self.server_port}/overview.html"
        with urllib.request.urlopen(url, timeout=2) as resp:
            self.assertEqual(resp.status, 200)
            html = resp.read().decode()
            self.assertIn("Gesamtanlagen-Leitstand", html)
            self.assertIn("stations-scada-container", html)
            self.assertIn("overview.js", html)
            self.assertNotIn("a-scene", html, "overview.html darf keine AR.js/Hiro 3D-Szene enthalten!")
            self.assertIn("overview.css", html)

    def test_api_config_get_endpoint(self):
        """GET /api/config liefert Konfiguration mit MQTT-URL und Stationen."""
        url = f"http://localhost:{self.server_port}/api/config"
        with urllib.request.urlopen(url, timeout=2) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode())
            self.assertIn("config", data)
            self.assertIn("mqttStatus", data)
            self.assertIn("mqtt", data["config"])
            self.assertIn("brokerUrl", data["config"]["mqtt"])
            self.assertIn("stations", data["config"])

    def test_api_config_post_and_reset_endpoints(self):
        """POST /api/config aktualisiert MQTT-URL und POST /api/config/reset setzt zurück."""
        url = f"http://localhost:{self.server_port}/api/config"
        new_url = "mqtt://192.168.10.77:1883"
        payload = json.dumps({"mqtt": {"brokerUrl": new_url}}).encode()
        req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=2) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode())
            self.assertTrue(data["success"])
            self.assertEqual(data["config"]["mqtt"]["brokerUrl"], new_url)

        # GET prüfen
        with urllib.request.urlopen(url, timeout=2) as resp:
            data = json.loads(resp.read().decode())
            self.assertEqual(data["config"]["mqtt"]["brokerUrl"], new_url)

        # Reset auf Werkseinstellungen
        reset_url = f"http://localhost:{self.server_port}/api/config/reset"
        reset_req = urllib.request.Request(reset_url, data=b"{}", headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(reset_req, timeout=2) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode())
            self.assertTrue(data["success"])

    def test_api_config_test_mqtt_endpoint(self):
        """POST /api/config/test-mqtt testet Erreichbarkeit eines Brokers."""
        url = f"http://localhost:{self.server_port}/api/config/test-mqtt"
        payload = json.dumps({"brokerUrl": "mqtt://127.0.0.1:1883", "timeoutMs": 300}).encode()
        req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=3) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode())
            self.assertIn("success", data)
            self.assertIn("message", data)

    def test_api_config_websocket_and_data_source(self):
        """GET /api/config liefert dataSource & wsStatus und POST /api/config aktualisiert WebSocket-Parameter."""
        url = f"http://localhost:{self.server_port}/api/config"
        # 1. GET Prüfen
        with urllib.request.urlopen(url, timeout=2) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode())
            self.assertIn("dataSource", data["config"])
            self.assertIn("websocket", data["config"])
            self.assertIn("url", data["config"]["websocket"])
            self.assertIn("wsStatus", data)

        # 2. POST Aktualisieren
        new_ws_url = "ws://192.168.10.1:1880/ws/telemetry"
        payload = json.dumps({
            "dataSource": "websocket",
            "websocket": {"url": new_ws_url}
        }).encode()
        req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=2) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode())
            self.assertTrue(data["success"])
            self.assertEqual(data["config"]["websocket"]["url"], new_ws_url)
            self.assertEqual(data["config"]["dataSource"], "websocket")

        # 3. GET Bestätigen
        with urllib.request.urlopen(url, timeout=2) as resp:
            data = json.loads(resp.read().decode())
            self.assertEqual(data["config"]["websocket"]["url"], new_ws_url)

        # 4. Reset
        reset_url = f"http://localhost:{self.server_port}/api/config/reset"
        reset_req = urllib.request.Request(reset_url, data=b"{}", headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(reset_req, timeout=2) as resp:
            self.assertEqual(resp.status, 200)

    def test_api_config_test_websocket_endpoint(self):
        """POST /api/config/test-websocket testet Erreichbarkeit eines WebSocket-Endpunkts."""
        url = f"http://localhost:{self.server_port}/api/config/test-websocket"
        # Test 1: Gültiger lokaler WebSocket-Endpunkt
        payload = json.dumps({"url": f"ws://127.0.0.1:{self.server_port}/ws/telemetry", "timeoutMs": 1500}).encode()
        req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=3) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode())
            self.assertIn("success", data)
            self.assertIn("message", data)
            self.assertTrue(data["success"], "Lokaler Server-WebSocket muss erreichbar sein")

        # Test 2: Ungültiges Protokoll muss mit 400 abgelehnt werden
        invalid_payload = json.dumps({"url": "ftp://invalid-server"}).encode()
        invalid_req = urllib.request.Request(url, data=invalid_payload, headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(invalid_req, timeout=2) as resp:
                self.fail("FTP URL hätte mit HTTP 400 abgewiesen werden müssen")
        except urllib.error.HTTPError as err:
            self.assertEqual(err.code, 400)

        # Test 3: WSS (Secure WebSocket) Protokoll wird vollständig akzeptiert und analysiert
        wss_payload = json.dumps({"url": "wss://127.0.0.1:9999/ws/telemetry", "timeoutMs": 400}).encode()
        wss_req = urllib.request.Request(url, data=wss_payload, headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(wss_req, timeout=3) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode())
            self.assertIn("protocol", data)
            self.assertEqual(data["protocol"], "wss", "Endpunkt muss WSS Protokoll identifizieren")
            self.assertTrue(data.get("isSecure"), "isSecure muss für WSS Endpunkte True sein")

    def test_wss_and_https_server_capability(self):
        """Prüft, dass WebSocketServerService und Server WSS/TLS und resolveSslConfig unterstützen."""
        cmd = [
            "node",
            "-e",
            """
            import { resolveSslConfig } from './backend/server.js';
            import { WebSocketServerService } from './backend/websocket-server.js';
            import { WebSocketClientService } from './backend/websocket-client.js';

            // 1. Prüfe WSS-Erkennung in WebSocketServerService
            const wsServer = new WebSocketServerService({ isSecure: true, path: '/ws/telemetry' });
            if (wsServer.getProtocol() !== 'wss' || !wsServer.isSecure()) {
              console.error('WebSocketServerService erkennt WSS nicht korrekt');
              process.exit(1);
            }

            // 2. Prüfe WSS-Support in WebSocketClientService
            const wsClient = new WebSocketClientService({ url: 'wss://example.com/ws/telemetry' });
            if (!wsClient.url.startsWith('wss://')) {
              console.error('WebSocketClientService speichert WSS URL nicht korrekt');
              process.exit(1);
            }

            // 3. Prüfe testConnection WSS Metadaten
            WebSocketServerService.testConnection('wss://127.0.0.1:9999/ws', 200).then(res => {
              if (res.protocol !== 'wss' || res.isSecure !== true) {
                console.error('testConnection liefert ungültiges WSS-Ergebnis:', res);
                process.exit(1);
              }
              console.log('OK');
              process.exit(0);
            });
            """
        ]
        result = subprocess.run(cmd, cwd=BASE_DIR, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, f"WSS Server-Fähigkeiten fehlerhaft: {result.stderr}")


    def test_security_headers_present(self):
        """Backend setzt alle essenziellen Security Headers (X-Content-Type-Options, etc.)."""
        conn = http.client.HTTPConnection("localhost", self.server_port, timeout=2)
        conn.request("GET", "/health")
        resp = conn.getresponse()
        self.assertEqual(resp.getheader("X-Content-Type-Options"), "nosniff")
        self.assertEqual(resp.getheader("X-Frame-Options"), "SAMEORIGIN")
        self.assertIn("1; mode=block", resp.getheader("X-XSS-Protection", ""))
        conn.close()

    def test_device_detection_routing(self):
        """Erkennt Smartphones/Tablets und routet automatisch zu AR (/index.html) oder SCADA (/overview.html)."""
        # 1. iPhone -> /index.html
        conn = http.client.HTTPConnection("localhost", self.server_port, timeout=2)
        conn.request("GET", "/", headers={"User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1"})
        resp = conn.getresponse()
        self.assertEqual(resp.status, 302)
        self.assertEqual(resp.getheader("Location"), "/index.html")
        conn.close()

        # 2. iPad / Tablet -> /index.html
        conn = http.client.HTTPConnection("localhost", self.server_port, timeout=2)
        conn.request("GET", "/", headers={"User-Agent": "Mozilla/5.0 (iPad; CPU OS 15_0 like Mac OS X) AppleWebKit/605.1.15"})
        resp = conn.getresponse()
        self.assertEqual(resp.status, 302)
        self.assertEqual(resp.getheader("Location"), "/index.html")
        conn.close()

        # 3. Android Tablet -> /index.html
        conn = http.client.HTTPConnection("localhost", self.server_port, timeout=2)
        conn.request("GET", "/", headers={"User-Agent": "Mozilla/5.0 (Linux; Android 12; SM-X900) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36"})
        resp = conn.getresponse()
        self.assertEqual(resp.status, 302)
        self.assertEqual(resp.getheader("Location"), "/index.html")
        conn.close()

        # 4. Desktop Windows -> /overview.html
        conn = http.client.HTTPConnection("localhost", self.server_port, timeout=2)
        conn.request("GET", "/", headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"})
        resp = conn.getresponse()
        self.assertEqual(resp.status, 302)
        self.assertEqual(resp.getheader("Location"), "/overview.html")
        conn.close()

        # 5. Expliziter Override via Query-Param
        conn = http.client.HTTPConnection("localhost", self.server_port, timeout=2)
        conn.request("GET", "/?view=desktop", headers={"User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0)"})
        resp = conn.getresponse()
        self.assertEqual(resp.status, 302)
        self.assertEqual(resp.getheader("Location"), "/overview.html")
        conn.close()

    def test_auth_login_sessions_and_rate_limiting(self):
        """Prüft Login mit Token, Session-Validierung und Brute-Force Rate Limiting."""
        # 1. Erfolgreicher Login
        conn = http.client.HTTPConnection("localhost", self.server_port, timeout=2)
        body = json.dumps({"username": "admin", "password": "admin123"})
        conn.request("POST", "/api/auth/login", body=body, headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        self.assertEqual(resp.status, 200)
        data = json.loads(resp.read().decode())
        self.assertTrue(data["success"])
        self.assertIn("token", data)
        self.assertEqual(data["user"]["username"], "admin")
        self.assertEqual(data["user"]["group"]["id"], "admin")
        self.assertIn("manage_groups", data["user"]["permissions"])
        token = data["token"]
        conn.close()

        # 2. Session via /api/auth/me abfragen
        conn = http.client.HTTPConnection("localhost", self.server_port, timeout=2)
        conn.request("GET", "/api/auth/me", headers={"Authorization": f"Bearer {token}"})
        resp = conn.getresponse()
        self.assertEqual(resp.status, 200)
        me_data = json.loads(resp.read().decode())
        self.assertEqual(me_data["user"]["username"], "admin")
        conn.close()

        # 3. Falsches Passwort
        conn = http.client.HTTPConnection("localhost", self.server_port, timeout=2)
        bad_body = json.dumps({"username": "operator", "password": "wrongpassword"})
        conn.request("POST", "/api/auth/login", body=bad_body, headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        self.assertEqual(resp.status, 401)
        conn.close()

        # 4. Rate-Limiting nach 5 Fehlversuchen für Test-Benutzer
        test_user = "brute_target_test"
        for _ in range(5):
            conn = http.client.HTTPConnection("localhost", self.server_port, timeout=2)
            conn.request("POST", "/api/auth/login", body=json.dumps({"username": test_user, "password": "bad"}), headers={"Content-Type": "application/json"})
            resp = conn.getresponse()
            self.assertEqual(resp.status, 401)
            conn.close()

        # 6. Versuch muss mit 429 Too Many Requests abgewiesen werden
        conn = http.client.HTTPConnection("localhost", self.server_port, timeout=2)
        conn.request("POST", "/api/auth/login", body=json.dumps({"username": test_user, "password": "bad"}), headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        self.assertEqual(resp.status, 429)
        locked_data = json.loads(resp.read().decode())
        self.assertIn("gesperrt", locked_data["error"])
        conn.close()

    def test_rbac_and_group_management(self):
        """Prüft rollenbasierte Rechteverwaltung und dynamisches Anlegen von Gruppen."""
        # 1. Gruppen abrufen
        conn = http.client.HTTPConnection("localhost", self.server_port, timeout=2)
        conn.request("GET", "/api/auth/groups")
        resp = conn.getresponse()
        self.assertEqual(resp.status, 200)
        groups_data = json.loads(resp.read().decode())
        group_ids = [g["id"] for g in groups_data["groups"]]
        self.assertIn("admin", group_ids)
        self.assertIn("operator", group_ids)
        self.assertIn("maintenance", group_ids)
        self.assertIn("viewer", group_ids)
        conn.close()

        # 2. Neue Gruppe anlegen ohne Token -> 401
        test_gid = f"grp_test_{int(time.time() * 1000)}"
        new_group = {"id": test_gid, "name": "QA Techniker", "description": "Prüfpersonal", "permissions": ["view_overview", "control_faults"]}
        conn = http.client.HTTPConnection("localhost", self.server_port, timeout=2)
        conn.request("POST", "/api/auth/groups", body=json.dumps(new_group), headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        self.assertEqual(resp.status, 401)
        conn.close()

        # 3. Login als Admin für Token
        conn = http.client.HTTPConnection("localhost", self.server_port, timeout=2)
        conn.request("POST", "/api/auth/login", body=json.dumps({"username": "admin", "password": "admin123"}), headers={"Content-Type": "application/json"})
        login_res = json.loads(conn.getresponse().read().decode())
        token = login_res["token"]
        conn.close()

        # 4. Neue Gruppe anlegen mit Admin Token -> 201 Created
        conn = http.client.HTTPConnection("localhost", self.server_port, timeout=2)
        conn.request("POST", "/api/auth/groups", body=json.dumps(new_group), headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"})
        resp = conn.getresponse()
        self.assertEqual(resp.status, 201)
        create_res = json.loads(resp.read().decode())
        self.assertTrue(create_res["success"])
        self.assertEqual(create_res["group"]["id"], test_gid)
        conn.close()

        # 5. Prüfen, ob Gruppe jetzt vorhanden ist
        conn = http.client.HTTPConnection("localhost", self.server_port, timeout=2)
        conn.request("GET", "/api/auth/groups")
        resp = conn.getresponse()
        groups_data = json.loads(resp.read().decode())
        group_ids = [g["id"] for g in groups_data["groups"]]
        self.assertIn(test_gid, group_ids)
        conn.close()

        # 6. Aufräumen: Gruppe löschen via DELETE /api/auth/groups/:id
        conn = http.client.HTTPConnection("localhost", self.server_port, timeout=2)
        conn.request("DELETE", f"/api/auth/groups/{test_gid}", headers={"Authorization": f"Bearer {token}"})
        del_resp = conn.getresponse()
        self.assertEqual(del_resp.status, 200)
        conn.close()

    def test_telemetry_interpretation_and_ingestion(self):
        """Prüft intelligente Daten-Endpoint-Extraktion und verständliche deutsche Interpretation."""
        # 1. Flaches Paket (ST-020)
        flat_payload = {
            "station_id": "ST-020",
            "v1": 250.3,
            "v2": 5.2,
            "v3": 32
        }
        conn = http.client.HTTPConnection("localhost", self.server_port, timeout=2)
        conn.request("POST", "/api/telemetry/interpret", body=json.dumps(flat_payload), headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        self.assertEqual(resp.status, 200)
        res1 = json.loads(resp.read().decode())
        self.assertTrue(res1["success"])
        interp1 = res1["interpretation"]
        self.assertEqual(interp1["stationId"], "ST-020")
        self.assertEqual(interp1["status"], "OPTIMAL")
        self.assertIn("optimal", interp1["summary"].lower())
        self.assertGreaterEqual(len(interp1["extractedEndpoints"]), 3)
        conn.close()

        # 2. Verschachteltes IoT Gateway Paket mit Warn-Grenzwert
        nested_payload = {
            "device": { "type": "IOT2050", "module": "ST-020" },
            "telemetry": {
                "fill_weight_g": 250.2,
                "pressure_bar": 6.8,  # > 6.5 -> Warnung
                "cycle_rate_cpm": 32
            }
        }
        conn = http.client.HTTPConnection("localhost", self.server_port, timeout=2)
        conn.request("POST", "/api/telemetry/interpret", body=json.dumps(nested_payload), headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        self.assertEqual(resp.status, 200)
        res2 = json.loads(resp.read().decode())
        interp2 = res2["interpretation"]
        self.assertEqual(interp2["stationId"], "ST-020")
        self.assertEqual(interp2["status"], "WARNUNG")
        self.assertIn("warnung", interp2["summary"].lower())
        conn.close()

        # 3. Paket in den Leitstand einspeisen (Ingest)
        conn = http.client.HTTPConnection("localhost", self.server_port, timeout=2)
        conn.request("POST", "/api/telemetry/ingest", body=json.dumps(flat_payload), headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        self.assertEqual(resp.status, 200)
        ingest_res = json.loads(resp.read().decode())
        self.assertTrue(ingest_res["success"])
        self.assertEqual(ingest_res["interpretation"]["stationId"], "ST-020")
        conn.close()

        # 4. Endpunkte abfragen
        conn = http.client.HTTPConnection("localhost", self.server_port, timeout=2)
        conn.request("GET", "/api/telemetry/endpoints")
        resp = conn.getresponse()
        self.assertEqual(resp.status, 200)
        ep_res = json.loads(resp.read().decode())
        self.assertIn("endpoints", ep_res)
        self.assertGreater(len(ep_res["endpoints"]), 0)
        conn.close()

    def test_opcua_websocket_ingestion_and_demo_replacement(self):
        """Prüft, dass Node-RED OPC UA Pakete korrekt interpretiert werden und Demo-Daten im Store ersetzen."""
        script = """
        import { KeyValueStore } from './backend/keyvalue-store.js';
        import { TelemetryInterpreter } from './backend/telemetry-interpreter.js';
        import { WebSocketClientService, normalizeWsUrl } from './backend/websocket-client.js';

        // 1. Initialisiere Store mit Demo-Daten
        const store = new KeyValueStore(300000);
        store.push('ST-010', { v1: 84, v2: -0.8, v3: 1684, isDemo: true, simulated: true });
        store.push('ST-010', { v1: 84.2, v2: -0.8, v3: 1685, isDemo: true, simulated: true });
        const beforeCount = store.getHistory('ST-010').length;
        const hadDemoBefore = store.hasDemoData('ST-010');

        // 2. Simuliere Node-RED OPC UA Paket (wie von wss://nodered.bbk.robin-w.de/ws/opcua empfangen)
        const interpreter = new TelemetryInterpreter();
        let telemetryCalled = false;
        let lastPayload = null;

        const wsClient = new WebSocketClientService({
          url: 'wss://nodered.bbk.tobin-w.de/ws/opcua', // Test mit Tippfehler
          telemetryInterpreter: interpreter,
          onTelemetry: (stationId, payload, meta) => {
            telemetryCalled = true;
            lastPayload = payload;
            store.push(stationId, payload);
          }
        });

        // Test-Paket direkt an handleMessage übergeben
        const rawOpcUaMsg = JSON.stringify({
          topic: "ns=0;i=2258",
          payload: {
            value: { dataType: "DateTime", arrayType: "Scalar", value: "2026-10-13T11:45:00.123Z" },
            statusCode: { value: 0 },
            sourceTimestamp: "2026-10-13T11:45:00.123Z"
          },
          _msgid: "test-msg-123"
        });

        wsClient.handleMessage(rawOpcUaMsg);

        const historyAfter = store.getHistory('ST-010');
        const hasDemoAfter = store.hasDemoData('ST-010');

        console.log(JSON.stringify({
          normalizedUrl: wsClient.url,
          telemetryCalled,
          beforeCount,
          hadDemoBefore,
          afterCount: historyAfter.length,
          hasDemoAfter,
          isLive: lastPayload?.isLive,
          isDemo: lastPayload?.isDemo,
          stationId: 'ST-010',
          interpretation: lastPayload?.interpretation
        }));
        """
        res = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=BASE_DIR,
            capture_output=True,
            text=True,
            check=True
        )
        lines = [line.strip() for line in res.stdout.strip().split("\n") if line.strip().startswith("{") and line.strip().endswith("}")]
        data = json.loads(lines[-1])
        self.assertTrue(data["telemetryCalled"], "onTelemetry muss für Node-RED OPC UA Paket aufgerufen werden")
        self.assertTrue("robin-w.de" in data["normalizedUrl"], "Tippfehler tobin-w.de muss automatisch korrigiert werden")
        self.assertTrue(data["hadDemoBefore"], "Store sollte vor dem Empfang Demo-Daten haben")
        self.assertEqual(data["afterCount"], 1, "Demo-Daten müssen durch das erste reale Live-Paket ersetzt werden")
        self.assertFalse(data["hasDemoAfter"], "Store darf nach Ersetzen keine Demo-Daten mehr enthalten")
        self.assertTrue(data["isLive"])
        self.assertFalse(data["isDemo"])
        self.assertIn("OPC UA", data["interpretation"])

    def test_websocket_typo_domain_normalization(self):
        """Prüft, dass normalizeWsUrl Tippfehler in Domain-Namen transparent korrigiert."""
        script = """
        import { normalizeWsUrl } from './backend/websocket-client.js';
        console.log(JSON.stringify({
          url1: normalizeWsUrl('wss://nodered.bbk.tobin-w.de/ws/opcua'),
          url2: normalizeWsUrl('ws://nodered.bbk.tobin-w.de/ws/opcua'),
          url3: normalizeWsUrl('wss://nodered.bbk.robin-w.de/ws/opcua')
        }));
        """
        res = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=BASE_DIR,
            capture_output=True,
            text=True,
            check=True
        )
        lines = [line.strip() for line in res.stdout.strip().split("\n") if line.strip().startswith("{") and line.strip().endswith("}")]
        data = json.loads(lines[-1])
        self.assertEqual(data["url1"], "wss://nodered.bbk.robin-w.de/ws/opcua")
        self.assertEqual(data["url2"], "ws://nodered.bbk.robin-w.de/ws/opcua")
        self.assertEqual(data["url3"], "wss://nodered.bbk.robin-w.de/ws/opcua")

    def test_opcua_multistation_clock_synchronization_and_auth_interpret(self):
        """Prüft, dass Node-RED OPC UA Takt alle 4 Stationen synchronisiert und standaloneInterpret allStations liefert."""
        script = """
        import { KeyValueStore } from './backend/keyvalue-store.js';
        import { TelemetryInterpreter } from './backend/telemetry-interpreter.js';
        import { WebSocketClientService } from './backend/websocket-client.js';
        import { authService } from './js/services/auth-service.js';

        // 1. Prüfe authService.standaloneInterpret
        const rawOpcUaMsg = {
          topic: "ns=0;i=2258",
          payload: {
            value: { dataType: "DateTime", arrayType: "Scalar", value: "2026-11-03T07:50:06.940Z" },
            statusCode: { value: 0 },
            sourceTimestamp: "2026-11-03T07:50:06.940Z",
            serverTimestamp: "2026-11-03T07:50:06.940Z"
          },
          _msgid: "test-heartbeat"
        };

        const clientInterp = authService.standaloneInterpret(rawOpcUaMsg);
        const hasAllStations = Array.isArray(clientInterp?.interpretation?.allStations) && clientInterp.interpretation.allStations.length >= 1;

        // 2. Prüfe Backend Store Multi-Station Ersetzung
        const store = new KeyValueStore(300000);
        ['ST-010'].forEach(sId => {
          store.push(sId, { v1: 100, v2: 10, v3: 1, isDemo: true, simulated: true });
        });

        const updatedStations = [];
        const interpreter = new TelemetryInterpreter();
        const wsClient = new WebSocketClientService({
          url: 'wss://nodered.bbk.robin-w.de/ws/opcua',
          telemetryInterpreter: interpreter,
          onTelemetry: (stationId, payload, meta) => {
            updatedStations.push(stationId);
            store.push(stationId, payload);
          }
        });

        wsClient.handleMessage(JSON.stringify(rawOpcUaMsg));

        const demoRemaining = ['ST-010'].some(sId => store.hasDemoData(sId));

        console.log(JSON.stringify({
          clientSuccess: clientInterp.success,
          clientLive: clientInterp.isLive,
          hasAllStations,
          stations: clientInterp?.interpretation?.allStations?.map(s => s.stationId),
          updatedCount: updatedStations.length,
          updatedStations,
          demoRemaining
        }));
        """
        res = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=BASE_DIR,
            capture_output=True,
            text=True,
            check=True
        )
        lines = [line.strip() for line in res.stdout.strip().split("\n") if line.strip().startswith("{") and line.strip().endswith("}")]
        data = json.loads(lines[-1])
        self.assertTrue(data["clientSuccess"])
        self.assertTrue(data["clientLive"])
        self.assertTrue(data["hasAllStations"])
        self.assertIn("ST-010", data["stations"])
        self.assertGreaterEqual(data["updatedCount"], 1, "Mindestens ST-010 muss durch Node-RED OPC UA Takt aktualisiert werden")
        self.assertFalse(data["demoRemaining"], "Demo-Daten müssen durch echte Live-Telemetrie ersetzt werden")

    def test_station_customization_and_renaming(self):
        """Prüft, dass Module/Stationen einzeln konfiguriert, umbenannt und mit MQTT-Topics gebunden werden können."""
        # 1. Einzelne Station abrufen
        get_url = f"http://localhost:{self.server_port}/api/stations/ST-010"
        with urllib.request.urlopen(get_url, timeout=2) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode())
            self.assertIn("station", data)
            self.assertEqual(data["station"]["id"], "ST-010")

        # 2. Modul umbenennen und konfigurieren via PUT /api/stations/ST-010
        custom_name = "Pumpe 101: PowerHouse Vibration"
        custom_topic = "/bbk-lf/rpi04/power-house/vibration"
        payload = json.dumps({
            "name": custom_name,
            "description": "Vibrations-Sensor an Hauptantrieb",
            "mqttTopic": custom_topic,
            "v1": {
                "label": "Schwingung",
                "unit": "mm/s",
                "min": 1.0,
                "max": 5.0,
                "defaultVal": 3.2
            }
        }).encode()

        put_req = urllib.request.Request(get_url, data=payload, headers={"Content-Type": "application/json"}, method="PUT")
        with urllib.request.urlopen(put_req, timeout=2) as resp:
            self.assertEqual(resp.status, 200)
            res_data = json.loads(resp.read().decode())
            self.assertTrue(res_data["success"])
            self.assertEqual(res_data["station"]["name"], custom_name)
            self.assertEqual(res_data["station"]["mqttTopic"], custom_topic)
            self.assertEqual(res_data["station"]["v1"]["label"], "Schwingung")

        # 3. Prüfen, ob GET /api/stations den neuen Namen und die Bindung liefert
        list_url = f"http://localhost:{self.server_port}/api/stations"
        with urllib.request.urlopen(list_url, timeout=2) as resp:
            data = json.loads(resp.read().decode())
            st10 = next(s for s in data["stations"] if s["id"] == "ST-010")
            self.assertEqual(st10["name"], custom_name)
            self.assertEqual(st10["mqttTopic"], custom_topic)
            self.assertEqual(st10["v1"]["label"], "Schwingung")

    def test_dynamic_mqtt_topic_subscription_and_endpoints(self):
        """Prüft, dass beliebige MQTT-Topics dynamisch über REST-Endpunkte abonniert und verwaltet werden können."""
        # 1. Abonnierte Topics abrufen
        topics_url = f"http://localhost:{self.server_port}/api/mqtt/topics"
        with urllib.request.urlopen(topics_url, timeout=2) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode())
            self.assertIn("subscribedTopics", data)

        # 2. Neues benutzerdefiniertes Topic abonnieren
        sub_url = f"http://localhost:{self.server_port}/api/mqtt/subscribe"
        target_topic = "/bbk-lf/rpi04/custom-sensor-stream"
        payload = json.dumps({"topic": target_topic}).encode()
        req = urllib.request.Request(sub_url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=2) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode())
            self.assertTrue(data["success"])
            self.assertIn(target_topic, data["subscribedTopics"])

        # 3. GET /api/mqtt/topics prüfen
        with urllib.request.urlopen(topics_url, timeout=2) as resp:
            data = json.loads(resp.read().decode())
            self.assertIn(target_topic, data["subscribedTopics"])

        # 4. Topic de-abonnieren
        unsub_url = f"http://localhost:{self.server_port}/api/mqtt/unsubscribe"
        req = urllib.request.Request(unsub_url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=2) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode())
            self.assertTrue(data["success"])
            self.assertNotIn(target_topic, data["subscribedTopics"])

    def test_demo_data_clearance_endpoint(self):
        """Prüft den POST /api/store/clear-demo Endpunkt zum Verwerfen aller Demo-Daten."""
        url = f"http://localhost:{self.server_port}/api/store/clear-demo"
        req = urllib.request.Request(url, data=b"{}", headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=2) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode())
            self.assertTrue(data["success"])
            self.assertIn("Demo-Daten erfolgreich verworfen", data["message"])

    def test_custom_mqtt_topic_routing_to_configured_station(self):
        """Prüft, dass MqttClientService Nachrichten auf benutzerdefinierten Topics direkt an die gebundene Station routet."""
        script = """
        import { KeyValueStore } from './backend/keyvalue-store.js';
        import { MqttClientService } from './backend/mqtt-client.js';
        import { TelemetryInterpreter } from './backend/telemetry-interpreter.js';

        const store = new KeyValueStore(300000);
        // Vorbefüllung mit Demo-Daten
        store.push('ST-020', { v1: 250, v2: 5.2, v3: 32, isDemo: true, simulated: true });

        const stations = [
          {
            id: 'ST-020',
            name: 'PowerHouse Vibration Station',
            mqttTopic: '/bbk-lf/rpi04/power-house/vibration',
            v1: { id: 'vibration', label: 'Vibration', unit: 'mm/s', defaultVal: 3.0 },
            v2: { id: 'pressure', label: 'Druck', unit: 'bar', defaultVal: 5.0 },
            v3: { id: 'takt', label: 'Takt', unit: 'D/min', defaultVal: 30 }
          }
        ];

        const interpreter = new TelemetryInterpreter({ stations });
        let receivedStation = null;
        let receivedSample = null;

        const mqttClient = new MqttClientService({
          allowSimulator: false,
          stations,
          telemetryInterpreter: interpreter,
          onTelemetry: (stationId, payload, meta) => {
            receivedStation = stationId;
            receivedSample = payload;
            store.push(stationId, payload);
          }
        });

        // Simuliere Eintreffen einer Node-RED MQTT-Nachricht auf dem benutzerdefinierten Topic
        const incomingPayload = JSON.stringify({
          value: 3.339053,
          sourceTimestamp: "2026-11-03T08:31:55.338Z"
        });

        mqttClient.handleMessage('/bbk-lf/rpi04/power-house/vibration', incomingPayload);

        const stateAfter = store.getStationState('ST-020');
        console.log(JSON.stringify({
          receivedStation,
          v1: receivedSample?.v1,
          isLive: receivedSample?.isLive,
          isDemo: receivedSample?.isDemo,
          hasLive: stateAfter.hasLive,
          hasDemo: stateAfter.hasDemo
        }));
        """
        res = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=BASE_DIR,
            capture_output=True,
            text=True,
            check=True
        )
        lines = [line.strip() for line in res.stdout.strip().split("\n") if line.strip().startswith("{") and line.strip().endswith("}")]
        data = json.loads(lines[-1])
        self.assertEqual(data["receivedStation"], "ST-020")
        self.assertAlmostEqual(data["v1"], 3.339053, places=3)
        self.assertTrue(data["isLive"])
        self.assertFalse(data["isDemo"])
        self.assertTrue(data["hasLive"])
        self.assertFalse(data["hasDemo"], "Demo-Daten der Station müssen durch das reale MQTT-Paket ersetzt worden sein")

    def test_automatic_module_creation_from_unmapped_packet(self):
        """Prüft, dass bei ungemappten empfangenen Daten automatisch ein neues Modul generiert wird."""
        url = f"http://127.0.0.1:{self.server_port}/api/stations/create-from-packet"
        raw_opcua_packet = {
            "topic": "ns=2;s=Demo.Alarms.Plant.PowerHouse.P-101.Vibration",
            "payload": {
                "value": { "dataType": "Double", "arrayType": "Scalar", "value": 0.492353 },
                "statusCode": { "value": 0 },
                "sourceTimestamp": "2026-11-03T09:11:25.136Z"
            }
        }
        payload = json.dumps({"packet": raw_opcua_packet}).encode("utf-8")
        req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=2) as resp:
            self.assertEqual(resp.status, 201)
            res_data = json.loads(resp.read().decode("utf-8"))

        self.assertTrue(res_data.get("success"))
        created_station = res_data.get("station")
        self.assertIsNotNone(created_station)
        self.assertEqual(created_station["id"], "ST-POWERHOUSE-VIBRATION")
        self.assertIn("PowerHouse", created_station["name"])
        self.assertIn("Vibration", created_station["name"])
        self.assertEqual(created_station["v1"]["label"], "Vibration")
        self.assertEqual(created_station["v1"]["unit"], "mm/s")
        self.assertAlmostEqual(created_station["v1"]["val"], 0.492, places=3)
        self.assertTrue(created_station.get("isLive"))

        # 2. Prüfen, ob das Modul über GET /api/stations abrufbar ist
        get_url = f"http://127.0.0.1:{self.server_port}/api/stations/{created_station['id']}"
        with urllib.request.urlopen(get_url, timeout=2) as resp:
            self.assertEqual(resp.status, 200)
            station_details = json.loads(resp.read().decode("utf-8"))
            self.assertEqual(station_details["station"]["id"], "ST-POWERHOUSE-VIBRATION")

        # 3. Aufräumen: Erstelltes Modul wieder löschen
        del_req = urllib.request.Request(get_url, method="DELETE")
        with urllib.request.urlopen(del_req, timeout=2) as resp:
            self.assertEqual(resp.status, 200)

    def test_historical_incident_ledger_and_kpis(self):
        """
        Prüft die historische Störungs- & Ausfall-Datenbank (Incident Ledger):
        - GET /api/incidents liefert Störungs-Liste & KPI-Synopsis
        - POST /api/incidents legt neue manuelle Störung an (Status: OPEN)
        - POST /api/incidents/:id/resolve quittiert Störung und berechnet Ausfallzeit
        - POST /api/fault integriert automatisch Vorfälle in den Ledger
        - Filter-Parameter (?status=, ?stationId=) schränken Abfrage korrekt ein
        """
        # 1. Initiale Störungen abrufen
        get_url = f"http://127.0.0.1:{self.server_port}/api/incidents"
        with urllib.request.urlopen(get_url, timeout=3) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode("utf-8"))
            self.assertTrue(data.get("success"))
            self.assertIn("incidents", data)
            self.assertIn("kpis", data)
            initial_count = len(data["incidents"])
            self.assertGreaterEqual(initial_count, 3)
            self.assertIn("total", data["kpis"])
            self.assertIn("active", data["kpis"])
            self.assertIn("mttrMinutes", data["kpis"])
            self.assertIn("cumulativeDowntimeMinutes", data["kpis"])

        # 2. Neue Störung manuell melden
        post_data = json.dumps({
            "stationId": "ST-020",
            "title": "Dosierventil Klemmung durch Zuckerkristallisation",
            "severity": "KRITISCH",
            "operator": "Prüfungs-Techniker A. Müller"
        }).encode("utf-8")
        req = urllib.request.Request(get_url, data=post_data, headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=3) as resp:
            self.assertEqual(resp.status, 201)
            created = json.loads(resp.read().decode("utf-8"))
            self.assertTrue(created.get("success"))
            inc = created["incident"]
            self.assertEqual(inc["stationId"], "ST-020")
            self.assertEqual(inc["status"], "OPEN")
            created_id = inc["id"]

        # 3. Filter prüfen: Nur aktive/offene Störungen
        filter_url = f"http://127.0.0.1:{self.server_port}/api/incidents?status=OPEN"
        with urllib.request.urlopen(filter_url, timeout=3) as resp:
            self.assertEqual(resp.status, 200)
            open_data = json.loads(resp.read().decode("utf-8"))
            open_ids = [i["id"] for i in open_data["incidents"]]
            self.assertIn(created_id, open_ids)
            for item in open_data["incidents"]:
                self.assertEqual(item["status"], "OPEN")

        # 4. Störung quittieren / beheben
        resolve_url = f"http://127.0.0.1:{self.server_port}/api/incidents/{created_id}/resolve"
        resolve_data = json.dumps({
            "operator": "Techniker M. Weber",
            "notes": "Dosierventil mit Heißwasser gespült."
        }).encode("utf-8")
        resolve_req = urllib.request.Request(resolve_url, data=resolve_data, headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(resolve_req, timeout=3) as resp:
            self.assertEqual(resp.status, 200)
            resolved_res = json.loads(resp.read().decode("utf-8"))
            self.assertTrue(resolved_res.get("success"))
            self.assertEqual(resolved_res["incident"]["status"], "RESOLVED")
            self.assertIsNotNone(resolved_res["incident"]["resolvedAt"])
            self.assertGreaterEqual(resolved_res["incident"]["durationSeconds"], 0)

        # 5. POST /api/fault Interaktion mit Incident Ledger
        fault_url = f"http://127.0.0.1:{self.server_port}/api/fault"
        fault_payload = json.dumps({"stationId": "ST-010", "isFault": True}).encode("utf-8")
        fault_req = urllib.request.Request(fault_url, data=fault_payload, headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(fault_req, timeout=3) as resp:
            self.assertEqual(resp.status, 200)
            fault_res = json.loads(resp.read().decode("utf-8"))
            self.assertTrue(fault_res.get("success"))
            self.assertTrue(fault_res.get("isFault"))
            self.assertIsNotNone(fault_res.get("incident"))
            self.assertEqual(fault_res["incident"]["status"], "OPEN")

        # Quittieren über POST /api/fault
        clear_payload = json.dumps({"stationId": "ST-010", "isFault": False}).encode("utf-8")
        clear_req = urllib.request.Request(fault_url, data=clear_payload, headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(clear_req, timeout=3) as resp:
            self.assertEqual(resp.status, 200)
            clear_res = json.loads(resp.read().decode("utf-8"))
            self.assertFalse(clear_res.get("isFault"))
            self.assertEqual(clear_res["incident"]["status"], "RESOLVED")

    def test_mysql_24h_and_zabbix_monitoring_api(self):
        """
        Prüft die 24-Stunden-MySQL- und Zabbix-Monitoring-Schnittstellen:
        - GET /api/history/24h liefert 24h-Zeitreihen und statistische Aggregationen
        - GET /api/mysql/status liefert Verbindungs-, Retention- und Tabellenstatus
        - POST /api/config/test-mysql testet Erreichbarkeit der MySQL-Datenbank
        - GET /api/zabbix/hosts liefert Hosts mit Availability-Badges ([ZBX], [MQTT], [WS], [MYSQL])
        - POST /api/zabbix/hosts erlaubt das standardisierte Einpflegen neuer Hosts & Items
        - GET /api/zabbix/problems liefert aktive Schwellenwert-Verletzungen
        """
        # 1. GET /api/history/24h
        h24_url = f"http://127.0.0.1:{self.server_port}/api/history/24h?stationId=ST-010&hours=24"
        with urllib.request.urlopen(h24_url, timeout=3) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode("utf-8"))
            self.assertTrue(data.get("success"))
            self.assertEqual(data.get("stationId"), "ST-010")
            self.assertEqual(data.get("hours"), 24)
            self.assertIn("history", data)
            self.assertIn("aggregates", data)
            self.assertIn("v1", data["aggregates"])

        # 2. GET /api/mysql/status
        status_url = f"http://127.0.0.1:{self.server_port}/api/mysql/status"
        with urllib.request.urlopen(status_url, timeout=3) as resp:
            self.assertEqual(resp.status, 200)
            status_data = json.loads(resp.read().decode("utf-8"))
            self.assertIn("connected", status_data)
            self.assertEqual(status_data.get("retentionHours"), 24)
            self.assertIn("totalSamples24h", status_data)

        # 3. POST /api/config/test-mysql
        test_sql_url = f"http://127.0.0.1:{self.server_port}/api/config/test-mysql"
        test_payload = json.dumps({
            "host": "localhost",
            "port": 3306,
            "database": "cps_telemetry"
        }).encode("utf-8")
        test_req = urllib.request.Request(test_sql_url, data=test_payload, headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(test_req, timeout=4) as resp:
            self.assertEqual(resp.status, 200)
            test_res = json.loads(resp.read().decode("utf-8"))
            self.assertIn("message", test_res)
            self.assertIn("database", test_res)

        # 4. GET /api/zabbix/hosts
        zbx_hosts_url = f"http://127.0.0.1:{self.server_port}/api/zabbix/hosts"
        with urllib.request.urlopen(zbx_hosts_url, timeout=3) as resp:
            self.assertEqual(resp.status, 200)
            zbx_data = json.loads(resp.read().decode("utf-8"))
            self.assertTrue(zbx_data.get("success"))
            self.assertGreaterEqual(zbx_data.get("totalHosts", 0), 1)
            first_host = zbx_data["hosts"][0]
            self.assertIn("hostId", first_host)
            self.assertIn("availability", first_host)
            self.assertIn("items", first_host)
            self.assertTrue(first_host["availability"].get("zabbix"))

        # 5. POST /api/zabbix/hosts (Neuen Host einpflegen)
        create_host_payload = json.dumps({
            "hostId": "ST-050",
            "name": "Modul 5: Zabbix Endverpackung",
            "description": "Automatische Kartonierung",
            "plcIp": "192.168.10.15",
            "mqttTopic": "cps-i40/ST-050/telemetry",
            "items": {
              "v1": { "label": "Karton-Füllstand", "unit": "%", "min": 20, "max": 100 },
              "v2": { "label": "Vakuum-Hub", "unit": "bar", "min": -0.9, "max": -0.5 },
              "v3": { "label": "Takt", "unit": "K/min", "min": 10, "max": 30 }
            }
        }).encode("utf-8")
        create_host_req = urllib.request.Request(zbx_hosts_url, data=create_host_payload, headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(create_host_req, timeout=3) as resp:
            self.assertEqual(resp.status, 200)
            create_res = json.loads(resp.read().decode("utf-8"))
            self.assertTrue(create_res.get("success"))
            self.assertEqual(create_res["host"]["id"], "ST-050")

        # 6. GET /api/zabbix/problems
        problems_url = f"http://127.0.0.1:{self.server_port}/api/zabbix/problems"
        with urllib.request.urlopen(problems_url, timeout=3) as resp:
            self.assertEqual(resp.status, 200)
            problems_data = json.loads(resp.read().decode("utf-8"))
            self.assertTrue(problems_data.get("success"))
            self.assertIn("problems", problems_data)

    def test_legacy_demo_auto_migration_and_duplicate_powerhouse_prevention(self):
        """
        Prüft, dass:
        1. Veraltete Demo-Stationen (Dosen-Zuführung, Verschluss & Bördelung, etc.) in bestehenden Config-Dateien
           beim Start automatisch bereinigt und zu ST-010 PowerHouse: Vibration (P-101) migriert werden.
        2. Eintreffende Node-RED Pakete mit Topic 'Demo.Alarms.Plant.PowerHouse.P-101.Vibration'
           direkt ST-010 zugeordnet werden, sodass KEIN doppeltes Modul 'ST-POWERHOUSE-VIBRATION' entsteht.
        """
        script = """
        import fs from "fs";
        import path from "path";
        import { ConfigManager } from "./backend/config-manager.js";
        import { TelemetryInterpreter } from "./backend/telemetry-interpreter.js";

        const tempCfg = path.join("/tmp", `test-legacy-cfg-${Date.now()}.json`);
        fs.writeFileSync(tempCfg, JSON.stringify({
          dataSource: "websocket",
          stations: [
            { id: "ST-010", name: "Modul 1: Dosen-Zuführung", description: "Vakuum- und Magazinförderung", mqttTopic: "cps-i40/ST-010/telemetry", wsNodeId: "" },
            { id: "ST-020", name: "ST-020", description: "Automatisch generiertes Modul aus Empfangsdaten (cps-i40/ST-020/telemetry)", mqttTopic: "null" },
            { id: "ST-030", name: "Modul 3: Verschluss & Bördelung", description: "Bördeldruck & Schließmoment", mqttTopic: "cps-i40/ST-030/telemetry" },
            { id: "ST-040", name: "Modul 4: Qualitätskontrolle & Waage", description: "Kontrollwägung", mqttTopic: "cps-i40/ST-040/telemetry" },
            { id: "ST-POWERHOUSE-VIBRATION", name: "PowerHouse: Vibration (P-101)", description: "Auto Modul", mqttTopic: "/bbk-lf/rpi04/power-house/vibration" }
          ]
        }));

        const cfgManager = new ConfigManager(tempCfg);
        const stations = cfgManager.getStations();

        // Interpreter Topic-Erkennung
        const interpreter = new TelemetryInterpreter({ stations });
        const detectedNodeRed = interpreter.detectStationId({}, [], { topic: "Demo.Alarms.Plant.PowerHouse.P-101.Vibration" });
        const detectedMqtt = interpreter.detectStationId({}, [], { topic: "/bbk-lf/rpi04/power-house/vibration" });

        fs.unlinkSync(tempCfg);

        console.log(JSON.stringify({
          stationCount: stations.length,
          st010Name: stations.find(s => s.id === "ST-010")?.name,
          st010Ws: stations.find(s => s.id === "ST-010")?.wsNodeId,
          hasDuplicate: stations.some(s => s.id === "ST-POWERHOUSE-VIBRATION"),
          hasLegacyDemo: stations.some(s => s.name?.includes("Dosen-Zuführung") || s.name?.includes("Bördelung")),
          detectedNodeRed,
          detectedMqtt
        }));
        """
        res = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=BASE_DIR,
            capture_output=True,
            text=True,
            check=True
        )
        data = json.loads(res.stdout.strip().split("\n")[-1])
        self.assertEqual(data["stationCount"], 1, "Veraltete Demo-Stationen und Duplikate müssen bereinigt sein")
        self.assertEqual(data["st010Name"], "PowerHouse: Vibration (P-101)")
        self.assertIn("Demo.Alarms.Plant.PowerHouse.P-101.Vibration", data["st010Ws"])
        self.assertFalse(data["hasDuplicate"], "ST-POWERHOUSE-VIBRATION darf nicht doppelt existieren")
        self.assertFalse(data["hasLegacyDemo"], "Keine alten Demo-Module mehr")
        self.assertEqual(data["detectedNodeRed"], "ST-010", "Node-RED Topic muss ST-010 zugeordnet werden")
        self.assertEqual(data["detectedMqtt"], "ST-010", "MQTT Topic muss ST-010 zugeordnet werden")


if __name__ == "__main__":
    unittest.main()




