/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

/**
 * lib/NormalModuleFactory.js - 普通模块工厂 ⭐⭐⭐
 *
 * 【文件作用】
 * NormalModuleFactory 是创建 NormalModule 的工厂，负责：
 * 1. 解析模块路径（使用 enhanced-resolve）
 * 2. 匹配 loader 规则（基于 module.rules）
 * 3. 确定 parser 和 generator
 * 4. 创建 NormalModule 实例
 *
 * 【核心职责】
 *
 * 1. **路径解析**：
 *    './a.js' → '/absolute/path/to/a.js'
 *    使用 resolverFactory 创建的解析器
 *
 * 2. **Loader 匹配**：
 *    根据 module.rules 配置匹配 loader：
 *    - test: /\.js$/ → 匹配 .js 文件
 *    - use: ['babel-loader'] → 使用 babel-loader
 *
 * 3. **模块创建**：
 *    根据解析和匹配的结果，创建 NormalModule 实例
 *
 * 【工厂模式】⭐
 *
 * 工厂模式的优势：
 * - 封装复杂的创建逻辑
 * - 统一的创建接口
 * - 支持钩子扩展
 *
 * ```javascript
 * // 使用工厂创建模块
 * normalModuleFactory.create({
 *   context: '/project',
 *   dependencies: [dependency],
 *   ...
 * }, (err, module) => {
 *   // module 是创建好的 NormalModule 实例
 * });
 * ```
 *
 * 【钩子系统】
 *
 * NormalModuleFactory 提供丰富的钩子供插件扩展：
 *
 * - beforeResolve: 解析前（可以修改请求）
 * - resolve: 解析阶段
 * - afterResolve: 解析后（可以修改解析结果）
 * - createModule: 创建模块前
 * - module: 模块创建后
 *
 * 【Loader 匹配流程】
 *
 * ```
 * 1. 解析请求路径
 *    './src/index.js' → '/project/src/index.js'
 *
 * 2. 遍历 module.rules
 *    for (const rule of rules) {
 *      if (rule.test.test('/project/src/index.js')) {
 *        匹配成功，应用 rule.use
 *      }
 *    }
 *
 * 3. 合并 loader
 *    - inline loader（请求字符串中的）
 *    - pre loader（rule.enforce: 'pre'）
 *    - normal loader（普通 rule）
 *    - post loader（rule.enforce: 'post'）
 *
 * 4. 返回 loader 列表
 *    [
 *      { loader: 'babel-loader', options: {...} },
 *      { loader: 'ts-loader', options: {...} }
 *    ]
 * ```
 *
 * 【解析器（Resolver）】
 *
 * 使用 enhanced-resolve 库：
 * - 支持别名（alias）
 * - 支持扩展名自动补全（extensions）
 * - 支持模块查找路径（modules: ['node_modules']）
 * - 支持条件导出（exports field）
 *
 * 【创建时机】
 * 在 Compiler.compile() 开始时创建：
 * ```javascript
 * const params = {
 *   normalModuleFactory: new NormalModuleFactory(...),
 *   contextModuleFactory: new ContextModuleFactory(...)
 * };
 * ```
 *
 * 【与其他工厂的区别】
 * - NormalModuleFactory: 普通文件（最常用）
 * - ContextModuleFactory: require.context()
 * - DelegatedModuleFactory: DLL 模块
 * - ExternalModuleFactory: 外部模块
 */

"use strict";

const { getContext } = require("loader-runner");
const asyncLib = require("neo-async");
const {
	AsyncSeriesBailHook,
	SyncWaterfallHook,
	SyncBailHook,
	SyncHook,
	HookMap
} = require("tapable");
const ChunkGraph = require("./ChunkGraph");
const Module = require("./Module");
const ModuleFactory = require("./ModuleFactory");
const ModuleGraph = require("./ModuleGraph");
const { JAVASCRIPT_MODULE_TYPE_AUTO } = require("./ModuleTypeConstants");
const NormalModule = require("./NormalModule");
const BasicEffectRulePlugin = require("./rules/BasicEffectRulePlugin");
const BasicMatcherRulePlugin = require("./rules/BasicMatcherRulePlugin");
const ObjectMatcherRulePlugin = require("./rules/ObjectMatcherRulePlugin");
const RuleSetCompiler = require("./rules/RuleSetCompiler");
const UseEffectRulePlugin = require("./rules/UseEffectRulePlugin");
const LazySet = require("./util/LazySet");
const { getScheme } = require("./util/URLAbsoluteSpecifier");
const { cachedCleverMerge, cachedSetProperty } = require("./util/cleverMerge");
const { join } = require("./util/fs");
const {
	parseResource,
	parseResourceWithoutFragment
} = require("./util/identifier");

/** @typedef {import("../declarations/WebpackOptions").ModuleOptionsNormalized} ModuleOptions */
/** @typedef {import("../declarations/WebpackOptions").RuleSetRule} RuleSetRule */
/** @typedef {import("./Generator")} Generator */
/** @typedef {import("./ModuleFactory").ModuleFactoryCreateData} ModuleFactoryCreateData */
/** @typedef {import("./ModuleFactory").ModuleFactoryResult} ModuleFactoryResult */
/** @typedef {import("./NormalModule").NormalModuleCreateData} NormalModuleCreateData */
/** @typedef {import("./Parser")} Parser */
/** @typedef {import("./ResolverFactory")} ResolverFactory */
/** @typedef {import("./dependencies/ModuleDependency")} ModuleDependency */
/** @typedef {import("./util/fs").InputFileSystem} InputFileSystem */

/** @typedef {Pick<RuleSetRule, 'type'|'sideEffects'|'parser'|'generator'|'resolve'|'layer'>} ModuleSettings */
/** @typedef {Partial<NormalModuleCreateData & {settings: ModuleSettings}>} CreateData */

/**
 * @typedef {Object} ResolveData
 * @property {ModuleFactoryCreateData["contextInfo"]} contextInfo
 * @property {ModuleFactoryCreateData["resolveOptions"]} resolveOptions
 * @property {string} context
 * @property {string} request
 * @property {Record<string, any> | undefined} assertions
 * @property {ModuleDependency[]} dependencies
 * @property {string} dependencyType
 * @property {CreateData} createData
 * @property {LazySet<string>} fileDependencies
 * @property {LazySet<string>} missingDependencies
 * @property {LazySet<string>} contextDependencies
 * @property {boolean} cacheable allow to use the unsafe cache
 */

