import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, applyOperation, validateState, validateBackup, exportBackup, mergeBackup, selectPrompts, LIMITS } from '../extension/src/model.js';
const now = '2026-10-09T10:00:00.000Z';
let seq = 0;
const op = (s, t, p) => applyOperation(s, t, p, { now, uuid: () => 'id-' + (++seq) });
const payload = (extra = {}) => ({ title: '角色设计', body: '  第一行\n\n```text\n{{人物}}\n```\n尾行  ', categoryId: 'characters', ...extra });
const added = () => op(initialState(), 'savePrompt', payload()).state;
test('首次启动无示例提示词且有三个分类', () => { const s = initialState(); assert.equal(s.prompts.length, 0); assert.equal(s.categories.length, 3); });
test('正文空格、换行、变量和代码标记无损保存', () => { assert.equal(added().prompts[0].body, payload().body); });
test('拒绝空正文或过长标题', () => { for (const p of [payload({ body: '  ' }), payload({ title: 'a'.repeat(121) })]) assert.throws(() => op(initialState(), 'savePrompt', p)); });
test('重复正文提示，可明确另存', () => { const s = added(); assert.throws(() => op(s, 'savePrompt', payload()), e => e.code === 'DUPLICATE'); assert.equal(op(s, 'savePrompt', payload({ allowDuplicate: true })).state.prompts.length, 2); });
test('编辑保留稳定 ID 且增加版本', () => { const s = added(), p = s.prompts[0]; const next = op(s, 'savePrompt', { ...payload({ title: '新版' }), id: p.id, expectedVersion: 1 }).state; assert.equal(next.prompts[0].id, p.id); assert.equal(next.prompts[0].version, 2); assert.equal(s.prompts[0].title, '角色设计'); });
test('旧窗口编辑被阻止而不会覆盖', () => { const s = added(), id = s.prompts[0].id; assert.throws(() => op(s, 'savePrompt', { ...payload(), id, expectedVersion: 0 }), e => e.code === 'CONFLICT'); });
test('删除进入回收站且可恢复', () => { let s = added(), id = s.prompts[0].id; s = op(s, 'deletePrompt', { id, expectedVersion: 1 }).state; assert.equal(selectPrompts(s).length, 0); assert.equal(selectPrompts(s, '', 'all', 'trash').length, 1); s = op(s, 'restorePrompt', { id, expectedVersion: 2 }).state; assert.equal(selectPrompts(s).length, 1); });
test('回收站记录不能从旧编辑器直接覆盖', () => { let s = added(); s = op(s, 'deletePrompt', { id: s.prompts[0].id, expectedVersion: 1 }).state; assert.throws(() => op(s, 'savePrompt', { ...payload(), id: s.prompts[0].id, expectedVersion: 2 }), e => e.code === 'CONFLICT'); });
test('彻底删除仅限回收站且检查版本', () => { let s = added(), id = s.prompts[0].id; assert.throws(() => op(s, 'purgePrompt', { id, expectedVersion: 1 })); s = op(s, 'deletePrompt', { id, expectedVersion: 1 }).state; assert.throws(() => op(s, 'purgePrompt', { id, expectedVersion: 1 }), e => e.code === 'CONFLICT'); assert.equal(op(s, 'purgePrompt', { id, expectedVersion: 2 }).state.prompts.length, 0); });
test('置顶排在最前，并可筛选常用', () => { let s = added(); s = op(s, 'savePrompt', payload({ title: '另一条', body: 'another' })).state; s = op(s, 'togglePin', { id: s.prompts[0].id, expectedVersion: 1 }).state; assert.equal(selectPrompts(s)[0].pinned, true); assert.equal(selectPrompts(s, '', 'all', 'pinned').length, 1); });
test('中文正文搜索与分类筛选交集', () => { const s = added(); assert.equal(selectPrompts(s, '人物', 'characters').length, 1); assert.equal(selectPrompts(s, '人物', 'video').length, 0); });
test('标题搜索全半角和大小写归一', () => { const s = op(initialState(), 'savePrompt', payload({ title: 'ＰＲＯＭＰＴ工具' })).state; assert.equal(selectPrompts(s, 'prompt').length, 1); });
test('分类空名和归一化重名被拒绝', () => { let s = op(initialState(), 'saveCategory', { name: 'ＡＢＣ' }).state; assert.throws(() => op(s, 'saveCategory', { name: 'abc' })); assert.throws(() => op(s, 'saveCategory', { name: ' ' })); });
test('删除分类保留正文并重新归类', () => { const s = added(), next = op(s, 'deleteCategory', { id: 'characters', expectedName: '角色类' }).state; assert.equal(next.prompts[0].categoryId, 'uncategorized'); assert.equal(next.prompts[0].body, s.prompts[0].body); assert.throws(() => op(next, 'deleteCategory', { id: 'uncategorized', expectedName: '未分类' })); });
test('草稿持久数据保存不要求完整标题', () => { const d = { id: 'draft-1', title: '', body: '未完成', categoryId: 'video', seq: 1, updatedAt: now }; let s = op(initialState(), 'saveDraft', d).state; s = op(s, 'saveDraft', { ...d, body: '更早消息', seq: 0 }).state; assert.equal(s.drafts[0].body, '未完成'); assert.equal(validateState(s).drafts.length, 1); });
test('提示词提交成功同时移除关联草稿', () => { let s = op(initialState(), 'saveDraft', { id: 'draft-1', title: '测试', body: '草稿', categoryId: 'video', seq: 1, updatedAt: now }).state; s = op(s, 'savePrompt', payload({ draftId: 'draft-1' })).state; assert.equal(s.drafts.length, 0); });
test('备份导出恢复保留正文、置顶与回收站', () => { let s = added(); s = op(s, 'togglePin', { id: s.prompts[0].id, expectedVersion: 1 }).state; s = op(s, 'deletePrompt', { id: s.prompts[0].id, expectedVersion: 2 }).state; const imported = mergeBackup(initialState(), exportBackup(s, now)).state; assert.deepEqual(imported.prompts, s.prompts); });
test('反复恢复同一备份不制造重复', () => { const s = added(), backup = exportBackup(s, now), merged = mergeBackup(initialState(), backup); assert.equal(mergeBackup(merged.state, backup).result.skipped, 1); });
test('相同 ID 不同内容保留两版', () => { const s = added(), b = exportBackup(s, now); b.prompts[0].body = '另一版'; const next = mergeBackup(s, b); assert.equal(next.result.conflicts, 1); assert.equal(next.state.prompts.length, 2); assert.equal(next.state.prompts[0].body, s.prompts[0].body); assert.notEqual(next.state.prompts[1].id, s.prompts[0].id); assert.equal(mergeBackup(next.state, b).result.skipped, 1); });
test('分类 ID 相同名字不同不会误归类', () => { const s = added(), b = exportBackup(s, now); b.categories.find(c => c.id === 'characters').name = '新分类'; b.prompts[0].id = 'another'; const next = mergeBackup(s, b); assert.notEqual(next.state.prompts[1].categoryId, 'characters'); });
test('不接受损坏、重复 ID、缺失分类引用和未来版本备份', () => { const b = exportBackup(added(), now); for (const change of [x => x.version = 99, x => x.prompts.push(x.prompts[0]), x => x.prompts[0].categoryId = 'missing', x => delete x.prompts[0].body]) { const next = structuredClone(b); change(next); assert.throws(() => validateBackup(next)); } });
test('旧 V1 备份迁移保留内容', () => { const b = exportBackup(added(), now); b.version = 1; const next = validateBackup(b); assert.equal(next.prompts[0].pinned, false); assert.equal(next.prompts[0].body, b.prompts[0].body); });
test('旧 schemaVersion 1 可无损升级', () => { const s = added(); s.schemaVersion = 1; delete s.drafts; const next = validateState(s); assert.equal(next.schemaVersion, 2); assert.equal(next.prompts[0].body, s.prompts[0].body); });
test('未来本地格式不可静默重置', () => { const s = initialState(); s.schemaVersion = 50; assert.throws(() => validateState(s), e => e.code === 'CORRUPT'); });
test('预览后数据变化阻止使用过期恢复预览', () => { const s = added(); assert.throws(() => op(s, 'importBackup', { backup: exportBackup(s), expectedRevision: 0 }), e => e.code === 'CONFLICT'); });
test('恢复草稿为副本，不会覆盖原提示词', () => { const s = added(); s.drafts.push({ id: 'd1', title: '草稿', body: '未完成', categoryId: 'characters', seq: 1, updatedAt: now, promptId: s.prompts[0].id, expectedVersion: 1 }); const next = mergeBackup(initialState(), exportBackup(s)); assert.equal(next.state.drafts[0].promptId, null); });
test('最大长度正文可原样保存', () => { const body = '中'.repeat(LIMITS.body); assert.equal(op(initialState(), 'savePrompt', payload({ body })).state.prompts[0].body.length, LIMITS.body); });
test('两个窗口续写同一草稿时，各自保留独立分支', () => {
  const d = { id: 'original', title: '草稿', body: '原稿', categoryId: 'video', seq: 1, updatedAt: now };
  let s = op(initialState(), 'saveDraft', d).state;
  s = op(s, 'saveDraft', { ...d, id: 'window-a', body: '版本A', sourceDraft: { id: 'original', seq: 1 } }).state;
  s = op(s, 'saveDraft', { ...d, id: 'window-b', body: '版本B', sourceDraft: { id: 'original', seq: 1 } }).state;
  assert.deepEqual(s.drafts.map(x => x.body), ['版本A', '版本B']);
});
test('未改动的恢复草稿提交后清理原草稿', () => {
  const d = { id: 'original', title: '草稿', body: '原稿', categoryId: 'video', seq: 1, updatedAt: now };
  const s = op(initialState(), 'saveDraft', d).state;
  const next = op(s, 'savePrompt', { ...payload(), draftId: 'new-window-id', sourceDraft: { id: 'original', seq: 1 } }).state;
  assert.equal(next.drafts.length, 0);
});

