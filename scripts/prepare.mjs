import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
const root = path.resolve(import.meta.dirname, '..', 'extension');
const manifestPath = path.join(root, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
// Retain this public key across builds so unpacked installs keep a stable extension ID.
if (!manifest.key) {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'der' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  manifest.key = publicKey.toString('base64');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}
fs.copyFileSync(path.join(root, 'sidepanel.html'), path.join(root, 'manager.html'));
console.log('Prepared manager page and stable extension identity.');
