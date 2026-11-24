# 接口契约（所有子任务共同遵守）

项目根：`/Users/macbook/Documents/trae_projects/interior-design-studio`
派生自 `../interior-design/floorplan-3d/index.html`（2674 行，原生 JS 单文件，Three.js r160 走 CDN）。
不引入构建工具、框架、TypeScript。Node 25，`package.json` 为 `"type":"module"`。

## 运行

```bash
node server.mjs        # 127.0.0.1:4173（PORT 可覆盖），静态服务 + /api + /files
```

页面在 `file://` 下也要能打开（降级：对话/效果图不可用），`fetch` 失败时用内置空方案。

## 目录

```
index.html          页面 + 2D/3D 引擎（保持单文件）
server.mjs          HTTP/SSE 桥接、静态服务、文件落盘
lib/codex/*         从 baocut 移植的精简 codex app-server 客户端
data/empty-plan.json  默认空户型（已存在）
prompts/patch.md    对话改方案的提示词与输出契约
prompts/render.md   效果图生成提示词
prompts/plan-import.md  图纸解析提示词
docs/contract.md    本文件
projects/           运行期产出（renders、导入文件、项目 JSON）
workdir/            codex 临时工作目录（图纸解析）
```

## 1. 方案 Plan

```ts
type Plan = {
  version: 1,
  name: string,
  bounds: { x, y, w, h },                 // mm，2D 世界范围
  walls: [x0, y0, x1, y1, kind, height?][], // 轴对齐矩形（已含厚度），kind: 'e'外墙 | 'b'承重 | 'n'非承重 | 'low'矮墙
  wins:  [x0, y0, x1, y1][],
  doors: { name, rect:[x0,y0,x1,y1], h:[x,y], c:[dx,dy], o:[dx,dy], len, entry? }[],
  slides:{ rect:[x0,y0,x1,y1], v:boolean }[],
  rooms: { id, name, poly:[[x,y],...], mat, at?:[x,y], counted?:boolean }[],
  materials: Record<string, { name, price, sw }>
}
```

- 单位 mm，2D 的 y 轴向下；3D 用现有 `wx()/wz()` 转换。
- 墙体可单独指定 `height`（mm）。省略时，矮墙默认 1000 mm，其他墙默认 2800 mm。剖切视图按显示高度裁切。
- `at` 是房间标签位置；`counted:false` 表示不计面积（飘窗）。
- 现有 `index.html` 里的 `WALLS/WINS/DOORS/SLIDES/ROOMS/MATS` 是这套结构的来源，运行时统一由 `PLAN` 驱动。
- 125-C 户型作为“示例方案”保留为 `data/125c-plan.json`（由任务 1 生成），默认加载 `data/empty-plan.json`。

## 2. 会话状态 State

沿用现有结构并扩展：

```ts
type State = {
  furniture: { id, type, name, cx, cy, w, d, rot, color }[],
  rooms: Record<roomId, { name, mat }>,
  demolished: string[],        // 'w'+index
  measures: any[],
  renders?: RenderRecord[]
}
```

localStorage 键：方案 `interior-plan-v1`，状态 `interior-state-v1`（新键，避免读旧站数据）。

## 3. 页面运行时 API（`window.Studio`）

由任务 1 实现，后续任务只调用：

```js
window.Studio = {
  getPlan(),                 // 深拷贝
  getState(),                // 深拷贝
  applyPlan(plan, opts),     // 校验 + 替换 PLAN，重建 2D/3D，入撤销栈
  applyOps(ops),             // 见下；整体作为一个撤销步骤；返回 { applied, skipped, errors }
  getSelection(),            // { kind:'furn'|'room'|'wall'|null, id }
  select(sel),               // 与现有 select() 一致
  flyToRoom(id),
  renderAll(),               // 2D 重绘 + 3D sync
  sync(),                    // 仅 3D
  toast(msg),
  is3D(),                    // 当前是否 3D 模式
  shot(opts)                 // 返回 dataURL；opts: { scale=1, clean=false } clean 隐藏标签/测量/选中框
                             // 实现恒为 async（Promise<dataURL|null>），调用方 await；2D 快照超大面积会自动降倍率
}
```

`applyOps` 在 2D 坐标里操作；`dx/dy` 与家具坐标同向（mm）。

## 4. 对话补丁协议

