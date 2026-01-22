/**
 * LUCID Lookup Service für artidomo
 * Einfache, robuste Lösung für Coolify
 */

import express from 'express';
import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import XmlStream from 'xml-stream';
import cron from 'node-cron';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 3000;
const CACHE_DIR = process.env.CACHE_DIR || '/data';
const CACHE_FILE = path.join(CACHE_DIR, 'lucid-cache.json');

// Konfiguration aus Umgebungsvariablen
const config = {
  // Token MUSS als Umgebungsvariable gesetzt werden in Coolify
  zsvr_token: process.env.ZSVR_TOKEN || '',
  // API Key für interne Authentifizierung - MUSS in Coolify gesetzt werden
  internal_api_key: process.env.INTERNAL_API_KEY || '',
  cache_ttl_hours: parseInt(process.env.CACHE_TTL_HOURS || '24'),
  // Korrekte LUCID API URL - kann über Umgebungsvariable überschrieben werden
  api_url: process.env.LUCID_API_URL || 'https://registerabruf.verpackungsregister.org/v1/listofproducers'
};

// In-Memory Cache für schnelle Zugriffe
let memoryCache = {
  data: new Map(),
  lastUpdate: null,
  isLoading: false
};

// Middleware
app.use(cors());
app.use(express.json());

// Logging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

/**
 * XML von LUCID API herunterladen und parsen - STREAMING VERSION
 * Löst ERR_STRING_TOO_LONG für 568MB XML-Dateien
 */
