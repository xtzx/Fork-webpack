# Compiler 钩子系统详解

> 基于已添加注释的 lib/Compiler.js

## 一、什么是钩子系统？

### 1.1 基本概念

**钩子（Hook）**是 webpack 插件系统的核心机制，基于 `tapable` 库实现。

```javascript
// 定义钩子
const hook = new SyncHook(['arg1', 'arg2']);

// 注册监听器（插件）
hook.tap('PluginName', (arg1, arg2) => {
    // 插件逻辑
});

// 触发钩子（webpack 内部）
hook.call(value1, value2);
```

### 1.2 四种钩子类型

| 钩子类型 | 说明 | 特点 |
|---------|------|-----|
| **SyncHook** | 同步钩子 | 按顺序依次调用，不能中断 |
| **SyncBailHook** | 同步熔断钩子 | 返回非 undefined 时停止 |
| **AsyncSeriesHook** | 异步串行钩子 | 依次异步调用，等待每个完成 |
| **AsyncParallelHook** | 异步并行钩子 | 同时触发所有监听器 |

---

## 二、Compiler 的 30+ 个钩子

### 2.1 初始化阶段（3 个）

```javascript
environment
    ↓ 准备环境（在 lib/webpack.js 中调用）
afterEnvironment
    ↓ 环境准备完成
initialize
    ↓ 初始化完成
```

**文件位置**: `lib/webpack.js:171-180`

**使用场景**:
- 设置全局配置
- 准备编译环境
- 初始化全局状态

### 2.2 编译流程主钩子（12 个）⭐⭐⭐

```
beforeRun
    ↓ 运行前准备（清理缓存等）
run
    ↓ 开始运行
beforeCompile
    ↓ 编译前准备（可以修改编译参数）
compile
    ↓ 开始编译
thisCompilation
    ↓ Compilation 实例创建
compilation
    ↓ Compilation 准备完成
make ⭐⭐⭐
    ↓ 构建模块（最重要！）
finishMake
    ↓ 模块构建完成
afterCompile
    ↓ 编译完成（包括 seal）
shouldEmit
    ↓ 判断是否输出
emit ⭐⭐
    ↓ 输出文件前（最后修改内容的机会）
afterEmit
    ↓ 输出完成
done ⭐
    ↓ 全部完成
```

**时间范围**:
- beforeRun 到 done: **整个编译周期**
- make 到 afterCompile: **核心构建过程**（最耗时）

### 2.3 监听模式钩子（4 个）

```javascript
watchRun        // watch 模式运行前（替代 run）
invalid         // 文件变化，编译无效化
watchClose      // 停止监听
shutdown        // 关闭编译器
```

### 2.4 工厂钩子（2 个）

```javascript
normalModuleFactory      // 普通模块工厂创建后
contextModuleFactory     // 上下文模块工厂创建后
```

**使用场景**:
- 注册模块工厂的钩子
- 修改 loader 解析规则
- 自定义模块类型

### 2.5 其他钩子（7 个）

```javascript
assetEmitted         // 单个资源输出后
failed               // 编译失败
afterDone            // done 后的同步钩子
additionalPass       // 需要额外编译轮次
readRecords          // 读取 records
emitRecords          // 写入 records
infrastructureLog    // 基础设施日志
afterPlugins         // 插件注册完成
afterResolvers       // 解析器初始化完成
entryOption          // 处理入口配置
```

---

## 三、核心钩子详解

### 3.1 make 钩子 ⭐⭐⭐

**最重要的钩子！所有模块构建都在这里发生。**

**触发位置**: `lib/Compiler.js:1872`

**执行流程**:

```javascript
compiler.hooks.make.callAsync(compilation, err => {
    // 所有插件在这里添加入口和构建模块
});
```

**谁在监听**:
- `EntryPlugin`: 添加入口模块
- `DllPlugin`: 添加 DLL 入口
- `DllReferencePlugin`: 引用 DLL
- `PrefetchPlugin`: 预取模块

**实际例子**:

```javascript
// EntryPlugin.js
compiler.hooks.make.tapAsync('EntryPlugin', (compilation, callback) => {
    // 添加入口模块
    compilation.addEntry(
        context,
        entryDependency,
        options,
        callback
    );
});

// make 钩子完成后：
// - 所有入口模块已添加
// - 所有模块已递归构建
// - 依赖图构建完成
// - 准备进入 seal 阶段
```

