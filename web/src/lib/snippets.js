// Code snippet generators. Input is an effective request (see effective.js).

export const LANGUAGES = [
  { id: 'curl', label: 'cURL', libs: [{ id: 'curl', label: 'curl' }] },
  {
    id: 'php',
    label: 'PHP',
    libs: [
      { id: 'guzzle', label: 'Guzzle' },
      { id: 'curl', label: 'ext-curl' },
    ],
  },
  {
    id: 'node',
    label: 'Node.js',
    libs: [
      { id: 'fetch', label: 'fetch (built-in)' },
      { id: 'axios', label: 'axios' },
    ],
  },
  {
    id: 'python',
    label: 'Python',
    libs: [
      { id: 'requests', label: 'requests' },
      { id: 'httpx', label: 'httpx' },
    ],
  },
];

// string literals per language
const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const js = (s) => JSON.stringify(String(s));
const py = (s) => JSON.stringify(String(s)); // JSON string literals are valid Python literals
const php = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

const isJson = (r) => r.body.type === 'json' && (() => {
  try {
    JSON.parse(r.body.content);
    return true;
  } catch {
    return false;
  }
})();
const hasBody = (r) => r.body.type !== 'none' && r.body.type !== 'file';
const fileBody = (r) => (r.body.type === 'file' && r.body.file ? r.body.file : '');
const indent = (text, pad) => text.split('\n').join('\n' + pad);

function curl(r) {
  const lines = [`curl --request ${r.method} \\`, `  --url ${sh(r.url)}`];
  for (const [k, v] of r.headers) lines[lines.length - 1] += ' \\', lines.push(`  --header ${sh(`${k}: ${v}`)}`);
  const add = (l) => {
    lines[lines.length - 1] += ' \\';
    lines.push('  ' + l);
  };
  if (r.body.type === 'form') r.body.fields.forEach((f) => add(`--data-urlencode ${sh(`${f.key}=${f.value}`)}`));
  else if (r.body.type === 'multipart') r.body.fields.forEach((f) => add(`--form ${sh(f.file ? `${f.key}=@${f.file}` : `${f.key}=${f.value}`)}`));
  else if (fileBody(r)) add(`--data-binary ${sh('@' + fileBody(r))}`);
  else if (hasBody(r)) add(`--data-raw ${sh(r.body.content)}`);
  return lines.join('\n');
}

function phpArray(pairs, pad = '    ') {
  return `[\n${pairs.map(([k, v]) => `${pad}    ${php(k)} => ${v},`).join('\n')}\n${pad}]`;
}

function guzzle(r) {
  const opts = [];
  if (r.headers.length) opts.push(['headers', phpArray(r.headers.map(([k, v]) => [k, php(v)]), '    ')]);
  if (r.body.type === 'form') opts.push(['form_params', phpArray(r.body.fields.map((f) => [f.key, php(f.value)]), '    ')]);
  else if (r.body.type === 'multipart')
    opts.push([
      'multipart',
      `[\n${r.body.fields
        .map((f) => `        ['name' => ${php(f.key)}, 'contents' => ${f.file ? `fopen(${php(f.file)}, 'r')` : php(f.value)}],`)
        .join('\n')}\n    ]`,
    ]);
  else if (fileBody(r)) opts.push(['body', `fopen(${php(fileBody(r))}, 'r')`]);
  else if (hasBody(r)) opts.push(['body', php(r.body.content)]);
  return `<?php
// composer require guzzlehttp/guzzle
require 'vendor/autoload.php';

$client = new \\GuzzleHttp\\Client();

$response = $client->request(${php(r.method)}, ${php(r.url)}${opts.length ? `, [\n${opts.map(([k, v]) => `    ${php(k)} => ${v},`).join('\n')}\n]` : ''});

echo $response->getStatusCode() . "\\n";
echo $response->getBody();
`;
}

function phpCurl(r) {
  const o = [
    ['CURLOPT_URL', php(r.url)],
    ['CURLOPT_RETURNTRANSFER', 'true'],
    ['CURLOPT_CUSTOMREQUEST', php(r.method)],
  ];
  if (r.headers.length) o.push(['CURLOPT_HTTPHEADER', `[\n${r.headers.map(([k, v]) => `        ${php(`${k}: ${v}`)},`).join('\n')}\n    ]`]);
  if (r.body.type === 'form') o.push(['CURLOPT_POSTFIELDS', `http_build_query(${phpArray(r.body.fields.map((f) => [f.key, php(f.value)]), '    ')})`]);
  else if (r.body.type === 'multipart')
    o.push(['CURLOPT_POSTFIELDS', phpArray(r.body.fields.map((f) => [f.key, f.file ? `new CURLFile(${php(f.file)})` : php(f.value)]), '    ')]);
  else if (fileBody(r)) o.push(['CURLOPT_POSTFIELDS', `file_get_contents(${php(fileBody(r))})`]);
  else if (hasBody(r)) o.push(['CURLOPT_POSTFIELDS', php(r.body.content)]);
  return `<?php
$ch = curl_init();
curl_setopt_array($ch, [
${o.map(([k, v]) => `    ${k} => ${v},`).join('\n')}
]);

$response = curl_exec($ch);
if ($response === false) {
    throw new RuntimeException(curl_error($ch));
}
echo curl_getinfo($ch, CURLINFO_HTTP_CODE) . "\\n";
echo $response;
curl_close($ch);
`;
}

const jsObject = (pairs, pad) => `{\n${pairs.map(([k, v]) => `${pad}  ${js(k)}: ${v},`).join('\n')}\n${pad}}`;

