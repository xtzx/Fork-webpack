/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

/**
 * lib/WebpackOptionsApply.js - 应用配置并注册内置插件 ⭐⭐⭐
 *
 * 【文件作用】
 * 这是 webpack 初始化流程中最重要的文件之一，负责：
 * 1. 根据用户配置决定注册哪些内置插件
 * 2. 将配置项转换为实际的插件注册
 * 3. 注册 40+ 个核心插件
 *
 * 【核心设计思想】
 * webpack 的功能都是通过插件实现的，连核心功能也不例外！
 *
 * 例如：
 * - entry 配置 → EntryOptionPlugin
 * - optimization.minimize → TerserPlugin
 * - devtool → SourceMapDevToolPlugin
 * - externals → ExternalsPlugin
 *
 * 【执行时机】
 * 在 lib/webpack.js: createCompiler() 的最后阶段：
 * ```javascript
 * const compiler = new Compiler(context, options);
 * new NodeEnvironmentPlugin().apply(compiler);
 * // 注册用户插件
 * for (const plugin of options.plugins) {
 *   plugin.apply(compiler);
 * }
 * // 应用默认配置
 * applyWebpackOptionsDefaults(options);
 * // ⭐⭐⭐ 应用内置插件（本文件）
 * new WebpackOptionsApply().process(options, compiler);
 * compiler.hooks.initialize.call();
 * ```
 *
 * 【注册的插件分类】
 * 1. 模块类型插件（3个）：JavascriptModulesPlugin、JsonModulesPlugin、AssetModulesPlugin
 * 2. 依赖处理插件（12个）：CommonJsPlugin、HarmonyModulesPlugin、ImportPlugin 等
 * 3. 优化插件（15个）：SplitChunksPlugin、ModuleConcatenationPlugin 等
 * 4. ID生成插件（2个）：DeterministicModuleIdsPlugin、DeterministicChunkIdsPlugin
 * 5. 输出格式插件：ChunkFormatPlugin、LibraryPlugin 等
 * 6. 特性插件：HMR、Worker、WASM、CSS 等
 * 7. 工具插件：TemplatedPathPlugin、StatsPlugin 等
 *
 * 【与 lib/config/defaults.js 的关系】
 * - defaults.js: 设置配置的默认值
 * - WebpackOptionsApply.js: 根据配置注册插件
 *
 * 【重要性】
 * 理解这个文件 = 理解 webpack 如何将配置转换为实际功能
 */

"use strict";

// ===== 基类 =====
const OptionsApply = require("./OptionsApply"); // 配置应用基类（空实现，用于扩展）

// ===== 模块类型插件（处理不同类型的文件）=====
const AssetModulesPlugin = require("./asset/AssetModulesPlugin"); // 资源模块（图片、字体等）
const JavascriptModulesPlugin = require("./javascript/JavascriptModulesPlugin"); // ⭐⭐⭐ JS 模块（最核心）
const JsonModulesPlugin = require("./json/JsonModulesPlugin"); // JSON 模块

// ===== 性能优化插件 =====
const ChunkPrefetchPreloadPlugin = require("./prefetch/ChunkPrefetchPreloadPlugin"); // 预加载/预获取

// ===== 核心功能插件 =====
const EntryOptionPlugin = require("./EntryOptionPlugin"); // ⭐⭐⭐ 入口处理插件
const RecordIdsPlugin = require("./RecordIdsPlugin"); // Records 记录插件（HMR 用）
const RuntimePlugin = require("./RuntimePlugin"); // ⭐⭐⭐ 运行时代码插件

// ===== API 插件（提供全局变量和函数）=====
const APIPlugin = require("./APIPlugin"); // __webpack_public_path__ 等 API
const CompatibilityPlugin = require("./CompatibilityPlugin"); // 兼容性 API
const ConstPlugin = require("./ConstPlugin"); // 常量替换
const ExportsInfoApiPlugin = require("./ExportsInfoApiPlugin"); // __webpack_exports_info__
const WebpackIsIncludedPlugin = require("./WebpackIsIncludedPlugin"); // __webpack_is_included__

// ===== 工具插件 =====
const TemplatedPathPlugin = require("./TemplatedPathPlugin"); // 模板路径（[name]、[hash]）
const UseStrictPlugin = require("./UseStrictPlugin"); // "use strict" 处理
const WarnCaseSensitiveModulesPlugin = require("./WarnCaseSensitiveModulesPlugin"); // 大小写警告

// ===== 协议插件（处理特殊 URI）=====
const DataUriPlugin = require("./schemes/DataUriPlugin"); // data: URI
const FileUriPlugin = require("./schemes/FileUriPlugin"); // file: URI

// ===== 缓存插件 =====
const ResolverCachePlugin = require("./cache/ResolverCachePlugin"); // 解析器缓存

// ===== 依赖插件（处理各种 import/require 语法）=====
const CommonJsPlugin = require("./dependencies/CommonJsPlugin"); // ⭐⭐ CommonJS（require）
const HarmonyModulesPlugin = require("./dependencies/HarmonyModulesPlugin"); // ⭐⭐⭐ ES6 模块（import/export）
const ImportMetaContextPlugin = require("./dependencies/ImportMetaContextPlugin"); // import.meta.webpackContext
const ImportMetaPlugin = require("./dependencies/ImportMetaPlugin"); // import.meta
const ImportPlugin = require("./dependencies/ImportPlugin"); // ⭐⭐ 动态 import()
const LoaderPlugin = require("./dependencies/LoaderPlugin"); // loader API
const RequireContextPlugin = require("./dependencies/RequireContextPlugin"); // require.context()
const RequireEnsurePlugin = require("./dependencies/RequireEnsurePlugin"); // require.ensure()
const RequireIncludePlugin = require("./dependencies/RequireIncludePlugin"); // require.include()
const SystemPlugin = require("./dependencies/SystemPlugin"); // System.import()（已废弃）
const URLPlugin = require("./dependencies/URLPlugin"); // new URL()
const WorkerPlugin = require("./dependencies/WorkerPlugin"); // new Worker()

// ===== 异步模块插件 =====
const InferAsyncModulesPlugin = require("./async-modules/InferAsyncModulesPlugin"); // 推断异步模块

// ===== 统计和元信息插件 =====
const JavascriptMetaInfoPlugin = require("./JavascriptMetaInfoPlugin"); // JS 元信息
const DefaultStatsFactoryPlugin = require("./stats/DefaultStatsFactoryPlugin"); // ⭐⭐ 统计数据工厂
const DefaultStatsPresetPlugin = require("./stats/DefaultStatsPresetPlugin"); // 统计预设
const DefaultStatsPrinterPlugin = require("./stats/DefaultStatsPrinterPlugin"); // ⭐⭐ 统计打印器

