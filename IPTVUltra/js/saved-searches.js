/**
 * @fileoverview Saved keyword searches: links below All Channels in the groups
 * column, the matching rules, and the editor overlay.
 */

// ----- Saved keyword searches -----
// Each playlist keeps its searches in the playlist state (`ps.savedSearches`,
// a list of {id, name, terms, hours}). A search is a pinned group with the key
// `ss:<id>`. The key `ss:+` is the row "+ New saved search".
//
// Rules (decided by the user, 2026-11-08):
// - A channel matches when 1 or more terms match.
// - A term matches at the start of a word: "Pitt" matches "Pittsburgh", but
//   not "Spitting". A term can have spaces ("Pittsburgh Penguins").
// - The fields are the channel name, the group, the title of an event name
//   with no time, and the titles of the programs that are on now or that
//   start in the window of the search. Each search has its own window
//   (`hours`, a value of SS_HOURS, default 1 h; the user, 2026-11-14).
// - Sequence: a matching program that is on now, then a matching program
//   that starts in the window (by start time), then a match in the name or
//   the group.
// - In the guide, only a matching program that is on now or that starts in
//   the window gets the mark (`ss-match`). The minute tick adds and removes
//   the mark (epgTickRowBlocks).
const SS_PREFIX = 'ss:';
const SS_NEW_KEY = 'ss:+';
const SS_HOURS = [1, 2, 3, 6, 12, 24];
const SS_DEFAULT_HOURS = 1;
const SS_CACHE_MS = 60000;
const SS_MAX_TERMS = 20;
let _ssCache = null;   // {key, list, at, result, nowCount}
let _ssMarkRe = null;  // marks the matching programs in the guide
let _ssMarkMs = SS_DEFAULT_HOURS * 3600000;  // the window of the mark

/**
 * @param {?Object} s A saved search.
 * @return {number} The window of the search in hours (a value of SS_HOURS).
 */
function ssHoursOf(s) {
  const h = s && +s.hours;
  return SS_HOURS.includes(h) ? h : SS_DEFAULT_HOURS;
}

/** @return {!Array<!Object>} The saved searches of the active playlist. */
function savedSearches() {
  const ps = _activePlaylistKey ? getPlaylistState(_activePlaylistKey) : null;
  if (!ps) return [];
  if (!Array.isArray(ps.savedSearches)) ps.savedSearches = [];
  return ps.savedSearches;
}

/**
 * @param {string} g A group key.
 * @return {boolean} True for a saved search or the row "+ New saved search".
 */
function isSavedSearchKey(g) {
  return typeof g === 'string' && g.startsWith(SS_PREFIX);
}

/**
 * @param {string} g A group key.
 * @return {?Object} The saved search of the key, or null.
 */
function savedSearchOf(g) {
  if (!isSavedSearchKey(g) || g === SS_NEW_KEY) return null;
  const id = g.slice(SS_PREFIX.length);
  return savedSearches().find(s => s.id === id) || null;
}

/** @return {!Array<string>} The group keys of the saved searches, and "+". */
function savedSearchKeys() {
  if (!_activePlaylistKey || _activePlaylistKey === 'm:demo') return [];
  return savedSearches().map(s => SS_PREFIX + s.id).concat([SS_NEW_KEY]);
}

/**
 * Cleans a list of terms: no empty terms, no duplicates, 1 space between
 * words.
 * @param {!Array<string>} terms
 * @return {!Array<string>}
 */
function ssCleanTerms(terms) {
  const out = [];
  for (const t of terms) {
    const c = String(t || '').replace(/\s+/g, ' ').trim();
    if (c && !out.some(o => o.toLowerCase() === c.toLowerCase())) out.push(c);
  }
  return out.slice(0, SS_MAX_TERMS);
}

/**
 * Makes 1 expression for a list of terms. A term matches at the start of a
 * word, without regard to case.
 * @param {!Array<string>} terms
 * @return {?RegExp} The expression, or null when there are no terms.
 */
