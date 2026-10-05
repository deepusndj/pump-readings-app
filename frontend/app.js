// Pump Readings — standalone frontend talking to the FastAPI backend over
// /api/*. Ported from the original Claude-Artifact version. Core scope only:
// Readings, Cost (employee entry + owner month-grid), Stock, History, and
// the owner password gate. The AI Assistant tab is intentionally omitted.

const PUMPS = [
  { id: 'petrolA1', label: 'Petrol A1', fuel: 'petrol' },
  { id: 'petrolA2', label: 'Petrol A2', fuel: 'petrol' },
  { id: 'petrolB1', label: 'Petrol B1', fuel: 'petrol' },
  { id: 'petrolB2', label: 'Petrol B2', fuel: 'petrol' },
  { id: 'dieselA1', label: 'Diesel A1', fuel: 'diesel' },
  { id: 'dieselA2', label: 'Diesel A2', fuel: 'diesel' },
  { id: 'dieselB1', label: 'Diesel B1', fuel: 'diesel' },
  { id: 'dieselB2', label: 'Diesel B2', fuel: 'diesel' },
];

const COST_CATEGORIES = ['Fuel Purchase', 'Salary', 'Electricity', 'Minor Tools', 'Rent for Swiping Machines', 'Tea', 'Watercan', 'Cleaning', 'Miscellaneous', 'Other'];
// "Fuel Purchase" is auto-derived from Stock entries server-side — never a
// manually editable column in the owner's cost grid.
const COST_TABLE_CATEGORIES = COST_CATEGORIES.filter(c => c !== 'Fuel Purchase');
const FUEL_TANKS = [{ id: 'petrol', label: 'Petrol tank', fuel: 'petrol' }, { id: 'diesel', label: 'Diesel tank', fuel: 'diesel' }];

let appRole = null; // 'employee' | 'owner'

// Owner password is kept in memory only (never persisted to localStorage or
// sessionStorage) so it's needed to authenticate API calls during the
// current session, but is always gone on a fresh page load/app reopen —
// the owner password prompt is asked again every time, by design.
let ownerPasswordMem = null;

let state = {
  date: todayStr(),
  pumps: {},
  existingDoc: null,
  prevFinal: {},
  overrides: {},
  confirmedFlags: {},
  fieldEdit: null,
  name: '',
};

let costFormState = { date: todayStr(), category: COST_TABLE_CATEGORIES[0], amount: '', note: '' };
let stockFormState = { date: todayStr() };
let costTableState = { month: monthKey(todayStr()) };
let stockTableState = { month: monthKey(todayStr()) };
let historyState = { from: '', to: '' };
let ratesCache = null;

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

function ownerHeaders(extra) {
  const h = Object.assign({ 'Content-Type': 'application/json' }, extra || {});
  if (ownerPasswordMem) h['X-Owner-Password'] = ownerPasswordMem;
  return h;
}

async function api(method, path, body, needsOwner) {
  const opts = { method, headers: needsOwner ? ownerHeaders() : { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch('/api' + path, opts);
  if (res.status === 404) return null;
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).detail || ''; } catch (e) {}
    throw new Error(detail || ('Request failed (' + res.status + ')'));
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function todayStr() {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 10);
}

function fmt(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function monthKey(dateStr) { return dateStr.slice(0, 7); }

function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

function shiftMonth(key, delta) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

async function getRates() {
  if (ratesCache) return ratesCache;
  try {
    ratesCache = await api('GET', '/settings/rates');
  } catch (e) {
    ratesCache = null;
  }
  if (!ratesCache) {
    ratesCache = { petrol: 110, diesel: 99, marginPetrol: 2.75, marginDiesel: 2.22, petrolDepreciation: 0.24, purchaseCostPetrol: 107.25, purchaseCostDiesel: 96.78 };
  }
  return ratesCache;
}

// ---------------------------------------------------------------------------
// READINGS tab
// ---------------------------------------------------------------------------

function computeLitres(pumpId) {
  const v = state.pumps[pumpId];
  if (v.final === null || v.final === undefined || v.initial === null || v.initial === undefined) {
    return { litres: null, negative: false };
  }
  // Round to 2dp — meter readings only have cents-level precision, and raw
  // float subtraction (e.g. 97921.04 - 97858.93) produces noise like
  // 62.11000000000058 that would otherwise get stored and shown verbatim.
  const raw = Math.round((v.final - v.initial - (v.test || 0)) * 100) / 100;
  const negative = (v.final - v.initial) < 0;
  return { litres: raw, negative };
}

async function loadPrevAndCurrent(dateStr) {
  // Most recent 30 readings strictly before this date, to carry yesterday's
  // "final" forward as today's "initial" — looked up separately from the
  // target date's own doc so older dates still resolve correctly.
  const [existing, recent] = await Promise.all([
    api('GET', '/readings/' + dateStr),
    api('GET', '/readings?to=' + dateStr + '&limit=31'),
  ]);
  const prevDoc = (recent || []).filter(d => d.date < dateStr).sort((a, b) => a.date < b.date ? 1 : -1)[0] || null;
  const prevFinal = {};
  PUMPS.forEach(p => {
    prevFinal[p.id] = prevDoc && prevDoc.pumps && prevDoc.pumps[p.id] ? prevDoc.pumps[p.id].final : null;
  });
  return { existing, prevFinal };
}

// ---------------------------------------------------------------------------
// Missing-days note (employee view only). Entry for day D is only ever made
// on day D+1 ("today's readings get entered tomorrow"), so a day only
// counts as "missed" once a full day has passed without it being entered —
// today itself is never flagged, only yesterday and earlier.
// ---------------------------------------------------------------------------

const MISSING_DAYS_LOOKBACK = 14;

function addDaysStr(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d + delta);
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
}

function shortDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

async function renderMissingDaysNote() {
  const el = document.getElementById('missingDaysNote');
  if (!el) return;
  if (appRole !== 'employee') { el.classList.add('hidden'); el.innerHTML = ''; return; }

  const today = todayStr();
  const rangeTo = addDaysStr(today, -1); // yesterday — today isn't due yet
  const rangeFrom = addDaysStr(today, -MISSING_DAYS_LOOKBACK);

  try {
    const rows = await api('GET', '/readings?from=' + rangeFrom + '&to=' + rangeTo);
    const present = new Set((rows || []).map(r => r.date));
    const missing = [];
    for (let d = rangeFrom; d <= rangeTo; d = addDaysStr(d, 1)) {
      if (!present.has(d)) missing.push(d);
    }
    if (!missing.length) { el.classList.add('hidden'); el.innerHTML = ''; return; }

    missing.reverse(); // most recent first
    const shown = missing.slice(0, 6);
    const rest = missing.length - shown.length;
    el.innerHTML = `
      <div class="missing-note">
        <span class="missing-note-label">${missing.length === 1 ? 'Missing day' : 'Missing days'}:</span>
        ${shown.map(d => `<span class="missing-chip">${shortDay(d)}</span>`).join('')}
        ${rest > 0 ? `<span class="missing-chip more">+${rest} more</span>` : ''}
      </div>`;
    el.classList.remove('hidden');
  } catch (e) {
    el.classList.add('hidden');
    el.innerHTML = '';
  }
}

async function renderEntryForDate(dateStr) {
  state.date = dateStr;
  const body = document.getElementById('entryBody');
  body.innerHTML = '<div class="loading">Loading readings&hellip;</div>';
  document.getElementById('saveBtn').disabled = true;
  renderMissingDaysNote();

  let existing, prevFinal;
  try {
    const r = await loadPrevAndCurrent(dateStr);
    existing = r.existing; prevFinal = r.prevFinal;
  } catch (e) {
    body.innerHTML = '<div class="empty-state">Could not load readings — try again.</div>';
    return;
  }

  state.existingDoc = existing;
  state.prevFinal = prevFinal;
  state.overrides = {};
  state.confirmedFlags = {};
  state.fieldEdit = null;
  state.pumps = {};

  PUMPS.forEach(p => {
    if (existing && existing.pumps && existing.pumps[p.id]) {
      const saved = existing.pumps[p.id];
      state.pumps[p.id] = { initial: saved.initial, final: saved.final, test: saved.test };
      if (saved.confirmedReset) state.confirmedFlags[p.id] = true;
      if (saved.overridden) state.overrides[p.id] = true;
    } else {
      state.pumps[p.id] = { initial: prevFinal[p.id], final: null, test: 0 };
    }
  });
  state.name = existing ? (existing.enteredBy || '') : '';

  updateStatusChip();
  renderEntryBody();
}

function fieldLabel(field) {
  return field === 'initial' ? 'Initial' : field === 'final' ? 'Final' : 'Test L';
}

// A field is "locked behind Edit" once the day is already saved. Initial is
// owner-only; final/test can be opened by either role. Not-yet-saved days
// behave exactly as before — free typing, no confirmation needed.
function fieldPermission(field) {
  const isSavedDay = !!state.existingDoc;
  if (!isSavedDay) return { locked: false, editable: true, ownerOnly: false };
  const ownerOnly = field === 'initial';
  const editable = appRole === 'owner' || !ownerOnly;
  const isEditingThis = state.fieldEdit && state.fieldEdit.field === field;
  return { locked: editable && !isEditingThis, editable, ownerOnly, isEditingThis };
}