// ===== 工具函数 =====
const { cleverMerge } = require("./util/cleverMerge"); // 智能合并对象

/** @typedef {import("../declarations/WebpackOptions").WebpackOptionsNormalized} WebpackOptions */
/** @typedef {import("./Compiler")} Compiler */

/**
 * WebpackOptionsApply - 配置应用器类
 *
 * 【继承自 OptionsApply】
 * OptionsApply 是一个空基类，只是提供了统一的接口
 *
 * 【核心方法】
 * process(options, compiler) - 根据配置注册插件
 *
 * 【设计原则】
 * 按需注册：只注册用户配置中启用的功能对应的插件
 * 例如：
 * - 如果 optimization.splitChunks 未禁用 → 注册 SplitChunksPlugin
 * - 如果 devtool 配置了 → 注册 SourceMapDevToolPlugin
 * - 如果 externals 配置了 → 注册 ExternalsPlugin
 */
class WebpackOptionsApply extends OptionsApply {
	/**
	 * 构造函数
	 *
	 * 【作用】
	 * 调用父类构造函数（虽然父类是空的）
	 */
	constructor() {
		super();
	}

	/**
	 * 处理配置并注册内置插件 ⭐⭐⭐
	 *
	 * 【这是 webpack 初始化的核心方法！】
	 *
	 * 【作用】
	 * 遍历用户配置，根据每个配置项决定是否注册对应的插件
	 *
	 * 【执行顺序】
	 * 1. 基本属性设置（outputPath、name 等）
	 * 2. 外部依赖插件（ExternalsPlugin）
	 * 3. Chunk 格式插件（ArrayPush、CommonJS、Module）
	 * 4. Chunk 加载插件（Jsonp、Import、Require）
	 * 5. 库输出插件（UMD、CommonJS 等）
	 * 6. SourceMap 插件
	 * 7. 模块类型插件（JavaScript、JSON、Asset）
	 * 8. 实验性特性插件（WASM、CSS、LazyCompilation）
	 * 9. 入口和运行时插件 ⭐⭐⭐
	 * 10. 依赖处理插件（CommonJS、ES6、动态 import）⭐⭐⭐
	 * 11. 优化插件（Tree Shaking、Code Splitting）⭐⭐⭐
	 * 12. ID 生成插件
	 * 13. 统计和工具插件
	 *
	 * 【注册的插件总数】
	 * 根据配置不同，通常注册 30-50 个插件
	 *
	 * 【重要性】
	 * 这个方法决定了 webpack 有哪些功能可用
	 * 例如：不注册 ImportPlugin，就无法使用 import()
	 *
	 * @param {WebpackOptions} options - 规范化后的 webpack 配置
	 * @param {Compiler} compiler - 编译器实例
	 * @returns {WebpackOptions} 处理后的配置对象
	 */
	process(options, compiler) {
		// ===== 第1部分: 设置 compiler 的基本属性 =====

		// 输出路径（用于生成文件的绝对路径）
		compiler.outputPath = options.output.path;

		// Records 输入路径（读取上次编译记录，用于 HMR）
		compiler.recordsInputPath = options.recordsInputPath || null;

		// Records 输出路径（保存当前编译记录）
		compiler.recordsOutputPath = options.recordsOutputPath || null;

		// 编译器名称（多编译器时用于区分）
		compiler.name = options.name;

		// ===== 第2部分: 外部依赖处理 ⭐⭐ =====
		/**
		 * externals 配置用于声明外部依赖
		 *
		 * 【场景】
		 * 某些依赖不想打包到 bundle 中，而是从外部加载：
		 * ```javascript
		 * module.exports = {
		 *   externals: {
		 *     react: 'React',      // import React from 'react' → window.React
		 *     jquery: 'jQuery'     // import $ from 'jquery' → window.jQuery
		 *   }
		 * };
		 * ```
		 *
		 * 【ExternalsPlugin 的作用】
		 * 1. 拦截对外部模块的 import/require
		 * 2. 不构建该模块，而是生成访问外部变量的代码
		 * 3. 支持多种外部类型：global、commonjs、amd、umd 等
		 *
		 * 【externalsType】
		 * - 'var': window.React
		 * - 'commonjs': require('react')
		 * - 'module': import 'react'
		 * - 'umd': 自动检测
		 */
		if (options.externals) {
			//@ts-expect-error https://github.com/microsoft/TypeScript/issues/41697
			const ExternalsPlugin = require("./ExternalsPlugin");
			new ExternalsPlugin(options.externalsType, options.externals).apply(
				compiler
			);
		}

		// ===== 第3部分: 外部依赖预设（针对特定环境）⭐ =====
		/**
		 * externalsPresets 为特定环境提供默认的外部依赖配置
		 */

		// Node.js 环境预设
		// 自动将 Node.js 内置模块标记为 external（fs、path、http 等）
		// 这些模块不打包，运行时使用 Node.js 提供的版本
		if (options.externalsPresets.node) {
			const NodeTargetPlugin = require("./node/NodeTargetPlugin");
			new NodeTargetPlugin().apply(compiler);
		}

		// Electron 主进程环境
		// 自动 external electron 模块和 Node.js 内置模块
		if (options.externalsPresets.electronMain) {
			//@ts-expect-error https://github.com/microsoft/TypeScript/issues/41697
			const ElectronTargetPlugin = require("./electron/ElectronTargetPlugin");
			new ElectronTargetPlugin("main").apply(compiler);
		}

		// Electron 预加载脚本环境
		// 预加载脚本可以访问部分 Node.js API 和 Electron API
		if (options.externalsPresets.electronPreload) {
			//@ts-expect-error https://github.com/microsoft/TypeScript/issues/41697
			const ElectronTargetPlugin = require("./electron/ElectronTargetPlugin");
			new ElectronTargetPlugin("preload").apply(compiler);
		}

		// Electron 渲染进程环境
		// 渲染进程运行在浏览器环境，但可以通过 remote 访问主进程
		if (options.externalsPresets.electronRenderer) {
			//@ts-expect-error https://github.com/microsoft/TypeScript/issues/41697
			const ElectronTargetPlugin = require("./electron/ElectronTargetPlugin");
			new ElectronTargetPlugin("renderer").apply(compiler);
		}

		// 通用 Electron 环境（未指定具体进程时的默认配置）
		if (
			options.externalsPresets.electron &&
			!options.externalsPresets.electronMain &&
			!options.externalsPresets.electronPreload &&
			!options.externalsPresets.electronRenderer
		) {
			//@ts-expect-error https://github.com/microsoft/TypeScript/issues/41697
			const ElectronTargetPlugin = require("./electron/ElectronTargetPlugin");
			new ElectronTargetPlugin().apply(compiler);
		}

		// NW.js 环境预设
		// 自动 external nw.gui 模块（NW.js 特有的 API）
		if (options.externalsPresets.nwjs) {
			//@ts-expect-error https://github.com/microsoft/TypeScript/issues/41697
			const ExternalsPlugin = require("./ExternalsPlugin");
			new ExternalsPlugin("node-commonjs", "nw.gui").apply(compiler);
		}

		// Web 异步环境预设
		// 将外部 URL 的资源（HTTP(S)）标记为 external，使用 import() 动态加载
		if (options.externalsPresets.webAsync) {
			//@ts-expect-error https://github.com/microsoft/TypeScript/issues/41697
			const ExternalsPlugin = require("./ExternalsPlugin");
			new ExternalsPlugin("import", ({ request, dependencyType }, callback) => {
				// 处理不同类型的外部请求

				// URL 依赖（new URL('./file', import.meta.url)）
				if (dependencyType === "url") {
					// 匹配外部 URL：//、http://、https://、#
					if (/^(\/\/|https?:\/\/|#)/.test(request))
						return callback(null, `asset ${request}`);
				}
				// CSS import 依赖（@import url()）
				else if (options.experiments.css && dependencyType === "css-import") {
					if (/^(\/\/|https?:\/\/|#)/.test(request))
						return callback(null, `css-import ${request}`);
				}
				// 其他 HTTP(S) 或标准库请求
				else if (
					options.experiments.css &&
					/^(\/\/|https?:\/\/|std:)/.test(request)
				) {
					// CSS 文件
					if (/^\.css(\?|$)/.test(request))
						return callback(null, `css-import ${request}`);
					// 其他文件
					return callback(null, `import ${request}`);
				}
				callback(); // 不是外部依赖，正常打包
			}).apply(compiler);
		}
		// Web 同步环境预设（浏览器环境）
		else if (options.externalsPresets.web) {
			//@ts-expect-error https://github.com/microsoft/TypeScript/issues/41697
			const ExternalsPlugin = require("./ExternalsPlugin");
			new ExternalsPlugin("module", ({ request, dependencyType }, callback) => {
				if (dependencyType === "url") {
					if (/^(\/\/|https?:\/\/|#)/.test(request))
						return callback(null, `asset ${request}`);
				} else if (options.experiments.css && dependencyType === "css-import") {
					if (/^(\/\/|https?:\/\/|#)/.test(request))
						return callback(null, `css-import ${request}`);
				} else if (/^(\/\/|https?:\/\/|std:)/.test(request)) {
					if (options.experiments.css && /^\.css((\?)|$)/.test(request))
						return callback(null, `css-import ${request}`);
					return callback(null, `module ${request}`);
				}
				callback();
			}).apply(compiler);
		}
		// Node 环境 + CSS 支持
		else if (options.externalsPresets.node) {
			if (options.experiments.css) {
				//@ts-expect-error https://github.com/microsoft/TypeScript/issues/41697
				const ExternalsPlugin = require("./ExternalsPlugin");
				new ExternalsPlugin(
					"module",
					({ request, dependencyType }, callback) => {
						if (dependencyType === "url") {
							if (/^(\/\/|https?:\/\/|#)/.test(request))
								return callback(null, `asset ${request}`);
						} else if (dependencyType === "css-import") {
							if (/^(\/\/|https?:\/\/|#)/.test(request))
								return callback(null, `css-import ${request}`);
						} else if (/^(\/\/|https?:\/\/|std:)/.test(request)) {
							if (/^\.css(\?|$)/.test(request))
								return callback(null, `css-import ${request}`);
							return callback(null, `module ${request}`);
						}
						callback();
					}
				).apply(compiler);
			}
		}

		// ===== 第4部分: Chunk 预加载/预获取 =====
		/**
		 * ChunkPrefetchPreloadPlugin 处理 webpackPrefetch 和 webpackPreload 魔法注释
		 *
		 * 【场景】
		 * ```javascript
		 * import(
 * webpackPrefetch: true *
		 *   './component.js'
		 * );
		 * ```
		 *
		 * 生成：
		 * <link rel="prefetch" href="component.js">
		 */
		new ChunkPrefetchPreloadPlugin().apply(compiler);

		// ===== 第5部分: Chunk 格式插件 ⭐⭐ =====
		/**
		 * chunkFormat 决定如何生成 chunk 文件的格式
		 *
		 * 【三种格式】
		 * 1. array-push: JSONP 格式（传统，浏览器）
		 *    (window.webpackJsonp = window.webpackJsonp || []).push([...])
		 *
		 * 2. commonjs: CommonJS 格式（Node.js）
		 *    module.exports = { ... }
		 *
		 * 3. module: ES Module 格式（现代浏览器）
		 *    export default { ... }
		 *
		 * 【自动推断】
		 * 通常由 target 自动决定：
		 * - target: 'web' → array-push
		 * - target: 'node' → commonjs
		 * - experiments.outputModule → module
		 */
		if (typeof options.output.chunkFormat === "string") {
			switch (options.output.chunkFormat) {
				case "array-push": {
					// JSONP 格式：webpackJsonp.push([chunkIds, modules])
					// 用于浏览器环境，通过全局变量传递
					const ArrayPushCallbackChunkFormatPlugin = require("./javascript/ArrayPushCallbackChunkFormatPlugin");
					new ArrayPushCallbackChunkFormatPlugin().apply(compiler);
					break;
				}
				case "commonjs": {
					// CommonJS 格式：module.exports = { ... }
					// 用于 Node.js 环境，通过 require() 加载
					const CommonJsChunkFormatPlugin = require("./javascript/CommonJsChunkFormatPlugin");
					new CommonJsChunkFormatPlugin().apply(compiler);
					break;
				}
				case "module": {
					// ES Module 格式：export default { ... }
					// 用于现代浏览器或 Node.js（type: module）
					const ModuleChunkFormatPlugin = require("./esm/ModuleChunkFormatPlugin");
					new ModuleChunkFormatPlugin().apply(compiler);
					break;
				}
				default:
					// 不支持的格式，抛出错误
					throw new Error(
						"Unsupported chunk format '" + options.output.chunkFormat + "'."
					);
			}
		}

		// ===== 第6部分: Chunk 加载插件 ⭐⭐ =====
		/**
		 * enabledChunkLoadingTypes 决定如何加载动态 chunk（import()）
		 *
		 * 【加载方式】
		 * - 'jsonp': 通过 <script> 标签 + JSONP（浏览器）
		 * - 'import': 通过 import() 语法（ESM）
		 * - 'require': 通过 require()（Node.js）
		 * - 'import-scripts': 通过 importScripts()（Worker）
		 *
		 * 【自动推断】
		 * 由 target 决定：
		 * - target: 'web' → 'jsonp'
		 * - target: 'node' → 'require'
		 * - target: 'webworker' → 'import-scripts'
		 */
		if (options.output.enabledChunkLoadingTypes.length > 0) {
			// 遍历所有启用的加载类型
			for (const type of options.output.enabledChunkLoadingTypes) {
				// EnableChunkLoadingPlugin 会根据类型注册对应的加载插件
				// 例如：type='jsonp' → JsonpChunkLoadingPlugin
				const EnableChunkLoadingPlugin = require("./javascript/EnableChunkLoadingPlugin");
				new EnableChunkLoadingPlugin(type).apply(compiler);
			}
		}

		// ===== 第7部分: WASM 加载插件 =====
		/**
		 * enabledWasmLoadingTypes 决定如何加载 WebAssembly 模块
		 *
		 * 【加载方式】
		 * - 'fetch': 通过 fetch API（浏览器）
		 * - 'async-node': 通过 fs.readFile（Node.js 异步）
		 * - 'async-node-module': 通过 import（Node.js ESM）
		 *
		 * 【应用场景】
		 * 项目中使用了 .wasm 文件时自动启用
		 */
		if (options.output.enabledWasmLoadingTypes.length > 0) {
			for (const type of options.output.enabledWasmLoadingTypes) {
				// 根据类型注册对应的 WASM 加载插件
				const EnableWasmLoadingPlugin = require("./wasm/EnableWasmLoadingPlugin");
				new EnableWasmLoadingPlugin(type).apply(compiler);
			}
		}

		// ===== 第8部分: 库输出类型插件 =====
		/**
		 * enabledLibraryTypes 决定如何输出为库
		 *
		 * 【库类型】
		 * - 'var': var MyLibrary = ...
		 * - 'commonjs': exports.MyLibrary = ...
		 * - 'commonjs2': module.exports = ...
		 * - 'amd': define('MyLibrary', ...)
		 * - 'umd': 通用模块定义（支持多种环境）
		 * - 'module': export default ...
		 *
		 * 【应用场景】
		 * 开发库而非应用时使用
		 */
		if (options.output.enabledLibraryTypes.length > 0) {
			for (const type of options.output.enabledLibraryTypes) {
				// 根据类型注册对应的库插件
				const EnableLibraryPlugin = require("./library/EnableLibraryPlugin");
				new EnableLibraryPlugin(type).apply(compiler);
			}
		}

		// ===== 第9部分: 模块路径信息插件 =====
		/**
		 * pathinfo 决定是否在生成的代码中包含模块路径注释
		 *
		 * 【场景】
		 * pathinfo: true 时生成：
		 * ```javascript
		 * /***\/ "./src/index.js"
		 * /***\/ (function(module, exports, __webpack_require__) {
		 *   // 模块代码
		 * })
		 * ```
		 *
		 * 【用途】
		 * - 开发模式：方便调试（默认 true）
		 * - 生产模式：减小体积（默认 false）
		 */
		if (options.output.pathinfo) {
			const ModuleInfoHeaderPlugin = require("./ModuleInfoHeaderPlugin");
			// pathinfo 可以是 true 或 'verbose'
			// true: 简单的路径信息
			// 'verbose': 详细的路径信息（包含 exports、size 等）
			new ModuleInfoHeaderPlugin(options.output.pathinfo !== true).apply(
				compiler
			);
		}

		// ===== 第10部分: 清理输出目录插件 =====
		/**
		 * output.clean 配置是否在构建前清理输出目录
		 *
		 * 【场景】
		 * ```javascript
		 * output: {
		 *   path: '/dist',
		 *   clean: true  // 每次构建前删除 dist/ 目录
		 * }
		 * ```
		 *
		 * 【CleanPlugin 的作用】
		 * 1. 在 emit 前删除输出目录
		 * 2. 支持 keep 选项（保留特定文件）
		 * 3. 支持 dry 模式（只检测，不删除）
		 */
		if (options.output.clean) {
			const CleanPlugin = require("./CleanPlugin");
			new CleanPlugin(
				options.output.clean === true ? {} : options.output.clean
			).apply(compiler);
		}

		// ===== 第11部分: SourceMap 插件 ⭐⭐ =====
		/**
		 * devtool 配置决定如何生成 SourceMap
		 *
		 * 【常见配置】
		 * - false / 不设置: 不生成 SourceMap
		 * - 'eval': 使用 eval，最快，但重建时无法正确映射
		 * - 'source-map': 单独的 .map 文件，最完整，但最慢
		 * - 'inline-source-map': SourceMap 内联到 bundle
		 * - 'cheap-source-map': 快速但不包含列信息
		 * - 'cheap-module-source-map': 包含 loader 的 SourceMap
		 *
		 * 【devtool 字符串的组成】
		 * [inline-|hidden-|eval-][nosources-][cheap-[module-]]source-map
		 *
		 * - inline: 内联到 bundle
		 * - hidden: 生成 .map 但不引用（用于错误报告服务）
		 * - eval: 使用 eval + sourceURL
		 * - nosources: 不包含源码内容
		 * - cheap: 不包含列信息，速度更快
		 * - module: 包含 loader 的 SourceMap
		 */
		if (options.devtool) {
			if (options.devtool.includes("source-map")) {
				// 解析 devtool 字符串，提取配置
				const hidden = options.devtool.includes("hidden");
				const inline = options.devtool.includes("inline");
				const evalWrapped = options.devtool.includes("eval");
				const cheap = options.devtool.includes("cheap");
				const moduleMaps = options.devtool.includes("module");
				const noSources = options.devtool.includes("nosources");

				// 根据是否 eval 选择插件
				// eval: EvalSourceMapDevToolPlugin（每个模块用 eval 包装）
				// 否则: SourceMapDevToolPlugin（标准 SourceMap）
				const Plugin = evalWrapped
					? require("./EvalSourceMapDevToolPlugin")
					: require("./SourceMapDevToolPlugin");

				new Plugin({
					// SourceMap 文件名（inline 时为 null）
					filename: inline ? null : options.output.sourceMapFilename,

					// 模块文件名模板（在 SourceMap 中显示的路径）
					moduleFilenameTemplate: options.output.devtoolModuleFilenameTemplate,

					// 降级模块文件名模板（路径冲突时使用）
					fallbackModuleFilenameTemplate:
						options.output.devtoolFallbackModuleFilenameTemplate,

					// append: 如何引用 SourceMap
					// hidden: false（不引用）
					// 其他: undefined（自动在文件末尾添加 //# sourceMappingURL=...）
					append: hidden ? false : undefined,

					// module: 是否包含 loader 转换前的源码
					// moduleMaps: 'module' in devtool
					// cheap: 不包含
					module: moduleMaps ? true : cheap ? false : true,

					// columns: 是否包含列信息
					// cheap: 不包含（只有行信息）
					columns: cheap ? false : true,

					// noSources: 是否包含源码内容
					// nosources: 只包含映射关系，不包含源码
					noSources: noSources,

					// namespace: SourceMap 的命名空间
					namespace: options.output.devtoolNamespace
				}).apply(compiler);
			} else if (options.devtool.includes("eval")) {
				// 只有 eval，没有 source-map
				// 使用 eval + sourceURL（最快，但功能最弱）
				const EvalDevToolModulePlugin = require("./EvalDevToolModulePlugin");
				new EvalDevToolModulePlugin({
					moduleFilenameTemplate: options.output.devtoolModuleFilenameTemplate,
					namespace: options.output.devtoolNamespace
				}).apply(compiler);
			}
		}

		// ===== 第12部分: 核心模块类型插件 ⭐⭐⭐ =====
		/**
		 * 这三个插件是 webpack 处理不同文件类型的核心
		 * 每个插件都会：
		 * 1. 注册 parser（解析器）
		 * 2. 注册 generator（代码生成器）
		 * 3. 注册 renderManifest 钩子（渲染 chunk）
		 */

		// JavaScript 模块插件 ⭐⭐⭐
		// 处理 .js、.jsx、.mjs、.cjs 文件
		// 是 webpack 最核心的插件，负责生成 bundle 代码
		new JavascriptModulesPlugin().apply(compiler);

		// JSON 模块插件
		// 处理 .json 文件
		// 将 JSON 转换为 JavaScript 模块（module.exports = { ... }）
		new JsonModulesPlugin().apply(compiler);

		// 资源模块插件
		// 处理图片、字体、媒体等文件
		// 支持 4 种资源类型：asset/resource、asset/inline、asset/source、asset
		new AssetModulesPlugin().apply(compiler);

		// ===== 第13部分: 实验性特性验证 =====
		/**
		 * 检查用户配置的一致性
		 * 某些配置依赖实验性特性，如果未启用会报错
		 */
		if (!options.experiments.outputModule) {
			// 如果未启用 experiments.outputModule，不能使用 ESM 输出

			// 检查 output.module
			if (options.output.module) {
				throw new Error(
					"'output.module: true' is only allowed when 'experiments.outputModule' is enabled"
				);
			}

			// 检查库类型
			if (options.output.enabledLibraryTypes.includes("module")) {
				throw new Error(
					"library type \"module\" is only allowed when 'experiments.outputModule' is enabled"
				);
			}

			// 检查 externalsType
			if (options.externalsType === "module") {
				throw new Error(
					"'externalsType: \"module\"' is only allowed when 'experiments.outputModule' is enabled"
				);
			}
		}

		// ===== 第14部分: 实验性特性插件 ⭐ =====
		/**
		 * experiments 配置启用实验性的 webpack 特性
		 * 这些特性可能在未来版本中改变或移除
		 */

		// 同步 WebAssembly 支持
		// 允许同步导入 .wasm 文件（实验性）
		// import add from './add.wasm'; → 同步加载
		if (options.experiments.syncWebAssembly) {
			const WebAssemblyModulesPlugin = require("./wasm-sync/WebAssemblyModulesPlugin");
			new WebAssemblyModulesPlugin({
				// mangleImports: 是否混淆 WASM 导入名称（减小体积）
				mangleImports: options.optimization.mangleWasmImports
			}).apply(compiler);
		}

		// 异步 WebAssembly 支持（推荐）
		// 允许异步导入 .wasm 文件
		// import('./add.wasm').then(module => ...) → 异步加载
		if (options.experiments.asyncWebAssembly) {
			const AsyncWebAssemblyModulesPlugin = require("./wasm-async/AsyncWebAssemblyModulesPlugin");
			new AsyncWebAssemblyModulesPlugin({
				mangleImports: options.optimization.mangleWasmImports
			}).apply(compiler);
		}

		// CSS 支持（实验性）⭐
		// 原生支持 CSS 文件，不需要 style-loader 和 css-loader
		// import './styles.css'; → webpack 原生处理
		if (options.experiments.css) {
			const CssModulesPlugin = require("./css/CssModulesPlugin");
			new CssModulesPlugin(options.experiments.css).apply(compiler);
		}

		if (options.experiments.lazyCompilation) {
			const LazyCompilationPlugin = require("./hmr/LazyCompilationPlugin");
			const lazyOptions =
				typeof options.experiments.lazyCompilation === "object"
					? options.experiments.lazyCompilation
					: null;
			new LazyCompilationPlugin({
				backend:
					typeof lazyOptions.backend === "function"
						? lazyOptions.backend
						: require("./hmr/lazyCompilationBackend")({
								...lazyOptions.backend,
								client:
									(lazyOptions.backend && lazyOptions.backend.client) ||
									require.resolve(
										`../hot/lazy-compilation-${
											options.externalsPresets.node ? "node" : "web"
										}.js`
									)
						  }),
				entries: !lazyOptions || lazyOptions.entries !== false,
				imports: !lazyOptions || lazyOptions.imports !== false,
				test: (lazyOptions && lazyOptions.test) || undefined
			}).apply(compiler);
		}

		if (options.experiments.buildHttp) {
			const HttpUriPlugin = require("./schemes/HttpUriPlugin");
			const httpOptions = options.experiments.buildHttp;
			new HttpUriPlugin(httpOptions).apply(compiler);
		}

		// ===== 第15部分: 入口插件 ⭐⭐⭐ =====
		/**
		 * EntryOptionPlugin 处理 entry 配置
		 *
		 * 【作用】
		 * 根据 entry 配置注册对应的入口插件（EntryPlugin、DllEntryPlugin等）
		 * 在 make 钩子中添加入口模块
		 */
		new EntryOptionPlugin().apply(compiler);

		// 触发 entryOption 钩子
		// EntryOptionPlugin 监听这个钩子，根据 entry 类型注册具体的入口插件
		compiler.hooks.entryOption.call(options.context, options.entry);

		// ===== 第16部分: 运行时插件 ⭐⭐⭐ =====
		/**
		 * RuntimePlugin 管理 webpack 运行时代码的生成
		 *
		 * 【运行时代码】
		 * - __webpack_require__: 模块加载函数
		 * - __webpack_require__.e: 异步加载 chunk
		 * - __webpack_require__.d: 定义导出
		 * - ... 等 10+ 个运行时函数
		 *
		 * 【运行时模块】
		 * webpack 5 将运行时代码模块化为 29 个 RuntimeModule
		 * RuntimePlugin 负责管理这些模块的注入
		 */
		new RuntimePlugin().apply(compiler);

		// ===== 第17部分: 异步模块推断插件 =====
		/**
		 * InferAsyncModulesPlugin 自动推断哪些模块是异步的
		 *
		 * 【场景】
		 * 如果模块使用了 Top Level Await 或 import()，标记为异步模块
		 * 异步模块的父模块也会变成异步模块（传递性）
		 */
		new InferAsyncModulesPlugin().apply(compiler);

		// ===== 第18部分: 特殊协议插件 =====
		/**
		 * 处理特殊的 URI 协议
		 */

		// Data URI 插件
		// 支持 data: 协议（内联数据）
		// import logo from 'data:image/png;base64,...'
		new DataUriPlugin().apply(compiler);

		// File URI 插件
		// 支持 file: 协议（本地文件路径）
		// import config from 'file:///path/to/config.json'
		new FileUriPlugin().apply(compiler);

		// ===== 第19部分: 依赖处理插件（核心）⭐⭐⭐ =====
		/**
		 * 这些插件负责识别和处理各种 import/require 语法
		 * 是 webpack 依赖分析的核心
		 */

		// 兼容性插件
		// 提供 require、module、exports 等全局变量
		new CompatibilityPlugin().apply(compiler);

		// ES6 模块插件 ⭐⭐⭐
		// 处理 import/export 语法
		// 这是现代 JavaScript 的标准模块系统
		new HarmonyModulesPlugin({
			topLevelAwait: options.experiments.topLevelAwait // 是否支持顶层 await
		}).apply(compiler);

		// AMD 插件（如果启用）
		// 处理 define() 和 require() 的 AMD 语法
		if (options.amd !== false) {
			const AMDPlugin = require("./dependencies/AMDPlugin");
			const RequireJsStuffPlugin = require("./RequireJsStuffPlugin");
			new AMDPlugin(options.amd || {}).apply(compiler);
			new RequireJsStuffPlugin().apply(compiler);
		}

		// CommonJS 插件 ⭐⭐
		// 处理 require() 和 module.exports 语法
		// Node.js 的传统模块系统
		new CommonJsPlugin().apply(compiler);

		// Loader 插件
		// 支持 loader 内部使用的特殊 API
		// 如 require.resolve、require.context 等
		new LoaderPlugin({}).apply(compiler);

		// Node.js 内置模块插件
		// 提供 __dirname、__filename、global 等 Node.js 全局变量
		if (options.node !== false) {
			const NodeStuffPlugin = require("./NodeStuffPlugin");
			new NodeStuffPlugin(options.node).apply(compiler);
		}

		// ===== 第20部分: API 插件（提供全局 API）=====

		// webpack 公共 API
		// 提供 __webpack_public_path__、__webpack_hash__ 等
		new APIPlugin({
			module: options.output.module
		}).apply(compiler);

		// 导出信息 API
		// 提供 __webpack_exports_info__（用于调试）
		new ExportsInfoApiPlugin().apply(compiler);

		// webpack 包含检测 API
		// 提供 __webpack_is_included__(module)
		new WebpackIsIncludedPlugin().apply(compiler);

		// 常量替换插件
		// 处理 typeof window、typeof module 等
		new ConstPlugin().apply(compiler);

		// Use Strict 插件
		// 处理 "use strict" 指令
		new UseStrictPlugin().apply(compiler);

		// ===== 第21部分: 更多依赖语法插件 ⭐⭐ =====

		// require.include() 语法（已废弃，但仍支持）
		new RequireIncludePlugin().apply(compiler);

		// require.ensure() 语法（已废弃，但仍支持）
		// 用于代码分割
		new RequireEnsurePlugin().apply(compiler);

		// require.context() 语法 ⭐
		// 动态导入一组模块
		// require.context('./locales', true, /\.json$/)
		new RequireContextPlugin().apply(compiler);

		// import() 语法 ⭐⭐⭐
		// 动态导入，创建新的 chunk
		// 这是现代代码分割的标准方式
		new ImportPlugin().apply(compiler);

		// import.meta.webpackContext 语法
		// ESM 版本的 require.context
		new ImportMetaContextPlugin().apply(compiler);

		// System.import() 语法（已废弃）
		new SystemPlugin().apply(compiler);

		// import.meta 语法
		// 提供 import.meta.url、import.meta.webpack 等
		new ImportMetaPlugin().apply(compiler);

		// new URL() 语法
		// 处理 new URL('./file.png', import.meta.url)
		new URLPlugin().apply(compiler);

		// new Worker() 语法
		// 处理 new Worker(new URL('./worker.js', import.meta.url))
		new WorkerPlugin(
			options.output.workerChunkLoading,  // Worker 的 chunk 加载方式
			options.output.workerWasmLoading,   // Worker 的 WASM 加载方式
			options.output.module,              // 是否使用 ESM
			options.output.workerPublicPath     // Worker 脚本的公共路径
		).apply(compiler);

		// ===== 第22部分: 统计信息插件 ⭐⭐ =====
		/**
		 * 这些插件负责生成和格式化编译统计信息
		 */

		// 统计数据工厂
		// 负责收集编译数据（模块、chunk、资源等）
		new DefaultStatsFactoryPlugin().apply(compiler);

		// 统计预设
		// 提供预定义的统计格式（'normal'、'errors-only' 等）
		new DefaultStatsPresetPlugin().apply(compiler);

		// 统计打印器
		// 负责格式化输出统计信息（彩色、缩进等）
		new DefaultStatsPrinterPlugin().apply(compiler);

		// ===== 第23部分: JavaScript 元信息插件 =====
		// 收集 JavaScript 模块的元信息（buildMeta）
		new JavascriptMetaInfoPlugin().apply(compiler);

		if (typeof options.mode !== "string") {
			const WarnNoModeSetPlugin = require("./WarnNoModeSetPlugin");
			new WarnNoModeSetPlugin().apply(compiler);
		}

		const EnsureChunkConditionsPlugin = require("./optimize/EnsureChunkConditionsPlugin");
		new EnsureChunkConditionsPlugin().apply(compiler);
		if (options.optimization.removeAvailableModules) {
			const RemoveParentModulesPlugin = require("./optimize/RemoveParentModulesPlugin");
			new RemoveParentModulesPlugin().apply(compiler);
		}
		if (options.optimization.removeEmptyChunks) {
			const RemoveEmptyChunksPlugin = require("./optimize/RemoveEmptyChunksPlugin");
			new RemoveEmptyChunksPlugin().apply(compiler);
		}
		if (options.optimization.mergeDuplicateChunks) {
			const MergeDuplicateChunksPlugin = require("./optimize/MergeDuplicateChunksPlugin");
			new MergeDuplicateChunksPlugin().apply(compiler);
		}
		if (options.optimization.flagIncludedChunks) {
			const FlagIncludedChunksPlugin = require("./optimize/FlagIncludedChunksPlugin");
			new FlagIncludedChunksPlugin().apply(compiler);
		}
		if (options.optimization.sideEffects) {
			const SideEffectsFlagPlugin = require("./optimize/SideEffectsFlagPlugin");
			new SideEffectsFlagPlugin(
				options.optimization.sideEffects === true
			).apply(compiler);
		}
		if (options.optimization.providedExports) {
			const FlagDependencyExportsPlugin = require("./FlagDependencyExportsPlugin");
			new FlagDependencyExportsPlugin().apply(compiler);
		}
		if (options.optimization.usedExports) {
			const FlagDependencyUsagePlugin = require("./FlagDependencyUsagePlugin");
			new FlagDependencyUsagePlugin(
				options.optimization.usedExports === "global"
			).apply(compiler);
		}
		if (options.optimization.innerGraph) {
			const InnerGraphPlugin = require("./optimize/InnerGraphPlugin");
			new InnerGraphPlugin().apply(compiler);
		}
		if (options.optimization.mangleExports) {
			const MangleExportsPlugin = require("./optimize/MangleExportsPlugin");
			new MangleExportsPlugin(
				options.optimization.mangleExports !== "size"
			).apply(compiler);
		}
		if (options.optimization.concatenateModules) {
			const ModuleConcatenationPlugin = require("./optimize/ModuleConcatenationPlugin");
			new ModuleConcatenationPlugin().apply(compiler);
		}
		if (options.optimization.splitChunks) {
			const SplitChunksPlugin = require("./optimize/SplitChunksPlugin");
			new SplitChunksPlugin(options.optimization.splitChunks).apply(compiler);
		}
		if (options.optimization.runtimeChunk) {
			const RuntimeChunkPlugin = require("./optimize/RuntimeChunkPlugin");
			new RuntimeChunkPlugin(options.optimization.runtimeChunk).apply(compiler);
		}
		if (!options.optimization.emitOnErrors) {
			const NoEmitOnErrorsPlugin = require("./NoEmitOnErrorsPlugin");
			new NoEmitOnErrorsPlugin().apply(compiler);
		}
		if (options.optimization.realContentHash) {
			const RealContentHashPlugin = require("./optimize/RealContentHashPlugin");
			new RealContentHashPlugin({
				hashFunction: options.output.hashFunction,
				hashDigest: options.output.hashDigest
			}).apply(compiler);
		}
		if (options.optimization.checkWasmTypes) {
			const WasmFinalizeExportsPlugin = require("./wasm-sync/WasmFinalizeExportsPlugin");
			new WasmFinalizeExportsPlugin().apply(compiler);
		}
		const moduleIds = options.optimization.moduleIds;
		if (moduleIds) {
			switch (moduleIds) {
				case "natural": {
					const NaturalModuleIdsPlugin = require("./ids/NaturalModuleIdsPlugin");
					new NaturalModuleIdsPlugin().apply(compiler);
					break;
				}
				case "named": {
					const NamedModuleIdsPlugin = require("./ids/NamedModuleIdsPlugin");
					new NamedModuleIdsPlugin().apply(compiler);
					break;
				}
				case "hashed": {
					const WarnDeprecatedOptionPlugin = require("./WarnDeprecatedOptionPlugin");
					const HashedModuleIdsPlugin = require("./ids/HashedModuleIdsPlugin");
					new WarnDeprecatedOptionPlugin(
						"optimization.moduleIds",
						"hashed",
						"deterministic"
					).apply(compiler);
					new HashedModuleIdsPlugin({
						hashFunction: options.output.hashFunction
					}).apply(compiler);
					break;
				}
				case "deterministic": {
					const DeterministicModuleIdsPlugin = require("./ids/DeterministicModuleIdsPlugin");
					new DeterministicModuleIdsPlugin().apply(compiler);
					break;
				}
				case "size": {
					const OccurrenceModuleIdsPlugin = require("./ids/OccurrenceModuleIdsPlugin");
					new OccurrenceModuleIdsPlugin({
						prioritiseInitial: true
					}).apply(compiler);
					break;
				}
				default:
					throw new Error(
						`webpack bug: moduleIds: ${moduleIds} is not implemented`
					);
			}
		}
		const chunkIds = options.optimization.chunkIds;
		if (chunkIds) {
			switch (chunkIds) {
				case "natural": {
					const NaturalChunkIdsPlugin = require("./ids/NaturalChunkIdsPlugin");
					new NaturalChunkIdsPlugin().apply(compiler);
					break;
				}
				case "named": {
					const NamedChunkIdsPlugin = require("./ids/NamedChunkIdsPlugin");
					new NamedChunkIdsPlugin().apply(compiler);
					break;
				}
				case "deterministic": {
					const DeterministicChunkIdsPlugin = require("./ids/DeterministicChunkIdsPlugin");
					new DeterministicChunkIdsPlugin().apply(compiler);
					break;
				}
				case "size": {
					//@ts-expect-error https://github.com/microsoft/TypeScript/issues/41697
					const OccurrenceChunkIdsPlugin = require("./ids/OccurrenceChunkIdsPlugin");
					new OccurrenceChunkIdsPlugin({
						prioritiseInitial: true
					}).apply(compiler);
					break;
				}
				case "total-size": {
					//@ts-expect-error https://github.com/microsoft/TypeScript/issues/41697
					const OccurrenceChunkIdsPlugin = require("./ids/OccurrenceChunkIdsPlugin");
					new OccurrenceChunkIdsPlugin({
						prioritiseInitial: false
					}).apply(compiler);
					break;
				}
				default:
					throw new Error(
						`webpack bug: chunkIds: ${chunkIds} is not implemented`
					);
			}
		}
		if (options.optimization.nodeEnv) {
			const DefinePlugin = require("./DefinePlugin");
			new DefinePlugin({
				"process.env.NODE_ENV": JSON.stringify(options.optimization.nodeEnv)
			}).apply(compiler);
		}
		if (options.optimization.minimize) {
			for (const minimizer of options.optimization.minimizer) {
				if (typeof minimizer === "function") {
					minimizer.call(compiler, compiler);
				} else if (minimizer !== "..." && minimizer) {
					minimizer.apply(compiler);
				}
			}
		}

		if (options.performance) {
			const SizeLimitsPlugin = require("./performance/SizeLimitsPlugin");
			new SizeLimitsPlugin(options.performance).apply(compiler);
		}

		new TemplatedPathPlugin().apply(compiler);

		new RecordIdsPlugin({
			portableIds: options.optimization.portableRecords
		}).apply(compiler);

		new WarnCaseSensitiveModulesPlugin().apply(compiler);

		const AddManagedPathsPlugin = require("./cache/AddManagedPathsPlugin");
		new AddManagedPathsPlugin(
			options.snapshot.managedPaths,
			options.snapshot.immutablePaths
		).apply(compiler);

		if (options.cache && typeof options.cache === "object") {
			const cacheOptions = options.cache;
			switch (cacheOptions.type) {
				case "memory": {
					if (isFinite(cacheOptions.maxGenerations)) {
						//@ts-expect-error https://github.com/microsoft/TypeScript/issues/41697
						const MemoryWithGcCachePlugin = require("./cache/MemoryWithGcCachePlugin");
						new MemoryWithGcCachePlugin({
							maxGenerations: cacheOptions.maxGenerations
						}).apply(compiler);
					} else {
						//@ts-expect-error https://github.com/microsoft/TypeScript/issues/41697
						const MemoryCachePlugin = require("./cache/MemoryCachePlugin");
						new MemoryCachePlugin().apply(compiler);
					}
					if (cacheOptions.cacheUnaffected) {
						if (!options.experiments.cacheUnaffected) {
							throw new Error(
								"'cache.cacheUnaffected: true' is only allowed when 'experiments.cacheUnaffected' is enabled"
							);
						}
						compiler.moduleMemCaches = new Map();
					}
					break;
				}
				case "filesystem": {
					const AddBuildDependenciesPlugin = require("./cache/AddBuildDependenciesPlugin");
					for (const key in cacheOptions.buildDependencies) {
						const list = cacheOptions.buildDependencies[key];
		 				new AddBuildDependenciesPlugin(list).apply(compiler);
					}
					if (!isFinite(cacheOptions.maxMemoryGenerations)) {
						//@ts-expect-error https://github.com/microsoft/TypeScript/issues/41697
						const MemoryCachePlugin = require("./cache/MemoryCachePlugin");
						new MemoryCachePlugin().apply(compiler);
					} else if (cacheOptions.maxMemoryGenerations !== 0) {
						//@ts-expect-error https://github.com/microsoft/TypeScript/issues/41697
						const MemoryWithGcCachePlugin = require("./cache/MemoryWithGcCachePlugin");
						new MemoryWithGcCachePlugin({
							maxGenerations: cacheOptions.maxMemoryGenerations
						}).apply(compiler);
					}
					if (cacheOptions.memoryCacheUnaffected) {
						if (!options.experiments.cacheUnaffected) {
							throw new Error(
								"'cache.memoryCacheUnaffected: true' is only allowed when 'experiments.cacheUnaffected' is enabled"
							);
						}
						compiler.moduleMemCaches = new Map();
					}
					switch (cacheOptions.store) {
						case "pack": {
							const IdleFileCachePlugin = require("./cache/IdleFileCachePlugin");
							const PackFileCacheStrategy = require("./cache/PackFileCacheStrategy");
							new IdleFileCachePlugin(
								new PackFileCacheStrategy({
									compiler,
									fs: compiler.intermediateFileSystem,
									context: options.context,
									cacheLocation: cacheOptions.cacheLocation,
									version: cacheOptions.version,
									logger: compiler.getInfrastructureLogger(
										"webpack.cache.PackFileCacheStrategy"
									),
									snapshot: options.snapshot,
									maxAge: cacheOptions.maxAge,
									profile: cacheOptions.profile,
									allowCollectingMemory: cacheOptions.allowCollectingMemory,
									compression: cacheOptions.compression,
									readonly: cacheOptions.readonly
								}),
								cacheOptions.idleTimeout,
								cacheOptions.idleTimeoutForInitialStore,
								cacheOptions.idleTimeoutAfterLargeChanges
							).apply(compiler);
							break;
						}
						default:
							throw new Error("Unhandled value for cache.store");
					}
					break;
				}
				default:
					// @ts-expect-error Property 'type' does not exist on type 'never'. ts(2339)
					throw new Error(`Unknown cache type ${cacheOptions.type}`);
			}
		}
		new ResolverCachePlugin().apply(compiler);

		if (options.ignoreWarnings && options.ignoreWarnings.length > 0) {
			const IgnoreWarningsPlugin = require("./IgnoreWarningsPlugin");
			new IgnoreWarningsPlugin(options.ignoreWarnings).apply(compiler);
		}

		compiler.hooks.afterPlugins.call(compiler);
		if (!compiler.inputFileSystem) {
			throw new Error("No input filesystem provided");
		}
		compiler.resolverFactory.hooks.resolveOptions
			.for("normal")
			.tap("WebpackOptionsApply", resolveOptions => {
				resolveOptions = cleverMerge(options.resolve, resolveOptions);
				resolveOptions.fileSystem = compiler.inputFileSystem;
				return resolveOptions;
			});
		compiler.resolverFactory.hooks.resolveOptions
			.for("context")
			.tap("WebpackOptionsApply", resolveOptions => {
				resolveOptions = cleverMerge(options.resolve, resolveOptions);
				resolveOptions.fileSystem = compiler.inputFileSystem;
				resolveOptions.resolveToContext = true;
				return resolveOptions;
			});
		compiler.resolverFactory.hooks.resolveOptions
			.for("loader")
			.tap("WebpackOptionsApply", resolveOptions => {
				resolveOptions = cleverMerge(options.resolveLoader, resolveOptions);
				resolveOptions.fileSystem = compiler.inputFileSystem;
				return resolveOptions;
			});
		compiler.hooks.afterResolvers.call(compiler);
		return options;
	}
}

module.exports = WebpackOptionsApply;
