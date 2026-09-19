// 测试用 ESM 解析/加载钩子。
//
// 背景：插件源码是为打包器写的，旧模块的相对导入不带扩展名，还会裸 import JSON；
// 而纯逻辑/集成测试要能直接用 Node 原生剥离类型执行。这个钩子只做两件事：
//   1. 给不带扩展名的相对导入补 .ts / .tsx / /index.ts；
//   2. 让 .json 以 JSON 模块加载，免去 import attribute。
// 只在 `npm test` 生效，不参与打包产物。

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HAS_EXTENSION = /\.[cm]?[jt]sx?$/;
const CANDIDATES = ['.ts', '.tsx'];

export async function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
  if (isRelative && !HAS_EXTENSION.test(specifier)) {
    for (const ext of CANDIDATES) {
      const candidate = new URL(specifier + ext, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return nextResolve(specifier + ext, context);
      }
    }
    for (const ext of CANDIDATES) {
      const candidate = new URL(specifier + '/index' + ext, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return nextResolve(specifier + '/index' + ext, context);
      }
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('.json')) {
    const source = readFileSync(fileURLToPath(url), 'utf8');
    return { format: 'json', source, shortCircuit: true };
  }
  return nextLoad(url, context);
}
