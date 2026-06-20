// ── Config ────────────────────────────────────────────────────────────────────
const API      = '';
const PER_PAGE = 48;

// ── State ─────────────────────────────────────────────────────────────────────
let currentPage    = 1;
let totalResults   = 0;
let selectedPerson = null; // { id, name }
let allPeople      = [];
let searchTimer;
let personTimer;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const grid        = document.getElementById('grid');
const loading     = document.getElementById('loading');
const errorEl     = document.getElementById('error');
const countEl     = document.getElementById('result-count');
const paginationEl= document.getElementById('pagination');
const scrapeInfo  = document.getElementById('scrape-info');

const fCountry    = document.getElementById('f-country');
const fIssuer     = document.getElementById('f-issuer');
const fStatus     = document.getElementById('f-status');
const fQ          = document.getElementById('f-q');
const fPerson     = document.getElementById('f-person');
const suggestions = document.getElementById('f-person-suggestions');
const clearBtn    = document.getElementById('clear-btn');

// ── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  await Promise.all([loadMeta(), loadPeople(), loadScrapeInfo()]);
  await loadBadges();
}

// ── Load filter options ───────────────────────────────────────────────────────
async function loadMeta() {
  try {
    const res = await fetch(`${API}/api/meta`);
    if (!res.ok) return;
    const { countries, issuers } = await res.json();
    countries.forEach(c => fCountry.add(new Option(c, c)));
    issuers.forEach(i => fIssuer.add(new Option(i, i)));
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
  if (fCountry.value)        params.set('country',   fCountry.value);
  if (fIssuer.value)         params.set('issuer',    fIssuer.value);
  if (fStatus.value)         params.set('status',    fStatus.value);
  if (fQ.value.trim())       params.set('q',         fQ.value.trim());
  if (selectedPerson)        params.set('person_id', selectedPerson.id);
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
  const card      = document.createElement('div');
  card.className  = 'card';
  const status    = badgeStatus(b.expires_at);
  const imageUrl  = b.image_url
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
  const exp        = new Date(expiresAt);
  const now        = new Date();
  const threeMonths= new Date(); threeMonths.setMonth(threeMonths.getMonth() + 3);
  if (exp < now)         return { cls: 'expired', label: 'Expired' };
  if (exp < threeMonths) return { cls: 'soon',    label: 'Expiring soon' };
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
    const li = document.createElement('li');
    // Highlight the matching part
    const idx  = p.name.toLowerCase().indexOf(q.toLowerCase());
    const pre  = escapeHTML(p.name.slice(0, idx));
    const match= escapeHTML(p.name.slice(idx, idx + q.length));
    const post = escapeHTML(p.name.slice(idx + q.length));
    li.innerHTML = `${pre}<strong>${match}</strong>${post}`;

    li.addEventListener('mousedown', e => {
      e.preventDefault(); // keep focus on input until we're done
      selectedPerson  = p;
      fPerson.value   = p.name;
      suggestions.classList.remove('open');
      loadBadges(1);
    });
    suggestions.appendChild(li);
  });

  suggestions.classList.add('open');
}

fPerson.addEventListener('input', () => {
  // If user clears the input, clear the person filter
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
  // Small delay so the mousedown on a suggestion fires first
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

// ── Filter event listeners ────────────────────────────────────────────────────
[fCountry, fIssuer, fStatus].forEach(el =>
  el.addEventListener('change', () => loadBadges(1))
);

fQ.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadBadges(1), 400);
});

clearBtn.addEventListener('click', () => {
  fCountry.value = '';
  fIssuer.value  = '';
  fStatus.value  = '';
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
