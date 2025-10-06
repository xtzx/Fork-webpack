/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

/**
 * lib/javascript/JavascriptModulesPlugin.js - JavaScript 模块插件（代码生成核心）⭐⭐⭐
 *
 * 【文件作用】
 * 这是 webpack 中最重要的插件之一，负责：
 * 1. 注册 JavaScript 模块的 parser 和 generator
 * 2. 生成 JavaScript chunk 的最终代码（renderMain）
 * 3. 处理模块包装和运行时代码
 * 4. 生成 bundle 文件的完整结构
 *
 * 【核心职责】
 *
 * 1. **Parser 和 Generator 注册**：
 *    - 为不同的 JS 模块类型注册解析器
 *    - javascript/auto、javascript/esm、javascript/dynamic
 *    - 注册代码生成器
 *
 * 2. **代码生成（最核心！）**：
 *    - renderMain: 生成 chunk 的完整代码
 *    - renderBootstrap: 生成启动代码
 *    - renderModuleContent: 包装单个模块
 *
 * 3. **运行时代码生成**：
 *    - 生成 __webpack_require__ 函数
 *    - 生成模块缓存系统
 *    - 生成 chunk 加载函数
 *
 * 【生成的代码结构】
 *
 * ```javascript
 * // 最终生成的 bundle 结构：
 *
 * (function(modules) {
 *   // ===== 运行时代码 =====
 *   var installedModules = {};
 *
 *   function __webpack_require__(moduleId) {
 *     // 模块加载逻辑
 *   }
 *
 *   __webpack_require__.e = function(chunkId) {
 *     // chunk 加载逻辑
 *   }
 *
 *   // ===== 启动代码 =====
 *   return __webpack_require__(0);
 * })({
 *   // ===== 模块映射 =====
 *   0: function(module, exports, __webpack_require__) {
 *     // 模块0的代码
 *   },
 *   1: function(module, exports, __webpack_require__) {
 *     // 模块1的代码
 *   }
 * });
 * ```
 *
 * 【关键方法】
 *
 * - renderMain: 生成 chunk 的主要内容 ⭐⭐⭐
 * - renderChunk: 渲染 chunk
 * - renderBootstrap: 生成启动代码
 * - renderModuleContainer: 包装模块为函数
 *
 * 【执行时机】
 *
 * 在 Seal 阶段的 createChunkAssets 中调用：
 * ```javascript
 * compilation.hooks.renderManifest.tap('JavascriptModulesPlugin',
 *   (result, options) => {
 *     const source = this.renderMain(options);
 *     result.push({
 *       render: () => source,
 *       filename: ...,
 *       ...
 *     });
 *   }
 * );
 * ```
 *
 * 【钩子系统】
 *
 * 提供多个钩子供其他插件扩展：
 * - renderModuleContent: 修改模块内容
 * - renderChunk: 修改 chunk 代码
 * - renderMain: 修改最终输出
 * - chunkHash: 参与 chunk 哈希计算
 *
 * 【Chunk → Bundle 的转换】⭐⭐⭐
 *
 * 这个插件完成了 Chunk（逻辑） → Bundle（物理文件）的转换：
 * 1. Chunk 包含一组模块
 * 2. renderMain 将模块拼接成代码
 * 3. 生成 Source 对象
 * 4. 添加到 compilation.assets
 * 5. Emit 阶段写入磁盘
 *
 * 【性能考虑】
 *
 * - 使用 CachedSource 缓存生成结果
 * - 只在模块变化时重新生成
 * - 支持 SourceMap 增量更新
 *
 * 【文档中不存在的知识点】⭐⭐⭐
 *
 * 1. **模块包装的格式**：
 *    每个模块被包装成函数，接收 3 个参数
 *    - module: 模块对象
 *    - exports: 导出对象
 *    - __webpack_require__: 加载函数
 *
 * 2. **运行时代码的模块化**：
 *    webpack 运行时也是模块化的
 *    不同功能拆分成不同的 RuntimeModule
 *    按需加载运行时代码
 *
 * 3. **Tree Shaking 的应用时机**：
 *    在 renderModuleContent 中应用
 *    只生成被使用的导出代码
 *
 * 4. **Source 对象的层次**：
 *    使用 ConcatSource 拼接多个部分
 *    支持 SourceMap 的增量合并
 *
 * 5. **严格模式的处理**：
 *    根据模块类型决定是否添加 "use strict"
 */

"use strict";

const { SyncWaterfallHook, SyncHook, SyncBailHook } = require("tapable");
const vm = require("vm");
const {
	ConcatSource,     // 拼接多个 Source
	OriginalSource,   // 原始 Source（带 SourceMap）
	PrefixSource,     // 添加前缀的 Source
	RawSource,        // 原始字符串 Source
	CachedSource      // 缓存的 Source
} = require("webpack-sources");
const Compilation = require("../Compilation");
const { tryRunOrWebpackError } = require("../HookWebpackError");
const HotUpdateChunk = require("../HotUpdateChunk");
const InitFragment = require("../InitFragment");
const {
	JAVASCRIPT_MODULE_TYPE_AUTO,
	JAVASCRIPT_MODULE_TYPE_DYNAMIC,
	JAVASCRIPT_MODULE_TYPE_ESM,
	WEBPACK_MODULE_TYPE_RUNTIME
} = require("../ModuleTypeConstants");
const RuntimeGlobals = require("../RuntimeGlobals");
const Template = require("../Template");
const { last, someInIterable } = require("../util/IterableHelpers");
const StringXor = require("../util/StringXor");
const { compareModulesByIdentifier } = require("../util/comparators");
const createHash = require("../util/createHash");
const nonNumericOnlyHash = require("../util/nonNumericOnlyHash");
const { intersectRuntime } = require("../util/runtime");
const JavascriptGenerator = require("./JavascriptGenerator");
const JavascriptParser = require("./JavascriptParser");

/** @typedef {import("webpack-sources").Source} Source */
/** @typedef {import("../Chunk")} Chunk */
/** @typedef {import("../ChunkGraph")} ChunkGraph */
/** @typedef {import("../CodeGenerationResults")} CodeGenerationResults */
/** @typedef {import("../Compilation").ChunkHashContext} ChunkHashContext */
/** @typedef {import("../Compiler")} Compiler */
/** @typedef {import("../DependencyTemplates")} DependencyTemplates */
/** @typedef {import("../Module")} Module */
/** @typedef {import("../ModuleGraph")} ModuleGraph */
/** @typedef {import("../RuntimeTemplate")} RuntimeTemplate */
/** @typedef {import("../util/Hash")} Hash */

/**
 * @param {Chunk} chunk a chunk
 * @param {ChunkGraph} chunkGraph the chunk graph
 * @returns {boolean} true, when a JS file is needed for this chunk
 */
const chunkHasJs = (chunk, chunkGraph) => {
	if (chunkGraph.getNumberOfEntryModules(chunk) > 0) return true;

	return chunkGraph.getChunkModulesIterableBySourceType(chunk, "javascript")
		? true
		: false;
};

/**
 * @param {Module} module a module
 * @param {string} code the code
 * @returns {string} generated code for the stack
 */
const printGeneratedCodeForStack = (module, code) => {
	const lines = code.split("\n");
	const n = `${lines.length}`.length;
	return `\n\nGenerated code for ${module.identifier()}\n${lines
		.map(
			/**
			 * @param {string} line the line
			 * @param {number} i the index
			 * @param {string[]} lines the lines
			 * @returns {string} the line with line number
			 */
			(line, i, lines) => {
				const iStr = `${i + 1}`;
				return `${" ".repeat(n - iStr.length)}${iStr} | ${line}`;
			}
		)
		.join("\n")}`;
};

