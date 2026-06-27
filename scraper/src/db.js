import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function initDb() {
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
      id            SERIAL PRIMARY KEY,
      person_id     INTEGER REFERENCES people(id) ON DELETE CASCADE,
      credly_id     TEXT UNIQUE,
      name          TEXT,
      issuer        TEXT,
      issued_at     DATE,
      expires_at    DATE,
      badge_url     TEXT,
      image_url     TEXT,
      description   TEXT,
      type_category TEXT,
      level         TEXT,
      created_at    TIMESTAMPTZ DEFAULT now(),
      updated_at    TIMESTAMPTZ DEFAULT now()
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

    CREATE INDEX IF NOT EXISTS idx_badges_person_id    ON badges(person_id);
    CREATE INDEX IF NOT EXISTS idx_badges_issuer       ON badges(issuer);
    CREATE INDEX IF NOT EXISTS idx_badges_expires      ON badges(expires_at);
    CREATE INDEX IF NOT EXISTS idx_badges_type_category ON badges(type_category);
    CREATE INDEX IF NOT EXISTS idx_people_country      ON people(country);
  `);
}

export async function upsertPerson(p) {
  const res = await pool.query(`
    INSERT INTO people (name, department, office, country, credly_slug, credly_found, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, now())
    ON CONFLICT (credly_slug) DO UPDATE SET
      name         = EXCLUDED.name,
      department   = EXCLUDED.department,
      office       = EXCLUDED.office,
      country      = EXCLUDED.country,
      credly_found = EXCLUDED.credly_found,
      updated_at   = now()
    RETURNING id, (xmax = 0) AS inserted
  `, [p.name, p.department, p.office, p.country, p.credly_slug, p.credly_found]);
  return res.rows[0];
}

export async function upsertPersonNoSlug(p) {
  const res = await pool.query(`
    INSERT INTO people (name, department, office, country, credly_found, updated_at)
    VALUES ($1, $2, $3, $4, false, now())
    ON CONFLICT DO NOTHING
    RETURNING id
  `, [p.name, p.department, p.office, p.country]);
  if (res.rows[0]) return res.rows[0];
  const existing = await pool.query('SELECT id FROM people WHERE name = $1 LIMIT 1', [p.name]);
  return existing.rows[0];
}

export async function upsertBadge(personId, b) {
  const res = await pool.query(`
    INSERT INTO badges (
      person_id, credly_id, name, issuer, issued_at, expires_at,
      badge_url, image_url, description, type_category, level, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
    ON CONFLICT (credly_id) DO UPDATE SET
      name          = EXCLUDED.name,
      issuer        = EXCLUDED.issuer,
      issued_at     = EXCLUDED.issued_at,
      expires_at    = EXCLUDED.expires_at,
      badge_url     = EXCLUDED.badge_url,
      image_url     = EXCLUDED.image_url,
      description   = EXCLUDED.description,
      type_category = EXCLUDED.type_category,
      level         = EXCLUDED.level,
      updated_at    = now()
    RETURNING id, (xmax = 0) AS inserted
  `, [personId, b.credly_id, b.name, b.issuer, b.issued_at, b.expires_at,
      b.badge_url, b.image_url, b.description, b.type_category, b.level]);
  return res.rows[0];
}

export async function startScrapeRun() {
  const res = await pool.query('INSERT INTO scrape_runs DEFAULT VALUES RETURNING id');
  return res.rows[0].id;
}

export async function finishScrapeRun(id, stats) {
  await pool.query(`
    UPDATE scrape_runs SET finished_at = now(), people_total = $2, people_new = $3,
      badges_total = $4, badges_new = $5, errors = $6
    WHERE id = $1
  `, [id, stats.peopleTotal, stats.peopleNew, stats.badgesTotal, stats.badgesNew,
      JSON.stringify(stats.errors)]);
}

export { pool };