/**
 * @typedef {Object} ResourceData
 * @property {string} resource
 * @property {string} path
 * @property {string} query
 * @property {string} fragment
 * @property {string=} context
 */

/** @typedef {ResourceData & { data: Record<string, any> }} ResourceDataWithData */

/** @typedef {Object} ParsedLoaderRequest
 * @property {string} loader loader
 * @property {string|undefined} options options
 */

const EMPTY_RESOLVE_OPTIONS = {};
const EMPTY_PARSER_OPTIONS = {};
const EMPTY_GENERATOR_OPTIONS = {};
const EMPTY_ELEMENTS = [];

const MATCH_RESOURCE_REGEX = /^([^!]+)!=!/;
const LEADING_DOT_EXTENSION_REGEX = /^[^.]/;

const loaderToIdent = data => {
	if (!data.options) {
		return data.loader;
	}
	if (typeof data.options === "string") {
		return data.loader + "?" + data.options;
	}
	if (typeof data.options !== "object") {
		throw new Error("loader options must be string or object");
	}
	if (data.ident) {
		return data.loader + "??" + data.ident;
	}
	return data.loader + "?" + JSON.stringify(data.options);
};

const stringifyLoadersAndResource = (loaders, resource) => {
	let str = "";
	for (const loader of loaders) {
		str += loaderToIdent(loader) + "!";
	}
	return str + resource;
};

const needCalls = (times, callback) => {
	return err => {
		if (--times === 0) {
			return callback(err);
		}
		if (err && times > 0) {
			times = NaN;
			return callback(err);
		}
	};
};

const mergeGlobalOptions = (globalOptions, type, localOptions) => {
	const parts = type.split("/");
	let result;
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		const options = globalOptions[current];
		if (typeof options === "object") {
			if (result === undefined) {
				result = options;
			} else {
				result = cachedCleverMerge(result, options);
			}
		}
	}
	if (result === undefined) {
		return localOptions;
	} else {
		return cachedCleverMerge(result, localOptions);
	}
};

// TODO webpack 6 remove
const deprecationChangedHookMessage = (name, hook) => {
	const names = hook.taps
		.map(tapped => {
			return tapped.name;
		})
		.join(", ");

	return (
		`NormalModuleFactory.${name} (${names}) is no longer a waterfall hook, but a bailing hook instead. ` +
		"Do not return the passed object, but modify it instead. " +
		"Returning false will ignore the request and results in no module created."
	);
};

const ruleSetCompiler = new RuleSetCompiler([
	new BasicMatcherRulePlugin("test", "resource"),
	new BasicMatcherRulePlugin("scheme"),
	new BasicMatcherRulePlugin("mimetype"),
	new BasicMatcherRulePlugin("dependency"),
	new BasicMatcherRulePlugin("include", "resource"),
	new BasicMatcherRulePlugin("exclude", "resource", true),
	new BasicMatcherRulePlugin("resource"),
	new BasicMatcherRulePlugin("resourceQuery"),
	new BasicMatcherRulePlugin("resourceFragment"),
	new BasicMatcherRulePlugin("realResource"),
	new BasicMatcherRulePlugin("issuer"),
	new BasicMatcherRulePlugin("compiler"),
	new BasicMatcherRulePlugin("issuerLayer"),
	new ObjectMatcherRulePlugin("assert", "assertions"),
	new ObjectMatcherRulePlugin("descriptionData"),
	new BasicEffectRulePlugin("type"),
	new BasicEffectRulePlugin("sideEffects"),
	new BasicEffectRulePlugin("parser"),
	new BasicEffectRulePlugin("resolve"),
	new BasicEffectRulePlugin("generator"),
	new BasicEffectRulePlugin("layer"),
	new UseEffectRulePlugin()
]);