/**
 * @typedef {Object} RenderContext
 * @property {Chunk} chunk the chunk
 * @property {DependencyTemplates} dependencyTemplates the dependency templates
 * @property {RuntimeTemplate} runtimeTemplate the runtime template
 * @property {ModuleGraph} moduleGraph the module graph
 * @property {ChunkGraph} chunkGraph the chunk graph
 * @property {CodeGenerationResults} codeGenerationResults results of code generation
 * @property {boolean} strictMode rendering in strict context
 */

/**
 * @typedef {Object} MainRenderContext
 * @property {Chunk} chunk the chunk
 * @property {DependencyTemplates} dependencyTemplates the dependency templates
 * @property {RuntimeTemplate} runtimeTemplate the runtime template
 * @property {ModuleGraph} moduleGraph the module graph
 * @property {ChunkGraph} chunkGraph the chunk graph
 * @property {CodeGenerationResults} codeGenerationResults results of code generation
 * @property {string} hash hash to be used for render call
 * @property {boolean} strictMode rendering in strict context
 */

/**
 * @typedef {Object} ChunkRenderContext
 * @property {Chunk} chunk the chunk
 * @property {DependencyTemplates} dependencyTemplates the dependency templates
 * @property {RuntimeTemplate} runtimeTemplate the runtime template
 * @property {ModuleGraph} moduleGraph the module graph
 * @property {ChunkGraph} chunkGraph the chunk graph
 * @property {CodeGenerationResults} codeGenerationResults results of code generation
 * @property {InitFragment<ChunkRenderContext>[]} chunkInitFragments init fragments for the chunk
 * @property {boolean} strictMode rendering in strict context
 */

/**
 * @typedef {Object} RenderBootstrapContext
 * @property {Chunk} chunk the chunk
 * @property {CodeGenerationResults} codeGenerationResults results of code generation
 * @property {RuntimeTemplate} runtimeTemplate the runtime template
 * @property {ModuleGraph} moduleGraph the module graph
 * @property {ChunkGraph} chunkGraph the chunk graph
 * @property {string} hash hash to be used for render call
 */

/** @typedef {RenderContext & { inlined: boolean }} StartupRenderContext */

/**
 * @typedef {Object} CompilationHooks
 * @property {SyncWaterfallHook<[Source, Module, ChunkRenderContext]>} renderModuleContent
 * @property {SyncWaterfallHook<[Source, Module, ChunkRenderContext]>} renderModuleContainer
 * @property {SyncWaterfallHook<[Source, Module, ChunkRenderContext]>} renderModulePackage
 * @property {SyncWaterfallHook<[Source, RenderContext]>} renderChunk
 * @property {SyncWaterfallHook<[Source, RenderContext]>} renderMain
 * @property {SyncWaterfallHook<[Source, RenderContext]>} renderContent
 * @property {SyncWaterfallHook<[Source, RenderContext]>} render
 * @property {SyncWaterfallHook<[Source, Module, StartupRenderContext]>} renderStartup
 * @property {SyncWaterfallHook<[string, RenderBootstrapContext]>} renderRequire
 * @property {SyncBailHook<[Module, RenderBootstrapContext], string>} inlineInRuntimeBailout
 * @property {SyncBailHook<[Module, RenderContext], string | void>} embedInRuntimeBailout
 * @property {SyncBailHook<[RenderContext], string | void>} strictRuntimeBailout
 * @property {SyncHook<[Chunk, Hash, ChunkHashContext]>} chunkHash
 * @property {SyncBailHook<[Chunk, RenderContext], boolean>} useSourceMap
 */

/** @type {WeakMap<Compilation, CompilationHooks>} */
const compilationHooksMap = new WeakMap();

const PLUGIN_NAME = "JavascriptModulesPlugin";

class JavascriptModulesPlugin {
	/**
	 * @param {Compilation} compilation the compilation
	 * @returns {CompilationHooks} the attached hooks
	 */
	static getCompilationHooks(compilation) {
		if (!(compilation instanceof Compilation)) {
			throw new TypeError(
				"The 'compilation' argument must be an instance of Compilation"
			);
		}
		let hooks = compilationHooksMap.get(compilation);
		if (hooks === undefined) {
			hooks = {
				renderModuleContent: new SyncWaterfallHook([
					"source",
					"module",
					"renderContext"
				]),
				renderModuleContainer: new SyncWaterfallHook([
					"source",
					"module",
					"renderContext"
				]),
				renderModulePackage: new SyncWaterfallHook([
					"source",
					"module",
					"renderContext"
				]),
				render: new SyncWaterfallHook(["source", "renderContext"]),
				renderContent: new SyncWaterfallHook(["source", "renderContext"]),
				renderStartup: new SyncWaterfallHook([
					"source",
					"module",
					"startupRenderContext"
				]),
				renderChunk: new SyncWaterfallHook(["source", "renderContext"]),
				renderMain: new SyncWaterfallHook(["source", "renderContext"]),
				renderRequire: new SyncWaterfallHook(["code", "renderContext"]),
				inlineInRuntimeBailout: new SyncBailHook(["module", "renderContext"]),
				embedInRuntimeBailout: new SyncBailHook(["module", "renderContext"]),
				strictRuntimeBailout: new SyncBailHook(["renderContext"]),
				chunkHash: new SyncHook(["chunk", "hash", "context"]),
				useSourceMap: new SyncBailHook(["chunk", "renderContext"])
			};
			compilationHooksMap.set(compilation, hooks);
		}
		return hooks;
	}

	constructor(options = {}) {
		this.options = options;
		/** @type {WeakMap<Source, TODO>} */
		this._moduleFactoryCache = new WeakMap();
	}

