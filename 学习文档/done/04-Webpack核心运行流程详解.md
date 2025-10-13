# Webpack 核心运行流程详解（按模块划分）

> 完整的模块化流程图 + 文件路径标注

## 一、总览：Webpack 的六大核心阶段

```
📦 Webpack 编译流程
    ↓
1️⃣ 初始化阶段（Initialization）
    ↓
2️⃣ 编译阶段（Compilation）
    ↓
3️⃣ 构建阶段（Make）⭐ 依赖图构建
    ↓
4️⃣ 封装阶段（Seal）
    ↓
5️⃣ 生成阶段（Emit）
    ↓
6️⃣ 输出阶段（Done）
```

---

## 二、阶段 1️⃣：初始化阶段

### 2.1 启动入口

```
用户执行: webpack / webpack-cli
    ↓
📄 bin/webpack.js
    ↓ 检查并加载 webpack-cli
    ↓
webpack-cli 解析命令行参数
    ↓
调用 webpack(config)
    ↓
📄 lib/webpack.js
```

### 2.2 配置处理

**文件路径**：`lib/webpack.js`

```javascript
// 1. 验证配置
webpackOptionsSchemaCheck(options)

// 2. 规范化配置
📄 lib/config/normalization.js
   └─ getNormalizedWebpackOptions(rawOptions)

// 3. 应用默认值
📄 lib/config/defaults.js
   ├─ applyWebpackOptionsBaseDefaults(options)
   └─ applyWebpackOptionsDefaults(options)
```

### 2.3 创建 Compiler

**文件路径**：`lib/Compiler.js` ⭐⭐⭐

```javascript
const compiler = new Compiler(context, options)
    ↓
初始化属性：
    ├─ compiler.hooks (钩子系统)
    ├─ compiler.options (配置)
    ├─ compiler.outputFileSystem (输出文件系统)
    └─ compiler.inputFileSystem (输入文件系统)
```

### 2.4 注册插件

```javascript
// 1. 应用 Node 环境插件
📄 lib/node/NodeEnvironmentPlugin.js
   └─ 提供文件系统能力

// 2. 注册用户插件
for (const plugin of options.plugins) {
    plugin.apply(compiler);
}

// 3. 应用内置插件
📄 lib/WebpackOptionsApply.js ⭐⭐
   └─ 根据配置注册内置插件
```

**关键流程**：`lib/WebpackOptionsApply.js`

```
WebpackOptionsApply.process(options, compiler)
    ↓
根据配置注册插件：
    ├─ 📄 lib/EntryPlugin.js (入口插件)
    ├─ 📄 lib/javascript/JavascriptModulesPlugin.js (JS 模块处理)
    ├─ 📄 lib/RuntimePlugin.js (运行时)
    ├─ 📁 lib/optimize/* (优化插件)
    ├─ 📄 lib/InferAsyncModulesPlugin.js
    └─ 更多内置插件...
```

---

## 三、阶段 2️⃣：编译阶段

### 3.1 开始编译

**入口**：`compiler.run()` 或 `compiler.watch()`

**文件路径**：`lib/Compiler.js`

```javascript
compiler.run(callback)
    ↓
compiler.hooks.beforeRun.callAsync()
    ↓
compiler.hooks.run.callAsync()
    ↓
compiler.compile(onCompiled)
```

### 3.2 创建 Compilation

**文件路径**：`lib/Compilation.js` ⭐⭐⭐

```javascript
compiler.compile()
    ↓
创建编译参数：
📄 lib/NormalModuleFactory.js ⭐⭐
📄 lib/ContextModuleFactory.js
    ↓
compiler.hooks.compile.call(params)
    ↓
创建 Compilation 实例：
compilation = new Compilation(compiler)
    ↓
compiler.hooks.make.callAsync(compilation)
```

**Compilation 的核心属性**：

```javascript
compilation = {
    modules: Set(),           // 所有模块
    chunks: Set(),           // 所有 chunk
    assets: {},              // 所有资源

    // ⭐ 核心：依赖图相关
    moduleGraph: ModuleGraph,      // 模块依赖图
    chunkGraph: ChunkGraph,        // Chunk 依赖图

    // 工厂
    moduleFactory: NormalModuleFactory,
    contextModuleFactory: ContextModuleFactory
}
```