### 3.2 emit 钩子 ⭐⭐

**输出文件前的最后机会！**

**触发位置**: `lib/Compiler.js:emitAssets` 方法内

**使用场景**:
- 修改输出内容
- 添加额外文件
- 生成清单文件
- 上传到 CDN

**实际例子**:

```javascript
compiler.hooks.emit.tapAsync('MyPlugin', (compilation, callback) => {
    // 添加额外文件
    compilation.assets['extra-file.txt'] = {
        source() { return 'Extra content'; },
        size() { return 13; }
    };

    // 修改现有文件
    const mainAsset = compilation.assets['main.js'];
    compilation.assets['main.js'] = {
        source() {
            return `// Banner\n${mainAsset.source()}`;
        },
        size() {
            return mainAsset.size() + 11;
        }
    };

    callback();
});
```

### 3.3 done 钩子 ⭐

**编译完成（成功或失败）**

**触发位置**:
- `lib/Compiler.js:1114` (run 方法内)
- `lib/Compiler.js:1057` (shouldEmit 为 false 时)

**使用场景**:
- 输出统计信息
- 上传构建结果
- 发送通知
- 清理临时文件

**实际例子**:

```javascript
compiler.hooks.done.tap('MyPlugin', (stats) => {
    // 输出统计信息
    console.log(stats.toString({
        colors: true,
        chunks: false
    }));

    // 检查错误
    if (stats.hasErrors()) {
        console.error('Build failed!');
    }

    // 上传到服务器
    uploadToServer(stats.toJson());
});
```

### 3.4 compilation 钩子 ⭐⭐

**Compilation 创建完成，注册 Compilation 钩子的地方**

**触发位置**: `lib/Compiler.js:newCompilation` 方法内

**使用场景**:
- 注册 Compilation 级别的钩子
- 修改 Compilation 配置
- 添加自定义处理逻辑

**实际例子**:

```javascript
compiler.hooks.compilation.tap('MyPlugin', (compilation) => {
    // 注册 Compilation 的钩子
    compilation.hooks.optimizeModules.tap('MyPlugin', (modules) => {
        // 优化模块
    });

    compilation.hooks.optimizeChunks.tap('MyPlugin', (chunks) => {
        // 优化 chunk
    });
});
```

---

## 四、钩子执行顺序（完整流程）

### 4.1 单次编译模式（run）

```
用户调用: compiler.run(callback)
    ↓
═══════════════════════════════════════
  运行阶段
═══════════════════════════════════════
    ↓
beforeRun (async)          // 运行前准备
    ↓
run (async)                // 开始运行
    ↓
readRecords (async)        // 读取 records
    ↓
═══════════════════════════════════════
  编译阶段
═══════════════════════════════════════
    ↓
beforeCompile (async)      // 编译前准备
    ↓
compile (sync)             // 开始编译
    ↓
thisCompilation (sync)     // 创建 Compilation
    ↓
compilation (sync)         // Compilation 准备完成
    ↓
═══════════════════════════════════════
  构建阶段（最耗时）⭐⭐⭐
═══════════════════════════════════════
    ↓
make (async parallel) ⭐⭐⭐  // 构建所有模块
    │
    ├─ EntryPlugin 添加入口
    ├─ 递归构建所有模块
    ├─ 解析依赖
    └─ 构建依赖图
    ↓
finishMake (async)         // 模块构建完成
    ↓
[compilation.finish()] 内部 // 完成报告
    ↓
[compilation.seal()] 内部 ⭐⭐⭐ // 封装阶段
    │
    ├─ 创建 Chunk
    ├─ 优化模块和 Chunk
    ├─ 生成 ID
    └─ 生成代码
    ↓
afterCompile (async)       // 编译完成
    ↓
═══════════════════════════════════════
  输出阶段
═══════════════════════════════════════
    ↓
shouldEmit (sync bail)     // 判断是否输出
    ↓
emit (async) ⭐⭐           // 输出文件前
    ↓
[emitAssets() 内部]        // 实际写入文件
    ↓
assetEmitted (async)       // 每个文件输出后
    ↓
afterEmit (async)          // 所有文件输出后
    ↓
