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
index.html          页面样式、DOM、Three.js importmap 与脚本入口
js/                 2D/3D 编辑器、界面交互、项目和 AI 接口的原生 JS 脚本
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

type Plan = {
  version: 1,
  name: string,
  bounds: { x:number, y:number, w:number, h:number },
  walls: ([...Rect, kind:WallKind, height?:number] | (ArcBand & {kind:WallKind, height?:number}))[],
  wins: (Rect | ArcBand)[],
  doors: { name:string, rect:Rect, h:Point, c:Point, o:Point, len:number, entry?:boolean }[],
  slides: { rect:Rect, v:boolean }[],
  rooms: { id:string, name:string, poly:Point[], arcs?:{edge:number,sweep:number}[], mat:string, at?:Point, counted?:boolean,
           outdoor?:true, bay?:{roomId?:string,openingEdges?:number[],sillHeight?:number} }[],
  materials: Record<string, { name:string, price:number, sw:string }>
}
```

- 单位 mm，2D 的 y 轴向下；3D 用现有 `wx()/wz()` 转换。
- 直墙和直窗的矩形坐标已包含厚度。圆弧墙窗的 `from`、`to` 为中心线起止点，`thickness` 为总厚度（小于直径）。`sweep` 为有符号角度，顺时针为正，逆时针为负，绝对值为 0.5–180 度。同一墙体的编号始终使用其在 `walls` 中的下标。
- 墙体可单独指定 `height`（mm）。省略时，矮墙默认 1000 mm，其他墙默认 2800 mm。剖切视图按显示高度裁切。
- `rooms[].arcs` 中的 `edge` 从零开始，指 `poly[i]` 与 `poly[(i+1)%poly.length]` 之间的边，`sweep` 与墙窗的角度规则相同。每条边至多一个弧段，折线和圆弧端点只记一次。面积包含圆弧边围出的面积。
- `at` 是房间标签位置。`counted:false` 表示不计入套内使用面积，独立于区域类型。室外露台和花园用 `outdoor:true`，在地平面显示。图面确认的飘窗台用 `bay`，其中 `roomId` 关联室内房间，`openingEdges` 指向飘窗轮廓上朝向室内的开口边，`sillHeight` 为已知窗台高度（mm）。
- 编辑器由 `PLAN` 驱动，`WALLS/WINS/DOORS/SLIDES/ROOMS/MATS` 随方案加载同步更新，供渲染和查找使用。
- 125-C 户型作为“示例方案”保留为 `data/125c-plan.json`（由任务 1 生成），默认加载 `data/empty-plan.json`。

## 2. 会话状态 State

沿用现有结构并扩展：

```ts
type State = {
  furniture: (ImportedFurniture & { id: string, ceiling?: CeilingMount })[],
  rooms: Record<roomId, { name, mat }>,
  demolished: string[],        // 'w'+index
  measures: any[],
  dimensionMarks?: {id: string, axis: 'x' | 'y', a: DimensionAnchor, b: DimensionAnchor, original?: number}[],
  ceiling?: {version: 1, baseHeight: number, rooms: Record<roomId, CeilingRoom>},
  walk?: {recent: WalkPose[], views: {id: string, name: string, pose: WalkPose,
    scene?: {hour: number, night: boolean, furn: boolean}}[]},
  renders?: RenderRecord[]
}

