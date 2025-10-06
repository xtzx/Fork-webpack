/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

/**
 * lib/Compiler.js - webpack 编译器核心类 ⭐⭐⭐
 *
 * 【文件作用】
 * Compiler 是 webpack 的"大脑"，负责：
 * 1. 控制整个编译生命周期
 * 2. 管理文件系统（输入/输出）
 * 3. 管理缓存系统
 * 4. 提供钩子系统供插件扩展
 * 5. 创建和管理 Compilation 实例
 * 6. 处理 watch 模式
 *
 * 【核心职责】
 *
 * 1. **生命周期管理**：
 *    - run(): 单次编译
 *    - watch(): 监听模式
 *    - compile(): 创建 Compilation 并执行编译
 *    - close(): 关闭编译器，释放资源
 *
 * 2. **文件系统管理**：
 *    - inputFileSystem: 读取源文件
 *    - outputFileSystem: 写入构建产物
 *    - watchFileSystem: 监听文件变化
 *
 * 3. **缓存管理**：
 *    - cache: 缓存实例（内存或文件系统）
 *    - 增量编译支持
 *
 * 4. **钩子系统**（~30 个钩子）：
 *    - 提供扩展点供插件使用
 *    - 控制编译流程的每个阶段
 *
 * 【与 Compilation 的区别】
 *
 * | Compiler | Compilation |
 * |----------|-------------|
 * | 全局唯一 | 每次编译创建 |
 * | 管理整个生命周期 | 管理单次编译 |
 * | 持久化状态 | 临时状态 |
 * | 文件系统、缓存 | 模块、Chunk、资源 |
 *
 * 【钩子执行顺序】
 * ```
 * beforeRun → run → beforeCompile → compile
 *   → thisCompilation → compilation → make
 *   → finishMake → afterCompile → shouldEmit
 *   → emit → afterEmit → done
 * ```
 *
 * 【重要性】
 * 理解 Compiler 是理解 webpack 运行机制的关键！
 * 所有编译流程都由 Compiler 控制。
 */

"use strict";

// ===== 核心依赖 =====
const parseJson = require("json-parse-even-better-errors"); // JSON 解析（更好的错误信息）
const asyncLib = require("neo-async"); // 异步控制流库（性能优于 async.js）

// tapable: webpack 的钩子系统核心
const {
	SyncHook,           // 同步钩子
	SyncBailHook,       // 同步熔断钩子（可中断）
	AsyncParallelHook,  // 异步并行钩子
	AsyncSeriesHook     // 异步串行钩子
} = require("tapable");

const { SizeOnlySource } = require("webpack-sources"); // 只包含大小信息的 Source
const webpack = require("./"); // webpack 主模块

// ===== 核心类 =====
const Cache = require("./Cache"); // 缓存管理
const CacheFacade = require("./CacheFacade"); // 缓存门面
const ChunkGraph = require("./ChunkGraph"); // Chunk 依赖图
const Compilation = require("./Compilation"); // 编译实例
const ConcurrentCompilationError = require("./ConcurrentCompilationError"); // 并发编译错误
const ContextModuleFactory = require("./ContextModuleFactory"); // 上下文模块工厂
const ModuleGraph = require("./ModuleGraph"); // 模块依赖图
const NormalModuleFactory = require("./NormalModuleFactory"); // 普通模块工厂
const RequestShortener = require("./RequestShortener"); // 请求路径缩短器
const ResolverFactory = require("./ResolverFactory"); // 解析器工厂
const Stats = require("./Stats"); // 统计信息
const Watching = require("./Watching"); // 监听管理器
const WebpackError = require("./WebpackError"); // webpack 错误基类

// ===== 工具 =====
const { Logger } = require("./logging/Logger"); // 日志记录器
const { join, dirname, mkdirp } = require("./util/fs"); // 文件系统工具
const { makePathsRelative } = require("./util/identifier"); // 路径处理
const { isSourceEqual } = require("./util/source"); // Source 比较

/** @typedef {import("webpack-sources").Source} Source */
/** @typedef {import("../declarations/WebpackOptions").EntryNormalized} Entry */
/** @typedef {import("../declarations/WebpackOptions").OutputNormalized} OutputOptions */
/** @typedef {import("../declarations/WebpackOptions").WatchOptions} WatchOptions */
/** @typedef {import("../declarations/WebpackOptions").WebpackOptionsNormalized} WebpackOptions */
/** @typedef {import("../declarations/WebpackOptions").WebpackPluginInstance} WebpackPluginInstance */
/** @typedef {import("./Chunk")} Chunk */
/** @typedef {import("./Dependency")} Dependency */
/** @typedef {import("./FileSystemInfo").FileSystemInfoEntry} FileSystemInfoEntry */
/** @typedef {import("./Module")} Module */
/** @typedef {import("./util/WeakTupleMap")} WeakTupleMap */
/** @typedef {import("./util/fs").InputFileSystem} InputFileSystem */
/** @typedef {import("./util/fs").IntermediateFileSystem} IntermediateFileSystem */
/** @typedef {import("./util/fs").OutputFileSystem} OutputFileSystem */
/** @typedef {import("./util/fs").WatchFileSystem} WatchFileSystem */

/**
 * @typedef {Object} CompilationParams
 * @property {NormalModuleFactory} normalModuleFactory
 * @property {ContextModuleFactory} contextModuleFactory
 */

/**
 * @template T
 * @callback Callback
 * @param {(Error | null)=} err
 * @param {T=} result
 */

/**
 * @callback RunAsChildCallback
 * @param {(Error | null)=} err
 * @param {Chunk[]=} entries
 * @param {Compilation=} compilation
 */

/**
 * @typedef {Object} AssetEmittedInfo
 * @property {Buffer} content
 * @property {Source} source
 * @property {Compilation} compilation
 * @property {string} outputPath
 * @property {string} targetPath
 */

// ===== 辅助工具函数 =====

/**
 * 检查数组是否已排序
 *
 * 【用途】
 * 优化：如果数组已排序，跳过排序操作
 *
 * @param {string[]} array - 字符串数组
 * @returns {boolean} 是否已排序
 */
const isSorted = array => {
	// 遍历检查相邻元素
	for (let i = 1; i < array.length; i++) {
		if (array[i - 1] > array[i]) return false;
	}
	return true;
};

/**
 * 对象属性排序
 *
 * 【用途】
 * 确保对象属性的顺序一致（用于缓存、哈希计算）
 *
 * @param {Object} obj - 源对象
 * @param {string[]} keys - 属性键列表
 * @returns {Object} 属性已排序的新对象
 */
const sortObject = (obj, keys) => {
	const o = {};
	// 按字母顺序排序键
	for (const k of keys.sort()) {
		o[k] = obj[k];
	}
	return o;
};

/**
 * 检查文件名是否包含哈希
 *
 * 【用途】
 * 判断输出文件是否包含内容哈希：
 * - 如果包含哈希，文件变化时文件名会变
 * - 用于判断是否需要清理旧文件
 *
 * 【示例】
 * ```javascript
 * includesHash('main.[contenthash].js', 'contenthash') // true
 * includesHash('main.js', 'contenthash') // false
 * ```
 *
 * @param {string} filename - 文件名
 * @param {string | string[] | undefined} hashes - 哈希占位符列表
 * @returns {boolean} 是否包含哈希
 */
const includesHash = (filename, hashes) => {
	if (!hashes) return false;

	if (Array.isArray(hashes)) {
		// 检查是否包含任意一个哈希
		return hashes.some(hash => filename.includes(hash));
	} else {
		// 检查单个哈希
		return filename.includes(hashes);
	}
};

/**
 * Compiler - webpack 编译器主类
 *
 * 【核心设计】
 * Compiler 是一个全局单例，通过钩子系统控制整个编译流程。
 * 所有的扩展功能都通过插件在钩子上注册。
 */