---

## 四、阶段 3️⃣：构建阶段（Make）⭐⭐⭐

> 这是最核心的阶段，包含依赖图构建！

### 4.1 整体流程

```
compiler.hooks.make.callAsync(compilation)
    ↓
1️⃣ 添加入口
    ↓
2️⃣ 构建模块
    ↓
3️⃣ 解析依赖
    ↓
4️⃣ 构建依赖的模块（递归）
    ↓
5️⃣ 完成构建
```

### 4.2 添加入口

**触发插件**：`lib/EntryPlugin.js`

```javascript
compiler.hooks.make.tapAsync('EntryPlugin', (compilation, callback) => {
    compilation.addEntry(
        context,
        entryDependency,
        options,
        callback
    )
})
```

**文件路径**：`lib/Compilation.js`

```javascript
compilation.addEntry()
    ↓
compilation.addModuleTree()
    ↓
compilation.handleModuleCreation()
    ↓
compilation.factorizeModule() // 创建模块
    ↓
compilation.addModule()       // 添加到模块集合
    ↓
compilation.buildModule()     // 构建模块
```

### 4.3 模块工厂（创建模块）

**文件路径**：`lib/NormalModuleFactory.js` ⭐⭐⭐

```javascript
factorizeModule()
    ↓
moduleFactory.create(data)
    ↓
1️⃣ 解析模块路径：
   📄 lib/ResolverFactory.js
   └─ enhanced-resolve 库
       ↓
   解析结果: /absolute/path/to/module.js

2️⃣ 匹配 loader：
   根据 module.rules 匹配
   📄 lib/rules/*.js
       ↓
   结果: ['babel-loader', 'ts-loader']

3️⃣ 创建模块实例：
   📄 lib/NormalModule.js ⭐⭐
   └─ new NormalModule({
       type: 'javascript/auto',
       request: 'src/index.js',
       loaders: [...],
       parser: JavascriptParser,
       generator: JavascriptGenerator
   })
```

### 4.4 构建模块（核心！）

**文件路径**：`lib/NormalModule.js`

```javascript
module.build(options, compilation, resolver, fs, callback)
    ↓
1️⃣ 执行 loader：
   📦 loader-runner
   └─ 转换源码
       ↓
   结果: JavaScript 代码

2️⃣ 解析源码（AST）：
   📄 lib/javascript/JavascriptParser.js ⭐⭐
   └─ 使用 acorn 解析
       ↓
   结果: AST (抽象语法树)

3️⃣ 遍历 AST，收集依赖：
   遇到 import/require 等：
       ↓
   创建依赖对象：
   📁 lib/dependencies/
       ├─ 📄 HarmonyImportDependency.js (import)
       ├─ 📄 CommonJsRequireDependency.js (require)
       ├─ 📄 ImportDependency.js (dynamic import)
       └─ 115 个不同的依赖类型！

4️⃣ 添加依赖到模块：
   module.dependencies.push(dependency)
       ↓
   同时添加到 ModuleGraph：
   📄 lib/ModuleGraph.js ⭐⭐⭐
   └─ moduleGraph.addDependency(module, dependency)
```

### 4.5 依赖图构建（重点！）⭐⭐⭐

**核心文件**：
- `lib/ModuleGraph.js` - 模块依赖图主类
- `lib/ModuleGraphModule.js` - 图中的模块节点
- `lib/ModuleGraphConnection.js` - 模块之间的连接

**数据结构**：

```javascript
ModuleGraph {
    // 核心数据结构
    _dependencyMap: Map<Dependency, ModuleGraphConnection>
    _moduleMap: Map<Module, ModuleGraphModule>

    // 模块关系
    getModule(dependency) -> Module
    getParentModule(dependency) -> Module
    getIssuer(module) -> Module

    // 依赖关系
    getOutgoingConnections(module) -> Set<ModuleGraphConnection>
    getIncomingConnections(module) -> Set<ModuleGraphConnection>
}

ModuleGraphModule {
    // 模块在图中的信息
    incomingConnections: Set<ModuleGraphConnection>  // 谁依赖我
    outgoingConnections: Set<ModuleGraphConnection>  // 我依赖谁
    exports: ExportsInfo                              // 导出信息
    issuer: Module                                    // 谁引入了我
}

ModuleGraphConnection {
    // 连接信息
    originModule: Module        // 源模块
    resolvedModule: Module      // 目标模块
    dependency: Dependency      // 依赖对象
    active: boolean            // 是否激活
    conditional: boolean       // 是否条件依赖
}
```

