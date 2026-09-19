// 测试用 ESM 解析/加载钩子。
//
// 背景：插件源码是为打包器写的，旧模块的相对导入不带扩展名，还会裸 import JSON；
// 而纯逻辑/集成测试要能直接用 Node 原生剥离类型执行。这个钩子只做三件事：
//   1. 给不带扩展名的相对导入补 .ts / .tsx / /index.ts；
//   2. 让 .json 以 JSON 模块加载，免去 import attribute；
//   3. 把 pako 这类 CJS 包改写成带具名导出的 shim，兼容 `import { ungzip } from 'pako'`。
// 只在 `npm test` 生效，不参与打包产物。

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

  // pako 是 CJS，Node 的具名导出探测认不出 ungzip/gzip 等名字，
  // 直接 `import { ungzip } from 'pako'` 会报 "does not provide an export named"。
  // 生成一个 shim：内部用 createRequire 取真实 CJS 导出，再补齐具名导出。
  if (url.includes('/node_modules/pako/')) {
    const cjsPath = fileURLToPath(url);
    const source = [
      `import { createRequire as __createRequire } from 'node:module';`,
      `const __require = __createRequire(${JSON.stringify(pathToFileURL(cjsPath).href)});`,
      `const __pako = __require(${JSON.stringify(cjsPath)});`,
      `export default __pako;`,
      `export const ungzip = __pako.ungzip;`,
      `export const gzip = __pako.gzip;`,
      `export const inflate = __pako.inflate;`,
      `export const deflate = __pako.deflate;`,
      `export const inflateRaw = __pako.inflateRaw;`,
      `export const deflateRaw = __pako.deflateRaw;`,
    ].join('\n');
    return { format: 'module', source, shortCircuit: true };
  }

  return nextLoad(url, context);
}
