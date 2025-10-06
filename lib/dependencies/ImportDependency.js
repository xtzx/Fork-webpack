/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

/**
 * lib/dependencies/ImportDependency.js - 动态导入依赖 ⭐⭐⭐
 *
 * 【文件作用】
 * 处理 ES Module 的动态 import() 语句，这是异步加载的核心
 *
 * 【对应的语法】
 * ```javascript
 * import('./lazy.js')                    // 基础动态导入
 * import('./lazy.js').then(m => {...})   // Promise 链式调用
 * const module = await import('./lazy.js') // async/await
 *
 * // 魔法注释
 * import(
 *   /* webpackChunkName: "my-chunk" *\/
 *   /* webpackMode: "lazy" *\/
 *   './lazy.js'
 * )
 * ```
 *
 * 【核心特性】
 *
 * 1. **异步加载**：
 *    - 创建独立的 Chunk（代码分割）
 *    - 按需加载，不阻塞主线程
 *    - 返回 Promise
 *
 * 2. **魔法注释支持**：
 *    - webpackChunkName: 指定 chunk 名称
 *    - webpackMode: 加载模式（'lazy'、'eager'、'weak'、'lazy-once'）
 *    - webpackPrefetch: 预取
 *    - webpackPreload: 预加载
 *
 * 3. **与静态 import 的区别**：
 *    - 静态 import: 同步加载，放到同一个 Chunk
 *    - 动态 import(): 异步加载，创建新的 Chunk
 *
 * 【工作原理】⭐⭐⭐
 *
 * **Make 阶段（识别）**：
 * ```
 * JavascriptParser 解析到 import()
 *   ↓
 * walkImportExpression()
 *   ↓
 * 创建 ImportDependency
 *   ↓
 * 创建 AsyncDependenciesBlock（异步依赖块）
 *   ↓
 * 标记为异步依赖
 * ```
 *
 * **Seal 阶段（创建 Chunk）**：
 * ```
 * buildChunkGraph 遍历模块
 *   ↓
 * 遇到 AsyncDependenciesBlock
 *   ↓
 * 创建新的 Chunk
 *   ↓
 * 建立 Chunk 父子关系
 * main chunk → lazy chunk
 * ```
 *
 * **代码生成阶段**：
 * ```
 * 源码：
 * import('./lazy.js').then(m => m.foo())
 *
 * 生成：
 * __webpack_require__.e(/* lazy chunk id *\/)
 *   .then(__webpack_require__.bind(__webpack_require__, './lazy.js'))
 *   .then(m => m.foo())
 * ```
 *
 * 【运行时行为】
 *
 * 1. __webpack_require__.e(chunkId)：
 *    - 创建 <script> 标签
 *    - src = lazy.chunk.js
 *    - 返回 Promise
 *
 * 2. chunk 加载完成：
 *    - 执行 chunk 代码
 *    - 注册模块
 *    - resolve Promise
 *
 * 3. __webpack_require__('./lazy.js')：
 *    - 执行模块代码
 *    - 返回 exports
 *
 * 【魔法注释详解】⭐
 *
 * webpackChunkName:
 * ```javascript
 * import(/* webpackChunkName: "my-chunk" *\/ './lazy.js')
 * // 生成: my-chunk.js（而不是 0.js）
 * ```
 *
 * webpackMode:
 * - 'lazy': 默认，按需加载
 * - 'eager': 不创建新 chunk，放到主 chunk
 * - 'weak': 弱加载，模块必须已存在
 * - 'lazy-once': 多个动态导入共享一个 chunk
 *
 * webpackPrefetch:
 * ```javascript
 * import(/* webpackPrefetch: true *\/ './lazy.js')
 * // 在浏览器空闲时预加载
 * // <link rel="prefetch" href="lazy.js">
 * ```
 *
 * webpackPreload:
 * ```javascript
 * import(/* webpackPreload: true *\/ './lazy.js')
 * // 与主 chunk 并行加载
 * // <link rel="preload" href="lazy.js">
 * ```
 *
 * 【性能优化】
 *
 * 1. **代码分割**：
 *    - 减少主 bundle 大小
 *    - 加快首屏加载
 *    - 按需加载功能模块
 *
 * 2. **并行加载**：
 *    - 多个 import() 可以并行
 *    - 充分利用浏览器并发能力
 *
 * 3. **缓存优化**：
 *    - 独立的 chunk 可以单独缓存
 *    - 主代码变化不影响异步 chunk
 *
 * 【文档中不存在的知识点】⭐⭐
 *
 * 1. **如何创建独立 Chunk**：
 *    - ImportDependency 关联 AsyncDependenciesBlock
 *    - buildChunkGraph 检测到异步块
 *    - 为异步块创建新的 Chunk
 *
 * 2. **如何生成加载代码**：
 *    - Template 类负责代码生成
 *    - 调用 runtimeTemplate.moduleNamespacePromise()
 *    - 生成 __webpack_require__.e() 代码
 *
 * 3. **父子 Chunk 的关系**：
 *    - 主 chunk 记录子 chunk 的 ID
 *    - 运行时根据 ID 加载对应的文件
 *    - 文件名通过 chunkFilename 配置
 */