**构建流程**：

```javascript
// 1. 构建模块时创建依赖
module.build()
    ↓
parser.parse(source)  // 解析源码
    ↓
遇到 import './a.js'
    ↓
创建 HarmonyImportDependency
    ↓
module.dependencies.push(dependency)

// 2. 处理依赖
compilation.processModuleDependencies(module)
    ↓
for (dependency of module.dependencies) {
    // 解析依赖
    factorizeModule(dependency)
        ↓
    创建依赖的模块 (dependencyModule)
        ↓
    // ⭐ 关键：建立图连接
    moduleGraph.setResolvedModule(
        originModule: module,
        dependency: dependency,
        module: dependencyModule
    )
        ↓
    // 内部创建 ModuleGraphConnection
    connection = new ModuleGraphConnection(
        originModule,
        dependency,
        dependencyModule
    )
        ↓
    // 添加到双向连接
    originModule.outgoingConnections.add(connection)
    dependencyModule.incomingConnections.add(connection)
        ↓
    // 递归构建依赖模块
    buildModule(dependencyModule)
}
```

### 4.6 递归构建

```javascript
compilation.handleModuleCreation(dependency)
    ↓
factorizeModule(dependency)
    ↓
addModule(module)
    ↓
buildModule(module)
    ↓
module.build()
    ↓
收集依赖 -> module.dependencies
    ↓
processModuleDependencies(module)
    ↓
对每个依赖递归调用 handleModuleCreation()
    ↓
... 直到没有新的依赖
```

**结果**：

```
完整的模块依赖图：

entry.js
  ├─ import a.js
  │    ├─ import c.js
  │    └─ import d.js
  └─ import b.js
       └─ import c.js (重复，共享)

ModuleGraph 中记录了：
- 所有模块
- 所有依赖关系
- 每个模块的导入导出信息
```

---

## 五、阶段 4️⃣：封装阶段（Seal）⭐⭐⭐

### 5.1 Seal 流程

**文件路径**：`lib/Compilation.js`

```javascript
compilation.seal()
    ↓
1️⃣ 创建 Chunk
    ↓
2️⃣ 优化模块和 Chunk
    ↓
3️⃣ 生成模块 ID 和 Chunk ID
    ↓
4️⃣ 生成代码
    ↓
5️⃣ 创建资源
```

### 5.2 创建 Chunk

```javascript
compilation.seal()
    ↓
// 触发钩子
compiler.hooks.seal.call()
    ↓
// 从入口创建 Chunk
for (const [name, { dependencies, options }] of compilation.entries) {
    const chunk = compilation.addChunk(name)

    // 将入口模块添加到 chunk
    📄 lib/ChunkGraph.js ⭐⭐
    chunkGraph.connectChunkAndEntryModule(
        chunk,
        module,
        entrypoint
    )
}
```

**ChunkGraph 结构**：

```javascript
ChunkGraph {
    // Chunk 和 Module 的多对多关系
    _chunks: Map<Chunk, ChunkGraphChunk>
    _modules: Map<Module, ChunkGraphModule>

    // 关系查询
    getChunkModules(chunk) -> Iterable<Module>
    getModuleChunks(module) -> Iterable<Chunk>

    // 运行时
    getChunkRuntimeModules(chunk) -> Iterable<RuntimeModule>
}
```

### 5.3 构建 Chunk 图

```javascript
// 从入口模块开始，遍历依赖图
buildChunkGraph(compilation)
    ↓
📄 lib/buildChunkGraph.js ⭐⭐
    ↓
遍历 ModuleGraph，将模块分配到 Chunk：
    ├─ 根据 import() 动态导入创建新 chunk
    ├─ 根据 optimization.splitChunks 拆分 chunk
    └─ 计算 chunk 之间的依赖关系
```

### 5.4 优化阶段

