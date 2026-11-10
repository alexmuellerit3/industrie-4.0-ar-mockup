/**
 * CPS-i40 Mobile AR WebApp - Zentrale Konfiguration
 * 
 * Bereitet die Schnittstellenanbindung an Edge-Gateways,
 * OPC UA Server (z. B. Node-RED / Siemens IOT2050) und REST/WebSocket-Dienste vor.
 */

export const APP_CONFIG = {
  appName: "CPS-i40 AR Telemetrie",
  version: "1.2.0-modular",
  productionLine: "PowerHouse • P-101",
  defaultStationIndex: 0, // Startet bei ST-010 (PowerHouse: Vibration P-101)

  // Schnittstellen-Endpunkte (Echtzeit Live-Kopplung mit automatischem Fallback)
  api: {
    mode: "websocket", // "mock" | "websocket" | "rest"
    wsEndpoint: "wss://nodered.bbk.robin-w.de/ws/opcua",
    restEndpoint: "https://edge-gateway.local/api/v1/stations",
    pollIntervalMs: 1500,
    requestTimeoutMs: 5000
  },

  // OPC UA Server Parameter (Dokumentation & Adressraum)
  opcUa: {
    serverUri: "opc.tcp://192.168.10.1:4840",
    securityPolicy: "Basic256Sha256",
    namespaceIndex: 2
  },

  // Stations-Definitionen mit industriellen Parametern & Node-Mappings
  stations: [
    {
      id: "ST-010",
      name: "PowerHouse: Vibration (P-101)",
      plcIp: "192.168.10.11",
      mqttTopic: "/bbk-lf/rpi04/power-house/vibration",
      wsNodeId: "ns=2;s=Demo.Alarms.Plant.PowerHouse.P-101.Vibration",
      isLive: true,
      isDemo: false,
      v1: {
        id: "vibration",
        nodeId: "ns=2;s=Demo.Alarms.Plant.PowerHouse.P-101.Vibration",
        label: "Vibration",
        val: 0.8,
        unit: "mm/s",
        min: 0.05,
        max: 2.5
      },
      v2: {
        id: "status_code",
        nodeId: "",
        label: "Status",
        val: 0,
        unit: "Good",
        min: 0,
        max: 0
      },
      v3: {
        id: "signal_quality",
        nodeId: "",
        label: "Signal",
        val: 100,
        unit: "%",
        min: 90,
        max: 100,
        isFixed: true
      }
    }
  ]
};
