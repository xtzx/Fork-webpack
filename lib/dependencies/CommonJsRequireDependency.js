/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

/**
 * lib/dependencies/CommonJsRequireDependency.js - CommonJS require 依赖 ⭐⭐⭐
 *
 * 【文件作用】
 * 处理 CommonJS 的 require() 语句，这是 Node.js 的标准模块系统
 *
 * 【对应的语法】
 * ```javascript
 * const foo = require('./a');           // 基础 require
 * const { bar } = require('./b');       // 解构
 * const baz = require('./c').baz;       // 属性访问
 * module.exports = require('./d');      // 直接导出
 * ```
 *
 * 【核心特性】
 *
 * 1. **同步加载**：
 *    - require() 是同步的
 *    - 模块放到同一个 Chunk
 *    - 不会代码分割
 *
 * 2. **动态性**：
 *    - require(variable) 支持动态路径
 *    - 但 webpack 需要静态分析，所以有限制
 *
 * 3. **与 ES Module 互操作**：
 *    - require(esModule) → 自动处理 default
 *    - import from commonjs → 支持互操作
 *
 * 【与 HarmonyImportDependency 的区别】
 *
 * | 特性 | HarmonyImportDependency | CommonJsRequireDependency |
 * |------|------------------------|---------------------------|
 * | 语法 | import foo from './a' | const foo = require('./a') |
 * | 类别 | esm | commonjs |
 * | 静态分析 | 完全静态 | 部分动态 |
 * | Tree Shaking | 支持 | 有限支持 |
 * | 执行时机 | 提升到顶部 | 执行时加载 |
 *
 * 【工作原理】
 *
 * **Make 阶段（识别）**：
 * ```
 * JavascriptParser 解析到 require()
 *   ↓
 * walkCallExpression()
 *   ↓
 * hooks.call.for('require')
 *   ↓
 * CommonJsRequireDependencyParserPlugin
 *   ↓
 * 创建 CommonJsRequireDependency
 *   ↓
 * module.dependencies.push(dep)
 * ```
 *
 * **代码生成阶段**：
 * ```
 * 源码：
 * const foo = require('./a');
 *
 * 生成：
 * const foo = __webpack_require__(/* module id *\/);
 * ```
 *
 * 【Tree Shaking 支持】⭐
 *
 * CommonJS 的 Tree Shaking 有限：
 * ```javascript
 * // ❌ 无法优化（动态访问）
 * const utils = require('./utils');
 * utils[dynamicKey]();
 *
 * // ✅ 可以优化（静态访问）
 * const { foo } = require('./utils');
 * foo();
 * // webpack 知道只用了 foo
 * ```
 *
 * 【动态 require】
 *
 * webpack 对动态 require 的处理：
 * ```javascript
 * // ❌ 完全动态（无法处理）
 * require(variable);
 *
 * // ⚠️ 部分动态（创建 ContextModule）
 * require('./locales/' + lang + '.json');
 * // webpack 会打包 ./locales 下的所有 .json 文件
 *
 * // ✅ 静态（正常处理）
 * require('./a.js');
 * ```
 *
 * 【互操作性】⭐
 *
 * require ES Module:
 * ```javascript
 * // a.js (ES Module)
 * export default 'foo';
 * export const bar = 'bar';
 *
 * // b.js (CommonJS)
 * const a = require('./a');
 * console.log(a.default);  // 'foo'
 * console.log(a.bar);      // 'bar'
 * ```
 *
 * ES Module import CommonJS:
 * ```javascript
 * // a.js (CommonJS)
 * module.exports = { foo: 'foo' };
 *
 * // b.js (ES Module)
 * import a from './a';
 * console.log(a.foo);  // 'foo'
 * ```
 *
 * 【文档中不存在的知识点】⭐⭐
 *
 * 1. **为什么 require 不能完全 Tree Shaking**：
 *    - CommonJS 是动态的（运行时才知道导出）
 *    - 可能有 module.exports[key] = value
 *    - 无法静态分析所有导出
 *
 * 2. **如何生成运行时代码**：
 *    - 使用 ModuleDependencyTemplateAsId
 *    - 将 require('./a') 替换为 __webpack_require__(moduleId)
 *    - moduleId 在 Seal 阶段生成
 *
 * 3. **循环依赖如何处理**：
 *    - CommonJS 支持循环依赖
 *    - 使用 module.exports 对象引用
 *    - 可以访问部分初始化的模块
 */

"use strict";

const makeSerializable = require("../util/makeSerializable");
const ModuleDependency = require("./ModuleDependency");
const ModuleDependencyTemplateAsId = require("./ModuleDependencyTemplateAsId");

/** @typedef {import("../javascript/JavascriptParser").Range} Range */

/**
 * CommonJsRequireDependency - CommonJS require 依赖类
 *
 * 【继承关系】
 * Dependency → ModuleDependency → CommonJsRequireDependency
 *
 * 【创建时机】
 * JavascriptParser 解析到 require() 调用时创建
 *
 * 【实例对应】
 * 源码中的每个 require() → 1 个 CommonJsRequireDependency 实例
 */
class CommonJsRequireDependency extends ModuleDependency {
	/**
	 * 构造函数
	 *
	 * 【参数说明】
	 *
	 * @param {string} request - 请求路径（如 './a.js'）
	 * @param {Range=} range - 源码位置范围 [start, end]
	 *   用于代码生成时替换 require() 表达式
	 * @param {string=} context - 请求上下文路径
	 *
	 * 【示例】
	 * ```javascript
	 * // 源码
	 * const foo = require('./a.js');
	 *
	 * // 创建
	 * new CommonJsRequireDependency(
	 *   './a.js',
	 *   [12, 27],    // require() 的位置
	 *   '/project'   // 上下文路径
	 * )
	 * ```
	 */
	constructor(request, range, context) {
		// 调用父类构造函数
		super(request);

		/**
		 * 源码位置范围
		 *
		 * 【格式】
		 * [startPos, endPos]
		 *
		 * 【用途】
		 * 代码生成时替换源码：
		 * require('./a') → __webpack_require__(moduleId)
		 */
		this.range = range;

		/**
		 * 上下文路径
		 *
		 * 【用途】
		 * 解析相对路径时使用
		 */
		this._context = context;
	}

	/**
	 * 获取依赖类型
	 *
	 * 【返回值】
	 * 'cjs require' - 标识这是 CommonJS require
	 *
	 * 【用途】
	 * - 错误报告显示
	 * - 统计信息
	 */
	get type() {
		return "cjs require";
	}

	/**
	 * 获取依赖类别
	 *
	 * 【返回值】
	 * 'commonjs' - CommonJS 模块系统
	 *
	 * 【用途】
	 * 区分模块系统类型
	 */
	get category() {
		return "commonjs";
	}
}

/**
 * Template - 代码生成模板
 *
 * 【作用】
 * 使用 ModuleDependencyTemplateAsId
 * 将 require('./a') 替换为 __webpack_require__(moduleId)
 *
 * 【生成示例】
 * 源码：const foo = require('./a');
 * 生成：const foo = __webpack_require__(123);
 */
CommonJsRequireDependency.Template = ModuleDependencyTemplateAsId;

CommonJsRequireDependency.Template = ModuleDependencyTemplateAsId;

makeSerializable(
	CommonJsRequireDependency,
	"webpack/lib/dependencies/CommonJsRequireDependency"
);

module.exports = CommonJsRequireDependency;
