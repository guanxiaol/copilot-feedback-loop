(function () {
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const pill = $('status-pill');
  const portEl = $('port');
  const sessionEl = $('session');
  const requestsEl = $('requests');
  const rtEl = $('rt');
  const toggleLabel = $('toggle-label');

  document.querySelectorAll('button[data-cmd]').forEach(btn => {
    btn.addEventListener('click', () => {
      vscode.postMessage({ type: 'command', command: btn.dataset.cmd });
    });
  });

  function setState(s) {
    // pill 状态
    pill.classList.remove('ok', 'err', 'off');
    if (!s.enabled) {
      pill.textContent = '已停用';
      pill.classList.add('off');
    } else if (s.connected) {
      pill.textContent = '运行中';
      pill.classList.add('ok');
    } else {
      pill.textContent = '未连接';
      pill.classList.add('err');
    }

    portEl.textContent = s.port ? String(s.port) : '—';
    sessionEl.textContent = (s.sessionId || '').slice(0, 8) || '—';
    requestsEl.textContent = String(s.totalRequests || 0);
    rtEl.textContent = (s.avgRoundtripMs || 0) + ' ms';
    toggleLabel.textContent = s.enabled ? '停用拦截器' : '启用拦截器';
  }

  window.addEventListener('message', ev => {
    if (ev.data?.type === 'status') setState(ev.data.state || {});
  });
}());