test('旧提示词和草稿缺少备注时兼容为空且保留正文', () => {
  const s = added(); delete s.prompts[0].notes;
  s.drafts.push({ id: 'old-draft', title: '', body: '旧草稿', categoryId: 'video', seq: 1, updatedAt: now });
  const next = validateState(s);
  assert.equal(next.prompts[0].notes, ''); assert.equal(next.prompts[0].body, payload().body);
  assert.equal(next.drafts[0].notes, ''); assert.equal(next.drafts[0].body, '旧草稿');
  assert.equal(validateBackup(exportBackup(s, now)).prompts[0].notes, '');
});

test('备注独立保存、搜索、编辑与清空，不混入正文', () => {
  const notes = '面膜盒子三视图+膜袋正视图+人物照片\n  保留格式  ';
  let s = op(initialState(), 'savePrompt', payload({ notes })).state;
  assert.equal(s.prompts[0].notes, notes); assert.equal(s.prompts[0].body, payload().body);
  assert.equal(selectPrompts(s, '膜袋正视图').length, 1);
  s = op(s, 'savePrompt', { ...payload({ notes: '' }), id: s.prompts[0].id, expectedVersion: 1 }).state;
  assert.equal(s.prompts[0].notes, ''); assert.equal(selectPrompts(s, '膜袋正视图').length, 0);
});

