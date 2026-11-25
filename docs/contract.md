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
type Point = [x:number, y:number]
type Rect = [x0:number, y0:number, x1:number, y1:number]
type ArcBand = { from:Point, to:Point, sweep:number, thickness:number }
type WallKind = 'e' | 'b' | 'n' | 'low'
type WinStyle = 'casement' | 'sliding' | 'fixed' | 'floor' | 'bay'
type Source = 'drawing' | 'ai' | 'user'

type Plan = PlanV2          // 写出、传输与保存一律 V2；读取时接受 V1 并迁移

type PlanV2 = {
  version: 2,
  name: string,
  bounds: { x:number, y:number, w:number, h:number },
  walls: (WallSeg | WallArc)[],
  wins: (WinSeg | WinArc)[],
  doors: (Door & { id:string, source?:Source })[],
  slides: (Slide & { id:string, source?:Source })[],
  rooms: (Room & { ceiling?:Ceiling, source?:Source })[],
  materials: Record<string, { name:string, price:number, sw:string }>,
  dims: Dim[]
}

type WallSeg = { id:string, rect:Rect, kind:WallKind, height?:number, source:Source }
type WallArc = { id:string, from:Point, to:Point, sweep:number, thickness:number,
                 kind:WallKind, height?:number, source:Source }
type WinSeg = { id:string, rect:Rect, sill?:number, h?:number, style?:WinStyle, source:Source }
type WinArc = { id:string, from:Point, to:Point, sweep:number, thickness:number,
                sill?:number, h?:number, style?:WinStyle, source:Source }
type Door = { name:string, rect:Rect, h:Point, c:Point, o:Point, len:number, entry?:boolean }
type Slide = { rect:Rect, v:boolean }
type Room = { id:string, name:string, poly:Point[], arcs?:{edge:number, sweep:number}[],
              mat:string, at?:Point, counted?:boolean }
type Ceiling = { h?:number, drops?:{rect:Rect, depth:number}[],
                 cove?:'none'|'perimeter', box?:boolean }
type Dim = {
  id: string,
  source: Source,
  from: DimAnchor,
  to: DimAnchor,
  offset: number,                 // 尺寸线相对 from→to 连线的偏移
  drawingValue?: number,          // 原图标注值，mm
  axis: 'x' | 'y',                // 量测方向，用于成链与求和
  chain?: string,                 // 同一尺寸链的分组键
  locked: 'from' | 'to' | 'none', // 固定哪一端；改数值时移动另一端
  note?: string,                  // 如「外墙外沿」
}
type DimAnchor =
  | { kind:'wall', id:string, face:'axis'|'outer'|'inner'|'left'|'right', point:Point }
  | { kind:'room', id:string, edge:number, face:'inner', point:Point }