"use strict";

const Dependency = require("../Dependency");
const makeSerializable = require("../util/makeSerializable");
const ModuleDependency = require("./ModuleDependency");

/** @typedef {import("webpack-sources").ReplaceSource} ReplaceSource */
/** @typedef {import("../AsyncDependenciesBlock")} AsyncDependenciesBlock */
/** @typedef {import("../Dependency").ReferencedExport} ReferencedExport */
/** @typedef {import("../DependencyTemplate").DependencyTemplateContext} DependencyTemplateContext */
/** @typedef {import("../Module")} Module */
/** @typedef {import("../Module").BuildMeta} BuildMeta */
/** @typedef {import("../ModuleGraph")} ModuleGraph */
/** @typedef {import("../javascript/JavascriptParser").Range} Range */
/** @typedef {import("../serialization/ObjectMiddleware").ObjectDeserializerContext} ObjectDeserializerContext */
/** @typedef {import("../serialization/ObjectMiddleware").ObjectSerializerContext} ObjectSerializerContext */
/** @typedef {import("../util/runtime").RuntimeSpec} RuntimeSpec */

/**
 * ImportDependency - 动态导入依赖类
 *
 * 【继承关系】
 * Dependency → ModuleDependency → ImportDependency
 *
 * 【创建时机】
 * JavascriptParser 解析到 import() 表达式时创建
 *
 * 【与 AsyncDependenciesBlock 的关系】⭐
 * ImportDependency 总是关联一个 AsyncDependenciesBlock：
 * ```javascript
 * const block = new AsyncDependenciesBlock(
 *   { name: 'my-chunk' },  // 魔法注释
 *   module,
 *   loc
 * );
 * const dep = new ImportDependency('./lazy.js', range);
 * block.addDependency(dep);
 * module.addBlock(block);
 * ```
 *
 * 【实例对应】
 * 源码中的每个 import() → 1 个 ImportDependency + 1 个 AsyncDependenciesBlock
 */
class ImportDependency extends ModuleDependency {
	/**
	 * 构造函数
	 *
	 * 【参数说明】
	 *
	 * @param {string} request - 请求路径（如 './lazy.js'）
	 * @param {Range} range - 源码位置范围 [start, end]
	 *   用于代码生成时替换 import() 表达式
	 * @param {(string[][] | null)=} referencedExports - 引用的导出列表
	 *   如果明确知道使用了哪些导出（Tree Shaking）
	 *
	 * 【示例】
	 * ```javascript
	 * // 源码
	 * import('./lazy.js').then(m => m.foo())
	 *
	 * // 创建
	 * new ImportDependency(
	 *   './lazy.js',
	 *   [12, 27],           // import() 的位置
	 *   [['foo']]           // 使用了 foo 导出
	 * )
	 * ```
	 */
	constructor(request, range, referencedExports) {
		// 调用父类构造函数
		super(request);

		/**
		 * 源码位置范围
		 *
		 * 【格式】
		 * [startPos, endPos]
		 *
		 * 【用途】
		 * 代码生成时，用这个范围替换源码：
		 * import('./lazy.js') → __webpack_require__.e(...)
		 */
		this.range = range;

		/**
		 * 引用的导出列表
		 *
		 * 【格式】
		 * - [['foo']]: 使用 foo 导出
		 * - [['foo', 'bar']]: 使用 foo.bar
		 * - null: 使用整个模块
		 *
		 * 【用途】
		 * Tree Shaking：只保留被使用的导出
		 */
		this.referencedExports = referencedExports;
	}

