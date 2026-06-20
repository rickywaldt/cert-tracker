// Scrapes all people from itq.eu/meet-our-team via the FacetWP API.
// Returns array of { name, department, office, country }

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

function stripTags(html) {
  return html.replace(/<[^>]+>/g, '').trim();
}

function parsePeople(html) {
  const people = [];

  // Split into individual employee card blocks
  const cardBlocks = html.split(/<article\b/i).slice(1);

  for (const block of cardBlocks) {
    const nameMatch = block.match(/class="[^"]*employee-card__name[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/);
    const officeMatch = block.match(/class="[^"]*employee-card__location[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/);
    const deptMatch  = block.match(/class="[^"]*employee-card__function[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/);

    if (!nameMatch) continue;

    const name = stripTags(nameMatch[1]);
    const office = officeMatch ? stripTags(officeMatch[1]) : null;
    const department = deptMatch ? stripTags(deptMatch[1]) : null;

    if (!name) continue;

    people.push({
      name,
      department,
      office,
      country: OFFICE_TO_COUNTRY[office] || null,
    });
  }

  return people;
}

export async function scrapeITQTeam() {
  const firstData = await fetchPage(1);
  const totalPages = firstData.settings?.pager?.total_pages || 1;

  console.log(`[itq] ${firstData.settings?.pager?.total_rows} people across ${totalPages} pages`);

  const pageNums = Array.from({ length: totalPages }, (_, i) => i + 1);
  const allData = await Promise.all(pageNums.map(fetchPage));

  const allPeople = [];
  for (const data of allData) {
    allPeople.push(...parsePeople(data.template));
  }

  return allPeople;
}
