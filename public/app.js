'use strict';

/* ---------------------------------------------------------------
   QA Test Scenario Tool — dashboard logic
   Products (Message / Email / Content)
     -> enhancements of that product
        -> test scenarios of that enhancement
---------------------------------------------------------------- */

const state = {
  products: [],
  product: null,        // selected product key
  enhancements: [],     // enhancements of the selected product
  enhancement: null,    // full enhancement (with scenarios) when open
  enhFilter: '',
  scenarioFilter: '',
  openTestCases: new Set(),   // scenario serial numbers whose test-case panel is open
  tcJob: null,                // the test-case run in progress, as the server reports it
  tcPoll: null,               // its polling timer
  documents: [],              // enhancement write-ups
  docFilter: '',
  enhancementDocs: [],        // documents linked to the open enhancement
  view: 'dashboard',          // dashboard | enhancements | scenarios | documents
  openDocs: new Set(),        // document ids expanded in the list
  docBodies: {},              // id -> full document (loaded on first expand)
  docTab: 'message',          // active product tab in Documents
  editingDoc: null,           // document whose edit row should start open
  docsNavOpen: false,         // Documents nav dropdown showing the products
  openHomeProduct: null,      // product key expanded on the dashboard
  homeEnhancements: {},       // product key -> its enhancements (loaded on first expand)
};

const el = (id) => document.getElementById(id);

const dom = {
  productList: el('productList'),
  crumbs: el('crumbs'),
  enhancementView: el('enhancementView'),
  enhancementList: el('enhancementList'),
  productTitle: el('productTitle'),
  productSub: el('productSub'),
  enhancementSearch: el('enhancementSearch'),
  scenarioView: el('scenarioView'),
  enhancementTitle: el('enhancementTitle'),

  scenarioHead: el('scenarioHead'),
  scenarioBody: el('scenarioBody'),
  scenarioFoot: el('scenarioFoot'),
  scenarioSearch: el('scenarioSearch'),
  exportBtn: el('exportBtn'),
  reuploadBtn: el('reuploadBtn'),
  modal: el('modal'),
  modalTitle: el('modalTitle'),
  modalProduct: el('modalProduct'),
  modalName: el('modalName'),
  modalDesc: el('modalDesc'),
  modalFile: el('modalFile'),
  modalMode: el('modalMode'),
  modalSplit: el('modalSplit'),
  modalError: el('modalError'),
  modalSubmit: el('modalSubmit'),
  productField: el('productField'),
  nameField: el('nameField'),
  descField: el('descField'),
  modeField: el('modeField'),
  uploadForm: el('uploadForm'),
  toast: el('toast'),
  addScenarioForm: el('addScenarioForm'),
  addScenarioText: el('addScenarioText'),
  addScenarioExtras: el('addScenarioExtras'),
  addScenarioBtn: el('addScenarioBtn'),
  documentsView: el('documentsView'),
  documentList: el('documentList'),
  documentSearch: el('documentSearch'),
  fileField: el('fileField'),
  docField: el('docField'),
  docFieldLabel: el('docFieldLabel'),
  splitField: el('splitField'),
  modalDoc: el('modalDoc'),
  modalHint: el('modalHint'),
  docLinkBtn: el('docLinkBtn'),
  fileFieldLabel: el('fileFieldLabel'),
  nameFieldLabel: el('nameFieldLabel'),
  docTabs: el('docTabs'),


};

/* ---------------- browser history ----------------
   Every view has an address, so the browser's back and forward arrows walk
   the same path the user clicked. Hash routes keep a reload working without
   the server needing to know about any of them. */

function routeToHash(route) {
  if (!route) return '#/';
  if (route.view === 'enhancements') return `#/product/${route.product}`;
  if (route.view === 'scenarios') return `#/enhancement/${route.id}`;
  if (route.view === 'documents') {
    if (route.expand) return `#/documents/${route.expand}`;
    if (route.product) return `#/documents/p/${route.product}`;
    return '#/documents';
  }
  return '#/';
}

function hashToRoute(hash) {
  const parts = String(hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'product' && parts[1]) return { view: 'enhancements', product: parts[1] };
  if (parts[0] === 'enhancement' && parts[1]) return { view: 'scenarios', id: parts[1] };
  if (parts[0] === 'documents') {
    if (parts[1] === 'p' && parts[2]) return { view: 'documents', product: parts[2] };
    return { view: 'documents', expand: parts[1] || null };
  }
  return { view: 'dashboard' };
}

/** Add a step to the history stack — or replace it, when it is where we already are. */
function pushRoute(route) {
  const hash = routeToHash(route);
  if (location.hash === hash) history.replaceState(route, '', hash);
  else history.pushState(route, '', hash);
}

/** Render what a route asks for. Never touches history: the caller owns that. */
async function applyRoute(route) {
  if (route.view === 'enhancements' && state.products.some((p) => p.key === route.product)) {
    return openProduct(route.product, { push: false });
  }
  if (route.view === 'scenarios') {
    const shown = await openEnhancement(route.id, { push: false });
    if (shown) return undefined;
  } else if (route.view === 'documents') {
    return openDocuments({ expand: route.expand, product: route.product, push: false });
  }
  return resetToDashboard({ push: false });
}

window.addEventListener('popstate', (event) => {
  applyRoute(event.state || hashToRoute(location.hash));
});

/* ---------------- helpers ---------------- */

async function api(url, options) {
  let res;
  try {
    res = await fetch(url, options);
  } catch (err) {
    /* fetch only rejects when the request never arrived: the server is down,
       or the machine is off the network. The browser's own wording for that
       is "Failed to fetch", which says nothing about what to do. */
    const offline = `The tool is not responding. It runs on this machine — check the server is still started, then try again.`;
    throw new Error(offline);
  }

  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  dom.toast.textContent = message;
  dom.toast.classList.toggle('error', isError);
  dom.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { dom.toast.hidden = true; }, 3800);
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function productLabel(key) {
  const p = state.products.find((item) => item.key === key);
  return p ? p.label : key;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/* ---------------- products (left panel) ---------------- */

async function loadProducts() {
  const { products, documentCount } = await api('/api/products');
  state.products = products;
  state.documentCount = documentCount || 0;
  renderProducts();
  fillProductSelect();
}

/** Two-letter monogram for the nav chip: "Data Sprawl" -> DS, "Email" -> EM. */
function monogram(label) {
  const words = String(label).trim().split(/\s+/);
  return (words.length > 1 ? words[0][0] + words[1][0] : String(label).slice(0, 2)).toUpperCase();
}

/** Each product carries its own accent, so the nav is scannable at a glance. */
const PRODUCT_TONE = { message: 'a', email: 'b', content: 'c', datasprawl: 'd', diy: 'e' };

function navItem({ label, blurb, count, active, onClick, muted, caret, tone }) {
  const li = document.createElement('li');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `product-item${active ? ' active' : ''}`;
  if (tone) btn.dataset.tone = tone;
  btn.innerHTML = `
    <span class="p-top">
      <span class="p-chip"></span>
      <span class="p-name">
        <strong></strong>
        <span class="pill"></span>
        <span class="p-caret"></span>
      </span>
    </span>
    <p class="p-blurb"></p>`;
  btn.querySelector('.p-chip').textContent = monogram(label);
  btn.querySelector('strong').textContent = label;
  const pill = btn.querySelector('.pill');
  pill.textContent = count;
  if (muted) pill.classList.add('ghost');
  const caretEl = btn.querySelector('.p-caret');
  caretEl.textContent = caret || '';
  caretEl.hidden = !caret;
  btn.querySelector('.p-blurb').textContent = blurb;

  btn.addEventListener('click', onClick);
  li.appendChild(btn);
  return li;
}

function renderProducts() {
  dom.productList.innerHTML = '';

  state.products.forEach((product) => {
    dom.productList.appendChild(navItem({
      label: product.label,
      blurb: product.blurb,
      count: product.enhancementCount,
      muted: !product.enhancementCount,
      active: state.product === product.key,
      tone: PRODUCT_TONE[product.key] || 'a',
      onClick: () => openProduct(product.key),
    }));
  });

  const divider = document.createElement('li');
  divider.className = 'nav-divider';
  dom.productList.appendChild(divider);

  dom.productList.appendChild(navItem({
    label: 'Documents',
    blurb: 'Write-ups and screenshots',
    count: state.documentCount || 0,
    muted: !state.documentCount,
    active: state.view === 'documents',
    caret: state.docsNavOpen ? '\u25be' : '\u25b8',
    tone: 'e',
    onClick: toggleDocsNav,
  }));

  if (state.docsNavOpen) dom.productList.appendChild(buildDocsNavProducts());
}


/* Documents is a dropdown: it opens onto the products, and picking one shows
   the documents uploaded against that product. */
function toggleDocsNav() {
  state.docsNavOpen = !state.docsNavOpen;
  renderProducts();
  if (state.docsNavOpen && state.view !== 'documents') openDocuments();
}

function buildDocsNavProducts() {
  const li = document.createElement('li');
  li.className = 'nav-sub';

  state.products.forEach((product) => {
    const on = state.view === 'documents' && state.docTab === product.key;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `nav-sub-item${on ? ' active' : ''}`;
    btn.innerHTML = '<span class="nav-sub-name"></span><span class="pill ghost"></span>';
    btn.querySelector('.nav-sub-name').textContent = product.label;
    btn.querySelector('.pill').textContent = product.documentCount || 0;
    btn.title = `Documents uploaded for ${product.label}`;
    btn.addEventListener('click', () => openDocuments({ product: product.key }));
    li.appendChild(btn);
  });

  return li;
}

function fillProductSelect() {
  dom.modalProduct.innerHTML = '';
  state.products.forEach((product) => {
    const option = document.createElement('option');
    option.value = product.key;
    option.textContent = product.label;
    dom.modalProduct.appendChild(option);
  });
}

/* ---------------- enhancement list ---------------- */

async function openProduct(key, { silent = false, push = true } = {}) {
  if (push) pushRoute({ view: 'enhancements', product: key });
  stopTestCasePolling();
  state.product = key;
  state.enhancement = null;
  state.view = 'enhancements';
  state.enhFilter = '';
  dom.enhancementSearch.value = '';
  renderProducts();

  hideAllViews();
  dom.enhancementView.hidden = false;
  dom.enhancementSearch.hidden = false;

  const product = state.products.find((p) => p.key === key);
  dom.productTitle.textContent = `${product.label} Migration Scenarios`;
  dom.productSub.textContent = 'Select an enhancement to view its test scenarios.';
  renderCrumbs();

  try {
    const { enhancements } = await api(`/api/products/${key}/enhancements`);
    state.enhancements = enhancements;
    renderEnhancements();
  } catch (err) {
    if (!silent) toast(err.message, true);
  }
}

function renderEnhancements() {
  const term = state.enhFilter.trim().toLowerCase();
  const items = term
    ? state.enhancements.filter((e) =>
        `${e.name} ${e.description} ${e.sourceFile}`.toLowerCase().includes(term))
    : state.enhancements;

  dom.enhancementList.innerHTML = '';

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    if (state.enhancements.length && term) {
      empty.innerHTML = '<h3>No Matches Found</h3><p>No enhancement matches your search.</p>';
    } else {
      empty.innerHTML = `<h3>No Enhancements Yet</h3>
        <p>Use <strong>+ New Enhancement</strong> on the left to create one and upload its test scenario file.</p>`;
    }
    dom.enhancementList.appendChild(empty);
    return;
  }

  items.forEach((enh) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'enh-card';
    /* The name and how many scenarios it holds are what anyone is choosing
       between here. The file it came from and when it was last touched are
       on the set's own page, where they are worth reading. */
    card.innerHTML = `
      <span>
        <p class="enh-name"></p>
      </span>
      <span class="enh-right">
        <span class="pill"></span>
        <span class="chev">&rsaquo;</span>
      </span>`;
    card.querySelector('.enh-name').textContent = enh.name;
    card.querySelector('.pill').textContent = plural(enh.scenarioCount, 'scenario');
    card.addEventListener('click', () => openEnhancement(enh.id));
    dom.enhancementList.appendChild(card);
  });
}

