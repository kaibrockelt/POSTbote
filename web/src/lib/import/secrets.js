// Shared clean-up for imported requests: secrets become {{variables}} whose
// values go to the private part of an environment, and URLs that start with
// a known variable's value (e.g. baseUrl) use the variable instead.

const SECRET_HEADERS = /^(authorization|proxy-authorization|x-api-key|api-key|apikey|x-auth-token|x-access-token|x-token|cookie)$/i;
const SECRET_PARAMS = /^(access_token|token|api_key|apikey|api-key|key|secret|client_secret|password|auth|sig|signature)$/i;
const hasVar = (s) => /\{\{.*\}\}/.test(s);

const camel = (s) =>
  String(s)
    .toLowerCase()
    .replace(/^x-/, '')
    .replace(/[^a-z0-9]+(.)/g, (_, c) => c.toUpperCase())
    .replace(/[^a-zA-Z0-9]/g, '') || 'secret';

/**
 * Moves secret values out of the doc (mutates it) and returns
 * [{ key, value, where }]. `taken` holds variable names already in use with
 * their values: equal values share a name, a declared but empty variable
 * (`token=`) gets filled, different values get a suffix.
 */
export function extractSecrets(doc, taken = new Map()) {
  const found = [];
  const use = (base, value, where) => {
    let name = base;
    const free = (n) => !taken.has(n) || taken.get(n) === value || taken.get(n) === '';
    for (let i = 2; !free(name); i++) name = `${base}${i}`;
    if (taken.get(name) !== value) {
      taken.set(name, value);
      found.push({ key: name, value, where });
    }
    return `{{${name}}}`;
  };

  const a = doc.auth;
  if (a?.type === 'bearer' && a.token && !hasVar(a.token)) a.token = use('token', a.token, 'bearer token');
  if (a?.type === 'basic' && a.password && !hasVar(a.password)) a.password = use('password', a.password, 'basic auth password');
  if (a?.type === 'apikey' && a.value && !hasVar(a.value)) a.value = use(camel(a.key || 'apiKey'), a.value, `API key ${a.key}`);

  for (const h of doc.headers || []) {
    if (!SECRET_HEADERS.test(h.key) || !h.value || hasVar(h.value)) continue;
    // keep the scheme visible: "Bearer {{token}}"
    const m = h.value.match(/^(Bearer|Token|Basic|Digest|ApiKey)\s+(.+)$/i);
    if (m) h.value = `${m[1]} ${use(m[1].toLowerCase() === 'basic' ? 'basicAuth' : 'token', m[2], `${h.key} header`)}`;
    else h.value = use(camel(h.key), h.value, `${h.key} header`);
  }
  for (const p of doc.params || []) {
    if (SECRET_PARAMS.test(p.key) && p.value && !hasVar(p.value)) p.value = use(camel(p.key), p.value, `query parameter ${p.key}`);
  }
  return found;
}

/**
 * Replaces the start of the URL with the variable whose value it starts with
 * (longest match), e.g. https://api.example.com/v1/users → {{baseUrl}}/users.
 * `vars` is a list of { name, value }.
 */
export function useKnownVars(doc, vars) {
  const url = doc.url || '';
  let best = null;
  for (const v of vars) {
    const val = String(v.value || '').replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(val) || hasVar(val)) continue;
    const next = url.charAt(val.length);
    if (url.toLowerCase().startsWith(val.toLowerCase()) && (next === '' || '/?#'.includes(next)) && (!best || val.length > best.val.length)) best = { name: v.name, val };
  }
  if (best) doc.url = `{{${best.name}}}${url.slice(best.val.length)}`;
  return best?.name || null;
}
