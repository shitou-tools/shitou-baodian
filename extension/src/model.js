export const UNCATEGORIZED = 'uncategorized';
export const LIMITS = Object.freeze({ title: 120, body: 100000, notes: 5000, category: 30, prompts: 10000, categories: 200, drafts: 30, bytes: 9 * 1024 * 1024 });
export class AppError extends Error { constructor(message, code = 'VALIDATION', details) { super(message); this.code = code; this.details = details; } }
const fail = (message, code, details) => { throw new AppError(message, code, details); };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const validId = v => typeof v === 'string' && /^[\w-]{1,100}$/.test(v);
const validDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && Number.isFinite(Date.parse(v));
export const nameKey = v => v.trim().normalize('NFKC').toLocaleLowerCase('en-US');
function field(v, label, max, trim = true) {
  if (typeof v !== 'string' || !v.trim()) fail(`${label}不能为空。`);
  if (v.length > max) fail(`${label}最多 ${max.toLocaleString()} 个字符。`);
  return trim ? v.trim() : v;
}
function notesField(value = '') {
  if (typeof value !== 'string' || value.length > LIMITS.notes) fail('备注必须是文字，最多 5,000 个字符。');
  return value;
}
export function initialState() {
  return { schemaVersion: 2, revision: 0, categories: [{ id: UNCATEGORIZED, name: '未分类' }, { id: 'characters', name: '角色类' }, { id: 'video', name: '视频制作类' }], prompts: [], drafts: [], recentRequests: [], lastExportAt: null };
}
function records(categories, prompts, version = 2) {
  if (!Array.isArray(categories) || categories.length > LIMITS.categories || !Array.isArray(prompts) || prompts.length > LIMITS.prompts) fail('条目数量超出限制或格式不正确。');
  const cids = new Set(), names = new Set(), pids = new Set();
  const cs = categories.map(c => {
    if (!object(c) || !validId(c.id) || cids.has(c.id)) fail('分类编号无效或重复。');
    const name = field(c.name, '分类名称', LIMITS.category), key = nameKey(name);
    if (names.has(key)) fail('分类名称重复。');
    if ((c.id === UNCATEGORIZED) !== (key === nameKey('未分类'))) fail('“未分类”信息不正确。');
    cids.add(c.id); names.add(key); return { id: c.id, name };
  });
  if (!cids.has(UNCATEGORIZED)) fail('缺少“未分类”。');
  const ps = prompts.map(p => {
    if (!object(p) || !validId(p.id) || pids.has(p.id)) fail('提示词编号无效或重复。');
    if (!cids.has(p.categoryId)) fail('提示词引用了不存在的分类。');
    if (!validDate(p.createdAt) || !validDate(p.updatedAt) || Date.parse(p.createdAt) > Date.parse(p.updatedAt)) fail('提示词日期无效。');
    if (p.deletedAt != null && !validDate(p.deletedAt)) fail('删除时间无效。');
    if (p.pinned !== undefined && typeof p.pinned !== 'boolean') fail('置顶状态无效。');
    if (p.version !== undefined && (!Number.isSafeInteger(p.version) || p.version < 1)) fail('提示词版本无效。');
    pids.add(p.id);
    return { id: p.id, title: field(p.title, '标题', LIMITS.title), body: field(p.body, '正文', LIMITS.body, false), notes: notesField(p.notes), categoryId: p.categoryId, createdAt: p.createdAt, updatedAt: p.updatedAt, version: p.version ?? 1, pinned: version === 1 ? false : (p.pinned ?? false), deletedAt: version === 1 ? null : (p.deletedAt ?? null) };
  });
  return { categories: cs, prompts: ps };
}
export function validateDraft(d) {
  if (!object(d) || !validId(d.id) || typeof d.title !== 'string' || d.title.length > LIMITS.title || typeof d.body !== 'string' || d.body.length > LIMITS.body || !validDate(d.updatedAt) || !validId(d.categoryId) || !Number.isSafeInteger(d.seq) || d.seq < 0) fail('草稿格式不正确。');
  if (d.promptId != null && (!validId(d.promptId) || !Number.isSafeInteger(d.expectedVersion) || d.expectedVersion < 1)) fail('草稿关联记录无效。');
  return { id: d.id, title: d.title, body: d.body, notes: notesField(d.notes), categoryId: d.categoryId, updatedAt: d.updatedAt, seq: d.seq, promptId: d.promptId ?? null, expectedVersion: d.expectedVersion ?? null };
}
export function validateState(raw) {
  if (!object(raw) || ![1, 2].includes(raw.schemaVersion) || !Number.isSafeInteger(raw.revision) || raw.revision < 0) fail('本地数据版本不受支持，原始数据未被覆盖。', 'CORRUPT');
  try {
    const data = records(raw.categories, raw.prompts, raw.schemaVersion);
    const ds = raw.drafts ?? [];
    if (!Array.isArray(ds) || ds.length > LIMITS.drafts) fail('草稿数量无效。');
    const drafts = ds.map(validateDraft);
    if (new Set(drafts.map(d => d.id)).size !== drafts.length) fail('草稿编号重复。');
    const requests = raw.recentRequests ?? [];
    if (!Array.isArray(requests) || requests.length > 50 || requests.some(r => !object(r) || !validId(r.id) || typeof r.fingerprint !== 'string' || !object(r.result))) fail('请求记录无效。');
    return { schemaVersion: 2, revision: raw.revision, ...data, drafts, recentRequests: structuredClone(requests), lastExportAt: validDate(raw.lastExportAt) ? raw.lastExportAt : null };
  } catch (e) { throw new AppError(`本地数据读取失败：${e.message} 原始数据未被覆盖。`, 'CORRUPT'); }
}
export function validateBackup(raw) {
  if (!object(raw) || raw.app !== 'prompt-library' || ![1, 2].includes(raw.version) || !validDate(raw.exportedAt)) fail('请选择石头宝典支持的 JSON 备份（V1 或 V2）。');
  const data = records(raw.categories, raw.prompts, raw.version);
  if (raw.version === 2 && raw.drafts !== undefined && !Array.isArray(raw.drafts)) fail('备份中的草稿格式不正确。');
  const drafts = raw.version === 2 ? (raw.drafts ?? []).map(validateDraft) : [];
  if (drafts.length > LIMITS.drafts || new Set(drafts.map(d => d.id)).size !== drafts.length) fail('草稿数量或编号无效。');
  return { ...data, drafts, exportedAt: raw.exportedAt };
}
export function exportBackup(state, now = new Date().toISOString()) {
  return { app: 'prompt-library', version: 2, exportedAt: now, categories: structuredClone(state.categories), prompts: structuredClone(state.prompts), drafts: structuredClone(state.drafts) };
}
export function selectPrompts(state, query = '', category = 'all', view = 'all') {
  const term = nameKey(query);
  return state.prompts.filter(p => (view === 'trash' ? !!p.deletedAt : !p.deletedAt) && (view !== 'pinned' || p.pinned) && (category === 'all' || p.categoryId === category) && (!term || nameKey(`${p.title}\n${p.body}\n${p.notes || ''}`).includes(term)))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id));
}
function check(record, expected) {
  if (!record || record.version !== expected) fail('内容已在其他窗口发生变化。你的草稿仍保留，可另存副本或重新打开最新内容。', 'CONFLICT');
}
function tick(record, now) { return new Date(Math.max(Date.parse(now), Date.parse(record.updatedAt) + 1)).toISOString(); }
const signature = p => JSON.stringify([p.title, p.body, p.notes || '', p.categoryId, p.pinned, !!p.deletedAt]);
function consumeSourceDraft(state, source) {
  if (source && validId(source.id) && Number.isSafeInteger(source.seq)) state.drafts = state.drafts.filter(d => d.id !== source.id || d.seq !== source.seq);
}
export function mergeBackup(current, backup, uuid = () => crypto.randomUUID()) {
  const incoming = validateBackup(backup), state = structuredClone(current);
  const stats = { added: 0, skipped: 0, conflicts: 0, addedCategories: 0, addedDrafts: 0 };
  const names = new Map(state.categories.map(c => [nameKey(c.name), c.id])), mapping = new Map();
  incoming.categories.forEach(c => {
    const key = nameKey(c.name);
    if (!names.has(key)) {
      const id = state.categories.some(x => x.id === c.id) ? uuid() : c.id;
      state.categories.push({ id, name: c.name }); names.set(key, id); stats.addedCategories++;
    }
    mapping.set(c.id, names.get(key));
  });
  const sigs = new Set(state.prompts.map(signature));
  incoming.prompts.forEach(p => {
    const item = { ...p, categoryId: mapping.get(p.categoryId) };
    if (sigs.has(signature(item))) { stats.skipped++; return; }
    if (state.prompts.some(x => x.id === item.id)) { item.id = uuid(); stats.conflicts++; }
    state.prompts.push(item); sigs.add(signature(item)); stats.added++;
  });
  incoming.drafts.forEach(d => {
    const item = { ...d, categoryId: mapping.get(d.categoryId) || UNCATEGORIZED };
    if (state.drafts.some(x => x.title === item.title && x.body === item.body && (x.notes || '') === item.notes && x.categoryId === item.categoryId)) return;
    // Restored drafts are always independent copies; never overwrite a current record.
    item.id = uuid(); item.promptId = null; item.expectedVersion = null;
    state.drafts.push(item); stats.addedDrafts++;
  });
  if (state.categories.length > LIMITS.categories || state.prompts.length > LIMITS.prompts || state.drafts.length > LIMITS.drafts) fail('合并后的内容超过容量限制，请先整理分类、提示词或草稿。');
  return { state, result: stats };
}
export function applyOperation(current, type, payload = {}, options = {}) {
  if (!object(payload)) fail('操作参数无效。');
  let state = structuredClone(current), result = {};
  const now = options.now || new Date().toISOString(), uuid = options.uuid || (() => crypto.randomUUID());
  const category = key => state.categories.find(c => c.id === key);
  switch (type) {
    case 'savePrompt': {
      const title = field(payload.title, '标题', LIMITS.title), body = field(payload.body, '正文', LIMITS.body, false), notes = notesField(payload.notes), categoryId = payload.categoryId || UNCATEGORIZED;
      if (!category(categoryId)) fail('分类已经不存在，请重新选择。', 'CONFLICT');
      const duplicate = state.prompts.find(p => !p.deletedAt && p.id !== payload.id && p.body === body);
      if (duplicate && !payload.allowDuplicate) fail(`已收藏相同正文：「${duplicate.title}」。`, 'DUPLICATE', { id: duplicate.id });
      if (payload.id) {
        const record = state.prompts.find(p => p.id === payload.id); check(record, payload.expectedVersion);
        if (record.deletedAt) fail('这条提示词在回收站中，请先恢复或另存副本。', 'CONFLICT');
        Object.assign(record, { title, body, notes, categoryId, updatedAt: tick(record, now), version: record.version + 1 }); result.id = record.id;
      } else {
        if (state.prompts.length >= LIMITS.prompts) fail('提示词数量已达上限。');
        const id = uuid(); state.prompts.push({ id, title, body, notes, categoryId, createdAt: now, updatedAt: now, version: 1, pinned: false, deletedAt: null }); result.id = id;
      }
      if (payload.draftId) state.drafts = state.drafts.filter(d => d.id !== payload.draftId);
      consumeSourceDraft(state, payload.sourceDraft);
      break;
    }
    case 'togglePin': case 'deletePrompt': case 'restorePrompt': {
      const p = state.prompts.find(p => p.id === payload.id); check(p, payload.expectedVersion);
      if (type === 'togglePin') p.pinned = !p.pinned;
      if (type === 'deletePrompt') p.deletedAt = now;
      if (type === 'restorePrompt') p.deletedAt = null;
      p.updatedAt = tick(p, now); p.version++; break;
    }
    case 'purgePrompt': {
      const p = state.prompts.find(p => p.id === payload.id); check(p, payload.expectedVersion);
      if (!p.deletedAt) fail('只能彻底删除回收站中的提示词。');
      state.prompts = state.prompts.filter(x => x.id !== p.id); break;
    }
    case 'saveCategory': {
      const name = field(payload.name, '分类名称', LIMITS.category);
      if (state.categories.some(c => nameKey(c.name) === nameKey(name) && c.id !== payload.id)) fail('已存在同名分类。');
      if (payload.id) {
        if (payload.id === UNCATEGORIZED) fail('“未分类”不能改名。');
        const c = category(payload.id); if (!c || c.name !== payload.expectedName) fail('分类已发生变化，请重新打开。', 'CONFLICT');
        c.name = name;
      } else { if (state.categories.length >= LIMITS.categories) fail('分类数量已达上限。'); state.categories.push({ id: uuid(), name }); }
      break;
    }
    case 'deleteCategory': {
      if (payload.id === UNCATEGORIZED) fail('“未分类”不能删除。');
      const c = category(payload.id); if (!c || c.name !== payload.expectedName) fail('分类已发生变化，请重新打开。', 'CONFLICT');
      state.prompts.forEach(p => { if (p.categoryId === c.id) { p.categoryId = UNCATEGORIZED; p.version++; p.updatedAt = tick(p, now); } });
      state.drafts.forEach(d => { if (d.categoryId === c.id) d.categoryId = UNCATEGORIZED; });
      state.categories = state.categories.filter(x => x.id !== c.id); break;
    }
    case 'saveDraft': {
      const d = validateDraft(payload), found = state.drafts.find(x => x.id === d.id);
      if (found && found.seq >= d.seq) return { state: current, result: { stale: true } };
      consumeSourceDraft(state, payload.sourceDraft);
      if (!found && state.drafts.length >= LIMITS.drafts) fail('最多保留 30 份草稿，请先保存或清理已有草稿。');
      if (found) Object.assign(found, d); else state.drafts.push(d);
      break;
    }
    case 'deleteDraft': state.drafts = state.drafts.filter(d => d.id !== payload.id); consumeSourceDraft(state, payload.sourceDraft); break;
    case 'importBackup': {
      if (payload.expectedRevision !== state.revision) fail('预览后资料库已有变化，请重新选择备份并预览。', 'CONFLICT');
      ({ state, result } = mergeBackup(state, payload.backup, uuid)); break;
    }
    case 'markExport': state.lastExportAt = now; break;
    default: fail('不支持的操作。');
  }
  if (type !== 'markExport') state.revision++;
  return { state, result };
}
