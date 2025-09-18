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
  zsvr_token: process.env.ZSVR_TOKEN || 'DD05A5841ACCB874003B660CBB98DC6BF2D75A036F4DEA448793C3C962FEF3E7',
  internal_api_key: process.env.INTERNAL_API_KEY || '',
  cache_ttl_hours: parseInt(process.env.CACHE_TTL_HOURS || '24'),
  api_url: 'https://lucid.verpackungsregister.org/api/v1/public-register/download'
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
  
  try {
    // Download XML mit Token
    const response = await axios({
      method: 'GET',
      url: config.api_url,
      headers: {
        'Authorization': `Bearer ${config.zsvr_token}`,
        'Accept': 'application/xml'
      },
      responseType: 'text',
      timeout: 300000, // 5 Minuten Timeout
      maxContentLength: 500 * 1024 * 1024, // 500MB max
      maxBodyLength: 500 * 1024 * 1024
    });

    console.log('[LUCID] XML heruntergeladen, starte Parsing...');

    // Parse XML mit fast-xml-parser (effizienter als xml2js)
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '',
      textNodeName: 'value'
    });
    
    const result = parser.parse(response.data);
    
    // Finde die Produzenten im XML (Struktur kann variieren)
    let producers = [];
    
    // Verschiedene mögliche Strukturen prüfen
    if (result?.producers?.producer) {
      producers = Array.isArray(result.producers.producer) 
        ? result.producers.producer 
        : [result.producers.producer];
    } else if (result?.RegisterExcerpt?.Producer) {
      producers = Array.isArray(result.RegisterExcerpt.Producer)
        ? result.RegisterExcerpt.Producer
        : [result.RegisterExcerpt.Producer];
    } else if (result?.Producers?.Producer) {
      producers = Array.isArray(result.Producers.Producer)
        ? result.Producers.Producer
        : [result.Producers.Producer];
    }

    console.log(`[LUCID] ${producers.length} Produzenten gefunden`);

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
          company_name: producer.Name || producer.CompanyName || producer.name || producer.company_name || '',
          vat_number: producer.VATNumber || producer.UstIdNr || producer.vat_number || '',
          tax_number: producer.TaxNumber || producer.Steuernummer || producer.tax_number || '',
          address: producer.Address || producer.address || '',
          city: producer.City || producer.city || '',
          postal_code: producer.PostalCode || producer.postal_code || ''
        });
      }
    }

    return dataMap;
  } catch (error) {
    console.error('[LUCID] Fehler beim Download/Parsing:', error.message);
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
  console.log('[START] LUCID Lookup Service startet...');
  console.log(`[CONFIG] Cache TTL: ${config.cache_ttl_hours} Stunden`);
  console.log(`[CONFIG] API Key: ${config.internal_api_key ? 'Konfiguriert' : 'Nicht gesetzt'}`);

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