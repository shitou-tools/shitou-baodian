// Keep rendering bounded even when an older server returns 50 records at once.
export function createHistoryPager(fetchPage, size = 10) {
  let items = [], marker = '', started = false, ended = false, page = 0, canDelete = false;
  async function load(target = 0, reset = false) {
    let next = reset ? [] : [...items], cursor = reset ? '' : marker;
    let loaded = reset ? false : started, done = reset ? false : ended, allowed = reset ? false : canDelete;
    const seen = new Set(next.map(x => x.key));
    while (!loaded || (!done && next.length <= target * size + size)) {
      const data = await fetchPage(cursor);
      if (data.nextMarker && data.nextMarker <= cursor) throw new Error('云端分页游标无效，请刷新重试。');
      for (const item of data.items) if (!seen.has(item.key)) { next.push(item); seen.add(item.key); }
      cursor = data.nextMarker || ''; done = !cursor; loaded = true; allowed = data.canDelete === true;
    }
    items = next; marker = cursor; started = loaded; ended = done; canDelete = allowed;
    page = Math.min(Math.max(0, target), Math.max(0, Math.ceil(items.length / size) - 1));
    return { items: items.slice(page * size, (page + 1) * size), page, hasPrevious: page > 0,
      hasNext: items.length > (page + 1) * size || !ended, canDelete };
  }
  return { load };
}
