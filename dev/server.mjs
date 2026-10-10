import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    let relative = decodeURIComponent(url.pathname);
    if (relative === '/') relative = '/extension/manager.html';
    const file = path.resolve(root, '.' + relative);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    let data = await fs.readFile(file);
    if (file.endsWith('.html') && file.includes(path.sep + 'extension' + path.sep)) {
      data = data.toString().replace(/<script type="module" src="src\/(app|history)\.js"><\/script>/, '<script type="module" src="/dev/preview-bridge.js"></script>');
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(data);
  } catch { res.writeHead(404); res.end('Not found'); }
});
server.listen(4178, '127.0.0.1', () => console.log('Preview: http://127.0.0.1:4178/extension/manager.html (isolated demo storage; not your Chrome extension data)'));
