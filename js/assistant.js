/* 助手对话、效果图与后台 AI 任务。
 * 依赖 App.core、App.store、App.plan、App.geom、App.panel、App.io、App.projects。
 */
(() => {
  'use strict';
  const App = globalThis.App;

  function aiResponseMessage(status, body){
    if (App.core.PUBLIC_ACCESS === 'owner' && status === 401){
      return App.core.tr('公网登录已过期，请刷新页面后重新登录 AI。', 'Your public session expired. Refresh and sign in to AI again.');
    }
    try {
      const detail = JSON.parse(body)?.error;
      if (typeof detail === 'string' && detail.trim()) return detail.trim();
    } catch(e){}
    return `HTTP ${status}`;
  }

  const publicAiOffline = () => App.core.tr('公网 AI 服务暂不可用，请刷新页面后重试。', 'The public AI service is temporarily unavailable. Refresh and try again.');

  // 公网隧道只传短 HTTP 请求，本机入口继续直接读取原来的 SSE。
  async function readPublicJob(path, cursor, signal){
    for (let attempt = 1; ; attempt++){
      const response = await fetch(`${path}?cursor=${cursor}`, {cache:'no-store', signal}).catch(error => {
        if (signal.aborted || attempt === 3) throw error;
        return null;
      });
      if (response && (attempt === 3 || ![502, 503, 504].includes(response.status))) return response;
      if (response?.body) await response.body.cancel().catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 750 * attempt));
    }
  }

  async function* publicJobUpdates(id, signal){
    if (typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id)){
      throw new Error(App.core.tr('服务未返回任务编号。', 'The service did not return a job ID.'));
    }
    const path = App.core.studioPath(`/api/jobs/${id}`);
    let cursor = 0, done = false;
    try {
      while (!done){
        const response = await readPublicJob(path, cursor, signal);
        if (!response.ok) throw new Error(aiResponseMessage(response.status, await response.text()));
        const update = await response.json();
        if (!Array.isArray(update?.chunks) || !Number.isSafeInteger(update.cursor) || update.cursor < cursor || typeof update.done !== 'boolean'){
          throw new Error(App.core.tr('服务返回了无效的任务进度。', 'The service returned invalid job progress.'));
        }
        cursor = update.cursor;
        done = update.done;
        yield update;
        if (!done && !update.chunks.length) await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } finally {
      if (!done) void fetch(path, {method:'DELETE', keepalive:true}).catch(() => {});
    }
  }

  async function* aiTextChunks(kind, init){
    const owner = App.core.PUBLIC_ACCESS === 'owner';
    const response = await fetch(App.core.studioPath(owner ? `/api/jobs/${kind}` : `/api/${kind}`), init);
    if (!response.ok) throw new Error(aiResponseMessage(response.status, await response.text()));
    if (owner){
      const {id} = await response.json();
      let errorBody = '';
      for await (const {chunks, status, done, error} of publicJobUpdates(id, init.signal)){
        if (error) throw new Error(error);
        if (status >= 300){
          errorBody += chunks.join('');
          if (done) throw new Error(aiResponseMessage(status, errorBody));
        } else {
          yield* chunks;
        }
      }
      return;
    }
    if (!response.body) throw new Error(App.core.tr('当前浏览器不支持流式读取', 'Streaming is not supported in this browser'));
    const reader = response.body.getReader(), decoder = new TextDecoder();
    try {
      for (;;){
        const {done, value} = await reader.read();
        if (done) break;
        yield decoder.decode(value, {stream:true});
      }
      const rest = decoder.decode();
      if (rest) yield rest;
    } finally {
      reader.releaseLock();
    }
  }

  /* ======================= 助手对话（契约 §4 / §5） =======================
   * 纯前端：右侧「助手」页签 → POST /api/chat 读 SSE → Studio.applyOps。
   * 网络/服务不可用时只禁用对话输入，2D / 3D 编辑照常。
   * ===================================================================== */
  /* CHAT_PURE_BEGIN */
  // 安全渲染：先整体转义，再只放行粗体 / 行内代码 / 段落换行 / 列表
  function mdLite(raw){
    const inline = s => s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/`([^`\n]+)`/g, '<code>$1</code>');
    const lines = App.core.esc(String(raw ?? '')).split(/\r?\n/);
    let html = '', para = [], list = null;
    const flushP = () => { if (para.length){ html += `<p>${para.map(inline).join('<br>')}</p>`; para = []; } };
    const flushL = () => {
      if (list){ html += `<${list.t}>${list.items.map(t => `<li>${inline(t)}</li>`).join('')}</${list.t}>`; list = null; }
    };
    for (const line of lines){
      const t = line.trim();
      if (!t){ flushP(); flushL(); continue; }
      const m = t.match(/^(?:[-*•]|\d+[.)、])\s+(.*)$/);
      if (m){
        flushP();
        const type = /^\d/.test(t) ? 'ol' : 'ul';
        if (!list || list.t !== type){ flushL(); list = {t:type, items:[]}; }
        list.items.push(m[1]);
        continue;
      }
      flushL(); para.push(t);
    }
    flushP(); flushL();
    return html;
  }

  // 从 SSE 缓冲区切出完整事件；半帧留在 rest 里等下一次 decode
  function takeSSE(buf){
    const events = [];
    let m;
    while ((m = buf.match(/\r?\n\r?\n/))){
      const frame = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      const data = frame.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
      if (!data) continue;
      try { events.push(JSON.parse(data)); } catch(e){}
    }
    return {events, rest: buf};
  }

  function pointInPoly(x, y, poly){
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++){
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  /* CHAT_PURE_END */

  const CHAT_SID_KEY = 'interior-chat-sid';
  const chatSid = (() => {
    try {
      const v = localStorage.getItem(CHAT_SID_KEY);
      if (v) return v;
      const n = 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      localStorage.setItem(CHAT_SID_KEY, n);
      return n;
    } catch(e){ return 'c-' + Math.random().toString(36).slice(2, 10); }
  })();
  // 快捷 chips 只预填输入框，不直接发送
  const CHAT_CHIPS = [
    ['客厅采光怎么样？', 'How is the daylight in the living room?'],
    ['把沙发往窗边挪一点', 'Move the sofa a bit toward the window'],
    ['主卧换成橡木地板', 'Switch the master bedroom to oak flooring'],
    ['这个户型怎么布置更好？', 'How would you improve this layout?'],
  ];
  const chatState = {msgs:[], sending:false, online:null, ctrl:null, notice:null, focusT:0, attachments:[]};
  const chatEls = {};
  const MAX_CHAT_ATTACHMENTS = 6;
  const CHAT_FILE_LIMIT = 8 * 1024 * 1024;
  const CHAT_TOTAL_LIMIT = 20 * 1024 * 1024;
  const CHAT_TEXT_LIMIT = 128 * 1024;
  const CHAT_FILE_TYPES = {
    png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', webp:'image/webp', pdf:'application/pdf',
    txt:'text/plain', md:'text/markdown', json:'application/json', csv:'text/csv',
    dxf:'application/dxf', dwg:'image/vnd.dwg',
  };
  const CHAT_TEXT_TYPES = new Set(['txt', 'md', 'json', 'csv']);

  const roomAtPoint = (x, y) => (App.store.ROOMS.find(r => pointInPoly(x, y, r.poly)) || {}).id || null;

  function chatScroll(){ if (chatEls.msgs) chatEls.msgs.scrollTop = chatEls.msgs.scrollHeight; }

  function chatMeta(m, text){
    if (!m.metaEl){ m.metaEl = document.createElement('div'); m.metaEl.className = 'meta'; m.el.appendChild(m.metaEl); }
    m.meta = text; m.metaEl.textContent = text;
    chatScroll();
  }

  function chatAdd(role, text){
    const m = {role, text: String(text ?? ''), meta:'', el:null, metaEl:null};
    const el = document.createElement('div');
    el.className = 'msg ' + (role === 'me' ? 'me' : role === 'err' ? 'err' : 'bot');
    el.innerHTML = role === 'me' ? App.core.esc(m.text).replace(/\n/g, '<br>') : mdLite(m.text);
    chatEls.msgs.appendChild(el);
    m.el = el;
    chatState.msgs.push(m);
    chatScroll();
    return m;
  }

  function chatStatus(text, busy){
    chatEls.st.textContent = text || '';
    chatEls.st.classList.toggle('spin', !!busy);
  }

  function chatBusy(on){
    chatState.sending = on;
    chatEls.stop.hidden = !on;
    syncChatComposer();
  }

  function syncChatComposer(){
    if (!chatEls.attach) return;
    const {attachments, sending, online} = chatState;
    chatEls.send.disabled = sending || online !== true || (!attachments.length && !chatEls.in.value.trim());
    chatEls.attach.disabled = sending || online !== true || attachments.length >= MAX_CHAT_ATTACHMENTS;
    chatEls.chips.hidden = attachments.length > 0 || chatState.msgs.length > 0;
  }

  function chatAttachmentMarkup(attachments, removable){
    const {tr, esc} = App.core;
    return attachments.map(({name, type, preview}, index) => `<span class="chat-attachment ${preview ? 'is-image' : 'is-file'}" title="${esc(name)}">
      ${preview ? `<img src="${esc(preview)}" alt="${esc(name)}">`
        : `<span class="chat-file-type" aria-hidden="true">${esc(type.toUpperCase())}</span><span class="chat-file-name">${esc(name)}</span>`}
      ${removable ? `<button type="button" class="chat-remove" data-remove-attachment="${index}" aria-label="${esc(tr('移除附件','Remove attachment') + ' ' + name)}">×</button>` : ''}</span>`).join('');
  }

  function renderChatAttachments(){
    chatEls.refs.hidden = !chatState.attachments.length;
    chatEls.refs.innerHTML = chatAttachmentMarkup(chatState.attachments, true);
    syncChatComposer();
  }

  function chatFileDescription(file){
    const original = file.name.split(/[\\/]/).at(-1).trim();
    const suffix = /\.([a-z0-9]+)$/i.exec(original);
    const type = suffix?.[1].toLowerCase() || Object.keys(CHAT_FILE_TYPES).find(ext => CHAT_FILE_TYPES[ext] === file.type);
    if (!type || !Object.hasOwn(CHAT_FILE_TYPES, type)) return null;
    const stem = suffix ? original.slice(0, suffix.index) : original;
    const fallback = App.core.tr('粘贴的附件','Pasted attachment');
    return { name:`${(stem || fallback).slice(0,110)}.${type}`, mime:CHAT_FILE_TYPES[type], type };
  }

  function attachChatFiles(files){
    if (chatState.sending || chatState.online !== true) return;
    const {tr, toast} = App.core;
    const {attachments} = chatState;
    let total = attachments.reduce((size, entry) => size + entry.file.size, 0);
    let issue = '';
    for (const file of files){
      const details = chatFileDescription(file);
      if (!details){ issue ||= tr('支持 PNG、JPG、WebP、PDF、TXT、MD、JSON、CSV、DXF 和 DWG。', 'Choose PNG, JPG, WebP, PDF, TXT, MD, JSON, CSV, DXF or DWG.'); continue; }
      if (!file.size){ issue ||= tr('无法添加空文件。', 'Empty files cannot be attached.'); continue; }
      if (CHAT_TEXT_TYPES.has(details.type) && file.size > CHAT_TEXT_LIMIT){
        issue ||= tr('文本附件最多 128 KB。', 'Text attachments can be up to 128 KB.'); continue;
      }
      if (file.size > CHAT_FILE_LIMIT || attachments.length >= MAX_CHAT_ATTACHMENTS || total + file.size > CHAT_TOTAL_LIMIT){
        issue ||= tr('最多 6 个附件，单个 8 MB，合计 20 MB。', 'Up to 6 attachments, 8 MB each and 20 MB in total.'); continue;
      }
      const preview = details.mime.startsWith('image/') && details.type !== 'dwg'
        ? URL.createObjectURL(file.slice(0, file.size, details.mime)) : '';
      attachments.push({...details, file, preview});
      total += file.size;
    }
    renderChatAttachments();
    if (issue) toast(issue);
  }

  function chatFilesFromTransfer(transfer){
    const files = Array.from(transfer?.items || []).filter(item => item.kind === 'file')
      .map(item => item.getAsFile()).filter(Boolean);
    return files.length ? files : Array.from(transfer?.files || []);
  }

  async function encodeChatAttachment({file,name,mime}){
    const url = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error(App.core.tr(`无法读取附件 ${name}`, `Could not read the attachment ${name}`)));
      reader.readAsDataURL(file);
    });
    return {name, mime, data:url.slice(url.indexOf(',')+1)};
  }

  function resetChatDraft(){
    for (const {preview} of chatState.attachments) if (preview) URL.revokeObjectURL(preview);
    chatState.attachments.length = 0;
    chatEls.in.value = ''; chatEls.file.value = '';
    renderChatAttachments();
  }

  function resetChatHistory(){
    for (const {attachmentUrls} of chatState.msgs) for (const url of attachmentUrls || []) URL.revokeObjectURL(url);
    chatState.msgs.length = 0;
    chatEls.msgs.replaceChildren();
    resetChatDraft();
  }

  function startFurnitureCreation(){
    if (App.core.PUBLIC_ACCESS === 'guest') return;
    App.panel.drawer('panel', true);
    chatPane('chat');
  }

  function paintChatNotice(){
    const box = chatEls.off;
    if (!chatState.notice){ box.style.display = 'none'; box.textContent = ''; return; }
    box.style.display = 'block';
    box.classList.toggle('warn', chatState.notice === 'codex');
    if (chatState.notice === 'down'){
      box.textContent = App.core.PUBLIC_ACCESS === 'owner' ? publicAiOffline() :
        App.core.tr('本地服务未连接：请先在项目根运行 node server.mjs，再刷新页面。对话与效果图暂不可用，2D / 3D 编辑不受影响。',
           'Local service is not reachable: run node server.mjs in the project root, then reload. Chat stays unavailable; 2D / 3D editing keeps working.');
    } else {
      box.textContent = App.core.tr('未检测到 codex（未安装或未登录）：对话可能无法回复。请先安装并登录 codex。',
                           'codex is missing or not signed in: replies may fail. Install and sign in to codex first.');
    }
  }

  function renderChatChips(){
    if (!chatEls.chips) return;
    chatEls.chips.innerHTML = '';
    CHAT_CHIPS.forEach(([zh, en]) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn';
      b.dataset.zh = zh; b.dataset.en = en; b.textContent = App.core.tr(zh, en);
      b.onclick = () => { chatEls.in.value = App.core.tr(zh, en); syncChatComposer(); chatEls.in.focus(); };
      chatEls.chips.appendChild(b);
    });
  }

  // 语言切换时刷新动态文案（静态文案走 applyStaticLang 的 data-en）
  function chatRelang(){
    if (!chatEls.in) return;
    const {tr} = App.core;
    chatEls.send.textContent = tr('发送', 'Send');
    chatEls.stop.textContent = tr('停止', 'Stop');
    chatEls.attach.setAttribute('aria-label', tr('添加附件', 'Add attachments'));
    chatEls.attach.title = tr('添加文件，也可拖入或粘贴', 'Add files, or drag or paste them');
    chatEls.in.setAttribute('aria-label', tr('助手消息', 'Assistant message'));
    chatEls.in.title = tr('Enter 发送，Shift+Enter 换行', 'Enter to send, Shift+Enter for a new line');
    chatEls.in.placeholder = tr('描述你的需求，也可拖入或粘贴附件', 'Describe what you need, or drag or paste attachments');
    chatEls.refs.setAttribute('aria-label', tr('附件', 'Attachments'));
    chatEls.dropHint.textContent = tr('松开即可添加附件', 'Drop to add attachments');
    renderChatAttachments();
    renderChatChips();
    paintChatNotice();
  }

  function chatPane(which){
    const onChat = which === 'chat', onRender = which === 'render';
    chatEls.root.hidden = !onChat;
    App.core.$('#render').hidden = !onRender;
    App.core.$('#panel').hidden = !(which === 'props');
    App.core.$('aside.right').classList.toggle('chattab', onChat);
    document.querySelectorAll('#ptabs [data-pane]').forEach(b => b.classList.toggle('on', b.dataset.pane === which));
    if (!onChat) chatEls.compose.classList.remove('is-dropping');
    if (onChat){ chatScroll(); setTimeout(() => { try { chatEls.in.focus({preventScroll:true}); } catch(e){ chatEls.in.focus(); } }, 0); }
    else if (onRender) renderPaneShown();
  }

  function editableChatState(){
    const {renders, walk, ...editable} = App.io.studio.getState();
    return editable;
  }

  // 当前选中和视角指明关注点，整份方案提供跨房间编辑所需的索引。
  async function buildChatContext(includeSceneImage){
    const sel = App.io.studio.getSelection();
    const plan = App.io.studio.getPlan(), state = editableChatState();
    const selF = sel.kind === 'furn' ? App.store.getF(sel.id) : null;
    let roomId = sel.kind === 'room' ? sel.id : (selF ? roomAtPoint(selF.cx, selF.cy) : null);
    // 没有选中时，3D 下取视线中心所在的房间（groundAt 返回 2D 世界坐标）
    if (!roomId && App.io.studio.is3D() && App.view3d?.groundAt){
      try {
        const r = App.core.$('#stage').getBoundingClientRect();
        const g = App.view3d.groundAt(r.left + r.width/2, r.top + r.height/2);
        if (g) roomId = roomAtPoint(g.x, g.y);
      } catch(e){}
    }
    const view = {camera: null, room: roomId};
    const images = [];
    if (App.io.studio.is3D()){
      try { view.camera = App.view3d?.viewInfo?.() || null; } catch(e){}
      if (includeSceneImage){
        try {
          const url = await App.io.studio.shot({scale: 0.5, clean: true});
          const cut = typeof url === 'string' ? url.indexOf(',') : -1;
          if (cut > 0 && url.startsWith('data:')) images.push({mime:'image/png', data:url.slice(cut + 1), role:'scene'});
        } catch(e){}
      }
    }
    const context = {mode:App.io.studio.is3D() ? '3d' : '2d', selection:sel.kind ? sel : null, plan, state, view};
    return [context, images];
  }

  async function chatFurniture(raw, bubble){
    if (!Array.isArray(raw) || !raw.length) return;
    const {items, persisted} = await App.customFurniture.add(raw);
    if (!items.length) return;
    const {tr, esc} = App.core, cards = document.createElement('div');
    cards.className = 'chat-assets';
    cards.innerHTML = items.map((asset,index) => {
      const {name,w,d} = asset, pad = Math.max(w,d)*.08;
      return `<div class="chat-asset">
        <svg viewBox="${-w/2-pad} ${-d/2-pad} ${w+2*pad} ${d+2*pad}" aria-hidden="true">${App.draw2d.furnitureShape(asset)}</svg>
        <div><b>${esc(name)}</b><small>${w} × ${d} mm</small></div>
        <button type="button" class="btn" data-place-asset="${index}">${tr('放入方案','Place in design')}</button>
      </div>`;
    }).join('');
    cards.addEventListener('click', e => {
      const button = e.target.closest('[data-place-asset]');
      if (!button || chatState.sending) return;
      const placed = App.interact.placeLibraryAsset(items[Number(button.dataset.placeAsset)]);
      if (placed){
        button.textContent = tr('再放一个','Place another');
        App.core.toast(tr('已添加到当前方案。','Added to the current design.'));
      }
    });
    const status = document.createElement('div');
    status.className = 'meta';
    status.textContent = persisted ? tr('已加入家具库的「我的素材」。','Added to My assets in the furniture library.') :
      tr('浏览器存储不可用，本次仍可放入方案。','Browser storage is unavailable. These assets can still be placed now.');
    bubble.el.append(cards, status);
  }

  // focus：选中目标，3D 下飞到所在房间，1.5 秒后恢复原选中（用户自己改选则不动）
  function chatFocus(focus){
    if (!focus || typeof focus !== 'object') return;
    const prev = App.io.studio.getSelection();
    let roomId = typeof focus.room === 'string' && App.plan.roomDef(focus.room) ? focus.room : null;
    const fid = Array.isArray(focus.furn) ? focus.furn.find(id => App.store.getF(id)) : (typeof focus.furn === 'string' ? focus.furn : null);
    let sel = null;
    if (fid && App.store.getF(fid)){ const f = App.store.getF(fid); sel = {kind:'furn', id:fid}; if (!roomId) roomId = roomAtPoint(f.cx, f.cy); }
    else if (roomId) sel = {kind:'room', id:roomId};
    if (!sel) return;
    App.io.studio.select(sel);
    if (App.io.studio.is3D() && roomId) App.io.studio.flyToRoom(roomId);
    clearTimeout(chatState.focusT);
    chatState.focusT = setTimeout(() => {
      const cur = App.io.studio.getSelection();
      if (cur.kind === sel.kind && cur.id === sel.id) App.io.studio.select(prev.kind ? prev : null);
    }, 1500);
  }

  // 局部方案编辑按发送时的索引寻址。期间继续编辑则用最新方案重新生成补丁。
  function chatResult(r, bubble, context){
    const ops = Array.isArray(r.ops) ? r.ops : [];
    if (ops.length){
      if (ops.some(op => op?.op === 'editScene') &&
          (JSON.stringify(context.plan) !== JSON.stringify(App.io.studio.getPlan()) ||
           JSON.stringify(context.state) !== JSON.stringify(editableChatState()))){
        chatMeta(bubble, App.core.tr('等待回复时方案已改变，请基于当前方案重发这条指令。',
          'The design changed while the assistant was working. Send the request again for the current design.'));
        return;
      }
      const hasPlan = ops.some(o => o && o.op === 'setPlan'), hasDel = ops.some(o => o && o.op === 'deleteFurniture');
      const risky = ops.length > 3 || hasPlan || hasDel;
      if (risky && !confirm(App.core.tr(
        `助手准备执行 ${ops.length} 项改动${hasPlan ? '（含整体替换方案）' : ''}${hasDel ? '（含删除家具）' : ''}。\n应用后仍可用「撤销」回退，是否继续？`,
        `The assistant wants to apply ${ops.length} changes${hasPlan ? ' (including a full plan replacement)' : ''}${hasDel ? ' (including furniture deletion)' : ''}.\nYou can still Undo afterwards. Continue?`))){
        chatMeta(bubble, App.core.tr('已取消，方案未改动', 'Cancelled — nothing changed'));
        return;
      }
      let res;
      try { res = App.io.studio.applyOps(ops); }
      catch(e){ chatAdd('err', App.core.tr('应用改动失败：', 'Failed to apply changes: ') + (e.message || e)); return; }
      const bits = [App.core.tr(`已应用 ${res.applied} 项`, `Applied ${res.applied}`)];
      if (res.skipped) bits.push(App.core.tr(`跳过 ${res.skipped} 项`, `skipped ${res.skipped}`));
      if (res.errors && res.errors.length) bits.push(res.errors[0]);
      chatMeta(bubble, bits.join(' · '));
    }
    if (r.focus) chatFocus(r.focus);
  }

  function chatErrText(e){
    const msg = (e && e.message) || String(e);
    if (e instanceof TypeError || /fetch|network|load failed/i.test(msg)){
      if (App.core.PUBLIC_ACCESS === 'owner') return App.core.tr('无法连接公网 AI 服务，请重试。', 'Cannot reach the public AI service. Try again.');
      return App.core.tr('无法连接本地服务，请确认 node server.mjs 正在运行（对话不可用不影响编辑）。',
                'Cannot reach the local service — make sure node server.mjs is running (editing still works).');
    }
    return App.core.tr('请求失败：', 'Request failed: ') + msg;
  }

  async function chatSend(){
    if (chatState.sending || chatState.online !== true) return;
    const message = chatEls.in.value.trim();
    if (!message && !chatState.attachments.length) return;
    const files = chatState.attachments.splice(0);
    resetChatDraft();
    const sent = chatAdd('me', message);
    if (files.length){
      const sentFiles = document.createElement('div');
      sentFiles.className = 'chat-sent-attachments';
      sentFiles.innerHTML = chatAttachmentMarkup(files, false);
      sent.attachmentUrls = files.map(file => file.preview).filter(Boolean);
      sent.el.appendChild(sentFiles); chatScroll();
    }
    const ctrl = new AbortController();
    chatState.ctrl = ctrl;
    chatBusy(true);
    chatStatus(files.length ? App.core.tr('正在准备附件…', 'Preparing attachments…')
      : App.core.tr('正在准备上下文…', 'Preparing context…'), true);
    let cur = null;
    try {
      const [context, images] = await buildChatContext(Boolean(message));
      const attachments = [];
      for (const file of files){
        ctrl.signal.throwIfAborted();
        attachments.push(await encodeChatAttachment(file));
      }
      ctrl.signal.throwIfAborted();
      chatStatus(App.core.tr('正在思考…', 'Thinking…'), true);
      const chunks = aiTextChunks('chat', {
        method:'POST',
        headers:{'content-type':'application/json'},
        body: JSON.stringify({sessionId: App.projects.activeProjectId ? `${chatSid}-${App.projects.activeProjectId}` : chatSid, message, context, images, attachments}),
        signal: ctrl.signal,
      });
      let buf = '', acc = '', got = false, erred = false;
      const ensure = () => cur || (cur = chatAdd('bot', ''));
      for await (const textChunk of chunks){
        buf += textChunk;
        const step = takeSSE(buf); buf = step.rest;
        for (const ev of step.events){
          const type = ev && ev.type;
          if (type === 'status' && ev.text){ chatStatus(String(ev.text), true); }
          else if (type === 'delta' && ev.text){
            acc += ev.text; const m = ensure(); m.text = acc; m.el.innerHTML = mdLite(acc); chatScroll();
          }
          else if (type === 'result' && ev.result && typeof ev.result === 'object'){
            got = true;
            const r = ev.result;
            const reply = typeof r.reply === 'string' && r.reply.trim() ? r.reply : acc;
            const m = ensure(); m.text = reply; m.el.innerHTML = mdLite(reply);
            chatResult(r, m, context);
            await chatFurniture(r.furniture, m);
            chatScroll();
          }
          else if (type === 'error'){ erred = true; chatAdd('err', String(ev.message || App.core.tr('服务返回错误', 'The service returned an error'))); }
        }
      }
      if (!got && !erred && !ctrl.signal.aborted && !cur) chatAdd('err', App.core.tr('没有收到回复，请重试。', 'No reply received — please try again.'));
    } catch(e){
      if (e && e.name === 'AbortError'){
        if (cur) chatMeta(cur, App.core.tr('已停止生成', 'Generation stopped'));
        else chatAdd('err', App.core.tr('已停止', 'Stopped'));
      } else {
        chatAdd('err', chatErrText(e));
      }
    } finally {
      chatState.ctrl = null;
      chatBusy(false);
      chatStatus('', false);
    }
  }

  async function chatProbe(){
    if (App.core.PUBLIC_ACCESS === 'guest') return null;
    try {
      // /api/health 首次探测要跑 zsh 定位 codex、--version、login status 与模型表（各自 8–10s 上限），
      // 装了 codex 的机器冷启动常超过 5s；过早中止会把「服务在跑」误判成「未连接」并锁死输入。
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 30000);
      const res = await fetch(App.core.studioPath('/api/health'), {cache:'no-store', signal: c.signal});
      clearTimeout(t);
      if (!res.ok) return null;
      const j = await res.json();
      return j && j.ok ? j : null;
    } catch(e){ return null; }
  }

  function bindChatFileDrop(){
    let depth = 0;
    const isFileDrag = event => Array.from(event.dataTransfer?.types || []).includes('Files');
    const showDrop = () => chatEls.compose.classList.toggle('is-dropping', depth > 0 && !chatEls.attach.disabled);
    chatEls.root.addEventListener('dragenter', e => {
      if (!isFileDrag(e)) return;
      e.preventDefault(); depth++; showDrop();
    });
    chatEls.root.addEventListener('dragover', e => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = chatEls.attach.disabled ? 'none' : 'copy';
    });
    chatEls.root.addEventListener('dragleave', () => { depth = Math.max(0, depth-1); showDrop(); });
    chatEls.root.addEventListener('drop', e => {
      depth = 0; showDrop();
      if (!isFileDrag(e)) return;
      e.preventDefault();
      attachChatFiles(chatFilesFromTransfer(e.dataTransfer));
      if (!chatEls.in.disabled) chatEls.in.focus();
    });
  }

  async function chatInit(){
    chatEls.root = App.core.$('#chat'); chatEls.msgs = App.core.$('#chatMsgs'); chatEls.in = App.core.$('#chatIn');
    chatEls.send = App.core.$('#chatSend'); chatEls.stop = App.core.$('#chatStop'); chatEls.st = App.core.$('#chatSt');
    chatEls.off = App.core.$('#chatOff'); chatEls.chips = App.core.$('#chatChips');
    chatEls.compose = App.core.$('#chatCompose'); chatEls.attach = App.core.$('#chatAttach');
    chatEls.dropHint = App.core.$('#chatDropHint');
    chatEls.file = App.core.$('#chatFile'); chatEls.refs = App.core.$('#chatRefs');
    chatPane('props');
    chatRelang();
    App.core.$('#ptabs').onclick = e => { const b = e.target.closest('[data-pane]'); if (b) chatPane(b.dataset.pane); };
    chatEls.send.onclick = () => chatSend();
    chatEls.stop.onclick = () => { try { chatState.ctrl?.abort(); } catch(e){} };
    chatEls.attach.onclick = () => chatEls.file.click();
    chatEls.file.onchange = () => {
      const files = [...chatEls.file.files];
      chatEls.file.value = '';
      attachChatFiles(files);
      if (files.length && !chatEls.in.disabled) chatEls.in.focus();
    };
    chatEls.refs.onclick = e => {
      const button = e.target.closest('[data-remove-attachment]');
      if (!button || chatState.sending) return;
      const [removed] = chatState.attachments.splice(Number(button.dataset.removeAttachment),1);
      if (removed?.preview) URL.revokeObjectURL(removed.preview);
      renderChatAttachments();
      chatEls.attach.focus();
    };
    chatEls.in.oninput = syncChatComposer;
    chatEls.compose.addEventListener('paste', e => {
      const files = chatFilesFromTransfer(e.clipboardData);
      if (!files.length) return;
      if (!e.clipboardData.getData('text/plain')) e.preventDefault();
      attachChatFiles(files);
    });
    bindChatFileDrop();
    chatEls.in.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing){ e.preventDefault(); chatSend(); }
    });
    chatEls.send.disabled = true;
    chatEls.in.disabled = true;
    chatStatus(App.core.tr('正在检查本地服务…', 'Checking the local service…'), true);
    const info = await chatProbe();
    chatStatus('', false);
    if (!info){
      chatState.online = false; chatState.notice = 'down';
      chatEls.in.disabled = true; chatEls.send.disabled = true;
      syncChatComposer();
      paintChatNotice();
      return;
    }
    chatState.online = true; chatEls.in.disabled = false;
    syncChatComposer();
    if (info.codex && info.codex.found === false){ chatState.notice = 'codex'; paintChatNotice(); }
  }

  /* ======================= 效果图（契约 §5 /api/render，任务 4） =======================
   * 右侧「效果图」页签：机位（当前 / 斜视 / 俯视 / 房间四角）→ Studio.shot({scale:2, clean:true})
   * → POST /api/render 读 SSE：status 显示阶段、image 收 URL、error 显示原因、done 收尾。
   * 记录 {id,kind,roomId,camera,style,prompt,url,at} 存入 state.renders 并单独持久化。
   * 服务不可用时按钮置灰；网络失败只影响本页签，2D / 3D 编辑照常。
   * ===================================================================== */
  const R_STYLES = [
    ['现代简约', 'Modern minimal'], ['奶油风', 'Creamy'], ['侘寂', 'Wabi-sabi'], ['北欧', 'Nordic'], ['日式', 'Japanese'],
  ];
  const R_CAMS = [
    ['current', '当前视角', 'Current view'],
    ['iso', '斜视', 'Oblique'],
    ['top', '俯视', 'Top-down'],
    ['corner', '选中房间四角', 'Selected room corners'],
  ];
  const R_CORNER_NAMES = [['左上', 'top-left'], ['右上', 'top-right'], ['右下', 'bottom-right'], ['左下', 'bottom-left']];
  const R_EYE = 1500, R_LOOK = 1100;            // mm：1.5 m 眼高看向房间中心

  const renderState = {
    online: null, codex: true, probedAt: 0, busy: false, ctrl: null,
    style: '现代简约', cam: 'current', corner: 0, refURL: '', refT: 0, refRevision: 0, refCapture: null, last: null, lb: null,
  };
  const renderEls = {};
  let capturePending = false, nextCaptureAt = 0;

  const rStyleLabel = zh => { const s = R_STYLES.find(x => x[0] === zh); return s ? App.core.tr(s[0], s[1]) : String(zh || ''); };
  const rCamLabel = (key, corner, roomId) => {
    if (key === 'room'){
      return App.core.tr('房间内景', 'Room interior') + (roomId && App.plan.roomDef(roomId) ? ' · ' + App.core.nm(App.store.roomState(roomId).name) : '');
    }
    const base = R_CAMS.find(c => c[0] === key);
    let s = base ? App.core.tr(base[1], base[2]) : String(key || '');
    if (key === 'corner'){
      const c = R_CORNER_NAMES[(corner || 0) & 3];
      s += ' · ' + App.core.tr(c[0], c[1]);
      if (roomId && App.plan.roomDef(roomId)) s += ' · ' + App.core.nm(App.store.roomState(roomId).name);
    }
    return s;
  };
  // 某个房间最近一张效果图（房间面板缩略图用）
  function roomLatestRender(id){
    const list = Array.isArray(App.store.state.renders) ? App.store.state.renders : [];
    for (let i = list.length - 1; i >= 0; i--){
      const r = list[i];
      if (r && r.kind === 'room' && r.roomId === id && typeof r.url === 'string') return r;
    }
    return null;
  }
  const rRecTitle = rec => {
    if (!rec) return '';
    const c = rec.camera;
    const cam = c && typeof c === 'object' ? rCamLabel(c.key, c.corner, c.roomId) : String(c || '');
    return [rStyleLabel(rec.style), cam].filter(Boolean).join(' · ');
  };

  // 当前要拍哪个房间：选中房间 → 选中家具所在房间 → 视线中心 → 面积最大的房间
  function renderPickRoom(){
    const sel = App.io.studio.getSelection();
    if (sel && sel.kind === 'room' && App.plan.roomDef(sel.id)) return sel.id;
    const f = sel && sel.kind === 'furn' ? App.store.getF(sel.id) : null;
    if (f && roomAtPoint(f.cx, f.cy)) return roomAtPoint(f.cx, f.cy);
    if (App.io.studio.is3D() && App.view3d?.groundAt){
      try {
        const r = App.core.$('#stage').getBoundingClientRect();
        const g = App.view3d.groundAt(r.left + r.width/2, r.top + r.height/2);
        const id = g && roomAtPoint(g.x, g.y);
        if (id) return id;
      } catch(e){}
    }
    let best = null, big = -1;
    App.store.ROOMS.forEach(r => { const a = App.geom.roomArea(r); if (a > big){ big = a; best = r.id; } });
    return best;
  }

  // 房间四角：多边形 AABB 内缩一点，相机 1.5 m 高看向房间中心
  function renderCornerPose(id, i){
    const r = App.plan.roomDef(id); if (!r) return null;
    const [x0, y0, x1, y1] = App.geom.bbox(r.poly);
    const ix = Math.min(350, (x1 - x0) * .18), iy = Math.min(350, (y1 - y0) * .18);
    const xs = [x0 + ix, x1 - ix], ys = [y0 + iy, y1 - iy];
    const c = [[xs[0], ys[0]], [xs[1], ys[0]], [xs[1], ys[1]], [xs[0], ys[1]]][(i || 0) & 3];
    return {cam: [c[0], c[1], R_EYE], target: [(x0 + x1)/2, (y0 + y1)/2, R_LOOK]};
  }

  function renderCorners(){
    const box = renderEls.corners;
    if (!box) return;
    box.hidden = renderState.cam !== 'corner';
    box.innerHTML = '';
    if (box.hidden) return;
    const id = renderPickRoom();
    if (id){
      const s = document.createElement('span');
      s.className = 'muted';
      s.textContent = App.core.tr('房间：', 'Room: ') + App.core.nm(App.store.roomState(id).name);
      box.appendChild(s);
    }
    R_CORNER_NAMES.forEach(([zh, en], i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn' + (renderState.corner === i ? ' on' : '');
      b.textContent = App.core.tr(zh, en);
      b.onclick = () => { renderState.corner = i; renderCorners(); renderFly(); };
      box.appendChild(b);
    });
  }

  function renderStyles(){
    const box = renderEls.styles;
    if (!box) return;
    box.innerHTML = '';
    R_STYLES.forEach(([zh, en]) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn' + (renderState.style === zh ? ' on' : '');
      b.textContent = App.core.tr(zh, en);
      b.onclick = () => { renderState.style = zh; renderStyles(); };
      box.appendChild(b);
    });
  }

  function renderNotice(){
    const box = renderEls.off;
    if (!box) return;
    box.innerHTML = '';
    box.style.display = 'none';
    let msg = '', warn = false;
    if (renderState.online === null) return;
    if (renderState.online === false){
      msg = App.core.PUBLIC_ACCESS === 'owner' ? publicAiOffline() : App.core.tr('本地服务未连接：请先在项目根运行 node server.mjs，再刷新页面。效果图暂不可用，2D / 3D 编辑不受影响。',
               'Local service is not reachable: run node server.mjs in the project root, then reload. Renders stay unavailable; 2D / 3D editing keeps working.');
      warn = true;
    } else if (!renderState.codex){
      msg = App.core.tr('未检测到 codex（未安装或未登录）：生成很可能失败，请先安装并登录 codex。',
               'codex is missing or not signed in: generation will likely fail. Install and sign in to codex first.');
      warn = true;
    } else if (!App.io.studio.is3D()){
      msg = App.core.tr('效果图基于 3D 视角生成，请先切换到 3D 场景。', 'Renders use the 3D view — switch to the 3D scene first.');
      warn = true;
    }
    if (!msg) return;
    box.style.display = 'block';
    box.classList.toggle('warn', warn);
    box.appendChild(document.createTextNode(msg));
    if (renderState.online !== false && renderState.codex && !App.io.studio.is3D()){
      box.appendChild(document.createElement('br'));
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn'; b.style.marginTop = '5px';
      b.textContent = App.core.tr('切换到 3D', 'Switch to 3D');
      b.onclick = async () => { await App.io.setView('3d'); renderViewSync(); };
      box.appendChild(b);
    }
  }

  function renderAvailability(){
    const e = renderEls;
    if (!e.gen) return;
    const online = renderState.online === true;
    const is3 = App.io.studio.is3D();
    e.capture.disabled = !is3 || renderState.busy || capturePending;
    e.capture.title = is3 ? '' : App.core.tr('请先切换到 3D', 'Switch to 3D first');
    const why = !online ? App.core.tr('AI 服务不可用', 'AI service unavailable')
      : !is3 ? App.core.tr('需要 3D 场景', 'Needs the 3D scene') : '';
    e.gen.disabled = !!why || renderState.busy;
    e.gen.title = why;
    e.re.disabled = !online || !is3 || renderState.busy;
    e.re.title = why;
    e.dl.disabled = !renderState.last || renderState.online === false;
  }

  function renderStatus(text, spin){
    if (!renderEls.st) return;
    renderEls.st.textContent = text || '';
    renderEls.st.classList.toggle('spin', !!spin);
  }

  function renderErr(msg){
    const box = renderEls.err;
    if (!box) return;
    if (!msg){ box.style.display = 'none'; box.textContent = ''; return; }
    box.style.display = 'block';
    box.textContent = msg;
  }

  function renderSetBusy(on){
    renderState.busy = on;
    if (renderEls.stop) renderEls.stop.hidden = !on;
    if (renderEls.gen) renderEls.gen.textContent = on ? App.core.tr('生成中…', 'Generating…') : App.core.tr('生成效果图', 'Generate');
    renderAvailability();
    App.view3d?.syncBar?.();                 // 室内标题条的生成按钮跟着置灰
  }

  function renderRefShow(url, capture = null){
    const img = renderEls.ref, wrap = renderEls.refWrap;
    if (!img) return;
    renderState.refRevision++;
    renderState.refURL = url;
    renderState.refCapture = capture;
    wrap.classList.remove('bad');
    renderEls.refRetry.hidden = true;
    img.onerror = () => { wrap.classList.add('bad'); renderEls.refRetry.hidden = false; };
    img.src = url;
  }

  function currentRenderReference(){
    const capture = renderState.refCapture;
    return capture && capture.url === renderState.refURL && capture.projectId === App.projects.activeProjectId ? capture : null;
  }

  function resetRenderReference(){
    clearTimeout(renderState.refT);
    renderState.refT = 0;
    renderState.refRevision++;
    if (renderState.lb?.url === renderState.refURL) closeLightbox();
    renderState.refURL = '';
    renderState.refCapture = null;
    if (!renderEls.ref) return;
    renderEls.ref.onerror = null;
    renderEls.ref.removeAttribute('src');
    renderEls.refWrap.classList.remove('bad');
    renderEls.refRetry.hidden = true;
  }

  function renderOutShow(url, bust){
    const img = renderEls.out, wrap = renderEls.outWrap;
    if (!img) return;
    wrap.classList.remove('bad');
    renderEls.outRetry.hidden = true;
    img.onerror = () => { wrap.classList.add('bad'); renderEls.outRetry.hidden = false; };
    // 重试：同源 URL 加时间戳绕过缓存里失败的结果
    const asset = App.core.renderAssetUrl(url);
    img.src = bust && /^https?:|^\//.test(asset) ? asset + (asset.includes('?') ? '&' : '?') + 'r=' + Date.now() : asset;
  }

  function renderShowRec(rec, open){
    renderState.last = rec;
    renderOutShow(rec.url);
    renderEls.actions.hidden = false;
    renderEls.outCap.textContent = rRecTitle(rec) || App.core.tr('效果图', 'Render');
    renderHistory();
    renderAvailability();
    if (open) openLightbox(rec.url, rRecTitle(rec), rec);
  }

  function renderHistory(){
    const box = renderEls.hist;
    if (!box) return;
    const list = Array.isArray(App.store.state.renders) ? App.store.state.renders : [];
    box.innerHTML = '';
    renderEls.empty.hidden = list.length > 0;
    renderEls.histN.textContent = list.length ? String(list.length) : '';
    [...list].reverse().forEach(rec => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'ritem';
      b.title = [rRecTitle(rec), rec.at ? String(rec.at).slice(0, 16).replace('T', ' ') : ''].filter(Boolean).join(' · ');
      const im = document.createElement('img');
      im.alt = b.title; im.loading = 'lazy';
      im.onerror = () => { im.remove(); b.title = App.core.tr('加载失败，点击重试', 'Failed to load — click to retry'); };
      im.src = App.core.renderAssetUrl(rec.url);
      const cap = document.createElement('span');
      cap.textContent = rStyleLabel(rec.style);
      b.append(im, cap);
      b.onclick = () => renderShowRec(rec, true);
      box.appendChild(b);
    });
  }

  // 语言切换：重建动态文案与选项，保留当前选择
  function renderRelang(){
    if (!renderEls.root) return;
    const camVal = renderEls.cam.value || renderState.cam;
    renderEls.cam.innerHTML = '';
    R_CAMS.forEach(([v, zh, en]) => renderEls.cam.add(new Option(App.core.tr(zh, en), v)));
    renderEls.cam.value = camVal;
    renderState.cam = camVal;
    renderStyles(); renderCorners();
    renderEls.note.placeholder = App.core.tr('补充描述，例如「傍晚暖光，加一块地毯」', 'Extra notes, e.g. "warm evening light, add a rug"');
    renderEls.gen.textContent = renderState.busy ? App.core.tr('生成中…', 'Generating…') : App.core.tr('生成效果图', 'Generate');
    renderEls.stop.textContent = App.core.tr('停止', 'Stop');
    renderEls.dl.textContent = App.core.tr('下载', 'Download');
    renderEls.re.textContent = App.core.tr('重新生成', 'Regenerate');
    renderEls.refCap.textContent = App.core.tr('参考截图', 'Reference');
    renderEls.outCap.textContent = renderState.last ? (rRecTitle(renderState.last) || App.core.tr('效果图', 'Render')) : App.core.tr('效果图', 'Render');
    renderEls.refRetry.textContent = App.core.tr('加载失败 · 重试', 'Failed · Retry');
    renderEls.outRetry.textContent = App.core.tr('加载失败 · 重试', 'Failed · Retry');
    renderEls.empty.textContent = App.core.tr('还没有效果图', 'No renders yet');
    renderEls.lbDl.textContent = App.core.tr('下载', 'Download');
    renderEls.lbClose.textContent = App.core.tr('关闭', 'Close');
    renderNotice(); renderAvailability(); renderHistory();
  }

  async function renderProbe(){
    const info = await chatProbe();
    renderState.online = !!info;
    renderState.codex = !!(info && info.codex && info.codex.found !== false);
    renderState.probedAt = Date.now();
    renderNotice(); renderAvailability();
  }

  function renderPaneShown(){
    renderRelang();
    renderViewSync();
    if (renderState.online !== true || !renderState.codex || Date.now() - renderState.probedAt > 30000) renderProbe();
  }

  // 2D / 3D 切换、语言切换后同步提示与按钮状态
  function renderViewSync(){
    if (!renderEls.gen) return;
    renderNotice(); renderAvailability();
    if (App.io.studio.is3D()) renderRefreshRef();
  }

  async function renderWaitFly(){
    for (let i = 0; i < 50; i++){
      if (!App.view3d?.flying?.()) return;
      await new Promise(r => setTimeout(r, 60));
    }
  }

  async function renderShot(){
    const url = await App.io.studio.shot({scale: 2, clean: true});
    return typeof url === 'string' && url.startsWith('data:image/png;base64,') && url.length > 100 ? url : null;
  }

  async function renderCaptureCurrent({openPanel = false} = {}){
    const now = performance.now();
    if (!App.io.studio.is3D() || !renderEls.ref || App.core.PUBLIC_ACCESS === 'guest' ||
        renderState.busy || capturePending || now < nextCaptureAt) return false;
    capturePending = true;
    nextCaptureAt = now + 400;
    clearTimeout(renderState.refT);
    renderState.refT = 0;
    const revision = ++renderState.refRevision;
    const projectId = App.projects.activeProjectId;
    try {
      renderAvailability();
      const scene = renderScene({key:'current', roomId:null}, 'angle');
      const shot = await renderShot();
      if (revision !== renderState.refRevision || projectId !== App.projects.activeProjectId) return false;
      if (!shot) throw new Error('Empty reference capture');
      renderState.cam = 'current';
      renderEls.cam.value = 'current';
      renderCorners();
      renderRefShow(shot, {url:shot, scene, projectId});
      if (openPanel){
        if (document.pointerLockElement) document.exitPointerLock?.();
        App.panel.drawer('panel', true);
        chatPane('render');
      }
      App.core.toast(App.core.tr('已将当前画面设为效果图参考。', 'Current view set as the render reference.'));
      return true;
    } catch {
      if (revision === renderState.refRevision && projectId === App.projects.activeProjectId){
        App.core.toast(App.core.tr('截图失败，请重试', 'Screenshot failed. Try again.'));
      }
      return false;
    } finally {
      capturePending = false;
      renderAvailability();
    }
  }

  function captureWalkReference(){
    if (!App.view3d?.walking?.()) return Promise.resolve(false);
    return renderCaptureCurrent({openPanel:true});
  }

  let renderRefPending = null;
  async function renderRefreshRef(){
    const revision = renderState.refRevision;
    if (!App.io.studio.is3D() || currentRenderReference() || capturePending || renderRefPending === revision) return;
    renderRefPending = revision;
    try {
      await renderWaitFly();
      await new Promise(r => setTimeout(r, 80));    // 让镜头动效最后一帧落地
      if (!App.io.studio.is3D() || revision !== renderState.refRevision) return;
      const url = await App.io.studio.shot({scale: 1, clean: true});
      if (url && revision === renderState.refRevision) renderRefShow(url);
    } catch(e){}
    finally { if (renderRefPending === revision) renderRefPending = null; }
  }

  // 机位切换复用 3D 的 flyTo / camTween；房间四角用 AABB 计算
  function renderFly(){
    resetRenderReference();
    if (!App.io.studio.is3D() || !App.view3d) return;
    const V = App.view3d;
    // 室内视角下切到别的预设机位：先退出室内（不动画），否则旧房间的裁切盒会把画面切空
    if (V.roomViewing?.()) V.exitRoom({silent: true});
    try {
      if (renderState.cam === 'iso') V.flyIso?.();
      else if (renderState.cam === 'top') V.flyTop?.();
      else if (renderState.cam === 'corner'){
        const id = renderPickRoom();
        if (!id){ App.core.toast(App.core.tr('请先在平面图上选择一个房间', 'Select a room on the plan first')); return; }
        const p = renderCornerPose(id, renderState.corner);
        if (p) V.flyToWorld?.(p.target[0], p.target[1], p.target[2], p.cam[0], p.cam[1], p.cam[2]);
      }
    } catch(e){}
    renderState.refT = setTimeout(renderRefreshRef, 1100);
  }

  function renderAddRecord(rec){
    App.store.state.renders = Array.isArray(App.store.state.renders) ? App.store.state.renders : [];
    App.store.state.renders.push(rec);
    if (App.store.state.renders.length > 30) App.store.state.renders.splice(0, App.store.state.renders.length - 30);
    App.store.save();
    renderHistory();
  }

  function renderScene(cam, kind){
    const state = App.io.studio.getState(), plan = App.io.studio.getPlan();
    const room = cam.roomId && App.plan.roomDef(cam.roomId);
    return {
      plan,
      furniture:state.furniture,
      materials:plan.materials,
      roomMaterials:Object.fromEntries(Object.entries(state.rooms).map(([id, v]) => [id, v.mat])),
      camera:{
        view:App.view3d?.viewInfo?.() || null,
        preset:cam.key,
        kind,
        roomId:cam.roomId,
        room:room ? {name:App.store.roomState(cam.roomId).name, poly:App.core.deepCopy(room.poly)} : null,
      },
    };
  }

  // opts.kind==='room' + opts.roomId：从室内标题条生成，机位 = 当前进房位姿（任务 5）
  async function renderGenerate(opts = {}){
    if (renderState.busy || capturePending || renderState.online === false) return null;
    if (!App.io.studio.is3D()){ renderViewSync(); return null; }
    if (!App.view3d){ App.core.toast(App.core.tr('3D 引擎尚未就绪', 'The 3D engine is not ready yet')); return null; }
    const note = renderEls.note.value.trim();
    const style = renderState.style;
    const asRoom = opts.kind === 'room' && !!App.plan.roomDef(opts.roomId);
    const kind = asRoom ? 'room' : 'angle';
    const roomId = asRoom ? opts.roomId : (renderState.cam === 'corner' ? renderPickRoom() : null);
    const cam = asRoom
      ? {key: 'room', corner: null, roomId}
      : {key: renderState.cam, corner: renderState.cam === 'corner' ? renderState.corner : null, roomId: roomId || null};
    const reference = currentRenderReference();
    const pinned = !asRoom && cam.key === 'current' ? reference : null;
    const ctrl = new AbortController();
    renderState.ctrl = ctrl;
    renderErr('');
    renderSetBusy(true);
    if (!pinned) renderStatus(App.core.tr('正在截图…', 'Capturing the view…'), true);
    let gotUrl = '', lastRec = null;
    try {
      if (!pinned) await renderWaitFly();
      const shot = pinned?.url ?? await renderShot();
      if (!shot) throw new Error(App.core.tr('截图失败（3D 画面为空）', 'Screenshot failed (empty 3D frame)'));
      if (!reference) renderRefShow(shot);
      const scene = pinned?.scene ?? renderScene(cam, kind);
      const cut = shot.indexOf(',');
      renderStatus(App.core.tr('已提交，正在生成，可能需要 1–3 分钟…', 'Submitted — generating, this can take 1–3 minutes…'), true);
      const chunks = aiTextChunks('render', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          kind, roomId: cam.roomId, mime: 'image/png',
          image: cut > 0 ? shot.slice(cut + 1) : shot,
          scene, style, note: note || undefined,
        }),
        signal: ctrl.signal,
      });
      let buf = '', err = '';
      for await (const textChunk of chunks){
        if (renderState.online !== true){ renderState.online = true; renderNotice(); renderAvailability(); }
        buf += textChunk;
        const step = takeSSE(buf); buf = step.rest;
        for (const ev of step.events){
          const type = ev && ev.type;
          if (type === 'status' && ev.text) renderStatus(String(ev.text), true);
          else if (type === 'error'){
            err = String(ev.message || App.core.tr('服务返回错误', 'The service returned an error'));
            renderErr(err);
          } else if (type === 'image' && typeof ev.url === 'string'){
            gotUrl = ev.url;
            const rec = {
              id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
              kind,
              roomId: cam.roomId || null,
              camera: {key: cam.key, corner: cam.corner, roomId: cam.roomId, label: rCamLabel(cam.key, cam.corner, cam.roomId)},
              style,
              prompt: typeof ev.prompt === 'string' && ev.prompt ? ev.prompt : `[${style}] ${kind}`,
              url: ev.url,
              at: new Date().toISOString(),
              note: note || '',
            };
            lastRec = rec;
            renderAddRecord(rec);
            renderShowRec(rec, false);
            // 房间面板正在显示这个房间时，刷新最近一张缩略图
            if (rec.kind === 'room' && App.store.ui.sel?.kind === 'room' && App.store.ui.sel.id === rec.roomId) App.panel.renderPanel();
            renderStatus(App.core.tr('已生成', 'Done'), false);
          }
        }
      }
      if (ctrl.signal.aborted){ if (!gotUrl) renderStatus(App.core.tr('已取消', 'Cancelled'), false); return lastRec; }
      if (!gotUrl){
        if (!err) renderErr(App.core.tr('没有收到图片，请重试或在补充描述里写得更具体。', 'No image was returned — try again or add more detail.'));
        renderStatus(App.core.tr('生成失败', 'Failed'), false);
      }
    } catch(e){
      if (e && e.name === 'AbortError'){
        if (!gotUrl) renderStatus(App.core.tr('已取消', 'Cancelled'), false);
      } else {
        const msg = (e && e.message) || String(e);
        const net = e instanceof TypeError || /fetch|network|load failed/i.test(msg);
        const offline = App.core.PUBLIC_ACCESS === 'owner'
          ? App.core.tr('无法连接公网 AI 服务，请重试。', 'Cannot reach the public AI service. Try again.')
          : App.core.tr('无法连接本地服务，请确认 node server.mjs 正在运行。', 'Cannot reach the local service — make sure node server.mjs is running.');
        renderErr(net ? offline : msg);
        renderStatus(App.core.tr('生成失败', 'Failed'), false);
        if (net){ renderState.online = false; renderNotice(); }
      }
    } finally {
      renderState.ctrl = null;
      renderSetBusy(false);
    }
    return lastRec;
  }

  async function renderDownload(url, id){
    const name = `render-${String(id || Date.now().toString(36)).replace(/[^\w-]+/g, '')}.png`;
    if (String(url).startsWith('data:')){ App.io.download(name, App.io.dataURLBlob(url)); return; }
    const asset = App.core.renderAssetUrl(url);
    try {
      const r = await fetch(asset, {cache: 'no-store'});
      if (!r.ok) throw new Error('HTTP ' + r.status);
      App.io.download(name, await r.blob());
    } catch(e){
      window.open(asset, '_blank', 'noopener');      // 退路：新窗口打开
    }
  }

  function openLightbox(url, title, rec){
    renderState.lb = {url, rec};
    renderEls.lbImg.onerror = () => { renderEls.lbCap.textContent = App.core.tr('图片加载失败，可关闭后重试', 'Image failed to load — close and retry'); };
    renderEls.lbImg.src = App.core.renderAssetUrl(url);
    renderEls.lbCap.textContent = title || '';
    renderEls.lb.classList.add('on');
    renderEls.lb.setAttribute('aria-hidden', 'false');
  }
  function closeLightbox(){
    renderState.lb = null;
    renderEls.lb.classList.remove('on');
    renderEls.lb.setAttribute('aria-hidden', 'true');
    renderEls.lbImg.removeAttribute('src');
  }

  function renderInit(){
    const id = s => App.core.$(s);
    Object.assign(renderEls, {
      root: id('#render'), cam: id('#rCam'), corners: id('#rCorners'), styles: id('#rStyles'),
      capture: id('#rCapture'),
      note: id('#rNote'), st: id('#rSt'), gen: id('#rGen'), stop: id('#rStop'),
      off: id('#renderOff'), err: id('#renderErr'),
      ref: id('#rRef'), refWrap: id('#rRefWrap'), refRetry: id('#rRefRetry'), refCap: id('#rRefCap'),
      out: id('#rOut'), outWrap: id('#rOutWrap'), outRetry: id('#rOutRetry'), outCap: id('#rOutCap'),
      actions: id('#rActions'), dl: id('#rDl'), re: id('#rRe'),
      hist: id('#rHist'), histN: id('#rHistN'), empty: id('#rEmpty'),
      lb: id('#lightbox'), lbImg: id('#lbImg'), lbCap: id('#lbCap'), lbDl: id('#lbDl'), lbClose: id('#lbClose'),
    });
    renderEls.cam.onchange = () => {
      renderState.cam = renderEls.cam.value;
      renderCorners(); renderFly(); renderAvailability();
    };
    renderEls.capture.onclick = () => renderCaptureCurrent();
    renderEls.gen.onclick = () => renderGenerate();
    renderEls.re.onclick = () => renderGenerate();
    renderEls.stop.onclick = () => { try { renderState.ctrl?.abort(); } catch(e){} };
    renderEls.dl.onclick = () => { if (renderState.last) renderDownload(renderState.last.url, renderState.last.id); };
    renderEls.ref.onclick = () => { if (renderState.refURL) openLightbox(renderState.refURL, App.core.tr('参考截图', 'Reference'), null); };
    renderEls.out.onclick = () => { if (renderState.last) openLightbox(renderState.last.url, rRecTitle(renderState.last), renderState.last); };
    renderEls.refRetry.onclick = () => { resetRenderReference(); renderRefreshRef(); };
    renderEls.outRetry.onclick = () => { if (renderState.last) renderOutShow(renderState.last.url, true); };
    renderEls.lbClose.onclick = closeLightbox;
    renderEls.lbDl.onclick = () => {
      const lb = renderState.lb;
      if (lb && lb.url) renderDownload(lb.url, lb.rec ? lb.rec.id : 'reference');
    };
    renderEls.lb.onclick = e => { if (e.target === renderEls.lb) closeLightbox(); };
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && renderEls.lb.classList.contains('on')) closeLightbox(); });
    renderRelang();
    const last = (App.store.state.renders || []).at(-1);
    if (last) renderShowRec(last, false);          // 刷新后恢复最近一张
    renderProbe();
  }

  Object.assign(App.assistant, {
    aiResponseMessage, publicAiOffline, pointInPoly, chatState, chatEls, chatRelang, chatPane, resetChatHistory, startFurnitureCreation,
    chatInit, renderState, renderEls, roomLatestRender, rRecTitle, renderAvailability, renderStatus,
    renderErr, renderShowRec, renderHistory, renderRelang, renderViewSync, openLightbox, renderInit,
    renderGenerate, captureWalkReference, resetRenderReference,
  });
})();