```javascript
// 优化模块
compiler.hooks.optimizeModules.call(modules)
    ↓
📁 lib/optimize/
    ├─ 📄 SideEffectsFlagPlugin.js (标记副作用)
    ├─ 📄 FlagDependencyUsagePlugin.js (标记使用)
    └─ 📄 ModuleConcatenationPlugin.js (模块合并)

// 优化 Chunk
compiler.hooks.optimizeChunks.call(chunks)
    ↓
📁 lib/optimize/
    ├─ 📄 SplitChunksPlugin.js ⭐⭐ (代码分割)
    ├─ 📄 RuntimeChunkPlugin.js (提取运行时)
    └─ 📄 RemoveEmptyChunksPlugin.js

// 优化模块 ID
compiler.hooks.optimizeModuleIds.call(modules)
    ↓
📁 lib/ids/
    ├─ 📄 DeterministicModuleIdsPlugin.js
    ├─ 📄 NamedModuleIdsPlugin.js
    └─ 📄 HashedModuleIdsPlugin.js

// 优化 Chunk ID
compiler.hooks.optimizeChunkIds.call(chunks)
    ↓
📁 lib/ids/
    ├─ 📄 DeterministicChunkIdsPlugin.js
    └─ 📄 NamedChunkIdsPlugin.js
```

### 5.5 生成代码

```javascript
compilation.createChunkAssets()
    ↓
for (const chunk of chunks) {
    // 生成代码模板
    📄 lib/javascript/JavascriptModulesPlugin.js ⭐⭐
        ↓
    renderMain(renderContext)
        ↓
    使用模板生成代码：
    📄 lib/Template.js
    📁 lib/runtime/*.js (运行时模板)
        ↓
    拼接模块代码：
        ├─ 运行时代码
        ├─ 模块包装代码
        └─ 各个模块的代码
            ↓
    生成 Source 对象：
    📦 webpack-sources
        ├─ RawSource
        ├─ ConcatSource
        └─ SourceMapSource
}
```

---

## 六、阶段 5️⃣：生成阶段（Emit）

### 6.1 Emit 流程

**文件路径**：`lib/Compiler.js`

```javascript
compiler.hooks.emit.callAsync(compilation)
    ↓
遍历 compilation.assets
    ↓
for (const [file, source] of assets) {
    写入到输出目录：
    outputFileSystem.writeFile(
        outputPath + file,
        source.buffer()
    )
}
```

### 6.2 生成文件

```
输出目录 (dist/)
    ├─ main.js (主 chunk)
    ├─ chunk-vendors.js (公共依赖)
    ├─ chunk-async.js (异步 chunk)
    ├─ main.js.map (source map)
    └─ manifest.json (资产清单)
```

---

## 七、阶段 6️⃣：完成阶段（Done）

```javascript
compiler.hooks.done.callAsync(stats)
    ↓
输出统计信息：
📄 lib/Stats.js
    ↓
compiler.close()
    ↓
清理资源：
    ├─ 关闭文件系统
    ├─ 关闭缓存
    └─ 关闭 watching
```

---

## 八、核心模块总结

### 8.1 最重要的文件（必读）⭐⭐⭐

| 文件 | 重要性 | 说明 |
|------|--------|------|
| `lib/Compiler.js` | ⭐⭐⭐ | 编译器核心，控制整个流程 |
| `lib/Compilation.js` | ⭐⭐⭐ | 编译实例，单次编译的核心 |
| `lib/ModuleGraph.js` | ⭐⭐⭐ | 模块依赖图，最重要的数据结构 |
| `lib/NormalModule.js` | ⭐⭐⭐ | 模块实现，理解模块构建 |
| `lib/NormalModuleFactory.js` | ⭐⭐⭐ | 模块工厂，创建模块 |

### 8.2 重要的文件（推荐）⭐⭐

| 文件 | 重要性 | 说明 |
|------|--------|------|
| `lib/ChunkGraph.js` | ⭐⭐ | Chunk 依赖图 |
| `lib/WebpackOptionsApply.js` | ⭐⭐ | 配置转插件 |
| `lib/javascript/JavascriptParser.js` | ⭐⭐ | JS 解析器 |
| `lib/javascript/JavascriptModulesPlugin.js` | ⭐⭐ | JS 代码生成 |
| `lib/optimize/SplitChunksPlugin.js` | ⭐⭐ | 代码分割 |

