/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

/**
 * lib/dependencies/HarmonyImportDependency.js - ES Module import 依赖 ⭐⭐⭐
 *
 * 【文件作用】
 * 处理 ES Module 的 import 语句，这是最常用的依赖类型之一
 *
 * 【对应的语法】
 * ```javascript
 * import foo from './a.js';              // default import
 * import { foo, bar } from './a.js';     // named import
 * import * as A from './a.js';           // namespace import
 * import './a.js';                       // side effect import
 * import { foo as bar } from './a.js';   // aliased import
 * ```
 *
 * 【核心职责】
 *
 * 1. **记录导入信息**：
 *    - 导入的模块路径
 *    - 导入的名称（具体导入了什么）
 *    - 源码位置（用于错误报告）
 *
 * 2. **生成导入代码**：
 *    - 生成 webpack 运行时的导入语句
 *    - 处理 ES Module 的互操作性
 *
 * 3. **提供导出使用信息**（Tree Shaking）：
 *    - 告诉 webpack 具体使用了哪些导出
 *    - 例如：import { foo } → 只使用 'foo'
 *
 * 4. **错误检查**：
 *    - 检查导入的名称是否存在
 *    - 生成友好的错误信息
 *
 * 【与其他 Import 依赖的区别】
 *
 * - HarmonyImportDependency: import 'module' （基础依赖）
 * - HarmonyImportSpecifierDependency: import { foo } （具体导入项）
 * - HarmonyImportSideEffectDependency: import './style.css' （副作用）
 *
 * 【生成的代码示例】
 *
 * 源码：
 * ```javascript
 * import { foo } from './a.js';
 * ```
 *
 * 生成：
 * ```javascript
 * var _a_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__("./a.js");
 * // 使用：_a_js__WEBPACK_IMPORTED_MODULE_0__.foo
 * ```
 *
 * 【关键方法】
 * - getImportVar(): 生成导入变量名
 * - getImportStatement(): 生成导入语句
 * - getReferencedExports(): 返回引用的导出（Tree Shaking）
 * - getLinkingErrors(): 检查导入错误
 */

"use strict";

const ConditionalInitFragment = require("../ConditionalInitFragment");
const Dependency = require("../Dependency");
const HarmonyLinkingError = require("../HarmonyLinkingError");
const InitFragment = require("../InitFragment");
const Template = require("../Template");
const AwaitDependenciesInitFragment = require("../async-modules/AwaitDependenciesInitFragment");
const { filterRuntime, mergeRuntime } = require("../util/runtime");
const ModuleDependency = require("./ModuleDependency");

/** @typedef {import("webpack-sources").ReplaceSource} ReplaceSource */
/** @typedef {import("webpack-sources").Source} Source */
/** @typedef {import("../ChunkGraph")} ChunkGraph */
/** @typedef {import("../Dependency").ReferencedExport} ReferencedExport */
/** @typedef {import("../Dependency").UpdateHashContext} UpdateHashContext */
/** @typedef {import("../DependencyTemplate").DependencyTemplateContext} DependencyTemplateContext */
/** @typedef {import("../Module")} Module */
/** @typedef {import("../ModuleGraph")} ModuleGraph */
/** @typedef {import("../RuntimeTemplate")} RuntimeTemplate */
/** @typedef {import("../WebpackError")} WebpackError */
/** @typedef {import("../javascript/JavascriptParser").Assertions} Assertions */
/** @typedef {import("../serialization/ObjectMiddleware").ObjectDeserializerContext} ObjectDeserializerContext */
/** @typedef {import("../serialization/ObjectMiddleware").ObjectSerializerContext} ObjectSerializerContext */
/** @typedef {import("../util/Hash")} Hash */
/** @typedef {import("../util/runtime").RuntimeSpec} RuntimeSpec */

/**
 * 导出存在性检查模式
 *
 * 【用途】
 * 控制导入不存在的导出时的行为
 *
 * 【模式说明】
 * - NONE: 不检查（忽略错误）
 * - WARN: 警告（输出警告但继续编译）
 * - AUTO: 自动（根据环境决定）
 * - ERROR: 错误（中断编译）
 *
 * 【配置位置】
 * module.parser.javascript.exportsPresence
 */
const ExportPresenceModes = {
	NONE: /** @type {0} */ (0),
	WARN: /** @type {1} */ (1),
	AUTO: /** @type {2} */ (2),
	ERROR: /** @type {3} */ (3),
	fromUserOption(str) {
		switch (str) {
			case "error":
				return ExportPresenceModes.ERROR;
			case "warn":
				return ExportPresenceModes.WARN;
			case "auto":
				return ExportPresenceModes.AUTO;
			case false:
				return ExportPresenceModes.NONE;
			default:
				throw new Error(`Invalid export presence value ${str}`);
		}
	}
};

