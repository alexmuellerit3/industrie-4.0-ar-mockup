#!/usr/bin/env bash
# ==============================================================================
# CPS-i40 Deployment Script für externe Server
# Automatisierte Installation und Inbetriebnahme via Docker Compose
# ==============================================================================

set -euo pipefail

CYAN='\033[0;36m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${CYAN}====================================================${NC}"
echo -e "${CYAN}   CPS-i40 Industrie 4.0 Server-Deployment          ${NC}"
echo -e "${CYAN}====================================================${NC}"

# 1. Voraussetzungen prüfen
echo -e "\n${YELLOW}[1/5] Prüfe Systemvoraussetzungen...${NC}"

if ! command -v docker &> /dev/null; then
    echo -e "${RED}FEHLER: Docker ist nicht installiert! Bitte installieren Sie Docker zuerst.${NC}"
    exit 1
fi

# Docker Compose Erkennung (v2 Plugin oder altes Binary)
if docker compose version &> /dev/null; then
    COMPOSE_CMD="docker compose"
elif command -v docker-compose &> /dev/null; then
    COMPOSE_CMD="docker-compose"
else
    echo -e "${RED}FEHLER: Docker Compose wurde nicht gefunden!${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Docker und Compose gefunden ($COMPOSE_CMD)${NC}"

# 2. Verzeichnisse vorbereiten
echo -e "\n${YELLOW}[2/5] Bereite Konfiguration vor...${NC}"
mkdir -p mosquitto
if [ ! -f "mosquitto/mosquitto.conf" ]; then
    echo -e "${RED}FEHLER: mosquitto/mosquitto.conf fehlt!${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Konfigurationsdateien vorhanden.${NC}"

# 3. Container bauen
echo -e "\n${YELLOW}[3/5] Erstelle Docker Images...${NC}"
$COMPOSE_CMD build --pull

# 4. Container im Hintergrund starten
echo -e "\n${YELLOW}[4/5] Starte Dienste (Backend + Mosquitto)...${NC}"
$COMPOSE_CMD up -d

# 5. Healthcheck abwarten
echo -e "\n${YELLOW}[5/5] Warte auf Server-Bereitschaft...${NC}"
MAX_RETRIES=15
COUNTER=0
HEALTHY=false

while [ $COUNTER -lt $MAX_RETRIES ]; do
    if curl -s http://localhost:3000/health | grep -q '"status":"ok"'; then
        HEALTHY=true
        break
    fi
    sleep 2
    COUNTER=$((COUNTER + 1))
    echo -n "."
done

echo ""

if [ "$HEALTHY" = true ]; then
    HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")
    echo -e "${GREEN}====================================================${NC}"
    echo -e "${GREEN}✓ Deployment erfolgreich abgeschlossen!            ${NC}"
    echo -e "${GREEN}====================================================${NC}"
    echo -e "Anlagen-Leitstand (ohne Marker): http://${HOST_IP}:3000/overview.html"
    echo -e "Mobile AR-Kameraansicht:         http://${HOST_IP}:3000/index.html"
    echo -e "REST API Endpunkt:               http://${HOST_IP}:3000/api/stations"
    echo -e "WebSocket Stream:                ws://${HOST_IP}:3000/ws/telemetry"
    echo -e "MQTT Broker:                     mqtt://${HOST_IP}:1883"
    echo -e "===================================================="
else
    echo -e "${RED}WARNUNG: Server antwortete nicht rechtzeitig auf /health.${NC}"
    echo -e "Prüfen Sie die Logs mit: $COMPOSE_CMD logs"
    exit 1
fi
