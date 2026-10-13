"""
Automatische Unit- und Integritätstests für die CPS-i40 WebApp.
Stellt sicher, dass Kamera-Konfiguration, CSS-Stacking und JS-Module fehlerfrei bleiben.
"""

import unittest
import os
import re

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

class TestCameraAndCSSStacking(unittest.TestCase):
    """Prüft CSS-Regeln zur Vermeidung des 'Black Screen' Kamera-Bugs."""

    def setUp(self):
        with open(os.path.join(BASE_DIR, "css", "style.css"), "r") as f:
            self.css = f.read()

    def test_body_background_must_be_transparent(self):
        """Body darf keine opake Hintergrundfarbe haben, da AR.js das Video bei z-index < 0 rendert."""
        body_rule_match = re.search(r"html,\s*body\s*\{([^}]+)\}", self.css)
        self.assertIsNotNone(body_rule_match, "Regel 'html, body' in style.css nicht gefunden")
        rule_content = body_rule_match.group(1)
        
        self.assertIn("background: transparent", rule_content, 
                      "FEHLER: 'html, body' muss 'background: transparent !important' haben, sonst verdeckt die Hintergrundfarbe das Kamera-Video!")
        self.assertNotIn("background-color: #000", rule_content,
                         "FEHLER: 'background-color: #000' blockiert den AR.js Kamera-Stream!")

    def test_video_and_canvas_stacking(self):
        """Prüft, dass Video und Canvas saubere z-index Hierarchien besitzen."""
        self.assertIn("#arjs-video", self.css, "CSS-Selektor #arjs-video fehlt")
        self.assertIn(".a-canvas", self.css, "CSS-Selektor .a-canvas fehlt")
        self.assertIn(".ar-frame", self.css, "CSS-Selektor .ar-frame fehlt")


class TestARSceneConfiguration(unittest.TestCase):
    """Prüft die AR.js und A-Frame Parameter in index.html."""

    def setUp(self):
        with open(os.path.join(BASE_DIR, "index.html"), "r") as f:
            self.html = f.read()

    def test_a_scene_presence_and_attributes(self):
        """Prüft, ob a-scene mit korrekten AR.js Parametern existiert."""
        self.assertIn("<a-scene", self.html)
        self.assertIn("sourceType: webcam", self.html, "AR.js sourceType: webcam fehlt!")
        self.assertIn("facingMode: environment", self.html, "Kamera facingMode: environment fehlt!")
        self.assertIn("logarithmicDepthBuffer: true", self.html, "logarithmicDepthBuffer fehlt!")

    def test_hiro_marker_and_camera(self):
        """Prüft, ob der Hiro-Marker und das Kamera-Element definiert sind."""
        self.assertIn('preset="hiro"', self.html, "Hiro-Marker Preset fehlt")
        self.assertIn('id="hiro-marker"', self.html, "ID #hiro-marker fehlt")
        self.assertIn('<a-entity camera>', self.html, "Kamera-Entity in Szene fehlt")

    def test_modular_script_import(self):
        """Prüft die Einbindung des modularen Einstiegspunkts."""
        self.assertIn('<script type="module" src="js/app.js"></script>', self.html)
        self.assertIn('<link rel="stylesheet" href="css/style.css">', self.html)

    def test_zoom_components(self):
        """Prüft das Vorhandensein des Zoom-Buttons und der Zoom-Steuerung."""
        self.assertIn('id="btn-zoom"', self.html, "Zoom-Button #btn-zoom fehlt in index.html")
        with open(os.path.join(BASE_DIR, "js", "ar-controller.js"), "r") as f:
            ar_content = f.read()
        self.assertIn("cycleZoom(", ar_content, "cycleZoom-Methode fehlt in ARController")
        self.assertIn("detectZoomCapabilities(", ar_content, "detectZoomCapabilities fehlt in ARController")
        self.assertIn("discoverNativeCameras(", ar_content, "discoverNativeCameras fehlt in ARController")
        self.assertIn("switchCameraLens(", ar_content, "switchCameraLens fehlt in ARController")
        self.assertIn("--camera-zoom", ar_content, "--camera-zoom fehlt in ARController")
        self.assertIn("Math.max(1.0,", ar_content, "Minimum-Zoom muss strikt auf mindestens 1.0 gesperrt sein!")

    def test_close_card_and_persistence(self):
        """Prüft, dass der Schließen-Button existiert und das Popup persistent bleibt."""
        self.assertIn('id="btn-close-card"', self.html, "Schließen-Button #btn-close-card fehlt in index.html")
        with open(os.path.join(BASE_DIR, "js", "app.js"), "r") as f:
            app_content = f.read()
        self.assertIn("handleCloseCard", app_content, "handleCloseCard fehlt in app.js")
        self.assertNotIn("this.ui.hideStationCard()", app_content.split("handleMarkerLost()")[1].split("handleCloseCard()")[0],
                         "handleMarkerLost darf die Karte nicht mehr automatisch schließen!")
        with open(os.path.join(BASE_DIR, "js", "ui-controller.js"), "r") as f:
            ui_content = f.read()
        self.assertIn("onCloseCard", ui_content, "onCloseCard Callback fehlt in ui-controller.js")