/**
 * HarmonyImportDependency - ES Module 导入依赖类
 *
 * 【继承关系】
 * Dependency → ModuleDependency → HarmonyImportDependency
 *
 * 【创建时机】
 * JavascriptParser 解析到 import 语句时创建
 *
 * 【实例对应】
 * 源码中的每个 import 语句 → 1 个 HarmonyImportDependency 实例
 */
class HarmonyImportDependency extends ModuleDependency {
	/**
	 * 构造函数
	 *
	 * 【参数说明】
	 * @param {string} request - 请求路径（如 './a.js'）
	 * @param {number} sourceOrder - 源码顺序（import 语句在文件中的位置）
	 * @param {Assertions=} assertions - import 断言（ES2020 特性）
	 *
	 * 【sourceOrder 的作用】
	 * 保持导入语句的执行顺序：
	 * ```javascript
	 * import './a.js';  // sourceOrder: 0
	 * import './b.js';  // sourceOrder: 1
	 * import './c.js';  // sourceOrder: 2
	 * ```
	 *
	 * 【assertions 示例】
	 * ```javascript
	 * import data from './data.json' assert { type: 'json' };
	 * //                             ^^^^^^^^^^^^^^^^^^^^^^
	 * //                             这就是 assertions
	 * ```
	 */
	constructor(request, sourceOrder, assertions) {
		// 调用父类构造函数，传递请求路径
		super(request);

		/**
		 * 源码顺序
		 * 用于保持 import 语句的执行顺序
		 */
		this.sourceOrder = sourceOrder;

		/**
		 * import 断言（ES2020 特性）
		 * 用于指定导入的模块类型
		 */
		this.assertions = assertions;
	}

	/**
	 * 获取依赖类别
	 *
	 * 【返回值】
	 * 'esm' - 表示这是 ES Module 类别的依赖
	 *
	 * 【用途】
	 * 用于区分不同模块系统的依赖：
	 * - 'esm': ES Module
	 * - 'commonjs': CommonJS
	 * - 'amd': AMD
	 */
	get category() {
		return "esm";
	}

	/**
	 * 获取引用的导出列表（Tree Shaking 关键！）
	 *
	 * 【返回值】
	 * NO_EXPORTS_REFERENCED: 表示这个依赖本身不引用任何导出
	 *
	 * 【为什么返回空】
	 * HarmonyImportDependency 只是基础依赖，表示"导入了模块"
	 * 具体使用了哪些导出，由子类表示：
	 * - HarmonyImportSpecifierDependency: import { foo } ← 引用 'foo'
	 * - HarmonyImportDefaultDependency: import foo ← 引用 'default'
	 *
	 * @param {ModuleGraph} moduleGraph - 模块图
	 * @param {RuntimeSpec} runtime - 运行时规范
	 * @returns {(string[] | ReferencedExport)[]} 引用的导出列表
	 */
	getReferencedExports(moduleGraph, runtime) {
		return Dependency.NO_EXPORTS_REFERENCED;
	}

	/**
	 * 获取导入变量名（代码生成核心方法）⭐⭐
	 *
	 * 【作用】
	 * 为导入的模块生成一个唯一的变量名
	 *
	 * 【生成规则】
	 * 1. 基于模块的 userRequest（用户请求的路径）
	 * 2. 转换为合法的 JavaScript 标识符
	 * 3. 添加 __WEBPACK_IMPORTED_MODULE_ 前缀
	 * 4. 添加数字后缀（确保唯一性）
	 *
	 * 【示例】
	 * ```javascript
	 * import foo from './a.js';
	 * import bar from './b.js';
	 * import baz from './a.js';  // 再次导入 a.js
	 *
	 * 生成的变量名：
	 * './a.js' → _a_js__WEBPACK_IMPORTED_MODULE_0__
	 * './b.js' → _b_js__WEBPACK_IMPORTED_MODULE_1__
	 * './a.js' → _a_js__WEBPACK_IMPORTED_MODULE_0__  ← 相同模块复用变量
	 * ```
	 *
	 * 【缓存机制】⭐
	 * 同一个模块在同一个父模块中只生成一次变量名
	 * 使用 importVarMap 缓存：
	 * - key: 目标模块
	 * - value: 生成的变量名
	 *
	 * @param {ModuleGraph} moduleGraph - 模块图
	 * @returns {string} 导入变量名
	 */
	getImportVar(moduleGraph) {
		// 1. 获取父模块（谁导入了这个依赖）
		const module = moduleGraph.getParentModule(this);

		// 2. 获取父模块的元数据
		const meta = moduleGraph.getMeta(module);

		// 3. 获取或创建导入变量映射（缓存）
		let importVarMap = meta.importVarMap;
		if (!importVarMap) meta.importVarMap = importVarMap = new Map();

		// 4. 获取目标模块（这个依赖指向哪个模块）
		const targetModule = moduleGraph.getModule(this);

		// 5. 检查缓存：是否已经为这个模块生成过变量名
		let importVar = importVarMap.get(targetModule);
		if (importVar) return importVar;  // 直接返回缓存的变量名

		// 6. 生成新的变量名
		// 格式：{路径标识符}__WEBPACK_IMPORTED_MODULE_{序号}__
		importVar = `${Template.toIdentifier(
			`${this.userRequest}`  // 用户请求路径（相对路径）
		)}__WEBPACK_IMPORTED_MODULE_${importVarMap.size}__`;

		// 7. 缓存变量名
		importVarMap.set(targetModule, importVar);

		return importVar;
	}

