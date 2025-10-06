/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

/**
 * lib/ModuleGraph.js - 模块依赖图（webpack 最核心的数据结构！）⭐⭐⭐
 *
 * 【文件作用】
 * ModuleGraph 是 webpack 编译过程中最重要的数据结构，它记录了：
 * 1. 所有模块之间的依赖关系
 * 2. 每个模块的导入导出信息
 * 3. 模块之间的连接状态
 * 4. 模块的构建顺序和深度
 *
 * 【为什么需要 ModuleGraph】
 *
 * 问题：
 * - 如何知道一个模块被哪些模块依赖？（Tree Shaking）
 * - 如何判断一个导出是否被使用？（Dead Code Elimination）
 * - 如何处理循环依赖？
 * - 如何优化模块合并和代码分割？
 *
 * 答案：ModuleGraph！它提供了高效的图查询能力。
 *
 * 【核心数据结构】
 *
 * ```
 * ModuleGraph {
 *   _dependencyMap: WeakMap<Dependency, ModuleGraphConnection>
 *     └─ 依赖 -> 连接的映射
 *
 *   _moduleMap: Map<Module, ModuleGraphModule>
 *     └─ 模块 -> 图节点的映射
 * }
 *
 * ModuleGraphModule {  // 图中的模块节点
 *   incomingConnections: Set<Connection>  // 入边（谁依赖我）
 *   outgoingConnections: Set<Connection>  // 出边（我依赖谁）
 *   exports: ExportsInfo                  // 导出信息
 *   issuer: Module                        // 引入者
 *   depth: number                         // 深度（用于排序）
 * }
 *
 * ModuleGraphConnection {  // 连接边
 *   originModule: Module      // 源模块
 *   dependency: Dependency    // 依赖对象
 *   module: Module           // 目标模块
 *   active: boolean          // 是否激活
 * }
 * ```
 *
 * 【图的构建过程】
 *
 * 1. 构建模块时创建依赖对象
 *    module.build() -> parser.parse() -> new HarmonyImportDependency()
 *
 * 2. 解析依赖获取目标模块
 *    factorizeModule(dependency) -> targetModule
 *
 * 3. 建立图连接（核心！）
 *    moduleGraph.setResolvedModule(originModule, dependency, targetModule)
 *    -> 创建 ModuleGraphConnection
 *    -> 添加到 originModule.outgoingConnections
 *    -> 添加到 targetModule.incomingConnections
 *
 * 4. 记录导出信息
 *    moduleGraph.setExportsInfo(module, exportsInfo)
 *
 * 【应用场景】
 *
 * 1. Tree Shaking:
 *    - 查询哪些导出被使用：exportsInfo.getUsed()
 *    - 删除未使用的导出和代码
 *
 * 2. 代码分割:
 *    - 分析模块共享情况：getIncomingConnections()
 *    - 决定哪些模块放到公共 chunk
 *
 * 3. 模块合并 (Scope Hoisting):
 *    - 分析依赖关系：getOutgoingConnections()
 *    - 决定哪些模块可以合并
 *
 * 4. 循环依赖检测:
 *    - 遍历图检测环：DFS + visited set
 *
 * 【性能优化】
 *
 * 1. WeakMap 存储依赖映射：
 *    - 不阻止 Dependency 被 GC
 *    - 快速查找 O(1)
 *
 * 2. SortableSet 存储连接：
 *    - 保持顺序
 *    - 支持高效遍历
 *
 * 3. 懒创建 ModuleGraphModule：
 *    - 只在需要时创建
 *    - 减少内存占用
 */

"use strict";

const util = require("util");
const ExportsInfo = require("./ExportsInfo");
const ModuleGraphConnection = require("./ModuleGraphConnection");
const SortableSet = require("./util/SortableSet");
const WeakTupleMap = require("./util/WeakTupleMap");

/** @typedef {import("./DependenciesBlock")} DependenciesBlock */
/** @typedef {import("./Dependency")} Dependency */
/** @typedef {import("./ExportsInfo").ExportInfo} ExportInfo */
/** @typedef {import("./Module")} Module */
/** @typedef {import("./ModuleProfile")} ModuleProfile */
/** @typedef {import("./RequestShortener")} RequestShortener */
/** @typedef {import("./util/runtime").RuntimeSpec} RuntimeSpec */

/**
 * @callback OptimizationBailoutFunction
 * @param {RequestShortener} requestShortener
 * @returns {string}
 */

// 空集合常量（避免重复创建）
const EMPTY_SET = new Set();

/**
 * 按源模块分组连接（性能优化的辅助函数）
 *
 * 【优化技巧】
 * 利用连接集合已经按 originModule 排序的特性：
 * - 记住上一个处理的模块
 * - 如果当前连接的源模块相同，直接添加
 * - 避免重复的 Map 查找
 *
 * @param {SortableSet<ModuleGraphConnection>} set - 连接集合
 * @returns {readonly Map<Module | undefined, readonly ModuleGraphConnection[]>} 按源模块分组
 */
const getConnectionsByOriginModule = set => {
	const map = new Map();

	// 性能优化：缓存上一个模块，避免重复查找
	/** @type {Module | 0} */
	let lastModule = 0;
	/** @type {ModuleGraphConnection[] | undefined} */
	let lastList = undefined;

	for (const connection of set) {
		const { originModule } = connection;

		if (lastModule === originModule) {
			// 与上一个相同，直接添加到缓存的列表
			/** @type {ModuleGraphConnection[]} */
			(lastList).push(connection);
		} else {
			// 不同的模块，更新缓存
			lastModule = /** @type {Module} */ (originModule);
			const list = map.get(originModule);

			if (list !== undefined) {
				// 该模块已有列表，添加到现有列表
				lastList = list;
				list.push(connection);
			} else {
				// 新模块，创建新列表
				const list = [connection];
				lastList = list;
				map.set(originModule, list);
			}
		}
	}

	return map;
};

/**
 * @param {SortableSet<ModuleGraphConnection>} set input
 * @returns {readonly Map<Module | undefined, readonly ModuleGraphConnection[]>} mapped by module
 */
const getConnectionsByModule = set => {
	const map = new Map();
	/** @type {Module | 0} */
	let lastModule = 0;
	/** @type {ModuleGraphConnection[] | undefined} */
	let lastList = undefined;
	for (const connection of set) {
		const { module } = connection;
		if (lastModule === module) {
			/** @type {ModuleGraphConnection[]} */
			(lastList).push(connection);
		} else {
			lastModule = module;
			const list = map.get(module);
			if (list !== undefined) {
				lastList = list;
				list.push(connection);
			} else {
				const list = [connection];
				lastList = list;
				map.set(module, list);
			}
		}
	}
	return map;
};

