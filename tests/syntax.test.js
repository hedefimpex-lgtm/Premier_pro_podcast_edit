'use strict';
const test = require('node:test');
const assert = require('node:assert');

test('panel ES2017, host.jsx ES3 uyumlu', () => {
  const { bad } = require('./syntax-check');
  assert.deepStrictEqual(bad.map(b => b.file + ': ' + b.error), []);
});
