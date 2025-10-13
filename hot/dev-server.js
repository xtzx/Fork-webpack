/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

/**
 * hot/dev-server.js - HMR 开发服务器客户端 ⭐⭐⭐
 *
 * 【文件作用】
 * 这是 webpack HMR（Hot Module Replacement）的客户端核心代码
 * 负责：
 * 1. 通过 WebSocket 连接到 webpack-dev-server
 * 2. 接收服务器推送的更新通知
 * 3. 触发模块的热更新流程
 * 4. 更新失败时进行全页刷新
 *
 * 【工作流程】
 * 1. 启动时等待 WDS（webpack-dev-server）的更新信号
 * 2. 接收到 webpackHotUpdate 事件（带新的 hash）
 * 3. 对比 hash，如果不同且当前空闲，触发更新检查
 * 4. 调用 module.hot.check() 下载并应用更新
 * 5. 成功：模块更新，状态保留
 * 6. 失败：全页刷新（window.location.reload）
 *
 * 【关键概念】
 * - __webpack_hash__: webpack 编译生成的当前 bundle 的 hash
 * - lastHash: 服务器推送的最新 hash
 * - upToDate: 检查当前 bundle 是否是最新版本
 * - check(): 检查并应用更新的核心函数
 *
 * 【与其他文件的关系】
 * - 接收 emitter.js 发出的 webpackHotUpdate 事件
 * - 调用 HotModuleReplacement.runtime.js 提供的 module.hot.check()
 * - 使用 log.js 输出日志信息
 */

/* globals __webpack_hash__ */

