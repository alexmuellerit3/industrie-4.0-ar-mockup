/**
 * AuthManager - Authentifizierung, Session-Management & Rollenbasierte Rechteverwaltung (RBAC)
 * 
 * Beinhaltet:
 * 1. Sicheres Passwort-Hashing via Node.js stdlib 'crypto' (scrypt + Salt + timingSafeEqual)
 * 2. Token-basiertes Session-Management mit Ablaufzeit
 * 3. Dynamische Gruppen- und Rechteverwaltung (Gruppen erstellen, bearbeiten, löschen)
 * 4. Persistente Speicherung in config/auth-config.json
 * 5. Brute-Force-Schutz mit IP-basiertem Rate-Limiting für Login
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

export const AVAILABLE_PERMISSIONS = [
  { id: "view_overview", label: "Leitstand ansehen", description: "Zugriff auf die SCADA-Anlagenübersicht" },
  { id: "view_ar", label: "AR-HUD ansehen", description: "Zugriff auf die mobile AR-Kameraansicht" },
  { id: "control_faults", label: "Störungen schalten", description: "Störungen an Stationen simulieren und quittieren" },
  { id: "edit_config", label: "Konfiguration bearbeiten", description: "MQTT- und Stationsparameter ändern" },
  { id: "ingest_telemetry", label: "Daten einspeisen", description: "Externe Telemetriepakete und JSON-Objekte senden" },
  { id: "manage_users", label: "Benutzer verwalten", description: "Benutzer anlegen, bearbeiten und löschen" },
  { id: "manage_groups", label: "Gruppen verwalten", description: "Gruppen und deren Rechte erstellen und verwalten" }
];

export const DEFAULT_GROUPS = [
  {
    id: "admin",
    name: "Administratoren",
    description: "Voller Systemzugriff auf alle Funktionen und Konfigurationen",
    permissions: ["view_overview", "view_ar", "control_faults", "edit_config", "ingest_telemetry", "manage_users", "manage_groups"],
    isSystem: true
  },
  {
    id: "operator",
    name: "Operatoren",
    description: "Anlagenbedienung, Überwachung und Störungsquittierung vor Ort",
    permissions: ["view_overview", "view_ar", "control_faults", "ingest_telemetry"],
    isSystem: true
  },
  {
    id: "maintenance",
    name: "Instandhaltung",
    description: "Wartungspersonal mit Konfigurations- und Diagnoserechten",
    permissions: ["view_overview", "view_ar", "control_faults", "edit_config"],
    isSystem: true
  },
  {
    id: "viewer",
    name: "Beobachter / Gäste",
    description: "Reiner Lesezugriff auf Leitstand und AR-HUD ohne Steuerungsrechte",
    permissions: ["view_overview", "view_ar"],
    isSystem: true
  }
];

export class AuthManager {
  /**
   * @param {string} filePath - Pfad zur auth-config.json
   */
  constructor(filePath) {
    this.filePath = filePath;
    this.sessions = new Map(); // token -> { userId, username, groupId, permissions, createdAt, expiresAt }
    this.loginAttempts = new Map(); // ip -> { count, firstAttempt, blockedUntil }
    this.sessionTtlMs = 24 * 60 * 60 * 1000; // 24 Stunden
    this.maxFailedAttempts = 5;
    this.blockDurationMs = 60 * 1000; // 1 Minute Sperre bei Brute-Force

    this.data = this.loadOrCreate();
  }

  /**
   * Hash eines Passworts mit scrypt und zufälligem Salt
   */
  static hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
    const hash = crypto.scryptSync(password, salt, 64).toString("hex");
    return { hash, salt };
  }

  /**
   * Sichere Verifikation in konstanter Zeit
   */
  static verifyPassword(password, storedHash, salt) {
    try {
      const calculatedHash = crypto.scryptSync(password, salt, 64).toString("hex");
      return crypto.timingSafeEqual(Buffer.from(calculatedHash, "hex"), Buffer.from(storedHash, "hex"));
    } catch {
      return false;
    }
  }

  /**
   * Lädt die Authentifizierungskonfiguration oder erstellt Defaults
   */
  loadOrCreate() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed.users && parsed.groups) {
          return parsed;
        }
      }
    } catch (err) {
      console.warn("[Auth] Konnte auth-config.json nicht laden, initialisiere Defaults:", err.message);
    }

    // Default Daten erzeugen
    const adminHash = AuthManager.hashPassword("admin123");
    const operatorHash = AuthManager.hashPassword("operator123");
    const viewerHash = AuthManager.hashPassword("viewer123");

    const initialData = {
      groups: JSON.parse(JSON.stringify(DEFAULT_GROUPS)),
      users: [
        {
          id: "usr-admin",
          username: "admin",
          name: "System Administrator",
          groupId: "admin",
          passwordHash: adminHash.hash,
          passwordSalt: adminHash.salt,
          createdAt: Date.now()
        },
        {
          id: "usr-operator",
          username: "operator",
          name: "Schichtleiter Fertigung",
          groupId: "operator",
          passwordHash: operatorHash.hash,
          passwordSalt: operatorHash.salt,
          createdAt: Date.now()
        },
        {
          id: "usr-viewer",
          username: "viewer",
          name: "Gast / Leitstand Monitor",
          groupId: "viewer",
          passwordHash: viewerHash.hash,
          passwordSalt: viewerHash.salt,
          createdAt: Date.now()
        }
      ]
    };

    this.saveData(initialData);
    return initialData;
  }

  saveData(data = this.data) {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const tmpPath = `${this.filePath}.tmp.${Date.now()}`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      console.error("[Auth] Fehler beim Speichern von auth-config.json:", err.message);
    }
  }

  // ==========================================================================
  // RATE-LIMITING & BRUTE FORCE PROTECTION
  // ==========================================================================

  checkRateLimit(key) {
    if (!key) return { allowed: true };
    const now = Date.now();
    const entry = this.loginAttempts.get(key);
    if (!entry) return { allowed: true };

    if (entry.blockedUntil && now < entry.blockedUntil) {
      const remainingSec = Math.ceil((entry.blockedUntil - now) / 1000);
      return { allowed: false, remainingSec };
    }

    if (now - entry.firstAttempt > 60000) {
      this.loginAttempts.delete(key);
      return { allowed: true };
    }

    return { allowed: true };
  }

  recordFailedLogin(key) {
    if (!key) return;
    const now = Date.now();
    let entry = this.loginAttempts.get(key);
    if (!entry || (now - entry.firstAttempt > 60000)) {
      entry = { count: 1, firstAttempt: now, blockedUntil: null };
    } else {
      entry.count += 1;
      if (entry.count >= this.maxFailedAttempts) {
        entry.blockedUntil = now + this.blockDurationMs;
        console.warn(`[Auth] Brute-Force Schutz aktiv: ${key} für 60s gesperrt.`);
      }
    }
    this.loginAttempts.set(key, entry);
  }

  recordSuccessfulLogin(key) {
    if (key) this.loginAttempts.delete(key);
  }

  // ==========================================================================
  // AUTHENTIFIZIERUNG & SESSIONS
  // ==========================================================================

  login(username, password, clientIp = "127.0.0.1") {
    const normUser = String(username || "").toLowerCase().trim();
    const rateKey = `${clientIp}:${normUser || "anon"}`;
    const rateCheck = this.checkRateLimit(rateKey);
    if (!rateCheck.allowed) {
      return {
        success: false,
        status: 429,
        error: `Zu viele Fehlversuche für diesen Benutzer. Bitte warten Sie ${rateCheck.remainingSec} Sekunden (Konto temporär gesperrt).`
      };
    }

    if (!username || !password) {
      this.recordFailedLogin(rateKey);
      return { success: false, status: 400, error: "Benutzername und Passwort sind erforderlich." };
    }

    const user = this.data.users.find(u => u.username.toLowerCase() === normUser);
    if (!user) {
      this.recordFailedLogin(rateKey);
      return { success: false, status: 401, error: "Ungültiger Benutzername oder falsches Passwort." };
    }

    const isValid = AuthManager.verifyPassword(password, user.passwordHash, user.passwordSalt);
    if (!isValid) {
      this.recordFailedLogin(rateKey);
      return { success: false, status: 401, error: "Ungültiger Benutzername oder falsches Passwort." };
    }

    this.recordSuccessfulLogin(rateKey);

    // Gruppe & Rechte ermitteln
    const group = this.getGroupById(user.groupId) || { id: "viewer", name: "Beobachter", permissions: ["view_overview", "view_ar"] };
    const permissions = group.permissions || [];

    // Kryptografisch sicheren Session Token generieren
    const token = crypto.randomBytes(32).toString("hex");
    const session = {
      userId: user.id,
      username: user.username,
      name: user.name || user.username,
      groupId: group.id,
      groupName: group.name,
      permissions,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.sessionTtlMs
    };

    this.sessions.set(token, session);

    return {
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        group: {
          id: group.id,
          name: group.name
        },
        permissions
      }
    };
  }

  logout(token) {
    if (token && this.sessions.has(token)) {
      this.sessions.delete(token);
      return true;
    }
    return false;
  }

  validateToken(token) {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;

    if (Date.now() > session.expiresAt) {
      this.sessions.delete(token);
      return null;
    }

    // Refresh Session
    session.expiresAt = Date.now() + this.sessionTtlMs;
    return session;
  }

  // ==========================================================================
  // GRUPPENVERWALTUNG (RBAC)
  // ==========================================================================

  getGroups() {
    return this.data.groups.map(g => ({
      ...g,
      userCount: this.data.users.filter(u => u.groupId === g.id).length
    }));
  }

  getGroupById(id) {
    return this.data.groups.find(g => g.id === id) || null;
  }

  createGroup({ id, name, description, permissions }) {
    if (!name || !name.trim()) {
      throw new Error("Ein Gruppenname ist erforderlich.");
    }

    const safeId = (id || name)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_-]/g, "_")
      .replace(/^_+|_+$/g, "");

    if (!safeId) {
      throw new Error("Ungültige Gruppen-ID.");
    }

    if (this.data.groups.some(g => g.id === safeId)) {
      throw new Error(`Eine Gruppe mit der ID '${safeId}' existiert bereits.`);
    }

    // Validiere Berechtigungen
    const validPermIds = new Set(AVAILABLE_PERMISSIONS.map(p => p.id));
    const cleanPerms = Array.isArray(permissions)
      ? permissions.filter(p => validPermIds.has(p))
      : ["view_overview", "view_ar"];

    const newGroup = {
      id: safeId,
      name: name.trim(),
      description: description ? description.trim() : "",
      permissions: cleanPerms,
      isSystem: false,
      createdAt: Date.now()
    };

    this.data.groups.push(newGroup);
    this.saveData();

    return newGroup;
  }

  updateGroup(id, updates = {}) {
    const group = this.getGroupById(id);
    if (!group) {
      throw new Error(`Gruppe '${id}' nicht gefunden.`);
    }

    if (updates.name && updates.name.trim()) {
      group.name = updates.name.trim();
    }
    if (typeof updates.description === "string") {
      group.description = updates.description.trim();
    }
    if (Array.isArray(updates.permissions)) {
      const validPermIds = new Set(AVAILABLE_PERMISSIONS.map(p => p.id));
      group.permissions = updates.permissions.filter(p => validPermIds.has(p));
    }

    group.updatedAt = Date.now();
    this.saveData();

    // Laufende Sessions aktualisieren, falls Gruppe geändert wurde
    for (const session of this.sessions.values()) {
      if (session.groupId === id) {
        session.groupName = group.name;
        session.permissions = group.permissions;
      }
    }

    return group;
  }

  deleteGroup(id) {
    const index = this.data.groups.findIndex(g => g.id === id);
    if (index === -1) {
      throw new Error(`Gruppe '${id}' existiert nicht.`);
    }

    const group = this.data.groups[index];
    if (group.isSystem) {
      throw new Error(`Systemgruppen ('${group.name}') können nicht gelöscht werden.`);
    }

    // Prüfe, ob noch Benutzer dieser Gruppe angehören
    const assignedUsers = this.data.users.filter(u => u.groupId === id);
    if (assignedUsers.length > 0) {
      throw new Error(`Gruppe kann nicht gelöscht werden, da ihr noch ${assignedUsers.length} Benutzer zugewiesen sind.`);
    }

    this.data.groups.splice(index, 1);
    this.saveData();
    return true;
  }

  // ==========================================================================
  // BENUTZERVERWALTUNG
  // ==========================================================================

  getUsers() {
    return this.data.users.map(u => {
      const group = this.getGroupById(u.groupId);
      return {
        id: u.id,
        username: u.username,
        name: u.name,
        groupId: u.groupId,
        groupName: group ? group.name : "Unbekannt",
        createdAt: u.createdAt
      };
    });
  }

  createUser({ username, password, name, groupId }) {
    if (!username || !username.trim()) {
      throw new Error("Benutzername ist erforderlich.");
    }
    if (!password || password.length < 6) {
      throw new Error("Das Passwort muss mindestens 6 Zeichen lang sein.");
    }

    const cleanUsername = username.trim().toLowerCase();
    if (this.data.users.some(u => u.username.toLowerCase() === cleanUsername)) {
      throw new Error(`Der Benutzername '${cleanUsername}' ist bereits vergeben.`);
    }

    const group = this.getGroupById(groupId) || this.getGroupById("viewer");
    const { hash, salt } = AuthManager.hashPassword(password);

    const newUser = {
      id: `usr-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
      username: cleanUsername,
      name: name ? name.trim() : username.trim(),
      groupId: group.id,
      passwordHash: hash,
      passwordSalt: salt,
      createdAt: Date.now()
    };

    this.data.users.push(newUser);
    this.saveData();

    return {
      id: newUser.id,
      username: newUser.username,
      name: newUser.name,
      groupId: newUser.groupId,
      groupName: group.name,
      createdAt: newUser.createdAt
    };
  }

  updateUser(id, updates = {}) {
    const user = this.data.users.find(u => u.id === id || u.username === id);
    if (!user) {
      throw new Error(`Benutzer '${id}' nicht gefunden.`);
    }

    if (updates.name && updates.name.trim()) {
      user.name = updates.name.trim();
    }
    if (updates.groupId) {
      const group = this.getGroupById(updates.groupId);
      if (!group) throw new Error(`Gruppe '${updates.groupId}' existiert nicht.`);
      user.groupId = group.id;
    }
    if (updates.password && updates.password.length >= 6) {
      const { hash, salt } = AuthManager.hashPassword(updates.password);
      user.passwordHash = hash;
      user.passwordSalt = salt;
    }

    user.updatedAt = Date.now();
    this.saveData();

    const group = this.getGroupById(user.groupId);
    return {
      id: user.id,
      username: user.username,
      name: user.name,
      groupId: user.groupId,
      groupName: group ? group.name : "Unbekannt"
    };
  }

  deleteUser(id) {
    const index = this.data.users.findIndex(u => u.id === id || u.username === id);
    if (index === -1) {
      throw new Error(`Benutzer '${id}' nicht gefunden.`);
    }

    const user = this.data.users[index];
    if (user.username === "admin") {
      throw new Error("Der Standard-Administrator 'admin' darf nicht gelöscht werden.");
    }

    this.data.users.splice(index, 1);
    this.saveData();
    return true;
  }
}
