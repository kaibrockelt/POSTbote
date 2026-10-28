// Derives the sidebar structure from the flat file map.
import YAML from 'yaml';
import { RUNNER_EXT, FOLDER_FILE, REQ_EXT, isEnvFile, basename, listEnvs } from './format.js';

const metaCache = new Map(); // text -> { name, method }

function meta(text, fallback) {
  let m = metaCache.get(text);
  if (!m) {
    try {
      const d = YAML.parse(text) || {};
      m = { name: d.name ? String(d.name) : '', method: String(d.method || 'GET').toUpperCase(), url: String(d.url || ''), seq: Number(d.seq) || 0 };
    } catch {
      m = { name: '', method: '?', url: '', seq: 0, broken: true };
    }
    if (metaCache.size > 5000) metaCache.clear();
    metaCache.set(text, m);
  }
  return { ...m, name: m.name || fallback };
}

const byOrder = (a, b) => a.seq - b.seq || a.name.localeCompare(b.name, undefined, { numeric: true });

export function buildTree(files) {
  const root = { name: 'requests', path: 'requests', folders: [], requests: [], hasMeta: false };
  const index = new Map([['requests', root]]);
  const folder = (path) => {
    if (index.has(path)) return index.get(path);
    const parent = folder(path.slice(0, path.lastIndexOf('/')));
    const f = { name: basename(path), path, folders: [], requests: [], hasMeta: false };
    parent.folders.push(f);
    index.set(path, f);
    return f;
  };
  const workflows = [];
  const envs = [];
  const other = [];
  for (const [path, text] of Object.entries(files)) {
    if (path.startsWith('requests/')) {
      const dir = path.slice(0, path.lastIndexOf('/'));
      const f = folder(dir);
      if (path.endsWith('/' + FOLDER_FILE)) {
        f.hasMeta = true;
        f.label = meta(text, '').name;
        continue;
      }
      if (path.endsWith(REQ_EXT)) {
        f.requests.push({ path, ...meta(text, basename(path).slice(0, -REQ_EXT.length)) });
        continue;
      }
    } else if (path.startsWith('runners/') && path.endsWith(RUNNER_EXT)) {
      workflows.push({ path, ...meta(text, basename(path).slice(0, -RUNNER_EXT.length)) });
      continue;
    } else if (isEnvFile(path)) {
      continue;
    } else if (path === 'postbote.yaml') {
      continue;
    }
    other.push(path);
  }
  const sort = (f) => {
    f.folders.sort((a, b) => (a.label || a.name).localeCompare(b.label || b.name));
    f.requests.sort(byOrder);
    f.folders.forEach(sort);
  };
  sort(root);
  workflows.sort(byOrder);
  envs.push(...listEnvs(files));
  other.sort();
  return { root, workflows, envs, other };
}

export function allRequests(files) {
  return Object.keys(files)
    .filter((p) => p.startsWith('requests/') && p.endsWith(REQ_EXT))
    .sort()
    .map((path) => ({ path, ...meta(files[path], basename(path).slice(0, -REQ_EXT.length)) }));
}

/** Request folders as [{ path, label }] for "move to" menus, top level first. */
export function folderList(root) {
  const out = [{ path: root.path, label: '/ (top level)' }];
  const walk = (f, prefix) => {
    for (const c of f.folders) {
      const label = `${prefix}${c.label || c.name}`;
      out.push({ path: c.path, label });
      walk(c, label + ' / ');
    }
  };
  walk(root, '');
  return out;
}

/**
 * Filters the request tree. Every word of the query has to match the
 * request's method, name, URL or folder names (not the file path).
 */
export function filterTree(root, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return root;
  const walk = (f, folderText) => {
    const text = f === root ? '' : `${folderText} ${f.label || f.name}`.toLowerCase();
    const requests = f.requests.filter((r) => {
      const hay = `${r.method} ${r.name} ${r.url} ${text}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    const folders = f.folders.map((c) => walk(c, text)).filter((c) => c.folders.length || c.requests.length);
    return { ...f, folders, requests };
  };
  return walk(root, '');
}
