// Resolves Credly slugs from names and fetches all badges per user.
// Uses the same proxy approach as credly-scraper: direct HTTPS to credly.com.

const CREDLY_BASE = 'https://www.credly.com';

function nameToSlug(name) {
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/å/g, 'a')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-');
}

function slugVariants(name) {
  const base = nameToSlug(name);
  const noHyphen = base.replace(/-/g, '');
  return [base, noHyphen];
}

async function checkSlug(slug) {
  try {
    const res = await fetch(`${CREDLY_BASE}/users/${slug}`, {
      method: 'HEAD',
      headers: { 'User-Agent': 'ITQCertTracker/1.0' },
      redirect: 'manual',
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function resolveCredlySlug(name) {
  for (const variant of slugVariants(name)) {
    if (await checkSlug(variant)) return variant;
  }
  return null;
}

async function fetchBadgePage(slug, page) {
  const url = `${CREDLY_BASE}/users/${slug}/badges?page=${page}&page_size=48&sort=most_popular`;
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'ITQCertTracker/1.0',
    },
  });
  if (!res.ok) throw new Error(`Credly badges returned ${res.status} for ${slug} page ${page}`);
  return res.json();
}

export async function fetchAllBadges(slug) {
  const first = await fetchBadgePage(slug, 1);
  const total = first.metadata?.total_count || 0;
  const perPage = first.metadata?.per || 48;
  const totalPages = Math.ceil(total / perPage);

  const allBadges = [...(first.data || [])];

  if (totalPages > 1) {
    const pages = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
    const remaining = await Promise.all(pages.map(p => fetchBadgePage(slug, p)));
    for (const page of remaining) allBadges.push(...(page.data || []));
  }

  return allBadges.map(b => ({
    credly_id: b.id,
    name: b.badge_template?.name || b.name || 'Unknown',
    // issuer is at b.issuer.entities[].entity.name where primary === true
    issuer: b.issuer?.entities?.find(e => e.primary)?.entity?.name
          || b.issuer?.entities?.[0]?.entity?.name
          || null,
    issued_at: b.issued_at ? b.issued_at.split('T')[0] : null,
    expires_at: b.expires_at_date || null,
    badge_url: b.badge_url || `${CREDLY_BASE}/badges/${b.id}`,
    image_url: b.badge_template?.image_url || null,
    description: b.badge_template?.description || null,
  }));
}

export function withConcurrency(tasks, limit) {
  let i = 0;
  const results = new Array(tasks.length);
  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]();
    }
  }
  return Promise.all(Array.from({ length: limit }, worker)).then(() => results);
}
