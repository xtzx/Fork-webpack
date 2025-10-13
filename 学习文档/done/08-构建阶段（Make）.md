# 🎯 Webpack 构建阶段（Make）深度解析

让我用通俗的语言和流程图为你讲解！

---

## 一、构建阶段的终极目标 ✅

**你的理解完全正确！**

**Make 阶段的目标 = 构建完整的依赖图**

```
输入：入口文件（entry.js）
输出：完整的依赖图（ModuleGraph）
      包含所有模块和它们之间的依赖关系
```

---

## 二、依赖图构建的完整流程（白话版）

### 🎬 故事化讲解

想象 webpack 是一个**侦探**，要找出一个项目中所有文件的关系：

#### **第 1 步：从入口开始**

```
侦探拿到线索：entry.js（入口文件）
侦探说："让我看看这个文件..."
```

#### **第 2 步：读取并解析文件**

```
📄 entry.js 内容:
import { foo } from './a.js';
import { bar } from './b.js';
console.log(foo, bar);

侦探说："哦！这个文件依赖了 a.js 和 b.js"
侦探记录：entry.js → [a.js, b.js]
```

#### **第 3 步：递归调查依赖**

```
侦探说："现在去看看 a.js"

📄 a.js 内容:
import { util } from './common.js';
export const foo = () => util();

侦探说："a.js 依赖 common.js"
侦探记录：a.js → [common.js]

侦探说："再看看 b.js"

📄 b.js 内容:
import { util } from './common.js';
export const bar = () => util();

侦探说："b.js 也依赖 common.js"
侦探记录：b.js → [common.js]

侦探说："最后看看 common.js"

📄 common.js 内容:
export const util = () => 'utility';

侦探说："common.js 不依赖任何人"
侦探记录：common.js → []
```

#### **第 4 步：绘制依赖图**

```
侦探拿出笔记本，画出关系图：

        entry.js
         ↙   ↘
       a.js  b.js
         ↘   ↙
       common.js

侦探说："完成！这就是整个项目的依赖关系"
```

---

## 三、技术流程图（带文件位置）

