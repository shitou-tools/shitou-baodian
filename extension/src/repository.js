import { AppError, LIMITS, initialState, validateState, exportBackup, mergeBackup, applyOperation } from './model.js';
export const STORAGE_KEY = 'promptBoxDatabase';
export function createRepository(storage) {
  let tail = Promise.resolve();
  const serial = fn => { const pending = tail.then(fn); tail = pending.catch(() => {}); return pending; };
  async function read() {
    const value = (await storage.get(STORAGE_KEY))[STORAGE_KEY];
    if (value === undefined) return { state: initialState(), recovery: null };
    if (!value || typeof value !== 'object' || !value.state) throw new AppError('本地数据无法读取，未覆盖原始数据。', 'CORRUPT');
    return { state: validateState(value.state), recovery: value.recovery ?? null };
  }
  async function write(db) {
    const bytes = new TextEncoder().encode(JSON.stringify({ [STORAGE_KEY]: db })).length;
    if (bytes > LIMITS.bytes) throw new AppError('本地空间不足。请先导出备份、整理内容后重试；当前输入仍保留。', 'QUOTA');
    try { await storage.set({ [STORAGE_KEY]: db }); }
    catch (e) { throw new AppError(`保存失败，原数据未被替换：${e.message || '存储不可用'}`, 'STORAGE'); }
  }
  const summary = db => ({ state: db.state, recovery: db.recovery ? { createdAt: db.recovery.createdAt, afterRevision: db.recovery.afterRevision, promptCount: db.recovery.state.prompts.length } : null, bytes: new TextEncoder().encode(JSON.stringify(db)).length });
  return {
    execute(message) { return serial(async () => {
      if (!message || typeof message.type !== 'string') throw new AppError('无效请求。');
      const db = await read(), { type, payload = {}, requestId } = message;
      if (type === 'getState') return summary(db);
      if (type === 'exportBackup') return exportBackup(db.state);
      if (type === 'previewBackup') return { ...mergeBackup(db.state, payload.backup).result, expectedRevision: db.state.revision, exportedAt: payload.backup.exportedAt };
      if (type === 'exportRecovery') {
        if (!db.recovery) throw new AppError('没有恢复点。');
        return exportBackup(validateState(db.recovery.state), db.recovery.createdAt);
      }
      if (typeof requestId !== 'string' || !/^[\w-]{1,100}$/.test(requestId)) throw new AppError('请求编号无效。');
      const fingerprint = JSON.stringify([type, payload]);
      // Hash the request: never duplicate full prompt bodies inside the request journal.
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fingerprint)))).map(n => n.toString(16).padStart(2, '0')).join('');
      const previous = db.state.recentRequests.find(r => r.id === requestId);
      if (previous) {
        if (previous.fingerprint !== digest) throw new AppError('请求编号重复，请重新操作。');
        return { ...summary(db), result: previous.result };
      }
      let next;
      if (type === 'undoImport') {
        if (!db.recovery || db.recovery.afterRevision !== db.state.revision) throw new AppError('恢复后已有新改动，无法直接撤回。可以导出恢复点查看原内容。', 'CONFLICT');
        next = { state: validateState(db.recovery.state), result: {} };
        next.state.lastExportAt = db.state.lastExportAt;
        next.state.revision = db.state.revision + 1; db.recovery = null;
      } else next = applyOperation(db.state, type, payload);
      if (type === 'importBackup') db.recovery = { state: structuredClone(db.state), createdAt: new Date().toISOString(), afterRevision: next.state.revision };
      next.state.recentRequests = [...next.state.recentRequests, { id: requestId, fingerprint: digest, result: next.result }].slice(-30);
      await write({ state: next.state, recovery: db.recovery });
      return { ...summary({ state: next.state, recovery: db.recovery }), result: next.result };
    }); }
  };
}