emitRecords (async)        // 写入 records
    ↓
═══════════════════════════════════════
  完成阶段
═══════════════════════════════════════
    ↓
done (async) ⭐            // 编译完成
    ↓
afterDone (sync)           // done 后的同步收尾
    ↓
[用户回调执行]
```

### 4.2 监听模式（watch）

```
用户调用: compiler.watch(options, handler)
    ↓
═══════════════════════════════════════
  首次编译（与 run 类似）
═══════════════════════════════════════
watchRun (替代 beforeRun/run)
    ↓
beforeCompile → compile → make → seal
    ↓
emit → done
    ↓
═══════════════════════════════════════
  监听文件变化
═══════════════════════════════════════
    ↓
[文件变化]
    ↓
invalid                    // 标记编译无效
    ↓
watchRun                   // 重新编译
    ↓
[重复编译流程]
    ↓
═══════════════════════════════════════
  停止监听
═══════════════════════════════════════
    ↓
watchClose                 // 关闭监听
    ↓
shutdown                   // 关闭编译器
```

---

## 五、钩子使用示例

### 5.1 开发插件的基本模式

```javascript
class MyWebpackPlugin {
    apply(compiler) {
        // 1. 初始化时注册钩子
        compiler.hooks.make.tapAsync(
            'MyWebpackPlugin',  // 插件名
            (compilation, callback) => {
                // 2. 钩子触发时执行逻辑
                console.log('Make stage!');

                // 3. 完成后调用 callback
                callback();
            }
        );
    }
}