/**
 * ModuleGraphModule - 模块在依赖图中的节点
 *
 * 【职责】
 * 存储模块在依赖图中的所有信息：
 * 1. 连接信息：入边、出边
 * 2. 导出信息：模块导出了什么
 * 3. 构建信息：深度、顺序、性能
 * 4. 优化信息：是否异步、优化失败原因
 *
 * 【为什么分离】
 * Module 类：模块本身的信息（代码、依赖、构建状态）
 * ModuleGraphModule：模块在图中的关系信息
 *
 * 这样分离的好处：
 * - 同一个 Module 可以在多个 Compilation 中有不同的图信息
 * - 便于序列化和缓存
 * - 职责清晰
 */
class ModuleGraphModule {
	constructor() {
		// ===== 连接信息 =====

		/**
		 * 入边：谁依赖我（incoming connections）
		 *
		 * 【用途】
		 * - Tree Shaking: 如果没有入边，模块未被使用，可以删除
		 * - 代码分割: 被多个模块依赖的模块可以提取到公共 chunk
		 *
		 * @type {SortableSet<ModuleGraphConnection>}
		 */
		this.incomingConnections = new SortableSet();

		/**
		 * 出边：我依赖谁（outgoing connections）
		 *
		 * 【懒创建】
		 * 初始值为 undefined，首次使用时才创建
		 * 原因：不是所有模块都有出边（如 CSS 文件）
		 *
		 * @type {SortableSet<ModuleGraphConnection> | undefined}
		 */
		this.outgoingConnections = undefined;

		// ===== 引入者信息 =====

		/**
		 * 引入者：谁第一次引入了这个模块
		 *
		 * 【用途】
		 * - 错误报告：显示模块引入路径
		 * - 构建顺序：决定模块构建的优先级
		 *
		 * @type {Module | null}
		 */
		this.issuer = undefined;

		// ===== 优化信息 =====

		/**
		 * 优化失败原因列表
		 *
		 * 【用途】
		 * 记录为什么某些优化无法应用到此模块
		 * 例如：无法合并模块的原因
		 *
		 * @type {(string | OptimizationBailoutFunction)[]}
		 */
		this.optimizationBailout = [];

		// ===== 导出信息 =====

		/**
		 * 导出信息对象
		 *
		 * 【核心作用】⭐
		 * 记录模块的所有导出：
		 * - 导出了哪些名称
		 * - 哪些导出被使用（Tree Shaking）
		 * - 导出是否可以被重命名（压缩优化）
		 *
		 * @type {ExportsInfo}
		 */
		this.exports = new ExportsInfo();

		// ===== 遍历顺序（用于拓扑排序）=====

		/**
		 * 前序遍历索引
		 * DFS 访问顺序（第一次访问时的序号）
		 * @type {number | null}
		 */
		this.preOrderIndex = null;

		/**
		 * 后序遍历索引
		 * DFS 完成顺序（离开节点时的序号）
		 * @type {number | null}
		 */
		this.postOrderIndex = null;

		/**
		 * 模块深度
		 * 从入口模块到此模块的最短路径长度
		 *
		 * 【用途】
		 * - 决定模块加载顺序
		 * - 优化 chunk 分割
		 *
		 * @type {number | null}
		 */
		this.depth = null;

		// ===== 性能分析 =====

		/**
		 * 模块构建性能分析数据
		 * 记录构建耗时、loader 耗时等
		 * @type {ModuleProfile | undefined | null}
		 */
		this.profile = undefined;

		// ===== 异步模块标记 =====

		/**
		 * 是否是异步模块
		 *
		 * 【判断依据】
		 * - 使用 import() 动态导入
		 * - 使用 async/await 导入
		 *
		 * @type {boolean}
		 */
		this.async = false;

		// ===== 内部状态 =====

		/**
		 * 未分配的连接（内部使用）
		 * 用于处理构建过程中暂时无法确定目标模块的依赖
		 * @type {ModuleGraphConnection[]}
		 */
		this._unassignedConnections = undefined;
	}
}

/**
 * ModuleGraph - 模块依赖图主类（最核心！）⭐⭐⭐
 *
 * 【核心职责】
 * 1. 管理模块之间的依赖关系
 * 2. 提供高效的图查询接口
 * 3. 支持 Tree Shaking 和代码优化
 * 4. 处理模块的导入导出信息
 *
 * 【数据结构设计】
 *
 * 两个核心 Map：
 * 1. _dependencyMap: Dependency -> Connection
 *    - 快速查找依赖对应的连接
 *    - 使用 WeakMap 允许 GC
 *
 * 2. _moduleMap: Module -> ModuleGraphModule
 *    - 快速查找模块的图信息
 *    - 存储入边、出边、导出等信息
 *
 * 【使用示例】
 * ```javascript
 * // 建立连接
 * moduleGraph.setResolvedModule(originModule, dependency, targetModule);
 *
 * // 查询关系
 * const targetModule = moduleGraph.getModule(dependency);
 * const connections = moduleGraph.getOutgoingConnections(module);
 *
 * // 导出信息
 * const exportsInfo = moduleGraph.getExportsInfo(module);
 * const isUsed = exportsInfo.isExportUsed('foo');
 * ```
 */
class ModuleGraph {
	constructor() {
		// ===== 核心数据存储 =====

		/**
		 * 依赖映射：Dependency -> ModuleGraphConnection
		 *
		 * 【为什么用 WeakMap】⭐
		 * - 不阻止 Dependency 被 GC
		 * - 查找速度 O(1)
		 * - 自动清理无用映射
		 *
		 * 【存储内容】
		 * - null: 依赖未解析（找不到目标模块）
		 * - Connection: 依赖已解析的连接对象
		 *
		 * @type {WeakMap<Dependency, ModuleGraphConnection | null>}
		 */
		this._dependencyMap = new WeakMap();

		/**
		 * 模块映射：Module -> ModuleGraphModule
		 *
		 * 【存储内容】
		 * 模块在图中的所有信息：
		 * - 入边、出边
		 * - 导出信息
		 * - 构建顺序
		 * - 性能数据
		 *
		 * 【懒创建】
		 * ModuleGraphModule 在首次访问时才创建
		 *
		 * @type {Map<Module, ModuleGraphModule>}
		 */
		this._moduleMap = new Map();

		/**
		 * 元数据映射（用于存储任意附加数据）
		 *
		 * 【用途】
		 * 插件可以在这里存储自定义数据
		 *
		 * @type {WeakMap<any, Object>}
		 */
		this._metaMap = new WeakMap();

		// ===== 缓存系统 =====

		/**
		 * 全局缓存（用于优化重复计算）
		 *
		 * 【使用场景】
		 * - 缓存导出使用情况的计算结果
		 * - 缓存连接激活状态的判断
		 *
		 * @type {WeakTupleMap<any[], any> | undefined}
		 */
		this._cache = undefined;

		/**
		 * 每个模块的内存缓存
		 *
		 * 【用途】
		 * 为每个模块提供独立的缓存空间
		 *
		 * @type {Map<Module, WeakTupleMap<any, any>>}
		 */
		this._moduleMemCaches = undefined;

		/**
		 * 缓存阶段标识
		 * 用于区分不同编译阶段的缓存
		 * @type {string | undefined}
		 */
		this._cacheStage = undefined;
	}

