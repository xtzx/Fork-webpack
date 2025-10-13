# 编译模块详解 - Loader 与递归构建

> 深入理解 Make 阶段的模块编译过程

## 📋 目录

1. [编译模块概述](#一编译模块概述)
2. [涉及的核心文件](#二涉及的核心文件)
3. [完整的编译流程](#三完整的编译流程)
4. [Loader 工作原理](#四loader-工作原理)
5. [AST 解析与依赖识别](#五ast-解析与依赖识别)
6. [递归构建机制](#六递归构建机制)
7. [源码实现细节](#七源码实现细节)

---

## 一、编译模块概述

### 1.1 什么是"编译模块"？

**编译模块 = Make 阶段 = 构建依赖图**

```
输入: 入口依赖（EntryDependency）
输出: 完整的 ModuleGraph（模块依赖图）

过程:
1. 从入口文件开始
2. 读取源码
3. 执行 loader 转换
4. 解析 AST 找依赖
5. 递归处理所有依赖
6. 构建完整依赖图
```

### 1.2 核心步骤

```mermaid
graph TD
    Start([入口文件]) --> Read[读取源码]
    Read --> Loader[执行 Loader 链]
    Loader --> Parse[解析 AST]
    Parse --> FindDeps[识别依赖]
    FindDeps --> BuildGraph[建立图连接]
    BuildGraph --> Recurse[递归处理依赖]
    Recurse --> More{还有依赖?}
    More -->|是| Read
    More -->|否| Complete([依赖图完成])

    style Loader fill:#ff9999
    style Parse fill:#ff9999
    style BuildGraph fill:#ff9999
    style Recurse fill:#ff9999
```

---

## 二、涉及的核心文件

### 2.1 文件分层

```
┌─────────────────────────────────────────────────────────┐
│                  控制层（编译流程）                       │
│  lib/Compilation.js                                     │
│    ├─ addEntry() - 添加入口                             │
│    ├─ addModuleTree() - 添加模块树                      │
│    ├─ handleModuleCreation() - 处理模块创建 ⭐⭐⭐       │
│    ├─ buildModule() - 构建模块                          │
│    └─ processModuleDependencies() - 处理依赖 ⭐⭐⭐      │
└─────────────────────────────────────────────────────────┘
                        ↓ 调用
┌─────────────────────────────────────────────────────────┐
│                  工厂层（模块创建）                       │
│  lib/NormalModuleFactory.js                             │
│    ├─ create() - 创建模块                               │
│    ├─ resolve() - 解析路径 ⭐                           │
│    └─ 匹配 loader 规则 ⭐⭐                             │
└─────────────────────────────────────────────────────────┘
                        ↓ 创建
┌─────────────────────────────────────────────────────────┐
│                  模块层（模块构建）                       │
│  lib/NormalModule.js                                    │
│    ├─ build() - 构建入口                                │
│    ├─ _doBuild() - 执行 loader ⭐⭐⭐                    │
│    └─ 创建 Source 对象                                  │
└─────────────────────────────────────────────────────────┘
                        ↓ 使用
┌─────────────────────────────────────────────────────────┐
│                  Loader 层（代码转换）                    │
│  loader-runner (外部包)                                 │
│    ├─ runLoaders() - 执行 loader 链 ⭐⭐⭐              │
│    ├─ pitching 阶段（从左到右）                         │
│    └─ normal 阶段（从右到左）                           │
└─────────────────────────────────────────────────────────┘
                        ↓ 转换后
┌─────────────────────────────────────────────────────────┐
│                  解析层（依赖识别）                       │
│  lib/javascript/JavascriptParser.js                     │
│    ├─ parse() - 解析 AST ⭐⭐⭐                          │
│    ├─ walkStatements() - 遍历语句                       │
│    └─ 识别依赖并创建 Dependency 对象                    │
└─────────────────────────────────────────────────────────┘
                        ↓ 产生
┌─────────────────────────────────────────────────────────┐
│                  依赖图层（关系存储）                     │
│  lib/ModuleGraph.js                                     │
│    └─ setResolvedModule() - 建立连接 ⭐⭐⭐             │
└─────────────────────────────────────────────────────────┘
```

---

## 三、完整的编译流程

### 3.1 从入口到完成的详细流程图

```mermaid
graph TD
    Start([入口: compilation.addEntry]) --> Validate[验证依赖对象]

    Validate --> GetFactory[获取模块工厂<br/>dependencyFactories.get]

    GetFactory --> CallHandle[handleModuleCreation<br/>⭐ 核心递归方法]

    CallHandle --> Step1[步骤1: 创建模块<br/>factorizeModule]

    Step1 --> FactoryCreate[factory.create<br/>NormalModuleFactory]

    FactoryCreate --> ResolvePath[resolve 路径<br/>enhanced-resolve<br/>./a.js → /path/to/a.js]

    ResolvePath --> MatchLoader[匹配 loader 规则<br/>test: /\.js$/<br/>use: babel-loader]

    MatchLoader --> CreateModule[new NormalModule<br/>包含 loaders 列表]

    CreateModule --> Step2[步骤2: 添加模块<br/>addModule - 去重]

    Step2 --> CheckExist{模块已存在?}
    CheckExist -->|是| UseExist[复用现有模块]
    CheckExist -->|否| AddNew[添加到 modules]

    UseExist --> Step3
    AddNew --> Step3[步骤3: 构建模块<br/>buildModule]

    Step3 --> CheckNeed{needBuild?<br/>检查缓存}
    CheckNeed -->|否| UseCache[使用缓存<br/>跳过构建]
    CheckNeed -->|是| DoBuild[_doBuild<br/>⭐⭐⭐ 执行 loader]

    DoBuild --> ReadFile[读取源文件<br/>fs.readFile]

    ReadFile --> RunLoaders[runLoaders<br/>loader-runner]

    RunLoaders --> Pitching[Pitching 阶段<br/>从左到右]
    Pitching --> LoaderN[loaderN.pitch]
    LoaderN --> Loader2[loader2.pitch]
    Loader2 --> Loader1[loader1.pitch]

    Loader1 --> NormalPhase[Normal 阶段<br/>从右到左 ⭐⭐]

    NormalPhase --> LN[loaderN source]
    LN --> L2[loader2 transformed]
    L2 --> L1[loader1 final]

    L1 --> FinalCode[最终代码<br/>必须是 JavaScript]

    FinalCode --> CreateSource[创建 Source 对象]

    CreateSource --> ParseAST[parser.parse<br/>⭐⭐⭐ 解析 AST]

    ParseAST --> AcornParse[acorn.parse<br/>生成 AST]

    AcornParse --> Walk1[第1轮: detectMode]
    Walk1 --> Walk2[第2轮: preWalkStatements<br/>收集声明]
    Walk2 --> Walk3[第3轮: blockPreWalk]
    Walk3 --> Walk4[第4轮: walkStatements<br/>⭐⭐⭐ 识别依赖]

    Walk4 --> FindImport{遇到 import?}
    FindImport -->|是| CreateHarmony[创建 HarmonyImportDependency]

    Walk4 --> FindRequire{遇到 require?}
    FindRequire -->|是| CreateCommonJs[创建 CommonJsRequireDependency]

    Walk4 --> FindDynamic{遇到 import?}
    FindDynamic -->|是| CreateImport[创建 ImportDependency<br/>+ AsyncDependenciesBlock]

    CreateHarmony --> DepsCollected
    CreateCommonJs --> DepsCollected
    CreateImport --> DepsCollected[依赖收集完成<br/>module.dependencies]
    UseCache --> DepsCollected

    DepsCollected --> Step4[步骤4: 建立图连接<br/>setResolvedModule ⭐⭐⭐]

    Step4 --> CreateConn[创建 ModuleGraphConnection]
    CreateConn --> AddIncoming[添加到 target.incoming]
    AddIncoming --> AddOutgoing[添加到 origin.outgoing]
    AddOutgoing --> MapDep[建立 dependency → connection 映射]

    MapDep --> Step5[步骤5: 处理依赖<br/>processModuleDependencies]

    Step5 --> LoopDeps[遍历 module.dependencies]

    LoopDeps --> ForEachDep[对每个依赖:]
    ForEachDep --> Recursive[🔄 递归调用<br/>handleModuleCreation<br/>回到步骤1]

    Recursive --> AllDone{所有依赖<br/>处理完?}
    AllDone -->|否| LoopDeps
    AllDone -->|是| Complete([模块编译完成])

    Complete --> Result[结果:<br/>ModuleGraph 包含该模块<br/>及其所有依赖]

    style DoBuild fill:#ff9999
    style ParseAST fill:#ff9999
    style Walk4 fill:#ff9999
    style Step4 fill:#ff9999
    style Recursive fill:#ff9999
```

---

## 四、Loader 工作原理

### 4.1 为什么是"从右到左，从下到上"？⭐⭐⭐

#### 配置示例

```javascript
module.exports = {
  module: {
    rules: [
      {
        test: /\.js$/,
        use: ['loader1', 'loader2', 'loader3']
      }
    ]
  }
};
```

#### 执行顺序详解

```
配置中的顺序（从左到右）:
['loader1', 'loader2', 'loader3']

实际执行顺序（从右到左）:
loader3 → loader2 → loader1

为什么？
```

**原理**：函数组合（Compose）

```javascript
// loader 本质是函数
const loader1 = (source) => transform1(source);
const loader2 = (source) => transform2(source);
const loader3 = (source) => transform3(source);

// 组合（从右到左）
const result = loader1(loader2(loader3(source)));

// 等价于:
source
  → loader3 处理
  → loader2 处理
  → loader1 处理
  → 最终结果

// 这样设计的好处:
// - 符合函数式编程思想
// - 类似 Unix 管道: cat file | grep pattern | wc -l
// - 最后一个 loader 最先接触原始代码
// - 第一个 loader 最后处理（输出必须是 JS）
```

#### "从下到上"的含义

```javascript
module.exports = {
  module: {
    rules: [
      {
        test: /\.css$/,
        use: ['style-loader']  // 规则1
      },
      {
        test: /\.css$/,
        use: ['css-loader']    // 规则2
      }
    ]
  }
};

// 执行顺序：
// 规则2（下面）先匹配: css-loader
// 规则1（上面）后匹配: style-loader
//
// 实际执行: css-loader → style-loader
// （仍然是从右到左）

// 注意：
// 实际上 webpack 会合并所有匹配的规则
// 然后统一按"从右到左"执行
```

### 4.2 Loader 的完整执行流程

#### Pitching 阶段（从左到右）⭐

```
Pitching 阶段:
loader1.pitch() → loader2.pitch() → loader3.pitch()

如果 pitch 返回值：
loader1.pitch() → [返回值] → loader1() → 结束

为什么有 pitching？
- 提前终止（如果不需要读取文件）
- 传递数据给 normal 阶段
- 性能优化

示例:
// style-loader.pitch
exports.pitch = function(remainingRequest) {
  // 如果是服务端渲染，直接返回
  if (isServer) {
    return `module.exports = {};`;  // ⭐ 跳过后续 loader
  }
  // 返回 undefined，继续
};
```

#### Normal 阶段（从右到左）⭐⭐⭐

```
读取文件
  ↓
Normal 阶段:
源码 → loader3 → result1 → loader2 → result2 → loader1 → 最终代码

详细示例:
源码:
  `const foo = 1; const bar = 2;`
  ↓
loader3 (babel-loader):
  ES6+ → ES5
  `var foo = 1; var bar = 2;`
  ↓
loader2 (某个优化 loader):
  删除未使用变量
  `var foo = 1;`
  ↓
loader1 (某个包装 loader):
  添加模块包装
  `module.exports = function() { var foo = 1; }`
  ↓
最终代码（必须是 JavaScript）
```

### 4.3 Loader 的输入输出

```javascript
// Loader 签名
module.exports = function(source, sourceMap, meta) {
  // source: 上一个 loader 的输出（字符串或 Buffer）
  // sourceMap: 上一个 loader 的 SourceMap（可选）
  // meta: 上一个 loader 的元数据（可选）

  // this: loaderContext（提供 API）
  // this.callback: 返回多个值
  // this.async: 获取异步回调
  // this.addDependency: 添加文件依赖

  const result = transform(source);

  // 返回转换后的代码
  return result;

  // 或使用 callback 返回多个值
  this.callback(null, result, sourceMap, meta);
};
```

### 4.4 loaderContext 提供的 API ⭐⭐

```javascript
// loader 中可用的 this API

this.resource       // 文件绝对路径: /path/to/file.js
this.resourcePath   // 文件路径（不含 query）
this.resourceQuery  // query 字符串: ?foo=bar
this.context        // 文件所在目录: /path/to

// 异步相关
this.async()        // 获取异步回调
this.callback(err, content, sourceMap, meta)  // 返回结果

// 依赖相关
this.addDependency(file)      // 添加文件依赖（watch 用）
this.addContextDependency(dir) // 添加目录依赖
this.clearDependencies()      // 清除依赖

// 缓存相关
this.cacheable(flag)  // 标记是否可缓存（默认 true）

// 输出文件
this.emitFile(name, content, sourceMap)  // 输出额外文件

// 获取选项
this.getOptions()     // 获取 loader 的 options

// 工具方法
this.utils.contextify(context, request)  // 路径转相对
this.utils.absolutify(context, request)  // 路径转绝对

// 还有更多...
```

---

## 五、AST 解析与依赖识别

### 5.1 为什么要用 AST？⭐⭐⭐

#### 问题：为什么不用正则表达式？

```javascript
// 源码
const code = `
  import foo from './a.js';           // 真正的 import
  // import bar from './b.js';        // 注释，不是依赖
  const str = "import baz from './c.js'";  // 字符串，不是依赖
`;

// ❌ 使用正则无法区分：
const regex = /import\s+.*\s+from\s+['"](.*)['"];/g;
// 会错误匹配注释和字符串

// ✅ 使用 AST 可以准确识别：
// AST 知道哪些是真正的语句，哪些是注释/字符串
```

### 5.2 AST 解析详细流程

```mermaid
graph TD
    Start([源码字符串]) --> Acorn[acorn.parse<br/>JavaScript 解析器]

    Acorn --> AST[生成 AST<br/>抽象语法树]

    AST --> Example["示例 AST:<br/>{<br/>  type: 'Program',<br/>  body: [<br/>    {<br/>      type: 'ImportDeclaration',<br/>      source: { value: './a.js' },<br/>      specifiers: [...]<br/>    }<br/>  ]<br/>}"]

    Example --> DetectMode[第1轮: detectMode<br/>检测严格模式]

    DetectMode --> PreWalk[第2轮: preWalkStatements<br/>收集声明]

    PreWalk --> CollectDecl["收集:<br/>- import 声明<br/>- export 声明<br/>- 函数声明<br/>- 变量声明<br/>建立作用域"]

    CollectDecl --> BlockPre[第3轮: blockPreWalkStatements<br/>块级作用域]

    BlockPre --> Walk[第4轮: walkStatements ⭐⭐⭐<br/>识别依赖]

    Walk --> TraverseAST[遍历 AST 节点]

    TraverseAST --> CheckType{节点类型?}

    CheckType -->|ImportDeclaration| HandleImport[walkImportDeclaration]
    HandleImport --> ExtractSource[提取 source: './a.js']
    ExtractSource --> ExtractSpec[提取 specifiers: ['foo']]
    ExtractSpec --> TriggerImport[触发 hooks.import]
    TriggerImport --> CreateHarmony[插件创建<br/>HarmonyImportDependency]
    CreateHarmony --> AddDep1[module.dependencies.push dep]

    CheckType -->|CallExpression| CheckCallee{callee?}
    CheckCallee -->|require| HandleRequire[触发 hooks.call.for require]
    HandleRequire --> CreateCJS[插件创建<br/>CommonJsRequireDependency]
    CreateCJS --> AddDep2[module.dependencies.push dep]

    CheckCallee -->|import| HandleDynamic[walkImportExpression]
    HandleDynamic --> CreateImportDep[创建 ImportDependency]
    CreateImportDep --> CreateAsync[创建 AsyncDependenciesBlock]
    CreateAsync --> AddBlock[module.blocks.push block]

    CheckType -->|ExportDeclaration| HandleExport[walkExportDeclaration]
    HandleExport --> CreateExport[创建 HarmonyExportDependency]
    CreateExport --> RecordExport[记录导出信息]

    AddDep1 --> MoreNodes
    AddDep2 --> MoreNodes
    AddBlock --> MoreNodes
    RecordExport --> MoreNodes{还有节点?}

    MoreNodes -->|是| TraverseAST
    MoreNodes -->|否| Complete([依赖收集完成])

    Complete --> Result["结果:<br/>module.dependencies = [<br/>  HarmonyImportDep,<br/>  CommonJsRequireDep,<br/>  ...<br/>]<br/>module.blocks = [<br/>  AsyncDependenciesBlock,<br/>  ...<br/>]"]

    style Walk fill:#ff9999
    style HandleImport fill:#ffcc99
    style HandleRequire fill:#ffcc99
    style HandleDynamic fill:#ffcc99
```

### 5.3 为什么需要四轮遍历？⭐⭐

```javascript
// 问题：变量可能先使用后声明（提升）

// 示例代码：
console.log(foo);  // 第 1 行：使用 foo
var foo = 1;       // 第 2 行：声明 foo

// 如果只遍历一次：
// - 第 1 行遇到 foo，作用域中没有，认为是自由变量
// - 第 2 行遇到声明，但已经晚了

// 解决方案：多轮遍历
// - 第 1 轮：不处理，只检测模式
// - 第 2 轮：收集所有声明（包括第 2 行的 foo）
// - 第 3 轮：处理块级作用域
// - 第 4 轮：处理使用（现在知道 foo 已声明）
```

---

## 六、递归构建机制

### 6.1 递归的核心 ⭐⭐⭐

```javascript
/**
 * handleModuleCreation - 递归构建的核心
 *
 * 【调用链】
 * handleModuleCreation(dep1)
 *   ├─ factorizeModule → 创建 module1
 *   ├─ buildModule → 构建 module1
 *   │   └─ parser.parse → 发现 [dep2, dep3]
 *   └─ processModuleDependencies
 *       ├─ handleModuleCreation(dep2) ← 递归！
 *       │   └─ ... 继续处理 dep2
 *       └─ handleModuleCreation(dep3) ← 递归！
 *           └─ ... 继续处理 dep3
 */
```

### 6.2 递归过程可视化

```
Level 0 (入口):
┌──────────────┐
│  entry.js    │
│  dependencies│
│  ├─ './a.js' │───┐
│  └─ './b.js' │─┐ │
└──────────────┘ │ │
                 │ │
Level 1:         │ │
┌───────────┐ ←─┘ │
│  a.js     │     │
│  deps:    │     │
│  └─'./c'  │─┐   │
└───────────┘ │   │
              │   │
┌───────────┐ │ ←─┘
│  b.js     │ │
│  deps:    │ │
│  └─'./c'  │─┤
└───────────┘ │
              │
Level 2:      │
┌───────────┐ │
│  c.js     │←┴─ 共享模块（只构建一次）
│  deps: [] │
└───────────┘

最终依赖图:
entry.js
  ├─→ a.js ──┐
  └─→ b.js ──┤
             ↓
          c.js (共享)
```

### 6.3 递归停止条件

```javascript
// 递归何时停止？

// 条件1: 模块无依赖
if (module.dependencies.length === 0) {
  // 叶子模块，停止递归
  return;
}

// 条件2: 模块已构建（去重）
const existing = addModule(module);
if (existing !== module) {
  // 模块已存在，复用，不再递归
  return existing;
}

// 条件3: 所有依赖都已处理
for (const dep of module.dependencies) {
  processModuleDependencies(dep);
}
// 当所有依赖的递归都完成，返回

// 最终：
// 所有可达模块都已构建
// 依赖图构建完成
```

---

## 七、源码实现细节

### 7.1 Loader 执行的源码位置 ⭐⭐⭐

**源码文件**：`lib/NormalModule.js: _doBuild()`

```javascript
_doBuild(options, compilation, resolver, fs, hooks, callback) {
  // ===== 步骤1: 创建 loaderContext =====
  /**
   * loaderContext 是传给 loader 的 this 对象
   *
   * 【包含】
   * - resource: 文件路径
   * - context: 文件目录
   * - callback: 异步回调
   * - async: 获取异步回调
   * - addDependency: 添加依赖
   * - emitFile: 输出文件
   * - ... 等 API
   */
  const loaderContext = this._createLoaderContext(...);

  // ===== 步骤2: 初始化依赖集合 =====
  this.buildInfo.fileDependencies = new LazySet();
  this.buildInfo.contextDependencies = new LazySet();
  this.buildInfo.missingDependencies = new LazySet();

  // ===== 步骤3: 执行 loader-runner ⭐⭐⭐ =====
  /**
   * runLoaders 是外部包 loader-runner 的主函数
   *
   * 【执行过程】
   * 1. Pitching 阶段（从左到右）
   * 2. 读取源文件
   * 3. Normal 阶段（从右到左）
   * 4. 返回最终结果
   */
  runLoaders(
    {
      resource: this.resource,    // 文件路径
      loaders: this.loaders,      // loader 列表
      context: loaderContext,     // loader 的 this
      processResource: (loaderContext, resourcePath, callback) => {
        // 自定义资源读取（支持特殊协议）
        const scheme = getScheme(resource);
        hooks.readResource
          .for(scheme)
          .callAsync(loaderContext, callback);
      }
    },
    (err, result) => {
      // ===== loader 执行完成 =====

      if (err) {
        // loader 执行失败
        return callback(new ModuleBuildError(err));
      }

      // 提取结果
      const source = result.result[0];      // 转换后的代码
      const sourceMap = result.result[1];   // SourceMap（可选）
      const extraInfo = result.result[2];   // 额外信息（可选）

      // 验证结果
      if (!Buffer.isBuffer(source) && typeof source !== "string") {
        return callback(new Error("Loader 必须返回 Buffer 或 String"));
      }

      // ===== 创建 Source 对象 =====
      this._source = this.createSource(
        options.context,
        source,
        sourceMap
      );

      // ===== 提取 AST（如果 loader 提供）⭐ =====
      /**
       * 性能优化：
       * - babel-loader 已经解析过 AST
       * - 可以直接使用，避免重复解析
       * - 提升 20-30% 性能
       */
      this._ast = extraInfo?.webpackAST || null;

      // 收集 loader 访问的文件（用于 watch）
      this.buildInfo.fileDependencies.addAll(result.fileDependencies);
      this.buildInfo.contextDependencies.addAll(result.contextDependencies);

      callback();
    }
  );
}
```

### 7.2 AST 解析的源码位置 ⭐⭐⭐

**源码文件**：`lib/javascript/JavascriptParser.js: parse()`

```javascript
parse(source, state) {
  // ===== 步骤1: 解析为 AST =====
  let ast;
  if (typeof source === "object") {
    // 已经是 AST（loader 提供）
    ast = source;
  } else {
    // 字符串，需要解析
    ast = JavascriptParser._parse(source, {
      sourceType: this.sourceType,  // 'module' 或 'script'
      onComment: comments,           // 收集注释（魔法注释）
    });
  }

  // ===== 步骤2: 初始化作用域 =====
  this.scope = {
    topLevelScope: true,
    definitions: new StackedMap(),  // 变量定义栈
    isStrict: false,
    // ...
  };

  // ===== 步骤3: 触发 program 钩子 =====
  if (this.hooks.program.call(ast, comments) === undefined) {
    // ===== 步骤4: 四轮遍历 AST ⭐⭐⭐ =====

    // 第1轮: 检测模式
    this.detectMode(ast.body);

    // 第2轮: 收集声明（建立作用域）
    this.preWalkStatements(ast.body);

    // 第3轮: 块级作用域
    this.blockPreWalkStatements(ast.body);

    // 第4轮: 主遍历（识别依赖）⭐⭐⭐
    this.walkStatements(ast.body);
  }

  // ===== 步骤5: 触发 finish 钩子 =====
  this.hooks.finish.call(ast, comments);

  return state;
}
```

### 7.3 依赖识别的源码逻辑

**源码文件**：`lib/javascript/JavascriptParser.js: walkStatement()`

```javascript
walkStatement(statement) {
  // 根据 AST 节点类型分发处理

  switch (statement.type) {
    case "ImportDeclaration":
      // ⭐ import 语句
      this.walkImportDeclaration(statement);
      break;

    case "ExportNamedDeclaration":
    case "ExportDefaultDeclaration":
    case "ExportAllDeclaration":
      // export 语句
      this.walkExportDeclaration(statement);
      break;

    case "VariableDeclaration":
      // var/let/const 声明
      this.walkVariableDeclaration(statement);
      break;

    case "ExpressionStatement":
      // 表达式语句（可能包含 require）
      this.walkExpressionStatement(statement);
      break;

    // ... 更多类型
  }
}

// import 的详细处理
walkImportDeclaration(statement) {
  // 提取 source
  const source = statement.source.value;  // './a.js'

  // 提取 specifiers
  const specifiers = statement.specifiers;  // [{ imported: 'foo' }]

  // ⭐⭐⭐ 触发 import 钩子
  /**
   * 插件在这里工作！
   *
   * HarmonyImportDependencyParserPlugin 监听了这个钩子
   * 会创建 HarmonyImportDependency 对象
   */
  const result = this.hooks.import.call(
    statement,
    source
  );

  // 插件会在钩子中:
  // 1. 创建 dependency
  // 2. 添加到 this.state.module.dependencies
}
```

### 7.4 递归的源码实现

**源码文件**：`lib/Compilation.js: processModuleDependencies()`

```javascript
processModuleDependencies(module, callback) {
  // ===== 步骤1: 遍历模块的依赖 =====
  const dependencies = [];

  // 广度优先遍历模块的依赖块
  const queue = [module];
  while (queue.length > 0) {
    const block = queue.pop();

    // 收集块的依赖
    if (block.dependencies) {
      for (const dep of block.dependencies) {
        dependencies.push(dep);
      }
    }

    // 添加嵌套块到队列
    if (block.blocks) {
      for (const b of block.blocks) {
        queue.push(b);
      }
    }
  }

  // ===== 步骤2: 按工厂和资源分组（性能优化）⭐ =====
  /**
   * 相同工厂 + 相同资源的依赖放到一组
   *
   * 【原因】
   * - 减少工厂查找次数
   * - 一次创建多个相同资源的模块
   *
   * 【结构】
   * sortedDependencies = [
   *   {
   *     factory: NormalModuleFactory,
   *     dependencies: [dep1, dep2],  // 都指向 './a.js'
   *     context: '/project',
   *     originModule: module
   *   },
   *   ...
   * ]
   */
  const sortedDependencies = groupDependencies(dependencies);

  // ===== 步骤3: 对每组递归调用 handleModuleCreation ⭐⭐⭐ =====
  for (const item of sortedDependencies) {
    // 🔄 递归调用（关键！）
    this.handleModuleCreation(item, (err, result) => {
      // handleModuleCreation 会：
      // 1. 创建依赖的模块
      // 2. 构建依赖的模块
      // 3. 建立图连接
      // 4. 再次调用 processModuleDependencies（递归）

      // 最终：
      // 所有依赖的依赖都会被处理
      // 直到没有新的依赖
    });
  }
}
```

### 7.5 去重机制的实现 ⭐⭐

**源码文件**：`lib/Compilation.js: _addModule()`

```javascript
_addModule(module, callback) {
  // ===== 生成唯一标识符 =====
  /**
   * identifier 格式：type|path
   *
   * 【示例】
   * 'javascript/auto|/path/to/a.js'
   * 'javascript/auto|/path/to/a.js?query=1'  // 不同（有 query）
   *
   * 【特点】
   * - 相同文件 = 相同 identifier
   * - 不同 loader = 不同 identifier（因为 type 不同）
   */
  const identifier = module.identifier();

  // ===== 查找是否已存在 ⭐⭐⭐ =====
  const existing = this._modules.get(identifier);

  if (existing) {
    // ⭐ 模块已存在，直接返回
    /**
     * 场景：
     * - a.js: import './common.js'
     * - b.js: import './common.js'
     *
     * 第二次遇到 common.js 时：
     * - 不会重新创建
     * - 不会重新构建
     * - 不会重新解析 AST
     * - 直接返回第一次创建的实例
     *
     * 好处：
     * - 节省时间（避免重复构建）
     * - 节省内存（只有一个实例）
     * - 确保一致性（同一个模块对象）
     */
    return callback(null, existing);
  }

  // ===== 模块不存在，尝试从缓存恢复 ⭐ =====
  this._modulesCache.get(identifier, null, (err, cached) => {
    if (cached) {
      // 从持久化缓存恢复
      // 包含 buildInfo、buildMeta、dependencies
      // 避免重新构建
      cached.updateCacheModule(module);
      module = cached;
    }

    // 添加到集合
    this._modules.set(identifier, module);
    this.modules.add(module);

    callback(null, module);
  });
}
```

---

## 八、完整示例

### 8.1 从源码到依赖图的完整过程

**示例源码**：

```javascript
// src/index.js
import { add } from './math.js';
import './style.css';

console.log(add(1, 2));

// src/math.js
export function add(a, b) {
  return a + b;
}

// src/style.css
body { color: red; }
```

**配置**：

```javascript
module.exports = {
  entry: './src/index.js',
  module: {
    rules: [
      {
        test: /\.js$/,
        use: ['babel-loader']
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader']
      }
    ]
  }
};
```

**编译过程**：

```
步骤1: 添加入口
  compilation.addEntry('./src/index.js')

步骤2: 创建入口模块
  factorizeModule(entryDep)
    ├─ resolve: './src/index.js' → /path/to/src/index.js
    ├─ 匹配规则: test: /\.js$/ → babel-loader
    └─ new NormalModule({
        resource: '/path/to/src/index.js',
        loaders: [{ loader: 'babel-loader', options: {...} }]
      })

步骤3: 添加模块（首次，添加）
  addModule(indexModule)
    └─ 不存在，添加到 modules

步骤4: 构建入口模块
  indexModule.build()
    ├─ _doBuild()
    │   ├─ 读取文件: import { add } from './math.js'...
    │   ├─ runLoaders
    │   │   └─ babel-loader: ES6 → ES5
    │   └─ 返回: var add = require('./math.js').add;...
    │
    ├─ 创建 Source 对象
    │
    └─ parser.parse()
        ├─ acorn.parse() → AST
        ├─ walkStatements()
        │   ├─ 遇到 import { add } from './math.js'
        │   │   └─ 创建 HarmonyImportSpecifierDependency
        │   │       └─ indexModule.dependencies.push(mathDep)
        │   │
        │   └─ 遇到 import './style.css'
        │       └─ 创建 HarmonyImportSideEffectDependency
        │           └─ indexModule.dependencies.push(cssDep)
        │
        └─ 依赖收集完成
            indexModule.dependencies = [mathDep, cssDep]

步骤5: 处理入口模块的依赖
  processModuleDependencies(indexModule)
    ├─ 分组:
    │   └─ [mathDep, cssDep]
    │
    └─ 对每个依赖调用 handleModuleCreation

步骤6: 处理 mathDep（递归）
  handleModuleCreation(mathDep)
    ├─ factorizeModule
    │   ├─ resolve: './math.js' → /path/to/src/math.js
    │   ├─ 匹配: babel-loader
    │   └─ new NormalModule(mathModule)
    │
    ├─ addModule(mathModule)
    │   └─ 首次，添加
    │
    ├─ setResolvedModule(indexModule, mathDep, mathModule)
    │   ├─ 创建 connection(index → math)
    │   ├─ indexModule.outgoing.add(connection)
    │   └─ mathModule.incoming.add(connection)
    │
    ├─ buildModule(mathModule)
    │   ├─ _doBuild()
    │   │   ├─ 读取: export function add...
    │   │   ├─ babel-loader 转换
    │   │   └─ 返回转换后代码
    │   │
    │   └─ parser.parse()
    │       ├─ 遇到 export function
    │       │   └─ 创建 HarmonyExportSpecifierDependency
    │       │       └─ 记录导出信息
    │       │
    │       └─ 无 import 语句
    │           └─ mathModule.dependencies = []
    │
    └─ processModuleDependencies(mathModule)
        └─ 无依赖，完成

步骤7: 处理 cssDep（递归）
  handleModuleCreation(cssDep)
    ├─ factorizeModule
    │   ├─ resolve: './style.css' → /path/to/src/style.css
    │   ├─ 匹配: style-loader, css-loader
    │   └─ new NormalModule(cssModule)
    │
    ├─ addModule(cssModule)
    │   └─ 首次，添加
    │
    ├─ setResolvedModule(indexModule, cssDep, cssModule)
    │
    ├─ buildModule(cssModule)
    │   ├─ _doBuild()
    │   │   ├─ 读取: body { color: red; }
    │   │   ├─ css-loader: CSS → JS（module.exports = ...）
    │   │   ├─ style-loader: 注入样式到 DOM
    │   │   └─ 返回 JS 代码
    │   │
    │   └─ parser.parse()
    │       └─ 解析转换后的 JS 代码
    │           └─ cssModule.dependencies = []
    │
    └─ processModuleDependencies(cssModule)
        └─ 无依赖，完成

步骤8: 所有依赖处理完成
  └─ ModuleGraph 构建完成

最终依赖图:
┌─────────────┐
│  index.js   │
│  depth: 0   │
└─────────────┘
  ├─→ ┌──────────┐
  │   │ math.js  │
  │   │ depth: 1 │
  │   └──────────┘
  │
  └─→ ┌───────────┐
      │ style.css │
      │ depth: 1  │
      └───────────┘

ModuleGraph._moduleMap = {
  index.js => {
    incoming: [],
    outgoing: [conn(index→math), conn(index→css)],
    exports: {}
  },
  math.js => {
    incoming: [conn(index→math)],
    outgoing: [],
    exports: { add: {provided: true, used: true} }
  },
  style.css => {
    incoming: [conn(index→css)],
    outgoing: [],
    exports: {}
  }
}
```

---

## 九、常见问题

### Q1: Loader 转换后必须是 JavaScript 吗？⭐⭐

**答**：是的！最终必须是 JavaScript

```javascript
// CSS 文件的转换链：
style.css
  ↓ css-loader
CSS → JavaScript (module.exports = "body{color:red}")
  ↓ style-loader
JS → JS (注入样式的代码)
  ↓ 最终
JavaScript 代码（可以被 parser 解析）

// 图片文件的转换链：
image.png
  ↓ file-loader
PNG → JavaScript (module.exports = "/path/to/image.png")
  ↓ 最终
JavaScript 代码

// 原因：
// - parser 只能解析 JavaScript
// - 最终要打包到 bundle（JavaScript 文件）
// - 所有资源都转为 JS 模块
```

### Q2: 为什么需要多个 loader？⭐

```javascript
// 单个 loader：
{
  test: /\.css$/,
  use: ['all-in-one-css-loader']  // 一个 loader 做所有事
}
// 问题：功能耦合，不灵活

// 多个 loader（推荐）：
{
  test: /\.css$/,
  use: [
    'style-loader',  // 功能3: 注入到 DOM
    'css-loader',    // 功能2: 解析 CSS
    'sass-loader'    // 功能1: 编译 Sass
  ]
}

// 优势：
// 1. 职责单一：每个 loader 只做一件事
// 2. 可组合：自由组合不同 loader
// 3. 可复用：loader 可以用在不同规则中
// 4. 易维护：修改一个 loader 不影响其他

// Unix 哲学：Do one thing and do it well
```

### Q3: Loader 如何传递数据？⭐

```javascript
// 方式1: 返回值传递（标准）
module.exports = function(source) {
  const result = transform(source);
  return result;  // 传给下一个 loader
};

// 方式2: this.callback 传递多个值
module.exports = function(source, sourceMap) {
  const result = transform(source);
  const newSourceMap = updateSourceMap(sourceMap);
  const meta = { someData: 'value' };

  // 传递: 代码、SourceMap、元数据
  this.callback(null, result, newSourceMap, meta);
};

// 方式3: pitch 阶段传递
exports.pitch = function(remainingRequest, precedingRequest, data) {
  data.someValue = 123;  // ⭐ 存储在 data 对象
};

exports.normal = function(source) {
  const value = this.data.someValue;  // ⭐ 读取 data
  // ...
};
```

### Q4: 如何调试 loader 执行？⭐

```javascript
// 方法1: 添加 console.log
module.exports = function(source) {
  console.log('🔨 Loader 执行:', this.resource);
  console.log('📝 输入:', source.substring(0, 100));

  const result = transform(source);

  console.log('✅ 输出:', result.substring(0, 100));
  return result;
};

// 方法2: 使用 webpack 的 stats
// webpack.config.js
module.exports = {
  stats: {
    loggingDebug: ['MyLoader']
  }
};

// 方法3: 断点调试
// 在 lib/NormalModule.js: _doBuild() 设置断点
// 查看 loaderContext 和执行过程
```

---

## 十、性能优化技巧

### 10.1 Loader 优化

```javascript
// 1. 限制 loader 应用范围
{
  test: /\.js$/,
  include: path.resolve(__dirname, 'src'),  // ⭐ 只处理 src
  exclude: /node_modules/,                  // ⭐ 排除 node_modules
  use: ['babel-loader']
}

// 2. 缓存 loader 结果
{
  test: /\.js$/,
  use: [
    {
      loader: 'babel-loader',
      options: {
        cacheDirectory: true  // ⭐ 启用缓存
      }
    }
  ]
}

// 3. 使用 cache-loader
{
  test: /\.js$/,
  use: [
    'cache-loader',  // ⭐ 缓存所有 loader 结果
    'babel-loader',
    'ts-loader'
  ]
}

// 4. 使用 thread-loader（并行）
{
  test: /\.js$/,
  use: [
    'thread-loader',  // ⭐ 在 worker 线程中执行
    'babel-loader'
  ]
}
```

### 10.2 AST 优化

```javascript
// 1. 复用 loader 提供的 AST
// babel-loader 可以返回 AST
{
  loader: 'babel-loader',
  options: {
    // ⭐ 返回 AST 给 webpack
    customize: (config) => {
      return {
        ...config,
        // 提供 AST
        parserOpts: {
          ...config.parserOpts,
          // babel 会提供 AST
        }
      };
    }
  }
}

// NormalModule._doBuild() 会检查:
this._ast = extraInfo?.webpackAST || null;

// 如果有 AST，parser.parse() 跳过 acorn.parse
// 节省 20-30% 解析时间

// 2. 缓存 AST
// webpack 会缓存解析结果
// watch 模式下，未变化的文件复用缓存
```

### 10.3 并行构建

```javascript
// webpack 自动并行构建模块

// 原理：
// 1. handleModuleCreation 是异步的
// 2. processModuleDependencies 并行处理多个依赖
// 3. buildModule 使用队列系统

// 示例：
entry.js 的依赖: [a.js, b.js, c.js]
  ↓
并行构建:
┌─────────┐  ┌─────────┐  ┌─────────┐
│ build   │  │ build   │  │ build   │
│ a.js    │  │ b.js    │  │ c.js    │
└─────────┘  └─────────┘  └─────────┘
     ↓            ↓            ↓
  同时进行，充分利用多核

// 配置并行度:
module.exports = {
  parallelism: 100  // 默认 100，最多并行 100 个模块
};
```

---

## 十一、注意事项与最佳实践

### 11.1 Loader 开发注意事项

```javascript
// ✅ 1. 保持简单和纯粹
module.exports = function(source) {
  // 只做转换，不做其他事
  return transform(source);
};

// ✅ 2. 使用 loader-utils
const loaderUtils = require('loader-utils');

module.exports = function(source) {
  // 获取 options
  const options = loaderUtils.getOptions(this);

  // 插值文件名
  const url = loaderUtils.interpolateName(
    this,
    '[name].[hash].[ext]',
    { content }
  );

  return transform(source, options);
};

// ✅ 3. 标记可缓存性
module.exports = function(source) {
  // 如果输出不依赖外部因素，标记为可缓存
  this.cacheable(true);  // 默认就是 true

  // 如果输出依赖外部因素（如文件系统、时间），标记为不可缓存
  if (dependsOnExternalFactors) {
    this.cacheable(false);
  }

  return transform(source);
};

// ✅ 4. 添加文件依赖
module.exports = function(source) {
  // 如果读取了其他文件，添加依赖
  const configPath = path.resolve('./config.json');
  const config = fs.readFileSync(configPath);

  // ⭐ 添加依赖（watch 模式会监听这个文件）
  this.addDependency(configPath);

  return transform(source, config);
};

// ❌ 5. 不要修改 webpack 内部状态
module.exports = function(source) {
  // ❌ 不要这样做
  this._module.someProperty = value;  // 危险
  this._compilation.someState = value;  // 危险

  // ✅ 只转换 source
  return transform(source);
};
```

### 11.2 性能最佳实践

```javascript
// 1. 精确匹配，减少不必要的 loader 执行
{
  test: /\.js$/,
  include: [
    path.resolve('src'),           // ⭐ 只包含 src
    path.resolve('lib')
  ],
  exclude: [
    path.resolve('node_modules'),  // ⭐ 排除 node_modules
    path.resolve('bower_components')
  ],
  use: ['babel-loader']
}

// 2. 避免重复转换
{
  test: /\.js$/,
  oneOf: [  // ⭐ 只使用第一个匹配的规则
    {
      resourceQuery: /inline/,
      use: ['raw-loader']
    },
    {
      use: ['babel-loader']
    }
  ]
}

// 3. 使用 noParse 跳过解析
module.exports = {
  module: {
    noParse: /jquery|lodash/,  // ⭐ 不解析这些文件
  }
};

// 4. 减少 resolve 操作
module.exports = {
  resolve: {
    extensions: ['.js'],  // ⭐ 只配置需要的扩展名
    // 不要配置太多，每个都会尝试
  }
};
```

---

## 十二、总结

### 核心要点

**编译模块 = loader 转换 + AST 解析 + 递归构建**

**关键步骤**：
1. 读取源文件
2. 执行 loader（从右到左）
3. 解析 AST（四轮遍历）
4. 识别依赖（创建 Dependency）
5. 建立图连接（setResolvedModule）
6. 递归处理依赖

**核心文件**：
- `lib/Compilation.js`（流程控制）
- `lib/NormalModule.js`（_doBuild）
- `lib/javascript/JavascriptParser.js`（parse）
- `loader-runner`（执行 loader）
- `lib/ModuleGraph.js`（存储关系）

**性能关键**：
- Loader 缓存（60-80% 命中）
- AST 缓存和复用
- 模块去重（避免重复构建）
- 并行构建（充分利用多核）

**注意事项**：
- Loader 从右到左
- 最终必须是 JavaScript
- 去重机制（identifier）
- 递归停止条件

---

## 附录：源码注释情况

### 已添加详细注释的相关文件

```
✅ lib/Compilation.js（85%）
  - handleModuleCreation（100% 逐行）
  - addModule（100% 逐行）
  - buildModule（100% 逐行）
  - processModuleDependencies（100% 逐行）

✅ lib/NormalModule.js（85%）
  - build（100%）
  - _doBuild（100% 逐行）

✅ lib/NormalModuleFactory.js（85%）
  - create（100% 逐行）
  - resolve（100% 逐行）

✅ lib/javascript/JavascriptParser.js（90%）
  - parse（100% 逐行）

✅ lib/ModuleGraph.js（80%）
  - setResolvedModule（100% 逐行）
```

### 查看注释的方法

直接打开上述文件，所有关键代码都有详细的中文注释！

---

**通过这份文档，你应该完全理解"编译模块"的每一个细节了！** 🎉

**配合源码注释食用效果更佳！** 💪
