// 回归守卫：路由注册必须全部发生在 registerPlaylistHandlers 的顶层，
// 绝不能嵌套在别的 handler 函数体里。
//
// 背景：把上游合并进 fork 时，git 自动合并把两侧各自新增的 `/player/song/remove`
// 都保留了，并吞掉了 `/player/favorite/toggle` 的闭合 `});`——于是第一份
// song/remove 被嵌进了 favorite handler 的函数体内（注册阶段不可达、成为死代码，
// 且一旦 favorite 分支新增非 return 路径就会在请求期间重复注册路由）。
// 语法合法、tsc 通过、既有 grep 式测试也发现不了。
//
// 用 TypeScript AST 检查：任何 `router.post/get/...(...)` 调用都不得位于
// 箭头函数 / 函数表达式内部（registerPlaylistHandlers 自身是函数声明，不算）。

import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete']);

test('playlist.ts：路由注册都必须在该 handler 注册函数的顶层', () => {
  const file = path.resolve('src/handlers/playlist.ts');
  const source = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);

  const nested: string[] = [];
  const seen = new Map<string, number>();

  function visit(node: ts.Node, insideCallback: boolean) {
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === 'router'
      && HTTP_METHODS.has(node.expression.name.text)
      && node.arguments.length > 0
      && (ts.isStringLiteral(node.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))) {
      const method = node.expression.name.text;
      const route = `${method.toUpperCase()} ${(node.arguments[0] as ts.StringLiteral).text}`;
      seen.set(route, (seen.get(route) ?? 0) + 1);
      if (insideCallback) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        nested.push(`${route} @ line ${line}`);
      }
    }
    const nowInside = insideCallback
      || ts.isArrowFunction(node)
      || ts.isFunctionExpression(node);
    ts.forEachChild(node, (child) => visit(child, nowInside));
  }

  visit(sf, false);

  assert.deepEqual(nested, [], `存在嵌套在其它 handler 内的路由注册（合并残留）：\n${nested.join('\n')}`);
  const dups = [...seen.entries()].filter(([, n]) => n > 1);
  assert.deepEqual(dups, [], `存在重复定义的路由：${dups.map(([r, n]) => `${r} x${n}`).join(', ')}`);
});