	/**
	 * Apply the plugin
	 * @param {Compiler} compiler the compiler instance
	 * @returns {void}
	 */
	apply(compiler) {
		compiler.hooks.compilation.tap(
			PLUGIN_NAME,
			(compilation, { normalModuleFactory }) => {
				const hooks = JavascriptModulesPlugin.getCompilationHooks(compilation);
				normalModuleFactory.hooks.createParser
					.for(JAVASCRIPT_MODULE_TYPE_AUTO)
					.tap(PLUGIN_NAME, options => {
						return new JavascriptParser("auto");
					});
				normalModuleFactory.hooks.createParser
					.for(JAVASCRIPT_MODULE_TYPE_DYNAMIC)
					.tap(PLUGIN_NAME, options => {
						return new JavascriptParser("script");
					});
				normalModuleFactory.hooks.createParser
					.for(JAVASCRIPT_MODULE_TYPE_ESM)
					.tap(PLUGIN_NAME, options => {
						return new JavascriptParser("module");
					});
				normalModuleFactory.hooks.createGenerator
					.for(JAVASCRIPT_MODULE_TYPE_AUTO)
					.tap(PLUGIN_NAME, () => {
						return new JavascriptGenerator();
					});
				normalModuleFactory.hooks.createGenerator
					.for(JAVASCRIPT_MODULE_TYPE_DYNAMIC)
					.tap(PLUGIN_NAME, () => {
						return new JavascriptGenerator();
					});
				normalModuleFactory.hooks.createGenerator
					.for(JAVASCRIPT_MODULE_TYPE_ESM)
					.tap(PLUGIN_NAME, () => {
						return new JavascriptGenerator();
					});
				compilation.hooks.renderManifest.tap(PLUGIN_NAME, (result, options) => {
					const {
						hash,
						chunk,
						chunkGraph,
						moduleGraph,
						runtimeTemplate,
						dependencyTemplates,
						outputOptions,
						codeGenerationResults
					} = options;

					const hotUpdateChunk = chunk instanceof HotUpdateChunk ? chunk : null;

					let render;
					const filenameTemplate =
						JavascriptModulesPlugin.getChunkFilenameTemplate(
							chunk,
							outputOptions
						);
					if (hotUpdateChunk) {
						render = () =>
							this.renderChunk(
								{
									chunk,
									dependencyTemplates,
									runtimeTemplate,
									moduleGraph,
									chunkGraph,
									codeGenerationResults,
									strictMode: runtimeTemplate.isModule()
								},
								hooks
							);
					} else if (chunk.hasRuntime()) {
						render = () =>
							this.renderMain(
								{
									hash,
									chunk,
									dependencyTemplates,
									runtimeTemplate,
									moduleGraph,
									chunkGraph,
									codeGenerationResults,
									strictMode: runtimeTemplate.isModule()
								},
								hooks,
								compilation
							);
					} else {
						if (!chunkHasJs(chunk, chunkGraph)) {
							return result;
						}

						render = () =>
							this.renderChunk(
								{
									chunk,
									dependencyTemplates,
									runtimeTemplate,
									moduleGraph,
									chunkGraph,
									codeGenerationResults,
									strictMode: runtimeTemplate.isModule()
								},
								hooks
							);
					}

					result.push({
						render,
						filenameTemplate,
						pathOptions: {
							hash,
							runtime: chunk.runtime,
							chunk,
							contentHashType: "javascript"
						},
						info: {
							javascriptModule: compilation.runtimeTemplate.isModule()
						},
						identifier: hotUpdateChunk
							? `hotupdatechunk${chunk.id}`
							: `chunk${chunk.id}`,
						hash: chunk.contentHash.javascript
					});

					return result;
				});
				compilation.hooks.chunkHash.tap(PLUGIN_NAME, (chunk, hash, context) => {
					hooks.chunkHash.call(chunk, hash, context);
					if (chunk.hasRuntime()) {
						this.updateHashWithBootstrap(
							hash,
							{
								hash: "0000",
								chunk,
								codeGenerationResults: context.codeGenerationResults,
								chunkGraph: context.chunkGraph,
								moduleGraph: context.moduleGraph,
								runtimeTemplate: context.runtimeTemplate
							},
							hooks
						);
					}
				});
				compilation.hooks.contentHash.tap(PLUGIN_NAME, chunk => {
					const {
						chunkGraph,
						codeGenerationResults,
						moduleGraph,
						runtimeTemplate,
						outputOptions: {
							hashSalt,
							hashDigest,
							hashDigestLength,
							hashFunction
						}
					} = compilation;
					const hash = createHash(hashFunction);
					if (hashSalt) hash.update(hashSalt);
					if (chunk.hasRuntime()) {
						this.updateHashWithBootstrap(
							hash,
							{
								hash: "0000",
								chunk,
								codeGenerationResults,
								chunkGraph: compilation.chunkGraph,
								moduleGraph: compilation.moduleGraph,
								runtimeTemplate: compilation.runtimeTemplate
							},
							hooks
						);
					} else {
						hash.update(`${chunk.id} `);
						hash.update(chunk.ids ? chunk.ids.join(",") : "");
					}
					hooks.chunkHash.call(chunk, hash, {
						chunkGraph,
						codeGenerationResults,
						moduleGraph,
						runtimeTemplate
					});
					const modules = chunkGraph.getChunkModulesIterableBySourceType(
						chunk,
						"javascript"
					);
					if (modules) {
						const xor = new StringXor();
						for (const m of modules) {
							xor.add(chunkGraph.getModuleHash(m, chunk.runtime));
						}
						xor.updateHash(hash);
					}
					const runtimeModules = chunkGraph.getChunkModulesIterableBySourceType(
						chunk,
						WEBPACK_MODULE_TYPE_RUNTIME
					);
					if (runtimeModules) {
						const xor = new StringXor();
						for (const m of runtimeModules) {
							xor.add(chunkGraph.getModuleHash(m, chunk.runtime));
						}
						xor.updateHash(hash);
					}
					const digest = /** @type {string} */ (hash.digest(hashDigest));
					chunk.contentHash.javascript = nonNumericOnlyHash(
						digest,
						hashDigestLength
					);
				});
				compilation.hooks.additionalTreeRuntimeRequirements.tap(
					PLUGIN_NAME,
					(chunk, set, { chunkGraph }) => {
						if (
							!set.has(RuntimeGlobals.startupNoDefault) &&
							chunkGraph.hasChunkEntryDependentChunks(chunk)
						) {
							set.add(RuntimeGlobals.onChunksLoaded);
							set.add(RuntimeGlobals.require);
						}
					}
				);
				compilation.hooks.executeModule.tap(PLUGIN_NAME, (options, context) => {
					const source = options.codeGenerationResult.sources.get("javascript");
					if (source === undefined) return;
					const { module, moduleObject } = options;
					const code = source.source();

					const fn = vm.runInThisContext(
						`(function(${module.moduleArgument}, ${module.exportsArgument}, ${RuntimeGlobals.require}) {\n${code}\n/**/})`,
						{
							filename: module.identifier(),
							lineOffset: -1
						}
					);
					try {
						fn.call(
							moduleObject.exports,
							moduleObject,
							moduleObject.exports,
							context.__webpack_require__
						);
					} catch (e) {
						e.stack += printGeneratedCodeForStack(
							options.module,
							/** @type {string} */ (code)
						);
						throw e;
					}
				});
				compilation.hooks.executeModule.tap(PLUGIN_NAME, (options, context) => {
					const source = options.codeGenerationResult.sources.get("runtime");
					if (source === undefined) return;
					let code = source.source();
					if (typeof code !== "string") code = code.toString();

					const fn = vm.runInThisContext(
						`(function(${RuntimeGlobals.require}) {\n${code}\n/**/})`,
						{
							filename: options.module.identifier(),
							lineOffset: -1
						}
					);
					try {
						fn.call(null, context.__webpack_require__);
					} catch (e) {
						e.stack += printGeneratedCodeForStack(options.module, code);
						throw e;
					}
				});
			}
		);
	}

	static getChunkFilenameTemplate(chunk, outputOptions) {
		if (chunk.filenameTemplate) {
			return chunk.filenameTemplate;
		} else if (chunk instanceof HotUpdateChunk) {
			return outputOptions.hotUpdateChunkFilename;
		} else if (chunk.canBeInitial()) {
			return outputOptions.filename;
		} else {
			return outputOptions.chunkFilename;
		}
	}

