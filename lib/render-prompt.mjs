/** Translate the render guide's rules and style table into the provider prompt. */
export function buildRenderPrompt(guide, { style, note, kind, scene }) {
  const section = (heading) => guide.split(`## ${heading}`)[1]?.split('\n## ')[0]?.trim();
  const rules = section('硬性要求（优先级最高）');
  const styleTable = section('风格维度（由 `风格` 字段决定）');
  const negatives = section('负面提示词（生成时避开）');
  if (!rules || !styleTable || !negatives) throw new Error('效果图提示词模板缺少规则或风格定义。');

  const columns = styleTable.split('\n').filter(line => line.startsWith('|'))
    .map(line => line.split('|').slice(1, -1).map(value => value.trim()));
  const selectedStyle = style || '现代简约';
  const values = columns.slice(2).find(row => row[0] === selectedStyle);
  const styleText = values
    ? columns[0].slice(1).map((label, i) => `${label}：${values[i + 1] ?? ''}`).join('\n')
    : '根据指定风格调整环境光、软装点缀和已选材质的质感。';
  const roomName = scene?.camera?.roomName ?? scene?.camera?.room?.name;
  const view = kind === 'room' ? `室内视角${typeof roomName === 'string' ? ` · ${roomName.slice(0, 100)}` : ''}` : '当前视角';
  return [
    note ? `用户补充描述（优先于风格；保留下述几何与机位约束）：\n${note}` : '',
    `根据所附 3D 截图生成一张照片级室内效果图。视角：${view}。`,
    rules,
    `风格：${selectedStyle}\n${styleText}`,
    negatives,
  ].filter(Boolean).join('\n\n');
}
