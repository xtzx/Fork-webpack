/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

/**
 * lib/Dependency.js - 依赖基类
 *
 * 【文件作用】⭐⭐⭐
 * 这是 webpack 依赖系统的基类，所有依赖类型都继承自它。
 *
 * 【核心概念】
 * Dependency（依赖）是连接两个模块的桥梁：
 * - 记录源码中的依赖语句（import、require 等）
 * - 记录依赖的位置信息（行号、列号）
 * - 提供依赖的元信息（类型、类别、条件等）
 *
 * 【依赖类型举例】
 * webpack 有 115+ 种依赖类型！分类如下：
 *
 * 1. ES Module 依赖：
 *    - HarmonyImportDependency: import x from 'y'
 *    - HarmonyExportDependency: export { x }
 *
 * 2. CommonJS 依赖：
 *    - CommonJsRequireDependency: require('x')
 *    - CommonJsExportsDependency: module.exports = x
 *
 * 3. 动态依赖：
 *    - ImportDependency: import('./x')
 *    - RequireContextDependency: require.context()
 *
 * 4. 静态资源依赖：
 *    - URLDependency: new URL('./x', import.meta.url)
 *    - ConstDependency: 常量替换
 *
 * 【与 ModuleGraph 的关系】
 * Dependency 本身不存储图关系，只是一个"标记"：
 * - Dependency 记录：在哪里、什么类型的依赖
 * - ModuleGraph 记录：依赖连接了哪两个模块
 *
 * 【设计变更】
 * webpack 5 之前，Dependency 直接存储 module 属性
 * webpack 5 后，将图关系移到 ModuleGraph 中：
 * - 更清晰的职责分离
 * - 支持多个 compilation 共享 dependency
 * - 便于缓存和序列化
 */

"use strict";

const memoize = require("./util/memoize");

/** @typedef {import("webpack-sources").Source} Source */
/** @typedef {import("./ChunkGraph")} ChunkGraph */
/** @typedef {import("./DependenciesBlock")} DependenciesBlock */
/** @typedef {import("./DependencyTemplates")} DependencyTemplates */
/** @typedef {import("./Module")} Module */
/** @typedef {import("./ModuleGraph")} ModuleGraph */
/** @typedef {import("./ModuleGraphConnection")} ModuleGraphConnection */
/** @typedef {import("./ModuleGraphConnection").ConnectionState} ConnectionState */
/** @typedef {import("./RuntimeTemplate")} RuntimeTemplate */
/** @typedef {import("./WebpackError")} WebpackError */
/** @typedef {import("./serialization/ObjectMiddleware").ObjectDeserializerContext} ObjectDeserializerContext */
/** @typedef {import("./serialization/ObjectMiddleware").ObjectSerializerContext} ObjectSerializerContext */
/** @typedef {import("./util/Hash")} Hash */
/** @typedef {import("./util/runtime").RuntimeSpec} RuntimeSpec */

/**
 * @typedef {Object} UpdateHashContext
 * @property {ChunkGraph} chunkGraph
 * @property {RuntimeSpec} runtime
 * @property {RuntimeTemplate=} runtimeTemplate
 */

/**
 * @typedef {Object} SourcePosition
 * @property {number} line
 * @property {number=} column
 */

/**
 * @typedef {Object} RealDependencyLocation
 * @property {SourcePosition} start
 * @property {SourcePosition=} end
 * @property {number=} index
 */

/**
 * @typedef {Object} SyntheticDependencyLocation
 * @property {string} name
 * @property {number=} index
 */

/** @typedef {SyntheticDependencyLocation|RealDependencyLocation} DependencyLocation */

/**
 * 导出规格（用于描述模块导出信息）
 *
 * @typedef {Object} ExportSpec
 * @property {string} name - 导出名称（如 'default'、'foo'）
 * @property {boolean=} canMangle - 是否可以被重命名（用于压缩优化）
 * @property {boolean=} terminalBinding - 是否是终端绑定（用于检测 export * 冲突）
 * @property {(string | ExportSpec)[]=} exports - 嵌套导出（用于命名空间导出）
 * @property {ModuleGraphConnection=} from - 重新导出时：来源模块
 * @property {string[] | null=} export - 重新导出时：来源导出名
 * @property {number=} priority - 重新导出时：优先级
 * @property {boolean=} hidden - 导出是否被隐藏（被其他导出覆盖）
 */