/* ---------------- scenario table ---------------- */

/** Stop following a run when the page moves on. */
function stopTestCasePolling() {
  if (state.tcPoll) clearTimeout(state.tcPoll);
  state.tcPoll = null;
  state.tcJob = null;
  const strip = document.getElementById('tcProgress');
  if (strip) strip.hidden = true;
}

async function openEnhancement(id, { push = true } = {}) {
  try {
    const { enhancement, documents } = await api(`/api/enhancements/${id}`);
    state.enhancement = enhancement;
    state.enhancementDocs = documents || [];
    state.product = enhancement.product;
    state.view = 'scenarios';
    state.scenarioFilter = '';
    state.openTestCases = new Set();
    dom.scenarioSearch.value = '';

    hideAllViews();
    dom.scenarioView.hidden = false;
    dom.enhancementTitle.textContent = enhancement.name;
    dom.exportBtn.href = `/api/enhancements/${enhancement.id}/export.csv`;

    const linked = state.enhancementDocs[0];
    dom.docLinkBtn.hidden = !linked;
    if (linked) dom.docLinkBtn.onclick = () => openDocuments({ expand: linked.id });

    renderProducts();
    renderCrumbs();
    renderScenarios();
    renderAddBoxExtras();
    if (push) pushRoute({ view: 'scenarios', id: enhancement.id });
    return true;
  } catch (err) {
    toast(err.message, true);
    return false;
  }
}

/* One input per extra column, so a manually added row can fill them too.
   Built here (not in renderScenarios) so searching never wipes what you typed. */
function renderAddBoxExtras() {
  dom.addScenarioExtras.innerHTML = '';
  (state.enhancement.extraColumns || []).forEach((col) => {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'input';
    input.placeholder = col;
    input.dataset.col = col;
    input.autocomplete = 'off';
    dom.addScenarioExtras.appendChild(input);
  });
}

async function addScenarioInTool(event) {
  event.preventDefault();
  const enh = state.enhancement;
  if (!enh) return;

  const text = dom.addScenarioText.value.trim();
  if (!text) {
    dom.addScenarioText.focus();
    toast('Enter the test scenario before adding it.', true);
    return;
  }

  const extra = {};
  dom.addScenarioExtras.querySelectorAll('input[data-col]').forEach((input) => {
    extra[input.dataset.col] = input.value;
  });

  dom.addScenarioBtn.disabled = true;
  try {
    const result = await api(`/api/enhancements/${enh.id}/scenario`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: text, extra }),
    });

    state.enhancement = result.enhancement;
    dom.addScenarioText.value = '';
    dom.addScenarioExtras.querySelectorAll('input[data-col]').forEach((input) => { input.value = ''; });

    // clear any active search so the newly added row is actually visible
    state.scenarioFilter = '';
    dom.scenarioSearch.value = '';
    renderScenarios();
    await loadProducts();
    toast(`Test scenario ${result.sno} added.`);
    dom.addScenarioText.focus();
  } catch (err) {
    toast(err.message, true);
  } finally {
    dom.addScenarioBtn.disabled = false;
  }
}

/* ---------------- icons ----------------
   Inline so they inherit the button's colour and need no extra request. */

const ICON = {
  download: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M8 1.6v7.2m0 0L5.2 6M8 8.8 10.8 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.4 10.8v1.6a2 2 0 0 0 2 2h7.2a2 2 0 0 0 2-2v-1.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
};

/** An icon-only button: the label lives in the tooltip and for screen readers. */
function iconButton(icon, label, className = '') {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `icon-btn-sq ${className}`.trim();
  btn.innerHTML = ICON[icon];
  btn.title = label;
  btn.setAttribute('aria-label', label);
  return btn;
}

/* ---------------- run status ----------------
   Scenarios written before the tool tracked results count as passed: they were
   run and signed off, the tool simply had nowhere to record it. A negative
   scenario is the exception — it describes the migration refusing something,
   so Fail is the outcome it is about. Both are only the starting value: the
   pill is clickable and a tester's own result stands. */

const STATUS_ORDER = ['pass', 'fail', 'pending'];
const STATUS_LABEL = { pass: 'Pass', fail: 'Fail', pending: 'Not run' };

function isNegative(scenario) {
  const extra = (scenario && scenario.extra) || {};
  const key = Object.keys(extra).find((k) => /^type$/i.test(k));
  return key ? /^(negative|neg)$/i.test(String(extra[key]).trim()) : false;
}

function scenarioStatus(scenario) {
  const value = scenario && scenario.status;
  if (STATUS_ORDER.includes(value)) return value;
  return isNegative(scenario) ? 'fail' : 'pass';
}