class Compiler {
	/**
	 * Compiler 构造函数
	 *
	 * 【参数说明】
	 * @param {string} context - 编译上下文路径（通常是项目根目录）
	 * @param {WebpackOptions} options - webpack 配置对象
	 *
	 * 【初始化内容】
	 * 1. 创建钩子系统（~30 个钩子）
	 * 2. 初始化基本属性（context、options）
	 * 3. 创建缓存系统
	 * 4. 初始化文件系统引用
	 * 5. 初始化其他管理器（resolverFactory 等）
	 *
	 * 【钩子执行顺序】
	 * ```
	 * 初始化: environment → afterEnvironment → initialize
	 * 运行: beforeRun → run → beforeCompile
	 * 编译: compile → thisCompilation → compilation
	 * 构建: make → finishMake → afterCompile
	 * 输出: shouldEmit → emit → assetEmitted → afterEmit
	 * 完成: done → afterDone
	 * ```
	 */
	constructor(context, options = /** @type {WebpackOptions} */ ({})) {
		// ===== 钩子系统（webpack 插件机制的核心）⭐⭐⭐ =====
		/**
		 * 钩子对象（冻结，防止修改）
		 *
		 * 【钩子类型说明】
		 * - SyncHook: 同步钩子，按注册顺序依次调用
		 * - SyncBailHook: 同步熔断钩子，返回非 undefined 时停止
		 * - AsyncSeriesHook: 异步串行钩子，依次异步调用
		 * - AsyncParallelHook: 异步并行钩子，同时触发所有监听器
		 *
		 * 【使用方式】
		 * ```javascript
		 * // 插件注册
		 * compiler.hooks.make.tapAsync('MyPlugin', (compilation, callback) => {
		 *   // 插件逻辑
		 *   callback();
		 * });
		 *
		 * // webpack 触发
		 * compiler.hooks.make.callAsync(compilation, err => {
		 *   // 所有插件执行完成
		 * });
		 * ```
		 */
		this.hooks = Object.freeze({
			// ===== 🔵 初始化阶段钩子 =====

			/**
			 * initialize: 初始化完成（在 lib/webpack.js 最后调用）
			 * @type {SyncHook<[]>}
			 */
			initialize: new SyncHook([]),

			// ===== 🔵 判断和完成钩子 =====

			/**
			 * shouldEmit: 判断是否应该输出文件
			 * 插件可以返回 false 阻止输出（如只做检查）
			 * @type {SyncBailHook<[Compilation], boolean | undefined>}
			 */
			shouldEmit: new SyncBailHook(["compilation"]),

			/**
			 * done: 编译完成（成功或失败）
			 * 最后一个钩子，用于收尾工作和报告
			 * @type {AsyncSeriesHook<[Stats]>}
			 */
			done: new AsyncSeriesHook(["stats"]),

			/**
			 * afterDone: done 钩子后的同步钩子
			 * 用于不需要异步的收尾工作
			 * @type {SyncHook<[Stats]>}
			 */
			afterDone: new SyncHook(["stats"]),

			/**
			 * additionalPass: 需要额外的编译轮次
			 * 某些优化需要多轮编译
			 * @type {AsyncSeriesHook<[]>}
			 */
			additionalPass: new AsyncSeriesHook([]),

			// ===== 🔵 运行前钩子 =====

			/**
			 * beforeRun: 运行前（单次编译模式）
			 * 用于清理缓存、准备资源等
			 * @type {AsyncSeriesHook<[Compiler]>}
			 */
			beforeRun: new AsyncSeriesHook(["compiler"]),

			/**
			 * run: 开始运行（单次编译模式）
			 * 表示即将开始编译
			 * @type {AsyncSeriesHook<[Compiler]>}
			 */
			run: new AsyncSeriesHook(["compiler"]),

			// ===== 🔵 输出阶段钩子 =====

			/**
			 * emit: 输出文件前
			 * 最后修改输出内容的机会
			 * @type {AsyncSeriesHook<[Compilation]>}
			 */
			emit: new AsyncSeriesHook(["compilation"]),

			/**
			 * assetEmitted: 单个资源文件输出后
			 * 可以获取输出的文件内容和路径
			 * @type {AsyncSeriesHook<[string, AssetEmittedInfo]>}
			 */
			assetEmitted: new AsyncSeriesHook(["file", "info"]),

			/**
			 * afterEmit: 所有文件输出后
			 * 用于文件后处理（如压缩、上传等）
			 * @type {AsyncSeriesHook<[Compilation]>}
			 */
			afterEmit: new AsyncSeriesHook(["compilation"]),

			// ===== 🔵 Compilation 创建钩子 =====

			/**
			 * thisCompilation: 创建 Compilation 实例时（在 compilation 钩子前）
			 * 用于访问 compilation 内部，不应在子编译器中触发
			 * @type {SyncHook<[Compilation, CompilationParams]>}
			 */
			thisCompilation: new SyncHook(["compilation", "params"]),

			/**
			 * compilation: Compilation 创建完成
			 * 插件可以在这里注册 Compilation 的钩子
			 * @type {SyncHook<[Compilation, CompilationParams]>}
			 */
			compilation: new SyncHook(["compilation", "params"]),

			/**
			 * normalModuleFactory: 普通模块工厂创建后
			 * 用于注册模块工厂的钩子（如 loader 解析）
			 * @type {SyncHook<[NormalModuleFactory]>}
			 */
			normalModuleFactory: new SyncHook(["normalModuleFactory"]),

			/**
			 * contextModuleFactory: 上下文模块工厂创建后
			 * 用于 require.context() 等动态导入
			 * @type {SyncHook<[ContextModuleFactory]>}
			 */
			contextModuleFactory: new SyncHook(["contextModuleFactory"]),

			// ===== 🔵 编译过程钩子 =====

			/**
			 * beforeCompile: 编译前准备
			 * 可以在这里修改编译参数
			 * @type {AsyncSeriesHook<[CompilationParams]>}
			 */
			beforeCompile: new AsyncSeriesHook(["params"]),

			/**
			 * compile: 开始编译
			 * Compilation 实例即将创建
			 * @type {SyncHook<[CompilationParams]>}
			 */
			compile: new SyncHook(["params"]),

			/**
			 * make: 构建模块阶段 ⭐⭐⭐
			 *
			 * 【最重要的钩子！】
			 * 所有入口插件都在这里注册：
			 * - EntryPlugin: 添加入口模块
			 * - DllPlugin: 添加 DLL 模块
			 * - 等等...
			 *
			 * 这个钩子触发后，webpack 开始：
			 * 1. 添加入口模块
			 * 2. 构建模块（解析、转换）
			 * 3. 收集依赖
			 * 4. 递归构建所有依赖
			 * 5. 构建完整的依赖图
			 *
			 * @type {AsyncParallelHook<[Compilation]>}
			 */
			make: new AsyncParallelHook(["compilation"]),

			/**
			 * finishMake: 模块构建完成
			 * 所有模块都已构建，准备进入 seal 阶段
			 * @type {AsyncParallelHook<[Compilation]>}
			 */
			finishMake: new AsyncSeriesHook(["compilation"]),

			/**
			 * afterCompile: 编译完成（包括 seal 阶段）
			 * Compilation 的所有工作都完成了
			 * @type {AsyncSeriesHook<[Compilation]>}
			 */
			afterCompile: new AsyncSeriesHook(["compilation"]),

			// ===== 🔵 Records 钩子 =====

			/**
			 * readRecords: 读取 records 文件
			 * records 记录了模块 ID、chunk ID 等信息，用于持久化缓存
			 * @type {AsyncSeriesHook<[]>}
			 */
			readRecords: new AsyncSeriesHook([]),

			/**
			 * emitRecords: 写入 records 文件
			 * @type {AsyncSeriesHook<[]>}
			 */
			emitRecords: new AsyncSeriesHook([]),

			// ===== 🔵 监听模式钩子 =====

			/**
			 * watchRun: watch 模式运行前
			 * 在 watch 模式下替代 run 钩子
			 * @type {AsyncSeriesHook<[Compiler]>}
			 */
			watchRun: new AsyncSeriesHook(["compiler"]),

			/**
			 * failed: 编译失败
			 * 用于错误处理和报告
			 * @type {SyncHook<[Error]>}
			 */
			failed: new SyncHook(["error"]),

			/**
			 * invalid: 文件变化，编译无效化
			 * watch 模式下文件变化时触发
			 * @type {SyncHook<[string | null, number]>}
			 */
			invalid: new SyncHook(["filename", "changeTime"]),

			/**
			 * watchClose: 停止监听
			 * watch 模式关闭时触发
			 * @type {SyncHook<[]>}
			 */
			watchClose: new SyncHook([]),

			/**
			 * shutdown: 关闭编译器
			 * 释放所有资源
			 * @type {AsyncSeriesHook<[]>}
			 */
			shutdown: new AsyncSeriesHook([]),

			/**
			 * infrastructureLog: 基础设施日志
			 * 用于记录 webpack 内部的日志信息
			 * @type {SyncBailHook<[string, string, any[]], true>}
			 */
			infrastructureLog: new SyncBailHook(["origin", "type", "args"]),

			// ===== 🔵 遗留钩子（位置不合理，但为了兼容性保留）=====
			// TODO the following hooks are weirdly located here
			// TODO move them for webpack 5

			/**
			 * environment: 准备环境
			 * 在 lib/webpack.js 的 createCompiler 中调用
			 * @type {SyncHook<[]>}
			 */
			environment: new SyncHook([]),

			/**
			 * afterEnvironment: 环境准备完成
			 * @type {SyncHook<[]>}
			 */
			afterEnvironment: new SyncHook([]),

			/**
			 * afterPlugins: 插件注册完成
			 * @type {SyncHook<[Compiler]>}
			 */
			afterPlugins: new SyncHook(["compiler"]),

			/**
			 * afterResolvers: 解析器初始化完成
			 * @type {SyncHook<[Compiler]>}
			 */
			afterResolvers: new SyncHook(["compiler"]),

			/**
			 * entryOption: 处理入口配置
			 * 用于注册入口插件（EntryPlugin）
			 * @type {SyncBailHook<[string, Entry], boolean>}
			 */
			entryOption: new SyncBailHook(["context", "entry"])
		});

		// ===== 基本属性 =====

		// webpack 主模块的引用
		this.webpack = webpack;

		/**
		 * 编译器名称（多编译器时用于区分）
		 * @type {string=}
		 */
		this.name = undefined;

		/**
		 * 父编译实例（子编译器才有）
		 * 用于嵌套编译（如 html-webpack-plugin）
		 * @type {Compilation=}
		 */
		this.parentCompilation = undefined;

		/**
		 * 根编译器引用
		 * - 对于主编译器：root === this
		 * - 对于子编译器：root 指向主编译器
		 * @type {Compiler}
		 */
		this.root = this;

		/**
		 * 输出路径（output.path 的值）
		 * @type {string}
		 */
		this.outputPath = "";

		/**
		 * Watching 实例（watch 模式下）
		 * @type {Watching | undefined}
		 */
		this.watching = undefined;

		// ===== 文件系统（由 NodeEnvironmentPlugin 注入）⭐⭐ =====

		/**
		 * 输出文件系统（写入构建产物）
		 * 默认：node 的 fs 模块
		 * 可替换：memfs（内存文件系统）
		 * @type {OutputFileSystem}
		 */
		this.outputFileSystem = null;

		/**
		 * 中间文件系统（临时文件）
		 * @type {IntermediateFileSystem}
		 */
		this.intermediateFileSystem = null;

		/**
		 * 输入文件系统（读取源文件）
		 * 默认：graceful-fs（更稳定的 fs）
		 * @type {InputFileSystem}
		 */
		this.inputFileSystem = null;

		/**
		 * 监听文件系统（watch 模式）
		 * 使用 watchpack 库实现
		 * @type {WatchFileSystem}
		 */
		this.watchFileSystem = null;

		// ===== Records（模块和 Chunk ID 记录）=====

		/**
		 * records 输入路径
		 * 从哪里读取 records 文件
		 * @type {string|null}
		 */
		this.recordsInputPath = null;

		/**
		 * records 输出路径
		 * 写入 records 文件的位置
		 * @type {string|null}
		 */
		this.recordsOutputPath = null;

		/**
		 * records 对象
		 * 存储模块 ID、chunk ID 等信息，用于：
		 * - 持久化缓存
		 * - 保持 ID 稳定
		 */
		this.records = {};

		// ===== 路径管理 =====

		/**
		 * 受管理的路径集合
		 *
		 * 【用途】
		 * 这些路径下的文件被包管理器管理（如 node_modules）：
		 * - 文件不会被用户修改
		 * - 可以使用更激进的缓存策略
		 * - 提高构建性能
		 *
		 * @type {Set<string | RegExp>}
		 */
		this.managedPaths = new Set();

		/**
		 * 不可变路径集合
		 *
		 * 【用途】
		 * 这些路径下的文件不会改变（如 node_modules/.cache）：
		 * - 永久缓存
		 * - 跳过文件监听
		 *
		 * @type {Set<string | RegExp>}
		 */
		this.immutablePaths = new Set();

		// ===== 文件变化信息（watch 模式）=====

		/**
		 * 修改的文件集合（相对于上次编译）
		 * @type {ReadonlySet<string> | undefined}
		 */
		this.modifiedFiles = undefined;

		/**
		 * 删除的文件集合（相对于上次编译）
		 * @type {ReadonlySet<string> | undefined}
		 */
		this.removedFiles = undefined;

		/**
		 * 文件时间戳映射
		 * 记录每个文件的修改时间，用于增量编译
		 * @type {ReadonlyMap<string, FileSystemInfoEntry | "ignore" | null> | undefined}
		 */
		this.fileTimestamps = undefined;

		/**
		 * 目录时间戳映射
		 * 记录目录的修改时间
		 * @type {ReadonlyMap<string, FileSystemInfoEntry | "ignore" | null> | undefined}
		 */
		this.contextTimestamps = undefined;

		/**
		 * 文件系统开始时间
		 * 用于判断文件变化
		 * @type {number | undefined}
		 */
		this.fsStartTime = undefined;

		// ===== 解析器工厂（模块解析）⭐⭐ =====

		/**
		 * 解析器工厂
		 *
		 * 【作用】
		 * 创建和管理各种解析器：
		 * - normal: 普通模块解析（import/require）
		 * - context: 上下文模块解析（require.context）
		 * - loader: loader 解析
		 *
		 * 使用 enhanced-resolve 库实现
		 *
		 * @type {ResolverFactory}
		 */
		this.resolverFactory = new ResolverFactory();

		// 基础设施日志记录器（内部使用）
		this.infrastructureLogger = undefined;

		// webpack 配置对象
		this.options = options;

		// 编译上下文路径
		this.context = context;

		// 请求路径缩短器（用于错误信息展示）
		this.requestShortener = new RequestShortener(context, this.root);

		// ===== 缓存系统 ⭐⭐ =====

		/**
		 * 缓存实例
		 *
		 * 【缓存类型】
		 * - memory: 内存缓存（快，但不持久）
		 * - filesystem: 文件系统缓存（慢，但持久化）
		 *
		 * 【缓存内容】
		 * - 模块构建结果
		 * - 模块解析结果
		 * - loader 执行结果
		 *
		 * 【性能影响】
		 * 缓存可以将重复构建速度提升 10-100 倍！
		 */
		this.cache = new Cache();

		/**
		 * 模块内存缓存
		 *
		 * 【用途】
		 * 为每个模块提供独立的缓存空间
		 *
		 * @type {Map<Module, { buildInfo: object, references: WeakMap<Dependency, Module>, memCache: WeakTupleMap }> | undefined}
		 */
		this.moduleMemCaches = undefined;

		/**
		 * 编译器路径（用于缓存 key）
		 * 多编译器时用于区分缓存
		 */
		this.compilerPath = "";

		// ===== 状态标记 =====

		/**
		 * 是否正在运行
		 * 用于防止并发编译
		 * @type {boolean}
		 */
		this.running = false;

		/**
		 * 是否空闲（watch 模式下）
		 * @type {boolean}
		 */
		this.idle = false;

		/**
		 * 是否是 watch 模式
		 * @type {boolean}
		 */
		this.watchMode = false;

		// 向后兼容标记
		this._backCompat = this.options.experiments.backCompat !== false;

		// ===== 缓存最后的对象（性能优化）=====

		/**
		 * 上次的 Compilation 实例
		 * 用于某些优化场景
		 * @type {Compilation}
		 */
		this._lastCompilation = undefined;

		/**
		 * 上次的 NormalModuleFactory 实例
		 * 可以复用减少创建开销
		 * @type {NormalModuleFactory}
		 */
		this._lastNormalModuleFactory = undefined;

		// ===== 资源输出缓存（内部使用）=====

		/**
		 * 资源输出源码缓存
		 * 记录哪些文件已经写入，避免重复写入
		 * @private
		 * @type {WeakMap<Source, { sizeOnlySource: SizeOnlySource, writtenTo: Map<string, number> }>}
		 */
		this._assetEmittingSourceCache = new WeakMap();

		/**
		 * 已写入的文件映射
		 * @private
		 * @type {Map<string, number>}
		 */
		this._assetEmittingWrittenFiles = new Map();

		/**
		 * 上次输出的文件集合
		 * 用于清理旧文件
		 * @private
		 * @type {Set<string>}
		 */
		this._assetEmittingPreviousFiles = new Set();
	}