function ssCompile(terms) {
  const parts = ssCleanTerms(terms).map(
      t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'));
  if (!parts.length) return null;
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${parts.join('|')})`, 'iu');
}

/**
 * Finds the channels that match an expression, in the sequence of the rules.
 * @param {!RegExp} re
 * @param {number} hours The window: a program that starts in the next hours
 *     can match.
 * @return {{result: !Array<!Object>, nowCount: number}} The channels, and the
 *     number of channels with a matching program on now.
 */
function ssMatch(re, hours) {
  const now = Date.now(), end = now + hours * 3600000;
  const items = [];
  let nowCount = 0;
  for (let i = 0; i < channels.length; i++) {
    const ch = channels[i];
    if (_hiddenGroups.size && _hiddenGroups.has(ch.group)) continue;
    let rank = -1, key = 0;
    const progs = ch.tvgId ? epgProgsOf(ch.tvgId) : null;
    if (progs && progs.length) {
      let j = _epgBinarySearch(progs, now);
      if (j < 0) j = 0;
      for (; j < progs.length && progs[j].start < end; j++) {
        const p = progs[j];
        if (p.stop <= now || !p.title || !re.test(p.title)) continue;
        if (p.start <= now) {
          rank = 0;
          nowCount++;
        } else {
          rank = 1;
          key = p.start;
        }
        break;
      }
    }
    if (rank < 0) {
      const u = untimedEventOf(ch);
      if (re.test(ch.name) || re.test(ch.group || '') ||
          (u && re.test(u.title)))
        rank = 2;
    }
    if (rank >= 0) items.push({ch, rank, key, i});
  }
  items.sort((a, b) => a.rank - b.rank || a.key - b.key || a.i - b.i);
  return {result: items.map(x => x.ch), nowCount};
}

/**
 * The channels of a saved search. The result stays for SS_CACHE_MS, so the
 * sequence under the cursor does not change at each refresh.
 * @param {!Object} s The saved search.
 * @return {!Array<!Object>}
 */
function savedSearchChannels(s) {
  // A new channel list is a new array (also with the same length), and the
  // key has the names of the hidden groups, not only their number.
  const hours = ssHoursOf(s);
  const key = s.id + '\n' + hours + '\n' + s.terms.join('\n') + '\n' +
      [..._hiddenGroups].sort().join('\n');
  if (_ssCache && _ssCache.key === key && _ssCache.list === channels &&
      Date.now() - _ssCache.at < SS_CACHE_MS)
    return _ssCache.result;
  const re = ssCompile(s.terms);
  const m = re ? ssMatch(re, hours) : {result: [], nowCount: 0};
  _ssCache = {
    key,
    list: channels,
    at: Date.now(),
    result: m.result,
    nowCount: m.nowCount
  };
  return m.result;
}

/**
 * Sets the expression that marks the matching programs in the guide.
 * renderChannelList calls it for each view.
 */
function ssUpdateMark() {
  const s = currentSearchQuery ? null : savedSearchOf(currentGroup);
  _ssMarkRe = s ? ssCompile(s.terms) : null;
  _ssMarkMs = ssHoursOf(s) * 3600000;
}

/**
 * @param {number} start The start of a program (ms).
 * @param {number} stop The stop of a program (ms).
 * @param {number} now The current time (ms).
 * @return {boolean} True when the program is on now, or starts in the window
 *     of the open saved search.
 */
function ssInWindow(start, stop, now) {
  return stop > now && start < now + _ssMarkMs;
}

/**
 * @param {!Object} p A program.
 * @param {number=} now The current time (ms).
 * @return {boolean} True when the program matches the open saved search, and
 *     it is on now or starts in the window of the search.
 */
function ssProgMatches(p, now = Date.now()) {
  return !!_ssMarkRe && !!p.title && ssInWindow(p.start, p.stop, now) &&
      _ssMarkRe.test(p.title);
}

/** Saves the searches of the playlist, and shows the new group list. */
function ssSaveAll() {
  _ssCache = null;
  savePlaylistState();
  extractGroups();
}

// ----- Saved search editor -----
// The overlay `#ssOverlay` has 2 modes:
// - 'list': the saved searches of the playlist (Settings > Manage saved
//   searches). OK edits, ◀ ▶ move, "+ New saved search" adds.
// - 'edit': 1 search. Rows: the name, 1 row for each term with its match
//   count, "+ Add term", the window ("Programs starting within", ◀ ▶ or OK
//   change it), and the buttons Save, Cancel, and Delete. OK on a text row
//   opens the keyboard of the TV (an <input>). Red deletes the focused term.
let ssOpen = false;
const ssEd = {
  mode: 'edit',
  id: null,  // null = a new search
  name: '',
  terms: [],
  hours: SS_DEFAULT_HOURS,
  focus: 0,
  btn: 0,       // 0 Save, 1 Cancel, 2 Delete
  editing: -1,  // the row of the open input, -1 = none
  listFocus: 0,
  fromList: false,    // the editor came from the list (Back goes to it)
  counts: new Map(),  // term (lower case) -> number of channels
  sum: null           // {key, m}: the match of all terms
};

/**
 * Opens the editor for a saved search.
 * @param {?Object} s The search, or null for a new search.
 * @param {!Array<string>=} prefill The terms of a new search.
 * @param {boolean=} fromList True when the list opens the editor.
 */
function openSavedSearchEditor(s, prefill, fromList) {
  if (!_activePlaylistKey || _activePlaylistKey === 'm:demo') return;
  if (settingsOpen) closeSettings();
  ssEd.mode = 'edit';
  ssEd.fromList = !!fromList;
  ssEd.id = s ? s.id : null;
  ssEd.name = s ? s.name : '';
  ssEd.terms = s ? s.terms.slice() : ssCleanTerms(prefill || []);
  ssEd.hours = ssHoursOf(s);
  ssEd.focus = 0;
  ssEd.btn = 0;
  ssEd.editing = -1;
  ssEd.counts = new Map();
  ssEd.sum = null;
  if (!s && ssEd.terms.length && !ssEd.name) ssEd.name = ssEd.terms.join(', ');
  // A new search with no terms starts on "+ Add term"
  if (!s && !ssEd.terms.length) ssEd.focus = 1;
  ssShow();
}

/** Opens the list of the saved searches of the playlist. */
function openSavedSearchList() {
  if (!_activePlaylistKey || _activePlaylistKey === 'm:demo') return;
  if (settingsOpen) closeSettings();
  ssEd.mode = 'list';
  ssEd.editing = -1;
  ssEd.listFocus = 0;
  ssEd.fromList = false;
  ssShow();
}

/**
 * Leaves the editor: back to the list when the list opened it, else the
 * overlay closes.
 */
function ssLeaveEditor() {
  if (ssEd.mode !== 'edit' || !ssEd.fromList) {
    closeSavedSearchEditor();
    return;
  }
  ssEd.mode = 'list';
  ssEd.fromList = false;
  ssEd.editing = -1;
  if (_isTextInput(document.activeElement)) document.activeElement.blur();
  // The list has the searches and the row "+ New saved search"
  ssEd.listFocus = Math.min(ssEd.listFocus, savedSearches().length);
  ssRender();
}

function ssShow() {
  const ov = document.getElementById('ssOverlay');
  if (!ov) return;
  ssOpen = true;
  ov.classList.remove('hidden');
  ssRender();
}

function closeSavedSearchEditor() {
  if (!ssOpen) return;
  ssOpen = false;
  ssEd.editing = -1;
  const ov = document.getElementById('ssOverlay');
  if (ov) ov.classList.add('hidden');
  const list = document.getElementById('ssList');
  if (list) list.innerHTML = '';
  if (_isTextInput(document.activeElement)) document.activeElement.blur();
}

// Edit-mode rows: 0 = name, 1..n = terms, n + 1 = "+ Add term", n + 2 = the
// window, n + 3 = buttons
function ssRowCount() {
  return ssEd.terms.length + 4;
}
function ssAddRow() {
  return ssEd.terms.length + 1;
}
function ssHoursRow() {
  return ssEd.terms.length + 2;
}
function ssBtnRow() {
  return ssEd.terms.length + 3;
}

/**
 * Changes the window of the editor to the previous or next value of SS_HOURS.
 * @param {number} dir -1 or 1.
 * @param {boolean=} wrap True: after the last value comes the first (OK).
 */
function ssStepHours(dir, wrap) {
  const i = SS_HOURS.indexOf(ssEd.hours);
  let j = (i < 0 ? 0 : i) + dir;
  if (wrap)
    j = (j + SS_HOURS.length) % SS_HOURS.length;
  else
    j = Math.max(0, Math.min(SS_HOURS.length - 1, j));
  if (SS_HOURS[j] === ssEd.hours) return;
  ssEd.hours = SS_HOURS[j];
  ssEd.counts.clear();
  ssRender();
}

/**
 * The number of channels that match 1 term.
 * @param {string} term
 * @return {number}
 */
function ssTermCount(term) {
  const k = term.toLowerCase();
  if (!ssEd.counts.has(k)) {
    const re = ssCompile([term]);
    ssEd.counts.set(k, re ? ssMatch(re, ssEd.hours).result.length : 0);
  }
  return ssEd.counts.get(k);
}

/**
 * The match of all terms of the editor. The result stays until the terms
 * change: a key in the editor does not do the full match again.
 * @return {?{result: !Array<!Object>, nowCount: number}}
 */
function ssEditorMatch() {
  const key = ssEd.hours + '\n' + ssEd.terms.join('\n').toLowerCase();
  if (ssEd.sum && ssEd.sum.key === key) return ssEd.sum.m;
  const re = ssCompile(ssEd.terms);
  const m = re ? ssMatch(re, ssEd.hours) : null;
  ssEd.sum = {key, m};
  return m;
}

function ssRender() {
  const list = document.getElementById('ssList');
  const title = document.getElementById('ssTitle');
  const hint = document.getElementById('ssHint');
  const sum = document.getElementById('ssSummary');
  if (!list) return;
  list.innerHTML = '';
  if (ssEd.mode === 'list') {
    title.textContent = '🔎 Saved searches';
    hint.textContent = 'OK edit · ◀ ▶ move · Back close';
    sum.textContent = '';
    const all = savedSearches();
    const rows = all.map(s => ({s})).concat([{add: true}]);
    ssEd.listFocus = Math.min(ssEd.listFocus, rows.length - 1);
    rows.forEach((r, i) => {
      const row = document.createElement('div');
      row.className =
          'settings-row ss-row' + (i === ssEd.listFocus ? ' focused' : '');
      row.innerHTML = r.add ?
          `<div class="settings-label"><div class="settings-name">➕ New saved search</div></div>` :
          `<div class="settings-label"><div class="settings-name">🔎 ${
              escapeHtml(r.s.name)}</div><div class="settings-sub">${
              escapeHtml(r.s.terms.join(
                  ' · '))} · within ${ssHoursOf(r.s)} h</div></div>`;
      row.addEventListener('click', () => {
        ssEd.listFocus = i;
        ssListActivate();
      });
      list.appendChild(row);
    });
    const f = list.querySelector('.ss-row.focused');
    if (f) f.scrollIntoView({block: 'nearest'});
    return;
  }
  title.textContent = ssEd.id ? '🔎 Edit saved search' : '🔎 New saved search';
  hint.textContent = ssEd.editing >= 0 ?
      'Type the text · OK done · Back cancel' :
      'OK edit · Red delete term · ◀ ▶ buttons · Back cancel';
  const addRow = ssAddRow(), hoursRow = ssHoursRow(), btnRow = ssBtnRow();
  for (let i = 0; i < ssRowCount(); i++) {
    const row = document.createElement('div');
    const focused = i === ssEd.focus;
    row.className = 'settings-row ss-row' + (focused ? ' focused' : '');
    if (i === 0) {
      row.innerHTML =
          `<div class="settings-label"><div class="settings-name">Name</div></div>` +
          `<div class="settings-value ss-value"></div>`;
      row.querySelector('.ss-value')
          .appendChild(ssField(0, ssEd.name, 'Name of the search'));
    } else if (i < addRow) {
      const t = ssEd.terms[i - 1];
      row.innerHTML = `<div class="settings-label ss-value"></div>` +
          `<div class="settings-value"><span class="settings-val ss-count">${
                          ssTermCount(t)} channels</span></div>`;
      row.querySelector('.ss-value').appendChild(ssField(i, t, 'Term'));
    } else if (i === addRow) {
      row.innerHTML = `<div class="settings-label ss-value"></div>`;
      row.querySelector('.ss-value')
          .appendChild(ssField(i, '', '+ Add term', true));
    } else if (i === hoursRow) {
      row.classList.add('ss-hours');
      row.innerHTML =
          `<div class="settings-label"><div class="settings-name">Programs starting within</div>` +
          `<div class="settings-sub">Programs on now always match</div></div>` +
          `<div class="settings-value"><span class="settings-val">◀ ${
              ssEd.hours} h ▶</span></div>`;
      row.addEventListener('click', () => {
        ssEd.focus = i;
        ssStepHours(1, true);
      });
    } else {
      row.classList.add('ss-btns');
      const names = ['Save', 'Cancel'].concat(ssEd.id ? ['Delete'] : []);
      row.innerHTML = names
                          .map(
                              (n, b) => `<button class="ss-btn${
                                  focused && b === ssEd.btn ?
                                      ' focused' :
                                      ''}" data-b="${b}">${n}</button>`)
                          .join('');
      row.querySelectorAll('.ss-btn').forEach(el => {
        el.addEventListener('click', e => {
          e.stopPropagation();
          ssEd.focus = btnRow;
          ssEd.btn = +el.dataset.b;
          ssActivateButton();
        });
      });
    }
    if (i < hoursRow)
      row.addEventListener('click', () => {
        ssEd.focus = i;
        ssStartEdit(i);
      });
    list.appendChild(row);
  }
  ssTermsHeader(list);
  const m = ssEditorMatch();
  if (m) {
    sum.textContent =
        `${m.result.length} channels · ${m.nowCount} programs now`;
  } else
    sum.textContent = 'Add a term. A channel shows if 1 or more terms match.';
  const f = list.querySelector('.ss-row.focused');
  if (f) f.scrollIntoView({block: 'nearest'});
  if (ssEd.editing >= 0) {
    const inp = list.querySelector(`input[data-row="${ssEd.editing}"]`);
    if (inp) {
      inp.focus();
      inp.setSelectionRange(inp.value.length, inp.value.length);
    }
  }
}

/**
 * Puts the label "Terms" above the first term row.
 * @param {!Element} list
 * @return {boolean} True when the label was added.
 */
function ssTermsHeader(list) {
  const first = list.children[1];
  if (!first) return false;
  const h = document.createElement('div');
  h.className = 'ss-section';
  h.textContent = 'Terms (a channel shows if 1 or more terms match)';
  list.insertBefore(h, first);
  return true;
}

/**
 * Makes the text field of a row. The field is read-only until you edit it.
 * @param {number} row
 * @param {string} value
 * @param {string} placeholder
 * @param {boolean=} isAdd
 * @return {!HTMLInputElement}
 */
function ssField(row, value, placeholder, isAdd) {
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'ss-input' + (isAdd ? ' ss-add' : '');
  inp.value = value;
  inp.placeholder = placeholder;
  inp.dataset.row = String(row);
  inp.readOnly = ssEd.editing !== row;
  inp.maxLength = 60;
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.keyCode === 13) {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;  // the hold that started the edit
      ssCommitEdit(inp.value);
    }
  });
  return inp;
}