async function cycleScenarioStatus(sno, button) {
  const enh = state.enhancement;
  if (!enh) return;

  const scenario = enh.scenarios.find((s) => Number(s.sno) === Number(sno));
  if (!scenario) return;

  const next = STATUS_ORDER[(STATUS_ORDER.indexOf(scenarioStatus(scenario)) + 1) % STATUS_ORDER.length];
  button.disabled = true;
  try {
    const result = await api(`/api/enhancements/${enh.id}/scenarios/${sno}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: next }),
    });
    state.enhancement = result.enhancement;
    renderScenarios();
  } catch (err) {
    button.disabled = false;
    toast(err.message, true);
  }
}

/** The per-row Pass / Fail / Not run pill. Clicking it steps to the next one. */
function buildStatusPill(scenario) {
  const value = scenarioStatus(scenario);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `status-pill is-${value}`;
  btn.textContent = STATUS_LABEL[value];
  btn.title = `${STATUS_LABEL[value]} — click to change`;
  btn.addEventListener('click', () => cycleScenarioStatus(scenario.sno, btn));
  return btn;
}

/* The ACTION header carries a menu of the things that act on the whole table
   at once. The menu is fixed-positioned: .table-wrap scrolls, and an absolutely
   positioned menu would be clipped by it. */
function buildActionMenu() {
  const enh = state.enhancement;

  const wrap = document.createElement('span');
  wrap.className = 'bulk';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'bulk-btn';
  btn.textContent = 'Actions \u25be';
  btn.title = 'Actions for every scenario in this table';
  btn.setAttribute('aria-haspopup', 'true');
  btn.setAttribute('aria-expanded', 'false');
  wrap.appendChild(btn);

  const menu = document.createElement('div');
  menu.className = 'bulk-menu';
  menu.hidden = true;
  wrap.appendChild(menu);

  const item = (text, onClick) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'bulk-item';
    el.textContent = text;
    el.addEventListener('click', () => { closeActionMenu(); onClick(); });
    menu.appendChild(el);
    return el;
  };

  const total = enh.scenarios.length;
  const allOpen = Boolean(total) && state.openTestCases.size >= total;

  const expand = item('Expand all test cases', () => {
    state.openTestCases = new Set(enh.scenarios.map((s) => s.sno));
    renderScenarios();
  });
  expand.disabled = !total || allOpen;

  const collapse = item('Collapse all', () => {
    state.openTestCases.clear();
    renderScenarios();
  });
  collapse.disabled = !state.openTestCases.size;

  const missing = enh.scenarios.filter((s) => !(s.testCases && s.testCases.length)).length;
  const fill = item(
    missing ? `Generate test cases for ${plural(missing, 'scenario')}` : 'All scenarios have test cases',
    () => startTestCaseRun(enh.id, false)
  );
  fill.disabled = !missing || Boolean(state.tcJob && state.tcJob.state === 'running');

  const sep = document.createElement('div');
  sep.className = 'bulk-sep';
  menu.appendChild(sep);

  const csv = document.createElement('a');
  csv.className = 'bulk-item';
  csv.textContent = 'Export CSV';
  csv.href = `/api/enhancements/${enh.id}/export.csv`;
  csv.setAttribute('download', '');
  csv.addEventListener('click', () => closeActionMenu());
  menu.appendChild(csv);

  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    const wasClosed = menu.hidden;
    closeActionMenu();
    if (!wasClosed) return;

    const rect = btn.getBoundingClientRect();
    menu.style.top = `${Math.round(rect.bottom + 6)}px`;
    menu.style.right = `${Math.round(window.innerWidth - rect.right)}px`;
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  });

  return wrap;
}

function closeActionMenu() {
  document.querySelectorAll('.bulk-menu').forEach((m) => { m.hidden = true; });
  document.querySelectorAll('.bulk-btn').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}

function renderScenarios() {
  const enh = state.enhancement;
  if (!enh) return;

  const columns = ['S.No', 'Test Scenario', ...enh.extraColumns, 'Status'];
  dom.scenarioHead.innerHTML = '';
  const headRow = document.createElement('tr');
  columns.forEach((name, idx) => {
    const th = document.createElement('th');
    th.textContent = name;
    if (idx === 0) th.className = 'sno';
    headRow.appendChild(th);
  });
  const actHead = document.createElement('th');
  actHead.className = 'act';
  actHead.appendChild(buildActionMenu());
  headRow.appendChild(actHead);
  dom.scenarioHead.appendChild(headRow);

  const term = state.scenarioFilter.trim().toLowerCase();
  const rows = term
    ? enh.scenarios.filter((s) =>
        `${s.scenario} ${Object.values(s.extra || {}).join(' ')}`.toLowerCase().includes(term))
    : enh.scenarios;

  dom.scenarioBody.innerHTML = '';

  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = columns.length + 1; // + the Action column
    td.textContent = term ? 'No test scenario matches your search.' : 'No test scenarios have been uploaded yet.';
    tr.appendChild(td);
    dom.scenarioBody.appendChild(tr);
  }

  // Every scenario gets its own row, numbered sequentially.
  rows.forEach((scenario) => {
    const tr = document.createElement('tr');
    const sno = document.createElement('td');
    sno.className = 'sno';
    sno.textContent = scenario.sno;
    tr.appendChild(sno);

    const text = document.createElement('td');
    text.textContent = scenario.scenario;
    tr.appendChild(text);

    enh.extraColumns.forEach((col) => {
      const td = document.createElement('td');
      td.textContent = (scenario.extra || {})[col] || '';
      tr.appendChild(td);
    });

    const statusCell = document.createElement('td');
    statusCell.className = 'status-cell';
    statusCell.appendChild(buildStatusPill(scenario));
    tr.appendChild(statusCell);

    const act = document.createElement('td');
    act.className = 'act';

    const tcBtn = document.createElement('button');
    tcBtn.type = 'button';
    tcBtn.className = 'tc-btn';
    const open = state.openTestCases.has(scenario.sno);
    tcBtn.textContent = open ? 'Hide Test Cases' : 'View Test Cases';
    tcBtn.title = `Test cases for scenario ${scenario.sno}`;
    tcBtn.addEventListener('click', () => toggleTestCases(scenario.sno));
    act.appendChild(tcBtn);

    tr.appendChild(act);

    dom.scenarioBody.appendChild(tr);

    // Expanded detail row sits directly under its scenario, spanning the table.
    if (state.openTestCases.has(scenario.sno)) {
      dom.scenarioBody.appendChild(buildTestCaseRow(scenario, columns.length + 1));
    }
  });

  if (term) {
    dom.scenarioFoot.textContent = `Showing ${rows.length} of ${plural(enh.scenarios.length, 'test scenario')}`;
  } else if (!enh.scenarios.length) {
    dom.scenarioFoot.textContent = 'No test scenarios yet.';
  } else {
    dom.scenarioFoot.textContent = plural(enh.scenarios.length, 'test scenario');
  }
}

/* ---------------- test cases (Claude-generated) ---------------- */

const TC_COLUMNS = ['Test Case', 'Test Scenario', 'Preconditions', 'Test Steps', 'Expected Result'];

function toggleTestCases(sno) {
  if (state.openTestCases.has(sno)) state.openTestCases.delete(sno);
  else state.openTestCases.add(sno);
  renderScenarios();
}

function buildTestCaseRow(scenario, colSpan) {
  const tr = document.createElement('tr');
  tr.className = 'tc-row';
  const td = document.createElement('td');
  td.colSpan = colSpan;

  const panel = document.createElement('div');
  panel.className = 'tc-panel';

  const head = document.createElement('div');
  head.className = 'tc-head';
  const title = document.createElement('span');
  title.className = 'tc-title';
  title.textContent = `Test Cases for Test Scenario ${scenario.sno}`;
  head.appendChild(title);

  const meta = document.createElement('span');
  meta.className = 'tc-meta';
  head.appendChild(meta);

  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'btn btn-outline tc-action';
  head.appendChild(action);

  const body = document.createElement('div');
  body.className = 'tc-body';

  panel.appendChild(head);
  panel.appendChild(body);
  td.appendChild(panel);
  tr.appendChild(td);

  const cases = scenario.testCases || [];
  if (cases.length) {
    const info = scenario.testCasesMeta || {};
    meta.textContent = info.generatedAt ? `Generated ${formatDate(info.generatedAt)} · ${info.model || ''}` : '';
    action.textContent = 'Regenerate';
    action.addEventListener('click', () => runTestCases(scenario.sno, true, action, body));
    body.appendChild(renderTestCaseTable(cases));
  } else {
    meta.textContent = 'Not generated yet';
    action.textContent = 'Generate Test Cases';
    action.classList.add('btn-primary');
    action.classList.remove('btn-outline');
    action.addEventListener('click', () => runTestCases(scenario.sno, false, action, body));
    const hint = document.createElement('p');
    hint.className = 'tc-hint';
    hint.textContent =
      'Generates the test case, preconditions, steps and expected result.';
    body.appendChild(hint);
  }

  return tr;
}

function renderTestCaseTable(cases) {
  const wrap = document.createElement('div');
  wrap.className = 'tc-table-wrap';

  const table = document.createElement('table');
  table.className = 'tc-table';

  // fixed column proportions keep the five columns readable instead of cramped
  const colgroup = document.createElement('colgroup');
  ['c1', 'c2', 'c3', 'c4', 'c5'].forEach((cls) => {
    const col = document.createElement('col');
    col.className = cls;
    colgroup.appendChild(col);
  });
  table.appendChild(colgroup);

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  TC_COLUMNS.forEach((name) => {
    const th = document.createElement('th');
    th.textContent = name;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  cases.forEach((tc) => {
    const row = document.createElement('tr');

    const idCell = document.createElement('td');
    idCell.className = 'tc-id';
    const idText = document.createElement('strong');
    idText.textContent = tc.id || '';
    idCell.appendChild(idText);
    if (tc.title) {
      const sub = document.createElement('span');
      sub.className = 'tc-id-sub';
      sub.textContent = tc.title;
      idCell.appendChild(sub);
    }
    row.appendChild(idCell);

    [tc.testScenario, tc.preconditions].forEach((value) => {
      const td = document.createElement('td');
      td.textContent = value || '';
      row.appendChild(td);
    });

    const steps = document.createElement('td');
    const ol = document.createElement('ol');
    ol.className = 'tc-steps';
    (tc.testSteps || []).forEach((step) => {
      const li = document.createElement('li');
      li.textContent = step;
      ol.appendChild(li);
    });
    steps.appendChild(ol);
    row.appendChild(steps);

    const expected = document.createElement('td');
    expected.textContent = tc.expectedResult || '';
    row.appendChild(expected);

    tbody.appendChild(row);
  });
  table.appendChild(tbody);

  wrap.appendChild(table);
  return wrap;
}

/* ---------------- test cases for every scenario ----------------
   The per-row button generates one set and waits. Filling a whole upload that
   way is one click per scenario, so the same work runs as a job on the server
   and the page follows along. */

function renderTestCaseProgress() {
  const strip = el('tcProgress');
  const job = state.tcJob;

  if (!job || (job.state !== 'running' && job.state !== 'failed')) {
    strip.hidden = true;
    return;
  }

  const done = job.done + job.failed + job.skipped;
  const pct = job.total ? Math.round((done / job.total) * 100) : 100;

  strip.hidden = false;
  strip.classList.toggle('is-failed', job.state === 'failed');
  el('tcProgressFill').style.width = `${pct}%`;
  el('tcProgressStop').hidden = job.state !== 'running';

  if (job.state === 'failed') {
    el('tcProgressText').textContent = job.error || 'Generation stopped.';
    return;
  }

  const trailer = job.failed ? ` · ${job.failed} could not be generated` : '';
  el('tcProgressText').textContent =
    `Writing test cases — ${job.done} of ${job.total} done${trailer}`;
}

async function pollTestCaseRun(id) {
  if (state.tcPoll) clearTimeout(state.tcPoll);

  let result;
  try {
    result = await api(`/api/enhancements/${id}/testcases`);
  } catch (err) {
    state.tcJob = { state: 'failed', error: err.message, total: 0, done: 0, failed: 0, skipped: 0 };
    renderTestCaseProgress();
    return;
  }

  state.tcJob = result.job;
  renderTestCaseProgress();
  if (!result.job) return;

  // the rows gain their test cases as the job goes, so keep the table current
  if (state.view === 'scenarios' && state.enhancement && state.enhancement.id === id) {
    const fresh = await api(`/api/enhancements/${id}`);
    state.enhancement = fresh.enhancement;
    renderScenarios();
    renderTestCaseProgress();
  }

  if (result.job.state === 'running') {
    state.tcPoll = setTimeout(() => pollTestCaseRun(id), 2500);
    return;
  }

  if (result.job.state === 'done') {
    const trailer = result.job.failed ? `, ${result.job.failed} could not be generated` : '';
    toast(`Test cases written for ${plural(result.job.done, 'scenario')}${trailer}.`);
    await loadProducts();
  }
}

/** Start filling in the test cases for one enhancement. */
async function startTestCaseRun(id, regenerate) {
  try {
    const started = await api(`/api/enhancements/${id}/testcases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ regenerate: Boolean(regenerate) }),
    });

    state.tcJob = started.job;
    renderTestCaseProgress();

    if (started.job && started.job.total === 0) {
      toast('Every scenario already has test cases.');
      return;
    }
    pollTestCaseRun(id);
  } catch (err) {
    toast(err.message, true);
  }
}

el('tcProgressStop').addEventListener('click', async () => {
  const id = state.enhancement && state.enhancement.id;
  if (!id) return;
  try {
    await api(`/api/enhancements/${id}/testcases`, { method: 'DELETE' });
    if (state.tcPoll) clearTimeout(state.tcPoll);
    state.tcJob = null;
    renderTestCaseProgress();
    toast('Stopped. What was written is kept.');
  } catch (err) {
    toast(err.message, true);
  }
});