	/**
	 * @param {string} name cache name
	 * @returns {CacheFacade} the cache facade instance
	 */
	getCache(name) {
		return new CacheFacade(
			this.cache,
			`${this.compilerPath}${name}`,
			this.options.output.hashFunction
		);
	}

	/**
	 * @param {string | (function(): string)} name name of the logger, or function called once to get the logger name
	 * @returns {Logger} a logger with that name
	 */
	getInfrastructureLogger(name) {
		if (!name) {
			throw new TypeError(
				"Compiler.getInfrastructureLogger(name) called without a name"
			);
		}
		return new Logger(
			(type, args) => {
				if (typeof name === "function") {
					name = name();
					if (!name) {
						throw new TypeError(
							"Compiler.getInfrastructureLogger(name) called with a function not returning a name"
						);
					}
				}
				if (this.hooks.infrastructureLog.call(name, type, args) === undefined) {
					if (this.infrastructureLogger !== undefined) {
						this.infrastructureLogger(name, type, args);
					}
				}
			},
			childName => {
				if (typeof name === "function") {
					if (typeof childName === "function") {
						return this.getInfrastructureLogger(() => {
							if (typeof name === "function") {
								name = name();
								if (!name) {
									throw new TypeError(
										"Compiler.getInfrastructureLogger(name) called with a function not returning a name"
									);
								}
							}
							if (typeof childName === "function") {
								childName = childName();
								if (!childName) {
									throw new TypeError(
										"Logger.getChildLogger(name) called with a function not returning a name"
									);
								}
							}
							return `${name}/${childName}`;
						});
					} else {
						return this.getInfrastructureLogger(() => {
							if (typeof name === "function") {
								name = name();
								if (!name) {
									throw new TypeError(
										"Compiler.getInfrastructureLogger(name) called with a function not returning a name"
									);
								}
							}
							return `${name}/${childName}`;
						});
					}
				} else {
					if (typeof childName === "function") {
						return this.getInfrastructureLogger(() => {
							if (typeof childName === "function") {
								childName = childName();
								if (!childName) {
									throw new TypeError(
										"Logger.getChildLogger(name) called with a function not returning a name"
									);
								}
							}
							return `${name}/${childName}`;
						});
					} else {
						return this.getInfrastructureLogger(`${name}/${childName}`);
					}
				}
			}
		);
	}

	// TODO webpack 6: solve this in a better way
	// e.g. move compilation specific info from Modules into ModuleGraph
	_cleanupLastCompilation() {
		if (this._lastCompilation !== undefined) {
			for (const module of this._lastCompilation.modules) {
				ChunkGraph.clearChunkGraphForModule(module);
				ModuleGraph.clearModuleGraphForModule(module);
				module.cleanupForCache();
			}
			for (const chunk of this._lastCompilation.chunks) {
				ChunkGraph.clearChunkGraphForChunk(chunk);
			}
			this._lastCompilation = undefined;
		}
	}

	// TODO webpack 6: solve this in a better way
	_cleanupLastNormalModuleFactory() {
		if (this._lastNormalModuleFactory !== undefined) {
			this._lastNormalModuleFactory.cleanupForCache();
			this._lastNormalModuleFactory = undefined;
		}
	}

