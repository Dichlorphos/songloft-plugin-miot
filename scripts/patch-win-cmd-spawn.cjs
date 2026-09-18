// Node >= 18.20.2 / 20.12.2 / 21.7.3（CVE-2024-27980 修复）在 Windows 上不再允许
// 无 shell 地 spawn `.cmd` / `.bat`：execFileSync('npm.cmd', ...) 直接抛
// `spawnSync npm.cmd EINVAL`。@songloft/plugin-builder 用这种写法调用前端构建，
// 于是 `npm run build` 与 `npm run dev` 在 Windows 上必然失败，降级 Node 也一样。
//
// 这里只做一件事：把 `.cmd` / `.bat` 的调用改经 cmd.exe 执行，其余调用原样透传。
// 非 Windows 平台完全不改行为，Linux CI 不受影响。
//
// 覆盖 execFileSync / execFile / spawnSync / spawn 四个入口。builder 目前用到的是
// execFileSync（npm install、npm run build、jsc），其余三个是为了将来不再次踩坑。
// 等 @songloft/plugin-builder 自己修好 Windows 调用后，本文件与 package.json 里的
// -r 注入可以一并删除。
const cp = require('node:child_process');

const isWindowsBatch = (file) =>
  process.platform === 'win32' && typeof file === 'string' && /\.(cmd|bat)$/i.test(file);

for (const name of ['execFileSync', 'execFile', 'spawnSync', 'spawn']) {
  const original = cp[name];
  if (typeof original !== 'function') continue;
  cp[name] = function patched(file, args, options) {
    if (!isWindowsBatch(file)) {
      return original.apply(this, arguments);
    }
    // 兼容 (file, args, options) 与 (file, options) 两种签名
    const argv = Array.isArray(args) ? args : [];
    const opts = (Array.isArray(args) ? options : args) || {};
    // 参数里可能带空格（如 Windows 用户名下的路径），逐个加引号交给 cmd.exe
    const line = [file, ...argv]
      .map((part) => (/[\s"]/.test(String(part)) ? `"${String(part).replace(/"/g, '\\"')}"` : String(part)))
      .join(' ');
    const cmd = process.env.ComSpec || 'cmd.exe';
    return original.call(this, cmd, ['/d', '/s', '/c', line], opts);
  };
}