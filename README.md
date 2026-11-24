# 户型装修设计 · interior-design-studio

原生 JS 单文件页面（2D 平面 + Three.js r160 的 3D 场景），配一个零依赖的本地 Node 桥接服务：
把 `codex app-server` 接成「对话改方案 / 生成效果图 / 解析户型图纸」三个 AI 接口。
没有构建步骤、没有框架、不需要 `npm install`。

## 启动

```bash
node server.mjs              # http://127.0.0.1:4173（只监听本机）
PORT=8080 node server.mjs    # 换端口
npm start                    # 同上
```

- 需要 Node 20+（开发环境为 Node 25，`package.json` 是 `"type":"module"`）。
- 页面通过 CDN importmap 加载 three.js r160，**首次打开 3D 需要联网**。
- 也可以直接用浏览器打开 `index.html`（`file://`）：2D / 3D 编辑照常，AI 功能降级（见下）。
- AI 功能需要本机装有 [codex CLI](https://github.com/openai/codex)（≥ 0.158.0）并已 `codex login`；
  找不到时可设置 `CODEX_PATH` 指向可执行文件。

## 目录

```
index.html            页面 + 2D 引擎 + 3D 场景（保持单文件，原生 JS）
server.mjs            本地 HTTP/SSE 桥接：静态服务、/api/chat、/api/render、/api/plan/import、/files
lib/codex/            codex app-server 客户端（定位可执行文件、stdio JSON-RPC、会话/回合、Plan 校验）
prompts/              三个 codex 会话的系统提示词：patch.md / render.md / plan-import.md
data/                 默认空户型 empty-plan.json、示例 125-C 户型 125c-plan.json
docs/contract.md      接口契约（Plan/State 结构、window.Studio、HTTP API、op 列表）
projects/             运行期产出：效果图 renders/，/files/* 映射到这里（只读）
workdir/              图纸解析的临时工作目录 import-<uuid>/
tests/                零依赖自测：run.mjs 启服务 + headless Chrome，selftest.html 内跑断言
```

## 五个功能入口

1. **2D 平面设计**（默认视图）
   左侧家具库点击或拖入平面图；选择 / 移动 / 旋转 / 缩放手柄、测量、拆改墙体；
   右侧属性面板改房间名与地面材质；撤销 / 重做（Ctrl+Z / Ctrl+Shift+Z）。
   顶部「文件」菜单负责导入导出：项目 JSON（户型 + 家具 + 效果图记录）、方案 JSON、PNG 图片。
2. **3D 场景与室内视角**（顶栏 2D/3D，或按 `T`）
   鸟瞰 / 漫游、斜视 / 俯视、全高墙 / 剖切墙、日照与夜景；左侧房间列表点击飞到房间，
   「进入房间」以 1.55 m 眼高进入室内，六面裁切墙体外侧，退出或切回 2D 时恢复。
3. **助手对话**（右侧「助手」页签）
   自然语言改方案：`POST /api/chat` → SSE → 前端按契约的 ops（移动 / 旋转 / 缩放 / 增删家具、
   改房间、拆墙 / 复墙、整体换方案）一次性应用，并作为**一个**撤销步骤。
4. **效果图**（右侧「效果图」页签）
   选机位（当前 / 斜视 / 俯视 / 房间四角）、风格与补充描述，基于当前 3D 截图调 `POST /api/render`，
   生成结果存到 `projects/renders/`，可下载、回看历史；记录随项目保存。
5. **导入图纸**（「文件 → 导入图纸…」）
   上传图片 / PDF / CAD 导出 / JSON，服务端写入 `workdir/import-<uuid>/`，由 codex 识别成 Plan，
   预览房间、面积、门窗后一键应用（可选保留现有家具）；也可取消，不改动当前方案。

## codex 未安装 / 未登录时

- `/api/health` 返回 `ok:true` 且 `codex.found:false`（附 `detail` 说明是未安装、版本过低还是未登录）。
- **对话**页签顶部显示提示「未检测到 codex…对话可能无法回复」，仍可输入，发送后收到一条服务端错误气泡；
  2D / 3D 编辑、撤销、导入导出、刷新保留都不受影响。
- **效果图**页签显示「生成很可能失败」，3D 下按钮仍可点，失败原因写在页签内的错误条。
- **导入图纸**直接返回 503 错误，浮层里给出「改用 JSON 方案导入」的按钮。
- 完全连不上 `server.mjs`（例如 `file://` 打开或服务没启动）时，两个 AI 页签分别提示先运行
  `node server.mjs`；页面用内置空户型启动，一切本地编辑照常。

## 数据与自测

- localStorage：方案 `interior-plan-v1`、状态 `interior-state-v1`、效果图 `interior-renders-v1`、
  语言 `huxing-lang`、对话会话 `interior-chat-sid`。所有读写都包在 `try/catch` 里，
  存储被禁用或数据损坏时退回默认方案，不影响编辑。
- 自测（需要系统 Chrome，缺省会跳过并以 0 退出）：

  ```bash
  node tests/run.mjs
  ```
