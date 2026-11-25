# 后台任务：对话与效果图可离开、可恢复

日期：2026-11-25
依据：`docs/superpowers/specs/2026-11-25-v2-design.md` §6.1
实现：`lib/task-jobs.mjs`、`server.mjs`（`/api/jobs/*`）、`deploy/public-jobs.mjs`
测试：`tests/task-jobs.mjs`（`node --test tests/task-jobs.mjs`）

## 1. 要解决的问题

现有 `/api/chat`、`/api/render` 是同步 SSE：浏览器断开连接，服务端立刻 `interrupt()` 掉 codex 回合，结果随之丢失。刷新页面等于白等。V2 要求"可以离开"由后端兑现：提交后拿到 `jobId`，任务脱离连接继续跑，事件与结果落盘，刷新后按 `jobId` 接着读。

SSE 接口继续保留（见第 3 节），两者共用同一份执行逻辑（`runChatTurn` / `runRenderTurn`），提示词、超时与错误文案只有一处。

## 2. 存储

- 默认目录：`~/.interior-design-studio/task-jobs`，环境变量 `STUDIO_TASK_JOBS_DIR` 覆盖。
- 终态保留：默认 30 分钟；`STUDIO_TASK_JOBS_RETENTION_MS` 可以加长，低于 30 分钟会被拉到 30 分钟（承诺不可被配置削弱）。
- 并发与容量：同时执行 2 个任务，未结束任务上限 8 个（超出返回 `429`）；每个访问范围最多保留 64 条终态任务，超出先删最旧的终态任务。
- 目录权限 `0700`，文件 `0600`。

```
<dir>/task-<uuid>/job.json      任务元数据（phase / status / ownership …）
                 input.json     请求参数，任务结束即删除
                 events.jsonl   事件帧，逐条追加，SSE 格式
                 result.json    最终结果（仅成功任务）
```

单任务事件上限 4 MB、结果上限 4 MB、请求体上限 40 MB。

**重启语义**：服务重启后，已完成任务照常可读；运行中的任务无法续接 codex 回合，标记为 `failed`（`status: 503`，`error: 服务已重启，任务已中断，请重新提交。`），已产生的事件保留，便于前端说明中断位置。

## 3. 接口

所有接口只监听 `127.0.0.1`，与现有 API 一致。公网访问见第 6 节。

### `POST /api/jobs/chat`

请求体与 `/api/chat` 相同，另加可选的 `ownership`：

```json
{ "message": "把客厅沙发移到窗边",
  "sessionId": "可选，同一会话复用",
  "context": { "plan": {...}, "state": {...}, "selection": null, "view": {...} },
  "images": [{ "mime": "image/png", "data": "<base64>" }],
  "ownership": { "projectId": "p-1", "schemeId": "s-1", "baseRevision": 7 } }
```

- `message` 为空返回 `400`，`ownership` 非法返回 `400`。
- 成功返回 `202`：

```json
{ "jobId": "task-9f0c…", "id": "task-9f0c…", "kind": "chat",
  "phase": "queued", "status": null, "error": null,
  "ownership": { "projectId": "p-1", "schemeId": "s-1", "baseRevision": 7 },
  "createdAt": 1795585075328, "updatedAt": 1795585075328,
  "startedAt": null, "finishedAt": null, "reused": false }
```

`jobId` 与 `id` 是同一个值，保留两个字段只为少改前端代码。

### `POST /api/jobs/render`

请求体与 `/api/render` 相同，另加可选的 `ownership`：

```json
{ "kind": "angle" | "room", "roomId": "living" | null,
  "image": "<base64 PNG>", "mime": "image/png",
  "scene": { "plan": {...}, "furniture": [...], "camera": {...} },
  "style": "现代简约", "note": "黄昏灯光",
  "ownership": { "projectId": "p-1", "schemeId": "s-1", "baseRevision": 7 } }
```

缺少可解码的 `image` 返回 `400`。其余同上。

### `GET /api/jobs/task/<id>?cursor=0`

返回任务状态、游标之后的事件帧与最终结果：

```json
{ "id": "task-9f0c…", "kind": "chat",
  "phase": "running" | "queued" | "done" | "failed" | "canceled",
  "status": null | 200 | 4xx | 502 | 504 | 410 | 499,
  "error": null | "…",
  "ownership": { "projectId": "p-1", "schemeId": "s-1", "baseRevision": 7 },
  "createdAt": 1795585075328, "updatedAt": 1795585088010,
  "startedAt": 1795585075329, "finishedAt": null,
  "cursor": 3, "chunks": ["data: {\"type\":\"status\",…}\n\n", "…"],
  "done": false,
  "result": { "…仅 done 且结果非空时出现" } }
```

- `chunks` 是标准 SSE 帧（`data: <json>\n\n`），与 `/api/chat` 的实时流同形，前端可直接复用现有 `takeSSE(buf)` 解析器。每次最多返回 512 帧，`cursor` 用于接着读，直到 `done: true`。
- 任务不存在、已过期或属于其他访问范围返回 `404`；游标越界返回 `400`。
- 事件类型与现有 SSE 完全一致：
  - 对话：`status` / `delta` / `result`（补丁对象）/ `error` / `done`
  - 效果图：`status` / `image`（`{url, prompt}`）/ `error` / `done`
- 终态对照：`done`（`status: 200`）、`failed`（`error` 有说明）、`canceled`（`status: 410`）。`done: true` 表示事件已经取完且任务已结束。