/**
 * Opens the keyboard on a text row.
 * @param {number} row
 */
function ssStartEdit(row) {
  if (row >= ssHoursRow()) return;
  ssEd.editing = row;
  ssRender();
}

/**
 * Ends the edit of a row and keeps the text.
 * @param {string} text
 */
function ssCommitEdit(text) {
  const row = ssEd.editing;
  if (row < 0) return;
  ssEd.editing = -1;
  const v = String(text || '').replace(/\s+/g, ' ').trim();
  if (row === 0) {
    ssEd.name = v;
  } else if (row === ssAddRow()) {
    if (v) {
      ssEd.terms = ssCleanTerms(ssEd.terms.concat([v]));
      ssEd.focus = ssAddRow();  // the next term goes on the same row
    }
  } else {
    const t = ssEd.terms.slice();
    if (v)
      t[row - 1] = v;
    else
      t.splice(row - 1, 1);
    ssEd.terms = ssCleanTerms(t);
  }
  if (_isTextInput(document.activeElement)) document.activeElement.blur();
  ssRender();
}

/** Ends the edit of a row and drops the text. */
function ssCancelEdit() {
  ssEd.editing = -1;
  if (_isTextInput(document.activeElement)) document.activeElement.blur();
  ssRender();
}

function ssActivateButton() {
  if (ssEd.btn === 0)
    ssSaveEditor();
  else if (ssEd.btn === 1)
    ssLeaveEditor();
  else
    ssDeleteEditor();
}

