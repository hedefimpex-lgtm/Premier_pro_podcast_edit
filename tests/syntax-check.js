'use strict';
/**
 * Sözdizimi uyumluluk denetimi:
 *  - Panel ve kütüphane kodu: ES2017 (Premiere Pro 2021 / CEP 10 — Chromium 74, Node 12)
 *  - host.jsx: ES3 (ExtendScript)
 * Ayrıca eski ortamlarda bulunmayan bazı API'lerin kullanılmadığını kontrol eder.
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const ext = path.join(__dirname, '..', 'extension');
const results = [];

function check(file, ecmaVersion, sourceType) {
  const code = fs.readFileSync(file, 'utf8');
  try {
    acorn.parse(code, { ecmaVersion, sourceType: sourceType || 'script', allowReturnOutsideFunction: true, allowHashBang: true });
    results.push({ file, ok: true });
  } catch (e) {
    results.push({ file, ok: false, error: e.message });
  }
  return code;
}

const FORBIDDEN = [
  [/\?\./, 'optional chaining (?.)'],
  [/\?\?/, 'nullish coalescing (??)'],
  [/\.replaceAll\(/, 'String.replaceAll'],
  [/\.at\(-?\d/, 'Array/String.at'],
  [/\.flat(Map)?\(/, 'Array.flat'],
  [/Object\.fromEntries/, 'Object.fromEntries'],
  [/fs\.rmSync|fs\.cpSync/, 'fs.rmSync/cpSync (Node 14+)'],
  [/structuredClone/, 'structuredClone']
];

const jsFiles = ['js/main.js', 'js/cep.js'].concat(fs.readdirSync(path.join(ext, 'js', 'lib')).map(f => 'js/lib/' + f));
jsFiles.forEach(f => {
  const full = path.join(ext, f);
  const code = check(full, 2017);
  // yorumları ve dizeleri kabaca çıkar
  const stripped = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
  FORBIDDEN.forEach(([re, name]) => {
    if (re.test(stripped)) results.push({ file: full, ok: false, error: 'eski ortamda olmayan özellik: ' + name });
  });
});

const jsx = path.join(ext, 'jsx', 'host.jsx');
const jsxCode = check(jsx, 3);
if (/[^\x00-\x7f]/.test(jsxCode)) results.push({ file: jsx, ok: false, error: 'host.jsx ASCII olmalı' });
['.indexOf(', '.forEach(', '.map(', '.filter(', 'JSON.'].forEach(api => {
  // ExtendScript'te dizi indexOf/forEach yok; dize indexOf'a izin ver (String(...).indexOf)
  const lines = jsxCode.split('\n').filter(l => l.includes(api) && !/String\(.*\)\.indexOf|\.comments\)\.indexOf/.test(l));
  if (lines.length) results.push({ file: jsx, ok: false, error: 'ExtendScript desteklemeyebilir: ' + api + ' → ' + lines[0].trim() });
});

const manifest = fs.readFileSync(path.join(ext, 'CSXS', 'manifest.xml'), 'utf8');
if (!/--enable-nodejs/.test(manifest) || !/--mixed-context/.test(manifest)) results.push({ file: 'manifest.xml', ok: false, error: 'Node.js parametreleri eksik' });

const bad = results.filter(r => !r.ok);
if (require.main === module) {
  bad.forEach(r => console.error('✗ ' + path.relative(process.cwd(), r.file) + ': ' + r.error));
  console.log((results.length - bad.length) + '/' + results.length + ' denetim geçti');
  process.exit(bad.length ? 1 : 0);
}
module.exports = { results, bad };
