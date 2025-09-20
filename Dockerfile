FROM node:20-alpine

WORKDIR /app

# Kopiere package.json und installiere dependencies
COPY package.json ./
RUN npm install --production

# Kopiere den Server-Code
COPY server.js ./

# Erstelle Datenverzeichnis
RUN mkdir -p /data

# Port freigeben
EXPOSE 3000

# WICHTIG: Erhöhe Node.js Memory Limit für 500MB XML Verarbeitung
ENV NODE_OPTIONS="--max-old-space-size=4096"

# Health Check mit längeren Timeouts für große Downloads
# Start-Period: 60s gibt dem Service Zeit zum Laden
# Timeout: 30s für langsame Antworten während Download
HEALTHCHECK --interval=60s --timeout=30s --start-period=60s --retries=5 \
  CMD node -e "require('http').get('http://localhost:3000/healthz', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Server starten
CMD ["node", "server.js"]