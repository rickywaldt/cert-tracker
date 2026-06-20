// Scrapes all people from itq.eu/meet-our-team via the FacetWP API.
// Returns array of { name, department, office, country }
// Strategy: fetch each office filter separately to associate names with offices.

const ITQ_URL = 'https://itq.eu/meet-our-team/';

const OFFICE_TO_COUNTRY = {
  'ITQ Netherlands (Beverwijk)':  'Netherlands',
  'ITQ Netherlands (Amersfoort)': 'Netherlands',
  'ITQ Nederland (Beverwijk)':    'Netherlands',
  'ITQ Germany':                  'Germany',
  'ITQ Belgium':                  'Belgium',
  'ITQ France':                   'France',
  'ITQ Luxembourg':               'Luxembourg',
  'ITQ Sweden':                   'Sweden',
  'ITQ Denmark':                  'Denmark',
};

const OFFICES = [
  { value: '6008',  label: 'ITQ Netherlands (Beverwijk)' },
  { value: '20312', label: 'ITQ Netherlands (Amersfoort)' },
  { value: '6011',  label: 'ITQ Germany' },
  { value: '6010',  label: 'ITQ Belgium' },
  { value: '14638', label: 'ITQ France' },
  { value: '14629', label: 'ITQ Luxembourg' },
  { value: '24805', label: 'ITQ Sweden' },
  { value: '24810', label: 'ITQ Denmark' },
  { value: '10762', label: 'ITQ Nederland (Beverwijk)' },
];

async function fetchOfficePage(officeValue, page) {
  const body = JSON.stringify({
    action: 'facetwp_refresh',
    data: {
      facets: { departments: [], offices: [officeValue], employees_load_more: [] },
      frozen_facets: {},
      http_params: { get: [], uri: 'meet-our-team', url_vars: [] },
      template: 'wp',
      extras: { sort: 'default' },
      soft_refresh: 0,
      is_bfcache: 0,
      first_load: page === 1 ? 1 : 0,
      paged: page,
    },
  });

  const res = await fetch(ITQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'ITQCertTracker/1.0' },
    body,
  });

  if (!res.ok) throw new Error(`FacetWP returned ${res.status} for office ${officeValue} page ${page}`);

  const data = await res.json();
  const html = data.template ?? '';
  const totalPages = data.settings?.pager?.total_pages ?? 1;

  if (!html) {
    console.warn(`[itq] Empty HTML for office ${officeValue} page ${page} — keys: ${Object.keys(data).join(', ')}`);
  }

  return { html, totalPages };
}

function extractNames(html) {
  const names = [];
  const re = /class="[^"]*employee-card__name[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/span>/g;
  for (const m of html.matchAll(re)) {
    const name = m[1].replace(/<[^>]+>/g, '').trim();
    if (name) names.push(name);
  }
  return names;
}

function extractFunctions(html) {
  const funcs = [];
  const re = /class="[^"]*employee-card__function[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/[^>]+>/g;
  for (const m of html.matchAll(re)) {
    const f = m[1].replace(/<[^>]+>/g, '').trim();
    funcs.push(f || null);
  }
  return funcs;
}

export async function scrapeITQTeam() {
  const peopleMap = new Map();

  for (const office of OFFICES) {
    const first = await fetchOfficePage(office.value, 1);
    const totalPages = first.totalPages;

    const restPages = totalPages > 1
      ? await Promise.all(
          Array.from({ length: totalPages - 1 }, (_, i) => fetchOfficePage(office.value, i + 2))
        )
      : [];

    for (const { html } of [first, ...restPages]) {
      const names = extractNames(html);
      const funcs = extractFunctions(html);

      for (let i = 0; i < names.length; i++) {
        const name = names[i];
        if (!peopleMap.has(name)) {
          peopleMap.set(name, {
            name,
            office: office.label,
            country: OFFICE_TO_COUNTRY[office.label] || null,
            department: funcs[i] || null,
          });
        }
      }
    }

    console.log(`[itq] ${office.label}: ${peopleMap.size} total so far`);
  }

  return Array.from(peopleMap.values());
}
