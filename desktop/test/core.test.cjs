const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SSEParser, serverOrigin, allowedRequest, trustedFileURL } = require('../core.cjs');
test('portable short-path URL encoding still trusts only the bundled local entry point', () => {
  const path = require('node:path');
  const { pathToFileURL } = require('node:url');
  const file = path.resolve('test-output/QIUZIZ~1/resources/app.asar/ui/index.html');
  const encoded = pathToFileURL(file).href;
  const chromiumURL = encoded.replace(/%7E/gi, '~');
  assert.ok(trustedFileURL(encoded, file));
  assert.ok(trustedFileURL(chromiumURL, file));
  assert.equal(trustedFileURL(chromiumURL + '?other=1', file), false);
  assert.equal(trustedFileURL(chromiumURL + '#frame', file), false);
  assert.equal(trustedFileURL(chromiumURL.replace('index.html', 'other.html'), file), false);
  assert.equal(trustedFileURL('https://example.com/index.html', file), false);
  assert.equal(trustedFileURL('invalid-url', file), false);
});
test('SSE retains Chinese UTF-8 and CRLF frames across arbitrary chunks', () => {
  const events = [];
  const parser = new SSEParser((type, data) => events.push({ type, data }));
  const bytes = Buffer.from('event: connected\r\ndata: {"seq":1}\r\n\r\nevent: update\ndata: {"name":"第一组","delta":2}\n\n');
  for (const byte of bytes) parser.feed(new Uint8Array([byte]));
  assert.deepEqual(events, [{ type: 'connected', data: { seq: 1 } }, { type: 'update', data: { name: '第一组', delta: 2 } }]);
});
test('server and IPC endpoints cannot be used for arbitrary file or URL access', () => {
  assert.equal(serverOrigin('https://jiafen.qiuzizhao.com/'), 'https://jiafen.qiuzizhao.com');
  assert.equal(serverOrigin('http://127.0.0.1:5000'), 'http://127.0.0.1:5000');
  for (const url of ['file:///etc/passwd', 'http://example.com', 'https://user:secret@example.com', 'https://example.com/path', 'https://example.com/?query=1']) assert.throws(() => serverOrigin(url));
  assert.ok(allowedRequest('/api/classes/7/score', 'POST'));
  for (const route of ['/api/export', '/api/import', '//example.com', '/api/classes/../score', '/api/score?other=1']) assert.equal(allowedRequest(route, 'POST'), false);
});