```
┌────────────────────────────────────────┐
│ 🚀 Make 阶段开始                        │
│ 触发: compiler.hooks.make.callAsync()  │
│ 位置: lib/Compiler.js:1872            │
└────────────────────────────────────────┘
                ↓
┌────────────────────────────────────────┐
│ 📍 步骤1: 添加入口模块                  │
│                                        │
│ EntryPlugin 监听 make 钩子:            │
│   compilation.addEntry(entryDep)      │
│                                        │
│ 位置: lib/EntryPlugin.js              │
│ 调用: lib/Compilation.js:addEntry()   │
└────────────────────────────────────────┘
                ↓
┌────────────────────────────────────────┐
│ 📍 步骤2: 创建入口模块                  │
│                                        │
│ factorizeModule(entryDep)              │
│   ↓                                    │
│ NormalModuleFactory.create()           │
│   ├─ 解析路径: './entry.js' → 绝对路径│
│   ├─ 匹配 loader                      │
│   └─ 创建 NormalModule 实例           │
│                                        │
│ 位置: lib/NormalModuleFactory.js      │
└────────────────────────────────────────┘
                ↓
┌────────────────────────────────────────┐
│ 📍 步骤3: 构建模块（最核心！）⭐⭐⭐     │
│                                        │
│ module.build()                         │
│   ↓                                    │
│ 3.1 执行 loader（转换文件）            │
│     loader-runner 执行 loader 链       │
│     babel-loader: ES6 → ES5           │
│     ts-loader: TS → JS                │
│     结果: JavaScript 代码              │
│   ↓                                    │
│ 3.2 解析代码（生成 AST）⭐              │
│     JavascriptParser.parse(source)    │
│     使用 acorn 库解析                  │
│     结果: 抽象语法树（AST）            │
│   ↓                                    │
│ 3.3 遍历 AST，收集依赖⭐⭐⭐            │
│     遇到 import './a.js'              │
│       → 创建 HarmonyImportDependency  │
│     遇到 require('./b.js')            │
│       → 创建 CommonJsRequireDependency│
│     遇到 import('./c.js')             │
│       → 创建 ImportDependency（动态）  │
│     结果: module.dependencies = [...]  │
│                                        │
│ 位置: lib/NormalModule.js:build()     │
│      lib/javascript/JavascriptParser.js│
└────────────────────────────────────────┘
                ↓
┌────────────────────────────────────────┐
│ 📍 步骤4: 建立图连接⭐⭐⭐               │
│                                        │
│ processModuleDependencies(module)      │
│                                        │
│ for (dependency of module.dependencies) {│
│   ↓                                    │
│   factorizeModule(dependency)          │
│     → 解析得到 targetModule           │
│   ↓                                    │
│   moduleGraph.setResolvedModule(       │
│     originModule,                      │
│     dependency,                        │
│     targetModule                       │
│   )                                    │
│   这一步建立了图的边！                 │
│   ↓                                    │
│   originModule.outgoingConnections     │
│     .add(connection)                   │
│   targetModule.incomingConnections     │
│     .add(connection)                   │
│ }                                      │
│                                        │
│ 位置: lib/Compilation.js              │
│      lib/ModuleGraph.js:586           │
└────────────────────────────────────────┘
                ↓
┌────────────────────────────────────────┐
│ 📍 步骤5: 递归构建依赖⭐                │
│                                        │
│ for (dependency of module.dependencies) {│
│   ↓                                    │
│   targetModule = resolve(dependency)   │
│   ↓                                    │
│   if (!已构建) {                       │
│     build(targetModule)  ← 递归！      │
│   }                                    │
│ }                                      │
│                                        │
│ 这个过程会一直递归，直到没有新的依赖    │
└────────────────────────────────────────┘
                ↓
┌────────────────────────────────────────┐
│ ✅ Make 阶段完成！                     │
│                                        │
│ 结果:                                  │
│ ├─ 所有模块都已构建                   │
│ ├─ 完整的依赖图（ModuleGraph）        │
│ ├─ 每个模块的导入导出信息             │
│ └─ 准备进入 Seal 阶段                 │
└────────────────────────────────────────┘
```

---

## 四、核心问题解答

### ❓ 问题1：如何判断依赖关系？读取 import 关键词还是 AST？

**答案：通过 AST 语法树！** ⭐⭐⭐

**详细流程**：

```
1. 读取源文件内容
   entry.js: "import { foo } from './a.js'"
   ↓
2. 使用 acorn 解析为 AST
   {
     type: "ImportDeclaration",
     source: {
       type: "Literal",
       value: "./a.js"
     },
     specifiers: [
       { type: "ImportSpecifier", imported: "foo" }
     ]
   }
   ↓
3. JavascriptParser 遍历 AST
   parser.hooks.import.tap('HarmonyImportDependencyPlugin', (statement) => {
     // 创建依赖对象
     const dep = new HarmonyImportDependency(
       './a.js',      // 模块路径
       ['foo'],       // 引入的名称
       statement.loc  // 源码位置
     );
     module.dependencies.push(dep);
   })
   ↓
4. 记录引用了哪些导出
   dependency.referencedExports = ['foo']  // 只引用 foo
```

**为什么用 AST 而不是字符串匹配？**

```javascript
// ❌ 字符串匹配的问题：
"import { foo } from './a.js'"  // 真正的 import
"// import { bar } from './b.js'"  // 注释，不是依赖
'const str = "import { baz } from \'./c.js\'"'  // 字符串，不是依赖

// ✅ AST 可以准确识别：
AST 知道哪些是真正的语句，哪些是注释或字符串
```

**位置**: `lib/javascript/JavascriptParser.js`

---

### ❓ 问题2：怎么判断一段代码没有用可以被删除？（Tree Shaking）

