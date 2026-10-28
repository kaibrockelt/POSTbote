// Script API of postbote. Evaluated once per run. The only native function is
// __host(op, argsJson) -> '{"v":...}' | '{"u":1}' | '{"e":"message"}'.
(function (g) {
  var host = g.__host;
  delete g.__host;

  function call(op) {
    var args = Array.prototype.slice.call(arguments, 1);
    var r = JSON.parse(host(op, JSON.stringify(args)));
    if (r.e !== undefined) throw new Error(r.e);
    return r.u ? undefined : r.v;
  }
  function str(v) {
    return typeof v === 'string' ? v : (v === undefined ? '' : JSON.stringify(v));
  }
  function fmt(v) {
    if (typeof v === 'string') return JSON.stringify(v);
    try { var s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch (e) { return String(v); }
  }
  function show(v) {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return String(v);
    if (v === undefined) return 'undefined';
    if (typeof v === 'function') return '[function]';
    try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); }
  }
  function deepEq(a, b) {
    if (a === b) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    var ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(function (k) { return deepEq(a[k], b[k]); });
  }

  // ------------------------------------------------------------ assertions
  var checks = {
    toBe: function (a, b) { return [a === b, fmt(a) + ' to be ' + fmt(b)]; },
    toEqual: function (a, b) { return [deepEq(a, b), fmt(a) + ' to equal ' + fmt(b)]; },
    toBeTruthy: function (a) { return [!!a, fmt(a) + ' to be truthy']; },
    toBeFalsy: function (a) { return [!a, fmt(a) + ' to be falsy']; },
    toBeDefined: function (a) { return [a !== undefined, 'value to be defined']; },
    toBeUndefined: function (a) { return [a === undefined, fmt(a) + ' to be undefined']; },
    toBeNull: function (a) { return [a === null, fmt(a) + ' to be null']; },
    toContain: function (a, b) {
      var ok = a != null && (Array.isArray(a) ? a.some(function (x) { return deepEq(x, b); }) : String(a).indexOf(b) >= 0);
      return [ok, fmt(a) + ' to contain ' + fmt(b)];
    },
    toMatch: function (a, re) { return [(re instanceof RegExp ? re : new RegExp(re)).test(String(a)), fmt(a) + ' to match ' + String(re)]; },
    toBeGreaterThan: function (a, b) { return [a > b, fmt(a) + ' to be > ' + fmt(b)]; },
    toBeGreaterThanOrEqual: function (a, b) { return [a >= b, fmt(a) + ' to be >= ' + fmt(b)]; },
    toBeLessThan: function (a, b) { return [a < b, fmt(a) + ' to be < ' + fmt(b)]; },
    toBeLessThanOrEqual: function (a, b) { return [a <= b, fmt(a) + ' to be <= ' + fmt(b)]; },
    toHaveProperty: function (a, k) { return [a != null && Object.prototype.hasOwnProperty.call(Object(a), k), 'object to have property ' + fmt(k)]; },
    toHaveLength: function (a, n) { return [a != null && a.length === n, 'length ' + (a == null ? a : a.length) + ' to be ' + n]; },
    toBeOneOf: function (a, list) { return [list.some(function (x) { return deepEq(x, a); }), fmt(a) + ' to be one of ' + fmt(list)]; },
    toBeType: function (a, t) {
      var at = Array.isArray(a) ? 'array' : a === null ? 'null' : typeof a;
      return [at === t, fmt(a) + ' to be of type ' + t];
    }
  };
  g.expect = function (actual) {
    var pos = {}, neg = {};
    Object.keys(checks).forEach(function (name) {
      pos[name] = function () {
        var r = checks[name].apply(null, [actual].concat(Array.prototype.slice.call(arguments)));
        if (!r[0]) throw new Error('expected ' + r[1]);
        return pos;
      };
      neg[name] = function () {
        var r = checks[name].apply(null, [actual].concat(Array.prototype.slice.call(arguments)));
        if (r[0]) throw new Error('expected NOT ' + r[1]);
        return neg;
      };
    });
    pos.not = neg;
    return pos;
  };
  g.assert = function (cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); };
  g.test = function (name, fn) {
    try { fn(); call('test', String(name), true, ''); }
    catch (e) { call('test', String(name), false, String(e && e.message !== undefined ? e.message : e)); }
  };

  // ------------------------------------------------------------ console
  g.console = {};
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    g.console[level] = function () {
      call('log', level, Array.prototype.map.call(arguments, show).join(' '));
    };
  });

  // ------------------------------------------------------------ variables
  g.env = {
    name: call('env.name'),
    get: function (k) { return call('env.get', String(k)); },
    set: function (k, v) { call('env.set', String(k), str(v)); },
    unset: function (k) { call('env.unset', String(k)); },
    all: function () { return call('env.all'); }
  };
  // cookie jar of the active environment (kept across runs)
  g.cookies = {
    get: function (name, url) { return call('cookies.get', String(name), url ? String(url) : ''); },
    all: function () { return call('cookies.all'); },
    set: function (name, value, url) { call('cookies.set', String(name), str(value), String(url || '')); },
    clear: function () { call('cookies.clear'); }
  };
  g.vars = {
    get: function (k) { return call('vars.get', String(k)); },
    set: function (k, v) { call('vars.set', String(k), v === undefined ? null : v); },
    unset: function (k) { call('vars.unset', String(k)); },
    has: function (k) { return call('vars.has', String(k)); },
    all: function () { return call('vars.all'); },
    // resolve looks a name up through all scopes, exactly like {{name}}
    resolve: function (k) { return call('vars.resolve', String(k)); },
    interpolate: function (s) { return call('interpolate', String(s)); }
  };
  var col = call('collection');
  g.collection = { name: col.name, vars: col.vars };

  // ------------------------------------------------------------ files (sandboxed to the collection)
  g.fs = {
    read: function (p) { return call('fs.read', String(p)); },
    readJson: function (p) { return JSON.parse(call('fs.read', String(p))); },
    write: function (p, c) { call('fs.write', String(p), typeof c === 'string' ? c : JSON.stringify(c, null, 2)); },
    writeJson: function (p, v) { call('fs.write', String(p), JSON.stringify(v, null, 2) + '\n'); },
    append: function (p, c) { call('fs.append', String(p), typeof c === 'string' ? c : JSON.stringify(c)); },
    exists: function (p) { return call('fs.exists', String(p)); },
    remove: function (p) { call('fs.remove', String(p)); },
    list: function (dir) { return call('fs.list', dir === undefined ? '' : String(dir)); }
  };
  g.csv = {
    parse: function (text, opts) { return call('csv.parse', String(text), opts || {}); },
    stringify: function (rows, opts) { return call('csv.stringify', rows, opts || {}); }
  };
  g.util = {
    uuid: function () { return call('uuid'); },
    now: function () { return Date.now(); },
    isoNow: function () { return new Date().toISOString(); },
    randomInt: function (min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; },
    base64Encode: function (s) { return call('base64.encode', String(s)); },
    base64Decode: function (s) { return call('base64.decode', String(s)); },
    hash: function (alg, s) { return call('hash', String(alg), String(s)); },
    hmac: function (alg, key, msg) { return call('hmac', String(alg), String(key), String(msg)); },
    sleep: function (ms) { call('sleep', Number(ms) || 0); }
  };
  g.postbote = {
    // synchronous request from a script, e.g. to fetch a token
    sendRequest: function (opts) {
      if (typeof opts === 'string') opts = { url: opts };
      return g.__makeRes(call('send', opts));
    }
  };

  // ------------------------------------------------------------ request / response wrappers
  function headerFind(obj, k) {
    k = String(k).toLowerCase();
    return Object.keys(obj).filter(function (h) { return h.toLowerCase() === k; })[0];
  }
  g.__makeReq = function (d) {
    var r = { name: d.name, method: d.method, url: d.url, body: d.body, bodyType: d.bodyType,
              headers: {}, params: d.params || [], fields: d.fields || [] };
    (d.headers || []).forEach(function (h) { r.headers[h[0]] = h[1]; });
    r.getHeader = function (k) { var h = headerFind(r.headers, k); return h === undefined ? undefined : r.headers[h]; };
    r.setHeader = function (k, v) { var h = headerFind(r.headers, k); if (h !== undefined) delete r.headers[h]; r.headers[k] = String(v); };
    r.removeHeader = function (k) { var h = headerFind(r.headers, k); if (h !== undefined) delete r.headers[h]; };
    r.setParam = function (k, v) {
      var p = r.params.filter(function (p) { return p.key === k; })[0];
      if (p) p.value = String(v); else r.params.push({ key: k, value: String(v) });
    };
    r.removeParam = function (k) { r.params = r.params.filter(function (p) { return p.key !== k; }); };
    r.json = function () { return JSON.parse(r.body); };
    r.setJson = function (o) { r.body = JSON.stringify(o, null, 2); r.bodyType = 'json'; };
    return r;
  };
  g.__exportReq = function (r) {
    return {
      method: String(r.method || 'GET'), url: String(r.url || ''),
      body: r.body == null ? '' : str(r.body), bodyType: String(r.bodyType || ''),
      headers: Object.keys(r.headers || {}).map(function (k) { return [k, String(r.headers[k])]; }),
      params: (r.params || []).map(function (p) { return { key: String(p.key), value: p.value == null ? '' : String(p.value) }; }),
      fields: (r.fields || []).map(function (f) { return { key: String(f.key), value: f.value == null ? '' : String(f.value), file: f.file ? String(f.file) : '' }; })
    };
  };
  g.__makeRes = function (d) {
    var r = { status: d.status, statusText: d.statusText, headers: {}, body: d.body, timeMs: d.timeMs, size: d.size, encoding: d.encoding || '' };
    (d.headers || []).forEach(function (h) {
      var k = h[0].toLowerCase();
      r.headers[k] = (k in r.headers) ? r.headers[k] + ', ' + h[1] : h[1];
    });
    var cache, parsed = false;
    r.json = function () { if (!parsed) { cache = JSON.parse(r.body); parsed = true; } return cache; };
    r.text = function () { return r.body; };
    r.header = function (k) { return r.headers[String(k).toLowerCase()]; };
    return r;
  };

  // ------------------------------------------------------------ workflows
  g.__makeWf = function (d) {
    var wf = { name: d.name, rows: d.rows, row: null, iteration: 0, results: [], last: null, __ctl: {} };
    wf.goto = function (n) { wf.__ctl.next = String(n); };
    wf.stop = function (reason) { wf.__ctl.stop = reason ? String(reason) : 'stopped by script'; };
    wf.skipIteration = function () { wf.__ctl.skip = true; };
    return wf;
  };
  g.__takeCtl = function () {
    if (!g.wf) return '{}';
    var c = g.wf.__ctl; g.wf.__ctl = {};
    return JSON.stringify({ next: c.next || '', stop: c.stop || '', skip: !!c.skip });
  };

  // ------------------------------------------------------------ entry points used by the runner
  g.__slot = function (name) { return JSON.parse(call('slot', name)); };
  function errText(e) {
    if (e && e.stack) return String(e) + '\n' + e.stack;
    return String(e);
  }
  // runs the script stored in slot "script" in its own function scope
  g.__runUser = function () {
    var src = call('slot', 'script');
    try { (new Function(src))(); return ''; } catch (e) { return errText(e); }
  };
  g.__evalCond = function () {
    var src = call('slot', 'script');
    try { return JSON.stringify({ v: !!(new Function('return (' + src + '\n);'))() }); }
    catch (e) { return JSON.stringify({ e: errText(e) }); }
  };
})(globalThis);