	/**
	 * @param {boolean} update create new variables or update existing one
	 * @param {DependencyTemplateContext} templateContext the template context
	 * @returns {[string, string]} the import statement and the compat statement
	 */
	getImportStatement(
		update,
		{ runtimeTemplate, module, moduleGraph, chunkGraph, runtimeRequirements }
	) {
		return runtimeTemplate.importStatement({
			update,
			module: moduleGraph.getModule(this),
			chunkGraph,
			importVar: this.getImportVar(moduleGraph),
			request: this.request,
			originModule: module,
			runtimeRequirements
		});
	}

	/**
	 * @param {ModuleGraph} moduleGraph module graph
	 * @param {string[]} ids imported ids
	 * @param {string} additionalMessage extra info included in the error message
	 * @returns {WebpackError[] | undefined} errors
	 */
	getLinkingErrors(moduleGraph, ids, additionalMessage) {
		const importedModule = moduleGraph.getModule(this);
		// ignore errors for missing or failed modules
		if (!importedModule || importedModule.getNumberOfErrors() > 0) {
			return;
		}

		const parentModule = moduleGraph.getParentModule(this);
		const exportsType = importedModule.getExportsType(
			moduleGraph,
			parentModule.buildMeta.strictHarmonyModule
		);
		if (exportsType === "namespace" || exportsType === "default-with-named") {
			if (ids.length === 0) {
				return;
			}

			if (
				(exportsType !== "default-with-named" || ids[0] !== "default") &&
				moduleGraph.isExportProvided(importedModule, ids) === false
			) {
				// We are sure that it's not provided

				// Try to provide detailed info in the error message
				let pos = 0;
				let exportsInfo = moduleGraph.getExportsInfo(importedModule);
				while (pos < ids.length && exportsInfo) {
					const id = ids[pos++];
					const exportInfo = exportsInfo.getReadOnlyExportInfo(id);
					if (exportInfo.provided === false) {
						// We are sure that it's not provided
						const providedExports = exportsInfo.getProvidedExports();
						const moreInfo = !Array.isArray(providedExports)
							? " (possible exports unknown)"
							: providedExports.length === 0
							? " (module has no exports)"
							: ` (possible exports: ${providedExports.join(", ")})`;
						return [
							new HarmonyLinkingError(
								`export ${ids
									.slice(0, pos)
									.map(id => `'${id}'`)
									.join(".")} ${additionalMessage} was not found in '${
									this.userRequest
								}'${moreInfo}`
							)
						];
					}
					exportsInfo = exportInfo.getNestedExportsInfo();
				}

				// General error message
				return [
					new HarmonyLinkingError(
						`export ${ids
							.map(id => `'${id}'`)
							.join(".")} ${additionalMessage} was not found in '${
							this.userRequest
						}'`
					)
				];
			}
		}
		switch (exportsType) {
			case "default-only":
				// It's has only a default export
				if (ids.length > 0 && ids[0] !== "default") {
					// In strict harmony modules we only support the default export
					return [
						new HarmonyLinkingError(
							`Can't import the named export ${ids
								.map(id => `'${id}'`)
								.join(
									"."
								)} ${additionalMessage} from default-exporting module (only default export is available)`
						)
					];
				}
				break;
			case "default-with-named":
				// It has a default export and named properties redirect
				// In some cases we still want to warn here
				if (
					ids.length > 0 &&
					ids[0] !== "default" &&
					importedModule.buildMeta.defaultObject === "redirect-warn"
				) {
					// For these modules only the default export is supported
					return [
						new HarmonyLinkingError(
							`Should not import the named export ${ids
								.map(id => `'${id}'`)
								.join(
									"."
								)} ${additionalMessage} from default-exporting module (only default export is available soon)`
						)
					];
				}
				break;
		}
	}

