import express from 'express';
import crypto from 'crypto';
import pg from 'pg';
import fetch from 'node-fetch';

const { Pool } = pg;
const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const BASIC_USER = process.env.BASIC_AUTH_USER;
const BASIC_PASS = process.env.BASIC_AUTH_PASSWORD;

if (!BASIC_USER || !BASIC_PASS) {
  console.error('BASIC_AUTH_USER and BASIC_AUTH_PASSWORD are required');
  process.exit(1);
}

// ── Create tables if they don't exist ────────────────────────────────────────
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS people (
      id           SERIAL PRIMARY KEY,
      name         TEXT NOT NULL,
      department   TEXT,
      office       TEXT,
      country      TEXT,
      credly_slug  TEXT UNIQUE,
      credly_found BOOLEAN DEFAULT false,
      created_at   TIMESTAMPTZ DEFAULT now(),
      updated_at   TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS badges (
      id          SERIAL PRIMARY KEY,
      person_id   INTEGER REFERENCES people(id) ON DELETE CASCADE,
      credly_id   TEXT UNIQUE,
      name        TEXT,
      issuer      TEXT,
      issued_at   DATE,
      expires_at  DATE,
      badge_url   TEXT,
      image_url   TEXT,
      description TEXT,
      created_at  TIMESTAMPTZ DEFAULT now(),
      updated_at  TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS scrape_runs (
      id            SERIAL PRIMARY KEY,
      started_at    TIMESTAMPTZ DEFAULT now(),
      finished_at   TIMESTAMPTZ,
      people_total  INTEGER,
      people_new    INTEGER,
      badges_total  INTEGER,
      badges_new    INTEGER,
      errors        JSONB DEFAULT '[]'
    );

    CREATE INDEX IF NOT EXISTS idx_badges_person_id ON badges(person_id);
    CREATE INDEX IF NOT EXISTS idx_badges_issuer    ON badges(issuer);
    CREATE INDEX IF NOT EXISTS idx_badges_expires   ON badges(expires_at);
    CREATE INDEX IF NOT EXISTS idx_people_country   ON people(country);
  `);
  console.log('[api] Database ready');
}

// ── Basic Auth middleware ─────────────────────────────────────────────────────
app.use((req, res, next) => {
  const auth = req.headers.authorization || '';
  const [scheme, encoded] = auth.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString();
    const sep  = decoded.indexOf(':');
    const user = decoded.slice(0, sep);
    const pass = decoded.slice(sep + 1);
    const uBuf = Buffer.from(user), uExp = Buffer.from(BASIC_USER);
    const pBuf = Buffer.from(pass), pExp = Buffer.from(BASIC_PASS);
    if (uBuf.length === uExp.length && pBuf.length === pExp.length &&
        crypto.timingSafeEqual(uBuf, uExp) && crypto.timingSafeEqual(pBuf, pExp)) {
      return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="ITQ Cert Tracker"');
  return res.status(401).send('Authentication required.');
});

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Image proxy ───────────────────────────────────────────────────────────────
const imageCache = new Map();
const IMAGE_TTL  = 24 * 60 * 60 * 1000;

app.get('/api/image', async (req, res) => {
  const url = req.query.url;
  if (!url || !url.startsWith('https://images.credly.com/')) {
    return res.status(400).json({ error: 'Invalid image URL' });
  }
  const cached = imageCache.get(url);
  if (cached && Date.now() - cached.ts < IMAGE_TTL) {
    res.set('Content-Type', cached.contentType);
    res.set('X-Cache', 'HIT');
    return res.send(cached.buffer);
  }
  try {
    const r = await fetch(url);
    if (!r.ok) return res.status(r.status).end();
    const buffer      = Buffer.from(await r.arrayBuffer());
    const contentType = r.headers.get('content-type') || 'image/png';
    imageCache.set(url, { buffer, contentType, ts: Date.now() });
    res.set('Content-Type', contentType);
    res.set('X-Cache', 'MISS');
    res.send(buffer);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── GET /api/meta ─────────────────────────────────────────────────────────────
app.get('/api/meta', async (req, res) => {
  try {
    const [countries, issuers, offices] = await Promise.all([
      pool.query(`SELECT DISTINCT country FROM people WHERE country IS NOT NULL AND credly_found = true ORDER BY country`),
      pool.query(`SELECT DISTINCT issuer   FROM badges WHERE issuer IS NOT NULL ORDER BY issuer`),
      pool.query(`SELECT DISTINCT office   FROM people WHERE office  IS NOT NULL AND credly_found = true ORDER BY office`),
    ]);
    res.json({
      countries: countries.rows.map(r => r.country),
      issuers:   issuers.rows.map(r => r.issuer),
      offices:   offices.rows.map(r => r.office),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/people ───────────────────────────────────────────────────────────
app.get('/api/people', async (req, res) => {
  try {
    const { q } = req.query;
    let sql    = `SELECT id, name, credly_slug FROM people WHERE credly_found = true`;
    const params = [];
    if (q) {
      params.push(`%${q}%`);
      sql += ` AND name ILIKE $1`;
    }
    sql += ` ORDER BY name LIMIT 20`;
    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/badges ───────────────────────────────────────────────────────────
app.get('/api/badges', async (req, res) => {
  try {
    const {
      page      = 1,
      per_page  = 24,
      q,
      person_id,
      status,
    } = req.query;

    // multi-value params (can be comma-separated or repeated)
    const rawCountries = [req.query.country].flat().filter(Boolean)
      .flatMap(v => v.split(',').map(s => s.trim())).filter(Boolean);
    const rawIssuers = [req.query.issuer].flat().filter(Boolean)
      .flatMap(v => v.split(',').map(s => s.trim())).filter(Boolean);
    const rawStatuses = [status].flat().filter(Boolean)
      .flatMap(v => v.split(',').map(s => s.trim())).filter(Boolean);

    const perPage = Math.min(parseInt(per_page) || 24, 100);
    const offset  = (Math.max(parseInt(page) || 1, 1) - 1) * perPage;

    const conditions = ['p.credly_found = true'];
    const params     = [];

    // country: IN (exact match, case-sensitive as stored)
    if (rawCountries.length > 0) {
      const placeholders = rawCountries.map((c, i) => {
        params.push(c);
        return `$${params.length}`;
      });
      conditions.push(`p.country IN (${placeholders.join(', ')})`);
    }

    // issuer: ILIKE OR
    if (rawIssuers.length > 0) {
      const issuerClauses = rawIssuers.map(iss => {
        params.push(`%${iss}%`);
        return `b.issuer ILIKE $${params.length}`;
      });
      conditions.push(`(${issuerClauses.join(' OR ')})`);
    }

    // person
    if (person_id) {
      params.push(parseInt(person_id));
      conditions.push(`p.id = $${params.length}`);
    }

    // status (multi)
    if (rawStatuses.length > 0) {
      const statusClauses = rawStatuses.map(s => {
        if (s === 'active')        return `(b.expires_at IS NULL OR b.expires_at > now())`;
        if (s === 'expired')       return `(b.expires_at IS NOT NULL AND b.expires_at < now())`;
        if (s === 'expiring_soon') return `(b.expires_at IS NOT NULL AND b.expires_at BETWEEN now() AND now() + interval '3 months')`;
        return null;
      }).filter(Boolean);
      if (statusClauses.length > 0) conditions.push(`(${statusClauses.join(' OR ')})`);
    }

    // keyword search
    if (q) {
      params.push(`%${q}%`);
      const qi = params.length;
      conditions.push(`(b.name ILIKE $${qi} OR b.issuer ILIKE $${qi} OR b.description ILIKE $${qi})`);
    }

    const where = conditions.join(' AND ');

    const [dataRes, countRes] = await Promise.all([
      pool.query(`
        SELECT
          b.id, b.credly_id, b.name, b.issuer, b.issued_at, b.expires_at,
          b.badge_url, b.image_url, b.description,
          p.id AS person_id, p.name AS person_name, p.credly_slug,
          p.country, p.office, p.department
        FROM badges b
        JOIN people p ON p.id = b.person_id
        WHERE ${where}
        ORDER BY b.issued_at DESC NULLS LAST, p.name
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
      `, [...params, perPage, offset]),
      pool.query(`
        SELECT COUNT(*) FROM badges b JOIN people p ON p.id = b.person_id WHERE ${where}
      `, params),
    ]);

    res.json({
      total:    parseInt(countRes.rows[0].count),
      page:     parseInt(page),
      per_page: perPage,
      data:     dataRes.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/scrape-status ────────────────────────────────────────────────────
app.get('/api/scrape-status', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM scrape_runs ORDER BY started_at DESC LIMIT 5'
    );
    res.json(result.rows);
  } catch {
    // Table may not exist yet before first scraper run
    res.json([]);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDb()
  .then(() => app.listen(PORT, () => console.log(`[api] Listening on :${PORT}`)))
  .catch(err => { console.error('[api] DB init failed:', err); process.exit(1); });