module.exports = MyWebpackPlugin;
```

### 5.2 修改输出的插件

```javascript
class BannerPlugin {
    apply(compiler) {
        compiler.hooks.emit.tapAsync('BannerPlugin', (compilation, callback) => {
            // 遍历所有输出文件
            for (const filename in compilation.assets) {
                if (filename.endsWith('.js')) {
                    const asset = compilation.assets[filename];

                    // 添加 banner
                    compilation.assets[filename] = {
                        source() {
                            return `/*! My Banner */\n${asset.source()}`;
                        },
                        size() {
                            return asset.size() + 17;
                        }
                    };
                }
            }

            callback();
        });
    }
}
```

### 5.3 性能分析插件

```javascript
class PerformancePlugin {
    apply(compiler) {
        let startTime;

        // 记录开始时间
        compiler.hooks.compile.tap('PerformancePlugin', () => {
            startTime = Date.now();
        });

        // 记录各阶段耗时
        compiler.hooks.make.tapAsync('PerformancePlugin', (compilation, callback) => {
            console.log('Make started');
            callback();
        });

        compiler.hooks.afterCompile.tap('PerformancePlugin', () => {
            const duration = Date.now() - startTime;
            console.log(`Compilation took ${duration}ms`);
        });

        // 输出最终报告
        compiler.hooks.done.tap('PerformancePlugin', (stats) => {
            const totalTime = Date.now() - startTime;
            console.log(`Total time: ${totalTime}ms`);
            console.log(`Modules: ${stats.compilation.modules.size}`);
            console.log(`Chunks: ${stats.compilation.chunks.size}`);
        });
    }
}
```

---

## 六、重要钩子的触发位置

### 6.1 在 Compiler.run() 中触发的钩子

**文件**: `lib/Compiler.js` - run 方法（已添加详细注释）

```javascript
compiler.run(callback) {
    // 1. beforeRun 钩子
    this.hooks.beforeRun.callAsync(this, err => {

        // 2. run 钩子
        this.hooks.run.callAsync(this, err => {

            // 3. 读取 records（readRecords 钩子）
            this.readRecords(err => {

                // 4. 开始编译
                this.compile(onCompiled);

            });
        });
    });
}
```

### 6.2 在 Compiler.compile() 中触发的钩子

**文件**: `lib/Compiler.js:1843` - compile 方法（已添加详细注释）

```javascript
compiler.compile(callback) {
    // 1. beforeCompile 钩子
    this.hooks.beforeCompile.callAsync(params, err => {

        // 2. compile 钩子
        this.hooks.compile.call(params);

        // 3. 创建 Compilation
        const compilation = this.newCompilation(params);

        // 4. make 钩子 ⭐⭐⭐
        this.hooks.make.callAsync(compilation, err => {

            // 5. finishMake 钩子
            this.hooks.finishMake.callAsync(compilation, err => {

                // 6. compilation.finish()
                compilation.finish(err => {

                    // 7. compilation.seal() ⭐⭐⭐
                    compilation.seal(err => {

                        // 8. afterCompile 钩子
                        this.hooks.afterCompile.callAsync(compilation, callback);

                    });
                });
            });
        });
    });
}
```

### 6.3 在 onCompiled 回调中触发的钩子

**文件**: `lib/Compiler.js:1044` - onCompiled 函数（已添加详细注释）

```javascript
const onCompiled = (err, compilation) => {
    // 1. shouldEmit 钩子
    if (this.hooks.shouldEmit.call(compilation) === false) {
        // 不输出，直接 done
    }

    // 2. emitAssets()
    this.emitAssets(compilation, err => {

        // 3. 检查是否需要额外编译
        if (compilation.hooks.needAdditionalPass.call()) {
            // additionalPass 钩子
            this.hooks.additionalPass.callAsync(err => {
                this.compile(onCompiled);  // 递归编译
            });
            return;
        }

        // 4. emitRecords 钩子
        this.emitRecords(err => {

            // 5. done 钩子
            this.hooks.done.callAsync(stats, err => {

                // 6. 用户回调
                callback(null, stats);

                // 7. afterDone 钩子
                this.hooks.afterDone.call(stats);

            });
        });
    });
};
```

---

## 七、钩子的性能影响

### 7.1 make 钩子的耗时

**占总编译时间的 60-80%！**

```
make 钩子内部发生的事情：
├─ 添加入口模块: ~1ms
├─ 构建所有模块: ~3000ms ⭐（最耗时）
│   ├─ 读取文件: ~500ms
│   ├─ 执行 loader: ~1500ms
│   └─ 解析 AST: ~1000ms
└─ 构建依赖图: ~100ms
```

### 7.2 seal 钩子的耗时

**占总编译时间的 15-25%**

```
seal 阶段（compilation.seal）内部：
├─ 创建 Chunk: ~50ms
├─ 优化模块: ~200ms
├─ 优化 Chunk: ~300ms ⭐
│   └─ SplitChunksPlugin 分析
├─ 生成 ID: ~50ms
├─ 生成代码: ~500ms ⭐
└─ 创建资源: ~100ms
```

### 7.3 emit 钩子的耗时

**占总编译时间的 5-10%**

```
emit 阶段：
├─ emit 钩子: ~50ms（插件处理）
├─ 写入文件: ~200ms
└─ afterEmit 钩子: ~50ms
```

---

## 八、调试技巧

### 8.1 查看所有注册的钩子

```javascript
const webpack = require('webpack');
const config = require('./webpack.config');

const compiler = webpack(config);

// 查看 make 钩子注册的插件
console.log('make hook listeners:');
console.log(compiler.hooks.make.taps.map(t => t.name));

// 输出示例：
// ['EntryPlugin', 'DllReferencePlugin', 'PrefetchPlugin']
```

### 8.2 记录钩子执行时间

```javascript
class TimingPlugin {
    apply(compiler) {
        const timings = {};

        // 记录所有钩子的执行时间
        for (const hookName in compiler.hooks) {
            const hook = compiler.hooks[hookName];

            hook.intercept({
                call() {
                    timings[hookName] = Date.now();
                },
                done() {
                    const duration = Date.now() - timings[hookName];
                    console.log(`${hookName}: ${duration}ms`);
                }
            });
        }
    }
}
```

### 8.3 在关键钩子设置断点

**推荐断点位置**:
```
lib/Compiler.js:1872  // make 钩子
lib/Compiler.js:1902  // seal 开始
lib/Compiler.js:1114  // done 钩子
```

---

## 九、常见问题

### Q1: make 钩子为什么是 AsyncParallelHook？

**答**: 允许多个入口插件并行添加入口

```javascript
// 多个入口插件同时工作
EntryPlugin1: compilation.addEntry(entry1)  ┐
EntryPlugin2: compilation.addEntry(entry2)  ├─ 并行
EntryPlugin3: compilation.addEntry(entry3)  ┘

