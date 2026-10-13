/**
 * CPS-i40 Frontend Authentication & RBAC Service
 * 
 * Verwaltet Benutzersitzungen, Token-Persistenz im localStorage,
 * Autorisierungs-Header für REST/WebSocket sowie Endpunkte für
 * Gruppen- und Rechteverwaltung.
 */

class AuthService {
  constructor() {
    this.tokenKey = "cps_auth_token";
    this.userKey = "cps_auth_user";
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

  async checkSession() {
    const token = this.getToken();
    if (!token) {
      this.currentUser = null;
      this.notifyStateChanged();
      return null;
    }

    try {
      const res = await fetch("/api/auth/me", {
        headers: this.getAuthHeaders()
      });
      if (res.ok) {
        const data = await res.json();
        this.currentUser = data.user;
        localStorage.setItem(this.userKey, JSON.stringify(this.currentUser));
        this.notifyStateChanged();
        return this.currentUser;
      } else {
        this.logoutLocal();
        return null;
      }
    } catch (err) {
      console.warn("[AuthService] Session check failed:", err);
      return this.currentUser;
    }
  }

  async login(username, password) {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });

    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || "Anmeldung fehlgeschlagen");
    }

    try {
      localStorage.setItem(this.tokenKey, data.token);
      localStorage.setItem(this.userKey, JSON.stringify(data.user));
    } catch (e) {
      console.warn("[AuthService] localStorage write failed:", e);
    }

    this.currentUser = data.user;
    this.notifyStateChanged();
    return data;
  }

  async logout() {
    const token = this.getToken();
    if (token) {
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
    const res = await fetch("/api/auth/groups", {
      headers: this.getAuthHeaders()
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Fehler beim Laden der Gruppen (${res.status})`);
    }
    const data = await res.json();
    return data.groups || [];
  }

  async createGroup(groupData) {
    const res = await fetch("/api/auth/groups", {
      method: "POST",
      headers: this.getAuthHeaders(),
      body: JSON.stringify(groupData)
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || `Fehler beim Erstellen der Gruppe (${res.status})`);
    }
    return data.group;
  }

  async fetchUsers() {
    const res = await fetch("/api/auth/users", {
      headers: this.getAuthHeaders()
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Fehler beim Laden der Benutzer (${res.status})`);
    }
    const data = await res.json();
    return data.users || [];
  }

  async interpretTelemetry(payload) {
    const res = await fetch("/api/telemetry/interpret", {
      method: "POST",
      headers: this.getAuthHeaders(),
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || "Fehler bei der Interpretation");
    }
    return data;
  }

  async ingestTelemetry(payload) {
    const res = await fetch("/api/telemetry/ingest", {
      method: "POST",
      headers: this.getAuthHeaders(),
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error || "Fehler beim Einspeisen");
    }
    return data;
  }
}

export const authService = new AuthService();