class NormalModuleFactory extends ModuleFactory {
	/**
	 * @param {Object} param params
	 * @param {string=} param.context context
	 * @param {InputFileSystem} param.fs file system
	 * @param {ResolverFactory} param.resolverFactory resolverFactory
	 * @param {ModuleOptions} param.options options
	 * @param {Object=} param.associatedObjectForCache an object to which the cache will be attached
	 * @param {boolean=} param.layers enable layers
	 */
	constructor({
		context,
		fs,
		resolverFactory,
		options,
		associatedObjectForCache,
		layers = false
	}) {
		super();
		this.hooks = Object.freeze({
			/** @type {AsyncSeriesBailHook<[ResolveData], Module | false | void>} */
			resolve: new AsyncSeriesBailHook(["resolveData"]),
			/** @type {HookMap<AsyncSeriesBailHook<[ResourceDataWithData, ResolveData], true | void>>} */
			resolveForScheme: new HookMap(
				() => new AsyncSeriesBailHook(["resourceData", "resolveData"])
			),
			/** @type {HookMap<AsyncSeriesBailHook<[ResourceDataWithData, ResolveData], true | void>>} */
			resolveInScheme: new HookMap(
				() => new AsyncSeriesBailHook(["resourceData", "resolveData"])
			),
			/** @type {AsyncSeriesBailHook<[ResolveData], Module>} */
			factorize: new AsyncSeriesBailHook(["resolveData"]),
			/** @type {AsyncSeriesBailHook<[ResolveData], false | void>} */
			beforeResolve: new AsyncSeriesBailHook(["resolveData"]),
			/** @type {AsyncSeriesBailHook<[ResolveData], false | void>} */
			afterResolve: new AsyncSeriesBailHook(["resolveData"]),
			/** @type {AsyncSeriesBailHook<[ResolveData["createData"], ResolveData], Module | void>} */
			createModule: new AsyncSeriesBailHook(["createData", "resolveData"]),
			/** @type {SyncWaterfallHook<[Module, ResolveData["createData"], ResolveData], Module>} */
			module: new SyncWaterfallHook(["module", "createData", "resolveData"]),
			createParser: new HookMap(() => new SyncBailHook(["parserOptions"])),
			parser: new HookMap(() => new SyncHook(["parser", "parserOptions"])),
			createGenerator: new HookMap(
				() => new SyncBailHook(["generatorOptions"])
			),
			generator: new HookMap(
				() => new SyncHook(["generator", "generatorOptions"])
			),
			createModuleClass: new HookMap(
				() => new SyncBailHook(["createData", "resolveData"])
			)
		});
		this.resolverFactory = resolverFactory;
		this.ruleSet = ruleSetCompiler.compile([
			{
				rules: options.defaultRules
			},
			{
				rules: options.rules
			}
		]);
		this.context = context || "";
		this.fs = fs;
		this._globalParserOptions = options.parser;
		this._globalGeneratorOptions = options.generator;
		/** @type {Map<string, WeakMap<Object, TODO>>} */
		this.parserCache = new Map();
		/** @type {Map<string, WeakMap<Object, Generator>>} */
		this.generatorCache = new Map();
		/** @type {Set<Module>} */
		this._restoredUnsafeCacheEntries = new Set();

		const cacheParseResource = parseResource.bindCache(
			associatedObjectForCache
		);
		const cachedParseResourceWithoutFragment =
			parseResourceWithoutFragment.bindCache(associatedObjectForCache);
		this._parseResourceWithoutFragment = cachedParseResourceWithoutFragment;

		// ===== 注册 factorize 钩子（模块创建的核心流程）⭐⭐⭐ =====
		/**
		 * factorize 钩子负责完整的模块创建流程：
		 * 1. resolve: 解析模块路径
		 * 2. afterResolve: 匹配 loader
		 * 3. createModule: 创建模块实例
		 * 4. module: 模块后处理
		 *
		 * 【执行顺序】
		 * factorize → resolve → afterResolve → createModule → module
		 */
		this.hooks.factorize.tapAsync(
			{
				name: "NormalModuleFactory",
				stage: 100  // 默认阶段
			},
			(resolveData, callback) => {
				// ===== 步骤1: 触发 resolve 钩子（解析路径）⭐⭐⭐ =====
				/**
				 * resolve 钩子负责将请求路径解析为绝对路径
				 *
				 * 【输入】
				 * request: './a.js'
				 * context: '/project/src'
				 *
				 * 【输出】
				 * resource: '/project/src/a.js'
				 *
				 * 【使用】
				 * enhanced-resolve 库处理：
				 * - 别名（alias）
				 * - 扩展名补全（extensions）
				 * - 模块查找（modules: ['node_modules']）
				 */
				this.hooks.resolve.callAsync(resolveData, (err, result) => {
					// 解析错误
					if (err) return callback(err);

					// ===== 检查解析结果 =====

					// 结果为 false：忽略该依赖
					if (result === false) return callback();

					// 结果是 Module：直接返回（插件提供的模块）
					if (result instanceof Module) return callback(null, result);

					// 向后兼容性检查
					if (typeof result === "object")
						throw new Error(
							deprecationChangedHookMessage("resolve", this.hooks.resolve) +
								" Returning a Module object will result in this module used as result."
						);

					// ===== 步骤2: 触发 afterResolve 钩子（匹配 loader）⭐⭐⭐ =====
					/**
					 * afterResolve 钩子负责：
					 * 1. 根据 module.rules 匹配 loader
					 * 2. 确定 parser 和 generator
					 * 3. 填充 createData
					 *
					 * 【关键】
					 * 这一步决定了使用哪些 loader 处理模块
					 *
					 * 【匹配规则】
					 * module.rules: [
					 *   {
					 *     test: /\.js$/,        // 测试文件路径
					 *     use: ['babel-loader'] // 使用的 loader
					 *   }
					 * ]
					 */
					this.hooks.afterResolve.callAsync(resolveData, (err, result) => {
						// afterResolve 错误
						if (err) return callback(err);

						// 向后兼容性检查
						if (typeof result === "object")
							throw new Error(
								deprecationChangedHookMessage(
									"afterResolve",
									this.hooks.afterResolve
								)
							);

						// 结果为 false：忽略该模块
						if (result === false) return callback();

						// ===== 步骤3: 获取创建数据 =====
						/**
						 * createData 包含创建模块所需的所有信息：
						 * - resource: 文件绝对路径
						 * - loaders: loader 列表
						 * - parser: 解析器
						 * - generator: 代码生成器
						 * - type: 模块类型
						 * - etc...
						 *
						 * 这些数据在 afterResolve 钩子中被填充
						 */
						const createData = resolveData.createData;

						// ===== 步骤4: 触发 createModule 钩子 =====
						/**
						 * createModule 钩子允许插件：
						 * - 自定义模块创建逻辑
						 * - 返回特殊的模块类型
						 * - 修改创建数据
						 */
						this.hooks.createModule.callAsync(
							createData,
							resolveData,
							(err, createdModule) => {
								// ===== 步骤5: 创建模块实例 ⭐⭐ =====

								if (!createdModule) {
									// 插件没有创建模块，使用默认逻辑

									// 检查请求是否为空
									if (!resolveData.request) {
										return callback(new Error("Empty dependency (no request)"));
									}

									// ===== 尝试使用 createModuleClass 钩子 =====
									/**
									 * 不同的模块类型可能需要不同的模块类
									 *
									 * 【类型映射】
									 * - 'javascript/auto' → NormalModule
									 * - 'javascript/esm' → NormalModule
									 * - 'asset' → AssetModule
									 * - 'webassembly/async' → AsyncWebAssemblyModule
									 */
									createdModule = this.hooks.createModuleClass
										.for(createData.settings.type)
										.call(createData, resolveData);

									if (!createdModule) {
										// 没有特殊的模块类，使用默认的 NormalModule
										createdModule = /** @type {Module} */ (
											new NormalModule(
												/** @type {NormalModuleCreateData} */ (createData)
											)
										);
									}
								}

								// ===== 步骤6: 触发 module 钩子（模块后处理）=====
								/**
								 * module 钩子允许插件：
								 * - 修改创建的模块
								 * - 包装模块
								 * - 添加额外属性
								 *
								 * 【返回】
								 * 最终的模块实例（可能被插件修改过）
								 */
								createdModule = this.hooks.module.call(
									createdModule,
									createData,
									resolveData
								);

								// ===== 步骤7: 返回创建的模块 =====
								return callback(null, createdModule);
							}
						);
					});
				});
			}
		);
		// ===== 注册 resolve 钩子（路径解析的核心）⭐⭐⭐ =====
		/**
		 * resolve 钩子负责解析模块路径和处理 inline loader
		 *
		 * 【执行内容】
		 * 1. 解析 inline loader（请求字符串中的 loader）
		 * 2. 解析资源路径
		 * 3. 解析 loader 路径
		 * 4. 合并所有 loader
		 * 5. 确定 parser 和 generator
		 */
		this.hooks.resolve.tapAsync(
			{
				name: "NormalModuleFactory",
				stage: 100  // 默认阶段
			},
			(data, callback) => {
				// ===== 步骤1: 提取解析数据 =====
				const {
					contextInfo,           // 上下文信息
					context,               // 上下文路径
					dependencies,          // 依赖列表
					dependencyType,        // 依赖类型
					request,               // 请求字符串（可能包含 loader）
					assertions,            // import 断言
					resolveOptions,        // 解析选项
					fileDependencies,      // 文件依赖集合
					missingDependencies,   // 缺失依赖集合
					contextDependencies    // 目录依赖集合
				} = data;

				// 获取 loader 解析器（用于解析 loader 路径）
				const loaderResolver = this.getResolver("loader");

				// ===== 步骤2: 初始化变量 =====

				/**
				 * matchResourceData: 匹配的资源数据
				 *
				 * 【用途】
				 * 某些 loader 使用不同的路径进行规则匹配
				 * 格式：matchResource!=!actualResource
				 *
				 * @type {ResourceData | undefined}
				 */
				let matchResourceData = undefined;

				/**
				 * unresolvedResource: 未解析的资源路径
				 * 例如：'./a.js'、'lodash'
				 * @type {string}
				 */
				let unresolvedResource;

				/**
				 * elements: inline loader 列表
				 *
				 * 【格式】
				 * [
				 *   { loader: 'babel-loader', options: '...' },
				 *   { loader: 'ts-loader', options: undefined }
				 * ]
				 *
				 * @type {ParsedLoaderRequest[]}
				 */
				let elements;

				// ===== Loader 前缀标记 ⭐⭐ =====
				/**
				 * webpack 支持 loader 前缀控制自动 loader：
				 *
				 * -!  : 禁用所有 pre loader
				 * !   : 禁用所有 normal loader
				 * !!  : 禁用所有 pre、normal、post loader
				 *
				 * 【示例】
				 * import '!raw-loader!./file.txt'
				 * → 只使用 raw-loader，忽略配置的 loader
				 */
				let noPreAutoLoaders = false;      // 禁用 pre loader
				let noAutoLoaders = false;         // 禁用 normal loader
				let noPrePostAutoLoaders = false;  // 禁用 pre 和 post loader

				// ===== 步骤3: 提取协议（scheme）=====
				/**
				 * scheme 是 URL 协议
				 *
				 * 【示例】
				 * - file:///path → 'file'
				 * - http://example.com → 'http'
				 * - data:text/plain;base64,... → 'data'
				 * - 无协议：undefined
				 */
				const contextScheme = getScheme(context);
				/** @type {string | undefined} */
				let scheme = getScheme(request);

				// ===== 步骤4: 解析 inline loader（如果没有协议）⭐⭐⭐ =====
				if (!scheme) {
					// 没有协议，可能包含 inline loader

					/** @type {string} */
					let requestWithoutMatchResource = request;

					// ===== 处理 matchResource ⭐ =====
					/**
					 * matchResource 语法：matchResource!=!actualResource
					 *
					 * 【作用】
					 * 让 loader 规则匹配 matchResource 而不是 actualResource
					 *
					 * 【示例】
					 * import 'style.css!=!./style.scss'
					 * - style.css: 用于匹配 loader 规则（匹配 .css loader）
					 * - style.scss: 实际加载的文件
					 *
					 * 【用途】
					 * - 虚拟文件名
					 * - 特殊的 loader 匹配
					 */
					const matchResourceMatch = MATCH_RESOURCE_REGEX.exec(request);

					if (matchResourceMatch) {
						// 提取 matchResource
						let matchResource = matchResourceMatch[1];

						// 如果是相对路径，转为绝对路径
						if (matchResource.charCodeAt(0) === 46) {  // 46 === "."
							const secondChar = matchResource.charCodeAt(1);
							if (
								secondChar === 47 ||  // 47 === "/"，即 "./"
								(secondChar === 46 && matchResource.charCodeAt(2) === 47)  // "../"
							) {
								// matchResource 以 ./ 或 ../ 开头
								// 转为绝对路径
								matchResource = join(this.fs, context, matchResource);
							}
						}

						// 保存 matchResource 数据
						matchResourceData = {
							resource: matchResource,
							...cacheParseResource(matchResource)
						};

						// 移除 matchResource 部分，得到实际请求
						requestWithoutMatchResource = request.slice(
							matchResourceMatch[0].length
						);
					}

					// 重新获取协议（从移除 matchResource 后的请求）
					scheme = getScheme(requestWithoutMatchResource);

					// ===== 解析 inline loader ⭐⭐⭐ =====
					if (!scheme && !contextScheme) {
						/**
						 * 没有协议，解析 inline loader
						 *
						 * 【Inline Loader 语法】
						 * 'loader1!loader2!loader3!./file.js'
						 *
						 * 【前缀】
						 * - '-!loader!./file' → 禁用 pre loader
						 * - '!loader!./file' → 禁用 normal loader
						 * - '!!loader!./file' → 禁用所有自动 loader
						 */

						// 检查第一个和第二个字符
						const firstChar = requestWithoutMatchResource.charCodeAt(0);
						const secondChar = requestWithoutMatchResource.charCodeAt(1);

						// 检测前缀
						noPreAutoLoaders = firstChar === 45 && secondChar === 33; // 45="=", 33="!", "-!"
						noAutoLoaders = noPreAutoLoaders || firstChar === 33; // "!" 或 "-!"
						noPrePostAutoLoaders = firstChar === 33 && secondChar === 33; // "!!"

						// ===== 分割请求字符串 ⭐ =====
						/**
						 * 移除前缀后，按 ! 分割
						 *
						 * 【示例】
						 * '!!babel-loader!ts-loader!./src/index.ts'
						 *
						 * 1. 移除 !!  → 'babel-loader!ts-loader!./src/index.ts'
						 * 2. 按 ! 分割 → ['babel-loader', 'ts-loader', './src/index.ts']
						 * 3. pop 最后一个 → unresolvedResource = './src/index.ts'
						 * 4. 剩余的是 loader → ['babel-loader', 'ts-loader']
						 */
						const rawElements = requestWithoutMatchResource
							.slice(
								noPreAutoLoaders || noPrePostAutoLoaders
									? 2  // 移除 !! 或 -!
									: noAutoLoaders
									? 1  // 移除 !
									: 0  // 无前缀
							)
							.split(/!+/);  // 按 ! 分割（支持多个 !）

						// 最后一个元素是资源路径
						unresolvedResource = rawElements.pop();

						// ===== 解析 inline loader =====
						/**
						 * 将 loader 字符串解析为对象
						 *
						 * 【解析】
						 * 'babel-loader?presets=es2015'
						 * → { loader: 'babel-loader', options: 'presets=es2015' }
						 */
						elements = rawElements.map(el => {
							const { path, query } = cachedParseResourceWithoutFragment(el);
							return {
								loader: path,
								options: query ? query.slice(1) : undefined  // 移除 ? 前缀
							};
						});

						// 重新获取资源的协议
						scheme = getScheme(unresolvedResource);
					} else {
						// 有协议或上下文有协议，不解析 inline loader
						unresolvedResource = requestWithoutMatchResource;
						elements = EMPTY_ELEMENTS;
					}
				} else {
					// 请求本身有协议（如 http://），不解析 inline loader
					unresolvedResource = request;
					elements = EMPTY_ELEMENTS;
				}

				const resolveContext = {
					fileDependencies,
					missingDependencies,
					contextDependencies
				};

				/** @type {ResourceDataWithData} */
				let resourceData;

				let loaders;

				const continueCallback = needCalls(2, err => {
					if (err) return callback(err);

					// translate option idents
					try {
						for (const item of loaders) {
							if (typeof item.options === "string" && item.options[0] === "?") {
								const ident = item.options.slice(1);
								if (ident === "[[missing ident]]") {
									throw new Error(
										"No ident is provided by referenced loader. " +
											"When using a function for Rule.use in config you need to " +
											"provide an 'ident' property for referenced loader options."
									);
								}
								item.options = this.ruleSet.references.get(ident);
								if (item.options === undefined) {
									throw new Error(
										"Invalid ident is provided by referenced loader"
									);
								}
								item.ident = ident;
							}
						}
					} catch (e) {
						return callback(e);
					}

					if (!resourceData) {
						// ignored
						return callback(null, dependencies[0].createIgnoredModule(context));
					}

					const userRequest =
						(matchResourceData !== undefined
							? `${matchResourceData.resource}!=!`
							: "") +
						stringifyLoadersAndResource(loaders, resourceData.resource);

					const settings = {};
					const useLoadersPost = [];
					const useLoaders = [];
					const useLoadersPre = [];

					// handle .webpack[] suffix
					let resource;
					let match;
					if (
						matchResourceData &&
						typeof (resource = matchResourceData.resource) === "string" &&
						(match = /\.webpack\[([^\]]+)\]$/.exec(resource))
					) {
						settings.type = match[1];
						matchResourceData.resource = matchResourceData.resource.slice(
							0,
							-settings.type.length - 10
						);
					} else {
						settings.type = JAVASCRIPT_MODULE_TYPE_AUTO;
						const resourceDataForRules = matchResourceData || resourceData;
						const result = this.ruleSet.exec({
							resource: resourceDataForRules.path,
							realResource: resourceData.path,
							resourceQuery: resourceDataForRules.query,
							resourceFragment: resourceDataForRules.fragment,
							scheme,
							assertions,
							mimetype: matchResourceData
								? ""
								: resourceData.data.mimetype || "",
							dependency: dependencyType,
							descriptionData: matchResourceData
								? undefined
								: resourceData.data.descriptionFileData,
							issuer: contextInfo.issuer,
							compiler: contextInfo.compiler,
							issuerLayer: contextInfo.issuerLayer || ""
						});
						for (const r of result) {
							// https://github.com/webpack/webpack/issues/16466
							// if a request exists PrePostAutoLoaders, should disable modifying Rule.type
							if (r.type === "type" && noPrePostAutoLoaders) {
								continue;
							}
							if (r.type === "use") {
								if (!noAutoLoaders && !noPrePostAutoLoaders) {
									useLoaders.push(r.value);
								}
							} else if (r.type === "use-post") {
								if (!noPrePostAutoLoaders) {
									useLoadersPost.push(r.value);
								}
							} else if (r.type === "use-pre") {
								if (!noPreAutoLoaders && !noPrePostAutoLoaders) {
									useLoadersPre.push(r.value);
								}
							} else if (
								typeof r.value === "object" &&
								r.value !== null &&
								typeof settings[r.type] === "object" &&
								settings[r.type] !== null
							) {
								settings[r.type] = cachedCleverMerge(settings[r.type], r.value);
							} else {
								settings[r.type] = r.value;
							}
						}
					}

					let postLoaders, normalLoaders, preLoaders;

					const continueCallback = needCalls(3, err => {
						if (err) {
							return callback(err);
						}
						const allLoaders = postLoaders;
						if (matchResourceData === undefined) {
							for (const loader of loaders) allLoaders.push(loader);
							for (const loader of normalLoaders) allLoaders.push(loader);
						} else {
							for (const loader of normalLoaders) allLoaders.push(loader);
							for (const loader of loaders) allLoaders.push(loader);
						}
						for (const loader of preLoaders) allLoaders.push(loader);
						let type = settings.type;
						const resolveOptions = settings.resolve;
						const layer = settings.layer;
						if (layer !== undefined && !layers) {
							return callback(
								new Error(
									"'Rule.layer' is only allowed when 'experiments.layers' is enabled"
								)
							);
						}
						try {
							Object.assign(data.createData, {
								layer:
									layer === undefined ? contextInfo.issuerLayer || null : layer,
								request: stringifyLoadersAndResource(
									allLoaders,
									resourceData.resource
								),
								userRequest,
								rawRequest: request,
								loaders: allLoaders,
								resource: resourceData.resource,
								context:
									resourceData.context || getContext(resourceData.resource),
								matchResource: matchResourceData
									? matchResourceData.resource
									: undefined,
								resourceResolveData: resourceData.data,
								settings,
								type,
								parser: this.getParser(type, settings.parser),
								parserOptions: settings.parser,
								generator: this.getGenerator(type, settings.generator),
								generatorOptions: settings.generator,
								resolveOptions
							});
						} catch (e) {
							return callback(e);
						}
						callback();
					});
					this.resolveRequestArray(
						contextInfo,
						this.context,
						useLoadersPost,
						loaderResolver,
						resolveContext,
						(err, result) => {
							postLoaders = result;
							continueCallback(err);
						}
					);
					this.resolveRequestArray(
						contextInfo,
						this.context,
						useLoaders,
						loaderResolver,
						resolveContext,
						(err, result) => {
							normalLoaders = result;
							continueCallback(err);
						}
					);
					this.resolveRequestArray(
						contextInfo,
						this.context,
						useLoadersPre,
						loaderResolver,
						resolveContext,
						(err, result) => {
							preLoaders = result;
							continueCallback(err);
						}
					);
				});

				this.resolveRequestArray(
					contextInfo,
					contextScheme ? this.context : context,
					elements,
					loaderResolver,
					resolveContext,
					(err, result) => {
						if (err) return continueCallback(err);
						loaders = result;
						continueCallback();
					}
				);

				const defaultResolve = context => {
					if (/^($|\?)/.test(unresolvedResource)) {
						resourceData = {
							resource: unresolvedResource,
							data: {},
							...cacheParseResource(unresolvedResource)
						};
						continueCallback();
					}

					// resource without scheme and with path
					else {
						const normalResolver = this.getResolver(
							"normal",
							dependencyType
								? cachedSetProperty(
										resolveOptions || EMPTY_RESOLVE_OPTIONS,
										"dependencyType",
										dependencyType
								  )
								: resolveOptions
						);
						this.resolveResource(
							contextInfo,
							context,
							unresolvedResource,
							normalResolver,
							resolveContext,
							(err, resolvedResource, resolvedResourceResolveData) => {
								if (err) return continueCallback(err);
								if (resolvedResource !== false) {
									resourceData = {
										resource: resolvedResource,
										data: resolvedResourceResolveData,
										...cacheParseResource(resolvedResource)
									};
								}
								continueCallback();
							}
						);
					}
				};

				// resource with scheme
				if (scheme) {
					resourceData = {
						resource: unresolvedResource,
						data: {},
						path: undefined,
						query: undefined,
						fragment: undefined,
						context: undefined
					};
					this.hooks.resolveForScheme
						.for(scheme)
						.callAsync(resourceData, data, err => {
							if (err) return continueCallback(err);
							continueCallback();
						});
				}

				// resource within scheme
				else if (contextScheme) {
					resourceData = {
						resource: unresolvedResource,
						data: {},
						path: undefined,
						query: undefined,
						fragment: undefined,
						context: undefined
					};
					this.hooks.resolveInScheme
						.for(contextScheme)
						.callAsync(resourceData, data, (err, handled) => {
							if (err) return continueCallback(err);
							if (!handled) return defaultResolve(this.context);
							continueCallback();
						});
				}

				// resource without scheme and without path
				else defaultResolve(context);
			}
		);
	}

	cleanupForCache() {
		for (const module of this._restoredUnsafeCacheEntries) {
			ChunkGraph.clearChunkGraphForModule(module);
			ModuleGraph.clearModuleGraphForModule(module);
			module.cleanupForCache();
		}
	}

	/**
	 * 创建模块（工厂的核心方法）⭐⭐⭐
	 *
	 * 【作用】
	 * 根据依赖创建 NormalModule 实例
	 *
	 * 【执行流程】
	 * ```
	 * create()
	 *   ├─ 准备解析数据（resolveData）
	 *   ├─ beforeResolve 钩子（解析前）
	 *   │   └─ 插件可以修改请求或阻止解析
	 *   ├─ factorize 钩子（核心流程）⭐⭐⭐
	 *   │   ├─ resolve 钩子（解析模块路径）
	 *   │   │   ├─ enhanced-resolve 解析路径
	 *   │   │   └─ './a.js' → '/absolute/path/to/a.js'
	 *   │   ├─ afterResolve 钩子（解析后）
	 *   │   │   └─ 匹配 loader 规则
	 *   │   ├─ createModule 钩子（创建前）
	 *   │   ├─ new NormalModule()
	 *   │   └─ module 钩子（创建后）
	 *   └─ 返回工厂结果
	 * ```
	 *
	 * 【依赖跟踪】⭐
	 * 创建过程中会跟踪三种依赖：
	 * - fileDependencies: 访问的文件（用于 watch）
	 * - contextDependencies: 访问的目录
	 * - missingDependencies: 查找但不存在的文件
	 *
	 * 【钩子作用】
	 *
	 * beforeResolve: 可以：
	 *   - 修改请求路径
	 *   - 返回 false 忽略该依赖
	 *   - 添加额外的解析选项
	 *
	 * factorize: 实际的模块创建流程
	 *   - 内部触发 resolve、afterResolve 等钩子
	 *   - 最终创建 NormalModule 实例
	 *
	 * 【缓存标记】
	 * cacheable 标记结果是否可以被缓存：
	 * - true: 可以缓存（大部分情况）
	 * - false: 不可缓存（某些动态逻辑）
	 *
	 * @param {ModuleFactoryCreateData} data - 创建数据
	 * @param {function((Error | null)=, ModuleFactoryResult=): void} callback - 回调函数
	 * @returns {void}
	 */
	create(data, callback) {
		// ===== 步骤1: 提取和准备数据 =====

		// 依赖列表（通常只有一个）
		const dependencies = /** @type {ModuleDependency[]} */ (data.dependencies);

		// 上下文路径（工作目录）
		const context = data.context || this.context;

		// 解析选项
		const resolveOptions = data.resolveOptions || EMPTY_RESOLVE_OPTIONS;

		// 主依赖（第一个）
		const dependency = dependencies[0];

		// 请求路径（如 './a.js'）
		const request = dependency.request;

		// import 断言（如 assert { type: 'json' }）
		const assertions = dependency.assertions;

		// 上下文信息（issuer 等）
		const contextInfo = data.contextInfo;

		// ===== 步骤2: 创建依赖跟踪集合 =====
		/**
		 * 这些集合用于跟踪解析和创建过程中访问的文件
		 * watch 模式下，这些文件变化时需要重新编译
		 */
		const fileDependencies = new LazySet();        // 文件依赖
		const missingDependencies = new LazySet();     // 缺失的文件
		const contextDependencies = new LazySet();     // 目录依赖

		// 依赖类型（'esm'、'commonjs'、'amd' 等）
		const dependencyType =
			(dependencies.length > 0 && dependencies[0].category) || "";

		// ===== 步骤3: 构建解析数据对象 =====
		/**
		 * resolveData 包含解析所需的所有信息
		 * 会在钩子间传递和修改
		 *
		 * @type {ResolveData}
		 */
		const resolveData = {
			contextInfo,              // 上下文信息
			resolveOptions,           // 解析选项
			context,                  // 上下文路径
			request,                  // 请求路径
			assertions,               // import 断言
			dependencies,             // 依赖列表
			dependencyType,           // 依赖类型
			fileDependencies,         // 文件依赖集合
			missingDependencies,      // 缺失依赖集合
			contextDependencies,      // 目录依赖集合
			createData: {},           // 创建数据（会被钩子填充）
			cacheable: true           // 是否可缓存
		};

		// ===== 步骤4: 触发 beforeResolve 钩子 =====
		/**
		 * beforeResolve 钩子允许插件：
		 * 1. 修改请求路径
		 * 2. 修改解析选项
		 * 3. 返回 false 忽略该依赖
		 * 4. 提前返回模块（跳过解析）
		 */
		this.hooks.beforeResolve.callAsync(resolveData, (err, result) => {
			if (err) {
				// beforeResolve 钩子出错
				return callback(err, {
					fileDependencies,
					missingDependencies,
					contextDependencies,
					cacheable: false
				});
			}

			// 如果钩子返回 false，忽略该依赖
			if (result === false) {
				return callback(null, {
					fileDependencies,
					missingDependencies,
					contextDependencies,
					cacheable: resolveData.cacheable
				});
			}

			// 向后兼容性检查
			if (typeof result === "object")
				throw new Error(
					deprecationChangedHookMessage(
						"beforeResolve",
						this.hooks.beforeResolve
					)
				);

			// ===== 步骤5: 触发 factorize 钩子（核心流程）⭐⭐⭐ =====
			/**
			 * factorize 钩子是实际创建模块的地方
			 *
			 * 【内部流程】
			 * 1. resolve 钩子：解析模块路径
			 * 2. afterResolve 钩子：匹配 loader
			 * 3. createModule 钩子：创建模块实例
			 * 4. module 钩子：模块创建后的处理
			 *
			 * 【默认处理】
			 * NormalModuleFactory 的构造函数中注册了默认的处理逻辑
			 */
			this.hooks.factorize.callAsync(resolveData, (err, module) => {
				if (err) {
					// factorize 过程出错
					return callback(err, {
						fileDependencies,
						missingDependencies,
						contextDependencies,
						cacheable: false
					});
				}

				// ===== 步骤6: 构建工厂结果对象 =====
				/**
				 * 工厂结果包含：
				 * - module: 创建的模块实例
				 * - fileDependencies: 文件依赖
				 * - missingDependencies: 缺失的依赖
				 * - contextDependencies: 目录依赖
				 * - cacheable: 是否可缓存
				 */
				const factoryResult = {
					module,                               // NormalModule 实例
					fileDependencies,                     // 文件依赖集合
					missingDependencies,                  // 缺失依赖集合
					contextDependencies,                  // 目录依赖集合
					cacheable: resolveData.cacheable      // 缓存标记
				};

				// 返回工厂结果
				callback(null, factoryResult);
			});
		});
	}

	resolveResource(
		contextInfo,
		context,
		unresolvedResource,
		resolver,
		resolveContext,
		callback
	) {
		resolver.resolve(
			contextInfo,
			context,
			unresolvedResource,
			resolveContext,
			(err, resolvedResource, resolvedResourceResolveData) => {
				if (err) {
					return this._resolveResourceErrorHints(
						err,
						contextInfo,
						context,
						unresolvedResource,
						resolver,
						resolveContext,
						(err2, hints) => {
							if (err2) {
								err.message += `
A fatal error happened during resolving additional hints for this error: ${err2.message}`;
								err.stack += `

A fatal error happened during resolving additional hints for this error:
${err2.stack}`;
								return callback(err);
							}
							if (hints && hints.length > 0) {
								err.message += `
${hints.join("\n\n")}`;
							}

							// Check if the extension is missing a leading dot (e.g. "js" instead of ".js")
							let appendResolveExtensionsHint = false;
							const specifiedExtensions = Array.from(
								resolver.options.extensions
							);
							const expectedExtensions = specifiedExtensions.map(extension => {
								if (LEADING_DOT_EXTENSION_REGEX.test(extension)) {
									appendResolveExtensionsHint = true;
									return `.${extension}`;
								}
								return extension;
							});
							if (appendResolveExtensionsHint) {
								err.message += `\nDid you miss the leading dot in 'resolve.extensions'? Did you mean '${JSON.stringify(
									expectedExtensions
								)}' instead of '${JSON.stringify(specifiedExtensions)}'?`;
							}

							callback(err);
						}
					);
				}
				callback(err, resolvedResource, resolvedResourceResolveData);
			}
		);
	}

	_resolveResourceErrorHints(
		error,
		contextInfo,
		context,
		unresolvedResource,
		resolver,
		resolveContext,
		callback
	) {
		asyncLib.parallel(
			[
				callback => {
					if (!resolver.options.fullySpecified) return callback();
					resolver
						.withOptions({
							fullySpecified: false
						})
						.resolve(
							contextInfo,
							context,
							unresolvedResource,
							resolveContext,
							(err, resolvedResource) => {
								if (!err && resolvedResource) {
									const resource = parseResource(resolvedResource).path.replace(
										/^.*[\\/]/,
										""
									);
									return callback(
										null,
										`Did you mean '${resource}'?
BREAKING CHANGE: The request '${unresolvedResource}' failed to resolve only because it was resolved as fully specified
(probably because the origin is strict EcmaScript Module, e. g. a module with javascript mimetype, a '*.mjs' file, or a '*.js' file where the package.json contains '"type": "module"').
The extension in the request is mandatory for it to be fully specified.
Add the extension to the request.`
									);
								}
								callback();
							}
						);
				},
				callback => {
					if (!resolver.options.enforceExtension) return callback();
					resolver
						.withOptions({
							enforceExtension: false,
							extensions: []
						})
						.resolve(
							contextInfo,
							context,
							unresolvedResource,
							resolveContext,
							(err, resolvedResource) => {
								if (!err && resolvedResource) {
									let hint = "";
									const match = /(\.[^.]+)(\?|$)/.exec(unresolvedResource);
									if (match) {
										const fixedRequest = unresolvedResource.replace(
											/(\.[^.]+)(\?|$)/,
											"$2"
										);
										if (resolver.options.extensions.has(match[1])) {
											hint = `Did you mean '${fixedRequest}'?`;
										} else {
											hint = `Did you mean '${fixedRequest}'? Also note that '${match[1]}' is not in 'resolve.extensions' yet and need to be added for this to work?`;
										}
									} else {
										hint = `Did you mean to omit the extension or to remove 'resolve.enforceExtension'?`;
									}
									return callback(
										null,
										`The request '${unresolvedResource}' failed to resolve only because 'resolve.enforceExtension' was specified.
${hint}
Including the extension in the request is no longer possible. Did you mean to enforce including the extension in requests with 'resolve.extensions: []' instead?`
									);
								}
								callback();
							}
						);
				},
				callback => {
					if (
						/^\.\.?\//.test(unresolvedResource) ||
						resolver.options.preferRelative
					) {
						return callback();
					}
					resolver.resolve(
						contextInfo,
						context,
						`./${unresolvedResource}`,
						resolveContext,
						(err, resolvedResource) => {
							if (err || !resolvedResource) return callback();
							const moduleDirectories = resolver.options.modules
								.map(m => (Array.isArray(m) ? m.join(", ") : m))
								.join(", ");
							callback(
								null,
								`Did you mean './${unresolvedResource}'?
Requests that should resolve in the current directory need to start with './'.
Requests that start with a name are treated as module requests and resolve within module directories (${moduleDirectories}).
If changing the source code is not an option there is also a resolve options called 'preferRelative' which tries to resolve these kind of requests in the current directory too.`
							);
						}
					);
				}
			],
			(err, hints) => {
				if (err) return callback(err);
				callback(null, hints.filter(Boolean));
			}
		);
	}

	resolveRequestArray(
		contextInfo,
		context,
		array,
		resolver,
		resolveContext,
		callback
	) {
		if (array.length === 0) return callback(null, array);
		asyncLib.map(
			array,
			(item, callback) => {
				resolver.resolve(
					contextInfo,
					context,
					item.loader,
					resolveContext,
					(err, result, resolveRequest) => {
						if (
							err &&
							/^[^/]*$/.test(item.loader) &&
							!/-loader$/.test(item.loader)
						) {
							return resolver.resolve(
								contextInfo,
								context,
								item.loader + "-loader",
								resolveContext,
								err2 => {
									if (!err2) {
										err.message =
											err.message +
											"\n" +
											"BREAKING CHANGE: It's no longer allowed to omit the '-loader' suffix when using loaders.\n" +
											`                 You need to specify '${item.loader}-loader' instead of '${item.loader}',\n` +
											"                 see https://webpack.js.org/migrate/3/#automatic-loader-module-name-extension-removed";
									}
									callback(err);
								}
							);
						}
						if (err) return callback(err);

						const parsedResult = this._parseResourceWithoutFragment(result);

						const type = /\.mjs$/i.test(parsedResult.path)
							? "module"
							: /\.cjs$/i.test(parsedResult.path)
							? "commonjs"
							: resolveRequest.descriptionFileData === undefined
							? undefined
							: resolveRequest.descriptionFileData.type;

						const resolved = {
							loader: parsedResult.path,
							type,
							options:
								item.options === undefined
									? parsedResult.query
										? parsedResult.query.slice(1)
										: undefined
									: item.options,
							ident: item.options === undefined ? undefined : item.ident
						};
						return callback(null, resolved);
					}
				);
			},
			callback
		);
	}

	getParser(type, parserOptions = EMPTY_PARSER_OPTIONS) {
		let cache = this.parserCache.get(type);

		if (cache === undefined) {
			cache = new WeakMap();
			this.parserCache.set(type, cache);
		}

		let parser = cache.get(parserOptions);

		if (parser === undefined) {
			parser = this.createParser(type, parserOptions);
			cache.set(parserOptions, parser);
		}

		return parser;
	}

	/**
	 * @param {string} type type
	 * @param {{[k: string]: any}} parserOptions parser options
	 * @returns {Parser} parser
	 */
	createParser(type, parserOptions = {}) {
		parserOptions = mergeGlobalOptions(
			this._globalParserOptions,
			type,
			parserOptions
		);
		const parser = this.hooks.createParser.for(type).call(parserOptions);
		if (!parser) {
			throw new Error(`No parser registered for ${type}`);
		}
		this.hooks.parser.for(type).call(parser, parserOptions);
		return parser;
	}

	getGenerator(type, generatorOptions = EMPTY_GENERATOR_OPTIONS) {
		let cache = this.generatorCache.get(type);

		if (cache === undefined) {
			cache = new WeakMap();
			this.generatorCache.set(type, cache);
		}

		let generator = cache.get(generatorOptions);

		if (generator === undefined) {
			generator = this.createGenerator(type, generatorOptions);
			cache.set(generatorOptions, generator);
		}

		return generator;
	}

	createGenerator(type, generatorOptions = {}) {
		generatorOptions = mergeGlobalOptions(
			this._globalGeneratorOptions,
			type,
			generatorOptions
		);
		const generator = this.hooks.createGenerator
			.for(type)
			.call(generatorOptions);
		if (!generator) {
			throw new Error(`No generator registered for ${type}`);
		}
		this.hooks.generator.for(type).call(generator, generatorOptions);
		return generator;
	}

	getResolver(type, resolveOptions) {
		return this.resolverFactory.get(type, resolveOptions);
	}
}

module.exports = NormalModuleFactory;
