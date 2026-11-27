/* 首次使用引导。
 * 依赖 App.core、App.assistant。
 */
(() => {
  'use strict';
  const App = globalThis.App;

  /* ======================= 首次使用引导 ======================= */
  // 高亮 + 分步卡片。首次访问自动弹出；之后从「文件 → 使用引导」重看。
  // 关闭（跳过 / 走完 / Esc）后记到 localStorage，iframe 内（自测）不自动弹。
  const TOUR_KEY = 'interior-tour-v1';
  const tourEls = {
    wrap: App.core.$('#tour'), hole: App.core.$('#tourHole'), card: App.core.$('#tourCard'),
    title: App.core.$('#tourTitle'), body: App.core.$('#tourBody'), dots: App.core.$('#tourDots'),
    skip: App.core.$('#tourSkip'), prev: App.core.$('#tourPrev'), next: App.core.$('#tourNext'), hint: App.core.$('#tourHint'),
  };
  const app = App.core.$('.app');
  const compact = () => matchMedia('(max-width:760px)').matches;
  const panelTarget = (target) => () => App.core.narrow() || app.classList.contains('hide-panel') ? '#tgPanel' : target;
  let tourSteps = [], tourIdx = 0, tourOn = false, tourEntered = -1, previousFocus;

  function tourDefs(){
    const guest = App.core.PUBLIC_ACCESS === 'guest';
    return [
      { title: App.core.tr('欢迎使用户型装修设计', 'Welcome to the floor plan studio'),
        body: guest ? App.core.tr('左边挑家具，中间摆布局，右边调整房间和家具属性。\n花一分钟熟悉一下界面。',
                         'Pick furniture on the left, arrange it in the middle, and edit properties on the right.\nOne minute to get oriented.')
          : App.core.tr('左边挑家具，中间摆布局，右边改属性或让助手直接改方案。\n花一分钟熟悉一下界面。',
               'Pick furniture on the left, arrange it in the middle, and edit or ask the assistant on the right.\nOne minute to get oriented.') },
      { sel: () => App.core.narrow() || app.classList.contains('hide-lib') ? '#tgLib' : '#lib',
        title: App.core.tr('① 家具库', '1. Furniture library'),
        body: App.core.tr('点顶部「家具库」展开，从中点选家具添加，也可以拖到平面图。选中家具后可移动、调整大小或旋转。',
                 'Use Library at the top to show furniture. Tap an item to add it or drag it onto the plan. Select an item to move, resize, or rotate it.') },
      { sel: '#viewSeg', title: App.core.tr('② 2D / 3D 随时切换', '2. Switch 2D / 3D anytime'),
        body: App.core.tr('按 T 或点这里切换。3D 里可以鸟瞰、漫游，也能直接拖动家具；\n左侧列表点房间可以飞过去，点「进入」看室内。',
                 'Press T or click here. In 3D you can orbit, walk and drag furniture;\nclick a room on the left to fly there, or step inside.') },
      ...(guest ? [
        { sel: panelTarget('#ptabs'),
          title: App.core.tr('③ 属性', '3. Properties'),
          body: App.core.tr('点顶部「属性」打开面板，可修改房间名称或地面材质，查看面积与材料费用。',
                   'Use Properties at the top to change room names or flooring and review areas and material costs.') },
        { sel: () => compact() ? '#toolbarMore' : '.menu', title: App.core.tr('④ 打开或保存项目', '4. Open or save a project'),
          body: App.core.tr('用「文件」导入设计、打开 125-C 新示例项目，或导出自己的项目。窄屏时「文件」位于「更多」。',
                   'Use File to import a design, open the 125-C sample as a new project, or export your project. On narrow screens, find File under More.') },
      ] : [
        { sel: panelTarget('#ptabs'), title: App.core.tr('③ 属性面板', '3. Properties panel'),
          body: App.core.tr('点顶部「属性」打开面板。这里可以修改房间和家具属性，也可以切换到「助手」和「效果图」。',
                   'Use Properties at the top to open the panel. Edit room and furniture properties or switch to Assistant and Renders.') },
        { sel: '#projectToggle', title: App.core.tr('④ 导入图纸、切换项目', '4. Import drawings and switch projects'),
          body: App.core.tr('从「项目」上传户型图、PDF 或 CAD 导出。上传后可以继续编辑，识别完成后在项目列表里预览并打开新方案。',
                   'Upload a drawing, PDF or CAD export from Projects. Keep editing while recognition runs, then preview and open the new plan from the list.') },
        { sel: panelTarget('#chat'), title: App.core.tr('⑤ 第二步：对话修改', '5. Step two: change it by talking'),
          body: App.core.tr('切到「助手」，直接说要改哪里：\n「把客厅沙发放到窗边」「主卧衣柜加宽到 2.4 米」「厨房换成 600 地砖」。\n助手返回改动预览，确认后才应用，一次 Ctrl+Z 可整体撤销。在 3D 里提问会自动带上当前视角。',
                   'Open the Assistant tab and say what to change:\n“move the sofa to the window”, “widen the wardrobe to 2.4 m”, “use 600 tiles in the kitchen”.\nYou preview the change before it is applied, and one Ctrl+Z undoes the whole batch. In 3D your current view is attached automatically.'),
          enter(){ try { App.assistant.chatPane('chat'); } catch(e) {} },
          leave(){ try { App.assistant.chatPane('props'); } catch(e) {} } },
        { sel: panelTarget('#render'), title: App.core.tr('⑥ 生成效果图', '6. Generate a render'),
          body: App.core.tr('在 3D 里挑机位和风格，把当前视角交给助手生成照片级效果图；\n也可以进入某个房间，单独生成这个房间的室内效果图。',
                   'In 3D pick a camera and style, and turn the current view into a photoreal render;\nor step into a room and generate that room on its own.'),
          enter(){ try { App.assistant.chatPane('render'); } catch(e) {} },
          leave(){ try { App.assistant.chatPane('props'); } catch(e) {} } },
      ]),
      { sel: '#stage', title: guest ? App.core.tr('⑤ 平面图操作', '5. Working the plan') : App.core.tr('⑦ 平面图操作', '7. Working the plan'),
        body: App.core.tr('拖动平移，滚轮或双指缩放，F 适应窗口。\nV 选择、M 测量、X 拆改墙体；Delete 删除，Ctrl+Z 撤销。',
                 'Drag to pan, wheel or pinch to zoom, F to fit.\nV select, M measure, X demolish; Delete removes, Ctrl+Z undoes.') },
    ];
  }

  // 目标元素的屏幕矩形；元素不存在或不可见时返回 null（卡片改为居中）
  function tourTarget(sel){
    if (!sel) return null;
    const el = document.querySelector(sel);
    if (!el) return null;
    const box = el.tagName === 'DETAILS' ? el.querySelector('summary') : el;
    if (!box || box.offsetParent === null) return null;
    const r = box.getBoundingClientRect();
    return r.width > 4 && r.height > 4 ? r : null;
  }

  function tourPlace(step){
    const pad = 8, gap = 14, vw = innerWidth, vh = innerHeight;
    const r = tourTarget(typeof step.sel === 'function' ? step.sel() : step.sel);
    if (!r){
      tourEls.hole.hidden = true;
      const w = Math.min(400, vw - 24);
      tourEls.card.style.width = w + 'px';
      tourEls.card.style.left = Math.round((vw - w) / 2) + 'px';
      tourEls.card.style.top = Math.round(Math.max(20, vh / 2 - 170)) + 'px';
      return;
    }
    tourEls.hole.hidden = false;
    tourEls.hole.style.left = (r.left - pad) + 'px';
    tourEls.hole.style.top = (r.top - pad) + 'px';
    tourEls.hole.style.width = (r.width + pad * 2) + 'px';
    tourEls.hole.style.height = (r.height + pad * 2) + 'px';
    const cw = Math.min(360, vw - 24);
    tourEls.card.style.width = cw + 'px';
    const left = Math.min(Math.max(12, r.left + r.width / 2 - cw / 2), vw - cw - 12);
    let top = r.bottom + gap;
    if (top + 240 > vh) top = Math.max(12, r.top - gap - 240);
    tourEls.card.style.left = Math.round(left) + 'px';
    tourEls.card.style.top = Math.round(top) + 'px';
  }

  function tourRender(){
    const s = tourSteps[tourIdx];
    // 换到新一步时先收起上一步的副作用（关菜单、切回属性页签），再执行本步的；
    // 面板切换后尺寸会变，稍后再量一次位置。
    if (tourEntered !== tourIdx){
      const prev = tourSteps[tourEntered];
      if (prev && typeof prev.leave === 'function') { try { prev.leave(); } catch(e) {} }
      if (typeof s.enter === 'function') { try { s.enter(); } catch(e) {} }
      tourEntered = tourIdx;
      setTimeout(() => { if (tourOn) tourPlace(tourSteps[tourIdx]); }, 60);
    }
    tourEls.title.textContent = s.title;
    tourEls.body.textContent = s.body;
    tourEls.dots.innerHTML = tourSteps.map((_, i) => `<i class="${i === tourIdx ? 'on' : ''}"></i>`).join('');
    tourEls.prev.style.visibility = tourIdx ? 'visible' : 'hidden';
    if (!tourIdx && document.activeElement === tourEls.prev) tourEls.next.focus();
    tourEls.next.textContent = tourIdx === tourSteps.length - 1 ? App.core.tr('开始使用', 'Get started') : App.core.tr('下一步', 'Next');
    tourEls.prev.textContent = App.core.tr('上一步', 'Back');
    tourEls.skip.textContent = App.core.tr('跳过', 'Skip');
    tourEls.hint.textContent = App.core.tr('← → 切换 · Esc 退出', '← → to move · Esc to exit');
    tourPlace(s);
  }

  function tourKey(e){
    if (e.key === 'Tab'){
      const buttons = tourIdx ? [tourEls.skip, tourEls.prev, tourEls.next] : [tourEls.skip, tourEls.next];
      const index = buttons.indexOf(document.activeElement);
      const start = index < 0 ? (e.shiftKey ? 0 : -1) : index;
      const next = (start + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
      e.preventDefault();
      buttons[next].focus();
    }
    else if (e.key === 'Escape'){ e.preventDefault(); e.stopPropagation(); tourEnd(); }
    else if (e.key === 'ArrowRight'){ e.preventDefault(); e.stopPropagation(); tourGo(1); }
    else if (e.key === 'ArrowLeft'){ e.preventDefault(); e.stopPropagation(); tourGo(-1); }
  }
  function tourOnResize(){ if (tourOn) tourPlace(tourSteps[tourIdx]); }

  // 读屏 / 手机：卡片一起滑入，不做额外动画，避免和 2D/3D 过渡抢帧
  function tourStart(){
    previousFocus = document.activeElement;
    App.core.setToolbarOptions(false);
    tourSteps = tourDefs(); tourIdx = 0; tourEntered = -1; tourOn = true;
    app.inert = true;
    tourEls.wrap.classList.add('on');
    tourRender();
    tourEls.next.focus({preventScroll:true});
    document.addEventListener('keydown', tourKey, true);
    addEventListener('resize', tourOnResize);
  }
  function tourEnd(mark = true){
    if (!tourOn) return;
    const cur = tourSteps[tourEntered];
    if (cur && typeof cur.leave === 'function') { try { cur.leave(); } catch(e) {} }
    tourEntered = -1;
    tourOn = false;
    if (mark) try { localStorage.setItem(TOUR_KEY, '1'); } catch(e) {}
    tourEls.wrap.classList.remove('on');
    app.inert = false;
    const fallback = compact() ? '#toolbarMore' : previousFocus?.closest('.menu') ? '.menu summary' : '#viewSeg .btn';
    const returnTarget = previousFocus?.getClientRects().length && previousFocus !== document.body
      ? previousFocus : App.core.$(fallback);
    returnTarget?.focus({preventScroll:true});
    document.removeEventListener('keydown', tourKey, true);
    removeEventListener('resize', tourOnResize);
  }
  function tourGo(d){
    const next = tourIdx + d;
    if (next < 0) return;
    if (next >= tourSteps.length) return tourEnd();
    tourIdx = next; tourRender();
  }
  function tourRelang(){ if (tourOn){ tourSteps = tourDefs(); tourRender(); } }

  tourEls.next.onclick = () => tourGo(1);
  tourEls.prev.onclick = () => tourGo(-1);
  tourEls.skip.onclick = () => tourEnd();
  App.core.$('#tourStart').onclick = () => { if (!tourOn) tourStart(); };

  // 首次访问：等默认方案与家具库渲染完再弹；iframe 内（自测）不自动弹
  try {
    if (localStorage.getItem(TOUR_KEY) !== '1' && window.top === window.self){
      setTimeout(() => {
        if (!document.documentElement.dataset.studioInteracted &&
            !tourOn && !App.core.$('#lightbox')?.classList.contains('on')) tourStart();
      }, 1100);
    }
  } catch(e) {}

  Object.assign(App.tour, {
    tourRelang,
  });
})();