class TestConfigAndTelemetryService(unittest.TestCase):
    """Prüft Konfiguration und Service-Dateien."""

    def test_config_structure(self):
        with open(os.path.join(BASE_DIR, "js", "config.js"), "r") as f:
            config_content = f.read()
        self.assertIn("export const APP_CONFIG", config_content)
        self.assertIn("ST-010", config_content)
        self.assertIn("ST-020", config_content)
        self.assertIn("ST-030", config_content)
        self.assertIn("ST-040", config_content)

    def test_telemetry_service_methods(self):
        with open(os.path.join(BASE_DIR, "js", "services", "telemetry-service.js"), "r") as f:
            service_content = f.read()
        self.assertIn("class TelemetryService", service_content)
        self.assertIn("subscribe(", service_content)
        self.assertIn("toggleFaultSimulation(", service_content)
        self.assertIn("connectWebSocket(", service_content)
        self.assertIn("startRestPolling(", service_content)

class TestCleanUIResponsiveRules(unittest.TestCase):
    """Prüft Clean UI Regeln: Industrie-Look, kein Blau, sauberes Ausblenden auf Touchscreens."""

    def setUp(self):
        with open(os.path.join(BASE_DIR, "css", "style.css"), "r") as f:
            self.css = f.read()

    def test_no_gamey_blue_in_hud(self):
        """HUD darf kein blau/cyan verwenden, sondern funktionales Titan-/Graphit-Design."""
        self.assertNotIn("#00ffff", self.css.lower())
        self.assertNotIn("#0070f3", self.css.lower())
        self.assertNotIn("cyan", self.css.lower())

    def test_sim_toggle_hidden_on_touchscreens(self):
        """Der Desktop-Sim-Schalter muss auf mobilen Touchscreens für ein cleanes UI ausgeblendet sein."""
        self.assertIn("@media (hover: none) and (pointer: coarse)", self.css)
        self.assertIn(".sim-toggle", self.css)
        self.assertIn("display: none !important;", self.css)


class TestBrowserARTestSuite(unittest.TestCase):
    """Prüft die 6-Stufen In-Browser AR-Testsuite in tests/index.html."""

    def setUp(self):
        with open(os.path.join(BASE_DIR, "tests", "index.html"), "r") as f:
            self.test_html = f.read()

    def test_all_six_stages_present(self):
        """Alle 6 Stufen der AR-Testsuite müssen in tests/index.html definiert sein."""
        for stage_num in range(1, 7):
            self.assertIn(f'id="card-stage{stage_num}"', self.test_html, f"Stufe {stage_num} fehlt in tests/index.html")
            self.assertIn(f'id="badge-stage{stage_num}"', self.test_html, f"Badge {stage_num} fehlt in tests/index.html")

    def test_canvas_stream_and_hiro_asset(self):
        """Prüft, ob der synthetische Canvas-Stream und das lokale Hiro-Asset konfiguriert sind."""
        self.assertIn('canvas.captureStream', self.test_html)
        self.assertIn('assets/hiro.png', self.test_html)
        self.assertIn('runAllStages', self.test_html)
        hiro_path = os.path.join(BASE_DIR, "tests", "assets", "hiro.png")
        self.assertTrue(os.path.isfile(hiro_path), "Lokales Asset tests/assets/hiro.png fehlt!")
        self.assertGreater(os.path.getsize(hiro_path), 1000, "Asset tests/assets/hiro.png ist leer oder korrupt!")