function ssSaveEditor() {
  const terms = ssCleanTerms(ssEd.terms);
  if (!terms.length) {
    showEPGToast('Add 1 term or more.', 'error', 'Saved search');
    hideEPGToast(3000);
    return;
  }
  const all = savedSearches();
  const name = ssEd.name || terms.join(', ');
  let s = ssEd.id ? all.find(x => x.id === ssEd.id) : null;
  if (s) {
    s.name = name;
    s.terms = terms;
    s.hours = ssEd.hours;
  } else {
    s = {id: Date.now().toString(36), name, terms, hours: ssEd.hours};
    all.push(s);
  }
  closeSavedSearchEditor();
  ssSaveAll();
  // Open the saved search
  currentGroup = SS_PREFIX + s.id;
  stdGroupFocusIdx = Math.max(0, groupsList.indexOf(currentGroup));
  if (currentSearchQuery) {
    currentSearchQuery = '';
    searchInput.value = '';
    if (epgSearchInput) epgSearchInput.value = '';
  }
  renderGroupsList();
  refreshCurrentView();
}

function ssDeleteEditor() {
  const all = savedSearches();
  const i = all.findIndex(x => x.id === ssEd.id);
  if (i < 0) return;
  const key = SS_PREFIX + ssEd.id;
  all.splice(i, 1);
  ssLeaveEditor();
  ssSaveAll();
  if (currentGroup === key) {
    currentGroup = 'all';
    stdGroupFocusIdx = Math.max(0, groupsList.indexOf(currentGroup));
    if (_activePlaylistKey) {
      getPlaylistState(_activePlaylistKey).lastGroup = currentGroup;
      savePlaylistState();
    }
    renderGroupsList();
    refreshCurrentView();
  }
}

