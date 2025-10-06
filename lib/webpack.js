/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

/**
 * webpack.js - webpack 核心导出文件
 *
 * 【文件作用】
 * 这是 webpack 的核心工厂函数文件，负责：
 * 1. 创建 Compiler 或 MultiCompiler 实例
 * 2. 应用配置和插件
 * 3. 提供同步和异步两种调用方式
 *
 * 【实现原理】
 * - 使用工厂模式创建编译器实例
 * - 通过函数重载支持单配置和多配置
 * - 集成了配置验证、规范化、默认值应用等流程
 *
 * 【关键流程】
 * 1. 验证配置 (schema validation)
 * 2. 规范化配置 (normalization)
 * 3. 应用默认值 (defaults)
 * 4. 创建 Compiler 实例
 * 5. 注册插件 (plugins)
 * 6. 初始化内置插件 (WebpackOptionsApply)
 * 7. 触发钩子并返回 compiler
 */

"use strict";

const util = require("util");
// 预编译的 schema 检查函数（性能优化）
const webpackOptionsSchemaCheck = require("../schemas/WebpackOptions.check.js");
// 完整的 schema 定义（用于详细错误信息）
const webpackOptionsSchema = require("../schemas/WebpackOptions.json");
// 编译器主类 - 控制整个编译流程
const Compiler = require("./Compiler");
// 多编译器 - 用于多配置并行编译
const MultiCompiler = require("./MultiCompiler");
// 配置应用器 - 将配置转换为插件
const WebpackOptionsApply = require("./WebpackOptionsApply");
// 配置默认值处理
const {
	applyWebpackOptionsDefaults,
	applyWebpackOptionsBaseDefaults
} = require("./config/defaults");
// 配置规范化处理
const { getNormalizedWebpackOptions } = require("./config/normalization");
// Node.js 环境插件 - 提供文件系统等能力
const NodeEnvironmentPlugin = require("./node/NodeEnvironmentPlugin");
// 记忆化函数 - 缓存函数执行结果
const memoize = require("./util/memoize");

/** @typedef {import("../declarations/WebpackOptions").WebpackOptions} WebpackOptions */
/** @typedef {import("./Compiler").WatchOptions} WatchOptions */
/** @typedef {import("./MultiCompiler").MultiCompilerOptions} MultiCompilerOptions */
/** @typedef {import("./MultiStats")} MultiStats */
/** @typedef {import("./Stats")} Stats */

// 懒加载 schema 验证函数（仅在需要详细错误信息时加载）
const getValidateSchema = memoize(() => require("./validateSchema"));

/**
 * @template T
 * @callback Callback
 * @param {Error=} err
 * @param {T=} stats
 * @returns {void}
 */

/**
 * 创建多编译器实例
 *
 * 【使用场景】
 * 当 webpack 配置是一个数组时（多配置），创建 MultiCompiler 来：
 * - 并行或串行编译多个配置
 * - 管理多个 Compiler 实例
 * - 处理配置间的依赖关系
 *
 * 【实现细节】
 * 1. 为每个配置创建独立的 Compiler 实例
 * 2. 将所有 Compiler 包装到 MultiCompiler 中
 * 3. 设置编译器之间的依赖关系（如果存在）
 *
 * @param {ReadonlyArray<WebpackOptions>} childOptions - 配置数组
 * @param {MultiCompilerOptions} options - 多编译器选项
 * @returns {MultiCompiler} 多编译器实例
 */
const createMultiCompiler = (childOptions, options) => {
	// 为每个配置创建独立的 Compiler
	const compilers = childOptions.map(options => createCompiler(options));

	// 创建 MultiCompiler 包装所有编译器
	const compiler = new MultiCompiler(compilers, options);

	// 设置编译器之间的依赖关系
	// 例如：DLL 配置需要在主配置之前编译完成
	for (const childCompiler of compilers) {
		if (childCompiler.options.dependencies) {
			compiler.setDependencies(
				childCompiler,
				childCompiler.options.dependencies
			);
		}
	}
	return compiler;
};

