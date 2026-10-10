import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloud, CLOUD_KEY, endpointURL, sha256 } from '../extension/src/cloud.js';
import { createRepository } from '../extension/src/repository.js';
const endpoint = 'https://test.cn-hongkong.fcapp.run/';
const token = 'test-only-' + 'a'.repeat(40);
function setup() {
  let stored = {}, fail = false, corrupt = false, permit = true, now = 1780000000000;
  const objects = new Map(), calls = [];
  const storage = { get: async key => ({ [key]: structuredClone(stored[key]) }), set: async values => Object.assign(stored, structuredClone(values)) };
  const repository = createRepository(storage);
  const deps = { storage, repository, now: () => now, permissions: { contains: async () => permit }, fetcher: async (url, options) => {
    assert.equal(url, endpoint); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    const p = JSON.parse(options.body); calls.push(p);
    if (fail) throw new Error('Network unavailable');
    let data = {};
    if (p.action === 'health') data = { bucket: 'your-backup-bucket', region: 'cn-hongkong', prefix: 'prompt-box-backups/v1/' };
    if (p.action === 'put') { objects.set(p.key, p.raw); data = { key: p.key, sha256: corrupt ? 'bad' : await sha256(p.raw) }; }
    if (p.action === 'list') data = { items: [...objects.keys()].sort().map(key => ({ key, size: objects.get(key).length, lastModified: new Date(now).toISOString() })), nextMarker: '' };
    if (p.action === 'get') { const raw = objects.get(p.key); data = { raw, sha256: corrupt ? 'bad' : await sha256(raw) }; }
    if (p.action === 'delete') { objects.delete(p.key); data = { key: p.key, deleted: true }; }
    return new Response(JSON.stringify({ ok: true, ...data }));
  } };
  const cloud = createCloud(deps);
  return { cloud, deps, repository, objects, calls, data: () => stored, fail: b => fail = b, corrupt: b => corrupt = b, permit: b => permit = b, tick: () => now += 300000 };
}
async function connect(h) { return h.cloud.execute('cloudSave', { endpoint, token, enabled: true }); }
const save = (h, body) => h.repository.execute({ type: 'savePrompt', requestId: crypto.randomUUID(), payload: { title: '测试', body, notes: '所需素材', categoryId: 'video' } });

