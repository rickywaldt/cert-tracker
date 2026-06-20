import { initDb, upsertPerson, upsertPersonNoSlug, upsertBadge,
         startScrapeRun, finishScrapeRun, pool } from './db.js';
import { scrapeITQTeam } from './itq.js';
import { resolveCredlySlug, fetchAllBadges, withConcurrency } from './credly.js';

async function run() {
  console.log('[scraper] Starting...');
  await initDb();

  const runId = await startScrapeRun();
  const stats = { peopleTotal: 0, peopleNew: 0, badgesTotal: 0, badgesNew: 0, errors: [] };

  // 1. Scrape ITQ team page
  let people;
  try {
    people = await scrapeITQTeam();
    console.log(`[scraper] Found ${people.length} people on itq.eu`);
    stats.peopleTotal = people.length;
  } catch (err) {
    console.error('[scraper] Failed to scrape ITQ:', err.message);
    stats.errors.push({ phase: 'itq_scrape', error: err.message });
    await finishScrapeRun(runId, stats);
    process.exit(1);
  }

  // 2. Resolve Credly slugs + persist people
  const tasks = people.map(person => async () => {
    try {
      const slug = await resolveCredlySlug(person.name);
      const row = slug
        ? await upsertPerson({ ...person, credly_slug: slug, credly_found: true })
        : await upsertPersonNoSlug(person);

      if (row?.inserted) stats.peopleNew++;

      if (!slug || !row) return;

      // 3. Fetch all badges for this person
      const badges = await fetchAllBadges(slug);
      stats.badgesTotal += badges.length;

      for (const badge of badges) {
        const b = await upsertBadge(row.id, badge);
        if (b?.inserted) stats.badgesNew++;
      }

      console.log(`[scraper] ✓ ${person.name} — ${badges.length} badges`);
    } catch (err) {
      console.warn(`[scraper] ✗ ${person.name}: ${err.message}`);
      stats.errors.push({ person: person.name, error: err.message });
    }
  });

  await withConcurrency(tasks, 5);
  await finishScrapeRun(runId, stats);

  console.log(`[scraper] Done. People: ${stats.peopleTotal} (${stats.peopleNew} new). Badges: ${stats.badgesTotal} (${stats.badgesNew} new). Errors: ${stats.errors.length}`);
  await pool.end();
}

run().catch(err => {
  console.error('[scraper] Fatal:', err);
  process.exit(1);
});
