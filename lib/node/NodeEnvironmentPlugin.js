/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

/**
 * lib/node/NodeEnvironmentPlugin.js - Node.js 环境插件 ⭐⭐⭐
 *
 * 【文件作用】
 * 这是 webpack 在 Node.js 环境下运行的基础插件，负责为 Compiler 注入文件系统能力
 *
 * 【核心职责】
 * 1. 注入输入文件系统（inputFileSystem）- 读取源文件
 * 2. 注入输出文件系统（outputFileSystem）- 写入构建产物
 * 3. 注入中间文件系统（intermediateFileSystem）- 处理中间文件
 * 4. 注入监听文件系统（watchFileSystem）- watch 模式使用
 * 5. 创建基础日志系统（infrastructureLogger）
 *
 * 【为什么需要这个插件？】
 * webpack 核心是平台无关的（可以在浏览器、Node.js、Worker 中运行）
 * 文件系统是平台相关的，需要通过插件注入
 *
 * 【何时应用？】
 * 在 createCompiler() 的最早期：
 * ```javascript
 * const compiler = new Compiler(context, options);
 * new NodeEnvironmentPlugin(...).apply(compiler);  // ⭐ 第一个应用的插件
 * ```
 *
 * 【文件系统的类型】
 * - inputFileSystem: CachedInputFileSystem（带缓存，提升性能）
 * - outputFileSystem: graceful-fs（原生 fs 的增强版）
 * - intermediateFileSystem: 同 outputFileSystem
 * - watchFileSystem: NodeWatchFileSystem（基于 chokidar）
 *
 * 【性能优化】
 * - inputFileSystem 带 60 秒缓存（减少磁盘 IO）
 * - graceful-fs 处理文件描述符限制
 * - watch 使用原生事件（inotify/FSEvents）而非轮询
 *
 * 【与其他文件的关系】
 * - 在 lib/webpack.js: createCompiler() 中被应用
 * - 为 Compiler 提供文件操作能力
 * - NormalModule 通过 compiler.inputFileSystem 读取文件
 * - Compiler.emitAssets() 通过 compiler.outputFileSystem 写入文件
 */

"use strict";

// ===== 核心依赖 =====

// CachedInputFileSystem: 带缓存的文件系统（enhanced-resolve 包）
// 作用：缓存文件读取结果，减少磁盘 IO，提升性能
const CachedInputFileSystem = require("enhanced-resolve/lib/CachedInputFileSystem");

// graceful-fs: Node.js fs 模块的增强版
// 作用：
// 1. 优雅处理 EMFILE 错误（文件描述符用尽）
// 2. 自动重试失败的操作
// 3. 修复 Windows 平台的文件锁问题
const fs = require("graceful-fs");

// createConsoleLogger: 创建控制台日志记录器
const createConsoleLogger = require("../logging/createConsoleLogger");

// NodeWatchFileSystem: Node.js 的文件监听系统
// 作用：监听文件变化，用于 watch 模式
const NodeWatchFileSystem = require("./NodeWatchFileSystem");

// nodeConsole: Node.js 控制台输出配置
const nodeConsole = require("./nodeConsole");

/** @typedef {import("../../declarations/WebpackOptions").InfrastructureLogging} InfrastructureLogging */
/** @typedef {import("../Compiler")} Compiler */

/**
 * NodeEnvironmentPlugin - Node.js 环境插件类
 *
 * 【设计模式】
 * 这是一个标准的 webpack 插件，实现了 apply 方法
 *
 * 【何时创建】
 * 在 lib/webpack.js: createCompiler() 中：
 * ```javascript
 * new NodeEnvironmentPlugin({
 *   infrastructureLogging: options.infrastructureLogging
 * }).apply(compiler);
 * ```
 *
 * 【为什么是插件而不是内置？】
 * 1. 平台抽象：webpack 核心不依赖 Node.js
 * 2. 可替换：可以实现其他环境的插件（如浏览器环境）
 * 3. 灵活性：用户可以自定义文件系统（如内存文件系统）
 */
class NodeEnvironmentPlugin {
	/**
	 * 构造函数
	 *
	 * 【参数】
	 * @param {Object} options - 选项对象
	 * @param {InfrastructureLogging} options.infrastructureLogging - 基础设施日志配置
	 *
	 * 【infrastructureLogging 配置项】
	 * - level: 日志级别（'none' | 'error' | 'warn' | 'info' | 'log' | 'verbose'）
	 * - debug: 是否启用调试日志（boolean 或 RegExp）
	 * - colors: 是否使用彩色输出
	 * - appendOnly: 是否只追加（不清屏）
	 * - stream: 输出流（默认 process.stderr）
	 */
	constructor(options) {
		// 保存配置选项
		this.options = options;
	}