// 而不是串行等待：
EntryPlugin1 → 完成 → EntryPlugin2 → 完成 → EntryPlugin3
```

### Q2: 为什么有 thisCompilation 和 compilation 两个钩子？

**答**:
- `thisCompilation`: 仅在主 compiler 触发，子编译器不触发
- `compilation`: 主 compiler 和子编译器都触发

**使用场景**:
```javascript
// 只在主编译时执行
compiler.hooks.thisCompilation.tap('Plugin', (compilation) => {
    // 仅执行一次
});

// 主编译和子编译都执行
compiler.hooks.compilation.tap('Plugin', (compilation) => {
    // 可能执行多次（如果有子编译器）
});
```

### Q3: 为什么 done 钩子既可能成功也可能失败？

**答**: done 钩子总是会触发，无论编译成功或失败

```javascript
compiler.hooks.done.tap('Plugin', (stats) => {
    // 检查是否有错误
    if (stats.hasErrors()) {
        console.error('编译失败');
    } else {
        console.log('编译成功');
    }
});
```

### Q4: 为什么 emit 钩子在 shouldEmit 之后？

**答**:
1. `shouldEmit`: 判断是否应该输出（可以取消输出）
2. `emit`: 如果要输出，在输出前的最后机会

```javascript
// shouldEmit 返回 false
if (this.hooks.shouldEmit.call(compilation) === false) {
    // 跳过 emit，直接到 done
}

// 只有 shouldEmit 通过才触发 emit
this.hooks.emit.callAsync(compilation, err => {
    // 输出文件
});
```

---

## 十、最佳实践

### 1. 选择合适的钩子

| 目的 | 推荐钩子 |
|------|---------|
| 添加入口 | make |
| 修改模块 | compilation + compilation.hooks.buildModule |
| 优化代码 | compilation + compilation.hooks.optimizeModules |
| 修改输出 | emit |
| 统计报告 | done |

### 2. 注意钩子类型

```javascript
// ✅ 正确：异步钩子用 tapAsync 或 tapPromise
compiler.hooks.make.tapAsync('Plugin', (compilation, callback) => {
    // 异步操作
    setTimeout(() => callback(), 1000);
});

// ❌ 错误：异步钩子用 tap
compiler.hooks.make.tap('Plugin', (compilation) => {
    // 无法等待异步操作！
});
```

### 3. 错误处理

```javascript
compiler.hooks.make.tapAsync('Plugin', (compilation, callback) => {
    doSomething((err) => {
        if (err) {
            // ⚠️ 必须将错误传递给 callback
            return callback(err);
        }
        callback();
    });
});
```

### 4. 避免阻塞

```javascript
// ✅ 好：使用 process.nextTick
compiler.hooks.done.tap('Plugin', (stats) => {
    process.nextTick(() => {
        // 耗时操作
        uploadToServer(stats);
    });
});

// ❌ 坏：直接执行耗时操作
compiler.hooks.done.tap('Plugin', (stats) => {
    uploadToServer(stats);  // 阻塞 webpack 进程
});
```

---

## 十一、总结

### 核心要点

1. **钩子是 webpack 插件系统的基础**
   - 所有扩展都通过钩子实现
   - 理解钩子就理解了 webpack 的扩展机制

2. **make 和 seal 是最重要的钩子**
   - make: 构建模块，占 60-80% 时间
   - seal: 优化和生成代码，占 15-25% 时间

3. **钩子有明确的执行顺序**
   - 异步钩子按注册顺序执行
   - 同步钩子立即按顺序执行

4. **选择合适的钩子类型很重要**
   - 同步操作用同步钩子
   - 异步操作用异步钩子
   - 注意 callback 的调用

### 学习建议

1. **阅读已注释的源码**
   - lib/Compiler.js（已添加详细注释）
   - 重点看 run()、compile()、close() 方法

2. **实践调试**
   - 在关键钩子设置断点
   - 观察执行顺序和数据

3. **开发简单插件**
   - 从一个钩子开始
   - 逐步理解整个流程

---

**相关文件**:
- `lib/Compiler.js` - 已添加钩子系统和核心方法注释
- `lib/Compilation.js` - 下一步添加注释
- `lib/webpack.js` - createCompiler 中触发 environment/afterEnvironment/initialize

**下一步**: 为 Compilation.js 添加详细注释
