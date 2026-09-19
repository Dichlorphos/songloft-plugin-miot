// 注册上面的解析钩子；供 npm test 用 `node --import` 加载。

import { register } from 'node:module';

register('./ts-resolve-hooks.mjs', import.meta.url);