	/**
	 * 启动监听模式（持续编译）⭐⭐⭐
	 *
	 * 【作用】
	 * 启动 watch 模式，监听文件变化并自动重新编译
	 *
	 * 【与 run() 的区别】
	 * - run(): 单次编译，完成后停止
	 * - watch(): 持续监听，文件变化时自动重新编译
	 *
	 * 【工作流程】
	 * ```
	 * watch()
	 *   ↓
	 * 创建 Watching 实例
	 *   ↓
	 * 首次编译（类似 run）
	 *   ↓
	 * 监听文件变化（使用 watchpack）
	 *   ↓
	 * [文件变化]
	 *   ↓
	 * invalid 钩子
	 *   ↓
	 * watchRun 钩子（替代 beforeRun + run）
	 *   ↓
	 * 重新编译（compile）
	 *   ↓
	 * 循环...
	 * ```
	 *
	 * 【监听内容】⭐
	 * 监听的文件来自：
	 * - compilation.fileDependencies: 源文件
	 * - compilation.contextDependencies: 目录
	 * - compilation.missingDependencies: 缺失的文件
	 *
	 * 【停止监听】
	 * ```javascript
	 * const watching = compiler.watch(options, handler);
	 *
	 * // 停止监听
	 * watching.close(() => {
	 *   console.log('Watching stopped');
	 * });
	 * ```
	 *
	 * 【增量编译】⭐
	 * watch 模式支持增量编译：
	 * - 只重新构建变化的模块
	 * - 复用未变化模块的缓存
	 * - 大幅提升重新编译速度（10-100 倍）
	 *
	 * 【使用示例】
	 * ```javascript
	 * const webpack = require('webpack');
	 * const compiler = webpack(config);
	 *
	 * const watching = compiler.watch({
	 *   aggregateTimeout: 300,  // 延迟 300ms（防抖）
	 *   poll: false             // 是否使用轮询
	 * }, (err, stats) => {
	 *   if (err) {
	 *     console.error(err);
	 *     return;
	 *   }
	 *   console.log(stats.toString());
	 * });
	 * ```
	 *
	 * 【性能优化】
	 * - aggregateTimeout: 文件变化后等待一段时间再编译（防抖）
	 * - ignored: 忽略某些文件的变化（如 node_modules）
	 * - poll: 某些文件系统不支持事件，使用轮询
	 *
	 * @param {WatchOptions} watchOptions - 监听选项
	 * @param {Callback<Stats>} handler - 每次编译完成的回调
	 * @returns {Watching} 监听管理器实例
	 */
	watch(watchOptions, handler) {
		// 防止并发（与 run 方法相同的检查）
		if (this.running) {
			return handler(new ConcurrentCompilationError());
		}

		// 设置运行和监听标记
		this.running = true;
		this.watchMode = true;

		// 创建 Watching 实例
		/**
		 * Watching 负责：
		 * 1. 首次编译
		 * 2. 监听文件变化
		 * 3. 触发重新编译
		 * 4. 管理编译队列
		 * 5. 提供停止接口
		 */
		this.watching = new Watching(this, watchOptions, handler);

		return this.watching;
	}

	/**
	 * 执行单次编译（最核心的方法之一！）⭐⭐⭐
	 *
	 * 【作用】
	 * 启动一次完整的编译流程，从读取源文件到输出构建产物
	 *
	 * 【执行流程】
	 * ```
	 * 1. 检查并发编译
	 * 2. 触发 beforeRun 钩子
	 * 3. 触发 run 钩子
	 * 4. 读取 records
	 * 5. 执行编译（compile）
	 * 6. 判断是否输出（shouldEmit）
	 * 7. 输出资源（emitAssets）
	 * 8. 写入 records
	 * 9. 存储缓存
	 * 10. 触发 done 钩子
	 * 11. 清理资源
	 * ```
	 *
	 * 【与 watch 的区别】
	 * - run: 单次编译，完成后停止
	 * - watch: 持续监听文件，自动重新编译
	 *
	 * 【调用示例】
	 * ```javascript
	 * compiler.run((err, stats) => {
	 *   if (err) {
	 *     console.error(err);
	 *     return;
	 *   }
	 *   console.log(stats.toString());
	 * });
	 * ```
	 *
	 * 【并发控制】
	 * 同一时间只能运行一次编译，否则抛出 ConcurrentCompilationError
	 *
	 * @param {Callback<Stats>} callback - 编译完成回调
	 * @returns {void}
	 */
	run(callback) {
		// 步骤1: 防止并发编译（重要！）⭐
		if (this.running) {
			// 已经在运行，返回错误
			return callback(new ConcurrentCompilationError());
		}

		// 日志记录器（延迟创建）
		let logger;

		/**
		 * 最终回调函数（统一的结束处理）
		 *
		 * 【职责】
		 * 1. 标记编译器为空闲状态
		 * 2. 缓存进入空闲状态
		 * 3. 重置 running 标记
		 * 4. 触发失败钩子（如果有错误）
		 * 5. 调用用户回调
		 * 6. 触发 afterDone 钩子
		 */
		const finalCallback = (err, stats) => {
			// 进入空闲状态
			if (logger) logger.time("beginIdle");
			this.idle = true;
			this.cache.beginIdle(); // 缓存也进入空闲状态
			this.idle = true;
			if (logger) logger.timeEnd("beginIdle");

			// 重置运行状态
			this.running = false;

			// 如果有错误，触发 failed 钩子
			if (err) {
				this.hooks.failed.call(err);
			}

			// 调用用户提供的回调
			if (callback !== undefined) callback(err, stats);

			// 触发 afterDone 钩子（同步，用于不需要异步的收尾工作）
			this.hooks.afterDone.call(stats);
		};

		// 记录开始时间（用于性能分析）
		const startTime = Date.now();

		// 步骤2: 标记为运行中
		this.running = true;

		/**
		 * 编译完成回调（处理输出和收尾）
		 *
		 * 【执行流程】
		 * 1. 判断是否输出（shouldEmit 钩子）
		 * 2. 输出资源文件（emitAssets）
		 * 3. 检查是否需要额外编译轮次
		 * 4. 写入 records
		 * 5. 存储缓存依赖
		 * 6. 触发 done 钩子
		 */
		const onCompiled = (err, compilation) => {
			// 如果编译失败，直接结束
			if (err) return finalCallback(err);

			// 步骤1: 判断是否应该输出文件
			// 插件可以返回 false 阻止输出（如只做类型检查的场景）
			if (this.hooks.shouldEmit.call(compilation) === false) {
				// 不输出文件，直接完成
				compilation.startTime = startTime;
				compilation.endTime = Date.now();
				const stats = new Stats(compilation);

				// 触发 done 钩子并结束
				this.hooks.done.callAsync(stats, err => {
					if (err) return finalCallback(err);
					return finalCallback(null, stats);
				});
				return;
			}

			// 步骤2-6: 使用 nextTick 避免阻塞
			process.nextTick(() => {
				// 创建日志记录器
				logger = compilation.getLogger("webpack.Compiler");

				// 步骤2: 输出资源文件 ⭐⭐⭐
				logger.time("emitAssets");
				this.emitAssets(compilation, err => {
					logger.timeEnd("emitAssets");
					if (err) return finalCallback(err);

					// 步骤3: 检查是否需要额外编译轮次
					// 某些优化需要多轮编译
					if (compilation.hooks.needAdditionalPass.call()) {
						compilation.needAdditionalPass = true;

						// 记录时间并创建统计对象
						compilation.startTime = startTime;
						compilation.endTime = Date.now();
						logger.time("done hook");
						const stats = new Stats(compilation);

						// 触发 done 钩子
						this.hooks.done.callAsync(stats, err => {
							logger.timeEnd("done hook");
							if (err) return finalCallback(err);

							// 触发 additionalPass 钩子，然后重新编译
							this.hooks.additionalPass.callAsync(err => {
								if (err) return finalCallback(err);
								// 递归调用 compile，开始新一轮编译
								this.compile(onCompiled);
							});
						});
						return;
					}

					// 步骤4: 写入 records 文件
					logger.time("emitRecords");
					this.emitRecords(err => {
						logger.timeEnd("emitRecords");
						if (err) return finalCallback(err);

						// 步骤5-6: 完成编译
						compilation.startTime = startTime;
						compilation.endTime = Date.now();
						logger.time("done hook");
						const stats = new Stats(compilation);

						// 触发 done 钩子
						this.hooks.done.callAsync(stats, err => {
							logger.timeEnd("done hook");
							if (err) return finalCallback(err);

							// 步骤6: 存储构建依赖到缓存
							// 用于下次构建的增量编译
							this.cache.storeBuildDependencies(
								compilation.buildDependencies,
								err => {
									if (err) return finalCallback(err);
									// 所有工作完成！
									return finalCallback(null, stats);
								}
							);
						});
					});
				});
			});
		};

		/**
		 * 内部 run 函数（执行钩子链）
		 *
		 * 【钩子调用顺序】
		 * beforeRun → run → readRecords → compile
		 *
		 * 【为什么嵌套调用】
		 * 这些都是异步钩子，需要按顺序执行：
		 * - 等待 beforeRun 完成
		 * - 再触发 run
		 * - 再读取 records
		 * - 最后开始编译
		 */
		const run = () => {
			// 步骤3: 触发 beforeRun 钩子
			// 用于清理缓存、准备资源等
			this.hooks.beforeRun.callAsync(this, err => {
				if (err) return finalCallback(err);

				// 步骤4: 触发 run 钩子
				// 表示即将开始编译
				this.hooks.run.callAsync(this, err => {
					if (err) return finalCallback(err);

					// 步骤5: 读取 records 文件
					// records 记录了上次编译的模块 ID、chunk ID 等
					this.readRecords(err => {
						if (err) return finalCallback(err);

						// 步骤6: 开始编译！⭐⭐⭐
						// compile 会创建 Compilation 实例并执行构建
						this.compile(onCompiled);
					});
				});
			});
		};

		// 步骤0: 处理空闲状态
		// 如果缓存在空闲状态，先结束空闲再开始编译
		if (this.idle) {
			this.cache.endIdle(err => {
				if (err) return finalCallback(err);

				// 标记为非空闲状态
				this.idle = false;
				// 开始执行 run 流程
				run();
			});
		} else {
			// 缓存不在空闲状态，直接执行
			run();
		}
	}

	/**
	 * @param {RunAsChildCallback} callback signals when the call finishes
	 * @returns {void}
	 */
	runAsChild(callback) {
		const startTime = Date.now();

		const finalCallback = (err, entries, compilation) => {
			try {
				callback(err, entries, compilation);
			} catch (e) {
				const err = new WebpackError(
					`compiler.runAsChild callback error: ${e}`
				);
				err.details = e.stack;
				this.parentCompilation.errors.push(err);
			}
		};

		this.compile((err, compilation) => {
			if (err) return finalCallback(err);

			this.parentCompilation.children.push(compilation);
			for (const { name, source, info } of compilation.getAssets()) {
				this.parentCompilation.emitAsset(name, source, info);
			}

			const entries = [];
			for (const ep of compilation.entrypoints.values()) {
				entries.push(...ep.chunks);
			}

			compilation.startTime = startTime;
			compilation.endTime = Date.now();

			return finalCallback(null, entries, compilation);
		});
	}