test('服务地址限定 HTTPS 函数计算域名，拒绝查询参数、用户信息和伪造域名', () => {
  assert.equal(endpointURL(endpoint), endpoint);
  for (const value of ['http://test.cn-hongkong.fcapp.run', 'https://fcapp.run.evil.com', endpoint + '?token=secret', 'https://user@a.fcapp.run', 'https://a.fcapp.run:8443']) assert.throws(() => endpointURL(value));
});
test('未配置时自动备份不联网；手动备份有明确提示', async () => { const h = setup(); await h.cloud.run(false); assert.equal(h.calls.length, 0); await assert.rejects(h.cloud.execute('cloudBackup')); });
test('保存连接须有主机许可且验证成功；状态不暴露口令', async () => {
  const h = setup(); h.permit(false); await assert.rejects(connect(h)); assert.equal(h.data()[CLOUD_KEY], undefined);
  h.permit(true); const status = await connect(h); assert.equal(status.enabled, true); assert.ok(!JSON.stringify(status).includes(token));
  const backup = await h.repository.execute({ type: 'exportBackup' }); assert.ok(!JSON.stringify(backup).includes(token));
});
test('只上传有改动的资料，导出时间不触发冗余上传', async () => {
  const h = setup(); await connect(h); await save(h, '首条'); await h.cloud.run(false); h.tick(); await h.cloud.run(false);
  assert.equal(h.objects.size, 1); await save(h, '新内容'); await h.cloud.run(false); assert.equal(h.objects.size, 2);
});
test('上传失败不标成功；重启后相同快照重试使用同一文件与导出时间', async () => {
  const h = setup(); await connect(h); await save(h, '正文'); h.fail(true);
  await assert.rejects(h.cloud.run(false)); const key = h.data()[CLOUD_KEY].pending.key;
  assert.equal((await h.cloud.status()).lastSuccess, null); assert.ok((await h.cloud.status()).error);
  assert.equal(h.data()[CLOUD_KEY].pending.backup, undefined);
  h.fail(false); h.tick(); const restarted = createCloud(h.deps); await restarted.run(false);
  const attempts = h.calls.filter(x => x.action === 'put'); assert.equal(attempts[0].raw, attempts[1].raw); assert.equal(attempts[1].key, key);
  assert.ok((await restarted.status()).lastSuccess); assert.equal((await restarted.status()).error, '');
});
test('失败后有新改动时使用新快照，旧请求不会覆盖新内容', async () => {
  const h = setup(); await connect(h); await save(h, '旧'); h.fail(true); await assert.rejects(h.cloud.run(false));
  const oldKey = h.data()[CLOUD_KEY].pending.key; await save(h, '新'); h.fail(false); await h.cloud.run(false);
  assert.notEqual(h.data()[CLOUD_KEY].lastKey, oldKey); assert.equal(JSON.parse([...h.objects.values()][0]).prompts.length, 2);
});
test('云端确认散列错误不标记成功，恢复散列错误不改本地', async () => {
  const h = setup(); await connect(h); await save(h, '正文'); h.corrupt(true); await assert.rejects(h.cloud.run(false));
  assert.equal((await h.cloud.status()).lastSuccess, null); h.corrupt(false); await h.cloud.run(false); const key = [...h.objects.keys()][0];
  const before = await h.repository.execute({ type: 'getState' }); h.corrupt(true); await assert.rejects(h.cloud.execute('cloudDownload', { key }));
  assert.deepEqual(await h.repository.execute({ type: 'getState' }), before);
});
test('历史列举与下载保留备注，下载不直接覆盖资料库', async () => {
  const h = setup(); await connect(h); await save(h, '正文'); await h.cloud.run(false);
  const list = await h.cloud.execute('cloudList'); const backup = await h.cloud.execute('cloudDownload', { key: list.items[0].key });
  assert.equal(backup.prompts[0].notes, '所需素材'); assert.equal((await h.repository.execute({ type: 'getState' })).state.prompts.length, 1);
  await assert.rejects(h.cloud.execute('cloudDownload', { key: 'index.html' }));
});
test('暂停后自动任务不上传，手动备份仍可用；并行任务合并重复内容', async () => {
  const h = setup(); await connect(h); await Promise.all([h.cloud.run(false), h.cloud.run(false)]); assert.equal(h.objects.size, 1);
  await h.cloud.execute('cloudPause'); await save(h, '暂停期间'); await h.cloud.run(false); assert.equal(h.objects.size, 1);
  await h.cloud.execute('cloudBackup'); assert.equal(h.objects.size, 2);
});
test('删除需明确确认及合法路径；失败不更改成功状态，本地内容始终保留', async () => {
  const h = setup(); await connect(h); await save(h, '保留正文'); await h.cloud.run(false);
  const key = [...h.objects.keys()][0], before = await h.repository.execute({ type: 'getState' });
  await assert.rejects(h.cloud.execute('cloudDelete', { key }));
  await assert.rejects(h.cloud.execute('cloudDelete', { key: 'index.html', confirmed: true }));
  assert.equal(h.calls.filter(x => x.action === 'delete').length, 0);
  h.fail(true); await assert.rejects(h.cloud.execute('cloudDelete', { key, confirmed: true }));
  assert.equal((await h.cloud.status()).lastKey, key); h.fail(false);
  await h.cloud.execute('cloudDelete', { key, confirmed: true });
  assert.equal(h.objects.size, 0); assert.equal((await h.cloud.status()).lastSuccess, null);
  assert.deepEqual(await h.repository.execute({ type: 'getState' }), before);
  h.tick(); await h.cloud.run(false); assert.equal(h.objects.size, 1);
});
test('删除旧备份不会影响其他快照或最新成功记录', async () => {
  const h = setup(); await connect(h); await h.cloud.run(false); const key = [...h.objects.keys()][0];
  h.tick(); await save(h, '新内容'); await h.cloud.run(false); const status = await h.cloud.status();
  await h.cloud.execute('cloudDelete', { key, confirmed: true });
  assert.equal(h.objects.size, 1); assert.equal((await h.cloud.status()).lastKey, status.lastKey);
});