async function downloadAndParseXML() {
  console.log('[LUCID] Starte STREAMING Download der XML-Daten...');
  console.log('[LUCID] URL:', config.api_url);
  console.log('[LUCID] Token (erste 20 Zeichen):', config.zsvr_token.substring(0, 20) + '...');

  return new Promise(async (resolve, reject) => {
    try {
      // Map für Produzenten-Daten
      const dataMap = new Map();
      let producerCount = 0;
      const startTime = Date.now();

      // Download XML mit Token - STREAMING!
      console.log('[LUCID] Sende Anfrage an LUCID API (Stream-Modus)...');
      const response = await axios({
        method: 'GET',
        url: config.api_url,
        params: {
          token: config.zsvr_token
        },
        headers: {
          'Accept': 'application/xml',
          'Accept-Encoding': 'identity' // Keine Kompression für Stream
        },
        responseType: 'stream', // ← KRITISCH: Stream statt Text!
        timeout: 600000, // 10 Minuten
        maxContentLength: Infinity, // Keine Limits für Stream
        maxBodyLength: Infinity
      });

      console.log('[LUCID] Stream gestartet, Status:', response.status);
      console.log('[LUCID] Content-Length:', response.headers['content-length'], 'Bytes');

      // XML Stream Parser erstellen
      const xml = new XmlStream(response.data);

      // Event für JEDES <Producer> Element (alle gängigen LUCID XML-Strukturen)
      // xml-stream unterstützt CSS-ähnliche Selektoren
      xml.collect('Producer'); // Sammelt alle Producer-Elemente
      xml.collect('producer'); // Alternative Schreibweise

      // Event wenn ein Producer-Element komplett ist
      xml.on('endElement: Producer', (producer) => {
        producerCount++;

        // Extrahiere Felder (verschiedene Feldnamen unterstützen)
        const regNum = producer.RegistrationNumber ||
                       producer.registrationNumber ||
                       producer.registration_number ||
                       producer.RegNr || '';

        if (regNum) {
          const normalized = regNum.trim().toUpperCase();
          dataMap.set(normalized, {
            registration_number: regNum,
            company_name: producer.ProducerName || producer.Name || producer.CompanyName || producer.name || '',
            vat_number: producer.VATNumber || producer.UstIdNr || producer.vat_number || '',
            tax_number: producer.TaxNumber || producer.Steuernummer || producer.tax_number || '',
            address: producer.Address || producer.address || '',
            city: producer.City || producer.city || '',
            postal_code: producer.PostalCode || producer.postal_code || ''
          });
        }

        // Progress-Log alle 10.000 Einträge
        if (producerCount % 10000 === 0) {
          const elapsed = Math.floor((Date.now() - startTime) / 1000);
          console.log(`[LUCID] Verarbeitet: ${producerCount.toLocaleString()} Produzenten... (${elapsed}s)`);
        }
      });

      // Alternative Schreibweise (lowercase)
      xml.on('endElement: producer', (producer) => {
        producerCount++;

        const regNum = producer.RegistrationNumber ||
                       producer.registrationNumber ||
                       producer.registration_number ||
                       producer.RegNr || '';

        if (regNum) {
          const normalized = regNum.trim().toUpperCase();
          dataMap.set(normalized, {
            registration_number: regNum,
            company_name: producer.ProducerName || producer.Name || producer.CompanyName || producer.name || '',
            vat_number: producer.VATNumber || producer.UstIdNr || producer.vat_number || '',
            tax_number: producer.TaxNumber || producer.Steuernummer || producer.tax_number || '',
            address: producer.Address || producer.address || '',
            city: producer.City || producer.city || '',
            postal_code: producer.PostalCode || producer.postal_code || ''
          });
        }

        if (producerCount % 10000 === 0) {
          const elapsed = Math.floor((Date.now() - startTime) / 1000);
          console.log(`[LUCID] Verarbeitet: ${producerCount.toLocaleString()} Produzenten... (${elapsed}s)`);
        }
      });

      // Stream Ende - Erfolg!
      xml.on('end', () => {
        const duration = Math.floor((Date.now() - startTime) / 1000);
        console.log(`[LUCID] ✅ Stream abgeschlossen! ${producerCount.toLocaleString()} Produzenten gefunden`);
        console.log(`[LUCID] Map erstellt mit ${dataMap.size.toLocaleString()} Einträgen`);
        console.log(`[LUCID] Gesamt-Dauer: ${duration} Sekunden (${Math.floor(duration / 60)}min ${duration % 60}s)`);

        if (dataMap.size > 0) {
          // Zeige ersten Eintrag als Beispiel
          const firstEntry = Array.from(dataMap.entries())[0];
          console.log('[LUCID] Beispiel-Eintrag:', JSON.stringify(firstEntry, null, 2).substring(0, 300));
        }

        resolve(dataMap);
      });

      // Fehler-Handling - XML Parse Fehler
      xml.on('error', (error) => {
        console.error('[LUCID] ❌ XML Parse Fehler:', error.message);
        console.error('[LUCID] Error Stack:', error.stack);
        reject(error);
      });

      // Fehler-Handling - HTTP Stream Fehler
      response.data.on('error', (error) => {
        console.error('[LUCID] ❌ HTTP Stream Fehler:', error.message);
        console.error('[LUCID] Error Code:', error.code);
        reject(error);
      });

    } catch (error) {
      console.error('[LUCID] ❌ FEHLER beim Download/Parsing!');
      console.error('[LUCID] Error Type:', error.constructor.name);
      console.error('[LUCID] Error Message:', error.message);

      if (error.response) {
        console.error('[LUCID] Response Status:', error.response.status);
        console.error('[LUCID] Response Status Text:', error.response.statusText);
        console.error('[LUCID] Response Headers:', JSON.stringify(error.response.headers));

        // Spezielle Behandlung für 429 Rate Limit
        if (error.response.status === 429) {
          console.error('[LUCID] 🔴 RATE LIMIT ERREICHT! API blockiert weitere Anfragen.');
          console.error('[LUCID] Retry-After Header:', error.response.headers['retry-after']);
        }
      }

      if (error.config) {
        console.error('[LUCID] Request URL:', error.config.url);
      }

      if (error.code) {
        console.error('[LUCID] Error Code:', error.code);
        if (error.code === 'ECONNABORTED') {
          console.error('[LUCID] ⏱️ TIMEOUT! Download hat zu lange gedauert.');
        }
        if (error.code === 'ENOTFOUND') {
          console.error('[LUCID] 🔍 DNS FEHLER! Server nicht gefunden.');
        }
      }

      reject(error);
    }
  });
}

