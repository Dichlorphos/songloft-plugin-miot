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
### 2026-09-19 — Node.js 24 — CJS 包（pako）具名导入在测试中失败

- 状态：workaround
- 工具及版本：Node.js v24.21.0；pako 1.0.11（CJS）
- 环境：Windows 11；测试经 `scripts/register-ts-hooks.mjs` 钩子运行
- 现象：测试导入 `src/miio/client.ts` 时进程在模块链接阶段就崩，一条用例都不执行。
- 原始错误：`SyntaxError: The requested module 'pako' does not provide an export named 'ungzip'`
- 根因：`pako` 是 CJS 包，Node 的具名导出探测（cjs-module-lexer）认不出 `ungzip`/`gzip` 等名字 —— `import('pako')` 只有 `default`，没有具名导出。打包器会做 CJS/ESM 互操作，所以 `import { ungzip } from 'pako'` 在生产构建里没问题，只有 Node 原生跑测试时才暴露。
- 解决方案或规避方案：在 `scripts/ts-resolve-hooks.mjs` 的 `load` 里为 pako 的模块 URL 生成 shim：内部用 `createRequire` 取真实 `module.exports`，再显式 `export const ungzip = ...`。切勿在 shim 里 `import pako from '<自身 URL>'`——会造成自引用循环（`ReferenceError: Cannot access 'pako' before initialization`）。
- 验证：`node --import ./scripts/register-ts-hooks.mjs --test src/handlers/playlist_outcome.test.ts` 从模块加载失败变为 4 条用例通过；`npm test` 86 通过。
- 相关链接：`scripts/ts-resolve-hooks.mjs`、`src/miio/client.ts`
- 复现记录：
  - 2026-09-19：不带 pako shim 时导入 `src/handlers/playlist.ts`（间接依赖 `miio/client`）必现。

### 2026-09-19 — Songloft SDK Router — 手写 HTTPRequest 导致 handler 报 q.split is not a function

- 状态：resolved
- 工具及版本：`@songloft/plugin-sdk` 2.15.0（`createRouter` / `jsonResponse` / `parseQuery`）
- 环境：Node.js v24.21.0 测试
- 现象：用真实 `createRouter` 驱动 handler 做契约测试时，所有用例返回 `{"success":false,"error":"q.split is not a function"}`，看起来像业务失败，实为请求对象构造错误。
- 原始错误：`{"success":false,"error":"q.split is not a function"}`
- 根因：误以为 `HTTPRequest.query` 是 `Record<string,string>` 而传了 `{}`；SDK 类型里 `query: string`、`body: Uint8Array | null`，`parseQuery` 内部对字符串调 `split`。
- 解决方案或规避方案：构造请求时 `query: ''`，`body: new TextEncoder().encode(JSON.stringify(payload))`；读响应时 `HTTPResponse.body` 同样是字节，用 `new TextDecoder().decode(res.body)` 再 `JSON.parse`。
- 验证：修正后 4 条 handler 契约用例全绿。
- 相关链接：`src/handlers/playlist_outcome.test.ts`、`node_modules/@songloft/plugin-sdk/dist/index.d.ts` 的 `HTTPRequest`
- 复现记录：
  - 2026-09-19：把 `query` 传成对象即复现。

### 2026-09-19 — Node.js 24 — 运行时自检脚本无法直接加载 memory 模块

- 状态：open
- 工具及版本：Node.js v24.21.0（原生类型剥离）+ `scripts/register-ts-hooks.mjs`
- 环境：Windows 11 + 本项目仓库
- 现象：直接执行 `node --import ./scripts/register-ts-hooks.mjs <script>.mjs` 调用 `runMemoryV2SelfTest()` 时，模块加载阶段整份报错，自检一条都不执行。
- 原始错误：
  - `SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property is not supported in strip-only mode`，指向 `src/memory/memory_resolver.ts:57` 的 `constructor(private readonly index: MemoryEntityIndex) {}`。
- 根因：Node 原生类型剥离（strip-only）不支持 TS 参数属性（constructor parameter properties）。`src/memory/memory_resolver.ts` 使用了该语法，因此 memory 自检链无法在原生 Node 下加载。`npm test` 覆盖的测试目前不导入该文件，所以未暴露。
- 解决方案或规避方案：
  1. 需要跑 `runMemoryV2SelfTest()` 时，通过插件运行时或 `tsc` 编译产物执行，不要依赖 Node 原生 strip-only。
  2. 若要纳入 `npm test`，需先把参数属性改为显式字段赋值（或用支持参数属性的编译/转译链）。
- 验证：`node --import ./scripts/register-ts-hooks.mjs .codex-self-test.mjs` 必现上述错误；改用编译产物或插件内调用可绕过。
- 相关链接：`src/memory/self_test.ts`、`src/memory/memory_resolver.ts`、`src/handlers/memory.ts`
- 复现记录：
  - 2026-09-19：为验证“手动别名豁免淘汰”新增自检断言后，本地直跑自检脚本时必现。


### 2026-09-20 — npm run build — prebuild 脚本重写数据文件行尾，污染工作区

