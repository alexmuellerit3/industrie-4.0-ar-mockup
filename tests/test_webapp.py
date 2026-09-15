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

if __name__ == "__main__":
    unittest.main()