function ssListActivate() {
  const all = savedSearches();
  const s = all[ssEd.listFocus];
  openSavedSearchEditor(s || null, undefined, true);
}

/**
 * Moves the focused search in the list.
 * @param {number} dir -1 or 1.
 */
function ssListMove(dir) {
  const all = savedSearches();
  const i = ssEd.listFocus, j = i + dir;
  if (i >= all.length || j < 0 || j >= all.length) return;
  [all[i], all[j]] = [all[j], all[i]];
  ssEd.listFocus = j;
  ssSaveAll();
  ssRender();
}

/**
 * The keys of the overlay. While a text field is open, the keys go to it.
 * @param {!KeyboardEvent} e
 */
function handleSavedSearchKey(e) {
  const k = e.key, kc = e.keyCode;
  const up = k === 'ArrowUp' || kc === 38,
        down = k === 'ArrowDown' || kc === 40;
  const left = k === 'ArrowLeft' || kc === 37,
        right = k === 'ArrowRight' || kc === 39;
  const enter = k === 'Enter' || kc === 13;
  const red = kc === 403 || k === 'ColorF0Red';
  if (ssEd.editing >= 0) {
    // The input handles Enter. Up and Down end the edit and keep the text.
    if (up || down) {
      e.preventDefault();
      const inp =
          document.querySelector(`#ssList input[data-row="${ssEd.editing}"]`);
      ssCommitEdit(inp ? inp.value : '');
    }
    return;
  }
  if (ssEd.mode === 'list') {
    const n = savedSearches().length + 1;
    if (up || down) {
      e.preventDefault();
      ssEd.listFocus =
          Math.max(0, Math.min(n - 1, ssEd.listFocus + (up ? -1 : 1)));
      ssRender();
    } else if (left || right) {
      e.preventDefault();
      ssListMove(left ? -1 : 1);
    } else if (enter) {
      e.preventDefault();
      ssListActivate();
    }
    return;
  }
  const btnRow = ssBtnRow();
  if (up || down) {
    e.preventDefault();
    ssEd.focus =
        Math.max(0, Math.min(ssRowCount() - 1, ssEd.focus + (up ? -1 : 1)));
    ssRender();
  } else if ((left || right) && ssEd.focus === ssHoursRow()) {
    e.preventDefault();
    ssStepHours(left ? -1 : 1);
  } else if ((left || right) && ssEd.focus === btnRow) {
    e.preventDefault();
    const nb = ssEd.id ? 3 : 2;
    ssEd.btn = Math.max(0, Math.min(nb - 1, ssEd.btn + (left ? -1 : 1)));
    ssRender();
  } else if (enter) {
    e.preventDefault();
    if (ssEd.focus === btnRow)
      ssActivateButton();
    else if (ssEd.focus === ssHoursRow())
      ssStepHours(1, true);
    else
      ssStartEdit(ssEd.focus);
  } else if (red) {
    e.preventDefault();
    const i = ssEd.focus - 1;
    if (i >= 0 && i < ssEd.terms.length) {
      ssEd.terms.splice(i, 1);
      ssEd.focus = Math.min(ssEd.focus, ssRowCount() - 1);
      ssRender();
    }
  }
}

/**
 * Back in the overlay: ends a text edit, or goes from the editor back to the
 * list, or closes.
 */
function savedSearchBack() {
  if (ssEd.editing >= 0) {
    ssCancelEdit();
    return;
  }
  ssLeaveEditor();
}

/**
 * The terms of the search box for a new saved search. Commas separate the
 * terms. With no comma, the full text is 1 term.
 * @return {!Array<string>}
 */
function ssTermsFromSearchBox() {
  const q = (currentSearchQuery || '').trim();
  if (!q) return [];
  return ssCleanTerms(q.split(','));
}