codex 的最终回答必须是**一个 JSON 对象**（允许包在 ```json 围栏里）：

```json
{
  "reply": "已把沙发左移 20cm，并换成橡木地板。",
  "ops": [
    { "op": "moveFurniture", "id": "f12", "dx": -200, "dy": 0 },
    { "op": "rotateFurniture", "id": "f12", "rot": 90 },
    { "op": "resizeFurniture", "id": "f13", "w": 1600, "d": 500 },
    { "op": "addFurniture", "type": "wardrobe", "name": "衣柜", "cx": 4200, "cy": 300, "w": 2000, "d": 600, "rot": 0, "color": "#efe6d8" },
    { "op": "deleteFurniture", "id": "f14" },
    { "op": "setRoom", "room": "living", "name": "客厅", "mat": "wood" },
    { "op": "demolishWall", "id": "w17" },
    { "op": "restoreWall", "id": "w17" },
    { "op": "setPlan", "plan": { ...完整 Plan... } }
  ],
  "focus": { "room": "living", "furn": ["f12"] }
}
```

局部和联动编辑用一条 `editScene`。例如把一段现有矮墙升为全高：

```json
{"reply":"已改为全高实墙。","ops":[{"op":"editScene","changes":[{"action":"replace","path":["plan","walls",12,4],"value":"n"}]}]}
```

- `action` 是 `add`、`replace` 或 `remove`。新增和替换带 `value`，路径里的数字代表从零起算的数组索引，末尾的 `"-"` 表示追加。
- `plan` 支持名称、范围、墙体、门窗、推拉门、房间和材质。 `state` 支持家具和构件（含 `parts`）、房间覆盖、拆墙记录和测量线。
- 同一条 `editScene` 的变更按顺序对临时副本执行，整体校验后写入并可一次撤销。对话等待期间若方案又被编辑，此前生成的索引补丁会被拦截。

规则：
- `ops` 为空数组表示纯问答，不做改动。
- 位置参数是绝对 mm；`rot` 为绝对角度（0/90/180/270 为主）。
- 不确定时先问，不猜；一次只给与用户意图相关的 ops。
- `focus` 用于高亮/飞行，可省略。

## 5. HTTP API

全部只监听 127.0.0.1。

### `GET /api/health`

```json
{ "ok": true,
  "codex": { "found": true, "version": "0.159.0", "path": "/opt/homebrew/bin/codex",
             "account": { "email": "..." } | null, "models": ["..."] },
  "projectRoot": "/.../interior-design-studio" }
```

### `POST /api/chat` → `text/event-stream`

请求：

```json
{ "sessionId": "optional-stable-id",
  "message": "把客厅沙发移到窗边",
  "context": { "mode": "2d"|"3d", "selection": {...}|null,
               "plan": { ... 当前完整 Plan ... }, "state": { ... 完整场景状态，不含效果图 ... },
               "view": { "camera": {...}|null, "room": "living"|null } },
  "images": [ { "mime": "image/png", "data": "<base64，不含 data: 前缀>" } ] }
```

SSE 事件（`data: <json>\n\n`）：

```
{"type":"status","text":"..."}      // 可多次，显示进度
{"type":"delta","text":"..."}       // 可多次，正文增量（可选实现）
{"type":"result","result":{"reply":"...","ops":[...],"focus":{...}}}
{"type":"error","message":"..."}
{"type":"done"}
```

服务端负责：拼上下文 + prompts/patch.md → 常驻 codex 会话 → 从最终 agent 消息解析 JSON；解析失败时 `{reply: 原文, ops: []}`。

### `POST /api/render` → `text/event-stream`

```json
{ "kind": "angle"|"room",
  "roomId": "living"|null,
  "image": "<base64 PNG，当前 3D 视角截图>",
  "scene": { "plan": {...}, "furniture": [...], "materials": {...}, "camera": {...} },
  "style": "现代简约" | "奶油风" | "侘寂" | "北欧" | "日式" | 自定义字符串,
  "note": "可选补充描述" }
```

事件：`status`（多次）、`{"type":"image","url":"/files/renders/xxx.png","prompt":"..."}`、`error`、`done`。
服务端保存图片到 `projects/renders/<uuid>.png`。

### `POST /api/plan/import` → JSON

```json
{ "files": [ { "name": "plan.pdf", "mime": "application/pdf", "data": "<base64>" } ],
  "note": "可选" }
