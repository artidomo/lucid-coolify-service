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

# Health Check
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/healthz', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Server starten
CMD ["node", "server.js"]