// 只读兼容：读到 V1 时迁移为 V2，不再写出 V1
type PlanV1 = {
  version: 1,
  name: string,
  bounds: { x:number, y:number, w:number, h:number },
  walls: ([...Rect, kind:WallKind, height?:number] | (ArcBand & {kind:WallKind, height?:number}))[],
  wins: (Rect | ArcBand)[],
  doors: Door[],
  slides: Slide[],
  rooms: Room[],
  materials: Record<string, { name:string, price:number, sw:string }>
}
```

- 单位 mm，2D 的 y 轴向下；3D 用现有 `wx()/wz()` 转换。
- 直墙和直窗的矩形坐标已包含厚度。圆弧墙窗的 `from`、`to` 为中心线起止点，`thickness` 为总厚度（小于直径）。`sweep` 为有符号角度，顺时针为正，逆时针为负，绝对值为 0.5–180 度。
- V2 中墙体、窗、门、推拉门、房间都按 `id` 认身份，不再依赖下标；`editScene` 的路径仍按数组下标寻址（§4）。`source` 记录来源：`drawing` 图纸读取、`ai` 识别/复核初稿、`user` 用户修改。
- 墙体可单独指定 `height`（mm）。省略时，矮墙默认 1000 mm，其他墙默认 2800 mm。剖切视图按显示高度裁切。
- `rooms[].arcs` 中的 `edge` 从零开始，指 `poly[i]` 与 `poly[(i+1)%poly.length]` 之间的边，`sweep` 与墙窗的角度规则相同。每条边至多一个弧段，折线和圆弧端点只记一次。面积包含圆弧边围出的面积。
- `at` 是房间标签位置；`counted:false` 表示不计面积（飘窗）。
- `ceiling` 是天花（平顶层高、矩形局部下沉、灯槽、窗帘盒），缺省表示未设置；它不参与 2D 墙体选择。
- 现有 `index.html` 里的 `WALLS/WINS/DOORS/SLIDES/ROOMS/MATS` 仍是页面内部的元组别名，运行时统一由 `PLAN` 驱动；`sanitizePlan` 接受 V2 对象并按等价字段搬运，不改几何。页面当前仍把方案按 V1 元组存回本地，重载时再走一次迁移——因为迁移期 id 由顺序 + 几何决定，同一方案重新迁移得到同一组 id。
- 125-C 户型作为“示例方案”保留为 `data/125c-plan.json`（由任务 1 生成），默认加载 `data/empty-plan.json`。

### 1.1 字段表

| 集合 | 字段 | 说明 |
|---|---|---|
| `walls[]` | `id` | 方案内唯一；迁移期由顺序 + 坐标哈希生成，V2 输入原样保留 |
| | `rect` / `from`+`to`+`sweep`+`thickness` | 直墙用矩形；弧墙用中心线端点、扫角与总厚度（二选一） |
| | `kind` | `e` 外墙、`b` 分户/承重、`n` 内墙、`low` 矮墙；未知值归一为 `n` |
| | `height?` | mm，省略按墙类型取默认值 |
| | `source` | `drawing` / `ai` / `user` |
| `wins[]` | `id`、`rect` 或弧段字段 | 同上；窗的几何独立存储，不按下标旁挂 |
| | `sill?` | 窗台高 mm，0–3000；越界时置空并在 `warnings` 说明 |
| | `h?` | 窗高 mm，200–6000；越界时置空并在 `warnings` 说明 |
| | `style?` | `casement` / `sliding` / `fixed` / `floor` / `bay`，未知值丢弃 |
| | `source` | 同墙 |
| `doors[]` | `id` | 门洞唯一 id |
| | `name`、`rect`、`h`、`c`、`o`、`len`、`entry?` | 与 V1 一一对应：`h` 铰链点、`c` 关门方向、`o` 开门方向、`len` 门扇长 |
| | `source?` | 校验时补齐，缺省 `ai` |
| `slides[]` | `id`、`rect`、`v`、`source?` | `v:true` 竖向推拉 |
| `rooms[]` | `id`、`name`、`poly`、`mat`、`at?`、`counted?`、`arcs?` | 与 V1 相同；`id` 方案内唯一，重复时追加 `_2` |
| | `ceiling?` | `h` 层高、`drops[]` 局部下沉（`depth` 下沉深度）、`cove` 灯槽、`box` 窗帘盒 |
| | `source?` | 校验时补齐，缺省 `ai` |
| `dims[]` | `id`、`source` | 尺寸唯一 id 与来源 |
| | `from`、`to` | `DimAnchor`，见下 |
| | `offset` | 尺寸线相对连线的偏移，mm，缺省 0 |
| | `axis` | `x` / `y`，缺省按两端量测点推断 |
| | `chain?` | 尺寸链分组键；缺省按 `axis` + 共线推断 |
| | `locked` | 固定端：`from` / `to` / `none`（缺省 `none`） |
| | `drawingValue?` | 原图标注值，改模型时不清除，用于「图上 / 现在」对照 |
| | `note?` | 量测面说明，如「外墙外沿」 |
| `DimAnchor` | `kind:'wall'` | `id` 必须是已存在的墙 id；`face` 取 `axis`/`outer`/`inner`/`left`/`right` |
| | `kind:'room'` | `id` 必须是已存在的房间 id；`edge` 指向 `poly` 的合法边；`face` 固定 `inner` |
| | `point` | 量测点；缺省时按墙段/房间边推导（直墙取面或中心、弧墙取起点、房间边取中点） |

### 1.2 校验与迁移

`lib/codex/plan.mjs` 的 `validatePlan(raw)` 是 Plan 的唯一入口，返回
`{ok:true, plan:PlanV2, warnings:string[]}` 或 `{ok:false, error:string}`（至少一个房间，否则失败）。

- **V1→V2 迁移**：读到元组形态的 walls/wins（V1，无论 `version` 写的是什么）时，按数组顺序 + 坐标哈希生成迁移期稳定 id（同一输入重复迁移得到同一 id），写出 `version:2`。
- **字段保留**：门的 `rect`/`h`/`c`/`o`/`len`/`entry`/`name` 原样保留；窗的几何保持，`sill`/`h`/`style` 置空；迁移出的结构对象 `source` 记为 `ai`。
- **id 唯一**：已有 `id` 原样保留；同一集合内重复时按出现顺序追加 `_2`、`_3`。校验幂等：`validatePlan(validatePlan(raw).plan)` 不再改变方案。
- **dims**：锚点必须引用存在的墙/房间 id 与合法房间边，否则丢弃该条尺寸并在 `warnings` 中说明，不拒绝整个方案；重复 id 同样去重；最多 2000 条。
- **提示不拒绝**：弧墙端点与相邻墙段端点距离超过 1 mm 时写入 `warnings`，不影响 `ok`；墙体超过 4000 段时跳过该提示。
- **过渡视图**：仍按 V1 元组读取的调用方使用 `toV1Plan(plan)`——返回 `version:1` 视图（直墙 `[...Rect, kind, height?]`、弧段 `ArcBand`、门窗去掉 `id`/`source`、房间去掉 `source`/`ceiling`、无 `dims`），不修改入参。

## 2. 会话状态 State

沿用现有结构并扩展：

```ts
type State = {
  furniture: (ImportedFurniture & { id: string })[],
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

### `/api/jobs/plan-import` → 后台图纸识别

- `POST /api/jobs/plan-import` 接收同样的文件 JSON，可附 `projectName`，入队后返回 `202` 和任务 `id`。模型回合最长 30 分钟。
- `GET /api/jobs/plan-import` 返回当前访问范围的 `jobs`，含 `id`、`name`、`phase`、`review` 和毫秒时间戳。
- `GET /api/jobs/<id>?cursor=0` 返回 `phase`、`done`、`status`、`chunks` 和下一游标。完成时 `chunks` 中是识别结果 JSON，失败时 `error` 提供失败信息。
- `DELETE /api/jobs/<id>` 取消任务。公网通过已认证网关访问，项目成果按本机与公网访问范围隔离。

识别成功后服务端会自动复核一次识别结果（默认开启），结果记录在任务的 `review` 字段：

```ts
type ReviewState = "pending" | "running" | "match" | "differ" | "unavailable"

type JobReview = {
  state: ReviewState
  count: number        // 复核发现的问题条数；只有 differ 时可能非 0
  updatedAt: number    // 毫秒时间戳
}

type ReviewIssue = { where: string, detail: string }   // where ≤ 60 字，detail ≤ 200 字

type ReviewDelta = {
  rooms: { before: number, after: number },       // 房间数量
  area: { before: number, after: number },        // 计入面积的房间总面积，㎡，保留 1 位小数
  walls: { before: number, after: number },
  wins: { before: number, after: number },
  doors: { before: number, after: number },
  furniture: { before: number, after: number },
  changedRooms: string[]                          // 名称或面积（变化 > 5%）有变的房间 id
}

type JobReviewDetail = {
  state: "match" | "differ",
  summary: string,                                // ≤ 120 字
  issues: ReviewIssue[],                          // 最多 8 条；match 时为 []
  fixed: { plan: Plan, furniture: ImportedFurniture[] } | null,   // match 时为 null
  delta: ReviewDelta,                             // fixed 相对原识别结果的变化
  updatedAt: number,
  rerun: boolean                                  // 原图已保存且复核已启用
}
```

复核状态机：

```
null                  // 复核未开启，或任务不是正常识别完成
 └─ 识别成功 → pending → running → match | differ
                            └─ 失败、超时、中止 → unavailable
pending / running 期间服务重启 → unavailable（同时删除 review.json）
```

- `GET /api/jobs/<id>/review`：无请求体。`match` 或 `differ` 时返回 `200` 和 `JobReviewDetail`；`pending`、`running`、`unavailable`、任务不存在或不属于当前访问范围时返回 `404`（`{error}`），前端据此轮询。
- `GET /api/jobs/<id>/source`：返回 `{available, reviewEnabled}`。此接口和任务列表只返回状态，原图在服务端私有保存。同一任务仅能在所属访问范围读取状态。任务不存在或属于其他访问范围时返回 `404`，附 `code: "missing-job"`。
- `POST /api/jobs/<id>/source`：接收 `{files, note?, result?, name?}`。上传文件的格式与导入接口一致。已有任务仅补存原图。任务记录过期时，携带 `result: {plan, furniture}` 和可选 `name` 可恢复关联，响应会给出新的任务 `id`。前端沿用原有项目，并关联响应中的任务 ID。保存原图与启动复核是两次独立操作。
- `POST /api/jobs/<id>/review`：可传 `{result: {plan, furniture}}` 复核当前项目快照。无请求体时使用任务保存的识别结果。接口沿用原图归档里的备注，受理后立即返回 `202 {ok:true}`，结果通过上面的 `GET` 查询。原图缺失、任务缺失和复核关闭返回 `404`，分别附 `missing-source`、`missing-job` 和 `review-disabled`。识别未完成或已有复核进行中返回 `409`，Codex 不可用返回 `503`。
- 复核失败时任务 `review.state` 变为 `unavailable`，项目方案仍可编辑。设置 `STUDIO_PLAN_REVIEW=off` 会关闭自动和手动复核，仍可保存原图和读取已有复核结果。
- 任务默认保存在 `~/.interior-design-studio/import-jobs`，可设置 `STUDIO_IMPORT_JOBS_DIR`。公网部署默认使用 `/var/lib/interior-design/import-jobs`。两种入口都把识别成功的原图单独保存在 `<任务ID>/source/files/`，与任务一起跨重启保留。已归档或正在复核的任务不参与过期清理，其余终态任务最多保留 7 天及各访问范围最近 32 条。可编辑的项目和编辑记录仍由浏览器保存，复核结果由用户确认后应用。

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
  handedness?: "left" | "right" // cornersofa 在旋转前的短段方向
  topShape?: "rect" | "round" | "oval" // coffeetable 或 sidetable 的台面轮廓
  height?: number             // coffeetable 或 sidetable 的台面离地高度（mm）
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

`cornersofa` 的 `handedness` 在 `rot: 0` 时表示靠背在局部上方，短段沿 `-x` 一侧（`left`）或 `+x` 一侧（`right`）向下延伸。省略时使用原有的左侧造型。`coffeetable` 和 `sidetable` 的 `topShape` 可指定矩形、圆形或椭圆，圆形和椭圆的两条全轴为 `w`、`d`。台面 `height` 范围为 200–800 mm。省略台面字段的家具沿用各类型原有造型和高度。

家具库未覆盖的物体可以作为 `component` 导入。部件的 `x,z` 范围为 `[-0.5,0.5]`，`w,d` 范围为 `(0,1]`，`y >= 0`，`h > 0` 且 `y + h <= 10000` mm。每件最多 48 个部件。构件和部件分别旋转，调整构件宽深时内部的水平比例随之缩放。

直梯段 `stairs` 沿局部 `-z` 到 `+z` 上升，`steps` 为 1–32。扇形梯段 `winder` 的 `steps` 为 2–32，`pivot` 和 `edges` 都使用部件各轴 `[-0.5,0.5]` 的坐标，端点数为 `steps + 1`。内角与相邻两端点构成一块踏步，三角形方向需一致且面积大于零。

页面预览家具及构件数量，并展示中文摘要供用户核对估算的尺寸、轮廓和布置关系。应用后，识别结果进入 `state.furniture`，并和户型一起保存为一次撤销操作。「保留现有家具」会一并带入画布原有布置。

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
