/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

/**
 * lib/NormalModule.js - 普通模块类（最常用的模块类型）⭐⭐⭐
 *
 * 【文件作用】
 * NormalModule 是 webpack 中最常用的模块类型，处理：
 * - JavaScript 文件（.js、.jsx、.ts、.tsx）
 * - CSS 文件（.css、.scss、.less）
 * - 图片文件（.png、.jpg、.svg）
 * - 其他任何通过 loader 处理的文件
 *
 * 【核心职责】
 *
 * 1. **模块构建（build）**：
 *    - 读取源文件
 *    - 执行 loader 链转换
 *    - 解析 AST 收集依赖
 *    - 生成模块信息（buildInfo、buildMeta）
 *
 * 2. **代码生成（codeGeneration）**：
 *    - 生成模块的最终代码
 *    - 处理导入导出语句
 *    - 应用 Tree Shaking
 *    - 生成 Source 对象
 *
 * 3. **依赖管理**：
 *    - 收集模块的依赖（dependencies）
 *    - 收集代码块的依赖（blocks）
 *    - 管理异步依赖（AsyncDependenciesBlock）
 *
 * 【与其他模块类型的区别】
 *
 * - NormalModule: 通过文件系统加载的普通文件（最常用）
 * - RawModule: 直接提供源码的模块（如生成的代码）
 * - ExternalModule: 外部模块（不打包，运行时引用）
 * - DelegatedModule: 委托模块（DLL）
 * - ContextModule: 上下文模块（require.context）
 *
 * 【构建流程】
 *
 * ```
 * NormalModule.build()
 *   ├─ doBuild()
 *   │   ├─ 读取源文件（fs.readFile）
 *   │   ├─ 执行 loader-runner
 *   │   │   ├─ babel-loader: ES6 → ES5
 *   │   │   ├─ ts-loader: TS → JS
 *   │   │   ├─ css-loader: CSS → JS
 *   │   │   └─ 其他 loader...
 *   │   └─ 返回转换后的源码
 *   ├─ 创建 Source 对象
 *   ├─ parser.parse()
 *   │   ├─ acorn.parse() 生成 AST
 *   │   ├─ 遍历 AST 节点
 *   │   ├─ 识别 import/require
 *   │   └─ 创建 Dependency 对象
 *   ├─ 收集依赖到 module.dependencies
 *   └─ 生成 buildInfo 和 buildMeta
 * ```
 *
 * 【关键属性】
 *
 * - request: 完整的请求字符串（包含 loader）
 * - userRequest: 用户请求的路径（不含 loader）
 * - resource: 文件的绝对路径
 * - loaders: loader 配置列表
 * - parser: 解析器（JavascriptParser、CSSParser 等）
 * - generator: 代码生成器
 * - dependencies: 依赖列表
 * - buildInfo: 构建信息（哈希、缓存等）
 * - buildMeta: 构建元数据（导出、副作用等）
 *
 * 【性能优化】
 *
 * 1. 增量构建：
 *    - 检查文件时间戳
 *    - 只重建变化的模块
 *
 * 2. 缓存：
 *    - 持久化缓存（文件系统）
 *    - 内存缓存（_lastSuccessfulBuildMeta）
 *
 * 3. 并行处理：
 *    - 多个模块可以并行构建
 *    - loader 可以在 worker 线程运行
 *
 * 【创建时机】
 * 由 NormalModuleFactory.create() 创建：
 * ```javascript
 * factory.create({
 *   context,
 *   dependencies,
 *   ...
 * }, (err, module) => {
 *   // module 是 NormalModule 实例
 * });
 * ```
 */

"use strict";

// ===== 核心依赖 =====
const parseJson = require("json-parse-even-better-errors");  // JSON 解析
const { getContext, runLoaders } = require("loader-runner");  // loader 执行引擎
const querystring = require("querystring");  // 查询字符串解析
const { HookMap, SyncHook, AsyncSeriesBailHook } = require("tapable");  // 钩子系统
const {
	CachedSource,      // 缓存的 Source
	OriginalSource,    // 原始 Source
	RawSource,         // 原始字符串 Source
	SourceMapSource    // 带 SourceMap 的 Source
} = require("webpack-sources");

// ===== webpack 核心类 =====
const Compilation = require("./Compilation");
const HookWebpackError = require("./HookWebpackError");
const Module = require("./Module");  // 模块基类
const ModuleBuildError = require("./ModuleBuildError");
const ModuleError = require("./ModuleError");
const ModuleGraphConnection = require("./ModuleGraphConnection");
const ModuleParseError = require("./ModuleParseError");
const { JAVASCRIPT_MODULE_TYPE_AUTO } = require("./ModuleTypeConstants");
const ModuleWarning = require("./ModuleWarning");
const RuntimeGlobals = require("./RuntimeGlobals");
const UnhandledSchemeError = require("./UnhandledSchemeError");
const WebpackError = require("./WebpackError");

// ===== 工具函数 =====
const formatLocation = require("./formatLocation");
const LazySet = require("./util/LazySet");
const { isSubset } = require("./util/SetHelpers");
const { getScheme } = require("./util/URLAbsoluteSpecifier");
const {
	compareLocations,
	concatComparators,
	compareSelect,
	keepOriginalOrder
} = require("./util/comparators");
const createHash = require("./util/createHash");
const { createFakeHook } = require("./util/deprecation");
const { join } = require("./util/fs");
const {
	contextify,       // 将绝对路径转为相对路径
	absolutify,       // 将相对路径转为绝对路径
	makePathsRelative  // 批量处理路径
} = require("./util/identifier");
const makeSerializable = require("./util/makeSerializable");
const memoize = require("./util/memoize");

/** @typedef {import("webpack-sources").Source} Source */
/** @typedef {import("../declarations/LoaderContext").NormalModuleLoaderContext} NormalModuleLoaderContext */
/** @typedef {import("../declarations/WebpackOptions").Mode} Mode */
/** @typedef {import("../declarations/WebpackOptions").ResolveOptions} ResolveOptions */
/** @typedef {import("../declarations/WebpackOptions").WebpackOptionsNormalized} WebpackOptions */
/** @typedef {import("./ChunkGraph")} ChunkGraph */
/** @typedef {import("./Compiler")} Compiler */
/** @typedef {import("./Dependency").UpdateHashContext} UpdateHashContext */
/** @typedef {import("./DependencyTemplates")} DependencyTemplates */
/** @typedef {import("./Generator")} Generator */
/** @typedef {import("./Module").CodeGenerationContext} CodeGenerationContext */
/** @typedef {import("./Module").CodeGenerationResult} CodeGenerationResult */
/** @typedef {import("./Module").ConcatenationBailoutReasonContext} ConcatenationBailoutReasonContext */
/** @typedef {import("./Module").LibIdentOptions} LibIdentOptions */
/** @typedef {import("./Module").NeedBuildContext} NeedBuildContext */
/** @typedef {import("./ModuleGraph")} ModuleGraph */
/** @typedef {import("./ModuleGraphConnection").ConnectionState} ConnectionState */
/** @typedef {import("./ModuleTypeConstants").JavaScriptModuleTypes} JavaScriptModuleTypes */
/** @typedef {import("./NormalModuleFactory")} NormalModuleFactory */
/** @typedef {import("./Parser")} Parser */
/** @typedef {import("./RequestShortener")} RequestShortener */
/** @typedef {import("./ResolverFactory").ResolverWithOptions} ResolverWithOptions */
/** @typedef {import("./RuntimeTemplate")} RuntimeTemplate */
/** @typedef {import("./logging/Logger").Logger} WebpackLogger */
/** @typedef {import("./serialization/ObjectMiddleware").ObjectDeserializerContext} ObjectDeserializerContext */
/** @typedef {import("./serialization/ObjectMiddleware").ObjectSerializerContext} ObjectSerializerContext */
/** @typedef {import("./util/Hash")} Hash */
/** @typedef {import("./util/fs").InputFileSystem} InputFileSystem */
/** @typedef {import("./util/runtime").RuntimeSpec} RuntimeSpec */

/**
 * @typedef {Object} SourceMap
 * @property {number} version
 * @property {string[]} sources
 * @property {string} mappings
 * @property {string=} file
 * @property {string=} sourceRoot
 * @property {string[]=} sourcesContent
 * @property {string[]=} names
 */