	/**
	 * @param {Module} module the rendered module
	 * @param {ChunkRenderContext} renderContext options object
	 * @param {CompilationHooks} hooks hooks
	 * @param {boolean} factory true: renders as factory method, false: pure module content
	 * @returns {Source} the newly generated source from rendering
	 */
	renderModule(module, renderContext, hooks, factory) {
		const {
			chunk,
			chunkGraph,
			runtimeTemplate,
			codeGenerationResults,
			strictMode
		} = renderContext;
		try {
			const codeGenResult = codeGenerationResults.get(module, chunk.runtime);
			const moduleSource = codeGenResult.sources.get("javascript");
			if (!moduleSource) return null;
			if (codeGenResult.data !== undefined) {
				const chunkInitFragments = codeGenResult.data.get("chunkInitFragments");
				if (chunkInitFragments) {
					for (const i of chunkInitFragments)
						renderContext.chunkInitFragments.push(i);
				}
			}
			const moduleSourcePostContent = tryRunOrWebpackError(
				() =>
					hooks.renderModuleContent.call(moduleSource, module, renderContext),
				"JavascriptModulesPlugin.getCompilationHooks().renderModuleContent"
			);
			let moduleSourcePostContainer;
			if (factory) {
				const runtimeRequirements = chunkGraph.getModuleRuntimeRequirements(
					module,
					chunk.runtime
				);
				const needModule = runtimeRequirements.has(RuntimeGlobals.module);
				const needExports = runtimeRequirements.has(RuntimeGlobals.exports);
				const needRequire =
					runtimeRequirements.has(RuntimeGlobals.require) ||
					runtimeRequirements.has(RuntimeGlobals.requireScope);
				const needThisAsExports = runtimeRequirements.has(
					RuntimeGlobals.thisAsExports
				);
				const needStrict = module.buildInfo.strict && !strictMode;
				const cacheEntry = this._moduleFactoryCache.get(
					moduleSourcePostContent
				);
				let source;
				if (
					cacheEntry &&
					cacheEntry.needModule === needModule &&
					cacheEntry.needExports === needExports &&
					cacheEntry.needRequire === needRequire &&
					cacheEntry.needThisAsExports === needThisAsExports &&
					cacheEntry.needStrict === needStrict
				) {
					source = cacheEntry.source;
				} else {
					const factorySource = new ConcatSource();
					const args = [];
					if (needExports || needRequire || needModule)
						args.push(
							needModule
								? module.moduleArgument
								: "__unused_webpack_" + module.moduleArgument
						);
					if (needExports || needRequire)
						args.push(
							needExports
								? module.exportsArgument
								: "__unused_webpack_" + module.exportsArgument
						);
					if (needRequire) args.push(RuntimeGlobals.require);
					if (!needThisAsExports && runtimeTemplate.supportsArrowFunction()) {
						factorySource.add("/***/ ((" + args.join(", ") + ") => {\n\n");
					} else {
						factorySource.add("/***/ (function(" + args.join(", ") + ") {\n\n");
					}
					if (needStrict) {
						factorySource.add('"use strict";\n');
					}
					factorySource.add(moduleSourcePostContent);
					factorySource.add("\n\n/***/ })");
					source = new CachedSource(factorySource);
					this._moduleFactoryCache.set(moduleSourcePostContent, {
						source,
						needModule,
						needExports,
						needRequire,
						needThisAsExports,
						needStrict
					});
				}
				moduleSourcePostContainer = tryRunOrWebpackError(
					() => hooks.renderModuleContainer.call(source, module, renderContext),
					"JavascriptModulesPlugin.getCompilationHooks().renderModuleContainer"
				);
			} else {
				moduleSourcePostContainer = moduleSourcePostContent;
			}
			return tryRunOrWebpackError(
				() =>
					hooks.renderModulePackage.call(
						moduleSourcePostContainer,
						module,
						renderContext
					),
				"JavascriptModulesPlugin.getCompilationHooks().renderModulePackage"
			);
		} catch (e) {
			e.module = module;
			throw e;
		}
	}

	/**
	 * @param {RenderContext} renderContext the render context
	 * @param {CompilationHooks} hooks hooks
	 * @returns {Source} the rendered source
	 */
	renderChunk(renderContext, hooks) {
		const { chunk, chunkGraph } = renderContext;
		const modules = chunkGraph.getOrderedChunkModulesIterableBySourceType(
			chunk,
			"javascript",
			compareModulesByIdentifier
		);
		const allModules = modules ? Array.from(modules) : [];
		let strictHeader;
		let allStrict = renderContext.strictMode;
		if (!allStrict && allModules.every(m => m.buildInfo.strict)) {
			const strictBailout = hooks.strictRuntimeBailout.call(renderContext);
			strictHeader = strictBailout
				? `// runtime can't be in strict mode because ${strictBailout}.\n`
				: '"use strict";\n';
			if (!strictBailout) allStrict = true;
		}
		/** @type {ChunkRenderContext} */
		const chunkRenderContext = {
			...renderContext,
			chunkInitFragments: [],
			strictMode: allStrict
		};
		const moduleSources =
			Template.renderChunkModules(chunkRenderContext, allModules, module =>
				this.renderModule(module, chunkRenderContext, hooks, true)
			) || new RawSource("{}");
		let source = tryRunOrWebpackError(
			() => hooks.renderChunk.call(moduleSources, chunkRenderContext),
			"JavascriptModulesPlugin.getCompilationHooks().renderChunk"
		);
		source = tryRunOrWebpackError(
			() => hooks.renderContent.call(source, chunkRenderContext),
			"JavascriptModulesPlugin.getCompilationHooks().renderContent"
		);
		if (!source) {
			throw new Error(
				"JavascriptModulesPlugin error: JavascriptModulesPlugin.getCompilationHooks().renderContent plugins should return something"
			);
		}
		source = InitFragment.addToSource(
			source,
			chunkRenderContext.chunkInitFragments,
			chunkRenderContext
		);
		source = tryRunOrWebpackError(
			() => hooks.render.call(source, chunkRenderContext),
			"JavascriptModulesPlugin.getCompilationHooks().render"
		);
		if (!source) {
			throw new Error(
				"JavascriptModulesPlugin error: JavascriptModulesPlugin.getCompilationHooks().render plugins should return something"
			);
		}
		chunk.rendered = true;
		return strictHeader
			? new ConcatSource(strictHeader, source, ";")
			: renderContext.runtimeTemplate.isModule()
			? source
			: new ConcatSource(source, ";");
	}