/**
 * @typedef {Object} ExportsSpec
 * @property {(string | ExportSpec)[] | true | null} exports exported names, true for unknown exports or null for no exports
 * @property {Set<string>=} excludeExports when exports = true, list of unaffected exports
 * @property {Set<string>=} hideExports list of maybe prior exposed, but now hidden exports
 * @property {ModuleGraphConnection=} from when reexported: from which module
 * @property {number=} priority when reexported: with which priority
 * @property {boolean=} canMangle can the export be renamed (defaults to true)
 * @property {boolean=} terminalBinding are the exports terminal bindings that should be checked for export star conflicts
 * @property {Module[]=} dependencies module on which the result depends on
 */

/**
 * @typedef {Object} ReferencedExport
 * @property {string[]} name name of the referenced export
 * @property {boolean=} canMangle when false, referenced export can not be mangled, defaults to true
 */

// TRANSITIVE 符号：表示依赖的变化会传递影响
const TRANSITIVE = Symbol("transitive");

// 懒加载：获取被忽略的模块（用于可选依赖）
const getIgnoredModule = memoize(() => {
	const RawModule = require("./RawModule");
	return new RawModule("/* (ignored) */", `ignored`, `(ignored)`);
});

/**
 * Dependency - 依赖基类
 *
 * 【核心职责】
 * 1. 记录依赖的位置信息（源码中的行列号）
 * 2. 提供依赖的元数据（类型、类别）
 * 3. 定义依赖的行为接口（导出、警告、错误等）
 *
 * 【重要属性】
 * - weak: 弱依赖（不会触发模块构建）
 * - optional: 可选依赖（找不到不报错）
 * - _loc*: 位置信息（优化内存占用的存储方式）
 *
 * 【不存储的信息】
 * ❌ 不存储目标模块（由 ModuleGraph 管理）
 * ❌ 不存储父模块（由 ModuleGraph 管理）
 * ✅ 只存储依赖本身的信息
 */
class Dependency {
	constructor() {
		// ===== 父级引用（内部使用）=====

		/** @type {Module | undefined} */
		this._parentModule = undefined; // 所属的父模块

		/** @type {DependenciesBlock | undefined} */
		this._parentDependenciesBlock = undefined; // 所属的依赖块

		/** @type {number} */
		this._parentDependenciesBlockIndex = -1; // 在依赖块中的索引

		// ===== 依赖特性 =====

		// TODO check if this can be moved into ModuleDependency
		/** @type {boolean} */
		this.weak = false; // 弱依赖：不会触发模块构建

		// TODO check if this can be moved into ModuleDependency
		/** @type {boolean} */
		this.optional = false; // 可选依赖：找不到不报错

		// ===== 位置信息（优化的存储方式）=====
		// 使用单独的数字属性代替对象，减少内存占用

		this._locSL = 0; // Start Line (起始行)
		this._locSC = 0; // Start Column (起始列)
		this._locEL = 0; // End Line (结束行)
		this._locEC = 0; // End Column (结束列)
		this._locI = undefined; // Index (索引)
		this._locN = undefined; // Name (名称)
		this._loc = undefined; // 缓存的位置对象
	}

	/**
	 * 获取依赖类型
	 *
	 * 【子类必须重写】
	 * 返回依赖的具体类型，如：
	 * - "harmony import"
	 * - "commonjs require"
	 * - "import()"
	 *
	 * @returns {string} 依赖类型的显示名称
	 */
	get type() {
		return "unknown";
	}

	/**
	 * 获取依赖类别
	 *
	 * 【典型类别】
	 * - "esm": ES Module
	 * - "commonjs": CommonJS
	 * - "amd": AMD
	 * - "url": URL 资源
	 *
	 * @returns {string} 依赖类别
	 */
	get category() {
		return "unknown";
	}

	/**
	 * 获取依赖位置信息（懒计算 + 缓存）
	 *
	 * 【内存优化技巧】⭐
	 * 不直接存储位置对象，而是：
	 * 1. 存储：单独的数字属性（_locSL, _locSC 等）
	 * 2. 计算：首次访问时构建对象
	 * 3. 缓存：缓存构建的对象
	 *
	 * 【为什么这样做】
	 * - 依赖对象数量巨大（数千到数万个）
	 * - 大部分依赖的位置信息不会被访问
	 * - 数字属性比对象占用更少内存
	 *
	 * @returns {DependencyLocation} 位置对象
	 */
	get loc() {
		// 如果已缓存，直接返回
		if (this._loc !== undefined) return this._loc;

		// 构建位置对象
		/** @type {SyntheticDependencyLocation & RealDependencyLocation} */
		const loc = {};

		// 添加起始位置
		if (this._locSL > 0) {
			loc.start = { line: this._locSL, column: this._locSC };
		}

		// 添加结束位置
		if (this._locEL > 0) {
			loc.end = { line: this._locEL, column: this._locEC };
		}

		// 添加名称（用于合成位置）
		if (this._locN !== undefined) {
			loc.name = this._locN;
		}

		// 添加索引
		if (this._locI !== undefined) {
			loc.index = this._locI;
		}

		// 缓存并返回
		return (this._loc = loc);
	}

