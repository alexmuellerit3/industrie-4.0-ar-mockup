# 06. Zeitreihen-Store & Aggregationen

> **Kernkomponente:** [`backend/keyvalue-store.js`](file:///root/bbk_cpr/backend/keyvalue-store.js)  
> **Konzept:** In-Memory Zeitreihen-Puffer mit striktem 5-Minuten-Gleitfenster (**TTL = 300.000 ms**)

---

## ⏱️ Funktionsweise des 5-Minuten Sliding Windows

Industrielle Fertigungsleitstände benötigen eine verlässliche Kurzzeithistorie, um Prozessschwankungen sofort zu erkennen, ohne Datenbanken mit gigantischen Datenmengen zu überlasten.

```
Zeitstempel (ms) ──────────►
[t - 300s]                    [t - 150s]                     [t (Jetzt)]
    │                              │                             │
    ├── Älteste Werte              ├── Kontinuierliche           └── Neueste Werte
    │   werden bei jedem           │   Messwertfolge                 werden hinten
    │   Push verworfen             │   (v1, v2, v3, isFault)         angefügt (push)
    ▼                              ▼                             ▼
 [PRUNED / SHIFT]             [HISTORIE]                    [STORE ENTRY]
```

### Die Pruning-Logik:
Da Messwerte chronologisch mit monoton wachsenden Zeitstempeln eintreffen, werden veraltete Datensätze effizient von der Spitze der Liste entfernt:

```javascript
pruneStation(stationId, now = Date.now()) {
  const list = this.series.get(stationId);
  if (!list) return;

  const cutoff = now - this.ttlMs; // 300.000 ms = 5 Minuten
  while (list.length > 0 && list[0].timestamp < cutoff) {
    list.shift(); // O(1) Bereinigung
  }
}
```

---

## 🔄 Automatische Verdrängung von Demo-Daten

Ein häufiges Problem bei Industrie-Demonstratoren ist, dass beim Starten Demodaten vorgeladen werden, die sich mit echten SPS-Werten vermischen. Der [`KeyValueStore`](file:///root/bbk_cpr/backend/keyvalue-store.js) löst dies intelligent:

* Jeder Eintrag wird mit Flags markiert: `isLive: boolean` und `isDemo: boolean`.
* Trifft das erste echte Paket von Node-RED (`isLive: true`) ein, filtert die Methode `push()` alle vorherigen Demo-Einträge sofort aus der Zeitreihe:
  ```javascript
  if (isLiveSample) {
    const filtered = list.filter(item => !item.isDemo && !item.simulated);
    if (filtered.length !== list.length) {
      list = filtered;
      this.series.set(stationId, list);
    }
  }
  ```
* Das garantiert, dass die Diagramme im Leitstand und in der AR-App ausschließlich verifizierte Live-Sensordaten anzeigen!

---

## 📊 Statistische Berechnungen & Trendanalyse

Über die Methode `getSummary(stationId)` berechnet der Store laufend:

### 1. Minimal-, Maximal- und Durchschnittswert
$$\text{avg} = \frac{1}{N} \sum_{i=1}^{N} v_i, \quad \text{min} = \min_{1 \le i \le N} v_i, \quad \text{max} = \max_{1 \le i \le N} v_i$$

### 2. Quartils-Trendanalyse
Zur robusten Trendbestimmung wird die Historie in vier Quartile unterteilt. Der Durchschnitt des ersten Quartils ($Q_1$) wird mit dem des letzten Quartils ($Q_4$) verglichen:
$$\Delta Q = \bar{Q}_4 - \bar{Q}_1$$
* **`up` (↗):** $\Delta Q > 0.05$ (steigender Trend)
* **`down` (↘):** $\Delta Q < -0.05$ (fallender Trend)
* **`stable` (→):** $-0.05 \le \Delta Q \le 0.05$ (stabiler Prozess)

### 3. Störungsquote
$$\text{Störrate (\%)} = \left( \frac{\text{Anzahl Datensätze mit isFault = true}}{\text{Gesamtzahl Datensätze}} \right) \times 100$$

---

## ⚡ Performance- & Speichereffizienz

* **Speicherbedarf:** Ein Sample belegt im Speicher ca. 80 Bytes. Bei einem 1-Sekunden-Takt über 5 Minuten fallen pro Station maximal 300 Punkte an. Für alle 4 Stationen benötigt der Store weniger als **100 Kilobytes RAM**!
* **Garbage Collection:** Durch das kontinuierliche Prunen kleiner Batches entstehen keine GC-Spikes in Node.js.
