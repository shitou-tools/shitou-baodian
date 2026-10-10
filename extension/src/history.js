import { request } from './client.js';
import { createHistoryPager } from './history-pager.js';
const $ = id => document.getElementById(id);
const stamp = value => new Date(value).toLocaleString('zh-CN', { hour12: false });
const pager = createHistoryPager(marker => request('cloudList', { marker }));
let current = { page: 0 }, busy = false;
function node(tag, className, text) { const n = document.createElement(tag); n.className = className; n.textContent = text; return n; }
function choice(title, message, action, danger = false) {
  $('history-confirm-title').textContent = title; $('history-confirm-message').textContent = message;
  $('history-accept').textContent = action; $('history-accept').className = 'primary' + (danger ? ' history-danger-confirm' : '');
  const dialog = $('history-confirm'); dialog.returnValue = ''; dialog.showModal(); $('history-cancel').focus();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'yes'), { once: true }));
}
$('history-cancel').addEventListener('click', () => $('history-confirm').close('no'));
$('history-accept').addEventListener('click', () => $('history-confirm').close('yes'));
async function job(fn) {
  if (busy) return; busy = true; $('history-fields').disabled = true; $('history-error').hidden = true;
  $('history-list').setAttribute('aria-busy', 'true');
  try { await fn(); } catch (error) { $('history-error').textContent = error.message || '操作失败，请重试。'; $('history-error').hidden = false; }
  finally { busy = false; $('history-fields').disabled = false; $('history-list').setAttribute('aria-busy', 'false'); }
}
function download(backup) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = `石头宝典-云备份-${backup.exportedAt.replace(/[:.]/g, '-')}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function restore(item) {
  const backup = await request('cloudDownload', { key: item.key });
  const p = await request('previewBackup', { backup });
  if (!await choice('预览备份恢复', `备份时间：${stamp(p.exportedAt)}\n新增提示词：${p.added} 条\n跳过重复：${p.skipped} 条\n编号冲突：${p.conflicts} 条（保留两版）\n新增分类：${p.addedCategories} 个\n恢复草稿：${p.addedDrafts} 份\n\n合并到当前资料库，不覆盖已有正文。操作前会保留恢复点。`, '合并恢复')) return;
  await request('importBackup', { backup, expectedRevision: p.expectedRevision });
  $('history-notice').textContent = `恢复完成，新增 ${p.added} 条提示词。可返回资料库查看。`;
}
async function remove(item) {
  if (!await choice('删除这份云端备份？', `备份时间：${stamp(item.lastModified)}\n大小：${(item.size / 1024).toFixed(1)} KB\n设备：${item.key.slice('prompt-box-backups/v1/'.length + 14, 'prompt-box-backups/v1/'.length + 22)}\n\n删除后无法在插件内找回。只删除这份云端快照，本地提示词和其他备份保留。`, '确认删除', true)) return;
  await request('cloudDelete', { key: item.key, confirmed: true });
  // Remove the confirmed row even if refreshing later fails; never imply a failed delete succeeded.
  for (const row of $('history-list').children) if (row.dataset.key === item.key) row.remove();
  $('history-notice').textContent = '该云端备份已删除，本地提示词保留。';
  try { await load(0, true); $('history-notice').textContent = '已删除选中的备份，已返回最新记录。'; }
  catch { $('history-prev').disabled = true; $('history-next').disabled = true; throw new Error('备份已删除，但列表刷新失败，请点击“刷新记录”。'); }
}
function action(label, fn, className = 'secondary') {
  const button = node('button', className, label); button.type = 'button'; button.addEventListener('click', () => job(fn)); return button;
}
async function load(page = 0, reset = false) {
  const data = await pager.load(page, reset); current = data;
  const rows = data.items.map((item, i) => {
    const row = node('article', 'history-record', ''); row.dataset.key = item.key;
    const info = node('div', '', ''); info.append(node('h3', '', stamp(item.lastModified)), node('p', '', `${(item.size / 1024).toFixed(1)} KB · 设备 ${item.key.slice('prompt-box-backups/v1/'.length + 14, 'prompt-box-backups/v1/'.length + 22)}`));
    const actions = node('div', 'button-row', '');
    const del = action('删除备份', () => remove(item), 'secondary history-delete'); del.disabled = !data.canDelete;
    if (del.disabled) del.title = '请先更新云端服务以启用删除';
    actions.append(action('下载备份', async () => download(await request('cloudDownload', { key: item.key }))), action('预览恢复', () => restore(item)), del);
    row.append(node('span', 'history-record-number', String(data.page * 10 + i + 1).padStart(2, '0')), info, actions); return row;
  });
  if (!rows.length) { const empty = node('div', 'history-empty', ''); empty.append(node('strong', '', '还没有云端备份'), node('p', '', '回到备份设置，点击“立即备份”留下第一份记录。')); rows.push(empty); }
  $('history-list').replaceChildren(...rows);
  $('history-prev').disabled = !data.hasPrevious; $('history-next').disabled = !data.hasNext;
  $('history-page-number').textContent = `第 ${data.page + 1} 页 · ${data.items.length} 份`;
  $('history-notice').textContent = '包含提示词、备注、分类、草稿与回收站。可先预览，再决定是否恢复。';
  $('history-upgrade').hidden = data.canDelete;
}
$('history-refresh').addEventListener('click', () => job(() => load(0, true)));
$('history-prev').addEventListener('click', () => job(() => load(current.page - 1)));
$('history-next').addEventListener('click', () => job(() => load(current.page + 1)));
await job(() => load());
