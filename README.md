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

## 公网入口

公网隧道连接 `deploy/public-gateway.mjs` 的 `127.0.0.1:4174`。访客可以编辑方案，持访问密钥的用户登录后可以使用 AI。网关将 AI 结果分批返回给浏览器，适配 Cloudflare Quick Tunnel。

- 本机服务和公网网关都设置 `STUDIO_PUBLIC_BRIDGE_TOKEN_FILE`，指向同一份本地桥接密钥文件。
- 公网网关额外设置 `STUDIO_PUBLIC_ACCESS_KEY_FILE`，指向独立随机生成的登录密钥文件，也可以用 `STUDIO_PUBLIC_ACCESS_KEY_HASH_FILE` 读取高熵登录密钥的 SHA-256 十六进制摘要。密钥文件权限设为 `0600`。
- 浏览器分别保存本机域名和公网域名的方案。需要在另一端打开时，通过项目 JSON 导出和导入。
- 固定域名可设置 `STUDIO_PUBLIC_URL` 为完整 HTTPS 地址，例如 `https://aitobee.muskapis.com/interior-design/`。将 [Nginx 片段](deploy/nginx-interior-design.conf) 加入对应 HTTPS 站点，保留原始域名和路径，把请求转给同机的 4174 网关。Linux 的 systemd 服务定义在 `deploy/`。
- 如 Codex 环境使用 API 密钥，效果图可以通过服务端配置注入 `image_gen`。设置 `STUDIO_RENDER_IMAGE_CONFIG_FILE` 指向私有 JSON，内容为固定 HTTPS API 基址 `baseUrl`、图像模型名 `model` 和本机 Codex API 密钥文件路径 `authFile`。图像工具只供效果图回合调用，使用该次请求的参考截图。有些兼容网关返回临时图片链接，可设置 `allowPublicResultUrls: true`，应用会验证公开地址和 PNG 内容。

## 目录

```
index.html            页面 + 2D 引擎 + 3D 场景（保持单文件，原生 JS）
server.mjs            本地 HTTP/SSE 桥接：静态服务、/api/chat、/api/render、/api/plan/import、/files
lib/codex/            codex app-server 客户端（定位可执行文件、stdio JSON-RPC、会话/回合、Plan 校验）
prompts/              四个 codex 会话的系统提示词：patch.md / render.md / plan-import.md / plan-verify.md
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
   「校核」可对照原始图片，校准尺寸并修改墙、门窗和飘窗。顶部「文件」菜单可导入、导出包含多方案的项目 JSON，也可导出当前方案或 PNG。
2. **3D 场景与室内视角**（顶栏 2D/3D，或按 `T`）
   鸟瞰 / 漫游、斜视 / 俯视、全高墙 / 剖切墙、日照与夜景；左侧房间列表点击飞到房间，
   「进入房间」以 1.55 m 眼高进入室内，六面裁切墙体外侧，退出或切回 2D 时恢复。可指定漫游站位，并按方案保存视角。
3. **助手对话**（右侧「助手」页签）
   用自然语言新增、移除或修改墙体、门窗、房间、材质、家具与构件。一次要求可联动多个对象，
   例如去掉开口并补实墙。更改通过校验后同时应用到 2D 和 3D，并作为一个撤销步骤。
4. **效果图**（右侧「效果图」页签）
   选机位（当前 / 斜视 / 俯视 / 房间四角）、风格与补充描述，根据参考截图生成。效果图与参考图可在方案历史中查看，支持基于同一参考重新生成。
   对话和效果图在后台执行，刷新后可以续查，结果归入提交时的方案。公网任务时限和恢复条件详见 [后台任务](docs/jobs.md)。
5. **项目与图纸导入**（右上角「项目」）
   上传图片 / PDF / CAD 导出 / JSON 后，识别在后台运行，单次模型回合最长 30 分钟。
   列表显示排队、识别中、待预览、失败和取消。刷新或离开页面后，可以回来查看任务，失败时可以重新导入。
   识别保留家具、家电、洁具、楼梯和端景在图中的位置、尺寸与朝向。确认预览后，方案作为独立项目打开。
   项目与各份方案保存在当前浏览器。项目支持排序和重命名，同一项目内可复制、切换和比较方案。预算按项目默认单价估算，方案可单独改价。
   识别成功后，原图与该项目的图纸任务长期保存在服务端，可以在重启后继续复核。
   识别完成后会自动对照原图复核一次（默认开启），可在项目列表里切换「识别结果 / 修正后」查看差异并应用修正，接口见 `docs/contract.md` §5。
   旧项目缺少原图时，在项目列表选择「补传原图」即可关联到当前项目。复核单独保存结果，由用户确认是否应用。
   `STUDIO_PLAN_REVIEW=off` 可关闭自动和手动复核。没有归档原图的后台任务最多保留 7 天，各访问范围最多保留最近 32 条。

## codex 未安装 / 未登录时

- `/api/health` 返回 `ok:true` 且 `codex.found:false`（附 `detail` 说明是未安装、版本过低还是未登录）。
- **对话**页签顶部显示提示「未检测到 codex…对话可能无法回复」，仍可输入，发送后收到一条服务端错误气泡；
  2D / 3D 编辑、撤销、导入导出、刷新保留都不受影响。
- **效果图**页签显示「生成很可能失败」，3D 下按钮仍可点，失败原因写在页签内的错误条。
- **导入图纸**提交后在项目列表显示失败原因，仍可从文件菜单导入项目 JSON。
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