### `GET /api/jobs/task`

返回当前访问范围的任务列表（不含 `chunks`），按创建时间倒序，供页面刷新后找回任务入口：

```json
{ "jobs": [ { "id": "task-9f0c…", "kind": "render", "phase": "done", "…": "…" } ] }
```

### `DELETE /api/jobs/task/<id>`

取消任务。运行中的任务会收到 `abort`，codex 回合被中断，保留已产生的事件，状态变为 `canceled`。返回 `200 {ok:true}`；任务不存在返回 `404`。

## 4. 幂等与归属

**幂等键**：`sha256(kind + projectId + schemeId + 稳定序列化的请求参数)`。提交时若存在**同一访问范围内、同一幂等键、尚未结束**的任务，直接返回那个任务并带 `reused: true`，不再入队。任务结束（含失败、取消）后同一请求会新建任务——否则用户永远没法再问第二次。

参数摘要对键顺序不敏感（`stableJson`），因此同一份上下文顺序变化不会绕过去重。未提供 `sessionId` 时服务端不会在提交阶段生成它（否则随机值会让同样的请求永远命中不了同一任务），而是在任务真正开始执行时生成一次。

**归属**：`projectId`、`schemeId`、`baseRevision` 原样存入任务，并在提交响应与每次轮询中回传。字段只接受字符串或数字（字符串截到 200 字），缺省为 `null`。服务端不解释它们的含义，由前端决定"结果回来时方案是否已经变了"。

## 5. 与现有 SSE 接口的关系

- `/api/chat`、`/api/render` 行为不变：同步 SSE、连接关闭即中止、HTTP 状态仍是 `200`（错误通过事件）或请求校验的 `4xx`。
- 实现上两者都薄封装到 `runChatTurn` / `runRenderTurn`：SSE 把事件直接写给响应，后台任务把事件落盘。中止来源不同（实时：连接关闭；后台：`DELETE`、超时、输出超限），执行逻辑同一份。
- 超时沿用原值：对话 10 分钟、效果图 8 分钟。超时的后台任务标记 `failed`（`504`）。

## 6. 公网

`deploy/public-jobs.mjs` 的租期调整（`RELAY_LIMITS`，测试可注入更短值）：

| 常量 | 旧值 | 新值 |
|---|---|---|
| `POLL_LEASE` | 3 分钟 | **10 分钟** |
| `MAX_JOB_AGE` | 15 分钟 | 15 分钟（保持不变） |
| `FINISHED_TTL` | 20 分钟 | 20 分钟 |

含义：浏览器离开后，公网任务最多再等 10 分钟；总时长到 15 分钟必定停止，UI 应写明这个上限。

公网网关将对话和效果图提交转发至本机 SSE。Relay 记录登录会话、方案归属与事件，在同一登录会话内支持按 `GET /api/jobs/task` 列出任务、按任务 ID 续读或取消。完全相同的在途请求可以复用任务。公网任务保存在网关内存中，网关重启或登录会话失效后需要重新提交。

## 7. 前端接入

1. **提交**：`POST /api/jobs/chat`（或 `/render`），body 沿用现有字段并附 `ownership: {projectId, schemeId, baseRevision}`。取响应里的 `jobId`，连同 `projectId` / `schemeId` 记入方案（IndexedDB 或 `localStorage`），用于刷新后找回。
2. **轮询**：`GET /api/jobs/task/<jobId>?cursor=<cursor>`，建议运行中 1 s 一次、页面隐藏时 3–5 s 一次（可见性恢复时立刻补一次）。把 `chunks.join('')` 交给现有 `takeSSE(buf)`，逐事件处理，保留未成帧的尾巴到下一次。`cursor` 用响应里的值。
3. **阶段文案**：`status` 事件给出阶段名；服务端没有新阶段时按已用时间显示兜底文案，不伪造百分比。计时器每秒跳动。
4. **完成**。效果图写回提交时所属方案。助手在当前方案及修订号匹配时按现有规则应用。离开方案后完成的助手结果可在原方案查看，编辑过的方案需要重新提交修改指令。
5. **取消**：`DELETE /api/jobs/task/<jobId>`。
6. **恢复**：页面加载时 `GET /api/jobs/task`，把 `queued` / `running` 的任务接回轮询；`done` 且未读的在项目列表打状态点。
7. **离线编辑**。本地页面未连接服务时，2D 和 3D 编辑仍可用。

## 8. 测试

`tests/task-jobs.mjs` 全部使用假执行器，不调用 codex：

- 提交、轮询、断开后继续执行、完成取结果（含磁盘上的 `result.json`）
- 进行中的重复提交复用任务、结束后新建；幂等键含方案归属
- 归属缺省与非法类型、未知任务类型、容量上限
- 失败与抛异常落成终态、游标校验、访问范围隔离
- 取消中止信号
- 保留期清理
- 跨重启读回已完成任务、崩溃遗留的运行中任务标记中断
- 公网租期常量与租期/总时限到点停止

## 9. 已知取舍

- 幂等只覆盖"进行中"的任务；完成后再提交同一请求会新建任务（便于用户重试）。
- `events.jsonl` 逐条 `appendFile`，进程被强杀时最后一行可能不完整；前端解析失败时丢弃该帧即可。
- 单个任务的事件总量按 4 MB 截断，超出后台任务失败（`502`），避免一次长对话写爆磁盘。
- 公网 relay 的任务 id 只存在内存里：relay 重启后旧 id 返回 `404`（与改动前一致）。
