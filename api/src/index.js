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

// ── Basic Auth middleware ─────────────────────────────────────────────────────
app.use((req, res, next) => {
  const auth = req.headers.authorization || '';
  const [scheme, encoded] = auth.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString();
    const sep = decoded.indexOf(':');
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
const IMAGE_TTL = 24 * 60 * 60 * 1000;

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
    const buffer = Buffer.from(await r.arrayBuffer());
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
  const [countries, issuers, offices] = await Promise.all([
    pool.query(`SELECT DISTINCT country FROM people WHERE country IS NOT NULL AND credly_found = true ORDER BY country`),
    pool.query(`SELECT DISTINCT issuer FROM badges WHERE issuer IS NOT NULL ORDER BY issuer`),
    pool.query(`SELECT DISTINCT office FROM people WHERE office IS NOT NULL AND credly_found = true ORDER BY office`),
  ]);
  res.json({
    countries: countries.rows.map(r => r.country),
    issuers:   issuers.rows.map(r => r.issuer),
    offices:   offices.rows.map(r => r.office),
  });
});

// ── GET /api/people ───────────────────────────────────────────────────────────
app.get('/api/people', async (req, res) => {
  const { country } = req.query;
  const params = [];
  let countryClause = '';
  if (country) {
    params.push(country);
    countryClause = `AND p.country = $1`;
  }
  const result = await pool.query(`
    SELECT p.id, p.name, p.credly_slug, p.country, p.office, p.department,
           COUNT(b.id)::int AS badge_count
    FROM people p
    LEFT JOIN badges b ON b.person_id = p.id
    WHERE p.credly_found = true
    GROUP BY p.id
    HAVING COUNT(b.id) > 0
    ${countryClause}
    ORDER BY p.name
  `, params);
  res.json(result.rows);
});

// ── GET /api/badges ───────────────────────────────────────────────────────────
app.get('/api/badges', async (req, res) => {
  const { country, issuer, status, q, person_id, page = 1, per_page = 50 } = req.query;
  const perPage = Math.min(parseInt(per_page) || 50, 200);
  const offset  = (Math.max(parseInt(page) || 1, 1) - 1) * perPage;

  const conditions = ['p.credly_found = true'];
  const params = [];

  if (country) {
    params.push(country);
    conditions.push(`p.country = $${params.length}`);
  }
  if (issuer) {
    params.push(`%${issuer}%`);
    conditions.push(`b.issuer ILIKE $${params.length}`);
  }
  if (person_id) {
    params.push(parseInt(person_id));
    conditions.push(`p.id = $${params.length}`);
  }
  if (status === 'active') {
    conditions.push(`(b.expires_at IS NULL OR b.expires_at > now())`);
  } else if (status === 'expired') {
    conditions.push(`b.expires_at IS NOT NULL AND b.expires_at < now()`);
  } else if (status === 'expiring_soon') {
    conditions.push(`b.expires_at IS NOT NULL AND b.expires_at BETWEEN now() AND now() + interval '3 months'`);
  }
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
});

// ── GET /api/scrape-status ────────────────────────────────────────────────────
app.get('/api/scrape-status', async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM scrape_runs ORDER BY started_at DESC LIMIT 5'
  );
  res.json(result.rows);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[api] Listening on :${PORT}`));