const getInvalidDependenciesModuleWarning = memoize(() =>
	require("./InvalidDependenciesModuleWarning")
);
const getValidate = memoize(() => require("schema-utils").validate);

const ABSOLUTE_PATH_REGEX = /^([a-zA-Z]:\\|\\\\|\/)/;

/**
 * @typedef {Object} LoaderItem
 * @property {string} loader
 * @property {any} options
 * @property {string?} ident
 * @property {string?} type
 */

/**
 * @param {string} context absolute context path
 * @param {string} source a source path
 * @param {Object=} associatedObjectForCache an object to which the cache will be attached
 * @returns {string} new source path
 */
const contextifySourceUrl = (context, source, associatedObjectForCache) => {
	if (source.startsWith("webpack://")) return source;
	return `webpack://${makePathsRelative(
		context,
		source,
		associatedObjectForCache
	)}`;
};

/**
 * @param {string} context absolute context path
 * @param {SourceMap} sourceMap a source map
 * @param {Object=} associatedObjectForCache an object to which the cache will be attached
 * @returns {SourceMap} new source map
 */
const contextifySourceMap = (context, sourceMap, associatedObjectForCache) => {
	if (!Array.isArray(sourceMap.sources)) return sourceMap;
	const { sourceRoot } = sourceMap;
	/** @type {function(string): string} */
	const mapper = !sourceRoot
		? source => source
		: sourceRoot.endsWith("/")
		? source =>
				source.startsWith("/")
					? `${sourceRoot.slice(0, -1)}${source}`
					: `${sourceRoot}${source}`
		: source =>
				source.startsWith("/")
					? `${sourceRoot}${source}`
					: `${sourceRoot}/${source}`;
	const newSources = sourceMap.sources.map(source =>
		contextifySourceUrl(context, mapper(source), associatedObjectForCache)
	);
	return {
		...sourceMap,
		file: "x",
		sourceRoot: undefined,
		sources: newSources
	};
};

/**
 * @param {string | Buffer} input the input
 * @returns {string} the converted string
 */
const asString = input => {
	if (Buffer.isBuffer(input)) {
		return input.toString("utf-8");
	}
	return input;
};

/**
 * @param {string | Buffer} input the input
 * @returns {Buffer} the converted buffer
 */
const asBuffer = input => {
	if (!Buffer.isBuffer(input)) {
		return Buffer.from(input, "utf-8");
	}
	return input;
};

class NonErrorEmittedError extends WebpackError {
	constructor(error) {
		super();

		this.name = "NonErrorEmittedError";
		this.message = "(Emitted value instead of an instance of Error) " + error;
	}
}

makeSerializable(
	NonErrorEmittedError,
	"webpack/lib/NormalModule",
	"NonErrorEmittedError"
);

/**
 * @typedef {Object} NormalModuleCompilationHooks
 * @property {SyncHook<[object, NormalModule]>} loader
 * @property {SyncHook<[LoaderItem[], NormalModule, object]>} beforeLoaders
 * @property {SyncHook<[NormalModule]>} beforeParse
 * @property {SyncHook<[NormalModule]>} beforeSnapshot
 * @property {HookMap<AsyncSeriesBailHook<[string, NormalModule], string | Buffer>>} readResourceForScheme
 * @property {HookMap<AsyncSeriesBailHook<[object], string | Buffer>>} readResource
 * @property {AsyncSeriesBailHook<[NormalModule, NeedBuildContext], boolean>} needBuild
 */

/**
 * @typedef {Object} NormalModuleCreateData
 * @property {string=} layer an optional layer in which the module is
 * @property {JavaScriptModuleTypes | ""} type module type. When deserializing, this is set to an empty string "".
 * @property {string} request request string
 * @property {string} userRequest request intended by user (without loaders from config)
 * @property {string} rawRequest request without resolving
 * @property {LoaderItem[]} loaders list of loaders
 * @property {string} resource path + query of the real resource
 * @property {Record<string, any>=} resourceResolveData resource resolve data
 * @property {string} context context directory for resolving
 * @property {string=} matchResource path + query of the matched resource (virtual)
 * @property {Parser} parser the parser used
 * @property {Record<string, any>=} parserOptions the options of the parser used
 * @property {Generator} generator the generator used
 * @property {Record<string, any>=} generatorOptions the options of the generator used
 * @property {ResolveOptions=} resolveOptions options used for resolving requests from this module
 */

/** @type {WeakMap<Compilation, NormalModuleCompilationHooks>} */
const compilationHooksMap = new WeakMap();

