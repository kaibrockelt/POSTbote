// Turns the result of a collection importer into the files of a new
// collection. Importers deliver docs, not files:
//
//   { name, docs, collection: { variables, headers, auth, scripts },
//     folders: [{ path, doc, docs }],            // path like requests/users
//     requests: [{ dir, doc }],                   // in display order
//     environments: [{ name, values: [{ key, value, secret }] }],
//     warnings }
//
// so secrets, environments, file names and the serializer are handled the
// same way for every format.
import {
  MANIFEST,
  FOLDER_FILE,
  REQ_EXT,
  emptyRequest,
  serializeCollection,
  serializeFolder,
  serializeRequest,
  updateGitignore,
  updateEnv,
  envPublicPath,
  envPrivatePath,
  slug,
  uniquePath,
} from '../format.js';
import { extractSecrets } from './secrets.js';

const emptyAuth = { type: 'inherit', token: '', username: '', password: '', key: '', value: '', in: 'header' };

/** Docs that still contain literal secrets (to offer moving them). */
export function countSecrets(result) {
  let n = 0;
  const taken = new Map();
  for (const d of allDocs(normalize(result))) n += extractSecrets(d, taken).length;
  return n;
}

function normalize(result) {
  const r = structuredClone(result);
  r.collection = { variables: [], headers: [], scripts: {}, ...r.collection };
  r.folders ||= [];
  r.requests ||= [];
  return r;
}

const allDocs = (r) => [r.collection, ...r.folders.map((f) => f.doc), ...r.requests.map((q) => q.doc)];

/**
 * `secretsEnv`: environment that receives literal secrets found in requests,
 * folders and the collection ('' keeps them where they are).
 */
export function buildCollectionFiles(result, { secretsEnv = '' } = {}) {
  const r = normalize(result);
  const envs = new Map((r.environments || []).map((e) => [e.name, e.values.map((v) => ({ ...v }))]));
  const notes = [];

  if (secretsEnv) {
    if (!envs.has(secretsEnv)) envs.set(secretsEnv, []);
    const values = envs.get(secretsEnv);
    const taken = new Map(values.map((v) => [v.key, v.value]));
    let moved = 0;
    for (const d of allDocs(r)) {
      for (const s of extractSecrets(d, taken)) {
        const have = values.find((v) => v.key === s.key);
        if (have) Object.assign(have, { value: s.value, secret: true });
        else values.push({ key: s.key, value: s.value, secret: true });
        moved++;
      }
    }
    if (moved) notes.push(`${moved} token${moved > 1 ? 's/keys' : '/key'} moved to the private values of “${secretsEnv}”`);
  }

  const c = r.collection;
  const files = {
    [MANIFEST]: serializeCollection({
      version: 1,
      name: r.name,
      settings: { commitEnvironments: false, timeoutMs: '', scriptTimeoutMs: '', followRedirects: true, verifyTls: true },
      variables: c.variables,
      headers: c.headers,
      auth: c.auth?.type ? { ...emptyAuth, ...c.auth } : { type: 'none' },
      scripts: c.scripts,
    }),
    '.gitignore': updateGitignore('', false),
  };

  for (const f of r.folders) {
    files[`${f.path}/${FOLDER_FILE}`] = serializeFolder({
      variables: [],
      headers: [],
      scripts: {},
      ...f.doc,
      auth: { ...emptyAuth, ...f.doc.auth },
    });
  }
  // seq keeps the order of the source within each folder
  const seq = new Map();
  for (const { dir, doc } of r.requests) {
    const base = emptyRequest(doc.name || 'request');
    const full = { ...base, ...doc, body: { ...base.body, ...doc.body }, auth: { ...emptyAuth, ...doc.auth } };
    const n = (seq.get(dir) || 0) + 1;
    seq.set(dir, n);
    full.seq = n;
    files[uniquePath(files, dir, slug(full.name) || 'request', REQ_EXT)] = serializeRequest(full);
  }

  for (const [name, values] of envs) {
    const env = slug(name) || 'imported';
    const shared = values.map((v) => ({ key: v.key, value: v.secret ? '' : v.value }));
    const priv = values.filter((v) => v.secret).map((v) => ({ key: v.key, value: v.value }));
    files[envPublicPath(env)] = updateEnv(`# shared values of "${env}", committed to git: no secrets here\n`, shared);
    if (priv.length) files[envPrivatePath(env)] = updateEnv(`# private values of "${env}", not committed (see .gitignore)\n`, priv);
  }

  const readme = [`# ${r.name}`, '', r.docs || 'Imported collection.'];
  for (const f of r.folders) if (f.docs) readme.push('', `## ${f.doc.name || f.path}`, '', f.docs);
  files['README.md'] = readme.join('\n').trim() + '\n';

  return { files, notes };
}
