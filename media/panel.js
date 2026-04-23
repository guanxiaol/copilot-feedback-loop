(function () {
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const summaryEl = $('summary');
  const metaEl = $('meta');
  const pillEl = $('state-pill');
  const textarea = $('feedback');
  const imagesEl = $('images');
  const sendBtn = $('send');
  const cancelBtn = $('cancel');
  const hintKey = $('hint-key');
  const charCount = $('char-count');
  const imgCount = $('img-count');

  /** @type {{ mimeType: string, base64: string, name?: string }[]} */
  let images = [];
  let currentId = null;
  let ctrlEnterSend = true;
  let receivedAt = 0;

  // --- 轻量 Markdown → HTML（仅支持: 代码块/行内代码/粗体/斜体/标题/列表/链接/换行） ---
  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function renderMarkdown(md) {
    if (!md) return '';
    // 1. 提取代码块先做占位
    const blocks = [];
    md = md.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
      blocks.push('<pre><code class="lang-' + escapeHtml(lang || '') + '">' + escapeHtml(code) + '</code></pre>');
      return `\u0000BLOCK${blocks.length - 1}\u0000`;
    });
    md = escapeHtml(md);
    // 行内代码
    md = md.replace(/`([^`\n]+)`/g, (_, c) => '<code>' + c + '</code>');
    // 粗体/斜体
    md = md.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    md = md.replace(/(^|\W)\*([^*\n]+)\*/g, '$1<em>$2</em>');
    // 标题
    md = md.replace(/^######\s(.+)$/gm, '<h6>$1</h6>');
    md = md.replace(/^#####\s(.+)$/gm, '<h5>$1</h5>');
    md = md.replace(/^####\s(.+)$/gm, '<h4>$1</h4>');
    md = md.replace(/^###\s(.+)$/gm, '<h3>$1</h3>');
    md = md.replace(/^##\s(.+)$/gm, '<h2>$1</h2>');
    md = md.replace(/^#\s(.+)$/gm, '<h1>$1</h1>');
    // 无序列表
    md = md.replace(/(^|\n)([\-\*]\s.+(?:\n[\-\*]\s.+)*)/g, (_, pre, list) => {
      const items = list.split(/\n/).map(l => l.replace(/^[\-\*]\s/, '')).map(t => '<li>' + t + '</li>').join('');
      return pre + '<ul>' + items + '</ul>';
    });
    // 链接 [text](url)
    md = md.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    // 段落换行
    md = md.replace(/\n{2,}/g, '</p><p>');
    md = md.replace(/\n/g, '<br>');
    md = '<p>' + md + '</p>';
    md = md.replace(/<p>\s*<\/p>/g, '');
    md = md.replace(/<p>(\s*<(h\d|ul|pre|blockquote))/g, '$1');
    md = md.replace(/(<\/(h\d|ul|pre|blockquote)>)\s*<\/p>/g, '$1');
    // 恢复代码块
    md = md.replace(/\u0000BLOCK(\d+)\u0000/g, (_, i) => blocks[+i]);
    return md;
  }

  function setSummary(md) {
    if (!md) {
      summaryEl.innerHTML = `
        <div class="placeholder">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/><path d="M12 8v5"/><path d="M12 16.5v.01"/>
          </svg>
          <p>暂无请求。当 Copilot 发起反馈调用时，这里会展示它即将提交的完整回复内容。</p>
        </div>`;
    } else {
      summaryEl.innerHTML = renderMarkdown(md);
      summaryEl.scrollTop = 0;
    }
  }

  function formatMeta() {
    if (!currentId) { metaEl.textContent = '等待中…'; return; }
    const seconds = Math.max(0, Math.floor((Date.now() - receivedAt) / 1000));
    metaEl.textContent = `请求 ${currentId.slice(0, 8)} · ${seconds}s 前`;
  }

  function renderImages() {
    imagesEl.innerHTML = '';
    images.forEach((img, idx) => {
      const wrap = document.createElement('div');
      wrap.className = 'thumb';
      const im = document.createElement('img');
      im.src = 'data:' + img.mimeType + ';base64,' + img.base64;
      im.alt = img.name || '粘贴的图片';
      const rm = document.createElement('button');
      rm.type = 'button'; rm.className = 'remove'; rm.title = '移除这张图片';
      rm.setAttribute('aria-label', '移除图片');
      rm.textContent = '×';
      rm.addEventListener('click', () => { images.splice(idx, 1); renderImages(); updateCounters(); });
      wrap.appendChild(im); wrap.appendChild(rm);
      imagesEl.appendChild(wrap);
    });
  }

  function updateCounters() {
    const chars = textarea.value.length;
    charCount.textContent = chars + ' 字';
    if (images.length) {
      imgCount.classList.remove('hidden');
      imgCount.textContent = images.length + ' 图';
    } else {
      imgCount.classList.add('hidden');
    }
    sendBtn.disabled = !(currentId && (chars > 0 || images.length > 0));
  }

  function setPill(text, live) {
    pillEl.textContent = text;
    pillEl.classList.toggle('pill-live', !!live);
    pillEl.classList.toggle('pill-idle', !live);
  }

  function playSound(kind) {
    if (!kind || kind === 'none') return;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const play = (freq, when, dur) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        osc.connect(gain); gain.connect(ctx.destination);
        gain.gain.setValueAtTime(0.0001, ctx.currentTime + when);
        gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + when + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + when + dur);
        osc.start(ctx.currentTime + when); osc.stop(ctx.currentTime + when + dur);
      };
      if (kind === 'triple') { play(880, 0, 0.12); play(880, 0.18, 0.12); play(880, 0.36, 0.12); }
      else if (kind === 'chime') { play(659, 0, 0.3); play(988, 0.15, 0.4); }
      else if (kind === 'ping') { play(1200, 0, 0.1); }
      else if (kind === 'urgent') { for (let i = 0; i < 6; i++) play(1200, i * 0.15, 0.08); }
    } catch (_) { /* no audio allowed */ }
  }

  function send() {
    if (!currentId) return;
    vscode.postMessage({
      type: 'feedback_response',
      id: currentId,
      feedback: textarea.value,
      images
    });
    // 本地复位
    textarea.value = '';
    images = [];
    renderImages();
    updateCounters();
    setPill('已发送', false);
    setSummary('');
    metaEl.textContent = '已发送，等待下一条请求…';
    currentId = null;
  }

  function cancel() {
    if (!currentId) return;
    vscode.postMessage({ type: 'feedback_response', id: currentId, feedback: '', cancelled: true });
    textarea.value = '';
    images = [];
    renderImages();
    updateCounters();
    setPill('已取消', false);
    setSummary('');
    metaEl.textContent = '已取消。';
    currentId = null;
  }

  sendBtn.addEventListener('click', send);
  cancelBtn.addEventListener('click', cancel);

  textarea.addEventListener('input', updateCounters);

  textarea.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') {
      const withMod = ev.ctrlKey || ev.metaKey;
      if (ctrlEnterSend ? withMod : !ev.shiftKey) {
        ev.preventDefault();
        if (!sendBtn.disabled) send();
      }
    }
  });

  textarea.addEventListener('paste', ev => {
    const items = ev.clipboardData?.items || [];
    let consumed = false;
    for (const it of items) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const blob = it.getAsFile();
        if (!blob) continue;
        consumed = true;
        const reader = new FileReader();
        reader.onload = () => {
          const b64 = String(reader.result || '').split(',')[1] || '';
          images.push({ mimeType: blob.type, base64: b64, name: blob.name });
          renderImages();
          updateCounters();
        };
        reader.readAsDataURL(blob);
      }
    }
    if (consumed) ev.preventDefault();
  });

  window.addEventListener('message', ev => {
    const msg = ev.data;
    if (msg?.type === 'feedback_request') {
      currentId = msg.id;
      receivedAt = Date.now();
      setSummary(msg.summary || '');
      textarea.value = '';
      images = [];
      renderImages();
      updateCounters();
      textarea.focus();
      setPill('待反馈', true);
      formatMeta();
      if (msg.soundEnabled) playSound(msg.soundType);
      if (typeof msg.ctrlEnterSend === 'boolean') {
        ctrlEnterSend = msg.ctrlEnterSend;
        hintKey.textContent = ctrlEnterSend ? 'Ctrl' : '';
        if (!ctrlEnterSend) hintKey.parentElement.innerHTML = '支持粘贴图片 · 按 <kbd>Enter</kbd> 发送（<kbd>Shift</kbd>+<kbd>Enter</kbd> 换行）';
      }
    }
  });

  // 实时更新 meta 时间
  setInterval(() => { if (currentId) formatMeta(); }, 1000);

  updateCounters();
}());
