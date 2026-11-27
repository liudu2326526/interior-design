import { readFile } from 'node:fs/promises';
import '../js/ceiling-model.js';

const model = globalThis.CeilingModel;
const promptURL = new URL('../prompts/drawing-ceiling.md', import.meta.url);
const objectGroups = ['zones', 'edges', 'fixtures'];
const roomProperties = ['baseHeight', 'finish', 'color'];
const structureFields = ['bounds', 'rooms', 'walls', 'wins', 'doors', 'slides'];
const roofless = room => room.outdoor || room.bay;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const cleanText = value => typeof value === 'string' ? value.trim().slice(0, 800) : '';
const hasRoomDesign = design => Boolean(design && (roomProperties.some(key => design[key] !== undefined) ||
  objectGroups.some(group => design[group].length)));

function warnings(...lists) {
  const entries = lists.flatMap(list => Array.isArray(list) ? list.slice(0, 24).map(cleanText).filter(Boolean) : []);
  return [...new Set(entries)].slice(0, 24);
}

function coveredRooms(raw, plan) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const entries = [];
  for (const entry of raw.slice(0, plan.rooms.length)) {
    const room = plan.rooms.find(candidate => candidate.id === entry?.roomId);
    const evidence = cleanText(entry?.evidence);
    if (!room?.outdoor || room.bay || !evidence || seen.has(room.id)) continue;
    seen.add(room.id);
    entries.push({roomId: room.id, evidence});
  }
  return entries;
}

/** The editor's strict validation also checks fixture footprints and same-height overlaps. */
export function validateDrawingCeiling(plan, raw, { coveredOutdoorRooms, requireRoomDesign = false } = {}) {
  if (raw == null) return null;
  const ceiling = model.validate(raw, plan.rooms);
  const outdoor = new Set(coveredRooms(coveredOutdoorRooms, plan).map(({roomId}) => roomId));
  const fixtureIds = new Set();
  const empty = { ...ceiling, rooms: {} };
  for (const room of plan.rooms) {
    const design = Object.hasOwn(ceiling.rooms, room.id) ? ceiling.rooms[room.id] : null;
    if (requireRoomDesign && !roofless(room) && !hasRoomDesign(design)) {
      throw new Error(`「${room.name}」缺少天花方案。若保留原顶，请写明保留方案。`);
    }
    if (!design) continue;
    if (room.bay || (room.outdoor && (!outdoor.has(room.id) || !design.zones.length))) {
      throw new Error(`「${room.name}」没有可确认的顶面，不能写入天花设计。`);
    }
    try {
      model.apply(empty, room, design, {checkGeometry: true});
    } catch (error) {
      throw new Error(`「${room.name}」天花校验失败：${error.message}`, {cause: error});
    }
    for (const fixture of design.fixtures) {
      if (fixtureIds.has(fixture.id)) throw new Error(`顶装设备编号重复：${fixture.id}`);
      fixtureIds.add(fixture.id);
    }
  }
  return ceiling;
}

function proposedCeiling(plan, reply, { baseHeight, ...validation } = {}) {
  if (!isRecord(reply?.rooms)) throw new Error('天花结果缺少房间对象。');
  const ceiling = validateDrawingCeiling(plan, {
    version: 1, baseHeight: reply.baseHeight ?? baseHeight, rooms: reply.rooms,
  }, validation);
  if (!Object.values(ceiling.rooms).some(hasRoomDesign) && reply.baseHeight == null) {
    throw new Error('天花结果没有可编辑的设计内容。');
  }
  return ceiling;
}

function unavailable(reason, message, reply) {
  return {
    ceiling: null,
    ceilingMeta: {
      source: 'unavailable', estimated: false, reason,
      warnings: warnings([message], reply?.warnings),
      ...(cleanText(reply?.alignment) && {alignment: cleanText(reply.alignment)}),
    },
  };
}

async function runStage(run, stage, input) {
  const prompt = await readFile(promptURL, 'utf8');
  const reply = await run({stage, prompt, input: {stage, ...input}});
  if (!isRecord(reply)) throw new Error('天花识别、设计或复核没有返回有效对象。');
  return reply;
}

