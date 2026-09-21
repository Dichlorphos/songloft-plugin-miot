# 合并残留：/player/song/remove 被重复注册且 favorite/toggle 未闭合

Type: task
Status: done
Blocked by: 无

## 问题

把上游 `upstream/main` 合并进 fork 时，`src/handlers/playlist.ts` **未被 git 标记为冲突**，但自动合并把两侧各自新增的 `/player/song/remove` 都保留了：

- fork 侧（`1e3d5e7`）该端点位于 `favorite/toggle` 之后，但**自身没有闭合 `});`**——它的闭合依赖随后紧邻的 `});`；
- 上游侧（`upstream/main`）同样新增了 `/player/song/remove`，且**带完整闭合**。

两侧拼在一起后：

- `favorite/toggle` 的 handler 只闭合到 `}`，其后那份 fork 版 `song/remove` 的 `router.post(...)` 被卷进 `favorite/toggle` 的**函数体内**（`depth=2`）；
- 那份「内层」注册在模块初始化时**不会执行**，但当用户调用 `/player/favorite/toggle` 时，会在请求处理期间**动态再注册一次 `/player/song/remove`**；
- 顶层的上游版（`depth=1`）才是实际生效的实现。

后果：语法合法（括号总量平衡）、`tsc` 通过、既有 grep 式契约测试也发现不了；实际行为是「同一路径被注册两次」+ 一份死代码，且收藏请求带有注册路由的副作用。

## 期望

- `src/handlers/playlist.ts` 中每个路由恰好注册一次，且全部位于注册函数的顶层；
- `/player/song/remove` 保留上游那份实现（注释更完整、与 `#465` 上游版本一致），删除 fork 侧的重复实现并补回 `favorite/toggle` 的闭合 `});`；
- 增加守卫测试，防止今后再出现「路由嵌套在别的 handler 内」或「同一路径重复定义」。

## 验收

- 新增 `src/handlers/playlist_route_registration.test.ts`：用 TypeScript AST 检查所有 `router.{get,post,put,delete}` 调用都不得位于箭头函数/函数表达式内部，且不得重复定义同一路径。
- 修复前该测试必须变红（实测报 `POST /player/song/remove @ line 908`），修复后转绿。
- `npm run typecheck`、`npm test`、`node frontend/tests/run.mjs`、`npm run validate`、`npm run build` 全部通过。

## Answer

已修复：

- 删除 fork 侧重复的 `song/remove` 实现（60 行，含其注释与多余的 `});`），补回 `favorite/toggle` 的闭合 `});`；
- 路由注册从 16 处降为 15 处，全部 `depth=1`，无重复、无嵌套；
- 新增 `src/handlers/playlist_route_registration.test.ts`（AST 守卫），修复前实测变红、修复后转绿。

**验证**：`npm test` 259 项通过、`npm run typecheck`、`node frontend/tests/run.mjs`、`npm run validate`、`npm run build` 全部通过。

## Comments

- 2026-09-21：`/code-review` 全局审核（Standards + Spec 双轴）时由 Spec 轴发现。因该文件未被标记为冲突，合并当日的 typecheck 与全部测试均未报警，属「静默合并破坏」。
