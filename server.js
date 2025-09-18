/**
 * LUCID Lookup Service für artidomo
 * Einfache, robuste Lösung für Coolify
 */

import express from 'express';
import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
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
 * XML von LUCID API herunterladen und parsen
 */
async function downloadAndParseXML() {
  console.log('[LUCID] Starte Download der XML-Daten...');
  console.log('[LUCID] URL:', config.api_url);
  console.log('[LUCID] Token (erste 20 Zeichen):', config.zsvr_token.substring(0, 20) + '...');
  
  try {
    // Download XML mit Token
    console.log('[LUCID] Sende Anfrage an LUCID API...');
    const response = await axios({
      method: 'GET',
      url: config.api_url,
      params: {
        token: config.zsvr_token  // Token als URL-Parameter laut API-Doku!
      },
      headers: {
        'Accept': 'application/xml'
      },
      responseType: 'text',
      timeout: 300000, // 5 Minuten Timeout
      maxContentLength: 2000 * 1024 * 1024, // 2GB max - LUCID Datei ist sehr groß!
      maxBodyLength: 2000 * 1024 * 1024
    });

    console.log('[LUCID] Response Status:', response.status);
    console.log('[LUCID] Response Headers:', JSON.stringify(response.headers));
    console.log('[LUCID] Response Größe:', response.data.length, 'Bytes');
    console.log('[LUCID] Erste 500 Zeichen der Response:', response.data.substring(0, 500));

    // Parse XML mit fast-xml-parser (effizienter als xml2js)
    console.log('[LUCID] Starte XML Parsing...');
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '',
      textNodeName: 'value'
    });
    
    const result = parser.parse(response.data);
    console.log('[LUCID] XML geparst, prüfe Struktur...');
    console.log('[LUCID] Root Keys:', Object.keys(result || {}));
    
    // Finde die Produzenten im XML (Struktur kann variieren)
    let producers = [];

    // Debug: Zeige die XML-Struktur
    if (result?.Root?.ListOfProducers?.Producer) {
      console.log('[LUCID] Gefunden: Root.ListOfProducers.Producer');
      producers = Array.isArray(result.Root.ListOfProducers.Producer)
        ? result.Root.ListOfProducers.Producer
        : [result.Root.ListOfProducers.Producer];
    } else if (result?.producers?.producer) {
      console.log('[LUCID] Gefunden: result.producers.producer');
      producers = Array.isArray(result.producers.producer)
        ? result.producers.producer
        : [result.producers.producer];
    } else if (result?.RegisterExcerpt?.Producer) {
      console.log('[LUCID] Gefunden: result.RegisterExcerpt.Producer');
      producers = Array.isArray(result.RegisterExcerpt.Producer)
        ? result.RegisterExcerpt.Producer
        : [result.RegisterExcerpt.Producer];
    } else if (result?.Producers?.Producer) {
      console.log('[LUCID] Gefunden: result.Producers.Producer');
      producers = Array.isArray(result.Producers.Producer)
        ? result.Producers.Producer
        : [result.Producers.Producer];
    } else {
      console.log('[LUCID] WARNUNG: Keine bekannte Struktur gefunden!');
      console.log('[LUCID] Vollständige Struktur (erste Ebene):', JSON.stringify(result, null, 2).substring(0, 1000));
    }

    console.log(`[LUCID] ${producers.length} Produzenten gefunden`);
    if (producers.length > 0) {
      console.log('[LUCID] Beispiel Produzent:', JSON.stringify(producers[0], null, 2).substring(0, 500));
    }

    // In Map speichern für schnelle Lookups
    const dataMap = new Map();
    
    for (const producer of producers) {
      // Verschiedene Feldnamen unterstützen
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
    }

    console.log(`[LUCID] Map erstellt mit ${dataMap.size} Einträgen`);
    return dataMap;
  } catch (error) {
    console.error('[LUCID] FEHLER beim Download/Parsing!');
    console.error('[LUCID] Error Type:', error.constructor.name);
    console.error('[LUCID] Error Message:', error.message);
    if (error.response) {
      console.error('[LUCID] Response Status:', error.response.status);
      console.error('[LUCID] Response Headers:', error.response.headers);
      console.error('[LUCID] Response Data (erste 1000 Zeichen):', 
        error.response.data ? String(error.response.data).substring(0, 1000) : 'Keine Daten');
    }
    if (error.config) {
      console.error('[LUCID] Request Config:', {
        url: error.config.url,
        method: error.config.method,
        headers: error.config.headers
      });
    }
    throw error;
  }
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
 * LUCID Validierung
 */
app.get('/api/lucid/validate', async (req, res) => {
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

  try {
    await updateCache(true);
    res.json({ 
      ok: true, 
      message: 'Cache erfolgreich aktualisiert',
      entries: memoryCache.data.size 
    });
  } catch (error) {
    res.status(500).json({ 
      ok: false, 
      error: 'Cache Update fehlgeschlagen: ' + error.message 
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
  console.log('[START] LUCID Lookup Service startet... (Debug Version v2)');
  console.log(`[CONFIG] Cache TTL: ${config.cache_ttl_hours} Stunden`);
  console.log(`[CONFIG] API Key: ${config.internal_api_key ? 'Konfiguriert' : 'Nicht gesetzt'}`);
  console.log(`[CONFIG] LUCID API URL: ${config.api_url}`);

  // Versuche Cache von Disk zu laden
  const loadedFromDisk = await loadCacheFromDisk();
  
  // Wenn kein Cache oder zu alt, lade neu
  if (!loadedFromDisk) {
    console.log('[START] Initiales Laden der LUCID-Daten...');
    try {
      await updateCache(true);
    } catch (error) {
      console.error('[START] Initiales Laden fehlgeschlagen:', error.message);
      console.log('[START] Service startet trotzdem, Cache wird beim ersten Request geladen');
    }
  } else {
    // Prüfe ob Update nötig
    const hoursSinceUpdate = (Date.now() - memoryCache.lastUpdate) / (1000 * 60 * 60);
    if (hoursSinceUpdate >= config.cache_ttl_hours) {
      console.log(`[START] Cache veraltet (${hoursSinceUpdate.toFixed(1)}h), starte Update...`);
      updateCache(); // Async im Hintergrund
    }
  }

  // Cron Job für automatische Updates (täglich um 2:30 Uhr)
  cron.schedule('30 2 * * *', () => {
    console.log('[CRON] Automatisches Cache Update gestartet');
    updateCache(true);
  }, {
    timezone: 'Europe/Berlin'
  });

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