	/**
	 * 获取或创建模块的图节点（内部方法）
	 *
	 * 【懒创建模式】⭐
	 * - 只在需要时创建 ModuleGraphModule
	 * - 减少内存占用
	 * - 提高性能
	 *
	 * 【调用时机】
	 * 任何需要访问模块图信息的地方：
	 * - 添加连接
	 * - 查询导出
	 * - 设置深度
	 *
	 * @param {Module} module - 模块对象
	 * @returns {ModuleGraphModule} 模块的图节点
	 */
	_getModuleGraphModule(module) {
		// 尝试从缓存获取
		let mgm = this._moduleMap.get(module);

		if (mgm === undefined) {
			// 首次访问，创建新节点
			mgm = new ModuleGraphModule();
			this._moduleMap.set(module, mgm);
		}

		return mgm;
	}

	/**
	 * @param {Dependency} dependency the dependency
	 * @param {DependenciesBlock} block parent block
	 * @param {Module} module parent module
	 * @param {number=} indexInBlock position in block
	 * @returns {void}
	 */
	setParents(dependency, block, module, indexInBlock = -1) {
		dependency._parentDependenciesBlockIndex = indexInBlock;
		dependency._parentDependenciesBlock = block;
		dependency._parentModule = module;
	}

	/**
	 * @param {Dependency} dependency the dependency
	 * @returns {Module} parent module
	 */
	getParentModule(dependency) {
		return dependency._parentModule;
	}

	/**
	 * @param {Dependency} dependency the dependency
	 * @returns {DependenciesBlock} parent block
	 */
	getParentBlock(dependency) {
		return dependency._parentDependenciesBlock;
	}

	/**
	 * @param {Dependency} dependency the dependency
	 * @returns {number} index
	 */
	getParentBlockIndex(dependency) {
		return dependency._parentDependenciesBlockIndex;
	}

	/**
	 * 建立模块连接（依赖图构建的核心方法！）⭐⭐⭐
	 *
	 * 【作用】
	 * 这是构建依赖图最关键的方法！
	 * 当解析出依赖的目标模块后，调用此方法建立连接。
	 *
	 * 【调用时机】
	 * ```javascript
	 * // 1. 构建模块，解析依赖
	 * module.build() -> parser.parse(source)
	 *
	 * // 2. 遇到 import/require，创建依赖对象
	 * const dependency = new HarmonyImportDependency('./a.js')
	 *
	 * // 3. 解析依赖，获取目标模块
	 * factorizeModule(dependency) -> targetModule
	 *
	 * // 4. 建立连接（就是这个方法！）
	 * moduleGraph.setResolvedModule(originModule, dependency, targetModule)
	 * ```
	 *
	 * 【执行流程】
	 * 1. 创建 ModuleGraphConnection 对象（连接边）
	 * 2. 添加到目标模块的入边集合（谁依赖我）
	 * 3. 添加到源模块的出边集合（我依赖谁）
	 * 4. 记录依赖到连接的映射
	 *
	 * 【数据结构变化】
	 * ```
	 * 调用前：
	 * originModule {
	 *   outgoingConnections: []
	 * }
	 * targetModule {
	 *   incomingConnections: []
	 * }
	 *
	 * 调用后：
	 * originModule {
	 *   outgoingConnections: [connection]  // 添加出边
	 * }
	 * targetModule {
	 *   incomingConnections: [connection]  // 添加入边
	 * }
	 * dependency -> connection  // 映射关系
	 * ```
	 *
	 * @param {Module} originModule - 源模块（引用者）
	 * @param {Dependency} dependency - 依赖对象
	 * @param {Module} module - 目标模块（被引用者）
	 * @returns {void}
	 */
	setResolvedModule(originModule, dependency, module) {
		// 步骤1: 创建连接对象（图的边）
		const connection = new ModuleGraphConnection(
			originModule,          // 源模块
			dependency,            // 依赖对象
			module,               // 目标模块
			undefined,            // resolvedOriginModule（通常为 undefined）
			dependency.weak,      // 是否是弱依赖
			dependency.getCondition(this)  // 激活条件
		);

		// 步骤2: 添加到目标模块的入边集合
		// 这样目标模块就知道谁依赖了它
		const connections = this._getModuleGraphModule(module).incomingConnections;
		connections.add(connection);

		if (originModule) {
			// 步骤3: 添加到源模块的出边集合
			const mgm = this._getModuleGraphModule(originModule);

			// 添加到未分配连接列表（用于后续处理）
			if (mgm._unassignedConnections === undefined) {
				mgm._unassignedConnections = [];
			}
			mgm._unassignedConnections.push(connection);

			// 懒创建出边集合
			if (mgm.outgoingConnections === undefined) {
				mgm.outgoingConnections = new SortableSet();
			}
			mgm.outgoingConnections.add(connection);
		} else {
			// 步骤4: 如果没有源模块（入口模块），直接记录映射
			// 入口模块的依赖没有 originModule
			this._dependencyMap.set(dependency, connection);
		}
	}