async function runTestCases(sno, regenerate, button, body) {
  const enh = state.enhancement;
  if (!enh) return;

  button.disabled = true;
  const previousLabel = button.textContent;
  button.textContent = 'Generating…';
  body.innerHTML = '';
  const loading = document.createElement('p');
  loading.className = 'tc-loading';
  loading.textContent = 'Generating test cases…';
  body.appendChild(loading);

  try {
    const result = await api(`/api/enhancements/${enh.id}/scenarios/${sno}/testcases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ regenerate: Boolean(regenerate) }),
    });

    const scenario = state.enhancement.scenarios.find((s) => Number(s.sno) === Number(sno));
    if (scenario) {
      scenario.testCases = result.testCases;
      scenario.testCasesMeta = result.meta;
    }
    renderScenarios();
    toast(`${plural(result.testCases.length, 'test case')} generated for test scenario ${sno}.`);
  } catch (err) {
    button.disabled = false;
    button.textContent = previousLabel;
    body.innerHTML = '';
    const problem = document.createElement('p');
    problem.className = 'tc-error';
    problem.textContent = err.message;
    body.appendChild(problem);
  }
}

/* ---------------- breadcrumbs ---------------- */

function renderCrumbs() {
  dom.crumbs.innerHTML = '';

  const add = (text, onClick) => {
    if (dom.crumbs.childNodes.length) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '\u203a';
      dom.crumbs.appendChild(sep);
    }
    if (onClick) {
      const a = document.createElement('a');
      a.textContent = text;
      a.addEventListener('click', onClick);
      dom.crumbs.appendChild(a);
    } else {
      const span = document.createElement('span');
      span.textContent = text;
      dom.crumbs.appendChild(span);
    }
  };

  const away = state.product || state.view === 'documents';
  add('Dashboard', away ? () => resetToDashboard() : null);

  if (state.view === 'documents') {
    add('Enhancement Documents', null);
    return;
  }

  if (state.product) {
    add(productLabel(state.product), state.enhancement ? () => openProduct(state.product) : null);
  }
  if (state.enhancement) add(state.enhancement.name, null);
}

function resetToDashboard({ push = true } = {}) {
  if (push) pushRoute({ view: 'dashboard' });
  stopTestCasePolling();
  state.product = null;
  state.enhancement = null;
  state.enhancements = [];
  state.view = 'dashboard';
  renderProducts();
  renderCrumbs();
  hideAllViews();
  dom.enhancementView.hidden = false;
  dom.enhancementSearch.hidden = true;
  dom.productTitle.textContent = 'Dashboard';
  dom.productSub.textContent = 'Test scenarios and documents across all products.';
  renderDashboard();
}

/** Landing view: the totals at a glance, then a card per product. */
function renderDashboard() {
  dom.enhancementList.innerHTML = '';

  const totals = state.products.reduce(
    (acc, p) => ({
      enhancements: acc.enhancements + p.enhancementCount,
      scenarios: acc.scenarios + p.scenarioCount,
      testCases: acc.testCases + (p.testCaseCount || 0),
    }),
    { enhancements: 0, scenarios: 0, testCases: 0 }
  );

  const stats = document.createElement('div');
  stats.className = 'stat-row';
  [
    ['Enhancements', totals.enhancements, 'Under test', 'a'],
    ['Test Scenarios', totals.scenarios, 'Across all enhancements', 'b'],
    ['Scenarios with Test Cases', totals.testCases, 'With detailed test cases', 'c'],
    ['Documents', state.documentCount || 0, 'Write-ups and screenshots', 'd'],
  ].forEach(([label, value, hint, tone]) => {
    const tile = document.createElement('div');
    tile.className = 'stat';
    tile.dataset.tone = tone;
    tile.innerHTML = '<p class="stat-value"></p><p class="stat-label"></p><p class="stat-hint"></p>';
    tile.querySelector('.stat-value').textContent = value;
    tile.querySelector('.stat-label').textContent = label;
    tile.querySelector('.stat-hint').textContent = hint;
    stats.appendChild(tile);
  });
  dom.enhancementList.appendChild(stats);

  const heading = document.createElement('p');
  heading.className = 'section-head';
  heading.textContent = 'Products';
  dom.enhancementList.appendChild(heading);

  const grid = document.createElement('div');
  grid.className = 'home-grid';

  state.products.forEach((product) => {
    const open = state.openHomeProduct === product.key;

    const item = document.createElement('div');
    item.className = `home-item${open ? ' open' : ''}`;

    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'home-card';
    card.dataset.tone = PRODUCT_TONE[product.key] || 'a';
    card.setAttribute('aria-expanded', open ? 'true' : 'false');
    card.innerHTML = `
      <span class="home-card-top">
        <span class="p-chip"></span>
        <span class="home-card-name"></span>
        <span class="home-card-chev"></span>
      </span>
      <span class="home-card-blurb"></span>
      <span class="home-card-stats"></span>`;
    card.querySelector('.p-chip').textContent = monogram(product.label);
    card.querySelector('.home-card-name').textContent = product.label;
    card.querySelector('.home-card-chev').textContent = open ? '▾' : '▸';
    card.querySelector('.home-card-blurb').textContent = product.blurb;
    card.querySelector('.home-card-stats').textContent = [
      plural(product.enhancementCount, 'enhancement'),
      plural(product.scenarioCount, 'scenario'),
      `${product.documentCount || 0} doc${(product.documentCount || 0) === 1 ? '' : 's'}`,
    ].join('  ·  ');
    card.title = open ? `Close ${product.label}` : `Open ${product.label}`;
    card.addEventListener('click', () => toggleHomeProduct(product.key));
    item.appendChild(card);

    if (open) item.appendChild(buildHomePanel(product));
    grid.appendChild(item);
  });

  dom.enhancementList.appendChild(grid);
}

/**
 * A dashboard product card is a dropdown, the same way a document card is:
 * click to open its scenarios in place, click again to close it. Only one
 * product stays open at a time.
 */
async function toggleHomeProduct(key) {
  if (state.openHomeProduct === key) {
    state.openHomeProduct = null;
    renderDashboard();
    return;
  }

  try {
    if (!state.homeEnhancements[key]) {
      const { enhancements } = await api(`/api/products/${key}/enhancements`);
      state.homeEnhancements[key] = enhancements;
    }
    state.openHomeProduct = key;
    renderDashboard();
  } catch (err) {
    toast(err.message, true);
  }
}

/** The open card's body: that product's enhancements, and a way out to the full list. */
function buildHomePanel(product) {
  const panel = document.createElement('div');
  panel.className = 'home-panel';

  const bar = document.createElement('div');
  bar.className = 'home-panel-bar';

  const label = document.createElement('span');
  label.className = 'home-panel-label';
  label.textContent = plural(product.enhancementCount, 'enhancement');
  bar.appendChild(label);

  const openAll = document.createElement('button');
  openAll.type = 'button';
  openAll.className = 'btn btn-outline home-panel-btn';
  openAll.textContent = 'Open full list';
  openAll.addEventListener('click', () => openProduct(product.key));
  bar.appendChild(openAll);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn btn-outline home-panel-btn';
  close.textContent = 'Close';
  close.addEventListener('click', () => toggleHomeProduct(product.key));
  bar.appendChild(close);

  panel.appendChild(bar);

  const list = document.createElement('div');
  list.className = 'home-panel-list';

  const items = state.homeEnhancements[product.key] || [];
  if (!items.length) {
    const none = document.createElement('p');
    none.className = 'home-panel-empty';
    none.textContent = 'No enhancements yet.';
    list.appendChild(none);
  }

  items.forEach((enh) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'home-row';
    row.innerHTML = `
      <span class="home-row-main">
        <span class="home-row-name"></span>
        <span class="home-row-meta"></span>
      </span>
      <span class="home-row-right">
        <span class="pill"></span>
        <span class="chev">&rsaquo;</span>
      </span>`;
    row.querySelector('.home-row-name').textContent = enh.name;
    row.querySelector('.home-row-meta').textContent = [
      enh.description,
      `Updated ${formatDate(enh.updatedAt)}`,
    ].filter(Boolean).join('  ·  ');
    row.querySelector('.pill').textContent = plural(enh.scenarioCount, 'scenario');
    row.addEventListener('click', () => openEnhancement(enh.id));
    list.appendChild(row);
  });

  panel.appendChild(list);
  return panel;
}

/* ---------------- enhancement documents ---------------- */

const KIND_LABEL = { docx: 'Word Document', pdf: 'PDF', image: 'Screenshot', text: 'Text / Markdown' };

function hideAllViews() {
  dom.enhancementView.hidden = true;
  dom.scenarioView.hidden = true;
  dom.documentsView.hidden = true;
}

async function openDocuments({ expand, product, push = true } = {}) {
  if (push) pushRoute({ view: 'documents', expand: expand || null, product: product || null });
  if (product) state.docsNavOpen = true;
  stopTestCasePolling();
  state.product = null;
  state.enhancement = null;
  state.view = 'documents';
  state.docFilter = '';
  dom.documentSearch.value = '';

  hideAllViews();
  dom.documentsView.hidden = false;

  try {
    const { documents } = await api('/api/documents');
    state.documents = documents;

    // Arriving with no document named means the list shows collapsed — this is
    // what the Back arrow lands on after a document was opened.
    if (!expand) state.openDocs.clear();

    if (expand) {
      const target = documents.find((d) => d.id === expand);
      if (target && !documentsInTab(state.docTab).some((d) => d.id === target.id)) {
        state.docTab = target.product || 'unassigned';
      }
      await loadDocumentBody(expand);
      state.openDocs.add(expand);
    } else if (product) {
      state.docTab = product;
    } else {
      state.docTab = 'all';       // the Documents nav item means every product
    }

    renderProducts();
    renderCrumbs();
    renderDocTabs();
    renderDocuments();
  } catch (err) {
    toast(err.message, true);
  }
}

/** One tab per product, plus a transitional tab for documents with no product. */
function docTabs() {
  const tabs = [{ key: 'all', label: 'All' }, ...state.products.map((p) => ({ key: p.key, label: p.label }))];
  if (state.documents.some((d) => !d.product)) tabs.push({ key: 'unassigned', label: 'Unassigned' });
  return tabs;
}

function documentsInTab(tabKey) {
  if (tabKey === 'all') return state.documents;
  return state.documents.filter((d) => (tabKey === 'unassigned' ? !d.product : d.product === tabKey));
}

function renderDocTabs() {
  dom.docTabs.innerHTML = '';
  docTabs().forEach((tab) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `tab${state.docTab === tab.key ? ' active' : ''}`;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', state.docTab === tab.key ? 'true' : 'false');

    const label = document.createElement('span');
    label.textContent = tab.label;
    btn.appendChild(label);

    const count = document.createElement('span');
    count.className = 'tab-count';
    count.textContent = documentsInTab(tab.key).length;
    btn.appendChild(count);

    btn.addEventListener('click', () => {
      state.docTab = tab.key;
      state.openDocs.clear();
      pushRoute({ view: 'documents', product: tab.key });
      renderProducts();
      renderDocTabs();
      renderDocuments();
    });
    dom.docTabs.appendChild(btn);
  });
}

/** Fetch the document once; the body is kept for as long as the page lives. */
async function loadDocumentBody(id) {
  if (state.docBodies[id]) return state.docBodies[id];
  const { document: doc } = await api(`/api/documents/${id}`);
  state.docBodies[id] = doc;
  return doc;
}

/**
 * The card is a dropdown: click to open the document, click again to close it.
 * Only one document stays open — opening another closes the previous one.
 */
async function toggleDocument(id, { startEditing = false, push = true } = {}) {
  if (state.openDocs.has(id) && !startEditing) {
    state.openDocs.delete(id);
    if (push) pushRoute({ view: 'documents', expand: null });
    renderDocuments();
    return;
  }

  try {
    await loadDocumentBody(id);
    if (push) pushRoute({ view: 'documents', expand: id });
    state.openDocs.clear();          // only one document stays open at a time
    state.openDocs.add(id);
    state.editingDoc = startEditing ? id : null;
    renderDocuments();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderDocuments() {
  const term = state.docFilter.trim().toLowerCase();
  const inTab = documentsInTab(state.docTab);
  const items = term
    ? inTab.filter((d) => `${d.name} ${d.description} ${d.fileName}`.toLowerCase().includes(term))
    : inTab;

  dom.documentList.innerHTML = '';

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    if (inTab.length && term) {
      empty.innerHTML = '<h3>No Matches Found</h3><p>No document in this tab matches your search.</p>';
    } else {
      const where = (state.docTab === 'unassigned' || state.docTab === 'all')
        ? ''
        : ` for ${productLabel(state.docTab)}`;
      empty.innerHTML = `<h3>No Documents${where} Yet</h3>
        <p>Upload a write-up to read its content and screenshots here.</p>`;
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary';
      btn.textContent = '+ Upload Document';
      btn.addEventListener('click', openDocumentModal);
      empty.appendChild(btn);
    }
    dom.documentList.appendChild(empty);
    return;
  }

  items.forEach((doc) => {
    const open = state.openDocs.has(doc.id);
    const wrap = document.createElement('div');
    wrap.className = `doc-item${open ? ' open' : ''}`;

    // A div, not a button: the Edit control lives inside the header next to the
    // name, and a button cannot legally contain another button.
    const card = document.createElement('div');
    card.className = 'enh-card doc-card';
    card.setAttribute('role', 'button');
    card.tabIndex = 0;
    card.setAttribute('aria-expanded', open ? 'true' : 'false');
    card.innerHTML = `
      <span class="doc-card-main">
        <span class="doc-name-row">
          <span class="enh-name"></span>
        </span>
      </span>
      <span class="enh-right">
        <span class="pill ghost"></span>
        <span class="chev"></span>
      </span>`;
    card.querySelector('.enh-name').textContent = doc.name;
    card.querySelector('.pill').textContent = KIND_LABEL[doc.kind] || doc.kind;
    card.querySelector('.chev').textContent = open ? '▾' : '▸';
    card.title = open ? 'Close document' : 'Open document';

    const toggle = () => toggleDocument(doc.id);
    card.addEventListener('click', toggle);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });

    wrap.appendChild(card);

    if (open) wrap.appendChild(buildDocumentPanel(state.docBodies[doc.id] || doc));
    dom.documentList.appendChild(wrap);
  });
}

/* ---------------- editing a document's matter in the tool ----------------
   The write-up is corrected here; the uploaded file is never rewritten, so
   Download Original always hands back exactly what was uploaded. */

const FORMAT_TOOLS = [
  { label: 'B', cmd: 'bold', title: 'Bold' },
  { label: 'I', cmd: 'italic', title: 'Italic' },
  { label: 'U', cmd: 'underline', title: 'Underline' },
  { label: 'Heading', cmd: 'formatBlock', arg: 'h3', title: 'Make this line a heading' },
  { label: 'Text', cmd: 'formatBlock', arg: 'p', title: 'Make this line normal text' },
  { label: 'Bullets', cmd: 'insertUnorderedList', title: 'Bulleted list' },
  { label: 'Numbers', cmd: 'insertOrderedList', title: 'Numbered list' },
  { label: 'Clear', cmd: 'removeFormat', title: 'Clear formatting' },
];

function buildDocumentPanel(doc) {
  const panel = document.createElement('div');
  panel.className = 'doc-panel';

  const editing = state.editingDoc === doc.id;

  /* The body is built first: the editor needs the article it acts on. */
  const body = document.createElement('div');
  body.className = 'doc-body';
  let article = null;

  if (doc.kind === 'pdf') {
    const frame = document.createElement('iframe');
    frame.className = 'doc-pdf';
    frame.src = `/api/documents/${doc.id}/file`;
    frame.title = doc.name;
    body.appendChild(frame);
  } else if (doc.kind === 'video') {
    const player = document.createElement('video');
    player.className = 'doc-video';
    player.src = `/api/documents/${doc.id}/file`;
    player.controls = true;
    player.preload = 'metadata';
    body.appendChild(player);
  } else if (doc.kind === 'image') {
    const figure = document.createElement('figure');
    figure.className = 'doc-figure';
    const img = document.createElement('img');
    img.src = `/api/documents/${doc.id}/file`;
    img.alt = doc.name;
    figure.appendChild(img);
    body.appendChild(figure);
  } else {
    // .docx / .md / .txt were converted to a safe HTML subset on the server
    article = document.createElement('article');
    article.className = `doc-article${editing ? ' editing' : ''}`;
    article.innerHTML = doc.html || '<p class="doc-empty">This document has no readable text.</p>';
    if (editing) {
      article.contentEditable = 'true';
      article.spellcheck = true;
    }
    body.appendChild(article);
  }

  const bar = document.createElement('div');
  bar.className = 'doc-bar';

  const label = document.createElement('span');
  label.className = 'doc-bar-label';
  label.textContent = doc.fileName;
  bar.appendChild(label);

  const download = document.createElement('a');
  download.className = 'icon-btn-sq';
  download.innerHTML = ICON.download;
  download.title = 'Download the original file';
  download.setAttribute('aria-label', 'Download the original file');
  download.href = `/api/documents/${doc.id}/file?download=1`;
  download.setAttribute('download', '');
  bar.appendChild(download);

  panel.appendChild(bar);
  if (editing) panel.appendChild(buildDocumentEditor(doc, article));
  panel.appendChild(body);
  return panel;
}

/**
 * One edit mode, opened by the pencil on the card: the title, the product the
 * document belongs to and — for the kinds the tool renders as text — the matter
 * itself, all saved together. The uploaded file is never rewritten, so Download
 * Original still hands back exactly what was uploaded.
 */
function buildDocumentEditor(doc, article) {
  const form = document.createElement('form');
  form.className = 'doc-edit';

  const row = document.createElement('div');
  row.className = 'doc-edit-row';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'input';
  nameInput.maxLength = 140;
  nameInput.value = doc.name;
  nameInput.setAttribute('aria-label', 'Document title');
  row.appendChild(nameInput);

  const productSelect = document.createElement('select');
  productSelect.className = 'input doc-edit-product';
  state.products.forEach((p) => {
    const option = document.createElement('option');
    option.value = p.key;
    option.textContent = p.label;
    productSelect.appendChild(option);
  });
  const noneOption = document.createElement('option');
  noneOption.value = '';
  noneOption.textContent = 'Unassigned';
  productSelect.appendChild(noneOption);
  productSelect.value = doc.product || '';
  row.appendChild(productSelect);

  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'btn btn-primary doc-bar-btn';
  save.textContent = 'Save';
  row.appendChild(save);

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-outline doc-bar-btn';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => {
    state.editingDoc = null;
    renderDocuments();               // re-renders from the stored copy, dropping the edits
  });
  row.appendChild(cancel);

  form.appendChild(row);

  // The formatting strip only appears where there is matter the tool can edit.
  if (article) {
    const tools = document.createElement('div');
    tools.className = 'doc-tools';

    FORMAT_TOOLS.forEach((tool) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'doc-tool';
      btn.textContent = tool.label;
      btn.title = tool.title;
      // mousedown would move the caret out of the text before the command runs
      btn.addEventListener('mousedown', (event) => event.preventDefault());
      btn.addEventListener('click', () => {
        article.focus();
        document.execCommand(tool.cmd, false, tool.arg || null);
      });
      tools.appendChild(btn);
    });

    const note = document.createElement('span');
    note.className = 'doc-editbar-note';
    note.textContent = 'Edit the text below \u2014 the uploaded file is left untouched';
    tools.appendChild(note);

    form.appendChild(tools);
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const name = nameInput.value.trim();
    if (!name) {
      toast('Enter a document title.', true);
      nameInput.focus();
      return;
    }

    const payload = { name, product: productSelect.value };
    if (article) {
      const html = article.innerHTML.trim();
      if (!html || !article.textContent.trim()) {
        toast('The document cannot be saved empty.', true);
        return;
      }
      payload.html = html;
    }

    save.disabled = true;
    save.textContent = 'Saving\u2026';
    try {
      await api(`/api/documents/${doc.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      delete state.docBodies[doc.id];        // read back the copy the server stored
      state.editingDoc = null;
      state.docTab = productSelect.value || 'unassigned';
      await openDocuments({ expand: doc.id });
      toast('Document saved.');
    } catch (err) {
      save.disabled = false;
      save.textContent = 'Save';
      toast(err.message, true);
    }
  });

  return form;
}