**阶段：Seal 阶段的优化子阶段** 🏷️

**判断流程**：

#### **第 1 步：记录模块提供了什么导出**

```
📄 a.js
export const foo = 1;  ← 导出 foo
export const bar = 2;  ← 导出 bar

ModuleGraph 记录:
a.js.exports = {
  foo: { provided: true, used: false },
  bar: { provided: true, used: false }
}
```

#### **第 2 步：分析哪些导出被使用**

```
📄 b.js
import { foo } from './a.js'  ← 只用了 foo

依赖分析:
dependency.getReferencedExports() → ['foo']

更新 ModuleGraph:
a.js.exports = {
  foo: { provided: true, used: true },   ← 标记为已使用
  bar: { provided: true, used: false }   ← 未使用
}
```

#### **第 3 步：删除未使用的导出（生成代码时）**

```
生成 a.js 的代码时:

// 检查导出使用情况
if (exportsInfo.getExportInfo('foo').used) {
  输出: __webpack_exports__.foo = 1;  ✅
}

if (exportsInfo.getExportInfo('bar').used) {
  // bar 未使用，不生成代码 ❌
}

最终代码:
// 只包含 foo，bar 被删除
__webpack_exports__.foo = 1;
```

**白话总结**：
1. 记录每个模块导出了什么
2. 记录每个依赖使用了什么
3. 对比找出未使用的导出
4. 生成代码时跳过未使用的部分

**关键文件**：
- `lib/Dependency.js:getReferencedExports()` - 记录使用了什么
- `lib/ModuleGraph.js:getExportsInfo()` - 查询导出信息
- `lib/optimize/SideEffectsFlagPlugin.js` - 标记副作用
- 生成代码阶段应用删除

---

### ❓ 问题3：怎么解决循环依赖问题？

**阶段：Make 阶段（构建时）+ Seal 阶段（排序时）** 🏷️

#### **检测循环依赖**：

```
场景:
a.js → b.js → c.js → a.js (循环！)

检测方法（DFS）:
visited = {}

function visit(module) {
  if (visited[module] === 'visiting') {
    发现循环！
    return;
  }

  visited[module] = 'visiting';  // 标记为正在访问

  for (dependency of module.dependencies) {
    targetModule = resolve(dependency);
    visit(targetModule);  // 递归
  }

  visited[module] = 'visited';  // 标记为已访问
}
```

#### **处理循环依赖**：

**webpack 不会阻止循环依赖，而是智能处理！**

```
处理策略：

1. 记录循环
   moduleGraph.setIssuer(c, b)
   moduleGraph.setIssuer(b, a)
   moduleGraph.setIssuer(a, c)  ← 检测到环

2. 调整加载顺序
   使用拓扑排序的变体
   确保至少有一个模块先初始化

3. 使用临时变量
   生成的代码：

   // a.js
   var b = __webpack_require__('./b.js');  // b 还未完全初始化
   exports.foo = function() { return b.bar(); }

   // b.js
   var a = __webpack_require__('./a.js');  // a 正在初始化
   exports.bar = function() { return a.foo(); }

   // 运行时可以工作，因为函数是延迟执行的
```

**警告但不报错**：

```
⚠️ WARNING in ./a.js
Module Warning (from ./node_modules/...):
Circular dependency detected:
a.js -> b.js -> c.js -> a.js
```

**关键文件**：
- `lib/Compilation.js` - 模块排序
- `lib/ModuleGraph.js` - 循环检测
- `lib/javascript/JavascriptModulesPlugin.js` - 生成处理循环的代码

---

### ❓ 问题4：动态加载原理是什么样的？（import()）

**阶段：Make 阶段识别 + Seal 阶段创建独立 Chunk** 🏷️

#### **识别动态导入（Make 阶段）**：