	set loc(loc) {
		if ("start" in loc && typeof loc.start === "object") {
			this._locSL = loc.start.line || 0;
			this._locSC = loc.start.column || 0;
		} else {
			this._locSL = 0;
			this._locSC = 0;
		}
		if ("end" in loc && typeof loc.end === "object") {
			this._locEL = loc.end.line || 0;
			this._locEC = loc.end.column || 0;
		} else {
			this._locEL = 0;
			this._locEC = 0;
		}
		if ("index" in loc) {
			this._locI = loc.index;
		} else {
			this._locI = undefined;
		}
		if ("name" in loc) {
			this._locN = loc.name;
		} else {
			this._locN = undefined;
		}
		this._loc = loc;
	}

	/**
	 * @param {number} startLine start line
	 * @param {number} startColumn start column
	 * @param {number} endLine end line
	 * @param {number} endColumn end column
	 */
	setLoc(startLine, startColumn, endLine, endColumn) {
		this._locSL = startLine;
		this._locSC = startColumn;
		this._locEL = endLine;
		this._locEC = endColumn;
		this._locI = undefined;
		this._locN = undefined;
		this._loc = undefined;
	}

	/**
	 * @returns {string | undefined} a request context
	 */
	getContext() {
		return undefined;
	}

	/**
	 * @returns {string | null} an identifier to merge equal requests
	 */
	getResourceIdentifier() {
		return null;
	}

	/**
	 * @returns {boolean | TRANSITIVE} true, when changes to the referenced module could affect the referencing module; TRANSITIVE, when changes to the referenced module could affect referencing modules of the referencing module
	 */
	couldAffectReferencingModule() {
		return TRANSITIVE;
	}

	/**
	 * Returns the referenced module and export
	 * @deprecated
	 * @param {ModuleGraph} moduleGraph module graph
	 * @returns {never} throws error
	 */
	getReference(moduleGraph) {
		throw new Error(
			"Dependency.getReference was removed in favor of Dependency.getReferencedExports, ModuleGraph.getModule and ModuleGraph.getConnection().active"
		);
	}

	/**
	 * 获取此依赖引用的导出列表（Tree Shaking 核心！）⭐⭐⭐
	 *
	 * 【作用】
	 * 返回依赖引用了目标模块的哪些导出，用于：
	 * 1. Tree Shaking: 删除未使用的导出
	 * 2. Side Effects: 判断是否需要执行模块
	 * 3. 代码优化: 决定哪些代码可以删除
	 *
	 * 【返回值示例】
	 * - [["foo"]]: 只引用 foo 导出
	 * - [["foo", "bar"]]: 引用 foo.bar（嵌套）
	 * - [[]]: 引用整个导出对象
	 * - EXPORTS_OBJECT_REFERENCED: 引用整个对象（默认）
	 * - NO_EXPORTS_REFERENCED: 不引用任何导出
	 *
	 * 【举例】
	 * ```javascript
	 * import { foo } from './a'  // [["foo"]]
	 * import * as A from './a'   // [[]]
	 * import './a'               // NO_EXPORTS_REFERENCED
	 * require('./a')             // EXPORTS_OBJECT_REFERENCED
	 * ```
	 *
	 * @param {ModuleGraph} moduleGraph - 模块图
	 * @param {RuntimeSpec} runtime - 运行时规范
	 * @returns {(string[] | ReferencedExport)[]} 引用的导出列表
	 */
	getReferencedExports(moduleGraph, runtime) {
		// 默认：引用整个导出对象
		return Dependency.EXPORTS_OBJECT_REFERENCED;
	}

	/**
	 * 获取依赖的激活条件
	 *
	 * 【作用】
	 * 返回判断连接是否激活的函数，用于：
	 * - 条件导入：根据环境判断是否使用
	 * - 动态优化：运行时决定是否加载
	 *
	 * 【返回值】
	 * - null: 始终激活
	 * - false: 始终不激活
	 * - function: 动态判断函数
	 *
	 * @param {ModuleGraph} moduleGraph - 模块图
	 * @returns {null | false | function(ModuleGraphConnection, RuntimeSpec): ConnectionState}
	 */
	getCondition(moduleGraph) {
		return null; // 默认：始终激活
	}

