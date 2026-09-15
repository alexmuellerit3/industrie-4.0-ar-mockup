/**
 * CPS-i40 Mobile AR WebApp - Zentrale Konfiguration
 * 
 * Bereitet die Schnittstellenanbindung an Edge-Gateways,
 * OPC UA Server (z. B. Node-RED / Siemens IOT2050) und REST/WebSocket-Dienste vor.
 */

export const APP_CONFIG = {
  appName: "CPS-i40 AR Telemetrie",
  version: "1.2.0-modular",
  productionLine: "CPR-01 • Bonbon-Linie",
  defaultStationIndex: 1, // Startet bei Modul 2 (Dosier- & Befüllstation)

  // Schnittstellen-Endpunkte (Für spätere Live-Kopplung)
  api: {
    mode: "mock", // "mock" | "websocket" | "rest"
    wsEndpoint: "wss://edge-gateway.local/api/v1/telemetry",
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
      name: "Modul 1: Dosen-Zuführung",
      plcIp: "192.168.10.11",
      v1: {
        id: "magazine_level",
        nodeId: "ns=2;s=Modul1.MagazineLevel",
        label: "Magazin",
        val: 84,
        unit: "%",
        min: 82,
        max: 86
      },
      v2: {
        id: "vacuum_pressure",
        nodeId: "ns=2;s=Modul1.VacuumPressure",
        label: "Vakuum",
        val: -0.8,
        unit: "bar",
        min: -0.85,
        max: -0.78
      },
      v3: {
        id: "part_counter",
        nodeId: "ns=2;s=Modul1.PartCounter",
        label: "Zähler",
        val: 1684,
        unit: "Stk",
        isFixed: true
      }
    },
    {
      id: "ST-020",
      name: "Modul 2: Dosierung & Befüllung",
      plcIp: "192.168.10.12",
      v1: {
        id: "fill_weight",
        nodeId: "ns=2;s=Modul2.FillWeight_Actual",
        label: "Füllgewicht",
        val: 250.3,
        unit: "g",
        min: 249.7,
        max: 250.6
      },
      v2: {
        id: "pressure",
        nodeId: "ns=2;s=Modul2.OperatingPressure",
        label: "Druck",
        val: 5.2,
        unit: "bar",
        min: 5.1,
        max: 5.3
      },
      v3: {
        id: "throughput",
        nodeId: "ns=2;s=Modul2.ThroughputRate",
        label: "Takt",
        val: 32,
        unit: "D/min",
        min: 31,
        max: 33
      }
    },
    {
      id: "ST-030",
      name: "Modul 3: Verschluss & Bördelung",
      plcIp: "192.168.10.13",
      v1: {
        id: "press_force",
        nodeId: "ns=2;s=Modul3.RollerPressure",
        label: "Anpressdruck",
        val: 5.2,
        unit: "bar",
        min: 5.1,
        max: 5.3
      },
      v2: {
        id: "torque",
        nodeId: "ns=2;s=Modul3.SealingTorque",
        label: "Drehmoment",
        val: 3.9,
        unit: "Nm",
        min: 3.8,
        max: 4.1
      },
      v3: {
        id: "seal_check",
        nodeId: "ns=2;s=Modul3.QualityCheckOK",
        label: "Prüfung",
        val: 100,
        unit: "%",
        isFixed: true
      }
    },
    {
      id: "ST-040",
      name: "Modul 4: Qualitätskontrolle & Waage",
      plcIp: "192.168.10.14",
      v1: {
        id: "check_weight",
        nodeId: "ns=2;s=Modul4.WeightCheck_Actual",
        label: "Kontrollgewicht",
        val: 250.1,
        unit: "g",
        min: 249.8,
        max: 250.4
      },
      v2: {
        id: "reject_rate",
        nodeId: "ns=2;s=Modul4.RejectRate_Percent",
        label: "Ausschuss",
        val: 0.4,
        unit: "%",
        min: 0.3,
        max: 0.5
      },
      v3: {
        id: "oee",
        nodeId: "ns=2;s=Modul4.OverallOEE",
        label: "OEE",
        val: 93,
        unit: "%",
        isFixed: true
      }
    }
  ]
};