/**
 * Cache aktualisieren
 */
async function updateCache(force = false) {
  // Prüfe ob Update nötig
  if (!force && memoryCache.lastUpdate) {
    const hoursSinceUpdate = (Date.now() - memoryCache.lastUpdate) / (1000 * 60 * 60);
    if (hoursSinceUpdate < config.cache_ttl_hours) {
      console.log(`[CACHE] Noch aktuell (${hoursSinceUpdate.toFixed(1)}h alt)`);
      return;
    }
  }

  // Verhindere parallele Updates
  if (memoryCache.isLoading) {
    console.log('[CACHE] Update läuft bereits...');
    return;
  }

  memoryCache.isLoading = true;

  try {
    // Warte 5 Sekunden vor Download (Rate Limit Schutz)
    console.log('[CACHE] ⏳ Warte 5 Sekunden (Rate Limit Schutz)...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Lade neue Daten
    const newData = await downloadAndParseXML();
    
    // Update Memory Cache
    memoryCache.data = newData;
    memoryCache.lastUpdate = Date.now();
    
    // Speichere auf Disk als Backup
    try {
      await fs.mkdir(CACHE_DIR, { recursive: true });
      
      const cacheData = {
        lastUpdate: memoryCache.lastUpdate,
        count: newData.size,
        data: Array.from(newData.entries())
      };
      
      await fs.writeFile(CACHE_FILE, JSON.stringify(cacheData), 'utf-8');
      console.log(`[CACHE] Auf Disk gespeichert: ${CACHE_FILE}`);
    } catch (diskError) {
      console.error('[CACHE] Disk-Speicherung fehlgeschlagen:', diskError.message);
      // Kein Abbruch - Memory Cache funktioniert trotzdem
    }
    
    console.log(`[CACHE] Update erfolgreich! ${newData.size} Einträge im Cache`);
  } catch (error) {
    console.error('[CACHE] Update fehlgeschlagen:', error.message);
    throw error;
  } finally {
    memoryCache.isLoading = false;
  }
}

/**
 * Cache von Disk laden (beim Start)
 */
async function loadCacheFromDisk() {
  try {
    const data = await fs.readFile(CACHE_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    
    memoryCache.data = new Map(parsed.data);
    memoryCache.lastUpdate = parsed.lastUpdate;
    
    console.log(`[CACHE] Von Disk geladen: ${memoryCache.data.size} Einträge`);
    return true;
  } catch (error) {
    console.log('[CACHE] Kein Cache auf Disk gefunden');
    return false;
  }
}

// === ROUTES ===

/**
 * Health Check
 */
app.get('/healthz', (req, res) => {
  const status = {
    ok: true,
    uptime: process.uptime(),
    cache: {
      entries: memoryCache.data.size,
      lastUpdate: memoryCache.lastUpdate,
      age: memoryCache.lastUpdate ? 
        Math.floor((Date.now() - memoryCache.lastUpdate) / 1000 / 60) + ' Minuten' : 
        'nie'
    }
  };
  res.json(status);
});

/**
 * LUCID Validierung - GESCHÜTZT mit API-Key
 */
app.get('/api/lucid/validate', async (req, res) => {
  // API-Key Authentifizierung
  const apiKey = req.headers['x-api-key'] || req.headers['authorization'];

  if (!config.internal_api_key) {
    console.error('[SECURITY] WARNUNG: INTERNAL_API_KEY nicht gesetzt!');
  }

  if (apiKey !== config.internal_api_key) {
    console.log('[SECURITY] Ungültiger API-Key Versuch');
    return res.status(401).json({
      ok: false,
      error: 'Unauthorized - Invalid API Key'
    });
  }

  const { lucid } = req.query;
  
  if (!lucid) {
    return res.status(400).json({ 
      ok: false, 
      error: 'LUCID-Nummer fehlt' 
    });
  }

  // Normalisiere die Nummer
  const normalized = lucid.trim().toUpperCase();
  
  // Stelle sicher dass Cache vorhanden
  if (memoryCache.data.size === 0) {
    console.log('[API] Cache leer, starte Update...');
    try {
      await updateCache(true);
    } catch (error) {
      return res.status(503).json({ 
        ok: false, 
        error: 'Cache nicht verfügbar, bitte später versuchen' 
      });
    }
  }

  // Suche im Cache
  const producer = memoryCache.data.get(normalized);
  
  if (producer) {
    return res.json({
      ok: true,
      registered: true,
      status: 'registered',
      lucid: lucid,
      company: producer.company_name,
      details: producer,
      checkedAt: new Date().toISOString(),
      cacheAge: memoryCache.lastUpdate ? 
        Math.floor((Date.now() - memoryCache.lastUpdate) / 1000 / 60) : 
        null
    });
  } else {
    return res.json({
      ok: true,
      registered: false,
      status: 'not_found',
      lucid: lucid,
      company: null,
      details: null,
      checkedAt: new Date().toISOString(),
      cacheAge: memoryCache.lastUpdate ? 
        Math.floor((Date.now() - memoryCache.lastUpdate) / 1000 / 60) : 
        null
    });
  }
});

/**
 * Manueller Cache Refresh (geschützt)
 */
app.post('/admin/refresh', async (req, res) => {
  // Prüfe API Key wenn konfiguriert
  if (config.internal_api_key) {
    const providedKey = req.headers['x-api-key'] || req.query.api_key;
    if (providedKey !== config.internal_api_key) {
      return res.status(401).json({
        ok: false,
        error: 'Ungültiger API Key'
      });
    }
  }

  // Sofort-Response damit Request nicht timeout
  res.json({
    ok: true,
    message: 'Cache-Update gestartet im Hintergrund. Prüfe /api/stats für Status.',
    currentEntries: memoryCache.data.size
  });

  // Starte Update im Hintergrund
  updateCache(true)
    .then(() => {
      console.log('[ADMIN] Cache-Update erfolgreich abgeschlossen');
    })
    .catch((error) => {
      console.error('[ADMIN] Cache-Update fehlgeschlagen:', error);
    });
});

/**
 * SOFORTIGER Cache Test - NUR FÜR TESTS!
 * Lädt die komplette 500MB XML OHNE Verzögerung
 *
 * ⚠️ WARNUNG: Sollte nach Tests entfernt werden!
 * ⚠️ Kann Rate-Limits auslösen wenn zu oft aufgerufen!
 */
app.post('/admin/test-load', async (req, res) => {
  // SICHERHEIT: Nur in Development-Umgebung ODER mit speziellem Test-Key
  const isTestEnvironment = process.env.NODE_ENV === 'development' ||
                           process.env.ENABLE_TEST_ENDPOINTS === 'true';

  if (!isTestEnvironment) {
    return res.status(404).json({
      ok: false,
      error: 'Endpoint nicht verfügbar in Produktion'
    });
  }

  // Prüfe API Key
  if (config.internal_api_key) {
    const providedKey = req.headers['x-api-key'] || req.query.api_key;
    if (providedKey !== config.internal_api_key) {
      return res.status(401).json({
        ok: false,
        error: 'Ungültiger API Key'
      });
    }
  }

  // Rate Limit Check - verhindere mehrfache Aufrufe
  const lastTestLoad = memoryCache.lastTestLoad || 0;
  const timeSinceLastTest = Date.now() - lastTestLoad;
  if (timeSinceLastTest < 300000) { // 5 Minuten Sperre
    return res.status(429).json({
      ok: false,
      error: `Rate Limit: Warte noch ${Math.ceil((300000 - timeSinceLastTest) / 1000)} Sekunden`,
      nextAllowedIn: Math.ceil((300000 - timeSinceLastTest) / 1000)
    });
  }
  memoryCache.lastTestLoad = Date.now();

  console.log('[TEST-LOAD] 🚀 SOFORTIGER TEST-DOWNLOAD GESTARTET!');
  console.log('[TEST-LOAD] Lade 500MB XML von LUCID...');

  // Response sofort senden
  res.json({
    ok: true,
    message: 'TEST-LOAD gestartet! Monitor mit: GET /api/stats',
    info: 'Dies lädt die ECHTE 500MB XML-Datei SOFORT ohne Verzögerung!'
  });

  // Überschreibe die 5-Sekunden Verzögerung für diesen Test
  try {
    const startTime = Date.now();
    console.log('[TEST-LOAD] Starte Download OHNE Verzögerung...');

    // Direkt die Download-Funktion aufrufen
    const newData = await downloadAndParseXML();

    const duration = Date.now() - startTime;
    console.log(`[TEST-LOAD] ✅ ERFOLG! ${newData.size} Einträge in ${(duration/1000).toFixed(1)}s geladen`);

    // Update Memory Cache
    memoryCache.data = newData;
    memoryCache.lastUpdate = Date.now();

    // Speichere auf Disk
    const cacheData = {
      lastUpdate: memoryCache.lastUpdate,
      count: newData.size,
      data: Array.from(newData.entries())
    };

    await fs.writeFile(CACHE_FILE, JSON.stringify(cacheData), 'utf-8');
    console.log('[TEST-LOAD] Cache auf Disk gespeichert');

  } catch (error) {
    console.error('[TEST-LOAD] ❌ FEHLER beim Test-Load:', error.message);
    if (error.response?.status === 429) {
      console.error('[TEST-LOAD] Rate Limit erreicht! Warte vor nächstem Versuch.');
    }
  }
});

/**
 * DEBUG: Teste LUCID API direkt
 */
app.get('/admin/test-api', async (req, res) => {
  // API Key Check
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (config.internal_api_key && apiKey !== config.internal_api_key) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  console.log('[DEBUG] Teste LUCID API direkt...');

  try {
    // Teste mit kleinerem Timeout und Header-Only Request
    const testResponse = await axios.head(config.api_url, {
      params: { token: config.zsvr_token },
      timeout: 10000
    });

    console.log('[DEBUG] HEAD Request erfolgreich');
    console.log('[DEBUG] Status:', testResponse.status);
    console.log('[DEBUG] Headers:', testResponse.headers);

    // Jetzt versuche ersten Teil zu laden
    const partialResponse = await axios.get(config.api_url, {
      params: { token: config.zsvr_token },
      headers: {
        'Accept': 'application/xml',
        'Range': 'bytes=0-10000' // Nur erste 10KB
      },
      timeout: 30000
    });

    res.json({
      ok: true,
      headStatus: testResponse.status,
      contentType: testResponse.headers['content-type'],
      contentLength: testResponse.headers['content-length'],
      serverHeaders: testResponse.headers,
      firstBytes: partialResponse.data.substring(0, 1000),
      apiUrl: config.api_url,
      tokenPresent: !!config.zsvr_token
    });

  } catch (error) {
    console.error('[DEBUG] API Test fehlgeschlagen:', error.message);

    res.status(500).json({
      ok: false,
      error: error.message,
      code: error.code,
      status: error.response?.status,
      statusText: error.response?.statusText,
      responseData: error.response?.data ? String(error.response.data).substring(0, 1000) : null,
      apiUrl: config.api_url,
      tokenPresent: !!config.zsvr_token,
      tokenLength: config.zsvr_token ? config.zsvr_token.length : 0
    });
  }
});

/**
 * Cache Statistiken
 */
app.get('/api/stats', (req, res) => {
  res.json({
    ok: true,
    cache: {
      entries: memoryCache.data.size,
      lastUpdate: memoryCache.lastUpdate,
      lastUpdateISO: memoryCache.lastUpdate ? 
        new Date(memoryCache.lastUpdate).toISOString() : 
        null,
      ageMinutes: memoryCache.lastUpdate ? 
        Math.floor((Date.now() - memoryCache.lastUpdate) / 1000 / 60) : 
        null,
      isLoading: memoryCache.isLoading
    },
    config: {
      cache_ttl_hours: config.cache_ttl_hours,
      api_key_required: !!config.internal_api_key
    }
  });
});

// === STARTUP ===

async function startServer() {
  console.log('[START] LUCID Lookup Service startet... (v4 - Stable)');
  console.log(`[CONFIG] Cache TTL: ${config.cache_ttl_hours} Stunden`);
  console.log(`[CONFIG] API Key: ${config.internal_api_key ? 'Konfiguriert' : 'Nicht gesetzt'}`);
  console.log(`[CONFIG] Node Heap: ${(process.memoryUsage().heapTotal / 1024 / 1024).toFixed(0)} MB`);

  // Erhöhe Node.js Memory Limit für 500 MB XML
  if (process.env.NODE_OPTIONS !== '--max-old-space-size=4096') {
    console.log('[CONFIG] ⚠️ Node Memory Limit niedrig - setze NODE_OPTIONS=--max-old-space-size=4096');
  }

  // Versuche Cache von Disk zu laden
  const loadedFromDisk = await loadCacheFromDisk();

  if (!loadedFromDisk) {
    console.log('[START] ⚠️ Kein Cache auf Disk gefunden');
    console.log('[START] ℹ️ Cache wird beim Cron-Job (2:30 Uhr) oder manuell geladen');
    console.log('[START] ℹ️ Service läuft trotzdem und antwortet mit "not_found" bis Cache geladen');
  } else {
    console.log(`[START] ✅ Cache von Disk geladen: ${memoryCache.data.size} Einträge`);
    const hoursSinceUpdate = (Date.now() - memoryCache.lastUpdate) / (1000 * 60 * 60);
    console.log(`[START] Cache-Alter: ${hoursSinceUpdate.toFixed(1)} Stunden`);

    // NUR wenn Cache SEHR alt ist (>48h), dann einmalig nachladen
    if (hoursSinceUpdate > 48) {
      console.log('[START] Cache älter als 48h - starte einmaliges Update in 30 Sekunden...');
      setTimeout(() => {
        updateCache(true).catch(err => {
          console.error('[START] Update fehlgeschlagen:', err.message);
        });
      }, 30000); // 30 Sekunden Verzögerung nach Start
    }
  }

  // Cron Job WIEDER AKTIVIERT - aber mit Sicherheitsmechanismen
  cron.schedule('30 2 * * *', async () => {
    console.log('[CRON] Automatisches Cache Update gestartet (2:30 Uhr)');

    // Prüfe ob nicht schon kürzlich aktualisiert
    if (memoryCache.lastUpdate) {
      const hoursSinceUpdate = (Date.now() - memoryCache.lastUpdate) / (1000 * 60 * 60);
      if (hoursSinceUpdate < 20) {
        console.log(`[CRON] Skip - Cache erst ${hoursSinceUpdate.toFixed(1)}h alt`);
        return;
      }
    }

    try {
      await updateCache(true);
      console.log('[CRON] Cache Update erfolgreich');
    } catch (error) {
      console.error('[CRON] Cache Update fehlgeschlagen:', error.message);
      // Kein Crash - Service läuft weiter mit altem Cache
    }
  }, {
    timezone: 'Europe/Berlin'
  });

  console.log('[CRON] ✅ Automatische Updates aktiviert (täglich 2:30 Uhr)');

  // Server starten
  app.listen(PORT, () => {
    console.log(`[START] ✅ LUCID Lookup Service läuft auf Port ${PORT}`);
    console.log(`[START] Health Check: http://localhost:${PORT}/healthz`);
    console.log(`[START] API Endpoint: http://localhost:${PORT}/api/lucid/validate?lucid=DE...`);
  });
}

// Start!
startServer().catch(err => {
  console.error('[FATAL] Service konnte nicht gestartet werden:', err);
  process.exit(1);
});