### 8.3 依赖相关文件（深入）⭐

| 文件/目录 | 说明 |
|----------|------|
| `lib/Dependency.js` | 依赖基类 |
| `lib/ModuleGraphConnection.js` | 模块连接 |
| `lib/ModuleGraphModule.js` | 图中的模块节点 |
| `lib/dependencies/` | 115 个依赖类型 |

---

## 九、依赖图构建详解（重点！）⭐⭐⭐

### 9.1 为什么需要依赖图？

**问题**：
- 如何知道一个模块被哪些模块引用？
- 如何判断一个模块的导出是否被使用（Tree Shaking）？
- 如何处理循环依赖？
- 如何优化 chunk 分割？

**答案**：依赖图（ModuleGraph）

### 9.2 ModuleGraph 的核心能力

```javascript
// 1. 查询依赖关系
moduleGraph.getIssuer(module)              // 谁引入了这个模块
moduleGraph.getIncomingConnections(module) // 所有指向这个模块的连接
moduleGraph.getOutgoingConnections(module) // 这个模块依赖的所有连接

// 2. 查询导出使用情况
const exportsInfo = moduleGraph.getExportsInfo(module)
exportsInfo.isExportUsed('foo')  // 导出 foo 是否被使用

// 3. 优化决策
moduleGraph.canConcatenate(moduleA, moduleB)  // 是否可以合并模块
moduleGraph.isAsync(module)                    // 是否异步模块
```

### 9.3 依赖图构建的关键点

**1. 双向连接**：

```javascript
// 从 A 模块导入 B 模块
connection = {
    originModule: A,
    dependency: importDep,
    module: B
}

// A 的出度
A.outgoingConnections.add(connection)

// B 的入度
B.incomingConnections.add(connection)
```

**2. 导出跟踪**：

```javascript
// 模块 A 导出 foo
module.buildInfo.exports = ['foo', 'bar']
    ↓
moduleGraph.setExportsInfo(module, exportsInfo)
    ↓
// 模块 B 导入 foo
import { foo } from './a'
    ↓
exportsInfo.getUsed('foo') = UsageState.Used
    ↓
// Tree Shaking: bar 未使用，可以删除
exportsInfo.getUsed('bar') = UsageState.Unused
```

**3. 循环依赖检测**：

```javascript
// A -> B -> C -> A (循环)
moduleGraph.setIssuer(B, A)
moduleGraph.setIssuer(C, B)
moduleGraph.setIssuer(A, C)  // 检测到循环

// 处理策略：
- 标记循环
- 调整模块顺序
- 插入临时变量
```

### 9.4 依赖图的应用场景

1. **Tree Shaking**：
   - 分析哪些导出未使用
   - 删除死代码

2. **代码分割**：
   - 分析模块共享情况
   - 决定哪些模块放到公共 chunk

3. **模块合并（Scope Hoisting）**：
   - 分析模块依赖关系
   - 决定哪些模块可以合并

4. **懒加载优化**：
   - 分析异步边界
   - 生成 import() 代码

---

## 十、完整流程图