// ===== 检查 HMR 是否启用 =====
if (module.hot) {
	// module.hot 由 HotModuleReplacementPlugin 注入
	// 如果存在，说明 HMR 已启用

	// ===== 状态变量 =====

	/** @type {undefined|string} */
	var lastHash; // 上次从服务器接收到的 hash

	/**
	 * 检查当前应用是否是最新版本
	 *
	 * 【原理】
	 * - __webpack_hash__: 当前运行的 bundle 的 hash
	 * - lastHash: 服务器推送的最新 hash
	 * - 如果 lastHash 包含 __webpack_hash__，说明已是最新
	 *
	 * 【返回】
	 * true: 应用已是最新版本
	 * false: 有新版本可用
	 */
	var upToDate = function upToDate() {
		return /** @type {string} */ (lastHash).indexOf(__webpack_hash__) >= 0;
	};

	var log = require("./log"); // 日志工具

	// ===== check: 检查并应用更新 ⭐⭐⭐ =====
	/**
	 * 核心函数：检查服务器的更新并应用
	 *
	 * 【流程】
	 * 1. 调用 module.hot.check(true) 检查更新
	 *    - true: 自动应用更新（autoApply）
	 * 2. 下载更新清单（hot-update.json）
	 * 3. 下载更新模块（hot-update.js）
	 * 4. 应用更新（dispose → 删除旧模块 → 添加新模块 → accept）
	 * 5. 成功：输出更新日志
	 * 6. 失败：全页刷新
	 */
	var check = function check() {
		// ⭐⭐⭐ 调用 module.hot.check
		// 这是 HMR Runtime 提供的核心 API
		// 参数 true 表示自动应用更新
		module.hot
			.check(true)
			.then(function (updatedModules) {
				// ===== 情况1: 无法找到更新 =====
				if (!updatedModules) {
					// updatedModules 为 null/undefined 表示没有找到更新
					// 原因可能是：
					// 1. webpack-dev-server 重启了
					// 2. 网络问题，无法下载更新清单
					// 3. 更新清单为空

					log(
						"warning",
						"[HMR] Cannot find update. " +
							(typeof window !== "undefined"
								? "Need to do a full reload!" // 浏览器环境
								: "Please reload manually!") // Node.js 环境
					);
					log(
						"warning",
						"[HMR] (Probably because of restarting the webpack-dev-server)"
					);

					// 浏览器环境：执行全页刷新
					if (typeof window !== "undefined") {
						window.location.reload();
					}
					return;
				}

				// ===== 情况2: 成功应用更新 =====
				// updatedModules 是更新的模块 ID 数组
				// 例如: ['./src/App.js', './src/Component.js']

				// 检查是否还有更新（可能服务器在此期间又推送了新的更新）
				if (!upToDate()) {
					check(); // ⭐ 递归调用，继续检查
				}

				// 输出更新结果日志
				// log-apply-result 会详细列出哪些模块被更新了
				require("./log-apply-result")(updatedModules, updatedModules);

				// 确认应用已是最新
				if (upToDate()) {
					log("info", "[HMR] App is up to date.");
				}
			})
			.catch(function (err) {
				// ===== 情况3: 更新失败 =====
				// 原因可能是：
				// 1. 模块没有 accept
				// 2. Accept 回调抛出错误
				// 3. 网络错误

				var status = module.hot.status();
				// status 可能的值:
				// - idle: 空闲
				// - check: 检查中
				// - prepare: 准备更新
				// - dispose: 清理旧模块
				// - apply: 应用更新
				// - abort: 更新中止 ⭐
				// - fail: 更新失败 ⭐

				if (["abort", "fail"].indexOf(status) >= 0) {
					// 严重错误：更新已中止或失败
					// 无法安全地继续，必须全页刷新

					log(
						"warning",
						"[HMR] Cannot apply update. " +
							(typeof window !== "undefined"
								? "Need to do a full reload!"
								: "Please reload manually!")
					);
					log("warning", "[HMR] " + log.formatError(err));

					// 执行全页刷新
					if (typeof window !== "undefined") {
						window.location.reload();
					}
				} else {
					// 其他错误：可能是临时性的
					// 只输出警告，不刷新页面
					log("warning", "[HMR] Update failed: " + log.formatError(err));
				}
			});
	};

	// ===== 事件监听：接收服务器的更新通知 ⭐⭐⭐ =====

	var hotEmitter = require("./emitter"); // 事件发射器

	/**
	 * 监听 webpackHotUpdate 事件
	 *
	 * 【触发时机】
	 * webpack-dev-server 通过 WebSocket 推送更新通知时
	 * WebSocket 客户端代码会触发此事件
	 *
	 * 【事件数据】
	 * currentHash: 服务器最新的编译 hash
	 *
	 * 【工作流程】
	 * 1. 保存新的 hash 到 lastHash
	 * 2. 检查是否需要更新（!upToDate）
	 * 3. 检查当前状态是否空闲（status === 'idle'）
	 * 4. 满足条件则触发 check()
	 */
	hotEmitter.on("webpackHotUpdate", function (currentHash) {
		// 保存服务器推送的最新 hash
		lastHash = currentHash;

		// 检查是否需要更新
		// 条件1: 当前不是最新版本（!upToDate）
		// 条件2: HMR 状态是空闲（status === 'idle'）
		//
		// 为什么要检查 idle？
		// - 如果正在更新中（check、prepare、apply），不能再次触发更新
		// - 避免并发更新导致状态混乱
		if (!upToDate() && module.hot.status() === "idle") {
			log("info", "[HMR] Checking for updates on the server...");
			check(); // ⭐ 触发更新检查
		}
	});

	// ===== 初始化日志 =====
	// 输出启动信息，表示 HMR 客户端已就绪
	log("info", "[HMR] Waiting for update signal from WDS...");

	/**
	 * 【完整流程示例】
	 *
	 * 1. 开发者修改 src/App.js
	 *    ↓
	 * 2. webpack-dev-server 重新编译
	 *    ↓
	 * 3. 编译完成，生成新的 hash: 'abc123'
	 *    ↓
	 * 4. WDS 通过 WebSocket 推送消息
	 *    { type: 'hash', data: 'abc123' }
	 *    { type: 'ok' }
	 *    ↓
	 * 5. WebSocket 客户端接收消息
	 *    触发 hotEmitter.emit('webpackHotUpdate', 'abc123')
	 *    ↓
	 * 6. 本文件的监听器被调用
	 *    lastHash = 'abc123'
	 *    !upToDate() → true (hash 不同)
	 *    status === 'idle' → true (当前空闲)
	 *    ↓
	 * 7. 调用 check()
	 *    ↓
	 * 8. module.hot.check(true)
	 *    → 下载 abc123.hot-update.json
	 *    → 下载 main.abc123.hot-update.js
	 *    → 应用更新
	 *    ↓
	 * 9. 更新成功
	 *    updatedModules = ['./src/App.js']
	 *    输出日志: "[HMR] Updated modules: ./src/App.js"
	 *    ↓
	 * 10. UI 重新渲染，状态保留 ✅
	 */
} else {
	// HMR 未启用
	// 原因可能是：
	// 1. 没有使用 HotModuleReplacementPlugin
	// 2. 生产环境构建
	// 3. 配置错误
	throw new Error("[HMR] Hot Module Replacement is disabled.");
}