/* ---------------- upload dialog ---------------- */

let modalMode = 'create'; // 'create' | 'reupload' | 'document'

const SUBMIT_LABEL = {
  create: 'Create Enhancement',
  reupload: 'Upload Scenarios',
  document: 'Upload Document',
};

const HINTS = {
  create:
    'Attach either file, or both. Scenarios: columns S.No and Test Scenario. Document: .docx keeps its text and screenshots; PDFs open in the viewer.',
  scenarios:
    'Required columns: S.No and Test Scenario. Any other columns are kept. Serial numbers are regenerated.',
  document:
    '.docx keeps its text and screenshots in place. PDFs open in the viewer, images show as one screenshot, and .md / .txt are formatted as text.',
};

/** Show only the fields that belong to the current dialog mode. */
function applyModalMode() {
  const isCreate = modalMode === 'create';
  const isReupload = modalMode === 'reupload';
  const isDocument = modalMode === 'document';

  dom.productField.hidden = isReupload;
  dom.nameField.hidden = isReupload;
  dom.descField.hidden = isReupload;
  dom.modeField.hidden = !isReupload;
  dom.fileField.hidden = isDocument;
  dom.splitField.hidden = isDocument;
  dom.docField.hidden = isReupload;
  dom.modalHint.textContent = isDocument ? HINTS.document : (isCreate ? HINTS.create : HINTS.scenarios);

  dom.docFieldLabel.innerHTML = isDocument
    ? 'Document File <em>(.docx, .pdf, .md, .txt, image)</em>'
    : 'Enhancement Document <em>(optional — .docx, .pdf, .md, .txt, image)</em>';
  dom.fileFieldLabel.innerHTML = isCreate
    ? 'Test Scenarios File <em>(optional — .csv, .xlsx, .xls)</em>'
    : 'Test Scenarios File <em>(.csv, .xlsx, .xls)</em>';
  dom.nameFieldLabel.textContent = isDocument ? 'Document Name (optional)' : 'Enhancement / Feature Name';
}

