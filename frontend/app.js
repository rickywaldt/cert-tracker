// ── Config ────────────────────────────────────────────────────────────────────
const API      = '';
const PER_PAGE = 48;

// ── State ─────────────────────────────────────────────────────────────────────
let currentPage    = 1;
let totalResults   = 0;
let selectedPerson = null;
let allPeople      = [];
let searchTimer;
let personTimer;

// ── Multi-select state ────────────────────────────────────────────────────────
const selected = { country: new Set(), issuer: new Set(), status: new Set() };

// Static options for status (not from API)
const STATUS_OPTIONS = [
  { value: 'active',        label: 'Active' },
  { value: 'expired',       label: 'Expired' },
  { value: 'expiring_soon', label: 'Expiring within 3 months' },
];

// ── DOM refs ──────────────────────────────────────────────────────────────────
const grid         = document.getElementById('grid');
const loading      = document.getElementById('loading');
const errorEl      = document.getElementById('error');
const countEl      = document.getElementById('result-count');
const paginationEl = document.getElementById('pagination');
const scrapeInfo   = document.getElementById('scrape-info');
const fQ           = document.getElementById('f-q');
const fPerson      = document.getElementById('f-person');
const suggestions  = document.getElementById('f-person-suggestions');
const clearBtn     = document.getElementById('clear-btn');

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
      // Show selected values joined, truncated
      const values = [...sel];
      const display = values.length <= 2
        ? values.join(', ')
        : `${values.slice(0, 2).join(', ')} +${values.length - 2}`;
      label.textContent = display;
      label.classList.add('has-selection');
    }
  }

  function open() {
    panel.classList.add('is-open');
    trigger.classList.add('is-active');
  }

  function close() {
    panel.classList.remove('is-open');
    trigger.classList.remove('is-active');
  }

  function toggle() {
    panel.classList.contains('is-open') ? close() : open();
  }

  function addOption(value, optionLabel) {
    const div = document.createElement('div');
    div.className = 'multiselect__option';
    div.setAttribute('role', 'option');

    const cb = document.createElement('input');
    cb.type  = 'checkbox';
    cb.value = value;
    cb.id    = `${containerId}-${value}`;
    cb.checked = selected[key].has(value);

    const lbl = document.createElement('label');
    lbl.htmlFor    = cb.id;
    lbl.textContent = optionLabel;
    lbl.style.cursor = 'pointer';
    lbl.style.flex = '1';

    if (cb.checked) div.classList.add('is-checked');

    cb.addEventListener('change', () => {
      if (cb.checked) {
        selected[key].add(value);
        div.classList.add('is-checked');
      } else {
        selected[key].delete(value);
        div.classList.remove('is-checked');
      }
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

  // Toggle on trigger click
  trigger.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });

  // Close when clicking outside
  document.addEventListener('click', (e) => {
    if (!container.contains(e.target)) close();
  });

  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  return { populate, reset, close };
}

// Instantiate the three multi-selects
const msCountry = createMultiSelect('ms-country', 'country', 'All countries');
const msIssuer  = createMultiSelect('ms-issuer',  'issuer',  'All issuers');
const msStatus  = createMultiSelect('ms-status',  'status',  'All statuses');

// ── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  // Populate status options immediately (static)
  msStatus.populate(STATUS_OPTIONS);
  await Promise.all([loadMeta(), loadPeople(), loadScrapeInfo()]);
  await loadBadges();
}

