import { createRepository } from './src/repository.js';
import { createCloud, CLOUD_ALARM } from './src/cloud.js';
const repository = createRepository(chrome.storage.local);
const cloud = createCloud({ storage: chrome.storage.local, repository, permissions: chrome.permissions });
async function ensureCloudAlarm() {
  const c = await cloud.status();
  if (c.enabled) { if (!await chrome.alarms.get(CLOUD_ALARM)) await chrome.alarms.create(CLOUD_ALARM, { delayInMinutes: 1, periodInMinutes: 5 }); }
  else await chrome.alarms.clear(CLOUD_ALARM);
}
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === CLOUD_ALARM) cloud.run(false).catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { ensureCloudAlarm().catch(() => {}); cloud.run(false).catch(() => {}); });
ensureCloudAlarm().catch(() => {});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.channel !== 'prompt-box') return false;
  const result = message.type?.startsWith('cloud') ? cloud.execute(message.type, message.payload).then(async data => { await ensureCloudAlarm(); return data; }) : repository.execute(message);
  result.then(data => respond({ ok: true, data }), error => respond({ ok: false, error: { message: error.message, code: error.code || 'UNKNOWN', details: error.details } }));
  return true;
});
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: 'save-prompt', title: '保存到石头宝典', contexts: ['selection'] });
  await ensureCloudAlarm();
});
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'open-library' && tab?.windowId != null) chrome.sidePanel.open({ windowId: tab.windowId }).catch(console.error);
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'save-prompt' || !info.selectionText || tab?.windowId == null) return;
  // Invoke synchronously to retain the user gesture before awaiting persistence.
  const opening = chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => chrome.runtime.openOptionsPage());
  const id = crypto.randomUUID();
  repository.execute({ type: 'saveDraft', requestId: crypto.randomUUID(), payload: { id, title: '', body: info.selectionText.slice(0, 100000), categoryId: 'uncategorized', updatedAt: new Date().toISOString(), seq: 1, promptId: null } })
    .then(async () => { await opening; await chrome.storage.local.set({ promptBoxCapture: { id, truncated: info.selectionText.length > 100000, at: Date.now() } }); })
    .catch(async error => { await opening; await chrome.storage.local.set({ promptBoxCapture: { error: error.message, at: Date.now() } }); });
});
