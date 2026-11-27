/* 方案切换、管理和双栏对比。场景写入由 App.projects 处理。 */
(() => {
  'use strict';

  const {tr, $, toast} = App.core;
  const bar = $('#schemeBar');
  const picker = $('#schemeSelect');
  const newButton = $('#schemeNew');
  const compareButton = $('#schemeCompare');
  const menu = $('#schemeMore');
  const renameButton = $('#schemeRename');
  const deleteButton = $('#schemeDelete');
  const editDialog = $('#schemeEditDialog');
  const form = $('#schemeEditForm');
  const sources = $('#schemeSourceChoices');
  const nameField = $('#schemeName');
  const confirm = $('#schemeConfirm');
  const formError = $('#schemeFormError');
  const compareDialog = $('#schemeCompareDialog');
  const compareOut = $('#schemeCompareOut');
  const compareIn = $('#schemeCompareIn');
  const compareFit = $('#schemeCompareFit');
  const sides = ['A', 'B'].map(side => ({
    select: $('#schemeCompare' + side),
    svg: $('#schemeComparePlan' + side),
    stats: $('#schemeCompareStats' + side),
  }));
  let action = null;
  let comparison = null;
  let drag = null;
  let pending = false;

  function fillPicker(select, schemes, value, excluded){
    const current = [...select.options];
    if (current.length !== schemes.length || schemes.some((scheme, index) =>
      scheme.id !== current[index].value || scheme.name !== current[index].text || current[index].disabled !== (scheme.id === excluded))){
      select.replaceChildren(...schemes.map(scheme => {
        const option = new Option(scheme.name, scheme.id);
        option.disabled = scheme.id === excluded;
        return option;
      }));
    }
    if (select.value !== value) select.value = value;
  }

  function render(){
    const project = App.projects.getActiveProject?.();
    bar.hidden = !project?.schemes?.length;
    if (bar.hidden) return;
    fillPicker(picker, project.schemes, App.projects.activeSchemeId);
    picker.setAttribute('aria-label', tr('当前方案', 'Current scheme'));
    picker.disabled = newButton.disabled = renameButton.disabled = pending;
    compareButton.disabled = deleteButton.disabled = pending || project.schemes.length < 2;
  }

  async function run(operation){
    if (pending) return false;
    pending = true;
    render();
    try { return await operation(); }
    finally { pending = false; render(); }
  }

  picker.addEventListener('change', () => {
    const id = picker.value;
    void run(() => App.projects.switchScheme(id)).catch(() => {
      toast(tr('无法打开方案，请重试。', 'Could not open the scheme. Try again.'));
    });
  });

  function suggestedCopyName(project, current){
    const existing = new Set(project.schemes.map(item => item.name));
    const stem = [...current.name].slice(0, 46).join('');
    const base = stem + tr(' 副本', ' copy');
    if (!existing.has(base)) return base;
    let index = 2;
    while (existing.has(base + ' ' + index)) index++;
    return base + ' ' + index;
  }

  function openEdit(mode, trigger){
    const project = App.projects.getActiveProject();
    const scheme = project?.schemes.find(item => item.id === App.projects.activeSchemeId);
    if (!scheme || pending || (mode === 'delete' && project.schemes.length < 2)) return;
    menu.open = false;
    const create = mode === 'new';
    const remove = mode === 'delete';
    action = {
      mode, id:scheme.id, sceneKey:App.projects.activeSceneKey, trigger,
      baselineName:App.projects.defaultSchemeName(), copyName:suggestedCopyName(project, scheme),
    };
    $('#schemeEditTitle').textContent = create ? tr('新建方案', 'New scheme')
      : remove ? tr('删除方案', 'Delete scheme') : tr('重命名方案', 'Rename scheme');
    const isRecognition = project.baselineSource === 'recognized';
    $('#schemeBaselineLabel').textContent = isRecognition
      ? tr('从识别底稿新建', 'Create from recognition baseline') : tr('从项目底稿新建', 'Create from project baseline');
    $('#schemeBaselineHint').textContent = isRecognition
      ? tr('沿用确认的户型和识别家具。', 'Start with the confirmed plan and recognized furniture.')
      : project.baselineSource === 'saved'
        ? tr('沿用项目保存的底稿。', 'Start with the saved project baseline.')
        : tr('沿用项目的初始户型。', 'Start with the initial plan.');
    $('#schemeCopyHint').textContent = tr('沿用「' + scheme.name + '」的当前设计。', 'Start with the current design in “' + scheme.name + '”.');
    $('#schemeDeleteNote').textContent = tr('确认删除「' + scheme.name + '」？', 'Delete “' + scheme.name + '”?');
    $('#schemeDeleteNote').hidden = !remove;
    sources.hidden = !create;
    form.elements.schemeSource.value = 'baseline';
    $('#schemeNameField').hidden = remove;
    nameField.required = !remove;
    nameField.value = create ? action.baselineName : scheme.name;
    formError.textContent = '';
    confirm.classList.toggle('danger', remove);
    confirm.textContent = create ? tr('创建并打开', 'Create and open') : remove ? tr('删除方案', 'Delete scheme') : tr('保存名称', 'Save name');
    editDialog.showModal();
    if (remove) $('#schemeCancel').focus();
    else if (create) form.elements.schemeSource[0].focus();
    else { nameField.focus(); nameField.select(); }
  }

  newButton.onclick = () => openEdit('new', newButton);
  renameButton.onclick = () => openEdit('rename', menu.querySelector('summary'));
  deleteButton.onclick = () => openEdit('delete', menu.querySelector('summary'));
  for (const id of ['#schemeCancel', '#schemeEditClose']) $(id).onclick = () => editDialog.close();
  editDialog.addEventListener('cancel', event => { if (pending) event.preventDefault(); });
  editDialog.addEventListener('close', () => {
    const trigger = action?.trigger;
    action = null;
    trigger?.focus({preventScroll:true});
  });
  form.addEventListener('change', event => {
    if (action?.mode !== 'new' || event.target.name !== 'schemeSource') return;
    if (!nameField.value.trim() || [action.baselineName, action.copyName].includes(nameField.value)){
      nameField.value = event.target.value === 'current' ? action.copyName : action.baselineName;
    }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!action || pending) return;
    const {mode, id, sceneKey} = action;
    if (sceneKey !== App.projects.activeSceneKey){
      formError.textContent = tr('当前方案已切换，请重新打开。', 'The active scheme changed. Open the dialog again.');
      return;
    }
    const name = nameField.value.trim();
    const project = App.projects.getActiveProject();
    if (mode !== 'delete'){
      if (!name){
        formError.textContent = tr('请输入方案名称。', 'Enter a scheme name.');
        nameField.focus();
        return;
      }
      if (project.schemes.some(item => item.name === name && (mode === 'new' || item.id !== id))){
        formError.textContent = tr('同一项目内已有同名方案。', 'A scheme with that name already exists in this project.');
        nameField.focus();
        return;
      }
    }
    const closeButtons = [confirm, $('#schemeCancel'), $('#schemeEditClose')];
    closeButtons.forEach(button => { button.disabled = true; });
    formError.textContent = '';
    let ok = false;
    try {
      ok = await run(() => {
        if (mode === 'new') return App.projects.createScheme({from:form.elements.schemeSource.value, name, expectedSceneKey:sceneKey});
        if (mode === 'rename') return App.projects.renameScheme(id, name);
        return App.projects.deleteScheme(id);
      });
    } catch (error){
      console.error(error);
    } finally {
      closeButtons.forEach(button => { button.disabled = false; });
    }
    if (ok) editDialog.close();
    else formError.textContent = tr('方案操作未保存，请重试。', 'The scheme action was not saved. Try again.');
  });
  nameField.addEventListener('input', () => { formError.textContent = ''; });

  function visibleDifferences(left, right){
    const keys = snapshot => {
      const {plan} = snapshot;
      const state = snapshot.state || {};
      const items = Array.isArray(state.furniture) ? state.furniture : [];
      const furniture = items.filter(item => item && !App.ceilingFurniture.is(item))
        .map(({id, ...item}) => item);
      const demolished = Array.isArray(state.demolished) ? [...new Set(state.demolished)].sort() : [];
      return [
        [plan.walls, demolished],
        [plan.wins, plan.doors, plan.slides],
        [plan.rooms, plan.materials, state.rooms || {}],
        furniture,
      ];
    };
    const labels = [
      tr('墙体与拆改', 'Walls and removals'),
      tr('门窗', 'Doors and windows'),
      tr('房间与地面', 'Rooms and flooring'),
      tr('家具布置', 'Furniture layout'),
    ];
    const a = keys(left), b = keys(right);
    const changed = labels.filter((_, index) => JSON.stringify(a[index]) !== JSON.stringify(b[index]));
    return changed.length
      ? tr('差异 · ', 'Differences · ') + changed.join(App.core.LANG === 'en' ? ', ' : '、')
      : tr('两套方案的平面布置相同', 'Both schemes have the same floor layout');
  }

  function renderComparison(){
    const {schemes, ids} = comparison;
    const selected = ids.map(id => schemes.find(item => item.id === id));
    comparison.bounds = App.schemesCompare.bounds(selected.map(item => item.snapshot));
    comparison.zoom = 1;
    comparison.center = {
      x:comparison.bounds.x + comparison.bounds.w / 2,
      y:comparison.bounds.y + comparison.bounds.h / 2,
    };
    sides.forEach(({select, svg, stats}, index) => {
      const {name, snapshot} = selected[index];
      fillPicker(select, schemes, ids[index], ids[1 - index]);
      select.setAttribute('aria-label', tr('方案 ' + (index ? 'B' : 'A'), 'Scheme ' + (index ? 'B' : 'A')));
      svg.setAttribute('aria-label', tr(name + '平面图', name + ' floor plan'));
      App.schemesCompare.render(svg, snapshot, comparison.bounds);
      const rooms = snapshot.plan.rooms.filter(room => room.counted !== false).length;
      const items = snapshot.state?.furniture;
      const furniture = Array.isArray(items) ? items.filter(item => item && !App.ceilingFurniture.is(item)).length : 0;
      const walls = snapshot.state?.demolished;
      const demolished = Array.isArray(walls) ? walls.length : 0;
      stats.textContent = tr('房间 ' + rooms + ' · 家具 ' + furniture + ' · 已拆墙 ' + demolished,
        'Rooms ' + rooms + ' · Furniture ' + furniture + ' · Removed walls ' + demolished);
    });
    $('#schemeCompareDifferences').textContent = visibleDifferences(selected[0].snapshot, selected[1].snapshot);
    updateViewport();
  }

  function updateViewport(){
    const {bounds, zoom, center} = comparison;
    const w = bounds.w / zoom;
    const h = bounds.h / zoom;
    const viewBox = [center.x - w / 2, center.y - h / 2, w, h].join(' ');
    for (const {svg} of sides){
      svg.setAttribute('viewBox', viewBox);
      svg.classList.toggle('zoomed', zoom > 1);
    }
    compareFit.textContent = Math.round(zoom * 100) + '%';
    compareOut.disabled = zoom <= .6;
    compareIn.disabled = zoom >= 5;
  }

  function setZoom(zoom){
    comparison.zoom = Math.max(.6, Math.min(5, zoom));
    updateViewport();
  }

  compareButton.onclick = async () => {
    try {
      const key = App.projects.activeSceneKey;
      const project = await run(() => App.projects.flushActiveProject());
      if (key !== App.projects.activeSceneKey) return;
      if (!project){
        toast(tr('无法保存当前方案，请重试后再对比。', 'Could not save the current scheme. Try again before comparing.'));
        return;
      }
      if (project.schemes.length < 2) return;
      const index = project.schemes.findIndex(item => item.id === App.projects.activeSchemeId);
      if (index < 0) return;
      const schemes = project.schemes.slice();
      comparison = {schemes, ids:[schemes[index].id, schemes[(index + 1) % schemes.length].id]};
      renderComparison();
      compareDialog.showModal();
      sides[0].select.focus();
    } catch (error){
      comparison = null;
      console.error(error);
      toast(tr('无法打开方案对比，请重试。', 'Could not open the comparison. Try again.'));
    }
  };
  $('#schemeCompareClose').onclick = () => compareDialog.close();
  compareDialog.addEventListener('close', () => {
    comparison = null;
    drag?.svg.classList.remove('panning');
    drag = null;
    compareButton.focus({preventScroll:true});
  });
  compareOut.onclick = () => setZoom(comparison.zoom / 1.25);
  compareIn.onclick = () => setZoom(comparison.zoom * 1.25);
  compareFit.onclick = () => {
    const {x, y, w, h} = comparison.bounds;
    comparison.center = {x:x + w / 2, y:y + h / 2};
    setZoom(1);
  };
  sides.forEach(({select, svg}, index) => {
    select.addEventListener('change', () => {
      comparison.ids[index] = select.value;
      renderComparison();
    });
    svg.addEventListener('wheel', event => {
      if (!comparison || (!event.ctrlKey && matchMedia('(max-width:600px)').matches)) return;
      event.preventDefault();
      setZoom(comparison.zoom * (event.deltaY > 0 ? .8 : 1.25));
    }, {passive:false});
    svg.addEventListener('pointerdown', event => {
      if (!comparison || drag || !event.isPrimary || event.button !== 0) return;
      if (event.pointerType === 'touch' && !svg.classList.contains('zoomed') && matchMedia('(max-width:600px)').matches) return;
      const matrix = svg.getScreenCTM();
      if (!matrix?.a || !matrix.d) return;
      drag = {
        svg, id:event.pointerId, clientX:event.clientX, clientY:event.clientY,
        scaleX:matrix.a, scaleY:matrix.d, x:comparison.center.x, y:comparison.center.y,
      };
      svg.setPointerCapture(event.pointerId);
      svg.classList.add('panning');
    });
    svg.addEventListener('pointermove', event => {
      if (drag?.svg !== svg || drag.id !== event.pointerId || !comparison) return;
      comparison.center = {
        x:drag.x - (event.clientX - drag.clientX) / drag.scaleX,
        y:drag.y - (event.clientY - drag.clientY) / drag.scaleY,
      };
      updateViewport();
    });
    svg.addEventListener('lostpointercapture', () => {
      if (drag?.svg !== svg) return;
      drag = null;
      svg.classList.remove('panning');
    });
    svg.addEventListener('dblclick', () => compareFit.click());
  });

  document.addEventListener('pointerdown', event => {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
  menu.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !menu.open) return;
    event.preventDefault();
    event.stopPropagation();
    menu.open = false;
    menu.querySelector('summary').focus();
  });
  App.schemesUI = {render};
  render();
})();
