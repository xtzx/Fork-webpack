/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

/**
 * lib/Compilation.js - 编译实例类（webpack 最复杂的类）⭐⭐⭐
 *
 * 【文件作用】
 * Compilation 代表一次完整的编译过程，是 webpack 最核心、最复杂的类
 *
 * 【核心职责】
 *
 * 1. **Make 阶段（构建依赖图）**：
 *    - 添加入口模块（addEntry）
 *    - 创建模块（factorizeModule）
 *    - 构建模块（buildModule）
 *    - 处理依赖（processModuleDependencies）
 *    - 构建完整的 ModuleGraph
 *
 * 2. **Seal 阶段（优化和生成）**：
 *    - 创建 Chunk（addChunk）
 *    - 构建 ChunkGraph（buildChunkGraph）
 *    - 优化模块和 Chunk
 *    - 生成 ID（模块 ID、Chunk ID）
 *    - 生成代码（codeGeneration）
 *    - 生成哈希（createHash）
 *    - 创建资源（createChunkAssets）
 *
 * 3. **资源管理**：
 *    - 管理所有输出资源（assets）
 *    - 处理资源优化（压缩等）
 *    - 生成统计信息（Stats）
 *
 * 4. **错误和警告管理**：
 *    - 收集构建错误
 *    - 收集警告信息
 *    - 生成友好的错误报告
 *
 * 【核心数据结构】
 *
 * ```javascript
 * compilation = {
 *   // ===== 模块相关 =====
 *   modules: Set<Module>,              // 所有模块
 *   moduleGraph: ModuleGraph,          // 模块依赖图 ⭐⭐⭐
 *
 *   // ===== Chunk 相关 =====
 *   chunks: Set<Chunk>,                // 所有 Chunk
 *   chunkGraph: ChunkGraph,            // Chunk 图 ⭐⭐⭐
 *   chunkGroups: ChunkGroup[],         // Chunk 组
 *   entrypoints: Map<string, Entrypoint>,  // 入口点
 *
 *   // ===== 资源相关 =====
 *   assets: { [filename]: Source },    // 输出资源 ⭐⭐⭐
 *
 *   // ===== 依赖跟踪 =====
 *   fileDependencies: Set<string>,     // 文件依赖（watch 用）
 *   contextDependencies: Set<string>,  // 目录依赖
 *   missingDependencies: Set<string>,  // 缺失的依赖
 *
 *   // ===== 错误和警告 =====
 *   errors: WebpackError[],            // 错误列表
 *   warnings: WebpackError[],          // 警告列表
 *
 *   // ===== 工厂 =====
 *   moduleFactories: Map<Dep, Factory>,  // 依赖到工厂的映射
 *   dependencyFactories: Map<Dep, Factory>
 * }
 * ```
 *
 * 【与 Compiler 的关系】
 *
 * | Compiler | Compilation |
 * |----------|-------------|
 * | 全局唯一，控制生命周期 | 每次编译创建 |
 * | 管理文件系统、缓存 | 管理模块、Chunk、资源 |
 * | 持久化状态 | 临时状态 |
 * | 触发钩子 | 执行具体工作 |
 *
 * 【生命周期】
 *
 * ```
 * 创建: compiler.compile() → new Compilation()
 * Make: compilation.addEntry() → 构建依赖图
 * Seal: compilation.seal() → 优化和生成
 * 完成: 返回给 compiler
 * 销毁: 下次编译时创建新的 Compilation
 * ```
 *
 * 【钩子系统】
 *
 * Compilation 有 100+ 个钩子！分类如下：
 *
 * 1. **构建阶段钩子**：
 *    - buildModule: 构建模块时
 *    - succeedModule: 模块构建成功
 *    - finishModules: 所有模块构建完成
 *
 * 2. **优化阶段钩子**：
 *    - optimize: 优化开始
 *    - optimizeModules: 优化模块
 *    - optimizeChunks: 优化 Chunk ⭐⭐⭐
 *    - optimizeTree: 优化依赖树
 *
 * 3. **ID 生成钩子**：
 *    - moduleIds: 生成模块 ID
 *    - chunkIds: 生成 Chunk ID
 *
 * 4. **代码生成钩子**：
 *    - beforeHash: 哈希前
 *    - afterHash: 哈希后
 *    - beforeModuleAssets: 模块资源前
 *    - beforeChunkAssets: Chunk 资源前
 *
 * 5. **资源处理钩子**：
 *    - processAssets: 处理资源 ⭐⭐
 *    - afterProcessAssets: 资源处理后
 *
 * 【性能分析】
 *
 * Compilation 的各阶段耗时占比：
 * - Make 阶段：60-70%（构建模块最耗时）
 * - Seal 阶段：25-35%
 *   - buildChunkGraph: 5-8%
 *   - optimizeChunks: 6-10%（SplitChunksPlugin）
 *   - codeGeneration: 8-12%
 *   - createChunkAssets: 5-8%
 * - 其他：5-10%
 *
 * 【重要性】
 * Compilation 是 webpack 最复杂的类（5000+ 行）
 * 理解它就理解了 webpack 的核心工作原理
 */

"use strict";

const asyncLib = require("neo-async");
const {
	HookMap,
	SyncHook,
	SyncBailHook,
	SyncWaterfallHook,
	AsyncSeriesHook,
	AsyncSeriesBailHook,
	AsyncParallelHook
} = require("tapable");
const util = require("util");
const { CachedSource } = require("webpack-sources");
const { MultiItemCache } = require("./CacheFacade");
const Chunk = require("./Chunk");
const ChunkGraph = require("./ChunkGraph");
const ChunkGroup = require("./ChunkGroup");
const ChunkRenderError = require("./ChunkRenderError");
const ChunkTemplate = require("./ChunkTemplate");
const CodeGenerationError = require("./CodeGenerationError");
const CodeGenerationResults = require("./CodeGenerationResults");
const Dependency = require("./Dependency");
const DependencyTemplates = require("./DependencyTemplates");
const Entrypoint = require("./Entrypoint");
const ErrorHelpers = require("./ErrorHelpers");
const FileSystemInfo = require("./FileSystemInfo");
const {
	connectChunkGroupAndChunk,
	connectChunkGroupParentAndChild
} = require("./GraphHelpers");
const {
	makeWebpackError,
	tryRunOrWebpackError
} = require("./HookWebpackError");
const MainTemplate = require("./MainTemplate");
const Module = require("./Module");
const ModuleDependencyError = require("./ModuleDependencyError");
const ModuleDependencyWarning = require("./ModuleDependencyWarning");
const ModuleGraph = require("./ModuleGraph");
const ModuleHashingError = require("./ModuleHashingError");
const ModuleNotFoundError = require("./ModuleNotFoundError");
const ModuleProfile = require("./ModuleProfile");
const ModuleRestoreError = require("./ModuleRestoreError");
const ModuleStoreError = require("./ModuleStoreError");
const ModuleTemplate = require("./ModuleTemplate");
const { WEBPACK_MODULE_TYPE_RUNTIME } = require("./ModuleTypeConstants");
const RuntimeGlobals = require("./RuntimeGlobals");
const RuntimeTemplate = require("./RuntimeTemplate");
const Stats = require("./Stats");
const WebpackError = require("./WebpackError");
const buildChunkGraph = require("./buildChunkGraph");
const BuildCycleError = require("./errors/BuildCycleError");
const { Logger, LogType } = require("./logging/Logger");
const StatsFactory = require("./stats/StatsFactory");
const StatsPrinter = require("./stats/StatsPrinter");
const { equals: arrayEquals } = require("./util/ArrayHelpers");
const AsyncQueue = require("./util/AsyncQueue");
const LazySet = require("./util/LazySet");
const { getOrInsert } = require("./util/MapHelpers");
const WeakTupleMap = require("./util/WeakTupleMap");
const { cachedCleverMerge } = require("./util/cleverMerge");
const {
	compareLocations,
	concatComparators,
	compareSelect,
	compareIds,
	compareStringsNumeric,
	compareModulesByIdentifier
} = require("./util/comparators");
const createHash = require("./util/createHash");
const {
	arrayToSetDeprecation,
	soonFrozenObjectDeprecation,
	createFakeHook
} = require("./util/deprecation");
const processAsyncTree = require("./util/processAsyncTree");
const { getRuntimeKey } = require("./util/runtime");
const { isSourceEqual } = require("./util/source");

/** @template T @typedef {import("tapable").AsArray<T>} AsArray<T> */
/** @typedef {import("webpack-sources").Source} Source */
/** @typedef {import("../declarations/WebpackOptions").EntryDescriptionNormalized} EntryDescription */
/** @typedef {import("../declarations/WebpackOptions").OutputNormalized} OutputOptions */
/** @typedef {import("../declarations/WebpackOptions").StatsOptions} StatsOptions */
/** @typedef {import("../declarations/WebpackOptions").WebpackPluginFunction} WebpackPluginFunction */
/** @typedef {import("../declarations/WebpackOptions").WebpackPluginInstance} WebpackPluginInstance */
/** @typedef {import("./AsyncDependenciesBlock")} AsyncDependenciesBlock */
/** @typedef {import("./Cache")} Cache */
/** @typedef {import("./CacheFacade")} CacheFacade */
/** @typedef {import("./ChunkGroup").ChunkGroupOptions} ChunkGroupOptions */
/** @typedef {import("./Compiler")} Compiler */
/** @typedef {import("./Compiler").CompilationParams} CompilationParams */
/** @typedef {import("./DependenciesBlock")} DependenciesBlock */
/** @typedef {import("./Dependency").DependencyLocation} DependencyLocation */
/** @typedef {import("./Dependency").ReferencedExport} ReferencedExport */
/** @typedef {import("./DependencyTemplate")} DependencyTemplate */
/** @typedef {import("./Entrypoint").EntryOptions} EntryOptions */
/** @typedef {import("./Module").CodeGenerationResult} CodeGenerationResult */
/** @typedef {import("./ModuleFactory")} ModuleFactory */
/** @typedef {import("./ModuleFactory").ModuleFactoryCreateDataContextInfo} ModuleFactoryCreateDataContextInfo */
/** @typedef {import("./ModuleFactory").ModuleFactoryResult} ModuleFactoryResult */
/** @typedef {import("./RequestShortener")} RequestShortener */
/** @typedef {import("./RuntimeModule")} RuntimeModule */
/** @typedef {import("./Template").RenderManifestEntry} RenderManifestEntry */
/** @typedef {import("./Template").RenderManifestOptions} RenderManifestOptions */
/** @typedef {import("./stats/DefaultStatsFactoryPlugin").StatsAsset} StatsAsset */
/** @typedef {import("./stats/DefaultStatsFactoryPlugin").StatsError} StatsError */
/** @typedef {import("./stats/DefaultStatsFactoryPlugin").StatsModule} StatsModule */
/** @typedef {import("./util/Hash")} Hash */
/** @template T @typedef {import("./util/deprecation").FakeHook<T>} FakeHook<T> */
/** @typedef {import("./util/runtime").RuntimeSpec} RuntimeSpec */

/**
 * @callback Callback
 * @param {(WebpackError | null)=} err
 * @returns {void}
 */

/**
 * @callback ModuleCallback
 * @param {(WebpackError | null)=} err
 * @param {Module=} result
 * @returns {void}
 */

/**
 * @callback ModuleFactoryResultCallback
 * @param {(WebpackError | null)=} err
 * @param {ModuleFactoryResult=} result
 * @returns {void}
 */

/**
 * @callback ModuleOrFactoryResultCallback
 * @param {(WebpackError | null)=} err
 * @param {Module | ModuleFactoryResult=} result
 * @returns {void}
 */

/**
 * @callback ExecuteModuleCallback
 * @param {(WebpackError | null)=} err
 * @param {ExecuteModuleResult=} result
 * @returns {void}
 */

/**
 * @callback DepBlockVarDependenciesCallback
 * @param {Dependency} dependency
 * @returns {any}
 */

/** @typedef {new (...args: any[]) => Dependency} DepConstructor */
/** @typedef {Record<string, Source>} CompilationAssets */

/**
 * @typedef {Object} AvailableModulesChunkGroupMapping
 * @property {ChunkGroup} chunkGroup
 * @property {Set<Module>} availableModules
 * @property {boolean} needCopy
 */

/**
 * @typedef {Object} DependenciesBlockLike
 * @property {Dependency[]} dependencies
 * @property {AsyncDependenciesBlock[]} blocks
 */

/**
 * @typedef {Object} ChunkPathData
 * @property {string|number} id
 * @property {string=} name
 * @property {string} hash
 * @property {function(number): string=} hashWithLength
 * @property {(Record<string, string>)=} contentHash
 * @property {(Record<string, (length: number) => string>)=} contentHashWithLength
 */

/**
 * @typedef {Object} ChunkHashContext
 * @property {CodeGenerationResults} codeGenerationResults results of code generation
 * @property {RuntimeTemplate} runtimeTemplate the runtime template
 * @property {ModuleGraph} moduleGraph the module graph
 * @property {ChunkGraph} chunkGraph the chunk graph
 */

/**
 * @typedef {Object} RuntimeRequirementsContext
 * @property {ChunkGraph} chunkGraph the chunk graph
 * @property {CodeGenerationResults} codeGenerationResults the code generation results
 */

/**
 * @typedef {Object} ExecuteModuleOptions
 * @property {EntryOptions=} entryOptions
 */

/**
 * @typedef {Object} ExecuteModuleResult
 * @property {any} exports
 * @property {boolean} cacheable
 * @property {Map<string, { source: Source, info: AssetInfo }>} assets
 * @property {LazySet<string>} fileDependencies
 * @property {LazySet<string>} contextDependencies
 * @property {LazySet<string>} missingDependencies
 * @property {LazySet<string>} buildDependencies
 */

/**
 * @typedef {Object} ExecuteModuleArgument
 * @property {Module} module
 * @property {{ id: string, exports: any, loaded: boolean }=} moduleObject
 * @property {any} preparedInfo
 * @property {CodeGenerationResult} codeGenerationResult
 */

/**
 * @typedef {Object} ExecuteModuleContext
 * @property {Map<string, { source: Source, info: AssetInfo }>} assets
 * @property {Chunk} chunk
 * @property {ChunkGraph} chunkGraph
 * @property {function(string): any=} __webpack_require__
 */

/**
 * @typedef {Object} EntryData
 * @property {Dependency[]} dependencies dependencies of the entrypoint that should be evaluated at startup
 * @property {Dependency[]} includeDependencies dependencies of the entrypoint that should be included but not evaluated
 * @property {EntryOptions} options options of the entrypoint
 */

/**
 * @typedef {Object} LogEntry
 * @property {string} type
 * @property {any[]} args
 * @property {number} time
 * @property {string[]=} trace
 */

/**
 * @typedef {Object} KnownAssetInfo
 * @property {boolean=} immutable true, if the asset can be long term cached forever (contains a hash)
 * @property {boolean=} minimized whether the asset is minimized
 * @property {string | string[]=} fullhash the value(s) of the full hash used for this asset
 * @property {string | string[]=} chunkhash the value(s) of the chunk hash used for this asset
 * @property {string | string[]=} modulehash the value(s) of the module hash used for this asset
 * @property {string | string[]=} contenthash the value(s) of the content hash used for this asset
 * @property {string=} sourceFilename when asset was created from a source file (potentially transformed), the original filename relative to compilation context
 * @property {number=} size size in bytes, only set after asset has been emitted
 * @property {boolean=} development true, when asset is only used for development and doesn't count towards user-facing assets
 * @property {boolean=} hotModuleReplacement true, when asset ships data for updating an existing application (HMR)
 * @property {boolean=} javascriptModule true, when asset is javascript and an ESM
 * @property {Record<string, string | string[]>=} related object of pointers to other assets, keyed by type of relation (only points from parent to child)
 */

/** @typedef {KnownAssetInfo & Record<string, any>} AssetInfo */

/**
 * @typedef {Object} Asset
 * @property {string} name the filename of the asset
 * @property {Source} source source of the asset
 * @property {AssetInfo} info info about the asset
 */

/**
 * @typedef {Object} ModulePathData
 * @property {string|number} id
 * @property {string} hash
 * @property {function(number): string=} hashWithLength
 */

/**
 * @typedef {Object} PathData
 * @property {ChunkGraph=} chunkGraph
 * @property {string=} hash
 * @property {function(number): string=} hashWithLength
 * @property {(Chunk|ChunkPathData)=} chunk
 * @property {(Module|ModulePathData)=} module
 * @property {RuntimeSpec=} runtime
 * @property {string=} filename
 * @property {string=} basename
 * @property {string=} query
 * @property {string=} contentHashType
 * @property {string=} contentHash
 * @property {function(number): string=} contentHashWithLength
 * @property {boolean=} noChunkHash
 * @property {string=} url
 */

/**
 * @typedef {Object} KnownNormalizedStatsOptions
 * @property {string} context
 * @property {RequestShortener} requestShortener
 * @property {string} chunksSort
 * @property {string} modulesSort
 * @property {string} chunkModulesSort
 * @property {string} nestedModulesSort
 * @property {string} assetsSort
 * @property {boolean} ids
 * @property {boolean} cachedAssets
 * @property {boolean} groupAssetsByEmitStatus
 * @property {boolean} groupAssetsByPath
 * @property {boolean} groupAssetsByExtension
 * @property {number} assetsSpace
 * @property {((value: string, asset: StatsAsset) => boolean)[]} excludeAssets
 * @property {((name: string, module: StatsModule, type: "module" | "chunk" | "root-of-chunk" | "nested") => boolean)[]} excludeModules
 * @property {((warning: StatsError, textValue: string) => boolean)[]} warningsFilter
 * @property {boolean} cachedModules
 * @property {boolean} orphanModules
 * @property {boolean} dependentModules
 * @property {boolean} runtimeModules
 * @property {boolean} groupModulesByCacheStatus
 * @property {boolean} groupModulesByLayer
 * @property {boolean} groupModulesByAttributes
 * @property {boolean} groupModulesByPath
 * @property {boolean} groupModulesByExtension
 * @property {boolean} groupModulesByType
 * @property {boolean | "auto"} entrypoints
 * @property {boolean} chunkGroups
 * @property {boolean} chunkGroupAuxiliary
 * @property {boolean} chunkGroupChildren
 * @property {number} chunkGroupMaxAssets
 * @property {number} modulesSpace
 * @property {number} chunkModulesSpace
 * @property {number} nestedModulesSpace
 * @property {false|"none"|"error"|"warn"|"info"|"log"|"verbose"} logging
 * @property {((value: string) => boolean)[]} loggingDebug
 * @property {boolean} loggingTrace
 * @property {any} _env
 */

/** @typedef {KnownNormalizedStatsOptions & Omit<StatsOptions, keyof KnownNormalizedStatsOptions> & Record<string, any>} NormalizedStatsOptions */

/**
 * @typedef {Object} KnownCreateStatsOptionsContext
 * @property {boolean=} forToString
 */

/** @typedef {KnownCreateStatsOptionsContext & Record<string, any>} CreateStatsOptionsContext */

/** @type {AssetInfo} */
const EMPTY_ASSET_INFO = Object.freeze({});

const esmDependencyCategory = "esm";
// TODO webpack 6: remove
const deprecatedNormalModuleLoaderHook = util.deprecate(
	compilation => {
		return require("./NormalModule").getCompilationHooks(compilation).loader;
	},
	"Compilation.hooks.normalModuleLoader was moved to NormalModule.getCompilationHooks(compilation).loader",
	"DEP_WEBPACK_COMPILATION_NORMAL_MODULE_LOADER_HOOK"
);

// TODO webpack 6: remove
const defineRemovedModuleTemplates = moduleTemplates => {
	Object.defineProperties(moduleTemplates, {
		asset: {
			enumerable: false,
			configurable: false,
			get: () => {
				throw new WebpackError(
					"Compilation.moduleTemplates.asset has been removed"
				);
			}
		},
		webassembly: {
			enumerable: false,
			configurable: false,
			get: () => {
				throw new WebpackError(
					"Compilation.moduleTemplates.webassembly has been removed"
				);
			}
		}
	});
	moduleTemplates = undefined;
};

const byId = compareSelect(
	/**
	 * @param {Chunk} c chunk
	 * @returns {number | string} id
	 */ c => c.id,
	compareIds
);

const byNameOrHash = concatComparators(
	compareSelect(
		/**
		 * @param {Compilation} c compilation
		 * @returns {string} name
		 */
		c => c.name,
		compareIds
	),
	compareSelect(
		/**
		 * @param {Compilation} c compilation
		 * @returns {string} hash
		 */ c => c.fullHash,
		compareIds
	)
);

const byMessage = compareSelect(err => `${err.message}`, compareStringsNumeric);

const byModule = compareSelect(
	err => (err.module && err.module.identifier()) || "",
	compareStringsNumeric
);

const byLocation = compareSelect(err => err.loc, compareLocations);

const compareErrors = concatComparators(byModule, byLocation, byMessage);

/** @type {WeakMap<Dependency, Module & { restoreFromUnsafeCache: Function } | null>} */
const unsafeCacheDependencies = new WeakMap();

/** @type {WeakMap<Module & { restoreFromUnsafeCache: Function }, object>} */
const unsafeCacheData = new WeakMap();

