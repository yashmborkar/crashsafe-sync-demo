const byId = id => document.getElementById(id);
const actionButtons = [...document.querySelectorAll('[data-action]')];
const segments = [...byId('meter').children];
const storageKey = 'crashsafe-demo-v1';
const statusLabels = {
  loading: 'Connecting',
  ready: 'Ready to import',
  running: 'Sync in progress',
  paused: 'Paused at checkpoint',
  'rolled-back': 'Page rolled back',
  completed: 'Import complete',
  error: 'Dashboard unavailable',
};

function newRun() {
  return { id: crypto.randomUUID(), activity: [] };
}

function loadRun() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey));
    if (saved?.id && Array.isArray(saved.activity)) return saved;
  } catch {
    // The demo remains usable when browser storage is unavailable.
  }
  return newRun();
}

function saveRun() {
  try {
    sessionStorage.setItem(storageKey, JSON.stringify(run));
  } catch {
    // Storage is only for keeping the same run and activity across a reload.
  }
}

let run = loadRun();
let snapshot;
let pending = false;
let unavailable = false;
saveRun();

function element(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

function setStatus(state) {
  byId('status').dataset.state = state;
  byId('status-label').textContent = statusLabels[state];
}

function updateControls() {
  for (const button of actionButtons) {
    button.disabled = pending || unavailable || !snapshot || snapshot.status === 'completed';
  }
  byId('restart').disabled = pending;
  byId('refresh').disabled = pending;
}

function pair(id, value, total) {
  byId(id).replaceChildren(document.createTextNode(String(value) + ' '), element('small', '/ ' + total));
}

function renderSnapshot() {
  if (!snapshot) {
    for (const id of ['count', 'pages', 'checkpoint', 'percent']) byId(id).textContent = '—';
    byId('checkpoint-help').textContent = 'Continuation cursor in PostgreSQL';
    byId('progress-label').textContent = 'Waiting for database';
  } else {
    const { checkpoint, status, customers, pagesCommitted, totalPages, totalCustomers } = snapshot;
    pair('count', customers.length, totalCustomers);
    pair('pages', pagesCommitted, totalPages);
    byId('checkpoint').textContent = checkpoint === null ? 'null' : `{ "offset": ${checkpoint.offset} }`;
    byId('checkpoint-help').textContent = status === 'completed' ? 'Source exhausted'
      : checkpoint === null ? 'Start of source' : 'Next source page starts here';
    byId('percent').textContent = `${Math.round(customers.length / totalCustomers * 100)}%`;
    byId('progress-label').textContent = status === 'completed' ? 'All pages committed'
      : pagesCommitted === 0 ? 'Waiting for first page'
        : `Page ${pagesCommitted + 1} is next`;
  }
  byId('meter').setAttribute('aria-valuenow', snapshot?.customers.length ?? 0);
  byId('meter').classList.toggle('complete', snapshot?.status === 'completed');
  segments.forEach((segment, index) => segment.classList.toggle('committed', index < (snapshot?.pagesCommitted ?? 0)));

  const rows = (snapshot?.customers ?? []).map(customer => {
    const row = document.createElement('tr');
    row.append(...[customer.id, customer.name, customer.email, customer.company].map(value => element('td', value)));
    return row;
  });
  byId('customer-rows').replaceChildren(...rows);
  byId('empty').hidden = rows.length > 0;
  byId('table-wrap').hidden = rows.length === 0;
}

function renderActivity() {
  const entries = run.activity.map(item => {
    const entry = document.createElement('li');
    entry.dataset.kind = item.kind;
    entry.append(element('strong', item.title), element('p', item.detail));
    return entry;
  });
  byId('activity').replaceChildren(...entries);
  byId('activity-empty').hidden = entries.length > 0;
}

function addActivity(kind, title, detail) {
  run.activity.unshift({ kind, title, detail, pages: snapshot.pagesCommitted });
  run.activity = run.activity.slice(0, 12);
  saveRun();
  renderActivity();
}

async function request(action) {
  const suffix = action ? '/' + action : '';
  const response = await fetch(`/api/runs/${run.id}${suffix}`, {
    method: action ? 'POST' : 'GET',
    headers: action ? { 'X-Demo-Action': '1' } : undefined,
  });
  const payload = await response.json();
  if (!response.ok && !['rolled-back', 'busy'].includes(payload.outcome)) {
    throw new Error(payload.error || 'Failed to load the demo dashboard.');
  }
  return payload;
}

async function perform(action) {
  if (pending) return;
  pending = true;
  updateControls();
  byId('action-error').hidden = true;
  byId('refresh').hidden = true;
  setStatus(action ? 'running' : 'loading');
  try {
    const data = await request(action);
    snapshot = action ? data.snapshot : data;
    unavailable = false;
    renderSnapshot();
    if (data.outcome === 'rolled-back') {
      const { attemptedWrites, sqlState, startCheckpoint } = data.failure;
      const offset = startCheckpoint?.offset ?? 0;
      const page = offset / snapshot.pageSize + 1;
      const cursor = startCheckpoint === null ? 'null' : `offset ${offset}`;
      addActivity('rolled-back', `Page ${page} rolled back`,
        `PostgreSQL error ${sqlState} rolled back ${attemptedWrites} UPSERTs. That page left the checkpoint at ${cursor}.`);
    } else if (data.outcome === 'busy') {
      addActivity('busy', 'Sync already running', 'Another worker owns this run. Refresh to see its progress.');
      byId('refresh').hidden = false;
    } else if (action && data.result.pagesProcessed > 0) {
      const { pagesProcessed, recordsProcessed, pagesCommitted, checkpoint } = data.result;
      if (data.outcome === 'completed') {
        addActivity('completed', 'Import complete',
          `Committed ${pagesProcessed} page${pagesProcessed === 1 ? '' : 's'} in this run. PostgreSQL contains ${snapshot.customers.length} unique customer IDs.`);
      } else {
        addActivity('paused', `Page ${pagesCommitted} committed`,
          `${recordsProcessed} customers committed. Next checkpoint is offset ${checkpoint.offset}.`);
      }
    }
    const latest = run.activity[0];
    const rollbackVisible = latest?.kind === 'rolled-back' && latest.pages === snapshot.pagesCommitted
      && ['ready', 'paused'].includes(snapshot.status);
    setStatus(rollbackVisible ? 'rolled-back' : snapshot.status);
  } catch (error) {
    unavailable = true;
    byId('action-error').textContent = error.message;
    byId('action-error').hidden = false;
    byId('refresh').hidden = false;
    setStatus('error');
  } finally {
    pending = false;
    updateControls();
  }
}

for (const button of actionButtons) {
  button.addEventListener('click', () => perform(button.dataset.action));
}
byId('refresh').addEventListener('click', () => perform());
byId('restart').addEventListener('click', () => {
  if (pending) return;
  run = newRun();
  snapshot = undefined;
  saveRun();
  renderActivity();
  renderSnapshot();
  void perform();
});

renderActivity();
void perform();
