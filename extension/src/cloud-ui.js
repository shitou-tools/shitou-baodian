import { endpointURL } from './cloud.js';
export function setupCloudUI({ request, report, toast }) {
  const $ = id => document.getElementById(id);
  let status, busy = false;
  const stamp = value => new Date(value).toLocaleString('zh-CN');
  async function refresh(fill = false) {
    status = await request('cloudStatus');
    if (fill) { $('cloud-endpoint').value = status.endpoint; $('cloud-auto').checked = status.enabled; }
    $('cloud-status').textContent = status.error ? `备份未完成：${status.error}` : status.lastSuccess ? `最近成功：${stamp(status.lastSuccess)}${status.enabled ? ' · 自动备份已开启' : ' · 自动备份已暂停'}` : status.configured ? '连接已配置，尚无成功上传的备份。' : '尚未连接云端，本地内容仍正常保存。';
    $('cloud-status').classList.toggle('danger-text', !!status.error);
    $('cloud-pause').hidden = !status.enabled;
  }
  async function job(fn) {
    if (busy) return;
    busy = true; $('cloud-fields').disabled = true;
    try { await fn(); } catch (e) { report(e); }
    finally { busy = false; $('cloud-fields').disabled = false; await refresh().catch(report); }
  }
  $('settings-button').addEventListener('click', () => refresh(true).catch(report));
  $('cloud-generate').addEventListener('click', async () => {
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
    $('cloud-token').value = token;
    try { await navigator.clipboard.writeText(token); toast('新口令已复制，请保存到函数的 BACKUP_TOKEN 环境变量'); } catch { $('cloud-token').type = 'text'; toast('请手动复制新口令并保存到函数环境变量'); }
  });
  $('cloud-save').addEventListener('click', () => {
    if (busy) return;
    let endpoint; try { endpoint = endpointURL($('cloud-endpoint').value.trim()); } catch (e) { report(e); return; }
    // Request optional host permission directly during the button's user gesture.
    const permission = chrome.permissions.request({ origins: [new URL(endpoint).origin + '/*'] });
    job(async () => {
      if (!await permission) throw new Error('未获得访问许可，连接尚未保存。');
      await request('cloudSave', { endpoint, token: $('cloud-token').value, enabled: $('cloud-auto').checked });
      $('cloud-token').value = ''; $('cloud-token').type = 'password';
      toast('连接已验证；点击“立即备份”完成首次上传');
      await refresh(true);
    });
  });
  $('cloud-now').addEventListener('click', () => job(async () => { await request('cloudBackup'); toast('云备份成功，已收到云端确认'); }));
  $('cloud-pause').addEventListener('click', () => job(async () => { await request('cloudPause'); $('cloud-auto').checked = false; toast('自动备份已暂停，云端历史保留'); }));
  $('cloud-list').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('cloud-history.html') }).catch(report));
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.promptBoxCloud && $('settings-dialog').open) refresh().catch(report); });
}
