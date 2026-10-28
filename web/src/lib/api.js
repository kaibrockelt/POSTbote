// Thin wrapper around the POSTBote HTTP API. Mutations carry X-Postbote, which the
// server requires as CSRF protection.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function call(method, url, body, opts = {}) {
  const headers = { 'X-Postbote': '1' };
  let payload = body;
  if (body !== undefined && !(body instanceof Blob) && !(body instanceof ArrayBuffer) && typeof body !== 'string') {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  } else if (typeof body === 'string') {
    headers['Content-Type'] = 'text/plain; charset=utf-8';
  }
  const res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin', signal: opts.signal });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = (await res.json()).error || msg;
    } catch {
      /* not json */
    }
    throw new ApiError(res.status, msg);
  }
  if (opts.blob) return res.blob();
  return res.json();
}

const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

export const api = {
  info: () => call('GET', '/api/info'),
  login: (username, password) => call('POST', '/api/login', { username, password }),
  logout: () => call('POST', '/api/logout', {}),
  workspaces: () => call('GET', '/api/workspaces'),
  createWorkspace: (body) => call('POST', '/api/workspaces', body),
  deleteWorkspace: (id) => call('DELETE', `/api/workspaces/${id}`),
  files: (id) => call('GET', `/api/workspaces/${id}/files`),
  putFile: (id, path, text) => call('PUT', `/api/workspaces/${id}/files/${enc(path)}`, text),
  deleteFile: (id, path) => call('DELETE', `/api/workspaces/${id}/files/${enc(path)}`),
  renameFile: (id, from, to) => call('POST', `/api/workspaces/${id}/rename`, { from, to }),
  run: (body, signal) => call('POST', '/api/run', body, { signal }),
  exportZip: (name, files, savePath) =>
    savePath ? call('POST', '/api/export', { name, files, savePath }) : call('POST', '/api/export', { name, files }, { blob: true }),
  importZip: (blob) => call('POST', '/api/import', blob),
  getSession: (id) => call('GET', `/api/session/${id}`),
  putSession: (id, session) => call('PUT', `/api/session/${id}`, session),
  setup: (collectionsDir) => call('POST', '/api/setup', { collectionsDir }),
  browse: (path) => call('GET', '/api/browse' + (path ? `?path=${encodeURIComponent(path)}` : '')),
};
