/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

/**
 * lib/index.js - webpack 主导出文件
 *
 * 【文件作用】
 * 这是 webpack 包的主入口（package.json 的 main 字段指向此文件）
 * 负责导出所有公共 API，包括：
 * - webpack 主函数
 * - 各种插件类
 * - 工具函数
 * - 类型定义
 *
 * 【核心设计：懒加载 + 记忆化】⭐⭐⭐
 *
 * 为什么不直接 require 所有模块？
 * 1. **启动性能**：避免加载未使用的模块
 * 2. **内存优化**：只保留使用过的模块在内存中
 * 3. **循环依赖**：延迟加载可以避免部分循环依赖问题
 *
 * 【实现技巧】
 * 1. 使用 getter 实现懒加载
 * 2. 使用 memoize 缓存加载结果
 * 3. 使用 Object.freeze 防止修改
 *
 * 【使用示例】
 * const webpack = require('webpack');
 * // 此时只加载了 index.js，其他模块还未加载
 *
 * const compiler = webpack(config);
 * // 现在才加载 ./webpack.js
 *
 * const { DefinePlugin } = webpack;
 * // 现在才加载 ./DefinePlugin.js
 */

"use strict";

const util = require("util");
// memoize: 缓存函数执行结果的工具函数
const memoize = require("./util/memoize");

/** @typedef {import("../declarations/WebpackOptions").Entry} Entry */
/** @typedef {import("../declarations/WebpackOptions").EntryNormalized} EntryNormalized */
/** @typedef {import("../declarations/WebpackOptions").EntryObject} EntryObject */
/** @typedef {import("../declarations/WebpackOptions").ExternalItemFunctionData} ExternalItemFunctionData */
/** @typedef {import("../declarations/WebpackOptions").ExternalItemObjectKnown} ExternalItemObjectKnown */
/** @typedef {import("../declarations/WebpackOptions").ExternalItemObjectUnknown} ExternalItemObjectUnknown */
/** @typedef {import("../declarations/WebpackOptions").ExternalItemValue} ExternalItemValue */
/** @typedef {import("../declarations/WebpackOptions").Externals} Externals */
/** @typedef {import("../declarations/WebpackOptions").FileCacheOptions} FileCacheOptions */
/** @typedef {import("../declarations/WebpackOptions").LibraryOptions} LibraryOptions */
/** @typedef {import("../declarations/WebpackOptions").MemoryCacheOptions} MemoryCacheOptions */
/** @typedef {import("../declarations/WebpackOptions").ModuleOptions} ModuleOptions */
/** @typedef {import("../declarations/WebpackOptions").ResolveOptions} ResolveOptions */
/** @typedef {import("../declarations/WebpackOptions").RuleSetCondition} RuleSetCondition */
/** @typedef {import("../declarations/WebpackOptions").RuleSetConditionAbsolute} RuleSetConditionAbsolute */
/** @typedef {import("../declarations/WebpackOptions").RuleSetRule} RuleSetRule */
/** @typedef {import("../declarations/WebpackOptions").RuleSetUse} RuleSetUse */
/** @typedef {import("../declarations/WebpackOptions").RuleSetUseItem} RuleSetUseItem */
/** @typedef {import("../declarations/WebpackOptions").StatsOptions} StatsOptions */
/** @typedef {import("../declarations/WebpackOptions").WebpackOptions} Configuration */
/** @typedef {import("../declarations/WebpackOptions").WebpackOptionsNormalized} WebpackOptionsNormalized */
/** @typedef {import("../declarations/WebpackOptions").WebpackPluginFunction} WebpackPluginFunction */
/** @typedef {import("../declarations/WebpackOptions").WebpackPluginInstance} WebpackPluginInstance */
/** @typedef {import("./ChunkGroup")} ChunkGroup */
/** @typedef {import("./Compilation").Asset} Asset */
/** @typedef {import("./Compilation").AssetInfo} AssetInfo */
/** @typedef {import("./Compilation").EntryOptions} EntryOptions */
/** @typedef {import("./Compilation").PathData} PathData */
/** @typedef {import("./Compiler").AssetEmittedInfo} AssetEmittedInfo */
/** @typedef {import("./MultiStats")} MultiStats */
/** @typedef {import("./NormalModuleFactory").ResolveData} ResolveData */
/** @typedef {import("./Parser").ParserState} ParserState */
/** @typedef {import("./ResolverFactory").ResolvePluginInstance} ResolvePluginInstance */
/** @typedef {import("./ResolverFactory").Resolver} Resolver */
/** @typedef {import("./Watching")} Watching */
/** @typedef {import("./cli").Argument} Argument */
/** @typedef {import("./cli").Problem} Problem */
/** @typedef {import("./stats/DefaultStatsFactoryPlugin").StatsAsset} StatsAsset */
/** @typedef {import("./stats/DefaultStatsFactoryPlugin").StatsChunk} StatsChunk */
/** @typedef {import("./stats/DefaultStatsFactoryPlugin").StatsChunkGroup} StatsChunkGroup */
/** @typedef {import("./stats/DefaultStatsFactoryPlugin").StatsChunkOrigin} StatsChunkOrigin */
/** @typedef {import("./stats/DefaultStatsFactoryPlugin").StatsCompilation} StatsCompilation */
/** @typedef {import("./stats/DefaultStatsFactoryPlugin").StatsError} StatsError */
/** @typedef {import("./stats/DefaultStatsFactoryPlugin").StatsLogging} StatsLogging */
/** @typedef {import("./stats/DefaultStatsFactoryPlugin").StatsLoggingEntry} StatsLoggingEntry */
/** @typedef {import("./stats/DefaultStatsFactoryPlugin").StatsModule} StatsModule */
/** @typedef {import("./stats/DefaultStatsFactoryPlugin").StatsModuleIssuer} StatsModuleIssuer */
/** @typedef {import("./stats/DefaultStatsFactoryPlugin").StatsModuleReason} StatsModuleReason */
/** @typedef {import("./stats/DefaultStatsFactoryPlugin").StatsModuleTraceDependency} StatsModuleTraceDependency */
/** @typedef {import("./stats/DefaultStatsFactoryPlugin").StatsModuleTraceItem} StatsModuleTraceItem */
/** @typedef {import("./stats/DefaultStatsFactoryPlugin").StatsProfile} StatsProfile */