	purgeInputFileSystem() {
		if (this.inputFileSystem && this.inputFileSystem.purge) {
			this.inputFileSystem.purge();
		}
	}

	/**
	 * 输出资源文件（Emit 阶段的核心）⭐⭐⭐
	 *
	 * 【作用】
	 * 将 compilation.assets 中的所有资源写入磁盘
	 *
	 * 【执行流程】
	 * ```
	 * emitAssets(compilation)
	 *   ├─ 触发 emit 钩子（最后修改资源的机会）
	 *   ├─ 创建输出目录（如果不存在）
	 *   ├─ 遍历所有资源（compilation.assets）
	 *   │   ├─ 检查大小写冲突
	 *   │   ├─ 检查是否需要写入（缓存优化）
	 *   │   ├─ 获取文件内容（source.buffer()）
	 *   │   ├─ 写入文件（outputFileSystem.writeFile）
	 *   │   └─ 触发 assetEmitted 钩子
	 *   ├─ 触发 afterEmit 钩子
	 *   └─ 完成
	 * ```
	 *
	 * 【性能优化】⭐⭐
	 *
	 * 1. **并发控制**：
	 *    asyncLib.forEachLimit(assets, 15, ...)
	 *    最多同时写入 15 个文件（避免文件句柄耗尽）
	 *
	 * 2. **缓存检查**：
	 *    - 检查文件是否已写入
	 *    - 检查内容是否变化
	 *    - 未变化则跳过写入
	 *
	 * 3. **不可变文件**：
	 *    - 文件名包含 contenthash
	 *    - 内容不变，永远不需要重写
	 *    - 直接跳过
	 *
	 * 4. **相似文件检测**：
	 *    - 检查大小写不同但实际相同的文件名
	 *    - 避免在不区分大小写的文件系统上冲突
	 *
	 * 【大小写冲突检测】⭐
	 * 问题：
	 * - Windows/macOS 文件系统不区分大小写
	 * - Main.js 和 main.js 是同一个文件
	 * - 但在 Linux 上是不同的文件
	 *
	 * 解决：
	 * - 使用 caseInsensitiveMap 检测
	 * - 如果检测到冲突，抛出错误
	 *
	 * 【调用时机】
	 * 在 run() 方法的 onCompiled 回调中调用（Emit 阶段）
	 *
	 * @param {Compilation} compilation - 编译实例
	 * @param {Callback<void>} callback - 完成回调
	 * @returns {void}
	 */
	emitAssets(compilation, callback) {
		// 输出路径（会在 emit 钩子中确定）
		let outputPath;

		/**
		 * emitFiles - 实际写入文件的函数
		 *
		 * 【执行内容】
		 * 1. 获取所有资源
		 * 2. 并发写入文件（最多 15 个并发）
		 * 3. 触发 assetEmitted 钩子
		 */
		const emitFiles = err => {
			if (err) return callback(err);

			// 获取所有资源（文件名 → Source 对象）
			const assets = compilation.getAssets();

			// 浅拷贝 assets（防止并发修改）
			compilation.assets = { ...compilation.assets };

			/**
			 * 大小写不敏感的文件映射
			 *
			 * 【用途】
			 * 检测大小写不同但实际相同的文件名
			 * 例如：Main.js 和 main.js
			 *
			 * @type {Map<string, { path: string, source: Source, size: number, waiting: { cacheEntry: any, file: string }[] }>}
			 */
			const caseInsensitiveMap = new Map();

			/**
			 * 所有目标路径集合
			 * 用于最后的清理工作
			 * @type {Set<string>}
			 */
			const allTargetPaths = new Set();

			// ===== 并发写入所有资源文件 =====
			/**
			 * 使用 asyncLib.forEachLimit 并发处理：
			 * - 最多同时处理 15 个文件
			 * - 避免打开过多文件句柄
			 * - 提升写入性能
			 */
			asyncLib.forEachLimit(
				assets,
				15,  // 并发数限制
				({ name: file, source, info }, callback) => {
					// 处理文件名（移除查询字符串）
					let targetFile = file;
					let immutable = info.immutable;

					// 检查是否有查询字符串（如 main.js?v=123）
					const queryStringIdx = targetFile.indexOf("?");
					if (queryStringIdx >= 0) {
						// 移除查询字符串，只保留文件名
						targetFile = targetFile.slice(0, queryStringIdx);

						// 重新检查文件是否不可变
						// 如果查询字符串中包含哈希，移除后需要重新判断
						immutable =
							immutable &&
							(includesHash(targetFile, info.contenthash) ||
								includesHash(targetFile, info.chunkhash) ||
								includesHash(targetFile, info.modulehash) ||
								includesHash(targetFile, info.fullhash));
					}

					/**
					 * writeOut - 实际写入文件的函数
					 *
					 * 【执行流程】
					 * 1. 确定目标路径
					 * 2. 检查缓存（是否已写入）
					 * 3. 检查大小写冲突
					 * 4. 决定是否需要写入
					 * 5. 写入文件或复用缓存
					 */
					const writeOut = err => {
						if (err) return callback(err);

						// 计算目标路径（输出目录 + 文件名）
						const targetPath = join(
							this.outputFileSystem,
							outputPath,
							targetFile
						);

						// 记录目标路径（用于后续清理）
						allTargetPaths.add(targetPath);

						// ===== 缓存检查：文件是否已写入 ⭐ =====
						// 获取该路径的文件代数（generation）
						const targetFileGeneration =
							this._assetEmittingWrittenFiles.get(targetPath);

						// ===== 为 Source 创建或获取缓存条目 =====
						let cacheEntry = this._assetEmittingSourceCache.get(source);
						if (cacheEntry === undefined) {
							// 首次写入此 Source，创建缓存条目
							cacheEntry = {
								sizeOnlySource: undefined,  // 只包含大小的 Source（优化）
								writtenTo: new Map()         // 写入位置的映射
							};
							this._assetEmittingSourceCache.set(source, cacheEntry);
						}

						let similarEntry;

						/**
						 * 检查大小写相似的文件 ⭐⭐
						 *
						 * 【作用】
						 * 防止在不区分大小写的文件系统上冲突：
						 * - Windows: Main.js 和 main.js 是同一个文件
						 * - macOS: 默认不区分大小写
						 * - Linux: 区分大小写
						 *
						 * 【检测逻辑】
						 * 1. 将路径转为小写
						 * 2. 检查是否已有相似路径
						 * 3. 如果有：
						 *    - 内容相同：复用（优化）
						 *    - 内容不同：报错（冲突）
						 *
						 * @returns {boolean} true 表示找到相似文件
						 */
						const checkSimilarFile = () => {
							// 转为小写进行比较
							const caseInsensitiveTargetPath = targetPath.toLowerCase();
							similarEntry = caseInsensitiveMap.get(caseInsensitiveTargetPath);

							if (similarEntry !== undefined) {
								// 找到相似的文件
								const { path: other, source: otherSource } = similarEntry;

								// 检查内容是否相同
								if (isSourceEqual(otherSource, source)) {
									// 内容相同，可以复用！⭐
									// 等待大小信息可用后更新
									if (similarEntry.size !== undefined) {
										updateWithReplacementSource(similarEntry.size);
									} else {
										// 大小还不可用，添加到等待列表
										if (!similarEntry.waiting) similarEntry.waiting = [];
										similarEntry.waiting.push({ file, cacheEntry });
									}
									alreadyWritten();  // 标记为已写入
								} else {
									// 内容不同，这是冲突！⚠️
									const err =
										new WebpackError(`Prevent writing to file that only differs in casing or query string from already written file.
This will lead to a race-condition and corrupted files on case-insensitive file systems.
${targetPath}
${other}`);
									err.file = file;
									callback(err);
								}
								return true;  // 找到相似文件
							} else {
								// 没有相似文件，记录此文件
								caseInsensitiveMap.set(
									caseInsensitiveTargetPath,
									(similarEntry = {
										path: targetPath,
										source,
										size: undefined,
										waiting: undefined
									})
								);
								return false;  // 没有找到相似文件
							}
						};

						/**
						 * 从 Source 对象获取二进制内容
						 *
						 * 【兼容性处理】
						 * Source 对象可能提供不同的方法：
						 * - buffer(): 直接返回 Buffer（优先）
						 * - source(): 返回字符串或 Buffer
						 *
						 * @returns {Buffer} 文件内容（Buffer 格式）
						 */
						const getContent = () => {
							if (typeof source.buffer === "function") {
								// 优先使用 buffer 方法（性能更好）
								return source.buffer();
							} else {
								// 使用 source 方法
								const bufferOrString = source.source();
								if (Buffer.isBuffer(bufferOrString)) {
									return bufferOrString;
								} else {
									// 字符串转 Buffer
									return Buffer.from(bufferOrString, "utf8");
								}
							}
						};

						/**
						 * 标记文件已写入（缓存优化）
						 *
						 * 【作用】
						 * 记录 Source 已写入到指定位置：
						 * 1. 更新文件代数（generation）
						 * 2. 记录到缓存
						 * 3. 下次相同内容可以跳过写入
						 *
						 * 【文件代数（generation）】⭐
						 * 用于跟踪文件的写入次数：
						 * - undefined: 从未写入
						 * - 1: 首次写入
						 * - 2+: 多次写入
						 *
						 * 用途：判断文件是否需要重新写入
						 */
						const alreadyWritten = () => {
							// 记录 Source 已写入到此位置
							if (targetFileGeneration === undefined) {
								// 首次写入，代数为 1
								const newGeneration = 1;
								this._assetEmittingWrittenFiles.set(targetPath, newGeneration);
								cacheEntry.writtenTo.set(targetPath, newGeneration);
							} else {
								// 已存在，使用当前代数
								cacheEntry.writtenTo.set(targetPath, targetFileGeneration);
							}
							callback();
						};

						/**
						 * 实际写入文件到文件系统 ⭐⭐⭐
						 *
						 * 【执行步骤】
						 * 1. 调用 outputFileSystem.writeFile 写入文件
						 * 2. 标记资源已输出（emittedAssets）
						 * 3. 更新文件代数
						 * 4. 触发 assetEmitted 钩子
						 *
						 * 【assetEmitted 钩子】
						 * 插件可以在这里：
						 * - 上传文件到 CDN
						 * - 生成文件清单
						 * - 通知外部服务
						 *
						 * @param {Buffer} content - 要写入的内容
						 * @returns {void}
						 */
						const doWrite = content => {
							// 写入文件到输出文件系统
							this.outputFileSystem.writeFile(targetPath, content, err => {
								if (err) return callback(err);

								// 标记资源已输出
								compilation.emittedAssets.add(file);

								// 更新文件代数（+1）
								const newGeneration =
									targetFileGeneration === undefined
										? 1
										: targetFileGeneration + 1;

								// 缓存写入信息
								cacheEntry.writtenTo.set(targetPath, newGeneration);
								this._assetEmittingWrittenFiles.set(targetPath, newGeneration);

								// ===== 触发 assetEmitted 钩子 =====
								/**
								 * 传递给插件的信息：
								 * - file: 文件名
								 * - content: 文件内容
								 * - source: Source 对象
								 * - outputPath: 输出目录
								 * - compilation: 编译实例
								 * - targetPath: 完整路径
								 */
								this.hooks.assetEmitted.callAsync(
									file,
									{
										content,
										source,
										outputPath,
										compilation,
										targetPath
									},
									callback
								);
							});
						};

						/**
						 * 用替换 Source 更新（内存优化）⭐⭐
						 *
						 * 【作用】
						 * 将完整的 Source 替换为只包含大小信息的 Source
						 *
						 * 【为什么这样做】
						 * - 完整 Source 包含所有代码内容，占用大量内存
						 * - 文件写入后，只需要知道大小即可
						 * - 使用 SizeOnlySource 替换，释放内存
						 *
						 * 【场景】
						 * watch 模式下，可能有很多次编译
						 * 如果保留所有 Source，内存会爆炸
						 *
						 * @param {number} size - 文件大小
						 */
						const updateWithReplacementSource = size => {
							// 更新当前文件
							updateFileWithReplacementSource(file, cacheEntry, size);

							// 更新相似文件的大小
							similarEntry.size = size;

							// 更新等待列表中的所有文件
							if (similarEntry.waiting !== undefined) {
								for (const { file, cacheEntry } of similarEntry.waiting) {
									updateFileWithReplacementSource(file, cacheEntry, size);
								}
							}
						};

						/**
						 * 用只包含大小的 Source 替换完整 Source（GC 优化）⭐⭐
						 *
						 * 【内存优化原理】
						 * ```
						 * 优化前：
						 * compilation.assets['main.js'] = Source（包含完整代码，1MB 内存）
						 *
						 * 优化后：
						 * compilation.assets['main.js'] = SizeOnlySource（只有大小，100 字节）
						 * ```
						 *
						 * 完整 Source 可以被 GC 回收，释放内存
						 *
						 * @param {string} file - 文件名
						 * @param {Object} cacheEntry - 缓存条目
						 * @param {number} size - 文件大小
						 */
						const updateFileWithReplacementSource = (
							file,
							cacheEntry,
							size
						) => {
							// 创建只包含大小的 Source（如果还没有）
							// 这个 Source 只提供 size() 方法，不包含实际内容
							if (!cacheEntry.sizeOnlySource) {
								cacheEntry.sizeOnlySource = new SizeOnlySource(size);
							}

							// 更新资源：用 SizeOnlySource 替换完整 Source
							// 原来的 Source 可以被 GC，释放内存
							compilation.updateAsset(file, cacheEntry.sizeOnlySource, {
								size
							});
						};

						/**
						 * 处理已存在的文件 ⭐⭐
						 *
						 * 【作用】
						 * 文件已存在时的处理逻辑
						 *
						 * 【优化策略】
						 * 1. 如果是不可变文件（contenthash）→ 直接跳过
						 * 2. 比较文件大小 → 大小不同必然内容不同
						 * 3. 大小相同 → 读取文件内容比较
						 * 4. 内容相同 → 跳过写入（保持 mtime）
						 * 5. 内容不同 → 写入新文件
						 *
						 * 【为什么保持 mtime】⭐
						 * - mtime 变化会触发 watch 工具
						 * - 内容未变但 mtime 变了 → 不必要的重新加载
						 * - 保持 mtime 不变 → 避免误触发
						 *
						 * @param {Object} stats - 文件统计信息
						 */
						const processExistingFile = stats => {
							// ===== 优化1: 不可变文件跳过 ⭐ =====
							// 文件名包含 contenthash，内容不变 → 直接跳过
							if (immutable) {
								updateWithReplacementSource(stats.size);
								return alreadyWritten();
							}

							// ===== 获取新文件内容 =====
							const content = getContent();

							// 更新为 SizeOnlySource（释放内存）
							updateWithReplacementSource(content.length);

							// ===== 优化2: 比较文件大小（快速检查）⭐ =====
							/**
							 * 快速负面匹配：
							 * - 大小不同 → 内容必然不同 → 直接写入
							 * - 大小相同 → 可能内容相同 → 需要详细比较
							 *
							 * 这个检查很快，避免了读取文件内容
							 */
							if (content.length === stats.size) {
								// 大小相同，需要比较内容

								// 标记此文件已比较（统计用）
								compilation.comparedForEmitAssets.add(file);

								// ===== 读取现有文件内容并比较 =====
								return this.outputFileSystem.readFile(
									targetPath,
									(err, existingContent) => {
										if (
											err ||
											!content.equals(/** @type {Buffer} */ (existingContent))
										) {
											// 内容不同，需要写入
											return doWrite(content);
										} else {
											// ⭐ 内容完全相同，跳过写入
											// 保持文件的 mtime 不变
											return alreadyWritten();
										}
									}
								);
							}

							// 大小不同，直接写入
							return doWrite(content);
						};

						/**
						 * 处理不存在的文件
						 *
						 * 【作用】
						 * 文件不存在时，直接写入
						 *
						 * 【执行内容】
						 * 1. 获取文件内容
						 * 2. 更新为 SizeOnlySource
						 * 3. 写入文件
						 */
						const processMissingFile = () => {
							// 获取文件内容
							const content = getContent();

							// 更新为 SizeOnlySource（释放内存）
							updateWithReplacementSource(content.length);

							// 写入文件
							return doWrite(content);
						};

						// ===== 缓存检查：文件是否已写入 ⭐⭐⭐ =====

						// 检查该路径是否在本次编译中已被写入过
						if (targetFileGeneration !== undefined) {
							// 路径已被写入过

							// 检查当前 Source 是否已写入到这个路径
							const writtenGeneration = cacheEntry.writtenTo.get(targetPath);

							if (writtenGeneration === targetFileGeneration) {
								// ===== 情况1: 相同的 Source 已写入到相同的路径 ⭐ =====
								/**
								 * 这意味着：
								 * - 这个 Source 之前已经写入过此路径
								 * - 文件代数相同，说明文件未被其他写入覆盖
								 * - 可能可以跳过写入
								 *
								 * 【假设】
								 * 编译运行期间，用户不会修改输出文件
								 * （除非删除文件）
								 */

								if (this._assetEmittingPreviousFiles.has(targetPath)) {
									// ⭐ 文件在上次编译中也输出了
									// 我们假设文件仍然在磁盘上（未被删除）
									// 直接跳过写入，节省 I/O

									compilation.updateAsset(file, cacheEntry.sizeOnlySource, {
										size: cacheEntry.sizeOnlySource.size()
									});

									return callback();
								} else {
									// 文件在上次编译中没有输出
									// 可能是新文件或被删除了
									// 设置为不可变，简化后续检查
									immutable = true;
								}
							} else if (!immutable) {
								// ===== 情况2: 文件代数不同（文件可能被覆盖）=====

								// 检查大小写相似文件
								if (checkSimilarFile()) return;

								/**
								 * 文件代数不同意味着：
								 * - 同一路径被写入了不同的内容
								 * - 内容很可能不同
								 *
								 * 【性能优化】⭐
								 * 跳过内容比较，直接当作新文件处理
								 * 这在 watch 模式下很常见（文件频繁变化）
								 */
								return processMissingFile();
							}
						}

						// ===== 检查大小写相似文件 =====
						if (checkSimilarFile()) return;

						// ===== 决定是否比较文件内容 ⭐ =====
						if (this.options.output.compareBeforeEmit) {
							// 配置开启了写入前比较
							// 检查文件是否存在
							this.outputFileSystem.stat(targetPath, (err, stats) => {
								const exists = !err && stats.isFile();

								if (exists) {
									// 文件存在，使用详细比较流程
									processExistingFile(stats);
								} else {
									// 文件不存在，直接写入
									processMissingFile();
								}
							});
						} else {
							// 未开启写入前比较，直接写入
							// （更快，但可能写入相同内容）
							processMissingFile();
						}
					};

					// ===== 创建输出目录（如果需要）=====
					/**
					 * 检查文件名是否包含目录分隔符
					 * 如果包含，需要先创建目录
					 *
					 * 【示例】
					 * - 'main.js' → 不需要创建目录
					 * - 'static/js/main.js' → 需要创建 static/js 目录
					 */
					if (targetFile.match(/\/|\\/)) {
						// 文件名包含路径，需要创建目录
						const fs = this.outputFileSystem;
						const dir = dirname(fs, join(fs, outputPath, targetFile));

						// 递归创建目录（mkdir -p）
						mkdirp(fs, dir, writeOut);
					} else {
						// 文件在输出根目录，直接写入
						writeOut();
					}
				},
				err => {
					// ===== 所有文件处理完成回调 =====

					// 清理大小写映射，释放内存
					caseInsensitiveMap.clear();

					if (err) {
						// 写入过程出错，清理状态
						this._assetEmittingPreviousFiles.clear();
						return callback(err);
					}

					// ===== 记录本次输出的文件 ⭐ =====
					/**
					 * 保存本次输出的所有文件路径
					 *
					 * 【用途】
					 * 下次编译时：
					 * - 如果文件在这个集合中 → 假设仍在磁盘上
					 * - 可以跳过某些检查，提升性能
					 *
					 * 【场景】
					 * watch 模式下的增量编译优化
					 */
					this._assetEmittingPreviousFiles = allTargetPaths;

					// ===== 触发 afterEmit 钩子 =====
					/**
					 * afterEmit 钩子在所有文件写入后触发
					 *
					 * 【插件可以做什么】
					 * - 上传文件到服务器
					 * - 生成文件清单
					 * - 发送通知
					 * - 清理临时文件
					 */
					this.hooks.afterEmit.callAsync(compilation, err => {
						if (err) return callback(err);

						// 所有工作完成
						return callback();
					});
				}
			);
		};

		// ===== emitAssets 主流程开始 =====

		// ===== 步骤1: 触发 emit 钩子 ⭐⭐ =====
		/**
		 * emit 钩子是修改输出内容的最后机会
		 *
		 * 【插件可以做什么】
		 * - 修改资源内容
		 * - 添加额外文件
		 * - 删除某些文件
		 * - 重命名文件
		 *
		 * 【在 emit 之后】
		 * compilation.assets 被冻结，不能再修改
		 */
		this.hooks.emit.callAsync(compilation, err => {
			if (err) return callback(err);

			// ===== 步骤2: 确定输出路径 =====
			// 处理路径占位符（如 [hash]）
			outputPath = compilation.getPath(this.outputPath, {});

			// ===== 步骤3: 创建输出目录并开始写入 =====
			// 递归创建输出目录（如果不存在）
			mkdirp(this.outputFileSystem, outputPath, emitFiles);
		});
	}

