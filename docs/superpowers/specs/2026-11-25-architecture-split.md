# 架构重构：拆分 index.html

日期：2026-11-25
状态：待实施（排在 V2.0 完成后）
前置：V2.0 实施完成、`node tests/run.mjs` 全绿、现有改动已提交

> 本文的行号是 2026-11-25 测量值（V2.0 实施中途）。**实施前必须重新测量**，V2.0 的改动会让分节边界移动。

---

## 1. 为什么拆

不是因为它有 8960 行。行数只是症状，真正的问题是三处耦合：

### 1.1 Plan 校验器写了两份

- 客户端：`index.html` 约 1133 行起，注释写着「与 `lib/codex/plan.mjs` 的 `validatePlan` 口径一致」。
- 服务端：`lib/codex/plan.mjs:618` 的 `validatePlan`。

两份实现靠注释和纪律维持一致，等于没有一致。后果是服务端接受、客户端拒绝（或反过来），而两边测试各自为政，谁都不会报错。V2 引入 `dims`、`DimAnchor`、`source`、稳定 id 后，这份 schema 的复杂度显著上升，漂移概率同步上升。

### 1.2 617 个顶层声明共享一个全局作用域

所有函数、常量、可变状态都在同一个 classic script 作用域里。这不是"存在两个文件"的问题——即便拆成十个文件，只要没有命名空间，加载顺序就变成隐式的依赖图，靠人记谁先谁后。

### 1.3 状态写入没有唯一入口

`PLAN` 与 `state` 是全局可变的。`mutate()` / `snap()` / `commit()` 已经存在，但没有强制约束，任何新代码都可以绕过。

---

## 2. 约束（不可破坏）

来自 `docs/contract.md` 与 `README.md`，这些是产品承诺，不是风格偏好：

1. **零构建**：没有 `npm install`、没有打包步骤。
2. **零依赖**：除 CDN 上的 three.js 外不引入第三方库。
3. **`file://` 可打开**：直接双击 `index.html`，2D/3D 编辑照常，AI 功能降级。
4. **原生 JS**：不引入 TypeScript、不引入框架。
5. **视觉与交互不变**：这是一次纯结构重构，不改行为。

**由 2 和 3 推导出的关键技术决定**：用 **classic script**（`<script src>`），**不用 ES module**。ES module 在 `file://` 下受 CORS 限制会被拦截；classic script 不受此限。

**关于框架**：不引入 React / Vue。这个应用的 DOM 只是一层薄壳，真正的绘制在 SVG 画布和 Three.js 里，框架不改善任何绘制路径，却要引入构建步骤并破坏约束 1、3。

---

## 3. 目标结构

`index.html` 只保留样式、DOM 骨架和按顺序的 script 标签。其余按现有注释分节边界切出。

| 文件 | 内容 | 当前行号 |
|---|---|---|
| `index.html` | 样式 + DOM + importmap + 装载 | 1–916 |
| `js/core.js` | 多语言、通用小工具、命名空间定义 | 917–1133 |
| `js/plan.js` | Plan V2 模型、迁移、房间/墙体查找 | 1133–1635 |
| `js/store.js` | 状态、历史、存储、撤销 | 1635–1684 |
| `js/geom.js` | 几何工具、颜色材质、家具图例 | 1684–1903 |
| `js/draw2d.js` | 2D 渲染、确定性检查的角标、尺寸绘制 | 1903–2201 |
| `js/checks.js` | 六条确定性检查 | 2201–2553 |
| `js/review.js` | 校核图层、尺寸锚点吸附、改尺寸移墙、合法性确认 | 2553–2875 |
| `js/panel.js` | 属性面板、窗/门/推拉门属性、尺寸面板 | 2875–3482 |
| `js/interact.js` | 操作、视图、吸附、指针交互、键盘、家具库 | 3482–3882 |
| `js/io.js` | 导入导出、2D/3D 切换、`window.Studio` | 3882–4528 |
| `js/import.js` | 图纸上传、结果预览、自动复核、复核大图 | 4528–5583 |
| `js/assistant.js` | 助手对话、效果图页签 | 5583–6468 |
| `js/projects.js` | 项目列表、方案、后台识别任务、任务条 | 6468–7046 |
| `js/tour.js` | 首次使用引导 | 7046–7205 |
| `js/view3d.js` | 3D 引擎（保持 `<script type="module">`） | 7205–8960 |

`js/view3d.js` 已经是 module，且位于文档末尾、只通过 `window.View3D` 对外，拆分风险最低，可以最后再做或不做。

### 3.1 命名空间约定

```js
// js/core.js 最先加载
globalThis.App = { core:{}, plan:{}, store:{}, geom:{}, draw:{},
                   checks:{}, review:{}, panel:{}, interact:{},
                   io:{}, importer:{}, assistant:{}, projects:{}, tour:{} };
```

规则：

1. 每个文件只往自己的命名空间挂东西，不定义裸顶层变量。
2. 跨文件只能通过 `App.x.y` 访问，不允许隐式依赖加载顺序的裸引用。
3. 文件头注释写明「依赖哪些 `App.*`」，`index.html` 里 script 标签的顺序必须与依赖一致。
4. 每个文件用 IIFE 包裹，避免中间变量泄漏到全局。

```js
// js/checks.js 骨架
(() => {
  'use strict';
  const { geom } = App;          // 显式声明依赖

  function checkOpenings(plan){ /* ... */ }

  App.checks = { run, checkOpenings, /* ... */ };
})();
```

### 3.2 状态写入唯一入口

