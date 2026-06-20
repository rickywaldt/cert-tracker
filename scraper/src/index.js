import { initDb, upsertPerson, upsertPersonNoSlug, upsertBadge,
  startScrapeRun, finishScrapeRun, pool } from './db.js';
import { scrapeITQTeam } from './itq.js';
import { resolveCredlySlugs, fetchAllBadges, withConcurrency } from './credly.js';

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

  // 2. Resolve Credly slugs + persist people + fetch badges
  const tasks = people.map(person => async () => {
    try {
      // Find all Credly slugs for this person (handles disambiguation suffixes
      // and duplicate accounts like ricky-waldt + ricky-waldt.f87f9886)
      const slugs = await resolveCredlySlugs(person.name);

      if (!slugs.length) {
        await upsertPersonNoSlug(person);
        return;
      }

      // Use the first (canonical) slug as the primary for the person record
      const primarySlug = slugs[0];
      const row = await upsertPerson({
        ...person,
        credly_slug: primarySlug,
        credly_found: true,
      });
      if (row?.inserted) stats.peopleNew++;
      if (!row) return;

      // Fetch badges from ALL found slugs (combines badges from duplicate accounts)
      let totalBadgesForPerson = 0;
      for (const slug of slugs) {
        try {
          const badges = await fetchAllBadges(slug);
          stats.badgesTotal += badges.length;
          totalBadgesForPerson += badges.length;
          for (const badge of badges) {
            const b = await upsertBadge(row.id, badge);
            if (b?.inserted) stats.badgesNew++;
          }
        } catch (err) {
          console.warn(`[scraper] ✗ ${person.name} (${slug}): ${err.message}`);
          stats.errors.push({ person: person.name, slug, error: err.message });
        }
      }

      const profileNote = slugs.length > 1 ? ` (${slugs.length} profiles: ${slugs.join(', ')})` : '';
      console.log(`[scraper] ✓ ${person.name} — ${totalBadgesForPerson} badges${profileNote}`);
    } catch (err) {
      console.warn(`[scraper] ✗ ${person.name}: ${err.message}`);
      stats.errors.push({ person: person.name, error: err.message });
    }
  });

  await withConcurrency(tasks, 5);
  await finishScrapeRun(runId, stats);

  console.log(
    `[scraper] Done. People: ${stats.peopleTotal} (${stats.peopleNew} new). ` +
    `Badges: ${stats.badgesTotal} (${stats.badgesNew} new). Errors: ${stats.errors.length}`
  );
  await pool.end();
}

run().catch(err => {
  console.error('[scraper] Fatal:', err);
  process.exit(1);
});