	/**
	 * @param {Callback<void>} callback signals when the call finishes
	 * @returns {void}
	 */
	emitRecords(callback) {
		if (this.hooks.emitRecords.isUsed()) {
			if (this.recordsOutputPath) {
				asyncLib.parallel(
					[
						cb => this.hooks.emitRecords.callAsync(cb),
						this._emitRecords.bind(this)
					],
					err => callback(err)
				);
			} else {
				this.hooks.emitRecords.callAsync(callback);
			}
		} else {
			if (this.recordsOutputPath) {
				this._emitRecords(callback);
			} else {
				callback();
			}
		}
	}

	/**
	 * @param {Callback<void>} callback signals when the call finishes
	 * @returns {void}
	 */
	_emitRecords(callback) {
		const writeFile = () => {
			this.outputFileSystem.writeFile(
				this.recordsOutputPath,
				JSON.stringify(
					this.records,
					(n, value) => {
						if (
							typeof value === "object" &&
							value !== null &&
							!Array.isArray(value)
						) {
							const keys = Object.keys(value);
							if (!isSorted(keys)) {
								return sortObject(value, keys);
							}
						}
						return value;
					},
					2
				),
				callback
			);
		};

		const recordsOutputPathDirectory = dirname(
			this.outputFileSystem,
			this.recordsOutputPath
		);
		if (!recordsOutputPathDirectory) {
			return writeFile();
		}
		mkdirp(this.outputFileSystem, recordsOutputPathDirectory, err => {
			if (err) return callback(err);
			writeFile();
		});
	}

