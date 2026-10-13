# ==============================================================================
# Dockerfile für CPS-i40 Industrie 4.0 Telemetrie-Backend & WebApp
# ==============================================================================

FROM node:20-alpine AS production

LABEL maintainer="alexmuellerit3"
LABEL description="CPS-i40 Industrie 4.0 AR WebApp & IoT Backend mit MQTT, WebSockets & 5m KeyValueStore"

# Arbeitsverzeichnis
WORKDIR /app

# Dependencies installieren
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Anwendungscode kopieren
COPY backend/ ./backend/
COPY config/ ./config/
COPY css/ ./css/
COPY js/ ./js/
COPY tests/ ./tests/
COPY index.html ./
COPY overview.html ./

# Produktions-Umgebungsvariablen
ENV NODE_ENV=production
ENV PORT=80

# Port nach außen freigeben
EXPOSE 80 3000

# Healthcheck zur automatischen Überwachung durch Docker / Portainer / K8s
HEALTHCHECK --interval=20s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:80/health || wget -qO- http://localhost:3000/health || exit 1

# Startbefehl
CMD ["node", "backend/server.js"]