	/**
	 * 更新依赖的目标模块
	 *
	 * 【使用场景】
	 * 当依赖的目标模块需要替换时（如模块合并、重定向）
	 *
	 * 【执行流程】
	 * 1. 获取旧连接
	 * 2. 克隆连接并更新目标模块
	 * 3. 停用旧连接
	 * 4. 添加新连接到相关模块
	 *
	 * @param {Dependency} dependency - 依赖对象
	 * @param {Module} module - 新的目标模块
	 * @returns {void}
	 */
	updateModule(dependency, module) {
		// 获取当前连接
		const connection =
			/** @type {ModuleGraphConnection} */
			(this.getConnection(dependency));

		// 如果目标模块没变，直接返回
		if (connection.module === module) return;

		// 克隆连接，更新目标模块
		const newConnection = connection.clone();
		newConnection.module = module;

		// 更新依赖映射
		this._dependencyMap.set(dependency, newConnection);

		// 停用旧连接
		connection.setActive(false);

		// 添加新连接到源模块的出边
		const originMgm = this._getModuleGraphModule(connection.originModule);
		originMgm.outgoingConnections.add(newConnection);

		// 添加新连接到目标模块的入边
		const targetMgm = this._getModuleGraphModule(module);
		targetMgm.incomingConnections.add(newConnection);
	}

	/**
	 * 删除依赖连接
	 *
	 * 【使用场景】
	 * - 模块被移除时
	 * - 依赖不再需要时
	 *
	 * 【执行流程】
	 * 1. 获取连接
	 * 2. 从目标模块删除入边
	 * 3. 从源模块删除出边
	 * 4. 将依赖映射设为 null（标记为已删除）
	 *
	 * @param {Dependency} dependency - 依赖对象
	 * @returns {void}
	 */
	removeConnection(dependency) {
		// 获取要删除的连接
		const connection = this.getConnection(dependency);

		// 从目标模块的入边中删除
		const targetMgm = this._getModuleGraphModule(connection.module);
		targetMgm.incomingConnections.delete(connection);

		// 从源模块的出边中删除
		const originMgm = this._getModuleGraphModule(connection.originModule);
		originMgm.outgoingConnections.delete(connection);

		// 标记依赖为已删除（设为 null）
		this._dependencyMap.set(dependency, null);
	}

	/**
	 * 为依赖添加说明信息
	 *
	 * 【使用场景】
	 * 添加人类可读的说明，用于：
	 * - 调试信息
	 * - 错误报告
	 * - 优化提示
	 *
	 * 【示例】
	 * addExplanation(dep, "Requested module is provided by plugin")
	 *
	 * @param {Dependency} dependency - 依赖对象
	 * @param {string} explanation - 说明信息
	 * @returns {void}
	 */
	addExplanation(dependency, explanation) {
		// 获取连接并添加说明
		const connection = this.getConnection(dependency);
		connection.addExplanation(explanation);
	}

	/**
	 * 克隆模块属性（从源模块复制到目标模块）
	 *
	 * 【使用场景】
	 * 当需要用新模块替换旧模块时，保留图信息：
	 * - 模块合并优化
	 * - 模块替换
	 * - 缓存模块复用
	 *
	 * 【复制的属性】
	 * - 遍历顺序索引（preOrderIndex、postOrderIndex）
	 * - 模块深度
	 * - 导出信息
	 * - 异步标记
	 *
	 * 【注意】
	 * 不复制连接信息（incomingConnections、outgoingConnections）
	 * 连接需要单独处理
	 *
	 * @param {Module} sourceModule - 源模块
	 * @param {Module} targetModule - 目标模块
	 * @returns {void}
	 */
	cloneModuleAttributes(sourceModule, targetModule) {
		// 获取源模块和目标模块的图节点
		const oldMgm = this._getModuleGraphModule(sourceModule);
		const newMgm = this._getModuleGraphModule(targetModule);

		// 复制遍历顺序索引
		newMgm.postOrderIndex = oldMgm.postOrderIndex;
		newMgm.preOrderIndex = oldMgm.preOrderIndex;

		// 复制深度信息
		newMgm.depth = oldMgm.depth;

		// 复制导出信息（重要！）
		newMgm.exports = oldMgm.exports;

		// 复制异步标记
		newMgm.async = oldMgm.async;
	}

	/**
	 * 移除模块的图属性
	 *
	 * 【使用场景】
	 * 重置模块的图信息，通常在：
	 * - 重新计算模块顺序前
	 * - 重新计算模块深度前
	 *
	 * 【清除的属性】
	 * - 遍历顺序索引
	 * - 深度
	 * - 异步标记
	 *
	 * 【不清除的属性】
	 * - 连接信息（incomingConnections、outgoingConnections）
	 * - 导出信息（exports）
	 * - 引入者（issuer）
	 *
	 * @param {Module} module - 模块
	 * @returns {void}
	 */
	removeModuleAttributes(module) {
		const mgm = this._getModuleGraphModule(module);

		// 重置遍历索引
		mgm.postOrderIndex = null;
		mgm.preOrderIndex = null;

		// 重置深度
		mgm.depth = null;

		// 重置异步标记
		mgm.async = false;
	}

	/**
	 * 移除所有模块的图属性
	 *
	 * 【使用场景】
	 * 批量重置所有模块的图信息：
	 * - 编译开始前的清理
	 * - 重新构建依赖图前
	 *
	 * 【性能】
	 * 遍历所有模块，时间复杂度 O(n)
	 *
	 * @returns {void}
	 */
	removeAllModuleAttributes() {
		// 遍历所有模块的图节点
		for (const mgm of this._moduleMap.values()) {
			// 重置所有图属性
			mgm.postOrderIndex = null;
			mgm.preOrderIndex = null;
			mgm.depth = null;
			mgm.async = false;
		}
	}

