'use strict';
const path = require('node:path');
const { fileURLToPath } = require('node:url');
function trustedFileURL(actual, expectedFile) {
  try {
    const url = new URL(actual);
    if (url.protocol !== 'file:' || url.search || url.hash) return false;
    const actualFile = path.resolve(fileURLToPath(url));
    const expected = path.resolve(expectedFile);
    // Chromium leaves ~ unescaped in Windows short paths; Node URL-encodes it.
    // Compare decoded local paths while retaining the exact expected file boundary.
    return process.platform === 'win32' ? actualFile.toLowerCase() === expected.toLowerCase() : actualFile === expected;
  } catch (_) { return false; }
}
function serverOrigin(value) {
  const u = new URL(value);
  if (u.username || u.password || u.pathname !== '/' || u.search || u.hash ||
      (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)))) {
    throw new Error('请输入 HTTPS 站点地址；本机调试可使用 http://127.0.0.1:端口');
  }
  return u.origin;
}
function allowedRequest(route, method) {
  return (method === 'GET' && ['/api/me', '/api/classes', '/api/history'].includes(route)) ||
    (method === 'POST' && (/^\/api\/classes\/\d+\/score$/.test(route) || ['/api/login', '/api/logout', '/api/score', '/api/undo'].includes(route)));
}
// Streaming parser retains partial UTF-8/SSE frames and handles CRLF across chunks.
class SSEParser {
  constructor(onEvent) { this.buffer = ''; this.decoder = new TextDecoder(); this.onEvent = onEvent; }
  feed(bytes) {
    this.buffer += typeof bytes === 'string' ? bytes : this.decoder.decode(bytes, { stream: true });
    let match;
    while ((match = /\r?\n\r?\n/.exec(this.buffer))) {
      const block = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      let event = 'message'; const lines = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''));
      }
      if (lines.length) { try { this.onEvent(event, JSON.parse(lines.join('\n'))); } catch (_) { /* ignore malformed frame */ } }
    }
    if (this.buffer.length > 1024 * 1024) throw new Error('实时消息过大');
  }
}
module.exports = { serverOrigin, allowedRequest, SSEParser, trustedFileURL };