/**
 * 懒加载函数工厂（核心工具函数1）⭐
 *
 * 【作用】
 * 创建一个懒加载的函数代理：
 * - 首次调用时才加载真正的函数
 * - 之后的调用使用缓存的函数
 *
 * 【实现原理】
 * 1. 接收一个工厂函数（返回目标函数）
 * 2. 返回一个代理函数
 * 3. 代理函数被调用时：
 *    - 首次：执行工厂函数获取真正的函数并缓存
 *    - 后续：直接使用缓存的函数
 *
 * 【使用场景】
 * webpack 主函数就是用这个创建的：
 * const fn = lazyFunction(() => require("./webpack"));
 *
 * @template {Function} T
 * @param {function(): T} factory - 工厂函数，返回目标函数
 * @returns {T} 懒加载的函数代理
 */
const lazyFunction = factory => {
	// 使用 memoize 包装工厂函数，确保只执行一次
	const fac = memoize(factory);

	// 创建代理函数
	const f = /** @type {any} */ (
		(...args) => {
			// 调用时才执行工厂函数获取真正的函数，并立即调用
			return fac()(...args);
		}
	);

	return /** @type {T} */ (f);
};

/**
 * 合并导出（核心工具函数2）⭐⭐⭐
 *
 * 【作用】
 * 将多个导出对象合并到一个对象上，并实现懒加载
 *
 * 【实现原理】
 * 1. 遍历 exports 对象的所有属性描述符
 * 2. 对于 getter 属性：转换为记忆化的 getter（懒加载）
 * 3. 对于嵌套对象：递归处理
 * 4. 最后冻结对象防止修改
 *
 * 【为什么使用 getter】
 * 使用 getter 而不是直接赋值，可以实现懒加载：
 * - 属性被访问时才执行 getter
 * - getter 内部调用 require() 加载模块
 * - memoize 确保模块只加载一次
 *
 * 【示例】
 * const obj = mergeExports(fn, {
 *   get Compiler() {
 *     return require("./Compiler");
 *   }
 * });
 * // 访问 obj.Compiler 时才加载 ./Compiler.js
 *
 * @template A
 * @template B
 * @param {A} obj - 基础对象
 * @param {B} exports - 要合并的导出对象
 * @returns {A & B} 合并后的对象
 */
