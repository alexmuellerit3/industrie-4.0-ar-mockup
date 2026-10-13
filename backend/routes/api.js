/**
 * API Routes - REST-Schnittstellen für CPS-i40 WebApp & Externe Systeme
 */

import express from "express";

export function createApiRouter({ store, mqttClient, wsServer, stationsConfig }) {
  const router = express.Router();

  // 1. Alle Stationen mit aktuellem Status abrufen
  router.get("/stations", (req, res) => {
    const stations = stationsConfig.map(st => {
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

  return router;
}
