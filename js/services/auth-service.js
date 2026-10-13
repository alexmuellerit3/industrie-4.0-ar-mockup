/**
 * CPS-i40 Frontend Authentication & RBAC Service
 * 
 * Verwaltet Benutzersitzungen, Token-Persistenz im localStorage,
 * Autorisierungs-Header für REST/WebSocket sowie Endpunkte für
 * Gruppen- und Rechteverwaltung.
 * 
 * Enthält automatische Fallback-Authentifizierung für Standalone- &
 * Offline-Betrieb (z.B. statische Vorschau ohne aktives Node.js Backend).
 */

const DEFAULT_ACCOUNTS = [
  {
    username: "admin",
    password: "admin123",
    displayName: "System Administrator",
    group: { id: "admin", name: "Administratoren" },
    permissions: ["view_overview", "view_ar", "control_faults", "edit_config", "ingest_telemetry", "manage_users", "manage_groups"]
  },
  {
    username: "operator",
    password: "operator123",
    displayName: "Anlagenbediener",
    group: { id: "operator", name: "Operatoren" },
    permissions: ["view_overview", "view_ar", "control_faults", "ingest_telemetry"]
  },
  {
    username: "viewer",
    password: "viewer123",
    displayName: "Gast / Beobachter",
    group: { id: "viewer", name: "Beobachter" },
    permissions: ["view_overview", "view_ar"]
  }
];

const DEFAULT_GROUPS = [
  {
    id: "admin",
    name: "Administratoren",
    description: "Voller Systemzugriff auf alle Funktionen und Konfigurationen",
    permissions: ["view_overview", "view_ar", "control_faults", "edit_config", "ingest_telemetry", "manage_users", "manage_groups"]
  },
  {
    id: "operator",
    name: "Operatoren",
    description: "Anlagenbedienung, Überwachung und Störungsquittierung vor Ort",
    permissions: ["view_overview", "view_ar", "control_faults", "ingest_telemetry"]
  },
  {
    id: "maintenance",
    name: "Instandhaltung",
    description: "Wartungspersonal mit Konfigurations- und Diagnoserechten",
    permissions: ["view_overview", "view_ar", "control_faults", "edit_config"]
  },
  {
    id: "viewer",
    name: "Beobachter / Gäste",
    description: "Reiner Lesezugriff auf Leitstand und AR-HUD ohne Steuerungsrechte",
    permissions: ["view_overview", "view_ar"]
  }
];

class AuthService {
  constructor() {
    this.tokenKey = "cps_auth_token";
    this.userKey = "cps_auth_user";
    this.customGroupsKey = "cps_custom_groups";
    this.listeners = new Set();
    this.currentUser = this.loadStoredUser();
  }

  getToken() {
    try {
      return localStorage.getItem(this.tokenKey) || null;
    } catch {
      return null;
    }
  }

  getUser() {
    return this.currentUser;
  }