function openCreateModal(productKey) {
  modalMode = 'create';
  dom.modalTitle.textContent = 'New Enhancement';
  dom.modalProduct.value = productKey || state.product || (state.products[0] && state.products[0].key);
  dom.modalName.value = '';
  dom.modalDesc.value = '';
  dom.modalSubmit.textContent = 'Create Enhancement';
  applyModalMode();
  showModal();
}

function openReuploadModal() {
  modalMode = 'reupload';
  dom.modalTitle.textContent = `Upload Test Scenarios — ${state.enhancement.name}`;
  dom.modalMode.value = 'replace';
  dom.modalSubmit.textContent = 'Upload Scenarios';
  applyModalMode();
  showModal();
}

function openDocumentModal() {
  modalMode = 'document';
  dom.modalTitle.textContent = 'Upload Enhancement Document';
  const tabProduct = state.docTab && state.docTab !== 'unassigned' ? state.docTab : null;
  dom.modalProduct.value = tabProduct || state.product || (state.products[0] && state.products[0].key);
  dom.modalName.value = '';
  dom.modalDesc.value = '';
  dom.modalSubmit.textContent = 'Upload Document';
  applyModalMode();
  showModal();
}

function showModal() {
  dom.modalError.hidden = true;
  dom.modalFile.value = '';
  dom.modalDoc.value = '';
  dom.modal.hidden = false;
  setTimeout(() => (modalMode === 'reupload' ? dom.modalFile : dom.modalName).focus(), 30);
}

function closeModal() {
  dom.modal.hidden = true;
  dom.uploadForm.reset();
  dom.modalSplit.checked = true;
}

function modalError(message) {
  dom.modalError.textContent = message;
  dom.modalError.hidden = false;
}

async function submitUpload(event) {
  event.preventDefault();
  dom.modalError.hidden = true;

  const isDocument = modalMode === 'document';

  if (isDocument && !dom.modalDoc.files.length) {
    modalError('Select a document file (.docx, .pdf, .md, .txt or an image).');
    return;
  }
  if (modalMode === 'reupload' && !dom.modalFile.files.length) {
    modalError('Select a .csv or .xlsx file of test scenarios.');
    return;
  }
  if (modalMode === 'create' && !dom.modalFile.files.length && !dom.modalDoc.files.length) {
    modalError('Attach a test scenario file, a document, or both. At least one is required.');
    return;
  }
  if (modalMode === 'create' && !dom.modalName.value.trim()) {
    modalError('Enter the enhancement / feature name.');
    return;
  }

  const body = new FormData();
  let url;

  if (isDocument) {
    url = '/api/documents';
    body.append('file', dom.modalDoc.files[0]);
    body.append('name', dom.modalName.value);
    body.append('description', dom.modalDesc.value);
    body.append('product', dom.modalProduct.value);   // keeps each product's documents separate
  } else {
    if (dom.modalFile.files.length) body.append('file', dom.modalFile.files[0]);
    body.append('splitLines', dom.modalSplit.checked ? 'true' : 'false');

    if (modalMode === 'create') {
      url = '/api/enhancements';
      body.append('product', dom.modalProduct.value);
      body.append('name', dom.modalName.value);
      body.append('description', dom.modalDesc.value);
      if (dom.modalDoc.files.length) body.append('document', dom.modalDoc.files[0]);
    } else {
      url = `/api/enhancements/${state.enhancement.id}/scenarios`;
      body.append('mode', dom.modalMode.value);
    }
  }

  dom.modalSubmit.disabled = true;
  dom.modalSubmit.textContent = 'Uploading…';
  try {
    const result = await api(url, { method: 'POST', body });
    closeModal();
    await loadProducts();

    if (isDocument) {
      toast(`Document "${result.document.name}" uploaded.`);
      await openDocuments({ expand: result.document.id });
    } else {
      const skipped = result.skipped ? `, ${plural(result.skipped, 'empty row')} skipped` : '';
      const withDoc = result.document ? ' Document uploaded.' : '';
      toast(result.imported
        ? `${plural(result.imported, 'test scenario')} imported${skipped}.${withDoc}`
        : `Enhancement created.${withDoc || ' Add test scenarios whenever you are ready.'}`);

      if (modalMode === 'create') {
        await openProduct(result.enhancement.product);
        await openEnhancement(result.enhancement.id);
      } else {
        await openEnhancement(state.enhancement.id);
      }
    }
  } catch (err) {
    modalError(err.message);
  } finally {
    dom.modalSubmit.disabled = false;
    dom.modalSubmit.textContent = SUBMIT_LABEL[modalMode] || 'Upload';
  }
}

/* ---------------- wiring ---------------- */

el('newEnhancementBtn').addEventListener('click', () => openCreateModal(state.product));
dom.reuploadBtn.addEventListener('click', openReuploadModal);
dom.uploadForm.addEventListener('submit', submitUpload);
dom.addScenarioForm.addEventListener('submit', addScenarioInTool);


el('addDocumentBtn').addEventListener('click', openDocumentModal);
dom.documentSearch.addEventListener('input', (e) => {
  state.docFilter = e.target.value;
  renderDocuments();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.bulk')) closeActionMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeActionMenu(); });
window.addEventListener('scroll', closeActionMenu, true);

el('modalClose').addEventListener('click', closeModal);
el('modalCancel').addEventListener('click', closeModal);
dom.modal.addEventListener('click', (e) => { if (e.target === dom.modal) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !dom.modal.hidden) closeModal(); });

dom.enhancementSearch.addEventListener('input', (e) => {
  state.enhFilter = e.target.value;
  renderEnhancements();
});
dom.scenarioSearch.addEventListener('input', (e) => {
  state.scenarioFilter = e.target.value;
  renderScenarios();
});

// The CloudFuze logo is dropped in at public/logo.png; without it the topbar
// shows a wordmark instead of a broken image.
function useBrandWordmark(img) {
  if (!img || !img.isConnected) return;
  const mark = document.createElement('span');
  mark.className = 'brand-word';
  mark.textContent = 'CloudFuze';
  img.replaceWith(mark);
}

(function brandLogoFallback() {
  const img = el('brandLogo');
  if (!img) return;
  img.addEventListener('error', () => useBrandWordmark(img));
  // the 404 can land before this script runs, so check the finished state too
  if (img.complete && img.naturalWidth === 0) useBrandWordmark(img);
})();

/* ---------------- the in-tool assistant ----------------
   Answers questions about this tool's own data. The server assembles the
   context from the store on every turn, so replies track the current rows. */

const bot = {
  open: false,
  busy: false,
  history: [],          // {role, content} pairs sent back for follow-up questions
  position: null,       // where the user dragged the panel to
  files: [],            // attachments waiting to go with the next message
  greeted: false,
};

const BOT_SUGGESTIONS = [
  'How many scenarios have failed?',
  'What is the Group DM Name Migration about?',
  'Which enhancements have no test cases yet?',
];

function botBubble(role, text, extraClass = '') {
  const row = document.createElement('div');
  row.className = `bot-msg is-${role} ${extraClass}`.trim();
  const bubble = document.createElement('div');
  bubble.className = 'bot-bubble';
  bubble.textContent = text;
  row.appendChild(bubble);
  el('botLog').appendChild(row);
  el('botLog').scrollTop = el('botLog').scrollHeight;
  return row;
}

/* ---------------- attachments ----------------
   A screenshot of the bug, or a sheet of scenarios, says more than a
   paragraph describing it. Files ride along with one message and are not
   stored — write-ups that need keeping go through the Documents page. */

const MAX_CHAT_FILES = 25;

function renderBotFiles() {
  const tray = el('botFiles-tray');
  tray.innerHTML = '';
  tray.hidden = !bot.files.length;

  bot.files.forEach((file, idx) => {
    const chip = document.createElement('span');
    chip.className = 'bot-file';

    const name = document.createElement('span');
    name.className = 'bot-file-name';
    name.textContent = file.name;
    name.title = `${file.name} — ${Math.max(1, Math.round(file.size / 1024))} KB`;
    chip.appendChild(name);

    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'bot-file-x';
    drop.setAttribute('aria-label', `Remove ${file.name}`);
    drop.textContent = '×';
    drop.addEventListener('click', () => {
      bot.files.splice(idx, 1);
      renderBotFiles();
    });
    chip.appendChild(drop);

    tray.appendChild(chip);
  });
}

function addBotFiles(list) {
  const incoming = Array.from(list || []);
  if (!incoming.length) return;

  const room = MAX_CHAT_FILES - bot.files.length;
  if (room <= 0) {
    toast(`${MAX_CHAT_FILES} files at a time is the most it takes.`, true);
    return;
  }

  bot.files = bot.files.concat(incoming.slice(0, room));
  if (incoming.length > room) toast(`Only the first ${room} were attached.`, true);
  renderBotFiles();
}

el('botAttach').addEventListener('click', () => el('botFiles').click());
el('botFiles').addEventListener('change', (event) => {
  addBotFiles(event.target.files);
  event.target.value = '';
});

/* dropping onto the panel, and pasting a screenshot straight in */
el('botPanel').addEventListener('dragover', (event) => {
  event.preventDefault();
  el('botPanel').classList.add('is-dropping');
});
el('botPanel').addEventListener('dragleave', (event) => {
  if (event.target === el('botPanel')) el('botPanel').classList.remove('is-dropping');
});
el('botPanel').addEventListener('drop', (event) => {
  event.preventDefault();
  el('botPanel').classList.remove('is-dropping');
  addBotFiles(event.dataTransfer.files);
});
el('botInput').addEventListener('paste', (event) => {
  const pasted = Array.from(event.clipboardData.files || []);
  if (pasted.length) {
    event.preventDefault();
    addBotFiles(pasted);
  }
});

/* ---------------- dictating a question ----------------
   The browser does the listening and the transcribing, so nothing is
   recorded, nothing is uploaded, and it costs nothing. The words land in the
   box rather than being sent: dictation mishears, and a question worth asking
   is worth a glance before it goes.

   Chrome and Edge have this; Firefox does not. Where it is absent the control
   is not shown at all, rather than offered and then apologised for. */

const Dictation = window.SpeechRecognition || window.webkitSpeechRecognition;

const voice = {
  session: null,     // the live SpeechRecognition, while it is listening
  settled: '',       // what the box held before dictation began
};

function stopDictating() {
  if (!voice.session) return;
  const session = voice.session;
  voice.session = null;
  try { session.stop(); } catch (err) { /* already stopped */ }

  el('botVoice').classList.remove('is-listening');
  el('botVoice').setAttribute('aria-pressed', 'false');
  el('botVoice').title = 'Dictate your question';
}

function startDictating() {
  if (voice.session) { stopDictating(); return; }

  const session = new Dictation();
  session.lang = document.documentElement.lang || 'en-US';
  session.continuous = true;      // a feature takes more than one sentence to describe
  session.interimResults = true;  // the words appear as they are said

  /* Whatever was typed already is kept; dictation adds to it. */
  voice.settled = el('botInput').value.trim();

  session.addEventListener('result', (event) => {
    let heard = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      heard += event.results[i][0].transcript;
    }
    heard = heard.trim();
    if (!heard) return;

    const joined = voice.settled ? `${voice.settled} ${heard}` : heard;
    el('botInput').value = joined.slice(0, 1000);

    /* A final result is banked, so the next phrase appends rather than
       replacing it. */
    if (event.results[event.results.length - 1].isFinal) {
      voice.settled = el('botInput').value.trim();
    }
  });

  session.addEventListener('error', (event) => {
    stopDictating();
    if (event.error === 'no-speech' || event.error === 'aborted') return;
    toast(event.error === 'not-allowed'
      ? 'The microphone is blocked. Allow it for this page in the address bar, then try again.'
      : `Dictation stopped: ${event.error}`, true);
  });

  session.addEventListener('end', stopDictating);

  try {
    session.start();
  } catch (err) {
    toast('Dictation could not start.', true);
    return;
  }

  voice.session = session;
  el('botVoice').classList.add('is-listening');
  el('botVoice').setAttribute('aria-pressed', 'true');
  el('botVoice').title = 'Stop dictating';
  el('botInput').focus();
}