/** Read drawing evidence first. Generate only after confirming the supplied drawings lack ceiling design. */
export async function buildDrawingCeiling({
  plan, furniture = [], ceiling, note = '', hasExplicitCeiling = false, inputs = {}, run,
}) {
  if (ceiling != null && !hasExplicitCeiling) {
    const coveredOutdoorRooms = coveredRooms(Object.entries(ceiling.rooms ?? {}).flatMap(([roomId, room]) =>
      Array.isArray(room?.zones) && room.zones.length ? [{roomId, evidence: '项目文件已有绘制的顶面。'}] : []), plan);
    return {
      ceiling: validateDrawingCeiling(plan, ceiling, {coveredOutdoorRooms}),
      ceilingMeta: {source: 'project', estimated: false, warnings: [], coveredOutdoorRooms},
    };
  }

  const context = {plan, furniture, note, hasExplicitCeiling, inputs};
  const recognition = await runStage(run, 'recognize', context);
  if (recognition.status === 'uncertain') {
    return unavailable('uncertain', '部分原图无法确认，暂无法判定是否含天花设计。', recognition);
  }
  if (recognition.status === 'unaligned' || (recognition.status === 'absent' && hasExplicitCeiling)) {
    return unavailable('unaligned', '已提供或发现天花资料，暂未识别出可对齐的设计。请核对图纸和对应房间。', recognition);
  }
  if (recognition.status === 'found') {
    const alignment = cleanText(recognition.alignment);
    if (!alignment) throw new Error('识别结果未说明天花图与户型的对齐依据。');
    const coveredOutdoorRooms = coveredRooms(recognition.coveredOutdoorRooms, plan);
    const ceiling = proposedCeiling(plan, recognition, {coveredOutdoorRooms});
    const usesDefaultHeight = recognition.baseHeight == null && Object.values(ceiling.rooms)
      .some(room => room.baseHeight === undefined);
    return {
      ceiling,
      ceilingMeta: {
        source: 'drawing', alignment, estimated: recognition.estimated === true || usesDefaultHeight,
        warnings: warnings(usesDefaultHeight ? [`未标原顶净高的房间暂按 ${ceiling.baseHeight} mm，需现场核对。`] : [],
          recognition.warnings), coveredOutdoorRooms,
      },
    };
  }
  if (recognition.status !== 'absent') throw new Error('无法确认图纸是否包含天花设计。');
  if (Object.keys(recognition.rooms ?? {}).length) throw new Error('天花存在性结论与识别出的房间数据冲突。');
  const sourceChecks = Array.isArray(recognition.sourceChecks) ? recognition.sourceChecks : [];
  const unchecked = inputs.sources?.some(source => source.incomplete === true &&
    !sourceChecks.some(check => check?.name === source.name && cleanText(check?.evidence)));
  if (unchecked) {
    return unavailable('uncertain', '仅有部分图纸预览，尚未核实未预览页或布局。', recognition);
  }
  if (!plan.rooms.some(room => !roofless(room))) {
    return unavailable('no-indoor', '图纸未见天花设计，也没有需要补做天花的室内房间。', recognition);
  }

  let generated = await runStage(run, 'generate', context);
  let draft;
  const validation = {requireRoomDesign: true};
  try {
    draft = proposedCeiling(plan, generated, validation);
  } catch (error) {
    generated = await runStage(run, 'generate', {...context, previousDraft: generated, validationError: error.message});
    draft = proposedCeiling(plan, generated, validation);
  }
  return {
    ceiling: draft,
    ceilingMeta: {
      source: 'generated', estimated: true,
      warnings: warnings(['AI 根据户型拟定方案。原顶净高、设备条件及吊顶尺寸需现场核对。'], recognition.warnings, generated.warnings),
    },
  };
}

function reviewResult(ceiling, meta, reviewState, summary, extraWarnings) {
  return {
    ceiling,
    ceilingMeta: {
      ...meta, reviewState, reviewSummary: cleanText(summary),
      warnings: warnings(extraWarnings, meta?.warnings),
    },
  };
}

function objectKeys(rooms) {
  return Object.entries(rooms).flatMap(([roomId, design]) => objectGroups.flatMap(group =>
    (design?.[group] ?? []).map(({id}) => JSON.stringify([roomId, group, id]))));
}

function validateRemovals(previous, revised, raw) {
  if (raw !== undefined && (!Array.isArray(raw) || raw.length > 400)) throw new Error('天花复核的删除清单无效。');
  const preserved = new Set(objectKeys(revised.rooms));
  const removed = new Set(objectKeys(previous.rooms).filter(key => !preserved.has(key)));
  for (const entry of raw ?? []) {
    const key = JSON.stringify([entry?.roomId, entry?.group, entry?.id]);
    if (!cleanText(entry?.reason) || !removed.delete(key)) throw new Error('天花复核包含无依据或冲突的删除。');
  }
  if (removed.size) throw new Error('天花复核不能省略已有对象，请为每个移除对象说明依据。');
}