  loadStoredUser() {
    try {
      const data = localStorage.getItem(this.userKey);
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  }

  getAuthHeaders() {
    const token = this.getToken();
    const headers = { "Content-Type": "application/json" };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    return headers;
  }

  onAuthStateChanged(callback) {
    if (typeof callback === "function") {
      this.listeners.add(callback);
      callback(this.currentUser);
    }
  }

  notifyStateChanged() {
    this.listeners.forEach(cb => {
      try {
        cb(this.currentUser);
      } catch (e) {
        console.error("[AuthService] Listener error:", e);
      }
    });
  }

  async parseSafeJson(res) {
    const contentType = res.headers ? (res.headers.get("content-type") || "") : "";
    if (contentType.includes("application/json")) {
      try {
        return await res.json();
      } catch {
        return null;
      }
    }
    return null;
  }

  async checkSession() {
    const token = this.getToken();
    if (!token) {
      this.currentUser = null;
      this.notifyStateChanged();
      return null;
    }

    // Wenn es ein Standalone-Token ist
    if (token.startsWith("standalone-token-")) {
      return this.currentUser;
    }

    try {
      const res = await fetch("/api/auth/me", {
        headers: this.getAuthHeaders()
      });
      const data = await this.parseSafeJson(res);
      if (res.ok && data && data.authenticated && data.user) {
        this.currentUser = data.user;
        localStorage.setItem(this.userKey, JSON.stringify(this.currentUser));
        this.notifyStateChanged();
        return this.currentUser;
      } else if (res.ok && data && !data.authenticated) {
        this.logoutLocal();
        return null;
      }
    } catch (err) {
      console.warn("[AuthService] Live-Session Check nicht erreichbar, behalte lokalen Status:", err.message);
    }
    return this.currentUser;
  }

  async login(username, password) {
    const uClean = String(username || "").trim().toLowerCase();
    const pClean = String(password || "");

    if (!uClean || !pClean) {
      throw new Error("Bitte Benutzername und Passwort eingeben.");
    }

    // 1. Versuche Backend-Login über Live-API
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: uClean, password: pClean })
      });

      const data = await this.parseSafeJson(res);
      if (data && typeof data === "object") {
        if (res.ok && data.success) {
          try {
            localStorage.setItem(this.tokenKey, data.token);
            localStorage.setItem(this.userKey, JSON.stringify(data.user));
          } catch {}
          this.currentUser = data.user;
          this.notifyStateChanged();
          return data;
        } else if (data.error) {
          throw new Error(data.error);
        }
      }
    } catch (netErr) {
      // Wenn es ein echter Auth-Fehler vom Backend war (z.B. falsches Passwort), direkt weiterwerfen
      if (netErr.message && !netErr.message.includes("is not valid JSON") && !netErr.message.includes("Failed to fetch") && !netErr.message.includes("NetworkError")) {
        throw netErr;
      }
      console.info("[AuthService] Live-Backend nicht erreichbar oder antwortet mit HTML. Prüfe Standalone-Fallback...");
    }

    // 2. Standalone / Offline-Fallback für Demo-Accounts
    const localMatch = DEFAULT_ACCOUNTS.find(a => a.username.toLowerCase() === uClean && a.password === pClean);
    if (localMatch) {
      const standaloneToken = `standalone-token-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const userObj = {
        username: localMatch.username,
        displayName: localMatch.displayName,
        group: localMatch.group,
        groupName: localMatch.group.name,
        permissions: localMatch.permissions,
        standalone: true
      };

      try {
        localStorage.setItem(this.tokenKey, standaloneToken);
        localStorage.setItem(this.userKey, JSON.stringify(userObj));
      } catch {}

      this.currentUser = userObj;
      this.notifyStateChanged();
      return { success: true, token: standaloneToken, user: userObj, standalone: true };
    }

    throw new Error("Ungültiger Benutzername oder falsches Passwort.");
  }

  async logout() {
    const token = this.getToken();
    if (token && !token.startsWith("standalone-token-")) {
      try {
        await fetch("/api/auth/logout", {
          method: "POST",
          headers: this.getAuthHeaders()
        });
      } catch (err) {
        console.warn("[AuthService] Remote logout failed:", err);
      }
    }
    this.logoutLocal();
  }

  logoutLocal() {
    try {
      localStorage.removeItem(this.tokenKey);
      localStorage.removeItem(this.userKey);
    } catch {}
    this.currentUser = null;
    this.notifyStateChanged();
  }

  async fetchGroups() {
    try {
      const res = await fetch("/api/auth/groups", {
        headers: this.getAuthHeaders()
      });
      const data = await this.parseSafeJson(res);
      if (res.ok && data && Array.isArray(data.groups)) {
        return data.groups;
      }
    } catch (_) {}

    // Fallback: Default + Custom Groups
    let custom = [];
    try {
      const raw = localStorage.getItem(this.customGroupsKey);
      if (raw) custom = JSON.parse(raw);
    } catch (_) {}

    return [...DEFAULT_GROUPS, ...custom];
  }

  async createGroup(groupData) {
    try {
      const res = await fetch("/api/auth/groups", {
        method: "POST",
        headers: this.getAuthHeaders(),
        body: JSON.stringify(groupData)
      });
      const data = await this.parseSafeJson(res);
      if (res.ok && data && data.success && data.group) {
        return data.group;
      } else if (data && data.error) {
        throw new Error(data.error);
      }
    } catch (err) {
      if (err.message && !err.message.includes("is not valid JSON") && !err.message.includes("Failed to fetch")) {
        throw err;
      }
    }

    // Standalone Speicherung
    const newGroup = {
      id: groupData.id,
      name: groupData.name,
      description: groupData.description || "",
      permissions: groupData.permissions || ["view_overview", "view_ar"],
      isSystem: false,
      createdAt: Date.now()
    };

    try {
      let custom = [];
      const raw = localStorage.getItem(this.customGroupsKey);
      if (raw) custom = JSON.parse(raw);
      custom.push(newGroup);
      localStorage.setItem(this.customGroupsKey, JSON.stringify(custom));
    } catch {}

    return newGroup;
  }

  async fetchUsers() {
    try {
      const res = await fetch("/api/auth/users", {
        headers: this.getAuthHeaders()
      });
      const data = await this.parseSafeJson(res);
      if (res.ok && data && Array.isArray(data.users)) {
        return data.users;
      }
    } catch (_) {}

    return DEFAULT_ACCOUNTS.map(a => ({
      username: a.username,
      displayName: a.displayName,
      group: a.group.id,
      groupName: a.group.name
    }));
  }

  async interpretTelemetry(payload) {
    try {
      const res = await fetch("/api/telemetry/interpret", {
        method: "POST",
        headers: this.getAuthHeaders(),
        body: JSON.stringify(payload)
      });
      const data = await this.parseSafeJson(res);
      if (res.ok && data && data.success) {
        return data;
      }
      if (data && data.error) throw new Error(data.error);
    } catch (err) {
      if (err.message && !err.message.includes("is not valid JSON") && !err.message.includes("Failed to fetch")) {
        throw err;
      }
    }

    // Standalone Interpreter Fallback
    return this.standaloneInterpret(payload);
  }

  async ingestTelemetry(payload) {
    try {
      const res = await fetch("/api/telemetry/ingest", {
        method: "POST",
        headers: this.getAuthHeaders(),
        body: JSON.stringify(payload)
      });
      const data = await this.parseSafeJson(res);
      if (res.ok && data && data.success) {
        return data;
      }
      if (data && data.error) throw new Error(data.error);
    } catch (err) {
      if (err.message && !err.message.includes("is not valid JSON") && !err.message.includes("Failed to fetch")) {
        throw err;
      }
    }

    return this.standaloneInterpret(payload);
  }

  standaloneInterpret(payload) {
    const pStr = JSON.stringify(payload);
    let stId = "ST-020";
    let stName = "Modul 2: Dosierung & Befüllung";
    if (pStr.includes("ST-010") || pStr.includes("Magazin") || pStr.includes("Vakuum")) {
      stId = "ST-010";
      stName = "Modul 1: Dosen-Zuführung";
    } else if (pStr.includes("ST-030") || pStr.includes("Drehmoment") || pStr.includes("Bördel")) {
      stId = "ST-030";
      stName = "Modul 3: Verschluss & Bördelung";
    } else if (pStr.includes("ST-040") || pStr.includes("Waage") || pStr.includes("OEE")) {
      stId = "ST-040";
      stName = "Modul 4: Qualitätskontrolle & Waage";
    }

    // Werte extrahieren
    let v1 = 250.3, v2 = 5.2, v3 = 32;
    if (typeof payload === "object") {
      if (payload.v1 !== undefined) v1 = payload.v1;
      if (payload.v2 !== undefined) v2 = payload.v2;
      if (payload.v3 !== undefined) v3 = payload.v3;
      if (payload.telemetry) {
        v1 = payload.telemetry.fill_weight_g ?? v1;
        v2 = payload.telemetry.pressure_bar ?? v2;
        v3 = payload.telemetry.cycle_rate_cpm ?? v3;
      }
      if (payload.payload) {
        v1 = payload.payload.v1 ?? v1;
        v2 = payload.payload.v2 ?? v2;
        v3 = payload.payload.v3 ?? v3;
      }
    }

    let status = "OPTIMAL";
    let summary = `✅ Modul '${stName}' arbeitet in optimalem Prozesszustand. Alle Werte im Sollbereich.`;
    if (v2 > 6.0 && v2 < 8.0) {
      status = "WARNUNG";
      summary = `⚠️ Warnung: Modul '${stName}' läuft mit Abweichungen: Druck (${v2} bar) liegt über dem Höchstwert.`;
    } else if (v2 >= 8.0 || v1 > 300) {
      status = "KRITISCH";
      summary = `⛔ Akute Störung: Modul '${stName}' überschreitet kritische Sicherheitsparameter!`;
    }

    const endpoints = [];
    const walk = (obj, prefix = "") => {
      if (!obj || typeof obj !== "object") return;
      Object.entries(obj).forEach(([k, v]) => {
        const path = prefix ? `${prefix}.${k}` : k;
        if (typeof v === "object" && v !== null && !Array.isArray(v)) {
          walk(v, path);
        } else {
          endpoints.push({ path, value: v, type: Array.isArray(v) ? "array" : typeof v });
        }
      });
    };
    walk(payload);

    return {
      success: true,
      interpretation: {
        timestamp: Date.now(),
        stationId: stId,
        stationName: stName,
        status,
        summary,
        mappedValues: {
          v1: { label: "Füllgewicht / Hauptwert", val: v1, unit: "g", status },
          v2: { label: "Druck / Zweitwert", val: v2, unit: "bar", status },
          v3: { label: "Takt / Zähler", val: v3, unit: "D/min", status: "NORMAL" }
        },
        extractedEndpoints: endpoints
      }
    };
  }
}

export const authService = new AuthService();
