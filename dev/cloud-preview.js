// Isolated browser UI fixture. No request is sent to Alibaba Cloud.
import { createCloud, sha256 } from '../extension/src/cloud.js';
export function previewCloud(storage, repository) {
  return createCloud({ storage, repository, permissions: { contains: async () => true }, fetcher: async (url, options) => {
    if (url !== 'https://demo.cn-hongkong.fcapp.run/') throw new Error('预览只接受 demo 地址，不连接真实云端');
    const p = JSON.parse(options.body), items = JSON.parse(localStorage.getItem('prompt-box-preview-cloud-files') || '{}');
    let data = {};
    if (p.action === 'health') data = { bucket: 'your-backup-bucket', region: 'cn-hongkong', prefix: 'prompt-box-backups/v1/' };
    if (p.action === 'put') { items[p.key] = p.raw; localStorage.setItem('prompt-box-preview-cloud-files', JSON.stringify(items)); data = { key: p.key, sha256: await sha256(p.raw) }; }
    if (p.action === 'list') {
      const keys = Object.keys(items).sort().filter(key => key > (p.marker || '')), selected = keys.slice(0, 50);
      data = { items: selected.map(key => ({ key, size: new TextEncoder().encode(items[key]).length, lastModified: JSON.parse(items[key]).exportedAt })), nextMarker: keys.length > 50 ? selected.at(-1) : '', canDelete: true };
    }
    if (p.action === 'delete') { delete items[p.key]; localStorage.setItem('prompt-box-preview-cloud-files', JSON.stringify(items)); data = { key: p.key, deleted: true }; }
    if (p.action === 'get') data = { raw: items[p.key], sha256: await sha256(items[p.key]) };
    return new Response(JSON.stringify({ ok: true, ...data }));
  } });
}