function renderEntryBody() {
  const body = document.getElementById('entryBody');
  let html = '';
  const isSavedDay = !!state.existingDoc;

  ['petrol', 'diesel'].forEach(fuel => {
    html += `<div class="section-label ${fuel}"><span class="dot"></span>${fuel === 'petrol' ? 'Petrol' : 'Diesel'}</div>`;
    PUMPS.filter(p => p.fuel === fuel).forEach(p => {
      const v = state.pumps[p.id];
      const { litres, negative } = computeLitres(p.id);
      const flagged = negative && !state.confirmedFlags[p.id];
      const unlocked = state.overrides[p.id];

      const fieldHtml = (field, labelText, placeholder) => {
        const perm = fieldPermission(field);
        const isEditingThisField = state.fieldEdit && state.fieldEdit.pumpId === p.id && state.fieldEdit.field === field;
        // Not-yet-saved day: original free-typing behaviour (initial still
        // respects the reset "unlock" checkbox; final/test always free).
        if (!isSavedDay) {
          const readonlyAttr = (field === 'initial' && !unlocked) ? 'readonly' : '';
          return `<div class="field">
            <label>${labelText}</label>
            <input type="text" inputmode="decimal" pattern="[0-9]*\\.?[0-9]*" ${readonlyAttr}
              value="${v[field] === null || v[field] === undefined ? '' : v[field]}"
              placeholder="${placeholder || ''}"
              data-role="${field}" data-pump="${p.id}">
          </div>`;
        }
        // Saved day: locked behind an explicit Edit, with a Clear option,
        // both gated by fieldPermission() and both confirmed before applying.
        const ownerLockIcon = perm.ownerOnly && appRole !== 'owner'
          ? `<svg class="lock-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="4" y="11" width="16" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>` : '';
        const readonlyAttr = (!perm.editable || !isEditingThisField) ? 'readonly' : '';
        const inputClass = !perm.editable ? 'locked-field' : (isEditingThisField ? 'editing-field' : 'locked-field');
        let actions = '';
        if (perm.editable) {
          actions = isEditingThisField
            ? `<div class="field-actions">
                 <button class="pill-btn save" data-act="fcApply" data-pump="${p.id}" data-field="${field}">✓ Save change</button>
                 <button class="pill-btn cancel" data-act="fcCancelEdit" data-pump="${p.id}" data-field="${field}">Cancel</button>
               </div>`
            : `<div class="field-actions">
                 <button class="pill-btn edit" data-act="fcEdit" data-pump="${p.id}" data-field="${field}">✎ Edit</button>
                 <button class="pill-btn clear" data-act="fcClear" data-pump="${p.id}" data-field="${field}">🗑 Clear</button>
               </div>`;
        }
        return `<div class="field">
          <label>${labelText} ${ownerLockIcon}</label>
          <input type="text" inputmode="decimal" pattern="[0-9]*\\.?[0-9]*" ${readonlyAttr} class="${inputClass}"
            value="${v[field] === null || v[field] === undefined ? '' : v[field]}"
            data-role="${field}" data-pump="${p.id}">
          ${actions}
        </div>`;
      };

      html += `<div class="pump-card ${flagged ? 'flag' : ''}" data-pump="${p.id}">
        <div class="pump-head">
          <div class="pump-name">${p.label}</div>
          <div class="pump-litres ${flagged ? 'flag' : ''}">${litres === null ? 'enter reading' : (negative && state.confirmedFlags[p.id] ? 'reset — 0 L' : fmt(litres) + ' L')}</div>
        </div>
        <div class="field-grid">
          ${fieldHtml('initial', 'Initial', v.initial === null ? 'no history' : '')}
          ${fieldHtml('final', 'Final', "today's reading")}
          ${fieldHtml('test', 'Test L', '')}
        </div>
        ${flagged ? `
        <div class="flag-note">
          This reading is lower than yesterday's — the meter may have been reset or replaced.
          <label><input type="checkbox" data-role="confirm" data-pump="${p.id}"> Yes, this is a real reset — count today as 0 L and continue from here</label>
          <label><input type="checkbox" data-role="unlock" data-pump="${p.id}"> Let me fix the initial reading instead (typo)</label>
        </div>` : (v.initial === null && v.final !== null ? `
        <div class="flag-note" style="color:var(--text-dim);background:var(--surface-raised)">
          No previous reading found for this pump — enter its starting meter value.
        </div>` : '')}
        ${isSavedDay && appRole !== 'owner' ? `
        <div class="locked-note"><svg class="lock-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="4" y="11" width="16" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg> Initial reading is locked — ask the owner to change it if it's wrong.</div>` : ''}
      </div>`;
    });
  });

  let allFilled = true, anyUnresolvedFlag = false;
  PUMPS.forEach(p => {
    const { litres, negative } = computeLitres(p.id);
    if (litres === null) { allFilled = false; return; }
    if (negative && !state.confirmedFlags[p.id]) { anyUnresolvedFlag = true; }
  });

  html += `<div class="name-field">
    <label>Entered by</label>
    <input type="text" id="nameInput" placeholder="Staff name" value="${state.name || ''}">
  </div>`;

  if (isSavedDay && appRole === 'owner') {
    html += `<div class="danger-zone">
      <h4>Delete this day's readings</h4>
      <p>Permanently removes the saved reading for <b>${state.date}</b> for every pump. Employees cannot do this — only the owner.</p>
      <button class="danger-btn" id="deleteDayBtn">Delete ${state.date} readings</button>
    </div>`;
  }

  body.innerHTML = html;
  attachEntryListeners();
  updateSaveButton(allFilled, anyUnresolvedFlag);
}

function attachEntryListeners() {
  document.querySelectorAll('#entryBody input[data-role]').forEach(input => {
    input.addEventListener('input', onFieldChange);
    input.addEventListener('change', onFieldChange);
  });
  const nameInput = document.getElementById('nameInput');
  if (nameInput) nameInput.addEventListener('input', e => { state.name = e.target.value; });

  document.querySelectorAll('#entryBody button[data-act]').forEach(btn => {
    btn.addEventListener('click', onFieldEditAction);
  });
  const deleteBtn = document.getElementById('deleteDayBtn');
  if (deleteBtn) deleteBtn.addEventListener('click', onDeleteDayClick);
}

// ---------- saved-reading edit / clear / delete-day ----------

function onFieldEditAction(e) {
  const act = e.currentTarget.dataset.act;
  const pumpId = e.currentTarget.dataset.pump;
  const field = e.currentTarget.dataset.field;

  if (act === 'fcEdit') {
    state.fieldEdit = { pumpId, field };
    renderEntryBody();
    const input = document.querySelector(`input[data-pump="${pumpId}"][data-role="${field}"]`);
    if (input) { input.focus(); input.select(); }
    return;
  }

  if (act === 'fcCancelEdit') {
    const saved = state.existingDoc && state.existingDoc.pumps && state.existingDoc.pumps[pumpId];
    state.pumps[pumpId][field] = saved ? saved[field] : state.pumps[pumpId][field];
    state.fieldEdit = null;
    renderEntryBody();
    return;
  }

  if (act === 'fcApply') {
    const input = document.querySelector(`input[data-pump="${pumpId}"][data-role="${field}"]`);
    const raw = input.value;
    const newVal = raw === '' ? null : parseFloat(raw);
    if (raw !== '' && isNaN(newVal)) { input.focus(); return; }
    const saved = state.existingDoc && state.existingDoc.pumps && state.existingDoc.pumps[pumpId];
    const oldVal = saved ? saved[field] : state.pumps[pumpId][field];
    const pumpLabel = (PUMPS.find(p => p.id === pumpId) || {}).label || pumpId;
    openConfirmModal({
      title: 'Confirm saved-reading change',
      body: `You're about to change <b>${fieldLabel(field)}</b> for <b>${pumpLabel}</b> on <b>${state.date}</b> from <b>${fmt(oldVal)}</b> to <b>${newVal === null ? '—' : fmt(newVal)}</b>. This reading was already saved — please confirm.`,
      confirmLabel: 'Confirm change',
      neutral: true,
      onConfirm: async () => {
        state.pumps[pumpId][field] = newVal;
        state.fieldEdit = null;
        await saveReadings();
        renderEntryBody();
        showFcToast(`${pumpLabel} ${fieldLabel(field)} updated`);
      },
    });
    return;
  }

  if (act === 'fcClear') {
    const saved = state.existingDoc && state.existingDoc.pumps && state.existingDoc.pumps[pumpId];
    const oldVal = saved ? saved[field] : state.pumps[pumpId][field];
    const pumpLabel = (PUMPS.find(p => p.id === pumpId) || {}).label || pumpId;
    openConfirmModal({
      title: 'Clear this reading?',
      body: `You're about to clear the <b>${fieldLabel(field)}</b> value for <b>${pumpLabel}</b> on <b>${state.date}</b> (currently <b>${fmt(oldVal)}</b>). You'll need to re-enter it. This can't be undone.`,
      confirmLabel: 'Clear value',
      neutral: false,
      onConfirm: async () => {
        state.pumps[pumpId][field] = field === 'test' ? 0 : null;
        state.fieldEdit = { pumpId, field }; // leave it open for immediate re-entry
        await saveReadings();
        renderEntryBody();
        const input = document.querySelector(`input[data-pump="${pumpId}"][data-role="${field}"]`);
        if (input) input.focus();
        showFcToast(`${pumpLabel} ${fieldLabel(field)} cleared`);
      },
    });
    return;
  }
}

function onDeleteDayClick() {
  openConfirmModal({
    title: "Delete this day's readings?",
    body: `This permanently deletes the saved reading for <b>every pump</b> on <b>${state.date}</b>, including initial, final and test values. This cannot be undone.`,
    confirmLabel: 'Delete readings',
    neutral: false,
    onConfirm: async () => {
      await api('DELETE', '/readings/' + state.date, undefined, true);
      showFcToast(`${state.date} readings deleted`);
      await renderEntryForDate(state.date);
    },
  });
}

// ---------- lightweight confirm modal + toast (Readings tab only) ----------

let fcPendingConfirm = null;

function openConfirmModal({ title, body, confirmLabel, neutral, onConfirm }) {
  document.getElementById('fcModalTitle').textContent = title;
  document.getElementById('fcModalBody').innerHTML = body;
  const confirmBtn = document.getElementById('fcModalConfirm');
  confirmBtn.textContent = confirmLabel;
  confirmBtn.className = 'fc-btn-confirm' + (neutral ? ' neutral' : '');
  fcPendingConfirm = onConfirm;
  document.getElementById('fcModalBackdrop').classList.add('show');
}

function closeConfirmModal() {
  document.getElementById('fcModalBackdrop').classList.remove('show');
  fcPendingConfirm = null;
}

function showFcToast(msg) {
  const t = document.getElementById('fcToast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(window._fcToastTimer);
  window._fcToastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

function onFieldChange(e) {
  const role = e.target.dataset.role;
  const pumpId = e.target.dataset.pump;
  const isLiveTyping = e.type === 'input' && (role === 'initial' || role === 'final' || role === 'test');
  const focusInfo = isLiveTyping ? {
    role, pumpId, selStart: e.target.selectionStart, selEnd: e.target.selectionEnd,
  } : null;

  if (role === 'initial' || role === 'final' || role === 'test') {
    const raw = e.target.value;
    const parsed = raw === '' ? null : parseFloat(raw);
    state.pumps[pumpId][role] = (parsed === null || isNaN(parsed)) ? (raw === '' ? null : state.pumps[pumpId][role]) : parsed;
    if (role === 'initial') state.overrides[pumpId] = true;
  } else if (role === 'confirm') {
    state.confirmedFlags[pumpId] = e.target.checked;
  } else if (role === 'unlock') {
    if (e.target.checked) state.overrides[pumpId] = true;
  }
  renderEntryBody();
  if (focusInfo) restoreFieldFocus(focusInfo);
}

function restoreFieldFocus({ role, pumpId, selStart, selEnd }) {
  const el = document.querySelector(`#entryBody input[data-role="${role}"][data-pump="${pumpId}"]`);
  if (!el) return;
  el.focus();
  try { el.setSelectionRange(selStart, selEnd); } catch (err) { /* ignore */ }
}

function updateSaveButton(allFilled, anyUnresolvedFlag) {
  const btn = document.getElementById('saveBtn');
  const msg = document.getElementById('saveMsg');
  btn.classList.remove('pending-review');
  if (!allFilled) {
    btn.disabled = true;
    msg.textContent = 'Enter a final reading for every pump';
    msg.className = 'save-msg';
  } else if (anyUnresolvedFlag) {
    btn.disabled = true;
    msg.textContent = 'Resolve the flagged reading(s) above before saving';
    msg.className = 'save-msg err';
  } else {
    btn.disabled = false;
    msg.textContent = '';
    msg.className = 'save-msg';
  }
}

function updateStatusChip() {
  const chip = document.getElementById('statusChip');
  if (state.existingDoc) {
    if (state.existingDoc.status === 'needs_review') {
      chip.textContent = 'Saved · flagged'; chip.className = 'status-chip review';
    } else {
      chip.textContent = 'Saved'; chip.className = 'status-chip saved';
    }
  } else {
    chip.textContent = 'Not entered'; chip.className = 'status-chip new';
  }
}

async function saveReadings() {
  const btn = document.getElementById('saveBtn');
  const msg = document.getElementById('saveMsg');
  btn.disabled = true;
  msg.textContent = 'Saving…';
  msg.className = 'save-msg';

  const pumpsOut = {};
  let anyReset = false;
  PUMPS.forEach(p => {
    const v = state.pumps[p.id];
    const { litres, negative } = computeLitres(p.id);
    const isReset = negative && state.confirmedFlags[p.id];
    if (isReset) anyReset = true;
    pumpsOut[p.id] = {
      initial: v.initial,
      final: v.final,
      test: v.test || 0,
      litres: isReset ? 0 : litres,
      confirmedReset: !!isReset,
      overridden: !!state.overrides[p.id],
    };
  });

  const petrolTotal = Math.round(PUMPS.filter(p => p.fuel === 'petrol').reduce((s, p) => s + (pumpsOut[p.id].litres || 0), 0) * 100) / 100;
  const dieselTotal = Math.round(PUMPS.filter(p => p.fuel === 'diesel').reduce((s, p) => s + (pumpsOut[p.id].litres || 0), 0) * 100) / 100;

  const data = {
    pumps: pumpsOut,
    totals: { petrol: petrolTotal, diesel: dieselTotal },
    enteredBy: state.name || '',
    status: anyReset ? 'needs_review' : 'ok',
  };

  try {
    const saved = await api('PUT', '/readings/' + state.date, data);
    state.existingDoc = saved;
    updateStatusChip();
    msg.textContent = 'Saved';
    msg.className = 'save-msg ok';
  } catch (err) {
    msg.textContent = 'Could not save — try again';
    msg.className = 'save-msg err';
  }
  btn.disabled = false;
}

// ---------------------------------------------------------------------------
// COST tab — employee one-at-a-time form
// ---------------------------------------------------------------------------

async function renderCostTab() {
  const body = document.getElementById('costBody');
  body.innerHTML = `
    <div class="simple-form">
      <div class="field"><label>Date</label><input type="date" id="costDate" value="${costFormState.date}"></div>
      <div class="field"><label>Category</label>
        <select id="costCategory">${COST_TABLE_CATEGORIES.map(c => `<option ${c === costFormState.category ? 'selected' : ''}>${c}</option>`).join('')}</select>
      </div>
      <div class="field"><label>Amount (₹)</label><input type="number" inputmode="decimal" id="costAmount" placeholder="0" value="${costFormState.amount}"></div>
      <div class="field"><label>Note (optional)</label><input type="text" id="costNote" placeholder="e.g. invoice #, vendor" value="${costFormState.note}"></div>
      <div class="field"><label>Entered by</label><input type="text" id="costEnteredBy" placeholder="Staff name"></div>
      <button class="submit-btn" id="costSubmit">Add expense</button>
      <div class="form-msg" id="costMsg"></div>
    </div>
    <div class="recent-list" id="costRecent"><div class="loading">Loading&hellip;</div></div>`;

  document.getElementById('costSubmit').addEventListener('click', saveCost);
  loadRecentCosts();
}

async function saveCost() {
  const date = document.getElementById('costDate').value;
  const category = document.getElementById('costCategory').value;
  const amount = parseFloat(document.getElementById('costAmount').value);
  const note = document.getElementById('costNote').value;
  const enteredBy = document.getElementById('costEnteredBy').value;
  const msg = document.getElementById('costMsg');
  const btn = document.getElementById('costSubmit');

  if (!date || !category || !(amount > 0)) {
    msg.textContent = 'Enter a date, category, and an amount greater than 0';
    msg.className = 'form-msg err';
    return;
  }
  btn.disabled = true;
  msg.textContent = 'Saving…'; msg.className = 'form-msg';
  try {
    await api('POST', '/costs/' + date + '/items', { category, amount, note: note || '', enteredBy: enteredBy || '' });
    costFormState = { date, category, amount: '', note: '' };
    msg.textContent = 'Saved'; msg.className = 'form-msg ok';
    document.getElementById('costAmount').value = '';
    document.getElementById('costNote').value = '';
    loadRecentCosts();
  } catch (e) {
    msg.textContent = 'Could not save — try again'; msg.className = 'form-msg err';
  }
  btn.disabled = false;
}

async function loadRecentCosts() {
  const el = document.getElementById('costRecent');
  if (!el) return;
  try {
    const docs = await api('GET', '/costs?limit=15');
    const list = (docs || []).filter(d => (d.items || []).length > 0);
    if (list.length === 0) { el.innerHTML = '<div class="empty-state">No expenses logged yet.</div>'; return; }
    el.innerHTML = list.map(c => {
      const items = Array.isArray(c.items) ? c.items : [];
      const total = items.reduce((s, it) => s + (it.amount || 0), 0);
      const breakdown = items.map(it => `${it.category} ₹${fmt(it.amount)}`).join(' · ');
      return `<div class="recent-row">
        <div class="rd-date">${c.date}</div>
        <div class="rd-main"><b>₹${fmt(total)}</b> total<div class="rd-sub">${breakdown}</div></div>
      </div>`;
    }).join('');
  } catch (e) {
    el.innerHTML = '<div class="empty-state">Couldn\'t load recent expenses.</div>';
  }
}

// ---------------------------------------------------------------------------
// COST tab — owner editable month-grid
// ---------------------------------------------------------------------------

let ownerCostCache = null;

async function renderOwnerCostTab() {
  const body = document.getElementById('costBody');
  body.innerHTML = '<div class="loading">Loading cost table&hellip;</div>';
  try {
    ownerCostCache = await api('GET', '/costs?limit=1000');
  } catch (e) {
    body.innerHTML = '<div class="empty-state">Could not load costs — try again.</div>';
    return;
  }
  drawOwnerCostTable();
}

function costGridForMonth(monKey) {
  const grid = {};
  (ownerCostCache || []).filter(c => monthKey(c.date) === monKey).forEach(c => {
    const byCat = {};
    (Array.isArray(c.items) ? c.items : []).forEach(it => {
      byCat[it.category] = (byCat[it.category] || 0) + (it.amount || 0);
    });
    grid[c.date] = byCat;
  });
  return grid;
}

// Employee-written notes per grid cell: notes[date][category] =
// { multi, lines: [{ amount, note }] }. Only cells that have at least one
// non-empty note appear, so "no entry" means "no popup".
let ownerCostNotes = {};

function costNotesForMonth(monKey) {
  const notes = {};
  (ownerCostCache || []).filter(c => monthKey(c.date) === monKey).forEach(c => {
    const items = Array.isArray(c.items) ? c.items : [];
    const countByCat = {};
    items.forEach(it => { countByCat[it.category] = (countByCat[it.category] || 0) + 1; });
    items.forEach(it => {
      const note = (it.note || '').trim();
      if (!note) return;
      notes[c.date] = notes[c.date] || {};
      const cell = notes[c.date][it.category] = notes[c.date][it.category] || { multi: countByCat[it.category] > 1, lines: [] };
      cell.lines.push({ amount: it.amount || 0, note });
    });
  });
  return notes;
}

let costNotePop = null;

function hideCostNote() {
  if (costNotePop) { costNotePop.remove(); costNotePop = null; }
}

function showCostNote(input) {
  hideCostNote();
  const cell = (ownerCostNotes[input.dataset.date] || {})[input.dataset.cat];
  if (!cell) return;
  const pop = document.createElement('div');
  pop.className = 'cost-note-pop';
  pop.setAttribute('role', 'note');
  cell.lines.forEach(l => {
    const line = document.createElement('div');
    line.className = 'cost-note-line';
    // textContent, not innerHTML: notes are free text typed by employees.
    line.textContent = cell.multi ? `₹${fmt(l.amount)} — ${l.note}` : l.note;
    pop.appendChild(line);
  });
  document.body.appendChild(pop);

  // Sit just under the cell; flip above it if there isn't room (e.g. the
  // phone keyboard is covering the bottom of the screen).
  const r = input.getBoundingClientRect();
  const viewH = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  const left = Math.min(Math.max(8, r.left + r.width / 2 - pw / 2), window.innerWidth - pw - 8);
  let top = r.bottom + 6;
  if (top + ph > viewH - 8 && r.top - ph - 6 > 8) top = r.top - ph - 6;
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
  costNotePop = pop;
}

function repositionCostNote() {
  const el = document.activeElement;
  if (costNotePop && el && el.classList && el.classList.contains('cost-cell')) showCostNote(el);
}
window.addEventListener('scroll', repositionCostNote, true);
window.addEventListener('resize', repositionCostNote);
if (window.visualViewport) window.visualViewport.addEventListener('resize', repositionCostNote);

function drawOwnerCostTable() {
  hideCostNote();
  const body = document.getElementById('costBody');
  const monKey = costTableState.month;
  const [y, m] = monKey.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const grid = costGridForMonth(monKey);
  ownerCostNotes = costNotesForMonth(monKey);
  const todayKey = todayStr();
  const isCurrentOrFutureMonth = monKey >= monthKey(todayKey);

  const colTotals = {}; COST_TABLE_CATEGORIES.forEach(c => colTotals[c] = 0);
  let grandTotal = 0;

  let rowsHtml = '';
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (dateStr > todayKey) break;
    const rowData = grid[dateStr] || {};
    let rowTotal = 0;
    const cells = COST_TABLE_CATEGORIES.map(cat => {
      const val = rowData[cat] || 0;
      rowTotal += val;
      colTotals[cat] += val;
      const hasNote = !!(ownerCostNotes[dateStr] && ownerCostNotes[dateStr][cat]);
      return `<td${hasNote ? ' class="has-note"' : ''}><input type="text" inputmode="decimal" class="cost-cell" data-date="${dateStr}" data-cat="${cat}" value="${val ? val : ''}" placeholder="–"></td>`;
    }).join('');
    grandTotal += rowTotal;
    const dow = new Date(y, m - 1, day).toLocaleDateString(undefined, { weekday: 'short' });
    rowsHtml += `<tr class="${dateStr === todayKey ? 'today-row' : ''}">
      <td class="cost-row-label">${day} <span style="color:var(--text-faint);font-weight:400;">${dow}</span></td>
      ${cells}
      <td class="cost-row-total">₹${fmt(rowTotal)}</td>
    </tr>`;
  }

  const headerCells = COST_TABLE_CATEGORIES.map(c => `<th>${c}</th>`).join('');
  const footerCells = COST_TABLE_CATEGORIES.map(c => `<td>₹${fmt(colTotals[c])}</td>`).join('');

  body.innerHTML = `
    <div class="month-nav">
      <button id="costTablePrevMonth">‹</button>
      <div class="m-label">${monthLabel(monKey)}</div>
      <button id="costTableNextMonth" ${isCurrentOrFutureMonth ? 'disabled' : ''}>›</button>
    </div>
    <div class="cost-table-hint">Tap any cell to edit that day's expense for that category. Changes save as soon as you leave the cell. A gold corner means the staff left a note — tap the cell to read it. Fuel purchase cost is tracked on the Stock tab instead.</div>
    <div class="cost-table-wrap">
      <table class="cost-table">
        <thead><tr><th class="cost-row-label">Day</th>${headerCells}<th>Total</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
        <tfoot><tr><td class="cost-row-label">Total</td>${footerCells}<td>₹${fmt(grandTotal)}</td></tr></tfoot>
      </table>
    </div>
    <div class="cost-table-note" id="costTableMsg"></div>`;

  document.getElementById('costTablePrevMonth').addEventListener('click', () => {
    costTableState.month = shiftMonth(costTableState.month, -1);
    drawOwnerCostTable();
  });
  const nextBtn = document.getElementById('costTableNextMonth');
  if (nextBtn && !nextBtn.disabled) {
    nextBtn.addEventListener('click', () => {
      costTableState.month = shiftMonth(costTableState.month, 1);
      drawOwnerCostTable();
    });
  }
  document.querySelectorAll('.cost-cell').forEach(input => {
    input.addEventListener('change', onCostCellChange);
    input.addEventListener('focus', () => showCostNote(input));
    input.addEventListener('blur', hideCostNote);
  });
}

async function onCostCellChange(e) {
  const input = e.target;
  const date = input.dataset.date;
  const cat = input.dataset.cat;
  const raw = input.value.trim();
  const amount = raw === '' ? 0 : parseFloat(raw);
  const msg = document.getElementById('costTableMsg');

  if (raw !== '' && isNaN(amount)) {
    input.value = '';
    return;
  }

  input.disabled = true;
  input.classList.add('saving');
  if (msg) { msg.textContent = 'Saving…'; msg.className = 'cost-table-note'; }
  try {
    await api('PUT', '/costs/' + date + '/category', { category: cat, amount, enteredBy: 'Owner (table edit)' }, true);
    ownerCostCache = await api('GET', '/costs?limit=1000');
    drawOwnerCostTable();
    const freshMsg = document.getElementById('costTableMsg');
    if (freshMsg) {
      freshMsg.textContent = 'Saved';
      freshMsg.className = 'cost-table-note ok';
      setTimeout(() => { if (freshMsg) freshMsg.textContent = ''; }, 1800);
    }
  } catch (err) {
    input.disabled = false;
    input.classList.remove('saving');
    if (msg) { msg.textContent = 'Could not save — try again'; msg.className = 'cost-table-note err'; }
  }
}

// ---------------------------------------------------------------------------
// STOCK tab — employee one-reading form
// ---------------------------------------------------------------------------

async function renderStockTab() {
  const body = document.getElementById('stockBody');
  body.innerHTML = `
    <div class="simple-form">
      <div class="field"><label>Date</label><input type="date" id="stockDate" value="${stockFormState.date}"></div>
      ${FUEL_TANKS.map(t => `
        <div class="fuel-block ${t.fuel}">
          <div class="fuel-block-title"><span class="dot"></span>${t.label}</div>
          <div class="two-col">
            <div class="field"><label>Dip reading (L)</label><input type="number" inputmode="decimal" id="dip_${t.id}" placeholder="litres"></div>
            <div class="field"><label>Received today (L)</label><input type="number" inputmode="decimal" id="recv_${t.id}" placeholder="0" value="0"></div>
          </div>
        </div>`).join('')}
      <div class="field"><label>Note (optional)</label><input type="text" id="stockNote" placeholder="e.g. tanker delivery ref"></div>
      <div class="field"><label>Entered by</label><input type="text" id="stockEnteredBy" placeholder="Staff name"></div>
      <button class="submit-btn" id="stockSubmit">Save stock reading</button>
      <div class="form-msg" id="stockMsg"></div>
    </div>
    <div class="recent-list" id="stockRecent"><div class="loading">Loading&hellip;</div></div>`;

  document.getElementById('stockSubmit').addEventListener('click', saveStock);
  loadRecentStock();
}

async function saveStock() {
  const date = document.getElementById('stockDate').value;
  const note = document.getElementById('stockNote').value;
  const enteredBy = document.getElementById('stockEnteredBy').value;
  const msg = document.getElementById('stockMsg');
  const btn = document.getElementById('stockSubmit');

  const tanks = {};
  let valid = !!date;
  FUEL_TANKS.forEach(t => {
    const dip = parseFloat(document.getElementById('dip_' + t.id).value);
    const recv = parseFloat(document.getElementById('recv_' + t.id).value) || 0;
    if (!(dip >= 0)) valid = false;
    tanks[t.id] = { dip: dip || 0, received: recv, note: '' };
  });
  if (!valid) {
    msg.textContent = 'Enter a dip reading for both tanks';
    msg.className = 'form-msg err';
    return;
  }
  btn.disabled = true;
  msg.textContent = 'Saving…'; msg.className = 'form-msg';
  try {
    const rates = await getRates();
    const cost = (tanks.petrol.received || 0) * rates.purchaseCostPetrol + (tanks.diesel.received || 0) * rates.purchaseCostDiesel;
    await api('PUT', '/stock/' + date, {
      petrol: tanks.petrol, diesel: tanks.diesel,
      cost, note: note || '', enteredBy: enteredBy || '',
    });
    msg.textContent = 'Saved'; msg.className = 'form-msg ok';
    loadRecentStock();
  } catch (e) {
    msg.textContent = 'Could not save — try again'; msg.className = 'form-msg err';
  }
  btn.disabled = false;
}

async function loadRecentStock() {
  const el = document.getElementById('stockRecent');
  if (!el) return;
  try {
    const docs = await api('GET', '/stock?limit=15');
    if (!docs || docs.length === 0) { el.innerHTML = '<div class="empty-state">No stock readings logged yet.</div>'; return; }
    el.innerHTML = docs.map(s => {
      const dipLine = (s.petrol?.dip != null || s.diesel?.dip != null)
        ? `Dip — Petrol <b>${s.petrol?.dip != null ? fmt(s.petrol.dip) : '—'}</b> L · Diesel <b>${s.diesel?.dip != null ? fmt(s.diesel.dip) : '—'}</b> L`
        : '';
      const recvLine = ((s.petrol?.received || 0) > 0 || (s.diesel?.received || 0) > 0)
        ? `Received — Petrol <b>${fmt(s.petrol?.received || 0)}</b> L · Diesel <b>${fmt(s.diesel?.received || 0)}</b> L${s.cost ? ` · ₹${fmt(s.cost)}` : ''}`
        : '';
      return `<div class="recent-row">
        <div class="rd-date">${s.date}</div>
        <div class="rd-main">${recvLine || dipLine || 'No movement'}
          <div class="rd-sub">${dipLine && recvLine ? dipLine + ' · ' : ''}${s.enteredBy || ''}${s.note ? ' · ' + s.note : ''}</div></div>
      </div>`;
    }).join('');
  } catch (e) {
    el.innerHTML = '<div class="empty-state">Couldn\'t load recent stock entries.</div>';
  }
}

// ---------------------------------------------------------------------------
// STOCK tab — owner editable month-grid
// ---------------------------------------------------------------------------

let ownerStockCache = null;

async function renderOwnerStockTab() {
  const body = document.getElementById('stockBody');
  body.innerHTML = '<div class="loading">Loading stock table&hellip;</div>';
  try {
    const [stock, costs, rates] = await Promise.all([
      api('GET', '/stock?limit=1000'),
      api('GET', '/costs?limit=1000'),
      getRates(),
    ]);
    ownerStockCache = stock;
    ownerCostCache = costs;
    ratesCache = rates;
  } catch (e) {
    body.innerHTML = '<div class="empty-state">Could not load stock — try again.</div>';
    return;
  }
  drawOwnerStockTable();
}

function stockGridForMonth(monKey) {
  const grid = {};
  (ownerStockCache || []).filter(s => monthKey(s.date) === monKey).forEach(s => {
    grid[s.date] = {
      petrolDip: s.petrol?.dip ?? null, petrolReceived: s.petrol?.received || 0,
      dieselDip: s.diesel?.dip ?? null, dieselReceived: s.diesel?.received || 0,
    };
  });
  return grid;
}

function fuelPurchaseByDateForMonth(monKey) {
  const fuelPurchase = {};
  (ownerCostCache || []).filter(c => monthKey(c.date) === monKey).forEach(c => {
    (Array.isArray(c.items) ? c.items : []).forEach(it => {
      if (it.category === 'Fuel Purchase') fuelPurchase[c.date] = (fuelPurchase[c.date] || 0) + (it.amount || 0);
    });
  });
  return fuelPurchase;
}

function drawOwnerStockTable() {
  const body = document.getElementById('stockBody');
  const monKey = stockTableState.month;
  const [y, m] = monKey.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const grid = stockGridForMonth(monKey);
  const fuelPurchaseByDate = fuelPurchaseByDateForMonth(monKey);
  const todayKey = todayStr();
  const isCurrentOrFutureMonth = monKey >= monthKey(todayKey);
  const rates = ratesCache || { purchaseCostPetrol: 0, purchaseCostDiesel: 0 };

  const totals = { petrolReceived: 0, dieselReceived: 0, fuelPurchase: 0 };
  let rowsHtml = '';
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (dateStr > todayKey) break;
    const row = grid[dateStr] || { petrolDip: null, petrolReceived: 0, dieselDip: null, dieselReceived: 0 };
    const fuelPurchase = fuelPurchaseByDate[dateStr] || 0;
    totals.petrolReceived += row.petrolReceived; totals.dieselReceived += row.dieselReceived;
    totals.fuelPurchase += fuelPurchase;
    const dow = new Date(y, m - 1, day).toLocaleDateString(undefined, { weekday: 'short' });
    rowsHtml += `<tr class="${dateStr === todayKey ? 'today-row' : ''}">
      <td class="cost-row-label">${day} <span style="color:var(--text-faint);font-weight:400;">${dow}</span></td>
      <td><input type="text" inputmode="decimal" class="stock-cell" data-date="${dateStr}" data-role="petrolDip" value="${row.petrolDip != null ? row.petrolDip : ''}" placeholder="–"></td>
      <td><input type="text" inputmode="decimal" class="stock-cell" data-date="${dateStr}" data-role="petrolReceived" value="${row.petrolReceived ? row.petrolReceived : ''}" placeholder="0"></td>
      <td><input type="text" inputmode="decimal" class="stock-cell" data-date="${dateStr}" data-role="dieselDip" value="${row.dieselDip != null ? row.dieselDip : ''}" placeholder="–"></td>
      <td><input type="text" inputmode="decimal" class="stock-cell" data-date="${dateStr}" data-role="dieselReceived" value="${row.dieselReceived ? row.dieselReceived : ''}" placeholder="0"></td>
      <td class="computed-cell">${fuelPurchase ? '<span class="computed-val">₹' + fmt(fuelPurchase) + '</span>' : '–'}</td>
    </tr>`;
  }

  body.innerHTML = `
    <div class="month-nav">
      <button id="stockTablePrevMonth">‹</button>
      <div class="m-label">${monthLabel(monKey)}</div>
      <button id="stockTableNextMonth" ${isCurrentOrFutureMonth ? 'disabled' : ''}>›</button>
    </div>
    <div class="cost-table-hint">Dip readings and litres received are editable per day. Receiving fuel automatically costs that delivery — petrol at ₹${fmt(rates.purchaseCostPetrol)}/L, diesel at ₹${fmt(rates.purchaseCostDiesel)}/L — as its own "Fuel Purchase" expense.</div>
    <div class="stock-table-wrap">
      <table class="stock-table">
        <thead><tr>
          <th class="cost-row-label">Day</th>
          <th class="col-petrol">Petrol dip (L)</th>
          <th class="col-petrol">Petrol recv. (L)</th>
          <th class="col-diesel">Diesel dip (L)</th>
          <th class="col-diesel">Diesel recv. (L)</th>
          <th>Fuel purchase ₹ <span style="opacity:.65;font-weight:400;">(auto)</span></th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
        <tfoot><tr>
          <td class="cost-row-label">Total</td>
          <td>–</td>
          <td>${fmt(totals.petrolReceived)} L</td>
          <td>–</td>
          <td>${fmt(totals.dieselReceived)} L</td>
          <td>₹${fmt(totals.fuelPurchase)}</td>
        </tr></tfoot>
      </table>
    </div>
    <div class="stock-table-note" id="stockTableMsg"></div>`;

  document.getElementById('stockTablePrevMonth').addEventListener('click', () => {
    stockTableState.month = shiftMonth(stockTableState.month, -1);
    drawOwnerStockTable();
  });
  const nextBtn = document.getElementById('stockTableNextMonth');
  if (nextBtn && !nextBtn.disabled) {
    nextBtn.addEventListener('click', () => {
      stockTableState.month = shiftMonth(stockTableState.month, 1);
      drawOwnerStockTable();
    });
  }
  document.querySelectorAll('.stock-cell').forEach(input => {
    input.addEventListener('change', onStockCellChange);
  });
}

async function onStockCellChange(e) {
  const input = e.target;
  const date = input.dataset.date;
  const role = input.dataset.role; // petrolDip | petrolReceived | dieselDip | dieselReceived
  const raw = input.value.trim();
  const msg = document.getElementById('stockTableMsg');

  const isDip = role === 'petrolDip' || role === 'dieselDip';
  const value = raw === '' ? (isDip ? null : 0) : parseFloat(raw);
  if (raw !== '' && isNaN(value)) { input.value = ''; return; }

  input.disabled = true;
  input.classList.add('saving');
  if (msg) { msg.textContent = 'Saving…'; msg.className = 'stock-table-note'; }
  try {
    const existing = (ownerStockCache || []).find(s => s.date === date) || {};
    const petrol = Object.assign({ dip: null, received: 0, note: '' }, existing.petrol || {});
    const diesel = Object.assign({ dip: null, received: 0, note: '' }, existing.diesel || {});
    if (role === 'petrolDip') petrol.dip = value;
    if (role === 'petrolReceived') petrol.received = value || 0;
    if (role === 'dieselDip') diesel.dip = value;
    if (role === 'dieselReceived') diesel.received = value || 0;

    const rates = ratesCache || await getRates();
    const cost = (petrol.received || 0) * rates.purchaseCostPetrol + (diesel.received || 0) * rates.purchaseCostDiesel;

    await api('PUT', '/stock/' + date, {
      petrol, diesel, cost,
      note: existing.note || '', enteredBy: existing.enteredBy || 'Owner (table edit)',
    });

    const [stock, costs] = await Promise.all([
      api('GET', '/stock?limit=1000'),
      api('GET', '/costs?limit=1000'),
    ]);
    ownerStockCache = stock;
    ownerCostCache = costs;
    drawOwnerStockTable();
    const freshMsg = document.getElementById('stockTableMsg');
    if (freshMsg) {
      freshMsg.textContent = 'Saved';
      freshMsg.className = 'stock-table-note ok';
      setTimeout(() => { if (freshMsg) freshMsg.textContent = ''; }, 1800);
    }
  } catch (err) {
    input.disabled = false;
    input.classList.remove('saving');
    if (msg) { msg.textContent = 'Could not save — try again'; msg.className = 'stock-table-note err'; }
  }
}

// ---------------------------------------------------------------------------
// HISTORY view
// ---------------------------------------------------------------------------

async function renderHistory() {
  const body = document.getElementById('historyBody');
  body.innerHTML = `
    <div class="hist-filter-row">
      <input type="date" id="histFrom" value="${historyState.from}" placeholder="From">
      <input type="date" id="histTo" value="${historyState.to}" placeholder="To">
    </div>
    <div id="histList"><div class="loading">Loading history&hellip;</div></div>`;

  document.getElementById('histFrom').addEventListener('change', e => { historyState.from = e.target.value; loadHistoryList(); });
  document.getElementById('histTo').addEventListener('change', e => { historyState.to = e.target.value; loadHistoryList(); });

  loadHistoryList();
}

async function loadHistoryList() {
  const list = document.getElementById('histList');
  if (!list) return;
  list.innerHTML = '<div class="loading">Loading history&hellip;</div>';
  try {
    let path = '/readings?limit=60';
    if (historyState.from) path += '&from=' + historyState.from;
    if (historyState.to) path += '&to=' + historyState.to;
    const docs = await api('GET', path);
    if (!docs || docs.length === 0) {
      list.innerHTML = '<div class="empty-state">No readings saved yet.<br>Entries you save will show up here.</div>';
      return;
    }
    let html = '';
    docs.forEach(d => {
      const status = d.status === 'needs_review' ? 'review' : 'ok';
      html += `<div class="hist-row" data-date="${d.date}">
        <div class="hist-dot ${status}"></div>
        <div class="hist-date">${d.date}</div>
        <div class="hist-fig"><b>${fmt(d.totals?.petrol)}</b> L petrol · <b>${fmt(d.totals?.diesel)}</b> L diesel</div>
        <div class="hist-who">${d.enteredBy || ''}</div>
      </div>`;
    });
    list.innerHTML = html;
    list.querySelectorAll('.hist-row').forEach(row => {
      row.addEventListener('click', () => {
        document.getElementById('dateInput').value = row.dataset.date;
        switchTab('entry');
        renderEntryForDate(row.dataset.date);
      });
    });
  } catch (err) {
    list.innerHTML = '<div class="empty-state">Couldn\'t load history — try again.</div>';
  }
}

// ---------------------------------------------------------------------------
// Owner password gate
// ---------------------------------------------------------------------------

function ownerUnlocked() {
  return !!ownerPasswordMem;
}

function renderOwnerLock(body, onUnlock) {
  body.innerHTML = `
    <div class="simple-form" style="max-width:320px;margin:40px auto;">
      <div class="field"><label>Owner password</label><input type="password" id="ownerPwInput" placeholder="Enter password" autocomplete="off"></div>
      <button class="submit-btn" id="ownerPwSubmit">Unlock</button>
      <div class="form-msg" id="ownerPwMsg"></div>
    </div>`;
  const submit = () => checkOwnerPassword(onUnlock);
  document.getElementById('ownerPwSubmit').addEventListener('click', submit);
  document.getElementById('ownerPwInput').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  document.getElementById('ownerPwInput').focus();
}

async function checkOwnerPassword(onUnlock) {
  const input = document.getElementById('ownerPwInput');
  const msg = document.getElementById('ownerPwMsg');
  const pw = input.value;
  if (!pw) { msg.textContent = 'Enter the password'; msg.className = 'form-msg err'; return; }
  msg.textContent = 'Checking…'; msg.className = 'form-msg';
  try {
    const res = await fetch('/api/owner/login', { method: 'POST', headers: { 'X-Owner-Password': pw } });
    if (res.ok) {
      ownerPasswordMem = pw;
      onUnlock();
    } else {
      msg.textContent = 'Incorrect password'; msg.className = 'form-msg err';
      input.value = ''; input.focus();
    }
  } catch (e) {
    msg.textContent = 'Could not check password — try again'; msg.className = 'form-msg err';
  }
}

// ---------------------------------------------------------------------------
// ANALYSIS tab (owner only) — monthly profit/revenue summary + rates/targets
// ---------------------------------------------------------------------------

let analysisState = { month: monthKey(todayStr()), sub: 'overview' };
let targetsCache = null;

// Historical selling-rate change points, carried over from the original
// Claude-artifact version (embedded there as rateChangesData). The pump's
// selling rate has changed a handful of times; revenue for a past reading
// should use the rate that was actually in effect that day, not today's.
const RATE_CHANGES = [
  { d: '2024-08-18', p: 105.65, ds: 94.63 },
  { d: '2024-11-10', p: 105.7, ds: 94.68 },
  { d: '2025-01-01', p: 105.71, ds: 94.69 },
  { d: '2026-05-15', p: 108.98, ds: 97.85 },
  { d: '2026-05-19', p: 109.93, ds: 98.81 },
  { d: '2026-05-23', p: 110.87, ds: 99.78 },
];

function rateForDate(dateStr, fallback) {
  if (!RATE_CHANGES.length) return fallback;
  let match = null;
  for (const c of RATE_CHANGES) {
    if (c.d <= dateStr) match = c; else break;
  }
  if (!match) match = RATE_CHANGES[0];
  return { petrol: match.p, diesel: match.ds };
}

async function getTargets() {
  if (targetsCache) return targetsCache;
  try {
    targetsCache = await api('GET', '/settings/targets');
  } catch (e) {
    targetsCache = null;
  }
  if (!targetsCache) targetsCache = { petrol: 1150, diesel: 1250 };
  return targetsCache;
}

function monthDateRange(monKey) {
  const [y, m] = monKey.split('-').map(Number);
  const from = monKey + '-01';
  const lastDay = new Date(y, m, 0).getDate();
  const to = monKey + '-' + String(lastDay).padStart(2, '0');
  return { from, to };
}

// Generic grouped-bar chart — exact port of the original's svgBarChart.
// groups: [{label, values:[n,n,...]}]; seriesColors: [color,...]
function svgBarChart({ groups, seriesColors, height = 160, width = 600 }) {
  const pad = { top: 10, right: 10, bottom: 24, left: 10 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const maxVal = Math.max(1, ...groups.flatMap(g => g.values));
  const groupW = innerW / Math.max(1, groups.length);
  const seriesCount = seriesColors.length;
  const barW = Math.max(3, (groupW * 0.6) / seriesCount);
  let bars = '';
  groups.forEach((g, gi) => {
    const gx = pad.left + gi * groupW + groupW * 0.2;
    g.values.forEach((v, si) => {
      const h = (v / maxVal) * innerH;
      const x = gx + si * barW;
      const y = pad.top + innerH - h;
      bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(barW - 1.5).toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="2" fill="${seriesColors[si]}" />`;
    });
    bars += `<text x="${(gx + groupW * 0.3).toFixed(1)}" y="${height - 6}" font-size="9.5" fill="var(--text-faint)" text-anchor="middle">${g.label}</text>`;
  });
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" xmlns="http://www.w3.org/2000/svg">${bars}</svg>`;
}

// Target-vs-actual bar chart for one fuel — bars colored by whether that
// day met the target, plus a dashed target line.
function targetChart(daily, fuelKey, target, color, width) {
  if (!daily.length) return '<div class="empty-state">No readings this month yet.</div>';
  width = width || Math.max(360, daily.length * 16);
  const height = 170;
  const pad = { top: 10, right: 10, bottom: 20, left: 10 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const maxVal = Math.max(target * 1.1, 1, ...daily.map(d => d[fuelKey]));
  const slotW = innerW / daily.length;
  const barW = Math.max(2, slotW * 0.65);
  const targetY = pad.top + innerH - (target / maxVal) * innerH;
  let bars = '';
  daily.forEach((d, i) => {
    const val = d[fuelKey];
    const h = (val / maxVal) * innerH;
    const x = pad.left + i * slotW + (slotW - barW) / 2;
    const y = pad.top + innerH - h;
    const barColor = val >= target ? color : 'var(--alert)';
    bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="2" fill="${barColor}" />`;
  });
  const targetLine = `<line x1="${pad.left}" y1="${targetY.toFixed(1)}" x2="${width - pad.right}" y2="${targetY.toFixed(1)}" stroke="var(--text-dim)" stroke-width="1.5" stroke-dasharray="4,3" />` +
    `<text x="${width - pad.right}" y="${(targetY - 4).toFixed(1)}" font-size="9.5" fill="var(--text-dim)" text-anchor="end">target ${fmt(target)} L</text>`;
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" xmlns="http://www.w3.org/2000/svg">${bars}${targetLine}</svg>`;
}

async function rangeFigures(from, to) {
  const [readings, costs, rates] = await Promise.all([
    api('GET', '/readings?from=' + from + '&to=' + to + '&limit=100'),
    api('GET', '/costs?from=' + from + '&to=' + to + '&limit=100'),
    getRates(),
  ]);
  const petrolL = readings.reduce((s, r) => s + (r.totals?.petrol || 0), 0);
  const dieselL = readings.reduce((s, r) => s + (r.totals?.diesel || 0), 0);
  const revenue = readings.reduce((s, r) => {
    const rate = rateForDate(r.date, rates);
    return s + (r.totals?.petrol || 0) * rate.petrol + (r.totals?.diesel || 0) * rate.diesel;
  }, 0);
  let operatingCost = 0;
  costs.forEach(c => {
    (Array.isArray(c.items) ? c.items : []).forEach(it => {
      if (it.category !== 'Fuel Purchase') operatingCost += (it.amount || 0);
    });
  });
  const marginP = rates.marginPetrol ?? 2.75, marginD = rates.marginDiesel ?? 2.22;
  const netProfit = (petrolL * marginP + dieselL * marginD) - operatingCost;
  return { petrolL, dieselL, revenue, operatingCost, netProfit };
}

async function monthlyFigures(monKey) {
  const { from, to } = monthDateRange(monKey);
  const [readings, costs, rates] = await Promise.all([
    api('GET', '/readings?from=' + from + '&to=' + to + '&limit=100'),
    api('GET', '/costs?from=' + from + '&to=' + to + '&limit=100'),
    getRates(),
  ]);
  const petrolL = readings.reduce((s, r) => s + (r.totals?.petrol || 0), 0);
  const dieselL = readings.reduce((s, r) => s + (r.totals?.diesel || 0), 0);

  // Revenue uses the ACTUAL selling rate in effect on each day (rates
  // changed a handful of times historically) — a customer only ever pays
  // what the pump was set to that day, so this is real cash collected.
  const revenue = readings.reduce((s, r) => {
    const rate = rateForDate(r.date, rates);
    return s + (r.totals?.petrol || 0) * rate.petrol + (r.totals?.diesel || 0) * rate.diesel;
  }, 0);

  let operatingCost = 0, fuelPurchaseCost = 0;
  const costsByDate = {};
  costs.forEach(c => {
    const items = Array.isArray(c.items) ? c.items : [];
    costsByDate[c.date] = (costsByDate[c.date] || 0) + items.reduce((s, it) => s + (it.amount || 0), 0);
    items.forEach(it => {
      if (it.category === 'Fuel Purchase') fuelPurchaseCost += (it.amount || 0);
      else operatingCost += (it.amount || 0);
    });
  });

  const marginP = rates.marginPetrol ?? 2.75, marginD = rates.marginDiesel ?? 2.22;
  const fuelGrossProfit = petrolL * marginP + dieselL * marginD;
  const profit = fuelGrossProfit - operatingCost;
  const dep = rates.petrolDepreciation ?? 0.24;
  const petrolEvaporationLossL = petrolL * dep;

  const daily = readings.slice().sort((a, b) => a.date < b.date ? -1 : 1)
    .map(r => ({ date: r.date, label: r.date.slice(8, 10), petrol: r.totals?.petrol || 0, diesel: r.totals?.diesel || 0 }));

  return { petrolL, dieselL, revenue, operatingCost, fuelPurchaseCost, fuelGrossProfit, profit, petrolEvaporationLossL, daily, costsByDate, marginP, marginD };
}

async function renderAnalysisTab() {
  const el = document.getElementById('analysisBody');
  el.innerHTML = `
    <div class="tabs" style="margin-bottom:16px;" id="analysisSubTabs">
      <button class="tab ${analysisState.sub === 'overview' ? 'active' : ''}" data-sub="overview">Overview</button>
      <button class="tab ${analysisState.sub === 'tracking' ? 'active' : ''}" data-sub="tracking">Fuel tracking</button>
      <button class="tab ${analysisState.sub === 'history' ? 'active' : ''}" data-sub="history">History</button>
    </div>
    <div id="analysisSubBody"><div class="loading">Loading&hellip;</div></div>`;

  document.querySelectorAll('#analysisSubTabs .tab').forEach(t => t.addEventListener('click', () => {
    analysisState.sub = t.dataset.sub;
    renderAnalysisTab();
  }));

  if (analysisState.sub === 'tracking') drawFuelTracking();
  else if (analysisState.sub === 'history') drawAnalysisHistory();
  else drawAnalysisOverview();
}

async function drawAnalysisOverview() {
  const sub = document.getElementById('analysisSubBody');
  const [fig, rates] = await Promise.all([monthlyFigures(analysisState.month), getRates()]);

  // Last 6 months, for the revenue/cost/profit trend chart.
  const months = [];
  for (let i = 5; i >= 0; i--) months.push(shiftMonth(analysisState.month, -i));
  const trendFigs = await Promise.all(months.map(mk => monthlyFigures(mk)));
  const trend = months.map((mk, i) => ({
    label: mk.slice(5),
    values: [Math.round(trendFigs[i].revenue), Math.round(trendFigs[i].operatingCost), Math.max(0, Math.round(trendFigs[i].profit))],
  }));

  const dailyChart = fig.daily.length ? svgBarChart({
    groups: fig.daily.map(d => ({ label: d.label, values: [d.petrol, d.diesel] })),
    seriesColors: ['var(--petrol)', 'var(--diesel)'], width: Math.max(360, fig.daily.length * 18),
  }) : '<div class="empty-state">No readings for this month yet.</div>';

  const trendChart = svgBarChart({ groups: trend, seriesColors: ['var(--petrol)', 'var(--alert)', 'var(--ok)'], width: 600 });

  sub.innerHTML = `
    <div class="month-nav">
      <button id="analysisPrevMonth">&lsaquo;</button>
      <div class="m-label">${monthLabel(analysisState.month)}</div>
      <button id="analysisNextMonth">&rsaquo;</button>
    </div>
    <div class="kpi-grid">
      <div class="kpi-card"><div class="k-label">Petrol dispensed</div><div class="k-value">${fmt(fig.petrolL)} L</div></div>
      <div class="kpi-card"><div class="k-label">Diesel dispensed</div><div class="k-value">${fmt(fig.dieselL)} L</div></div>
      <div class="kpi-card"><div class="k-label">Sales revenue</div><div class="k-value">₹${fmt(fig.revenue)}</div></div>
      <div class="kpi-card"><div class="k-label">Fuel gross profit</div><div class="k-value">₹${fmt(fig.fuelGrossProfit)}</div></div>
      <div class="kpi-card"><div class="k-label">Operating expenses</div><div class="k-value">₹${fmt(fig.operatingCost)}</div></div>
      <div class="kpi-card"><div class="k-label">Fuel purchases (ref.)</div><div class="k-value">₹${fmt(fig.fuelPurchaseCost)}</div></div>
      <div class="kpi-card profit ${fig.profit < 0 ? 'negative' : ''}" style="grid-column:1/3"><div class="k-label">Net profit</div><div class="k-value">₹${fmt(fig.profit)}</div></div>
    </div>
    <div class="analysis-note">Fuel gross profit = ${fmt(fig.petrolL)} L petrol × ₹${rates.marginPetrol ?? 2.75}/L + ${fmt(fig.dieselL)} L diesel × ₹${rates.marginDiesel ?? 2.22}/L — your known per-litre margin, which already nets out wholesale fuel cost. Net profit subtracts day-to-day operating expenses only (fuel purchase cost is <b>not</b> subtracted again — it's already inside the margin). Revenue uses the actual selling rate on each day, which has changed a few times historically. Petrol evaporation loss (${Math.round((rates.petrolDepreciation ?? 0.24) * 100)}% ≈ ${fmt(fig.petrolEvaporationLossL)} L) is shown for stock tracking only and does not affect profit.</div>
    <div class="chart-card">
      <h4>Daily litres this month — petrol / diesel</h4>
      ${dailyChart}
    </div>
    <div class="chart-card">
      <h4>Last 6 months — revenue / operating expenses / net profit (₹)</h4>
      ${trendChart}
    </div>
    <div class="rate-editor">
      <h4>Per-litre margin &amp; reference figures</h4>
      <div class="rate-row">
        <div class="rate-field"><label>Petrol margin ₹/L</label><input type="number" step="0.01" id="marginP" value="${rates.marginPetrol ?? 2.75}"></div>
        <div class="rate-field"><label>Diesel margin ₹/L</label><input type="number" step="0.01" id="marginD" value="${rates.marginDiesel ?? 2.22}"></div>
      </div>
      <div class="rate-row" style="margin-top:10px;">
        <div class="rate-field"><label>Petrol purchase cost ₹/L</label><input type="number" step="0.01" id="purchaseCostP" value="${rates.purchaseCostPetrol}"></div>
        <div class="rate-field"><label>Diesel purchase cost ₹/L</label><input type="number" step="0.01" id="purchaseCostD" value="${rates.purchaseCostDiesel}"></div>
      </div>
      <div class="analysis-note" style="margin:6px 0 0;">What you pay BPCL per litre — used to automatically cost tanker deliveries entered on the Stock tab as a separate "Fuel Purchase" expense.</div>
      <div class="rate-row" style="margin-top:14px;">
        <div class="rate-field"><label>Petrol evap. %</label><input type="number" id="rateDep" value="${Math.round((rates.petrolDepreciation ?? 0.24) * 100)}"></div>
        <div class="rate-field"><label>Fallback rate ₹/L (P)</label><input type="number" step="0.01" id="rateP" value="${rates.petrol}"></div>
        <div class="rate-field"><label>Fallback rate ₹/L (D)</label><input type="number" step="0.01" id="rateD" value="${rates.diesel}"></div>
        <button class="rate-save" id="rateSaveBtn">Save</button>
      </div>
      <div class="form-msg" id="rateMsg"></div>
    </div>`;

  document.getElementById('analysisPrevMonth').addEventListener('click', () => { analysisState.month = shiftMonth(analysisState.month, -1); drawAnalysisOverview(); });
  document.getElementById('analysisNextMonth').addEventListener('click', () => { analysisState.month = shiftMonth(analysisState.month, 1); drawAnalysisOverview(); });
  document.getElementById('rateSaveBtn').addEventListener('click', saveRates);
}

async function drawFuelTracking() {
  const sub = document.getElementById('analysisSubBody');
  const [fig, targets] = await Promise.all([monthlyFigures(analysisState.month), getTargets()]);

  const petrolMet = fig.daily.filter(d => d.petrol >= targets.petrol).length;
  const dieselMet = fig.daily.filter(d => d.diesel >= targets.diesel).length;
  const monthFuelProfit = fig.daily.reduce((s, d) => s + d.petrol * fig.marginP + d.diesel * fig.marginD, 0);

  const petrolChart = targetChart(fig.daily, 'petrol', targets.petrol, 'var(--petrol)', Math.max(360, fig.daily.length * 16));
  const dieselChart = targetChart(fig.daily, 'diesel', targets.diesel, 'var(--diesel)', Math.max(360, fig.daily.length * 16));

  sub.innerHTML = `
    <div class="month-nav">
      <button id="trackPrevMonth">&lsaquo;</button>
      <div class="m-label">${monthLabel(analysisState.month)}</div>
      <button id="trackNextMonth">&rsaquo;</button>
    </div>
    <div class="kpi-grid">
      <div class="kpi-card"><div class="k-label">Days petrol met target</div><div class="k-value">${petrolMet}/${fig.daily.length}</div></div>
      <div class="kpi-card"><div class="k-label">Days diesel met target</div><div class="k-value">${dieselMet}/${fig.daily.length}</div></div>
      <div class="kpi-card profit" style="grid-column:1/3"><div class="k-label">Fuel profit this month (before costs)</div><div class="k-value">₹${fmt(monthFuelProfit)}</div></div>
    </div>
    <div class="chart-card">
      <h4>Petrol — daily litres vs target</h4>
      ${petrolChart}
    </div>
    <div class="chart-card">
      <h4>Diesel — daily litres vs target</h4>
      ${dieselChart}
    </div>
    <div class="rate-editor">
      <h4>Daily target (litres)</h4>
      <div class="rate-row">
        <div class="rate-field"><label>Petrol</label><input type="number" id="targetP" value="${targets.petrol}"></div>
        <div class="rate-field"><label>Diesel</label><input type="number" id="targetD" value="${targets.diesel}"></div>
        <button class="rate-save" id="targetSaveBtn">Save</button>
      </div>
      <div class="form-msg" id="targetMsg"></div>
    </div>`;

  document.getElementById('trackPrevMonth').addEventListener('click', () => { analysisState.month = shiftMonth(analysisState.month, -1); drawFuelTracking(); });
  document.getElementById('trackNextMonth').addEventListener('click', () => { analysisState.month = shiftMonth(analysisState.month, 1); drawFuelTracking(); });
  document.getElementById('targetSaveBtn').addEventListener('click', saveTargets);
}

async function drawAnalysisHistory() {
  const sub = document.getElementById('analysisSubBody');
  sub.innerHTML = `<div id="historyBody"><div class="loading">Loading&hellip;</div></div>`;
  renderHistory();
}

async function saveRates() {
  const marginP = parseFloat(document.getElementById('marginP').value);
  const marginD = parseFloat(document.getElementById('marginD').value);
  const purchaseCostP = parseFloat(document.getElementById('purchaseCostP').value);
  const purchaseCostD = parseFloat(document.getElementById('purchaseCostD').value);
  const depPct = parseFloat(document.getElementById('rateDep').value);
  const p = parseFloat(document.getElementById('rateP').value);
  const d = parseFloat(document.getElementById('rateD').value);
  const msg = document.getElementById('rateMsg');
  if (!(marginP >= 0) || !(marginD >= 0) || !(purchaseCostP >= 0) || !(purchaseCostD >= 0) || !(p > 0) || !(d > 0) || !(depPct >= 0 && depPct <= 100)) {
    msg.textContent = 'Enter valid margins, purchase costs, fallback rates, and a depreciation % between 0-100'; msg.className = 'form-msg err'; return;
  }
  msg.textContent = 'Saving…'; msg.className = 'form-msg';
  try {
    const petrolDepreciation = depPct / 100;
    const data = {
      petrol: p, diesel: d, marginPetrol: marginP, marginDiesel: marginD, petrolDepreciation,
      purchaseCostPetrol: purchaseCostP, purchaseCostDiesel: purchaseCostD,
    };
    ratesCache = await api('PUT', '/settings/rates', data, true);
    msg.textContent = 'Saved'; msg.className = 'form-msg ok';
    drawAnalysisOverview();
  } catch (e) {
    msg.textContent = e.message || 'Could not save — try again'; msg.className = 'form-msg err';
  }
}

async function saveTargets() {
  const p = parseFloat(document.getElementById('targetP').value);
  const d = parseFloat(document.getElementById('targetD').value);
  const msg = document.getElementById('targetMsg');
  if (!(p > 0) || !(d > 0)) { msg.textContent = 'Enter valid targets for both fuels'; msg.className = 'form-msg err'; return; }
  msg.textContent = 'Saving…'; msg.className = 'form-msg';
  try {
    targetsCache = await api('PUT', '/settings/targets', { petrol: p, diesel: d }, true);
    msg.textContent = 'Saved'; msg.className = 'form-msg ok';
    drawFuelTracking();
  } catch (e) {
    msg.textContent = e.message || 'Could not save — try again'; msg.className = 'form-msg err';
  }
}

// ---------------------------------------------------------------------------
// Summary tab (owner only) — first tab the owner sees. Shows an AI-written
// daily briefing (generated automatically via /api/ai/briefing, not on
// request) plus a few quick KPI cards. Ported from the artifact's
// renderSummaryTab()/generateBriefing().
// ---------------------------------------------------------------------------

let ownerBriefing = null; // { text, generatedAt } | null
let ownerBriefingBusy = false;

function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + ' hr ago';
  return Math.round(hrs / 24) + ' d ago';
}

function renderBriefingBody(thinking) {
  const bodyEl = document.getElementById('briefingBody');
  const whenEl = document.getElementById('briefingWhen');
  const refreshBtn = document.getElementById('briefingRefreshBtn');
  if (!bodyEl) return;
  if (thinking) {
    bodyEl.className = 'briefing-body thinking';
    bodyEl.textContent = 'Reading your data and putting together today\'s briefing…';
    if (whenEl) whenEl.textContent = '';
    if (refreshBtn) refreshBtn.disabled = true;
    return;
  }
  bodyEl.className = 'briefing-body' + (ownerBriefing && ownerBriefing.error ? ' thinking' : '');
  bodyEl.textContent = ownerBriefing ? ownerBriefing.text : '';
  if (whenEl) whenEl.textContent = ownerBriefing && !ownerBriefing.unavailable ? 'Updated ' + timeAgo(ownerBriefing.generatedAt) : '';
  if (refreshBtn) refreshBtn.disabled = false;
}

async function generateBriefing(force) {
  if (ownerBriefingBusy) return;
  if (!force && ownerBriefing) { renderBriefingBody(); return; }
  ownerBriefingBusy = true;
  renderBriefingBody(true);
  try {
    const status = await api('GET', '/ai/status');
    if (!status || !status.configured) {
      ownerBriefing = { text: 'AI Assistant isn\'t set up on this server yet, so an automatic briefing can\'t be generated. You can still check the Analysis tab for the numbers.', generatedAt: new Date().toISOString(), unavailable: true };
      return;
    }
    const result = await api('POST', '/ai/briefing', { force: !!force }, true);
    ownerBriefing = { text: result.text, generatedAt: result.generatedAt };
  } catch (e) {
    ownerBriefing = { text: e.message || 'Couldn\'t generate a briefing right now — try refreshing.', generatedAt: new Date().toISOString(), error: true };
  } finally {
    ownerBriefingBusy = false;
    renderBriefingBody();
  }
}

function renderSummaryTab() {
  const el = document.getElementById('summaryBody');
  el.innerHTML = `
    <div class="briefing-card">
      <div class="briefing-head">
        <h3>Today's briefing</h3>
        <span class="briefing-when" id="briefingWhen"></span>
      </div>
      <div class="briefing-body" id="briefingBody"></div>
      <button class="briefing-refresh" id="briefingRefreshBtn">Refresh briefing</button>
    </div>
    <div id="summaryQuickBody"><div class="loading">Loading…</div></div>
    <div class="backup-card">
      <div class="briefing-head">
        <h3>Backups</h3>
        <span class="briefing-when" id="backupLastWhen"></span>
      </div>
      <div class="backup-note">A backup is taken automatically about once a month, the next time you open the app. You can also back up on demand.</div>
      <button class="briefing-refresh" id="backupNowBtn">Backup now</button>
      <div id="backupList"><div class="loading">Loading…</div></div>
    </div>`;

  document.getElementById('briefingRefreshBtn').addEventListener('click', () => generateBriefing(true));
  generateBriefing(false);
  drawSummaryQuickFigures();

  document.getElementById('backupNowBtn').addEventListener('click', onBackupNowClick);
  loadBackups();
}

// ---------------------------------------------------------------------------
// Backups (owner only): manual "Backup now" button + list of stored
// snapshots (each downloadable as JSON). A lazy monthly auto-backup is
// triggered once per owner session via checkAutoBackup(), called from
// enterApp() rather than here, so it fires regardless of which tab is open.
// ---------------------------------------------------------------------------

async function checkAutoBackup() {
  try {
    const result = await api('POST', '/backups/check', {}, true);
    // If the summary tab happened to already be rendered (it's the owner's
    // landing tab), refresh it so a freshly-made auto backup shows up
    // without the owner needing to navigate away and back.
    if (result && result.created && document.getElementById('backupList')) {
      loadBackups();
    }
  } catch (e) { /* silent — not critical */ }
}

async function loadBackups() {
  const listEl = document.getElementById('backupList');
  const whenEl = document.getElementById('backupLastWhen');
  if (!listEl) return;
  try {
    const result = await api('GET', '/backups', undefined, true);
    if (whenEl) whenEl.textContent = result.lastBackupAt ? 'Last backup ' + timeAgo(result.lastBackupAt) : 'No backups yet';
    if (!result.backups.length) {
      listEl.innerHTML = '<div class="empty-state">No backups yet — click "Backup now" to create the first one.</div>';
      return;
    }
    listEl.innerHTML = result.backups.map(b => `
      <div class="backup-row" data-id="${b.id}">
        <div class="backup-row-main">
          <span class="backup-kind ${b.kind}">${b.kind === 'auto' ? 'Auto' : 'Manual'}</span>
          <span class="backup-date">${new Date(b.createdAt).toLocaleString()}</span>
          <span class="backup-size">${(b.sizeBytes / 1024).toFixed(1)} KB</span>
        </div>
        <div class="backup-row-actions">
          <button class="pill-btn" data-dl="${b.id}">Download</button>
          <button class="pill-btn danger" data-del="${b.id}">Delete</button>
        </div>
      </div>`).join('');
    listEl.querySelectorAll('[data-dl]').forEach(btn =>
      btn.addEventListener('click', () => downloadBackup(btn.getAttribute('data-dl'))));
    listEl.querySelectorAll('[data-del]').forEach(btn =>
      btn.addEventListener('click', () => onDeleteBackupClick(btn.getAttribute('data-del'))));
  } catch (e) {
    listEl.innerHTML = '<div class="empty-state">Couldn\'t load backups.</div>';
  }
}

async function onBackupNowClick() {
  const btn = document.getElementById('backupNowBtn');
  btn.disabled = true;
  btn.textContent = 'Backing up…';
  try {
    await api('POST', '/backups', {}, true);
    showFcToast('Backup created');
    await loadBackups();
  } catch (e) {
    showFcToast(e.message || 'Backup failed');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Backup now';
  }
}

async function downloadBackup(id) {
  try {
    const res = await fetch('/api/backups/' + id + '/download', { headers: ownerHeaders() });
    if (!res.ok) throw new Error('Download failed (' + res.status + ')');
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : ('pump-readings-backup-' + id + '.json');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    showFcToast(e.message || 'Download failed');
  }
}

function onDeleteBackupClick(id) {
  openConfirmModal({
    title: 'Delete this backup?',
    body: 'This removes the stored snapshot. This can\'t be undone.',
    confirmLabel: 'Delete',
    onConfirm: async () => {
      try {
        await api('DELETE', '/backups/' + id, undefined, true);
        await loadBackups();
      } catch (e) {
        showFcToast(e.message || 'Delete failed');
      }
    },
  });
}

async function drawSummaryQuickFigures() {
  const el = document.getElementById('summaryQuickBody');
  if (!el) return;
  try {
    const today = todayStr();
    const weekFrom = new Date(Date.now() - 6 * 86400000);
    const weekFromStr = new Date(weekFrom - weekFrom.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const [week, month] = await Promise.all([
      rangeFigures(weekFromStr, today),
      monthlyFigures(monthKey(today)),
    ]);
    el.innerHTML = `
      <div class="briefing-kpis">
        <div class="kpi-card"><div class="k-label">This week — petrol</div><div class="k-value">${fmt(week.petrolL)} L</div></div>
        <div class="kpi-card"><div class="k-label">This week — diesel</div><div class="k-value">${fmt(week.dieselL)} L</div></div>
        <div class="kpi-card"><div class="k-label">This week — revenue</div><div class="k-value">₹${fmt(week.revenue)}</div></div>
        <div class="kpi-card profit ${week.netProfit < 0 ? 'negative' : ''}"><div class="k-label">This week — net profit</div><div class="k-value">₹${fmt(week.netProfit)}</div></div>
        <div class="kpi-card" style="grid-column:1/3"><div class="k-label">${monthLabel(monthKey(today))} so far — net profit</div><div class="k-value">₹${fmt(month.profit)}</div></div>
      </div>`;
  } catch (e) {
    el.innerHTML = '<div class="empty-state">Couldn\'t load this week\'s figures.</div>';
  }
}

// ---------------------------------------------------------------------------
// AI Assistant tab (owner only) — talks to /api/ai/send and /api/ai/resolve,
// which run the same read/write "tools" the original Claude-Artifact
// version had, backed by Gemini instead of window.claude.complete(). Every
// write is shown as a Confirm/Cancel card here first; nothing is saved
// until the owner clicks Confirm.
// ---------------------------------------------------------------------------

const AI_SUGGESTIONS = [
  'How did we do this month?',
  'Forecast diesel sales for next month',
  'Any anomalies in the last 30 days?',
  'Where can we cut costs?',
];

let aiChat = {
  turns: [],      // {role:'user'|'assistant', content} — kept for this visit only
  sending: false,
  history: [],    // Gemini "contents" array, resent on every call
  pending: null,  // [{name, args, summary, decided, confirmed}] while a confirm batch is open
  thinkingEl: null,
  configured: null, // null = not checked yet
};

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function setThinkingBusy(el, label) {
  el.className = 'ai-msg assistant thinking';
  el.innerHTML = `<span>${escapeHtml(label)}</span><span class="ai-busy-dots"><span></span><span></span><span></span></span>`;
}

function setThinkingAwaitingConfirm(el) {
  el.className = 'ai-msg assistant awaiting-confirm';
  el.innerHTML = `<span>Waiting for your confirmation below ⬇</span>`;
}

function renderResolvedConfirmCard(items) {
  const lines = items.map(it => `<div class="ai-confirm-text">${escapeHtml(it.summary)}</div>
      <div class="ai-confirm-result">${it.confirmed ? '✓ Confirmed — saved' : '✕ Cancelled — nothing changed'}</div>`).join('<div style="height:8px"></div>');
  const allConfirmed = items.every(it => it.confirmed);
  const anyConfirmed = items.some(it => it.confirmed);
  return `<div class="ai-confirm-card ${allConfirmed ? 'resolved-confirm' : (anyConfirmed ? '' : 'resolved-cancel')}">
    <div class="ai-confirm-label">${items.length > 1 ? items.length + ' CHANGES' : 'CONFIRMED BEFORE SAVING'}</div>
    ${lines}
  </div>`;
}

function renderAiLog() {
  const log = document.getElementById('aiLog');
  if (!log) return;
  if (aiChat.turns.length === 0) {
    log.innerHTML = '<div class="ai-msg assistant">Hi — I\'m your station\'s AI assistant. Ask me anything about your readings, costs, margins or trends, ask for a forecast, or tell me to fix something and I\'ll do it.</div>';
  } else {
    log.innerHTML = aiChat.turns.map(t => {
      if (t.role === 'confirm-record') return renderResolvedConfirmCard(t.items);
      return `<div class="ai-msg ${t.role}">${escapeHtml(t.content)}</div>`;
    }).join('');
  }
  if (aiChat.pending) renderPendingCards();
  log.scrollTop = log.scrollHeight;
}

async function renderAiTab() {
  const body = document.getElementById('aiBody');
  if (aiChat.configured === null) {
    try {
      const status = await api('GET', '/ai/status');
      aiChat.configured = !!(status && status.configured);
    } catch (e) {
      aiChat.configured = false;
    }
  }
  body.innerHTML = `
    <div class="ai-intro">
      <h3>AI Assistant</h3>
      <p>Ask about sales, costs, margins or trends, get a forecast, or ask it to add, change or delete a reading, expense, stock entry, target or rate. Every change shows you a Confirm/Cancel card right here first; nothing is saved or deleted until you tap Confirm.</p>
    </div>
    <div class="ai-chips" id="aiChips">${AI_SUGGESTIONS.map(s => `<button class="ai-chip" data-q="${s.replace(/"/g, '&quot;')}">${s}</button>`).join('')}</div>
    <div class="ai-log" id="aiLog"></div>
    <div class="ai-input-row">
      <textarea id="aiInput" placeholder="Ask about your station, or tell it what to fix…" rows="1" ${aiChat.configured ? '' : 'disabled'}></textarea>
      <button class="ai-send-btn" id="aiSendBtn" ${aiChat.configured ? '' : 'disabled'}>Send</button>
    </div>
    <div class="ai-note" id="aiNote">${aiChat.configured ? 'Can read your live data and make changes you ask for.' : 'AI Assistant isn\'t set up on this server yet (no API key configured).'}</div>`;

  renderAiLog();

  document.querySelectorAll('#aiChips .ai-chip').forEach(btn => {
    btn.addEventListener('click', () => { if (!aiChat.sending) sendAiMessage(btn.dataset.q); });
  });
  document.getElementById('aiSendBtn').addEventListener('click', () => {
    const box = document.getElementById('aiInput');
    const text = box.value.trim();
    if (text && !aiChat.sending) { box.value = ''; sendAiMessage(text); }
  });
  document.getElementById('aiInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const box = e.target;
      const text = box.value.trim();
      if (text && !aiChat.sending) { box.value = ''; sendAiMessage(text); }
    }
  });
}

async function sendAiMessage(text) {
  if (aiChat.sending) return;
  aiChat.sending = true;
  aiChat.turns.push({ role: 'user', content: text });
  renderAiLog();

  const log = document.getElementById('aiLog');
  document.querySelectorAll('#aiChips .ai-chip').forEach(b => b.disabled = true);
  const sendBtn = document.getElementById('aiSendBtn');
  if (sendBtn) sendBtn.disabled = true;

  const thinkingEl = document.createElement('div');
  setThinkingBusy(thinkingEl, 'Thinking…');
  log.appendChild(thinkingEl);
  log.scrollTop = log.scrollHeight;
  aiChat.thinkingEl = thinkingEl;

  try {
    const result = await api('POST', '/ai/send', { history: aiChat.history, message: text }, true);
    handleAiResult(result);
  } catch (e) {
    thinkingEl.remove();
    aiChat.thinkingEl = null;
    const bubble = document.createElement('div');
    bubble.className = 'ai-msg error';
    bubble.textContent = e.message || 'Something went wrong reaching the AI assistant — try again.';
    log.appendChild(bubble);
  } finally {
    aiChat.sending = false;
    document.querySelectorAll('#aiChips .ai-chip').forEach(b => b.disabled = false);
    if (sendBtn) sendBtn.disabled = false;
  }
}

function handleAiResult(result) {
  aiChat.history = result.history || aiChat.history;
  const thinkingEl = aiChat.thinkingEl;

  if (result.status === 'done') {
    if (thinkingEl) thinkingEl.remove();
    aiChat.thinkingEl = null;
    aiChat.turns.push({ role: 'assistant', content: result.text });
    aiChat.pending = null;
    renderAiLog();
    return;
  }

  // status === 'confirm' — one or more write actions need the owner's okay.
  if (thinkingEl) setThinkingAwaitingConfirm(thinkingEl);
  aiChat.pending = result.pending.map(p => ({ ...p, decided: false, confirmed: false }));
  renderAiLog();
}

function renderPendingCards() {
  const log = document.getElementById('aiLog');
  document.getElementById('aiConfirmAllBar')?.remove();
  // Only the live (currently-open) cards get rebuilt here — historical
  // confirm-record cards from aiChat.turns stay in the log untouched.
  log.querySelectorAll('.ai-pending-card').forEach(el => el.remove());

  aiChat.pending.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'ai-confirm-card ai-pending-card' + (p.decided ? (p.confirmed ? ' resolved-confirm' : ' resolved-cancel') : '');
    card.innerHTML = `
      <div class="ai-confirm-label">CONFIRM BEFORE SAVING</div>
      <div class="ai-confirm-text"></div>
      <div class="ai-confirm-actions">
        <button class="ai-confirm-btn confirm" ${p.decided ? 'disabled' : ''}>Confirm</button>
        <button class="ai-confirm-btn cancel" ${p.decided ? 'disabled' : ''}>Cancel</button>
      </div>
      ${p.decided ? `<div class="ai-confirm-result">${p.confirmed ? '✓ Confirmed — saving…' : '✕ Cancelled — nothing changed'}</div>` : ''}`;
    card.querySelector('.ai-confirm-text').textContent = p.summary;
    if (!p.decided) {
      card.querySelector('.confirm').addEventListener('click', () => decidePending(i, true));
      card.querySelector('.cancel').addEventListener('click', () => decidePending(i, false));
    }
    log.appendChild(card);
  });

  const undecidedCount = aiChat.pending.filter(p => !p.decided).length;
  if (undecidedCount > 1) {
    const bar = document.createElement('div');
    bar.id = 'aiConfirmAllBar';
    bar.className = 'ai-confirm-all-bar';
    bar.innerHTML = `
      <div class="ai-confirm-all-text">${undecidedCount} changes waiting for confirmation</div>
      <div class="ai-confirm-actions">
        <button class="ai-confirm-btn confirm" id="aiConfirmAllBtn">Confirm all ${undecidedCount}</button>
        <button class="ai-confirm-btn cancel" id="aiCancelAllBtn">Cancel all</button>
      </div>`;
    log.appendChild(bar);
    document.getElementById('aiConfirmAllBtn').addEventListener('click', () => {
      aiChat.pending.forEach((p, i) => { if (!p.decided) decidePending(i, true, true); });
      maybeResolvePending();
    });
    document.getElementById('aiCancelAllBtn').addEventListener('click', () => {
      aiChat.pending.forEach((p, i) => { if (!p.decided) decidePending(i, false, true); });
      maybeResolvePending();
    });
  }
  log.scrollTop = log.scrollHeight;
}

function decidePending(index, confirmed, skipRender) {
  aiChat.pending[index].decided = true;
  aiChat.pending[index].confirmed = confirmed;
  if (!skipRender) renderPendingCards();
  maybeResolvePending();
}

async function maybeResolvePending() {
  if (!aiChat.pending || aiChat.pending.some(p => !p.decided)) return;
  const decisions = aiChat.pending.map(p => p.confirmed);
  // Keep a permanent record of what was confirmed/cancelled in the log,
  // instead of discarding the card once it's resolved.
  aiChat.turns.push({ role: 'confirm-record', items: aiChat.pending.map(p => ({ summary: p.summary, confirmed: p.confirmed })) });
  aiChat.pending = null;
  renderAiLog();

  const log = document.getElementById('aiLog');
  const thinkingEl = document.createElement('div');
  setThinkingBusy(thinkingEl, 'Thinking…');
  log.appendChild(thinkingEl);
  log.scrollTop = log.scrollHeight;
  aiChat.thinkingEl = thinkingEl;
  aiChat.sending = true;

  try {
    const result = await api('POST', '/ai/resolve', { history: aiChat.history, decisions }, true);
    handleAiResult(result);
  } catch (e) {
    thinkingEl.remove();
    aiChat.thinkingEl = null;
    const bubble = document.createElement('div');
    bubble.className = 'ai-msg error';
    bubble.textContent = e.message || 'Something went wrong reaching the AI assistant — try again.';
    log.appendChild(bubble);
  } finally {
    aiChat.sending = false;
  }
}

// ---------------------------------------------------------------------------
// Tabs / role gate
// ---------------------------------------------------------------------------

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.getElementById('view-summary').classList.toggle('hidden', tab !== 'summary');
  document.getElementById('view-entry').classList.toggle('hidden', tab !== 'entry');
  document.getElementById('view-cost').classList.toggle('hidden', tab !== 'cost');
  document.getElementById('view-stock').classList.toggle('hidden', tab !== 'stock');
  document.getElementById('view-analysis').classList.toggle('hidden', tab !== 'analysis');
  document.getElementById('view-ai').classList.toggle('hidden', tab !== 'ai');
  document.getElementById('savebar').classList.toggle('hidden', tab !== 'entry');
  if (tab === 'cost') { appRole === 'owner' ? renderOwnerCostTab() : renderCostTab(); }
  if (tab === 'stock') { appRole === 'owner' ? renderOwnerStockTab() : renderStockTab(); }
  if (tab === 'analysis') renderAnalysisTab();
  if (tab === 'ai') renderAiTab();
  if (tab === 'summary') renderSummaryTab();
}

function bindTabClicks() {
  document.querySelectorAll('.tab').forEach(t => {
    t.replaceWith(t.cloneNode(true));
  });
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
}

function renderRoleScreen() {
  document.getElementById('appWrap').classList.add('hidden');
  document.getElementById('roleScreen').classList.remove('hidden');
  document.getElementById('roleOwnerGate').innerHTML = '';
  document.getElementById('roleEmployeeBtn').onclick = () => enterApp('employee');
  document.getElementById('roleOwnerBtn').onclick = () => {
    if (ownerUnlocked()) { enterApp('owner'); return; }
    renderOwnerLock(document.getElementById('roleOwnerGate'), () => enterApp('owner'));
  };
}

function enterApp(role) {
  appRole = role;
  document.getElementById('roleScreen').classList.add('hidden');
  document.getElementById('appWrap').classList.remove('hidden');

  const tabBar = document.getElementById('tabBar');
  const coreTabs = `
    <button class="tab" data-tab="entry">Readings</button>
    <button class="tab" data-tab="cost">Cost</button>
    <button class="tab" data-tab="stock">Stock</button>`;
  tabBar.innerHTML = role === 'owner'
    ? `<button class="tab" data-tab="summary">Summary</button>${coreTabs}<button class="tab" data-tab="analysis">Analysis</button><button class="tab" data-tab="ai">AI Assistant</button>`
    : coreTabs;
  bindTabClicks();
  switchTab(role === 'owner' ? 'summary' : 'entry');
  renderEntryForDate(state.date);
  if (role === 'owner') checkAutoBackup();
}

function switchRole() {
  ownerPasswordMem = null;
  appRole = null;
  renderRoleScreen();
}

function main() {
  document.getElementById('dateInput').value = state.date;
  document.getElementById('switchRoleBtn').addEventListener('click', switchRole);
  document.getElementById('saveBtn').addEventListener('click', saveReadings);
  document.getElementById('dateInput').addEventListener('change', e => renderEntryForDate(e.target.value));

  document.getElementById('fcModalCancel').addEventListener('click', closeConfirmModal);
  document.getElementById('fcModalConfirm').addEventListener('click', async () => {
    const fn = fcPendingConfirm;
    document.getElementById('fcModalBackdrop').classList.remove('show');
    fcPendingConfirm = null;
    if (fn) await fn();
  });
  document.getElementById('fcModalBackdrop').addEventListener('click', (e) => {
    if (e.target.id === 'fcModalBackdrop') closeConfirmModal();
  });

  renderRoleScreen();
}

main();
