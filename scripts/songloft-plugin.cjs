#!/usr/bin/env node
// @songloft/plugin-builder 的 CLI 包装：先装上 Windows `.cmd` spawn 补丁，再原样转发参数。
// 详见同目录 patch-win-cmd-spawn.cjs（为什么必须打这个补丁）。
//
// 直接调用 CLI 文件而不是 `songloft-plugin` bin，是为了保证补丁在 CLI 进程内生效：
// bin 会另起一个 node 进程，NODE_OPTIONS 之外的注入方式都够不着它。
require('./patch-win-cmd-spawn.cjs');

const { pathToFileURL } = require('node:url');
const { join } = require('node:path');

const cli = join(__dirname, '..', 'node_modules', '@songloft', 'plugin-builder', 'dist', 'cli.js');

import(pathToFileURL(cli).href).catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});