```javascript
// 源码
import('./lazy.js').then(module => {
  module.default();
});

// AST 解析
{
  type: "CallExpression",
  callee: { type: "Import" },  ← 识别为动态导入
  arguments: [
    { type: "Literal", value: "./lazy.js" }
  ]
}

// 创建特殊依赖
const dep = new ImportDependency('./lazy.js');
dep.async = true;  ← 标记为异步
module.addBlock(asyncBlock);  ← 创建异步块
```

#### **创建独立 Chunk（Seal 阶段）**：

```
Seal 阶段的处理：

1. 遍历所有模块的 asyncBlock

2. 为每个异步依赖创建新 Chunk
   entry.js (main chunk)
     ├─ a.js
     └─ import('./lazy.js') ← 创建新 chunk

   lazy.js (async chunk)
     └─ 独立的 chunk

3. 生成代码
   主 chunk (main.js):
   __webpack_require__.e("lazy")  // 加载 lazy chunk
     .then(() => __webpack_require__("./lazy.js"))

   异步 chunk (lazy.js):
   // lazy.js 的代码
   export default function() { ... }
```

**白话总结**：
- **Make 阶段**：识别 `import()` 语句，创建异步依赖
- **Seal 阶段**：为异步依赖创建独立的 Chunk
- **运行时**：通过 `__webpack_require__.e()` 动态加载 Chunk

**关键文件**：
- `lib/dependencies/ImportDependency.js` - 动态导入依赖
- `lib/AsyncDependenciesBlock.js` - 异步依赖块
- `lib/buildChunkGraph.js` - 构建 Chunk 图时处理异步

---

### ❓ 问题5：怎么实现的模块合并？（Scope Hoisting）

**阶段：Seal 阶段的优化子阶段** 🏷️

#### **合并条件判断**：

```
场景:
a.js:
  export const foo = 1;

b.js:
  import { foo } from './a.js';
  console.log(foo);

判断是否可以合并:
✅ a.js 只被 b.js 依赖（incomingConnections.size === 1）
✅ a.js 是 ES Module（可以静态分析）
✅ a.js 没有副作用
✅ a.js 没有异步依赖
✅ b.js 和 a.js 在同一个 Chunk

结果：可以合并！
```

#### **合并过程**：

```
合并前（两个独立模块）:

// Module a.js
__webpack_modules__['./a.js'] = function() {
  __webpack_exports__.foo = 1;
}

// Module b.js
__webpack_modules__['./b.js'] = function() {
  const a = __webpack_require__('./a.js');
  console.log(a.foo);
}

合并后（内联到一起）:

// 合并的模块
__webpack_modules__['./b.js'] = function() {
  // a.js 的代码直接内联
  const foo = 1;

  // b.js 的代码
  console.log(foo);  // 直接使用变量，不需要 require
}

性能提升：
- 减少模块数量
- 减少 __webpack_require__ 调用
- 减少运行时开销
```

**关键文件**：
- `lib/optimize/ModuleConcatenationPlugin.js` - 模块合并插件
- `lib/ModuleGraph.js` - 分析依赖关系

---

### ❓ 问题6：SplitChunksPlugin 配置如何实现？

**阶段：Seal 阶段的 optimizeChunks 钩子** 🏷️

让我逐个讲解每个配置：

#### **6.1 minSize（最小体积）**

```javascript
配置: minSize: 20000  // 20KB

实现原理:

for (const module of 候选公共模块) {
  let totalSize = 0;

  // 计算模块总大小
  for (const m of relatedModules) {
    totalSize += m.size();
  }

  if (totalSize < minSize) {
    跳过该模块，不提取  ❌
  } else {
    提取到公共 chunk  ✅
  }
}

白话：只有大于 20KB 的公共代码才值得提取，
     小的代码提取反而增加HTTP请求，得不偿失
```

#### **6.2 chunks（选择哪些 chunk）**