/**
 * 创建单个编译器实例（核心函数）⭐⭐⭐
 *
 * 【这是 webpack 最核心的初始化流程！】
 *
 * 【执行步骤】（严格按照顺序执行）
 * 1. 规范化配置 - 统一配置格式
 * 2. 应用基础默认值 - 设置 context 等基础配置
 * 3. 创建 Compiler 实例 - webpack 的核心控制器
 * 4. 应用 Node 环境插件 - 注入文件系统能力
 * 5. 注册用户插件 - 执行配置中的 plugins
 * 6. 应用完整默认值 - 补充其他配置项的默认值
 * 7. 触发环境钩子 - environment & afterEnvironment
 * 8. 应用内置插件 - 根据配置注册 webpack 内置插件
 * 9. 触发初始化钩子 - initialize
 *
 * 【关键知识点】
 * - 插件注册时机：用户插件在应用完整默认值之前注册
 * - 钩子触发顺序：environment -> afterEnvironment -> initialize
 * - 配置处理分两阶段：基础默认值 -> 用户插件 -> 完整默认值
 *
 * @param {WebpackOptions} rawOptions - 原始配置对象
 * @returns {Compiler} 编译器实例
 */
const createCompiler = rawOptions => {
	// 步骤1: 规范化配置（统一数组、对象等格式）
	const options = getNormalizedWebpackOptions(rawOptions);

	// 步骤2: 应用基础默认值（context、target 等）
	applyWebpackOptionsBaseDefaults(options);

	// 步骤3: 创建 Compiler 实例（webpack 的大脑）
	const compiler = new Compiler(
		/** @type {string} */ (options.context), // 工作目录
		options // 完整配置
	);

	// 步骤4: 应用 Node.js 环境插件
	// 为 compiler 注入文件系统能力（inputFileSystem、outputFileSystem）
	new NodeEnvironmentPlugin({
		infrastructureLogging: options.infrastructureLogging
	}).apply(compiler);

	// 步骤5: 注册用户配置的插件
	if (Array.isArray(options.plugins)) {
		for (const plugin of options.plugins) {
			if (typeof plugin === "function") {
				// 支持函数形式的插件
				plugin.call(compiler, compiler);
			} else if (plugin) {
				// 标准插件：调用 apply 方法
				plugin.apply(compiler);
			}
		}
	}

	// 步骤6: 应用完整的默认配置
	// 这一步会根据已有配置推断其他配置项
	applyWebpackOptionsDefaults(options);

	// 步骤7: 触发环境相关钩子
	compiler.hooks.environment.call();
	compiler.hooks.afterEnvironment.call();

	// 步骤8: 根据配置应用内置插件（这是重点！）
	// WebpackOptionsApply 会根据配置项注册大量内置插件
	// 例如：EntryPlugin、RuntimePlugin、ResolverPlugin 等
	new WebpackOptionsApply().process(options, compiler);

	// 步骤9: 触发初始化完成钩子
	compiler.hooks.initialize.call();

	// 返回配置完成的 Compiler 实例
	return compiler;
};

/**
 * @callback WebpackFunctionSingle
 * @param {WebpackOptions} options options object
 * @param {Callback<Stats>=} callback callback
 * @returns {Compiler} the compiler object
 */

/**
 * @callback WebpackFunctionMulti
 * @param {ReadonlyArray<WebpackOptions> & MultiCompilerOptions} options options objects
 * @param {Callback<MultiStats>=} callback callback
 * @returns {MultiCompiler} the multi compiler object
 */

/**
 * 工具函数：确保返回数组
 * @template T
 * @param {Array<T> | T} options - 配置（可能是单个或数组）
 * @returns {Array<T>} 配置数组
 */
const asArray = options =>
	Array.isArray(options) ? Array.from(options) : [options];