	/**
	 * 转移模块的连接（从旧模块到新模块）⭐⭐
	 *
	 * 【使用场景】
	 * 当需要用新模块替换旧模块时，转移连接关系：
	 * - 模块合并（Scope Hoisting）
	 * - 模块替换（缓存复用）
	 * - 模块升级（版本更新）
	 *
	 * 【执行流程】
	 * 1. 检查是否是同一个模块（优化）
	 * 2. 转移出边（outgoing connections）
	 * 3. 转移入边（incoming connections）
	 * 4. 更新连接中的模块引用
	 *
	 * 【过滤器】
	 * filterConnection 函数决定哪些连接需要转移：
	 * - 返回 true：转移该连接
	 * - 返回 false：保留在原模块
	 *
	 * 【示例】
	 * ```javascript
	 * // 转移所有连接
	 * moveModuleConnections(oldModule, newModule, () => true);
	 *
	 * // 只转移特定类型的连接
	 * moveModuleConnections(oldModule, newModule,
	 *   conn => conn.dependency.type === 'harmony import'
	 * );
	 * ```
	 *
	 * @param {Module} oldModule - 旧模块
	 * @param {Module} newModule - 新模块
	 * @param {function(ModuleGraphConnection): boolean} filterConnection - 过滤函数
	 * @returns {void}
	 */
	moveModuleConnections(oldModule, newModule, filterConnection) {
		// 优化：如果是同一个模块，无需转移
		if (oldModule === newModule) return;

		// 获取两个模块的图节点
		const oldMgm = this._getModuleGraphModule(oldModule);
		const newMgm = this._getModuleGraphModule(newModule);

		// ===== 步骤1: 转移出边（我依赖谁）=====
		const oldConnections = oldMgm.outgoingConnections;

		if (oldConnections !== undefined) {
			// 懒创建新模块的出边集合
			if (newMgm.outgoingConnections === undefined) {
				newMgm.outgoingConnections = new SortableSet();
			}
			const newConnections = newMgm.outgoingConnections;

			// 遍历旧模块的出边
			for (const connection of oldConnections) {
				// 应用过滤器，决定是否转移
				if (filterConnection(connection)) {
					// 更新连接的源模块引用
					connection.originModule = newModule;

					// 添加到新模块
					newConnections.add(connection);

					// 从旧模块删除
					oldConnections.delete(connection);
				}
			}
		}

		// ===== 步骤2: 转移入边（谁依赖我）=====
		const oldConnections2 = oldMgm.incomingConnections;
		const newConnections2 = newMgm.incomingConnections;

		// 遍历旧模块的入边
		for (const connection of oldConnections2) {
			// 应用过滤器，决定是否转移
			if (filterConnection(connection)) {
				// 更新连接的目标模块引用
				connection.module = newModule;

				// 添加到新模块
				newConnections2.add(connection);

				// 从旧模块删除
				oldConnections2.delete(connection);
			}
		}
	}

	/**
	 * @param {Module} oldModule the old referencing module
	 * @param {Module} newModule the new referencing module
	 * @param {function(ModuleGraphConnection): boolean} filterConnection filter predicate for replacement
	 * @returns {void}
	 */
	copyOutgoingModuleConnections(oldModule, newModule, filterConnection) {
		if (oldModule === newModule) return;
		const oldMgm = this._getModuleGraphModule(oldModule);
		const newMgm = this._getModuleGraphModule(newModule);
		// Outgoing connections
		const oldConnections = oldMgm.outgoingConnections;
		if (oldConnections !== undefined) {
			if (newMgm.outgoingConnections === undefined) {
				newMgm.outgoingConnections = new SortableSet();
			}
			const newConnections = newMgm.outgoingConnections;
			for (const connection of oldConnections) {
				if (filterConnection(connection)) {
					const newConnection = connection.clone();
					newConnection.originModule = newModule;
					newConnections.add(newConnection);
					if (newConnection.module !== undefined) {
						const otherMgm = this._getModuleGraphModule(newConnection.module);
						otherMgm.incomingConnections.add(newConnection);
					}
				}
			}
		}
	}

	/**
	 * @param {Module} module the referenced module
	 * @param {string} explanation an explanation why it's referenced
	 * @returns {void}
	 */
	addExtraReason(module, explanation) {
		const connections = this._getModuleGraphModule(module).incomingConnections;
		connections.add(new ModuleGraphConnection(null, null, module, explanation));
	}

	/**
	 * @param {Dependency} dependency the dependency to look for a referenced module
	 * @returns {Module | null} the referenced module
	 */
	getResolvedModule(dependency) {
		const connection = this.getConnection(dependency);
		return connection !== undefined ? connection.resolvedModule : null;
	}

	/**
	 * @param {Dependency} dependency the dependency to look for a referenced module
	 * @returns {ModuleGraphConnection | undefined} the connection
	 */
	getConnection(dependency) {
		const connection = this._dependencyMap.get(dependency);
		if (connection === undefined) {
			const module = this.getParentModule(dependency);
			if (module !== undefined) {
				const mgm = this._getModuleGraphModule(module);
				if (
					mgm._unassignedConnections &&
					mgm._unassignedConnections.length !== 0
				) {
					let foundConnection;
					for (const connection of mgm._unassignedConnections) {
						this._dependencyMap.set(
							/** @type {Dependency} */ (connection.dependency),
							connection
						);
						if (connection.dependency === dependency)
							foundConnection = connection;
					}
					mgm._unassignedConnections.length = 0;
					if (foundConnection !== undefined) {
						return foundConnection;
					}
				}
			}
			this._dependencyMap.set(dependency, null);
			return undefined;
		}
		return connection === null ? undefined : connection;
	}

	/**
	 * 获取依赖的目标模块（最常用的查询方法！）⭐⭐⭐
	 *
	 * 【作用】
	 * 根据依赖对象，查找它指向的目标模块
	 *
	 * 【使用示例】
	 * ```javascript
	 * // 源码中的 import
	 * import { foo } from './a.js'
	 *
	 * // 解析后
	 * const dependency = new HarmonyImportDependency('./a.js');
	 * const targetModule = moduleGraph.getModule(dependency);
	 * // targetModule -> a.js 模块对象
	 * ```
	 *
	 * 【返回值】
	 * - Module: 目标模块对象
	 * - null: 依赖未解析或无法解析
	 *
	 * @param {Dependency} dependency - 依赖对象
	 * @returns {Module | null} 目标模块
	 */
	getModule(dependency) {
		// 先获取连接
		const connection = this.getConnection(dependency);
		// 返回连接的目标模块
		return connection !== undefined ? connection.module : null;
	}

	/**
	 * 获取依赖的源模块（谁创建了这个依赖）
	 *
	 * 【作用】
	 * 根据依赖对象，查找它来自哪个模块
	 *
	 * 【使用示例】
	 * ```javascript
	 * // 在 entry.js 中
	 * import { foo } from './a.js'
	 *
	 * // 查询
	 * const originModule = moduleGraph.getOrigin(dependency);
	 * // originModule -> entry.js 模块对象
	 * ```
	 *
	 * 【用途】
	 * - 错误报告：显示依赖来自哪里
	 * - 依赖分析：追踪引用链
	 *
	 * @param {Dependency} dependency - 依赖对象
	 * @returns {Module | null} 源模块
	 */
	getOrigin(dependency) {
		// 先获取连接
		const connection = this.getConnection(dependency);
		// 返回连接的源模块
		return connection !== undefined ? connection.originModule : null;
	}

