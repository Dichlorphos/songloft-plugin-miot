# 工具问题沉淀

本文件记录项目开发过程中遇到的可复用工具问题，供后续代理快速定位、规避和验证。产品代码缺陷按 [issue-tracker.md](issue-tracker.md) 记录；一次性输入错误和短暂网络抖动无需写入。

## 记录范围

以下问题出现时应沉淀：

- 开发工具、CLI、构建、测试、包管理器或运行时故障；
- 操作系统、Shell、权限、路径、依赖或网络代理导致的非显然问题；
- 代理工具（文件操作、浏览器、搜索、连接器、子代理等）的故障或限制；
- 已找到但不易发现的解决方案、规避方案或环境前提；
- 尚未解决、会影响后续任务的重要问题。

记录应可复核，包含足够的原始错误和复现条件。若根因或解决方案未知，明确写为“未知”或“待确认”。

## 任务收尾

1. 在 `docs/agents/tool-issues.md` 中搜索工具名、错误信息和问题关键词。
2. 若已有相同条目，追加复现记录，并更新状态、根因、解决方案和验证结果。
3. 若是新问题，在“记录”下按模板新增条目。
4. 将该记录与当前任务变更一起提交；若本次任务没有可复用的工具问题，则跳过。

## 条目模板

### YYYY-MM-DD — <工具> — <问题简述>

- 状态：open / workaround / resolved
- 工具及版本：
- 环境：
- 现象：
- 原始错误：
- 根因：
- 解决方案或规避方案：
- 验证：
- 相关链接：
- 复现记录：
  - YYYY-MM-DD：

## 记录
### 2026-09-19 — Node.js 24 — 原生跑 TS 集成测试时无扩展名相对导入与裸 JSON 导入解析失败

- 状态：workaround
- 工具及版本：Node.js v24.21.0（原生类型剥离，`node --test "src/**/*.test.ts"`）
- 环境：Windows 11 + PowerShell；仓库为 ESM 风格 TS（`module: ESNext`），但 `package.json` 未声明 `"type": "module"`
- 现象：纯逻辑测试（只依赖 playback_sync 内的新文件）能跑；一旦测试导入仓库既有模块（如 `src/config/manager.ts`、`src/player/manager.ts`），Node 直接模块解析失败，测试文件整份报错退出，一条用例都不会执行。
- 原始错误：
  - `Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'D:\WorkSpace\songloft-plugin-miot\src\memory\types' imported from D:\WorkSpace\songloft-plugin-miot\src\config\manager.ts`
  - 越过该问题后出现：`TypeError [ERR_IMPORT_ATTRIBUTE_MISSING]: Module "file:///.../src/data/tts-commands.json" needs an import attribute of "type: json"`
  - 再往后：`SyntaxError: The requested module 'pako' does not provide an export named 'ungzip'`
- 根因：
  1. 既有源码为打包器（esbuild/Vite）编写，相对导入不带 `.ts` 扩展名；Node 原生 ESM 解析器不会自动补扩展名（打包器会）。新写的测试文件按 tsconfig 要求带 `.ts`，但被导入的旧文件不带。
  2. 旧代码裸 `import data from '.../tts-commands.json'`，Node 要求 import attribute。
  3. `player/manager.ts` 曾以值导入 `MinaService`（`import { MinaService }`），把 `service → mina → miio → pako` 整条宿主编译链拖进测试；`pako` 是 CJS，Node 具名导入解析不到 `ungzip`。
- 解决方案或规避方案：
  1. 新增 ESM 解析/加载钩子 `scripts/ts-resolve-hooks.mjs`：为无扩展名相对导入补 `.ts`/`.tsx`/`/index.ts`，并让 `.json` 以 JSON 模块加载；由 `scripts/register-ts-hooks.mjs` 注册。
  2. `package.json` 的 `test` 脚本改为 `node --import ./scripts/register-ts-hooks.mjs --test "src/**/*.test.ts"`。钩子只服务测试，不参与打包产物。
  3. 把 `player/manager.ts` 的 `MinaService` 改为 `import type`（该文件只把它当类型用），剪掉测试不需要的宿主依赖链；`tsconfig.test.json` 的 `include` 增加 `src/types/*.d.ts`，使链上所需的 `pako` 声明对测试可见。
- 验证：`npm test` 由 68 → 82 通过（含 6 条宿主集成测试）；`npm run typecheck`、`npm run build` 均通过；构建产物 entryHash 在改为 `import type` 前后一致，确认无行为变化。
- 相关链接：`scripts/ts-resolve-hooks.mjs`、`scripts/register-ts-hooks.mjs`、`.scratch/playback-sync/issues/02-switch-resume.md`
- 复现记录：
  - 2026-09-19：`node --test "src/playback_sync/switch_integration.test.ts"`（不带钩子）必现 `ERR_MODULE_NOT_FOUND`，指向 `src/memory/types`。

### 2026-09-19 — Node.js 24 test runner — 起播定时器导致测试进程不退出

- 状态：workaround
- 工具及版本：Node.js v24.21.0（`node --test`）
- 环境：Windows 11 + PowerShell
- 现象：集成测试所有断言都通过、并打印出 `✔`，但 `node --test` 迟迟不返回，进程一直挂着（表现为命令超时、CI 卡死）。
- 原始错误：无报错，纯粹不退出（事件循环被定时器占住）。
- 根因：`PlaylistManager.playCurrent()` 起播成功会注册自动切歌定时器（按歌曲时长，测试数据 200s）。测试直接 `new PlaylistManager` 后从不清理，`node --test` 会等待事件循环排空。
- 解决方案或规避方案：测试收尾对每个 `PlaylistManagerMap` 调 `cleanup()`（清理定时器与轮询）。集成测试里统一包在 `withHarness` 的 `finally` 中。
- 验证：加清理前后对比——加之前进程挂住不返回；加之后同一文件约 0.7s 内正常退出。
- 相关链接：`src/playback_sync/switch_integration.test.ts` 的 `withHarness`
- 复现记录：
  - 2026-09-19：删除 `withHarness` 中的 `h.playlistManagerMap.cleanup()` 即复现进程不退出。

### 2026-09-19 — 宿主单例 — 测试替换 globalThis.songloft 后单例缓存跨用例串数据

- 状态：workaround
- 工具及版本：仓库内 `src/playback_sync/index.ts` 的模块级单例（`getPlaybackRecorder` / `getSnapshotStore` / `getPendingContextStore`）
- 环境：Node.js v24.21.0；集成测试用内存 fake 替换全局 `songloft`
- 现象：多个集成用例依次替换 `globalThis.songloft` 后，后续用例读到前一个用例的内存 storage 内容（例如 pending 已被清除、或快照 revision 对不上），断言随机失败。
- 原始错误：无报错，表现为断言失败 + 数据串台。
- 根因：`getPlaybackRecorder()` 是模块级单例，首次调用即缓存了当时的宿主 storage 适配器；后续用例虽替换了全局 `songloft`，单例仍指向旧 fake。
- 解决方案或规避方案：每次安装新的 fake 宿主后调用 `resetPlaybackRecorderForTest()`（该函数同时重置 recorder / pendingStore / snapshotStore 三个单例），再构建被测对象。
- 验证：集成测试 6 条稳定通过；不调用重置时出现跨用例串台。
- 相关链接：`src/playback_sync/index.ts` 的 `resetPlaybackRecorderForTest`、`src/playback_sync/switch_integration.test.ts`
- 复现记录：
  - 2026-09-19：注释掉集成测试 `buildHarness` 中的 `resetPlaybackRecorderForTest()` 即复现。