	/**
	 * 获取依赖类型
	 *
	 * 【返回值】
	 * 'import()' - 标识这是动态导入
	 *
	 * 【用途】
	 * - 错误报告显示
	 * - 统计信息
	 */
	get type() {
		return "import()";
	}

	/**
	 * 获取依赖类别
	 *
	 * 【返回值】
	 * 'esm' - ES Module 类别
	 *
	 * 【说明】
	 * 虽然是动态导入，但仍然是 ES Module 系统的一部分
	 */
	get category() {
		return "esm";
	}

	/**
	 * 获取引用的导出（Tree Shaking 关键）⭐⭐
	 *
	 * 【作用】
	 * 返回动态导入使用了哪些导出
	 *
	 * 【示例】
	 * ```javascript
	 * // 明确使用某些导出
	 * import('./a').then(({ foo }) => foo())
	 * → referencedExports = [['foo']]
	 *
	 * // 使用整个模块
	 * import('./a').then(m => use(m))
	 * → referencedExports = null
	 * → 返回 EXPORTS_OBJECT_REFERENCED
	 * ```
	 *
	 * 【canMangle】
	 * 设置为 false，因为动态导入在运行时执行
	 * 不能在构建时重命名（可能有字符串访问）
	 *
	 * @param {ModuleGraph} moduleGraph - 模块图
	 * @param {RuntimeSpec} runtime - 运行时规范
	 * @returns {(string[] | ReferencedExport)[]} 引用的导出列表
	 */
	getReferencedExports(moduleGraph, runtime) {
		return this.referencedExports
			? this.referencedExports.map(e => ({
					name: e,
					canMangle: false  // 动态导入不能重命名
			  }))
			: Dependency.EXPORTS_OBJECT_REFERENCED;  // 使用整个导出对象
	}

	/**
	 * @param {ObjectSerializerContext} context context
	 */
	serialize(context) {
		context.write(this.range);
		context.write(this.referencedExports);
		super.serialize(context);
	}

	/**
	 * @param {ObjectDeserializerContext} context context
	 */
	deserialize(context) {
		this.range = context.read();
		this.referencedExports = context.read();
		super.deserialize(context);
	}
}

makeSerializable(ImportDependency, "webpack/lib/dependencies/ImportDependency");

ImportDependency.Template = class ImportDependencyTemplate extends (
	ModuleDependency.Template
) {
	/**
	 * @param {Dependency} dependency the dependency for which the template should be applied
	 * @param {ReplaceSource} source the current replace source which can be modified
	 * @param {DependencyTemplateContext} templateContext the context object
	 * @returns {void}
	 */
	apply(
		dependency,
		source,
		{ runtimeTemplate, module, moduleGraph, chunkGraph, runtimeRequirements }
	) {
		const dep = /** @type {ImportDependency} */ (dependency);
		const block = /** @type {AsyncDependenciesBlock} */ (
			moduleGraph.getParentBlock(dep)
		);
		const content = runtimeTemplate.moduleNamespacePromise({
			chunkGraph,
			block: block,
			module: /** @type {Module} */ (moduleGraph.getModule(dep)),
			request: dep.request,
			strict: /** @type {BuildMeta} */ (module.buildMeta).strictHarmonyModule,
			message: "import()",
			runtimeRequirements
		});

		source.replace(dep.range[0], dep.range[1] - 1, content);
	}
};

module.exports = ImportDependency;
