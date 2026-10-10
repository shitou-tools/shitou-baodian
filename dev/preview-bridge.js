// Development only. Not shipped in the extension ZIP.
import { createRepository } from '../extension/src/repository.js';
import { previewCloud } from './cloud-preview.js';
const listeners = [];
const storage = {
  async get(key) { return { [key]: JSON.parse(localStorage.getItem('prompt-box-preview:' + key) || 'null') ?? undefined }; },
  async set(values) {
    const changes = {};
    for (const [key, value] of Object.entries(values)) {
      const oldValue = (await storage.get(key))[key];
      localStorage.setItem('prompt-box-preview:' + key, JSON.stringify(value));
      changes[key] = { oldValue, newValue: value };
    }
    for (const fn of listeners) fn(changes, 'local');
  }
};
const repo = createRepository(storage);
const cloud = previewCloud(storage, repo);
window.chrome = {
  permissions: { request: async () => true },
  runtime: {
    getURL(path) { return '/extension/' + path; },
    async sendMessage(message) {
      try { return { ok: true, data: await navigator.locks.request('prompt-box-preview-write', () => message.type.startsWith('cloud') ? cloud.execute(message.type, message.payload) : repo.execute(message)) }; }
      catch(e) { return { ok: false, error: { message: e.message, code: e.code, details: e.details } }; }
    },
    openOptionsPage() { window.open('/extension/manager.html', '_blank'); }
  },
  storage: { local: storage, onChanged: { addListener(fn) { listeners.push(fn); } } },
  tabs: { async create({ url }) { if (url.startsWith('/extension/')) window.open(url, '_blank'); else alert('预览模式：仅打开本地演示页面。'); } }
};
window.addEventListener('storage', e => {
  if (e.key?.startsWith('prompt-box-preview:')) for (const fn of listeners) fn({ [e.key.slice('prompt-box-preview:'.length)]: { newValue: JSON.parse(e.newValue) } }, 'local');
});
await import(location.pathname.endsWith('cloud-history.html') ? '../extension/src/history.js' : '../extension/src/app.js');