```

服务端将资料写入 `workdir/import-<uuid>/`，由 codex 识别图纸图片、PDF、CAD 导出或 JSON。纯 PNG、JPEG 或 WebP 请求将原图直接附给模型，并从模型回复读取 JSON。需要从工作目录读取资料时，模型将 JSON 写入 `plan.json`。两种输出都将 `furniture` 与结构字段并列，服务端校验后返回户型和家具。

```ts
type ImportedFurniture = {
  type: string                 // 家具库类型或 component
  name: string
  cx: number
  cy: number
  w: number
  d: number
  rot: number
  color?: string
  parts?: ComponentPart[]     // type === "component" 时至少有一个部件
}

type ComponentPart = {
  shape: "box" | "cylinder" | "stairs" | "winder"
  x: number                    // 相对构件中心的横向比例
  z: number                    // 相对构件中心的纵向比例
  w: number                    // 相对构件宽度的比例
  d: number                    // 相对构件深度的比例
  y: number                    // 部件底面高度，mm
  h: number                    // 部件高度，mm
  rot?: number                 // 部件局部顺时针角度
  color?: string
  steps?: number               // stairs 或 winder 必填
  pivot?: [number,number]      // winder 内角，使用部件局部归一化坐标
  edges?: [number,number][]    // winder 外边界的顺序采样点，沿上行方向
}

type PlanImportResponse = {
  plan: Plan
  furniture: ImportedFurniture[]
  explanation: string
  id: string
}
```

`cx`、`cy` 为家具中心，与 Plan 使用同一个毫米坐标系。 `w`、`d` 为家具沿自身轴向的尺度。 `rot` 为平面顺时针角度，`0 <= rot < 360`，支持小数。没有识别到家具时，`furniture` 为空数组。

家具库未覆盖的物体可以作为 `component` 导入。部件的 `x,z` 范围为 `[-0.5,0.5]`，`w,d` 范围为 `(0,1]`，`y >= 0`，`h > 0` 且 `y + h <= 10000` mm。每件最多 48 个部件。构件和部件分别旋转，调整构件宽深时内部的水平比例随之缩放。

直梯段 `stairs` 沿局部 `-z` 到 `+z` 上升，`steps` 为 1–32。扇形梯段 `winder` 的 `steps` 为 2–32，`pivot` 和 `edges` 都使用部件各轴 `[-0.5,0.5]` 的坐标，端点数为 `steps + 1`。内角与相邻两端点构成一块踏步，三角形方向需一致且面积大于零。

页面预览家具及构件数量。应用后，识别结果进入 `state.furniture`，并和户型一起保存为一次撤销操作。「保留现有家具」会一并带入画布原有布置。

失败返回 `{ "error": "..." }`（HTTP 4xx/5xx）。

### `GET /files/*`

映射到 `projects/`，只读，防路径穿越。

## 6. codex 集成（从 baocut 移植）

参考源码（只读，不要修改）：

- `../baocut/packages/agent-drivers/src/codex/codex-binary.ts`（定位可执行文件、登录态）
- `codex-protocol.ts`（JSON-RPC 消息类型）
- `rpc-connection.ts`（stdio 行分隔 JSON-RPC）
- `codex-session.ts`（thread/turn 生命周期）
- `codex-driver.ts`（版本 0.158.0 下限）

要求：

- `codex app-server` 每会话常驻；`initialize` → `thread/start` → `turn/start`；按 `turn/completed` 收尾。
- 对话会话：`approvalPolicy:'never'`、`sandbox:'read-only'`，`developerInstructions` 读 `prompts/patch.md`。
- 渲染会话：允许 `image_gen` 工具；`sandbox:'workspace-write'`，cwd 为项目根；提示词读 `prompts/render.md`。
- 图纸解析会话：`sandbox:'workspace-write'`，cwd 为本次 `workdir/import-*/`，提示词读 `prompts/plan-import.md`。
- 找不到 codex / 未登录时，`/api/health` 返回 `found:false`，其余 API 返回明确错误，页面给出提示。
- 前端所有网络失败都要可恢复，不打断 2D/3D 编辑。

## 7. 约定

- 界面文案沿用现有 `tr('中文','English')` / `data-en` 机制，中英双语。
- 不改变现有视觉风格（配色/字号/圆角）。
- 不改 `LICENSE`；不执行 `git commit` / `git push`。
- 新增代码用注释分节，风格与现有 `index.html` 一致（简洁、少依赖）。
