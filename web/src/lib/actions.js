// Sidebar actions on collection items.
import {
  FOLDER_FILE,
  REQ_EXT,
  RUNNER_EXT,
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
  envPublicPath,
  envPrivatePath,
  listEnvs,
  emptyRequest,
} from './format.js';
import { app, ask, confirmAction, askRemove, canTrash, trashPaths, write, removeFile, renameFile, select, setEnv, fail, toast, contentOf, setDraft } from './state.svelte.js';
import { requestImporters } from './import/index.js';
import { importRequestInto, hasSecrets } from './import/apply.js';

const guard =
  (fn) =>
  async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      fail(e);
    }
  };

/** Keeps runner step references valid after files were moved. */
function rewriteRefs(moves) {
  for (const [path, text] of Object.entries(app.files)) {
    if (!path.endsWith(RUNNER_EXT)) continue;
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
  const formats = requestImporters.map((i) => i.label).join(', ');
  const paste = formats && {
    label: `Paste a request (${formats}) – optional`,
    placeholder: "curl https://api.example.com/users -H 'Accept: application/json'",
    target: {
      label: 'Store tokens and keys in',
      value: '',
      options: [
        { value: '', label: 'Nowhere (keep them in the request)' },
        { value: NEW_ENV, label: 'New environment…' },
        ...listEnvs(app.files).map((e) => ({ value: e.name, label: e.name })),
      ],
    },
  };
  const res = await ask('New request', '', { placeholder: paste ? 'Name (optional when pasting)' : 'e.g. Get user', paste });
  const { value: name, paste: text, target } = typeof res === 'string' ? { value: res, paste: '' } : res || {};
  if (!name && !text) return;
  let doc = emptyRequest(name);
  if (text) {
    // a new environment only makes sense when there is something to put in it
    const env = target === NEW_ENV ? (hasSecrets(text) ? await createEnv() : '') : target;
    if (env === null) return;
    const imported = importRequestInto(text, dir, name, env);
    doc = imported.doc;
    toast(imported.notes.join(' · '));
    for (const w of imported.warnings) toast(w);
  }
  const path = uniquePath(app.files, dir, slug(doc.name), REQ_EXT);
  write(path, serializeRequest(doc));
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

/**
 * Deletes or trashes: `mode` comes from a menu entry, otherwise the user is
 * asked. `trash` lists what goes to the system trash (a folder as a whole),
 * `files` what disappears from the collection.
 */
async function discard(title, message, { files, trash = files, mode }) {
  // a menu entry picks the mode; deleting for good is still confirmed
  if (!mode) mode = await askRemove(title, message);
  else if (mode === 'delete' && !(await confirmAction(title.replace(/^Remove/, 'Delete'), `${message}\nThis cannot be undone.`))) return false;
  if (!mode) return false;
  if (mode === 'trash' && canTrash()) {
    await trashPaths(trash);
    toast(`Moved to the trash: ${trash.join(', ')}`);
  } else {
    if (mode === 'trash') return false;
    for (const p of files) await removeFile(p);
  }
  return true;
}

/** Menu entries for removing something: trash (local app) and delete. */
export const removeItems = (fn) => [
  ...(canTrash() ? [{ label: 'Move to trash', action: () => fn('trash') }] : []),
  { label: 'Delete', danger: true, action: () => fn('delete') },
];

export const deleteFolder = guard(async (dir, mode) => {
  const files = Object.keys(app.files).filter((p) => p.startsWith(dir + '/'));
  if (!(await discard(`Remove folder “${basename(dir)}”?`, `${files.length} file(s): ${dir}/`, { files, trash: [dir], mode }))) return;
  if (app.selected?.path?.startsWith(dir)) select(null);
});

export const deleteFile = guard(async (path, label, mode) => {
  if (!(await discard(`Remove “${label || basename(path)}”?`, path, { files: [path], mode }))) return;
  if (app.selected?.path === path) select(null);
});

export const newWorkflow = guard(async () => {
  const name = await ask('New runner', '', { placeholder: 'e.g. Onboard users' });
  if (!name) return;
  const path = uniquePath(app.files, 'runners', slug(name), RUNNER_EXT);
  write(path, serializeWorkflow({ name, data: '', steps: [], scripts: { pre: '', post: '' }, settings: { stopOnFailure: false, delayMs: '', maxIterations: '' } }));
  select({ kind: 'workflow', path });
});

export const renameWorkflow = guard(async (path) => {
  const { doc } = parseWorkflow(app.files[path]);
  if (!doc) throw new Error('fix the YAML of this runner first');
  const name = await ask('Rename runner', doc.name);
  if (!name) return;
  doc.name = name;
  write(path, serializeWorkflow(doc));
  const to = uniquePath({ ...app.files, [path]: undefined }, dirname(path), slug(name), RUNNER_EXT);
  if (to !== path && !(to in app.files)) await renameFile(path, to);
});

const NEW_ENV = '\0new';

/** Asks for a name and creates the environment; null when cancelled. */
async function createEnv() {
  const name = await ask('New environment', '', {
    placeholder: 'e.g. staging',
    hint: 'Shared values go to <name>.env.pub (committed), secrets to <name>.env (private).',
  });
  if (!name) return null;
  const env = slug(name);
  if (listEnvs(app.files).some((e) => e.name === env)) throw new Error(`environment ${env} already exists`);
  write(envPublicPath(env), `# shared values of "${env}", committed to git: no secrets here\n`);
  if (!app.env) setEnv(env);
  return env;
}

export const newEnv = guard(async () => {
  const env = await createEnv();
  if (env) select({ kind: 'env', path: env });
});

export const renameEnv = guard(async (env) => {
  const name = await ask('Rename environment', env);
  if (!name) return;
  const to = slug(name);
  if (to === env) return;
  if (listEnvs(app.files).some((e) => e.name === to)) throw new Error(`environment ${to} already exists`);
  for (const [from, target] of [[envPublicPath(env), envPublicPath(to)], [envPrivatePath(env), envPrivatePath(to)]]) {
    if (from in app.files) await renameFile(from, target);
  }
  for (const t of app.tabs) if (t.kind === 'env' && t.path === env) t.path = to;
  if (app.selected?.kind === 'env' && app.selected.path === env) app.selected = { kind: 'env', path: to };
  if (app.env === env) setEnv(to);
});

export const deleteEnv = guard(async (env, mode) => {
  const files = [envPublicPath(env), envPrivatePath(env)].filter((f) => f in app.files);
  if (!(await discard(`Remove environment “${env}”?`, files.join(', '), { files, mode }))) return;
  if (app.env === env) setEnv('');
});

export const newFile = guard(async () => {
  const path = await ask('New file', 'data/', { placeholder: 'data/users.csv', hint: 'Any text file, e.g. CSV/JSON data for runners and scripts.' });
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
