// Global app state. The collection is a map of path -> text (the saved
// files). Editors work on drafts (unsaved text per path) that only reach the
// files on save. Persistence of saved files depends on where the collection
// lives: the local disk / server (API) or the browser (IndexedDB).
import { api } from './api.js';
import { browserDb } from './browserdb.js';
import {
  MANIFEST,
  FOLDER_FILE,
  REQ_EXT,
  RUNNER_EXT,
  parseYaml,
  scaffold,
  parseRequest,
  serializeRequest,
  parseWorkflow,
  serializeWorkflow,
  parseCollection,
  updateGitignore,
  uniquePath,
  slug,
  dirname,
  basename,
  envName,
  isEnvFile,
  envPublicPath,
  envPrivatePath,
  listEnvs,
} from './format.js';

export const app = $state({
  info: null,
  workspaces: [],
  ws: null, // { id, name, storage: 'disk' | 'server' | 'browser', path? }
  files: {},
  drafts: {}, // path -> unsaved text
  tabs: [], // [{ kind, path }]
  loading: false,
  selected: null, // active tab: { kind: 'request' | 'folder' | 'workflow' | 'env' | 'collection' | 'file', path }
  env: '',
  results: {}, // path -> run output
  running: {}, // path -> AbortController
  dataScratch: {}, // workflow path -> data typed into the editor without a file
  toasts: [],
  dialog: null,
  picker: null, // folder picker fallback when no native dialog exists
  exporting: false, // export dialog open
  menu: null, // context menu: { x, y, items: [{ label, action?, items?, danger?, disabled? }] }
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

export function openMenu(e, items) {
  e.preventDefault();
  e.stopPropagation();
  app.menu = { x: e.clientX, y: e.clientY, items };
}

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
  delete app.drafts[path];
  for (const t of app.tabs.filter((t) => tabFiles(t).includes(path))) {
    if (!tabFiles(t).some((f) => f in app.files || f in app.drafts)) dropTab(t);
  }
  persistUi();
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
  if (from in app.drafts) {
    app.drafts[to] = app.drafts[from];
    delete app.drafts[from];
  }
  // folders move with their files; tabs follow
  for (const t of app.tabs) {
    if (t.path === from) t.path = to;
    else if (t.kind === 'folder' && from === `${t.path}/${FOLDER_FILE}`) t.path = dirname(to);
  }
  if (app.selected?.path === from) app.selected = { ...app.selected, path: to };
  else if (app.selected?.kind === 'folder' && from === `${app.selected.path}/${FOLDER_FILE}`) app.selected = { ...app.selected, path: dirname(to) };
  persistUi();
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
  // the local app keeps it on disk (new port = new origin on every start)
  const last = app.info.setup?.lastWorkspace || local.get('ws');
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
    flushSession();
    app.ws = { ...ws };
    app.files = files;
    app.results = {};
    await restoreUi(ws.id, files);
    local.set('ws', ws.id);
    if (app.info.mode === 'local') api.setLastWorkspace(ws.id).catch(() => {});
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

// ------------------------------------------------------------ drafts & tabs

const tabKey = (t) => (t ? `${t.kind}:${t.path}` : '');
export const sameTab = (a, b) => tabKey(a) === tabKey(b);

/** The file a tab edits. */
export function tabFile(t) {
  if (t.kind === 'folder') return `${t.path}/${FOLDER_FILE}`;
  if (t.kind === 'collection') return MANIFEST;
  if (t.kind === 'env') return envPublicPath(t.path); // env tabs are keyed by name
  return t.path;
}

/** Current text of a file: the draft if there is one, else the saved file. */
export function contentOf(path) {
  return path in app.drafts ? app.drafts[path] : (app.files[path] ?? '');
}

export function setDraft(path, text) {
  if (text === (app.files[path] ?? '')) delete app.drafts[path];
  else app.drafts[path] = text;
  persistUi();
}

/** Files saved together with a tab (workflow data files have their own buttons). */
export function tabFiles(t) {
  if (t.kind === 'env') return [envPublicPath(t.path), envPrivatePath(t.path)];
  return [tabFile(t)];
}

/** Writes the draft of a single file (e.g. a workflow's data file). */
export function saveFile(path) {
  if (!(path in app.drafts)) return;
  const text = app.drafts[path];
  delete app.drafts[path];
  write(path, text);
  persistUi();
}

export const isDirty = (path) => path in app.drafts;
export const tabDirty = (t) => tabFiles(t).some(isDirty);

// ------------------------------------------------------------ session
// Open tabs, unsaved drafts and the selected environment survive restarts.
// Local app: a session file per collection (<config>/postbote/sessions/);
// team server: this browser's localStorage.

let uiTimer = null;
let uiPending = null;

function sessionSnapshot() {
  return {
    version: 1,
    tabs: $state.snapshot(app.tabs),
    selected: $state.snapshot(app.selected),
    env: app.env || '',
    drafts: $state.snapshot(app.drafts),
  };
}

async function writeSession(id, session) {
  if (app.info?.mode === 'local') await api.putSession(id, session);
  else local.set('session.' + id, JSON.stringify(session));
}

function persistUi() {
  const ws = app.ws;
  if (!ws) return;
  clearTimeout(uiTimer);
  uiPending = ws.id;
  uiTimer = setTimeout(flushSession, 250);
}

/** Writes the session right away (also used before the window closes). */
export function flushSession() {
  clearTimeout(uiTimer);
  if (!uiPending || app.ws?.id !== uiPending) return;
  const id = uiPending;
  uiPending = null;
  writeSession(id, sessionSnapshot()).catch((e) => console.warn('session not saved', e));
}

async function readSession(id) {
  try {
    if (app.info?.mode === 'local') return (await api.getSession(id)).session || {};
    return JSON.parse(local.get('session.' + id) || '{}');
  } catch {
    return {};
  }
}

/** Restores tabs, drafts and environment; reports what no longer exists. */
async function restoreUi(id, files) {
  const s = await readSession(id);
  const drafts = s.drafts && typeof s.drafts === 'object' ? s.drafts : {};
  const missing = [];
  const envNames = new Set(listEnvs(files).map((e) => e.name));
  const exists = (t) => {
    if (t.kind === 'collection') return true;
    if (t.kind === 'folder') return Object.keys(files).some((p) => p.startsWith(t.path + '/'));
    if (t.kind === 'env') return envNames.has(t.path);
    return t.path in files;
  };
  const tabs = [];
  for (let t of Array.isArray(s.tabs) ? s.tabs : []) {
    if (!t?.kind || !t?.path) continue;
    if (t.kind === 'env' && isEnvFile(t.path)) t = { kind: 'env', path: envName(t.path) }; // older sessions stored file paths
    if (tabs.some((x) => sameTab(x, t))) continue;
    if (exists(t)) tabs.push(t);
    else if (tabFiles(t).some((f) => f in drafts)) {
      tabs.push(t); // deleted meanwhile, but the unsaved version is kept
      missing.push(`${t.path} (deleted – your unsaved version is still open)`);
    } else missing.push(t.path);
  }
  // drafts of files that are gone and have no tab cannot be shown anymore
  for (const p of Object.keys(drafts)) if (!(p in files) && !tabs.some((t) => tabFiles(t).includes(p))) delete drafts[p];
  app.drafts = drafts;
  app.tabs = tabs;
  const sel = s.selected?.kind === 'env' && isEnvFile(s.selected.path) ? { kind: 'env', path: envName(s.selected.path) } : s.selected;
  app.selected = tabs.find((t) => sameTab(t, sel)) ?? tabs[0] ?? null;
  app.env = '';
  const env = s.env && isEnvFile(s.env) ? envName(s.env) : s.env;
  if (env) {
    if (envNames.has(env)) app.env = env;
    else {
      const i = missing.indexOf(env); // also open as a tab: report once
      if (i >= 0) missing.splice(i, 1);
      missing.push(`${env} (active environment – switched to “no environment”)`);
    }
  }
  if (missing.length) {
    dialog({
      type: 'info',
      title: 'Some items of your last session are gone',
      message: 'These were open last time but no longer exist in the collection (moved, renamed or deleted outside POSTBote):',
      items: missing,
    });
    persistUi();
  }
}

/** Opens (or focuses) a tab. */
export function select(sel) {
  if (sel && !app.tabs.some((t) => sameTab(t, sel))) {
    const i = app.tabs.findIndex((t) => sameTab(t, app.selected));
    app.tabs.splice(i + 1, 0, { kind: sel.kind, path: sel.path });
  }
  app.selected = sel ? { kind: sel.kind, path: sel.path } : null;
  persistUi();
}

function dropTab(t) {
  const i = app.tabs.findIndex((x) => sameTab(x, t));
  if (i < 0) return;
  app.tabs.splice(i, 1);
  if (sameTab(app.selected, t)) app.selected = app.tabs[i] ?? app.tabs[i - 1] ?? null;
}

const canSaveAs = (t) => ['request', 'workflow', 'env', 'file'].includes(t.kind);

/** Closes a tab, asking what to do with unsaved changes. Resolves false when cancelled. */
export async function closeTab(t) {
  if (tabDirty(t)) {
    const choice = await dialog({ type: 'unsaved', title: `Save changes to “${tabTitle(t)}”?`, message: 'Your changes will be lost if you don’t save them.', canSaveAs: canSaveAs(t) });
    if (!choice) return false;
    if (choice === 'save') await saveTab(t);
    else if (choice === 'saveas') {
      if (!(await saveTabAs(t))) return false;
      t = app.selected; // save-as replaced the tab
    } else for (const f of tabFiles(t)) delete app.drafts[f];
  }
  dropTab(t);
  persistUi();
  return true;
}

export async function saveTab(t = app.selected) {
  if (!t) return;
  for (const f of tabFiles(t)) {
    if (!isDirty(f)) continue;
    const text = app.drafts[f];
    const before = app.files[f];
    delete app.drafts[f];
    write(f, text);
    if (f === MANIFEST) syncGitignore(before, text);
  }
  persistUi();
}

// toggling commitEnvironments rewrites bote's block in .gitignore on save
function syncGitignore(before, after) {
  const was = parseCollection(before || '').doc?.settings.commitEnvironments;
  const now = parseCollection(after).doc?.settings.commitEnvironments;
  if (now === undefined || was === now) return;
  write('.gitignore', updateGitignore(app.files['.gitignore'] ?? '', now));
}

/** Saves the tab's content under a new name; the original file stays as it was. */
export async function saveTabAs(t = app.selected) {
  if (!t || !canSaveAs(t)) return false;
  const text = t.kind === 'env' ? '' : contentOf(t.path);
  let target;
  if (t.kind === 'request' || t.kind === 'workflow') {
    const isReq = t.kind === 'request';
    const doc = (isReq ? parseRequest : parseWorkflow)(text).doc;
    if (!doc) throw new Error('fix the YAML first');
    const name = await ask('Save as', `${doc.name || 'copy'} copy`, { placeholder: 'Name' });
    if (!name) return false;
    doc.name = name;
    target = uniquePath(app.files, dirname(t.path), slug(name), isReq ? REQ_EXT : RUNNER_EXT);
    write(target, (isReq ? serializeRequest : serializeWorkflow)(doc));
  } else if (t.kind === 'env') {
    const name = await ask('Save environment as', `${t.path}-copy`);
    if (!name) return false;
    target = slug(name);
    if (listEnvs(app.files).some((e) => e.name === target)) throw new Error(`environment ${target} already exists`);
    for (const [from, to] of [[envPublicPath(t.path), envPublicPath(target)], [envPrivatePath(t.path), envPrivatePath(target)]]) {
      if (from in app.files || from in app.drafts) write(to, contentOf(from));
      delete app.drafts[from];
    }
  } else {
    const p = await ask('Save file as', t.path);
    if (!p || p === t.path) return false;
    if (p in app.files) throw new Error(`${p} already exists`);
    target = p;
    write(target, text);
  }
  delete app.drafts[t.path];
  const i = app.tabs.findIndex((x) => sameTab(x, t));
  const next = { kind: t.kind, path: target };
  if (i >= 0) app.tabs[i] = next;
  app.selected = next;
  persistUi();
  return true;
}

export function discardTab(t = app.selected) {
  for (const f of tabFiles(t)) delete app.drafts[f];
  persistUi();
}

/** Display name of a tab, derived from the (draft) content. */
export function tabTitle(t) {
  const text = contentOf(tabFile(t));
  if (t.kind === 'collection') return 'Settings';
  if (t.kind === 'env') return t.path;
  if (t.kind === 'file') return basename(t.path);
  const name = parseYaml(text).doc?.name;
  if (name) return String(name);
  return basename(t.path).replace(/\.(req|flow)\.yaml$/, '');
}

/** Activates an environment by name ('' = none). */
export function setEnv(name) {
  app.env = name;
  persistUi();
}

/** Saved files with unsaved drafts applied: what editors show and runs use. */
export function currentFiles() {
  return { ...app.files, ...app.drafts };
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

/**
 * Exports the given files as zip. The desktop app asks for a location with a
 * native save dialog; browsers download the file. Returns the saved path (desktop).
 */
export async function exportWorkspace(files) {
  await flush();
  const fileName = (app.ws.name || 'collection').replace(/[^\w.-]+/g, '-') + '.zip';
  const invoke = window.__TAURI__?.core?.invoke;
  if (invoke && app.info?.mode === 'local') {
    const savePath = await invoke('plugin:dialog|save', { options: { defaultPath: fileName, filters: [{ name: 'Zip archive', extensions: ['zip'] }] } });
    if (!savePath) return null;
    await api.exportZip(app.ws.name, files, savePath);
    return savePath;
  }
  const blob = await api.exportZip(app.ws.name, files);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return null;
}

// ------------------------------------------------------------ running

export async function run(kind, path) {
  if (app.running[path]) return;
  await flush();
  const ctrl = new AbortController();
  app.running[path] = ctrl;
  try {
    // runs use what the editors show, including unsaved drafts
    const body = { kind, path, env: app.env || undefined, overrides: $state.snapshot(app.drafts) };
    if (kind === 'workflow') body.data = workflowData(path);
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

/** Rows for a workflow run: always what its data editor shows (file or scratch). */
export function workflowData(path) {
  const file = parseWorkflow(contentOf(path)).doc?.data;
  if (!file) return app.dataScratch[path] || '';
  return file in app.files ? contentOf(file) : undefined; // missing file: let the runner report it
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