保留现有 `mutate()` / `commit()` 机制，重构时收紧为：`App.store.apply(fn, label)` 是唯一的写入入口，所有改动经由它进撤销栈。拆完后加一条断言：仓库里不存在对 `PLAN.` 的直接赋值（`grep` 即可，作为测试项）。

---

## 4. 共享 Plan 校验器

### 4.1 做法

新建 `plan-schema.cjs`（项目根），同时被两个目标加载：

- **浏览器**：`<script src="plan-schema.cjs"></script>`，文件内部挂到 `globalThis.PlanSchema`。
- **服务端**：`server.mjs` 与 `lib/codex/plan.mjs` 用 `createRequire(import.meta.url)('../plan-schema.cjs')` 加载。

`.cjs` 后缀让 Node 在 `"type":"module"` 的项目里仍按 CommonJS 解析；浏览器不认后缀，只看 MIME。

文件形态：

```js
/* plan-schema.cjs — Plan V2 的唯一定义来源 */
(function (root) {
  'use strict';
  const PLAN_VERSION = 2;
  const WALL_KINDS = ['e', 'b', 'n', 'low'];
  // ... 常量、迁移、校验 ...

  const api = { PLAN_VERSION, WALL_KINDS, validatePlan, migrateV1, isPlanV2, /* ... */ };
  root.PlanSchema = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

### 4.2 配套改动

- `server.mjs` 的静态服务 MIME 表加 `.cjs` → `text/javascript`。
- `lib/codex/plan.mjs` 的 `validatePlan` 等改为从 `plan-schema.cjs` 转出，保持现有导出名不变，避免调用方改动。
- `index.html` 的客户端校验改为调用 `PlanSchema.validatePlan`，删除本地副本。
- 新增 `tests/plan-schema-parity.mjs`：对一组语料（125-C、空方案、迁移结果、若干非法输入）断言**只有一份实现**——即断言客户端与服务端拿到的是同一个函数引用/同一份输出，而不是比对两份实现的输出。

### 4.3 为什么不用"两份实现 + 一致性测试"

一致性测试只能发现已经发生的漂移，不能阻止漂移；而且语料永远覆盖不到新增字段。单一来源消灭整类 bug，代价是 `.cjs` 这个略微不常见的后缀，值得。

---

## 5. 实施顺序

**前置**：V2.0 完成、测试全绿、提交一次。现有工作区已有 2500+ 行未提交改动，先固化，否则重构和功能改动混在一起无法回退。

1. **建 worktree** 隔离重构。
2. **先做 §4 的共享校验器**。它是纯新增 + 替换，不涉及文件拆分，风险最低，且能立刻降低后续拆分的难度（`js/plan.js` 会薄很多）。
3. **逐文件提取**，从依赖最少的一端开始：`tour.js` → `assistant.js` → `projects.js` → `import.js` → `io.js` → `interact.js` → `panel.js` → `review.js` → `checks.js` → `draw2d.js` → `geom.js` → `store.js` → `plan.js` → `core.js`。`core.js` 最后，因为它承载命名空间本身。
4. **每提一个文件跑一次 `node tests/run.mjs`**。19 项自测是安全网；任何一次变红就停下修，不要连续提两个文件再测。
5. 全部拆完后补三条断言（见 §6）。
6. 单独提交，与 V2.0 的功能提交分开。

---

## 6. 验收

| 项 | 判据 |
|---|---|
| 行为不变 | `node tests/run.mjs` 19 项全过，且断言数量不少于拆分前 |
| 命名空间完整 | 加载后遍历 `Object.keys(App)`，每个子对象都有预期的方法名；缺一个即失败 |
| 无裸全局 | 扫描所有 `js/*.js`，顶层不得出现裸 `function` / `const` / `let` 声明（除 IIFE 内的） |
| 写入收敛 | 不存在 `PLAN.` 直接赋值的语句 |
| 校验器唯一 | `tests/plan-schema-parity.mjs` 通过；`grep -c "function validatePlan" index.html js/*.js` 结果为 0 |
| `file://` 可用 | 双击 `index.html`：2D 编辑、3D 场景、家具库、撤销全部可用；AI 操作给出降级提示 |
| 体积 | `index.html` 降到 1200 行以内；单文件不超过 1500 行 |

---

## 7. 风险

- **Safari 的 `file://` 子资源限制**。Chrome 与 Firefox 允许 `file://` 页面加载同目录 classic script；Safari 可能拦截。**这是唯一可能推翻方案的技术变量**，必须在动手前用 Safari 实测一次。若被拦，两选项：放弃 `file://` 承诺改为必须起本地服务；或退回单文件、只做 §4 的校验器统一与 §3.2 的写入收敛。
- **加载顺序变成隐式契约**。靠文件头注释和 script 标签顺序维持，容易在新增文件时出错。§6 的命名空间断言是主要防线；如后续仍出错，再考虑引入一个极小的顺序自检（每文件声明 `deps`，启动时校验已加载）。
- **大范围移动代码本身不产生价值**，且容易在移动过程中引入细微改动。纪律：只剪切粘贴，不在拆分的同时改逻辑；发现的问题单独记录，拆完再修。
- **与后续功能开发冲突**。重构期间应冻结 `index.html` 的功能改动，否则合并成本会迅速超过收益。

---

## 8. 明确不做

- 不引入构建工具、打包器、TypeScript。
- 不引入 React / Vue / 任何 UI 框架。
- 不改变 3D 引擎与 three.js 版本。
- 不在重构同时修改视觉、交互或业务逻辑。
- 不把 2D 引擎改成 Canvas 重绘架构（现有 SVG 方案与选中、吸附、虚线等交互深度耦合，重写不在本次范围）。