class Compilation {
	/**
	 * Compilation 构造函数
	 *
	 * 【创建时机】
	 * 在 compiler.compile() 中调用：
	 * ```javascript
	 * const compilation = compiler.newCompilation(params);
	 * ```
	 *
	 * 【参数说明】
	 *
	 * compiler: 创建此 Compilation 的 Compiler 实例
	 * params: 包含模块工厂的编译参数
	 *   - normalModuleFactory: 普通模块工厂
	 *   - contextModuleFactory: 上下文模块工厂
	 *
	 * 【初始化内容】
	 * 1. 创建 100+ 个钩子
	 * 2. 初始化核心数据结构（modules、chunks、assets 等）
	 * 3. 创建 ModuleGraph
	 * 4. 创建队列系统（factorizeQueue、buildQueue 等）
	 * 5. 设置依赖工厂映射
	 *
	 * 【队列系统】⭐
	 * Compilation 使用多个异步队列并行处理任务：
	 * - factorizeQueue: 模块创建队列
	 * - buildQueue: 模块构建队列
	 * - rebuildQueue: 模块重建队列
	 * - processDependenciesQueue: 依赖处理队列
	 *
	 * 这些队列允许并行处理多个模块，提升性能
	 *
	 * @param {Compiler} compiler - 创建此编译的编译器
	 * @param {CompilationParams} params - 编译参数
	 */
	constructor(compiler, params) {
		// 向后兼容标记
		this._backCompat = compiler._backCompat;

		// ===== 准备钩子相关 =====

		// 获取已废弃的 normalModuleLoader 钩子（向后兼容）
		const getNormalModuleLoader = () => deprecatedNormalModuleLoaderHook(this);

		/**
		 * processAssets 钩子的特殊处理
		 *
		 * 【作用】
		 * processAssets 是资源处理的核心钩子，支持多个阶段
		 * 需要特殊的拦截器处理 additionalAssets
		 *
		 * @typedef {{ additionalAssets?: true | Function }} ProcessAssetsAdditionalOptions
		 * @type {AsyncSeriesHook<[CompilationAssets], ProcessAssetsAdditionalOptions>}
		 */
		const processAssetsHook = new AsyncSeriesHook(["assets"]);

		let savedAssets = new Set();
		const popNewAssets = assets => {
			let newAssets = undefined;
			for (const file of Object.keys(assets)) {
				if (savedAssets.has(file)) continue;
				if (newAssets === undefined) {
					newAssets = Object.create(null);
				}
				newAssets[file] = assets[file];
				savedAssets.add(file);
			}
			return newAssets;
		};
		processAssetsHook.intercept({
			name: "Compilation",
			call: () => {
				savedAssets = new Set(Object.keys(this.assets));
			},
			register: tap => {
				const { type, name } = tap;
				const { fn, additionalAssets, ...remainingTap } = tap;
				const additionalAssetsFn =
					additionalAssets === true ? fn : additionalAssets;
				const processedAssets = additionalAssetsFn ? new WeakSet() : undefined;
				switch (type) {
					case "sync":
						if (additionalAssetsFn) {
							this.hooks.processAdditionalAssets.tap(name, assets => {
								if (processedAssets.has(this.assets))
									additionalAssetsFn(assets);
							});
						}
						return {
							...remainingTap,
							type: "async",
							fn: (assets, callback) => {
								try {
									fn(assets);
								} catch (e) {
									return callback(e);
								}
								if (processedAssets !== undefined)
									processedAssets.add(this.assets);
								const newAssets = popNewAssets(assets);
								if (newAssets !== undefined) {
									this.hooks.processAdditionalAssets.callAsync(
										newAssets,
										callback
									);
									return;
								}
								callback();
							}
						};
					case "async":
						if (additionalAssetsFn) {
							this.hooks.processAdditionalAssets.tapAsync(
								name,
								(assets, callback) => {
									if (processedAssets.has(this.assets))
										return additionalAssetsFn(assets, callback);
									callback();
								}
							);
						}
						return {
							...remainingTap,
							fn: (assets, callback) => {
								fn(assets, err => {
									if (err) return callback(err);
									if (processedAssets !== undefined)
										processedAssets.add(this.assets);
									const newAssets = popNewAssets(assets);
									if (newAssets !== undefined) {
										this.hooks.processAdditionalAssets.callAsync(
											newAssets,
											callback
										);
										return;
									}
									callback();
								});
							}
						};
					case "promise":
						if (additionalAssetsFn) {
							this.hooks.processAdditionalAssets.tapPromise(name, assets => {
								if (processedAssets.has(this.assets))
									return additionalAssetsFn(assets);
								return Promise.resolve();
							});
						}
						return {
							...remainingTap,
							fn: assets => {
								const p = fn(assets);
								if (!p || !p.then) return p;
								return p.then(() => {
									if (processedAssets !== undefined)
										processedAssets.add(this.assets);
									const newAssets = popNewAssets(assets);
									if (newAssets !== undefined) {
										return this.hooks.processAdditionalAssets.promise(
											newAssets
										);
									}
								});
							}
						};
				}
			}
		});

		/** @type {SyncHook<[CompilationAssets]>} */
		const afterProcessAssetsHook = new SyncHook(["assets"]);

		/**
		 * @template T
		 * @param {string} name name of the hook
		 * @param {number} stage new stage
		 * @param {function(): AsArray<T>} getArgs get old hook function args
		 * @param {string=} code deprecation code (not deprecated when unset)
		 * @returns {FakeHook<Pick<AsyncSeriesHook<T>, "tap" | "tapAsync" | "tapPromise" | "name">>} fake hook which redirects
		 */
		const createProcessAssetsHook = (name, stage, getArgs, code) => {
			if (!this._backCompat && code) return undefined;
			const errorMessage =
				reason => `Can't automatically convert plugin using Compilation.hooks.${name} to Compilation.hooks.processAssets because ${reason}.
BREAKING CHANGE: Asset processing hooks in Compilation has been merged into a single Compilation.hooks.processAssets hook.`;
			const getOptions = options => {
				if (typeof options === "string") options = { name: options };
				if (options.stage) {
					throw new Error(errorMessage("it's using the 'stage' option"));
				}
				return { ...options, stage: stage };
			};
			return createFakeHook(
				{
					name,
					/** @type {AsyncSeriesHook<T>["intercept"]} */
					intercept(interceptor) {
						throw new Error(errorMessage("it's using 'intercept'"));
					},
					/** @type {AsyncSeriesHook<T>["tap"]} */
					tap: (options, fn) => {
						processAssetsHook.tap(getOptions(options), () => fn(...getArgs()));
					},
					/** @type {AsyncSeriesHook<T>["tapAsync"]} */
					tapAsync: (options, fn) => {
						processAssetsHook.tapAsync(
							getOptions(options),
							(assets, callback) =>
								/** @type {any} */ (fn)(...getArgs(), callback)
						);
					},
					/** @type {AsyncSeriesHook<T>["tapPromise"]} */
					tapPromise: (options, fn) => {
						processAssetsHook.tapPromise(getOptions(options), () =>
							fn(...getArgs())
						);
					}
				},
				`${name} is deprecated (use Compilation.hooks.processAssets instead and use one of Compilation.PROCESS_ASSETS_STAGE_* as stage option)`,
				code
			);
		};
		this.hooks = Object.freeze({
			/** @type {SyncHook<[Module]>} */
			buildModule: new SyncHook(["module"]),
			/** @type {SyncHook<[Module]>} */
			rebuildModule: new SyncHook(["module"]),
			/** @type {SyncHook<[Module, WebpackError]>} */
			failedModule: new SyncHook(["module", "error"]),
			/** @type {SyncHook<[Module]>} */
			succeedModule: new SyncHook(["module"]),
			/** @type {SyncHook<[Module]>} */
			stillValidModule: new SyncHook(["module"]),

			/** @type {SyncHook<[Dependency, EntryOptions]>} */
			addEntry: new SyncHook(["entry", "options"]),
			/** @type {SyncHook<[Dependency, EntryOptions, Error]>} */
			failedEntry: new SyncHook(["entry", "options", "error"]),
			/** @type {SyncHook<[Dependency, EntryOptions, Module]>} */
			succeedEntry: new SyncHook(["entry", "options", "module"]),

			/** @type {SyncWaterfallHook<[(string[] | ReferencedExport)[], Dependency, RuntimeSpec]>} */
			dependencyReferencedExports: new SyncWaterfallHook([
				"referencedExports",
				"dependency",
				"runtime"
			]),

			/** @type {SyncHook<[ExecuteModuleArgument, ExecuteModuleContext]>} */
			executeModule: new SyncHook(["options", "context"]),
			/** @type {AsyncParallelHook<[ExecuteModuleArgument, ExecuteModuleContext]>} */
			prepareModuleExecution: new AsyncParallelHook(["options", "context"]),

			/** @type {AsyncSeriesHook<[Iterable<Module>]>} */
			finishModules: new AsyncSeriesHook(["modules"]),
			/** @type {AsyncSeriesHook<[Module]>} */
			finishRebuildingModule: new AsyncSeriesHook(["module"]),
			/** @type {SyncHook<[]>} */
			unseal: new SyncHook([]),
			/** @type {SyncHook<[]>} */
			seal: new SyncHook([]),

			/** @type {SyncHook<[]>} */
			beforeChunks: new SyncHook([]),
			/**
			 * The `afterChunks` hook is called directly after the chunks and module graph have
			 * been created and before the chunks and modules have been optimized. This hook is useful to
			 * inspect, analyze, and/or modify the chunk graph.
			 * @type {SyncHook<[Iterable<Chunk>]>}
			 */
			afterChunks: new SyncHook(["chunks"]),

			/** @type {SyncBailHook<[Iterable<Module>]>} */
			optimizeDependencies: new SyncBailHook(["modules"]),
			/** @type {SyncHook<[Iterable<Module>]>} */
			afterOptimizeDependencies: new SyncHook(["modules"]),

			/** @type {SyncHook<[]>} */
			optimize: new SyncHook([]),
			/** @type {SyncBailHook<[Iterable<Module>]>} */
			optimizeModules: new SyncBailHook(["modules"]),
			/** @type {SyncHook<[Iterable<Module>]>} */
			afterOptimizeModules: new SyncHook(["modules"]),

			/** @type {SyncBailHook<[Iterable<Chunk>, ChunkGroup[]]>} */
			optimizeChunks: new SyncBailHook(["chunks", "chunkGroups"]),
			/** @type {SyncHook<[Iterable<Chunk>, ChunkGroup[]]>} */
			afterOptimizeChunks: new SyncHook(["chunks", "chunkGroups"]),

			/** @type {AsyncSeriesHook<[Iterable<Chunk>, Iterable<Module>]>} */
			optimizeTree: new AsyncSeriesHook(["chunks", "modules"]),
			/** @type {SyncHook<[Iterable<Chunk>, Iterable<Module>]>} */
			afterOptimizeTree: new SyncHook(["chunks", "modules"]),

			/** @type {AsyncSeriesBailHook<[Iterable<Chunk>, Iterable<Module>]>} */
			optimizeChunkModules: new AsyncSeriesBailHook(["chunks", "modules"]),
			/** @type {SyncHook<[Iterable<Chunk>, Iterable<Module>]>} */
			afterOptimizeChunkModules: new SyncHook(["chunks", "modules"]),
			/** @type {SyncBailHook<[], boolean | undefined>} */
			shouldRecord: new SyncBailHook([]),

			/** @type {SyncHook<[Chunk, Set<string>, RuntimeRequirementsContext]>} */
			additionalChunkRuntimeRequirements: new SyncHook([
				"chunk",
				"runtimeRequirements",
				"context"
			]),
			/** @type {HookMap<SyncBailHook<[Chunk, Set<string>, RuntimeRequirementsContext]>>} */
			runtimeRequirementInChunk: new HookMap(
				() => new SyncBailHook(["chunk", "runtimeRequirements", "context"])
			),
			/** @type {SyncHook<[Module, Set<string>, RuntimeRequirementsContext]>} */
			additionalModuleRuntimeRequirements: new SyncHook([
				"module",
				"runtimeRequirements",
				"context"
			]),
			/** @type {HookMap<SyncBailHook<[Module, Set<string>, RuntimeRequirementsContext]>>} */
			runtimeRequirementInModule: new HookMap(
				() => new SyncBailHook(["module", "runtimeRequirements", "context"])
			),
			/** @type {SyncHook<[Chunk, Set<string>, RuntimeRequirementsContext]>} */
			additionalTreeRuntimeRequirements: new SyncHook([
				"chunk",
				"runtimeRequirements",
				"context"
			]),
			/** @type {HookMap<SyncBailHook<[Chunk, Set<string>, RuntimeRequirementsContext]>>} */
			runtimeRequirementInTree: new HookMap(
				() => new SyncBailHook(["chunk", "runtimeRequirements", "context"])
			),

			/** @type {SyncHook<[RuntimeModule, Chunk]>} */
			runtimeModule: new SyncHook(["module", "chunk"]),

			/** @type {SyncHook<[Iterable<Module>, any]>} */
			reviveModules: new SyncHook(["modules", "records"]),
			/** @type {SyncHook<[Iterable<Module>]>} */
			beforeModuleIds: new SyncHook(["modules"]),
			/** @type {SyncHook<[Iterable<Module>]>} */
			moduleIds: new SyncHook(["modules"]),
			/** @type {SyncHook<[Iterable<Module>]>} */
			optimizeModuleIds: new SyncHook(["modules"]),
			/** @type {SyncHook<[Iterable<Module>]>} */
			afterOptimizeModuleIds: new SyncHook(["modules"]),

			/** @type {SyncHook<[Iterable<Chunk>, any]>} */
			reviveChunks: new SyncHook(["chunks", "records"]),
			/** @type {SyncHook<[Iterable<Chunk>]>} */
			beforeChunkIds: new SyncHook(["chunks"]),
			/** @type {SyncHook<[Iterable<Chunk>]>} */
			chunkIds: new SyncHook(["chunks"]),
			/** @type {SyncHook<[Iterable<Chunk>]>} */
			optimizeChunkIds: new SyncHook(["chunks"]),
			/** @type {SyncHook<[Iterable<Chunk>]>} */
			afterOptimizeChunkIds: new SyncHook(["chunks"]),

			/** @type {SyncHook<[Iterable<Module>, any]>} */
			recordModules: new SyncHook(["modules", "records"]),
			/** @type {SyncHook<[Iterable<Chunk>, any]>} */
			recordChunks: new SyncHook(["chunks", "records"]),

			/** @type {SyncHook<[Iterable<Module>]>} */
			optimizeCodeGeneration: new SyncHook(["modules"]),

			/** @type {SyncHook<[]>} */
			beforeModuleHash: new SyncHook([]),
			/** @type {SyncHook<[]>} */
			afterModuleHash: new SyncHook([]),

			/** @type {SyncHook<[]>} */
			beforeCodeGeneration: new SyncHook([]),
			/** @type {SyncHook<[]>} */
			afterCodeGeneration: new SyncHook([]),

			/** @type {SyncHook<[]>} */
			beforeRuntimeRequirements: new SyncHook([]),
			/** @type {SyncHook<[]>} */
			afterRuntimeRequirements: new SyncHook([]),

			/** @type {SyncHook<[]>} */
			beforeHash: new SyncHook([]),
			/** @type {SyncHook<[Chunk]>} */
			contentHash: new SyncHook(["chunk"]),
			/** @type {SyncHook<[]>} */
			afterHash: new SyncHook([]),
			/** @type {SyncHook<[any]>} */
			recordHash: new SyncHook(["records"]),
			/** @type {SyncHook<[Compilation, any]>} */
			record: new SyncHook(["compilation", "records"]),

			/** @type {SyncHook<[]>} */
			beforeModuleAssets: new SyncHook([]),
			/** @type {SyncBailHook<[], boolean>} */
			shouldGenerateChunkAssets: new SyncBailHook([]),
			/** @type {SyncHook<[]>} */
			beforeChunkAssets: new SyncHook([]),
			// TODO webpack 6 remove
			/** @deprecated */
			additionalChunkAssets: createProcessAssetsHook(
				"additionalChunkAssets",
				Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
				() => [this.chunks],
				"DEP_WEBPACK_COMPILATION_ADDITIONAL_CHUNK_ASSETS"
			),

			// TODO webpack 6 deprecate
			/** @deprecated */
			additionalAssets: createProcessAssetsHook(
				"additionalAssets",
				Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
				() => []
			),
			// TODO webpack 6 remove
			/** @deprecated */
			optimizeChunkAssets: createProcessAssetsHook(
				"optimizeChunkAssets",
				Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE,
				() => [this.chunks],
				"DEP_WEBPACK_COMPILATION_OPTIMIZE_CHUNK_ASSETS"
			),
			// TODO webpack 6 remove
			/** @deprecated */
			afterOptimizeChunkAssets: createProcessAssetsHook(
				"afterOptimizeChunkAssets",
				Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE + 1,
				() => [this.chunks],
				"DEP_WEBPACK_COMPILATION_AFTER_OPTIMIZE_CHUNK_ASSETS"
			),
			// TODO webpack 6 deprecate
			/** @deprecated */
			optimizeAssets: processAssetsHook,
			// TODO webpack 6 deprecate
			/** @deprecated */
			afterOptimizeAssets: afterProcessAssetsHook,

			processAssets: processAssetsHook,
			afterProcessAssets: afterProcessAssetsHook,
			/** @type {AsyncSeriesHook<[CompilationAssets]>} */
			processAdditionalAssets: new AsyncSeriesHook(["assets"]),

			/** @type {SyncBailHook<[], boolean>} */
			needAdditionalSeal: new SyncBailHook([]),
			/** @type {AsyncSeriesHook<[]>} */
			afterSeal: new AsyncSeriesHook([]),

			/** @type {SyncWaterfallHook<[RenderManifestEntry[], RenderManifestOptions]>} */
			renderManifest: new SyncWaterfallHook(["result", "options"]),

			/** @type {SyncHook<[Hash]>} */
			fullHash: new SyncHook(["hash"]),
			/** @type {SyncHook<[Chunk, Hash, ChunkHashContext]>} */
			chunkHash: new SyncHook(["chunk", "chunkHash", "ChunkHashContext"]),

			/** @type {SyncHook<[Module, string]>} */
			moduleAsset: new SyncHook(["module", "filename"]),
			/** @type {SyncHook<[Chunk, string]>} */
			chunkAsset: new SyncHook(["chunk", "filename"]),

			/** @type {SyncWaterfallHook<[string, object, AssetInfo]>} */
			assetPath: new SyncWaterfallHook(["path", "options", "assetInfo"]),

			/** @type {SyncBailHook<[], boolean>} */
			needAdditionalPass: new SyncBailHook([]),

			/** @type {SyncHook<[Compiler, string, number]>} */
			childCompiler: new SyncHook([
				"childCompiler",
				"compilerName",
				"compilerIndex"
			]),

			/** @type {SyncBailHook<[string, LogEntry], true>} */
			log: new SyncBailHook(["origin", "logEntry"]),

			/** @type {SyncWaterfallHook<[WebpackError[]]>} */
			processWarnings: new SyncWaterfallHook(["warnings"]),
			/** @type {SyncWaterfallHook<[WebpackError[]]>} */
			processErrors: new SyncWaterfallHook(["errors"]),

			/** @type {HookMap<SyncHook<[Partial<NormalizedStatsOptions>, CreateStatsOptionsContext]>>} */
			statsPreset: new HookMap(() => new SyncHook(["options", "context"])),
			/** @type {SyncHook<[Partial<NormalizedStatsOptions>, CreateStatsOptionsContext]>} */
			statsNormalize: new SyncHook(["options", "context"]),
			/** @type {SyncHook<[StatsFactory, NormalizedStatsOptions]>} */
			statsFactory: new SyncHook(["statsFactory", "options"]),
			/** @type {SyncHook<[StatsPrinter, NormalizedStatsOptions]>} */
			statsPrinter: new SyncHook(["statsPrinter", "options"]),

			get normalModuleLoader() {
				return getNormalModuleLoader();
			}
		});
		/** @type {string=} */
		this.name = undefined;
		this.startTime = undefined;
		this.endTime = undefined;
		/** @type {Compiler} */
		this.compiler = compiler;
		this.resolverFactory = compiler.resolverFactory;
		this.inputFileSystem = compiler.inputFileSystem;
		this.fileSystemInfo = new FileSystemInfo(this.inputFileSystem, {
			managedPaths: compiler.managedPaths,
			immutablePaths: compiler.immutablePaths,
			logger: this.getLogger("webpack.FileSystemInfo"),
			hashFunction: compiler.options.output.hashFunction
		});
		if (compiler.fileTimestamps) {
			this.fileSystemInfo.addFileTimestamps(compiler.fileTimestamps, true);
		}
		if (compiler.contextTimestamps) {
			this.fileSystemInfo.addContextTimestamps(
				compiler.contextTimestamps,
				true
			);
		}
		/** @type {Map<string, string | Set<string>>} */
		this.valueCacheVersions = new Map();
		this.requestShortener = compiler.requestShortener;
		this.compilerPath = compiler.compilerPath;

		this.logger = this.getLogger("webpack.Compilation");

		const options = compiler.options;
		this.options = options;
		this.outputOptions = options && options.output;
		/** @type {boolean} */
		this.bail = (options && options.bail) || false;
		/** @type {boolean} */
		this.profile = (options && options.profile) || false;

		this.params = params;
		this.mainTemplate = new MainTemplate(this.outputOptions, this);
		this.chunkTemplate = new ChunkTemplate(this.outputOptions, this);
		this.runtimeTemplate = new RuntimeTemplate(
			this,
			this.outputOptions,
			this.requestShortener
		);
		/** @type {{javascript: ModuleTemplate}} */
		this.moduleTemplates = {
			javascript: new ModuleTemplate(this.runtimeTemplate, this)
		};
		defineRemovedModuleTemplates(this.moduleTemplates);

		/** @type {Map<Module, WeakTupleMap<any, any>> | undefined} */
		this.moduleMemCaches = undefined;
		/** @type {Map<Module, WeakTupleMap<any, any>> | undefined} */
		this.moduleMemCaches2 = undefined;
		this.moduleGraph = new ModuleGraph();
		/** @type {ChunkGraph} */
		this.chunkGraph = undefined;
		/** @type {CodeGenerationResults} */
		this.codeGenerationResults = undefined;

		/** @type {AsyncQueue<Module, Module, Module>} */
		this.processDependenciesQueue = new AsyncQueue({
			name: "processDependencies",
			parallelism: options.parallelism || 100,
			processor: this._processModuleDependencies.bind(this)
		});
		/** @type {AsyncQueue<Module, string, Module>} */
		this.addModuleQueue = new AsyncQueue({
			name: "addModule",
			parent: this.processDependenciesQueue,
			getKey: module => module.identifier(),
			processor: this._addModule.bind(this)
		});
		/** @type {AsyncQueue<FactorizeModuleOptions, string, Module | ModuleFactoryResult>} */
		this.factorizeQueue = new AsyncQueue({
			name: "factorize",
			parent: this.addModuleQueue,
			processor: this._factorizeModule.bind(this)
		});
		/** @type {AsyncQueue<Module, Module, Module>} */
		this.buildQueue = new AsyncQueue({
			name: "build",
			parent: this.factorizeQueue,
			processor: this._buildModule.bind(this)
		});
		/** @type {AsyncQueue<Module, Module, Module>} */
		this.rebuildQueue = new AsyncQueue({
			name: "rebuild",
			parallelism: options.parallelism || 100,
			processor: this._rebuildModule.bind(this)
		});

		/**
		 * Modules in value are building during the build of Module in key.
		 * Means value blocking key from finishing.
		 * Needed to detect build cycles.
		 * @type {WeakMap<Module, Set<Module>>}
		 */
		this.creatingModuleDuringBuild = new WeakMap();

		/** @type {Map<string, EntryData>} */
		this.entries = new Map();
		/** @type {EntryData} */
		this.globalEntry = {
			dependencies: [],
			includeDependencies: [],
			options: {
				name: undefined
			}
		};
		/** @type {Map<string, Entrypoint>} */
		this.entrypoints = new Map();
		/** @type {Entrypoint[]} */
		this.asyncEntrypoints = [];
		/** @type {Set<Chunk>} */
		this.chunks = new Set();
		/** @type {ChunkGroup[]} */
		this.chunkGroups = [];
		/** @type {Map<string, ChunkGroup>} */
		this.namedChunkGroups = new Map();
		/** @type {Map<string, Chunk>} */
		this.namedChunks = new Map();
		/** @type {Set<Module>} */
		this.modules = new Set();
		if (this._backCompat) {
			arrayToSetDeprecation(this.chunks, "Compilation.chunks");
			arrayToSetDeprecation(this.modules, "Compilation.modules");
		}
		/** @private @type {Map<string, Module>} */
		this._modules = new Map();
		this.records = null;
		/** @type {string[]} */
		this.additionalChunkAssets = [];
		/** @type {CompilationAssets} */
		this.assets = {};
		/** @type {Map<string, AssetInfo>} */
		this.assetsInfo = new Map();
		/** @type {Map<string, Map<string, Set<string>>>} */
		this._assetsRelatedIn = new Map();
		/** @type {WebpackError[]} */
		this.errors = [];
		/** @type {WebpackError[]} */
		this.warnings = [];
		/** @type {Compilation[]} */
		this.children = [];
		/** @type {Map<string, LogEntry[]>} */
		this.logging = new Map();
		/** @type {Map<DepConstructor, ModuleFactory>} */
		this.dependencyFactories = new Map();
		/** @type {DependencyTemplates} */
		this.dependencyTemplates = new DependencyTemplates(
			this.outputOptions.hashFunction
		);
		this.childrenCounters = {};
		/** @type {Set<number|string>} */
		this.usedChunkIds = null;
		/** @type {Set<number>} */
		this.usedModuleIds = null;
		/** @type {boolean} */
		this.needAdditionalPass = false;
		/** @type {Set<Module & { restoreFromUnsafeCache: Function }>} */
		this._restoredUnsafeCacheModuleEntries = new Set();
		/** @type {Map<string, Module & { restoreFromUnsafeCache: Function }>} */
		this._restoredUnsafeCacheEntries = new Map();
		/** @type {WeakSet<Module>} */
		this.builtModules = new WeakSet();
		/** @type {WeakSet<Module>} */
		this.codeGeneratedModules = new WeakSet();
		/** @type {WeakSet<Module>} */
		this.buildTimeExecutedModules = new WeakSet();
		/** @private @type {Map<Module, Callback[]>} */
		this._rebuildingModules = new Map();
		/** @type {Set<string>} */
		this.emittedAssets = new Set();
		/** @type {Set<string>} */
		this.comparedForEmitAssets = new Set();
		/** @type {LazySet<string>} */
		this.fileDependencies = new LazySet();
		/** @type {LazySet<string>} */
		this.contextDependencies = new LazySet();
		/** @type {LazySet<string>} */
		this.missingDependencies = new LazySet();
		/** @type {LazySet<string>} */
		this.buildDependencies = new LazySet();
		// TODO webpack 6 remove
		this.compilationDependencies = {
			add: util.deprecate(
				item => this.fileDependencies.add(item),
				"Compilation.compilationDependencies is deprecated (used Compilation.fileDependencies instead)",
				"DEP_WEBPACK_COMPILATION_COMPILATION_DEPENDENCIES"
			)
		};

		this._modulesCache = this.getCache("Compilation/modules");
		this._assetsCache = this.getCache("Compilation/assets");
		this._codeGenerationCache = this.getCache("Compilation/codeGeneration");

		const unsafeCache = options.module.unsafeCache;
		this._unsafeCache = !!unsafeCache;
		this._unsafeCachePredicate =
			typeof unsafeCache === "function" ? unsafeCache : () => true;
	}

	getStats() {
		return new Stats(this);
	}

	/**
	 * @param {StatsOptions | string} optionsOrPreset stats option value
	 * @param {CreateStatsOptionsContext} context context
	 * @returns {NormalizedStatsOptions} normalized options
	 */
	createStatsOptions(optionsOrPreset, context = {}) {
		if (
			typeof optionsOrPreset === "boolean" ||
			typeof optionsOrPreset === "string"
		) {
			optionsOrPreset = { preset: optionsOrPreset };
		}
		if (typeof optionsOrPreset === "object" && optionsOrPreset !== null) {
			// We use this method of shallow cloning this object to include
			// properties in the prototype chain
			/** @type {Partial<NormalizedStatsOptions>} */
			const options = {};
			for (const key in optionsOrPreset) {
				options[key] = optionsOrPreset[key];
			}
			if (options.preset !== undefined) {
				this.hooks.statsPreset.for(options.preset).call(options, context);
			}
			this.hooks.statsNormalize.call(options, context);
			return /** @type {NormalizedStatsOptions} */ (options);
		} else {
			/** @type {Partial<NormalizedStatsOptions>} */
			const options = {};
			this.hooks.statsNormalize.call(options, context);
			return /** @type {NormalizedStatsOptions} */ (options);
		}
	}

	createStatsFactory(options) {
		const statsFactory = new StatsFactory();
		this.hooks.statsFactory.call(statsFactory, options);
		return statsFactory;
	}

	createStatsPrinter(options) {
		const statsPrinter = new StatsPrinter();
		this.hooks.statsPrinter.call(statsPrinter, options);
		return statsPrinter;
	}

	/**
	 * @param {string} name cache name
	 * @returns {CacheFacade} the cache facade instance
	 */
	getCache(name) {
		return this.compiler.getCache(name);
	}

