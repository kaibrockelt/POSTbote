// Derives the sidebar structure from the flat file map.
import YAML from 'yaml';
import { FLOW_EXT, FOLDER_FILE, REQ_EXT, isEnvFile, basename } from './format.js';

const metaCache = new Map(); // text -> { name, method }

function meta(text, fallback) {
  let m = metaCache.get(text);
  if (!m) {
    try {
      const d = YAML.parse(text) || {};
      m = { name: d.name ? String(d.name) : '', method: String(d.method || 'GET').toUpperCase(), seq: Number(d.seq) || 0 };
    } catch {
      m = { name: '', method: '?', seq: 0, broken: true };
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
    } else if (path.startsWith('workflows/') && path.endsWith(FLOW_EXT)) {
      workflows.push({ path, ...meta(text, basename(path).slice(0, -FLOW_EXT.length)) });
      continue;
    } else if (isEnvFile(path)) {
      envs.push(path);
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
  envs.sort();
  other.sort();
  return { root, workflows, envs, other };
}

export function allRequests(files) {
  return Object.keys(files)
    .filter((p) => p.startsWith('requests/') && p.endsWith(REQ_EXT))
    .sort()
    .map((path) => ({ path, ...meta(files[path], basename(path).slice(0, -REQ_EXT.length)) }));
}
