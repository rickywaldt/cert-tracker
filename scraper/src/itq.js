// Scrapes all people from itq.eu/meet-our-team via the FacetWP API.
// Returns array of { name, department, office, country }

const ITQ_URL = 'https://itq.eu/meet-our-team/';
const PER_PAGE = 42;

// Map Credly office labels → normalised country names
const OFFICE_TO_COUNTRY = {
  'ITQ Netherlands (Beverwijk)': 'Netherlands',
  'ITQ Netherlands (Amersfoort)': 'Netherlands',
  'ITQ Nederland (Beverwijk)': 'Netherlands',
  'ITQ Germany': 'Germany',
  'ITQ Belgium': 'Belgium',
  'ITQ France': 'France',
  'ITQ Luxembourg': 'Luxembourg',
  'ITQ Sweden': 'Sweden',
  'ITQ Denmark': 'Denmark',
};

async function fetchPage(page) {
  const body = JSON.stringify({
    action: 'facetwp_refresh',
    data: {
      facets: { departments: [], offices: [], employees_load_more: [] },
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

  if (!res.ok) throw new Error(`FacetWP returned ${res.status} for page ${page}`);
  return res.json();
}

function parsePeople(html) {
  // Minimal HTML parsing without a DOM — extract employee card data via regex
  const people = [];
  // Match each employee card block
  const cardRe = /<div[^>]+class="[^"]*employee-card[^"]*"[^>]*>([\s\S]*?)<\/article>/g;
  // Simpler: find all name/function/data-department/data-office attributes
  const nameRe = /<[^>]+class="[^"]*employee-card__name[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/[^>]+>/g;
  const funcRe = /<[^>]+class="[^"]*employee-card__function[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/[^>]+>/g;
  const deptRe = /data-department="([^"]*)"/g;
  const officeRe = /data-office="([^"]*)"/g;

  const names = [...html.matchAll(nameRe)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
  const funcs = [...html.matchAll(funcRe)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
  const depts = [...html.matchAll(deptRe)].map(m => m[1]);
  const offices = [...html.matchAll(officeRe)].map(m => m[1]);

  for (let i = 0; i < names.length; i++) {
    if (!names[i] || names[i] === 'Bertwin' || names[i] === 'Q9') continue;
    people.push({
      name: names[i],
      department: depts[i] || null,
      office: offices[i] || null,
      country: OFFICE_TO_COUNTRY[offices[i]] || null,
    });
  }
  return people;
}

export async function scrapeITQTeam() {
  // Get first page to find total pages
  const firstData = await fetchPage(1);
  const totalPages = firstData.settings?.pager?.total_pages || 1;

  console.log(`[itq] ${firstData.settings?.pager?.total_rows} people across ${totalPages} pages`);

  // Fetch remaining pages in parallel (concurrency 3 to be polite)
  const pageNums = Array.from({ length: totalPages }, (_, i) => i + 1);
  const allData = await Promise.all(pageNums.map(fetchPage));

  const allPeople = [];
  for (const data of allData) {
    allPeople.push(...parsePeople(data.template));
  }

  return allPeople;
}
