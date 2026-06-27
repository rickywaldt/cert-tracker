// ── Config ────────────────────────────────────────────────────────────────────
const API     = '';
const PER_PAGE = 48;

// ── State ─────────────────────────────────────────────────────────────────────
let currentPage   = 1;
let totalResults  = 0;
let selectedPerson = null;
let allPeople     = [];
let searchTimer;
let personTimer;

// ── Multi-select state (country + issuer only) ────────────────────────────────
const selected = { country: new Set(), issuer: new Set() };

// ── DOM refs ──────────────────────────────────────────────────────────────────
const grid        = document.getElementById('grid');
const loading     = document.getElementById('loading');
const errorEl     = document.getElementById('error');
const countEl     = document.getElementById('result-count');
const paginationEl = document.getElementById('pagination');
const scrapeInfo  = document.getElementById('scrape-info');
const fQ          = document.getElementById('f-q');
const fStatus     = document.getElementById('f-status');
const fType       = document.getElementById('f-type');
const fPerson     = document.getElementById('f-person');
const suggestions = document.getElementById('f-person-suggestions');
const clearBtn    = document.getElementById('clear-btn');

// ── Multi-select component ────────────────────────────────────────────────────
function createMultiSelect(containerId, key, placeholder) {
  const container = document.getElementById(containerId);
  const trigger   = container.querySelector('.multiselect__trigger');
  const label     = container.querySelector('.multiselect__label');
  const panel     = container.querySelector('.multiselect__panel');

  function updateLabel() {
    const sel = selected[key];
    if (sel.size === 0) {
      label.textContent = placeholder;
      label.classList.remove('has-selection');
    } else {
      const values  = [...sel];
      const display = values.length <= 2
        ? values.join(', ')
        : `${values.slice(0, 2).join(', ')} +${values.length - 2}`;
      label.textContent = display;
      label.classList.add('has-selection');
    }
  }

  function open()   { panel.classList.add('is-open');    trigger.classList.add('is-active'); }
  function close()  { panel.classList.remove('is-open'); trigger.classList.remove('is-active'); }
  function toggle() { panel.classList.contains('is-open') ? close() : open(); }

  function addOption(value, optionLabel) {
    const div = document.createElement('div');
    div.className = 'multiselect__option';
    div.setAttribute('role', 'option');

    const cb    = document.createElement('input');
    cb.type     = 'checkbox';
    cb.value    = value;
    cb.id       = `${containerId}-${value}`;
    cb.checked  = selected[key].has(value);

    const lbl        = document.createElement('label');
    lbl.htmlFor      = cb.id;
    lbl.textContent  = optionLabel;
    lbl.style.cursor = 'pointer';
    lbl.style.flex   = '1';

    if (cb.checked) div.classList.add('is-checked');

    cb.addEventListener('change', () => {
      if (cb.checked) { selected[key].add(value);    div.classList.add('is-checked'); }
      else            { selected[key].delete(value);  div.classList.remove('is-checked'); }
      updateLabel();
      loadBadges(1);
    });

    div.appendChild(cb);
    div.appendChild(lbl);
    panel.appendChild(div);
  }

  function populate(options) {
    panel.innerHTML = '';
    options.forEach(({ value, label: optLabel }) => addOption(value, optLabel));
    updateLabel();
  }

  function reset() {
    selected[key].clear();
    panel.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.checked = false;
      cb.closest('.multiselect__option').classList.remove('is-checked');
    });
    updateLabel();
  }

  trigger.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  document.addEventListener('click', (e) => { if (!container.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  return { populate, reset, close };
}

const msCountry = createMultiSelect('ms-country', 'country', 'All countries');
const msIssuer  = createMultiSelect('ms-issuer',  'issuer',  'All issuers');

// ── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  await Promise.all([loadMeta(), loadPeople(), loadScrapeInfo()]);
  await loadBadges();
}

// ── Load filter options from /api/meta ────────────────────────────────────────
async function loadMeta() {
  try {
    const res = await fetch(`${API}/api/meta`);
    if (!res.ok) return;
    const { countries, issuers, type_categories } = await res.json();
    msCountry.populate(countries.map(c => ({ value: c, label: c })));
    msIssuer.populate(issuers.map(i => ({ value: i, label: i })));
    // Populate type dropdown dynamically
    fType.innerHTML = '<option value="">All types</option>';
    (type_categories || []).forEach(tc => {
      const opt = document.createElement('option');
      opt.value = tc;
      opt.textContent = tc;
      fType.appendChild(opt);
    });
  } catch (e) {
    console.warn('Could not load meta:', e.message);
  }
}

// ── Load all people for autocomplete ─────────────────────────────────────────
async function loadPeople() {
  try {
    const res = await fetch(`${API}/api/people`);
    if (!res.ok) return;
    allPeople = await res.json();
  } catch (e) {
    console.warn('Could not load people:', e.message);
  }
}

// ── Show last scrape time ─────────────────────────────────────────────────────
async function loadScrapeInfo() {
  try {
    const res = await fetch(`${API}/api/scrape-status`);
    if (!res.ok) return;
    const runs = await res.json();
    if (runs.length && runs[0].finished_at) {
      const d = new Date(runs[0].finished_at);
      scrapeInfo.textContent =
        `Last updated: ${d.toLocaleDateString()} ${d.toLocaleTimeString()} · ` +
        `${runs[0].people_total} people · ${runs[0].badges_total} badges`;
    }
  } catch { /* silent */ }
}

// ── Load badges ───────────────────────────────────────────────────────────────
async function loadBadges(page = 1) {
  currentPage = page;
  showLoading(true);
  errorEl.style.display = 'none';

  const params = new URLSearchParams();

  if (selected.country.size) params.set('country', [...selected.country].join(','));
  if (selected.issuer.size)  params.set('issuer',  [...selected.issuer].join(','));
  if (fStatus.value)         params.set('status',        fStatus.value);
  if (fType.value)           params.set('type_category', fType.value);
  if (fQ.value.trim())       params.set('q',             fQ.value.trim());
  if (selectedPerson)        params.set('person_id',     selectedPerson.id);
  params.set('page',     page);
  params.set('per_page', PER_PAGE);

  try {
    const res = await fetch(`${API}/api/badges?${params}`);
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    const { total, data } = await res.json();
    totalResults = total;
    renderBadges(data);
    renderResultsBar(total, page);
    renderPagination(total, page);
  } catch (e) {
    showError(`Failed to load badges: ${e.message}`);
  } finally {
    showLoading(false);
  }
}

// ── Render badge cards ────────────────────────────────────────────────────────
function renderBadges(badges) {
  grid.innerHTML = '';
  if (badges.length === 0) {
    grid.innerHTML = '<p style="grid-column:1/-1;color:#999;text-align:center;padding:3rem">No badges match the current filters.</p>';
    return;
  }
  badges.forEach(b => grid.appendChild(makeCard(b)));
}

function makeCard(b) {
  const card     = document.createElement('div');
  card.className = 'card';
  const status   = badgeStatus(b.expires_at);
  const imageUrl = b.image_url
    ? `${API}/api/image?url=${encodeURIComponent(b.image_url)}`
    : null;

  card.innerHTML = `
    <div class="card__image">
      ${imageUrl
        ? `<img src="${escapeAttr(imageUrl)}" alt="${escapeHTML(b.name)} badge" loading="lazy">`
        : '<span class="no-img">🏅</span>'}
    </div>
    <div class="card__body">
      <span class="badge-status badge-status--${status.cls}">${status.label}</span>
      ${b.type_category ? `<span class="badge-type">${escapeHTML(b.type_category)}</span>` : ''}
      <div class="card__name">${escapeHTML(b.name)}</div>
      <div class="card__issuer">${escapeHTML(b.issuer || '—')}</div>
      <div class="card__person">👤 ${escapeHTML(b.person_name)}${b.country ? ` · ${escapeHTML(b.country)}` : ''}</div>
      <div class="card__meta">
        Issued: ${formatDate(b.issued_at)}
        ${b.expires_at ? `· Expires: ${formatDate(b.expires_at)}` : ''}
      </div>
      <a class="card__link" href="${escapeAttr(b.badge_url)}" target="_blank" rel="noopener">View on Credly ↗</a>
    </div>
  `;
  return card;
}

function badgeStatus(expiresAt) {
  if (!expiresAt) return { cls: 'noexpiry', label: 'No expiry' };
  const exp        = new Date(expiresAt);
  const now        = new Date();
  const threeMonths = new Date(); threeMonths.setMonth(threeMonths.getMonth() + 3);
  if (exp < now)         return { cls: 'expired', label: '