	/**
	 * 获取依赖的解析后源模块
	 *
	 * 【与 getOrigin 的区别】
	 * - getOrigin: 直接的源模块
	 * - getResolvedOrigin: 解析后的源模块（处理别名、重定向等）
	 *
	 * 【使用场景】
	 * 某些情况下源模块可能被重定向或替换，
	 * 此方法返回最终解析后的模块
	 *
	 * @param {Dependency} dependency - 依赖对象
	 * @returns {Module | null} 解析后的源模块
	 */
	getResolvedOrigin(dependency) {
		const connection = this.getConnection(dependency);
		return connection !== undefined ? connection.resolvedOriginModule : null;
	}

	/**
	 * 获取模块的所有入边（谁依赖我）⭐⭐⭐
	 *
	 * 【作用】
	 * 查找所有依赖该模块的连接
	 *
	 * 【应用场景】
	 * 1. **Tree Shaking**:
	 *    如果 incomingConnections.size === 0，模块未被使用
	 *
	 * 2. **代码分割**:
	 *    如果 incomingConnections.size > 1，模块被多处引用，
	 *    可以提取到公共 chunk
	 *
	 * 3. **依赖追踪**:
	 *    找出哪些模块依赖了当前模块
	 *
	 * 【示例】
	 * ```javascript
	 * const connections = moduleGraph.getIncomingConnections(module);
	 *
	 * for (const conn of connections) {
	 *   console.log(
	 *     `${conn.originModule.identifier()} -> ${module.identifier()}`
	 *   );
	 * }
	 * ```
	 *
	 * @param {Module} module - 模块
	 * @returns {Iterable<ModuleGraphConnection>} 入边连接集合
	 */
	getIncomingConnections(module) {
		// 获取模块的图节点并返回入边集合
		const connections = this._getModuleGraphModule(module).incomingConnections;
		return connections;
	}

	/**
	 * 获取模块的所有出边（我依赖谁）⭐⭐⭐
	 *
	 * 【作用】
	 * 查找该模块依赖的所有其他模块
	 *
	 * 【应用场景】
	 * 1. **递归构建**:
	 *    遍历出边，递归构建依赖的模块
	 *
	 * 2. **模块合并**:
	 *    分析出边，判断是否可以合并模块
	 *
	 * 3. **循环依赖检测**:
	 *    遍历出边检测环
	 *
	 * 【示例】
	 * ```javascript
	 * const connections = moduleGraph.getOutgoingConnections(module);
	 *
	 * for (const conn of connections) {
	 *   console.log(
	 *     `${module.identifier()} -> ${conn.module.identifier()}`
	 *   );
	 * }
	 * ```
	 *
	 * 【注意】
	 * 可能返回空集合（某些模块没有依赖，如纯 CSS 文件）
	 *
	 * @param {Module} module - 模块
	 * @returns {Iterable<ModuleGraphConnection>} 出边连接集合
	 */
	getOutgoingConnections(module) {
		// 获取模块的图节点
		const connections = this._getModuleGraphModule(module).outgoingConnections;
		// 如果未初始化，返回空集合
		return connections === undefined ? EMPTY_SET : connections;
	}

	/**
	 * @param {Module} module the module
	 * @returns {readonly Map<Module | undefined, readonly ModuleGraphConnection[]>} reasons why a module is included, in a map by source module
	 */
	getIncomingConnectionsByOriginModule(module) {
		const connections = this._getModuleGraphModule(module).incomingConnections;
		return connections.getFromUnorderedCache(getConnectionsByOriginModule);
	}

	/**
	 * @param {Module} module the module
	 * @returns {readonly Map<Module | undefined, readonly ModuleGraphConnection[]> | undefined} connections to modules, in a map by module
	 */
	getOutgoingConnectionsByModule(module) {
		const connections = this._getModuleGraphModule(module).outgoingConnections;
		return connections === undefined
			? undefined
			: connections.getFromUnorderedCache(getConnectionsByModule);
	}

	/**
	 * @param {Module} module the module
	 * @returns {ModuleProfile | null} the module profile
	 */
	getProfile(module) {
		const mgm = this._getModuleGraphModule(module);
		return mgm.profile;
	}

	/**
	 * @param {Module} module the module
	 * @param {ModuleProfile | null} profile the module profile
	 * @returns {void}
	 */
	setProfile(module, profile) {
		const mgm = this._getModuleGraphModule(module);
		mgm.profile = profile;
	}

	/**
	 * 获取模块的引入者（谁第一次引入了这个模块）⭐
	 *
	 * 【作用】
	 * 返回第一次引入该模块的模块
	 *
	 * 【用途】
	 * 1. **错误报告**: 显示模块引入链
	 *    "Module A was imported by Module B"
	 *
	 * 2. **构建顺序**: 决定模块的构建优先级
	 *    先构建引入者，再构建被引入的模块
	 *
	 * 3. **依赖追踪**: 追踪模块引入路径
	 *    entry.js -> a.js -> b.js
	 *
	 * 【与 getOrigin 的区别】
	 * - getOrigin: 获取特定依赖的源模块
	 * - getIssuer: 获取模块的第一个引入者
	 *
	 * @param {Module} module - 模块
	 * @returns {Module | null} 引入者模块
	 */
	getIssuer(module) {
		const mgm = this._getModuleGraphModule(module);
		return mgm.issuer;
	}

	/**
	 * 设置模块的引入者
	 *
	 * 【使用场景】
	 * 在构建模块时，记录是谁引入了它
	 *
	 * @param {Module} module - 模块
	 * @param {Module | null} issuer - 引入者模块
	 * @returns {void}
	 */
	setIssuer(module, issuer) {
		const mgm = this._getModuleGraphModule(module);
		mgm.issuer = issuer;
	}

	/**
	 * 设置模块的引入者（仅在未设置时）
	 *
	 * 【作用】
	 * 只在 issuer 还未设置时才设置，保留第一个引入者
	 *
	 * 【为什么需要】
	 * 一个模块可能被多个模块引入，但我们只关心第一个引入者：
	 * - a.js 引入了 c.js（第一次）
	 * - b.js 也引入了 c.js（第二次）
	 * - c.js 的 issuer 应该是 a.js（取决于构建顺序）
	 *
	 * @param {Module} module - 模块
	 * @param {Module | null} issuer - 引入者模块
	 * @returns {void}
	 */
	setIssuerIfUnset(module, issuer) {
		const mgm = this._getModuleGraphModule(module);
		// 只在未设置时才设置
		if (mgm.issuer === undefined) mgm.issuer = issuer;
	}

	/**
	 * @param {Module} module the module
	 * @returns {(string | OptimizationBailoutFunction)[]} optimization bailouts
	 */
	getOptimizationBailout(module) {
		const mgm = this._getModuleGraphModule(module);
		return mgm.optimizationBailout;
	}