type DimensionAnchor = {kind: 'wall' | 'room', id: string, edge: number, t: number}
type WalkPose = {x: number, y: number, height: number, yaw: number, pitch: number, roomId: string | null}
type CeilingMount = {roomId?:string, zoneId?:string, hang?:number, kelvin?:number, intensity?:number, tilt?:number}
type CeilingRoom = {
  baseHeight?: number,
  color?: string,
  finish?: string,
  zones: {id:string, name:string, poly:Point[], arcs?:{edge:number,sweep:number}[],
          holes?:Point[][], drop:number, color:string, finish?:string,
          preset?:{type:'perimeter'|'island', width:number}}[],
  edges: {id:string, zoneId?:string, hole?:number, edge:number, type:'cove'|'trim',
          width:number, depth:number, color:string}[],
}
```

`dimensionMarks` 使用墙面或房间边的几何引用，`t` 为边上的位置比例。显示值由当前几何沿 `axis` 计算。可选的 `original` 是人工记录的原图读数，单位 mm。旧项目缺少此字段时按空列表读取。

`ceiling` 存储顶面分区、收边和房间原顶。每个房间可覆盖默认净高（2800 mm），并设置原顶颜色与饰面名称。区域完成面为原顶净高减去 `drop`，收边通过 `zoneId`、可选的 `hole` 和 `edge` 定位。高度与家具尺寸沿用毫米。

顶装灯具与设备存入 `furniture`，通过 `ceiling.zoneId` 指定顶面，省略时由坐标确定完成面。载入旧项目时，将天花记录的 `fixtures` 升级为家具并保留安装参数。图纸识别、预览和天花对话仍使用按房间汇总的 `fixtures` 投影，应用时更新对应家具。

`walk` 随项目保存。`recent` 在退出漫游时记录各漫游范围最近的相机位置和方向，`views` 用于兼容已有项目数据。`x`、`y` 沿用户型毫米坐标，`height` 用米，`yaw`、`pitch` 用弧度。编辑撤销保留漫游记录。漫游截图用作当前项目会话的效果图参考。

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
  select(sel),               // 更新画布选中项及属性面板
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
  "context": { "mode": "2d"|"3d", "task": "create-furniture", "selection": {...}|null,
               "plan": { ... 当前完整 Plan ... }, "state": { ... 完整场景状态，不含效果图 ... },
               "view": { "camera": {...}|null, "room": "living"|null } },
  "images": [ { "mime": "image/png", "role": "scene", "data": "<base64，不含 data: 前缀>" } ],
  "attachments": [ { "name": "方案参考.pdf", "mime": "application/pdf", "data": "<base64，不含 data: 前缀>" } ] }
```

用户上传的文件通过 `attachments` 发送，支持 PNG、JPEG、WebP、PDF、ASCII DXF、DWG 和 UTF-8 的 TXT、Markdown、JSON、CSV。每条消息最多 6 个文件，单个文件最多 8 MiB，合计最多 20 MiB。文本附件最多 128 KiB，分析时每个文件提供前 6000 个字符。PDF 提供首页预览和可读取的嵌入文字，文字最多 6000 个字符。CAD 提供有界的原生几何样本。Linux 的 PDF 预览和文字读取分别使用服务路径中的 `pdftoppm` 和 `pdftotext`，DWG 几何读取使用 LibreDWG 的 `dwgread`。

有用户附件时可省略 `message`。助手根据消息和附件内容判断用途，只有附件的请求不会修改当前方案。`context.task: "create-furniture"` 和 `images[].role: "furniture-reference"` 仍支持旧版家具流程。省略 `images[].role` 时按场景截图处理。

SSE 事件（`data: <json>\n\n`）：

```
{"type":"status","text":"..."}      // 可多次，显示进度
{"type":"delta","text":"..."}       // 可多次，正文增量（可选实现）
{"type":"result","result":{"reply":"...","ops":[...],"focus":{...},"furniture":[...]}}
{"type":"error","message":"..."}
{"type":"done"}
```

服务端将上下文和 `prompts/patch.md` 交给内存中的 Codex 会话，并从最终回复解析 JSON。同一个 `sessionId` 在会话存活期间可以继续追问。附件临时文件在请求处理结束后清理。含通用附件的请求只返回进度和结构化结果。旧版请求在解析失败时降级为 `{reply: 原文, ops: []}`。

`result.furniture` 可省略，每次最多返回 8 个素材。素材包含 `type`、`name`、毫米单位的 `w` 和 `d`，还可包含 `rot`、`color`、`parts`、`handedness`、`topShape` 和 `height`。素材由客户端存入当前浏览器的「我的素材」。场景变更通过 `ops` 应用，用户也可选择把素材放入方案。

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

### `POST /api/export/dwg` → `image/vnd.dwg`

请求使用 `application/json`，包含当前 `plan`、`state` 的 `furniture`、`rooms`、`demolished` 以及 `dimensions`。每行尺寸包含 `axis`、标注线位置 `at`、几何锚点数组 `points: [{value, across}]`、`kind: 'overall' | 'chain' | 'manual'`，人工标注可附带 `original`。

正常响应通过 `Content-Disposition` 下载 AutoCAD 2000 DWG（`AC1015`）。图形采用毫米和 1:1 模型空间，按用途分层。服务将经过校验的方案转换成 CAD 图形，并调用本机 `dxf2dwg`。转换器缺失返回 503，输入无效返回 422。

