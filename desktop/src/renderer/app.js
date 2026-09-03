// app.js — the whole UI. Plain JS on purpose (see README: a build-tooled
// framework would be overkill for a single local screen). Talks only to the
// embedded API at window.shelfmark.getConfig().apiUrl, using the per-launch
// bearer token — never anything else, per the strict CSP set in main/index.ts.

let config = null;
let currentBookId = null;
let currentBook = null;

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
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3500);
}

function renderGrid(books) {
  const grid = document.getElementById('library-grid');
  const empty = document.getElementById('empty-state');
  grid.innerHTML = '';
  empty.classList.toggle('hidden', books.length > 0);

  for (const book of books) {
    const card = document.createElement('div');
    card.className = 'book-card';
    card.innerHTML = `
      <img class="cover" loading="lazy" src="${config.apiUrl}/api/books/${book.id}/cover" onerror="this.style.visibility='hidden'" />
      <div class="title">${escapeHtml(book.title)}</div>
      <div class="author">${escapeHtml(book.author_name || 'Unknown author')}</div>
    `;
    card.addEventListener('click', () => openDetail(book.id));
    grid.appendChild(card);
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadLibrary(query = '') {
  const params = new URLSearchParams({ sort: 'title', pageSize: '200' });
  if (query) params.set('q', query);
  const data = await api(`/api/books?${params.toString()}`);
  renderGrid(data.books);
}

async function openDetail(id) {
  const book = await api(`/api/books/${id}`);
  currentBookId = id;
  currentBook = book;
  const panel = document.getElementById('detail-panel');
  panel.classList.remove('hidden');

  const hasEpub = (book.files || []).some((f) => f.format === 'epub');
  document.getElementById('detail-open-btn').textContent = hasEpub ? 'Read' : 'Open raw file';

  document.getElementById('detail-cover').src = `${config.apiUrl}/api/books/${id}/cover`;
  const form = document.getElementById('detail-form');
  form.title.value = book.title || '';
  form.authors.value = (book.authors || []).map((a) => a.name).join(', ');
  form.publisher.value = book.publisher || '';
  form.publishedOn.value = book.published_on || '';
  form.language.value = book.language || '';
  form.description.value = book.description || '';
}

function closeDetail() {
  document.getElementById('detail-panel').classList.add('hidden');
  currentBookId = null;
  currentBook = null;
}

async function importPaths(paths) {
  if (!paths || paths.length === 0) return;
  let imported = 0;
  let skipped = 0;
  for (const p of paths) {
    try {
      const result = await api('/api/books/import', { method: 'POST', body: JSON.stringify({ path: p }) });
      if (result.duplicate) {
        skipped++;
      } else {
        imported++;
        if (result.possibleDuplicates && result.possibleDuplicates.length > 0) {
          toast(`Imported "${p.split(/[\\/]/).pop()}" — looks similar to an existing book.`);
        }
      }
    } catch (err) {
      toast(`Failed to import ${p.split(/[\\/]/).pop()}: ${err.message}`);
    }
  }
  toast(`Imported ${imported} book(s)${skipped ? `, skipped ${skipped} duplicate(s)` : ''}.`);
  await loadLibrary(document.getElementById('search-input').value.trim());
}

function setupDragAndDrop() {
  const dropZone = document.getElementById('drop-zone');
  const overlay = document.getElementById('drop-overlay');
  let dragCounter = 0;

  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    overlay.classList.remove('hidden');
  });
  window.addEventListener('dragleave', () => {
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) overlay.classList.add('hidden');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragCounter = 0;
    overlay.classList.add('hidden');
    // Electron's renderer File objects carry a real filesystem `path`.
    const paths = Array.from(e.dataTransfer.files).map((f) => f.path).filter(Boolean);
    await importPaths(paths);
  });
  void dropZone;
}

async function main() {
  config = await window.shelfmark.getConfig();

  document.getElementById('import-btn').addEventListener('click', async () => {
    const paths = await window.shelfmark.pickFiles();
    await importPaths(paths);
  });

  document.getElementById('detail-close').addEventListener('click', closeDetail);

  document.getElementById('detail-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentBookId) return;
    const form = e.target;
    const authors = form.authors.value.split(',').map((s) => s.trim()).filter(Boolean);
    await api(`/api/books/${currentBookId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        title: form.title.value,
        publisher: form.publisher.value || null,
        publishedOn: form.publishedOn.value || null,
        language: form.language.value || null,
        description: form.description.value || null,
        authors,
      }),
    });
    toast('Saved.');
    await loadLibrary(document.getElementById('search-input').value.trim());
  });

  document.getElementById('detail-cover-btn').addEventListener('click', async () => {
    if (!currentBookId) return;
    const imagePath = await window.shelfmark.pickImage();
    if (!imagePath) return;
    await api(`/api/books/${currentBookId}/cover`, { method: 'POST', body: JSON.stringify({ path: imagePath }) });
    document.getElementById('detail-cover').src = `${config.apiUrl}/api/books/${currentBookId}/cover?t=${Date.now()}`;
    await loadLibrary(document.getElementById('search-input').value.trim());
  });

  document.getElementById('detail-open-btn').addEventListener('click', async () => {
    if (!currentBookId) return;
    const hasEpub = (currentBook?.files || []).some((f) => f.format === 'epub');
    if (hasEpub) {
      // Real in-app reader: a separate sandboxed BrowserWindow (book HTML
      // never runs in this window) fed by the server-side-sanitized
      // /api/books/:id/read endpoint. See README "In-app EPUB reader".
      await window.shelfmark.openReader(currentBookId);
      return;
    }
    // Non-EPUB formats have no in-app reader yet — fall back to streaming
    // the raw file to a new window (also exercises Range-request support).
    window.open(`${config.apiUrl}/api/books/${currentBookId}/file`, '_blank');
  });

  document.getElementById('detail-delete-btn').addEventListener('click', async () => {
    if (!currentBookId) return;
    if (!confirm('Delete this book? (soft delete — can be recovered from the DB.)')) return;
    await api(`/api/books/${currentBookId}`, { method: 'DELETE' });
    closeDetail();
    await loadLibrary(document.getElementById('search-input').value.trim());
  });

  let searchDebounce = null;
  document.getElementById('search-input').addEventListener('input', (e) => {
    clearTimeout(searchDebounce);
    const value = e.target.value.trim();
    searchDebounce = setTimeout(() => loadLibrary(value), 200);
  });

  setupDragAndDrop();
  await loadLibrary();
}

main().catch((err) => {
  console.error(err);
  toast(`Startup error: ${err.message}`);
});