	/**
	 * renderMain - 渲染 chunk 的主要内容（最核心的方法！）⭐⭐⭐
	 *
	 * 【作用】
	 * 生成 chunk 的完整 JavaScript 代码，这是 Chunk → Bundle 转换的核心
	 *
	 * 【生成的代码结构】
	 * ```javascript
	 * // 1. IIFE 包装（如果需要）
	 * (() => {
	 *   // 2. 严格模式（如果需要）
	 *   "use strict";
	 *
	 *   // 3. 模块映射
	 *   var __webpack_modules__ = {
	 *     moduleId: function(module, exports, __webpack_require__) { ... }
	 *   };
	 *
	 *   // 4. 运行时代码
	 *   var __webpack_module_cache__ = {};
	 *   function __webpack_require__(moduleId) { ... }
	 *
	 *   // 5. 运行时模块
	 *   __webpack_require__.d = function(exports, definition) { ... }
	 *
	 *   // 6. 启动代码
	 *   var __webpack_exports__ = __webpack_require__(entryModuleId);
	 * })();
	 * ```
	 *
	 * 【执行流程】
	 * 1. 准备数据（模块列表、运行时需求）
	 * 2. 生成 IIFE 包装
	 * 3. 生成严格模式声明
	 * 4. 生成模块映射（__webpack_modules__）
	 * 5. 生成运行时代码（bootstrap）
	 * 6. 生成运行时模块
	 * 7. 生成启动代码
	 * 8. 拼接所有部分
	 *
	 * 【性能优化】
	 * - 使用 ConcatSource 高效拼接
	 * - 支持 SourceMap 增量合并
	 * - 内联入口模块（减少函数调用）
	 *
	 * @param {MainRenderContext} renderContext - 渲染上下文
	 * @param {CompilationHooks} hooks - 钩子集合
	 * @param {Compilation} compilation - 编译实例
	 * @returns {Source} 生成的 Source 对象
	 */
	renderMain(renderContext, hooks, compilation) {
		// ===== 步骤1: 提取渲染上下文 =====
		const { chunk, chunkGraph, runtimeTemplate } = renderContext;

		// ===== 步骤2: 获取运行时需求 ⭐⭐ =====
		/**
		 * runtimeRequirements 是该 chunk 需要的所有运行时功能
		 *
		 * 【示例】
		 * Set([
		 *   '__webpack_require__',
		 *   '__webpack_require__.d',
		 *   '__webpack_require__.e',
		 *   '__webpack_require__.r'
		 * ])
		 *
		 * 【用途】
		 * 决定生成哪些运行时代码
		 * 只生成需要的，减少代码体积
		 */
		const runtimeRequirements = chunkGraph.getTreeRuntimeRequirements(chunk);

		// ===== 步骤3: 检查是否使用 IIFE 包装 ⭐ =====
		/**
		 * IIFE (Immediately Invoked Function Expression)
		 * 立即执行函数表达式
		 *
		 * 【作用】
		 * - 创建独立作用域
		 * - 避免全局污染
		 * - 浏览器环境通常使用 IIFE
		 * - Node.js 环境可以不使用
		 */
		const iife = runtimeTemplate.isIIFE();

		// ===== 步骤4: 生成启动代码（bootstrap）⭐⭐ =====
		/**
		 * bootstrap 包含：
		 * - header: 运行时代码的头部
		 * - startup: 启动代码（调用入口模块）
		 * - beforeStartup: 启动前代码
		 * - afterStartup: 启动后代码
		 * - allowInlineStartup: 是否允许内联启动
		 */
		const bootstrap = this.renderBootstrap(renderContext, hooks);

		// 检查是否使用 SourceMap
		const useSourceMap = hooks.useSourceMap.call(chunk, renderContext);

		// ===== 步骤5: 获取 chunk 的所有 JavaScript 模块 ⭐⭐ =====
		/**
		 * 获取 chunk 包含的所有 JavaScript 类型的模块
		 *
		 * 【排序】
		 * 按模块标识符排序，确保输出的确定性
		 * （相同输入产生相同输出）
		 *
		 * 【过滤】
		 * 只获取 sourceType 为 'javascript' 的模块
		 * （一个模块可能有多种 sourceType，如 JS + CSS）
		 */
		const allModules = Array.from(
			chunkGraph.getOrderedChunkModulesIterableBySourceType(
				chunk,
				"javascript",             // 只获取 JS 模块
				compareModulesByIdentifier // 排序函数
			) || []
		);

		// ===== 步骤6: 检查是否有入口模块 =====
		const hasEntryModules = chunkGraph.getNumberOfEntryModules(chunk) > 0;

		// ===== 步骤7: 确定内联模块（优化）⭐ =====
		/**
		 * 内联模块优化：
		 *
		 * 【原理】
		 * 入口模块可以直接内联到启动代码中
		 * 不需要包装成 __webpack_modules__ 的一部分
		 *
		 * 【好处】
		 * - 减少一次函数调用
		 * - 代码更直接
		 * - 稍微提升性能
		 *
		 * 【条件】
		 * - allowInlineStartup = true
		 * - 有入口模块
		 *
		 * @type {Set<Module> | undefined}
		 */
		let inlinedModules;
		if (bootstrap.allowInlineStartup && hasEntryModules) {
			inlinedModules = new Set(chunkGraph.getChunkEntryModulesIterable(chunk));
		}

		// ===== 步骤8: 初始化 Source 对象 =====
		/**
		 * ConcatSource: 用于拼接多个 Source
		 *
		 * 【优势】
		 * - 高效拼接
		 * - 支持 SourceMap 合并
		 * - 延迟计算（只在需要时生成最终字符串）
		 */
		let source = new ConcatSource();
		let prefix;  // 每行代码的前缀（缩进）

		// ===== 步骤9: 添加 IIFE 包装（如果需要）⭐ =====
		if (iife) {
			// 使用 IIFE 包装整个 chunk

			if (runtimeTemplate.supportsArrowFunction()) {
				// 支持箭头函数（现代浏览器）
				source.add("/******/ (() => { // webpackBootstrap\n");
			} else {
				// 不支持箭头函数（旧浏览器）
				source.add("/******/ (function() { // webpackBootstrap\n");
			}
			// IIFE 内部代码需要缩进
			prefix = "/******/ \t";
		} else {
			// 不使用 IIFE（如 Node.js 环境）
			prefix = "/******/ ";
		}

		// ===== 步骤10: 处理严格模式 ⭐⭐ =====
		/**
		 * 严格模式决策：
		 *
		 * 【策略】
		 * 1. 如果 renderContext.strictMode = true，使用严格模式
		 * 2. 如果所有模块都是严格模式，整体使用严格模式
		 * 3. 检查是否有阻止严格模式的原因
		 *
		 * 【好处】
		 * 整体严格模式比每个模块单独声明更高效
		 */
		let allStrict = renderContext.strictMode;

		if (!allStrict && allModules.every(m => m.buildInfo.strict)) {
			// 所有模块都是严格模式

			// 检查是否有阻止使用严格模式的原因
			const strictBailout = hooks.strictRuntimeBailout.call(renderContext);

			if (strictBailout) {
				// 有阻止原因，添加注释说明
				source.add(
					prefix +
						`// runtime can't be in strict mode because ${strictBailout}.\n`
				);
			} else {
				// 可以使用严格模式
				allStrict = true;
				source.add(prefix + '"use strict";\n');
			}
		}

		// ===== 步骤11: 创建 chunk 渲染上下文 =====
		/**
		 * chunkRenderContext 扩展了 renderContext
		 *
		 * 【新增字段】
		 * - chunkInitFragments: 初始化片段（用于依赖注入等）
		 * - strictMode: 是否严格模式
		 *
		 * @type {ChunkRenderContext}
		 */
		const chunkRenderContext = {
			...renderContext,
			chunkInitFragments: [],  // 初始化片段列表
			strictMode: allStrict     // 严格模式标记
		};

		// ===== 步骤12: 渲染所有模块（生成模块映射）⭐⭐⭐ =====
		/**
		 * 渲染 chunk 的所有模块为对象映射
		 *
		 * 【生成格式】
		 * {
		 *   moduleId1: function(module, exports, __webpack_require__) {
		 *     // 模块1的代码
		 *   },
		 *   moduleId2: function(module, exports, __webpack_require__) {
		 *     // 模块2的代码
		 *   }
		 * }
		 *
		 * 【过滤】
		 * 如果有内联模块，排除它们（它们会直接内联到启动代码）
		 *
		 * 【渲染】
		 * 对每个模块调用 renderModule 包装为函数
		 */
		const chunkModules = Template.renderChunkModules(
			chunkRenderContext,
			inlinedModules
				? allModules.filter(
						m => !(/** @type {Set<Module>} */ (inlinedModules).has(m))
				  )  // 排除内联模块
				: allModules,  // 包含所有模块
			module => this.renderModule(module, chunkRenderContext, hooks, true),  // 渲染函数
			prefix  // 代码前缀（缩进）
		);

		// ===== 步骤13: 添加模块映射到输出 ⭐⭐⭐ =====
		/**
		 * 检查是否需要生成 __webpack_modules__
		 *
		 * 【条件】
		 * - 有模块需要渲染
		 * - 或运行时需要 moduleFactories
		 * - 或运行时需要 require 函数
		 *
		 * 【不生成的情况】
		 * - chunk 为空
		 * - 只有运行时代码
		 */
		if (
			chunkModules ||
			runtimeRequirements.has(RuntimeGlobals.moduleFactories) ||
			runtimeRequirements.has(RuntimeGlobals.moduleFactoriesAddOnly) ||
			runtimeRequirements.has(RuntimeGlobals.require)
		) {
			// 生成 __webpack_modules__ 声明
			source.add(prefix + "var __webpack_modules__ = (");
			source.add(chunkModules || "{}");  // 模块映射或空对象
			source.add(");\n");

			// 添加分隔线
			source.add(
				"/************************************************************************/\n"
			);
		}

		// ===== 步骤14: 添加运行时头部代码 ⭐⭐ =====
		/**
		 * bootstrap.header 包含运行时的核心代码
		 *
		 * 【内容】
		 * - 模块缓存声明
		 * - __webpack_require__ 函数定义
		 * - 其他运行时工具函数
		 *
		 * 【示例】
		 * var __webpack_module_cache__ = {};
		 * function __webpack_require__(moduleId) {
		 *   if (__webpack_module_cache__[moduleId]) {
		 *     return __webpack_module_cache__[moduleId].exports;
		 *   }
		 *   // ... 模块加载逻辑
		 * }
		 */
		if (bootstrap.header.length > 0) {
			// 将 header 数组转为字符串
			const header = Template.asString(bootstrap.header) + "\n";

			// 添加到 source（带前缀）
			source.add(
				new PrefixSource(
					prefix,
					useSourceMap
						? new OriginalSource(header, "webpack/bootstrap")  // 带 SourceMap
						: new RawSource(header)  // 不带 SourceMap
				)
			);

			// 添加分隔线
			source.add(
				"/************************************************************************/\n"
			);
		}

		// ===== 步骤15: 添加运行时模块 ⭐⭐⭐ =====
		/**
		 * 运行时模块（RuntimeModule）是 webpack 运行时代码的模块化表示
		 *
		 * 【示例】
		 * - DefinePropertyGettersRuntimeModule: __webpack_require__.d
		 * - MakeNamespaceObjectRuntimeModule: __webpack_require__.r
		 * - EnsureChunkRuntimeModule: __webpack_require__.e
		 * - HasOwnPropertyRuntimeModule: __webpack_require__.o
		 *
		 * 【模块化运行时】⭐
		 * webpack 5 的重要改进：
		 * - 运行时代码也是模块
		 * - 按需加载运行时功能
		 * - 减少不需要的运行时代码
		 *
		 * 【顺序】
		 * 运行时模块按依赖顺序排列
		 * 确保功能的正确性
		 */
		const runtimeModules =
			renderContext.chunkGraph.getChunkRuntimeModulesInOrder(chunk);

		if (runtimeModules.length > 0) {
			// 渲染所有运行时模块
			source.add(
				new PrefixSource(
					prefix,
					Template.renderRuntimeModules(runtimeModules, chunkRenderContext)
				)
			);

			// 添加分隔线
			source.add(
				"/************************************************************************/\n"
			);

			// ===== 标记运行时模块已生成代码 =====
			/**
			 * 运行时模块也需要代码生成
			 *
			 * 【原因】
			 * - renderRuntimeModules 内部调用了 codeGeneration
			 * - 需要标记这些模块已处理
			 * - 避免重复生成
			 */
			for (const module of runtimeModules) {
				compilation.codeGeneratedModules.add(module);
			}
		}
		if (inlinedModules) {
			if (bootstrap.beforeStartup.length > 0) {
				const beforeStartup = Template.asString(bootstrap.beforeStartup) + "\n";
				source.add(
					new PrefixSource(
						prefix,
						useSourceMap
							? new OriginalSource(beforeStartup, "webpack/before-startup")
							: new RawSource(beforeStartup)
					)
				);
			}
			const lastInlinedModule = last(inlinedModules);
			const startupSource = new ConcatSource();
			startupSource.add(`var ${RuntimeGlobals.exports} = {};\n`);
			for (const m of inlinedModules) {
				const renderedModule = this.renderModule(
					m,
					chunkRenderContext,
					hooks,
					false
				);
				if (renderedModule) {
					const innerStrict = !allStrict && m.buildInfo.strict;
					const runtimeRequirements = chunkGraph.getModuleRuntimeRequirements(
						m,
						chunk.runtime
					);
					const exports = runtimeRequirements.has(RuntimeGlobals.exports);
					const webpackExports =
						exports && m.exportsArgument === RuntimeGlobals.exports;
					let iife = innerStrict
						? "it need to be in strict mode."
						: inlinedModules.size > 1
						? // TODO check globals and top-level declarations of other entries and chunk modules
						  // to make a better decision
						  "it need to be isolated against other entry modules."
						: chunkModules
						? "it need to be isolated against other modules in the chunk."
						: exports && !webpackExports
						? `it uses a non-standard name for the exports (${m.exportsArgument}).`
						: hooks.embedInRuntimeBailout.call(m, renderContext);
					let footer;
					if (iife !== undefined) {
						startupSource.add(
							`// This entry need to be wrapped in an IIFE because ${iife}\n`
						);
						const arrow = runtimeTemplate.supportsArrowFunction();
						if (arrow) {
							startupSource.add("(() => {\n");
							footer = "\n})();\n\n";
						} else {
							startupSource.add("!function() {\n");
							footer = "\n}();\n";
						}
						if (innerStrict) startupSource.add('"use strict";\n');
					} else {
						footer = "\n";
					}
					if (exports) {
						if (m !== lastInlinedModule)
							startupSource.add(`var ${m.exportsArgument} = {};\n`);
						else if (m.exportsArgument !== RuntimeGlobals.exports)
							startupSource.add(
								`var ${m.exportsArgument} = ${RuntimeGlobals.exports};\n`
							);
					}
					startupSource.add(renderedModule);
					startupSource.add(footer);
				}
			}
			if (runtimeRequirements.has(RuntimeGlobals.onChunksLoaded)) {
				startupSource.add(
					`${RuntimeGlobals.exports} = ${RuntimeGlobals.onChunksLoaded}(${RuntimeGlobals.exports});\n`
				);
			}
			source.add(
				hooks.renderStartup.call(startupSource, lastInlinedModule, {
					...renderContext,
					inlined: true
				})
			);
			if (bootstrap.afterStartup.length > 0) {
				const afterStartup = Template.asString(bootstrap.afterStartup) + "\n";
				source.add(
					new PrefixSource(
						prefix,
						useSourceMap
							? new OriginalSource(afterStartup, "webpack/after-startup")
							: new RawSource(afterStartup)
					)
				);
			}
		} else {
			const lastEntryModule = last(
				chunkGraph.getChunkEntryModulesIterable(chunk)
			);
			const toSource = useSourceMap
				? (content, name) =>
						new OriginalSource(Template.asString(content), name)
				: content => new RawSource(Template.asString(content));
			source.add(
				new PrefixSource(
					prefix,
					new ConcatSource(
						toSource(bootstrap.beforeStartup, "webpack/before-startup"),
						"\n",
						hooks.renderStartup.call(
							toSource(bootstrap.startup.concat(""), "webpack/startup"),
							lastEntryModule,
							{
								...renderContext,
								inlined: false
							}
						),
						toSource(bootstrap.afterStartup, "webpack/after-startup"),
						"\n"
					)
				)
			);
		}
		if (
			hasEntryModules &&
			runtimeRequirements.has(RuntimeGlobals.returnExportsFromRuntime)
		) {
			source.add(`${prefix}return ${RuntimeGlobals.exports};\n`);
		}
		if (iife) {
			source.add("/******/ })()\n");
		}

		/** @type {Source} */
		let finalSource = tryRunOrWebpackError(
			() => hooks.renderMain.call(source, renderContext),
			"JavascriptModulesPlugin.getCompilationHooks().renderMain"
		);
		if (!finalSource) {
			throw new Error(
				"JavascriptModulesPlugin error: JavascriptModulesPlugin.getCompilationHooks().renderMain plugins should return something"
			);
		}
		finalSource = tryRunOrWebpackError(
			() => hooks.renderContent.call(finalSource, renderContext),
			"JavascriptModulesPlugin.getCompilationHooks().renderContent"
		);
		if (!finalSource) {
			throw new Error(
				"JavascriptModulesPlugin error: JavascriptModulesPlugin.getCompilationHooks().renderContent plugins should return something"
			);
		}

		finalSource = InitFragment.addToSource(
			finalSource,
			chunkRenderContext.chunkInitFragments,
			chunkRenderContext
		);
		finalSource = tryRunOrWebpackError(
			() => hooks.render.call(finalSource, renderContext),
			"JavascriptModulesPlugin.getCompilationHooks().render"
		);
		if (!finalSource) {
			throw new Error(
				"JavascriptModulesPlugin error: JavascriptModulesPlugin.getCompilationHooks().render plugins should return something"
			);
		}
		chunk.rendered = true;
		return iife ? new ConcatSource(finalSource, ";") : finalSource;
	}

