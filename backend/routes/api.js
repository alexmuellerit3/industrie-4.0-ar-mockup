/**
 * API Routes - REST-Schnittstellen für CPS-i40 WebApp & Externe Systeme
 */

import express from "express";

import { MqttClientService } from "../mqtt-client.js";

export function createApiRouter({ store, mqttClient, wsServer, stationsConfig, configManager }) {
  const router = express.Router();

  // 1. Alle Stationen mit aktuellem Status abrufen
  router.get("/stations", (req, res) => {
    const activeStations = configManager ? configManager.getConfig().stations : (stationsConfig || []);
    const stations = activeStations.map(st => {
      const summary = store.getSummary(st.id);
      const isFault = Boolean(store.getMeta(`fault_${st.id}`));
      return {
        ...st,
        isFault,
        summary
      };
    });
    res.json({ stations, timestamp: Date.now() });
  });

  // 2. 5-Minuten Historie abrufen (Optional nach Station gefiltert)
  router.get("/history", (req, res) => {
    const stationId = req.query.station || req.query.stationId;
    const windowMs = parseInt(req.query.window || req.query.windowMs, 10) || 300000;

    if (stationId) {
      const data = store.getHistory(stationId, windowMs);
      const summary = store.getSummary(stationId, windowMs);
      return res.json({ stationId, count: data.length, windowMs, data, summary });
    }

    const allHistory = store.getAllHistory(windowMs);
    const allSummaries = store.getAllSummaries(windowMs);
    res.json({ windowMs, history: allHistory, summaries: allSummaries });
  });

  // 3. Statistische Zusammenfassungen der letzten 5 Minuten
  router.get("/history/summaries", (req, res) => {
    const windowMs = parseInt(req.query.window || req.query.windowMs, 10) || 300000;
    res.json({
      windowMs,
      ttlMinutes: 5,
      summaries: store.getAllSummaries(windowMs),
      timestamp: Date.now()
    });
  });

  // 4. System-Status (MQTT, WebSockets, Store, Memory)
  router.get("/status", (req, res) => {
    res.json({
      status: "operational",
      version: "1.3.0",
      uptimeSeconds: Math.floor(process.uptime()),
      mqtt: {
        connected: mqttClient ? mqttClient.isConnected : false,
        brokerUrl: mqttClient ? mqttClient.brokerUrl : null,
        simulated: mqttClient ? mqttClient.isSimulatorActive : true
      },
      websockets: {
        activeClients: wsServer ? wsServer.getClientCount() : 0,
        endpoint: "/ws/telemetry"
      },
      store: store ? store.getStats() : {},
      timestamp: Date.now()
    });
  });

  // 5. Störung simulieren / beheben
  router.post("/fault", (req, res) => {
    const { stationId, isFault } = req.body;
    if (!stationId) {
      return res.status(400).json({ error: "stationId is required" });
    }

    const faultState = Boolean(isFault);
    store.setMeta(`fault_${stationId}`, faultState);

    // Per MQTT publishen
    if (mqttClient) {
      mqttClient.publishCommand(stationId, {
        action: faultState ? "trigger_fault" : "clear_fault",
        isFault: faultState
      });
    }

    // Per WebSocket an alle UIs broadcasten
    if (wsServer) {
      wsServer.broadcast({
        type: "fault_change",
        stationId,
        isFault: faultState,
        timestamp: Date.now()
      });
    }

    res.json({ success: true, stationId, isFault: faultState });
  });

  // 6. Manuelle Telemetrie-Einspeisung über REST
  router.post("/telemetry", (req, res) => {
    const { stationId, data, isFault } = req.body;
    if (!stationId || !data) {
      return res.status(400).json({ error: "stationId and data are required" });
    }

    const sample = {
      v1: data.v1 ?? 0,
      v2: data.v2 ?? 0,
      v3: data.v3 ?? 0,
      isFault: isFault ?? false
    };

    const entry = store.push(stationId, sample);

    if (wsServer) {
      wsServer.broadcastTelemetry(stationId, entry);
    }

    if (mqttClient && mqttClient.isConnected) {
      mqttClient.publish(`cps-i40/${stationId}/telemetry`, entry);
    }

    res.json({ success: true, stationId, entry });
  });

  // 7. Konfiguration abrufen (MQTT-URL, Stationen, System-Status)
  router.get("/config", (req, res) => {
    const currentConfig = configManager ? configManager.getConfig() : {
      mqtt: {
        brokerUrl: mqttClient ? mqttClient.brokerUrl : "mqtt://localhost:1883",
        clientId: mqttClient ? mqttClient.clientId : "cps-backend"
      },
      stations: stationsConfig || []
    };

    res.json({
      config: currentConfig,
      mqttStatus: {
        connected: mqttClient ? mqttClient.isConnected : false,
        brokerUrl: mqttClient ? mqttClient.brokerUrl : null,
        simulated: mqttClient ? mqttClient.isSimulatorActive : true
      },
      timestamp: Date.now()
    });
  });

  // 8. Konfiguration bearbeiten & sofort anwenden (inkl. MQTT Broker Reconnect)
  router.post("/config", (req, res) => {
    try {
      const updates = req.body;
      if (!updates || typeof updates !== "object") {
        return res.status(400).json({ error: "Gültiges Konfigurationsobjekt erforderlich." });
      }

      // Validierung MQTT URL
      if (updates.mqtt && updates.mqtt.brokerUrl) {
        const url = String(updates.mqtt.brokerUrl).trim();
        if (!/^(mqtt|mqtts|ws|wss|tcp):\/\/.+/i.test(url)) {
          return res.status(400).json({
            error: "Ungültiges Protokoll für MQTT Broker URL. Erlaubt sind mqtt://, mqtts://, ws://, wss:// oder tcp://"
          });
        }
      }

      let updatedConfig = updates;
      if (configManager) {
        updatedConfig = configManager.updateConfig(updates);
      }

      // Wenn MQTT Broker URL geändert wurde, Client sofort neu verbinden
      if (updates.mqtt && updates.mqtt.brokerUrl && mqttClient) {
        mqttClient.updateBroker(updates.mqtt.brokerUrl);
      }

      // Broadcast an alle verbundenen WebClients
      if (wsServer) {
        wsServer.broadcast({
          type: "config_updated",
          config: updatedConfig,
          timestamp: Date.now()
        });
      }

      res.json({
        success: true,
        message: "Konfiguration erfolgreich aktualisiert und übernommen.",
        config: updatedConfig,
        mqttStatus: {
          connected: mqttClient ? mqttClient.isConnected : false,
          brokerUrl: mqttClient ? mqttClient.brokerUrl : null,
          simulated: mqttClient ? mqttClient.isSimulatorActive : true
        }
      });
    } catch (err) {
      console.error("[API] Fehler beim Speichern der Konfiguration:", err);
      res.status(500).json({ error: "Fehler beim Aktualisieren der Konfiguration: " + err.message });
    }
  });

  // 9. Konfiguration auf Werkseinstellungen zurücksetzen
  router.post("/config/reset", (req, res) => {
    try {
      let resetCfg = {};
      if (configManager) {
        resetCfg = configManager.resetConfig();
      }

      if (mqttClient && resetCfg.mqtt && resetCfg.mqtt.brokerUrl) {
        mqttClient.updateBroker(resetCfg.mqtt.brokerUrl);
      }

      if (wsServer) {
        wsServer.broadcast({
          type: "config_updated",
          config: resetCfg,
          timestamp: Date.now()
        });
      }

      res.json({
        success: true,
        message: "Konfiguration erfolgreich auf Standardwerte zurückgesetzt.",
        config: resetCfg
      });
    } catch (err) {
      res.status(500).json({ error: "Fehler beim Zurücksetzen: " + err.message });
    }
  });

  // 10. Verbindung zu beliebigem MQTT-Broker testen
  router.post("/config/test-mqtt", async (req, res) => {
    const { brokerUrl, timeoutMs } = req.body;
    if (!brokerUrl) {
      return res.status(400).json({ success: false, message: "brokerUrl ist erforderlich" });
    }

    try {
      const result = await MqttClientService.testConnection(brokerUrl, timeoutMs || 3500);
      res.json(result);
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  return router;
}