	/**
	 * 应用插件到 compiler ⭐⭐⭐
	 *
	 * 【作用】
	 * 这是插件的核心方法，为 compiler 注入 Node.js 环境的能力
	 *
	 * 【执行时机】
	 * 在 createCompiler() 中最早执行，早于：
	 * - 用户插件注册
	 * - 默认配置应用
	 * - 内置插件注册
	 *
	 * 【注入的能力】
	 * 1. 日志系统（infrastructureLogger）
	 * 2. 输入文件系统（inputFileSystem）- 读取源文件
	 * 3. 输出文件系统（outputFileSystem）- 写入构建产物
	 * 4. 中间文件系统（intermediateFileSystem）- 缓存等中间文件
	 * 5. 监听文件系统（watchFileSystem）- watch 模式
	 *
	 * @param {Compiler} compiler - 编译器实例
	 * @returns {void}
	 */
	apply(compiler) {
		// ===== 步骤1: 创建基础日志系统 =====
		/**
		 * infrastructureLogger 用于 webpack 内部日志
		 * 与编译日志（compilation.logger）不同：
		 * - infrastructureLogger: webpack 自身的日志（插件加载、缓存等）
		 * - compilation.logger: 编译过程的日志（模块构建、错误等）
		 */
		const { infrastructureLogging } = this.options;

		compiler.infrastructureLogger = createConsoleLogger({
			// 日志级别（默认 'info'）
			// 可选值：'none' < 'error' < 'warn' < 'info' < 'log' < 'verbose'
			level: infrastructureLogging.level || "info",

			// 调试模式
			// false: 不输出调试日志
			// true: 输出所有调试日志
			// RegExp: 只输出匹配的调试日志（如 /cache/）
			debug: infrastructureLogging.debug || false,

			// 控制台配置
			console:
				infrastructureLogging.console || // 用户自定义控制台
				nodeConsole({
					// 是否使用彩色输出（默认根据终端支持自动检测）
					colors: infrastructureLogging.colors,

					// 是否只追加输出（不清屏，适合 CI 环境）
					appendOnly: infrastructureLogging.appendOnly,

					// 输出流（默认 process.stderr）
					stream: infrastructureLogging.stream
				})
		});

		// ===== 步骤2: 注入输入文件系统 ⭐⭐⭐ =====
		/**
		 * inputFileSystem - 读取源文件的文件系统
		 *
		 * 【使用 CachedInputFileSystem 的原因】
		 * webpack 在编译过程中会多次读取同一个文件：
		 * 1. 解析模块路径时（检查文件是否存在）
		 * 2. loader 执行时（读取文件内容）
		 * 3. watch 模式下（检查文件变化）
		 *
		 * 缓存策略：
		 * - 缓存时长：60000ms（60秒）
		 * - 缓存内容：文件内容、stat 信息、目录列表
		 * - 失效时机：watch 模式下文件变化时、手动调用 purge()
		 *
		 * 性能提升：
		 * - 首次读取：磁盘 IO（慢）
		 * - 缓存命中：内存读取（快 100 倍）
		 * - 缓存命中率：通常 80-90%
		 */
		compiler.inputFileSystem = new CachedInputFileSystem(fs, 60000);

		// 保存引用（用于后续判断文件系统是否被替换）
		const inputFileSystem = compiler.inputFileSystem;

		// ===== 步骤3: 注入输出文件系统 =====
		/**
		 * outputFileSystem - 写入构建产物的文件系统
		 *
		 * 【使用 graceful-fs 的原因】
		 * 原生 fs 模块的问题：
		 * 1. EMFILE 错误：同时打开文件过多时崩溃
		 * 2. Windows 文件锁：文件被占用时操作失败
		 * 3. 并发问题：高并发时可能出错
		 *
		 * graceful-fs 的改进：
		 * 1. 自动队列：文件操作排队，避免 EMFILE
		 * 2. 自动重试：失败时自动重试
		 * 3. 跨平台：修复 Windows 特有问题
		 *
		 * 【应用场景】
		 * - compiler.emitAssets() 写入 bundle 文件
		 * - 写入 records 文件
		 * - 写入缓存文件
		 */
		compiler.outputFileSystem = fs;

		// ===== 步骤4: 注入中间文件系统 =====
		/**
		 * intermediateFileSystem - 处理中间文件的文件系统
		 *
		 * 【用途】
		 * 1. 持久化缓存文件（node_modules/.cache/webpack/）
		 * 2. 临时文件
		 * 3. Records 文件
		 *
		 * 【为什么单独一个？】
		 * 未来可能支持：
		 * - 输出到云存储，中间文件仍在本地
		 * - 输出到特定目录，中间文件放在临时目录
		 *
		 * 【当前实现】
		 * 与 outputFileSystem 相同，都是 graceful-fs
		 */
		compiler.intermediateFileSystem = fs;

		// ===== 步骤5: 注入监听文件系统 ⭐⭐ =====
		/**
		 * watchFileSystem - 监听文件变化的文件系统
		 *
		 * 【NodeWatchFileSystem 的实现】
		 * 基于 chokidar 库，提供跨平台的文件监听：
		 * - Linux: 使用 inotify（内核级通知）
		 * - macOS: 使用 FSEvents（系统级API）
		 * - Windows: 使用 ReadDirectoryChangesW（Win32 API）
		 * - 降级: 轮询（poll）模式
		 *
		 * 【监听策略】
		 * 1. 监听源文件变化（src/）
		 * 2. 监听配置文件变化（webpack.config.js）
		 * 3. 监听 node_modules 中的文件（可选）
		 * 4. 忽略指定目录（如 .git、dist/）
		 *
		 * 【使用场景】
		 * - compiler.watch() 启动监听模式
		 * - webpack-dev-server 监听文件变化
		 * - 文件变化触发重新编译
		 *
		 * 【性能优化】
		 * - 使用原生事件（不是轮询）
		 * - 防抖延迟（aggregateTimeout）
		 * - 批量处理变化
		 */
		compiler.watchFileSystem = new NodeWatchFileSystem(
			compiler.inputFileSystem // 传入 inputFileSystem，复用其缓存
		);

		// ===== 步骤6: 注册文件系统清理钩子 ⭐ =====
		/**
		 * 监听 beforeRun 钩子，在每次编译前清理文件系统缓存
		 *
		 * 【为什么需要清理缓存？】
		 * 场景：
		 * 1. 用户执行 compiler.run() 多次
		 * 2. 两次编译之间，文件可能已在外部被修改
		 * 3. 如果不清理缓存，会读到旧的文件内容
		 *
		 * 【什么时候清理？】
		 * beforeRun 钩子：每次 run() 调用前
		 * 注意：watch 模式下不走 beforeRun，而是通过 watchFileSystem 自动更新缓存
		 *
		 * 【清理策略】
		 * inputFileSystem.purge() 清空所有缓存：
		 * - 清空文件内容缓存
		 * - 清空 stat 信息缓存
		 * - 清空目录列表缓存
		 * - 下次读取时重新从磁盘加载
		 */
		compiler.hooks.beforeRun.tap("NodeEnvironmentPlugin", compiler => {
			// 检查文件系统是否被替换
			// 场景：用户可能通过插件替换了 inputFileSystem
			// 例如：使用 MemoryFileSystem 进行测试
			if (compiler.inputFileSystem === inputFileSystem) {
				// 记录文件系统清理时间（用于性能分析）
				compiler.fsStartTime = Date.now();

				// ⭐ 清空文件系统缓存
				/**
				 * purge() 的作用：
				 * 1. 清空内部的 _statStorage、_readFileStorage 等
				 * 2. 确保读取最新的文件内容
				 * 3. 防止缓存导致的问题
				 *
				 * 性能影响：
				 * - 首次编译：无影响（缓存本来就是空的）
				 * - 第二次编译：会变慢（需要重新读取文件）
				 * - 但正确性更重要（文件可能已修改）
				 */
				inputFileSystem.purge();
			}
		});

		/**
		 * 【完整的文件系统使用示例】
		 *
		 * 1. 读取源文件（Make 阶段）
		 * ```javascript
		 * // NormalModule._doBuild()
		 * compiler.inputFileSystem.readFile('/path/to/file.js', (err, content) => {
		 *   // 如果缓存命中，直接返回缓存内容
		 *   // 如果缓存未命中，从磁盘读取并缓存
		 * });
		 * ```
		 *
		 * 2. 写入构建产物（Emit 阶段）
		 * ```javascript
		 * // Compiler.emitAssets()
		 * compiler.outputFileSystem.writeFile('/dist/bundle.js', content, callback);
		 * ```
		 *
		 * 3. 监听文件变化（Watch 模式）
		 * ```javascript
		 * // Compiler.watch()
		 * compiler.watchFileSystem.watch(
		 *   files, dirs, missing, startTime, options,
		 *   (err, fileTimestamps, dirTimestamps, changedFiles, removedFiles) => {
		 *     // 文件变化，触发重新编译
		 *   }
		 * );
		 * ```
		 *
		 * 【内存文件系统示例】
		 * webpack-dev-server 替换输出文件系统：
		 * ```javascript
		 * const MemoryFileSystem = require('memory-fs');
		 * compiler.outputFileSystem = new MemoryFileSystem();
		 * // 构建产物写入内存，不写磁盘
		 * ```
		 */
	}
}

module.exports = NodeEnvironmentPlugin;