if (Dictation) {
  el('botVoice').hidden = false;
  el('botVoice').addEventListener('click', startDictating);
  // sending, or closing the panel, ends the listening
  el('botForm').addEventListener('submit', stopDictating);
  el('botClose').addEventListener('click', stopDictating);
}

/* ---------------- changes asked for in the chat ----------------
   The tool has no delete buttons: everything that changes the scenarios is
   asked for here. A delete is read back first and waits to be agreed, since
   it is the one thing that cannot be undone. */

async function runCommand(command, target) {
  try {
    const result = await api('/api/assistant/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, enhancementId: target ? target.id : null }),
    });

    botBubble('bot', result.done);

    // the page is showing what just changed, so bring it up to date
    await loadProducts();

    /* A write-up lives on the Documents page, so that is what needs redrawing
       — the scenario views know nothing about it. */
    if (result.isDocument) {
      if (state.view === 'documents') {
        await openDocuments({ product: state.docTab === 'all' ? null : state.docTab, push: false });
      } else {
        const { documents } = await api('/api/documents');
        state.documents = documents;
        if (state.view === 'dashboard') renderDashboard();
      }
      return;
    }

    if (result.gone) {
      if (state.view === 'scenarios' && state.enhancement && target && state.enhancement.id === target.id) {
        await openProduct(result.product);
      } else if (state.view === 'enhancements') {
        await openProduct(state.product);
      } else if (state.view === 'dashboard') {
        renderDashboard();
      }
      return;
    }

    if (state.view === 'scenarios' && state.enhancement && target && state.enhancement.id === target.id) {
      await openEnhancement(target.id, { push: false });
    } else if (state.view === 'enhancements') {
      await openProduct(state.product);
    }
  } catch (err) {
    botBubble('bot', err.message, 'is-error');
  }
}

/**
 * Offer the sets an instruction might have meant.
 *
 * Pointing at a screenshot and saying "this one" is how anyone asks, and
 * nothing here can see where the arrow points — so the candidates are put up
 * to be picked from, rather than the instruction being refused.
 */
function offerChoices(command, choices) {
  const row = document.createElement('div');
  row.className = 'bot-actions bot-choices';

  choices.forEach((choice) => {
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'bot-action';
    pick.textContent = `${choice.name} (${plural(choice.scenarioCount, 'scenario')})`;
    pick.title = `${productLabel(choice.product)} — ${choice.name}`;

    pick.addEventListener('click', () => {
      row.remove();
      const aimed = { ...command, name: choice.name };
      botBubble('bot', describeChosen(aimed, choice));
      if (command.confirm) askToConfirm(aimed, choice);
      else runCommand(aimed, choice);
    });

    row.appendChild(pick);
  });

  const none = document.createElement('button');
  none.type = 'button';
  none.className = 'bot-action';
  none.textContent = 'None of these';
  none.addEventListener('click', () => {
    row.remove();
    botBubble('bot', 'Left as it is. Open the set you mean, and ask again.');
  });
  row.appendChild(none);

  el('botLog').appendChild(row);
  el('botLog').scrollTop = el('botLog').scrollHeight;
}

/** What is about to happen, once a set has been picked. */
function describeChosen(command, target) {
  const list = (ns) => (ns.length === 1 ? `scenario ${ns[0]}` : `scenarios ${ns.join(', ')}`);

  switch (command.kind) {
    case 'delete-document':
      return `Delete the write-up "${target.name}". This cannot be undone.`;
    case 'rename-document':
      return `Rename the write-up "${target.name}" to "${command.to}".`;
    case 'move-document':
      return `File the write-up "${target.name}" under ${command.to}.`;
    case 'delete-set':
      return `Delete "${target.name}" and every scenario in it. This cannot be undone.`;
    case 'delete-scenarios':
      return `Delete ${list(command.snos)} in "${target.name}". This cannot be undone.`;
    case 'rename-set':
      return `Rename "${target.name}" to "${command.to}".`;
    case 'set-status':
      return `Mark ${list(command.snos)} in "${target.name}" as ${command.status === 'pending' ? 'not run' : command.status}.`;
    case 'edit-scenario':
      return `Reword scenario ${command.sno} in "${target.name}".`;
    default:
      return `Make that change to "${target.name}".`;
  }
}

/** Read a destructive change back, and wait to be told to go ahead. */
function askToConfirm(command, target) {
  const row = document.createElement('div');
  row.className = 'bot-actions';

  const go = document.createElement('button');
  go.type = 'button';
  go.className = 'bot-action is-danger';
  go.textContent = 'Yes, delete';

  const stop = document.createElement('button');
  stop.type = 'button';
  stop.className = 'bot-action';
  stop.textContent = 'Cancel';

  const settle = (chosen) => {
    go.disabled = true;
    stop.disabled = true;
    row.remove();
    if (chosen) runCommand(command, target);
    else botBubble('bot', 'Left as it is.');
  };

  go.addEventListener('click', () => settle(true));
  stop.addEventListener('click', () => settle(false));

  row.appendChild(go);
  row.appendChild(stop);
  el('botLog').appendChild(row);
  el('botLog').scrollTop = el('botLog').scrollHeight;
}

/** CSV of the drafted rows, in the same shape the upload dialog accepts. */
function draftToCsv(draft) {
  const cell = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const hasSection = draft.scenarios.some((r) => r.section);
  const header = ['S.No', 'Test Scenario', ...(hasSection ? ['Section'] : [])];
  const lines = [header.map(cell).join(',')];

  draft.scenarios.forEach((row, i) => {
    lines.push([i + 1, row.scenario, ...(hasSection ? [row.section || ''] : [])].map(cell).join(','));
  });
  return lines.join('\r\n');
}

function downloadCsv(draft) {
  const blob = new Blob(['\ufeff' + draftToCsv(draft)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${draft.name.replace(/[^a-z0-9 \-_]/gi, '').trim() || 'scenarios'}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Put the drafted rows into the tool, the same as uploading a sheet of them. */
/**
 * File a set of drafts, one per write-up.
 *
 * Nine write-ups make nine sets, each named after the one it came from, which
 * is what the Documents page already looks like. They are saved one after
 * another rather than all at once, so the page fills in as it goes and a
 * failure on the fourth does not take the three before it with it.
 *
 * Test cases are not written for them here. Nine sets is several hundred
 * scenarios and as many calls to the model; that is worth asking for
 * deliberately, from Actions on whichever set is wanted first.
 */
async function saveDrafts(drafts) {
  const row = document.createElement('div');
  row.className = 'bot-actions';
  const progress = document.createElement('span');
  progress.className = 'bot-actions-note';
  progress.textContent = `Filing ${plural(drafts.length, 'set')}…`;
  row.appendChild(progress);
  el('botLog').appendChild(row);

  const done = [];
  const failed = [];

  for (let i = 0; i < drafts.length; i += 1) {
    const draft = drafts[i];
    progress.textContent = `Filing ${i + 1} of ${drafts.length} — ${draft.name}`;
    el('botLog').scrollTop = el('botLog').scrollHeight;

    try {
      const result = await api('/api/assistant/scenarios', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ product: draft.product, name: draft.name, scenarios: draft.scenarios }),
      });
      done.push(result);
    } catch (err) {
      failed.push({ name: draft.name, why: err.message });
    }
  }

  row.remove();

  const total = done.reduce((n, r) => n + r.added, 0);
  botBubble('bot', `${plural(total, 'scenario')} filed across ${plural(done.length, 'set')} under ${productLabel(drafts[0].product)}:`);

  done.forEach((result) => {
    botBubble('bot', `  ${result.enhancement.name} — ${plural(result.added, 'scenario')}`);
  });

  failed.forEach((f) => botBubble('bot', `${f.name} could not be filed: ${f.why}`, 'is-error'));

  if (done.length) {
    botBubble('bot', 'Their test cases are not written yet — that is several hundred, so open a set '
      + 'and use Actions when you want them.');
    botOpenLink(done[0].enhancement.id, done[0].enhancement.name);
  }

  await loadProducts();
  if (state.view === 'enhancements' && state.product === drafts[0].product) await openProduct(state.product);
  else if (state.view === 'dashboard') renderDashboard();
}