- 状态：workaround
- 工具及版本：Node.js v24.21.0；`scripts/fetch-holidays.mjs` + `scripts/build-pinyin-data.mjs`（`prebuild` 钩子）
- 环境：Windows 11 + PowerShell；仓库检出为 CRLF
- 现象：`npm run build`（以及 `npm run dev`）成功后，`git status` 凭空多出 4 个已修改文件，内容却没有任何语义变化。反复 checkout 后只要再 build 一次就会再次出现，容易被误提交进版本库。
- 原始错误：无报错。`git diff` 为空、`git diff --stat` 也是空，只有 `git status` 报 ` M`：
  - `src/data/holidays/2026.json`
  - `src/data/holidays/2027.json`
  - `src/data/holidays/index.ts`
  - `src/data/pinyin-map.ts`
  - 伴随警告：`warning: in the working copy of '…', LF will be replaced by CRLF the next time Git touches it`
- 根因：两个 prebuild 脚本用 `writeFileSync` 写数据文件时使用 `\n`，绕过 Git 的 `core.autocrlf` 检出转换。仓库里这几个文件按 CRLF 存储/检出，脚本重写成 LF-only 后，索引里内容哈希未变（Git 归一化后一致）但工作区字节与索引不一致，于是 `git status` 显示为已修改，而 `git diff` 无输出。
- 解决方案或规避方案：构建后、提交前执行 `git checkout -- src/data/holidays/2026.json src/data/holidays/2027.json src/data/holidays/index.ts src/data/pinyin-map.ts` 还原行尾。不要用 `git add -A` 一把梭，避免把行尾噪声带进提交。若要根治，可让 prebuild 脚本按 `.gitattributes`/`core.autocrlf` 写对应行尾，或给这几个文件加 `.gitattributes` 固定 `text eol=crlf`。
- 验证：`npm run build` 后 `git status --short` 出现上述 4 个 ` M`；`git --no-pager diff --numstat` 输出为空；`git checkout --` 后恢复干净。
- 相关链接：`scripts/fetch-holidays.mjs`、`scripts/build-pinyin-data.mjs`、`package.json` 的 `prebuild`
- 复现记录：
  - 2026-09-20：本次任务中 `npm run build` 两次，两次都在成功后出现同样 4 个假改动。

### 2026-09-21 — PowerShell here-string — 用 here-string 改 TS 源码会静默失效或误转义

- 状态：workaround
- 工具及版本：PowerShell 7 (pwsh) + `Set-Content`/`-Raw`；Node.js v24.21.0；仓库文件为 CRLF 检出
- 环境：Windows 11 + 本项目仓库；`exec_command` 的 `shell` 未显式指定时可能落到 bash
- 现象：用 `$raw.Replace(...)` 批量改 `src/**/*.ts` 时，脚本报“成功”但文件没变；换一种写法又报 `SyntaxError: Unexpected identifier`。
- 原始错误：
  - 静默：`Write-Output 'ok'` 打印了，但 `rg` 搜不到新代码，diff 里也没有对应 hunk。
  - 报错：`SyntaxError: Unexpected identifier 'playing'`，指向内容里的中文行。
- 根因（两个独立坑）：
  1. **CRLF/LF 不匹配**：仓库里 `src/main.ts`、`src/config/manager.ts` 等是 CRLF 检出，而 `Get-Content`/`Set-Content` 往返可能只保留一部分行尾；here-string 字面量里写的是 `\n`，`String.Replace` 找不到就**静默不替换**（`Replace` 不匹配不报错）。
  2. **here-string 的转义规则**：`@"..."@`（双引号 here-string）会展开 `$` 与反引号；把含 `${...}`、反引号的 TS 模板字面量塞进去，会被 PowerShell 先解释掉或外泄成语法错误。`@'...'@` 虽不展开，但里面的**单引号**又需配对，中文文案里用反引号包代码片段时极易踩。
- 解决方案或规避方案：
  1. 改文件统一**显式指定 `shell: 'powershell'`**，不要依赖默认 shell；混用 bash 时 `2>$null` 会被 bash 当成重定向，生成名为 `$null` 的垃圾文件。
  2. 替换前先归一化行尾：`s.replace(/\r\n/g, '\n')`，写完再统一按 LF 落盘（或保持仓库既有风格）。
  3. **改源码优先用 Node 脚本**（`node patch.cjs`）而不是 PowerShell here-string：模板字面量可原样书写，且开头必须做 `if (!s.includes(old)) throw` 断言，避免静默不替换。含反引号的文案改用字符串数组 `.join('\n')` 拼接，绕开模板字面量嵌套。
- 验证：本任务里同一处 `resumeAfterReload` 改动，用 PowerShell `.Replace` 静默失败一次；改成带断言的 Node 脚本后稳定生效，`npm test` 181 项、`npm run typecheck`、`npm run build` 全绿。
- 相关链接：`docs/agents/tool-issues.md` 的构建污染条目（同源 CRLF 问题）、`.scratch/playback-sync/` 下本次改动
- 复现记录：
  - 2026-09-21：本任务中 `.Replace` 静默 no-op 1 次，here-string 反引号误转义 3 次。