/**
 * webpack 主函数（对外导出的核心 API）⭐⭐⭐
 *
 * 【使用方式】
 * 方式1: webpack(options) - 同步调用，返回 compiler
 * 方式2: webpack(options, callback) - 异步调用，自动执行编译
 *
 * 【支持两种配置】
 * 1. 单配置：返回 Compiler
 * 2. 多配置（数组）：返回 MultiCompiler
 *
 * 【关键设计】
 * - 配置验证：先用预编译 schema 快速检查，失败再用完整 schema
 * - 错误处理：使用 process.nextTick 确保异步错误正确传递
 * - 资源清理：非 watch 模式下自动调用 compiler.close()
 *
 * 【执行流程】
 * 1. 验证配置 schema
 * 2. 创建 compiler（单个或多个）
 * 3. 如果有 callback：
 *    - watch 模式：调用 compiler.watch()
 *    - 普通模式：调用 compiler.run() 并自动 close
 * 4. 如果无 callback：直接返回 compiler
 */
const webpack = /** @type {WebpackFunctionSingle & WebpackFunctionMulti} */ (
	/**
	 * @param {WebpackOptions | (ReadonlyArray<WebpackOptions> & MultiCompilerOptions)} options - webpack 配置
	 * @param {Callback<Stats> & Callback<MultiStats>=} callback - 可选的回调函数
	 * @returns {Compiler | MultiCompiler} 编译器实例
	 */
	(options, callback) => {
		// 创建 compiler 的内部函数
		const create = () => {
			// 配置验证：两阶段验证策略
			// 1. 先用预编译的快速检查（性能优化）
			if (!asArray(options).every(webpackOptionsSchemaCheck)) {
				// 2. 快速检查失败，使用完整 schema 给出详细错误
				getValidateSchema()(webpackOptionsSchema, options);
				// 如果走到这里说明预编译 schema 有 bug
				util.deprecate(
					() => {},
					"webpack bug: Pre-compiled schema reports error while real schema is happy. This has performance drawbacks.",
					"DEP_WEBPACK_PRE_COMPILED_SCHEMA_INVALID"
				)();
			}

			/** @type {MultiCompiler|Compiler} */
			let compiler;
			/** @type {boolean | undefined} */
			let watch = false;
			/** @type {WatchOptions|WatchOptions[]} */
			let watchOptions;

			// 判断是单配置还是多配置
			if (Array.isArray(options)) {
				// 多配置：创建 MultiCompiler
				/** @type {MultiCompiler} */
				compiler = createMultiCompiler(
					options,
					/** @type {MultiCompilerOptions} */ (options)
				);
				// 只要有一个配置启用 watch，就开启 watch 模式
				watch = options.some(options => options.watch);
				watchOptions = options.map(options => options.watchOptions || {});
			} else {
				// 单配置：创建 Compiler
				const webpackOptions = /** @type {WebpackOptions} */ (options);
				/** @type {Compiler} */
				compiler = createCompiler(webpackOptions);
				watch = webpackOptions.watch;
				watchOptions = webpackOptions.watchOptions || {};
			}

			return { compiler, watch, watchOptions };
		};

		// 分支1: 提供了 callback，自动执行编译
		if (callback) {
			try {
				const { compiler, watch, watchOptions } = create();

				if (watch) {
					// watch 模式：持续监听文件变化
					compiler.watch(watchOptions, callback);
				} else {
					// 普通模式：单次编译
					compiler.run((err, stats) => {
						// 重要：编译完成后关闭 compiler，释放资源
						compiler.close(err2 => {
							// 合并两个错误（如果存在）
							callback(err || err2, stats);
						});
					});
				}
				return compiler;
			} catch (err) {
				// 错误处理：使用 nextTick 确保异步传递错误
				// 这样调用者可以在同一个 tick 中完成同步设置
				process.nextTick(() => callback(err));
				return null;
			}
		} else {
			// 分支2: 没有 callback，返回 compiler 让用户手动控制
			const { compiler, watch } = create();

			// 警告：watch 模式必须提供 callback
			if (watch) {
				util.deprecate(
					() => {},
					"A 'callback' argument needs to be provided to the 'webpack(options, callback)' function when the 'watch' option is set. There is no way to handle the 'watch' option without a callback.",
					"DEP_WEBPACK_WATCH_WITHOUT_CALLBACK"
				)();
			}

			return compiler;
		}
	}
);

// 导出 webpack 主函数
module.exports = webpack;
