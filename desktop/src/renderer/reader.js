// reader.js — the in-app EPUB reader, running in its own sandboxed
// BrowserWindow (opened via window.shelfmark.openReader in the library
// window). Security model:
//   - Chapter HTML arrives *already sanitized* from /api/books/:id/read/:i
//     (server-side, sanitize.ts). This file never fetches raw book markup.
//   - <img> tags can't send the bearer token, so media is fetched here with
//     fetch()+Authorization and swapped in as blob: URLs.
//   - Internal chapter links arrive as data-href (rewritten server-side)
//     and are turned into spine navigations, never document navigations.

let config = null;
let bookId = null;
let spine = []; // [{ index, href, mediaType }]
let toc = []; // [{ label, href, children }]
let spineIndex = 0;
let objectUrls = [];
let sidebarMode = 'toc'; // 'toc' | 'bookmarks'

const DEFAULT_SETTINGS = {
  theme: 'dark',
  fontFamily: 'serif',
  fontSize: 19, // px
  lineHeight: 1.65,
  margin: 56, // px, horizontal
};
let settings = { ...DEFAULT_SETTINGS };

const FONT_STACKS = {
  serif: 'Georgia, "Iowan Old Style", "Times New Roman", serif',
  sans: '"Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif',
  // OpenDyslexic is not bundled; if the user has it installed it wins,
  // otherwise this degrades to widely-available legible faces.
  dyslexic: 'OpenDyslexic, "Comic Sans MS", "Trebuchet MS", Verdana, sans-serif',
};

// ── API helper ─────────────────────────────────────────────────────────

