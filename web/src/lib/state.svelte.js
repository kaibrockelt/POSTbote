// Global app state. The collection is a map of path -> text; editors parse
// the file they show and write it back. Persistence depends on where the
// collection lives: the local disk / server (API) or the browser (IndexedDB).
import { api } from './api.js';
import { browserDb } from './browserdb.js';
import { MANIFEST, parseYaml, scaffold } from './format.js';

export const app = $state({
  info: null,
  workspaces: [],
  ws: null, // { id, name, storage: 'disk' | 'server' | 'browser', path? }
  files: {},
  loading: false,
  selected: null, // { kind: 'request' | 'folder' | 'workflow' | 'env' | 'collection' | 'file', path }
  env: '',
  results: {}, // path -> run output
  running: {}, // path -> AbortController
  toasts: [],
  dialog: null,
  picker: null, // folder picker fallback when no native dialog exists
  saving: 0,
});

const local = {
  get(k) {
    try {
      return localStorage.getItem('postbote.' + k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      if (v == null) localStorage.removeItem('postbote.' + k);
      else localStorage.setItem('postbote.' + k, v);
    } catch {
      /* storage unavailable */
    }
  },
};

// ------------------------------------------------------------ ui helpers

let toastId = 0;
export function toast(message, kind = 'info') {
  const id = ++toastId;
  app.toasts.push({ id, message, kind });
  setTimeout(() => (app.toasts = app.toasts.filter((t) => t.id !== id)), kind === 'error' ? 7000 : 3500);
}

/** Modal prompt/confirm (window.prompt is unavailable in some webviews). */
export function dialog(opts) {
  return new Promise((resolve) => {
    app.dialog = { ...opts, resolve: (v) => ((app.dialog = null), resolve(v)) };
  });
}
export const ask = (title, value = '', opts = {}) => dialog({ type: 'prompt', title, value, ...opts });
export const confirmAction = (title, message = '', okLabel = 'Delete') => dialog({ type: 'confirm', title, message, okLabel });

/** Native folder dialog in the desktop app, otherwise the built-in picker. */
export async function pickFolder(start = '') {
  const invoke = window.__TAURI__?.core?.invoke;
  if (invoke) {
    try {
      return await invoke('plugin:dialog|open', { options: { directory: true, multiple: false, defaultPath: start || undefined } });
    } catch (e) {
      console.warn('native dialog unavailable', e);
    }
  }
  return new Promise((resolve) => {
    app.picker = { start, resolve: (v) => ((app.picker = null), resolve(v)) };
  });
}

/** Local app: where collections live (first-run wizard / app settings). */
export async function setCollectionsDir(dir) {
  await api.setup(dir);
  app.info = await api.info();
  await loadWorkspaces();
}

export function fail(e) {
  console.error(e);
  toast(e?.message || String(e), 'error');
}

// ------------------------------------------------------------ persistence

const pending = new Map(); // path -> timer (disk/server)
let browserTimer = null;
const inflight = new Set();

function track(p) {
  app.saving++;
  inflight.add(p);
  p.catch(fail).finally(() => {
    inflight.delete(p);
    app.saving--;
  });
  return p;
}

function persistBrowser() {
  clearTimeout(browserTimer);
  const ws = app.ws;
  browserTimer = setTimeout(() => {
    browserTimer = null;
    if (!ws || app.ws?.id !== ws.id) return;
    const files = $state.snapshot(app.files);
    const name = parseYaml(files[MANIFEST] || '').doc?.name || ws.name;
    ws.name = name;
    track(browserDb.put({ id: ws.id, name, files })).then(refreshBrowserList);
  }, 250);
}

export function write(path, text) {
  if (app.files[path] === text) return;
  app.files[path] = text;
  const ws = app.ws;
  if (ws.storage === 'browser') return persistBrowser();
  clearTimeout(pending.get(path));
  pending.set(
    path,
    setTimeout(() => {
      pending.delete(path);
      track(api.putFile(ws.id, path, app.files[path] ?? text));
    }, 300),
  );
}

export async function removeFile(path) {
  delete app.files[path];
  delete app.results[path];
  if (app.ws.storage === 'browser') return persistBrowser();
  clearTimeout(pending.get(path));
  pending.delete(path);
  await track(api.deleteFile(app.ws.id, path));
}

export async function renameFile(from, to) {
  if (from === to) return;
  if (to in app.files) throw new Error(`${to} already exists`);
  app.files[to] = app.files[from];
  delete app.files[from];
  if (app.results[from]) app.results[to] = app.results[from];
  delete app.results[from];
  if (app.selected?.path === from) app.selected = { ...app.selected, path: to };
  if (app.env === from) setEnv(to);
  if (app.ws.storage === 'browser') return persistBrowser();
  await flush();
  await track(api.renameFile(app.ws.id, from, to));
}

/** Waits until every pending change is persisted. */
export async function flush() {
  if (browserTimer) {
    clearTimeout(browserTimer);
    browserTimer = null;
    const files = $state.snapshot(app.files);
    await track(browserDb.put({ id: app.ws.id, name: app.ws.name, files }));
  }
  for (const [path, timer] of pending) {
    clearTimeout(timer);
    pending.delete(path);
    track(api.putFile(app.ws.id, path, app.files[path]));
  }
  await Promise.allSettled([...inflight]);
}

// ------------------------------------------------------------ workspaces

async function refreshBrowserList() {
  if (app.info?.mode !== 'server') return;
  const browser = await browserDb.list();
  app.workspaces = [...app.workspaces.filter((w) => w.storage !== 'browser'), ...browser];
}

export async function loadWorkspaces() {
  const { workspaces } = await api.workspaces();
  const browser = app.info.mode === 'server' ? await browserDb.list() : [];
  app.workspaces = [...workspaces, ...browser].sort((a, b) => a.name.localeCompare(b.name));
}

export async function init() {
  app.info = await api.info();
  if (!app.info.authenticated) return;
  await loadWorkspaces();
  const last = local.get('ws');
  const ws = app.workspaces.find((w) => w.id === last) || app.workspaces[0];
  if (ws) await openWorkspace(ws);
}

export async function openWorkspace(ws) {
  if (app.ws) await flush();
  app.loading = true;
  try {
    let files;
    if (ws.storage === 'browser') files = (await browserDb.get(ws.id))?.files || {};
    else files = (await api.files(ws.id)).files;
    app.ws = { ...ws };
    app.files = files;
    app.results = {};
    app.selected = local.get('sel.' + ws.id) ? JSON.parse(local.get('sel.' + ws.id)) : null;
    if (app.selected && !(app.selected.path in files) && app.selected.kind !== 'folder') app.selected = null;
    const env = local.get('env.' + ws.id) || '';
    app.env = env in files ? env : '';
    local.set('ws', ws.id);
  } finally {
    app.loading = false;
  }
}

/** Re-reads a disk/server collection, e.g. after `git pull` in the folder. */
export async function reload() {
  if (!app.ws || app.ws.storage === 'browser') return;
  await flush();
  const { files } = await api.files(app.ws.id);
  app.files = files;
}

export function select(sel) {
  app.selected = sel;
  if (app.ws) local.set('sel.' + app.ws.id, sel ? JSON.stringify(sel) : null);
}

export function setEnv(path) {
  app.env = path;
  if (app.ws) local.set('env.' + app.ws.id, path || null);
}

/** storage: 'browser' | 'server' | 'disk'. Disk without path = new folder in the collections folder. */
export async function createWorkspace({ name, storage, path, files }) {
  files ??= scaffold(name);
  let ws;
  if (storage === 'browser') {
    const id = browserDb.newId();
    const n = parseYaml(files[MANIFEST] || '').doc?.name || name;
    await browserDb.put({ id, name: n, files });
    ws = { id, name: n, storage: 'browser' };
  } else {
    const { id } = await api.createWorkspace({ name, path, files });
    ws = { id, storage };
  }
  await loadWorkspaces();
  await openWorkspace(app.workspaces.find((w) => w.id === ws.id) || ws);
}

export async function removeWorkspace(ws) {
  if (ws.storage === 'browser') await browserDb.remove(ws.id);
  else await api.deleteWorkspace(ws.id);
  if (app.ws?.id === ws.id) {
    app.ws = null;
    app.files = {};
    app.selected = null;
  }
  await loadWorkspaces();
  if (!app.ws && app.workspaces[0]) await openWorkspace(app.workspaces[0]);
}

/** Moves the open browser collection to the server (opt-in) or back. */
export async function moveWorkspace(target) {
  const ws = app.ws;
  await flush();
  const files = $state.snapshot(app.files);
  await createWorkspace({ name: ws.name, storage: target, files });
  if (ws.storage === 'browser') await browserDb.remove(ws.id);
  else await api.deleteWorkspace(ws.id);
  await loadWorkspaces();
}

export async function exportWorkspace() {
  await flush();
  const blob = await api.exportZip(app.ws.name, $state.snapshot(app.files));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (app.ws.name || 'collection').replace(/[^\w.-]+/g, '-') + '.zip';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ------------------------------------------------------------ running

export async function run(kind, path) {
  if (app.running[path]) return;
  await flush();
  const ctrl = new AbortController();
  app.running[path] = ctrl;
  try {
    const body = { kind, path, env: app.env || undefined };
    if (app.ws.storage === 'browser') body.files = $state.snapshot(app.files);
    else body.workspace = app.ws.id;
    const out = await api.run(body, ctrl.signal);
    app.results[path] = out;
    applyChanges(out.changedFiles || {});
    if (out.error) toast(out.error, 'error');
  } catch (e) {
    if (e.name !== 'AbortError') fail(e);
  } finally {
    delete app.running[path];
  }
}

export function cancelRun(path) {
  app.running[path]?.abort();
}

function applyChanges(changes) {
  const paths = Object.keys(changes);
  if (!paths.length) return;
  for (const p of paths) {
    if (changes[p] == null) delete app.files[p];
    else app.files[p] = changes[p];
  }
  // disk/server runs already wrote the files; browser collections persist here
  if (app.ws.storage === 'browser') persistBrowser();
}

