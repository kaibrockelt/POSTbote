// Browser storage for collections (team server default): IndexedDB, one
// record per collection holding its files. Nothing is persisted server-side.

const DB = 'postbote';
const STORE = 'collections';

let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, fn) {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const t = d.transaction(STORE, mode);
        const r = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve(r?.result);
        t.onerror = () => reject(t.error);
      }),
  );
}

export const browserDb = {
  async list() {
    const all = (await tx('readonly', (s) => s.getAll())) || [];
    return all.map(({ id, name, updated }) => ({ id, name, updated, storage: 'browser' }));
  },
  get: (id) => tx('readonly', (s) => s.get(id)),
  put: (rec) => tx('readwrite', (s) => s.put({ ...rec, updated: Date.now() })),
  remove: (id) => tx('readwrite', (s) => s.delete(id)),
  newId: () => 'b' + Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join(''),
};