	/**
	 * @param {ObjectSerializerContext} context context
	 */
	serialize(context) {
		const { write } = context;
		write(this.sourceOrder);
		write(this.assertions);
		super.serialize(context);
	}

	/**
	 * @param {ObjectDeserializerContext} context context
	 */
	deserialize(context) {
		const { read } = context;
		this.sourceOrder = read();
		this.assertions = read();
		super.deserialize(context);
	}
}

module.exports = HarmonyImportDependency;

/** @type {WeakMap<Module, WeakMap<Module, RuntimeSpec | boolean>>} */
const importEmittedMap = new WeakMap();

HarmonyImportDependency.Template = class HarmonyImportDependencyTemplate extends (
	ModuleDependency.Template
) {
	/**
	 * @param {Dependency} dependency the dependency for which the template should be applied
	 * @param {ReplaceSource} source the current replace source which can be modified
	 * @param {DependencyTemplateContext} templateContext the context object
	 * @returns {void}
	 */
	apply(dependency, source, templateContext) {
		const dep = /** @type {HarmonyImportDependency} */ (dependency);
		const { module, chunkGraph, moduleGraph, runtime } = templateContext;

		const connection = moduleGraph.getConnection(dep);
		if (connection && !connection.isTargetActive(runtime)) return;

		const referencedModule = connection && connection.module;

		if (
			connection &&
			connection.weak &&
			referencedModule &&
			chunkGraph.getModuleId(referencedModule) === null
		) {
			// in weak references, module might not be in any chunk
			// but that's ok, we don't need that logic in this case
			return;
		}

		const moduleKey = referencedModule
			? referencedModule.identifier()
			: dep.request;
		const key = `harmony import ${moduleKey}`;

		const runtimeCondition = dep.weak
			? false
			: connection
			? filterRuntime(runtime, r => connection.isTargetActive(r))
			: true;

		if (module && referencedModule) {
			let emittedModules = importEmittedMap.get(module);
			if (emittedModules === undefined) {
				emittedModules = new WeakMap();
				importEmittedMap.set(module, emittedModules);
			}
			let mergedRuntimeCondition = runtimeCondition;
			const oldRuntimeCondition = emittedModules.get(referencedModule) || false;
			if (oldRuntimeCondition !== false && mergedRuntimeCondition !== true) {
				if (mergedRuntimeCondition === false || oldRuntimeCondition === true) {
					mergedRuntimeCondition = oldRuntimeCondition;
				} else {
					mergedRuntimeCondition = mergeRuntime(
						oldRuntimeCondition,
						mergedRuntimeCondition
					);
				}
			}
			emittedModules.set(referencedModule, mergedRuntimeCondition);
		}

		const importStatement = dep.getImportStatement(false, templateContext);
		if (
			referencedModule &&
			templateContext.moduleGraph.isAsync(referencedModule)
		) {
			templateContext.initFragments.push(
				new ConditionalInitFragment(
					importStatement[0],
					InitFragment.STAGE_HARMONY_IMPORTS,
					dep.sourceOrder,
					key,
					runtimeCondition
				)
			);
			templateContext.initFragments.push(
				new AwaitDependenciesInitFragment(
					new Set([dep.getImportVar(templateContext.moduleGraph)])
				)
			);
			templateContext.initFragments.push(
				new ConditionalInitFragment(
					importStatement[1],
					InitFragment.STAGE_ASYNC_HARMONY_IMPORTS,
					dep.sourceOrder,
					key + " compat",
					runtimeCondition
				)
			);
		} else {
			templateContext.initFragments.push(
				new ConditionalInitFragment(
					importStatement[0] + importStatement[1],
					InitFragment.STAGE_HARMONY_IMPORTS,
					dep.sourceOrder,
					key,
					runtimeCondition
				)
			);
		}
	}

	/**
	 *
	 * @param {Module} module the module
	 * @param {Module} referencedModule the referenced module
	 * @returns {RuntimeSpec | boolean} runtimeCondition in which this import has been emitted
	 */
	static getImportEmittedRuntime(module, referencedModule) {
		const emittedModules = importEmittedMap.get(module);
		if (emittedModules === undefined) return false;
		return emittedModules.get(referencedModule) || false;
	}
};

module.exports.ExportPresenceModes = ExportPresenceModes;