	/**
	 * @param {Hash} hash the hash to be updated
	 * @param {RenderBootstrapContext} renderContext options object
	 * @param {CompilationHooks} hooks hooks
	 */
	updateHashWithBootstrap(hash, renderContext, hooks) {
		const bootstrap = this.renderBootstrap(renderContext, hooks);
		for (const key of Object.keys(bootstrap)) {
			hash.update(key);
			if (Array.isArray(bootstrap[key])) {
				for (const line of bootstrap[key]) {
					hash.update(line);
				}
			} else {
				hash.update(JSON.stringify(bootstrap[key]));
			}
		}
	}

	/**
	 * @param {RenderBootstrapContext} renderContext options object
	 * @param {CompilationHooks} hooks hooks
	 * @returns {{ header: string[], beforeStartup: string[], startup: string[], afterStartup: string[], allowInlineStartup: boolean }} the generated source of the bootstrap code
	 */
	renderBootstrap(renderContext, hooks) {
		const {
			chunkGraph,
			codeGenerationResults,
			moduleGraph,
			chunk,
			runtimeTemplate
		} = renderContext;

		const runtimeRequirements = chunkGraph.getTreeRuntimeRequirements(chunk);

		const requireFunction = runtimeRequirements.has(RuntimeGlobals.require);
		const moduleCache = runtimeRequirements.has(RuntimeGlobals.moduleCache);
		const moduleFactories = runtimeRequirements.has(
			RuntimeGlobals.moduleFactories
		);
		const moduleUsed = runtimeRequirements.has(RuntimeGlobals.module);
		const requireScopeUsed = runtimeRequirements.has(
			RuntimeGlobals.requireScope
		);
		const interceptModuleExecution = runtimeRequirements.has(
			RuntimeGlobals.interceptModuleExecution
		);

		const useRequire =
			requireFunction || interceptModuleExecution || moduleUsed;

		/**
		 * @type {{startup: string[], beforeStartup: string[], header: string[], afterStartup: string[], allowInlineStartup: boolean}}
		 */
		const result = {
			header: [],
			beforeStartup: [],
			startup: [],
			afterStartup: [],
			allowInlineStartup: true
		};

		let { header: buf, startup, beforeStartup, afterStartup } = result;

		if (result.allowInlineStartup && moduleFactories) {
			startup.push(
				"// module factories are used so entry inlining is disabled"
			);
			result.allowInlineStartup = false;
		}
		if (result.allowInlineStartup && moduleCache) {
			startup.push("// module cache are used so entry inlining is disabled");
			result.allowInlineStartup = false;
		}
		if (result.allowInlineStartup && interceptModuleExecution) {
			startup.push(
				"// module execution is intercepted so entry inlining is disabled"
			);
			result.allowInlineStartup = false;
		}

		if (useRequire || moduleCache) {
			buf.push("// The module cache");
			buf.push("var __webpack_module_cache__ = {};");
			buf.push("");
		}

		if (useRequire) {
			buf.push("// The require function");
			buf.push(`function ${RuntimeGlobals.require}(moduleId) {`);
			buf.push(Template.indent(this.renderRequire(renderContext, hooks)));
			buf.push("}");
			buf.push("");
		} else if (runtimeRequirements.has(RuntimeGlobals.requireScope)) {
			buf.push("// The require scope");
			buf.push(`var ${RuntimeGlobals.require} = {};`);
			buf.push("");
		}

		if (
			moduleFactories ||
			runtimeRequirements.has(RuntimeGlobals.moduleFactoriesAddOnly)
		) {
			buf.push("// expose the modules object (__webpack_modules__)");
			buf.push(`${RuntimeGlobals.moduleFactories} = __webpack_modules__;`);
			buf.push("");
		}

		if (moduleCache) {
			buf.push("// expose the module cache");
			buf.push(`${RuntimeGlobals.moduleCache} = __webpack_module_cache__;`);
			buf.push("");
		}

		if (interceptModuleExecution) {
			buf.push("// expose the module execution interceptor");
			buf.push(`${RuntimeGlobals.interceptModuleExecution} = [];`);
			buf.push("");
		}

		if (!runtimeRequirements.has(RuntimeGlobals.startupNoDefault)) {
			if (chunkGraph.getNumberOfEntryModules(chunk) > 0) {
				/** @type {string[]} */
				const buf2 = [];
				const runtimeRequirements =
					chunkGraph.getTreeRuntimeRequirements(chunk);
				buf2.push("// Load entry module and return exports");
				let i = chunkGraph.getNumberOfEntryModules(chunk);
				for (const [
					entryModule,
					entrypoint
				] of chunkGraph.getChunkEntryModulesWithChunkGroupIterable(chunk)) {
					const chunks = entrypoint.chunks.filter(c => c !== chunk);
					if (result.allowInlineStartup && chunks.length > 0) {
						buf2.push(
							"// This entry module depends on other loaded chunks and execution need to be delayed"
						);
						result.allowInlineStartup = false;
					}
					if (
						result.allowInlineStartup &&
						someInIterable(
							moduleGraph.getIncomingConnectionsByOriginModule(entryModule),
							([originModule, connections]) =>
								originModule &&
								connections.some(c => c.isTargetActive(chunk.runtime)) &&
								someInIterable(
									chunkGraph.getModuleRuntimes(originModule),
									runtime =>
										intersectRuntime(runtime, chunk.runtime) !== undefined
								)
						)
					) {
						buf2.push(
							"// This entry module is referenced by other modules so it can't be inlined"
						);
						result.allowInlineStartup = false;
					}

					let data;
					if (codeGenerationResults.has(entryModule, chunk.runtime)) {
						const result = codeGenerationResults.get(
							entryModule,
							chunk.runtime
						);
						data = result.data;
					}
					if (
						result.allowInlineStartup &&
						(!data || !data.get("topLevelDeclarations")) &&
						(!entryModule.buildInfo ||
							!entryModule.buildInfo.topLevelDeclarations)
					) {
						buf2.push(
							"// This entry module doesn't tell about it's top-level declarations so it can't be inlined"
						);
						result.allowInlineStartup = false;
					}
					if (result.allowInlineStartup) {
						const bailout = hooks.inlineInRuntimeBailout.call(
							entryModule,
							renderContext
						);
						if (bailout !== undefined) {
							buf2.push(
								`// This entry module can't be inlined because ${bailout}`
							);
							result.allowInlineStartup = false;
						}
					}
					i--;
					const moduleId = chunkGraph.getModuleId(entryModule);
					const entryRuntimeRequirements =
						chunkGraph.getModuleRuntimeRequirements(entryModule, chunk.runtime);
					let moduleIdExpr = JSON.stringify(moduleId);
					if (runtimeRequirements.has(RuntimeGlobals.entryModuleId)) {
						moduleIdExpr = `${RuntimeGlobals.entryModuleId} = ${moduleIdExpr}`;
					}
					if (
						result.allowInlineStartup &&
						entryRuntimeRequirements.has(RuntimeGlobals.module)
					) {
						result.allowInlineStartup = false;
						buf2.push(
							"// This entry module used 'module' so it can't be inlined"
						);
					}
					if (chunks.length > 0) {
						buf2.push(
							`${i === 0 ? `var ${RuntimeGlobals.exports} = ` : ""}${
								RuntimeGlobals.onChunksLoaded
							}(undefined, ${JSON.stringify(
								chunks.map(c => c.id)
							)}, ${runtimeTemplate.returningFunction(
								`${RuntimeGlobals.require}(${moduleIdExpr})`
							)})`
						);
					} else if (useRequire) {
						buf2.push(
							`${i === 0 ? `var ${RuntimeGlobals.exports} = ` : ""}${
								RuntimeGlobals.require
							}(${moduleIdExpr});`
						);
					} else {
						if (i === 0) buf2.push(`var ${RuntimeGlobals.exports} = {};`);
						if (requireScopeUsed) {
							buf2.push(
								`__webpack_modules__[${moduleIdExpr}](0, ${
									i === 0 ? RuntimeGlobals.exports : "{}"
								}, ${RuntimeGlobals.require});`
							);
						} else if (entryRuntimeRequirements.has(RuntimeGlobals.exports)) {
							buf2.push(
								`__webpack_modules__[${moduleIdExpr}](0, ${
									i === 0 ? RuntimeGlobals.exports : "{}"
								});`
							);
						} else {
							buf2.push(`__webpack_modules__[${moduleIdExpr}]();`);
						}
					}
				}
				if (runtimeRequirements.has(RuntimeGlobals.onChunksLoaded)) {
					buf2.push(
						`${RuntimeGlobals.exports} = ${RuntimeGlobals.onChunksLoaded}(${RuntimeGlobals.exports});`
					);
				}
				if (
					runtimeRequirements.has(RuntimeGlobals.startup) ||
					(runtimeRequirements.has(RuntimeGlobals.startupOnlyBefore) &&
						runtimeRequirements.has(RuntimeGlobals.startupOnlyAfter))
				) {
					result.allowInlineStartup = false;
					buf.push("// the startup function");
					buf.push(
						`${RuntimeGlobals.startup} = ${runtimeTemplate.basicFunction("", [
							...buf2,
							`return ${RuntimeGlobals.exports};`
						])};`
					);
					buf.push("");
					startup.push("// run startup");
					startup.push(
						`var ${RuntimeGlobals.exports} = ${RuntimeGlobals.startup}();`
					);
				} else if (runtimeRequirements.has(RuntimeGlobals.startupOnlyBefore)) {
					buf.push("// the startup function");
					buf.push(
						`${RuntimeGlobals.startup} = ${runtimeTemplate.emptyFunction()};`
					);
					beforeStartup.push("// run runtime startup");
					beforeStartup.push(`${RuntimeGlobals.startup}();`);
					startup.push("// startup");
					startup.push(Template.asString(buf2));
				} else if (runtimeRequirements.has(RuntimeGlobals.startupOnlyAfter)) {
					buf.push("// the startup function");
					buf.push(
						`${RuntimeGlobals.startup} = ${runtimeTemplate.emptyFunction()};`
					);
					startup.push("// startup");
					startup.push(Template.asString(buf2));
					afterStartup.push("// run runtime startup");
					afterStartup.push(`${RuntimeGlobals.startup}();`);
				} else {
					startup.push("// startup");
					startup.push(Template.asString(buf2));
				}
			} else if (
				runtimeRequirements.has(RuntimeGlobals.startup) ||
				runtimeRequirements.has(RuntimeGlobals.startupOnlyBefore) ||
				runtimeRequirements.has(RuntimeGlobals.startupOnlyAfter)
			) {
				buf.push(
					"// the startup function",
					"// It's empty as no entry modules are in this chunk",
					`${RuntimeGlobals.startup} = ${runtimeTemplate.emptyFunction()};`,
					""
				);
			}
		} else if (
			runtimeRequirements.has(RuntimeGlobals.startup) ||
			runtimeRequirements.has(RuntimeGlobals.startupOnlyBefore) ||
			runtimeRequirements.has(RuntimeGlobals.startupOnlyAfter)
		) {
			result.allowInlineStartup = false;
			buf.push(
				"// the startup function",
				"// It's empty as some runtime module handles the default behavior",
				`${RuntimeGlobals.startup} = ${runtimeTemplate.emptyFunction()};`
			);
			startup.push("// run startup");
			startup.push(
				`var ${RuntimeGlobals.exports} = ${RuntimeGlobals.startup}();`
			);
		}
		return result;
	}

