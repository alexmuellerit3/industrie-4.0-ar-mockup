/**
 * End-to-End Headless Browser Test für GitHub Pages Kompatibilität
 * Simuliert exakt das GitHub Pages Hosting unter:
 * https://alexmuellerit3.github.io/industrie-4.0-ar-mockup/overview.html
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const PORT = 8102;
const BASE_DIR = "/root/bbk_cpr";

// Statischer HTTP Server (simuliert GitHub Pages Static Host, keine /api Endpunkte)
const server = http.createServer((req, res) => {
  let reqPath = req.url.split("?")[0];
  if (reqPath.startsWith("/industrie-4.0-ar-mockup/")) {
    reqPath = reqPath.replace("/industrie-4.0-ar-mockup/", "/");
  }
  const filePath = path.join(BASE_DIR, reqPath === "/" ? "index.html" : reqPath);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    const ct = ext === ".html" ? "text/html; charset=utf-8"
             : ext === ".js"   ? "application/javascript; charset=utf-8"
             : ext === ".css"  ? "text/css; charset=utf-8"
             : ext === ".json" ? "application/json; charset=utf-8"
             : "application/octet-stream";
    res.writeHead(200, { "Content-Type": ct });
    res.end(fs.readFileSync(filePath));
  } else {
    res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<html><body>404 Not Found (GitHub Pages Static Host)</body></html>");
  }
});

server.listen(PORT, async () => {
  let browser = null;
  try {
    console.log(`[TEST] Starte Headless Chromium gegen http://alexmuellerit3.github.io:${PORT}...`);
    browser = await puppeteer.launch({
      executablePath: "/usr/bin/chromium",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        `--host-rules=MAP alexmuellerit3.github.io 127.0.0.1`
      ]
    });

    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", err => pageErrors.push(err.toString()));

    // 1. Initialer Seitenaufruf
    await page.goto(`http://alexmuellerit3.github.io:${PORT}/industrie-4.0-ar-mockup/overview.html`, { waitUntil: "domcontentloaded" });
    await new Promise(r => setTimeout(r, 600));

    const title = await page.title();
    console.log(`[1] Seitentitel: "${title}"`);
    if (!title.includes("SCADA")) throw new Error("Seitentitel ungültig");

    const initialCards = await page.$$eval(".heroui-station-card", els => els.length);
    console.log(`[1] Initiale Fertigungsmodule im SCADA Grid: ${initialCards}`);
    if (initialCards < 4) throw new Error(`Erwartete mindestens 4 Stationen, gefunden: ${initialCards}`);

    // 2. Störungssimulation & Quittierung
    const btnFaultText1 = await page.$eval("#btn-fault-ST-010", el => el.textContent);
    await page.click("#btn-fault-ST-010");
    await new Promise(r => setTimeout(r, 300));
    const btnFaultText2 = await page.$eval("#btn-fault-ST-010", el => el.textContent);
    console.log(`[2] Störungs-Button Toggle: "${btnFaultText1}" -> "${btnFaultText2}"`);
    if (!btnFaultText2.includes("quittieren")) throw new Error("Störung konnte nicht aktiviert werden");

    await page.click("#btn-fault-ST-010");
    await new Promise(r => setTimeout(r, 300));
    const btnFaultText3 = await page.$eval("#btn-fault-ST-010", el => el.textContent);
    console.log(`[2] Störungs-Button Rückkehr: "${btnFaultText3}"`);
    if (!btnFaultText3.includes("simulieren")) throw new Error("Störung konnte nicht quittiert werden");

    // 3. Raw JSON Inspektor (MQTT & WebSocket)
    await page.click("#tab-insp-mqtt");
    await new Promise(r => setTimeout(r, 200));
    await page.click("#btn-query-mqtt");
    await new Promise(r => setTimeout(r, 200));
    const mqttCode = await page.$eval("#code-insp-mqtt", el => el.textContent);
    console.log(`[3] MQTT-Abfrage ausgeführt (${mqttCode.length} Zeichen)`);
    if (!mqttCode.includes("vibration") && !mqttCode.includes("ST-")) throw new Error("MQTT-Paket ungültig");

    await page.click("#btn-create-mod-from-mqtt");
    await new Promise(r => setTimeout(r, 400));
    const cardsAfterMqtt = await page.$$eval(".heroui-station-card", els => els.length);
    console.log(`[3] Stationen nach Modul-Erstellung aus MQTT: ${cardsAfterMqtt}`);
    if (cardsAfterMqtt <= initialCards) throw new Error("Kein neues Modul aus MQTT erstellt");

    await page.click("#tab-insp-ws");
    await new Promise(r => setTimeout(r, 200));
    await page.click("#btn-create-mod-from-ws");
    await new Promise(r => setTimeout(r, 400));
    const cardsAfterWs = await page.$$eval(".heroui-station-card", els => els.length);
    console.log(`[3] Stationen nach Modul-Erstellung aus WS: ${cardsAfterWs}`);

    // 4. Modul Quick Edit Modal
    await page.click(".btn-quick-edit");
    await page.waitForSelector("#module-edit-modal-backdrop", { visible: true });
    await page.$eval("#mod-edit-name", el => el.value = "Modul 1: Ultra-Dosen-Zuführung");
    await page.$eval("#btn-save-mod-edit", el => el.click());
    await new Promise(r => setTimeout(r, 600));
    const titleUpdated = await page.$eval("#title-ST-010", el => el.textContent);
    console.log(`[4] Aktualisierter Modultitel im DOM: "${titleUpdated}"`);
    if (!titleUpdated.includes("Ultra-Dosen-Zuführung")) throw new Error("Titel wurde nicht aktualisiert");

    // 5. Konfigurationsmodal - Tab 1 Datenquellen & Verbindungen
    await page.click("#btn-open-config");
    await page.waitForSelector("#config-modal-backdrop", { visible: true });

    await page.click("#btn-test-ws");
    await new Promise(r => setTimeout(r, 400));
    const wsTest = await page.$eval("#ws-test-result", el => el.textContent);
    console.log(`[5] WebSocket Test-Rückmeldung: "${wsTest}"`);

    await page.$eval("#cfg-mqtt-url", el => el.value = "mqtt://broker.hivemq.com:1883");
    await page.click("#btn-test-mqtt");
    await new Promise(r => setTimeout(r, 400));
    const mqttTest = await page.$eval("#mqtt-test-result", el => el.textContent);
    console.log(`[5] MQTT Test-Rückmeldung: "${mqttTest}"`);

    await page.$eval("#cfg-mqtt-new-topic", el => el.value = "/bbk-lf/rpi04/my-sensor");
    await page.click("#btn-mqtt-sub-add");
    await new Promise(r => setTimeout(r, 200));
    const topics = await page.$$eval("#cfg-mqtt-topics-list span span", els => els.map(e => e.textContent));
    console.log(`[5] Abonnierte MQTT-Topics: ${JSON.stringify(topics)}`);
    if (!topics.includes("/bbk-lf/rpi04/my-sensor")) throw new Error("Topic wurde nicht abonniert");

    // 6. Konfigurationsmodal - Tab 2 Module & Demo-Daten Purge
    await page.click("[data-tab=\"pane-tab-stations\"]");
    await new Promise(r => setTimeout(r, 200));

    await page.click("#btn-clear-all-demo");
    await new Promise(r => setTimeout(r, 200));
    const clearText = await page.$eval("#btn-clear-all-demo", el => el.textContent);
    console.log(`[6] Demo-Daten verworfen Feedback: "${clearText}"`);

    await page.click("#btn-create-mod-from-live");
    await new Promise(r => setTimeout(r, 400));
    console.log("[6] Modul aus Live-Telemetrie in Tab 2 erstellt");

    // 7. Konfigurationsmodal - Tab 4 Benutzer & RBAC
    await page.click("#btn-open-config");
    await page.waitForSelector("#config-modal-backdrop", { visible: true });
    await page.click("[data-tab=\"pane-tab-auth\"]");
    await new Promise(r => setTimeout(r, 200));

    await page.click("#btn-tab-open-login");
    await page.waitForSelector("#auth-modal-backdrop", { visible: true });
    await page.$eval("#login-username", el => el.value = "admin");
    await page.$eval("#login-password", el => el.value = "admin123");
    await page.click("#btn-submit-login");
    await page.waitForSelector("#auth-modal-backdrop", { hidden: true });
    await new Promise(r => setTimeout(r, 300));

    const loggedInUser = await page.$eval("#auth-current-username", el => el.textContent);
    console.log(`[7] Angemeldeter Benutzer: "${loggedInUser}"`);
    if (!loggedInUser.includes("admin")) throw new Error("Login fehlgeschlagen");

    await page.$eval("#new-group-id", el => el.value = "instandhaltung");
    await page.$eval("#new-group-name", el => el.value = "Instandhaltungs-Team");
    await page.$eval("#new-group-desc", el => el.value = "Wartung und Störungsbehebung");
    await page.$eval("#btn-create-group", el => el.click());
    await new Promise(r => setTimeout(r, 400));
    const groupFeedback = await page.$eval("#new-group-feedback", el => el.textContent);
    console.log(`[7] Neue Gruppe angelegt: "${groupFeedback}"`);

    // 8. Konfigurationsmodal - Tab 5 JSON Interpreter
    await page.$eval("[data-tab=\"pane-tab-interpreter\"]", el => el.click());
    await new Promise(r => setTimeout(r, 200));
    await page.$eval(".interpreter-preset[data-preset=\"nested\"]", el => el.click());
    await page.$eval("#btn-interpret-json", el => el.click());
    await new Promise(r => setTimeout(r, 400));
    const interpName = await page.$eval("#interp-st-name", el => el.textContent);
    console.log(`[8] Interpretierter Modulname: "${interpName}"`);

    // 9. Speichern & Übernehmen
    await page.$eval("#btn-save-config", el => el.click());
    await new Promise(r => setTimeout(r, 500));
    const saveMsg = await page.$eval("#modal-feedback-msg", el => el.textContent);
    console.log(`[9] Konfiguration speichern: "${saveMsg}"`);

    await page.$eval("#btn-close-config", el => el.click());
    await new Promise(r => setTimeout(r, 400));

    const finalCards = await page.$$eval(".heroui-station-card", els => els.length);
    console.log(`[10] Finale Stationen im Leitstand: ${finalCards}`);

    // 11. Historische Störungs- & Ausfall-Datenbank (Incident Ledger)
    console.log("[11] Teste Historische Störungs- & Ausfall-Datenbank...");
    const incSection = await page.$("#incident-ledger-section");
    if (!incSection) throw new Error("Incident Ledger Section #incident-ledger-section nicht im DOM");

    const initialIncRows = await page.$$eval("#incident-table-tbody tr", els => els.length);
    console.log(`[11] Initiale historische Störungen: ${initialIncRows}`);
    if (initialIncRows < 3) throw new Error(`Erwartete mindestens 3 Störungseinträge, gefunden: ${initialIncRows}`);

    const incTotalText = await page.$eval("#inc-kpi-total", el => el.textContent);
    const incMttrText = await page.$eval("#inc-kpi-mttr", el => el.textContent);
    console.log(`[11] Incident KPIs: Total = ${incTotalText}, MTTR = ${incMttrText}`);

    // Störung manuell anlegen über Modal
    await page.$eval("#btn-open-manual-incident", el => el.click());
    await page.waitForSelector("#manual-incident-modal-backdrop", { visible: true });
    await page.$eval("#manual-inc-title", el => el.value = "Test-Notstopp: Druckluftabfall Hauptleitung");
    await page.$eval("#manual-inc-severity", el => el.value = "KRITISCH");
    await page.$eval("#manual-inc-operator", el => el.value = "IHK-Prüfling A. Müller");
    await page.$eval("#btn-save-manual-incident", el => el.click());
    await new Promise(r => setTimeout(r, 400));

    const activeBadge = await page.$eval("#inc-badge-active-count", el => el.textContent);
    console.log(`[11] Aktive Störungen Badge: "${activeBadge}"`);
    if (!activeBadge.includes("1 Aktiv") && !activeBadge.includes("Aktiv")) {
      throw new Error("Aktiver Vorfall wurde nicht registriert");
    }

    // Störung in der Tabelle als behoben markieren
    await page.$eval(".btn-inc-resolve", el => el.click());
    await new Promise(r => setTimeout(r, 300));
    const firstRowStatus = await page.$eval("#incident-table-tbody tr td:nth-child(7)", el => el.textContent);
    console.log(`[11] Störungs-Status nach Behebung: "${firstRowStatus}"`);
    if (!firstRowStatus.includes("Behoben")) {
      throw new Error("Störung konnte nicht behoben werden");
    }

    // CSV & JSON Download Handler Trigger
    await page.$eval("#btn-export-incidents-csv", el => el.click());
    await page.$eval("#btn-export-incidents-json", el => el.click());
    console.log("[11] CSV & JSON Export ausgelöst ohne Fehler");

    if (pageErrors.length > 0) {
      throw new Error(`Unerwartete Page-Errors aufgetreten: ${pageErrors.join(", ")}`);
    }

    console.log("\n=======================================================");
    console.log("✓ ALLE TESTS IM BROWSER AUF GITHUB PAGES ERFOLGREICH!");
    console.log("=======================================================\n");
  } finally {
    if (browser) await browser.close();
    server.close();
  }
});
