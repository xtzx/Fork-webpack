/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

/**
 * lib/hmr/HotModuleReplacementRuntimeModule.js - HMR 运行时模块 ⭐⭐⭐
 *
 * 【文件作用】
 * 这是一个 RuntimeModule（运行时模块），负责将 HMR 运行时代码注入到 bundle 中
 *
 * 【核心职责】
 * 1. 生成 HMR 运行时代码（基于 HotModuleReplacement.runtime.js）
 * 2. 替换占位符为实际的 RuntimeGlobals 变量名
 * 3. 在编译时被添加到每个需要 HMR 的 chunk 中
 *
 * 【RuntimeModule 是什么？】
 * RuntimeModule 是 webpack 运行时代码的模块化表示
 * 例如：
 * - __webpack_require__ 函数的定义
 * - 模块缓存的管理
 * - 异步加载的实现
 * - HMR 功能的实现 ← 本模块
 *
 * 【何时添加？】
 * 当 HotModuleReplacementPlugin 检测到需要 HMR 时：
 * compilation.hooks.additionalTreeRuntimeRequirements.tap((chunk) => {
 *   compilation.addRuntimeModule(chunk, new HotModuleReplacementRuntimeModule());
 * });
 *
 * 【生成的代码】
 * 注入后的 bundle 中会包含：
 * - module.hot 对象的实现
 * - module.hot.check() 方法
 * - module.hot.apply() 方法
 * - HMR 状态机管理
 */

"use strict";

const RuntimeGlobals = require("../RuntimeGlobals"); // 运行时全局变量名
const RuntimeModule = require("../RuntimeModule"); // 运行时模块基类
const Template = require("../Template"); // 模板工具

/**
 * HotModuleReplacementRuntimeModule - HMR 运行时模块类
 *
 * 【继承自 RuntimeModule】
 * RuntimeModule 是所有运行时模块的基类
 * 每个 RuntimeModule 都会生成一段代码，注入到 bundle 中
 */
class HotModuleReplacementRuntimeModule extends RuntimeModule {
	/**
	 * 构造函数
	 *
	 * 【参数】
	 * - "hot module replacement": 模块名称（用于调试）
	 * - RuntimeModule.STAGE_BASIC: 执行阶段
	 *
	 * 【执行阶段说明】
	 * RuntimeModule 有不同的执行阶段：
	 * - STAGE_NORMAL (0): 普通阶段
	 * - STAGE_BASIC (5): 基础阶段（本模块）
	 * - STAGE_ATTACH (10): 附加阶段
	 * - STAGE_TRIGGER (20): 触发阶段
	 *
	 * 执行顺序：STAGE_NORMAL → STAGE_BASIC → STAGE_ATTACH → STAGE_TRIGGER
	 */
	constructor() {
		super("hot module replacement", RuntimeModule.STAGE_BASIC);
	}