	/**
	 * 获取模块提供的所有导出（Tree Shaking 基础！）⭐⭐⭐
	 *
	 * 【作用】
	 * 返回模块导出了哪些名称
	 *
	 * 【返回值】
	 * - string[]: 具体的导出名称列表，如 ['foo', 'bar']
	 * - true: 有导出，但不确定具体是什么（动态导出）
	 * - null: 还未分析或无法分析
	 *
	 * 【使用示例】
	 * ```javascript
	 * // a.js
	 * export const foo = 1;
	 * export const bar = 2;
	 *
	 * // 查询
	 * const exports = moduleGraph.getProvidedExports(a);
	 * // exports -> ['foo', 'bar']
	 * ```
	 *
	 * 【应用】
	 * Tree Shaking 的第一步：知道模块导出了什么
	 *
	 * @param {Module} module - 模块
	 * @returns {true | string[] | null} 导出列表
	 */
	getProvidedExports(module) {
		const mgm = this._getModuleGraphModule(module);
		return mgm.exports.getProvidedExports();
	}

	/**
	 * 检查模块是否提供了指定导出
	 *
	 * 【作用】
	 * 判断模块是否导出了某个名称
	 *
	 * 【使用示例】
	 * ```javascript
	 * // a.js
	 * export const foo = 1;
	 *
	 * // 查询
	 * moduleGraph.isExportProvided(a, 'foo')  // true
	 * moduleGraph.isExportProvided(a, 'bar')  // false
	 * moduleGraph.isExportProvided(a, 'baz')  // null (未知)
	 * ```
	 *
	 * 【返回值】
	 * - true: 确定提供该导出
	 * - false: 确定不提供该导出
	 * - null: 无法确定（动态导出或未分析）
	 *
	 * @param {Module} module - 模块
	 * @param {string | string[]} exportName - 导出名称
	 * @returns {boolean | null} 是否提供
	 */
	isExportProvided(module, exportName) {
		const mgm = this._getModuleGraphModule(module);
		const result = mgm.exports.isExportProvided(exportName);
		// 转换：undefined -> null
		return result === undefined ? null : result;
	}

	/**
	 * 获取模块的导出信息对象（Tree Shaking 核心！）⭐⭐⭐
	 *
	 * 【作用】
	 * 返回包含所有导出详细信息的对象
	 *
	 * 【ExportsInfo 提供的能力】
	 * - getProvidedExports(): 获取导出列表
	 * - getExportInfo(name): 获取特定导出的信息
	 * - getUsedExports(): 获取被使用的导出
	 * - isExportUsed(name): 判断导出是否被使用
	 *
	 * 【使用示例】
	 * ```javascript
	 * const exportsInfo = moduleGraph.getExportsInfo(module);
	 *
	 * // 获取所有导出
	 * const provided = exportsInfo.getProvidedExports();
	 *
	 * // 检查特定导出
	 * const fooInfo = exportsInfo.getExportInfo('foo');
	 * const isUsed = fooInfo.used;
	 *
	 * // Tree Shaking: 删除未使用的导出
	 * if (!isUsed) {
	 *   // 不生成 foo 的代码
	 * }
	 * ```
	 *
	 * 【重要性】
	 * 这是 Tree Shaking 的核心数据结构！
	 *
	 * @param {Module} module - 模块
	 * @returns {ExportsInfo} 导出信息对象
	 */
	getExportsInfo(module) {
		const mgm = this._getModuleGraphModule(module);
		return mgm.exports;
	}

	/**
	 * 获取特定导出的信息
	 *
	 * 【作用】
	 * 返回指定导出名称的详细信息
	 *
	 * 【ExportInfo 包含的信息】
	 * - name: 导出名称
	 * - used: 是否被使用（Tree Shaking 关键）
	 * - canMangle: 是否可以被重命名（压缩优化）
	 * - provided: 是否确实提供了该导出
	 *
	 * 【使用示例】
	 * ```javascript
	 * const exportInfo = moduleGraph.getExportInfo(module, 'foo');
	 *
	 * console.log(exportInfo.used);       // true/false
	 * console.log(exportInfo.canMangle);  // true/false
	 * console.log(exportInfo.provided);   // true/false/null
	 * ```
	 *
	 * @param {Module} module - 模块
	 * @param {string} exportName - 导出名称
	 * @returns {ExportInfo} 导出信息
	 */
	getExportInfo(module, exportName) {
		const mgm = this._getModuleGraphModule(module);
		return mgm.exports.getExportInfo(exportName);
	}

	/**
	 * 获取只读的导出信息
	 *
	 * 【与 getExportInfo 的区别】
	 * - getExportInfo: 返回可修改的 ExportInfo（如果不存在会创建）
	 * - getReadOnlyExportInfo: 只读访问（不会创建新的 ExportInfo）
	 *
	 * 【使用场景】
	 * 当只需要查询而不需要修改时，使用此方法：
	 * - 性能更好（不创建新对象）
	 * - 防止意外修改
	 *
	 * @param {Module} module - 模块
	 * @param {string} exportName - 导出名称
	 * @returns {ExportInfo} 只读导出信息
	 */
	getReadOnlyExportInfo(module, exportName) {
		const mgm = this._getModuleGraphModule(module);
		return mgm.exports.getReadOnlyExportInfo(exportName);
	}

	/**
	 * @param {Module} module the module
	 * @param {RuntimeSpec} runtime the runtime
	 * @returns {false | true | SortableSet<string> | null} the used exports
	 * false: module is not used at all.
	 * true: the module namespace/object export is used.
	 * SortableSet<string>: these export names are used.
	 * empty SortableSet<string>: module is used but no export.
	 * null: unknown, worst case should be assumed.
	 */
	getUsedExports(module, runtime) {
		const mgm = this._getModuleGraphModule(module);
		return mgm.exports.getUsedExports(runtime);
	}

	/**
	 * @param {Module} module the module
	 * @returns {number | null} the index of the module
	 */
	getPreOrderIndex(module) {
		const mgm = this._getModuleGraphModule(module);
		return mgm.preOrderIndex;
	}

	/**
	 * @param {Module} module the module
	 * @returns {number | null} the index of the module
	 */
	getPostOrderIndex(module) {
		const mgm = this._getModuleGraphModule(module);
		return mgm.postOrderIndex;
	}

	/**
	 * @param {Module} module the module
	 * @param {number} index the index of the module
	 * @returns {void}
	 */
	setPreOrderIndex(module, index) {
		const mgm = this._getModuleGraphModule(module);
		mgm.preOrderIndex = index;
	}