	/**
	 * @param {string | (function(): string)} name name of the logger, or function called once to get the logger name
	 * @returns {Logger} a logger with that name
	 */
	getLogger(name) {
		if (!name) {
			throw new TypeError("Compilation.getLogger(name) called without a name");
		}
		/** @type {LogEntry[] | undefined} */
		let logEntries;
		return new Logger(
			(type, args) => {
				if (typeof name === "function") {
					name = name();
					if (!name) {
						throw new TypeError(
							"Compilation.getLogger(name) called with a function not returning a name"
						);
					}
				}
				let trace;
				switch (type) {
					case LogType.warn:
					case LogType.error:
					case LogType.trace:
						trace = ErrorHelpers.cutOffLoaderExecution(new Error("Trace").stack)
							.split("\n")
							.slice(3);
						break;
				}
				/** @type {LogEntry} */
				const logEntry = {
					time: Date.now(),
					type,
					args,
					trace
				};
				if (this.hooks.log.call(name, logEntry) === undefined) {
					if (logEntry.type === LogType.profileEnd) {
						// eslint-disable-next-line node/no-unsupported-features/node-builtins
						if (typeof console.profileEnd === "function") {
							// eslint-disable-next-line node/no-unsupported-features/node-builtins
							console.profileEnd(`[${name}] ${logEntry.args[0]}`);
						}
					}
					if (logEntries === undefined) {
						logEntries = this.logging.get(name);
						if (logEntries === undefined) {
							logEntries = [];
							this.logging.set(name, logEntries);
						}
					}
					logEntries.push(logEntry);
					if (logEntry.type === LogType.profile) {
						// eslint-disable-next-line node/no-unsupported-features/node-builtins
						if (typeof console.profile === "function") {
							// eslint-disable-next-line node/no-unsupported-features/node-builtins
							console.profile(`[${name}] ${logEntry.args[0]}`);
						}
					}
				}
			},
			childName => {
				if (typeof name === "function") {
					if (typeof childName === "function") {
						return this.getLogger(() => {
							if (typeof name === "function") {
								name = name();
								if (!name) {
									throw new TypeError(
										"Compilation.getLogger(name) called with a function not returning a name"
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
						return this.getLogger(() => {
							if (typeof name === "function") {
								name = name();
								if (!name) {
									throw new TypeError(
										"Compilation.getLogger(name) called with a function not returning a name"
									);
								}
							}
							return `${name}/${childName}`;
						});
					}
				} else {
					if (typeof childName === "function") {
						return this.getLogger(() => {
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
						return this.getLogger(`${name}/${childName}`);
					}
				}
			}
		);
	}

	/**
	 * 添加模块到编译（公开接口）
	 *
	 * 【作用】
	 * 将模块添加到模块队列
	 *
	 * 【队列系统】
	 * addModuleQueue 确保模块按顺序处理，自动去重
	 *
	 * @param {Module} module - 要添加的模块
	 * @param {ModuleCallback} callback - 回调（返回最终使用的模块）
	 * @returns {void}
	 */
	addModule(module, callback) {
		// 添加到队列（队列会调用 _addModule）
		this.addModuleQueue.add(module, callback);
	}

	/**
	 * 添加模块到编译（内部实现，去重的核心）⭐⭐⭐
	 *
	 * 【作用】
	 * 将模块添加到编译，如果模块已存在则复用
	 *
	 * 【去重机制】⭐⭐
	 * 多个依赖可能指向同一个模块：
	 * ```
	 * // a.js
	 * import './common.js';
	 *
	 * // b.js
	 * import './common.js';
	 *
	 * 结果：
	 * - 创建 2 个依赖对象
	 * - 但只创建 1 个 common.js 模块
	 * - a 和 b 的依赖都指向同一个模块实例
	 * ```
	 *
	 * 【执行流程】
	 * 1. 通过 identifier 查找是否已存在
	 * 2. 如果已存在 → 直接返回现有模块
	 * 3. 如果不存在：
	 *    - 尝试从缓存恢复
	 *    - 更新缓存模块（如果有）
	 *    - 添加到 modules 集合
	 *
	 * 【缓存恢复】⭐
	 * - 从持久化缓存加载模块
	 * - 恢复 buildInfo 和 buildMeta
	 * - 避免重新构建
	 *
	 * @param {Module} module - 要添加的模块（新创建的）
	 * @param {ModuleCallback} callback - 回调（返回实际使用的模块）
	 * @returns {void}
	 */
	_addModule(module, callback) {
		// ===== 步骤1: 获取模块的唯一标识符 =====
		/**
		 * identifier 是模块的唯一标识
		 *
		 * 【格式】
		 * - NormalModule: 'javascript/auto|/path/to/file.js'
		 * - 包含类型和路径信息
		 *
		 * 【用途】
		 * 用于检查模块是否已存在（去重）
		 */
		const identifier = module.identifier();

		// ===== 步骤2: 检查模块是否已添加（去重）⭐⭐ =====
		/**
		 * _modules 是 Map<identifier, Module>
		 * 存储所有已添加的模块
		 *
		 * 【去重原理】
		 * - a.js import './c.js' → 创建 c 模块
		 * - b.js import './c.js' → 查找到已存在的 c 模块
		 * - 返回同一个模块实例
		 */
		const alreadyAddedModule = this._modules.get(identifier);

		if (alreadyAddedModule) {
			// ⭐ 模块已存在，直接返回现有模块
			// 不会重复添加或构建
			return callback(null, alreadyAddedModule);
		}

		// ===== 步骤3: 模块不存在，准备添加 =====

		// 获取性能分析对象（如果启用）
		const currentProfile = this.profile
			? this.moduleGraph.getProfile(module)
			: undefined;

		// 标记缓存恢复开始
		if (currentProfile !== undefined) {
			currentProfile.markRestoringStart();
		}

		// ===== 步骤4: 尝试从持久化缓存恢复模块 ⭐⭐ =====
		/**
		 * _modulesCache 是持久化缓存
		 *
		 * 【作用】
		 * 如果模块之前构建过并缓存了，可以恢复：
		 * - buildInfo（构建信息）
		 * - buildMeta（构建元数据）
		 * - dependencies（依赖列表）
		 *
		 * 【好处】
		 * 避免重新读取文件、执行 loader、解析 AST
		 * 大幅提升重复构建速度（10-100 倍）
		 */
		this._modulesCache.get(identifier, null, (err, cacheModule) => {
			// 处理缓存读取错误
			if (err) return callback(new ModuleRestoreError(module, err));

			// 标记缓存恢复结束，集成开始
			if (currentProfile !== undefined) {
				currentProfile.markRestoringEnd();
				currentProfile.markIntegrationStart();
			}

			// ===== 步骤5: 合并缓存模块和新模块 ⭐ =====
			if (cacheModule) {
				/**
				 * 缓存中有模块！
				 *
				 * 【合并策略】
				 * - cacheModule: 从缓存恢复的模块（有构建数据）
				 * - module: 新创建的模块（有最新的工厂数据）
				 *
				 * updateCacheModule 会：
				 * 1. 将新模块的工厂数据更新到缓存模块
				 * 2. 保留缓存模块的构建数据
				 * 3. 返回合并后的缓存模块
				 *
				 * 【结果】
				 * 使用缓存模块（包含历史构建数据）
				 */
				cacheModule.updateCacheModule(module);

				// 使用缓存模块替换新模块
				module = cacheModule;
			}

			// ===== 步骤6: 添加模块到集合 ⭐ =====

			// 添加到内部模块映射（通过标识符索引）
			this._modules.set(identifier, module);

			// 添加到模块集合（Set，用于遍历所有模块）
			this.modules.add(module);

			// ===== 步骤7: 向后兼容处理 =====
			// 为模块设置 moduleGraph 引用（webpack 5 之前需要）
			if (this._backCompat)
				ModuleGraph.setModuleGraphForModule(module, this.moduleGraph);

			// 标记集成结束
			if (currentProfile !== undefined) {
				currentProfile.markIntegrationEnd();
			}

			// ===== 步骤8: 返回模块 =====
			/**
			 * 返回的模块可能是：
			 * - 新创建的模块（无缓存）
			 * - 缓存恢复的模块（有缓存）
			 *
			 * 调用者会使用这个返回的模块继续后续处理
			 */
			callback(null, module);
		});
	}

	/**
	 * Fetches a module from a compilation by its identifier
	 * @param {Module} module the module provided
	 * @returns {Module} the module requested
	 */
	getModule(module) {
		const identifier = module.identifier();
		return this._modules.get(identifier);
	}

	/**
	 * Attempts to search for a module by its identifier
	 * @param {string} identifier identifier (usually path) for module
	 * @returns {Module|undefined} attempt to search for module and return it, else undefined
	 */
	findModule(identifier) {
		return this._modules.get(identifier);
	}

	/**
	 * 构建模块（公开接口）
	 *
	 * 【作用】
	 * 将模块添加到构建队列，异步构建
	 *
	 * 【队列系统】⭐
	 * buildQueue 是一个异步队列，允许：
	 * - 并行构建多个模块
	 * - 控制并发数
	 * - 自动去重（相同模块只构建一次）
	 *
	 * 实际的构建工作在 _buildModule 中完成
	 *
	 * @param {Module} module - 要构建的模块
	 * @param {ModuleCallback} callback - 完成回调
	 * @returns {void}
	 */
	buildModule(module, callback) {
		// 添加到构建队列（队列会调用 _buildModule）
		this.buildQueue.add(module, callback);
	}

	/**
	 * 构建模块（内部实现）⭐⭐⭐
	 *
	 * 【作用】
	 * 实际执行模块构建的方法
	 *
	 * 【执行流程】
	 * ```
	 * _buildModule
	 *   ├─ module.needBuild()（检查是否需要构建）⭐
	 *   │   ├─ 检查文件时间戳
	 *   │   ├─ 检查缓存
	 *   │   └─ 返回 true/false
	 *   ├─ 如果不需要构建：
	 *   │   └─ 触发 stillValidModule 钩子，直接返回
	 *   ├─ 如果需要构建：
	 *   │   ├─ 触发 buildModule 钩子
	 *   │   ├─ module.build()（核心构建）⭐⭐⭐
	 *   │   │   ├─ 执行 loader
	 *   │   │   ├─ 解析 AST
	 *   │   │   └─ 收集依赖
	 *   │   ├─ 缓存模块（_modulesCache.store）
	 *   │   └─ 触发 succeedModule 钩子
	 *   └─ 完成
	 * ```
	 *
	 * 【增量构建】⭐⭐
	 * needBuild() 检查是否需要重新构建：
	 * - 检查源文件时间戳
	 * - 检查依赖文件时间戳
	 * - 检查 buildInfo.hash
	 *
	 * 如果都未变化，跳过构建，复用缓存
	 * 这是 watch 模式快速的关键！
	 *
	 * 【性能分析】
	 * 如果启用 profile，会记录：
	 * - 构建开始时间
	 * - 构建结束时间
	 * - 缓存存储时间
	 *
	 * @param {Module} module - 要构建的模块
	 * @param {ModuleCallback} callback - 完成回调
	 * @returns {void}
	 */
	_buildModule(module, callback) {
		// 获取性能分析对象（如果启用）
		const currentProfile = this.profile
			? this.moduleGraph.getProfile(module)
			: undefined;

		// 标记构建开始
		if (currentProfile !== undefined) {
			currentProfile.markBuildingStart();
		}

		// ===== 步骤1: 检查是否需要构建 ⭐⭐ =====
		/**
		 * needBuild 检查模块是否需要重新构建
		 *
		 * 【检查内容】
		 * 1. 文件时间戳是否变化
		 * 2. 依赖文件是否变化
		 * 3. 构建配置是否变化
		 * 4. 缓存是否有效
		 *
		 * 【增量构建的关键】
		 * 这个检查让 watch 模式只重建变化的模块
		 * 大幅提升重新编译速度（10-100 倍）
		 */
		module.needBuild(
			{
				compilation: this,
				fileSystemInfo: this.fileSystemInfo,
				valueCacheVersions: this.valueCacheVersions
			},
			(err, needBuild) => {
				if (err) return callback(err);

				// 不需要构建（缓存有效）
				if (!needBuild) {
					if (currentProfile !== undefined) {
						currentProfile.markBuildingEnd();
					}
					// 触发 stillValidModule 钩子（模块仍然有效）
					this.hooks.stillValidModule.call(module);
					return callback();
				}

				// ===== 步骤2: 需要构建，开始构建流程 ⭐⭐⭐ =====

				// 触发 buildModule 钩子（模块开始构建）
				this.hooks.buildModule.call(module);

				// 添加到已构建模块集合
				this.builtModules.add(module);

				// ===== 步骤3: 调用模块的 build 方法 ⭐⭐⭐ =====
				/**
				 * module.build() 是模块构建的核心：
				 * 1. 读取源文件
				 * 2. 执行 loader 链
				 * 3. 解析 AST
				 * 4. 收集依赖
				 *
				 * 这是最耗时的步骤（占构建时间 50-70%）
				 */
				module.build(
					this.options,                                      // webpack 选项
					this,                                              // compilation 实例
					this.resolverFactory.get("normal", module.resolveOptions),  // 解析器
					this.inputFileSystem,                              // 文件系统
					err => {
						// 构建完成

						if (currentProfile !== undefined) {
							currentProfile.markBuildingEnd();
						}

						// 处理构建错误
						if (err) {
							this.hooks.failedModule.call(module, err);
							return callback(err);
						}

						// ===== 步骤4: 缓存模块 ⭐ =====
						if (currentProfile !== undefined) {
							currentProfile.markStoringStart();
						}

						/**
						 * 将模块存储到缓存
						 *
						 * 【缓存内容】
						 * - 模块的 buildInfo
						 * - 模块的 buildMeta
						 * - 模块的依赖列表
						 * - 等等...
						 *
						 * 【用途】
						 * 下次构建时，如果文件未变化，直接从缓存恢复
						 */
						this._modulesCache.store(module.identifier(), null, module, err => {
							if (currentProfile !== undefined) {
								currentProfile.markStoringEnd();
							}

							if (err) {
								this.hooks.failedModule.call(module, err);
								return callback(new ModuleStoreError(module, err));
							}

							// ===== 步骤5: 触发 succeedModule 钩子 =====
							// 模块构建成功
							this.hooks.succeedModule.call(module);

							return callback();
						});
					}
				);
			}
		);
	}

	/**
	 * 处理模块的依赖（递归构建的关键！）⭐⭐⭐
	 *
	 * 【作用】
	 * 处理模块构建后收集到的所有依赖，递归构建依赖图
	 *
	 * 【执行流程】
	 * ```
	 * processModuleDependencies(module)
	 *   ↓
	 * 添加到 processDependenciesQueue（队列）
	 *   ↓
	 * 队列调用 _processModuleDependencies
	 *   ↓
	 * 遍历 module.dependencies
	 *   ├─ dependency1 → handleModuleCreation() ← 递归！
	 *   ├─ dependency2 → handleModuleCreation() ← 递归！
	 *   └─ dependency3 → handleModuleCreation() ← 递归！
	 *   ↓
	 * 所有依赖都处理完成
	 * ```
	 *
	 * 【递归构建】⭐⭐⭐
	 * 这是依赖图递归构建的核心：
	 *
	 * 1. module.build() 收集依赖 → module.dependencies
	 * 2. processModuleDependencies() 处理依赖
	 * 3. 对每个依赖调用 handleModuleCreation()
	 * 4. handleModuleCreation() 又会调用 module.build()
	 * 5. 循环往复，直到没有新的依赖
	 *
	 * 【队列系统】
	 * 使用 processDependenciesQueue 异步处理：
	 * - 并行处理多个模块的依赖
	 * - 自动去重
	 * - 避免堆栈溢出
	 *
	 * @param {Module} module - 要处理依赖的模块
	 * @param {ModuleCallback} callback - 完成回调
	 * @returns {void}
	 */
	processModuleDependencies(module, callback) {
		// 添加到依赖处理队列
		// 队列会调用 _processModuleDependencies 实际处理
		this.processDependenciesQueue.add(module, callback);
	}

	/**
	 * 非递归处理模块依赖
	 *
	 * 【作用】
	 * 只设置依赖的父级关系，不递归构建依赖模块
	 *
	 * 【使用场景】
	 * 特殊情况下不需要递归构建：
	 * - 预取模块（PrefetchPlugin）
	 * - 某些优化场景
	 *
	 * 【与 processModuleDependencies 的区别】
	 * - processModuleDependencies: 递归构建所有依赖
	 * - processModuleDependenciesNonRecursive: 只记录关系，不构建
	 *
	 * 【执行内容】
	 * 遍历模块的依赖和代码块，设置父级引用：
	 * - dependency._parentModule = module
	 * - dependency._parentBlock = block
	 * - dependency._parentBlockIndex = index
	 *
	 * @param {Module} module - 要处理的模块
	 * @returns {void}
	 */
	processModuleDependenciesNonRecursive(module) {
		/**
		 * 递归处理依赖块
		 *
		 * 【作用】
		 * 设置每个依赖的父级引用
		 * 支持嵌套的代码块（如异步依赖块）
		 */
		const processDependenciesBlock = block => {
			// 处理块的直接依赖
			if (block.dependencies) {
				let i = 0;
				for (const dep of block.dependencies) {
					// 设置依赖的父级（block、module、index）
					this.moduleGraph.setParents(dep, block, module, i++);
				}
			}

			// 递归处理嵌套的代码块
			if (block.blocks) {
				for (const b of block.blocks) processDependenciesBlock(b);
			}
		};

		// 从模块根块开始处理
		processDependenciesBlock(module);
	}

	/**
	 * 处理模块依赖（内部实现，递归构建的核心）⭐⭐⭐
	 *
	 * 【作用】
	 * 遍历模块的所有依赖，对每个依赖调用 handleModuleCreation
	 * 这是依赖图递归构建的关键方法！
	 *
	 * 【执行流程】
	 * 1. 遍历模块的依赖和代码块
	 * 2. 按工厂和资源分组依赖（优化性能）
	 * 3. 对每组依赖调用 handleModuleCreation
	 * 4. 等待所有依赖处理完成
	 *
	 * 【性能优化】⭐⭐
	 * - 依赖分组：减少工厂查找次数
	 * - 缓存检查：复用已构建的模块
	 * - 并行处理：同时处理多个依赖
	 *
	 * @param {Module} module - 要处理依赖的模块
	 * @param {ModuleCallback} callback - 完成回调
	 * @returns {void}
	 */
	_processModuleDependencies(module, callback) {
		// ===== 数据结构准备 =====

		/**
		 * sortedDependencies: 排序后的依赖列表
		 *
		 * 【结构】
		 * [
		 *   {
		 *     factory: ModuleFactory,    // 模块工厂
		 *     dependencies: Dependency[], // 依赖列表
		 *     context: string,            // 上下文路径
		 *     originModule: Module        // 源模块
		 *   },
		 *   ...
		 * ]
		 *
		 * 【作用】
		 * 将依赖按工厂和资源分组，减少重复查找
		 * 性能优化：相同工厂的依赖一起处理
		 *
		 * @type {Array<{factory: ModuleFactory, dependencies: Dependency[], context: string|undefined, originModule: Module|null}>}
		 */
		const sortedDependencies = [];

		/**
		 * currentBlock: 当前处理的依赖块
		 *
		 * 【作用】
		 * 遍历模块的依赖块时，记录当前块
		 *
		 * @type {DependenciesBlock}
		 */
		let currentBlock;

		// ===== 缓存变量（性能优化）⭐⭐ =====
		/**
		 * 这些变量用于缓存上次查找的结果
		 * 避免重复的 Map 查找操作
		 *
		 * 【优化原理】
		 * 相邻的依赖通常使用相同的工厂和资源
		 * 缓存上次的查找结果，直接复用
		 */

		/**
		 * dependencies: 依赖映射
		 * 结构：Map<工厂, Map<资源标识, 依赖列表>>
		 * @type {Map<ModuleFactory, Map<string, Dependency[]>>}
		 */
		let dependencies;

		/**
		 * factoryCacheKey: 缓存的工厂构造函数
		 * @type {DepConstructor}
		 */
		let factoryCacheKey;

		/**
		 * factoryCacheKey2: 缓存的工厂实例
		 * @type {ModuleFactory}
		 */
		let factoryCacheKey2;

		/**
		 * factoryCacheValue: 缓存的工厂对应的 Map
		 * @type {Map<string, Dependency[]>}
		 */
		let factoryCacheValue;

		/**
		 * listCacheKey1: 缓存的类别
		 * @type {string}
		 */
		let listCacheKey1;

		/**
		 * listCacheKey2: 缓存的资源标识
		 * @type {string}
		 */
		let listCacheKey2;

		/**
		 * listCacheValue: 缓存的依赖列表
		 * @type {Dependency[]}
		 */
		let listCacheValue;

		// ===== 进度计数器 =====
		/**
		 * inProgressSorting: 正在进行的排序任务数
		 *
		 * 【作用】
		 * 跟踪依赖排序的进度
		 * 初始值 1 是为了包括主任务本身
		 */
		let inProgressSorting = 1;

		/**
		 * inProgressTransitive: 正在进行的传递任务数
		 *
		 * 【作用】
		 * 跟踪 handleModuleCreation 的进度
		 * 所有任务完成时（计数归 0），触发回调
		 */
		let inProgressTransitive = 1;

		/**
		 * 依赖排序完成回调
		 *
		 * 【触发时机】
		 * 所有依赖都已遍历、分组、排序完成
		 *
		 * 【执行内容】
		 * 1. 检查是否有依赖需要处理
		 * 2. 增加队列并行度
		 * 3. 对每个分组调用 handleModuleCreation（递归！）
		 * 4. 等待所有任务完成
		 */
		const onDependenciesSorted = err => {
			// 如果排序过程出错，直接返回
			if (err) return callback(err);

			// ===== 提前退出优化 =====
			// 如果没有依赖需要处理，直接返回
			// 避免不必要的并行度调整
			if (sortedDependencies.length === 0 && inProgressTransitive === 1) {
				return callback();
			}

			// ===== 增加队列并行度 ⭐ =====
			/**
			 * 为什么需要增加并行度？
			 *
			 * 因为我们即将嵌套调用 handleModuleCreation
			 * 这些调用也会使用 processDependenciesQueue
			 * 需要允许更多的并行任务，避免死锁
			 */
			this.processDependenciesQueue.increaseParallelism();

			// ===== 处理所有排序后的依赖 ⭐⭐⭐ =====
			/**
			 * 遍历排序后的依赖组
			 * 对每组调用 handleModuleCreation
			 *
			 * 【并行处理】
			 * 这些 handleModuleCreation 调用会并行执行
			 * 通过计数器跟踪完成情况
			 */
			for (const item of sortedDependencies) {
				// 增加任务计数
				inProgressTransitive++;

				// ⭐⭐⭐ 递归调用 handleModuleCreation
				/**
				 * item 包含：
				 * - factory: 模块工厂
				 * - dependencies: 依赖列表（可能有多个依赖）
				 * - context: 上下文路径
				 * - originModule: 源模块（就是当前的 module）
				 *
				 * handleModuleCreation 会：
				 * 1. 创建依赖的模块
				 * 2. 构建依赖的模块
				 * 3. 递归处理依赖的依赖
				 */
				this.handleModuleCreation(item, err => {
					// ===== 错误处理（避免内存泄漏）⭐ =====
					/**
					 * V8 引擎的 Error 对象会保持对堆栈上函数的引用
					 * 这些闭包引用了 Compilation 对象
					 * 可能导致内存泄漏
					 *
					 * 解决：重新赋值 err.stack 切断引用链
					 */
					if (err && this.bail) {
						// bail 模式：遇到错误立即停止
						if (inProgressTransitive <= 0) return;

						// 设置为 -1 标记已失败，防止重复调用回调
						inProgressTransitive = -1;

						// 重新赋值 err.stack 切断闭包引用（避免内存泄漏）
						// eslint-disable-next-line no-self-assign
						err.stack = err.stack;

						// 触发完成回调
						onTransitiveTasksFinished(err);
						return;
					}

					// ===== 任务完成计数 =====
					// 减少任务计数，如果归 0 表示所有任务完成
					if (--inProgressTransitive === 0) onTransitiveTasksFinished();
				});
			}

			// ===== 主任务完成 =====
			// 减少主任务的计数（初始值 1）
			// 如果此时所有子任务也完成了，触发回调
			if (--inProgressTransitive === 0) onTransitiveTasksFinished();
		};

		/**
		 * 所有传递任务完成回调
		 *
		 * 【触发时机】
		 * inProgressTransitive 归 0 时，表示所有依赖都已处理完成
		 *
		 * 【执行内容】
		 * 1. 减少队列并行度（恢复原状）
		 * 2. 调用用户回调
		 */
		const onTransitiveTasksFinished = err => {
			// 如果有错误，直接返回
			if (err) return callback(err);

			// ===== 恢复队列并行度 =====
			// 之前增加了并行度，现在恢复
			this.processDependenciesQueue.decreaseParallelism();

			// 所有依赖都已处理完成，调用回调
			return callback();
		};

		/**
		 * 处理单个依赖
		 *
		 * 【作用】
		 * 对每个依赖执行：
		 * 1. 设置父级引用
		 * 2. 检查不安全缓存
		 * 3. 决定是解析还是复用缓存
		 *
		 * 【不安全缓存】⭐⭐
		 * webpack 有两种缓存：
		 * - 安全缓存：通过 hash 验证
		 * - 不安全缓存：假设模块不变，直接复用
		 *
		 * 不安全缓存更快，但可能不准确
		 *
		 * @param {Dependency} dep - 依赖对象
		 * @param {number} index - 依赖在块中的索引
		 * @returns {void}
		 */
		const processDependency = (dep, index) => {
			// ===== 步骤1: 设置依赖的父级引用 =====
			/**
			 * 记录依赖属于哪个块、哪个模块、哪个位置
			 *
			 * 【设置内容】
			 * - dep._parentBlock = currentBlock
			 * - dep._parentModule = module
			 * - dep._parentBlockIndex = index
			 *
			 * 【用途】
			 * - 错误报告：显示依赖来自哪里
			 * - 依赖遍历：从依赖找到父模块
			 */
			this.moduleGraph.setParents(dep, currentBlock, module, index);

			// ===== 步骤2: 检查不安全缓存 ⭐⭐ =====
			if (this._unsafeCache) {
				try {
					// 尝试从不安全缓存获取模块
					const unsafeCachedModule = unsafeCacheDependencies.get(dep);

					// null 表示依赖已处理过，跳过
					if (unsafeCachedModule === null) return;

					// undefined 表示缓存中没有，需要解析
					if (unsafeCachedModule !== undefined) {
						// ===== 缓存命中！检查模块是否已恢复 =====

						// 情况1：模块已经恢复到编译中
						if (
							this._restoredUnsafeCacheModuleEntries.has(unsafeCachedModule)
						) {
							// 直接使用已恢复的模块
							this._handleExistingModuleFromUnsafeCache(
								module,        // 源模块
								dep,           // 依赖
								unsafeCachedModule  // 缓存的模块
							);
							return;
						}

						// 情况2：模块还未恢复，尝试通过标识符查找
						const identifier = unsafeCachedModule.identifier();
						const cachedModule =
							this._restoredUnsafeCacheEntries.get(identifier);

						if (cachedModule !== undefined) {
							// 找到了恢复的模块（可能是同一个模块的新实例）

							// 更新不安全缓存映射到新模块
							unsafeCacheDependencies.set(dep, cachedModule);

							// 使用恢复的模块
							this._handleExistingModuleFromUnsafeCache(
								module,
								dep,
								cachedModule
							);
							return;
						}
						// 情况3：模块未恢复，需要从持久化缓存加载

						// 增加排序任务计数（异步操作）
						inProgressSorting++;

						// ===== 从持久化缓存获取模块 ⭐ =====
						/**
						 * _modulesCache 是持久化缓存
						 * 存储在文件系统或内存中
						 */
						this._modulesCache.get(identifier, null, (err, cachedModule) => {
							// 处理缓存读取错误
							if (err) {
								if (inProgressSorting <= 0) return;
								inProgressSorting = -1;  // 标记失败
								onDependenciesSorted(err);
								return;
							}

							try {
								// ===== 检查模块是否需要恢复 =====
								if (!this._restoredUnsafeCacheEntries.has(identifier)) {
									// 模块还未恢复，需要从缓存数据恢复

									// 获取缓存的模块数据
									const data = unsafeCacheData.get(cachedModule);

									if (data === undefined) {
										// 没有缓存数据，需要正常解析
										processDependencyForResolving(dep);
										if (--inProgressSorting === 0) onDependenciesSorted();
										return;
									}

									// 更新缓存映射（如果模块实例变了）
									if (cachedModule !== unsafeCachedModule) {
										unsafeCacheDependencies.set(dep, cachedModule);
									}

									// ===== 恢复模块数据 ⭐⭐ =====
									/**
									 * restoreFromUnsafeCache 恢复模块状态：
									 * - 恢复 buildInfo
									 * - 恢复 buildMeta
									 * - 恢复依赖列表
									 * - 恢复其他缓存数据
									 *
									 * 这样就不需要重新构建模块了
									 */
									cachedModule.restoreFromUnsafeCache(
										data,
										this.params.normalModuleFactory,
										this.params
									);

									// 标记模块已恢复
									this._restoredUnsafeCacheEntries.set(
										identifier,
										cachedModule
									);
									this._restoredUnsafeCacheModuleEntries.add(cachedModule);

									// ===== 检查模块是否已在编译中 =====
									if (!this.modules.has(cachedModule)) {
										// 模块不在编译中，需要添加

										// 增加传递任务计数
										inProgressTransitive++;

										// 处理新恢复的模块
										this._handleNewModuleFromUnsafeCache(
											module,
											dep,
											cachedModule,
											err => {
												if (err) {
													if (inProgressTransitive <= 0) return;
													inProgressTransitive = -1;
													onTransitiveTasksFinished(err);
												}
												if (--inProgressTransitive === 0)
													return onTransitiveTasksFinished();
											}
										);

										// 完成排序任务
										if (--inProgressSorting === 0) onDependenciesSorted();
										return;
									}
								}

								// ===== 模块已存在，直接使用 =====

								// 更新缓存映射（如果需要）
								if (unsafeCachedModule !== cachedModule) {
									unsafeCacheDependencies.set(dep, cachedModule);
								}

								// 处理已存在的模块
								this._handleExistingModuleFromUnsafeCache(
									module,
									dep,
									cachedModule
								);
							} catch (err) {
								// 恢复过程出错
								if (inProgressSorting <= 0) return;
								inProgressSorting = -1;
								onDependenciesSorted(err);
								return;
							}

							// 完成排序任务
							if (--inProgressSorting === 0) onDependenciesSorted();
						});
						return;
					}
				} catch (e) {
					// 不安全缓存处理出错（记录但继续）
					console.error(e);
				}
			}

			// ===== 没有缓存或缓存未命中，正常解析 =====
			processDependencyForResolving(dep);
		};

		/**
		 * 处理依赖以进行解析（依赖分组的核心逻辑）⭐⭐⭐
		 *
		 * 【作用】
		 * 将依赖按工厂和资源分组，减少重复查找
		 * 这是一个高度优化的函数！
		 *
		 * 【分组原理】
		 * 相同工厂 + 相同资源的依赖 → 放到同一组
		 * 例如：
		 * - import './a' 和 import './a' → 同一组（相同资源）
		 * - import './a' 和 import './b' → 不同组（不同资源）
		 *
		 * 【性能优化】⭐⭐
		 * 使用三级缓存避免重复查找：
		 * 1. 检查构造函数是否相同（最快）
		 * 2. 检查工厂是否相同（快）
		 * 3. 使用 Map 查找（慢）
		 *
		 * 【数据结构】
		 * ```
		 * dependencies: Map<工厂, Map<资源标识, 依赖列表>>
		 *
		 * 例如：
		 * {
		 *   NormalModuleFactory => {
		 *     'esm./a.js' => [dep1, dep2],
		 *     'esm./b.js' => [dep3]
		 *   }
		 * }
		 * ```
		 *
		 * @param {Dependency} dep - 依赖对象
		 * @returns {void}
		 */
		const processDependencyForResolving = dep => {
			// ===== 步骤1: 获取资源标识符 =====
			/**
			 * resourceIdent 是依赖的资源标识
			 *
			 * 【示例】
			 * - import './a' → './a'
			 * - require('./b') → './b'
			 * - import('lodash') → 'lodash'
			 *
			 * 【用途】
			 * 相同资源标识的依赖会被分到同一组
			 */
			const resourceIdent = dep.getResourceIdentifier();

			// 如果没有资源标识，跳过（某些特殊依赖）
			if (resourceIdent !== undefined && resourceIdent !== null) {
				// 获取依赖的类别（'esm'、'commonjs'、'amd' 等）
				const category = dep.category;

				// 获取依赖的构造函数（用于查找工厂）
				const constructor = /** @type {DepConstructor} */ (dep.constructor);

				// ===== 三级缓存优化 ⭐⭐⭐ =====

				// ===== 缓存级别1: 检查构造函数（超快路径）=====
				if (factoryCacheKey === constructor) {
					// 构造函数相同！说明工厂也相同

					// 进一步检查资源是否也相同
					if (listCacheKey1 === category && listCacheKey2 === resourceIdent) {
						// ⚡ 超快路径：构造函数、类别、资源都相同
						// 直接添加到缓存的列表
						listCacheValue.push(dep);
						return;
					}
					// 构造函数相同但资源不同，继续处理
				} else {
					// ===== 缓存级别2: 查找工厂 =====

					// 构造函数不同，需要查找对应的工厂
					const factory = this.dependencyFactories.get(constructor);

					if (factory === undefined) {
						// 没有对应的工厂！这是配置错误
						throw new Error(
							`No module factory available for dependency type: ${constructor.name}`
						);
					}

					// 检查工厂是否与上次相同
					if (factoryCacheKey2 === factory) {
						// ⚡ 快路径：工厂相同

						// 更新构造函数缓存
						factoryCacheKey = constructor;

						// 检查资源是否也相同
						if (listCacheKey1 === category && listCacheKey2 === resourceIdent) {
							// 超快路径：工厂和资源都相同
							listCacheValue.push(dep);
							return;
						}
						// 工厂相同但资源不同，继续处理
					} else {
						// ===== 缓存级别3: 慢路径（工厂也不同）=====

						if (factoryCacheKey2 !== undefined) {
							// 保存上一个工厂的缓存
							if (dependencies === undefined) dependencies = new Map();
							dependencies.set(factoryCacheKey2, factoryCacheValue);

							// 尝试获取新工厂的缓存
							factoryCacheValue = dependencies.get(factory);
							if (factoryCacheValue === undefined) {
								// 新工厂，创建新的 Map
								factoryCacheValue = new Map();
							}
						} else {
							// 第一次处理依赖，创建 Map
							factoryCacheValue = new Map();
						}

						// 更新缓存键
						factoryCacheKey = constructor;
						factoryCacheKey2 = factory;
					}
				}

				// ===== 步骤2: 生成缓存键 ⭐ =====
				/**
				 * 缓存键 = 类别 + 资源标识
				 *
				 * 【启发式优化】
				 * 大部分依赖是 ESM（import），所以：
				 * - ESM 依赖：直接使用资源标识（节省内存）
				 * - 其他依赖：拼接类别 + 资源标识
				 *
				 * 这个小优化节省了大量字符串拼接
				 */
				const cacheKey =
					category === esmDependencyCategory
						? resourceIdent                    // ESM：直接用资源标识
						: `${category}${resourceIdent}`;  // 其他：拼接

				// ===== 步骤3: 获取或创建依赖列表 =====
				let list = factoryCacheValue.get(cacheKey);

				if (list === undefined) {
					// 这是新的资源，创建新列表
					factoryCacheValue.set(cacheKey, (list = []));

					// ===== 添加到排序后的依赖列表 ⭐ =====
					/**
					 * sortedDependencies 最终会传递给 handleModuleCreation
					 *
					 * 【结构】
					 * {
					 *   factory: 模块工厂（用于创建模块）
					 *   dependencies: 依赖列表（可能有多个相同资源的依赖）
					 *   context: 上下文路径
					 *   originModule: 源模块
					 * }
					 */
					sortedDependencies.push({
						factory: factoryCacheKey2,     // 模块工厂
						dependencies: list,             // 依赖列表
						context: dep.getContext(),      // 上下文路径
						originModule: module            // 源模块
					});
				}

				// ===== 步骤4: 添加依赖到列表 =====
				list.push(dep);

				// ===== 步骤5: 更新缓存 =====
				// 缓存当前的类别、资源和列表
				// 下一个依赖如果相同，可以直接使用（超快路径）
				listCacheKey1 = category;
				listCacheKey2 = resourceIdent;
				listCacheValue = list;
			}
		};

		// ===== 主循环：遍历所有依赖块 ⭐⭐⭐ =====
		try {
			/**
			 * 使用队列进行广度优先遍历
			 *
			 * 【遍历内容】
			 * 1. 模块的直接依赖
			 * 2. 模块的异步依赖块
			 * 3. 嵌套的依赖块
			 *
			 * @type {DependenciesBlock[]}
			 */
			const queue = [module];  // 初始队列包含模块本身

			// 广度优先遍历所有依赖块
			do {
				// 从队列取出一个块
				const block = queue.pop();

				// ===== 处理块的直接依赖 =====
				if (block.dependencies) {
					// 设置当前块（processDependency 需要）
					currentBlock = block;

					// 遍历块的所有依赖
					let i = 0;
					for (const dep of block.dependencies) {
						// 处理每个依赖（设置父级、检查缓存、分组）
						processDependency(dep, i++);
					}
				}

				// ===== 处理嵌套的依赖块（如异步依赖）=====
				if (block.blocks) {
					// 将所有嵌套块添加到队列
					for (const b of block.blocks) {
						queue.push(b);
					}
				}
			} while (queue.length !== 0);  // 直到队列为空
		} catch (e) {
			// 遍历过程出错（如工厂不存在）
			return callback(e);
		}

		// ===== 所有依赖都已遍历完成 =====
		// 减少排序任务计数（初始值 1）
		// 如果所有异步任务也完成了，触发 onDependenciesSorted
		if (--inProgressSorting === 0) onDependenciesSorted();
	}

	/**
	 * 处理从不安全缓存恢复的新模块
	 *
	 * 【作用】
	 * 当从缓存恢复的模块还不在编译中时：
	 * 1. 建立依赖图连接
	 * 2. 设置引入者
	 * 3. 添加到模块集合
	 * 4. 处理模块的构建和依赖
	 *
	 * 【场景】
	 * 使用不安全缓存时，模块从缓存恢复但还未添加到当前编译
	 *
	 * 【与 _handleExistingModuleFromUnsafeCache 的区别】
	 * - _handleNewModuleFromUnsafeCache: 模块需要添加到编译
	 * - _handleExistingModuleFromUnsafeCache: 模块已在编译中
	 */
	_handleNewModuleFromUnsafeCache(originModule, dependency, module, callback) {
		const moduleGraph = this.moduleGraph;

		// ===== 步骤1: 建立依赖图连接 =====
		// 连接源模块、依赖对象和目标模块
		moduleGraph.setResolvedModule(originModule, dependency, module);

		// ===== 步骤2: 设置引入者 =====
		// 记录是谁第一次引入了这个模块（用于错误报告）
		moduleGraph.setIssuerIfUnset(
			module,
			originModule !== undefined ? originModule : null
		);

		// ===== 步骤3: 添加到模块集合 =====
		// 添加到内部模块映射（通过标识符查找）
		this._modules.set(module.identifier(), module);

		// 添加到模块集合（所有模块）
		this.modules.add(module);

		// 向后兼容：设置模块的 moduleGraph 引用
		if (this._backCompat)
			ModuleGraph.setModuleGraphForModule(module, this.moduleGraph);

		// ===== 步骤4: 处理模块构建和依赖 =====
		/**
		 * 虽然模块从缓存恢复了，但仍需要：
		 * 1. 检查是否需要重新构建（needBuild）
		 * 2. 处理模块的依赖（可能有新的依赖）
		 */
		this._handleModuleBuildAndDependencies(
			originModule,   // 源模块
			module,         // 恢复的模块
			true,           // 递归处理依赖
			callback
		);
	}

	/**
	 * 处理从不安全缓存恢复的已存在模块
	 *
	 * 【作用】
	 * 当从缓存恢复的模块已在编译中时：
	 * 只需要建立新的依赖图连接
	 *
	 * 【场景】
	 * - 模块 A 和模块 B 都依赖模块 C
	 * - 处理 A 时，C 从缓存恢复并添加到编译
	 * - 处理 B 时，C 已存在，只需建立 B → C 的连接
	 *
	 * 【与 _handleNewModuleFromUnsafeCache 的区别】
	 * - New: 需要添加模块、构建、处理依赖
	 * - Existing: 只需建立连接
	 */
	_handleExistingModuleFromUnsafeCache(originModule, dependency, module) {
		const moduleGraph = this.moduleGraph;

		// ===== 只建立依赖图连接 =====
		// 模块已存在，不需要重新添加或构建
		// 只需要建立新的依赖连接即可
		moduleGraph.setResolvedModule(originModule, dependency, module);
	}

	/**
	 * @typedef {Object} HandleModuleCreationOptions
	 * @property {ModuleFactory} factory
	 * @property {Dependency[]} dependencies
	 * @property {Module | null} originModule
	 * @property {Partial<ModuleFactoryCreateDataContextInfo>=} contextInfo
	 * @property {string=} context
	 * @property {boolean=} recursive recurse into dependencies of the created module
	 * @property {boolean=} connectOrigin connect the resolved module with the origin module
	 */

	/**
	 * 处理模块创建（Make 阶段的核心！）⭐⭐⭐
	 *
	 * 【作用】
	 * 这是 Make 阶段最核心的方法，负责：
	 * 1. 创建模块实例（factorizeModule）
	 * 2. 添加模块到编译（addModule）
	 * 3. 建立依赖图连接（setResolvedModule）
	 * 4. 触发模块构建（buildModule）
	 * 5. 递归处理依赖（processModuleDependencies）
	 *
	 * 【执行流程】
	 * ```
	 * handleModuleCreation
	 *   ├─ factorizeModule（创建模块）
	 *   │   ├─ 解析模块路径
	 *   │   ├─ 匹配 loader
	 *   │   └─ new NormalModule()
	 *   ├─ addModule（添加到集合）
	 *   ├─ setResolvedModule（建立图连接）⭐
	 *   └─ _handleModuleBuildAndDependencies
	 *       ├─ buildModule（构建模块）
	 *       │   ├─ 执行 loader
	 *       │   ├─ 解析 AST
	 *       │   └─ 收集依赖
	 *       └─ processModuleDependencies（递归处理依赖）
	 * ```
	 *
	 * 【递归构建】
	 * recursive = true 时，会递归处理模块的依赖
	 * 这是构建完整依赖图的关键
	 *
	 * 【性能分析】
	 * 如果启用性能分析（profile），会记录：
	 * - 模块创建时间
	 * - 模块构建时间
	 * - 依赖解析时间
	 *
	 * @param {HandleModuleCreationOptions} options - 选项对象
	 * @param {ModuleCallback} callback - 完成回调
	 * @returns {void}
	 */
	handleModuleCreation(
		{
			factory,              // 模块工厂（NormalModuleFactory 或 ContextModuleFactory）
			dependencies,         // 依赖列表（可能有多个依赖指向同一个模块）
			originModule,         // 源模块（谁的依赖）
			contextInfo,          // 上下文信息
			context,              // 上下文路径
			recursive = true,     // 是否递归处理依赖（默认 true）
			connectOrigin = recursive  // 是否连接源模块（默认同 recursive）
		},
		callback
	) {
		// 获取模块图引用
		const moduleGraph = this.moduleGraph;

		// 创建性能分析对象（如果启用）
		const currentProfile = this.profile ? new ModuleProfile() : undefined;

		// ===== 步骤1: 创建模块（factorizeModule）⭐⭐⭐ =====
		/**
		 * factorizeModule 负责：
		 * 1. 解析模块路径（./a.js → /absolute/path/to/a.js）
		 * 2. 匹配 loader 规则
		 * 3. 创建模块实例（new NormalModule）
		 *
		 * 这一步不会读取文件内容，只是创建模块对象
		 */
		this.factorizeModule(
			{
				currentProfile,       // 性能分析对象
				factory,              // 模块工厂
				dependencies,         // 依赖列表
				factoryResult: true,  // 返回完整的工厂结果
				originModule,         // 源模块
				contextInfo,          // 上下文信息
				context               // 上下文路径
			},
			(err, factoryResult) => {
				/**
				 * 应用工厂结果的依赖信息
				 *
				 * 【作用】
				 * 记录模块创建过程中访问的文件：
				 * - fileDependencies: 实际读取的文件
				 * - contextDependencies: 访问的目录
				 * - missingDependencies: 尝试但不存在的文件
				 *
				 * 【用途】
				 * watch 模式下，这些文件变化时需要重新编译
				 */
				const applyFactoryResultDependencies = () => {
					const { fileDependencies, contextDependencies, missingDependencies } =
						factoryResult;

					// 添加文件依赖（用于 watch 模式）
					if (fileDependencies) {
						this.fileDependencies.addAll(fileDependencies);
					}

					// 添加目录依赖
					if (contextDependencies) {
						this.contextDependencies.addAll(contextDependencies);
					}

					// 添加缺失的依赖
					if (missingDependencies) {
						this.missingDependencies.addAll(missingDependencies);
					}
				};

				// 处理创建错误
				if (err) {
					// 即使出错，也要记录依赖信息
					if (factoryResult) applyFactoryResultDependencies();

					// 判断是否是可选依赖
					if (dependencies.every(d => d.optional)) {
						// 所有依赖都是可选的，作为警告处理
						this.warnings.push(err);
						return callback();
					} else {
						// 有必需的依赖，作为错误处理
						this.errors.push(err);
						return callback(err);
					}
				}

				// 获取创建的模块
				const newModule = factoryResult.module;

				// 如果没有创建模块（某些情况下工厂可能返回 null）
				if (!newModule) {
					applyFactoryResultDependencies();
					return callback();
				}

				// 设置性能分析信息
				if (currentProfile !== undefined) {
					moduleGraph.setProfile(newModule, currentProfile);
				}

				// ===== 步骤2: 添加模块到编译（addModule）⭐⭐ =====
				/**
				 * addModule 负责：
				 * 1. 检查模块是否已存在
				 * 2. 如果已存在，返回现有模块（去重）
				 * 3. 如果不存在，添加到 compilation.modules
				 *
				 * 【去重机制】⭐
				 * 多个依赖可能指向同一个模块：
				 * - a.js import common.js
				 * - b.js import common.js
				 * 但 common.js 只会创建和构建一次
				 */
				this.addModule(newModule, (err, module) => {
					if (err) {
						// 添加模块失败
						applyFactoryResultDependencies();
						if (!err.module) {
							err.module = module;
						}
						this.errors.push(err);
						return callback(err);
					}

					// ===== 步骤3: 建立依赖图连接 ⭐⭐⭐ =====

					// 分支1: 使用不安全缓存（性能优化）
					if (
						this._unsafeCache &&
						factoryResult.cacheable !== false &&
						/** @type {any} */ (module).restoreFromUnsafeCache &&
						this._unsafeCachePredicate(module)
					) {
						// 模块可以从不安全缓存恢复
						const unsafeCacheableModule =
							/** @type {Module & { restoreFromUnsafeCache: Function }} */ (
								module
							);

						// 为所有依赖建立连接
						for (let i = 0; i < dependencies.length; i++) {
							const dependency = dependencies[i];

							// ⭐ 关键：建立依赖图连接
							moduleGraph.setResolvedModule(
								connectOrigin ? originModule : null,  // 源模块
								dependency,                            // 依赖对象
								unsafeCacheableModule                  // 目标模块
							);

							// 记录到不安全缓存
							unsafeCacheDependencies.set(dependency, unsafeCacheableModule);
						}

						// 缓存模块数据
						if (!unsafeCacheData.has(unsafeCacheableModule)) {
							unsafeCacheData.set(
								unsafeCacheableModule,
								unsafeCacheableModule.getUnsafeCacheData()
							);
						}
					} else {
						// 分支2: 正常流程（不使用不安全缓存）

						// 应用工厂依赖信息
						applyFactoryResultDependencies();

						// 为所有依赖建立连接
						for (let i = 0; i < dependencies.length; i++) {
							const dependency = dependencies[i];

							// ⭐⭐⭐ 最关键的一行！建立依赖图连接
							/**
							 * 这一行代码建立了模块之间的连接：
							 * - originModule: 源模块（谁依赖）
							 * - dependency: 依赖对象（依赖关系）
							 * - module: 目标模块（被依赖）
							 *
							 * 执行后：
							 * - originModule.outgoingConnections.add(connection)
							 * - module.incomingConnections.add(connection)
							 * - dependencyMap.set(dependency, connection)
							 */
							moduleGraph.setResolvedModule(
								connectOrigin ? originModule : null,  // 源模块
								dependency,                            // 依赖对象
								module                                 // 目标模块
							);
						}
					}

					// 设置模块的引入者（issuer）
					// 记录是谁第一次引入了这个模块（用于错误报告）
					moduleGraph.setIssuerIfUnset(
						module,
						originModule !== undefined ? originModule : null
					);

					// 如果返回的模块不是新创建的（已存在的模块）
					// 需要合并性能分析数据
					if (module !== newModule) {
						if (currentProfile !== undefined) {
							const otherProfile = moduleGraph.getProfile(module);
							if (otherProfile !== undefined) {
								// 合并性能数据
								currentProfile.mergeInto(otherProfile);
							} else {
								// 设置性能数据
								moduleGraph.setProfile(module, currentProfile);
							}
						}
					}

					// ===== 步骤4: 处理模块构建和依赖（递归！）⭐⭐⭐ =====
					/**
					 * _handleModuleBuildAndDependencies 负责：
					 * 1. 构建模块（buildModule）
					 * 2. 处理模块的依赖（processModuleDependencies）
					 * 3. 如果 recursive = true，递归处理所有依赖
					 *
					 * 这是递归构建依赖图的关键！
					 */
					this._handleModuleBuildAndDependencies(
						originModule,   // 源模块
						module,         // 当前模块
						recursive,      // 是否递归
						callback        // 完成回调
					);
				});
			}
		);
	}

	/**
	 * 处理模块构建和依赖（递归构建的核心）⭐⭐⭐
	 *
	 * 【作用】
	 * 1. 构建模块（buildModule）
	 * 2. 处理模块的依赖（processModuleDependencies）
	 * 3. 检测构建循环（避免死锁）
	 *
	 * 【执行流程】
	 * ```
	 * _handleModuleBuildAndDependencies
	 *   ├─ 检测构建循环
	 *   ├─ buildModule（构建模块）⭐⭐⭐
	 *   │   ├─ module.build()
	 *   │   │   ├─ loader-runner 执行 loader
	 *   │   │   ├─ parser.parse() 解析 AST
	 *   │   │   └─ 收集依赖到 module.dependencies
	 *   │   └─ 触发 succeedModule 钩子
	 *   └─ processModuleDependencies（处理依赖）⭐⭐⭐
	 *       └─ 对每个依赖递归调用 handleModuleCreation
	 * ```
	 *
	 * 【循环检测】⭐
	 * 当非递归模式下，如果在构建 A 模块时又需要创建 A 模块，
	 * 说明存在构建循环，会导致死锁。
	 *
	 * 【递归 vs 非递归】
	 * - recursive = true: 递归处理依赖（正常流程）
	 * - recursive = false: 不递归处理（特殊场景，如预取）
	 */
	_handleModuleBuildAndDependencies(originModule, module, recursive, callback) {
		// ===== 步骤1: 检测构建循环（防止死锁）⭐ =====
		let creatingModuleDuringBuildSet = undefined;

		// 只在非递归模式下检测循环
		if (!recursive && this.buildQueue.isProcessing(originModule)) {
			// 跟踪在构建 originModule 时创建的模块
			creatingModuleDuringBuildSet =
				this.creatingModuleDuringBuild.get(originModule);

			if (creatingModuleDuringBuildSet === undefined) {
				// 首次创建跟踪集合
				creatingModuleDuringBuildSet = new Set();
				this.creatingModuleDuringBuild.set(
					originModule,
					creatingModuleDuringBuildSet
				);
			}
			// 记录当前模块
			creatingModuleDuringBuildSet.add(module);

			// 检测是否存在循环
			// 如果 module 的构建被阻塞，且阻塞链中包含 originModule
			// 说明存在循环：A 构建时创建 B，B 构建时又创建 A
			const blockReasons = this.creatingModuleDuringBuild.get(module);
			if (blockReasons !== undefined) {
				// 遍历所有阻塞原因
				const set = new Set(blockReasons);
				for (const item of set) {
					const blockReasons = this.creatingModuleDuringBuild.get(item);
					if (blockReasons !== undefined) {
						for (const m of blockReasons) {
							if (m === module) {
								// 检测到循环！抛出错误避免死锁
								return callback(new BuildCycleError(module));
							}
							set.add(m);
						}
					}
				}
			}
		}

		// ===== 步骤2: 构建模块 ⭐⭐⭐ =====
		/**
		 * buildModule 是最核心的构建过程：
		 * 1. 调用 module.build()
		 * 2. 执行 loader 链转换文件
		 * 3. 使用 parser 解析 AST
		 * 4. 收集模块的依赖
		 * 5. 触发 succeedModule 或 failedModule 钩子
		 */
		this.buildModule(module, err => {
			// 清理循环检测记录
			if (creatingModuleDuringBuildSet !== undefined) {
				creatingModuleDuringBuildSet.delete(module);
			}

			// 处理构建错误
			if (err) {
				if (!err.module) {
					err.module = module;
				}
				this.errors.push(err);
				return callback(err);
			}

			// ===== 步骤3: 处理模块依赖 ⭐⭐⭐ =====

			if (!recursive) {
				// 非递归模式：只记录依赖，不立即处理
				this.processModuleDependenciesNonRecursive(module);
				callback(null, module);
				return;
			}

			// 递归模式：处理所有依赖

			// 避免循环依赖导致的死锁
			// 如果该模块的依赖正在被处理，直接返回
			if (this.processDependenciesQueue.isProcessing(module)) {
				return callback(null, module);
			}

			// ⭐⭐⭐ 关键：处理模块的依赖（递归点）
			/**
			 * processModuleDependencies 会：
			 * 1. 遍历 module.dependencies
			 * 2. 对每个依赖调用 handleModuleCreation（递归！）
			 * 3. 递归构建所有依赖模块
			 * 4. 构建完整的依赖图
			 */
			this.processModuleDependencies(module, err => {
				if (err) {
					return callback(err);
				}
				// 模块及其所有依赖都构建完成
				callback(null, module);
			});
		});
	}

	/**
	 * 创建模块（工厂方法调用）⭐⭐⭐
	 *
	 * 【作用】
	 * 调用模块工厂创建模块实例
	 *
	 * 【执行内容】
	 * 1. 准备工厂创建数据
	 * 2. 调用 factory.create()
	 * 3. 处理工厂结果
	 * 4. 收集依赖信息
	 *
	 * 【工厂类型】
	 * - NormalModuleFactory: 创建 NormalModule（最常用）
	 * - ContextModuleFactory: 创建 ContextModule
	 *
	 * @param {FactorizeModuleOptions} options - 选项对象
	 * @param {ModuleOrFactoryResultCallback} callback - 回调
	 * @returns {void}
	 */
	_factorizeModule(
		{
			currentProfile,    // 性能分析对象
			factory,           // 模块工厂
			dependencies,      // 依赖列表
			originModule,      // 源模块
			factoryResult,     // 是否返回完整工厂结果
			contextInfo,       // 上下文信息
			context            // 上下文路径
		},
		callback
	) {
		// ===== 步骤1: 标记工厂开始（性能分析）=====
		if (currentProfile !== undefined) {
			currentProfile.markFactoryStart();
		}

		// ===== 步骤2: 调用工厂创建模块 ⭐⭐⭐ =====
		/**
		 * factory.create() 会：
		 * 1. 解析模块路径（./a.js → /absolute/path/to/a.js）
		 * 2. 匹配 loader 规则
		 * 3. 创建 Module 实例（new NormalModule）
		 *
		 * 【关键】
		 * 这一步只是创建模块对象，不会读取文件或执行 loader
		 * 实际的构建在 buildModule 中进行
		 */
		factory.create(
			{
				// ===== 准备上下文信息 =====
				/**
				 * contextInfo 提供模块创建的上下文
				 *
				 * 【包含内容】
				 * - issuer: 谁引入了这个模块（用于错误报告）
				 * - issuerLayer: 引入者的图层
				 * - compiler: 编译器名称
				 */
				contextInfo: {
					issuer: originModule ? originModule.nameForCondition() : "",
					issuerLayer: originModule ? originModule.layer : null,
					compiler: this.compiler.name,
					...contextInfo  // 合并额外的上下文信息
				},

				// ===== 解析选项 =====
				// 使用源模块的解析选项（如 alias、extensions 等）
				resolveOptions: originModule ? originModule.resolveOptions : undefined,

				// ===== 上下文路径 =====
				/**
				 * context 是解析相对路径的基准路径
				 *
				 * 【优先级】
				 * 1. 明确提供的 context
				 * 2. 源模块的 context
				 * 3. compiler 的 context（项目根目录）
				 */
				context: context
					? context
					: originModule
					? originModule.context
					: this.compiler.context,

				// 依赖列表
				dependencies: dependencies
			},
			(err, result) => {
				// ===== 步骤3: 处理工厂结果 =====

				if (result) {
					// ===== 向后兼容处理 =====
					// webpack 5 之前，工厂直接返回模块
					// webpack 5+，工厂返回结果对象 { module, fileDependencies, ... }
					if (result.module === undefined && result instanceof Module) {
						result = {
							module: result
						};
					}

					// ===== 收集依赖信息 ⭐ =====
					if (!factoryResult) {
						/**
						 * 如果 factoryResult = false，
						 * 需要将工厂收集的依赖添加到编译的依赖集合
						 *
						 * 【依赖类型】
						 * - fileDependencies: 文件依赖（watch 用）
						 * - contextDependencies: 目录依赖（watch 用）
						 * - missingDependencies: 缺失的依赖
						 *
						 * 【用途】
						 * watch 模式下，这些文件变化时需要重新编译
						 */
						const {
							fileDependencies,
							contextDependencies,
							missingDependencies
						} = result;

						// 添加文件依赖
						if (fileDependencies) {
							this.fileDependencies.addAll(fileDependencies);
						}

						// 添加目录依赖
						if (contextDependencies) {
							this.contextDependencies.addAll(contextDependencies);
						}

						// 添加缺失的依赖
						if (missingDependencies) {
							this.missingDependencies.addAll(missingDependencies);
						}
					}
				}

				// ===== 步骤4: 处理错误 =====
				if (err) {
					/**
					 * 工厂创建失败（模块未找到）
					 *
					 * 【常见错误】
					 * - 模块路径不存在
					 * - 解析失败（无法找到模块）
					 * - loader 匹配错误
					 *
					 * 【错误包装】
					 * 创建 ModuleNotFoundError，提供友好的错误信息
					 */
					const notFoundError = new ModuleNotFoundError(
						originModule,  // 谁引入的（用于显示引用链）
						err,           // 原始错误
						dependencies.map(d => d.loc).filter(Boolean)[0]  // 源码位置
					);
					return callback(notFoundError, factoryResult ? result : undefined);
				}

				// ===== 步骤5: 检查结果 =====
				if (!result) {
					// 工厂没有返回结果（某些情况下可以忽略依赖）
					return callback();
				}

				// ===== 步骤6: 标记工厂结束 =====
				if (currentProfile !== undefined) {
					currentProfile.markFactoryEnd();
				}

				// ===== 步骤7: 返回结果 =====
				/**
				 * 根据 factoryResult 标志返回不同内容：
				 * - true: 返回完整的工厂结果（包含依赖信息）
				 * - false: 只返回模块对象
				 */
				callback(null, factoryResult ? result : result.module);
			}
		);
	}

	/**
	 * @param {string} context context string path
	 * @param {Dependency} dependency dependency used to create Module chain
	 * @param {ModuleCallback} callback callback for when module chain is complete
	 * @returns {void} will throw if dependency instance is not a valid Dependency
	 */
	addModuleChain(context, dependency, callback) {
		return this.addModuleTree({ context, dependency }, callback);
	}

	/**
	 * 添加模块树（从依赖开始递归构建）⭐⭐⭐
	 *
	 * 【作用】
	 * 这是递归构建依赖图的核心方法！
	 * 从一个依赖开始，递归构建整个模块树。
	 *
	 * 【执行流程】
	 * 1. 验证依赖对象
	 * 2. 根据依赖类型找到对应的工厂
	 * 3. 调用 handleModuleCreation 创建和构建模块
	 * 4. handleModuleCreation 内部会递归处理该模块的依赖
	 *
	 * 【递归过程】
	 * ```
	 * addModuleTree(entryDep)
	 *   → handleModuleCreation(entryDep)
	 *     → factorizeModule → 创建 entry.js
	 *     → buildModule → 构建 entry.js
	 *       → parser.parse → 解析出依赖 [aDep, bDep]
	 *     → processModuleDependencies
	 *       → handleModuleCreation(aDep) ← 递归
	 *         → factorizeModule → 创建 a.js
	 *         → buildModule → 构建 a.js
	 *           → parser.parse → 解析出依赖 [commonDep]
	 *         → processModuleDependencies
	 *           → handleModuleCreation(commonDep) ← 递归
	 *             ...
	 *       → handleModuleCreation(bDep) ← 递归
	 *         ...
	 * ```
	 *
	 * 【工厂模式】⭐
	 * dependencyFactories 存储依赖类型到工厂的映射：
	 * ```javascript
	 * dependencyFactories = {
	 *   HarmonyImportDependency → NormalModuleFactory,
	 *   CommonJsRequireDependency → NormalModuleFactory,
	 *   ImportDependency → NormalModuleFactory,
	 *   ...
	 * }
	 * ```
	 *
	 * 【Bail 模式】
	 * 如果 bail: true，遇到错误立即停止所有队列
	 *
	 * 【白话解释】
	 * 就像种一棵树：
	 * 1. 从种子（入口依赖）开始
	 * 2. 长出主干（入口模块）
	 * 3. 主干长出枝条（模块的依赖）
	 * 4. 枝条再长出更多枝条（递归）
	 * 5. 直到没有新的枝条（所有依赖都处理完）
	 *
	 * @param {Object} options - 选项
	 * @param {string} options.context - 上下文路径
	 * @param {Dependency} options.dependency - 依赖对象（起点）
	 * @param {Partial<ModuleFactoryCreateDataContextInfo>=} options.contextInfo - 上下文信息
	 * @param {ModuleCallback} callback - 完成回调
	 * @returns {void}
	 */
	addModuleTree({ context, dependency, contextInfo }, callback) {
		// 步骤1: 验证依赖对象
		if (
			typeof dependency !== "object" ||
			dependency === null ||
			!dependency.constructor
		) {
			return callback(
				new WebpackError("Parameter 'dependency' must be a Dependency")
			);
		}

		// 步骤2: 根据依赖类型获取对应的模块工厂
		// 使用依赖的构造函数作为 key
		const Dep = /** @type {DepConstructor} */ (dependency.constructor);
		const moduleFactory = this.dependencyFactories.get(Dep);

		if (!moduleFactory) {
			// 没有对应的工厂，无法处理这种依赖类型
			return callback(
				new WebpackError(
					`No dependency factory available for this dependency type: ${dependency.constructor.name}`
				)
			);
		}

		// 步骤3: 调用 handleModuleCreation 处理模块创建 ⭐⭐⭐
		/**
		 * handleModuleCreation 是递归构建的核心：
		 * 1. factorizeModule: 创建模块实例
		 * 2. addModule: 添加到模块集合
		 * 3. buildModule: 构建模块（执行 loader、解析 AST）
		 * 4. processModuleDependencies: 处理模块的依赖（递归！）
		 */
		this.handleModuleCreation(
			{
				factory: moduleFactory,          // 模块工厂
				dependencies: [dependency],      // 依赖列表
				originModule: null,              // 源模块（入口无源模块）
				contextInfo,                     // 上下文信息
				context                          // 上下文路径
			},
			(err, result) => {
				if (err && this.bail) {
					// Bail 模式：遇到错误立即停止所有队列
					callback(err);
					this.buildQueue.stop();
					this.rebuildQueue.stop();
					this.processDependenciesQueue.stop();
					this.factorizeQueue.stop();
				} else if (!err && result) {
					// 成功：返回创建的模块
					callback(null, result);
				} else {
					// 其他情况
					callback();
				}
			}
		);
	}

	/**
	 * 添加入口模块（Make 阶段的起点！）⭐⭐⭐
	 *
	 * 【作用】
	 * 这是 Make 阶段的入口方法！
	 * 由 EntryPlugin 在 make 钩子中调用。
	 *
	 * 【执行流程】
	 * 1. 规范化入口选项
	 * 2. 添加入口依赖到 entries 集合
	 * 3. 触发 addEntry 钩子
	 * 4. 调用 addModuleTree 开始构建
	 * 5. 触发 succeedEntry 或 failedEntry 钩子
	 *
	 * 【调用链】
	 * ```
	 * compiler.hooks.make
	 *   → EntryPlugin.apply()
	 *   → compilation.addEntry()
	 *   → compilation.addModuleTree()
	 *   → compilation.handleModuleCreation()
	 *   → 开始递归构建依赖图
	 * ```
	 *
	 * 【白话解释】
	 * 就像探险队的出发点：
	 * - context: 出发地点（项目根目录）
	 * - entry: 探险地图（入口依赖）
	 * - options: 探险计划（入口配置）
	 * - callback: 探险完成后的报告
	 *
	 * @param {string} context - 上下文路径（通常是项目根目录）
	 * @param {Dependency} entry - 入口依赖对象
	 * @param {string | EntryOptions} optionsOrName - 入口选项或名称
	 * @param {ModuleCallback} callback - 回调函数
	 * @returns {void}
	 */
	addEntry(context, entry, optionsOrName, callback) {
		// TODO webpack 6 remove
		// 规范化选项（兼容旧版本的字符串参数）
		const options =
			typeof optionsOrName === "object"
				? optionsOrName
				: { name: optionsOrName };

		// 调用内部方法添加入口项
		// target: "dependencies" 表示这是一个入口依赖
		this._addEntryItem(context, entry, "dependencies", options, callback);
	}

	/**
	 * @param {string} context context path for entry
	 * @param {Dependency} dependency dependency that should be followed
	 * @param {EntryOptions} options options
	 * @param {ModuleCallback} callback callback function
	 * @returns {void} returns
	 */
	addInclude(context, dependency, options, callback) {
		this._addEntryItem(
			context,
			dependency,
			"includeDependencies",
			options,
			callback
		);
	}

	/**
	 * 添加入口项（内部方法）⭐⭐
	 *
	 * 【作用】
	 * 处理入口的实际添加逻辑，支持多种入口类型
	 *
	 * 【入口类型】
	 * - dependencies: 普通入口依赖
	 * - includeDependencies: 强制包含的依赖
	 *
	 * 【执行流程】
	 * 1. 获取或创建入口数据对象
	 * 2. 添加依赖到对应的列表
	 * 3. 合并入口选项（处理冲突）
	 * 4. 触发 addEntry 钩子
	 * 5. 调用 addModuleTree 开始构建模块树
	 * 6. 触发成功或失败钩子
	 *
	 * 【入口数据结构】
	 * ```javascript
	 * entryData = {
	 *   dependencies: [entryDep1, entryDep2],      // 入口依赖列表
	 *   includeDependencies: [includeDep1],        // 强制包含的依赖
	 *   options: {
	 *     name: 'main',                            // 入口名称
	 *     runtime: 'runtime',                       // 运行时名称
	 *     dependOn: ['other-entry'],               // 依赖的其他入口
	 *     ...
	 *   }
	 * }
	 * ```
	 *
	 * 【冲突处理】⭐
	 * 如果同一个入口多次调用 addEntry，需要合并选项：
	 * - 相同的值：忽略
	 * - undefined：使用新值
	 * - 不同的值：报错（冲突）
	 *
	 * @param {string} context - 上下文路径
	 * @param {Dependency} entry - 入口依赖
	 * @param {"dependencies" | "includeDependencies"} target - 目标类型
	 * @param {EntryOptions} options - 入口选项
	 * @param {ModuleCallback} callback - 回调函数
	 * @returns {void}
	 */
	_addEntryItem(context, entry, target, options, callback) {
		const { name } = options;

		// 步骤1: 获取或创建入口数据
		// 如果有名称，使用命名入口；否则使用全局入口
		let entryData =
			name !== undefined ? this.entries.get(name) : this.globalEntry;

		if (entryData === undefined) {
			// 首次创建入口数据
			entryData = {
				dependencies: [],              // 入口依赖列表
				includeDependencies: [],       // 强制包含的依赖
				options: {
					name: undefined,
					...options                 // 合并选项
				}
			};
			// 添加当前依赖到对应列表
			entryData[target].push(entry);
			// 保存到 entries Map
			this.entries.set(name, entryData);
		} else {
			// 入口已存在，添加新的依赖
			entryData[target].push(entry);

			// 步骤2: 合并选项（处理冲突）⭐
			for (const key of Object.keys(options)) {
				if (options[key] === undefined) continue;  // 跳过 undefined
				if (entryData.options[key] === options[key]) continue;  // 相同值，跳过

				// 处理数组类型的选项
				if (
					Array.isArray(entryData.options[key]) &&
					Array.isArray(options[key]) &&
					arrayEquals(entryData.options[key], options[key])
				) {
					continue;  // 数组相等，跳过
				}

				if (entryData.options[key] === undefined) {
					// 原来是 undefined，使用新值
					entryData.options[key] = options[key];
				} else {
					// 冲突！两个值都不是 undefined 且不相等
					return callback(
						new WebpackError(
							`Conflicting entry option ${key} = ${entryData.options[key]} vs ${options[key]}`
						)
					);
				}
			}
		}

		// 步骤3: 触发 addEntry 钩子
		// 插件可以在这里监听入口添加
		this.hooks.addEntry.call(entry, options);

		// 步骤4: 添加模块树（开始真正的构建）⭐⭐⭐
		/**
		 * addModuleTree 会：
		 * 1. 创建入口模块（factorizeModule）
		 * 2. 添加模块到 compilation.modules
		 * 3. 构建模块（module.build）
		 * 4. 处理模块的依赖（递归）
		 * 5. 构建完整的依赖图
		 */
		this.addModuleTree(
			{
				context,
				dependency: entry,
				contextInfo: entryData.options.layer
					? { issuerLayer: entryData.options.layer }
					: undefined
			},
			(err, module) => {
				if (err) {
					// 入口添加失败
					this.hooks.failedEntry.call(entry, options, err);
					return callback(err);
				}
				// 入口添加成功
				this.hooks.succeedEntry.call(entry, options, module);
				return callback(null, module);
			}
		);
	}

	/**
	 * @param {Module} module module to be rebuilt
	 * @param {ModuleCallback} callback callback when module finishes rebuilding
	 * @returns {void}
	 */
	rebuildModule(module, callback) {
		this.rebuildQueue.add(module, callback);
	}

	/**
	 * @param {Module} module module to be rebuilt
	 * @param {ModuleCallback} callback callback when module finishes rebuilding
	 * @returns {void}
	 */
	_rebuildModule(module, callback) {
		this.hooks.rebuildModule.call(module);
		const oldDependencies = module.dependencies.slice();
		const oldBlocks = module.blocks.slice();
		module.invalidateBuild();
		this.buildQueue.invalidate(module);
		this.buildModule(module, err => {
			if (err) {
				return this.hooks.finishRebuildingModule.callAsync(module, err2 => {
					if (err2) {
						callback(
							makeWebpackError(err2, "Compilation.hooks.finishRebuildingModule")
						);
						return;
					}
					callback(err);
				});
			}

			this.processDependenciesQueue.invalidate(module);
			this.moduleGraph.unfreeze();
			this.processModuleDependencies(module, err => {
				if (err) return callback(err);
				this.removeReasonsOfDependencyBlock(module, {
					dependencies: oldDependencies,
					blocks: oldBlocks
				});
				this.hooks.finishRebuildingModule.callAsync(module, err2 => {
					if (err2) {
						callback(
							makeWebpackError(err2, "Compilation.hooks.finishRebuildingModule")
						);
						return;
					}
					callback(null, module);
				});
			});
		});
	}

	_computeAffectedModules(modules) {
		const moduleMemCacheCache = this.compiler.moduleMemCaches;
		if (!moduleMemCacheCache) return;
		if (!this.moduleMemCaches) {
			this.moduleMemCaches = new Map();
			this.moduleGraph.setModuleMemCaches(this.moduleMemCaches);
		}
		const { moduleGraph, moduleMemCaches } = this;
		const affectedModules = new Set();
		const infectedModules = new Set();
		let statNew = 0;
		let statChanged = 0;
		let statUnchanged = 0;
		let statReferencesChanged = 0;
		let statWithoutBuild = 0;

		const computeReferences = module => {
			/** @type {WeakMap<Dependency, Module>} */
			let references = undefined;
			for (const connection of moduleGraph.getOutgoingConnections(module)) {
				const d = connection.dependency;
				const m = connection.module;
				if (!d || !m || unsafeCacheDependencies.has(d)) continue;
				if (references === undefined) references = new WeakMap();
				references.set(d, m);
			}
			return references;
		};

		/**
		 * @param {Module} module the module
		 * @param {WeakMap<Dependency, Module>} references references
		 * @returns {boolean} true, when the references differ
		 */
		const compareReferences = (module, references) => {
			if (references === undefined) return true;
			for (const connection of moduleGraph.getOutgoingConnections(module)) {
				const d = connection.dependency;
				if (!d) continue;
				const entry = references.get(d);
				if (entry === undefined) continue;
				if (entry !== connection.module) return false;
			}
			return true;
		};

		const modulesWithoutCache = new Set(modules);
		for (const [module, cachedMemCache] of moduleMemCacheCache) {
			if (modulesWithoutCache.has(module)) {
				const buildInfo = module.buildInfo;
				if (buildInfo) {
					if (cachedMemCache.buildInfo !== buildInfo) {
						// use a new one
						const memCache = new WeakTupleMap();
						moduleMemCaches.set(module, memCache);
						affectedModules.add(module);
						cachedMemCache.buildInfo = buildInfo;
						cachedMemCache.references = computeReferences(module);
						cachedMemCache.memCache = memCache;
						statChanged++;
					} else if (!compareReferences(module, cachedMemCache.references)) {
						// use a new one
						const memCache = new WeakTupleMap();
						moduleMemCaches.set(module, memCache);
						affectedModules.add(module);
						cachedMemCache.references = computeReferences(module);
						cachedMemCache.memCache = memCache;
						statReferencesChanged++;
					} else {
						// keep the old mem cache
						moduleMemCaches.set(module, cachedMemCache.memCache);
						statUnchanged++;
					}
				} else {
					infectedModules.add(module);
					moduleMemCacheCache.delete(module);
					statWithoutBuild++;
				}
				modulesWithoutCache.delete(module);
			} else {
				moduleMemCacheCache.delete(module);
			}
		}

		for (const module of modulesWithoutCache) {
			const buildInfo = module.buildInfo;
			if (buildInfo) {
				// create a new entry
				const memCache = new WeakTupleMap();
				moduleMemCacheCache.set(module, {
					buildInfo,
					references: computeReferences(module),
					memCache
				});
				moduleMemCaches.set(module, memCache);
				affectedModules.add(module);
				statNew++;
			} else {
				infectedModules.add(module);
				statWithoutBuild++;
			}
		}

		const reduceAffectType = connections => {
			let affected = false;
			for (const { dependency } of connections) {
				if (!dependency) continue;
				const type = dependency.couldAffectReferencingModule();
				if (type === Dependency.TRANSITIVE) return Dependency.TRANSITIVE;
				if (type === false) continue;
				affected = true;
			}
			return affected;
		};
		const directOnlyInfectedModules = new Set();
		for (const module of infectedModules) {
			for (const [
				referencingModule,
				connections
			] of moduleGraph.getIncomingConnectionsByOriginModule(module)) {
				if (!referencingModule) continue;
				if (infectedModules.has(referencingModule)) continue;
				const type = reduceAffectType(connections);
				if (!type) continue;
				if (type === true) {
					directOnlyInfectedModules.add(referencingModule);
				} else {
					infectedModules.add(referencingModule);
				}
			}
		}
		for (const module of directOnlyInfectedModules) infectedModules.add(module);
		const directOnlyAffectModules = new Set();
		for (const module of affectedModules) {
			for (const [
				referencingModule,
				connections
			] of moduleGraph.getIncomingConnectionsByOriginModule(module)) {
				if (!referencingModule) continue;
				if (infectedModules.has(referencingModule)) continue;
				if (affectedModules.has(referencingModule)) continue;
				const type = reduceAffectType(connections);
				if (!type) continue;
				if (type === true) {
					directOnlyAffectModules.add(referencingModule);
				} else {
					affectedModules.add(referencingModule);
				}
				const memCache = new WeakTupleMap();
				const cache = moduleMemCacheCache.get(referencingModule);
				cache.memCache = memCache;
				moduleMemCaches.set(referencingModule, memCache);
			}
		}
		for (const module of directOnlyAffectModules) affectedModules.add(module);
		this.logger.log(
			`${Math.round(
				(100 * (affectedModules.size + infectedModules.size)) /
					this.modules.size
			)}% (${affectedModules.size} affected + ${
				infectedModules.size
			} infected of ${
				this.modules.size
			}) modules flagged as affected (${statNew} new modules, ${statChanged} changed, ${statReferencesChanged} references changed, ${statUnchanged} unchanged, ${statWithoutBuild} were not built)`
		);
	}

	_computeAffectedModulesWithChunkGraph() {
		const { moduleMemCaches } = this;
		if (!moduleMemCaches) return;
		const moduleMemCaches2 = (this.moduleMemCaches2 = new Map());
		const { moduleGraph, chunkGraph } = this;
		const key = "memCache2";
		let statUnchanged = 0;
		let statChanged = 0;
		let statNew = 0;
		/**
		 * @param {Module} module module
		 * @returns {{ id: string | number, modules?: Map<Module, string | number | undefined>, blocks?: (string | number)[] }} references
		 */
		const computeReferences = module => {
			const id = chunkGraph.getModuleId(module);
			/** @type {Map<Module, string | number | undefined>} */
			let modules = undefined;
			/** @type {(string | number)[] | undefined} */
			let blocks = undefined;
			const outgoing = moduleGraph.getOutgoingConnectionsByModule(module);
			if (outgoing !== undefined) {
				for (const m of outgoing.keys()) {
					if (!m) continue;
					if (modules === undefined) modules = new Map();
					modules.set(m, chunkGraph.getModuleId(m));
				}
			}
			if (module.blocks.length > 0) {
				blocks = [];
				const queue = Array.from(module.blocks);
				for (const block of queue) {
					const chunkGroup = chunkGraph.getBlockChunkGroup(block);
					if (chunkGroup) {
						for (const chunk of chunkGroup.chunks) {
							blocks.push(chunk.id);
						}
					} else {
						blocks.push(null);
					}
					queue.push.apply(queue, block.blocks);
				}
			}
			return { id, modules, blocks };
		};
		/**
		 * @param {Module} module module
		 * @param {Object} references references
		 * @param {string | number} references.id id
		 * @param {Map<Module, string | number>=} references.modules modules
		 * @param {(string | number)[]=} references.blocks blocks
		 * @returns {boolean} ok?
		 */
		const compareReferences = (module, { id, modules, blocks }) => {
			if (id !== chunkGraph.getModuleId(module)) return false;
			if (modules !== undefined) {
				for (const [module, id] of modules) {
					if (chunkGraph.getModuleId(module) !== id) return false;
				}
			}
			if (blocks !== undefined) {
				const queue = Array.from(module.blocks);
				let i = 0;
				for (const block of queue) {
					const chunkGroup = chunkGraph.getBlockChunkGroup(block);
					if (chunkGroup) {
						for (const chunk of chunkGroup.chunks) {
							if (i >= blocks.length || blocks[i++] !== chunk.id) return false;
						}
					} else {
						if (i >= blocks.length || blocks[i++] !== null) return false;
					}
					queue.push.apply(queue, block.blocks);
				}
				if (i !== blocks.length) return false;
			}
			return true;
		};

		for (const [module, memCache] of moduleMemCaches) {
			/** @type {{ references: { id: string | number, modules?: Map<Module, string | number | undefined>, blocks?: (string | number)[]}, memCache: WeakTupleMap<any[], any> }} */
			const cache = memCache.get(key);
			if (cache === undefined) {
				const memCache2 = new WeakTupleMap();
				memCache.set(key, {
					references: computeReferences(module),
					memCache: memCache2
				});
				moduleMemCaches2.set(module, memCache2);
				statNew++;
			} else if (!compareReferences(module, cache.references)) {
				const memCache = new WeakTupleMap();
				cache.references = computeReferences(module);
				cache.memCache = memCache;
				moduleMemCaches2.set(module, memCache);
				statChanged++;
			} else {
				moduleMemCaches2.set(module, cache.memCache);
				statUnchanged++;
			}
		}

		this.logger.log(
			`${Math.round(
				(100 * statChanged) / (statNew + statChanged + statUnchanged)
			)}% modules flagged as affected by chunk graph (${statNew} new modules, ${statChanged} changed, ${statUnchanged} unchanged)`
		);
	}

	/**
	 * 完成编译（Make 阶段的收尾工作）⭐⭐
	 *
	 * 【作用】
	 * Make 阶段结束时调用，完成收尾工作：
	 * 1. 清理队列
	 * 2. 计算性能数据（如果启用 profile）
	 * 3. 报告错误和警告
	 * 4. 触发 finishModules 钩子
	 *
	 * 【调用时机】
	 * 在 compiler.compile() 中：
	 * ```javascript
	 * compiler.hooks.make.callAsync(compilation, err => {
	 *   compiler.hooks.finishMake.callAsync(compilation, err => {
	 *     compilation.finish(err => {  ← 这里
	 *       compilation.seal(callback);
	 *     });
	 *   });
	 * });
	 * ```
	 *
	 * 【执行流程】
	 * ```
	 * finish()
	 *   ├─ 清理 factorizeQueue
	 *   ├─ 计算性能数据（如果启用）
	 *   │   ├─ 计算并行因子
	 *   │   ├─ 计算各阶段耗时
	 *   │   └─ 生成性能报告
	 *   ├─ 报告模块错误和警告
	 *   ├─ 触发 finishModules 钩子
	 *   └─ 完成
	 * ```
	 *
	 * 【性能分析】⭐
	 *
	 * 如果启用 profile（--profile），会计算：
	 * - buildingParallelismFactor: 构建并行因子
	 * - factoryParallelismFactor: 工厂并行因子
	 * - integrationParallelismFactor: 集成并行因子
	 * - storingParallelismFactor: 存储并行因子
	 *
	 * 【并行因子】
	 * 表示某个时间段内平均有多少个模块在并行处理
	 * 例如：并行因子 = 4，表示平均有 4 个模块同时构建
	 *
	 * 【Make 阶段完成后的状态】
	 * - ✅ 所有模块都已构建
	 * - ✅ ModuleGraph 完全构建
	 * - ✅ 所有依赖都已解析
	 * - ⏭️ 准备进入 Seal 阶段
	 */
	finish(callback) {
		// ===== 步骤1: 清理工厂队列 =====
		// factorizeQueue 在 Make 阶段使用，现在不再需要
		this.factorizeQueue.clear();

		// ===== 步骤2: 计算性能数据（如果启用）⭐ =====
		if (this.profile) {
			this.logger.time("finish module profiles");

			// 并行因子计算器
			const ParallelismFactorCalculator = require("./util/ParallelismFactorCalculator");
			const p = new ParallelismFactorCalculator();

			const moduleGraph = this.moduleGraph;
			const modulesWithProfiles = new Map();

			// 遍历所有模块，收集性能数据
			for (const module of this.modules) {
				const profile = moduleGraph.getProfile(module);
				if (!profile) continue;  // 跳过没有性能数据的模块

				modulesWithProfiles.set(module, profile);

				// 计算构建阶段的并行因子
				p.range(
					profile.buildingStartTime,
					profile.buildingEndTime,
					f => (profile.buildingParallelismFactor = f)
				);

				// 计算工厂阶段的并行因子
				p.range(
					profile.factoryStartTime,
					profile.factoryEndTime,
					f => (profile.factoryParallelismFactor = f)
				);

				// 计算集成阶段的并行因子
				p.range(
					profile.integrationStartTime,
					profile.integrationEndTime,
					f => (profile.integrationParallelismFactor = f)
				);

				// 计算存储阶段的并行因子
				p.range(
					profile.storingStartTime,
					profile.storingEndTime,
					f => (profile.storingParallelismFactor = f)
				);

				// 计算恢复阶段的并行因子
				p.range(
					profile.restoringStartTime,
					profile.restoringEndTime,
					f => (profile.restoringParallelismFactor = f)
				);

				// 计算额外工厂时间的并行因子
				if (profile.additionalFactoryTimes) {
					for (const { start, end } of profile.additionalFactoryTimes) {
						const influence = (end - start) / profile.additionalFactories;
						p.range(
							start,
							end,
							f =>
								(profile.additionalFactoriesParallelismFactor += f * influence)
						);
					}
				}
			}

			// 计算所有并行因子
			p.calculate();

			const logger = this.getLogger("webpack.Compilation.ModuleProfile");
			// Avoid coverage problems due indirect changes
			/* istanbul ignore next */
			const logByValue = (value, msg) => {
				if (value > 1000) {
					logger.error(msg);
				} else if (value > 500) {
					logger.warn(msg);
				} else if (value > 200) {
					logger.info(msg);
				} else if (value > 30) {
					logger.log(msg);
				} else {
					logger.debug(msg);
				}
			};
			const logNormalSummary = (category, getDuration, getParallelism) => {
				let sum = 0;
				let max = 0;
				for (const [module, profile] of modulesWithProfiles) {
					const p = getParallelism(profile);
					const d = getDuration(profile);
					if (d === 0 || p === 0) continue;
					const t = d / p;
					sum += t;
					if (t <= 10) continue;
					logByValue(
						t,
						` | ${Math.round(t)} ms${
							p >= 1.1 ? ` (parallelism ${Math.round(p * 10) / 10})` : ""
						} ${category} > ${module.readableIdentifier(this.requestShortener)}`
					);
					max = Math.max(max, t);
				}
				if (sum <= 10) return;
				logByValue(
					Math.max(sum / 10, max),
					`${Math.round(sum)} ms ${category}`
				);
			};
			const logByLoadersSummary = (category, getDuration, getParallelism) => {
				const map = new Map();
				for (const [module, profile] of modulesWithProfiles) {
					const list = getOrInsert(
						map,
						module.type + "!" + module.identifier().replace(/(!|^)[^!]*$/, ""),
						() => []
					);
					list.push({ module, profile });
				}

				let sum = 0;
				let max = 0;
				for (const [key, modules] of map) {
					let innerSum = 0;
					let innerMax = 0;
					for (const { module, profile } of modules) {
						const p = getParallelism(profile);
						const d = getDuration(profile);
						if (d === 0 || p === 0) continue;
						const t = d / p;
						innerSum += t;
						if (t <= 10) continue;
						logByValue(
							t,
							` |  | ${Math.round(t)} ms${
								p >= 1.1 ? ` (parallelism ${Math.round(p * 10) / 10})` : ""
							} ${category} > ${module.readableIdentifier(
								this.requestShortener
							)}`
						);
						innerMax = Math.max(innerMax, t);
					}
					sum += innerSum;
					if (innerSum <= 10) continue;
					const idx = key.indexOf("!");
					const loaders = key.slice(idx + 1);
					const moduleType = key.slice(0, idx);
					const t = Math.max(innerSum / 10, innerMax);
					logByValue(
						t,
						` | ${Math.round(innerSum)} ms ${category} > ${
							loaders
								? `${
										modules.length
								  } x ${moduleType} with ${this.requestShortener.shorten(
										loaders
								  )}`
								: `${modules.length} x ${moduleType}`
						}`
					);
					max = Math.max(max, t);
				}
				if (sum <= 10) return;
				logByValue(
					Math.max(sum / 10, max),
					`${Math.round(sum)} ms ${category}`
				);
			};
			logNormalSummary(
				"resolve to new modules",
				p => p.factory,
				p => p.factoryParallelismFactor
			);
			logNormalSummary(
				"resolve to existing modules",
				p => p.additionalFactories,
				p => p.additionalFactoriesParallelismFactor
			);
			logNormalSummary(
				"integrate modules",
				p => p.restoring,
				p => p.restoringParallelismFactor
			);
			logByLoadersSummary(
				"build modules",
				p => p.building,
				p => p.buildingParallelismFactor
			);
			logNormalSummary(
				"store modules",
				p => p.storing,
				p => p.storingParallelismFactor
			);
			logNormalSummary(
				"restore modules",
				p => p.restoring,
				p => p.restoringParallelismFactor
			);
			this.logger.timeEnd("finish module profiles");
		}
		this.logger.time("compute affected modules");
		this._computeAffectedModules(this.modules);
		this.logger.timeEnd("compute affected modules");
		this.logger.time("finish modules");
		const { modules, moduleMemCaches } = this;
		this.hooks.finishModules.callAsync(modules, err => {
			this.logger.timeEnd("finish modules");
			if (err) return callback(err);

			// extract warnings and errors from modules
			this.moduleGraph.freeze("dependency errors");
			// TODO keep a cacheToken (= {}) for each module in the graph
			// create a new one per compilation and flag all updated files
			// and parents with it
			this.logger.time("report dependency errors and warnings");
			for (const module of modules) {
				// TODO only run for modules with changed cacheToken
				// global WeakMap<CacheToken, WeakSet<Module>> to keep modules without errors/warnings
				const memCache = moduleMemCaches && moduleMemCaches.get(module);
				if (memCache && memCache.get("noWarningsOrErrors")) continue;
				let hasProblems = this.reportDependencyErrorsAndWarnings(module, [
					module
				]);
				const errors = module.getErrors();
				if (errors !== undefined) {
					for (const error of errors) {
						if (!error.module) {
							error.module = module;
						}
						this.errors.push(error);
						hasProblems = true;
					}
				}
				const warnings = module.getWarnings();
				if (warnings !== undefined) {
					for (const warning of warnings) {
						if (!warning.module) {
							warning.module = module;
						}
						this.warnings.push(warning);
						hasProblems = true;
					}
				}
				if (!hasProblems && memCache) memCache.set("noWarningsOrErrors", true);
			}
			this.moduleGraph.unfreeze();
			this.logger.timeEnd("report dependency errors and warnings");

			callback();
		});
	}

	unseal() {
		this.hooks.unseal.call();
		this.chunks.clear();
		this.chunkGroups.length = 0;
		this.namedChunks.clear();
		this.namedChunkGroups.clear();
		this.entrypoints.clear();
		this.additionalChunkAssets.length = 0;
		this.assets = {};
		this.assetsInfo.clear();
		this.moduleGraph.removeAllModuleAttributes();
		this.moduleGraph.unfreeze();
		this.moduleMemCaches2 = undefined;
	}

	/**
	 * @param {Callback} callback signals when the call finishes
	 * @returns {void}
	 */
	/**
	 * 封装阶段（Seal）- webpack 最复杂的阶段！⭐⭐⭐
	 *
	 * 【文件作用】
	 * seal 是 Compilation 最核心的方法，负责：
	 * 1. 创建 Chunk（代码块）
	 * 2. 优化模块和 Chunk
	 * 3. 生成模块 ID 和 Chunk ID
	 * 4. 生成最终代码
	 * 5. 创建资源对象（assets）
	 *
	 * 【为什么叫 "seal"（封装）】
	 * Make 阶段完成后，所有模块都已构建，依赖图完成。
	 * Seal 阶段将这些松散的模块"封装"成最终的输出文件。
	 *
	 * 【完整流程】
	 * ```
	 * 1. 创建 ChunkGraph
	 * 2. 触发 seal 钩子
	 * 3. 优化依赖
	 * 4. 创建 Chunk（根据入口和异步点）
	 * 5. 构建 Chunk 图（buildChunkGraph）⭐⭐⭐
	 * 6. 优化模块
	 * 7. 优化 Chunk（代码分割）⭐⭐⭐
	 * 8. 优化模块 ID
	 * 9. 优化 Chunk ID
	 * 10. 生成模块哈希
	 * 11. 生成代码（createModuleAssets）⭐⭐⭐
	 * 12. 生成 Chunk 资源（createChunkAssets）⭐⭐⭐
	 * 13. 优化资源
	 * 14. 完成封装
	 * ```
	 *
	 * 【耗时分析】
	 * Seal 阶段占总编译时间的 15-30%：
	 * - buildChunkGraph: ~20%（构建 Chunk 图）
	 * - optimizeChunks: ~30%（SplitChunksPlugin）
	 * - createChunkAssets: ~40%（生成代码）
	 * - 其他优化: ~10%
	 *
	 * 【与 Make 的区别】
	 * - Make: 构建依赖图（输入：入口，输出：ModuleGraph）
	 * - Seal: 优化和生成（输入：ModuleGraph，输出：assets）
	 */
	seal(callback) {
		/**
		 * 最终回调函数
		 *
		 * 【职责】
		 * 清理所有队列并调用用户回调
		 *
		 * 【清理的队列】
		 * 这些队列在 Make 阶段使用，Seal 阶段不再需要
		 */
		const finalCallback = err => {
			// 清理 Make 阶段使用的所有队列
			this.factorizeQueue.clear();        // 模块创建队列
			this.buildQueue.clear();            // 模块构建队列
			this.rebuildQueue.clear();          // 模块重建队列
			this.processDependenciesQueue.clear();  // 依赖处理队列
			this.addModuleQueue.clear();        // 模块添加队列

			// 调用用户回调
			return callback(err);
		};

		// ===== 步骤1: 创建 ChunkGraph（Chunk 依赖图）⭐⭐⭐ =====
		/**
		 * ChunkGraph 的作用：
		 * - 管理 Chunk 和 Module 的关系（多对多）
		 * - 一个 Module 可以属于多个 Chunk
		 * - 一个 Chunk 包含多个 Module
		 *
		 * 【与 ModuleGraph 的区别】
		 * ModuleGraph: Module ←→ Module（模块依赖关系）
		 * ChunkGraph: Chunk ←→ Module（chunk 包含关系）
		 */
		const chunkGraph = new ChunkGraph(
			this.moduleGraph,              // 基于模块图
			this.outputOptions.hashFunction  // 哈希函数
		);
		this.chunkGraph = chunkGraph;

		// 向后兼容：为每个模块设置 chunkGraph 引用
		if (this._backCompat) {
			for (const module of this.modules) {
				ChunkGraph.setChunkGraphForModule(module, chunkGraph);
			}
		}

		// ===== 步骤2: 触发 seal 钩子 =====
		// 插件可以在 seal 开始时执行逻辑
		this.hooks.seal.call();

		// ===== 步骤3: 优化依赖 =====
		this.logger.time("optimize dependencies");

		/**
		 * optimizeDependencies 钩子（可能多次调用）
		 *
		 * 【工作原理】
		 * while 循环：如果钩子返回 true，继续调用
		 * 某些优化需要多轮才能完成
		 */
		while (this.hooks.optimizeDependencies.call(this.modules)) {
			/* empty */
		}
		this.hooks.afterOptimizeDependencies.call(this.modules);
		this.logger.timeEnd("optimize dependencies");

		// ===== 步骤4: 创建 Chunk（从入口开始）⭐⭐⭐ =====
		this.logger.time("create chunks");

		// 触发 beforeChunks 钩子
		this.hooks.beforeChunks.call();

		// 冻结 ModuleGraph（不再修改模块关系）
		this.moduleGraph.freeze("seal");

		/**
		 * chunkGraphInit: 存储每个入口点的初始模块列表
		 * 用于后续的 buildChunkGraph
		 * @type {Map<Entrypoint, Module[]>}
		 */
		const chunkGraphInit = new Map();

		// 遍历所有入口，为每个入口创建 Chunk
		for (const [name, { dependencies, includeDependencies, options }] of this
			.entries) {

			// 4.1 创建入口 Chunk
			// name 是入口名称，如 'main'、'app' 等
			const chunk = this.addChunk(name);

			// 设置自定义文件名（如果有）
			if (options.filename) {
				chunk.filenameTemplate = options.filename;
			}

			// 4.2 创建入口点对象（Entrypoint）
			const entrypoint = new Entrypoint(options);

			// 4.3 设置运行时 Chunk
			// 如果没有 dependOn 和 runtime 配置，chunk 自己就是运行时
			if (!options.dependOn && !options.runtime) {
				entrypoint.setRuntimeChunk(chunk);
			}

			// 4.4 建立 Entrypoint 和 Chunk 的关系
			entrypoint.setEntrypointChunk(chunk);
			this.namedChunkGroups.set(name, entrypoint);
			this.entrypoints.set(name, entrypoint);
			this.chunkGroups.push(entrypoint);
			connectChunkGroupAndChunk(entrypoint, chunk);

			// 4.5 处理入口模块
			const entryModules = new Set();

			// 遍历入口的所有依赖（全局入口 + 该入口的依赖）
			for (const dep of [...this.globalEntry.dependencies, ...dependencies]) {
				// 记录入口来源（用于错误报告）
				entrypoint.addOrigin(null, { name }, /** @type {any} */ (dep).request);

				// 从依赖获取模块
				const module = this.moduleGraph.getModule(dep);

				if (module) {
					// ⭐ 关键：将入口模块连接到 Chunk
					// 这是 ChunkGraph 的第一个连接！
					chunkGraph.connectChunkAndEntryModule(chunk, module, entrypoint);

					// 收集入口模块
					entryModules.add(module);

					// 记录到初始化映射
					const modulesList = chunkGraphInit.get(entrypoint);
					if (modulesList === undefined) {
						chunkGraphInit.set(entrypoint, [module]);
					} else {
						modulesList.push(module);
					}
				}
			}

			// 4.6 计算模块深度（用于排序和优化）
			// 深度 = 从入口到该模块的最短路径长度
			this.assignDepths(entryModules);

			// 4.7 处理包含的模块（includeDependencies）
			// 这些模块会被强制包含到入口 Chunk 中
			const mapAndSort = deps =>
				deps
					.map(dep => this.moduleGraph.getModule(dep))
					.filter(Boolean)
					.sort(compareModulesByIdentifier);

			const includedModules = [
				...mapAndSort(this.globalEntry.includeDependencies),
				...mapAndSort(includeDependencies)
			];

			// 将包含的模块添加到初始化列表
			let modulesList = chunkGraphInit.get(entrypoint);
			if (modulesList === undefined) {
				chunkGraphInit.set(entrypoint, (modulesList = []));
			}
			for (const module of includedModules) {
				this.assignDepth(module);
				modulesList.push(module);
			}
		}
		const runtimeChunks = new Set();
		outer: for (const [
			name,
			{
				options: { dependOn, runtime }
			}
		] of this.entries) {
			if (dependOn && runtime) {
				const err =
					new WebpackError(`Entrypoint '${name}' has 'dependOn' and 'runtime' specified. This is not valid.
Entrypoints that depend on other entrypoints do not have their own runtime.
They will use the runtime(s) from referenced entrypoints instead.
Remove the 'runtime' option from the entrypoint.`);
				const entry = this.entrypoints.get(name);
				err.chunk = entry.getEntrypointChunk();
				this.errors.push(err);
			}
			if (dependOn) {
				const entry = this.entrypoints.get(name);
				const referencedChunks = entry
					.getEntrypointChunk()
					.getAllReferencedChunks();
				const dependOnEntries = [];
				for (const dep of dependOn) {
					const dependency = this.entrypoints.get(dep);
					if (!dependency) {
						throw new Error(
							`Entry ${name} depends on ${dep}, but this entry was not found`
						);
					}
					if (referencedChunks.has(dependency.getEntrypointChunk())) {
						const err = new WebpackError(
							`Entrypoints '${name}' and '${dep}' use 'dependOn' to depend on each other in a circular way.`
						);
						const entryChunk = entry.getEntrypointChunk();
						err.chunk = entryChunk;
						this.errors.push(err);
						entry.setRuntimeChunk(entryChunk);
						continue outer;
					}
					dependOnEntries.push(dependency);
				}
				for (const dependency of dependOnEntries) {
					connectChunkGroupParentAndChild(dependency, entry);
				}
			} else if (runtime) {
				const entry = this.entrypoints.get(name);
				let chunk = this.namedChunks.get(runtime);
				if (chunk) {
					if (!runtimeChunks.has(chunk)) {
						const err =
							new WebpackError(`Entrypoint '${name}' has a 'runtime' option which points to another entrypoint named '${runtime}'.
It's not valid to use other entrypoints as runtime chunk.
Did you mean to use 'dependOn: ${JSON.stringify(
								runtime
							)}' instead to allow using entrypoint '${name}' within the runtime of entrypoint '${runtime}'? For this '${runtime}' must always be loaded when '${name}' is used.
Or do you want to use the entrypoints '${name}' and '${runtime}' independently on the same page with a shared runtime? In this case give them both the same value for the 'runtime' option. It must be a name not already used by an entrypoint.`);
						const entryChunk = entry.getEntrypointChunk();
						err.chunk = entryChunk;
						this.errors.push(err);
						entry.setRuntimeChunk(entryChunk);
						continue;
					}
				} else {
					chunk = this.addChunk(runtime);
					chunk.preventIntegration = true;
					runtimeChunks.add(chunk);
				}
				entry.unshiftChunk(chunk);
				chunk.addGroup(entry);
				entry.setRuntimeChunk(chunk);
			}
		}
		// ===== 步骤5: 构建 Chunk 图（最关键！）⭐⭐⭐ =====
		/**
		 * buildChunkGraph - 构建完整的 Chunk 图
		 *
		 * 【作用】
		 * 从入口模块开始，遍历 ModuleGraph，将模块分配到 Chunk：
		 *
		 * 1. 处理同步依赖：
		 *    入口模块的同步依赖 → 放到同一个 Chunk
		 *
		 * 2. 处理异步依赖：
		 *    遇到 import() → 创建新的 Chunk
		 *
		 * 3. 建立 Chunk 之间的父子关系：
		 *    主 Chunk → 异步 Chunk
		 *
		 * 【执行前】
		 * - Chunk: [main]（只有入口 chunk）
		 * - 入口模块已连接到 main chunk
		 *
		 * 【执行后】
		 * - Chunk: [main, lazy1, lazy2, ...]（包含所有异步 chunk）
		 * - 所有模块都已分配到对应的 Chunk
		 * - Chunk 之间的父子关系建立
		 *
		 * 位置: lib/buildChunkGraph.js
		 */
		buildChunkGraph(this, chunkGraphInit);

		// 触发 afterChunks 钩子
		this.hooks.afterChunks.call(this.chunks);
		this.logger.timeEnd("create chunks");

		// ===== 步骤6: 优化阶段开始 =====
		this.logger.time("optimize");
		this.hooks.optimize.call();

		// ===== 步骤7: 优化模块 ⭐⭐ =====
		/**
		 * optimizeModules 钩子（可能多次调用）
		 *
		 * 【插件示例】
		 * - SideEffectsFlagPlugin: 标记模块副作用
		 * - FlagDependencyUsagePlugin: 标记导出使用情况
		 * - ModuleConcatenationPlugin: 模块合并（Scope Hoisting）
		 *
		 * 【while 循环】
		 * 某些优化需要多轮：
		 * - 第一轮：标记直接使用的导出
		 * - 第二轮：标记传递使用的导出
		 * - ...直到没有变化
		 */
		while (this.hooks.optimizeModules.call(this.modules)) {
			/* empty */
		}
		this.hooks.afterOptimizeModules.call(this.modules);

		// ===== 步骤8: 优化 Chunk（代码分割！）⭐⭐⭐ =====
		/**
		 * optimizeChunks 钩子（可能多次调用）
		 *
		 * 【最重要的优化！】
		 * 这里是 SplitChunksPlugin 工作的地方：
		 *
		 * 1. 分析模块共享情况
		 * 2. 根据 cacheGroups 配置分组
		 * 3. 应用 minSize、maxAsyncRequests 等规则
		 * 4. 创建新的公共 Chunk
		 * 5. 移动模块到公共 Chunk
		 *
		 * 【其他插件】
		 * - RuntimeChunkPlugin: 提取运行时到单独 Chunk
		 * - RemoveEmptyChunksPlugin: 删除空 Chunk
		 * - MergeDuplicateChunksPlugin: 合并重复 Chunk
		 *
		 * 位置: lib/optimize/SplitChunksPlugin.js
		 */
		while (this.hooks.optimizeChunks.call(this.chunks, this.chunkGroups)) {
			/* empty */
		}
		this.hooks.afterOptimizeChunks.call(this.chunks, this.chunkGroups);

		// ===== 步骤9: 优化模块和 Chunk 的关系树 =====
		/**
		 * optimizeTree 钩子（异步）
		 *
		 * 【用途】
		 * 优化整个依赖树结构
		 */
		this.hooks.optimizeTree.callAsync(this.chunks, this.modules, err => {
			if (err) {
				return finalCallback(
					makeWebpackError(err, "Compilation.hooks.optimizeTree")
				);
			}

			this.hooks.afterOptimizeTree.call(this.chunks, this.modules);

			// ===== 步骤10: 优化 Chunk 中的模块 =====
			/**
			 * optimizeChunkModules 钩子（异步）
			 *
			 * 【用途】
			 * 在 Chunk 级别优化模块：
			 * - 删除未使用的模块
			 * - 合并小模块
			 * - 调整模块顺序
			 */
			this.hooks.optimizeChunkModules.callAsync(
				this.chunks,
				this.modules,
				err => {
					if (err) {
						return finalCallback(
							makeWebpackError(err, "Compilation.hooks.optimizeChunkModules")
						);
					}

					this.hooks.afterOptimizeChunkModules.call(this.chunks, this.modules);

					// 判断是否需要记录 records
					const shouldRecord = this.hooks.shouldRecord.call() !== false;

					// ===== 步骤11: 生成模块 ID ⭐⭐ =====
					/**
					 * 模块 ID 生成流程
					 *
					 * 【作用】
					 * 为每个模块分配唯一 ID，用于：
					 * - 运行时模块查找：__webpack_require__(moduleId)
					 * - 持久化缓存：保持 ID 稳定
					 *
					 * 【ID 类型】
					 * - 数字 ID: 0, 1, 2, ...（默认，生产环境）
					 * - 字符串 ID: './src/a.js'（开发环境，便于调试）
					 * - 哈希 ID: 'a1b2c3'（确定性 ID，用于长期缓存）
					 *
					 * 【插件】
					 * - DeterministicModuleIdsPlugin: 确定性 ID（推荐）
					 * - NamedModuleIdsPlugin: 使用路径作为 ID
					 * - HashedModuleIdsPlugin: 哈希 ID
					 */

					// 从 records 恢复模块 ID
					this.hooks.reviveModules.call(this.modules, this.records);

					// 生成模块 ID 的钩子链
					this.hooks.beforeModuleIds.call(this.modules);
					this.hooks.moduleIds.call(this.modules);  // ID 生成插件在这里工作
					this.hooks.optimizeModuleIds.call(this.modules);  // 优化 ID
					this.hooks.afterOptimizeModuleIds.call(this.modules);

					// ===== 步骤12: 生成 Chunk ID ⭐⭐ =====
					/**
					 * Chunk ID 生成流程
					 *
					 * 【作用】
					 * 为每个 Chunk 分配唯一 ID
					 *
					 * 【ID 规则】
					 * - 入口 Chunk: 使用入口名称（'main'）
					 * - 异步 Chunk: 使用魔法注释名称或数字 ID
					 * - 公共 Chunk: 使用 cacheGroups.name
					 *
					 * 【插件】
					 * - DeterministicChunkIdsPlugin: 确定性 ID
					 * - NamedChunkIdsPlugin: 使用有意义的名称
					 */

					// 从 records 恢复 Chunk ID
					this.hooks.reviveChunks.call(this.chunks, this.records);

					// 生成 Chunk ID 的钩子链
					this.hooks.beforeChunkIds.call(this.chunks);
					this.hooks.chunkIds.call(this.chunks);  // ID 生成插件在这里工作
					this.hooks.optimizeChunkIds.call(this.chunks);  // 优化 ID
					this.hooks.afterOptimizeChunkIds.call(this.chunks);

					// ===== 步骤13: 分配运行时 ID =====
					// 为不同的运行时（runtime）分配 ID
					this.assignRuntimeIds();

					// ===== 步骤14: 计算受影响的模块 =====
					/**
					 * 计算哪些模块受 ChunkGraph 影响
					 *
					 * 【用途】
					 * 增量编译时，判断哪些模块需要重新生成代码
					 */
					this.logger.time("compute affected modules with chunk graph");
					this._computeAffectedModulesWithChunkGraph();
					this.logger.timeEnd("compute affected modules with chunk graph");

					// ===== 步骤15: 排序 =====
					// 根据 Chunk ID 对模块、Chunk 等进行排序
					// 确保输出的确定性（相同输入产生相同输出）
					this.sortItemsWithChunkIds();

					// ===== 步骤16: 记录到 records =====
					if (shouldRecord) {
						// 记录模块 ID（用于下次构建保持 ID 稳定）
						this.hooks.recordModules.call(this.modules, this.records);
						// 记录 Chunk ID
						this.hooks.recordChunks.call(this.chunks, this.records);
					}

					// ===== 步骤17: 优化代码生成 =====
					// 最后的代码生成优化机会
					this.hooks.optimizeCodeGeneration.call(this.modules);
					this.logger.timeEnd("optimize");

					// ===== 步骤18: 生成模块哈希 ⭐ =====
					/**
					 * 模块哈希生成
					 *
					 * 【作用】
					 * 为每个模块生成内容哈希，用于：
					 * - 判断模块是否变化
					 * - 增量编译优化
					 * - 缓存失效判断
					 *
					 * 【哈希内容】
					 * - 模块源码
					 * - 模块依赖
					 * - 模块配置
					 */
					this.logger.time("module hashing");
					this.hooks.beforeModuleHash.call();
					this.createModuleHashes();  // 计算每个模块的哈希
					this.hooks.afterModuleHash.call();
					this.logger.timeEnd("module hashing");

					// ===== 步骤19: 代码生成（核心！）⭐⭐⭐ =====
					/**
					 * codeGeneration - 生成所有模块的代码
					 *
					 * 【作用】
					 * 将每个模块转换为最终的 JavaScript 代码
					 *
					 * 【工作内容】
					 * 对每个模块：
					 * 1. 调用 module.codeGeneration()
					 * 2. 生成模块包装代码
					 * 3. 处理导入导出语句
					 * 4. 应用 Tree Shaking（删除未使用的导出）
					 * 5. 生成 Source 对象
					 *
					 * 【并行处理】
					 * 使用 worker 线程并行生成代码（提升性能）
					 *
					 * 【输出】
					 * compilation.codeGenerationResults
					 *   每个模块 → 生成的代码
					 */
					this.logger.time("code generation");
					this.hooks.beforeCodeGeneration.call();
					this.codeGeneration(err => {
						if (err) {
							return finalCallback(err);
						}
						this.hooks.afterCodeGeneration.call();
						this.logger.timeEnd("code generation");

						// ===== 步骤20: 处理运行时需求 ⭐⭐ =====
						/**
						 * processRuntimeRequirements - 分析运行时需求
						 *
						 * 【作用】
						 * 分析模块和 Chunk 需要哪些运行时代码：
						 *
						 * 【运行时功能示例】
						 * - __webpack_require__: 模块加载
						 * - __webpack_require__.e: 异步 chunk 加载
						 * - __webpack_require__.d: 定义 getter
						 * - __webpack_require__.r: 标记 ES Module
						 * - __webpack_require__.n: 兼容性处理
						 *
						 * 【工作流程】
						 * 1. 遍历所有模块，收集 runtimeRequirements
						 * 2. 为每个 Chunk 确定需要的运行时模块
						 * 3. 添加 RuntimeModule 到 Chunk
						 *
						 * 位置: lib/runtime/*.js（29 个运行时模块）
						 */
						this.logger.time("runtime requirements");
						this.hooks.beforeRuntimeRequirements.call();
						this.processRuntimeRequirements();
						this.hooks.afterRuntimeRequirements.call();
						this.logger.timeEnd("runtime requirements");

						// ===== 步骤21: 生成内容哈希（用于文件名）⭐⭐ =====
						/**
						 * createHash - 生成 Chunk 的内容哈希
						 *
						 * 【作用】
						 * 为每个 Chunk 生成哈希值，用于：
						 * - 文件名：main.[contenthash].js
						 * - 长期缓存：内容不变，文件名不变
						 * - 缓存失效：内容变化，文件名变化
						 *
						 * 【哈希类型】
						 * - [hash]: 整个编译的哈希
						 * - [chunkhash]: 单个 chunk 的哈希
						 * - [contenthash]: 内容哈希（最精确）
						 *
						 * 【返回值】
						 * codeGenerationJobs: 需要重新生成代码的任务
						 */
						this.logger.time("hashing");
						this.hooks.beforeHash.call();
						const codeGenerationJobs = this.createHash();
						this.hooks.afterHash.call();
						this.logger.timeEnd("hashing");

						// ===== 步骤22: 执行代码生成任务 =====
						/**
						 * 运行哈希变化后需要重新生成的代码
						 *
						 * 【增量优化】
						 * 只重新生成哈希变化的模块代码
						 */
						this._runCodeGenerationJobs(codeGenerationJobs, err => {
							if (err) {
								return finalCallback(err);
							}

							// 记录哈希到 records
							if (shouldRecord) {
								this.logger.time("record hash");
								this.hooks.recordHash.call(this.records);
								this.logger.timeEnd("record hash");
							}

							// ===== 步骤23: 创建模块资源 ⭐ =====
							/**
							 * createModuleAssets - 为模块创建单独的资源文件
							 *
							 * 【使用场景】
							 * 某些模块会生成独立文件：
							 * - CSS 模块 → .css 文件
							 * - 图片模块 → 图片文件
							 * - Worker 模块 → worker.js 文件
							 *
							 * 【不包含】
							 * 普通的 JS 模块会在 createChunkAssets 中处理
							 */
							this.logger.time("module assets");
							this.clearAssets();  // 清空之前的资源

							this.hooks.beforeModuleAssets.call();
							this.createModuleAssets();  // 创建模块资源
							this.logger.timeEnd("module assets");

							/**
							 * cont - 继续执行后续流程
							 *
							 * 【包含步骤】
							 * - processAssets: 处理和优化资源
							 * - afterSeal: 完成封装
							 */
							const cont = () => {
								// ===== 步骤25: 处理资源 ⭐⭐ =====
								/**
								 * processAssets 钩子 - 资源处理的核心钩子
								 *
								 * 【作用】
								 * 这是处理最终资源的地方，支持多个阶段：
								 *
								 * 【处理阶段】（按顺序）
								 * PROCESS_ASSETS_STAGE_ADDITIONAL        // 添加额外资源
								 * PROCESS_ASSETS_STAGE_PRE_PROCESS       // 预处理
								 * PROCESS_ASSETS_STAGE_DERIVED           // 派生资源
								 * PROCESS_ASSETS_STAGE_ADDITIONS         // 添加到现有资源
								 * PROCESS_ASSETS_STAGE_OPTIMIZE          // 优化
								 * PROCESS_ASSETS_STAGE_OPTIMIZE_COUNT    // 优化数量
								 * PROCESS_ASSETS_STAGE_OPTIMIZE_COMPATIBILITY // 兼容性
								 * PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE     // 优化大小（压缩）⭐
								 * PROCESS_ASSETS_STAGE_DEV_TOOLING       // 开发工具
								 * PROCESS_ASSETS_STAGE_OPTIMIZE_INLINE   // 内联优化
								 * PROCESS_ASSETS_STAGE_SUMMARIZE         // 总结
								 * PROCESS_ASSETS_STAGE_OPTIMIZE_HASH     // 优化哈希
								 * PROCESS_ASSETS_STAGE_OPTIMIZE_TRANSFER // 优化传输
								 * PROCESS_ASSETS_STAGE_ANALYSE           // 分析
								 * PROCESS_ASSETS_STAGE_REPORT            // 报告
								 *
								 * 【插件示例】
								 * - TerserPlugin: 压缩 JS（OPTIMIZE_SIZE 阶段）
								 * - CssMinimizerPlugin: 压缩 CSS
								 * - CompressionPlugin: gzip 压缩
								 */
								this.logger.time("process assets");
								this.hooks.processAssets.callAsync(this.assets, err => {
									if (err) {
										return finalCallback(
											makeWebpackError(err, "Compilation.hooks.processAssets")
										);
									}
									this.hooks.afterProcessAssets.call(this.assets);
									this.logger.timeEnd("process assets");

									// 冻结 assets 对象（不允许再修改）
									this.assets = this._backCompat
										? soonFrozenObjectDeprecation(
												this.assets,
												"Compilation.assets",
												"DEP_WEBPACK_COMPILATION_ASSETS",
												`BREAKING CHANGE: No more changes should happen to Compilation.assets after sealing the Compilation.
	Do changes to assets earlier, e. g. in Compilation.hooks.processAssets.
	Make sure to select an appropriate stage from Compilation.PROCESS_ASSETS_STAGE_*.`
										  )
										: Object.freeze(this.assets);

									// ===== 步骤26: 总结依赖 =====
									// 生成依赖统计信息
									this.summarizeDependencies();

									// 记录最终状态到 records
									if (shouldRecord) {
										this.hooks.record.call(this, this.records);
									}

									// ===== 步骤27: 检查是否需要额外 seal =====
									/**
									 * 某些插件可能需要重新 seal
									 *
									 * 【场景】
									 * 如果在资源处理阶段发现需要调整：
									 * - 添加了新的模块
									 * - 修改了 Chunk 结构
									 * - 需要重新优化
									 *
									 * 【处理】
									 * unseal() 重置状态，然后递归调用 seal()
									 */
									if (this.hooks.needAdditionalSeal.call()) {
										this.unseal();  // 重置封装状态
										return this.seal(callback);  // 重新封装
									}

									// ===== 步骤28: 完成封装！✅ =====
									// 触发 afterSeal 钩子，标志 seal 阶段完成
									return this.hooks.afterSeal.callAsync(err => {
										if (err) {
											return finalCallback(
												makeWebpackError(err, "Compilation.hooks.afterSeal")
											);
										}
										// 输出文件系统统计信息
										this.fileSystemInfo.logStatistics();

										// 所有工作完成！调用最终回调
										finalCallback();
									});
								});
							};

							// ===== 步骤24: 创建 Chunk 资源（最重要！）⭐⭐⭐ =====
							/**
							 * createChunkAssets - 生成 Chunk 的输出文件
							 *
							 * 【作用】
							 * 这是生成最终 bundle 文件的地方！
							 *
							 * 【工作内容】
							 * 对每个 Chunk：
							 * 1. 确定文件名（应用 [hash]、[chunkhash] 等占位符）
							 * 2. 调用 JavascriptModulesPlugin.renderMain()
							 * 3. 生成运行时代码
							 * 4. 拼接所有模块代码
							 * 5. 应用 SourceMap
							 * 6. 创建 Source 对象
							 * 7. 添加到 compilation.assets
							 *
							 * 【输出】
							 * compilation.assets = {
							 *   'main.js': Source,
							 *   'vendors.js': Source,
							 *   'lazy.js': Source,
							 *   ...
							 * }
							 *
							 * 【这是 Chunk → Bundle 的转换！】
							 * Chunk（逻辑） → Source（代码） → Bundle（文件）
							 *
							 * 位置: lib/javascript/JavascriptModulesPlugin.js
							 */
							this.logger.time("create chunk assets");
							if (this.hooks.shouldGenerateChunkAssets.call() !== false) {
								this.hooks.beforeChunkAssets.call();
								this.createChunkAssets(err => {
									this.logger.timeEnd("create chunk assets");
									if (err) {
										return finalCallback(err);
									}
									// 继续后续流程
									cont();
								});
							} else {
								// 不生成 Chunk 资源（特殊场景）
								this.logger.timeEnd("create chunk assets");
								cont();
							}
						});
					});
				}
			);
		});
	}

	/**
	 * @param {Module} module module to report from
	 * @param {DependenciesBlock[]} blocks blocks to report from
	 * @returns {boolean} true, when it has warnings or errors
	 */
	reportDependencyErrorsAndWarnings(module, blocks) {
		let hasProblems = false;
		for (let indexBlock = 0; indexBlock < blocks.length; indexBlock++) {
			const block = blocks[indexBlock];
			const dependencies = block.dependencies;

			for (let indexDep = 0; indexDep < dependencies.length; indexDep++) {
				const d = dependencies[indexDep];

				const warnings = d.getWarnings(this.moduleGraph);
				if (warnings) {
					for (let indexWar = 0; indexWar < warnings.length; indexWar++) {
						const w = warnings[indexWar];

						const warning = new ModuleDependencyWarning(module, w, d.loc);
						this.warnings.push(warning);
						hasProblems = true;
					}
				}
				const errors = d.getErrors(this.moduleGraph);
				if (errors) {
					for (let indexErr = 0; indexErr < errors.length; indexErr++) {
						const e = errors[indexErr];

						const error = new ModuleDependencyError(module, e, d.loc);
						this.errors.push(error);
						hasProblems = true;
					}
				}
			}

			if (this.reportDependencyErrorsAndWarnings(module, block.blocks))
				hasProblems = true;
		}
		return hasProblems;
	}

	/**
	 * 代码生成（为所有模块生成代码）⭐⭐⭐
	 *
	 * 【作用】
	 * 为编译中的所有模块生成最终代码
	 *
	 * 【执行流程】
	 * 1. 创建代码生成结果容器
	 * 2. 为每个模块创建代码生成任务
	 * 3. 合并相同哈希的任务（优化）
	 * 4. 并行执行所有任务
	 *
	 * 【性能考虑】⭐
	 * - 并行生成（利用多核）
	 * - 哈希去重（相同代码只生成一次）
	 * - 缓存复用（未变化的模块跳过）
	 *
	 * 【生成内容】
	 * 对每个模块：
	 * - 包装成 webpack 模块格式
	 * - 处理导入导出语句
	 * - 应用 Tree Shaking
	 * - 生成 Source 对象
	 */
	codeGeneration(callback) {
		// ===== 步骤1: 准备代码生成结果容器 =====
		const { chunkGraph } = this;

		/**
		 * codeGenerationResults 存储所有模块的生成结果
		 *
		 * 【结构】
		 * Map<Module, Map<Runtime, CodeGenerationResult>>
		 *
		 * 【内容】
		 * {
		 *   module1 => {
		 *     runtime1 => { sources, runtimeRequirements, ... },
		 *     runtime2 => { sources, runtimeRequirements, ... }
		 *   },
		 *   module2 => { ... }
		 * }
		 */
		this.codeGenerationResults = new CodeGenerationResults(
			this.outputOptions.hashFunction
		);

		// ===== 步骤2: 创建代码生成任务列表 ⭐⭐ =====
		/**
		 * jobs: 所有代码生成任务
		 *
		 * 【任务结构】
		 * {
		 *   module: Module,           // 要生成代码的模块
		 *   hash: string,             // 模块哈希
		 *   runtime: RuntimeSpec,     // 运行时
		 *   runtimes: RuntimeSpec[]   // 运行时列表（哈希相同时合并）
		 * }
		 *
		 * @type {{module: Module, hash: string, runtime: RuntimeSpec, runtimes: RuntimeSpec[]}[]}
		 */
		const jobs = [];

		// ===== 遍历所有模块，创建任务 =====
		for (const module of this.modules) {
			// ===== 获取模块的运行时集合 ⭐ =====
			/**
			 * 一个模块可能在多个运行时中使用
			 *
			 * 【示例】
			 * - 模块在 main 和 admin 两个入口中使用
			 * - 需要为每个运行时生成代码
			 *
			 * 【为什么】
			 * 不同运行时可能有不同的：
			 * - 导出使用情况（Tree Shaking）
			 * - 运行时需求
			 * - 优化策略
			 */
			const runtimes = chunkGraph.getModuleRuntimes(module);

			if (runtimes.size === 1) {
				// ===== 情况1: 模块只在一个运行时中使用 =====
				// 简单情况，直接创建任务
				for (const runtime of runtimes) {
					// 获取模块在该运行时的哈希
					const hash = chunkGraph.getModuleHash(module, runtime);

					// 创建代码生成任务
					jobs.push({ module, hash, runtime, runtimes: [runtime] });
				}
			} else if (runtimes.size > 1) {
				// ===== 情况2: 模块在多个运行时中使用 ⭐⭐ =====
				/**
				 * 优化：相同哈希的运行时可以共享代码
				 *
				 * 【原理】
				 * 如果模块在不同运行时的哈希相同：
				 * - 说明生成的代码也相同
				 * - 可以只生成一次
				 * - 多个运行时共享结果
				 *
				 * 【示例】
				 * 模块在 runtime1 和 runtime2 中使用：
				 * - 如果哈希相同 → 创建 1 个任务，runtimes: [runtime1, runtime2]
				 * - 如果哈希不同 → 创建 2 个任务
				 */
				/** @type {Map<string, { runtimes: RuntimeSpec[] }>} */
				const map = new Map();

				for (const runtime of runtimes) {
					// 获取模块在该运行时的哈希
					const hash = chunkGraph.getModuleHash(module, runtime);

					// 检查是否已有相同哈希的任务
					const job = map.get(hash);

					if (job === undefined) {
						// 新哈希，创建新任务
						const newJob = { module, hash, runtime, runtimes: [runtime] };
						jobs.push(newJob);
						map.set(hash, newJob);
					} else {
						// 哈希相同，添加到现有任务的运行时列表
						// ⭐ 优化：这样只生成一次代码，多个运行时共享
						job.runtimes.push(runtime);
					}
				}
			}
		}

		// ===== 步骤3: 执行所有代码生成任务 ⭐⭐⭐ =====
		/**
		 * _runCodeGenerationJobs 会：
		 * 1. 并行执行所有任务
		 * 2. 检查代码生成依赖
		 * 3. 处理循环依赖
		 * 4. 缓存结果
		 */
		this._runCodeGenerationJobs(jobs, callback);
	}

	/**
	 * 执行代码生成任务（并行处理核心）⭐⭐⭐
	 *
	 * 【作用】
	 * 并行执行所有代码生成任务
	 *
	 * 【执行流程】
	 * 1. 检查代码生成依赖
	 * 2. 并行生成代码（利用多核）
	 * 3. 处理延迟任务（有依赖的模块）
	 * 4. 检测循环依赖
	 * 5. 收集错误
	 *
	 * 【并行度】
	 * 由 options.parallelism 控制（默认 100）
	 *
	 * 【性能】
	 * - 并行处理提升 2-4 倍速度
	 * - 缓存命中率 60-80%
	 */
	_runCodeGenerationJobs(jobs, callback) {
		// ===== 快速路径：无任务 =====
		if (jobs.length === 0) {
			return callback();
		}

		// ===== 步骤1: 初始化统计和数据结构 =====
		let statModulesFromCache = 0;   // 从缓存获取的模块数
		let statModulesGenerated = 0;   // 新生成代码的模块数

		// 提取编译相关对象
		const { chunkGraph, moduleGraph, dependencyTemplates, runtimeTemplate } =
			this;

		// 代码生成结果容器
		const results = this.codeGenerationResults;

		/**
		 * errors: 代码生成错误集合
		 * @type {WebpackError[]}
		 */
		const errors = [];

		/**
		 * notCodeGeneratedModules: 还未生成代码的模块集合
		 *
		 * 【用途】
		 * 处理代码生成依赖：
		 * - 某些模块依赖其他模块的代码生成结果
		 * - 需要先生成被依赖的模块
		 *
		 * @type {Set<Module> | undefined}
		 */
		let notCodeGeneratedModules = undefined;

		/**
		 * runIteration - 运行一轮代码生成
		 *
		 * 【迭代原因】⭐⭐
		 * 某些模块可能依赖其他模块的代码生成结果
		 * 需要多轮迭代：
		 * 1. 第一轮：生成无依赖的模块
		 * 2. 第二轮：生成依赖第一轮的模块
		 * 3. ...直到所有模块都生成
		 *
		 * 【循环检测】
		 * 如果一轮中所有任务都被延迟 → 存在循环依赖 → 报错
		 */
		const runIteration = () => {
			// 延迟任务列表（本轮无法处理的）
			let delayedJobs = [];

			// 延迟模块集合
			let delayedModules = new Set();

			// ===== 并行处理所有任务 ⭐⭐⭐ =====
			/**
			 * asyncLib.eachLimit 并行处理任务
			 *
			 * 【参数】
			 * - jobs: 任务数组
			 * - parallelism: 并行数（默认 100）
			 * - 处理函数：对每个任务执行
			 * - 完成回调：所有任务完成时调用
			 */
			asyncLib.eachLimit(
				jobs,
				this.options.parallelism,  // 并行数限制
				(job, callback) => {
					const { module } = job;

					// ===== 检查代码生成依赖 ⭐ =====
					/**
					 * 某些模块可能依赖其他模块的代码生成结果
					 *
					 * 【场景】
					 * - ConcatenatedModule 依赖被合并的模块
					 * - 某些优化需要其他模块先生成
					 *
					 * 【检查】
					 * 如果依赖的模块还未生成代码，延迟处理
					 */
					const { codeGenerationDependencies } = module;

					if (codeGenerationDependencies !== undefined) {
						// 模块有代码生成依赖

						if (
							notCodeGeneratedModules === undefined ||
							codeGenerationDependencies.some(dep => {
								// 检查依赖的模块是否还未生成代码
								const referencedModule = moduleGraph.getModule(dep);
								return notCodeGeneratedModules.has(referencedModule);
							})
						) {
							// ===== 依赖未满足，延迟处理 ⭐ =====
							/**
							 * 依赖的模块还未生成代码
							 *
							 * 【策略】
							 * - 添加到 delayedJobs
							 * - 标记模块为延迟
							 * - 下一轮再处理
							 */
							delayedJobs.push(job);
							delayedModules.add(module);
							return callback();  // 跳过，不生成
						}
					}
					// ===== 依赖满足，执行代码生成 ⭐⭐⭐ =====
					const { hash, runtime, runtimes } = job;

					/**
					 * _codeGenerationModule 会：
					 * 1. 检查缓存（通过 hash）
					 * 2. 如果缓存未命中，调用 module.codeGeneration()
					 * 3. 生成 Source 对象
					 * 4. 收集运行时需求
					 * 5. 保存结果到 results
					 *
					 * 【生成内容】
					 * - sources: Map<SourceType, Source>
					 * - runtimeRequirements: Set<string>
					 * - data: 额外数据
					 */
					this._codeGenerationModule(
						module,                  // 模块
						runtime,                 // 运行时
						runtimes,                // 运行时列表
						hash,                    // 模块哈希
						dependencyTemplates,     // 依赖模板
						chunkGraph,              // Chunk 图
						moduleGraph,             // 模块图
						runtimeTemplate,         // 运行时模板
						errors,                  // 错误集合
						results,                 // 结果容器
						(err, codeGenerated) => {
							// ===== 统计代码生成情况 =====
							/**
							 * codeGenerated: 是否真正生成了代码
							 * - true: 新生成的（缓存未命中）
							 * - false: 从缓存获取
							 */
							if (codeGenerated) statModulesGenerated++;
							else statModulesFromCache++;
							callback(err);
						}
					);
				},
				err => {
					// ===== 本轮任务全部完成 =====

					if (err) return callback(err);

					// ===== 处理延迟任务 ⭐⭐ =====
					if (delayedJobs.length > 0) {
						// 有延迟的任务

						// ===== 检测循环依赖 ⭐ =====
						if (delayedJobs.length === jobs.length) {
							/**
							 * 所有任务都被延迟了！
							 *
							 * 【说明】
							 * 存在循环的代码生成依赖：
							 * - A 依赖 B 的代码生成
							 * - B 依赖 A 的代码生成
							 * - 死锁！无法继续
							 *
							 * 【处理】
							 * 抛出错误，显示循环依赖的模块
							 */
							return callback(
								new Error(
									`Unable to make progress during code generation because of circular code generation dependency: ${Array.from(
										delayedModules,
										m => m.identifier()
									).join(", ")}`
								)
							);
						}

						// ===== 准备下一轮迭代 ⭐ =====
						/**
						 * 有进展（部分任务完成了）
						 *
						 * 【下一轮】
						 * - jobs = delayedJobs（只处理延迟的）
						 * - notCodeGeneratedModules = delayedModules
						 * - 递归调用 runIteration
						 */
						jobs = delayedJobs;
						delayedJobs = [];
						notCodeGeneratedModules = delayedModules;
						delayedModules = new Set();

						// 递归：开始下一轮
						return runIteration();
					}

					// ===== 所有任务完成，处理错误 =====
					if (errors.length > 0) {
						// 排序错误（按模块标识符）
						errors.sort(
							compareSelect(err => err.module, compareModulesByIdentifier)
						);

						// 添加到编译错误列表
						for (const error of errors) {
							this.errors.push(error);
						}
					}

					// ===== 输出统计信息 ⭐ =====
					/**
					 * 显示代码生成的缓存命中率
					 *
					 * 【示例】
					 * 75% code generated (300 generated, 900 from cache)
					 *
					 * 【性能指标】
					 * - 缓存命中率越高越好
					 * - 首次编译：0% 缓存（全部生成）
					 * - 重复编译：60-80% 缓存（大部分复用）
					 */
					this.logger.log(
						`${Math.round(
							(100 * statModulesGenerated) /
								(statModulesGenerated + statModulesFromCache)
						)}% code generated (${statModulesGenerated} generated, ${statModulesFromCache} from cache)`
					);

					// 所有代码生成完成
					callback();
				}
			);
		};

		// ===== 启动第一轮迭代 =====
		runIteration();
	}

	/**
	 * @param {Module} module module
	 * @param {RuntimeSpec} runtime runtime
	 * @param {RuntimeSpec[]} runtimes runtimes
	 * @param {string} hash hash
	 * @param {DependencyTemplates} dependencyTemplates dependencyTemplates
	 * @param {ChunkGraph} chunkGraph chunkGraph
	 * @param {ModuleGraph} moduleGraph moduleGraph
	 * @param {RuntimeTemplate} runtimeTemplate runtimeTemplate
	 * @param {WebpackError[]} errors errors
	 * @param {CodeGenerationResults} results results
	 * @param {function((WebpackError | null)=, boolean=): void} callback callback
	 */
	_codeGenerationModule(
		module,
		runtime,
		runtimes,
		hash,
		dependencyTemplates,
		chunkGraph,
		moduleGraph,
		runtimeTemplate,
		errors,
		results,
		callback
	) {
		let codeGenerated = false;
		const cache = new MultiItemCache(
			runtimes.map(runtime =>
				this._codeGenerationCache.getItemCache(
					`${module.identifier()}|${getRuntimeKey(runtime)}`,
					`${hash}|${dependencyTemplates.getHash()}`
				)
			)
		);
		cache.get((err, cachedResult) => {
			if (err) return callback(err);
			let result;
			if (!cachedResult) {
				try {
					codeGenerated = true;
					this.codeGeneratedModules.add(module);
					result = module.codeGeneration({
						chunkGraph,
						moduleGraph,
						dependencyTemplates,
						runtimeTemplate,
						runtime,
						codeGenerationResults: results,
						compilation: this
					});
				} catch (err) {
					errors.push(new CodeGenerationError(module, err));
					result = cachedResult = {
						sources: new Map(),
						runtimeRequirements: null
					};
				}
			} else {
				result = cachedResult;
			}
			for (const runtime of runtimes) {
				results.add(module, runtime, result);
			}
			if (!cachedResult) {
				cache.store(result, err => callback(err, codeGenerated));
			} else {
				callback(null, codeGenerated);
			}
		});
	}

	_getChunkGraphEntries() {
		/** @type {Set<Chunk>} */
		const treeEntries = new Set();
		for (const ep of this.entrypoints.values()) {
			const chunk = ep.getRuntimeChunk();
			if (chunk) treeEntries.add(chunk);
		}
		for (const ep of this.asyncEntrypoints) {
			const chunk = ep.getRuntimeChunk();
			if (chunk) treeEntries.add(chunk);
		}
		return treeEntries;
	}

	/**
	 * @param {Object} options options
	 * @param {ChunkGraph=} options.chunkGraph the chunk graph
	 * @param {Iterable<Module>=} options.modules modules
	 * @param {Iterable<Chunk>=} options.chunks chunks
	 * @param {CodeGenerationResults=} options.codeGenerationResults codeGenerationResults
	 * @param {Iterable<Chunk>=} options.chunkGraphEntries chunkGraphEntries
	 * @returns {void}
	 */
	processRuntimeRequirements({
		chunkGraph = this.chunkGraph,
		modules = this.modules,
		chunks = this.chunks,
		codeGenerationResults = this.codeGenerationResults,
		chunkGraphEntries = this._getChunkGraphEntries()
	} = {}) {
		const context = { chunkGraph, codeGenerationResults };
		const { moduleMemCaches2 } = this;
		this.logger.time("runtime requirements.modules");
		const additionalModuleRuntimeRequirements =
			this.hooks.additionalModuleRuntimeRequirements;
		const runtimeRequirementInModule = this.hooks.runtimeRequirementInModule;
		for (const module of modules) {
			if (chunkGraph.getNumberOfModuleChunks(module) > 0) {
				const memCache = moduleMemCaches2 && moduleMemCaches2.get(module);
				for (const runtime of chunkGraph.getModuleRuntimes(module)) {
					if (memCache) {
						const cached = memCache.get(
							`moduleRuntimeRequirements-${getRuntimeKey(runtime)}`
						);
						if (cached !== undefined) {
							if (cached !== null) {
								chunkGraph.addModuleRuntimeRequirements(
									module,
									runtime,
									cached,
									false
								);
							}
							continue;
						}
					}
					let set;
					const runtimeRequirements =
						codeGenerationResults.getRuntimeRequirements(module, runtime);
					if (runtimeRequirements && runtimeRequirements.size > 0) {
						set = new Set(runtimeRequirements);
					} else if (additionalModuleRuntimeRequirements.isUsed()) {
						set = new Set();
					} else {
						if (memCache) {
							memCache.set(
								`moduleRuntimeRequirements-${getRuntimeKey(runtime)}`,
								null
							);
						}
						continue;
					}
					additionalModuleRuntimeRequirements.call(module, set, context);

					for (const r of set) {
						const hook = runtimeRequirementInModule.get(r);
						if (hook !== undefined) hook.call(module, set, context);
					}
					if (set.size === 0) {
						if (memCache) {
							memCache.set(
								`moduleRuntimeRequirements-${getRuntimeKey(runtime)}`,
								null
							);
						}
					} else {
						if (memCache) {
							memCache.set(
								`moduleRuntimeRequirements-${getRuntimeKey(runtime)}`,
								set
							);
							chunkGraph.addModuleRuntimeRequirements(
								module,
								runtime,
								set,
								false
							);
						} else {
							chunkGraph.addModuleRuntimeRequirements(module, runtime, set);
						}
					}
				}
			}
		}
		this.logger.timeEnd("runtime requirements.modules");

		this.logger.time("runtime requirements.chunks");
		for (const chunk of chunks) {
			const set = new Set();
			for (const module of chunkGraph.getChunkModulesIterable(chunk)) {
				const runtimeRequirements = chunkGraph.getModuleRuntimeRequirements(
					module,
					chunk.runtime
				);
				for (const r of runtimeRequirements) set.add(r);
			}
			this.hooks.additionalChunkRuntimeRequirements.call(chunk, set, context);

			for (const r of set) {
				this.hooks.runtimeRequirementInChunk.for(r).call(chunk, set, context);
			}

			chunkGraph.addChunkRuntimeRequirements(chunk, set);
		}
		this.logger.timeEnd("runtime requirements.chunks");

		this.logger.time("runtime requirements.entries");
		for (const treeEntry of chunkGraphEntries) {
			const set = new Set();
			for (const chunk of treeEntry.getAllReferencedChunks()) {
				const runtimeRequirements =
					chunkGraph.getChunkRuntimeRequirements(chunk);
				for (const r of runtimeRequirements) set.add(r);
			}

			this.hooks.additionalTreeRuntimeRequirements.call(
				treeEntry,
				set,
				context
			);

			for (const r of set) {
				this.hooks.runtimeRequirementInTree
					.for(r)
					.call(treeEntry, set, context);
			}

			chunkGraph.addTreeRuntimeRequirements(treeEntry, set);
		}
		this.logger.timeEnd("runtime requirements.entries");
	}

	// TODO webpack 6 make chunkGraph argument non-optional
	/**
	 * @param {Chunk} chunk target chunk
	 * @param {RuntimeModule} module runtime module
	 * @param {ChunkGraph} chunkGraph the chunk graph
	 * @returns {void}
	 */
	addRuntimeModule(chunk, module, chunkGraph = this.chunkGraph) {
		// Deprecated ModuleGraph association
		if (this._backCompat)
			ModuleGraph.setModuleGraphForModule(module, this.moduleGraph);

		// add it to the list
		this.modules.add(module);
		this._modules.set(module.identifier(), module);

		// connect to the chunk graph
		chunkGraph.connectChunkAndModule(chunk, module);
		chunkGraph.connectChunkAndRuntimeModule(chunk, module);
		if (module.fullHash) {
			chunkGraph.addFullHashModuleToChunk(chunk, module);
		} else if (module.dependentHash) {
			chunkGraph.addDependentHashModuleToChunk(chunk, module);
		}

		// attach runtime module
		module.attach(this, chunk, chunkGraph);

		// Setup internals
		const exportsInfo = this.moduleGraph.getExportsInfo(module);
		exportsInfo.setHasProvideInfo();
		if (typeof chunk.runtime === "string") {
			exportsInfo.setUsedForSideEffectsOnly(chunk.runtime);
		} else if (chunk.runtime === undefined) {
			exportsInfo.setUsedForSideEffectsOnly(undefined);
		} else {
			for (const runtime of chunk.runtime) {
				exportsInfo.setUsedForSideEffectsOnly(runtime);
			}
		}
		chunkGraph.addModuleRuntimeRequirements(
			module,
			chunk.runtime,
			new Set([RuntimeGlobals.requireScope])
		);

		// runtime modules don't need ids
		chunkGraph.setModuleId(module, "");

		// Call hook
		this.hooks.runtimeModule.call(module, chunk);
	}

	/**
	 * If `module` is passed, `loc` and `request` must also be passed.
	 * @param {string | ChunkGroupOptions} groupOptions options for the chunk group
	 * @param {Module=} module the module the references the chunk group
	 * @param {DependencyLocation=} loc the location from with the chunk group is referenced (inside of module)
	 * @param {string=} request the request from which the the chunk group is referenced
	 * @returns {ChunkGroup} the new or existing chunk group
	 */
	addChunkInGroup(groupOptions, module, loc, request) {
		if (typeof groupOptions === "string") {
			groupOptions = { name: groupOptions };
		}
		const name = groupOptions.name;

		if (name) {
			const chunkGroup = this.namedChunkGroups.get(name);
			if (chunkGroup !== undefined) {
				chunkGroup.addOptions(groupOptions);
				if (module) {
					chunkGroup.addOrigin(module, loc, request);
				}
				return chunkGroup;
			}
		}
		const chunkGroup = new ChunkGroup(groupOptions);
		if (module) chunkGroup.addOrigin(module, loc, request);
		const chunk = this.addChunk(name);

		connectChunkGroupAndChunk(chunkGroup, chunk);

		this.chunkGroups.push(chunkGroup);
		if (name) {
			this.namedChunkGroups.set(name, chunkGroup);
		}
		return chunkGroup;
	}

	/**
	 * @param {EntryOptions} options options for the entrypoint
	 * @param {Module} module the module the references the chunk group
	 * @param {DependencyLocation} loc the location from with the chunk group is referenced (inside of module)
	 * @param {string} request the request from which the the chunk group is referenced
	 * @returns {Entrypoint} the new or existing entrypoint
	 */
	addAsyncEntrypoint(options, module, loc, request) {
		const name = options.name;
		if (name) {
			const entrypoint = this.namedChunkGroups.get(name);
			if (entrypoint instanceof Entrypoint) {
				if (entrypoint !== undefined) {
					if (module) {
						entrypoint.addOrigin(module, loc, request);
					}
					return entrypoint;
				}
			} else if (entrypoint) {
				throw new Error(
					`Cannot add an async entrypoint with the name '${name}', because there is already an chunk group with this name`
				);
			}
		}
		const chunk = this.addChunk(name);
		if (options.filename) {
			chunk.filenameTemplate = options.filename;
		}
		const entrypoint = new Entrypoint(options, false);
		entrypoint.setRuntimeChunk(chunk);
		entrypoint.setEntrypointChunk(chunk);
		if (name) {
			this.namedChunkGroups.set(name, entrypoint);
		}
		this.chunkGroups.push(entrypoint);
		this.asyncEntrypoints.push(entrypoint);
		connectChunkGroupAndChunk(entrypoint, chunk);
		if (module) {
			entrypoint.addOrigin(module, loc, request);
		}
		return entrypoint;
	}

	/**
	 * This method first looks to see if a name is provided for a new chunk,
	 * and first looks to see if any named chunks already exist and reuse that chunk instead.
	 *
	 * @param {string=} name optional chunk name to be provided
	 * @returns {Chunk} create a chunk (invoked during seal event)
	 */
	addChunk(name) {
		if (name) {
			const chunk = this.namedChunks.get(name);
			if (chunk !== undefined) {
				return chunk;
			}
		}
		const chunk = new Chunk(name, this._backCompat);
		this.chunks.add(chunk);
		if (this._backCompat)
			ChunkGraph.setChunkGraphForChunk(chunk, this.chunkGraph);
		if (name) {
			this.namedChunks.set(name, chunk);
		}
		return chunk;
	}

	/**
	 * @deprecated
	 * @param {Module} module module to assign depth
	 * @returns {void}
	 */
	assignDepth(module) {
		const moduleGraph = this.moduleGraph;

		const queue = new Set([module]);
		let depth;

		moduleGraph.setDepth(module, 0);

		/**
		 * @param {Module} module module for processing
		 * @returns {void}
		 */
		const processModule = module => {
			if (!moduleGraph.setDepthIfLower(module, depth)) return;
			queue.add(module);
		};

		for (module of queue) {
			queue.delete(module);
			depth = moduleGraph.getDepth(module) + 1;

			for (const connection of moduleGraph.getOutgoingConnections(module)) {
				const refModule = connection.module;
				if (refModule) {
					processModule(refModule);
				}
			}
		}
	}

	/**
	 * @param {Set<Module>} modules module to assign depth
	 * @returns {void}
	 */
	assignDepths(modules) {
		const moduleGraph = this.moduleGraph;

		/** @type {Set<Module | number>} */
		const queue = new Set(modules);
		queue.add(1);
		let depth = 0;

		let i = 0;
		for (const module of queue) {
			i++;
			if (typeof module === "number") {
				depth = module;
				if (queue.size === i) return;
				queue.add(depth + 1);
			} else {
				moduleGraph.setDepth(module, depth);
				for (const { module: refModule } of moduleGraph.getOutgoingConnections(
					module
				)) {
					if (refModule) {
						queue.add(refModule);
					}
				}
			}
		}
	}

	/**
	 * @param {Dependency} dependency the dependency
	 * @param {RuntimeSpec} runtime the runtime
	 * @returns {(string[] | ReferencedExport)[]} referenced exports
	 */
	getDependencyReferencedExports(dependency, runtime) {
		const referencedExports = dependency.getReferencedExports(
			this.moduleGraph,
			runtime
		);
		return this.hooks.dependencyReferencedExports.call(
			referencedExports,
			dependency,
			runtime
		);
	}

	/**
	 *
	 * @param {Module} module module relationship for removal
	 * @param {DependenciesBlockLike} block //TODO: good description
	 * @returns {void}
	 */
	removeReasonsOfDependencyBlock(module, block) {
		if (block.blocks) {
			for (const b of block.blocks) {
				this.removeReasonsOfDependencyBlock(module, b);
			}
		}

		if (block.dependencies) {
			for (const dep of block.dependencies) {
				const originalModule = this.moduleGraph.getModule(dep);
				if (originalModule) {
					this.moduleGraph.removeConnection(dep);

					if (this.chunkGraph) {
						for (const chunk of this.chunkGraph.getModuleChunks(
							originalModule
						)) {
							this.patchChunksAfterReasonRemoval(originalModule, chunk);
						}
					}
				}
			}
		}
	}

	/**
	 * @param {Module} module module to patch tie
	 * @param {Chunk} chunk chunk to patch tie
	 * @returns {void}
	 */
	patchChunksAfterReasonRemoval(module, chunk) {
		if (!module.hasReasons(this.moduleGraph, chunk.runtime)) {
			this.removeReasonsOfDependencyBlock(module, module);
		}
		if (!module.hasReasonForChunk(chunk, this.moduleGraph, this.chunkGraph)) {
			if (this.chunkGraph.isModuleInChunk(module, chunk)) {
				this.chunkGraph.disconnectChunkAndModule(chunk, module);
				this.removeChunkFromDependencies(module, chunk);
			}
		}
	}

	/**
	 *
	 * @param {DependenciesBlock} block block tie for Chunk
	 * @param {Chunk} chunk chunk to remove from dep
	 * @returns {void}
	 */
	removeChunkFromDependencies(block, chunk) {
		/**
		 * @param {Dependency} d dependency to (maybe) patch up
		 */
		const iteratorDependency = d => {
			const depModule = this.moduleGraph.getModule(d);
			if (!depModule) {
				return;
			}
			this.patchChunksAfterReasonRemoval(depModule, chunk);
		};

		const blocks = block.blocks;
		for (let indexBlock = 0; indexBlock < blocks.length; indexBlock++) {
			const asyncBlock = blocks[indexBlock];
			const chunkGroup = this.chunkGraph.getBlockChunkGroup(asyncBlock);
			// Grab all chunks from the first Block's AsyncDepBlock
			const chunks = chunkGroup.chunks;
			// For each chunk in chunkGroup
			for (let indexChunk = 0; indexChunk < chunks.length; indexChunk++) {
				const iteratedChunk = chunks[indexChunk];
				chunkGroup.removeChunk(iteratedChunk);
				// Recurse
				this.removeChunkFromDependencies(block, iteratedChunk);
			}
		}

		if (block.dependencies) {
			for (const dep of block.dependencies) iteratorDependency(dep);
		}
	}

	assignRuntimeIds() {
		const { chunkGraph } = this;
		const processEntrypoint = ep => {
			const runtime = ep.options.runtime || ep.name;
			const chunk = ep.getRuntimeChunk();
			chunkGraph.setRuntimeId(runtime, chunk.id);
		};
		for (const ep of this.entrypoints.values()) {
			processEntrypoint(ep);
		}
		for (const ep of this.asyncEntrypoints) {
			processEntrypoint(ep);
		}
	}

	sortItemsWithChunkIds() {
		for (const chunkGroup of this.chunkGroups) {
			chunkGroup.sortItems();
		}

		this.errors.sort(compareErrors);
		this.warnings.sort(compareErrors);
		this.children.sort(byNameOrHash);
	}

	summarizeDependencies() {
		for (
			let indexChildren = 0;
			indexChildren < this.children.length;
			indexChildren++
		) {
			const child = this.children[indexChildren];

			this.fileDependencies.addAll(child.fileDependencies);
			this.contextDependencies.addAll(child.contextDependencies);
			this.missingDependencies.addAll(child.missingDependencies);
			this.buildDependencies.addAll(child.buildDependencies);
		}

		for (const module of this.modules) {
			module.addCacheDependencies(
				this.fileDependencies,
				this.contextDependencies,
				this.missingDependencies,
				this.buildDependencies
			);
		}
	}

	createModuleHashes() {
		let statModulesHashed = 0;
		let statModulesFromCache = 0;
		const { chunkGraph, runtimeTemplate, moduleMemCaches2 } = this;
		const { hashFunction, hashDigest, hashDigestLength } = this.outputOptions;
		const errors = [];
		for (const module of this.modules) {
			const memCache = moduleMemCaches2 && moduleMemCaches2.get(module);
			for (const runtime of chunkGraph.getModuleRuntimes(module)) {
				if (memCache) {
					const digest = memCache.get(`moduleHash-${getRuntimeKey(runtime)}`);
					if (digest !== undefined) {
						chunkGraph.setModuleHashes(
							module,
							runtime,
							digest,
							digest.slice(0, hashDigestLength)
						);
						statModulesFromCache++;
						continue;
					}
				}
				statModulesHashed++;
				const digest = this._createModuleHash(
					module,
					chunkGraph,
					runtime,
					hashFunction,
					runtimeTemplate,
					hashDigest,
					hashDigestLength,
					errors
				);
				if (memCache) {
					memCache.set(`moduleHash-${getRuntimeKey(runtime)}`, digest);
				}
			}
		}
		if (errors.length > 0) {
			errors.sort(compareSelect(err => err.module, compareModulesByIdentifier));
			for (const error of errors) {
				this.errors.push(error);
			}
		}
		this.logger.log(
			`${statModulesHashed} modules hashed, ${statModulesFromCache} from cache (${
				Math.round(
					(100 * (statModulesHashed + statModulesFromCache)) / this.modules.size
				) / 100
			} variants per module in average)`
		);
	}

	_createModuleHash(
		module,
		chunkGraph,
		runtime,
		hashFunction,
		runtimeTemplate,
		hashDigest,
		hashDigestLength,
		errors
	) {
		let moduleHashDigest;
		try {
			const moduleHash = createHash(hashFunction);
			module.updateHash(moduleHash, {
				chunkGraph,
				runtime,
				runtimeTemplate
			});
			moduleHashDigest = /** @type {string} */ (moduleHash.digest(hashDigest));
		} catch (err) {
			errors.push(new ModuleHashingError(module, err));
			moduleHashDigest = "XXXXXX";
		}
		chunkGraph.setModuleHashes(
			module,
			runtime,
			moduleHashDigest,
			moduleHashDigest.slice(0, hashDigestLength)
		);
		return moduleHashDigest;
	}

	createHash() {
		this.logger.time("hashing: initialize hash");
		const chunkGraph = this.chunkGraph;
		const runtimeTemplate = this.runtimeTemplate;
		const outputOptions = this.outputOptions;
		const hashFunction = outputOptions.hashFunction;
		const hashDigest = outputOptions.hashDigest;
		const hashDigestLength = outputOptions.hashDigestLength;
		const hash = createHash(hashFunction);
		if (outputOptions.hashSalt) {
			hash.update(outputOptions.hashSalt);
		}
		this.logger.timeEnd("hashing: initialize hash");
		if (this.children.length > 0) {
			this.logger.time("hashing: hash child compilations");
			for (const child of this.children) {
				hash.update(child.hash);
			}
			this.logger.timeEnd("hashing: hash child compilations");
		}
		if (this.warnings.length > 0) {
			this.logger.time("hashing: hash warnings");
			for (const warning of this.warnings) {
				hash.update(`${warning.message}`);
			}
			this.logger.timeEnd("hashing: hash warnings");
		}
		if (this.errors.length > 0) {
			this.logger.time("hashing: hash errors");
			for (const error of this.errors) {
				hash.update(`${error.message}`);
			}
			this.logger.timeEnd("hashing: hash errors");
		}

		this.logger.time("hashing: sort chunks");
		/*
		 * all non-runtime chunks need to be hashes first,
		 * since runtime chunk might use their hashes.
		 * runtime chunks need to be hashed in the correct order
		 * since they may depend on each other (for async entrypoints).
		 * So we put all non-runtime chunks first and hash them in any order.
		 * And order runtime chunks according to referenced between each other.
		 * Chunks need to be in deterministic order since we add hashes to full chunk
		 * during these hashing.
		 */
		/** @type {Chunk[]} */
		const unorderedRuntimeChunks = [];
		/** @type {Chunk[]} */
		const otherChunks = [];
		for (const c of this.chunks) {
			if (c.hasRuntime()) {
				unorderedRuntimeChunks.push(c);
			} else {
				otherChunks.push(c);
			}
		}
		unorderedRuntimeChunks.sort(byId);
		otherChunks.sort(byId);

		/** @typedef {{ chunk: Chunk, referencedBy: RuntimeChunkInfo[], remaining: number }} RuntimeChunkInfo */
		/** @type {Map<Chunk, RuntimeChunkInfo>} */
		const runtimeChunksMap = new Map();
		for (const chunk of unorderedRuntimeChunks) {
			runtimeChunksMap.set(chunk, {
				chunk,
				referencedBy: [],
				remaining: 0
			});
		}
		let remaining = 0;
		for (const info of runtimeChunksMap.values()) {
			for (const other of new Set(
				Array.from(info.chunk.getAllReferencedAsyncEntrypoints()).map(
					e => e.chunks[e.chunks.length - 1]
				)
			)) {
				const otherInfo = runtimeChunksMap.get(other);
				otherInfo.referencedBy.push(info);
				info.remaining++;
				remaining++;
			}
		}
		/** @type {Chunk[]} */
		const runtimeChunks = [];
		for (const info of runtimeChunksMap.values()) {
			if (info.remaining === 0) {
				runtimeChunks.push(info.chunk);
			}
		}
		// If there are any references between chunks
		// make sure to follow these chains
		if (remaining > 0) {
			const readyChunks = [];
			for (const chunk of runtimeChunks) {
				const hasFullHashModules =
					chunkGraph.getNumberOfChunkFullHashModules(chunk) !== 0;
				const info = runtimeChunksMap.get(chunk);
				for (const otherInfo of info.referencedBy) {
					if (hasFullHashModules) {
						chunkGraph.upgradeDependentToFullHashModules(otherInfo.chunk);
					}
					remaining--;
					if (--otherInfo.remaining === 0) {
						readyChunks.push(otherInfo.chunk);
					}
				}
				if (readyChunks.length > 0) {
					// This ensures deterministic ordering, since referencedBy is non-deterministic
					readyChunks.sort(byId);
					for (const c of readyChunks) runtimeChunks.push(c);
					readyChunks.length = 0;
				}
			}
		}
		// If there are still remaining references we have cycles and want to create a warning
		if (remaining > 0) {
			let circularRuntimeChunkInfo = [];
			for (const info of runtimeChunksMap.values()) {
				if (info.remaining !== 0) {
					circularRuntimeChunkInfo.push(info);
				}
			}
			circularRuntimeChunkInfo.sort(compareSelect(i => i.chunk, byId));
			const err =
				new WebpackError(`Circular dependency between chunks with runtime (${Array.from(
					circularRuntimeChunkInfo,
					c => c.chunk.name || c.chunk.id
				).join(", ")})
This prevents using hashes of each other and should be avoided.`);
			err.chunk = circularRuntimeChunkInfo[0].chunk;
			this.warnings.push(err);
			for (const i of circularRuntimeChunkInfo) runtimeChunks.push(i.chunk);
		}
		this.logger.timeEnd("hashing: sort chunks");

		const fullHashChunks = new Set();
		/** @type {{module: Module, hash: string, runtime: RuntimeSpec, runtimes: RuntimeSpec[]}[]} */
		const codeGenerationJobs = [];
		/** @type {Map<string, Map<Module, {module: Module, hash: string, runtime: RuntimeSpec, runtimes: RuntimeSpec[]}>>} */
		const codeGenerationJobsMap = new Map();
		const errors = [];

		const processChunk = chunk => {
			// Last minute module hash generation for modules that depend on chunk hashes
			this.logger.time("hashing: hash runtime modules");
			const runtime = chunk.runtime;
			for (const module of chunkGraph.getChunkModulesIterable(chunk)) {
				if (!chunkGraph.hasModuleHashes(module, runtime)) {
					const hash = this._createModuleHash(
						module,
						chunkGraph,
						runtime,
						hashFunction,
						runtimeTemplate,
						hashDigest,
						hashDigestLength,
						errors
					);
					let hashMap = codeGenerationJobsMap.get(hash);
					if (hashMap) {
						const moduleJob = hashMap.get(module);
						if (moduleJob) {
							moduleJob.runtimes.push(runtime);
							continue;
						}
					} else {
						hashMap = new Map();
						codeGenerationJobsMap.set(hash, hashMap);
					}
					const job = {
						module,
						hash,
						runtime,
						runtimes: [runtime]
					};
					hashMap.set(module, job);
					codeGenerationJobs.push(job);
				}
			}
			this.logger.timeAggregate("hashing: hash runtime modules");
			try {
				this.logger.time("hashing: hash chunks");
				const chunkHash = createHash(hashFunction);
				if (outputOptions.hashSalt) {
					chunkHash.update(outputOptions.hashSalt);
				}
				chunk.updateHash(chunkHash, chunkGraph);
				this.hooks.chunkHash.call(chunk, chunkHash, {
					chunkGraph,
					codeGenerationResults: this.codeGenerationResults,
					moduleGraph: this.moduleGraph,
					runtimeTemplate: this.runtimeTemplate
				});
				const chunkHashDigest = /** @type {string} */ (
					chunkHash.digest(hashDigest)
				);
				hash.update(chunkHashDigest);
				chunk.hash = chunkHashDigest;
				chunk.renderedHash = chunk.hash.slice(0, hashDigestLength);
				const fullHashModules =
					chunkGraph.getChunkFullHashModulesIterable(chunk);
				if (fullHashModules) {
					fullHashChunks.add(chunk);
				} else {
					this.hooks.contentHash.call(chunk);
				}
			} catch (err) {
				this.errors.push(new ChunkRenderError(chunk, "", err));
			}
			this.logger.timeAggregate("hashing: hash chunks");
		};
		otherChunks.forEach(processChunk);
		for (const chunk of runtimeChunks) processChunk(chunk);
		if (errors.length > 0) {
			errors.sort(compareSelect(err => err.module, compareModulesByIdentifier));
			for (const error of errors) {
				this.errors.push(error);
			}
		}

		this.logger.timeAggregateEnd("hashing: hash runtime modules");
		this.logger.timeAggregateEnd("hashing: hash chunks");
		this.logger.time("hashing: hash digest");
		this.hooks.fullHash.call(hash);
		this.fullHash = /** @type {string} */ (hash.digest(hashDigest));
		this.hash = this.fullHash.slice(0, hashDigestLength);
		this.logger.timeEnd("hashing: hash digest");

		this.logger.time("hashing: process full hash modules");
		for (const chunk of fullHashChunks) {
			for (const module of chunkGraph.getChunkFullHashModulesIterable(chunk)) {
				const moduleHash = createHash(hashFunction);
				module.updateHash(moduleHash, {
					chunkGraph,
					runtime: chunk.runtime,
					runtimeTemplate
				});
				const moduleHashDigest = /** @type {string} */ (
					moduleHash.digest(hashDigest)
				);
				const oldHash = chunkGraph.getModuleHash(module, chunk.runtime);
				chunkGraph.setModuleHashes(
					module,
					chunk.runtime,
					moduleHashDigest,
					moduleHashDigest.slice(0, hashDigestLength)
				);
				codeGenerationJobsMap.get(oldHash).get(module).hash = moduleHashDigest;
			}
			const chunkHash = createHash(hashFunction);
			chunkHash.update(chunk.hash);
			chunkHash.update(this.hash);
			const chunkHashDigest = /** @type {string} */ (
				chunkHash.digest(hashDigest)
			);
			chunk.hash = chunkHashDigest;
			chunk.renderedHash = chunk.hash.slice(0, hashDigestLength);
			this.hooks.contentHash.call(chunk);
		}
		this.logger.timeEnd("hashing: process full hash modules");
		return codeGenerationJobs;
	}

	/**
	 * @param {string} file file name
	 * @param {Source} source asset source
	 * @param {AssetInfo} assetInfo extra asset information
	 * @returns {void}
	 */
	emitAsset(file, source, assetInfo = {}) {
		if (this.assets[file]) {
			if (!isSourceEqual(this.assets[file], source)) {
				this.errors.push(
					new WebpackError(
						`Conflict: Multiple assets emit different content to the same filename ${file}${
							assetInfo.sourceFilename
								? `. Original source ${assetInfo.sourceFilename}`
								: ""
						}`
					)
				);
				this.assets[file] = source;
				this._setAssetInfo(file, assetInfo);
				return;
			}
			const oldInfo = this.assetsInfo.get(file);
			const newInfo = Object.assign({}, oldInfo, assetInfo);
			this._setAssetInfo(file, newInfo, oldInfo);
			return;
		}
		this.assets[file] = source;
		this._setAssetInfo(file, assetInfo, undefined);
	}

	_setAssetInfo(file, newInfo, oldInfo = this.assetsInfo.get(file)) {
		if (newInfo === undefined) {
			this.assetsInfo.delete(file);
		} else {
			this.assetsInfo.set(file, newInfo);
		}
		const oldRelated = oldInfo && oldInfo.related;
		const newRelated = newInfo && newInfo.related;
		if (oldRelated) {
			for (const key of Object.keys(oldRelated)) {
				const remove = name => {
					const relatedIn = this._assetsRelatedIn.get(name);
					if (relatedIn === undefined) return;
					const entry = relatedIn.get(key);
					if (entry === undefined) return;
					entry.delete(file);
					if (entry.size !== 0) return;
					relatedIn.delete(key);
					if (relatedIn.size === 0) this._assetsRelatedIn.delete(name);
				};
				const entry = oldRelated[key];
				if (Array.isArray(entry)) {
					entry.forEach(remove);
				} else if (entry) {
					remove(entry);
				}
			}
		}
		if (newRelated) {
			for (const key of Object.keys(newRelated)) {
				const add = name => {
					let relatedIn = this._assetsRelatedIn.get(name);
					if (relatedIn === undefined) {
						this._assetsRelatedIn.set(name, (relatedIn = new Map()));
					}
					let entry = relatedIn.get(key);
					if (entry === undefined) {
						relatedIn.set(key, (entry = new Set()));
					}
					entry.add(file);
				};
				const entry = newRelated[key];
				if (Array.isArray(entry)) {
					entry.forEach(add);
				} else if (entry) {
					add(entry);
				}
			}
		}
	}

	/**
	 * @param {string} file file name
	 * @param {Source | function(Source): Source} newSourceOrFunction new asset source or function converting old to new
	 * @param {AssetInfo | function(AssetInfo | undefined): AssetInfo} assetInfoUpdateOrFunction new asset info or function converting old to new
	 */
	updateAsset(
		file,
		newSourceOrFunction,
		assetInfoUpdateOrFunction = undefined
	) {
		if (!this.assets[file]) {
			throw new Error(
				`Called Compilation.updateAsset for not existing filename ${file}`
			);
		}
		if (typeof newSourceOrFunction === "function") {
			this.assets[file] = newSourceOrFunction(this.assets[file]);
		} else {
			this.assets[file] = newSourceOrFunction;
		}
		if (assetInfoUpdateOrFunction !== undefined) {
			const oldInfo = this.assetsInfo.get(file) || EMPTY_ASSET_INFO;
			if (typeof assetInfoUpdateOrFunction === "function") {
				this._setAssetInfo(file, assetInfoUpdateOrFunction(oldInfo), oldInfo);
			} else {
				this._setAssetInfo(
					file,
					cachedCleverMerge(oldInfo, assetInfoUpdateOrFunction),
					oldInfo
				);
			}
		}
	}

	renameAsset(file, newFile) {
		const source = this.assets[file];
		if (!source) {
			throw new Error(
				`Called Compilation.renameAsset for not existing filename ${file}`
			);
		}
		if (this.assets[newFile]) {
			if (!isSourceEqual(this.assets[file], source)) {
				this.errors.push(
					new WebpackError(
						`Conflict: Called Compilation.renameAsset for already existing filename ${newFile} with different content`
					)
				);
			}
		}
		const assetInfo = this.assetsInfo.get(file);
		// Update related in all other assets
		const relatedInInfo = this._assetsRelatedIn.get(file);
		if (relatedInInfo) {
			for (const [key, assets] of relatedInInfo) {
				for (const name of assets) {
					const info = this.assetsInfo.get(name);
					if (!info) continue;
					const related = info.related;
					if (!related) continue;
					const entry = related[key];
					let newEntry;
					if (Array.isArray(entry)) {
						newEntry = entry.map(x => (x === file ? newFile : x));
					} else if (entry === file) {
						newEntry = newFile;
					} else continue;
					this.assetsInfo.set(name, {
						...info,
						related: {
							...related,
							[key]: newEntry
						}
					});
				}
			}
		}
		this._setAssetInfo(file, undefined, assetInfo);
		this._setAssetInfo(newFile, assetInfo);
		delete this.assets[file];
		this.assets[newFile] = source;
		for (const chunk of this.chunks) {
			{
				const size = chunk.files.size;
				chunk.files.delete(file);
				if (size !== chunk.files.size) {
					chunk.files.add(newFile);
				}
			}
			{
				const size = chunk.auxiliaryFiles.size;
				chunk.auxiliaryFiles.delete(file);
				if (size !== chunk.auxiliaryFiles.size) {
					chunk.auxiliaryFiles.add(newFile);
				}
			}
		}
	}

	/**
	 * @param {string} file file name
	 */
	deleteAsset(file) {
		if (!this.assets[file]) {
			return;
		}
		delete this.assets[file];
		const assetInfo = this.assetsInfo.get(file);
		this._setAssetInfo(file, undefined, assetInfo);
		const related = assetInfo && assetInfo.related;
		if (related) {
			for (const key of Object.keys(related)) {
				const checkUsedAndDelete = file => {
					if (!this._assetsRelatedIn.has(file)) {
						this.deleteAsset(file);
					}
				};
				const items = related[key];
				if (Array.isArray(items)) {
					items.forEach(checkUsedAndDelete);
				} else if (items) {
					checkUsedAndDelete(items);
				}
			}
		}
		// TODO If this becomes a performance problem
		// store a reverse mapping from asset to chunk
		for (const chunk of this.chunks) {
			chunk.files.delete(file);
			chunk.auxiliaryFiles.delete(file);
		}
	}

	getAssets() {
		/** @type {Readonly<Asset>[]} */
		const array = [];
		for (const assetName of Object.keys(this.assets)) {
			if (Object.prototype.hasOwnProperty.call(this.assets, assetName)) {
				array.push({
					name: assetName,
					source: this.assets[assetName],
					info: this.assetsInfo.get(assetName) || EMPTY_ASSET_INFO
				});
			}
		}
		return array;
	}

	/**
	 * @param {string} name the name of the asset
	 * @returns {Readonly<Asset> | undefined} the asset or undefined when not found
	 */
	getAsset(name) {
		if (!Object.prototype.hasOwnProperty.call(this.assets, name))
			return undefined;
		return {
			name,
			source: this.assets[name],
			info: this.assetsInfo.get(name) || EMPTY_ASSET_INFO
		};
	}

	clearAssets() {
		for (const chunk of this.chunks) {
			chunk.files.clear();
			chunk.auxiliaryFiles.clear();
		}
	}

	createModuleAssets() {
		const { chunkGraph } = this;
		for (const module of this.modules) {
			if (module.buildInfo.assets) {
				const assetsInfo = module.buildInfo.assetsInfo;
				for (const assetName of Object.keys(module.buildInfo.assets)) {
					const fileName = this.getPath(assetName, {
						chunkGraph: this.chunkGraph,
						module
					});
					for (const chunk of chunkGraph.getModuleChunksIterable(module)) {
						chunk.auxiliaryFiles.add(fileName);
					}
					this.emitAsset(
						fileName,
						module.buildInfo.assets[assetName],
						assetsInfo ? assetsInfo.get(assetName) : undefined
					);
					this.hooks.moduleAsset.call(module, fileName);
				}
			}
		}
	}

	/**
	 * @param {RenderManifestOptions} options options object
	 * @returns {RenderManifestEntry[]} manifest entries
	 */
	getRenderManifest(options) {
		return this.hooks.renderManifest.call([], options);
	}

	/**
	 * @param {Callback} callback signals when the call finishes
	 * @returns {void}
	 */
	createChunkAssets(callback) {
		const outputOptions = this.outputOptions;
		const cachedSourceMap = new WeakMap();
		/** @type {Map<string, {hash: string, source: Source, chunk: Chunk}>} */
		const alreadyWrittenFiles = new Map();

		asyncLib.forEachLimit(
			this.chunks,
			15,
			(chunk, callback) => {
				/** @type {RenderManifestEntry[]} */
				let manifest;
				try {
					manifest = this.getRenderManifest({
						chunk,
						hash: this.hash,
						fullHash: this.fullHash,
						outputOptions,
						codeGenerationResults: this.codeGenerationResults,
						moduleTemplates: this.moduleTemplates,
						dependencyTemplates: this.dependencyTemplates,
						chunkGraph: this.chunkGraph,
						moduleGraph: this.moduleGraph,
						runtimeTemplate: this.runtimeTemplate
					});
				} catch (err) {
					this.errors.push(new ChunkRenderError(chunk, "", err));
					return callback();
				}
				asyncLib.forEach(
					manifest,
					(fileManifest, callback) => {
						const ident = fileManifest.identifier;
						const usedHash = fileManifest.hash;

						const assetCacheItem = this._assetsCache.getItemCache(
							ident,
							usedHash
						);

						assetCacheItem.get((err, sourceFromCache) => {
							/** @type {string | function(PathData, AssetInfo=): string} */
							let filenameTemplate;
							/** @type {string} */
							let file;
							/** @type {AssetInfo} */
							let assetInfo;

							let inTry = true;
							const errorAndCallback = err => {
								const filename =
									file ||
									(typeof file === "string"
										? file
										: typeof filenameTemplate === "string"
										? filenameTemplate
										: "");

								this.errors.push(new ChunkRenderError(chunk, filename, err));
								inTry = false;
								return callback();
							};

							try {
								if ("filename" in fileManifest) {
									file = fileManifest.filename;
									assetInfo = fileManifest.info;
								} else {
									filenameTemplate = fileManifest.filenameTemplate;
									const pathAndInfo = this.getPathWithInfo(
										filenameTemplate,
										fileManifest.pathOptions
									);
									file = pathAndInfo.path;
									assetInfo = fileManifest.info
										? {
												...pathAndInfo.info,
												...fileManifest.info
										  }
										: pathAndInfo.info;
								}

								if (err) {
									return errorAndCallback(err);
								}

								let source = sourceFromCache;

								// check if the same filename was already written by another chunk
								const alreadyWritten = alreadyWrittenFiles.get(file);
								if (alreadyWritten !== undefined) {
									if (alreadyWritten.hash !== usedHash) {
										inTry = false;
										return callback(
											new WebpackError(
												`Conflict: Multiple chunks emit assets to the same filename ${file}` +
													` (chunks ${alreadyWritten.chunk.id} and ${chunk.id})`
											)
										);
									} else {
										source = alreadyWritten.source;
									}
								} else if (!source) {
									// render the asset
									source = fileManifest.render();

									// Ensure that source is a cached source to avoid additional cost because of repeated access
									if (!(source instanceof CachedSource)) {
										const cacheEntry = cachedSourceMap.get(source);
										if (cacheEntry) {
											source = cacheEntry;
										} else {
											const cachedSource = new CachedSource(source);
											cachedSourceMap.set(source, cachedSource);
											source = cachedSource;
										}
									}
								}
								this.emitAsset(file, source, assetInfo);
								if (fileManifest.auxiliary) {
									chunk.auxiliaryFiles.add(file);
								} else {
									chunk.files.add(file);
								}
								this.hooks.chunkAsset.call(chunk, file);
								alreadyWrittenFiles.set(file, {
									hash: usedHash,
									source,
									chunk
								});
								if (source !== sourceFromCache) {
									assetCacheItem.store(source, err => {
										if (err) return errorAndCallback(err);
										inTry = false;
										return callback();
									});
								} else {
									inTry = false;
									callback();
								}
							} catch (err) {
								if (!inTry) throw err;
								errorAndCallback(err);
							}
						});
					},
					callback
				);
			},
			callback
		);
	}

	/**
	 * @param {string | function(PathData, AssetInfo=): string} filename used to get asset path with hash
	 * @param {PathData} data context data
	 * @returns {string} interpolated path
	 */
	getPath(filename, data = {}) {
		if (!data.hash) {
			data = {
				hash: this.hash,
				...data
			};
		}
		return this.getAssetPath(filename, data);
	}

	/**
	 * @param {string | function(PathData, AssetInfo=): string} filename used to get asset path with hash
	 * @param {PathData} data context data
	 * @returns {{ path: string, info: AssetInfo }} interpolated path and asset info
	 */
	getPathWithInfo(filename, data = {}) {
		if (!data.hash) {
			data = {
				hash: this.hash,
				...data
			};
		}
		return this.getAssetPathWithInfo(filename, data);
	}

	/**
	 * @param {string | function(PathData, AssetInfo=): string} filename used to get asset path with hash
	 * @param {PathData} data context data
	 * @returns {string} interpolated path
	 */
	getAssetPath(filename, data) {
		return this.hooks.assetPath.call(
			typeof filename === "function" ? filename(data) : filename,
			data,
			undefined
		);
	}

	/**
	 * @param {string | function(PathData, AssetInfo=): string} filename used to get asset path with hash
	 * @param {PathData} data context data
	 * @returns {{ path: string, info: AssetInfo }} interpolated path and asset info
	 */
	getAssetPathWithInfo(filename, data) {
		const assetInfo = {};
		// TODO webpack 5: refactor assetPath hook to receive { path, info } object
		const newPath = this.hooks.assetPath.call(
			typeof filename === "function" ? filename(data, assetInfo) : filename,
			data,
			assetInfo
		);
		return { path: newPath, info: assetInfo };
	}

	getWarnings() {
		return this.hooks.processWarnings.call(this.warnings);
	}

	getErrors() {
		return this.hooks.processErrors.call(this.errors);
	}

	/**
	 * This function allows you to run another instance of webpack inside of webpack however as
	 * a child with different settings and configurations (if desired) applied. It copies all hooks, plugins
	 * from parent (or top level compiler) and creates a child Compilation
	 *
	 * @param {string} name name of the child compiler
	 * @param {OutputOptions=} outputOptions // Need to convert config schema to types for this
	 * @param {Array<WebpackPluginInstance | WebpackPluginFunction>=} plugins webpack plugins that will be applied
	 * @returns {Compiler} creates a child Compiler instance
	 */
	createChildCompiler(name, outputOptions, plugins) {
		const idx = this.childrenCounters[name] || 0;
		this.childrenCounters[name] = idx + 1;
		return this.compiler.createChildCompiler(
			this,
			name,
			idx,
			outputOptions,
			plugins
		);
	}

	/**
	 * @param {Module} module the module
	 * @param {ExecuteModuleOptions} options options
	 * @param {ExecuteModuleCallback} callback callback
	 */
	executeModule(module, options, callback) {
		// Aggregate all referenced modules and ensure they are ready
		const modules = new Set([module]);
		processAsyncTree(
			modules,
			10,
			/**
			 * @param {Module} module the module
			 * @param {function(Module): void} push push more jobs
			 * @param {Callback} callback callback
			 * @returns {void}
			 */
			(module, push, callback) => {
				this.buildQueue.waitFor(module, err => {
					if (err) return callback(err);
					this.processDependenciesQueue.waitFor(module, err => {
						if (err) return callback(err);
						for (const { module: m } of this.moduleGraph.getOutgoingConnections(
							module
						)) {
							const size = modules.size;
							modules.add(m);
							if (modules.size !== size) push(m);
						}
						callback();
					});
				});
			},
			err => {
				if (err) return callback(err);

				// Create new chunk graph, chunk and entrypoint for the build time execution
				const chunkGraph = new ChunkGraph(
					this.moduleGraph,
					this.outputOptions.hashFunction
				);
				const runtime = "build time";
				const { hashFunction, hashDigest, hashDigestLength } =
					this.outputOptions;
				const runtimeTemplate = this.runtimeTemplate;

				const chunk = new Chunk("build time chunk", this._backCompat);
				chunk.id = chunk.name;
				chunk.ids = [chunk.id];
				chunk.runtime = runtime;

				const entrypoint = new Entrypoint({
					runtime,
					chunkLoading: false,
					...options.entryOptions
				});
				chunkGraph.connectChunkAndEntryModule(chunk, module, entrypoint);
				connectChunkGroupAndChunk(entrypoint, chunk);
				entrypoint.setRuntimeChunk(chunk);
				entrypoint.setEntrypointChunk(chunk);

				const chunks = new Set([chunk]);

				// Assign ids to modules and modules to the chunk
				for (const module of modules) {
					const id = module.identifier();
					chunkGraph.setModuleId(module, id);
					chunkGraph.connectChunkAndModule(chunk, module);
				}

				/** @type {WebpackError[]} */
				const errors = [];

				// Hash modules
				for (const module of modules) {
					this._createModuleHash(
						module,
						chunkGraph,
						runtime,
						hashFunction,
						runtimeTemplate,
						hashDigest,
						hashDigestLength,
						errors
					);
				}

				const codeGenerationResults = new CodeGenerationResults(
					this.outputOptions.hashFunction
				);
				/**
				 * @param {Module} module the module
				 * @param {Callback} callback callback
				 * @returns {void}
				 */
				const codeGen = (module, callback) => {
					this._codeGenerationModule(
						module,
						runtime,
						[runtime],
						chunkGraph.getModuleHash(module, runtime),
						this.dependencyTemplates,
						chunkGraph,
						this.moduleGraph,
						runtimeTemplate,
						errors,
						codeGenerationResults,
						(err, codeGenerated) => {
							callback(err);
						}
					);
				};

				const reportErrors = () => {
					if (errors.length > 0) {
						errors.sort(
							compareSelect(err => err.module, compareModulesByIdentifier)
						);
						for (const error of errors) {
							this.errors.push(error);
						}
						errors.length = 0;
					}
				};

				// Generate code for all aggregated modules
				asyncLib.eachLimit(modules, 10, codeGen, err => {
					if (err) return callback(err);
					reportErrors();

					// for backward-compat temporary set the chunk graph
					// TODO webpack 6
					const old = this.chunkGraph;
					this.chunkGraph = chunkGraph;
					this.processRuntimeRequirements({
						chunkGraph,
						modules,
						chunks,
						codeGenerationResults,
						chunkGraphEntries: chunks
					});
					this.chunkGraph = old;

					const runtimeModules =
						chunkGraph.getChunkRuntimeModulesIterable(chunk);

					// Hash runtime modules
					for (const module of runtimeModules) {
						modules.add(module);
						this._createModuleHash(
							module,
							chunkGraph,
							runtime,
							hashFunction,
							runtimeTemplate,
							hashDigest,
							hashDigestLength
						);
					}

					// Generate code for all runtime modules
					asyncLib.eachLimit(runtimeModules, 10, codeGen, err => {
						if (err) return callback(err);
						reportErrors();

						/** @type {Map<Module, ExecuteModuleArgument>} */
						const moduleArgumentsMap = new Map();
						/** @type {Map<string, ExecuteModuleArgument>} */
						const moduleArgumentsById = new Map();

						/** @type {ExecuteModuleResult["fileDependencies"]} */
						const fileDependencies = new LazySet();
						/** @type {ExecuteModuleResult["contextDependencies"]} */
						const contextDependencies = new LazySet();
						/** @type {ExecuteModuleResult["missingDependencies"]} */
						const missingDependencies = new LazySet();
						/** @type {ExecuteModuleResult["buildDependencies"]} */
						const buildDependencies = new LazySet();

						/** @type {ExecuteModuleResult["assets"]} */
						const assets = new Map();

						let cacheable = true;

						/** @type {ExecuteModuleContext} */
						const context = {
							assets,
							__webpack_require__: undefined,
							chunk,
							chunkGraph
						};

						// Prepare execution
						asyncLib.eachLimit(
							modules,
							10,
							(module, callback) => {
								const codeGenerationResult = codeGenerationResults.get(
									module,
									runtime
								);
								/** @type {ExecuteModuleArgument} */
								const moduleArgument = {
									module,
									codeGenerationResult,
									preparedInfo: undefined,
									moduleObject: undefined
								};
								moduleArgumentsMap.set(module, moduleArgument);
								moduleArgumentsById.set(module.identifier(), moduleArgument);
								module.addCacheDependencies(
									fileDependencies,
									contextDependencies,
									missingDependencies,
									buildDependencies
								);
								if (module.buildInfo.cacheable === false) {
									cacheable = false;
								}
								if (module.buildInfo && module.buildInfo.assets) {
									const { assets: moduleAssets, assetsInfo } = module.buildInfo;
									for (const assetName of Object.keys(moduleAssets)) {
										assets.set(assetName, {
											source: moduleAssets[assetName],
											info: assetsInfo ? assetsInfo.get(assetName) : undefined
										});
									}
								}
								this.hooks.prepareModuleExecution.callAsync(
									moduleArgument,
									context,
									callback
								);
							},
							err => {
								if (err) return callback(err);

								let exports;
								try {
									const {
										strictModuleErrorHandling,
										strictModuleExceptionHandling
									} = this.outputOptions;
									const __webpack_require__ = id => {
										const cached = moduleCache[id];
										if (cached !== undefined) {
											if (cached.error) throw cached.error;
											return cached.exports;
										}
										const moduleArgument = moduleArgumentsById.get(id);
										return __webpack_require_module__(moduleArgument, id);
									};
									const interceptModuleExecution = (__webpack_require__[
										RuntimeGlobals.interceptModuleExecution.replace(
											`${RuntimeGlobals.require}.`,
											""
										)
									] = []);
									const moduleCache = (__webpack_require__[
										RuntimeGlobals.moduleCache.replace(
											`${RuntimeGlobals.require}.`,
											""
										)
									] = {});

									context.__webpack_require__ = __webpack_require__;

									/**
									 * @param {ExecuteModuleArgument} moduleArgument the module argument
									 * @param {string=} id id
									 * @returns {any} exports
									 */
									const __webpack_require_module__ = (moduleArgument, id) => {
										var execOptions = {
											id,
											module: {
												id,
												exports: {},
												loaded: false,
												error: undefined
											},
											require: __webpack_require__
										};
										interceptModuleExecution.forEach(handler =>
											handler(execOptions)
										);
										const module = moduleArgument.module;
										this.buildTimeExecutedModules.add(module);
										const moduleObject = execOptions.module;
										moduleArgument.moduleObject = moduleObject;
										try {
											if (id) moduleCache[id] = moduleObject;

											tryRunOrWebpackError(
												() =>
													this.hooks.executeModule.call(
														moduleArgument,
														context
													),
												"Compilation.hooks.executeModule"
											);
											moduleObject.loaded = true;
											return moduleObject.exports;
										} catch (e) {
											if (strictModuleExceptionHandling) {
												if (id) delete moduleCache[id];
											} else if (strictModuleErrorHandling) {
												moduleObject.error = e;
											}
											if (!e.module) e.module = module;
											throw e;
										}
									};

									for (const runtimeModule of chunkGraph.getChunkRuntimeModulesInOrder(
										chunk
									)) {
										__webpack_require_module__(
											moduleArgumentsMap.get(runtimeModule)
										);
									}
									exports = __webpack_require__(module.identifier());
								} catch (e) {
									const err = new WebpackError(
										`Execution of module code from module graph (${module.readableIdentifier(
											this.requestShortener
										)}) failed: ${e.message}`
									);
									err.stack = e.stack;
									err.module = e.module;
									return callback(err);
								}

								callback(null, {
									exports,
									assets,
									cacheable,
									fileDependencies,
									contextDependencies,
									missingDependencies,
									buildDependencies
								});
							}
						);
					});
				});
			}
		);
	}

	checkConstraints() {
		const chunkGraph = this.chunkGraph;

		/** @type {Set<number|string>} */
		const usedIds = new Set();

		for (const module of this.modules) {
			if (module.type === WEBPACK_MODULE_TYPE_RUNTIME) continue;
			const moduleId = chunkGraph.getModuleId(module);
			if (moduleId === null) continue;
			if (usedIds.has(moduleId)) {
				throw new Error(`checkConstraints: duplicate module id ${moduleId}`);
			}
			usedIds.add(moduleId);
		}

		for (const chunk of this.chunks) {
			for (const module of chunkGraph.getChunkModulesIterable(chunk)) {
				if (!this.modules.has(module)) {
					throw new Error(
						"checkConstraints: module in chunk but not in compilation " +
							` ${chunk.debugId} ${module.debugId}`
					);
				}
			}
			for (const module of chunkGraph.getChunkEntryModulesIterable(chunk)) {
				if (!this.modules.has(module)) {
					throw new Error(
						"checkConstraints: entry module in chunk but not in compilation " +
							` ${chunk.debugId} ${module.debugId}`
					);
				}
			}
		}

		for (const chunkGroup of this.chunkGroups) {
			chunkGroup.checkConstraints();
		}
	}
}

/**
 * @typedef {Object} FactorizeModuleOptions
 * @property {ModuleProfile} currentProfile
 * @property {ModuleFactory} factory
 * @property {Dependency[]} dependencies
 * @property {boolean=} factoryResult return full ModuleFactoryResult instead of only module
 * @property {Module | null} originModule
 * @property {Partial<ModuleFactoryCreateDataContextInfo>=} contextInfo
 * @property {string=} context
 */

/**
 * @param {FactorizeModuleOptions} options options object
 * @param {ModuleCallback | ModuleFactoryResultCallback} callback callback
 * @returns {void}
 */

// Workaround for typescript as it doesn't support function overloading in jsdoc within a class
Compilation.prototype.factorizeModule = /** @type {{
	(options: FactorizeModuleOptions & { factoryResult?: false }, callback: ModuleCallback): void;
	(options: FactorizeModuleOptions & { factoryResult: true }, callback: ModuleFactoryResultCallback): void;
}} */ (
	function (options, callback) {
		this.factorizeQueue.add(options, callback);
	}
);

// Hide from typescript
const compilationPrototype = Compilation.prototype;

// TODO webpack 6 remove
Object.defineProperty(compilationPrototype, "modifyHash", {
	writable: false,
	enumerable: false,
	configurable: false,
	value: () => {
		throw new Error(
			"Compilation.modifyHash was removed in favor of Compilation.hooks.fullHash"
		);
	}
});

// TODO webpack 6 remove
Object.defineProperty(compilationPrototype, "cache", {
	enumerable: false,
	configurable: false,
	get: util.deprecate(
		/**
		 * @this {Compilation} the compilation
		 * @returns {Cache} the cache
		 */
		function () {
			return this.compiler.cache;
		},
		"Compilation.cache was removed in favor of Compilation.getCache()",
		"DEP_WEBPACK_COMPILATION_CACHE"
	),
	set: util.deprecate(
		v => {},
		"Compilation.cache was removed in favor of Compilation.getCache()",
		"DEP_WEBPACK_COMPILATION_CACHE"
	)
});

/**
 * Add additional assets to the compilation.
 */
Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL = -2000;

/**
 * Basic preprocessing of assets.
 */
Compilation.PROCESS_ASSETS_STAGE_PRE_PROCESS = -1000;

/**
 * Derive new assets from existing assets.
 * Existing assets should not be treated as complete.
 */
Compilation.PROCESS_ASSETS_STAGE_DERIVED = -200;

/**
 * Add additional sections to existing assets, like a banner or initialization code.
 */
Compilation.PROCESS_ASSETS_STAGE_ADDITIONS = -100;

/**
 * Optimize existing assets in a general way.
 */
Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE = 100;

/**
 * Optimize the count of existing assets, e. g. by merging them.
 * Only assets of the same type should be merged.
 * For assets of different types see PROCESS_ASSETS_STAGE_OPTIMIZE_INLINE.
 */
Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_COUNT = 200;

/**
 * Optimize the compatibility of existing assets, e. g. add polyfills or vendor-prefixes.
 */
Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_COMPATIBILITY = 300;

/**
 * Optimize the size of existing assets, e. g. by minimizing or omitting whitespace.
 */
Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_SIZE = 400;

/**
 * Add development tooling to assets, e. g. by extracting a SourceMap.
 */
Compilation.PROCESS_ASSETS_STAGE_DEV_TOOLING = 500;

/**
 * Optimize the count of existing assets, e. g. by inlining assets of into other assets.
 * Only assets of different types should be inlined.
 * For assets of the same type see PROCESS_ASSETS_STAGE_OPTIMIZE_COUNT.
 */
Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_INLINE = 700;

/**
 * Summarize the list of existing assets
 * e. g. creating an assets manifest of Service Workers.
 */
Compilation.PROCESS_ASSETS_STAGE_SUMMARIZE = 1000;

/**
 * Optimize the hashes of the assets, e. g. by generating real hashes of the asset content.
 */
Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_HASH = 2500;

/**
 * Optimize the transfer of existing assets, e. g. by preparing a compressed (gzip) file as separate asset.
 */
Compilation.PROCESS_ASSETS_STAGE_OPTIMIZE_TRANSFER = 3000;

/**
 * Analyse existing assets.
 */
Compilation.PROCESS_ASSETS_STAGE_ANALYSE = 4000;

/**
 * Creating assets for reporting purposes.
 */
Compilation.PROCESS_ASSETS_STAGE_REPORT = 5000;

module.exports = Compilation;
