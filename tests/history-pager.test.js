import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryPager } from '../extension/src/history-pager.js';
function setup(count) {
  let records = Array.from({ length: count }, (_, i) => ({ key: String(i).padStart(4, '0') })), fail = false;
  const calls = [];
  const pager = createHistoryPager(async marker => {
    calls.push(marker); if (fail) throw Error('offline');
    const rest = records.filter(x => x.key > marker), batch = rest.slice(0, 50);
    return { items: batch, nextMarker: rest.length > 50 ? batch.at(-1).key : '', canDelete: true };
  });
  return { pager, calls, remove: key => records = records.filter(x => x.key !== key), fail: v => fail = v };
}
test('超过一百份备份始终每页十条，前后翻页不遗漏不重复', async () => {
  const h = setup(103), keys = []; let p = await h.pager.load();
  for (;;) { assert.ok(p.items.length <= 10); keys.push(...p.items.map(x => x.key)); if (!p.hasNext) break; p = await h.pager.load(p.page + 1); }
  assert.equal(keys.length, 103); assert.equal(new Set(keys).size, 103); assert.equal(p.page, 10);
  assert.equal((await h.pager.load(9)).items[0].key, '0090'); assert.equal(h.calls.length, 3);
});
test('空列表和末页十条不会显示虚假的下一页', async () => {
  for (const count of [0, 10]) { const p = await setup(count).pager.load(); assert.equal(p.hasNext, false); assert.equal(p.hasPrevious, false); }
});
test('请求失败保留游标，重试后不跳过数据；删除后刷新清除缓存', async () => {
  const h = setup(60); await h.pager.load(); h.fail(true);
  await assert.rejects(h.pager.load(5)); h.fail(false);
  assert.equal((await h.pager.load(5)).items[0].key, '0050');
  h.remove('0000'); assert.equal((await h.pager.load(0, true)).items[0].key, '0001');
});
test('兼容旧服务：不声称支持删除；拒绝循环游标', async () => {
  const legacy = createHistoryPager(async () => ({ items: [], nextMarker: '' })); assert.equal((await legacy.load()).canDelete, false);
  const broken = createHistoryPager(async () => ({ items: [], nextMarker: 'x' })); await assert.rejects(broken.load(), /游标/);
});
