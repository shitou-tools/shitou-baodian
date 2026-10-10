import test from 'node:test';
import assert from 'node:assert/strict';
const event = () => ({ listener: null, addListener(fn) { this.listener = fn; } });
async function setup() {
  const data = {}, calls = [];
  globalThis.chrome = {
    runtime: { id: 'test-extension', onMessage: event(), onInstalled: event(), onStartup: event(), openOptionsPage: async () => calls.push('options') },
    storage: { local: { get: async key => ({ [key]: structuredClone(data[key]) }), set: async values => { calls.push('storage'); Object.assign(data, structuredClone(values)); }, setAccessLevel: async opts => calls.push(opts.accessLevel) } },
    alarms: { onAlarm: event(), get: async () => undefined, create: async () => {}, clear: async () => {} },
    permissions: { contains: async () => true },
    sidePanel: { setPanelBehavior: async opts => calls.push(opts.openPanelOnActionClick), open: async opts => calls.push(['panel', opts.windowId]) },
    commands: { onCommand: event() }, contextMenus: { onClicked: event(), removeAll: async () => {}, create: opts => calls.push(opts) }
  };
  await import('../extension/background.js?test=' + crypto.randomUUID());
  return { data, calls };
}
test('安装时配置侧栏、仅可信上下文存储和选中文字菜单', async () => { const { calls } = await setup(); await chrome.runtime.onInstalled.listener(); assert.ok(calls.includes(true)); assert.ok(calls.includes('TRUSTED_CONTEXTS')); assert.ok(calls.some(c => c?.id === 'save-prompt' && c.contexts[0] === 'selection')); });
test('拒绝其他扩展和无关消息', async () => { await setup(); assert.equal(chrome.runtime.onMessage.listener({ channel: 'prompt-box' }, { id: 'other' }, () => {}), false); assert.equal(chrome.runtime.onMessage.listener({}, { id: 'test-extension' }, () => {}), false); });
test('消息调用仓库并返回成功状态', async () => { await setup(); const result = await new Promise(resolve => chrome.runtime.onMessage.listener({ channel: 'prompt-box', type: 'getState' }, { id: 'test-extension' }, resolve)); assert.equal(result.ok, true); assert.equal(result.data.state.prompts.length, 0); });
test('快捷键打开所在窗口侧栏', async () => { const { calls } = await setup(); chrome.commands.onCommand.listener('open-library', { windowId: 7 }); assert.deepEqual(calls[0], ['panel', 7]); });
test('右键选文先打开侧栏，再持久保存草稿', async () => { const { calls, data } = await setup(); chrome.contextMenus.onClicked.listener({ menuItemId: 'save-prompt', selectionText: '测试\n{{角色}}' }, { windowId: 3 }); assert.deepEqual(calls[0], ['panel', 3]); for (let i = 0; i < 40 && !data.promptBoxCapture; i++) await new Promise(r => setTimeout(r, 5)); assert.ok(data.promptBoxCapture?.id); assert.equal(data.promptBoxDatabase.state.drafts[0].body, '测试\n{{角色}}'); });
test('超长选文显示截断标记', async () => { const { data } = await setup(); chrome.contextMenus.onClicked.listener({ menuItemId: 'save-prompt', selectionText: 'a'.repeat(100001) }, { windowId: 3 }); for (let i = 0; i < 40 && !data.promptBoxCapture; i++) await new Promise(r => setTimeout(r, 5)); assert.equal(data.promptBoxCapture.truncated, true); assert.equal(data.promptBoxDatabase.state.drafts[0].body.length, 100000); });