const mergeExports = (obj, exports) => {
	// 获取 exports 的所有属性描述符
	const descriptors = Object.getOwnPropertyDescriptors(exports);

	for (const name of Object.keys(descriptors)) {
		const descriptor = descriptors[name];

		if (descriptor.get) {
			// 情况1: getter 属性（大部分导出都是这种）
			const fn = descriptor.get;

			// 将 getter 转换为记忆化的 getter
			Object.defineProperty(obj, name, {
				configurable: false,  // 不可配置（不能删除或修改）
				enumerable: true,     // 可枚举（可以被 for...in 遍历）
				get: memoize(fn)      // 记忆化的 getter（只执行一次）
			});
		} else if (typeof descriptor.value === "object") {
			// 情况2: 嵌套对象（如 webpack.config、webpack.ids 等）
			Object.defineProperty(obj, name, {
				configurable: false,
				enumerable: true,
				writable: false,      // 不可写（防止修改）
				value: mergeExports({}, descriptor.value) // 递归处理嵌套对象
			});
		} else {
			// 情况3: 其他类型（不支持，抛出错误）
			throw new Error(
				"Exposed values must be either a getter or an nested object"
			);
		}
	}

	// 冻结对象，防止添加、删除或修改属性
	return /** @type {A & B} */ (Object.freeze(obj));
};

// ========== 构建最终导出对象 ==========

/**
 * 步骤1: 创建 webpack 主函数（懒加载版本）
 *
 * 【巧妙之处】
 * 这行代码创建了一个函数，同时也是一个对象！
 *
 * JavaScript 中函数也是对象，所以可以：
 * - 作为函数调用：webpack(config)
 * - 作为对象访问属性：webpack.Compiler
 *
 * 【执行时机】
 * require('./webpack') 只在首次调用 webpack(config) 时执行
 */
const fn = lazyFunction(() => require("./webpack"));

/**
 * 步骤2: 合并所有导出到 webpack 函数上
 *
 * 【最终效果】
 * const webpack = require('webpack');
 *
 * // 可以作为函数调用
 * webpack(config);
 *
 * // 也可以访问其他导出
 * new webpack.DefinePlugin();
 * webpack.version;
 *
 * 【导出分类】
 * 1. 核心功能: webpack、validate、version
 * 2. 核心类: Compiler、Compilation、Module 等
 * 3. 插件: DefinePlugin、HotModuleReplacementPlugin 等
 * 4. 工具函数: 在 util、config 命名空间下
 * 5. 子系统: cache、optimize、ids 等命名空间
 */
