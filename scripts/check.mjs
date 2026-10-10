import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '..');
const ext = path.join(root, 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json')));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
if (manifest.manifest_version !== 3 || manifest.version !== pkg.version) throw Error('Unexpected manifest');
for (const file of [manifest.background.service_worker, manifest.side_panel.default_path, manifest.options_ui.page, ...Object.values(manifest.icons)]) if (!fs.existsSync(path.join(ext, file))) throw Error('Missing: ' + file);
const files = fs.readdirSync(ext, { recursive: true }).filter(p => p.endsWith('.js'));
for (const file of files) execFileSync(process.execPath, ['--check', path.join(ext, file)]);
for (const html of ['sidepanel.html', 'manager.html', 'cloud-history.html']) {
  const text = fs.readFileSync(path.join(ext, html), 'utf8');
  const ids = [...text.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
  if (new Set(ids).size !== ids.length) throw Error('Duplicate HTML id');
  const sources = html === 'cloud-history.html' ? ['src/history.js'] : ['src/app.js', 'src/cloud-ui.js'];
  for (const [, id] of sources.map(p => fs.readFileSync(path.join(ext, p), 'utf8')).join('\n').matchAll(/\$\('([^']+)'\)/g)) if (!ids.includes(id)) throw Error('Missing DOM id: ' + id);
}
if (manifest.host_permissions || manifest.content_scripts) throw Error('Unexpected website access');
if (JSON.stringify(manifest.optional_host_permissions) !== JSON.stringify(['https://*.fcapp.run/*','https://*.fc.aliyuncs.com/*'])) throw Error('Unexpected cloud host permissions');
console.log(`PASS: Manifest, referenced resources, ${files.length} JS syntax checks, HTML IDs, minimal permissions.`);
