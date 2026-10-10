import { AppError, LIMITS, validateBackup } from './model.js';
export const CLOUD_KEY = 'promptBoxCloud';
export const CLOUD_ALARM = 'prompt-box-cloud-backup';
export const CLOUD_PREFIX = 'prompt-box-backups/v1/';
export function endpointURL(value) {
  let u; try { u = new URL(value); } catch { throw new AppError('请填写函数计算的 HTTPS 地址。'); }
  if (u.protocol !== 'https:' || u.port || u.username || u.password || u.search || u.hash || !/^[a-z0-9.-]+\.(fcapp\.run|fc\.aliyuncs\.com)$/.test(u.hostname)) throw new AppError('请使用函数计算提供的 HTTPS 地址（fcapp.run 或 fc.aliyuncs.com），不带查询参数。');
  return u.href;
}
export const sha256 = async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))).map(n => n.toString(16).padStart(2, '0')).join('');
const keyPattern = /^prompt-box-backups\/v1\/\d{13}-[a-f0-9-]{36}-[a-f0-9-]{36}\.json$/;
export function createCloud({ storage, repository, fetcher = fetch, permissions, now = () => Date.now() }) {
  let tail = Promise.resolve();
  const serial = fn => { const result = tail.then(fn); tail = result.catch(() => {}); return result; };
  const read = async () => (await storage.get(CLOUD_KEY))[CLOUD_KEY] || {};
  const write = config => storage.set({ [CLOUD_KEY]: config });
  const publicStatus = c => ({ configured: !!c.endpoint && !!c.token, endpoint: c.endpoint || '', enabled: !!c.enabled, lastSuccess: c.lastSuccess || null, lastAttempt: c.lastAttempt || null, error: c.error || '', deviceId: c.deviceId || '', lastKey: c.lastKey || '' });
  async function api(c, action, payload = {}) {
    if (!c.endpoint || !c.token) throw new AppError('请先保存云备份连接。');
    const endpoint = endpointURL(c.endpoint);
    if (!await permissions.contains({ origins: [new URL(endpoint).origin + '/*'] })) throw new AppError('尚未授权访问备份服务，请重新保存连接并允许访问。');
    let response;
    try { response = await fetcher(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.token}` }, body: JSON.stringify({ action, ...payload }), signal: AbortSignal.timeout(25000), redirect: 'error', credentials: 'omit', cache: 'no-store' }); }
    catch { throw new AppError('无法连接云备份服务，请检查网络和服务地址；本地内容已保留。'); }
    // Limit both declared and streamed lengths. Never echo a server response containing secrets.
    const responseLimit = 2 * LIMITS.bytes + 65536;
    if (Number(response.headers.get('content-length')) > responseLimit) throw new AppError('云端响应超过容量限制。');
    const reader = response.body.getReader(); let size = 0; const chunks = [];
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > responseLimit) { await reader.cancel(); throw new AppError('云端响应超过容量限制。'); } chunks.push(value); } } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let data; try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new AppError(`备份服务返回格式错误（HTTP ${response.status}）。`); }
    if (!response.ok || !data.ok) {
      const messages = { DELETE_PERMISSION: '云端尚未获得删除权限，请为备份角色添加指定目录的 oss:DeleteObject 权限。', AUTH: '连接口令不正确，请检查插件和函数环境变量中的口令。', OSS: '函数无法访问 OSS，请检查角色权限、地域和 Bucket 配置。', CONFIG: '云端缺少配置，请按部署说明检查环境变量和函数角色。', NOT_FOUND: '这份云备份已不存在。', INVALID: '备份服务拒绝了无效请求。', CONFLICT: '云端同名文件内容不同，请重新备份。' };
      throw new AppError(messages[data.code] || `云备份请求失败（HTTP ${response.status}）。`);
    }
    return data;
  }
  async function run(force = false) {
    const c = await read(); if (!force && (!c.enabled || !c.endpoint)) return publicStatus(c);
    if (!c.endpoint) throw new AppError('请先保存云备份连接。');
    c.lastAttempt = new Date(now()).toISOString();
    try {
      const backup = await repository.execute({ type: 'exportBackup' });
      const digest = await sha256(JSON.stringify([backup.categories, backup.prompts, backup.drafts]));
      if (!force && digest === c.lastDigest && !c.pending) return publicStatus(c);
      // Persist identity and export time, not another full copy of the library.
      if (!c.pending || c.pending.digest !== digest) {
        c.deviceId ||= crypto.randomUUID();
        c.pending = { digest, exportedAt: backup.exportedAt, key: `${CLOUD_PREFIX}${String(9999999999999 - now()).padStart(13, '0')}-${c.deviceId}-${crypto.randomUUID()}.json` };
      }
      await write(c);
      backup.exportedAt = c.pending.exportedAt;
      const raw = JSON.stringify(backup);
      const result = await api(c, 'put', { key: c.pending.key, raw });
      if (result.key !== c.pending.key || result.sha256 !== await sha256(raw)) throw new AppError('云端确认信息不匹配，尚未标记备份成功。');
      c.lastDigest = digest; c.lastKey = c.pending.key; c.lastSuccess = new Date(now()).toISOString(); c.error = ''; delete c.pending;
      await write(c); return publicStatus(c);
    } catch (e) { c.error = e.message; await write(c); throw e; }
  }
  return {
    run: force => serial(() => run(force)),
    async status() { return publicStatus(await read()); },
    execute(type, payload = {}) { return serial(async () => {
      let c = await read();
      if (type === 'cloudStatus') return publicStatus(c);
      if (type === 'cloudSave') {
        const endpoint = endpointURL(payload.endpoint);
        const token = payload.token?.trim() || (endpoint === c.endpoint ? c.token : '');
        if (!/^[A-Za-z0-9_-]{32,256}$/.test(token || '')) throw new AppError('请输入 32～256 位连接口令（字母、数字、横线或下划线）。');
        const candidate = { ...c, endpoint, token, enabled: payload.enabled === true, deviceId: c.deviceId || crypto.randomUUID() };
        const health = await api(candidate, 'health');
        if (typeof health.bucket !== 'string' || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(health.bucket) || health.prefix !== CLOUD_PREFIX || typeof health.region !== 'string' || !/^[a-z0-9-]+$/.test(health.region)) throw new AppError('云端配置无效或备份目录协议不一致。');
        if (endpoint !== c.endpoint) { delete candidate.lastDigest; delete candidate.lastSuccess; delete candidate.lastKey; delete candidate.pending; }
        candidate.error = ''; await write(candidate); return publicStatus(candidate);
      }
      if (type === 'cloudPause') { c.enabled = false; await write(c); return publicStatus(c); }
      if (type === 'cloudBackup') return run(true);
      if (type === 'cloudList') {
        const data = await api(c, 'list', { marker: payload.marker || '' });
        if (!Array.isArray(data.items) || data.items.some(x => !keyPattern.test(x.key))) throw new AppError('云端备份列表格式不正确。');
        return data;
      }
      if (type === 'cloudDelete') {
        if (payload.confirmed !== true || !keyPattern.test(payload.key || '')) throw new AppError('请先确认要删除的备份。');
        const result = await api(c, 'delete', { key: payload.key, confirmed: true });
        if (result.key !== payload.key || result.deleted !== true) throw new AppError('云端未确认删除结果，请刷新列表核对。');
        // Deleting the last confirmed snapshot must not suppress future automatic backups.
        if (c.lastKey === payload.key) { delete c.lastKey; delete c.lastSuccess; delete c.lastDigest; }
        if (c.pending?.key === payload.key) delete c.pending;
        await write(c); return { key: result.key, deleted: true };
      }
      if (type === 'cloudDownload') {
        if (!keyPattern.test(payload.key || '')) throw new AppError('备份文件路径无效。');
        const data = await api(c, 'get', { key: payload.key });
        if (typeof data.raw !== 'string' || await sha256(data.raw) !== data.sha256) throw new AppError('备份校验失败，未修改本地内容。');
        const backup = JSON.parse(data.raw); validateBackup(backup); return backup;
      }
      throw new AppError('不支持的云备份操作。');
    }); }
  };
}