	/**
	 * @param {Callback<void>} callback signals when the call finishes
	 * @returns {void}
	 */
	readRecords(callback) {
		if (this.hooks.readRecords.isUsed()) {
			if (this.recordsInputPath) {
				asyncLib.parallel(
					[
						cb => this.hooks.readRecords.callAsync(cb),
						this._readRecords.bind(this)
					],
					err => callback(err)
				);
			} else {
				this.records = {};
				this.hooks.readRecords.callAsync(callback);
			}
		} else {
			if (this.recordsInputPath) {
				this._readRecords(callback);
			} else {
				this.records = {};
				callback();
			}
		}
	}

	/**
	 * @param {Callback<void>} callback signals when the call finishes
	 * @returns {void}
	 */
	_readRecords(callback) {
		if (!this.recordsInputPath) {
			this.records = {};
			return callback();
		}
		this.inputFileSystem.stat(this.recordsInputPath, err => {
			// It doesn't exist
			// We can ignore this.
			if (err) return callback();

			this.inputFileSystem.readFile(this.recordsInputPath, (err, content) => {
				if (err) return callback(err);

				try {
					this.records = parseJson(content.toString("utf-8"));
				} catch (e) {
					return callback(new Error(`Cannot parse records: ${e.message}`));
				}

				return callback();
			});
		});
	}

	/**
	 * @param {Compilation} compilation the compilation
	 * @param {string} compilerName the compiler's name
	 * @param {number} compilerIndex the compiler's index
	 * @param {OutputOptions=} outputOptions the output options
	 * @param {WebpackPluginInstance[]=} plugins the plugins to apply
	 * @returns {Compiler} a child compiler
	 */
	createChildCompiler(
		compilation,
		compilerName,
		compilerIndex,
		outputOptions,
		plugins
	) {
		const childCompiler = new Compiler(this.context, {
			...this.options,
			output: {
				...this.options.output,
				...outputOptions
			}
		});
		childCompiler.name = compilerName;
		childCompiler.outputPath = this.outputPath;
		childCompiler.inputFileSystem = this.inputFileSystem;
		childCompiler.outputFileSystem = null;
		childCompiler.resolverFactory = this.resolverFactory;
		childCompiler.modifiedFiles = this.modifiedFiles;
		childCompiler.removedFiles = this.removedFiles;
		childCompiler.fileTimestamps = this.fileTimestamps;
		childCompiler.contextTimestamps = this.contextTimestamps;
		childCompiler.fsStartTime = this.fsStartTime;
		childCompiler.cache = this.cache;
		childCompiler.compilerPath = `${this.compilerPath}${compilerName}|${compilerIndex}|`;
		childCompiler._backCompat = this._backCompat;

		const relativeCompilerName = makePathsRelative(
			this.context,
			compilerName,
			this.root
		);
		if (!this.records[relativeCompilerName]) {
			this.records[relativeCompilerName] = [];
		}
		if (this.records[relativeCompilerName][compilerIndex]) {
			childCompiler.records = this.records[relativeCompilerName][compilerIndex];
		} else {
			this.records[relativeCompilerName].push((childCompiler.records = {}));
		}

		childCompiler.parentCompilation = compilation;
		childCompiler.root = this.root;
		if (Array.isArray(plugins)) {
			for (const plugin of plugins) {
				if (plugin) {
					plugin.apply(childCompiler);
				}
			}
		}
		for (const name in this.hooks) {
			if (
				![
					"make",
					"compile",
					"emit",
					"afterEmit",
					"invalid",
					"done",
					"thisCompilation"
				].includes(name)
			) {
				if (childCompiler.hooks[name]) {
					childCompiler.hooks[name].taps = this.hooks[name].taps.slice();
				}
			}
		}

		compilation.hooks.childCompiler.call(
			childCompiler,
			compilerName,
			compilerIndex
		);

		return childCompiler;
	}

	isChild() {
		return !!this.parentCompilation;
	}

	createCompilation(params) {
		this._cleanupLastCompilation();
		return (this._lastCompilation = new Compilation(this, params));
	}

	/**
	 * 创建新的 Compilation 实例并触发钩子 ⭐⭐⭐
	 *
	 * 【作用】
	 * 创建 Compilation 实例并触发相关钩子，让插件有机会注册
	 *
	 * 【执行流程】
	 * 1. 调用 createCompilation 创建实例
	 * 2. 设置 compilation 的基本属性
	 * 3. 触发 thisCompilation 钩子（仅主编译器）
	 * 4. 触发 compilation 钩子（主编译器和子编译器都会触发）
	 *
	 * 【两个钩子的区别】⭐
	 * - thisCompilation: 只在主编译器触发，子编译器不触发
	 * - compilation: 主编译器和子编译器都触发
	 *
	 * 【插件注册时机】
	 * 插件通常在这两个钩子中注册 Compilation 的钩子：
	 * ```javascript
	 * compiler.hooks.compilation.tap('MyPlugin', (compilation) => {
	 *   compilation.hooks.buildModule.tap('MyPlugin', (module) => {
	 *     // 模块构建时的逻辑
	 *   });
	 * });
	 * ```
	 *
	 * @param {CompilationParams} params - 编译参数（工厂实例）
	 * @returns {Compilation} 新创建的 Compilation 实例
	 */
	newCompilation(params) {
		// 创建 Compilation 实例
		const compilation = this.createCompilation(params);

		// 设置编译器名称（多编译器场景）
		compilation.name = this.name;

		// 设置 records（用于持久化缓存）
		compilation.records = this.records;

		// 触发 thisCompilation 钩子（仅主编译器）
		this.hooks.thisCompilation.call(compilation, params);

		// 触发 compilation 钩子（所有编译器）
		// 插件在这里注册 Compilation 的钩子
		this.hooks.compilation.call(compilation, params);

		return compilation;
	}