```javascript
配置: chunks: 'all' | 'async' | 'initial'

实现原理:

for (const chunk of compilation.chunks) {
  // 根据配置过滤
  if (chunks === 'async' && !chunk.canBeInitial()) {
    处理该 chunk  ✅  // 只处理异步 chunk
  }
  else if (chunks === 'initial' && chunk.canBeInitial()) {
    处理该 chunk  ✅  // 只处理入口 chunk
  }
  else if (chunks === 'all') {
    处理该 chunk  ✅  // 处理所有 chunk
  }
  else {
    跳过  ❌
  }
}

白话：
- 'all': 同步和异步代码都提取公共部分
- 'async': 只提取异步加载的公共部分
- 'initial': 只提取入口的公共部分
```

#### **6.3 maxAsyncRequests（最大异步请求数）**

```javascript
配置: maxAsyncRequests: 5

实现原理:

场景：一个异步 chunk 依赖了 10 个公共模块

计算:
当前 chunk 的异步请求数 =
  1 (chunk 自己) +
  公共模块数量

if (异步请求数 > maxAsyncRequests) {
  // 选择最大的几个公共模块
  公共模块按大小排序
  只提取前 4 个  // maxAsyncRequests - 1
  其余的保留在原 chunk 中
}

白话：限制并行加载的文件数，避免：
- HTTP 连接过多
- 加载时间过长
- 浏览器压力过大
```

#### **6.4 enforce（强制分割）**

```javascript
配置:
cacheGroups: {
  vendor: {
    test: /node_modules/,
    enforce: true  ← 强制提取
  }
}

实现原理:

if (enforce === true) {
  忽略 minSize 限制  // 即使很小也提取
  忽略 maxAsyncRequests 限制
  忽略 maxInitialRequests 限制

  强制创建该 chunk！
}

白话：不管大小和请求数限制，必须提取！
     通常用于 vendor（第三方库）chunk
```

#### **6.5 实际执行流程**

```
SplitChunksPlugin.apply(compiler) {
  compiler.hooks.optimizeChunks.tap('SplitChunksPlugin', (chunks) => {

    // 1. 分析所有模块的共享情况
    for (module of compilation.modules) {
      chunks = getChunksContainingModule(module);
      if (chunks.size > 1) {
        // 该模块被多个 chunk 共享
        共享模块列表.push(module);
      }
    }

    // 2. 根据 cacheGroups 分组
    for (module of 共享模块) {
      for (cacheGroup of cacheGroups) {
        if (cacheGroup.test.test(module.identifier())) {
          分组结果[cacheGroup.name].push(module);
        }
      }
    }

    // 3. 应用大小和请求数限制
    for (group of 分组结果) {
      totalSize = calculateSize(group.modules);

      if (!group.enforce) {
        if (totalSize < minSize) continue;  // 跳过
        if (请求数 > maxAsyncRequests) continue;  // 跳过
      }

      // 4. 创建新 chunk
      const newChunk = compilation.addChunk(group.name);

      // 5. 移动模块到新 chunk
      for (module of group.modules) {
        chunkGraph.disconnectChunkAndModule(oldChunk, module);
        chunkGraph.connectChunkAndModule(newChunk, module);
      }
    }
  });
}
```

**关键文件**：`lib/optimize/SplitChunksPlugin.js`

---

### ❓ 问题7：Chunk 的 name 规则是什么？

**阶段：Seal 阶段创建 Chunk 时** 🏷️

#### **命名规则**：

```javascript
1. 入口 Chunk
   配置: entry: { main: './src/index.js' }
   Chunk name: 'main'  ← 使用入口名

2. 异步 Chunk（魔法注释）
   代码: import(/* webpackChunkName: "my-chunk" */ './lazy.js')
   Chunk name: 'my-chunk'  ← 使用注释指定的名称

3. 异步 Chunk（无注释）
   代码: import('./lazy.js')
   Chunk name: 数字 ID (如 0, 1, 2)
   或者根据内容生成哈希

4. 公共 Chunk（SplitChunksPlugin）
   配置:
   cacheGroups: {
     vendors: {
       test: /node_modules/,
       name: 'vendors'  ← 指定名称
     }
   }
   Chunk name: 'vendors'

5. 运行时 Chunk
   配置: optimization.runtimeChunk: { name: 'runtime' }
   Chunk name: 'runtime'
```

