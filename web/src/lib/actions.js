// Sidebar actions on collection items.
import {
  FOLDER_FILE,
  REQ_EXT,
  FLOW_EXT,
  slug,
  uniquePath,
  dirname,
  basename,
  parseRequest,
  serializeRequest,
  parseWorkflow,
  serializeWorkflow,
  serializeFolder,
  parseFolder,
  parseYaml,
  isPublicEnv,
} from './format.js';
import { app, ask, confirmAction, write, removeFile, renameFile, select, setEnv, fail, contentOf, setDraft } from './state.svelte.js';

const guard =
  (fn) =>
  async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      fail(e);
    }
  };

const emptyRequest = (name) => ({
  name,
  method: 'GET',
  url: '{{baseUrl}}/',
  params: [],
  headers: [],
  auth: { type: 'inherit' },
  body: { type: 'none', content: '', fields: [] },
  scripts: { pre: '', post: '' },
  docs: '',
});

/** Keeps workflow step references valid after files were moved. */
function rewriteRefs(moves) {
  for (const [path, text] of Object.entries(app.files)) {
    if (!path.endsWith(FLOW_EXT)) continue;
    const { doc } = parseWorkflow(text);
    if (!doc) continue;
    let changed = false;
    for (const s of doc.steps) {
      if (moves.has(s.request)) {
        s.request = moves.get(s.request);
        changed = true;
      }
    }
    if (changed) write(path, serializeWorkflow(doc));
  }
}

export const newRequest = guard(async (dir = 'requests') => {
  const name = await ask('New request', '', { placeholder: 'e.g. Get user' });
  if (!name) return;
  const path = uniquePath(app.files, dir, slug(name), REQ_EXT);
  write(path, serializeRequest(emptyRequest(name)));
  select({ kind: 'request', path });
});

export const newFolder = guard(async (dir = 'requests') => {
  const name = await ask('New folder', '', { placeholder: 'e.g. Users' });
  if (!name) return;
  let folder = `${dir}/${slug(name)}`;
  for (let i = 2; Object.keys(app.files).some((p) => p.startsWith(folder + '/')); i++) folder = `${dir}/${slug(name)}-${i}`;
  // a folder exists as long as it contains a file; _folder.yaml keeps empty ones alive (also in git)
  write(`${folder}/${FOLDER_FILE}`, serializeFolder({ name, variables: [], headers: [], auth: { type: 'inherit' }, scripts: {} }));
  select({ kind: 'folder', path: folder });
});

export const renameRequest = guard(async (path) => {
  const { doc } = parseRequest(app.files[path]);
  if (!doc) throw new Error('fix the YAML of this request first');
  const name = await ask('Rename request', doc.name || basename(path).slice(0, -REQ_EXT.length));
  if (!name || name === doc.name) return;
  doc.name = name;
  write(path, serializeRequest(doc));
  if (path in app.drafts) {
    const draft = parseRequest(app.drafts[path]).doc;
    if (draft) setDraft(path, serializeRequest({ ...draft, name }));
  }
  const to = uniquePath({ ...app.files, [path]: undefined }, dirname(path), slug(name), REQ_EXT);
  if (to !== path && !(to in app.files)) {
    await renameFile(path, to);
    rewriteRefs(new Map([[path, to]]));
  }
});

export const duplicateRequest = guard(async (path) => {
  const { doc } = parseRequest(contentOf(path));
  if (!doc) throw new Error('fix the YAML of this request first');
  doc.name = `${doc.name || 'request'} copy`;
  const to = uniquePath(app.files, dirname(path), slug(doc.name), REQ_EXT);
  write(to, serializeRequest(doc));
  select({ kind: 'request', path: to });
});

export const moveFolder = guard(async (dir) => {
  const current = basename(dir);
  const name = await ask('Rename folder', parseYaml(app.files[`${dir}/${FOLDER_FILE}`] || '').doc?.name || current);
  if (!name) return;
  const target = `${dirname(dir)}/${slug(name)}`;
  const meta = `${dir}/${FOLDER_FILE}`;
  if (meta in app.files) {
    const { doc } = parseFolder(app.files[meta]);
    if (doc) {
      doc.name = name;
      write(meta, serializeFolder(doc));
    }
  }
  if (target === dir) return;
  if (Object.keys(app.files).some((p) => p.startsWith(target + '/'))) throw new Error(`${target} already exists`);
  await relocateFolder(dir, target);
});