module.exports = mergeExports(fn, {
	// ========== 核心 API ==========

	/**
	 * webpack 主函数（也可以通过 webpack.webpack 访问）
	 * 提供两种访问方式是为了兼容性
	 */
	get webpack() {
		return require("./webpack");
	},

	/**
	 * 配置验证函数
	 *
	 * 【两阶段验证策略】
	 * 1. 快速验证：使用预编译的 schema（快）
	 * 2. 详细验证：使用完整的 schema（慢，仅在失败时）
	 */
	get validate() {
		// 预编译的快速检查
		const webpackOptionsSchemaCheck = require("../schemas/WebpackOptions.check.js");

		// 详细检查（懒加载 + 记忆化）
		const getRealValidate = memoize(() => {
			const validateSchema = require("./validateSchema");
			const webpackOptionsSchema = require("../schemas/WebpackOptions.json");
			return options => validateSchema(webpackOptionsSchema, options);
		});

		// 返回验证函数
		return options => {
			// 先快速检查，失败再详细检查
			if (!webpackOptionsSchemaCheck(options)) getRealValidate()(options);
		};
	},

	/**
	 * Schema 验证工具（底层 API）
	 * 主要供内部使用，也暴露给高级用户
	 */
	get validateSchema() {
		const validateSchema = require("./validateSchema");
		return validateSchema;
	},

	/**
	 * webpack 版本号
	 * 从 package.json 读取
	 */
	get version() {
		return /** @type {string} */ (require("../package.json").version);
	},

	get cli() {
		return require("./cli");
	},
	get AutomaticPrefetchPlugin() {
		return require("./AutomaticPrefetchPlugin");
	},
	get AsyncDependenciesBlock() {
		return require("./AsyncDependenciesBlock");
	},
	get BannerPlugin() {
		return require("./BannerPlugin");
	},
	get Cache() {
		return require("./Cache");
	},
	get Chunk() {
		return require("./Chunk");
	},
	get ChunkGraph() {
		return require("./ChunkGraph");
	},
	get CleanPlugin() {
		return require("./CleanPlugin");
	},
	get Compilation() {
		return require("./Compilation");
	},
	get Compiler() {
		return require("./Compiler");
	},
	get ConcatenationScope() {
		return require("./ConcatenationScope");
	},
	get ContextExclusionPlugin() {
		return require("./ContextExclusionPlugin");
	},
	get ContextReplacementPlugin() {
		return require("./ContextReplacementPlugin");
	},
	get DefinePlugin() {
		return require("./DefinePlugin");
	},
	get DelegatedPlugin() {
		return require("./DelegatedPlugin");
	},
	get Dependency() {
		return require("./Dependency");
	},
	get DllPlugin() {
		return require("./DllPlugin");
	},
	get DllReferencePlugin() {
		return require("./DllReferencePlugin");
	},
	get DynamicEntryPlugin() {
		return require("./DynamicEntryPlugin");
	},
	get EntryOptionPlugin() {
		return require("./EntryOptionPlugin");
	},
	get EntryPlugin() {
		return require("./EntryPlugin");
	},
	get EnvironmentPlugin() {
		return require("./EnvironmentPlugin");
	},
	get EvalDevToolModulePlugin() {
		return require("./EvalDevToolModulePlugin");
	},
	get EvalSourceMapDevToolPlugin() {
		return require("./EvalSourceMapDevToolPlugin");
	},
	get ExternalModule() {
		return require("./ExternalModule");
	},
	get ExternalsPlugin() {
		return require("./ExternalsPlugin");
	},
	get Generator() {
		return require("./Generator");
	},
	get HotUpdateChunk() {
		return require("./HotUpdateChunk");
	},
	get HotModuleReplacementPlugin() {
		return require("./HotModuleReplacementPlugin");
	},
	get IgnorePlugin() {
		return require("./IgnorePlugin");
	},
	get JavascriptModulesPlugin() {
		return util.deprecate(
			() => require("./javascript/JavascriptModulesPlugin"),
			"webpack.JavascriptModulesPlugin has moved to webpack.javascript.JavascriptModulesPlugin",
			"DEP_WEBPACK_JAVASCRIPT_MODULES_PLUGIN"
		)();
	},
	get LibManifestPlugin() {
		return require("./LibManifestPlugin");
	},
	get LibraryTemplatePlugin() {
		return util.deprecate(
			() => require("./LibraryTemplatePlugin"),
			"webpack.LibraryTemplatePlugin is deprecated and has been replaced by compilation.outputOptions.library or compilation.addEntry + passing a library option",
			"DEP_WEBPACK_LIBRARY_TEMPLATE_PLUGIN"
		)();
	},
	get LoaderOptionsPlugin() {
		return require("./LoaderOptionsPlugin");
	},
	get LoaderTargetPlugin() {
		return require("./LoaderTargetPlugin");
	},
	get Module() {
		return require("./Module");
	},
	get ModuleFilenameHelpers() {
		return require("./ModuleFilenameHelpers");
	},
	get ModuleGraph() {
		return require("./ModuleGraph");
	},
	get ModuleGraphConnection() {
		return require("./ModuleGraphConnection");
	},
	get NoEmitOnErrorsPlugin() {
		return require("./NoEmitOnErrorsPlugin");
	},
	get NormalModule() {
		return require("./NormalModule");
	},
	get NormalModuleReplacementPlugin() {
		return require("./NormalModuleReplacementPlugin");
	},
	get MultiCompiler() {
		return require("./MultiCompiler");
	},
	get Parser() {
		return require("./Parser");
	},
	get PrefetchPlugin() {
		return require("./PrefetchPlugin");
	},
	get ProgressPlugin() {
		return require("./ProgressPlugin");
	},
	get ProvidePlugin() {
		return require("./ProvidePlugin");
	},
	get RuntimeGlobals() {
		return require("./RuntimeGlobals");
	},
	get RuntimeModule() {
		return require("./RuntimeModule");
	},
	get SingleEntryPlugin() {
		return util.deprecate(
			() => require("./EntryPlugin"),
			"SingleEntryPlugin was renamed to EntryPlugin",
			"DEP_WEBPACK_SINGLE_ENTRY_PLUGIN"
		)();
	},
	get SourceMapDevToolPlugin() {
		return require("./SourceMapDevToolPlugin");
	},
	get Stats() {
		return require("./Stats");
	},
	get Template() {
		return require("./Template");
	},
	get UsageState() {
		return require("./ExportsInfo").UsageState;
	},
	get WatchIgnorePlugin() {
		return require("./WatchIgnorePlugin");
	},
	get WebpackError() {
		return require("./WebpackError");
	},
	get WebpackOptionsApply() {
		return require("./WebpackOptionsApply");
	},
	get WebpackOptionsDefaulter() {
		return util.deprecate(
			() => require("./WebpackOptionsDefaulter"),
			"webpack.WebpackOptionsDefaulter is deprecated and has been replaced by webpack.config.getNormalizedWebpackOptions and webpack.config.applyWebpackOptionsDefaults",
			"DEP_WEBPACK_OPTIONS_DEFAULTER"
		)();
	},
	// TODO webpack 6 deprecate
	get WebpackOptionsValidationError() {
		return require("schema-utils").ValidationError;
	},
	get ValidationError() {
		return require("schema-utils").ValidationError;
	},

	cache: {
		get MemoryCachePlugin() {
			return require("./cache/MemoryCachePlugin");
		}
	},

	config: {
		get getNormalizedWebpackOptions() {
			return require("./config/normalization").getNormalizedWebpackOptions;
		},
		get applyWebpackOptionsDefaults() {
			return require("./config/defaults").applyWebpackOptionsDefaults;
		}
	},

	dependencies: {
		get ModuleDependency() {
			return require("./dependencies/ModuleDependency");
		},
		get HarmonyImportDependency() {
			return require("./dependencies/HarmonyImportDependency");
		},
		get ConstDependency() {
			return require("./dependencies/ConstDependency");
		},
		get NullDependency() {
			return require("./dependencies/NullDependency");
		}
	},

	ids: {
		get ChunkModuleIdRangePlugin() {
			return require("./ids/ChunkModuleIdRangePlugin");
		},
		get NaturalModuleIdsPlugin() {
			return require("./ids/NaturalModuleIdsPlugin");
		},
		get OccurrenceModuleIdsPlugin() {
			return require("./ids/OccurrenceModuleIdsPlugin");
		},
		get NamedModuleIdsPlugin() {
			return require("./ids/NamedModuleIdsPlugin");
		},
		get DeterministicChunkIdsPlugin() {
			return require("./ids/DeterministicChunkIdsPlugin");
		},
		get DeterministicModuleIdsPlugin() {
			return require("./ids/DeterministicModuleIdsPlugin");
		},
		get NamedChunkIdsPlugin() {
			return require("./ids/NamedChunkIdsPlugin");
		},
		get OccurrenceChunkIdsPlugin() {
			return require("./ids/OccurrenceChunkIdsPlugin");
		},
		get HashedModuleIdsPlugin() {
			return require("./ids/HashedModuleIdsPlugin");
		}
	},

	javascript: {
		get EnableChunkLoadingPlugin() {
			return require("./javascript/EnableChunkLoadingPlugin");
		},
		get JavascriptModulesPlugin() {
			return require("./javascript/JavascriptModulesPlugin");
		},
		get JavascriptParser() {
			return require("./javascript/JavascriptParser");
		}
	},

	optimize: {
		get AggressiveMergingPlugin() {
			return require("./optimize/AggressiveMergingPlugin");
		},
		get AggressiveSplittingPlugin() {
			return util.deprecate(
				() => require("./optimize/AggressiveSplittingPlugin"),
				"AggressiveSplittingPlugin is deprecated in favor of SplitChunksPlugin",
				"DEP_WEBPACK_AGGRESSIVE_SPLITTING_PLUGIN"
			)();
		},
		get InnerGraph() {
			return require("./optimize/InnerGraph");
		},
		get LimitChunkCountPlugin() {
			return require("./optimize/LimitChunkCountPlugin");
		},
		get MinChunkSizePlugin() {
			return require("./optimize/MinChunkSizePlugin");
		},
		get ModuleConcatenationPlugin() {
			return require("./optimize/ModuleConcatenationPlugin");
		},
		get RealContentHashPlugin() {
			return require("./optimize/RealContentHashPlugin");
		},
		get RuntimeChunkPlugin() {
			return require("./optimize/RuntimeChunkPlugin");
		},
		get SideEffectsFlagPlugin() {
			return require("./optimize/SideEffectsFlagPlugin");
		},
		get SplitChunksPlugin() {
			return require("./optimize/SplitChunksPlugin");
		}
	},

	runtime: {
		get GetChunkFilenameRuntimeModule() {
			return require("./runtime/GetChunkFilenameRuntimeModule");
		},
		get LoadScriptRuntimeModule() {
			return require("./runtime/LoadScriptRuntimeModule");
		}
	},

	prefetch: {
		get ChunkPrefetchPreloadPlugin() {
			return require("./prefetch/ChunkPrefetchPreloadPlugin");
		}
	},

	web: {
		get FetchCompileAsyncWasmPlugin() {
			return require("./web/FetchCompileAsyncWasmPlugin");
		},
		get FetchCompileWasmPlugin() {
			return require("./web/FetchCompileWasmPlugin");
		},
		get JsonpChunkLoadingRuntimeModule() {
			return require("./web/JsonpChunkLoadingRuntimeModule");
		},
		get JsonpTemplatePlugin() {
			return require("./web/JsonpTemplatePlugin");
		}
	},

	webworker: {
		get WebWorkerTemplatePlugin() {
			return require("./webworker/WebWorkerTemplatePlugin");
		}
	},

	node: {
		get NodeEnvironmentPlugin() {
			return require("./node/NodeEnvironmentPlugin");
		},
		get NodeSourcePlugin() {
			return require("./node/NodeSourcePlugin");
		},
		get NodeTargetPlugin() {
			return require("./node/NodeTargetPlugin");
		},
		get NodeTemplatePlugin() {
			return require("./node/NodeTemplatePlugin");
		},
		get ReadFileCompileWasmPlugin() {
			return require("./node/ReadFileCompileWasmPlugin");
		}
	},

	electron: {
		get ElectronTargetPlugin() {
			return require("./electron/ElectronTargetPlugin");
		}
	},

	wasm: {
		get AsyncWebAssemblyModulesPlugin() {
			return require("./wasm-async/AsyncWebAssemblyModulesPlugin");
		},
		get EnableWasmLoadingPlugin() {
			return require("./wasm/EnableWasmLoadingPlugin");
		}
	},

	library: {
		get AbstractLibraryPlugin() {
			return require("./library/AbstractLibraryPlugin");
		},
		get EnableLibraryPlugin() {
			return require("./library/EnableLibraryPlugin");
		}
	},

	container: {
		get ContainerPlugin() {
			return require("./container/ContainerPlugin");
		},
		get ContainerReferencePlugin() {
			return require("./container/ContainerReferencePlugin");
		},
		get ModuleFederationPlugin() {
			return require("./container/ModuleFederationPlugin");
		},
		get scope() {
			return require("./container/options").scope;
		}
	},

	sharing: {
		get ConsumeSharedPlugin() {
			return require("./sharing/ConsumeSharedPlugin");
		},
		get ProvideSharedPlugin() {
			return require("./sharing/ProvideSharedPlugin");
		},
		get SharePlugin() {
			return require("./sharing/SharePlugin");
		},
		get scope() {
			return require("./container/options").scope;
		}
	},

	debug: {
		get ProfilingPlugin() {
			return require("./debug/ProfilingPlugin");
		}
	},

	util: {
		get createHash() {
			return require("./util/createHash");
		},
		get comparators() {
			return require("./util/comparators");
		},
		get runtime() {
			return require("./util/runtime");
		},
		get serialization() {
			return require("./util/serialization");
		},
		get cleverMerge() {
			return require("./util/cleverMerge").cachedCleverMerge;
		},
		get LazySet() {
			return require("./util/LazySet");
		}
	},

	get sources() {
		return require("webpack-sources");
	},

	experiments: {
		schemes: {
			get HttpUriPlugin() {
				return require("./schemes/HttpUriPlugin");
			}
		},
		ids: {
			get SyncModuleIdsPlugin() {
				return require("./ids/SyncModuleIdsPlugin");
			}
		}
	}
});