test('备份合并保留仅备注不同的提示词和草稿', () => {
  let s = op(initialState(), 'savePrompt', payload({ notes: '旧备注' })).state;
  s = op(s, 'saveDraft', { id: 'd-notes', title: '草稿', body: '正文', notes: '旧备注', categoryId: 'video', seq: 1, updatedAt: now }).state;
  const b = exportBackup(s, now); b.prompts[0].notes = '新备注'; b.drafts[0].notes = '新备注';
  const next = mergeBackup(s, b);
  assert.deepEqual(next.state.prompts.map(p => p.notes), ['旧备注', '新备注']);
  assert.deepEqual(next.state.drafts.map(d => d.notes), ['旧备注', '新备注']);
  assert.equal(mergeBackup(next.state, b).result.added, 0);
  assert.equal(mergeBackup(next.state, b).result.addedDrafts, 0);
});

test('备注长度和备份类型校验阻止无效内容', () => {
  const notes = '字'.repeat(LIMITS.notes);
  const s = op(initialState(), 'savePrompt', payload({ notes })).state;
  assert.equal(validateBackup(exportBackup(s, now)).prompts[0].notes, notes);
  assert.throws(() => op(s, 'savePrompt', payload({ notes: notes + '字' })));
  const b = exportBackup(s, now); b.prompts[0].notes = { bad: true };
  assert.throws(() => validateBackup(b));
  assert.throws(() => op(s, 'saveDraft', { id: 'bad-note', title: '', body: '', notes: 123, categoryId: 'video', seq: 1, updatedAt: now }));
});
