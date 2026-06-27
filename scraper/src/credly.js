// Resolves Credly slugs from names and fetches all badges per user.
const CREDLY_BASE = 'https://www.credly.com';

// Manual overrides for people whose slug can't be derived from their name.
const SLUG_OVERRIDES = {
  'davy van de laar':  ['davy-van-de-laar.906902d4'],
  'frank sengewald':   ['frank-sengewald.76d85ba8'],
  'andreas diemer':    ['andreas-diemer.ae4216a6'],
  'ricky waldt':       ['ricky-waldt', 'ricky-waldt.f87f9886'],
  'stijn vermoesen':   ['stijnvermoesen'],
};

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

export async function resolveCredlySlugs(name) {
  const normalisedName = name.toLowerCase().trim();

  if (SLUG_OVERRIDES[normalisedName]) {
    const confirmed = [];
    for (const slug of SLUG_OVERRIDES[normalisedName]) {
      if (await checkSlug(slug)) confirmed.push(slug);
    }
    if (confirmed.length) return confirmed;
  }

  const base     = nameToSlug(name);
  const noHyphen = base.replace(/-/g, '');
  const found    = [];

  if (await checkSlug(base))                          found.push(base);
  if (!found.length && await checkSlug(noHyphen))     found.push(noHyphen);

  return found;
}

export async function resolveCredlySlug(name) {
  const slugs = await resolveCredlySlugs(name);
  return slugs[0] || null;
}

async function fetchBadgePage(slug, page) {
  const url = `${CREDLY_BASE}/users/${slug}/badges?page=${page}&page_size=48&sort=most_popular`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'ITQCertTracker/1.0' },
  });
  if (!res.ok) throw new Error(`Credly badges returned ${res.status} for ${slug} page ${page}`);
  return res.json();
}

export async function fetchAllBadges(slug) {
  const first      = await fetchBadgePage(slug, 1);
  const total      = first.metadata?.total_count || 0;
  const perPage    = first.metadata?.per || 48;
  const totalPages = Math.ceil(total / perPage);
  const allBadges  = [...(first.data || [])];

  if (totalPages > 1) {
    const pages     = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
    const remaining = await Promise.all(pages.map(p => fetchBadgePage(slug, p)));
    for (const page of remaining) allBadges.push(...(page.data || []));
  }

  return allBadges.map(b => ({
    credly_id:     b.id,
    name:          b.badge_template?.name || b.name || 'Unknown',
    issuer:        b.issuer?.entities?.find(e => e.primary)?.entity?.name
                   || b.issuer?.entities?.[0]?.entity?.name
                   || null,
    issued_at:     b.issued_at ? b.issued_at.split('T')[0] : null,
    expires_at:    b.expires_at_date || null,
    badge_url:     b.badge_url || `${CREDLY_BASE}/badges/${b.id}`,
    image_url:     b.badge_template?.image_url || null,
    description:   b.badge_template?.description || null,
    type_category: b.badge_template?.type_category || null,
    level:         b.badge_template?.level || null,
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