	/**
	 * 生成运行时代码 ⭐⭐⭐
	 *
	 * 【作用】
	 * 1. 读取 HotModuleReplacement.runtime.js 的函数内容
	 * 2. 替换占位符为实际的全局变量名
	 * 3. 返回最终的运行时代码字符串
	 *
	 * 【为什么需要替换占位符？】
	 * webpack 支持自定义全局变量名（通过 output.globalObject 等）
	 * 所以不能硬编码变量名，需要使用 RuntimeGlobals 动态获取
	 *
	 * 【占位符列表】
	 * - $getFullHash$ → RuntimeGlobals.getFullHash
	 *   用途：获取当前 bundle 的完整 hash
	 *   默认值：__webpack_require__.h
	 *
	 * - $interceptModuleExecution$ → RuntimeGlobals.interceptModuleExecution
	 *   用途：拦截模块执行（注入 module.hot）
	 *   默认值：__webpack_require__.i
	 *
	 * - $moduleCache$ → RuntimeGlobals.moduleCache
	 *   用途：模块缓存对象
	 *   默认值：__webpack_require__.c
	 *
	 * - $hmrModuleData$ → RuntimeGlobals.hmrModuleData
	 *   用途：HMR 模块数据（存储 module.hot.data）
	 *   默认值：__webpack_require__.hmrD
	 *
	 * - $hmrDownloadManifest$ → RuntimeGlobals.hmrDownloadManifest
	 *   用途：下载更新清单（hot-update.json）
	 *   默认值：__webpack_require__.hmrM
	 *
	 * - $hmrInvalidateModuleHandlers$ → RuntimeGlobals.hmrInvalidateModuleHandlers
	 *   用途：模块失效处理器
	 *   默认值：__webpack_require__.hmrI
	 *
	 * - $hmrDownloadUpdateHandlers$ → RuntimeGlobals.hmrDownloadUpdateHandlers
	 *   用途：下载更新模块处理器（hot-update.js）
	 *   默认值：__webpack_require__.hmrC
	 *
	 * @returns {string | null} 生成的运行时代码字符串
	 */
	generate() {
		// ===== 步骤1: 读取 HotModuleReplacement.runtime.js 的函数内容 =====
		/**
		 * Template.getFunctionContent() 的作用：
		 * 1. 读取模块文件（require）
		 * 2. 如果是函数，提取函数体内容（去掉 function() { 和 }）
		 * 3. 如果是普通代码，直接返回
		 *
		 * HotModuleReplacement.runtime.js 导出的是一个函数：
		 * module.exports = function() {
		 *   // HMR 运行时代码
		 *   // 包含 module.hot API 实现
		 *   // 包含 hotCheck、hotApply 等函数
		 * };
		 *
		 * getFunctionContent 会提取函数内部的代码
		 */
		return Template.getFunctionContent(
			require("./HotModuleReplacement.runtime.js")
		)
			// ===== 步骤2: 替换占位符 =====
			// 以下每个 replace 都将占位符替换为实际的全局变量名

			// 替换 $getFullHash$ → __webpack_require__.h
			// 用于获取当前 bundle 的 hash
			.replace(/\$getFullHash\$/g, RuntimeGlobals.getFullHash)

			// 替换 $interceptModuleExecution$ → __webpack_require__.i
			// 用于在模块执行前注入 module.hot 对象
			.replace(
				/\$interceptModuleExecution\$/g,
				RuntimeGlobals.interceptModuleExecution
			)

			// 替换 $moduleCache$ → __webpack_require__.c
			// 访问模块缓存，查找已加载的模块
			.replace(/\$moduleCache\$/g, RuntimeGlobals.moduleCache)

			// 替换 $hmrModuleData$ → __webpack_require__.hmrD
			// 存储 HMR 模块数据（module.hot.data）
			.replace(/\$hmrModuleData\$/g, RuntimeGlobals.hmrModuleData)

			// 替换 $hmrDownloadManifest$ → __webpack_require__.hmrM
			// 下载更新清单（hot-update.json）的函数
			.replace(/\$hmrDownloadManifest\$/g, RuntimeGlobals.hmrDownloadManifest)

			// 替换 $hmrInvalidateModuleHandlers$ → __webpack_require__.hmrI
			// 模块失效处理器集合
			.replace(
				/\$hmrInvalidateModuleHandlers\$/g,
				RuntimeGlobals.hmrInvalidateModuleHandlers
			)

			// 替换 $hmrDownloadUpdateHandlers$ → __webpack_require__.hmrC
			// 下载更新模块（hot-update.js）的处理器集合
			.replace(
				/\$hmrDownloadUpdateHandlers\$/g,
				RuntimeGlobals.hmrDownloadUpdateHandlers
			);

		/**
		 * 【生成的代码示例】
		 *
		 * 替换前（占位符）:
		 * var moduleCache = $moduleCache$;
		 * var downloadManifest = $hmrDownloadManifest$;
		 *
		 * 替换后（实际代码）:
		 * var moduleCache = __webpack_require__.c;
		 * var downloadManifest = __webpack_require__.hmrM;
		 *
		 * 【最终效果】
		 * 这段代码会被注入到 bundle.js 中，类似：
		 *
		 * (function() {
		 *   var installedModules = __webpack_require__.c;
		 *   var hotCheck = function() { ... };
		 *   var hotApply = function() { ... };
		 *   var createModuleHotObject = function() {
		 *     return {
		 *       accept: function() { ... },
		 *       decline: function() { ... },
		 *       dispose: function() { ... },
		 *       check: hotCheck,
		 *       apply: hotApply,
		 *       ...
		 *     };
		 *   };
		 *
		 *   __webpack_require__.i.push(function(options) {
		 *     options.module.hot = createModuleHotObject(options.id, options.module);
		 *   });
		 * })();
		 */
	}
}

module.exports = HotModuleReplacementRuntimeModule;