#### **实际例子**：

```javascript
// webpack.config.js
module.exports = {
  entry: {
    app: './src/app.js',
    admin: './src/admin.js'
  },
  optimization: {
    runtimeChunk: { name: 'runtime' },
    splitChunks: {
      cacheGroups: {
        vendor: {
          test: /node_modules/,
          name: 'vendors'
        },
        common: {
          minChunks: 2,
          name: 'common'
        }
      }
    }
  }
}

// 源码
// app.js
import './common.js';
import(/* webpackChunkName: "lazy" */ './lazy.js');

// 输出文件:
dist/
  ├─ runtime.js      ← 运行时 chunk
  ├─ app.js          ← 入口 chunk
  ├─ admin.js        ← 入口 chunk
  ├─ vendors.js      ← 公共依赖 chunk
  ├─ common.js       ← 公共代码 chunk
  └─ lazy.js         ← 异步 chunk
```

**关键代码**：
```javascript
// lib/Chunk.js
class Chunk {
  constructor(name) {
    this.name = name;  // chunk 名称
    this.id = null;    // chunk ID（数字或字符串）
  }
}
```

---

### ❓ 问题8：Bundle 和 Chunk 如何转换？

**阶段：Seal 阶段的最后 - 生成代码** 🏷️

#### **概念区分**：

```
Chunk（逻辑概念）:
- webpack 内部的模块组
- 包含一组相关的模块
- 在内存中

Bundle（物理文件）:
- 最终输出的文件
- Chunk 生成代码后的结果
- 在磁盘上

关系：1 个 Chunk = 1 个 Bundle（通常）
```

#### **转换流程**：

```
┌─────────────────────┐
│  Chunk (逻辑)        │
│                     │
│  name: 'main'       │
│  modules: [         │
│    entry.js,        │
│    a.js,            │
│    b.js             │
│  ]                  │
└─────────────────────┘
          ↓
    compilation.seal()
          ↓
┌─────────────────────┐
│ 生成代码（重点！）   │
│                     │
│ JavascriptModules   │
│ Plugin.renderMain() │
│                     │
│ 1. 生成运行时代码   │
│    __webpack_require__│
│    __webpack_modules__│
│                     │
│ 2. 包装每个模块     │
│    './entry.js': function(│
│      module,        │
│      exports,       │
│      __webpack_require__│
│    ) {              │
│      // 模块代码    │
│    }                │
│                     │
│ 3. 拼接成完整代码   │
│    使用 Source 对象 │
└─────────────────────┘
          ↓
┌─────────────────────┐
│  Source (中间)      │
│                     │
│  ConcatSource([     │
│    banner,          │
│    runtime,         │
│    modules          │
│  ])                 │
└─────────────────────┘
          ↓
    compilation.assets['main.js'] = source
          ↓
    emit 阶段
          ↓
┌─────────────────────┐
│  Bundle (文件)      │
│                     │
│  main.js           │
│  (function() {      │
│    // runtime       │
│    var modules = {} │
│    // module code   │
│  })()              │
└─────────────────────┘
```

#### **生成的代码结构**：

```javascript
// main.js (bundle)
(function(modules) {
  // ===== 运行时代码 =====
  var installedModules = {};

  function __webpack_require__(moduleId) {
    if (installedModules[moduleId]) {
      return installedModules[moduleId].exports;
    }
    var module = installedModules[moduleId] = {
      exports: {}
    };
    modules[moduleId].call(module.exports, module, module.exports, __webpack_require__);
    return module.exports;
  }

  // ===== 模块代码 =====
  return __webpack_require__('./entry.js');
})({
  // 每个模块的包装
  './entry.js': function(module, exports, __webpack_require__) {
    const a = __webpack_require__('./a.js');
    console.log(a.foo);
  },
  './a.js': function(module, exports, __webpack_require__) {
    exports.foo = 1;
  }
});
```

