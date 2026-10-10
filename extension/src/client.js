export async function request(type, payload = {}, requestId = crypto.randomUUID()) {
  const response = await chrome.runtime.sendMessage({ channel: 'prompt-box', type, payload, requestId });
  if (!response?.ok) {
    const error = new Error(response?.error?.message || '无法连接本地存储，请重新打开插件。');
    Object.assign(error, response?.error); throw error;
  }
  return response.data;
}