// moves every file of a folder (and its tabs/drafts) to a new directory
async function relocateFolder(dir, target) {
  const moves = new Map();
  for (const p of Object.keys(app.files).filter((p) => p.startsWith(dir + '/'))) {
    const to = target + p.slice(dir.length);
    await renameFile(p, to);
    moves.set(p, to);
  }
  rewriteRefs(moves);
}

/** Moves a request into another folder (keeps its file name if possible). */
export const moveRequest = guard(async (path, dir) => {
  if (dirname(path) === dir) return;
  const to = uniquePath(app.files, dir, basename(path).slice(0, -REQ_EXT.length), REQ_EXT);
  await renameFile(path, to);
  rewriteRefs(new Map([[path, to]]));
});

/** Moves a folder into another folder; not into itself or its own subfolders. */
export const moveFolderInto = guard(async (dir, parent) => {
  if (dirname(dir) === parent || parent === dir || parent.startsWith(dir + '/')) return;
  let target = `${parent}/${basename(dir)}`;
  for (let i = 2; Object.keys(app.files).some((p) => p.startsWith(target + '/')); i++) target = `${parent}/${basename(dir)}-${i}`;
  await relocateFolder(dir, target);
});

export const deleteFolder = guard(async (dir) => {
  const paths = Object.keys(app.files).filter((p) => p.startsWith(dir + '/'));
  if (!(await confirmAction(`Delete folder “${basename(dir)}”?`, `${paths.length} file(s) will be deleted.`))) return;
  for (const p of paths) await removeFile(p);
  if (app.selected?.path?.startsWith(dir)) select(null);
});

export const deleteFile = guard(async (path, label) => {
  if (!(await confirmAction(`Delete “${label || basename(path)}”?`, path))) return;
  await removeFile(path);
  if (app.selected?.path === path) select(null);
  if (app.env === path) setEnv('');
});

export const newWorkflow = guard(async () => {
  const name = await ask('New workflow', '', { placeholder: 'e.g. Onboard users' });
  if (!name) return;
  const path = uniquePath(app.files, 'workflows', slug(name), FLOW_EXT);
  write(path, serializeWorkflow({ name, data: '', steps: [], scripts: { pre: '', post: '' }, settings: { stopOnFailure: false, delayMs: '', maxIterations: '' } }));
  select({ kind: 'workflow', path });
});

export const renameWorkflow = guard(async (path) => {
  const { doc } = parseWorkflow(app.files[path]);
  if (!doc) throw new Error('fix the YAML of this workflow first');
  const name = await ask('Rename workflow', doc.name);
  if (!name) return;
  doc.name = name;
  write(path, serializeWorkflow(doc));
  const to = uniquePath({ ...app.files, [path]: undefined }, dirname(path), slug(name), FLOW_EXT);
  if (to !== path && !(to in app.files)) await renameFile(path, to);
});

export const newEnv = guard(async () => {
  const name = await ask('New environment', '', { placeholder: 'e.g. staging', hint: 'Private (gitignored) by default. Make it public later to commit it.' });
  if (!name) return;
  const path = uniquePath(app.files, 'environments', slug(name), '.env');
  write(path, `# ${name}\n`);
  select({ kind: 'env', path });
  if (!app.env) setEnv(path);
});

export const renameEnv = guard(async (path) => {
  const name = await ask('Rename environment', basename(path).replace(/\.env(\.pub)?$/, ''));
  if (!name) return;
  const to = `environments/${slug(name)}${isPublicEnv(path) ? '.env.pub' : '.env'}`;
  if (to !== path) await renameFile(path, to);
});

export const newFile = guard(async () => {
  const path = await ask('New file', 'data/', { placeholder: 'data/users.csv', hint: 'Any text file, e.g. CSV/JSON data for workflows and scripts.' });
  if (!path || path.endsWith('/')) return;
  if (path in app.files) throw new Error(`${path} already exists`);
  write(path, '');
  select({ kind: 'file', path });
});

export const renamePath = guard(async (path) => {
  const to = await ask('Rename file', path);
  if (!to || to === path) return;
  await renameFile(path, to);
});
