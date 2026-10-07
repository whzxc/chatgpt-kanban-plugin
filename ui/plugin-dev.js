// Development-only resource reload over the existing MCP bridge. No network access.
(() => {
  const { uri, revision } = window.__KANBAN_DEV__;
  if (location.protocol === 'blob:') URL.revokeObjectURL(location.href);
  let pending;
  let sequence = 0;
  let stopped = false;
  let timer;
  const schedule = () => { timer = setTimeout(poll, 1500); };
  function poll() {
    if (stopped) return;
    if (document.hidden) { schedule(); return; }
    pending = `kanban-dev-${Date.now()}-${++sequence}`;
    window.parent.postMessage({ jsonrpc: '2.0', id: pending, method: 'resources/read', params: { uri } }, '*');
    timer = setTimeout(() => { pending = undefined; schedule(); }, 20000);
  }
  window.addEventListener('message', event => {
    if (event.source !== window.parent || event.data?.jsonrpc !== '2.0') return;
    if (event.data.method === 'ui/resource-teardown') { stopped = true; clearTimeout(timer); return; }
    if (!pending || event.data.id !== pending) return;
    pending = undefined;
    clearTimeout(timer);
    const content = event.data.result?.contents?.find(item => item.uri === uri);
    if (content?._meta?.['kanban/devRevision'] && content._meta['kanban/devRevision'] !== revision && content.text) {
      stopped = true;
      location.replace(URL.createObjectURL(new Blob([content.text], { type: 'text/html' })));
    } else schedule();
  });
  window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); });
  schedule();
})();