function nodeBody(r, lib) {
  // returns [setup lines, body expression]
  if (r.body.type === 'form') {
    return [`const body = new URLSearchParams(${jsObject(r.body.fields.map((f) => [f.key, js(f.value)]), '')});\n`, 'body'];
  }
  if (fileBody(r)) return ["import { readFile } from 'node:fs/promises';\n", `await readFile(${js(fileBody(r))})`];
  if (r.body.type === 'multipart') {
    const files = r.body.fields.some((f) => f.file);
    const lines = [files ? "import { openAsBlob } from 'node:fs';\n" : '', 'const body = new FormData();'];
    for (const f of r.body.fields)
      lines.push(f.file ? `body.append(${js(f.key)}, await openAsBlob(${js(f.file)}), ${js(f.file.split('/').pop())});` : `body.append(${js(f.key)}, ${js(f.value)});`);
    return [lines.filter(Boolean).join('\n') + '\n', 'body'];
  }
  if (!hasBody(r)) return ['', null];
  if (isJson(r)) {
    const pretty = JSON.stringify(JSON.parse(r.body.content), null, 2);
    return lib === 'axios' ? ['', indent(pretty, '  ')] : ['', `JSON.stringify(${indent(pretty, '  ')})`];
  }
  return ['', js(r.body.content)];
}

function nodeFetch(r) {
  const [setup, body] = nodeBody(r, 'fetch');
  const opts = [['method', js(r.method)]];
  if (r.headers.length) opts.push(['headers', jsObject(r.headers.map(([k, v]) => [k, js(v)]), '  ')]);
  if (body) opts.push(['body', body]);
  return `// Node.js 18+ (fetch is built in); run as an ES module (.mjs)
${setup}const response = await fetch(${js(r.url)}, {
${opts.map(([k, v]) => `  ${k}: ${v},`).join('\n')}
});

console.log(response.status);
console.log(await response.text());
`;
}

function nodeAxios(r) {
  const [setup, body] = nodeBody(r, 'axios');
  const opts = [
    ['method', js(r.method.toLowerCase())],
    ['url', js(r.url)],
  ];
  if (r.headers.length) opts.push(['headers', jsObject(r.headers.map(([k, v]) => [k, js(v)]), '  ')]);
  if (body) opts.push(['data', body]);
  return `// npm install axios; run as an ES module (.mjs)
import axios from 'axios';
${setup}
const response = await axios.request({
${opts.map(([k, v]) => `  ${k}: ${v},`).join('\n')}
  validateStatus: () => true,
});

console.log(response.status);
console.log(response.data);
`;
}

// JSON value -> Python literal (True/False/None), pretty-printed
function pyLiteral(v, pad = '') {
  if (v === null) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'string') return py(v);
  if (typeof v === 'number') return String(v);
  const inner = pad + '    ';
  if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => inner + pyLiteral(x, inner)).join(',\n')},\n${pad}]` : '[]';
  const keys = Object.keys(v);
  return keys.length ? `{\n${keys.map((k) => `${inner}${py(k)}: ${pyLiteral(v[k], inner)}`).join(',\n')},\n${pad}}` : '{}';
}

const pyDict = (pairs, pad = '') => `{\n${pairs.map(([k, v]) => `${pad}    ${py(k)}: ${v},`).join('\n')}\n${pad}}`;

function python(r, lib) {
  const lines = [lib === 'httpx' ? '# pip install httpx\nimport httpx\n' : '# pip install requests\nimport requests\n'];
  const args = [py(r.method), 'url'];
  lines.push(`url = ${py(r.url)}`);
  if (r.headers.length) {
    lines.push(`headers = ${pyDict(r.headers.map(([k, v]) => [k, py(v)]))}`);
    args.push('headers=headers');
  }
  if (r.body.type === 'form') {
    lines.push(`data = ${pyDict(r.body.fields.map((f) => [f.key, py(f.value)]))}`);
    args.push('data=data');
  } else if (r.body.type === 'multipart') {
    const plain = r.body.fields.filter((f) => !f.file);
    const files = r.body.fields.filter((f) => f.file);
    if (plain.length) {
      lines.push(`data = ${pyDict(plain.map((f) => [f.key, py(f.value)]))}`);
      args.push('data=data');
    }
    if (files.length) {
      lines.push(`files = ${pyDict(files.map((f) => [f.key, `open(${py(f.file)}, "rb")`]))}`);
      args.push('files=files');
    }
  } else if (fileBody(r)) {
    lines.push(`payload = open(${py(fileBody(r))}, "rb")`);
    args.push(lib === 'httpx' ? 'content=payload' : 'data=payload');
  } else if (hasBody(r)) {
    if (isJson(r)) {
      lines.push(`payload = ${pyLiteral(JSON.parse(r.body.content))}`);
      args.push('json=payload');
    } else {
      lines.push(`payload = ${py(r.body.content)}`);
      args.push(lib === 'httpx' ? 'content=payload' : 'data=payload');
    }
  }
  const call = lib === 'httpx' ? 'httpx.request' : 'requests.request';
  lines.push('', `response = ${call}(${args.join(', ')})`, '', 'print(response.status_code)', 'print(response.text)', '');
  return lines.join('\n');
}

export function generate(lang, lib, r) {
  switch (lang) {
    case 'curl':
      return curl(r);
    case 'php':
      return lib === 'curl' ? phpCurl(r) : guzzle(r);
    case 'node':
      return lib === 'axios' ? nodeAxios(r) : nodeFetch(r);
    case 'python':
      return python(r, lib);
  }
  return '';
}