async function saveDraft(draft, button) {
  button.disabled = true;
  const previous = button.textContent;
  button.textContent = 'Saving\u2026';

  try {
    const result = await api('/api/assistant/scenarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product: draft.product,
        name: draft.name,
        scenarios: draft.scenarios,
        enhancementId: draft.enhancementId || undefined,
      }),
    });

    const where = productLabel(draft.product);
    const numbers = result.firstSno && result.lastSno && result.added
      ? `, numbered ${result.firstSno}${result.lastSno > result.firstSno ? `–${result.lastSno}` : ''}`
      : '';

    if (result.continued) {
      botBubble('bot', result.added
        ? `${plural(result.added, 'scenario')} added to the end of "${result.enhancement.name}"${numbers}.`
        : `Nothing new to add — "${result.enhancement.name}" already covers all ${plural(result.skipped, 'scenario')}.`);
    } else {
      botBubble('bot', `${plural(result.added, 'scenario')} ${result.appended ? 'added to' : 'saved as'} "${result.enhancement.name}" under ${where} Migration Scenarios${numbers}.`);
    }

    if (result.skipped && result.added) {
      botBubble('bot', `${plural(result.skipped, 'scenario')} skipped — already in the set.`);
    }

    /* The button said "Saving…" from the moment it was pressed and was
       never told the saving had finished, so a set that was filed minutes
       ago still looked as though it were in flight. */
    button.textContent = result.added ? `Saved ${plural(result.added, 'scenario')}` : 'Nothing to add';

    botOpenLink(result.enhancement.id, result.enhancement.name);

    if (result.added) {
      botBubble('bot', 'Writing the detailed test cases for them now — they will fill in on the page.');
      startTestCaseRun(result.enhancement.id, false);
    }

    await loadProducts();
    if (state.view === 'enhancements' && state.product === draft.product) await openProduct(draft.product);
    else if (state.view === 'dashboard') renderDashboard();
    toast(`${plural(result.added, 'scenario')} saved to ${where}.`);
  } catch (err) {
    button.disabled = false;
    button.textContent = previous;
    botBubble('bot', err.message, 'is-error');
  }
}

/** A link in the chat through to the scenarios that were just saved. */
function botOpenLink(id, name) {
  const row = document.createElement('div');
  row.className = 'bot-actions';

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'bot-action is-primary';
  open.textContent = 'Open it';
  open.title = name;
  open.addEventListener('click', () => {
    toggleBot(false);
    openEnhancement(id);
  });
  row.appendChild(open);

  el('botLog').appendChild(row);
  el('botLog').scrollTop = el('botLog').scrollHeight;
}

/** The row of actions under a drafted answer. */
function botDraftActions(draft) {
  const wrap = document.createElement('div');
  wrap.className = 'bot-actions';

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'bot-action is-primary';
  save.textContent = draft.enhancementId
    ? `Adding to ${draft.name}…`
    : `Saving to ${productLabel(draft.product)}…`;
  save.disabled = true;
  wrap.appendChild(save);

  const csv = document.createElement('button');
  csv.type = 'button';
  csv.className = 'bot-action';
  csv.textContent = 'Download CSV';
  csv.addEventListener('click', () => downloadCsv(draft));
  wrap.appendChild(csv);

  const count = document.createElement('span');
  count.className = 'bot-actions-note';
  count.textContent = plural(draft.scenarios.length, 'scenario');
  wrap.appendChild(count);

  el('botLog').appendChild(wrap);
  el('botLog').scrollTop = el('botLog').scrollHeight;
  return save;
}

/** First open: say what it can do, and offer a few one-tap questions. */
function botGreet() {
  if (bot.greeted) return;
  bot.greeted = true;

  botBubble('bot', 'Hello. Ask me anything about the scenarios, results or documents in this tool.');

  const chips = document.createElement('div');
  chips.className = 'bot-chips';
  BOT_SUGGESTIONS.forEach((text) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'bot-chip';
    chip.textContent = text;
    chip.addEventListener('click', () => {
      chips.remove();
      askBot(text);
    });
    chips.appendChild(chip);
  });
  el('botLog').appendChild(chips);
}

function toggleBot(force) {
  bot.open = typeof force === 'boolean' ? force : !bot.open;
  el('botPanel').hidden = !bot.open;
  el('botLauncher').setAttribute('aria-expanded', bot.open ? 'true' : 'false');
  el('botLauncher').classList.toggle('is-open', bot.open);
  if (bot.open) {
    botGreet();
    setTimeout(() => el('botInput').focus(), 40);
  }
}

async function askBot(question) {
  const text = String(question || '').trim();
  if (!text || bot.busy) return;

  bot.busy = true;
  el('botSend').disabled = true;
  el('botInput').value = '';

  const sent = bot.files.slice();
  bot.files = [];
  renderBotFiles();

  botBubble('user', sent.length ? `${text}\n\n${sent.map((f) => `📎 ${f.name}`).join('\n')}` : text);

  const thinking = botBubble('bot', 'Looking through the tool\u2026', 'is-thinking');

  try {
    const form = new FormData();
    form.append('question', text);
    form.append('history', JSON.stringify(bot.history));
    if (state.product) form.append('currentProduct', state.product);

    // reading a set of scenarios means the next ones belong on the end of it
    if (state.view === 'scenarios' && state.enhancement) {
      form.append('currentEnhancement', state.enhancement.id);
    }
    sent.forEach((file) => form.append('files', file, file.name));

    // no Content-Type header: the browser sets the multipart boundary
    const result = await api('/api/assistant', { method: 'POST', body: form });

    thinking.remove();

    (result.attachments || [])
      .filter((a) => a.kind === 'skipped')
      .forEach((a) => botBubble('bot', `📎 ${a.name} — ${a.note}`, 'is-error'));

    /* A write-up attached to the message has been kept, not just read. */
    (result.documents || []).forEach((doc) => {
      botBubble('bot', doc.replaced
        ? `"${doc.name}" updated under ${productLabel(doc.product)} documents.`
        : `"${doc.name}" filed under ${productLabel(doc.product)} documents.`);
    });

    if (result.documents && result.documents.length) await loadProducts();

    botBubble('bot', result.answer);

    if (result.command) {
      bot.history.push({ role: 'user', content: text });
      bot.history.push({ role: 'assistant', content: result.answer });
      bot.history = bot.history.slice(-8);

      /* Nothing matched what was asked for, so the candidates are offered
         rather than the instruction refused. */
      if (!result.target) {
        if (result.choices && result.choices.length) offerChoices(result.command, result.choices);
        return;
      }

      if (result.command.confirm) askToConfirm(result.command, result.target);
      else await runCommand(result.command, result.target);
      return;
    }

    /* One set per write-up, when the question spanned several of them. */
    if (result.drafts && result.drafts.length) {
      await saveDrafts(result.drafts);
    } else if (result.draft && result.draft.scenarios.length) {
      // drafted scenarios belong in their product's page; put them there
      await saveDraft(result.draft, botDraftActions(result.draft));
    }

    bot.history.push({ role: 'user', content: text });
    bot.history.push({ role: 'assistant', content: result.answer });
    bot.history = bot.history.slice(-8);
  } catch (err) {
    thinking.remove();
    botBubble('bot', err.message, 'is-error');

    /* Nothing reached the tool, so nothing is lost: the question goes back in
       the box and the files back in the tray, ready to send again. */
    if (!el('botInput').value.trim()) el('botInput').value = text;
    if (sent.length && !bot.files.length) {
      bot.files = sent;
      renderBotFiles();
      botBubble('bot', `${plural(sent.length, 'file')} kept — press send to try again.`);
    }
  } finally {
    bot.busy = false;
    el('botSend').disabled = false;
    el('botInput').focus();
  }
}

/* The panel can be dragged anywhere by its header, so it never sits on top of
   the row you are reading. Where you leave it is remembered for the session. */
function makeBotDraggable() {
  const panel = el('botPanel');
  const handle = el('botHead');
  let startX = 0;
  let startY = 0;
  let originX = 0;
  let originY = 0;
  let dragging = false;

  const place = (x, y) => {
    const rect = panel.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 8;
    const maxY = window.innerHeight - rect.height - 8;
    const left = Math.min(Math.max(8, x), Math.max(8, maxX));
    const top = Math.min(Math.max(8, y), Math.max(8, maxY));
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    bot.position = { left, top };
  };

  const onMove = (event) => {
    if (!dragging) return;
    event.preventDefault();
    place(originX + (event.clientX - startX), originY + (event.clientY - startY));
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove('is-dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };

  handle.addEventListener('mousedown', (event) => {
    if (event.target.closest('#botClose')) return;   // the X is not a drag handle
    const rect = panel.getBoundingClientRect();
    startX = event.clientX;
    startY = event.clientY;
    originX = rect.left;
    originY = rect.top;
    dragging = true;
    panel.classList.add('is-dragging');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    event.preventDefault();
  });

  // keep it on screen when the window changes size
  window.addEventListener('resize', () => {
    if (bot.position) place(bot.position.left, bot.position.top);
  });
}

makeBotDraggable();

el('botLauncher').addEventListener('click', () => toggleBot());
el('botClose').addEventListener('click', () => toggleBot(false));
el('botForm').addEventListener('submit', (event) => {
  event.preventDefault();
  askBot(el('botInput').value);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && bot.open) toggleBot(false);
});

(async function init() {
  try {
    await loadProducts();
    const route = hashToRoute(location.hash);
    history.replaceState(route, '', routeToHash(route));
    await applyRoute(route);
  } catch (err) {
    toast(`Unable to reach the server: ${err.message}`, true);
  }
})();
