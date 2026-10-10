import { setupCloudUI } from './cloud-ui.js';
import { request } from './client.js';
import { selectPrompts, UNCATEGORIZED, LIMITS } from './model.js';
const $ = id => document.getElementById(id);
document.body.classList.toggle('manager', location.pathname.endsWith('manager.html'));
let state, info, view = 'all', category = 'all', editor = null, detailId = null, draftChain = Promise.resolve(), toastTimer, refreshGeneration = 0;
const formatDate = date => new Date(date).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const categoryName = id => state.categories.find(c => c.id === id)?.name || '未分类';
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function button(text, className, action, label) { const b = el('button', className, text); b.type = 'button'; if (label) { b.setAttribute('aria-label', label); b.title = label; } b.addEventListener('click', () => Promise.resolve(action()).catch(report)); return b; }
function toast(text, error = false) { const t = $('toast'); t.textContent = text; t.classList.toggle('error', error); t.hidden = false; if (!t.matches(':popover-open')) t.showPopover(); clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidePopover(); t.hidden = true; }, error ? 6500 : 2800); }
function report(e) { toast(e.message || String(e), true); }
function setState(data) { if (!state || data.state.revision >= state.revision) { state = data.state; info = data; render(); } }
async function refresh() { const gen = ++refreshGeneration; const data = await request('getState'); if (gen === refreshGeneration) setState(data); }
async function mutate(type, payload) { const data = await request(type, payload); setState(data); return data.result; }
function navItem(label, count, active, fn) { const b = button('', 'nav-item' + (active ? ' active' : ''), fn); b.setAttribute('aria-pressed', String(active)); b.append(el('span', '', label), el('span', 'nav-count', count)); return b; }
function render() {
  const live = state.prompts.filter(p => !p.deletedAt), trash = state.prompts.filter(p => p.deletedAt);
  if (category !== 'all' && !state.categories.some(c => c.id === category)) category = 'all';
  $('views').replaceChildren(...[['all', '全部提示词', live.length], ['pinned', '常用置顶', live.filter(p => p.pinned).length], ['trash', '回收站', trash.length]].map(([key, name, count]) => navItem(name, count, view === key && category === 'all', () => { view = key; category = 'all'; render(); })));
  $('categories').replaceChildren(...state.categories.map(c => navItem(c.name, live.filter(p => p.categoryId === c.id).length, category === c.id, () => { category = c.id; view = 'all'; render(); })));
  $('draft-count').textContent = state.drafts.length;
  $('view-title').textContent = category !== 'all' ? categoryName(category) : ({ all: '全部提示词', pinned: '常用置顶', trash: '回收站' })[view];
  const items = selectPrompts(state, $('search').value, category, view);
  $('clear-search').hidden = !$('search').value;
  $('result-count').textContent = items.length;
  $('list').replaceChildren(...items.map(card));
  if (!items.length) {
    const empty = el('div', 'empty-state'); empty.append(el('div', 'empty-symbol', '“'));
    let heading = '从第一条好提示词开始', description = '把常用、验证过的文字留在这里。需要的时候，一眼找到。';
    if ($('search').value) { heading = '还没有找到这条灵感'; description = '试试更短的关键词，或切换到“全部提示词”。'; }
    else if (view === 'trash') { heading = '回收站是空的'; description = '删除的提示词会先放在这里，可以随时恢复。'; }
    else if (view === 'pinned') { heading = '让常用的，先被看见'; description = '点击提示词右上角的星标，把常用内容放到这里。'; }
    else if (category !== 'all') { heading = '这个分类，等你收藏'; description = '从一条真正好用的提示词开始。'; }
    empty.append(el('h3', '', heading), el('p', '', description));
    if (view === 'all' && !$('search').value) empty.append(button('＋ 收藏第一条', 'primary', () => openEditor()));
    if ($('search').value) empty.append(button('清除搜索', 'secondary', () => { $('search').value = ''; render(); }));
    $('list').append(empty);
  }
  $('library-summary').textContent = `${live.length} 条收藏 · ${state.categories.length} 个分类 · 本地保存`;
  if ($('drafts-dialog').open) renderDrafts();
  if ($('settings-dialog').open) renderSettings();
  if ($('detail-dialog').open && detailId) renderDetail();
}
function card(p) {
  const c = el('article', 'prompt-card'), top = el('div', 'card-top');
  top.append(el('span', 'pill', categoryName(p.categoryId)), button(p.pinned ? '★' : '☆', 'pin-button' + (p.pinned ? ' pinned' : ''), () => mutate('togglePin', { id: p.id, expectedVersion: p.version }), `${p.pinned ? '取消置顶' : '置顶'}：${p.title}`));
  const open = button('', 'card-open', () => showDetail(p.id), `查看：${p.title}`);
  open.append(el('h3', '', p.title), el('pre', 'card-preview', p.body));
  if (p.notes?.trim()) open.append(el('p', 'card-notes', `备注 · ${p.notes}`));
  const bottom = el('div', 'card-bottom');
  bottom.append(el('span', 'card-date', `${p.deletedAt ? '已删除' : '编辑于'} ${formatDate(p.deletedAt || p.updatedAt)}`), p.deletedAt ? button('恢复 ↗', 'copy-button', async () => { await mutate('restorePrompt', { id: p.id, expectedVersion: p.version }); toast('已恢复到原分类'); }) : button('复制 ↗', 'copy-button', () => copy(p.body), `复制：${p.title}`));
  c.append(top, open, bottom); return c;
}
async function copy(text) { try { await navigator.clipboard.writeText(text); toast('已复制完整提示词'); } catch { throw new Error('复制失败，请在详情中选择正文并手动复制。'); } }
function showDetail(id) { detailId = id; renderDetail(); if (!$('detail-dialog').open) $('detail-dialog').showModal(); }
function renderDetail() {
  const p = state.prompts.find(p => p.id === detailId); if (!p) { $('detail-dialog').close(); return; }
  $('detail-title').textContent = p.title; $('detail-category').textContent = categoryName(p.categoryId); $('detail-body').textContent = p.body;
  $('detail-notes-section').hidden = !p.notes?.trim(); $('detail-notes').textContent = p.notes || '';
  $('detail-meta').textContent = `${p.body.length.toLocaleString()} 字符 · 最近修改 ${formatDate(p.updatedAt)}${p.deletedAt ? ' · 在回收站中' : ''}`;
  const actions = [button('复制全文 ↗', 'primary', () => copy(p.body))];
  if (!p.deletedAt) {
    actions.unshift(button('移入回收站', 'text-button danger-text', async () => { await mutate('deletePrompt', { id: p.id, expectedVersion: p.version }); $('detail-dialog').close(); toast('已移入回收站，可随时恢复'); }));
    actions.unshift(button('编辑', 'secondary', () => { $('detail-dialog').close(); openEditor(p); }));
  } else {
    actions.unshift(button('恢复提示词', 'secondary', async () => { await mutate('restorePrompt', { id: p.id, expectedVersion: p.version }); toast('已恢复'); }));
    actions.unshift(button('彻底删除', 'text-button danger-text', async () => {
      if (await choice('彻底删除这条提示词？', `「${p.title}」将从本地资料库移除，无法通过回收站恢复。需要保留时，请先导出备份。`, [{ label: '取消', value: false }, { label: '彻底删除', value: true, className: 'secondary danger-text' }])) {
        await mutate('purgePrompt', { id: p.id, expectedVersion: p.version }); $('detail-dialog').close(); toast('已彻底删除');
      }
    }));
  }
  $('detail-actions').replaceChildren(...actions);
}
function openEditor(p = null, draft = null) {
  editor = draft ? { ...structuredClone(draft), id: crypto.randomUUID(), seq: 0, sourceDraft: { id: draft.id, seq: draft.seq } } : { id: crypto.randomUUID(), title: p?.title || '', body: p?.body || '', notes: p?.notes || '', categoryId: p?.categoryId || (category === 'all' ? UNCATEGORIZED : category), promptId: p?.id || null, expectedVersion: p?.version || null, seq: 0, updatedAt: new Date().toISOString() };
  if (!state.categories.some(c => c.id === editor.categoryId)) editor.categoryId = UNCATEGORIZED;
  $('editor-heading').textContent = editor.promptId ? '打磨这条提示词' : '新增提示词';
  $('prompt-title').value = editor.title; $('prompt-body').value = editor.body; $('prompt-notes').value = editor.notes || '';
  $('prompt-category').replaceChildren(...state.categories.map(c => { const option = el('option', '', c.name); option.value = c.id; return option; }));
  $('prompt-category').value = editor.categoryId;
  $('char-count').textContent = `${editor.body.length.toLocaleString()} / 100,000`;
  $('draft-status').textContent = draft ? '已恢复本地草稿' : '开始输入后自动保存草稿';
  $('draft-status').classList.remove('danger-text'); $('editor-error').hidden = true; $('save-copy').hidden = !editor.promptId;
  $('editor-fields').disabled = false;
  $('editor-dialog').showModal(); $('prompt-title').focus();
}
function queueDraft() {
  if (!editor) return;
  Object.assign(editor, { title: $('prompt-title').value, body: $('prompt-body').value, notes: $('prompt-notes').value, categoryId: $('prompt-category').value, seq: editor.seq + 1, updatedAt: new Date().toISOString() });
  $('char-count').textContent = `${editor.body.length.toLocaleString()} / 100,000`;
  const snapshot = structuredClone(editor);
  $('draft-status').textContent = '正在保存草稿…';
  draftChain = draftChain.then(async () => {
    try {
      await mutate('saveDraft', snapshot);
      if (editor?.id === snapshot.id && editor.seq === snapshot.seq) { $('draft-status').textContent = '草稿已保存在本机'; $('draft-status').classList.remove('danger-text'); }
    } catch (e) { if (editor?.id === snapshot.id) { $('draft-status').textContent = `草稿保存失败：${e.message}`; $('draft-status').classList.add('danger-text'); } }
  });
}
function choice(title, text, choices = [{ label: '取消', value: false, className: 'secondary' }, { label: '确认', value: true, className: 'primary' }]) {
  return new Promise(resolve => {
    const dialog = $('confirm-dialog'); $('confirm-title').textContent = title; $('confirm-message').textContent = text;
    let settled = false;
    const done = value => { if (settled) return; settled = true; dialog.close(); dialog.removeEventListener('cancel', cancel); resolve(value); };
    const cancel = e => { e.preventDefault(); done(false); };
    dialog.addEventListener('cancel', cancel);
    $('confirm-actions').replaceChildren(...choices.map(c => button(c.label, c.className || 'secondary', () => done(c.value))));
    dialog.showModal();
  });
}
async function savePrompt(asCopy = false) {
  if (!$('editor-form').reportValidity() || !editor) return;
  $('save-button').disabled = true; $('save-copy').disabled = true; $('discard-draft').disabled = true; $('close-editor').disabled = true; $('editor-fields').disabled = true;
  $('editor-error').hidden = true;
  try {
    await draftChain;
    const payload = { title: $('prompt-title').value, body: $('prompt-body').value, notes: $('prompt-notes').value, categoryId: $('prompt-category').value, id: asCopy ? null : editor.promptId, expectedVersion: editor.expectedVersion, draftId: editor.id, sourceDraft: editor.sourceDraft };
    try { await mutate('savePrompt', payload); }
    catch (e) {
      if (e.code !== 'DUPLICATE') throw e;
      const result = await choice('这段正文已经收藏过', e.message, [{ label: '返回编辑', value: false }, { label: '查看已有', value: 'view' }, { label: '仍然保存', value: true, className: 'primary' }]);
      if (result === 'view') { $('editor-dialog').close(); showDetail(e.details.id); return; }
      if (!result) return;
      await mutate('savePrompt', { ...payload, allowDuplicate: true });
    }
    $('editor-dialog').close(); editor = null; toast('已保存，随时取用');
  } catch (e) { $('editor-error').textContent = e.message; $('editor-error').hidden = false; }
  finally { $('save-button').disabled = false; $('save-copy').disabled = false; $('discard-draft').disabled = false; $('close-editor').disabled = false; $('editor-fields').disabled = false; }
}
function renderCategories() {
  $('category-list').replaceChildren(...state.categories.map(c => {
    const row = el('div', 'row-item'), input = el('input'); input.value = c.name; input.maxLength = 30; input.setAttribute('aria-label', `分类名称：${c.name}`); input.disabled = c.id === UNCATEGORIZED;
    row.append(input);
    if (c.id !== UNCATEGORIZED) row.append(button('改名', 'text-button', async () => { await mutate('saveCategory', { id: c.id, name: input.value, expectedName: c.name }); renderCategories(); toast('分类已更新'); }), button('删除', 'text-button danger-text', async () => { if (await choice('删除这个分类？', `「${c.name}」中的提示词会移入“未分类”，正文和草稿会保留。`)) { await mutate('deleteCategory', { id: c.id, expectedName: c.name }); renderCategories(); toast('分类已删除，内容已保留'); } }));
    else row.append(el('small', 'muted', '系统分类'));
    return row;
  }));
}
function renderDrafts() {
  const drafts = [...state.drafts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  $('draft-list').replaceChildren(...drafts.map(d => {
    const row = el('div', 'row-item'), open = button('', 'item-title', () => { $('drafts-dialog').close(); openEditor(null, d); });
    open.append(el('strong', '', d.title || '未命名草稿'), el('small', '', `${d.body.length.toLocaleString()} 字符 · ${formatDate(d.updatedAt)}`));
    row.append(open, button('继续写 ↗', 'text-button', () => { $('drafts-dialog').close(); openEditor(null, d); }), button('放弃', 'text-button danger-text', async () => { if (await choice('放弃这份草稿？', '只清除草稿，已收藏的提示词不受影响。')) await mutate('deleteDraft', { id: d.id }); })); return row;
  }));
  if (!drafts.length) $('draft-list').append(el('p', 'muted', '还没有草稿。编辑中的内容会自动保存在这里。'));
}
function renderSettings() {
  $('backup-info').textContent = state.lastExportAt ? `最近导出：${formatDate(state.lastExportAt)}。请确认文件已保存到你的文件夹。` : '尚未导出备份。建议定期为你的积累留一份副本。';
  $('storage-info').textContent = `占用 ${(info.bytes / 1024).toFixed(1)} KB`;
  $('recovery-section').hidden = !info.recovery;
  if (info.recovery) {
    $('recovery-info').textContent = `${formatDate(info.recovery.createdAt)} · ${info.recovery.promptCount} 条。恢复后已有其他改动时，只能导出恢复点，避免覆盖新内容。`;
    $('undo-button').disabled = info.recovery.afterRevision !== state.revision;
  }
}
function download(data, prefix = '石头宝典-备份') {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' }), url = URL.createObjectURL(blob), a = document.createElement('a');
  const date = new Date(); const stamp = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}-${String(date.getHours()).padStart(2,'0')}${String(date.getMinutes()).padStart(2,'0')}${String(date.getSeconds()).padStart(2,'0')}`;
  a.href = url; a.download = `${prefix}-${stamp}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function importFile(file) {
  if (!file) return;
  if (file.size > LIMITS.bytes) throw new Error('备份文件过大，请选择 9 MB 以内的石头宝典备份。');
  let backup; try { backup = JSON.parse(await file.text()); } catch { throw new Error('JSON 文件无法解析，请检查备份是否完整。'); }
  const preview = await request('previewBackup', { backup });
  const accepted = await choice('预览备份恢复', `备份时间：${formatDate(preview.exportedAt)}\n新增提示词：${preview.added} 条\n跳过重复：${preview.skipped} 条\n编号冲突：${preview.conflicts} 条（保留两版）\n新增分类：${preview.addedCategories} 个\n恢复草稿：${preview.addedDrafts} 份\n\n合并到当前资料库，不覆盖已有正文。操作前会保留恢复点。`, [{ label: '取消', value: false }, { label: '合并恢复', value: true, className: 'primary' }]);
  if (!accepted) return;
  await mutate('importBackup', { backup, expectedRevision: preview.expectedRevision });
  toast(`恢复完成，新增 ${preview.added} 条提示词`);
}
async function handleCapture() {
  const { promptBoxCapture: capture } = await chrome.storage.local.get('promptBoxCapture');
  if (!capture || sessionStorage.getItem('capture-seen') === String(capture.at)) return;
  sessionStorage.setItem('capture-seen', String(capture.at));
  if (capture.error) { report(new Error(`右键收藏失败：${capture.error}`)); return; }
  await refresh(); const draft = state.drafts.find(d => d.id === capture.id); if (!draft) return;
  if (document.querySelector('dialog[open]')) { toast('网页选中文字已存入草稿箱'); return; }
  openEditor(null, draft);
  if (capture.truncated) { $('editor-error').textContent = '所选文字超过 100,000 字符，仅保存前 100,000 字符，请检查后再收藏。'; $('editor-error').hidden = false; }
}
$('search').addEventListener('input', render);
$('clear-search').addEventListener('click', () => { $('search').value = ''; render(); $('search').focus(); });
$('new-button').addEventListener('click', () => openEditor());
$('expand').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('close-editor').addEventListener('click', () => $('editor-dialog').close());
$('editor-dialog').addEventListener('cancel', e => { if ($('save-button').disabled) e.preventDefault(); });
$('editor-form').addEventListener('submit', e => { e.preventDefault(); savePrompt(); });
$('save-copy').addEventListener('click', () => savePrompt(true));
['prompt-title', 'prompt-body', 'prompt-notes', 'prompt-category'].forEach(id => $(id).addEventListener('input', queueDraft));
$('discard-draft').addEventListener('click', async () => {
  try { if (!editor || !(await choice('放弃这份草稿？', '未保存的修改会被清除，已收藏的原内容仍然保留。'))) return; await draftChain; await mutate('deleteDraft', { id: editor.id, sourceDraft: editor.sourceDraft }); $('editor-dialog').close(); editor = null; } catch (e) { report(e); }
});
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => $(b.dataset.close).close()));
$('categories-button').addEventListener('click', () => { renderCategories(); $('categories-dialog').showModal(); });
$('category-form').addEventListener('submit', async e => { e.preventDefault(); const b = e.submitter; b.disabled = true; try { await mutate('saveCategory', { name: $('category-name').value }); $('category-name').value = ''; renderCategories(); } catch (error) { report(error); } finally { b.disabled = false; } });
$('drafts-button').addEventListener('click', () => { renderDrafts(); $('drafts-dialog').showModal(); });
$('settings-button').addEventListener('click', () => { renderSettings(); $('settings-dialog').showModal(); });
$('export-button').addEventListener('click', async () => { try { await draftChain; download(await request('exportBackup')); await mutate('markExport'); toast('已发起备份下载，请保管好文件'); } catch(e) { report(e); } });
$('import-button').addEventListener('click', () => $('backup-file').click());
$('backup-file').addEventListener('change', async e => { const file = e.target.files[0]; e.target.value = ''; try { await importFile(file); } catch (error) { report(error); } });
$('export-recovery').addEventListener('click', async () => { try { download(await request('exportRecovery'), '石头宝典-恢复点'); } catch(e) { report(e); } });
$('undo-button').addEventListener('click', async () => { try { if (await choice('撤回上次备份恢复？', '资料库将返回合并恢复之前的状态。')) { await mutate('undoImport'); toast('已撤回上次恢复'); } } catch(e) { report(e); } });
$('shortcuts-button').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
chrome.storage.onChanged.addListener((changes, area) => { if (area !== 'local') return; if (changes.promptBoxDatabase) refresh().catch(report); if (changes.promptBoxCapture) handleCapture().catch(report); });
try { await refresh(); await handleCapture(); }
catch(e) { $('fatal').textContent = e.message; $('fatal').hidden = false; $('new-button').disabled = true; $('library-summary').textContent = '读取失败，原始数据未被覆盖'; }

setupCloudUI({ request, report, toast });