**关键文件**：
- `lib/javascript/JavascriptModulesPlugin.js` - 生成 JS 代码
- `lib/Template.js` - 代码模板
- `lib/runtime/*.js` - 运行时模块

---

## 五、完整的 Make 阶段流程图（带问题标注）

```
┌──────────────────────────────────────────────────┐
│           Make 阶段开始                           │
│     compiler.hooks.make.callAsync()              │
└──────────────────────────────────────────────────┘
                    ↓
        ┌───────────────────────┐
        │  添加入口模块          │
        │  EntryPlugin          │
        └───────────────────────┘
                    ↓
        ┌───────────────────────┐
        │  创建模块              │
        │  NormalModuleFactory  │
        └───────────────────────┘
                    ↓
┌──────────────────────────────────────────────────┐
│              构建模块 ⭐⭐⭐                        │
│                                                  │
│  1️⃣ 执行 loader                                  │
│     loader-runner                                │
│                                                  │
│  2️⃣ 解析代码（AST）⭐                            │
│     acorn.parse(source)                          │
│     ↓                                            │
│     Q: 如何判断依赖？                             │
│     A: 遍历 AST，识别 import/require            │
│                                                  │
│  3️⃣ 收集依赖                                     │
│     遇到 import ⇨ HarmonyImportDependency       │
│     遇到 import() ⇨ ImportDependency (异步)     │
│     遇到 require ⇨ CommonJsRequireDependency    │
│     ↓                                            │
│     Q: 动态加载如何识别？                         │
│     A: AST 识别 Import() CallExpression         │
│        标记为 async                              │
│                                                  │
│  4️⃣ 记录导出信息                                 │
│     export const foo ⇨ exports['foo']           │
│     module.buildInfo.exports = ['foo', 'bar']   │
│                                                  │
└──────────────────────────────────────────────────┘
                    ↓
        ┌───────────────────────┐
        │  建立图连接 ⭐⭐⭐      │
        │  moduleGraph          │
        │  .setResolvedModule() │
        └───────────────────────┘
                    ↓
        ┌───────────────────────┐
        │  递归构建依赖          │
        │  (重复上述流程)       │
        │  ↓                    │
        │  Q: 循环依赖？         │
        │  A: DFS 检测，        │
        │     调整加载顺序      │
        └───────────────────────┘
                    ↓
┌──────────────────────────────────────────────────┐
│           Make 阶段完成                           │
│                                                  │
│  结果：完整的依赖图                               │
│  - 所有模块                                      │
│  - 所有依赖关系                                  │
│  - 导入导出信息                                  │
└──────────────────────────────────────────────────┘
                    ↓
            [进入 Seal 阶段]
                    ↓
┌──────────────────────────────────────────────────┐
│           Seal 阶段（优化和生成）                 │
│                                                  │
│  1️⃣ 创建 Chunk                                   │
│     - 入口 chunk                                 │
│     - 异步 chunk (import())                     │
│                                                  │
│  2️⃣ 优化模块                                     │
│     ↓                                            │
│     Q: 如何判断代码没用？                         │
│     A: 分析 exports.used 标记                   │
│        未使用的导出不生成代码                    │
│                                                  │
│  3️⃣ 优化 Chunk                                   │
│     ↓                                            │
│     Q: SplitChunksPlugin 如何工作？             │
│     A: 分析模块共享情况                          │
│        应用 minSize、chunks、maxRequests 规则   │
│        创建公共 chunk                            │
│     ↓                                            │
│     Q: 模块合并如何实现？                         │
│     A: ModuleConcatenationPlugin                │
│        分析依赖关系，内联模块代码                │
│                                                  │
│  4️⃣ 生成 ID                                      │
│     DeterministicModuleIdsPlugin                │
│     DeterministicChunkIdsPlugin                 │
│     ↓                                            │
│     Q: Chunk name 规则？                         │
│     A: 入口名/魔法注释/cacheGroups.name         │
│                                                  │
│  5️⃣ 生成代码                                     │
│     JavascriptModulesPlugin                     │
│     ↓                                            │
│     Q: Bundle 和 Chunk 如何转换？                │
│     A: Chunk → 生成代码 → Source → Bundle      │
│                                                  │
└──────────────────────────────────────────────────┘
```

