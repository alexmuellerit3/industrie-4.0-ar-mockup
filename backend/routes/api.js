/**
 * API Routes - REST-Schnittstellen für CPS-i40 WebApp & Externe Systeme
 * 
 * Beinhaltet:
 * 1. Stations- und Historiendaten (/api/stations, /api/history, /api/history/summaries)
 * 2. Systemstatus & Störungsmanagement (/api/status, /api/fault)
 * 3. Dynamische MQTT & Stations-Konfiguration (/api/config)
 * 4. Benutzer- & Rechteverwaltung mit Gruppen (/api/auth/*)
 * 5. Beliebige JSON-Telemetrie Ingestion & Automatische semantische Interpretation (/api/telemetry/*)
 */

import express from "express";
import { MqttClientService } from "../mqtt-client.js";
import { WebSocketServerService } from "../websocket-server.js";
import { AVAILABLE_PERMISSIONS } from "../auth-manager.js";

export function createApiRouter({
  store,
  mqttClient,
  wsClient,
  wsServer,
  stationsConfig,
  configManager,
  authManager,
  telemetryInterpreter
}) {
  const router = express.Router();

  // Helper zum Extrahieren von Authentifizierungs-Tokens
  const extractToken = (req) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      return authHeader.substring(7).trim();
    }
    if (req.query && req.query.token) {
      return String(req.query.token).trim();
    }
    return null;
  };

  // Auth Context Middleware: Ermittelt Benutzer falls Token vorhanden
  router.use((req, res, next) => {
    if (authManager) {
      const token = extractToken(req);
      if (token) {
        const session = authManager.validateToken(token);
        if (session) {
          req.user = session;
        }
      }
    }
    next();
  });

  // Middleware zur Erzwingung von Berechtigungen
  const requirePermission = (permission) => {
    return (req, res, next) => {
      if (!authManager) return next();

      // Wenn kein Benutzer angemeldet ist
      if (!req.user) {
        return res.status(401).json({
          error: "Authentifizierung erforderlich. Bitte melden Sie sich an.",
          code: "AUTH_REQUIRED"
        });
      }

      // Prüfe auf Berechtigung
      if (permission && (!req.user.permissions || !req.user.permissions.includes(permission))) {
        return res.status(403).json({
          error: `Zugriff verweigert. Berechtigung '${permission}' erforderlich.`,
          requiredPermission: permission,
          userPermissions: req.user.permissions || []
        });
      }

      next();
    };
  };

  // ==========================================================================
  // 1. AUTHENTIFIZIERUNG & RECHTEVERWALTUNG (RBAC)
  // ==========================================================================

  // Login
  router.post("/auth/login", (req, res) => {
    if (!authManager) {
      return res.status(503).json({ error: "Authentifizierungsdienst nicht verfügbar." });
    }
    const { username, password } = req.body;
    const clientIp = req.ip || req.socket?.remoteAddress || "127.0.0.1";
    const result = authManager.login(username, password, clientIp);
    if (!result.success) {
      return res.status(result.status || 401).json(result);
    }
    res.json(result);
  });

  // Logout
  router.post("/auth/logout", (req, res) => {
    const token = extractToken(req);
    if (authManager && token) {
      authManager.logout(token);
    }
    res.json({ success: true, message: "Erfolgreich abgemeldet." });
  });

  // Eigene Benutzerdaten & Berechtigungen
  router.get("/auth/me", (req, res) => {
    if (!req.user) {
      return res.json({
        authenticated: false,
        user: {
          id: "guest",
          username: "gast",
          name: "Gast",
          group: { id: "guest", name: "Gast" },
          permissions: ["view_overview", "view_ar"]
        }
      });
    }
    res.json({
      authenticated: true,
      user: {
        id: req.user.userId,
        username: req.user.username,
        name: req.user.name,
        group: { id: req.user.groupId, name: req.user.groupName },
        permissions: req.user.permissions
      }
    });
  });

  // Verfügbare Berechtigungsliste
  router.get("/auth/permissions", (req, res) => {
    res.json({ permissions: AVAILABLE_PERMISSIONS });
  });

  // Gruppen auflisten
  router.get("/auth/groups", (req, res) => {
    if (!authManager) return res.json({ groups: [] });
    res.json({ groups: authManager.getGroups() });
  });

  // Gruppe anlegen (benötigt 'manage_groups')
  router.post("/auth/groups", requirePermission("manage_groups"), (req, res) => {
    try {
      const { id, name, description, permissions } = req.body;
      const group = authManager.createGroup({ id, name, description, permissions });
      res.status(201).json({ success: true, message: `Gruppe '${group.name}' erfolgreich erstellt.`, group });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Gruppe bearbeiten
  router.put("/auth/groups/:id", requirePermission("manage_groups"), (req, res) => {
    try {
      const group = authManager.updateGroup(req.params.id, req.body);
      res.json({ success: true, message: `Gruppe '${group.name}' aktualisiert.`, group });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Gruppe löschen
  router.delete("/auth/groups/:id", requirePermission("manage_groups"), (req, res) => {
    try {
      authManager.deleteGroup(req.params.id);
      res.json({ success: true, message: `Gruppe '${req.params.id}' erfolgreich gelöscht.` });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Benutzer auflisten (benötigt 'manage_users')
  router.get("/auth/users", requirePermission("manage_users"), (req, res) => {
    if (!authManager) return res.json({ users: [] });
    res.json({ users: authManager.getUsers() });
  });

  // Benutzer anlegen
  router.post("/auth/users", requirePermission("manage_users"), (req, res) => {
    try {
      const user = authManager.createUser(req.body);
      res.status(201).json({ success: true, message: `Benutzer '${user.username}' erstellt.`, user });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Benutzer bearbeiten
  router.put("/auth/users/:id", requirePermission("manage_users"), (req, res) => {
    try {
      const user = authManager.updateUser(req.params.id, req.body);
      res.json({ success: true, message: `Benutzer '${user.username}' aktualisiert.`, user });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Benutzer löschen
  router.delete("/auth/users/:id", requirePermission("manage_users"), (req, res) => {
    try {
      authManager.deleteUser(req.params.id);
      res.json({ success: true, message: `Benutzer '${req.params.id}' gelöscht.` });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ==========================================================================
  // 2. TELEMETRIE INGESTION & INTERPRETER FÜR BELIEBIGE JSON-PAKETE
  // ==========================================================================

  // Beliebiges JSON-Paket einspeisen, interpretieren & speichern
  router.post("/telemetry/ingest", (req, res) => {
    if (!req.body || typeof req.body !== "object" || Object.keys(req.body).length === 0) {
      return res.status(400).json({ error: "Ein gültiges JSON-Objekt mit Messdaten ist erforderlich." });
    }

    if (!telemetryInterpreter) {
      return res.status(503).json({ error: "TelemetryInterpreter nicht initialisiert." });
    }

    try {
      const interpretation = telemetryInterpreter.interpret(req.body);
      const { station, metrics, isFault } = interpretation;

      // In 5-Minuten KeyValueStore einspeisen
      const sample = {
        v1: metrics.v1.value,
        v2: metrics.v2.value,
        v3: metrics.v3.value,
        isFault: Boolean(isFault),
        status: interpretation.overallStatus
      };
      const entry = store.push(station.id, sample);

      // Störungs-Metadaten aktualisieren
      if (isFault !== undefined) {
        store.setMeta(`fault_${station.id}`, Boolean(isFault));
      }

      // Live-Push an alle verbundenen WebSockets (Leitstand & AR)
      if (wsServer) {
        wsServer.broadcast({
          type: "telemetry_interpreted",
          stationId: station.id,
          entry,
          summary: store.getSummary(station.id),
          interpretation,
          timestamp: Date.now()
        });
      }

      // Per MQTT publishen, falls verbunden
      if (mqttClient && mqttClient.isConnected) {
        mqttClient.publish(`cps-i40/${station.id}/telemetry`, entry);
      }

      res.json({
        success: true,
        message: "JSON-Paket erfolgreich analysiert, interpretiert und gespeichert.",
        stationId: station.id,
        entry,
        interpretation
      });
    } catch (err) {
      console.error("[API] Fehler bei JSON Ingestion:", err);
      res.status(500).json({ error: "Fehler beim Interpretieren des JSON-Pakets: " + err.message });
    }
  });

  // Nur Analyse/Vorschau eines JSON-Pakets ohne Speicherung
  router.post("/telemetry/interpret", (req, res) => {
    if (!req.body || typeof req.body !== "object" || Object.keys(req.body).length === 0) {
      return res.status(400).json({ error: "Ein gültiges JSON-Objekt ist erforderlich." });
    }

    if (!telemetryInterpreter) {
      return res.status(503).json({ error: "TelemetryInterpreter nicht initialisiert." });
    }

    try {
      const interpretation = telemetryInterpreter.interpret(req.body);
      res.json({
        success: true,
        interpretation
      });
    } catch (err) {
      res.status(400).json({ error: "Fehler bei der Interpretation: " + err.message });
    }
  });

  // Bisher registrierte Endpoints abrufen
  router.get("/telemetry/endpoints", (req, res) => {
    if (!telemetryInterpreter) return res.json({ endpoints: [], totalCount: 0 });
    const endpoints = telemetryInterpreter.getKnownEndpoints();
    res.json({
      endpoints,
      totalCount: endpoints.length
    });
  });

  // ==========================================================================
  // 3. BESTEHENDE TELEMETRIE- & STATUS-ENDPUNKTE
  // ==========================================================================

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
      version: "1.4.0",
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
      auth: {
        activeSessions: authManager ? authManager.sessions.size : 0,
        groupsCount: authManager ? authManager.data.groups.length : 0,
        usersCount: authManager ? authManager.data.users.length : 0
      },
      interpreter: {
        knownEndpointsCount: telemetryInterpreter ? telemetryInterpreter.knownEndpoints.size : 0
      },
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

  // 7. Konfiguration abrufen (Datenquelle, WebSocket, MQTT-URL, Stationen, System-Status)
  router.get("/config", (req, res) => {
    const currentConfig = configManager ? configManager.getConfig() : {
      dataSource: "websocket",
      websocket: {
        url: "ws://localhost:3000/ws/telemetry",
        clientId: "cps-backend-ws"
      },
      mqtt: {
        brokerUrl: mqttClient ? mqttClient.brokerUrl : "mqtt://localhost:1883",
        clientId: mqttClient ? mqttClient.clientId : "cps-backend"
      },
      stations: stationsConfig || []
    };

    res.json({
      config: currentConfig,
      dataSource: currentConfig.dataSource || "websocket",
      mqttStatus: {
        connected: mqttClient ? mqttClient.isConnected : false,
        brokerUrl: mqttClient ? mqttClient.brokerUrl : null,
        simulated: mqttClient ? mqttClient.isSimulatorActive : true
      },
      wsStatus: {
        connected: wsClient ? wsClient.isConnected : true,
        url: currentConfig.websocket?.url || "ws://localhost:3000/ws/telemetry",
        activeClients: wsServer ? wsServer.getClientCount() : 0,
        endpoint: "/ws/telemetry"
      },
      timestamp: Date.now()
    });
  });

  // 8. Konfiguration bearbeiten & sofort anwenden
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

      // Validierung WebSocket URL
      if (updates.websocket && updates.websocket.url) {
        const wsUrl = String(updates.websocket.url).trim();
        if (!/^(ws|wss):\/\/.+/i.test(wsUrl)) {
          return res.status(400).json({
            error: "Ungültiges Protokoll für WebSocket URL. Erlaubt sind ws:// oder wss://"
          });
        }
      }

      let updatedConfig = updates;
      if (configManager) {
        updatedConfig = configManager.updateConfig(updates);
      }

      if (telemetryInterpreter && updatedConfig.stations) {
        telemetryInterpreter.updateStations(updatedConfig.stations);
      }

      // Wenn MQTT Broker URL geändert wurde, Client sofort neu verbinden
      if (updates.mqtt && updates.mqtt.brokerUrl && mqttClient) {
        mqttClient.updateBroker(updates.mqtt.brokerUrl);
      }

      // Wenn Upstream WebSocket URL geändert wurde, Client sofort neu verbinden
      if (updates.websocket && updates.websocket.url && wsClient) {
        wsClient.updateUrl(updates.websocket.url);
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
        dataSource: updatedConfig.dataSource || "websocket",
        mqttStatus: {
          connected: mqttClient ? mqttClient.isConnected : false,
          brokerUrl: mqttClient ? mqttClient.brokerUrl : null,
          simulated: mqttClient ? mqttClient.isSimulatorActive : true
        },
        wsStatus: {
          connected: wsClient ? wsClient.isConnected : true,
          url: updatedConfig.websocket?.url || "ws://localhost:3000/ws/telemetry",
          activeClients: wsServer ? wsServer.getClientCount() : 0,
          endpoint: "/ws/telemetry"
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

      if (telemetryInterpreter && resetCfg.stations) {
        telemetryInterpreter.updateStations(resetCfg.stations);
      }

      if (mqttClient && resetCfg.mqtt && resetCfg.mqtt.brokerUrl) {
        mqttClient.updateBroker(resetCfg.mqtt.brokerUrl);
      }

      if (wsClient && resetCfg.websocket && resetCfg.websocket.url) {
        wsClient.updateUrl(resetCfg.websocket.url);
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

  // 11. Verbindung zu beliebigem WebSocket-Server testen
  router.post("/config/test-websocket", async (req, res) => {
    const { url, wsUrl, timeoutMs } = req.body;
    const targetUrl = url || wsUrl;
    if (!targetUrl) {
      return res.status(400).json({ success: false, message: "url ist erforderlich" });
    }

    if (!/^(ws|wss):\/\/.+/i.test(String(targetUrl).trim())) {
      return res.status(400).json({
        success: false,
        message: "Ungültiges Protokoll. WebSocket-URL muss mit ws:// oder wss:// beginnen."
      });
    }

    try {
      const result = await WebSocketServerService.testConnection(targetUrl, timeoutMs || 3500);
      res.json(result);
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  return router;
}
