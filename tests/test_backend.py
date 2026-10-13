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


class TestBackendServerLive(unittest.TestCase):
    """Startet den Node.js Server temporär und prüft HTTP & REST Schnittstellen."""

    server_process = None
    server_port = 3099

    @classmethod
    def setUpClass(cls):
        env = os.environ.copy()
        env["PORT"] = str(cls.server_port)
        cls.server_process = subprocess.Popen(
            ["node", "backend/server.js"],
            cwd=BASE_DIR,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
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
            if cls.server_process.stdout:
                cls.server_process.stdout.close()
            if cls.server_process.stderr:
                cls.server_process.stderr.close()
            cls.server_process.terminate()
            cls.server_process.wait()

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
            self.assertEqual(len(stations), 4)
            ids = [s["id"] for s in stations]
            self.assertIn("ST-010", ids)
            self.assertIn("ST-020", ids)
            self.assertIn("ST-030", ids)
            self.assertIn("ST-040", ids)

    def test_api_history_endpoint(self):
        """GET /api/history liefert 5-Minuten Zeitreihen."""
        url = f"http://localhost:{self.server_port}/api/history"
        with urllib.request.urlopen(url, timeout=2) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode())
            self.assertIn("history", data)
            self.assertIn("summaries", data)
            self.assertIn("ST-020", data["history"])
            self.assertGreater(len(data["history"]["ST-020"]), 0)

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


if __name__ == "__main__":
    unittest.main()