async function api(pathname, options = {}) {
  const res = await fetch(config.apiUrl + pathname, {
    ...options,
    headers: {
      Authorization: `Bearer ${config.token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

function toast(message) {
  const el = document.getElementById('reader-toast');
  el.textContent = message;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 2500);
}

function scroller() {
  return document.getElementById('reader-scroll');
}

// ── settings (persisted globally and per-book) ─────────────────────────

function loadSettings() {
  let global = {};
  let perBook = {};
  try { global = JSON.parse(localStorage.getItem('shelfmark.reader.settings') || '{}'); } catch { /* ignore */ }
  try { perBook = JSON.parse(localStorage.getItem(`shelfmark.reader.settings.${bookId}`) || '{}'); } catch { /* ignore */ }
  settings = { ...DEFAULT_SETTINGS, ...global, ...perBook };
}

function saveSettings() {
  localStorage.setItem('shelfmark.reader.settings', JSON.stringify(settings));
  localStorage.setItem(`shelfmark.reader.settings.${bookId}`, JSON.stringify(settings));
}

function applySettings() {
  document.body.dataset.theme = settings.theme;
  const content = document.getElementById('content');
  content.style.fontFamily = FONT_STACKS[settings.fontFamily] || FONT_STACKS.serif;
  content.style.fontSize = `${settings.fontSize}px`;
  content.style.lineHeight = String(settings.lineHeight);
  content.style.maxWidth = '100%';
  content.style.paddingLeft = `${settings.margin}px`;
  content.style.paddingRight = `${settings.margin}px`;

  document.getElementById('theme-select').value = settings.theme;
  document.getElementById('font-select').value = settings.fontFamily;
}

function adjustSetting(key, delta, min, max) {
  settings[key] = Math.min(max, Math.max(min, Math.round((settings[key] + delta) * 100) / 100));
  saveSettings();
  // Re-apply typography without losing the reading position.
  const fraction = currentFraction();
  applySettings();
  restoreFraction(fraction);
}

// ── progress ───────────────────────────────────────────────────────────

function currentFraction() {
  const s = scroller();
  const max = s.scrollHeight - s.clientHeight;
  if (max <= 0) return 0;
  return Math.min(1, Math.max(0, s.scrollTop / max));
}

function currentPercent() {
  if (spine.length === 0) return 0;
  return Math.round(((spineIndex + currentFraction()) / spine.length) * 1000) / 10;
}

let saveInFlight = false;
async function saveProgressNow() {
  if (!bookId || saveInFlight) return;
  saveInFlight = true;
  try {
    await api(`/api/books/${bookId}/progress`, {
      method: 'PUT',
      body: JSON.stringify({
        spineIndex,
        scrollFraction: currentFraction(),
        percent: currentPercent(),
      }),
    });
  } catch {
    /* transient — next interval retries */
  } finally {
    saveInFlight = false;
  }
}

// ── chapter loading ────────────────────────────────────────────────────

function releaseObjectUrls() {
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls = [];
}

/** Rewrites /api/... media srcs to blob: URLs fetched with the bearer token. */
async function resolveMedia(root) {
  const imgs = Array.from(root.querySelectorAll('img[src^="/api/"]'));
  await Promise.all(
    imgs.map(async (img) => {
      try {
        const res = await fetch(config.apiUrl + img.getAttribute('src'), {
          headers: { Authorization: `Bearer ${config.token}` },
        });
        if (!res.ok) {
          img.style.display = 'none';
          return;
        }
        const url = URL.createObjectURL(await res.blob());
        objectUrls.push(url);
        img.src = url;
      } catch {
        img.style.display = 'none';
      }
    }),
  );
}

async function loadChapter(index, opts = {}) {
  if (index < 0 || index >= spine.length) return;
  if (!opts.initial) await saveProgressNow(); // persist where we were (spineIndex still holds the old chapter here)

  spineIndex = index;
  const data = await api(`/api/books/${bookId}/read/${index}`);
  const content = document.getElementById('content');

  releaseObjectUrls();
  content.innerHTML = data.html; // sanitized server-side — never raw book HTML
  await resolveMedia(content);

  const s = scroller();
  if (typeof opts.fraction === 'number') {
    restoreFraction(opts.fraction);
    // Images can change scrollHeight after the first restore; do one
    // deferred second pass so the restored position sticks.
    setTimeout(() => restoreFraction(opts.fraction), 300);
  } else if (opts.fragment) {
    const el = content.querySelector(`[id="${CSS.escape(opts.fragment)}"]`);
    if (el) el.scrollIntoView();
    else s.scrollTop = 0;
  } else {
    s.scrollTop = 0;
  }

  updateChrome();
}

function restoreFraction(fraction) {
  const s = scroller();
  const max = s.scrollHeight - s.clientHeight;
  s.scrollTop = max > 0 ? fraction * max : 0;
}

function nextChapter() {
  if (spineIndex < spine.length - 1) loadChapter(spineIndex + 1).catch(showError);
  else toast('End of book.');
}
function prevChapter() {
  if (spineIndex > 0) loadChapter(spineIndex - 1).catch(showError);
  else toast('Start of book.');
}

function showError(err) {
  toast(err.message || String(err));
}

// ── chrome / TOC / bookmarks ───────────────────────────────────────────

function labelForSpineIndex(index) {
  const href = spine[index]?.href;
  let best = null;
  const walk = (items) => {
    for (const item of items) {
      if (item.href && item.href.split('#')[0] === href) best = item.label;
      walk(item.children || []);
    }
  };
  walk(toc);
  return best;
}

function updateChrome() {
  document.getElementById('progress-label').textContent =
    `${spineIndex + 1} / ${spine.length} · ${Math.round(currentPercent())}%`;
  document.getElementById('chapter-label').textContent = labelForSpineIndex(spineIndex) || '';
  document.getElementById('prev-chapter').disabled = spineIndex === 0;
  document.getElementById('next-chapter').disabled = spineIndex >= spine.length - 1;
  markActiveTocItem();
}

function renderToc() {
  const container = document.getElementById('sidebar-content');
  container.innerHTML = '';
  if (toc.length === 0) {
    container.innerHTML = '<p class="sidebar-empty">No table of contents in this book.</p>';
    return;
  }
  const root = document.createElement('ul');
  root.className = 'toc-list';
  const build = (items, ul) => {
    for (const item of items) {
      const li = document.createElement('li');
      li.className = 'toc-item';
      const link = document.createElement('a');
      link.className = 'toc-link';
      link.textContent = item.label;
      if (item.href) {
        const [path, fragment] = item.href.split('#');
        const idx = spine.findIndex((s) => s.href === path);
        if (idx >= 0) {
          link.dataset.spineIndex = String(idx);
          if (fragment) link.dataset.fragment = fragment;
          link.addEventListener('click', () => {
            loadChapter(idx, { fragment }).catch(showError);
          });
        } else {
          link.style.opacity = '0.5';
        }
      }
      li.appendChild(link);
      if (item.children && item.children.length > 0) {
        const childUl = document.createElement('ul');
        childUl.className = 'toc-list';
        build(item.children, childUl);
        li.appendChild(childUl);
      }
      ul.appendChild(li);
    }
  };
  build(toc, root);
  container.appendChild(root);
  markActiveTocItem();
}

function markActiveTocItem() {
  document.querySelectorAll('.toc-link').forEach((el) => {
    el.classList.toggle('active', el.dataset.spineIndex === String(spineIndex));
  });
}

async function renderBookmarks() {
  const container = document.getElementById('sidebar-content');
  container.innerHTML = '';
  const { bookmarks } = await api(`/api/books/${bookId}/bookmarks`);
  if (bookmarks.length === 0) {
    container.innerHTML = '<p class="sidebar-empty">No bookmarks yet — press 🔖+ to add one.</p>';
    return;
  }
  for (const bm of bookmarks) {
    const row = document.createElement('div');
    row.className = 'bookmark-row';
    const label = document.createElement('span');
    label.className = 'bm-label';
    label.textContent = bm.label || `Chapter ${bm.spineIndex + 1}, ${Math.round(bm.scrollFraction * 100)}%`;
    label.addEventListener('click', () => {
      loadChapter(bm.spineIndex, { fraction: bm.scrollFraction }).catch(showError);
    });
    const del = document.createElement('button');
    del.className = 'bm-delete';
    del.textContent = '✕';
    del.title = 'Delete bookmark';
    del.addEventListener('click', async () => {
      await api(`/api/books/${bookId}/bookmarks/${bm.id}`, { method: 'DELETE' });
      await renderBookmarks();
    });
    row.appendChild(label);
    row.appendChild(del);
    container.appendChild(row);
  }
}

function setSidebarMode(mode) {
  sidebarMode = mode;
  document.getElementById('tab-toc').classList.toggle('active', mode === 'toc');
  document.getElementById('tab-bookmarks').classList.toggle('active', mode === 'bookmarks');
  if (mode === 'toc') renderToc();
  else renderBookmarks().catch(showError);
}

function toggleSidebar(mode) {
  const sidebar = document.getElementById('sidebar');
  const wantOpen = sidebar.classList.contains('hidden') || sidebarMode !== mode;
  if (wantOpen) {
    sidebar.classList.remove('hidden');
    setSidebarMode(mode);
  } else {
    sidebar.classList.add('hidden');
  }
}

// ── wiring ─────────────────────────────────────────────────────────────

function bindControls() {
  document.getElementById('back-btn').addEventListener('click', async () => {
    await saveProgressNow();
    window.close();
  });
  document.getElementById('toc-btn').addEventListener('click', () => toggleSidebar('toc'));
  document.getElementById('bookmarks-btn').addEventListener('click', () => toggleSidebar('bookmarks'));
  document.getElementById('tab-toc').addEventListener('click', () => setSidebarMode('toc'));
  document.getElementById('tab-bookmarks').addEventListener('click', () => setSidebarMode('bookmarks'));
  document.getElementById('sidebar-close').addEventListener('click', () =>
    document.getElementById('sidebar').classList.add('hidden'),
  );

  document.getElementById('bookmark-add-btn').addEventListener('click', async () => {
    const chapterLabel = labelForSpineIndex(spineIndex);
    const label = `${chapterLabel ? chapterLabel + ' — ' : ''}Ch. ${spineIndex + 1}, ${Math.round(currentFraction() * 100)}%`;
    await api(`/api/books/${bookId}/bookmarks`, {
      method: 'POST',
      body: JSON.stringify({ spineIndex, scrollFraction: currentFraction(), label }),
    });
    toast('Bookmark added.');
    if (!document.getElementById('sidebar').classList.contains('hidden') && sidebarMode === 'bookmarks') {
      await renderBookmarks();
    }
  });

  document.getElementById('prev-chapter').addEventListener('click', prevChapter);
  document.getElementById('next-chapter').addEventListener('click', nextChapter);

  document.getElementById('theme-select').addEventListener('change', (e) => {
    settings.theme = e.target.value;
    saveSettings();
    applySettings();
  });
  document.getElementById('font-select').addEventListener('change', (e) => {
    settings.fontFamily = e.target.value;
    saveSettings();
    applySettings();
  });
  document.getElementById('font-inc').addEventListener('click', () => adjustSetting('fontSize', 1, 12, 36));
  document.getElementById('font-dec').addEventListener('click', () => adjustSetting('fontSize', -1, 12, 36));
  document.getElementById('lh-inc').addEventListener('click', () => adjustSetting('lineHeight', 0.1, 1.1, 2.5));
  document.getElementById('lh-dec').addEventListener('click', () => adjustSetting('lineHeight', -0.1, 1.1, 2.5));
  document.getElementById('margin-inc').addEventListener('click', () => adjustSetting('margin', 16, 0, 320));
  document.getElementById('margin-dec').addEventListener('click', () => adjustSetting('margin', -16, 0, 320));

  // In-chapter links: data-href = cross-chapter (server-rewritten), "#…" = same-chapter.
  document.getElementById('content').addEventListener('click', (e) => {
    const anchor = e.target.closest('a');
    if (!anchor) return;
    e.preventDefault();
    const dataHref = anchor.getAttribute('data-href');
    if (dataHref) {
      const [path, fragment] = dataHref.split('#');
      const idx = spine.findIndex((s) => s.href === path);
      if (idx >= 0) loadChapter(idx, { fragment }).catch(showError);
      return;
    }
    const href = anchor.getAttribute('href') || '';
    if (href.startsWith('#') && href.length > 1) {
      const el = document
        .getElementById('content')
        .querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth' });
    }
  });

  // Keyboard navigation: ←/→ change chapter, PgUp/PgDn page within it,
  // ↑/↓ scroll smoothly (native behavior, kept).
  window.addEventListener('keydown', (e) => {
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const s = scroller();
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        nextChapter();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        prevChapter();
        break;
      case 'PageDown':
        e.preventDefault();
        s.scrollBy({ top: s.clientHeight * 0.92, behavior: 'smooth' });
        break;
      case 'PageUp':
        e.preventDefault();
        s.scrollBy({ top: -s.clientHeight * 0.92, behavior: 'smooth' });
        break;
    }
  });

  // Persist on interval and (with keepalive) on window close.
  setInterval(saveProgressNow, 5000);
  window.addEventListener('beforeunload', () => {
    const body = JSON.stringify({
      spineIndex,
      scrollFraction: currentFraction(),
      percent: currentPercent(),
    });
    fetch(`${config.apiUrl}/api/books/${bookId}/progress`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
  });
}

// ── startup ────────────────────────────────────────────────────────────

async function main() {
  config = await window.shelfmark.getConfig();
  bookId = new URLSearchParams(location.search).get('book');
  if (!bookId) {
    document.getElementById('content').innerHTML = '<p>No book specified.</p>';
    return;
  }

  const book = await api(`/api/books/${bookId}`);
  document.getElementById('book-title').textContent = book.title || 'Untitled';
  document.getElementById('book-author').textContent = (book.authors || []).map((a) => a.name).join(', ');
  document.title = `${book.title || 'Untitled'} — Shelfmark Reader`;

  const tocData = await api(`/api/books/${bookId}/toc`);
  spine = tocData.spine;
  toc = tocData.toc;
  if (spine.length === 0) {
    document.getElementById('content').innerHTML = '<p>This EPUB has no readable spine items.</p>';
    return;
  }

  loadSettings();
  applySettings();
  bindControls();
  renderToc();

  const { progress } = await api(`/api/books/${bookId}/progress`);
  const startIndex = progress ? Math.min(progress.spineIndex, spine.length - 1) : 0;
  const startFraction = progress ? progress.scrollFraction : 0;
  await loadChapter(startIndex, { fraction: startFraction, initial: true });
}

main().catch((err) => {
  console.error(err);
  document.getElementById('content').innerHTML =
    `<p>Failed to open this book: ${String(err.message || err).replace(/[<>&]/g, '')}</p>`;
});