	/**
	 * @param {RenderBootstrapContext} renderContext options object
	 * @param {CompilationHooks} hooks hooks
	 * @returns {string} the generated source of the require function
	 */
	renderRequire(renderContext, hooks) {
		const {
			chunk,
			chunkGraph,
			runtimeTemplate: { outputOptions }
		} = renderContext;
		const runtimeRequirements = chunkGraph.getTreeRuntimeRequirements(chunk);
		const moduleExecution = runtimeRequirements.has(
			RuntimeGlobals.interceptModuleExecution
		)
			? Template.asString([
					`var execOptions = { id: moduleId, module: module, factory: __webpack_modules__[moduleId], require: ${RuntimeGlobals.require} };`,
					`${RuntimeGlobals.interceptModuleExecution}.forEach(function(handler) { handler(execOptions); });`,
					"module = execOptions.module;",
					"execOptions.factory.call(module.exports, module, module.exports, execOptions.require);"
			  ])
			: runtimeRequirements.has(RuntimeGlobals.thisAsExports)
			? Template.asString([
					`__webpack_modules__[moduleId].call(module.exports, module, module.exports, ${RuntimeGlobals.require});`
			  ])
			: Template.asString([
					`__webpack_modules__[moduleId](module, module.exports, ${RuntimeGlobals.require});`
			  ]);
		const needModuleId = runtimeRequirements.has(RuntimeGlobals.moduleId);
		const needModuleLoaded = runtimeRequirements.has(
			RuntimeGlobals.moduleLoaded
		);
		const content = Template.asString([
			"// Check if module is in cache",
			"var cachedModule = __webpack_module_cache__[moduleId];",
			"if (cachedModule !== undefined) {",
			outputOptions.strictModuleErrorHandling
				? Template.indent([
						"if (cachedModule.error !== undefined) throw cachedModule.error;",
						"return cachedModule.exports;"
				  ])
				: Template.indent("return cachedModule.exports;"),
			"}",
			"// Create a new module (and put it into the cache)",
			"var module = __webpack_module_cache__[moduleId] = {",
			Template.indent([
				needModuleId ? "id: moduleId," : "// no module.id needed",
				needModuleLoaded ? "loaded: false," : "// no module.loaded needed",
				"exports: {}"
			]),
			"};",
			"",
			outputOptions.strictModuleExceptionHandling
				? Template.asString([
						"// Execute the module function",
						"var threw = true;",
						"try {",
						Template.indent([moduleExecution, "threw = false;"]),
						"} finally {",
						Template.indent([
							"if(threw) delete __webpack_module_cache__[moduleId];"
						]),
						"}"
				  ])
				: outputOptions.strictModuleErrorHandling
				? Template.asString([
						"// Execute the module function",
						"try {",
						Template.indent(moduleExecution),
						"} catch(e) {",
						Template.indent(["module.error = e;", "throw e;"]),
						"}"
				  ])
				: Template.asString([
						"// Execute the module function",
						moduleExecution
				  ]),
			needModuleLoaded
				? Template.asString([
						"",
						"// Flag the module as loaded",
						`${RuntimeGlobals.moduleLoaded} = true;`,
						""
				  ])
				: "",
			"// Return the exports of the module",
			"return module.exports;"
		]);
		return tryRunOrWebpackError(
			() => hooks.renderRequire.call(content, renderContext),
			"JavascriptModulesPlugin.getCompilationHooks().renderRequire"
		);
	}
}

module.exports = JavascriptModulesPlugin;
module.exports.chunkHasJs = chunkHasJs;
