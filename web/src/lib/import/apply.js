// Applies an imported request to the open collection: known base URLs become
// variables, secrets move to the private part of the chosen environment.
import { app, contentOf, write } from '../state.svelte.js';
import { emptyRequest, parseEnv, updateEnv, envPublicPath, envPrivatePath } from '../format.js';
import { variableScope } from '../vars.js';
import { importRequest, nameFromUrl } from './index.js';
import { extractSecrets, useKnownVars } from './secrets.js';

/** Returns { doc, notes } for the pasted text, ready for serializeRequest(). */
/** `env`: environment that receives the secrets ('' keeps them in the request). */
export function importRequestInto(text, dir, name = '', env = '') {
  const { format, doc: parsed, warnings } = importRequest(text);
  const base = emptyRequest(name);
  const doc = { ...base, ...parsed, body: { ...base.body, ...parsed.body }, auth: { ...base.auth, ...parsed.auth } };
  doc.name = name || parsed.name || nameFromUrl(doc.method, doc.url);
  const notes = [`Imported ${format}`];

  const scope = [...variableScope(app.files, env || app.env, dir).values()].filter((v) => !['runtime', 'builtin'].includes(v.source));
  const urlVar = useKnownVars(doc, scope);
  if (urlVar) notes.push(`URL uses {{${urlVar}}}`);

  if (env) {
    const taken = new Map(scope.map((v) => [v.name, v.value]));
    const secrets = extractSecrets(doc, taken);
    if (secrets.length) {
      storeSecrets(env, secrets);
      notes.push(`${secrets.map((s) => s.key).join(', ')} moved to the private values of “${env}”`);
    }
  }
  return { doc, notes, warnings };
}

// private file gets the values, the shared file declares the names empty
// (so teammates see which secrets they need)
function storeSecrets(env, secrets) {
  const add = (path, rows) => {
    const text = contentOf(path);
    const current = parseEnv(text);
    const have = new Map(current.map((r) => [r.key, r]));
    let changed = false;
    for (const r of rows) {
      if (!have.has(r.key)) {
        current.push(r);
        changed = true;
      } else if (have.get(r.key).value === '' && r.value !== '') {
        have.get(r.key).value = r.value; // declared but not set yet
        changed = true;
      }
    }
    if (!changed) return;
    const next = updateEnv(text, current);
    if (path in app.drafts) app.drafts[path] = next;
    else write(path, next);
  };
  add(envPrivatePath(env), secrets.map((s) => ({ key: s.key, value: s.value })));
  add(envPublicPath(env), secrets.map((s) => ({ key: s.key, value: '' })));
}