	/**
	 * 创建普通模块工厂 ⭐⭐⭐
	 *
	 * 【作用】
	 * NormalModuleFactory 负责创建普通模块（JS、TS、CSS 等）
	 * 这是 webpack 最常用的模块工厂
	 *
	 * 【工厂的职责】
	 * 1. 解析模块路径（使用 enhanced-resolve）
	 * 2. 匹配 loader 规则
	 * 3. 创建 NormalModule 实例
	 *
	 * 【配置来源】
	 * - context: 工作目录
	 * - fs: 文件系统
	 * - resolverFactory: 解析器工厂
	 * - options: module 配置（loader 规则等）
	 *
	 * 【缓存优化】⭐
	 * 保存到 _lastNormalModuleFactory，可能被复用
	 */
	createNormalModuleFactory() {
		// 清理上次的工厂实例
		this._cleanupLastNormalModuleFactory();

		// 创建新的普通模块工厂
		const normalModuleFactory = new NormalModuleFactory({
			context: this.options.context,              // 工作目录
			fs: this.inputFileSystem,                   // 文件系统
			resolverFactory: this.resolverFactory,      // 解析器工厂
			options: this.options.module,               // 模块配置（loader等）
			associatedObjectForCache: this.root,        // 缓存关联对象
			layers: this.options.experiments.layers     // 实验性：图层功能
		});

		// 缓存工厂实例（性能优化）
		this._lastNormalModuleFactory = normalModuleFactory;

		// 触发 normalModuleFactory 钩子
		// 插件可以在这里注册工厂的钩子（如修改 loader 规则）
		this.hooks.normalModuleFactory.call(normalModuleFactory);

		return normalModuleFactory;
	}

	/**
	 * 创建上下文模块工厂
	 *
	 * 【作用】
	 * ContextModuleFactory 负责处理动态 require：
	 * - require.context()
	 * - 动态路径的 require
	 *
	 * 【示例】
	 * ```javascript
	 * require.context('./locales', true, /\.json$/);
	 * // 动态导入 locales 目录下的所有 .json 文件
	 * ```
	 */
	createContextModuleFactory() {
		const contextModuleFactory = new ContextModuleFactory(this.resolverFactory);

		// 触发 contextModuleFactory 钩子
		this.hooks.contextModuleFactory.call(contextModuleFactory);

		return contextModuleFactory;
	}

	/**
	 * 创建编译参数对象
	 *
	 * 【返回内容】
	 * 包含两个模块工厂：
	 * - normalModuleFactory: 处理普通模块（import/require）
	 * - contextModuleFactory: 处理上下文模块（require.context）
	 *
	 * 【调用时机】
	 * 在 compile() 方法开始时调用
	 *
	 * @returns {CompilationParams} 编译参数
	 */
	newCompilationParams() {
		const params = {
			normalModuleFactory: this.createNormalModuleFactory(),
			contextModuleFactory: this.createContextModuleFactory()
		};
		return params;
	}

	/**
	 * 执行编译（核心流程！）⭐⭐⭐
	 *
	 * 【作用】
	 * 创建 Compilation 实例并执行完整的编译流程
	 *
	 * 【完整流程】
	 * ```
	 * 1. 创建编译参数（NormalModuleFactory、ContextModuleFactory）
	 * 2. beforeCompile 钩子 - 编译前准备
	 * 3. compile 钩子 - 开始编译
	 * 4. 创建 Compilation 实例
	 * 5. make 钩子 - 构建模块（最重要！）⭐⭐⭐
	 *    ├─ 添加入口模块
	 *    ├─ 构建所有模块
	 *    ├─ 解析依赖
	 *    └─ 构建依赖图
	 * 6. finishMake 钩子 - 模块构建完成
	 * 7. compilation.finish() - 完成报告
	 * 8. compilation.seal() - 封装阶段 ⭐⭐⭐
	 *    ├─ 创建 Chunk
	 *    ├─ 优化模块和 Chunk
	 *    ├─ 生成模块 ID 和 Chunk ID
	 *    └─ 生成代码
	 * 9. afterCompile 钩子 - 编译完成
	 * 10. 返回 compilation
	 * ```
	 *
	 * 【关键钩子】
	 * - make: 构建模块（EntryPlugin 在这里添加入口）
	 * - seal: 封装优化（代码分割、Tree Shaking 等）
	 *
	 * 【性能记录】
	 * 使用 logger.time/timeEnd 记录各阶段耗时
	 *
	 * @param {Callback<Compilation>} callback - 编译完成回调
	 * @returns {void}
	 */
	compile(callback) {
		// 步骤1: 创建编译参数（工厂实例）
		// 包含 NormalModuleFactory 和 ContextModuleFactory
		const params = this.newCompilationParams();

		// 步骤2: 触发 beforeCompile 钩子
		// 插件可以在这里修改编译参数
		this.hooks.beforeCompile.callAsync(params, err => {
			if (err) return callback(err);

			// 步骤3: 触发 compile 钩子（同步）
			// 表示即将创建 Compilation 实例
			this.hooks.compile.call(params);

			// 步骤4: 创建 Compilation 实例 ⭐⭐⭐
			// 每次编译都会创建新的 Compilation
			const compilation = this.newCompilation(params);

			// 创建日志记录器
			const logger = compilation.getLogger("webpack.Compiler");

			// 步骤5: 触发 make 钩子 - 构建模块阶段 ⭐⭐⭐
			//
			// 【最重要的钩子！】
			// 所有入口插件都在这里工作：
			// - EntryPlugin: compilation.addEntry(entryDependency)
			// - DllPlugin: 添加 DLL 入口
			//
			// make 钩子完成后，所有模块都已构建，依赖图完成
			logger.time("make hook");
			this.hooks.make.callAsync(compilation, err => {
				logger.timeEnd("make hook");
				if (err) return callback(err);

				// 步骤6: 触发 finishMake 钩子
				// 模块构建完成，准备进入 seal 阶段
				logger.time("finish make hook");
				this.hooks.finishMake.callAsync(compilation, err => {
					logger.timeEnd("finish make hook");
					if (err) return callback(err);

					// 步骤7-8: 使用 nextTick 避免堆栈过深
					process.nextTick(() => {
						// 步骤7: 完成编译（报告错误、警告等）
						logger.time("finish compilation");
						compilation.finish(err => {
							logger.timeEnd("finish compilation");
							if (err) return callback(err);

							// 步骤8: Seal 阶段 - 封装和优化 ⭐⭐⭐
							//
							// 【最关键的阶段！】
							// 在这个阶段：
							// 1. 创建 Chunk（根据入口和代码分割点）
							// 2. 优化模块（Tree Shaking、Scope Hoisting）
							// 3. 优化 Chunk（代码分割、公共模块提取）
							// 4. 生成模块 ID 和 Chunk ID
							// 5. 生成代码（将模块转换为最终代码）
							// 6. 创建资源对象（compilation.assets）
							logger.time("seal compilation");
							compilation.seal(err => {
								logger.timeEnd("seal compilation");
								if (err) return callback(err);

								// 步骤9: 触发 afterCompile 钩子
								// 编译完全完成，包括 seal 阶段
								logger.time("afterCompile hook");
								this.hooks.afterCompile.callAsync(compilation, err => {
									logger.timeEnd("afterCompile hook");
									if (err) return callback(err);

									// 步骤10: 返回 compilation 实例
									// compilation 包含所有构建结果
									return callback(null, compilation);
								});
							});
						});
					});
				});
			});
		});
	}

	/**
	 * 关闭编译器（释放所有资源）⭐⭐
	 *
	 * 【作用】
	 * 优雅地关闭编译器，清理所有资源
	 *
	 * 【清理内容】
	 * 1. 关闭 watching（如果存在）
	 * 2. 触发 shutdown 钩子
	 * 3. 清理编译缓存引用
	 * 4. 关闭缓存系统
	 * 5. 关闭文件监听器
	 * 6. 关闭 worker 线程（如果有）
	 *
	 * 【为什么必须调用】⭐
	 * 不调用 close() 的后果：
	 * - 内存泄漏（缓存、模块不会被 GC）
	 * - 进程无法退出（文件监听器还在运行）
	 * - 文件句柄泄漏（文件系统未关闭）
	 * - worker 线程未关闭
	 *
	 * 【使用示例】
	 * ```javascript
	 * compiler.run((err, stats) => {
	 *   // 处理结果
	 *   console.log(stats.toString());
	 *
	 *   // ⚠️ 重要：必须调用 close
	 *   compiler.close((closeErr) => {
	 *     if (closeErr) {
	 *       console.error(closeErr);
	 *     }
	 *     // 现在可以安全退出
	 *   });
	 * });
	 * ```
	 *
	 * 【注意】
	 * - 关闭是异步的，需要等待回调
	 * - 关闭期间不能启动新的编译
	 * - 如果在 watch 模式，会先关闭 watching
	 *
	 * @param {Callback<void>} callback - 关闭完成回调
	 * @returns {void}
	 */
	close(callback) {
		// 步骤1: 如果还在 watching，先关闭它
		if (this.watching) {
			// When there is still an active watching, close this first
			// 递归调用：watching.close → compiler.close
			this.watching.close(err => {
				this.close(callback);
			});
			return;
		}

		// 步骤2: 触发 shutdown 钩子
		// 插件可以在这里清理自己的资源
		this.hooks.shutdown.callAsync(err => {
			if (err) return callback(err);

			// 步骤3: 清理编译缓存引用（避免内存泄漏）⭐
			//
			// 【重要】
			// 不能调用 _cleanupLastCompilation()，因为：
			// - Stats 对象可能还在使用
			// - Stats 引用了 compilation
			// - 强制清理会导致 Stats 无法访问数据
			//
			// 解决方案：只清理缓存引用
			this._lastCompilation = undefined;
			this._lastNormalModuleFactory = undefined;

			// 步骤4: 关闭缓存系统
			// 这会：
			// - 持久化文件系统缓存
			// - 清理内存缓存
			// - 关闭缓存相关的文件句柄
			this.cache.shutdown(callback);
		});
	}
}

// 导出 Compiler 类
module.exports = Compiler;