	/**
	 * 获取此依赖提供的导出信息
	 *
	 * 【使用场景】
	 * 主要用于 export 语句，返回模块提供了哪些导出
	 *
	 * 【示例】
	 * ```javascript
	 * export { foo, bar }     // 返回 ['foo', 'bar']
	 * export * from './a'     // 返回重新导出信息
	 * ```
	 *
	 * @param {ModuleGraph} moduleGraph - 模块图
	 * @returns {ExportsSpec | undefined} 导出规格
	 */
	getExports(moduleGraph) {
		return undefined; // 默认：不提供导出（import 依赖）
	}

	/**
	 * Returns warnings
	 * @param {ModuleGraph} moduleGraph module graph
	 * @returns {WebpackError[] | null | undefined} warnings
	 */
	getWarnings(moduleGraph) {
		return null;
	}

	/**
	 * Returns errors
	 * @param {ModuleGraph} moduleGraph module graph
	 * @returns {WebpackError[] | null | undefined} errors
	 */
	getErrors(moduleGraph) {
		return null;
	}

	/**
	 * Update the hash
	 * @param {Hash} hash hash to be updated
	 * @param {UpdateHashContext} context context
	 * @returns {void}
	 */
	updateHash(hash, context) {}

	/**
	 * implement this method to allow the occurrence order plugin to count correctly
	 * @returns {number} count how often the id is used in this dependency
	 */
	getNumberOfIdOccurrences() {
		return 1;
	}

	/**
	 * @param {ModuleGraph} moduleGraph the module graph
	 * @returns {ConnectionState} how this dependency connects the module to referencing modules
	 */
	getModuleEvaluationSideEffectsState(moduleGraph) {
		return true;
	}

	/**
	 * @param {string} context context directory
	 * @returns {Module | null} a module
	 */
	createIgnoredModule(context) {
		return getIgnoredModule();
	}

	/**
	 * @param {ObjectSerializerContext} context context
	 */
	serialize({ write }) {
		write(this.weak);
		write(this.optional);
		write(this._locSL);
		write(this._locSC);
		write(this._locEL);
		write(this._locEC);
		write(this._locI);
		write(this._locN);
	}

	/**
	 * @param {ObjectDeserializerContext} context context
	 */
	deserialize({ read }) {
		this.weak = read();
		this.optional = read();
		this._locSL = read();
		this._locSC = read();
		this._locEL = read();
		this._locEC = read();
		this._locI = read();
		this._locN = read();
	}
}

// ===== 常量定义 =====

/**
 * 不引用任何导出
 *
 * 【使用场景】
 * import './style.css'  // 只执行副作用，不使用导出
 *
 * @type {string[][]}
 */
Dependency.NO_EXPORTS_REFERENCED = [];

/**
 * 引用整个导出对象
 *
 * 【使用场景】
 * const module = require('./a')  // 可能使用任何导出
 * import * as A from './a'        // 使用所有导出
 *
 * @type {string[][]}
 */
Dependency.EXPORTS_OBJECT_REFERENCED = [[]];

// ===== webpack 5 的重大变更 =====

/**
 * ❌ 已废弃：module 属性
 *
 * 【变更原因】
 * webpack 4: Dependency.module 直接存储目标模块
 * webpack 5: 图关系移到 ModuleGraph 中
 *
 * 【新的使用方式】
 * ❌ dependency.module
 * ✅ moduleGraph.getModule(dependency)
 *
 * 【为什么改变】
 * 1. 职责分离：Dependency 只存储依赖信息，不存储图关系
 * 2. 多 Compilation 支持：同一个 Dependency 可以在多个图中
 * 3. 缓存友好：Dependency 可以被序列化缓存
 */
Object.defineProperty(Dependency.prototype, "module", {
	/**
	 * @deprecated
	 * @returns {never} throws
	 */
	get() {
		throw new Error(
			"module property was removed from Dependency (use compilation.moduleGraph.getModule(dependency) instead)"
		);
	},

	/**
	 * @deprecated
	 * @returns {never} throws
	 */
	set() {
		throw new Error(
			"module property was removed from Dependency (use compilation.moduleGraph.updateModule(dependency, module) instead)"
		);
	}
});

/**
 * ❌ 已废弃：disconnect 方法
 *
 * 【变更原因】
 * webpack 4: Dependency 管理自己的连接
 * webpack 5: 连接由 ModuleGraph 管理
 */
Object.defineProperty(Dependency.prototype, "disconnect", {
	get() {
		throw new Error(
			"disconnect was removed from Dependency (Dependency no longer carries graph specific information)"
		);
	}
});

// 导出 TRANSITIVE 符号
Dependency.TRANSITIVE = TRANSITIVE;

module.exports = Dependency;