### `POST /api/ceiling-import` → JSON

请求携带当前项目的 `plan` 和 `ceiling`，以及 `mode`（`drawing` 或 `photo`）、`roomId`、`files`（`{name,data}`，`data` 为 Base64）和可选 `note`。图纸模式可对照整张底图，照片模式需要指定房间。公网入口通过 `/api/jobs/ceiling-import` 提交。

返回 `{aligned,alignment,warnings,estimated,items}`。`items` 是当前项目坐标中的候选对象，有对齐及估算说明。页面验证用户选中的候选后，通过一次 `editScene` 更新天花层。

### `POST /api/plan/import` → JSON

```json
{ "files": [ { "name": "plan.pdf", "mime": "application/pdf", "data": "<base64>" } ],
  "note": "可选" }
```

服务端将资料写入 `workdir/import-<uuid>/`，由 codex 识别图纸图片、PDF、CAD 导出或 JSON。纯 PNG、JPEG 或 WebP 请求将原图直接附给模型，并从模型回复读取 JSON。需要从工作目录读取资料时，模型将 JSON 写入 `plan.json`。两种输出都将 `furniture` 与结构字段并列，服务端校验后返回户型和家具。

### `/api/jobs/plan-import` → 后台图纸识别

- `POST /api/jobs/plan-import` 接收同样的文件 JSON，可附 `projectName`，入队后返回 `202` 和任务 `id`。模型回合最长 30 分钟。
- `GET /api/jobs/plan-import` 返回当前访问范围的 `jobs`，含 `id`、`name`、`phase`、`review`、`progress` 和毫秒时间戳。
- `GET /api/jobs/<id>?cursor=0` 同样提供进度元数据，并返回 `done`、`status`、`chunks` 和下一游标。完成时 `chunks` 中是识别结果 JSON，失败时 `error` 提供失败信息。
- `DELETE /api/jobs/<id>` 取消任务。公网通过已认证网关访问，项目成果按本机与公网访问范围隔离。

识别成功后服务端会自动复核一次识别结果（默认开启），结果记录在任务的 `review` 字段：

```ts
type JobProgress = {
  stage: "queued" | "preparing" | "waiting-model" | "recognizing" | "comparing" |
    "validating" | "done" | "failed" | "canceled" | "unavailable"
  updatedAt: number    // 当前进度的更新时间，与任务和复核结果各自的时间戳独立
  message?: string     // 面向用户的短进展或摘要，当前模型未返回时省略
}

type ReviewState = "pending" | "running" | "match" | "differ" | "unavailable"

type JobReview = {
  state: ReviewState
  count: number        // 复核发现的问题条数；只有 differ 时可能非 0
  updatedAt: number    // 毫秒时间戳
  progress?: JobProgress
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
  rerun: boolean                                  // 工作目录是否还在、能否重新复核
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
- `POST /api/jobs/<id>/review`：无请求体（沿用识别时保存的用户备注），重新复核并立即返回 `202 {ok:true}`，结果通过上面的 `GET` 轮询。任务不存在或已过期、识别未完成、复核进行中返回 `409`；工作目录已清理（公网任务复核结束后会删除上传文件，服务重启也会清空）返回 `404`；codex 不可用返回 `503`。
- 复核失败后，任务 `review.state` 变为 `unavailable`，项目卡片显示复核未完成，复核结果 `GET` 返回 `404`。`STUDIO_PLAN_REVIEW=off` 时不再启动自动复核（任务的 `review` 保持 `null`），`POST` 返回 `404`，已存在的复核结果仍可读取。
- 任务和结果保存在 `~/.interior-design-studio/import-jobs`，可设置 `STUDIO_IMPORT_JOBS_DIR`。队列随服务重启恢复；结果最多保留 7 天或各范围最近 32 条，复核进行中（`pending` / `running`）的任务不参与清理。本机任务的工作目录（原图、`plan.json`、`review-plan.png`、`review-note.json`）保留到过期清理或服务重启，以支持重新复核；公网任务在复核结束后立即删除上传文件。打开和编辑后的项目由浏览器保存。

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
- `js/` 使用普通脚本，跨文件调用通过 `App` 中对应的命名空间。脚本按初始化顺序在 `index.html` 中加载。