// ── Load filter options from /api/meta ────────────────────────────────────────
async function loadMeta() {
  try {
    const res = await fetch(`${API}/api/meta`);
    if (!res.ok) return;
    const { countries, issuers } = await res.json();
    msCountry.populate(countries.map(c => ({ value: c, label: c })));
    msIssuer.populate(issuers.map(i => ({ value: i, label: i })));
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

  // Multi-select: pass comma-separated values
  if (selected.country.size) params.set('country', [...selected.country].join(','));
  if (selected.issuer.size)  params.set('issuer',  [...selected.issuer].join(','));
  if (selected.status.size)  params.set('status',  [...selected.status].join(','));

  if (fQ.value.trim())  params.set('q',         fQ.value.trim());
  if (selectedPerson)   params.set('person_id', selectedPerson.id);
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
  const exp         = new Date(expiresAt);
  const now         = new Date();
  const threeMonths = new Date(); threeMonths.setMonth(threeMonths.getMonth() + 3);
  if (exp < now)          return { cls: 'expired', label: 'Expired' };
  if (exp < threeMonths)  return { cls: 'soon',    label: 'Expiring soon' };
  return { cls: 'active', label: 'Active' };
}

// ── Results bar ───────────────────────────────────────────────────────────────
function renderResultsBar(total, page) {
  const from = (page - 1) * PER_PAGE + 1;
  const to   = Math.min(page * PER_PAGE, total);
  countEl.textContent = total === 0 ? 'No results' : `Showing ${from}–${to} of ${total} badges`;
}

// ── Pagination ────────────────────────────────────────────────────────────────
function renderPagination(total, page) {
  paginationEl.innerHTML = '';
  const totalPages = Math.ceil(total / PER_PAGE);
  if (totalPages <= 1) return;

  const prev = document.createElement('button');
  prev.textContent = '←';
  prev.disabled = page <= 1;
  prev.addEventListener('click', () => loadBadges(page - 1));
  paginationEl.appendChild(prev);

  pageRange(page, totalPages).forEach(p => {
    if (p === '…') {
      const span = document.createElement('span');
      span.textContent = '…';
      span.style.padding = '0 0.25rem';
      paginationEl.appendChild(span);
    } else {
      const btn = document.createElement('button');
      btn.textContent = p;
      if (p === page) btn.className = 'active';
      btn.addEventListener('click', () => loadBadges(p));
      paginationEl.appendChild(btn);
    }
  });

  const next = document.createElement('button');
  next.textContent = '→';
  next.disabled = page >= totalPages;
  next.addEventListener('click', () => loadBadges(page + 1));
  paginationEl.appendChild(next);
}

function pageRange(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = [1];
  if (current > 3) pages.push('…');
  for (let p = Math.max(2, current - 1); p <= Math.min(total - 1, current + 1); p++) pages.push(p);
  if (current < total - 2) pages.push('…');
  pages.push(total);
  return pages;
}

// ── Person autocomplete ───────────────────────────────────────────────────────
function showSuggestions(q) {
  suggestions.innerHTML = '';
  if (q.length < 2) { suggestions.classList.remove('open'); return; }

  const matches = allPeople
    .filter(p => p.name.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 10);

  if (!matches.length) { suggestions.classList.remove('open'); return; }

  matches.forEach(p => {
    const li   = document.createElement('li');
    const idx  = p.name.toLowerCase().indexOf(q.toLowerCase());
    const pre  = escapeHTML(p.name.slice(0, idx));
    const match= escapeHTML(p.name.slice(idx, idx + q.length));
    const post = escapeHTML(p.name.slice(idx + q.length));
    li.innerHTML = `${pre}<strong>${match}</strong>${post}`;

    li.addEventListener('mousedown', e => {
      e.preventDefault();
      selectedPerson = p;
      fPerson.value  = p.name;
      suggestions.classList.remove('open');
      loadBadges(1);
    });
    suggestions.appendChild(li);
  });

  suggestions.classList.add('open');
}

fPerson.addEventListener('input', () => {
  if (!fPerson.value.trim()) {
    selectedPerson = null;
    suggestions.classList.remove('open');
    loadBadges(1);
    return;
  }
  clearTimeout(personTimer);
  personTimer = setTimeout(() => showSuggestions(fPerson.value.trim()), 150);
});

fPerson.addEventListener('blur', () => {
  setTimeout(() => suggestions.classList.remove('open'), 160);
});

fPerson.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    selectedPerson = null;
    fPerson.value  = '';
    suggestions.classList.remove('open');
    loadBadges(1);
  }
});

// ── Keyword search ────────────────────────────────────────────────────────────
fQ.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadBadges(1), 400);
});

// ── Clear all filters ─────────────────────────────────────────────────────────
clearBtn.addEventListener('click', () => {
  msCountry.reset();
  msIssuer.reset();
  msStatus.reset();
  fQ.value       = '';
  fPerson.value  = '';
  selectedPerson = null;
  suggestions.classList.remove('open');
  loadBadges(1);
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function showLoading(on) { loading.style.display = on ? 'block' : 'none'; }
function showError(msg)  { errorEl.textContent = msg; errorEl.style.display = 'block'; }
function formatDate(d)   { return d ? new Date(d).toLocaleDateString() : '—'; }
function escapeHTML(s)   { return String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function escapeAttr(s)   { return escapeHTML(s); }

// ── Start ─────────────────────────────────────────────────────────────────────
boot();