---

## 六、形象比喻

### 🏗️ Make 阶段 = 建筑工地的前期准备

```
1. 拿到建筑图纸（入口文件）
2. 查看需要哪些材料（依赖的模块）
3. 订购所有材料（构建所有模块）
4. 检查材料质量（执行 loader）
5. 记录材料清单（构建依赖图）

结果：所有材料准备就绪，清单完整
```

### 🏗️ Seal 阶段 = 正式施工

```
1. 规划施工区域（创建 Chunk）
2. 优化材料使用（Tree Shaking、代码分割）
3. 标记材料编号（生成 ID）
4. 组装成成品（生成代码）

结果：建筑完工，输出最终产品
```

---

## 七、关键数据结构的最终状态

### Make 阶段结束后的 ModuleGraph：

```javascript
ModuleGraph {
  // 所有模块
  modules: [
    entry.js,
    a.js,
    b.js,
    common.js
  ],

  // 依赖关系
  _dependencyMap: {
    entryDep1 → connection(entry → a),
    entryDep2 → connection(entry → b),
    aDep → connection(a → common),
    bDep → connection(b → common)
  },

  // 模块图节点
  _moduleMap: {
    entry.js: {
      incomingConnections: [],  // 入口无入边
      outgoingConnections: [entry→a, entry→b],
      exports: {},
      depth: 0
    },
    a.js: {
      incomingConnections: [entry→a],
      outgoingConnections: [a→common],
      exports: { foo: {provided: true, used: true} },
      depth: 1
    },
    b.js: {
      incomingConnections: [entry→b],
      outgoingConnections: [b→common],
      exports: { bar: {provided: true, used: true} },
      depth: 1
    },
    common.js: {
      incomingConnections: [a→common, b→common],  // 被共享
      outgoingConnections: [],
      exports: { util: {provided: true, used: true} },
      depth: 2
    }
  }
}
```

---

## 八、总结

### Make 阶段做了什么？

1. ✅ **读取所有源文件**
2. ✅ **执行 loader 转换**
3. ✅ **解析 AST 收集依赖**（通过 AST，不是字符串匹配）
4. ✅ **递归构建所有依赖**
5. ✅ **构建完整的依赖图**
6. ✅ **记录导入导出信息**

### 问题答案快速索引

| 问题 | 阶段 | 关键文件 |
|------|------|----------|
| 如何判断依赖？ | Make | JavascriptParser.js（AST） |
| 如何删除无用代码？ | Seal-优化 | SideEffectsFlagPlugin.js |
| 如何处理循环依赖？ | Make+Seal | ModuleGraph.js |
| 动态加载原理？ | Make识别+Seal创建 | ImportDependency.js |
| 模块合并？ | Seal-优化 | ModuleConcatenationPlugin.js |
| SplitChunks 配置？ | Seal-优化 | SplitChunksPlugin.js |
| Chunk 命名？ | Seal-创建 | Chunk.js |
| Bundle 转换？ | Seal-生成 | JavascriptModulesPlugin.js |

**核心理解**：
- **Make = 收集信息**（构建依赖图）
- **Seal = 应用优化**（利用依赖图优化）
- **依赖图是桥梁**（连接两个阶段）

---

希望这样的讲解方式更容易理解！有任何不清楚的地方可以继续问我 😊