```
用户代码 (src/index.js)
    ↓
┌──────────────────────────────────┐
│ 1️⃣ 初始化阶段                      │
│ bin/webpack.js                   │
│ lib/webpack.js                   │
│ lib/Compiler.js (new)            │
│ lib/WebpackOptionsApply.js       │
└──────────────────────────────────┘
    ↓
┌──────────────────────────────────┐
│ 2️⃣ 编译阶段                        │
│ compiler.compile()               │
│ lib/Compilation.js (new)         │
│ lib/NormalModuleFactory.js       │
└──────────────────────────────────┘
    ↓
┌──────────────────────────────────┐
│ 3️⃣ 构建阶段 ⭐⭐⭐                  │
│ ┌──────────────────────────────┐ │
│ │ compilation.addEntry()       │ │
│ │   ↓                          │ │
│ │ factorizeModule()            │ │
│ │   ↓                          │ │
│ │ lib/NormalModule.js (new)    │ │
│ │   ↓                          │ │
│ │ module.build()               │ │
│ │   ├─ loader-runner          │ │
│ │   ├─ JavascriptParser        │ │
│ │   └─ 收集依赖                │ │
│ │       ↓                      │ │
│ │ lib/ModuleGraph.js           │ │
│ │   ├─ addDependency()         │ │
│ │   └─ setResolvedModule()     │ │
│ │       ↓                      │ │
│ │ processModuleDependencies()  │ │
│ │   └─ 递归构建依赖模块        │ │
│ └──────────────────────────────┘ │
└──────────────────────────────────┘
    ↓
┌──────────────────────────────────┐
│ 4️⃣ 封装阶段 ⭐⭐⭐                  │
│ compilation.seal()               │
│   ├─ 创建 Chunk                  │
│   │   lib/Chunk.js               │
│   │   lib/ChunkGraph.js          │
│   ├─ 优化模块                    │
│   │   lib/optimize/*             │
│   ├─ 优化 Chunk                  │
│   │   SplitChunksPlugin          │
│   ├─ 生成 ID                     │
│   │   lib/ids/*                  │
│   └─ 生成代码                    │
│       JavascriptModulesPlugin    │
└──────────────────────────────────┘
    ↓
┌──────────────────────────────────┐
│ 5️⃣ 生成阶段                        │
│ compiler.hooks.emit.call()       │
│ 写入文件到 dist/                 │
└──────────────────────────────────┘
    ↓
┌──────────────────────────────────┐
│ 6️⃣ 完成阶段                        │
│ compiler.hooks.done.call()       │
│ 输出统计信息                     │
└──────────────────────────────────┘
```

---

## 十一、学习建议

### 11.1 学习顺序

**Week 1**：初始化流程
- ✅ bin/webpack.js
- ✅ lib/webpack.js
- ⏳ lib/Compiler.js (第 1-500 行)

**Week 2**：编译和构建
- ⏳ lib/Compiler.js (完成)
- ⏳ lib/Compilation.js (第 1-1000 行)
- ⏳ lib/NormalModuleFactory.js

**Week 3**：依赖图 ⭐
- ⏳ lib/Dependency.js
- ⏳ lib/ModuleGraph.js
- ⏳ lib/ModuleGraphModule.js
- ⏳ lib/ModuleGraphConnection.js

**Week 4**：模块和解析
- ⏳ lib/NormalModule.js
- ⏳ lib/javascript/JavascriptParser.js
- ⏳ lib/dependencies/ (常用依赖)

**Week 5**：Chunk 和优化
- ⏳ lib/Chunk.js
- ⏳ lib/ChunkGraph.js
- ⏳ lib/optimize/SplitChunksPlugin.js

### 11.2 调试建议

**断点位置**：

1. `lib/webpack.js:134` - 开始创建 compiler
2. `lib/Compiler.js:compile()` - 开始编译
3. `lib/Compilation.js:addEntry()` - 添加入口
4. `lib/NormalModule.js:build()` - 构建模块
5. `lib/ModuleGraph.js:setResolvedModule()` - 建立依赖关系
6. `lib/Compilation.js:seal()` - 封装阶段

---

## 十二、总结

### 核心概念

1. **Compiler**：全局唯一，控制整个编译生命周期
2. **Compilation**：每次编译创建，管理模块和资源
3. **ModuleGraph**：最重要的数据结构，记录所有依赖关系
4. **ChunkGraph**：从 ModuleGraph 派生，管理 Chunk 关系
5. **Module**：代码单元，经过 loader 转换和 parser 解析
6. **Dependency**：依赖关系的抽象，连接两个模块

### 关键文件

**必读**（~5000 行）：
- lib/Compiler.js
- lib/Compilation.js
- lib/ModuleGraph.js
- lib/NormalModule.js
- lib/NormalModuleFactory.js

**推荐**（~3000 行）：
- lib/ChunkGraph.js
- lib/javascript/JavascriptParser.js
- lib/optimize/SplitChunksPlugin.js

**深入**（根据兴趣）：
- lib/dependencies/ (115 个文件)
- lib/optimize/ (19 个文件)
- lib/runtime/ (29 个文件)

---

**下一步**：我将为依赖图相关的核心文件添加详细注释！