	/**
	 * @param {Module} module the module
	 * @param {number} index the index of the module
	 * @returns {boolean} true, if the index was set
	 */
	setPreOrderIndexIfUnset(module, index) {
		const mgm = this._getModuleGraphModule(module);
		if (mgm.preOrderIndex === null) {
			mgm.preOrderIndex = index;
			return true;
		}
		return false;
	}

	/**
	 * @param {Module} module the module
	 * @param {number} index the index of the module
	 * @returns {void}
	 */
	setPostOrderIndex(module, index) {
		const mgm = this._getModuleGraphModule(module);
		mgm.postOrderIndex = index;
	}

	/**
	 * @param {Module} module the module
	 * @param {number} index the index of the module
	 * @returns {boolean} true, if the index was set
	 */
	setPostOrderIndexIfUnset(module, index) {
		const mgm = this._getModuleGraphModule(module);
		if (mgm.postOrderIndex === null) {
			mgm.postOrderIndex = index;
			return true;
		}
		return false;
	}

	/**
	 * @param {Module} module the module
	 * @returns {number | null} the depth of the module
	 */
	getDepth(module) {
		const mgm = this._getModuleGraphModule(module);
		return mgm.depth;
	}

	/**
	 * @param {Module} module the module
	 * @param {number} depth the depth of the module
	 * @returns {void}
	 */
	setDepth(module, depth) {
		const mgm = this._getModuleGraphModule(module);
		mgm.depth = depth;
	}

	/**
	 * @param {Module} module the module
	 * @param {number} depth the depth of the module
	 * @returns {boolean} true, if the depth was set
	 */
	setDepthIfLower(module, depth) {
		const mgm = this._getModuleGraphModule(module);
		if (mgm.depth === null || mgm.depth > depth) {
			mgm.depth = depth;
			return true;
		}
		return false;
	}

	/**
	 * @param {Module} module the module
	 * @returns {boolean} true, if the module is async
	 */
	isAsync(module) {
		const mgm = this._getModuleGraphModule(module);
		return mgm.async;
	}

	/**
	 * @param {Module} module the module
	 * @returns {void}
	 */
	setAsync(module) {
		const mgm = this._getModuleGraphModule(module);
		mgm.async = true;
	}

	/**
	 * @param {any} thing any thing
	 * @returns {Object} metadata
	 */
	getMeta(thing) {
		let meta = this._metaMap.get(thing);
		if (meta === undefined) {
			meta = Object.create(null);
			this._metaMap.set(thing, /** @type {Object} */ (meta));
		}
		return /** @type {Object} */ (meta);
	}

	/**
	 * @param {any} thing any thing
	 * @returns {Object | undefined} metadata
	 */
	getMetaIfExisting(thing) {
		return this._metaMap.get(thing);
	}

	/**
	 * @param {string=} cacheStage a persistent stage name for caching
	 */
	freeze(cacheStage) {
		this._cache = new WeakTupleMap();
		this._cacheStage = cacheStage;
	}

	unfreeze() {
		this._cache = undefined;
		this._cacheStage = undefined;
	}

	/**
	 * @template {any[]} T
	 * @template V
	 * @param {(moduleGraph: ModuleGraph, ...args: T) => V} fn computer
	 * @param {T} args arguments
	 * @returns {V} computed value or cached
	 */
	cached(fn, ...args) {
		if (this._cache === undefined) return fn(this, ...args);
		return this._cache.provide(fn, ...args, () => fn(this, ...args));
	}

	/**
	 * @param {Map<Module, WeakTupleMap<any, any>>} moduleMemCaches mem caches for modules for better caching
	 */
	setModuleMemCaches(moduleMemCaches) {
		this._moduleMemCaches = moduleMemCaches;
	}

	/**
	 * @param {Dependency} dependency dependency
	 * @param {...any} args arguments, last argument is a function called with moduleGraph, dependency, ...args
	 * @returns {any} computed value or cached
	 */
	dependencyCacheProvide(dependency, ...args) {
		/** @type {(moduleGraph: ModuleGraph, dependency: Dependency, ...args: any[]) => any} */
		const fn = args.pop();
		if (this._moduleMemCaches && this._cacheStage) {
			const memCache = this._moduleMemCaches.get(
				this.getParentModule(dependency)
			);
			if (memCache !== undefined) {
				return memCache.provide(dependency, this._cacheStage, ...args, () =>
					fn(this, dependency, ...args)
				);
			}
		}
		if (this._cache === undefined) return fn(this, dependency, ...args);
		return this._cache.provide(dependency, ...args, () =>
			fn(this, dependency, ...args)
		);
	}

	// TODO remove in webpack 6
	/**
	 * @param {Module} module the module
	 * @param {string} deprecateMessage message for the deprecation message
	 * @param {string} deprecationCode code for the deprecation
	 * @returns {ModuleGraph} the module graph
	 */
	static getModuleGraphForModule(module, deprecateMessage, deprecationCode) {
		const fn = deprecateMap.get(deprecateMessage);
		if (fn) return fn(module);
		const newFn = util.deprecate(
			/**
			 * @param {Module} module the module
			 * @returns {ModuleGraph} the module graph
			 */
			module => {
				const moduleGraph = moduleGraphForModuleMap.get(module);
				if (!moduleGraph)
					throw new Error(
						deprecateMessage +
							"There was no ModuleGraph assigned to the Module for backward-compat (Use the new API)"
					);
				return moduleGraph;
			},
			deprecateMessage + ": Use new ModuleGraph API",
			deprecationCode
		);
		deprecateMap.set(deprecateMessage, newFn);
		return newFn(module);
	}

	// TODO remove in webpack 6
	/**
	 * @param {Module} module the module
	 * @param {ModuleGraph} moduleGraph the module graph
	 * @returns {void}
	 */
	static setModuleGraphForModule(module, moduleGraph) {
		moduleGraphForModuleMap.set(module, moduleGraph);
	}

	// TODO remove in webpack 6
	/**
	 * @param {Module} module the module
	 * @returns {void}
	 */
	static clearModuleGraphForModule(module) {
		moduleGraphForModuleMap.delete(module);
	}
}

// TODO remove in webpack 6
/** @type {WeakMap<Module, ModuleGraph>} */
const moduleGraphForModuleMap = new WeakMap();

// TODO remove in webpack 6
/** @type {Map<string, (module: Module) => ModuleGraph>} */
const deprecateMap = new Map();

module.exports = ModuleGraph;
module.exports.ModuleGraphConnection = ModuleGraphConnection;