class NormalModule extends Module {
	/**
	 * @param {Compilation} compilation the compilation
	 * @returns {NormalModuleCompilationHooks} the attached hooks
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
				loader: new SyncHook(["loaderContext", "module"]),
				beforeLoaders: new SyncHook(["loaders", "module", "loaderContext"]),
				beforeParse: new SyncHook(["module"]),
				beforeSnapshot: new SyncHook(["module"]),
				// TODO webpack 6 deprecate
				readResourceForScheme: new HookMap(scheme => {
					const hook = hooks.readResource.for(scheme);
					return createFakeHook(
						/** @type {AsyncSeriesBailHook<[string, NormalModule], string | Buffer>} */ ({
							tap: (options, fn) =>
								hook.tap(options, loaderContext =>
									fn(loaderContext.resource, loaderContext._module)
								),
							tapAsync: (options, fn) =>
								hook.tapAsync(options, (loaderContext, callback) =>
									fn(loaderContext.resource, loaderContext._module, callback)
								),
							tapPromise: (options, fn) =>
								hook.tapPromise(options, loaderContext =>
									fn(loaderContext.resource, loaderContext._module)
								)
						})
					);
				}),
				readResource: new HookMap(
					() => new AsyncSeriesBailHook(["loaderContext"])
				),
				needBuild: new AsyncSeriesBailHook(["module", "context"])
			};
			compilationHooksMap.set(compilation, hooks);
		}
		return hooks;
	}

	/**
	 * NormalModule 构造函数
	 *
	 * 【参数说明】
	 *
	 * 所有参数都由 NormalModuleFactory 提供：
	 * - 解析模块路径后确定 resource
	 * - 匹配 loader 规则后确定 loaders
	 * - 根据模块类型选择 parser 和 generator
	 *
	 * 【关键参数】
	 *
	 * request: 完整请求（包含 loader）
	 *   例如：'babel-loader!./src/index.js'
	 *
	 * userRequest: 用户请求（不含 loader）
	 *   例如：'./src/index.js'
	 *
	 * resource: 文件绝对路径
	 *   例如：'/project/src/index.js'
	 *
	 * loaders: loader 配置列表
	 *   例如：[{ loader: 'babel-loader', options: {...} }]
	 *
	 * parser: 解析器实例
	 *   例如：JavascriptParser（解析 JS）
	 *
	 * generator: 代码生成器
	 *   例如：JavascriptGenerator（生成 JS）
	 *
	 * @param {NormalModuleCreateData} options - 创建选项
	 */
	constructor({
		layer,              // 图层（实验性功能）
		type,               // 模块类型（'javascript/auto'、'css/auto' 等）
		request,            // 完整请求字符串（含 loader）
		userRequest,        // 用户请求路径（不含 loader）
		rawRequest,         // 原始请求字符串
		loaders,            // loader 配置列表
		resource,           // 文件绝对路径
		resourceResolveData,  // 解析数据
		context,            // 上下文路径
		matchResource,      // 匹配的资源路径
		parser,             // 解析器实例
		parserOptions,      // 解析器选项
		generator,          // 代码生成器
		generatorOptions,   // 生成器选项
		resolveOptions      // 解析选项
	}) {
		// 调用父类构造函数（Module）
		super(type, context || getContext(resource), layer);

		// ===== 来自工厂的信息（创建时确定）=====

		/**
		 * 完整请求字符串（包含 loader）
		 *
		 * 【示例】
		 * 'babel-loader!ts-loader!./src/index.tsx'
		 *
		 * 【用途】
		 * 作为模块的唯一标识符
		 *
		 * @type {string}
		 */
		this.request = request;

		/**
		 * 用户请求路径（不含 loader）
		 *
		 * 【示例】
		 * './src/index.tsx'
		 *
		 * 【用途】
		 * 显示给用户的路径（错误信息、统计等）
		 *
		 * @type {string}
		 */
		this.userRequest = userRequest;

		/**
		 * 原始请求字符串（源码中写的）
		 *
		 * 【示例】
		 * './index' （可能不含扩展名）
		 *
		 * @type {string}
		 */
		this.rawRequest = rawRequest;

		/**
		 * 是否是二进制模块
		 *
		 * 【判断依据】
		 * type 以 'asset' 或 'webassembly' 开头
		 *
		 * 【用途】
		 * 二进制模块不需要解析为字符串
		 *
		 * @type {boolean}
		 */
		this.binary = /^(asset|webassembly)\b/.test(type);

		/**
		 * 解析器实例
		 *
		 * 【类型】
		 * - JavascriptParser: 解析 JS/TS
		 * - CSSParser: 解析 CSS
		 * - AssetParser: 解析资源文件
		 *
		 * 【职责】
		 * 解析源码，收集依赖
		 *
		 * @type {Parser}
		 */
		this.parser = parser;

		/**
		 * 解析器选项
		 * 配置解析行为
		 */
		this.parserOptions = parserOptions;

		/**
		 * 代码生成器实例
		 *
		 * 【职责】
		 * 在 codeGeneration 阶段生成最终代码
		 *
		 * @type {Generator}
		 */
		this.generator = generator;

		/**
		 * 生成器选项
		 * 配置代码生成行为
		 */
		this.generatorOptions = generatorOptions;

		/**
		 * 文件的绝对路径
		 *
		 * 【示例】
		 * '/Users/project/src/index.js'
		 *
		 * 【用途】
		 * - 读取文件内容
		 * - watch 模式监听文件变化
		 *
		 * @type {string}
		 */
		this.resource = resource;

		/**
		 * 资源解析数据
		 *
		 * 【包含】
		 * 解析过程中的元数据
		 */
		this.resourceResolveData = resourceResolveData;

		/**
		 * 匹配的资源路径
		 *
		 * 【用途】
		 * 某些情况下，loader 匹配使用不同的路径
		 *
		 * @type {string | undefined}
		 */
		this.matchResource = matchResource;

		/**
		 * loader 配置列表
		 *
		 * 【结构】
		 * [
		 *   { loader: 'babel-loader', options: {...}, ident: ... },
		 *   { loader: 'ts-loader', options: {...} }
		 * ]
		 *
		 * 【执行顺序】
		 * 从右到左（从下到上）执行
		 *
		 * @type {LoaderItem[]}
		 */
		this.loaders = loaders;

		// 解析选项（如果提供）
		if (resolveOptions !== undefined) {
			// already declared in super class
			this.resolveOptions = resolveOptions;
		}

		// ===== 构建信息（构建后填充）=====

		/**
		 * 构建错误
		 * 构建失败时设置
		 * @type {(WebpackError | null)=}
		 */
		this.error = null;

		/**
		 * 模块源码（构建后生成）
		 *
		 * 【类型】
		 * - OriginalSource: 原始源码
		 * - SourceMapSource: 带 SourceMap 的源码
		 * - CachedSource: 缓存的源码
		 *
		 * @private
		 * @type {Source=}
		 */
		this._source = null;

		/**
		 * 源码大小映射（按类型）
		 *
		 * 【示例】
		 * {
		 *   'javascript': 1024,  // JS 代码大小
		 *   'css': 512           // CSS 代码大小
		 * }
		 *
		 * @private
		 * @type {Map<string, number> | undefined}
		 */
		this._sourceSizes = undefined;

		/**
		 * 源码类型集合
		 *
		 * 【示例】
		 * Set(['javascript', 'css'])
		 *
		 * @private
		 * @type {Set<string>}
		 */
		this._sourceTypes = undefined;

		// ===== 缓存相关 =====

		/**
		 * 上次成功构建的元数据
		 *
		 * 【用途】
		 * 增量构建时，比较元数据判断是否需要重建
		 */
		this._lastSuccessfulBuildMeta = {};

		/**
		 * 强制构建标记
		 *
		 * 【用途】
		 * 如果为 true，跳过缓存，强制重建
		 */
		this._forceBuild = true;

		/**
		 * 是否正在评估副作用
		 *
		 * 【用途】
		 * 防止副作用评估的循环
		 */
		this._isEvaluatingSideEffects = false;

		/**
		 * 已添加副作用提示的 ModuleGraph 集合
		 *
		 * 【用途】
		 * 避免重复添加副作用提示
		 *
		 * @type {WeakSet<ModuleGraph> | undefined}
		 */
		this._addedSideEffectsBailout = undefined;

		/**
		 * 代码生成器数据缓存
		 *
		 * 【用途】
		 * 存储代码生成过程中的自定义数据
		 *
		 * @type {Map<string, any>}
		 */
		this._codeGeneratorData = new Map();
	}

	/**
	 * @returns {string} a unique identifier of the module
	 */
	identifier() {
		if (this.layer === null) {
			if (this.type === JAVASCRIPT_MODULE_TYPE_AUTO) {
				return this.request;
			} else {
				return `${this.type}|${this.request}`;
			}
		} else {
			return `${this.type}|${this.request}|${this.layer}`;
		}
	}

	/**
	 * @param {RequestShortener} requestShortener the request shortener
	 * @returns {string} a user readable identifier of the module
	 */
	readableIdentifier(requestShortener) {
		return requestShortener.shorten(this.userRequest);
	}

	/**
	 * @param {LibIdentOptions} options options
	 * @returns {string | null} an identifier for library inclusion
	 */
	libIdent(options) {
		let ident = contextify(
			options.context,
			this.userRequest,
			options.associatedObjectForCache
		);
		if (this.layer) ident = `(${this.layer})/${ident}`;
		return ident;
	}

	/**
	 * @returns {string | null} absolute path which should be used for condition matching (usually the resource path)
	 */
	nameForCondition() {
		const resource = this.matchResource || this.resource;
		const idx = resource.indexOf("?");
		if (idx >= 0) return resource.slice(0, idx);
		return resource;
	}

	/**
	 * Assuming this module is in the cache. Update the (cached) module with
	 * the fresh module from the factory. Usually updates internal references
	 * and properties.
	 * @param {Module} module fresh module
	 * @returns {void}
	 */
	updateCacheModule(module) {
		super.updateCacheModule(module);
		const m = /** @type {NormalModule} */ (module);
		this.binary = m.binary;
		this.request = m.request;
		this.userRequest = m.userRequest;
		this.rawRequest = m.rawRequest;
		this.parser = m.parser;
		this.parserOptions = m.parserOptions;
		this.generator = m.generator;
		this.generatorOptions = m.generatorOptions;
		this.resource = m.resource;
		this.resourceResolveData = m.resourceResolveData;
		this.context = m.context;
		this.matchResource = m.matchResource;
		this.loaders = m.loaders;
	}

	/**
	 * Assuming this module is in the cache. Remove internal references to allow freeing some memory.
	 */
	cleanupForCache() {
		// Make sure to cache types and sizes before cleanup when this module has been built
		// They are accessed by the stats and we don't want them to crash after cleanup
		// TODO reconsider this for webpack 6
		if (this.buildInfo) {
			if (this._sourceTypes === undefined) this.getSourceTypes();
			for (const type of this._sourceTypes) {
				this.size(type);
			}
		}
		super.cleanupForCache();
		this.parser = undefined;
		this.parserOptions = undefined;
		this.generator = undefined;
		this.generatorOptions = undefined;
	}

	/**
	 * Module should be unsafe cached. Get data that's needed for that.
	 * This data will be passed to restoreFromUnsafeCache later.
	 * @returns {object} cached data
	 */
	getUnsafeCacheData() {
		const data = super.getUnsafeCacheData();
		data.parserOptions = this.parserOptions;
		data.generatorOptions = this.generatorOptions;
		return data;
	}

	restoreFromUnsafeCache(unsafeCacheData, normalModuleFactory) {
		this._restoreFromUnsafeCache(unsafeCacheData, normalModuleFactory);
	}

	/**
	 * restore unsafe cache data
	 * @param {object} unsafeCacheData data from getUnsafeCacheData
	 * @param {NormalModuleFactory} normalModuleFactory the normal module factory handling the unsafe caching
	 */
	_restoreFromUnsafeCache(unsafeCacheData, normalModuleFactory) {
		super._restoreFromUnsafeCache(unsafeCacheData, normalModuleFactory);
		this.parserOptions = unsafeCacheData.parserOptions;
		this.parser = normalModuleFactory.getParser(this.type, this.parserOptions);
		this.generatorOptions = unsafeCacheData.generatorOptions;
		this.generator = normalModuleFactory.getGenerator(
			this.type,
			this.generatorOptions
		);
		// we assume the generator behaves identically and keep cached sourceTypes/Sizes
	}

	/**
	 * @param {string} context the compilation context
	 * @param {string} name the asset name
	 * @param {string} content the content
	 * @param {string | TODO} sourceMap an optional source map
	 * @param {Object=} associatedObjectForCache object for caching
	 * @returns {Source} the created source
	 */
	createSourceForAsset(
		context,
		name,
		content,
		sourceMap,
		associatedObjectForCache
	) {
		if (sourceMap) {
			if (
				typeof sourceMap === "string" &&
				(this.useSourceMap || this.useSimpleSourceMap)
			) {
				return new OriginalSource(
					content,
					contextifySourceUrl(context, sourceMap, associatedObjectForCache)
				);
			}

			if (this.useSourceMap) {
				return new SourceMapSource(
					content,
					name,
					contextifySourceMap(context, sourceMap, associatedObjectForCache)
				);
			}
		}

		return new RawSource(content);
	}

	/**
	 * @param {ResolverWithOptions} resolver a resolver
	 * @param {WebpackOptions} options webpack options
	 * @param {Compilation} compilation the compilation
	 * @param {InputFileSystem} fs file system from reading
	 * @param {NormalModuleCompilationHooks} hooks the hooks
	 * @returns {NormalModuleLoaderContext} loader context
	 */
	_createLoaderContext(resolver, options, compilation, fs, hooks) {
		const { requestShortener } = compilation.runtimeTemplate;
		const getCurrentLoaderName = () => {
			const currentLoader = this.getCurrentLoader(loaderContext);
			if (!currentLoader) return "(not in loader scope)";
			return requestShortener.shorten(currentLoader.loader);
		};
		const getResolveContext = () => {
			return {
				fileDependencies: {
					add: d => loaderContext.addDependency(d)
				},
				contextDependencies: {
					add: d => loaderContext.addContextDependency(d)
				},
				missingDependencies: {
					add: d => loaderContext.addMissingDependency(d)
				}
			};
		};
		const getAbsolutify = memoize(() =>
			absolutify.bindCache(compilation.compiler.root)
		);
		const getAbsolutifyInContext = memoize(() =>
			absolutify.bindContextCache(this.context, compilation.compiler.root)
		);
		const getContextify = memoize(() =>
			contextify.bindCache(compilation.compiler.root)
		);
		const getContextifyInContext = memoize(() =>
			contextify.bindContextCache(this.context, compilation.compiler.root)
		);
		const utils = {
			absolutify: (context, request) => {
				return context === this.context
					? getAbsolutifyInContext()(request)
					: getAbsolutify()(context, request);
			},
			contextify: (context, request) => {
				return context === this.context
					? getContextifyInContext()(request)
					: getContextify()(context, request);
			},
			createHash: type => {
				return createHash(type || compilation.outputOptions.hashFunction);
			}
		};
		const loaderContext = {
			version: 2,
			getOptions: schema => {
				const loader = this.getCurrentLoader(loaderContext);

				let { options } = loader;

				if (typeof options === "string") {
					if (options.startsWith("{") && options.endsWith("}")) {
						try {
							options = parseJson(options);
						} catch (e) {
							throw new Error(`Cannot parse string options: ${e.message}`);
						}
					} else {
						options = querystring.parse(options, "&", "=", {
							maxKeys: 0
						});
					}
				}

				if (options === null || options === undefined) {
					options = {};
				}

				if (schema) {
					let name = "Loader";
					let baseDataPath = "options";
					let match;
					if (schema.title && (match = /^(.+) (.+)$/.exec(schema.title))) {
						[, name, baseDataPath] = match;
					}
					getValidate()(schema, options, {
						name,
						baseDataPath
					});
				}

				return options;
			},
			emitWarning: warning => {
				if (!(warning instanceof Error)) {
					warning = new NonErrorEmittedError(warning);
				}
				this.addWarning(
					new ModuleWarning(warning, {
						from: getCurrentLoaderName()
					})
				);
			},
			emitError: error => {
				if (!(error instanceof Error)) {
					error = new NonErrorEmittedError(error);
				}
				this.addError(
					new ModuleError(error, {
						from: getCurrentLoaderName()
					})
				);
			},
			getLogger: name => {
				const currentLoader = this.getCurrentLoader(loaderContext);
				return compilation.getLogger(() =>
					[currentLoader && currentLoader.loader, name, this.identifier()]
						.filter(Boolean)
						.join("|")
				);
			},
			resolve(context, request, callback) {
				resolver.resolve({}, context, request, getResolveContext(), callback);
			},
			getResolve(options) {
				const child = options ? resolver.withOptions(options) : resolver;
				return (context, request, callback) => {
					if (callback) {
						child.resolve({}, context, request, getResolveContext(), callback);
					} else {
						return new Promise((resolve, reject) => {
							child.resolve(
								{},
								context,
								request,
								getResolveContext(),
								(err, result) => {
									if (err) reject(err);
									else resolve(result);
								}
							);
						});
					}
				};
			},
			emitFile: (name, content, sourceMap, assetInfo) => {
				if (!this.buildInfo.assets) {
					this.buildInfo.assets = Object.create(null);
					this.buildInfo.assetsInfo = new Map();
				}
				this.buildInfo.assets[name] = this.createSourceForAsset(
					options.context,
					name,
					content,
					sourceMap,
					compilation.compiler.root
				);
				this.buildInfo.assetsInfo.set(name, assetInfo);
			},
			addBuildDependency: dep => {
				if (this.buildInfo.buildDependencies === undefined) {
					this.buildInfo.buildDependencies = new LazySet();
				}
				this.buildInfo.buildDependencies.add(dep);
			},
			utils,
			rootContext: options.context,
			webpack: true,
			sourceMap: !!this.useSourceMap,
			mode: options.mode || "production",
			_module: this,
			_compilation: compilation,
			_compiler: compilation.compiler,
			fs: fs
		};

		Object.assign(loaderContext, options.loader);

		hooks.loader.call(loaderContext, this);

		return loaderContext;
	}

	getCurrentLoader(loaderContext, index = loaderContext.loaderIndex) {
		if (
			this.loaders &&
			this.loaders.length &&
			index < this.loaders.length &&
			index >= 0 &&
			this.loaders[index]
		) {
			return this.loaders[index];
		}
		return null;
	}

	/**
	 * @param {string} context the compilation context
	 * @param {string | Buffer} content the content
	 * @param {string | TODO} sourceMap an optional source map
	 * @param {Object=} associatedObjectForCache object for caching
	 * @returns {Source} the created source
	 */
	createSource(context, content, sourceMap, associatedObjectForCache) {
		if (Buffer.isBuffer(content)) {
			return new RawSource(content);
		}

		// if there is no identifier return raw source
		if (!this.identifier) {
			return new RawSource(content);
		}

		// from here on we assume we have an identifier
		const identifier = this.identifier();

		if (this.useSourceMap && sourceMap) {
			return new SourceMapSource(
				content,
				contextifySourceUrl(context, identifier, associatedObjectForCache),
				contextifySourceMap(context, sourceMap, associatedObjectForCache)
			);
		}

		if (this.useSourceMap || this.useSimpleSourceMap) {
			return new OriginalSource(
				content,
				contextifySourceUrl(context, identifier, associatedObjectForCache)
			);
		}

		return new RawSource(content);
	}

	/**
	 * 执行构建（执行 loader 的核心方法）⭐⭐⭐
	 *
	 * 【作用】
	 * 这是模块构建的核心步骤：
	 * 1. 创建 loader 上下文（loaderContext）
	 * 2. 执行 loader-runner
	 * 3. 读取源文件
	 * 4. 依次执行 loader 链
	 * 5. 返回转换后的源码
	 *
	 * 【完整流程】
	 * ```
	 * _doBuild
	 *   ├─ 创建 loaderContext（loader 上下文）
	 *   │   └─ 提供给 loader 的 API（this.xxx）
	 *   │
	 *   ├─ 初始化 buildInfo 的依赖集合
	 *   │   ├─ fileDependencies（文件依赖）
	 *   │   ├─ contextDependencies（目录依赖）
	 *   │   └─ missingDependencies（缺失的依赖）
	 *   │
	 *   ├─ 触发 beforeLoaders 钩子
	 *   │
	 *   ├─ runLoaders（执行 loader 链）⭐⭐⭐
	 *   │   ├─ 读取源文件内容
	 *   │   ├─ pitching 阶段（从左到右）
	 *   │   │   └─ loader.pitch()
	 *   │   ├─ normal 阶段（从右到左）
	 *   │   │   ├─ loader3(source) → transformed
	 *   │   │   ├─ loader2(transformed) → transformed
	 *   │   │   └─ loader1(transformed) → final
	 *   │   └─ 返回最终结果
	 *   │
	 *   └─ processResult（处理 loader 结果）
	 *       ├─ 创建 Source 对象
	 *       ├─ 提取 AST（如果 loader 提供）
	 *       └─ 完成
	 * ```
	 *
	 * 【Loader 执行顺序】⭐⭐
	 *
	 * 配置:
	 * ```javascript
	 * module: {
	 *   rules: [{
	 *     test: /\.js$/,
	 *     use: ['loader1', 'loader2', 'loader3']
	 *   }]
	 * }
	 * ```
	 *
	 * 执行顺序（从右到左）:
	 * ```
	 * 源文件
	 *   ↓
	 * loader3（最后一个先执行）
	 *   ↓
	 * loader2
	 *   ↓
	 * loader1（第一个最后执行）
	 *   ↓
	 * 最终代码（必须是 JS）
	 * ```
	 *
	 * 【Pitching 阶段】⭐
	 *
	 * 在 normal 阶段前，还有 pitching 阶段（从左到右）:
	 * ```
	 * loader1.pitch() → loader2.pitch() → loader3.pitch()
	 *
	 * 如果 pitch 返回值，跳过后续 loader:
	 * loader1.pitch() → [有返回值] → loader1() → 结束
	 * ```
	 *
	 * 【loaderContext（this）】⭐⭐
	 *
	 * loader 中的 this 是 loaderContext，提供：
	 * ```javascript
	 * module.exports = function(source) {
	 *   this.resource      // 文件路径
	 *   this.resourcePath  // 文件路径（不含查询）
	 *   this.context       // 文件所在目录
	 *   this.query         // 查询字符串
	 *   this.callback      // 异步回调
	 *   this.async         // 获取异步回调
	 *   this.cacheable     // 标记是否可缓存
	 *   this.addDependency // 添加文件依赖
	 *   this.emitFile      // 输出文件
	 *   // ... 更多 API
	 * }
	 * ```
	 *
	 * 【性能考虑】⭐
	 * - loader 执行占构建时间的 50-70%
	 * - babel-loader 特别慢（转译复杂）
	 * - 使用 cache-loader 可以缓存 loader 结果
	 * - 使用 thread-loader 可以在 worker 线程执行
	 *
	 * @param {WebpackOptions} options - webpack 选项
	 * @param {Compilation} compilation - 编译实例
	 * @param {ResolverWithOptions} resolver - 解析器
	 * @param {InputFileSystem} fs - 文件系统
	 * @param {NormalModuleCompilationHooks} hooks - 钩子
	 * @param {function((WebpackError | null)=): void} callback - 完成回调
	 * @returns {void}
	 */
	_doBuild(options, compilation, resolver, fs, hooks, callback) {
		// ===== 步骤1: 创建 loader 上下文 ⭐⭐ =====
		/**
		 * loaderContext 是传递给 loader 的 this 对象
		 *
		 * 【提供的 API】
		 * - resource: 文件路径
		 * - context: 文件目录
		 * - query: 查询参数
		 * - callback: 异步回调
		 * - async: 获取异步回调
		 * - cacheable: 标记缓存
		 * - addDependency: 添加依赖
		 * - emitFile: 输出文件
		 * - 等等...
		 *
		 * loader 通过 this 访问这些 API
		 */
		const loaderContext = this._createLoaderContext(
			resolver,
			options,
			compilation,
			fs,
			hooks
		);

		/**
		 * 处理 loader 执行结果
		 *
		 * 【参数】
		 * - err: loader 执行错误
		 * - result: [source, sourceMap, extraInfo]
		 *
		 * 【执行内容】
		 * 1. 处理错误
		 * 2. 验证结果（必须是 Buffer 或 String）
		 * 3. 创建 Source 对象
		 * 4. 提取 AST（如果有）
		 */
		const processResult = (err, result) => {
			if (err) {
				// 确保错误是 Error 实例
				if (!(err instanceof Error)) {
					err = new NonErrorEmittedError(err);
				}

				// 获取当前执行的 loader（用于错误报告）
				const currentLoader = this.getCurrentLoader(loaderContext);

				// 创建模块构建错误
				const error = new ModuleBuildError(err, {
					from:
						currentLoader &&
						compilation.runtimeTemplate.requestShortener.shorten(
							currentLoader.loader
						)
				});
				return callback(error);
			}

			// 提取 loader 返回的内容
			const source = result[0];          // 源码（必需）
			const sourceMap = result.length >= 1 ? result[1] : null;  // SourceMap（可选）
			const extraInfo = result.length >= 2 ? result[2] : null;  // 额外信息（可选）

			// 验证返回值类型
			if (!Buffer.isBuffer(source) && typeof source !== "string") {
				const currentLoader = this.getCurrentLoader(loaderContext, 0);
				const err = new Error(
					`Final loader (${
						currentLoader
							? compilation.runtimeTemplate.requestShortener.shorten(
									currentLoader.loader
							  )
							: "unknown"
					}) didn't return a Buffer or String`
				);
				const error = new ModuleBuildError(err);
				return callback(error);
			}

			// ===== 创建 Source 对象 ⭐ =====
			/**
			 * Source 对象封装了源码和 SourceMap
			 *
			 * 【类型】
			 * - RawSource: 只有源码
			 * - SourceMapSource: 源码 + SourceMap
			 * - CachedSource: 缓存的 Source
			 *
			 * 【用途】
			 * - 代码生成阶段使用
			 * - SourceMap 生成
			 * - 缓存优化
			 */
			this._source = this.createSource(
				options.context,
				this.binary ? asBuffer(source) : asString(source),  // 二进制 or 字符串
				sourceMap,
				compilation.compiler.root
			);

			// 清空大小缓存
			if (this._sourceSizes !== undefined) this._sourceSizes.clear();

			// ===== 提取 AST（如果 loader 提供）⭐ =====
			/**
			 * 某些 loader 可以返回预解析的 AST
			 *
			 * 【好处】
			 * - 避免重复解析（babel-loader 已经解析过）
			 * - 提升性能（跳过 acorn.parse）
			 *
			 * 【extraInfo.webpackAST】
			 * 符合 ESTree 规范的 AST 对象
			 */
			this._ast =
				typeof extraInfo === "object" &&
				extraInfo !== null &&
				extraInfo.webpackAST !== undefined
					? extraInfo.webpackAST
					: null;

			return callback();
		};

		// ===== 步骤2: 初始化 buildInfo 的依赖集合 =====
		/**
		 * 这些集合用于跟踪构建过程中访问的文件
		 *
		 * 【用途】
		 * watch 模式下，这些文件变化时需要重新构建此模块
		 */
		this.buildInfo.fileDependencies = new LazySet();      // 文件依赖
		this.buildInfo.contextDependencies = new LazySet();   // 目录依赖
		this.buildInfo.missingDependencies = new LazySet();   // 缺失的依赖
		this.buildInfo.cacheable = true;  // 默认可缓存（loader 可以改变）

		// ===== 步骤3: 触发 beforeLoaders 钩子 =====
		try {
			hooks.beforeLoaders.call(this.loaders, this, loaderContext);
		} catch (err) {
			processResult(err);
			return;
		}

		// 如果有 loader，初始化构建依赖集合
		if (this.loaders.length > 0) {
			this.buildInfo.buildDependencies = new LazySet();
		}

		// ===== 步骤4: 执行 loader-runner ⭐⭐⭐ =====
		/**
		 * runLoaders 是 loader-runner 库的主函数
		 *
		 * 【执行过程】
		 * 1. pitching 阶段（从左到右）
		 * 2. 读取源文件
		 * 3. normal 阶段（从右到左）
		 * 4. 返回最终结果
		 */
		runLoaders(
			{
				resource: this.resource,    // 文件路径
				loaders: this.loaders,      // loader 列表
				context: loaderContext,     // loader 上下文（this）

				/**
				 * processResource - 自定义的资源读取函数
				 *
				 * 【作用】
				 * 替代默认的 fs.readFile，支持：
				 * - 特殊协议（data:、http:等）
				 * - 虚拟文件系统
				 * - 自定义资源加载
				 *
				 * 【触发钩子】
				 * hooks.readResource.for(scheme)
				 * 允许插件自定义资源读取逻辑
				 */
				processResource: (loaderContext, resourcePath, callback) => {
					const resource = loaderContext.resource;
					const scheme = getScheme(resource);  // 提取协议（file:、http:等）

					// 触发 readResource 钩子（按协议）
					hooks.readResource
						.for(scheme)
						.callAsync(loaderContext, (err, result) => {
							if (err) return callback(err);
							if (typeof result !== "string" && !result) {
								// 不支持的协议
								return callback(new UnhandledSchemeError(scheme, resource));
							}
							return callback(null, result);
						});
				}
			},
			(err, result) => {
				// ===== 步骤5: loader 执行完成，处理结果 =====

				// 清理 loaderContext 避免内存泄漏
				// 这些引用会阻止 GC
				loaderContext._compilation =
					loaderContext._compiler =
					loaderContext._module =
					loaderContext.fs =
						undefined;

				// 检查结果
				if (!result) {
					this.buildInfo.cacheable = false;
					return processResult(
						err || new Error("No result from loader-runner processing"),
						null
					);
				}

				// ===== 步骤6: 收集依赖信息 =====
				/**
				 * loader 执行过程中访问的文件
				 *
				 * 【来源】
				 * - loader 调用 this.addDependency(file)
				 * - loader-runner 自动收集读取的文件
				 *
				 * 【用途】
				 * watch 模式下监听这些文件的变化
				 */
				this.buildInfo.fileDependencies.addAll(result.fileDependencies);
				this.buildInfo.contextDependencies.addAll(result.contextDependencies);
				this.buildInfo.missingDependencies.addAll(result.missingDependencies);

				// 记录使用的 loader（构建依赖）
				for (const loader of this.loaders) {
					this.buildInfo.buildDependencies.add(loader.loader);
				}

				// 更新缓存标记（所有 loader 都可缓存才行）
				this.buildInfo.cacheable = this.buildInfo.cacheable && result.cacheable;

				// 处理最终结果
				processResult(err, result.result);
			}
		);
	}

	/**
	 * @param {WebpackError} error the error
	 * @returns {void}
	 */
	markModuleAsErrored(error) {
		// Restore build meta from successful build to keep importing state
		this.buildMeta = { ...this._lastSuccessfulBuildMeta };
		this.error = error;
		this.addError(error);
	}

	applyNoParseRule(rule, content) {
		// must start with "rule" if rule is a string
		if (typeof rule === "string") {
			return content.startsWith(rule);
		}

		if (typeof rule === "function") {
			return rule(content);
		}
		// we assume rule is a regexp
		return rule.test(content);
	}

	// check if module should not be parsed
	// returns "true" if the module should !not! be parsed
	// returns "false" if the module !must! be parsed
	shouldPreventParsing(noParseRule, request) {
		// if no noParseRule exists, return false
		// the module !must! be parsed.
		if (!noParseRule) {
			return false;
		}

		// we only have one rule to check
		if (!Array.isArray(noParseRule)) {
			// returns "true" if the module is !not! to be parsed
			return this.applyNoParseRule(noParseRule, request);
		}

		for (let i = 0; i < noParseRule.length; i++) {
			const rule = noParseRule[i];
			// early exit on first truthy match
			// this module is !not! to be parsed
			if (this.applyNoParseRule(rule, request)) {
				return true;
			}
		}
		// no match found, so this module !should! be parsed
		return false;
	}

	_initBuildHash(compilation) {
		const hash = createHash(compilation.outputOptions.hashFunction);
		if (this._source) {
			hash.update("source");
			this._source.updateHash(hash);
		}
		hash.update("meta");
		hash.update(JSON.stringify(this.buildMeta));
		this.buildInfo.hash = /** @type {string} */ (hash.digest("hex"));
	}

	/**
	 * 构建模块（最核心的方法！）⭐⭐⭐
	 *
	 * 【作用】
	 * 这是模块构建的主方法，完成：
	 * 1. 读取源文件
	 * 2. 执行 loader 链
	 * 3. 解析 AST
	 * 4. 收集依赖
	 * 5. 生成 buildInfo 和 buildMeta
	 *
	 * 【完整流程】
	 * ```
	 * build()
	 *   ├─ 重置状态（清空依赖、错误等）
	 *   ├─ 初始化 buildInfo 和 buildMeta
	 *   ├─ _doBuild()（执行 loader 和读取文件）⭐⭐⭐
	 *   │   ├─ 读取源文件内容
	 *   │   ├─ 执行 loader-runner
	 *   │   │   ├─ pitching 阶段（从左到右）
	 *   │   │   └─ normal 阶段（从右到左）
	 *   │   └─ 返回转换后的源码
	 *   ├─ 创建 Source 对象
	 *   ├─ parser.parse()（解析 AST）⭐⭐⭐
	 *   │   ├─ acorn.parse() 生成 AST
	 *   │   ├─ 遍历 AST 节点
	 *   │   ├─ 遇到 import → 创建 HarmonyImportDependency
	 *   │   ├─ 遇到 require → 创建 CommonJsRequireDependency
	 *   │   ├─ 遇到 import() → 创建 ImportDependency
	 *   │   └─ 添加到 module.dependencies
	 *   ├─ 排序依赖（按源码位置）
	 *   ├─ 生成 buildHash
	 *   ├─ 创建文件系统快照（用于 watch）
	 *   └─ 完成构建
	 * ```
	 *
	 * 【buildInfo（构建信息）】
	 * ```javascript
	 * {
	 *   cacheable: true/false,           // 是否可缓存
	 *   fileDependencies: Set<string>,   // 文件依赖（watch 用）
	 *   contextDependencies: Set<string>, // 目录依赖
	 *   missingDependencies: Set<string>, // 缺失的依赖
	 *   hash: 'a1b2c3',                  // 模块内容哈希
	 *   assets: {...},                    // 生成的额外资源
	 * }
	 * ```
	 *
	 * 【buildMeta（构建元数据）】
	 * ```javascript
	 * {
	 *   exportsType: 'namespace',        // 导出类型
	 *   sideEffectFree: false,           // 是否无副作用（Tree Shaking）
	 *   providedExports: ['foo', 'bar'], // 提供的导出
	 *   strictHarmonyModule: true,       // 是否严格 ES Module
	 * }
	 * ```
	 *
	 * 【性能考虑】⭐
	 * - loader 执行是最耗时的（50-70% 的构建时间）
	 * - AST 解析次之（20-30% 的构建时间）
	 * - 因此缓存和增量构建非常重要
	 *
	 * @param {WebpackOptions} options - webpack 选项
	 * @param {Compilation} compilation - 编译实例
	 * @param {ResolverWithOptions} resolver - 解析器
	 * @param {InputFileSystem} fs - 文件系统
	 * @param {function(WebpackError=): void} callback - 完成回调
	 * @returns {void}
	 */
	build(options, compilation, resolver, fs, callback) {
		// ===== 步骤1: 重置模块状态 =====
		// 清空上次构建的所有信息，准备新的构建

		this._forceBuild = false;         // 重置强制构建标记
		this._source = null;              // 清空源码
		if (this._sourceSizes !== undefined) this._sourceSizes.clear();  // 清空大小信息
		this._sourceTypes = undefined;    // 清空类型信息
		this._ast = null;                 // 清空 AST
		this.error = null;                // 清空错误
		this.clearWarningsAndErrors();    // 清空警告和错误
		this.clearDependenciesAndBlocks();  // 清空依赖和代码块

		// ===== 步骤2: 初始化 buildMeta（构建元数据）=====
		/**
		 * buildMeta 存储模块的元数据：
		 * - exportsType: 导出类型（'namespace'、'default'等）
		 * - sideEffectFree: 是否无副作用（Tree Shaking 关键）
		 * - providedExports: 提供的导出列表
		 * - 等等...
		 */
		this.buildMeta = {};

		// ===== 步骤3: 初始化 buildInfo（构建信息）=====
		/**
		 * buildInfo 存储构建过程的信息：
		 * - cacheable: 是否可以缓存
		 * - fileDependencies: 依赖的文件（用于 watch）
		 * - hash: 模块内容哈希
		 * - assets: 生成的额外资源
		 */
		this.buildInfo = {
			cacheable: false,              // 默认不可缓存（loader 执行后更新）
			parsed: true,                  // 是否已解析
			fileDependencies: undefined,   // 文件依赖集合
			contextDependencies: undefined,  // 目录依赖集合
			missingDependencies: undefined,  // 缺失的依赖
			buildDependencies: undefined,    // 构建依赖
			valueDependencies: undefined,    // 值依赖
			hash: undefined,                 // 模块哈希
			assets: undefined,               // 额外生成的资源
			assetsInfo: undefined            // 资源信息
		};

		// 记录构建开始时间（用于 snapshot）
		const startTime = compilation.compiler.fsStartTime || Date.now();

		// 获取 NormalModule 的编译钩子
		const hooks = NormalModule.getCompilationHooks(compilation);

		// ===== 步骤4: 执行构建（_doBuild）⭐⭐⭐ =====
		/**
		 * _doBuild 是实际执行构建的方法：
		 * 1. 读取源文件
		 * 2. 执行 loader 链
		 * 3. 返回转换后的源码
		 */
		return this._doBuild(options, compilation, resolver, fs, hooks, err => {
			// 如果 _doBuild 出错（loader 执行失败等）
			if (err) {
				// 标记模块为错误状态
				this.markModuleAsErrored(err);
				// 初始化构建哈希
				this._initBuildHash(compilation);
				return callback();
			}

			/**
			 * 处理解析错误
			 *
			 * 【触发时机】
			 * parser.parse() 解析失败时
			 *
			 * 【错误场景】
			 * - 语法错误：const a = （少了右括号）
			 * - 不支持的语法：async await 在低版本
			 * - 解析器内部错误
			 *
			 * 【错误处理】
			 * 创建友好的错误信息，包含：
			 * - 源码内容
			 * - 错误位置
			 * - 使用的 loader 列表
			 * - 模块类型
			 */
			const handleParseError = e => {
				// 获取源码内容
				const source = this._source.source();

				// 获取 loader 列表（用于错误报告）
				const loaders = this.loaders.map(item =>
					contextify(options.context, item.loader, compilation.compiler.root)
				);

				// 创建模块解析错误
				const error = new ModuleParseError(source, e, loaders, this.type);

				// 标记模块为错误状态
				this.markModuleAsErrored(error);

				// 初始化构建哈希
				this._initBuildHash(compilation);

				return callback();
			};

			/**
			 * 处理解析成功
			 *
			 * 【执行内容】
			 * 1. 排序依赖（按源码位置）
			 * 2. 生成构建哈希
			 * 3. 保存成功的 buildMeta
			 * 4. 继续后续处理
			 *
			 * 【依赖排序】⭐
			 * 排序依赖是为了：
			 * - 确保构建的确定性（相同输入→相同输出）
			 * - 保持依赖的源码顺序（执行顺序）
			 *
			 * 【排序规则】
			 * 1. 按源码位置（行号、列号）
			 * 2. 如果位置相同，保持原始顺序
			 */
			const handleParseResult = result => {
				// 排序依赖列表
				this.dependencies.sort(
					concatComparators(
						compareSelect(a => a.loc, compareLocations),  // 按位置排序
						keepOriginalOrder(this.dependencies)           // 保持原始顺序
					)
				);

				// 生成构建哈希
				this._initBuildHash(compilation);

				// 保存成功的 buildMeta（用于增量构建）
				this._lastSuccessfulBuildMeta = this.buildMeta;

				// 继续后续处理
				return handleBuildDone();
			};

			const handleBuildDone = () => {
				try {
					hooks.beforeSnapshot.call(this);
				} catch (err) {
					this.markModuleAsErrored(err);
					return callback();
				}

				const snapshotOptions = compilation.options.snapshot.module;
				if (!this.buildInfo.cacheable || !snapshotOptions) {
					return callback();
				}
				// add warning for all non-absolute paths in fileDependencies, etc
				// This makes it easier to find problems with watching and/or caching
				let nonAbsoluteDependencies = undefined;
				const checkDependencies = deps => {
					for (const dep of deps) {
						if (!ABSOLUTE_PATH_REGEX.test(dep)) {
							if (nonAbsoluteDependencies === undefined)
								nonAbsoluteDependencies = new Set();
							nonAbsoluteDependencies.add(dep);
							deps.delete(dep);
							try {
								const depWithoutGlob = dep.replace(/[\\/]?\*.*$/, "");
								const absolute = join(
									compilation.fileSystemInfo.fs,
									this.context,
									depWithoutGlob
								);
								if (absolute !== dep && ABSOLUTE_PATH_REGEX.test(absolute)) {
									(depWithoutGlob !== dep
										? this.buildInfo.contextDependencies
										: deps
									).add(absolute);
								}
							} catch (e) {
								// ignore
							}
						}
					}
				};
				checkDependencies(this.buildInfo.fileDependencies);
				checkDependencies(this.buildInfo.missingDependencies);
				checkDependencies(this.buildInfo.contextDependencies);
				if (nonAbsoluteDependencies !== undefined) {
					const InvalidDependenciesModuleWarning =
						getInvalidDependenciesModuleWarning();
					this.addWarning(
						new InvalidDependenciesModuleWarning(this, nonAbsoluteDependencies)
					);
				}
				// convert file/context/missingDependencies into filesystem snapshot
				compilation.fileSystemInfo.createSnapshot(
					startTime,
					this.buildInfo.fileDependencies,
					this.buildInfo.contextDependencies,
					this.buildInfo.missingDependencies,
					snapshotOptions,
					(err, snapshot) => {
						if (err) {
							this.markModuleAsErrored(err);
							return;
						}
						this.buildInfo.fileDependencies = undefined;
						this.buildInfo.contextDependencies = undefined;
						this.buildInfo.missingDependencies = undefined;
						this.buildInfo.snapshot = snapshot;
						return callback();
					}
				);
			};

			try {
				hooks.beforeParse.call(this);
			} catch (err) {
				this.markModuleAsErrored(err);
				this._initBuildHash(compilation);
				return callback();
			}

			// check if this module should !not! be parsed.
			// if so, exit here;
			const noParseRule = options.module && options.module.noParse;
			if (this.shouldPreventParsing(noParseRule, this.request)) {
				// We assume that we need module and exports
				this.buildInfo.parsed = false;
				this._initBuildHash(compilation);
				return handleBuildDone();
			}

			let result;
			try {
				const source = this._source.source();
				result = this.parser.parse(this._ast || source, {
					source,
					current: this,
					module: this,
					compilation: compilation,
					options: options
				});
			} catch (e) {
				handleParseError(e);
				return;
			}
			handleParseResult(result);
		});
	}

	/**
	 * @param {ConcatenationBailoutReasonContext} context context
	 * @returns {string | undefined} reason why this module can't be concatenated, undefined when it can be concatenated
	 */
	getConcatenationBailoutReason(context) {
		return this.generator.getConcatenationBailoutReason(this, context);
	}

	/**
	 * @param {ModuleGraph} moduleGraph the module graph
	 * @returns {ConnectionState} how this module should be connected to referencing modules when consumed for side-effects only
	 */
	getSideEffectsConnectionState(moduleGraph) {
		if (this.factoryMeta !== undefined) {
			if (this.factoryMeta.sideEffectFree) return false;
			if (this.factoryMeta.sideEffectFree === false) return true;
		}
		if (this.buildMeta !== undefined && this.buildMeta.sideEffectFree) {
			if (this._isEvaluatingSideEffects)
				return ModuleGraphConnection.CIRCULAR_CONNECTION;
			this._isEvaluatingSideEffects = true;
			/** @type {ConnectionState} */
			let current = false;
			for (const dep of this.dependencies) {
				const state = dep.getModuleEvaluationSideEffectsState(moduleGraph);
				if (state === true) {
					if (
						this._addedSideEffectsBailout === undefined
							? ((this._addedSideEffectsBailout = new WeakSet()), true)
							: !this._addedSideEffectsBailout.has(moduleGraph)
					) {
						this._addedSideEffectsBailout.add(moduleGraph);
						moduleGraph
							.getOptimizationBailout(this)
							.push(
								() =>
									`Dependency (${
										dep.type
									}) with side effects at ${formatLocation(dep.loc)}`
							);
					}
					this._isEvaluatingSideEffects = false;
					return true;
				} else if (state !== ModuleGraphConnection.CIRCULAR_CONNECTION) {
					current = ModuleGraphConnection.addConnectionStates(current, state);
				}
			}
			this._isEvaluatingSideEffects = false;
			// When caching is implemented here, make sure to not cache when
			// at least one circular connection was in the loop above
			return current;
		} else {
			return true;
		}
	}

	/**
	 * @returns {Set<string>} types available (do not mutate)
	 */
	getSourceTypes() {
		if (this._sourceTypes === undefined) {
			this._sourceTypes = this.generator.getTypes(this);
		}
		return this._sourceTypes;
	}

	/**
	 * @param {CodeGenerationContext} context context for code generation
	 * @returns {CodeGenerationResult} result
	 */
	codeGeneration({
		dependencyTemplates,
		runtimeTemplate,
		moduleGraph,
		chunkGraph,
		runtime,
		concatenationScope,
		codeGenerationResults,
		sourceTypes
	}) {
		/** @type {Set<string>} */
		const runtimeRequirements = new Set();

		if (!this.buildInfo.parsed) {
			runtimeRequirements.add(RuntimeGlobals.module);
			runtimeRequirements.add(RuntimeGlobals.exports);
			runtimeRequirements.add(RuntimeGlobals.thisAsExports);
		}

		/** @type {function(): Map<string, any>} */
		const getData = () => {
			return this._codeGeneratorData;
		};

		const sources = new Map();
		for (const type of sourceTypes || chunkGraph.getModuleSourceTypes(this)) {
			const source = this.error
				? new RawSource(
						"throw new Error(" + JSON.stringify(this.error.message) + ");"
				  )
				: this.generator.generate(this, {
						dependencyTemplates,
						runtimeTemplate,
						moduleGraph,
						chunkGraph,
						runtimeRequirements,
						runtime,
						concatenationScope,
						codeGenerationResults,
						getData,
						type
				  });

			if (source) {
				sources.set(type, new CachedSource(source));
			}
		}

		/** @type {CodeGenerationResult} */
		const resultEntry = {
			sources,
			runtimeRequirements,
			data: this._codeGeneratorData
		};
		return resultEntry;
	}

	/**
	 * @returns {Source | null} the original source for the module before webpack transformation
	 */
	originalSource() {
		return this._source;
	}

	/**
	 * @returns {void}
	 */
	invalidateBuild() {
		this._forceBuild = true;
	}

	/**
	 * @param {NeedBuildContext} context context info
	 * @param {function((WebpackError | null)=, boolean=): void} callback callback function, returns true, if the module needs a rebuild
	 * @returns {void}
	 */
	needBuild(context, callback) {
		const { fileSystemInfo, compilation, valueCacheVersions } = context;
		// build if enforced
		if (this._forceBuild) return callback(null, true);

		// always try to build in case of an error
		if (this.error) return callback(null, true);

		// always build when module is not cacheable
		if (!this.buildInfo.cacheable) return callback(null, true);

		// build when there is no snapshot to check
		if (!this.buildInfo.snapshot) return callback(null, true);

		// build when valueDependencies have changed
		/** @type {Map<string, string | Set<string>>} */
		const valueDependencies = this.buildInfo.valueDependencies;
		if (valueDependencies) {
			if (!valueCacheVersions) return callback(null, true);
			for (const [key, value] of valueDependencies) {
				if (value === undefined) return callback(null, true);
				const current = valueCacheVersions.get(key);
				if (
					value !== current &&
					(typeof value === "string" ||
						typeof current === "string" ||
						current === undefined ||
						!isSubset(value, current))
				) {
					return callback(null, true);
				}
			}
		}

		// check snapshot for validity
		fileSystemInfo.checkSnapshotValid(this.buildInfo.snapshot, (err, valid) => {
			if (err) return callback(err);
			if (!valid) return callback(null, true);
			const hooks = NormalModule.getCompilationHooks(compilation);
			hooks.needBuild.callAsync(this, context, (err, needBuild) => {
				if (err) {
					return callback(
						HookWebpackError.makeWebpackError(
							err,
							"NormalModule.getCompilationHooks().needBuild"
						)
					);
				}
				callback(null, !!needBuild);
			});
		});
	}

	/**
	 * @param {string=} type the source type for which the size should be estimated
	 * @returns {number} the estimated size of the module (must be non-zero)
	 */
	size(type) {
		const cachedSize =
			this._sourceSizes === undefined ? undefined : this._sourceSizes.get(type);
		if (cachedSize !== undefined) {
			return cachedSize;
		}
		const size = Math.max(1, this.generator.getSize(this, type));
		if (this._sourceSizes === undefined) {
			this._sourceSizes = new Map();
		}
		this._sourceSizes.set(type, size);
		return size;
	}

	/**
	 * @param {LazySet<string>} fileDependencies set where file dependencies are added to
	 * @param {LazySet<string>} contextDependencies set where context dependencies are added to
	 * @param {LazySet<string>} missingDependencies set where missing dependencies are added to
	 * @param {LazySet<string>} buildDependencies set where build dependencies are added to
	 */
	addCacheDependencies(
		fileDependencies,
		contextDependencies,
		missingDependencies,
		buildDependencies
	) {
		const { snapshot, buildDependencies: buildDeps } = this.buildInfo;
		if (snapshot) {
			fileDependencies.addAll(snapshot.getFileIterable());
			contextDependencies.addAll(snapshot.getContextIterable());
			missingDependencies.addAll(snapshot.getMissingIterable());
		} else {
			const {
				fileDependencies: fileDeps,
				contextDependencies: contextDeps,
				missingDependencies: missingDeps
			} = this.buildInfo;
			if (fileDeps !== undefined) fileDependencies.addAll(fileDeps);
			if (contextDeps !== undefined) contextDependencies.addAll(contextDeps);
			if (missingDeps !== undefined) missingDependencies.addAll(missingDeps);
		}
		if (buildDeps !== undefined) {
			buildDependencies.addAll(buildDeps);
		}
	}

	/**
	 * @param {Hash} hash the hash used to track dependencies
	 * @param {UpdateHashContext} context context
	 * @returns {void}
	 */
	updateHash(hash, context) {
		hash.update(this.buildInfo.hash);
		this.generator.updateHash(hash, {
			module: this,
			...context
		});
		super.updateHash(hash, context);
	}

	/**
	 * @param {ObjectSerializerContext} context context
	 */
	serialize(context) {
		const { write } = context;
		// deserialize
		write(this._source);
		write(this.error);
		write(this._lastSuccessfulBuildMeta);
		write(this._forceBuild);
		write(this._codeGeneratorData);
		super.serialize(context);
	}

	static deserialize(context) {
		const obj = new NormalModule({
			// will be deserialized by Module
			layer: null,
			type: "",
			// will be filled by updateCacheModule
			resource: "",
			context: "",
			request: null,
			userRequest: null,
			rawRequest: null,
			loaders: null,
			matchResource: null,
			parser: null,
			parserOptions: null,
			generator: null,
			generatorOptions: null,
			resolveOptions: null
		});
		obj.deserialize(context);
		return obj;
	}

	/**
	 * @param {ObjectDeserializerContext} context context
	 */
	deserialize(context) {
		const { read } = context;
		this._source = read();
		this.error = read();
		this._lastSuccessfulBuildMeta = read();
		this._forceBuild = read();
		this._codeGeneratorData = read();
		super.deserialize(context);
	}
}

makeSerializable(NormalModule, "webpack/lib/NormalModule");

module.exports = NormalModule;
