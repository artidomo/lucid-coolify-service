# 📋 LUCID Coolify Service - Einfache Anleitung

## 🎯 Was macht dieser Service?
- Lädt 1x täglich die LUCID-Daten herunter (nachts um 2:30 Uhr)
- Speichert alles im Speicher für blitzschnelle Abfragen
- Blockiert NICHT mehr Ihr Hauptsystem!
- Antwortet in Millisekunden statt Minuten

## 📁 Dateien im Ordner
- `Dockerfile` - Sagt Coolify wie der Service gebaut wird
- `package.json` - Liste der benötigten Pakete
- `server.js` - Der eigentliche Service-Code
- `README.md` - Diese Anleitung

## 🚀 SCHRITT-FÜR-SCHRITT Anleitung für Coolify

### Schritt 1: GitHub Repository erstellen
1. Gehen Sie zu GitHub.com
2. Klicken Sie auf "New Repository" 
3. Name: `lucid-coolify-service`
4. Private Repository (wichtig!)
5. Repository erstellen

### Schritt 2: Dateien hochladen
1. Klicken Sie auf "Upload files"
2. Ziehen Sie alle 4 Dateien aus dem Ordner rein:
   - Dockerfile
   - package.json  
   - server.js
   - README.md
3. Commit Message: "Initial LUCID service"
4. "Commit changes" klicken

### Schritt 3: In Coolify einrichten
1. Coolify öffnen
2. "Create New" → "Application"
3. "GitHub" auswählen
4. Ihr Repository verbinden: `lucid-coolify-service`
5. Branch: `main`

### Schritt 4: Build-Einstellungen
- **Build Pack**: Dockerfile
- **Port**: 3000
- **Health Check Path**: /healthz

### Schritt 5: Umgebungsvariablen (WICHTIG!)
In Coolify → Application → Environment Variables:

```
ZSVR_TOKEN=DD05A5841ACCB874003B660CBB98DC6BF2D75A036F4DEA448793C3C962FEF3E7
INTERNAL_API_KEY=geheim123artidomo
CACHE_TTL_HOURS=24
CACHE_DIR=/data
TZ=Europe/Berlin
```

### Schritt 6: Speicher einrichten
1. In Coolify → Application → Storages
2. "Add Storage" klicken
3. **Mount Path**: `/data`
4. **Type**: Volume
5. Speichern

### Schritt 7: Deployment
1. "Deploy" Button klicken
2. Warten bis grün (ca. 2-3 Minuten)
3. Logs prüfen - sollte stehen:
   - "LUCID Lookup Service läuft auf Port 3000"

## 🧪 TESTEN

### Test 1: Health Check
Öffnen Sie im Browser:
```
https://ihre-coolify-domain.de/healthz
```

Sollte zeigen:
```json
{
  "ok": true,
  "cache": {
    "entries": 1234567
  }
}
```

### Test 2: LUCID prüfen
```
https://ihre-coolify-domain.de/api/lucid/validate?lucid=DE1234567890123
```

## 🔌 Mit Hauptsystem verbinden

Später müssen wir im Hauptsystem nur noch diese Zeile ändern:

**ALT (blockiert):**
```javascript
const result = await lucidSmartService.findProducerByNumber(lucidNumber);
```

**NEU (Coolify):**
```javascript
const response = await axios.get(
  'https://ihre-coolify-domain.de/api/lucid/validate',
  { params: { lucid: lucidNumber } }
);
const result = response.data.registered ? response.data.details : null;
```

## ❓ Häufige Probleme

### "502 Bad Gateway"
→ Service startet noch, 2-3 Minuten warten

### "Cache nicht verfügbar"
→ Erster Download läuft, kann 2-5 Minuten dauern

### "Unauthorized"
→ INTERNAL_API_KEY prüfen

## 📞 Support
Bei Problemen melden Sie sich gerne!

---
**WICHTIG**: Der Service läuft komplett unabhängig vom Hauptsystem. 
Selbst wenn Coolify mal ausfällt, funktioniert Ihr Portal weiter (nur ohne LUCID-Prüfung).