class TestTabletCockpitAndTrends(unittest.TestCase):
    """Prüft die Tablet- und Großbildschirm-Erweiterung (Trends, Sparklines, Cockpit)."""

    def setUp(self):
        with open(os.path.join(BASE_DIR, "index.html"), "r") as f:
            self.html = f.read()
        with open(os.path.join(BASE_DIR, "css", "style.css"), "r") as f:
            self.css = f.read()
        with open(os.path.join(BASE_DIR, "js", "ui-controller.js"), "r") as f:
            self.ui_code = f.read()
        with open(os.path.join(BASE_DIR, "js", "services", "telemetry-service.js"), "r") as f:
            self.serv_code = f.read()

    def test_tablet_markup_elements(self):
        """Prüft, ob Sparklines, Trend-Indikatoren und Tablet-Details im HTML vorhanden sind."""
        self.assertIn('id="tablet-details"', self.html, "Tablet-Diagnose #tablet-details fehlt in index.html")
        self.assertIn('id="v1-spark"', self.html, "Sparkline #v1-spark fehlt")
        self.assertIn('id="v1-trend"', self.html, "Trend-Pfeil #v1-trend fehlt")
        self.assertIn('id="tab-plc"', self.html, "SPS-IP #tab-plc fehlt")
        self.assertIn('id="tab-node"', self.html, "NodeId #tab-node fehlt")

    def test_tablet_responsive_css(self):
        """Prüft, ob Media Query für Tablets (>= 768px) definiert ist."""
        self.assertIn("@media (min-width: 768px)", self.css, "Tablet-Breakpoint @media (min-width: 768px) fehlt in style.css")
        self.assertIn(".tablet-details", self.css)
        self.assertIn(".sensor-sparkline", self.css)

    def test_sparkline_and_trend_logic(self):
        """Prüft, ob UIController und TelemetryService Trends und Sparklines unterstützen."""
        self.assertIn("renderSparkline(", self.ui_code, "renderSparkline fehlt in UIController")
        self.assertIn("renderTrendArrow(", self.ui_code, "renderTrendArrow fehlt in UIController")
        self.assertIn("initHistoryBuffers(", self.serv_code, "initHistoryBuffers fehlt in TelemetryService")
        self.assertIn("history.push(", self.serv_code, "Historien-Aktualisierung fehlt in TelemetryService")


class TestHeroUiAndSevDeskStyle(unittest.TestCase):
    """Prüft die visuelle Transformation in das HeroUI & SevDesk Design-System."""

    def setUp(self):
        with open(os.path.join(BASE_DIR, "index.html"), "r") as f:
            self.index_html = f.read()
        with open(os.path.join(BASE_DIR, "overview.html"), "r") as f:
            self.overview_html = f.read()
        with open(os.path.join(BASE_DIR, "css", "style.css"), "r") as f:
            self.ar_css = f.read()
        with open(os.path.join(BASE_DIR, "css", "overview.css"), "r") as f:
            self.overview_css = f.read()

    def test_heroui_tokens_and_elements_in_css(self):
        """Prüft, dass HeroUI Farb-Tokens, Glasmorphismus und Komponenten in beiden Stylesheets definiert sind."""
        self.assertIn("--heroui-surface", self.ar_css)
        self.assertIn("--heroui-card", self.ar_css)
        self.assertIn("--heroui-content1", self.overview_css)
        self.assertIn("heroui-chip", self.overview_css)
        self.assertIn("heroui-btn", self.overview_css)

    def test_sevdesk_kpi_and_metric_cards(self):
        """Prüft das SevDesk Dashboard-Layout (KPI-Karten und Metrik-Kacheln)."""
        self.assertIn("sevdesk-kpi-card", self.overview_html)
        self.assertIn("sevdesk-kpi-card", self.overview_css)
        self.assertIn("sevdesk-metric-cell", self.overview_css)
        self.assertIn("sevdesk-eval-grid", self.overview_css)

    def test_ar_webapp_heroui_adaptations(self):
        """Prüft die Anpassung der AR WebApp an den HeroUI/SevDesk Stil."""
        self.assertIn("header-ctrl-group", self.index_html)
        self.assertIn("overview-nav-btn", self.index_html)
        self.assertIn("detail-5m-grid", self.index_html)
        self.assertIn("zoom-pill", self.ar_css)
        self.assertIn("overview-nav-btn", self.ar_css)


if __name__ == "__main__":
    unittest.main()