function preserveRoomProperties(rooms, previous, plan) {
  const result = {...rooms};
  for (const {id} of plan.rooms) {
    const prior = previous.rooms[id];
    if (!prior || !Object.hasOwn(previous.rooms, id)) continue;
    const values = Object.fromEntries(roomProperties.filter(key => prior[key] !== undefined).map(key => [key, prior[key]]));
    if (!Object.keys(values).length) continue;
    if (Object.hasOwn(result, id) && !isRecord(result[id])) throw new Error('天花复核房间格式无效。');
    result[id] = {...values, ...result[id]};
    for (const key of Object.keys(values)) {
      if (result[id][key] == null) throw new Error('天花复核不能清除已记录的净高或饰面。');
    }
  }
  return result;
}

/** Independently review the ceiling against the current (possibly structurally corrected) plan. */
export async function reviewDrawingCeiling({
  plan, previousPlan = plan, furniture = [], ceiling, ceilingMeta,
  note = '', hasExplicitCeiling = false, inputs = {}, run, retryUnavailable = false,
}) {
  const context = {plan, furniture, note, inputs, hasExplicitCeiling};
  let recovered = false;
  if (ceiling == null) {
    const noIndoor = !plan.rooms.some(room => !roofless(room));
    const structuralChange = structureFields.some(key => JSON.stringify(plan[key]) !== JSON.stringify(previousPlan?.[key]));
    const realignment = structuralChange && (hasExplicitCeiling || ceilingMeta?.reason === 'unaligned');
    const retry = (retryUnavailable || realignment || (structuralChange && ceilingMeta?.reason === 'no-indoor')) &&
      !(noIndoor && ceilingMeta?.reason === 'no-indoor');
    if (retry) {
      ({ceiling, ceilingMeta} = await buildDrawingCeiling({
        ...context, run, hasExplicitCeiling: hasExplicitCeiling || ceilingMeta?.reason === 'unaligned',
      }));
      recovered = ceiling !== null;
    }
    if (ceiling == null) {
      if (ceilingMeta?.reason === 'no-indoor') {
        return reviewResult(null, ceilingMeta, 'match', '没有需要补做天花的室内房间，无需复核。');
      }
      return reviewResult(null, ceilingMeta ?? unavailable('unavailable', '天花识别结果暂不可用。').ceilingMeta,
        'unavailable', '没有可复核的天花结果。');
    }
  }

  const priorMeta = ceilingMeta ?? {source: 'project', estimated: false};
  const reply = await runStage(run, 'review', {...context, previousPlan, ceiling, ceilingMeta: priorMeta});
  const meta = reply.estimated === true ? {...priorMeta, estimated: true} : priorMeta;
  const options = {coveredOutdoorRooms: meta.coveredOutdoorRooms, requireRoomDesign: meta.source === 'generated'};
  const verdict = reply.verdict;
  if (!['match', 'differ', 'unavailable'].includes(verdict)) throw new Error('天花复核缺少有效结论。');
  const summary = cleanText(reply.summary);
  if (verdict !== 'match' && !summary) throw new Error('天花复核未说明差异或无法复核的原因。');

  if (reply.rooms == null) {
    const valid = validateDrawingCeiling(plan, ceiling, options);
    if (recovered && verdict === 'match') {
      return reviewResult(valid, meta, 'differ', summary || '已补齐并复核天花方案。', reply.warnings);
    }
    return reviewResult(valid, meta, verdict, summary, reply.warnings);
  }
  if (verdict !== 'differ' || !isRecord(reply.rooms)) throw new Error('天花复核结果与修正内容不一致。');

  const coverage = coveredRooms([
    ...(meta.coveredOutdoorRooms ?? []),
    ...(meta.source === 'drawing' && Array.isArray(reply.coveredOutdoorRooms) ? reply.coveredOutdoorRooms : []),
  ], plan);
  const revised = proposedCeiling(plan, {...reply, rooms: preserveRoomProperties(reply.rooms, ceiling, plan)}, {
    ...options, baseHeight: ceiling.baseHeight, coveredOutdoorRooms: coverage,
  });
  validateRemovals(ceiling, revised, reply.removals);
  return reviewResult(revised, {...meta, coveredOutdoorRooms: coverage}, 'differ', summary, reply.warnings);
}
