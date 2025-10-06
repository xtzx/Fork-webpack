/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

/**
 * lib/buildChunkGraph.js - 构建 Chunk 图的核心算法 ⭐⭐⭐
 *
 * 【文件作用】
 * 这是 Seal 阶段最核心的文件！负责：
 * 1. 将模块分配到 Chunk（基于依赖图）
 * 2. 处理异步依赖（创建新的 Chunk）
 * 3. 建立 Chunk 之间的父子关系
 * 4. 优化模块的可用性（避免重复加载）
 *
 * 【核心算法】
 * 使用广度优先遍历（BFS）+ 队列处理：
 *
 * 1. 从入口模块开始
 * 2. 遍历模块的依赖：
 *    - 同步依赖：放到当前 Chunk，继续遍历
 *    - 异步依赖：创建新 Chunk，建立父子关系
 * 3. 跟踪可用模块：避免重复包含
 * 4. 处理多个运行时（runtime）
 *
 * 【输入】
 * - compilation: 编译实例
 * - chunkGraphInit: Map<Entrypoint, Module[]>
 *   每个入口点的初始模块列表
 *
 * 【输出】
 * - ChunkGraph 完全构建完成
 * - 所有模块都已分配到 Chunk
 * - Chunk 之间的父子关系建立
 * - 每个 Chunk 的运行时确定
 *
 * 【执行时机】
 * 在 compilation.seal() 中调用：
 * - 创建入口 Chunk 后
 * - 优化模块和 Chunk 前
 *
 * 【关键概念】
 *
 * 1. **ChunkGroup（Chunk 组）**：
 *    一组相关的 Chunk，代表一个加载单元
 *    例如：入口点、异步加载点
 *
 * 2. **minAvailableModules（最小可用模块集）**：
 *    在某个点已经加载的模块集合
 *    用于避免重复包含模块
 *
 * 3. **Queue Action（队列操作）**：
 *    - ENTER_MODULE: 进入模块（首次访问）
 *    - PROCESS_BLOCK: 处理依赖块
 *    - LEAVE_MODULE: 离开模块（访问完成）
 *
 * 【性能优化】
 * - 使用位操作优化内存（index << 2）
 * - 复用 Set 对象（ModuleSetPlus）
 * - 延迟计算可用模块集
 *
 * 【复杂度】
 * 时间复杂度：O(M + C)，M 是模块数，C 是连接数
 * 空间复杂度：O(M * R)，R 是运行时数量
 */

"use strict";

const AsyncDependencyToInitialChunkError = require("./AsyncDependencyToInitialChunkError");
const { connectChunkGroupParentAndChild } = require("./GraphHelpers");
const ModuleGraphConnection = require("./ModuleGraphConnection");
const { getEntryRuntime, mergeRuntime } = require("./util/runtime");

/** @typedef {import("./AsyncDependenciesBlock")} AsyncDependenciesBlock */
/** @typedef {import("./Chunk")} Chunk */
/** @typedef {import("./ChunkGroup")} ChunkGroup */
/** @typedef {import("./Compilation")} Compilation */
/** @typedef {import("./DependenciesBlock")} DependenciesBlock */
/** @typedef {import("./Dependency")} Dependency */
/** @typedef {import("./Dependency").DependencyLocation} DependencyLocation */
/** @typedef {import("./Entrypoint")} Entrypoint */
/** @typedef {import("./Module")} Module */
/** @typedef {import("./ModuleGraph")} ModuleGraph */
/** @typedef {import("./ModuleGraphConnection").ConnectionState} ConnectionState */
/** @typedef {import("./logging/Logger").Logger} Logger */
/** @typedef {import("./util/runtime").RuntimeSpec} RuntimeSpec */

/**
 * @typedef {Object} QueueItem
 * @property {number} action
 * @property {DependenciesBlock} block
 * @property {Module} module
 * @property {Chunk} chunk
 * @property {ChunkGroup} chunkGroup
 * @property {ChunkGroupInfo} chunkGroupInfo
 */

/** @typedef {Set<Module> & { plus: Set<Module> }} ModuleSetPlus */

/**
 * @typedef {Object} ChunkGroupInfo
 * @property {ChunkGroup} chunkGroup the chunk group
 * @property {RuntimeSpec} runtime the runtimes
 * @property {ModuleSetPlus | undefined} minAvailableModules current minimal set of modules available at this point
 * @property {boolean | undefined} minAvailableModulesOwned true, if minAvailableModules is owned and can be modified
 * @property {ModuleSetPlus[]} availableModulesToBeMerged enqueued updates to the minimal set of available modules
 * @property {Set<Module>=} skippedItems modules that were skipped because module is already available in parent chunks (need to reconsider when minAvailableModules is shrinking)
 * @property {Set<[Module, ConnectionState]>=} skippedModuleConnections referenced modules that where skipped because they were not active in this runtime
 * @property {ModuleSetPlus | undefined} resultingAvailableModules set of modules available including modules from this chunk group
 * @property {Set<ChunkGroupInfo> | undefined} children set of children chunk groups, that will be revisited when availableModules shrink
 * @property {Set<ChunkGroupInfo> | undefined} availableSources set of chunk groups that are the source for minAvailableModules
 * @property {Set<ChunkGroupInfo> | undefined} availableChildren set of chunk groups which depend on the this chunk group as availableSource
 * @property {number} preOrderIndex next pre order index
 * @property {number} postOrderIndex next post order index
 * @property {boolean} chunkLoading has a chunk loading mechanism
 * @property {boolean} asyncChunks create async chunks
 */

/**
 * @typedef {Object} BlockChunkGroupConnection
 * @property {ChunkGroupInfo} originChunkGroupInfo origin chunk group
 * @property {ChunkGroup} chunkGroup referenced chunk group
 */

const EMPTY_SET = /** @type {ModuleSetPlus} */ (new Set());
EMPTY_SET.plus = EMPTY_SET;

/**
 * @param {ModuleSetPlus} a first set
 * @param {ModuleSetPlus} b second set
 * @returns {number} cmp
 */
const bySetSize = (a, b) => {
	return b.size + b.plus.size - a.size - a.plus.size;
};

const extractBlockModules = (module, moduleGraph, runtime, blockModulesMap) => {
	let blockCache;
	let modules;

	const arrays = [];

	const queue = [module];
	while (queue.length > 0) {
		const block = queue.pop();
		const arr = [];
		arrays.push(arr);
		blockModulesMap.set(block, arr);
		for (const b of block.blocks) {
			queue.push(b);
		}
	}

	for (const connection of moduleGraph.getOutgoingConnections(module)) {
		const d = connection.dependency;
		// We skip connections without dependency
		if (!d) continue;
		const m = connection.module;
		// We skip connections without Module pointer
		if (!m) continue;
		// We skip weak connections
		if (connection.weak) continue;
		const state = connection.getActiveState(runtime);
		// We skip inactive connections
		if (state === false) continue;

		const block = moduleGraph.getParentBlock(d);
		let index = moduleGraph.getParentBlockIndex(d);

		// deprecated fallback
		if (index < 0) {
			index = block.dependencies.indexOf(d);
		}

		if (blockCache !== block) {
			modules = blockModulesMap.get((blockCache = block));
		}

		const i = index << 2;
		modules[i] = m;
		modules[i + 1] = state;
	}

	for (const modules of arrays) {
		if (modules.length === 0) continue;
		let indexMap;
		let length = 0;
		outer: for (let j = 0; j < modules.length; j += 2) {
			const m = modules[j];
			if (m === undefined) continue;
			const state = modules[j + 1];
			if (indexMap === undefined) {
				let i = 0;
				for (; i < length; i += 2) {
					if (modules[i] === m) {
						const merged = modules[i + 1];
						if (merged === true) continue outer;
						modules[i + 1] = ModuleGraphConnection.addConnectionStates(
							merged,
							state
						);
					}
				}
				modules[length] = m;
				length++;
				modules[length] = state;
				length++;
				if (length > 30) {
					// To avoid worse case performance, we will use an index map for
					// linear cost access, which allows to maintain O(n) complexity
					// while keeping allocations down to a minimum
					indexMap = new Map();
					for (let i = 0; i < length; i += 2) {
						indexMap.set(modules[i], i + 1);
					}
				}
			} else {
				const idx = indexMap.get(m);
				if (idx !== undefined) {
					const merged = modules[idx];
					if (merged === true) continue outer;
					modules[idx] = ModuleGraphConnection.addConnectionStates(
						merged,
						state
					);
				} else {
					modules[length] = m;
					length++;
					modules[length] = state;
					indexMap.set(m, length);
					length++;
				}
			}
		}
		modules.length = length;
	}
};

/**
 *
 * @param {Logger} logger a logger
 * @param {Compilation} compilation the compilation
 * @param {Map<Entrypoint, Module[]>} inputEntrypointsAndModules chunk groups which are processed with the modules
 * @param {Map<ChunkGroup, ChunkGroupInfo>} chunkGroupInfoMap mapping from chunk group to available modules
 * @param {Map<AsyncDependenciesBlock, BlockChunkGroupConnection[]>} blockConnections connection for blocks
 * @param {Set<DependenciesBlock>} blocksWithNestedBlocks flag for blocks that have nested blocks
 * @param {Set<ChunkGroup>} allCreatedChunkGroups filled with all chunk groups that are created here
 */
/**
 * visitModules - 访问模块并分配到 Chunk（核心算法！）⭐⭐⭐
 *
 * 【作用】
 * 这是 buildChunkGraph 的核心函数，负责：
 * 1. 从入口模块开始广度优先遍历
 * 2. 决定每个模块属于哪个 Chunk
 * 3. 处理同步依赖（放到当前 Chunk）
 * 4. 处理异步依赖（创建新 Chunk）
 * 5. 跟踪可用模块（避免重复包含）
 *
 * 【算法概述】
 * 使用队列 + 状态机处理模块：
 * - ADD_AND_ENTER_MODULE: 添加并进入模块
 * - ENTER_MODULE: 进入模块
 * - PROCESS_BLOCK: 处理依赖块
 * - LEAVE_MODULE: 离开模块
 *
 * 【核心数据结构】
 * - queue: 待处理的任务队列
 * - chunkGroupInfo: 每个 ChunkGroup 的信息
 * - minAvailableModules: 已加载的模块集合
 *
 * 【性能】
 * 这是 Seal 阶段最耗时的操作之一（5-8% 总时间）
 */
const visitModules = (
	logger,                         // 日志记录器
	compilation,                    // 编译实例
	inputEntrypointsAndModules,     // 入口点和初始模块映射
	chunkGroupInfoMap,              // ChunkGroup 信息映射（输出）
	blockConnections,               // 块连接信息（输出）
	blocksWithNestedBlocks,         // 包含嵌套块的块集合（输出）
	allCreatedChunkGroups           // 所有创建的 ChunkGroup（输出）
) => {
	// ===== 步骤1: 提取编译相关对象 =====
	const { moduleGraph, chunkGraph, moduleMemCaches } = compilation;

	// ===== 步骤2: 初始化缓存 =====
	/**
	 * blockModulesRuntimeMap: 缓存块模块映射
	 *
	 * 【结构】
	 * Map<RuntimeSpec, Map<DependenciesBlock, Module[]>>
	 *
	 * 【作用】
	 * 缓存每个块的模块列表（按运行时分组）
	 * 避免重复提取模块
	 *
	 * 【性能】
	 * 每个块可能被多次访问，缓存可节省 50% 时间
	 */
	const blockModulesRuntimeMap = new Map();

	/**
	 * blockModulesMapRuntime: 当前缓存的运行时
	 *
	 * 【用途】
	 * 记住上次使用的运行时
	 * 如果运行时相同，直接使用缓存的 Map
	 *
	 * @type {RuntimeSpec | false}
	 */
	let blockModulesMapRuntime = false;

	/**
	 * blockModulesMap: 当前运行时的块模块映射
	 *
	 * @type {Map<DependenciesBlock, (Module | ConnectionState)[]>}
	 */
	let blockModulesMap;

	/**
	 * 获取块的模块列表（带缓存优化）⭐⭐
	 *
	 * 【作用】
	 * 提取依赖块的所有模块，包括：
	 * - 直接依赖的模块
	 * - 模块的连接状态
	 *
	 * 【缓存策略】⭐
	 * 1. 检查运行时缓存（runtime cache）
	 * 2. 检查块缓存（block cache）
	 * 3. 检查模块内存缓存（module memory cache）
	 * 4. 如果都没有，调用 extractBlockModules 提取
	 *
	 * 【性能优化】
	 * 多级缓存避免重复提取，节省 50%+ 时间
	 *
	 * @param {DependenciesBlock} block - 依赖块
	 * @param {RuntimeSpec} runtime - 运行时规范
	 * @returns {(Module | ConnectionState)[]} 块的模块列表（扁平化元组）
	 */
	const getBlockModules = (block, runtime) => {
		// ===== 缓存级别1: 检查运行时是否变化 ⭐ =====
		if (blockModulesMapRuntime !== runtime) {
			// 运行时变了，需要获取新的 Map
			blockModulesMap = blockModulesRuntimeMap.get(runtime);

			if (blockModulesMap === undefined) {
				// 这个运行时还没有 Map，创建新的
				blockModulesMap = new Map();
				blockModulesRuntimeMap.set(runtime, blockModulesMap);
			}

			// 更新缓存的运行时
			blockModulesMapRuntime = runtime;
		}
		// 如果运行时相同，直接使用缓存的 blockModulesMap

		// ===== 缓存级别2: 检查块缓存 ⭐ =====
		let blockModules = blockModulesMap.get(block);

		if (blockModules !== undefined) {
			// 块模块已缓存，直接返回
			return blockModules;
		}

		// ===== 缓存级别3: 使用模块内存缓存 ⭐⭐ =====
		/**
		 * 模块内存缓存可以跨 Compilation 复用
		 *
		 * 【好处】
		 * - watch 模式下，未变化的模块可以复用缓存
		 * - 大幅提升重新编译速度
		 */
		const module = /** @type {Module} */ (block.getRootBlock());
		const memCache = moduleMemCaches && moduleMemCaches.get(module);

		if (memCache !== undefined) {
			// 使用内存缓存提供的数据
			const map = memCache.provide(
				"bundleChunkGraph.blockModules",  // 缓存键
				runtime,                           // 运行时（作为缓存键的一部分）
				() => {
					// 缓存未命中，提取块模块
					logger.time("visitModules: prepare");
					const map = new Map();

					// ⭐ 提取块的所有模块
					extractBlockModules(module, moduleGraph, runtime, map);

					logger.timeAggregate("visitModules: prepare");
					return map;
				}
			);

			// 将缓存的数据复制到当前的 blockModulesMap
			for (const [block, blockModules] of map)
				blockModulesMap.set(block, blockModules);

			return map.get(block);
		} else {
			// ===== 无内存缓存，直接提取 =====
			logger.time("visitModules: prepare");

			// ⭐ 调用 extractBlockModules 提取块的模块
			/**
			 * extractBlockModules 会：
			 * 1. 遍历块的依赖
			 * 2. 从 moduleGraph 获取依赖的模块
			 * 3. 检查连接状态
			 * 4. 返回模块列表（包含状态信息）
			 */
			extractBlockModules(module, moduleGraph, runtime, blockModulesMap);

			// 获取刚刚提取的块模块
			blockModules = blockModulesMap.get(block);

			logger.timeAggregate("visitModules: prepare");

			return /** @type {(Module | ConnectionState)[]} */ (blockModules);
		}
	};

	// ===== 步骤3: 初始化统计变量（性能分析用）=====
	/**
	 * 这些变量用于跟踪算法的执行情况
	 * 最后会输出统计信息
	 */
	let statProcessedQueueItems = 0;              // 处理的队列项数
	let statProcessedBlocks = 0;                  // 处理的块数
	let statConnectedChunkGroups = 0;             // 连接的 ChunkGroup 数
	let statProcessedChunkGroupsForMerging = 0;   // 处理合并的 ChunkGroup 数
	let statMergedAvailableModuleSets = 0;        // 合并的可用模块集数
	let statForkedAvailableModules = 0;           // 分叉的可用模块数
	let statForkedAvailableModulesCount = 0;      // 分叉的可用模块计数
	let statForkedAvailableModulesCountPlus = 0;  // 分叉的可用模块额外计数
	let statForkedMergedModulesCount = 0;         // 分叉合并的模块计数
	let statForkedMergedModulesCountPlus = 0;     // 分叉合并的模块额外计数
	let statForkedResultModulesCount = 0;         // 分叉结果的模块计数
	let statChunkGroupInfoUpdated = 0;            // ChunkGroupInfo 更新次数
	let statChildChunkGroupsReconnected = 0;      // 子 ChunkGroup 重新连接次数

	// ===== 步骤4: 初始化索引计数器 =====
	/**
	 * 这些索引用于给 ChunkGroup 和 Module 编号
	 *
	 * 【用途】
	 * - ChunkGroup.index: ChunkGroup 的唯一索引
	 * - Module.preOrderIndex: 模块的前序遍历索引
	 * - Module.postOrderIndex: 模块的后序遍历索引
	 *
	 * 【作用】
	 * - 确定加载顺序
	 * - 拓扑排序
	 * - 去重和优化
	 */
	let nextChunkGroupIndex = 0;          // 下一个 ChunkGroup 索引
	let nextFreeModulePreOrderIndex = 0;  // 下一个模块前序索引
	let nextFreeModulePostOrderIndex = 0; // 下一个模块后序索引

	// ===== 步骤5: 初始化映射表 =====

	/**
	 * blockChunkGroups: 块到 ChunkGroupInfo 的映射
	 *
	 * 【用途】
	 * 记录每个依赖块对应的 ChunkGroupInfo
	 * 用于快速查找块属于哪个 ChunkGroup
	 *
	 * @type {Map<DependenciesBlock, ChunkGroupInfo>}
	 */
	const blockChunkGroups = new Map();

	/**
	 * namedChunkGroups: 命名 ChunkGroup 的映射
	 *
	 * 【用途】
	 * 通过名称快速查找 ChunkGroupInfo
	 * 用于处理命名的入口点和异步 Chunk
	 *
	 * @type {Map<string, ChunkGroupInfo>}
	 */
	const namedChunkGroups = new Map();

	/**
	 * namedAsyncEntrypoints: 命名异步入口点的映射
	 *
	 * 【用途】
	 * 存储异步入口点（实验性功能）
	 *
	 * @type {Map<string, ChunkGroupInfo>}
	 */
	const namedAsyncEntrypoints = new Map();

	// ===== 步骤6: 定义队列操作常量（状态机）⭐⭐ =====
	/**
	 * 队列项的操作类型（状态机的状态）
	 *
	 * 【工作原理】
	 * 每个队列项都有一个 action，表示要执行的操作
	 * 状态机根据 action 决定如何处理队列项
	 *
	 * 【状态转换】
	 * ADD_AND_ENTER_MODULE → PROCESS_BLOCK → LEAVE_MODULE
	 */
	const ADD_AND_ENTER_ENTRY_MODULE = 0;  // 添加并进入入口模块
	const ADD_AND_ENTER_MODULE = 1;        // 添加并进入模块
	const ENTER_MODULE = 2;                // 进入模块（已添加）
	const PROCESS_BLOCK = 3;               // 处理依赖块
	const PROCESS_ENTRY_BLOCK = 4;         // 处理入口块
	const LEAVE_MODULE = 5;                // 离开模块

	// ===== 步骤7: 初始化队列 =====

	/**
	 * queue: 主处理队列
	 *
	 * 【结构】
	 * [
	 *   {
	 *     action: ADD_AND_ENTER_MODULE,
	 *     block: DependenciesBlock,
	 *     module: Module,
	 *     chunk: Chunk,
	 *     chunkGroup: ChunkGroup,
	 *     chunkGroupInfo: ChunkGroupInfo
	 *   },
	 *   ...
	 * ]
	 *
	 * 【使用】
	 * BFS 遍历：pop() 从队列取出，push() 添加到队列
	 *
	 * @type {QueueItem[]}
	 */
	let queue = [];

	/**
	 * queueConnect: 等待连接的 ChunkGroup 队列
	 *
	 * 【用途】
	 * 记录需要建立父子关系的 ChunkGroup
	 *
	 * @type {Map<ChunkGroupInfo, Set<ChunkGroupInfo>>}
	 */
	const queueConnect = new Map();

	/**
	 * chunkGroupsForCombining: 需要合并的 ChunkGroup 集合
	 *
	 * 【用途】
	 * 存储有父级依赖的入口点
	 * 这些 ChunkGroup 的可用模块集需要从父级合并
	 *
	 * @type {Set<ChunkGroupInfo>}
	 */
	const chunkGroupsForCombining = new Set();

	// ===== 步骤8: 处理入口点，初始化队列 ⭐⭐⭐ =====
	/**
	 * 遍历所有入口点和初始模块
	 * 为每个入口创建 ChunkGroupInfo
	 * 将入口模块添加到队列
	 *
	 * 【关键】
	 * 这是 BFS 遍历的起点
	 */
	for (const [chunkGroup, modules] of inputEntrypointsAndModules) {
		// ===== 获取入口的运行时 =====
		/**
		 * 运行时（runtime）标识代码执行的环境
		 *
		 * 【多运行时场景】
		 * - 多个独立的入口点
		 * - 每个入口可能有自己的运行时
		 * - 运行时隔离，避免冲突
		 */
		const runtime = getEntryRuntime(
			compilation,
			/** @type {string} */ (chunkGroup.name),
			chunkGroup.options
		);

		// ===== 创建 ChunkGroupInfo 对象 ⭐⭐ =====
		/**
		 * ChunkGroupInfo 存储 ChunkGroup 在遍历过程中的信息
		 *
		 * 【关键属性】
		 * - minAvailableModules: 最小可用模块集（核心优化！）
		 * - runtime: 运行时规范
		 * - children: 子 ChunkGroup
		 * - chunkLoading: 是否支持 chunk 加载
		 * - asyncChunks: 是否支持异步 chunk
		 *
		 * @type {ChunkGroupInfo}
		 */
		const chunkGroupInfo = {
			chunkGroup,                              // ChunkGroup 引用
			runtime,                                 // 运行时
			minAvailableModules: undefined,          // 最小可用模块集（待确定）
			minAvailableModulesOwned: false,         // 是否拥有可用模块集
			availableModulesToBeMerged: [],          // 待合并的可用模块
			skippedItems: undefined,                 // 跳过的项
			resultingAvailableModules: undefined,    // 结果可用模块集
			children: undefined,                     // 子 ChunkGroup
			availableSources: undefined,             // 可用来源
			availableChildren: undefined,            // 可用子级
			preOrderIndex: 0,                        // 前序索引
			postOrderIndex: 0,                       // 后序索引

			// ===== Chunk 加载配置 =====
			/**
			 * chunkLoading: 是否启用 chunk 加载
			 *
			 * 【优先级】
			 * 1. chunkGroup.options.chunkLoading（入口配置）
			 * 2. compilation.outputOptions.chunkLoading（全局配置）
			 *
			 * 【作用】
			 * - false: 不生成 chunk 加载代码（如 Node.js）
			 * - true: 生成 chunk 加载代码（如浏览器）
			 */
			chunkLoading:
				chunkGroup.options.chunkLoading !== undefined
					? chunkGroup.options.chunkLoading !== false
					: compilation.outputOptions.chunkLoading !== false,

			// ===== 异步 Chunk 配置 =====
			/**
			 * asyncChunks: 是否创建异步 chunk
			 *
			 * 【作用】
			 * - false: import() 不创建新 chunk（eager 模式）
			 * - true: import() 创建新 chunk（lazy 模式）
			 */
			asyncChunks:
				chunkGroup.options.asyncChunks !== undefined
					? chunkGroup.options.asyncChunks
					: compilation.outputOptions.asyncChunks !== false
		};

		// ===== 分配 ChunkGroup 索引 =====
		// 每个 ChunkGroup 有唯一的索引（用于排序和标识）
		chunkGroup.index = nextChunkGroupIndex++;

		// ===== 处理有父级的入口点 ⭐ =====
		/**
		 * 某些入口点可能依赖其他入口点（dependOn 配置）
		 *
		 * 【场景】
		 * entry: {
		 *   main: { import: './main.js', dependOn: 'shared' },
		 *   shared: './shared.js'
		 * }
		 *
		 * main 入口依赖 shared 入口
		 */
		if (chunkGroup.getNumberOfParents() > 0) {
			// ===== 有父级的入口点（子入口点）=====
			/**
			 * 子入口点的 minAvailableModules 还未知
			 * 需要等待父入口点确定后才能知道哪些模块已可用
			 *
			 * 【策略】
			 * - 将所有模块添加到 skippedItems
			 * - 标记为待合并
			 * - 等待父级处理完成后再处理
			 */
			const skippedItems = new Set();
			for (const module of modules) {
				skippedItems.add(module);
			}
			chunkGroupInfo.skippedItems = skippedItems;

			// 添加到待合并集合
			chunkGroupsForCombining.add(chunkGroupInfo);
		} else {
			// ===== 无父级的入口点（根入口点）⭐⭐ =====
			/**
			 * 应用从这里开始！
			 *
			 * 【初始状态】
			 * - minAvailableModules = EMPTY_SET（空集合）
			 * - 没有任何模块已加载
			 * - 所有模块都需要包含到 chunk
			 */
			chunkGroupInfo.minAvailableModules = EMPTY_SET;

			// 获取入口 chunk
			const chunk = chunkGroup.getEntrypointChunk();

			// ===== 将入口模块添加到队列 ⭐⭐⭐ =====
			/**
			 * 为每个入口模块创建队列项
			 *
			 * 【队列项】
			 * - action: ADD_AND_ENTER_MODULE（添加并进入）
			 * - block: 模块本身（作为依赖块）
			 * - module: 模块对象
			 * - chunk: 入口 chunk
			 * - chunkGroup: 入口 ChunkGroup
			 * - chunkGroupInfo: ChunkGroup 信息对象
			 *
			 * 【下一步】
			 * 队列处理器会：
			 * 1. 将模块连接到 chunk
			 * 2. 设置模块索引
			 * 3. 处理模块的依赖
			 */
			for (const module of modules) {
				queue.push({
					action: ADD_AND_ENTER_MODULE,  // 操作类型
					block: module,                  // 依赖块（模块本身）
					module,                         // 模块对象
					chunk,                          // 目标 chunk
					chunkGroup,                     // ChunkGroup
					chunkGroupInfo                  // ChunkGroup 信息
				});
			}
		}

		// ===== 保存 ChunkGroupInfo =====
		// 建立 ChunkGroup → ChunkGroupInfo 的映射
		chunkGroupInfoMap.set(chunkGroup, chunkGroupInfo);

		// 如果入口有名称，建立名称映射
		if (chunkGroup.name) {
			namedChunkGroups.set(chunkGroup.name, chunkGroupInfo);
		}
	}
	// ===== 步骤9: 建立入口点的父子关系 ⭐ =====
	/**
	 * 对于有父级的入口点，建立 availableSources 和 availableChildren
	 *
	 * 【作用】
	 * - availableSources: 记录父级 ChunkGroupInfo
	 * - availableChildren: 记录子级 ChunkGroupInfo
	 *
	 * 【用途】
	 * 合并可用模块集时，需要知道父子关系
	 */
	for (const chunkGroupInfo of chunkGroupsForCombining) {
		const { chunkGroup } = chunkGroupInfo;

		// 初始化可用来源集合
		chunkGroupInfo.availableSources = new Set();

		// 遍历所有父级 ChunkGroup
		for (const parent of chunkGroup.parentsIterable) {
			// 获取父级的 ChunkGroupInfo
			const parentChunkGroupInfo =
				/** @type {ChunkGroupInfo} */
				(chunkGroupInfoMap.get(parent));

			// 将父级添加到可用来源
			chunkGroupInfo.availableSources.add(parentChunkGroupInfo);

			// 在父级记录子级（双向连接）
			if (parentChunkGroupInfo.availableChildren === undefined) {
				parentChunkGroupInfo.availableChildren = new Set();
			}
			parentChunkGroupInfo.availableChildren.add(chunkGroupInfo);
		}
	}

	// ===== 步骤10: 反转队列 ⭐ =====
	/**
	 * 为什么要反转？
	 *
	 * 【原因】
	 * - queue.push() 添加到末尾
	 * - queue.pop() 从末尾取出（LIFO）
	 * - 但我们需要 FIFO（先进先出）
	 *
	 * 【解决】
	 * - 添加时都是 push 到末尾
	 * - 反转后，pop 取出的是最先添加的
	 * - 实现了 FIFO 的效果
	 */
	queue.reverse();

	// ===== 步骤11: 初始化辅助数据结构 =====

	/**
	 * outdatedChunkGroupInfo: 过时的 ChunkGroupInfo 集合
	 *
	 * 【用途】
	 * 当 minAvailableModules 缩小时，标记为过时
	 * 需要重新处理
	 *
	 * @type {Set<ChunkGroupInfo>}
	 */
	const outdatedChunkGroupInfo = new Set();

	/**
	 * chunkGroupsForMerging: 需要合并的 ChunkGroup 集合
	 *
	 * 【用途】
	 * 记录需要合并可用模块集的 ChunkGroup
	 *
	 * @type {Set<ChunkGroupInfo>}
	 */
	const chunkGroupsForMerging = new Set();

	/**
	 * queueDelayed: 延迟处理的队列
	 *
	 * 【用途】
	 * 某些队列项可能暂时无法处理
	 * 先放到延迟队列，稍后再试
	 *
	 * @type {QueueItem[]}
	 */
	let queueDelayed = [];

	// ===== 缓冲区（性能优化）⭐ =====
	/**
	 * 这些缓冲区用于临时存储数据
	 * 避免频繁创建数组，提升性能
	 */

	/**
	 * skipConnectionBuffer: 跳过的连接缓冲区
	 *
	 * 【用途】
	 * 临时存储被跳过的模块和连接状态
	 *
	 * @type {[Module, ConnectionState][]}
	 */
	const skipConnectionBuffer = [];

	/**
	 * skipBuffer: 跳过的模块缓冲区
	 *
	 * @type {Module[]}
	 */
	const skipBuffer = [];

	/**
	 * queueBuffer: 队列缓冲区
	 *
	 * 【用途】
	 * 临时存储队列项，然后批量添加到主队列
	 *
	 * @type {QueueItem[]}
	 */
	const queueBuffer = [];

	// ===== 步骤12: 初始化当前处理的对象引用 =====
	/**
	 * 这些变量在队列处理循环中使用
	 * 存储当前正在处理的对象
	 *
	 * 【用途】
	 * - 避免重复从队列项中提取
	 * - 在内部函数中访问
	 */
	/** @type {Module} */
	let module;         // 当前模块
	/** @type {Chunk} */
	let chunk;          // 当前 chunk
	/** @type {ChunkGroup} */
	let chunkGroup;     // 当前 ChunkGroup
	/** @type {DependenciesBlock} */
	let block;          // 当前依赖块
	/** @type {ChunkGroupInfo} */
	let chunkGroupInfo; // 当前 ChunkGroupInfo

	/**
	 * iteratorBlock - 处理异步依赖块（创建新 Chunk 的核心）⭐⭐⭐
	 *
	 * 【作用】
	 * 当遇到异步依赖块时，决定如何处理：
	 * 1. 创建新的 ChunkGroup 和 Chunk
	 * 2. 或者复用已存在的 ChunkGroup
	 * 3. 建立块和 ChunkGroup 的连接
	 * 4. 将块添加到队列等待处理
	 *
	 * 【场景】
	 * - import() 动态导入
	 * - require.ensure()
	 * - 其他异步加载点
	 *
	 * 【关键决策】⭐⭐
	 * 是否创建新 Chunk 取决于：
	 * - asyncChunks 配置
	 * - chunkLoading 配置
	 * - 是否是入口点
	 * - 是否已有同名 ChunkGroup
	 *
	 * @param {AsyncDependenciesBlock} b - 异步依赖块
	 * @returns {void}
	 */
	const iteratorBlock = b => {
		// ===== 步骤1: 查找或创建 ChunkGroupInfo ⭐⭐⭐ =====
		/**
		 * 检查该异步块是否已经处理过
		 *
		 * 【去重】
		 * 同一个异步块只创建一次 ChunkGroup
		 * 例如：
		 * - a.js: import('./lazy.js')
		 * - b.js: import('./lazy.js')
		 *
		 * lazy.js 只创建一个 ChunkGroup，a 和 b 共享
		 */
		let cgi = blockChunkGroups.get(b);

		/** @type {ChunkGroup | undefined} */
		let c;          // 将要使用的 ChunkGroup

		/** @type {Entrypoint | undefined} */
		let entrypoint; // 如果是入口点

		// ===== 提取入口选项（如果是异步入口点）=====
		const entryOptions = b.groupOptions && b.groupOptions.entryOptions;
	// ===== 步骤12: 初始化当前处理的对象引用 =====
	/**
	 * 这些变量在队列处理循环中使用
	 * 存储当前正在处理的对象
	 *
	 * 【用途】
	 * - 避免重复从队列项中提取
	 * - 在内部函数中访问
	 */
	/** @type {Module} */
	let module;         // 当前模块
	/** @type {Chunk} */
	let chunk;          // 当前 chunk
	/** @type {ChunkGroup} */
	let chunkGroup;     // 当前 ChunkGroup
	/** @type {DependenciesBlock} */
	let block;          // 当前依赖块
	/** @type {ChunkGroupInfo} */
	let chunkGroupInfo; // 当前 ChunkGroupInfo

	/**
	 * iteratorBlock - 处理异步依赖块（创建新 Chunk 的核心）⭐⭐⭐
	 *
	 * 【作用】
	 * 当遇到异步依赖块时，决定如何处理：
	 * 1. 创建新的 ChunkGroup 和 Chunk
	 * 2. 或者复用已存在的 ChunkGroup
	 * 3. 建立块和 ChunkGroup 的连接
	 * 4. 将块添加到队列等待处理
	 *
	 * 【场景】
	 * - import() 动态导入
	 * - require.ensure()
	 * - 其他异步加载点
	 *
	 * 【关键决策】⭐⭐
	 * 是否创建新 Chunk 取决于：
	 * - asyncChunks 配置
	 * - chunkLoading 配置
	 * - 是否是入口点
	 * - 是否已有同名 ChunkGroup
	 *
	 * @param {AsyncDependenciesBlock} b - 异步依赖块
	 * @returns {void}
	 */
	const iteratorBlock = b => {
		// ===== 步骤1: 查找或创建 ChunkGroupInfo ⭐⭐⭐ =====
		/**
		 * 检查该异步块是否已经处理过
		 *
		 * 【去重】
		 * 同一个异步块只创建一次 ChunkGroup
		 * 例如：
		 * - a.js: import('./lazy.js')
		 * - b.js: import('./lazy.js')
		 *
		 * lazy.js 只创建一个 ChunkGroup，a 和 b 共享
		 */
		let cgi = blockChunkGroups.get(b);

		/** @type {ChunkGroup | undefined} */
		let c;          // 将要使用的 ChunkGroup

		/** @type {Entrypoint | undefined} */
		let entrypoint; // 如果是入口点

		// ===== 提取入口选项（如果是异步入口点）=====
		const entryOptions = b.groupOptions && b.groupOptions.entryOptions;

		if (cgi === undefined) {
			// ===== 首次遇到这个异步块，需要创建 ChunkGroup =====

			// 提取 chunk 名称（魔法注释 webpackChunkName）
			const chunkName = (b.groupOptions && b.groupOptions.name) || b.chunkName;

			if (entryOptions) {
				// ===== 分支1: 异步入口点（实验性功能）⭐ =====
				/**
				 * 异步入口点：在运行时动态加载的入口
				 *
				 * 【配置示例】
				 * entry: {
				 *   main: {
				 *     import: './main.js',
				 *     asyncEntry: true
				 *   }
				 * }
				 */

				// 检查是否已有同名的异步入口点
				cgi = namedAsyncEntrypoints.get(/** @type {string} */ (chunkName));

				if (!cgi) {
					// ===== 创建新的异步入口点 =====

					// 添加异步入口点到编译
					entrypoint = compilation.addAsyncEntrypoint(
						entryOptions,  // 入口选项
						module,        // 包含该块的模块
						b.loc,         // 源码位置
						b.request      // 请求字符串
					);

					// 分配索引
					entrypoint.index = nextChunkGroupIndex++;

					// ===== 创建 ChunkGroupInfo =====
					cgi = {
						chunkGroup: entrypoint,
						runtime: entrypoint.options.runtime || entrypoint.name,
						minAvailableModules: EMPTY_SET,  // 异步入口点从空集开始
						minAvailableModulesOwned: false,
						availableModulesToBeMerged: [],
						skippedItems: undefined,
						resultingAvailableModules: undefined,
						children: undefined,
						availableSources: undefined,
						availableChildren: undefined,
						preOrderIndex: 0,
						postOrderIndex: 0,
						// 继承或使用入口选项的配置
						chunkLoading:
							entryOptions.chunkLoading !== undefined
								? entryOptions.chunkLoading !== false
								: chunkGroupInfo.chunkLoading,
						asyncChunks:
							entryOptions.asyncChunks !== undefined
								? entryOptions.asyncChunks
								: chunkGroupInfo.asyncChunks
					};

					// 保存映射
					chunkGroupInfoMap.set(entrypoint, cgi);

					// 连接块和 ChunkGroup
					chunkGraph.connectBlockAndChunkGroup(b, entrypoint);

					// 如果有名称，保存命名映射
					if (chunkName) {
						namedAsyncEntrypoints.set(chunkName, cgi);
					}
				} else {
					// ===== 异步入口点已存在，复用 =====
					entrypoint = /** @type {Entrypoint} */ (cgi.chunkGroup);

					// TODO: 合并 entryOptions

					// 添加来源（记录谁引用了这个入口点）
					entrypoint.addOrigin(module, b.loc, b.request);

					// 连接块和 ChunkGroup
					chunkGraph.connectBlockAndChunkGroup(b, entrypoint);
				}

				// ===== 将块添加到延迟队列 =====
				/**
				 * 异步入口点需要延迟处理
				 *
				 * 【原因】
				 * 需要先处理完当前 ChunkGroup
				 * 再处理异步入口点
				 */
				queueDelayed.push({
					action: PROCESS_ENTRY_BLOCK,    // 处理入口块
					block: b,
					module: module,
					chunk: entrypoint.chunks[0],
					chunkGroup: entrypoint,
					chunkGroupInfo: cgi
				});
			} else if (!chunkGroupInfo.asyncChunks || !chunkGroupInfo.chunkLoading) {
				// ===== 分支2: 不创建异步 Chunk（eager 模式）⭐⭐ =====
				/**
				 * 条件：asyncChunks = false 或 chunkLoading = false
				 *
				 * 【行为】
				 * - 不创建新的 ChunkGroup
				 * - 模块放到当前 chunk
				 * - import() 变成同步加载
				 *
				 * 【场景】
				 * - Node.js 环境（无需 chunk 加载）
				 * - eager 模式配置
				 *
				 * 【队列项】
				 * action: PROCESS_BLOCK（处理块，不是入口块）
				 */
				queue.push({
					action: PROCESS_BLOCK,
					block: b,
					module: module,
					chunk,          // 使用当前 chunk
					chunkGroup,     // 使用当前 ChunkGroup
					chunkGroupInfo
				});
			} else {
				// ===== 分支3: 创建新的异步 Chunk（lazy 模式）⭐⭐⭐ =====
				/**
				 * 这是最常见的情况：import() 创建新 Chunk
				 *
				 * 【条件】
				 * - asyncChunks = true
				 * - chunkLoading = true
				 * - 不是入口点
				 *
				 * 【行为】
				 * - 创建新的 ChunkGroup
				 * - 创建新的 Chunk
				 * - 建立父子关系
				 */

				// 检查是否已有同名的 ChunkGroup
				cgi = chunkName && namedChunkGroups.get(chunkName);

				if (!cgi) {
					// ===== 创建新的 ChunkGroup 和 Chunk ⭐⭐⭐ =====
					/**
					 * 这是创建新 Chunk 的关键代码！
					 *
					 * 【创建内容】
					 * - ChunkGroup: 管理一组 Chunk
					 * - Chunk: 实际的代码块
					 *
					 * 【参数】
					 * - groupOptions: 魔法注释选项
					 * - module: 包含该块的模块
					 * - loc: 源码位置
					 * - request: 请求字符串
					 */
					c = compilation.addChunkInGroup(
						b.groupOptions || b.chunkName,
						module,
						b.loc,
						b.request
					);

					// 分配索引
					c.index = nextChunkGroupIndex++;

					// ===== 创建 ChunkGroupInfo ⭐ =====
					cgi = {
						chunkGroup: c,
						runtime: chunkGroupInfo.runtime,  // 继承父级的运行时
						minAvailableModules: undefined,   // 稍后计算
						minAvailableModulesOwned: undefined,
						availableModulesToBeMerged: [],
						skippedItems: undefined,
						resultingAvailableModules: undefined,
						children: undefined,
						availableSources: undefined,
						availableChildren: undefined,
						preOrderIndex: 0,
						postOrderIndex: 0,
						chunkLoading: chunkGroupInfo.chunkLoading,  // 继承配置
						asyncChunks: chunkGroupInfo.asyncChunks      // 继承配置
					};

					// 记录创建的 ChunkGroup
					allCreatedChunkGroups.add(c);

					// 保存映射
					chunkGroupInfoMap.set(c, cgi);

					// 如果有名称，保存命名映射
					if (chunkName) {
						namedChunkGroups.set(chunkName, cgi);
					}
				} else {
					// ===== ChunkGroup 已存在，复用 ⭐ =====
					c = cgi.chunkGroup;

					// ===== 检查冲突：异步块指向初始 Chunk ⭐ =====
					/**
					 * 问题场景：
					 * - 入口 chunk 名为 'main'
					 * - import(/* webpackChunkName: "main" *\/ './lazy.js')
					 * - 异步块试图使用入口 chunk 的名称
					 *
					 * 【错误】
					 * 异步依赖不能指向初始 chunk
					 * 会导致循环引用和加载问题
					 */
					if (c.isInitial()) {
						// 报错：异步依赖指向初始 chunk
						compilation.errors.push(
							new AsyncDependencyToInitialChunkError(
								/** @type {string} */ (chunkName),
								module,
								b.loc
							)
						);
						// 回退到当前 ChunkGroup
						c = chunkGroup;
					} else {
						// ChunkGroup 存在且不是初始的，可以复用

						// 合并选项（如果有新的配置）
						c.addOptions(b.groupOptions);
					}

					// 添加来源（记录谁引用了这个 ChunkGroup）
					c.addOrigin(module, b.loc, b.request);
				}

				// ===== 初始化块连接列表 =====
				// 用于稍后建立父子关系
				blockConnections.set(b, []);
			}

			// ===== 保存块到 ChunkGroupInfo 的映射 =====
			blockChunkGroups.set(b, /** @type {ChunkGroupInfo} */ (cgi));
		} else if (entryOptions) {
			// ===== 块已处理过，且是入口点 =====
			entrypoint = /** @type {Entrypoint} */ (cgi.chunkGroup);
		} else {
			// ===== 块已处理过，不是入口点 =====
			c = cgi.chunkGroup;
		}

		// ===== 步骤2: 建立块连接（如果创建了新 ChunkGroup）⭐⭐ =====
		if (c !== undefined) {
			// c 不是 undefined 说明创建了或复用了 ChunkGroup

			// ===== 2.1: 存储块连接信息 =====
			/**
			 * 记录异步块的连接关系
			 *
			 * 【结构】
			 * {
			 *   originChunkGroupInfo: 父级 ChunkGroupInfo,
			 *   chunkGroup: 子级 ChunkGroup
			 * }
			 *
			 * 【用途】
			 * 稍后在 connectChunkGroups 阶段建立父子关系
			 */
			blockConnections.get(b).push({
				originChunkGroupInfo: chunkGroupInfo,  // 父级（当前）
				chunkGroup: c                           // 子级（新创建的）
			});

			// ===== 2.2: 记录需要连接的 ChunkGroup =====
			/**
			 * queueConnect 记录需要建立父子关系的 ChunkGroup 对
			 *
			 * 【结构】
			 * Map<父 ChunkGroupInfo, Set<子 ChunkGroupInfo>>
			 *
			 * 【用途】
			 * 批量处理连接，优化性能
			 */
			let connectList = queueConnect.get(chunkGroupInfo);
			if (connectList === undefined) {
				connectList = new Set();
				queueConnect.set(chunkGroupInfo, connectList);
			}
			// 添加子 ChunkGroupInfo
			connectList.add(/** @type {ChunkGroupInfo} */ (cgi));

			// ===== 2.3: 将块添加到延迟队列 ⭐ =====
			/**
			 * 异步块添加到延迟队列，稍后处理
			 *
			 * 【原因】
			 * - 需要先完成当前 ChunkGroup 的处理
			 * - 然后再处理异步块
			 * - 保证正确的处理顺序
			 *
			 * 【队列项】
			 * action: PROCESS_BLOCK（处理依赖块）
			 */
			queueDelayed.push({
				action: PROCESS_BLOCK,
				block: b,
				module: module,
				chunk: c.chunks[0],    // 新 ChunkGroup 的第一个 chunk
				chunkGroup: c,
				chunkGroupInfo: /** @type {ChunkGroupInfo} */ (cgi)
			});
		} else if (entrypoint !== undefined) {
			// ===== 处理异步入口点的特殊情况 =====
			/**
			 * 将异步入口点添加到当前 ChunkGroup
			 *
			 * 【作用】
			 * 建立入口点之间的关系
			 */
			chunkGroupInfo.chunkGroup.addAsyncEntrypoint(entrypoint);
		}
	};

	/**
	 * processBlock - 处理依赖块（遍历模块的依赖）⭐⭐⭐
	 *
	 * 【作用】
	 * 处理模块的依赖块，决定哪些模块需要添加到当前 Chunk
	 *
	 * 【执行内容】
	 * 1. 获取块的所有模块
	 * 2. 检查每个模块是否需要包含
	 * 3. 跳过已可用的模块（避免重复）
	 * 4. 将需要的模块添加到队列
	 * 5. 递归处理嵌套的异步块
	 *
	 * 【关键优化】⭐⭐
	 * minAvailableModules：跟踪已加载的模块
	 * - 如果模块已在父 chunk 中 → 跳过
	 * - 避免重复包含相同模块
	 *
	 * @param {DependenciesBlock} block - 要处理的依赖块
	 * @returns {void}
	 */
	const processBlock = block => {
		// 统计：处理的块数
		statProcessedBlocks++;

		// ===== 步骤1: 获取块的模块列表 ⭐⭐ =====
		const blockModules = getBlockModules(block, chunkGroupInfo.runtime);

		if (blockModules !== undefined) {
			// 获取最小可用模块集
			const { minAvailableModules } = chunkGroupInfo;

			// ===== 步骤2: 遍历块的所有模块 ⭐⭐⭐ =====
			/**
			 * blockModules 格式：[module1, state1, module2, state2, ...]
			 * - 步长为 2
			 * - i: 模块索引（偶数）
			 * - i+1: 状态索引（奇数）
			 */
			for (let i = 0; i < blockModules.length; i += 2) {
				// 提取模块（偶数索引）
				const refModule = /** @type {Module} */ (blockModules[i]);

				// ===== 检查1: 模块是否已在 chunk 中 ⭐ =====
				if (chunkGraph.isModuleInChunk(refModule, chunk)) {
					// 模块已连接，跳过（避免重复）
					continue;
				}

				// 提取连接状态（奇数索引）
				const activeState = /** @type {ConnectionState} */ (
					blockModules[i + 1]
				);

				// ===== 检查2: 处理非始终激活的连接 ⭐ =====
				if (activeState !== true) {
					// 连接状态不是 true（false 或条件函数）
					skipConnectionBuffer.push([refModule, activeState]);
					if (activeState === false) continue;
				}

				// ===== 检查3: 模块是否已可用（核心优化！）⭐⭐⭐ =====
				if (
					activeState === true &&
					(minAvailableModules.has(refModule) ||
						minAvailableModules.plus.has(refModule))
				) {
					/**
					 * 模块已在父 chunk 中可用
					 *
					 * 【优化】
					 * - 父 chunk 已包含该模块
					 * - 当前 chunk 不需要重复包含
					 * - 运行时直接使用父 chunk 的模块
					 *
					 * 【效果】
					 * 减少 30-50% 的重复代码
					 */
					skipBuffer.push(refModule);
					continue;
				}

				// ===== 模块需要添加到当前 chunk ⭐⭐⭐ =====
				/**
				 * 将模块添加到队列缓冲区
				 *
				 * 【action 选择】
				 * - activeState === true: ADD_AND_ENTER_MODULE
				 *   模块始终激活，直接添加并进入
				 *
				 * - activeState !== true: PROCESS_BLOCK
				 *   模块条件激活，需要进一步处理
				 *
				 * 【重要】
				 * 添加到缓冲区，稍后反转顺序
				 * 这对循环依赖的正确处理很关键
				 */
				queueBuffer.push({
					action: activeState === true ? ADD_AND_ENTER_MODULE : PROCESS_BLOCK,
					block: refModule,
					module: refModule,
					chunk,
					chunkGroup,
					chunkGroupInfo
				});
			}

			// ===== 步骤3: 处理缓冲区（反转顺序）⭐⭐ =====

			// === 3.1: 处理跳过的连接 ===
			if (skipConnectionBuffer.length > 0) {
				let { skippedModuleConnections } = chunkGroupInfo;
				if (skippedModuleConnections === undefined) {
					chunkGroupInfo.skippedModuleConnections = skippedModuleConnections =
						new Set();
				}
				// 反转顺序添加
				for (let i = skipConnectionBuffer.length - 1; i >= 0; i--) {
					skippedModuleConnections.add(skipConnectionBuffer[i]);
				}
				skipConnectionBuffer.length = 0;
			}

			// === 3.2: 处理跳过的模块 ===
			if (skipBuffer.length > 0) {
				let { skippedItems } = chunkGroupInfo;
				if (skippedItems === undefined) {
					chunkGroupInfo.skippedItems = skippedItems = new Set();
				}
				// 反转顺序添加
				for (let i = skipBuffer.length - 1; i >= 0; i--) {
					skippedItems.add(skipBuffer[i]);
				}
				skipBuffer.length = 0;
			}

			// === 3.3: 将缓冲区添加到主队列 ⭐ ===
			if (queueBuffer.length > 0) {
				// 反转顺序添加到主队列
				for (let i = queueBuffer.length - 1; i >= 0; i--) {
					queue.push(queueBuffer[i]);
				}
				queueBuffer.length = 0;
			}
		}

		// ===== 步骤4: 递归处理嵌套的异步块 ⭐⭐⭐ =====
		/**
		 * 遍历块的所有嵌套块
		 * 通常是 import() 等异步依赖块
		 */
		for (const b of block.blocks) {
			iteratorBlock(b);
		}

		// ===== 步骤5: 标记包含嵌套块的块 =====
		if (block.blocks.length > 0 && module !== block) {
			blocksWithNestedBlocks.add(block);
		}
	};

	/**
	 * @param {DependenciesBlock} block the block
	 * @returns {void}
	 */
	const processEntryBlock = block => {
		statProcessedBlocks++;
		// get prepared block info
		const blockModules = getBlockModules(block, chunkGroupInfo.runtime);

		if (blockModules !== undefined) {
			// Traverse all referenced modules
			for (let i = 0; i < blockModules.length; i += 2) {
				const refModule = /** @type {Module} */ (blockModules[i]);
				const activeState = /** @type {ConnectionState} */ (
					blockModules[i + 1]
				);
				// enqueue, then add and enter to be in the correct order
				// this is relevant with circular dependencies
				queueBuffer.push({
					action:
						activeState === true ? ADD_AND_ENTER_ENTRY_MODULE : PROCESS_BLOCK,
					block: refModule,
					module: refModule,
					chunk,
					chunkGroup,
					chunkGroupInfo
				});
			}
			// Add buffered items in reverse order
			if (queueBuffer.length > 0) {
				for (let i = queueBuffer.length - 1; i >= 0; i--) {
					queue.push(queueBuffer[i]);
				}
				queueBuffer.length = 0;
			}
		}

		// Traverse all Blocks
		for (const b of block.blocks) {
			iteratorBlock(b);
		}

		if (block.blocks.length > 0 && module !== block) {
			blocksWithNestedBlocks.add(block);
		}
	};

	const processQueue = () => {
		while (queue.length) {
			statProcessedQueueItems++;
			const queueItem = /** @type {QueueItem} */ (queue.pop());
			module = queueItem.module;
			block = queueItem.block;
			chunk = queueItem.chunk;
			chunkGroup = queueItem.chunkGroup;
			chunkGroupInfo = queueItem.chunkGroupInfo;

			switch (queueItem.action) {
				case ADD_AND_ENTER_ENTRY_MODULE:
					chunkGraph.connectChunkAndEntryModule(
						chunk,
						module,
						/** @type {Entrypoint} */ (chunkGroup)
					);
				// fallthrough
				case ADD_AND_ENTER_MODULE: {
					if (chunkGraph.isModuleInChunk(module, chunk)) {
						// already connected, skip it
						break;
					}
					// We connect Module and Chunk
					chunkGraph.connectChunkAndModule(chunk, module);
				}
				// fallthrough
				case ENTER_MODULE: {
					const index = chunkGroup.getModulePreOrderIndex(module);
					if (index === undefined) {
						chunkGroup.setModulePreOrderIndex(
							module,
							chunkGroupInfo.preOrderIndex++
						);
					}

					if (
						moduleGraph.setPreOrderIndexIfUnset(
							module,
							nextFreeModulePreOrderIndex
						)
					) {
						nextFreeModulePreOrderIndex++;
					}

					// reuse queueItem
					queueItem.action = LEAVE_MODULE;
					queue.push(queueItem);
				}
				// fallthrough
				case PROCESS_BLOCK: {
					processBlock(block);
					break;
				}
				case PROCESS_ENTRY_BLOCK: {
					processEntryBlock(block);
					break;
				}
				case LEAVE_MODULE: {
					const index = chunkGroup.getModulePostOrderIndex(module);
					if (index === undefined) {
						chunkGroup.setModulePostOrderIndex(
							module,
							chunkGroupInfo.postOrderIndex++
						);
					}

					if (
						moduleGraph.setPostOrderIndexIfUnset(
							module,
							nextFreeModulePostOrderIndex
						)
					) {
						nextFreeModulePostOrderIndex++;
					}
					break;
				}
			}
		}
	};

	const calculateResultingAvailableModules = chunkGroupInfo => {
		if (chunkGroupInfo.resultingAvailableModules)
			return chunkGroupInfo.resultingAvailableModules;

		const minAvailableModules = chunkGroupInfo.minAvailableModules;

		// Create a new Set of available modules at this point
		// We want to be as lazy as possible. There are multiple ways doing this:
		// Note that resultingAvailableModules is stored as "(a) + (b)" as it's a ModuleSetPlus
		// - resultingAvailableModules = (modules of chunk) + (minAvailableModules + minAvailableModules.plus)
		// - resultingAvailableModules = (minAvailableModules + modules of chunk) + (minAvailableModules.plus)
		// We choose one depending on the size of minAvailableModules vs minAvailableModules.plus

		let resultingAvailableModules;
		if (minAvailableModules.size > minAvailableModules.plus.size) {
			// resultingAvailableModules = (modules of chunk) + (minAvailableModules + minAvailableModules.plus)
			resultingAvailableModules =
				/** @type {Set<Module> & {plus: Set<Module>}} */ (new Set());
			for (const module of minAvailableModules.plus)
				minAvailableModules.add(module);
			minAvailableModules.plus = EMPTY_SET;
			resultingAvailableModules.plus = minAvailableModules;
			chunkGroupInfo.minAvailableModulesOwned = false;
		} else {
			// resultingAvailableModules = (minAvailableModules + modules of chunk) + (minAvailableModules.plus)
			resultingAvailableModules =
				/** @type {Set<Module> & {plus: Set<Module>}} */ (
					new Set(minAvailableModules)
				);
			resultingAvailableModules.plus = minAvailableModules.plus;
		}

		// add the modules from the chunk group to the set
		for (const chunk of chunkGroupInfo.chunkGroup.chunks) {
			for (const m of chunkGraph.getChunkModulesIterable(chunk)) {
				resultingAvailableModules.add(m);
			}
		}
		return (chunkGroupInfo.resultingAvailableModules =
			resultingAvailableModules);
	};

	const processConnectQueue = () => {
		// Figure out new parents for chunk groups
		// to get new available modules for these children
		for (const [chunkGroupInfo, targets] of queueConnect) {
			// 1. Add new targets to the list of children
			if (chunkGroupInfo.children === undefined) {
				chunkGroupInfo.children = targets;
			} else {
				for (const target of targets) {
					chunkGroupInfo.children.add(target);
				}
			}

			// 2. Calculate resulting available modules
			const resultingAvailableModules =
				calculateResultingAvailableModules(chunkGroupInfo);

			const runtime = chunkGroupInfo.runtime;

			// 3. Update chunk group info
			for (const target of targets) {
				target.availableModulesToBeMerged.push(resultingAvailableModules);
				chunkGroupsForMerging.add(target);
				const oldRuntime = target.runtime;
				const newRuntime = mergeRuntime(oldRuntime, runtime);
				if (oldRuntime !== newRuntime) {
					target.runtime = newRuntime;
					outdatedChunkGroupInfo.add(target);
				}
			}

			statConnectedChunkGroups += targets.size;
		}
		queueConnect.clear();
	};

	const processChunkGroupsForMerging = () => {
		statProcessedChunkGroupsForMerging += chunkGroupsForMerging.size;

		// Execute the merge
		for (const info of chunkGroupsForMerging) {
			const availableModulesToBeMerged = info.availableModulesToBeMerged;
			let cachedMinAvailableModules = info.minAvailableModules;

			statMergedAvailableModuleSets += availableModulesToBeMerged.length;

			// 1. Get minimal available modules
			// It doesn't make sense to traverse a chunk again with more available modules.
			// This step calculates the minimal available modules and skips traversal when
			// the list didn't shrink.
			if (availableModulesToBeMerged.length > 1) {
				availableModulesToBeMerged.sort(bySetSize);
			}
			let changed = false;
			merge: for (const availableModules of availableModulesToBeMerged) {
				if (cachedMinAvailableModules === undefined) {
					cachedMinAvailableModules = availableModules;
					info.minAvailableModules = cachedMinAvailableModules;
					info.minAvailableModulesOwned = false;
					changed = true;
				} else {
					if (info.minAvailableModulesOwned) {
						// We own it and can modify it
						if (cachedMinAvailableModules.plus === availableModules.plus) {
							for (const m of cachedMinAvailableModules) {
								if (!availableModules.has(m)) {
									cachedMinAvailableModules.delete(m);
									changed = true;
								}
							}
						} else {
							for (const m of cachedMinAvailableModules) {
								if (!availableModules.has(m) && !availableModules.plus.has(m)) {
									cachedMinAvailableModules.delete(m);
									changed = true;
								}
							}
							for (const m of cachedMinAvailableModules.plus) {
								if (!availableModules.has(m) && !availableModules.plus.has(m)) {
									// We can't remove modules from the plus part
									// so we need to merge plus into the normal part to allow modifying it
									const iterator =
										cachedMinAvailableModules.plus[Symbol.iterator]();
									// fast forward add all modules until m
									/** @type {IteratorResult<Module>} */
									let it;
									while (!(it = iterator.next()).done) {
										const module = it.value;
										if (module === m) break;
										cachedMinAvailableModules.add(module);
									}
									// check the remaining modules before adding
									while (!(it = iterator.next()).done) {
										const module = it.value;
										if (
											availableModules.has(module) ||
											availableModules.plus.has(module)
										) {
											cachedMinAvailableModules.add(module);
										}
									}
									cachedMinAvailableModules.plus = EMPTY_SET;
									changed = true;
									continue merge;
								}
							}
						}
					} else if (cachedMinAvailableModules.plus === availableModules.plus) {
						// Common and fast case when the plus part is shared
						// We only need to care about the normal part
						if (availableModules.size < cachedMinAvailableModules.size) {
							// the new availableModules is smaller so it's faster to
							// fork from the new availableModules
							statForkedAvailableModules++;
							statForkedAvailableModulesCount += availableModules.size;
							statForkedMergedModulesCount += cachedMinAvailableModules.size;
							// construct a new Set as intersection of cachedMinAvailableModules and availableModules
							const newSet = /** @type {ModuleSetPlus} */ (new Set());
							newSet.plus = availableModules.plus;
							for (const m of availableModules) {
								if (cachedMinAvailableModules.has(m)) {
									newSet.add(m);
								}
							}
							statForkedResultModulesCount += newSet.size;
							cachedMinAvailableModules = newSet;
							info.minAvailableModulesOwned = true;
							info.minAvailableModules = newSet;
							changed = true;
							continue merge;
						}
						for (const m of cachedMinAvailableModules) {
							if (!availableModules.has(m)) {
								// cachedMinAvailableModules need to be modified
								// but we don't own it
								statForkedAvailableModules++;
								statForkedAvailableModulesCount +=
									cachedMinAvailableModules.size;
								statForkedMergedModulesCount += availableModules.size;
								// construct a new Set as intersection of cachedMinAvailableModules and availableModules
								// as the plus part is equal we can just take over this one
								const newSet = /** @type {ModuleSetPlus} */ (new Set());
								newSet.plus = availableModules.plus;
								const iterator = cachedMinAvailableModules[Symbol.iterator]();
								// fast forward add all modules until m
								/** @type {IteratorResult<Module>} */
								let it;
								while (!(it = iterator.next()).done) {
									const module = it.value;
									if (module === m) break;
									newSet.add(module);
								}
								// check the remaining modules before adding
								while (!(it = iterator.next()).done) {
									const module = it.value;
									if (availableModules.has(module)) {
										newSet.add(module);
									}
								}
								statForkedResultModulesCount += newSet.size;
								cachedMinAvailableModules = newSet;
								info.minAvailableModulesOwned = true;
								info.minAvailableModules = newSet;
								changed = true;
								continue merge;
							}
						}
					} else {
						for (const m of cachedMinAvailableModules) {
							if (!availableModules.has(m) && !availableModules.plus.has(m)) {
								// cachedMinAvailableModules need to be modified
								// but we don't own it
								statForkedAvailableModules++;
								statForkedAvailableModulesCount +=
									cachedMinAvailableModules.size;
								statForkedAvailableModulesCountPlus +=
									cachedMinAvailableModules.plus.size;
								statForkedMergedModulesCount += availableModules.size;
								statForkedMergedModulesCountPlus += availableModules.plus.size;
								// construct a new Set as intersection of cachedMinAvailableModules and availableModules
								const newSet = /** @type {ModuleSetPlus} */ (new Set());
								newSet.plus = EMPTY_SET;
								const iterator = cachedMinAvailableModules[Symbol.iterator]();
								// fast forward add all modules until m
								/** @type {IteratorResult<Module>} */
								let it;
								while (!(it = iterator.next()).done) {
									const module = it.value;
									if (module === m) break;
									newSet.add(module);
								}
								// check the remaining modules before adding
								while (!(it = iterator.next()).done) {
									const module = it.value;
									if (
										availableModules.has(module) ||
										availableModules.plus.has(module)
									) {
										newSet.add(module);
									}
								}
								// also check all modules in cachedMinAvailableModules.plus
								for (const module of cachedMinAvailableModules.plus) {
									if (
										availableModules.has(module) ||
										availableModules.plus.has(module)
									) {
										newSet.add(module);
									}
								}
								statForkedResultModulesCount += newSet.size;
								cachedMinAvailableModules = newSet;
								info.minAvailableModulesOwned = true;
								info.minAvailableModules = newSet;
								changed = true;
								continue merge;
							}
						}
						for (const m of cachedMinAvailableModules.plus) {
							if (!availableModules.has(m) && !availableModules.plus.has(m)) {
								// cachedMinAvailableModules need to be modified
								// but we don't own it
								statForkedAvailableModules++;
								statForkedAvailableModulesCount +=
									cachedMinAvailableModules.size;
								statForkedAvailableModulesCountPlus +=
									cachedMinAvailableModules.plus.size;
								statForkedMergedModulesCount += availableModules.size;
								statForkedMergedModulesCountPlus += availableModules.plus.size;
								// construct a new Set as intersection of cachedMinAvailableModules and availableModules
								// we already know that all modules directly from cachedMinAvailableModules are in availableModules too
								const newSet = /** @type {ModuleSetPlus} */ (
									new Set(cachedMinAvailableModules)
								);
								newSet.plus = EMPTY_SET;
								const iterator =
									cachedMinAvailableModules.plus[Symbol.iterator]();
								// fast forward add all modules until m
								/** @type {IteratorResult<Module>} */
								let it;
								while (!(it = iterator.next()).done) {
									const module = it.value;
									if (module === m) break;
									newSet.add(module);
								}
								// check the remaining modules before adding
								while (!(it = iterator.next()).done) {
									const module = it.value;
									if (
										availableModules.has(module) ||
										availableModules.plus.has(module)
									) {
										newSet.add(module);
									}
								}
								statForkedResultModulesCount += newSet.size;
								cachedMinAvailableModules = newSet;
								info.minAvailableModulesOwned = true;
								info.minAvailableModules = newSet;
								changed = true;
								continue merge;
							}
						}
					}
				}
			}
			availableModulesToBeMerged.length = 0;
			if (changed) {
				info.resultingAvailableModules = undefined;
				outdatedChunkGroupInfo.add(info);
			}
		}
		chunkGroupsForMerging.clear();
	};

	const processChunkGroupsForCombining = () => {
		for (const info of chunkGroupsForCombining) {
			for (const source of /** @type {Set<ChunkGroupInfo>} */ (
				info.availableSources
			)) {
				if (!source.minAvailableModules) {
					chunkGroupsForCombining.delete(info);
					break;
				}
			}
		}
		for (const info of chunkGroupsForCombining) {
			const availableModules = /** @type {ModuleSetPlus} */ (new Set());
			availableModules.plus = EMPTY_SET;
			const mergeSet = set => {
				if (set.size > availableModules.plus.size) {
					for (const item of availableModules.plus) availableModules.add(item);
					availableModules.plus = set;
				} else {
					for (const item of set) availableModules.add(item);
				}
			};
			// combine minAvailableModules from all resultingAvailableModules
			for (const source of /** @type {Set<ChunkGroupInfo>} */ (
				info.availableSources
			)) {
				const resultingAvailableModules =
					calculateResultingAvailableModules(source);
				mergeSet(resultingAvailableModules);
				mergeSet(resultingAvailableModules.plus);
			}
			info.minAvailableModules = availableModules;
			info.minAvailableModulesOwned = false;
			info.resultingAvailableModules = undefined;
			outdatedChunkGroupInfo.add(info);
		}
		chunkGroupsForCombining.clear();
	};

	const processOutdatedChunkGroupInfo = () => {
		statChunkGroupInfoUpdated += outdatedChunkGroupInfo.size;
		// Revisit skipped elements
		for (const info of outdatedChunkGroupInfo) {
			// 1. Reconsider skipped items
			if (info.skippedItems !== undefined) {
				const minAvailableModules =
					/** @type {ModuleSetPlus} */
					(info.minAvailableModules);
				for (const module of info.skippedItems) {
					if (
						!minAvailableModules.has(module) &&
						!minAvailableModules.plus.has(module)
					) {
						queue.push({
							action: ADD_AND_ENTER_MODULE,
							block: module,
							module,
							chunk: info.chunkGroup.chunks[0],
							chunkGroup: info.chunkGroup,
							chunkGroupInfo: info
						});
						info.skippedItems.delete(module);
					}
				}
			}

			// 2. Reconsider skipped connections
			if (info.skippedModuleConnections !== undefined) {
				const minAvailableModules =
					/** @type {ModuleSetPlus} */
					(info.minAvailableModules);
				for (const entry of info.skippedModuleConnections) {
					const [module, activeState] = entry;
					if (activeState === false) continue;
					if (activeState === true) {
						info.skippedModuleConnections.delete(entry);
					}
					if (
						activeState === true &&
						(minAvailableModules.has(module) ||
							minAvailableModules.plus.has(module))
					) {
						info.skippedItems.add(module);
						continue;
					}
					queue.push({
						action: activeState === true ? ADD_AND_ENTER_MODULE : PROCESS_BLOCK,
						block: module,
						module,
						chunk: info.chunkGroup.chunks[0],
						chunkGroup: info.chunkGroup,
						chunkGroupInfo: info
					});
				}
			}

			// 2. Reconsider children chunk groups
			if (info.children !== undefined) {
				statChildChunkGroupsReconnected += info.children.size;
				for (const cgi of info.children) {
					let connectList = queueConnect.get(info);
					if (connectList === undefined) {
						connectList = new Set();
						queueConnect.set(info, connectList);
					}
					connectList.add(cgi);
				}
			}

			// 3. Reconsider chunk groups for combining
			if (info.availableChildren !== undefined) {
				for (const cgi of info.availableChildren) {
					chunkGroupsForCombining.add(cgi);
				}
			}
		}
		outdatedChunkGroupInfo.clear();
	};

	// Iterative traversal of the Module graph
	// Recursive would be simpler to write but could result in Stack Overflows
	while (queue.length || queueConnect.size) {
		logger.time("visitModules: visiting");
		processQueue();
		logger.timeAggregateEnd("visitModules: prepare");
		logger.timeEnd("visitModules: visiting");

		if (chunkGroupsForCombining.size > 0) {
			logger.time("visitModules: combine available modules");
			processChunkGroupsForCombining();
			logger.timeEnd("visitModules: combine available modules");
		}

		if (queueConnect.size > 0) {
			logger.time("visitModules: calculating available modules");
			processConnectQueue();
			logger.timeEnd("visitModules: calculating available modules");

			if (chunkGroupsForMerging.size > 0) {
				logger.time("visitModules: merging available modules");
				processChunkGroupsForMerging();
				logger.timeEnd("visitModules: merging available modules");
			}
		}

		if (outdatedChunkGroupInfo.size > 0) {
			logger.time("visitModules: check modules for revisit");
			processOutdatedChunkGroupInfo();
			logger.timeEnd("visitModules: check modules for revisit");
		}

		// Run queueDelayed when all items of the queue are processed
		// This is important to get the global indexing correct
		// Async blocks should be processed after all sync blocks are processed
		if (queue.length === 0) {
			const tempQueue = queue;
			queue = queueDelayed.reverse();
			queueDelayed = tempQueue;
		}
	}

	logger.log(
		`${statProcessedQueueItems} queue items processed (${statProcessedBlocks} blocks)`
	);
	logger.log(`${statConnectedChunkGroups} chunk groups connected`);
	logger.log(
		`${statProcessedChunkGroupsForMerging} chunk groups processed for merging (${statMergedAvailableModuleSets} module sets, ${statForkedAvailableModules} forked, ${statForkedAvailableModulesCount} + ${statForkedAvailableModulesCountPlus} modules forked, ${statForkedMergedModulesCount} + ${statForkedMergedModulesCountPlus} modules merged into fork, ${statForkedResultModulesCount} resulting modules)`
	);
	logger.log(
		`${statChunkGroupInfoUpdated} chunk group info updated (${statChildChunkGroupsReconnected} already connected chunk groups reconnected)`
	);
};

/**
 *
 * @param {Compilation} compilation the compilation
 * @param {Set<DependenciesBlock>} blocksWithNestedBlocks flag for blocks that have nested blocks
 * @param {Map<AsyncDependenciesBlock, BlockChunkGroupConnection[]>} blockConnections connection for blocks
 * @param {Map<ChunkGroup, ChunkGroupInfo>} chunkGroupInfoMap mapping from chunk group to available modules
 */
const connectChunkGroups = (
	compilation,
	blocksWithNestedBlocks,
	blockConnections,
	chunkGroupInfoMap
) => {
	const { chunkGraph } = compilation;

	/**
	 * Helper function to check if all modules of a chunk are available
	 *
	 * @param {ChunkGroup} chunkGroup the chunkGroup to scan
	 * @param {ModuleSetPlus} availableModules the comparator set
	 * @returns {boolean} return true if all modules of a chunk are available
	 */
	const areModulesAvailable = (chunkGroup, availableModules) => {
		for (const chunk of chunkGroup.chunks) {
			for (const module of chunkGraph.getChunkModulesIterable(chunk)) {
				if (!availableModules.has(module) && !availableModules.plus.has(module))
					return false;
			}
		}
		return true;
	};

	// For each edge in the basic chunk graph
	for (const [block, connections] of blockConnections) {
		// 1. Check if connection is needed
		// When none of the dependencies need to be connected
		// we can skip all of them
		// It's not possible to filter each item so it doesn't create inconsistent
		// connections and modules can only create one version
		// TODO maybe decide this per runtime
		if (
			// TODO is this needed?
			!blocksWithNestedBlocks.has(block) &&
			connections.every(({ chunkGroup, originChunkGroupInfo }) =>
				areModulesAvailable(
					chunkGroup,
					originChunkGroupInfo.resultingAvailableModules
				)
			)
		) {
			continue;
		}

		// 2. Foreach edge
		for (let i = 0; i < connections.length; i++) {
			const { chunkGroup, originChunkGroupInfo } = connections[i];

			// 3. Connect block with chunk
			chunkGraph.connectBlockAndChunkGroup(block, chunkGroup);

			// 4. Connect chunk with parent
			connectChunkGroupParentAndChild(
				originChunkGroupInfo.chunkGroup,
				chunkGroup
			);
		}
	}
};

/**
 * Remove all unconnected chunk groups
 * @param {Compilation} compilation the compilation
 * @param {Iterable<ChunkGroup>} allCreatedChunkGroups all chunk groups that where created before
 */
const cleanupUnconnectedGroups = (compilation, allCreatedChunkGroups) => {
	const { chunkGraph } = compilation;

	for (const chunkGroup of allCreatedChunkGroups) {
		if (chunkGroup.getNumberOfParents() === 0) {
			for (const chunk of chunkGroup.chunks) {
				compilation.chunks.delete(chunk);
				chunkGraph.disconnectChunk(chunk);
			}
			chunkGraph.disconnectChunkGroup(chunkGroup);
			chunkGroup.remove();
		}
	}
};

/**
 * buildChunkGraph - 构建 Chunk 图的主函数（Seal 阶段核心！）⭐⭐⭐
 *
 * 【整体流程】
 * 这个函数将 ModuleGraph（模块依赖图）转换为 ChunkGraph（Chunk 包含图）
 *
 * 【执行步骤】
 *
 * Part 1: visitModules（访问模块，分配到 Chunk）
 *   1. 从入口模块开始
 *   2. 广度优先遍历依赖图
 *   3. 同步依赖 → 放到当前 Chunk
 *   4. 异步依赖 → 创建新 Chunk
 *   5. 跟踪可用模块（避免重复）
 *
 * Part 2: connectChunkGroups（连接 ChunkGroup）
 *   1. 处理嵌套的异步块
 *   2. 建立 ChunkGroup 的父子关系
 *   3. 优化 Chunk 的加载顺序
 *
 * Part 3: 设置运行时 & 清理
 *   1. 为每个 Chunk 设置 runtime
 *   2. 清理未连接的 ChunkGroup
 *
 * 【白话解释】
 *
 * 想象你在整理书籍到书架：
 * 1. visitModules = 决定每本书放哪个书架
 *    - 同一个主题的书放同一个书架（同步依赖）
 *    - 不同主题的书放不同书架（异步依赖）
 * 2. connectChunkGroups = 标记书架之间的关系
 *    - 这个书架引用了那个书架
 * 3. 清理 = 移除空书架
 *
 * @param {Compilation} compilation - 编译实例
 * @param {Map<Entrypoint, Module[]>} inputEntrypointsAndModules - 入口点和初始模块
 * @returns {void}
 */
const buildChunkGraph = (compilation, inputEntrypointsAndModules) => {
	// 创建日志记录器
	const logger = compilation.getLogger("webpack.buildChunkGraph");

	// ===== 共享状态（在两个阶段间传递数据）=====

	/**
	 * blockConnections: 异步块的连接信息
	 *
	 * 【作用】
	 * 记录每个异步依赖块应该连接到哪些 ChunkGroup
	 * 用于 Part 2 建立 ChunkGroup 的父子关系
	 *
	 * @type {Map<AsyncDependenciesBlock, BlockChunkGroupConnection[]>}
	 */
	const blockConnections = new Map();

	/**
	 * allCreatedChunkGroups: 所有创建的 ChunkGroup
	 *
	 * 【用途】
	 * 记录新创建的 ChunkGroup，用于最后的清理
	 *
	 * @type {Set<ChunkGroup>}
	 */
	const allCreatedChunkGroups = new Set();

	/**
	 * chunkGroupInfoMap: ChunkGroup 的详细信息
	 *
	 * 【存储内容】
	 * - runtime: 运行时规范
	 * - minAvailableModules: 可用模块集（优化用）
	 * - 遍历索引（preOrderIndex、postOrderIndex）
	 *
	 * @type {Map<ChunkGroup, ChunkGroupInfo>}
	 */
	const chunkGroupInfoMap = new Map();

	/**
	 * blocksWithNestedBlocks: 包含嵌套块的依赖块
	 *
	 * 【用途】
	 * 记录哪些块包含嵌套的异步依赖
	 * 需要在 Part 2 中特殊处理
	 *
	 * @type {Set<DependenciesBlock>}
	 */
	const blocksWithNestedBlocks = new Set();

	// ===== PART ONE: 访问模块并分配到 Chunk ⭐⭐⭐ =====
	/**
	 * visitModules - 遍历所有模块，决定它们属于哪个 Chunk
	 *
	 * 【核心工作】
	 * 1. 从入口模块开始，广度优先遍历
	 * 2. 对于每个模块的依赖：
	 *    - 同步依赖：connectChunkAndModule（放到当前 chunk）
	 *    - 异步依赖：创建新 ChunkGroup 和 Chunk
	 * 3. 跟踪已加载的模块，避免重复
	 *
	 * 【最重要的阶段！】
	 * 这一步决定了最终会生成几个文件
	 */
	logger.time("visitModules");
	visitModules(
		logger,
		compilation,
		inputEntrypointsAndModules,
		chunkGroupInfoMap,
		blockConnections,
		blocksWithNestedBlocks,
		allCreatedChunkGroups
	);
	logger.timeEnd("visitModules");

	// ===== PART TWO: 连接 ChunkGroup ⭐⭐ =====
	/**
	 * connectChunkGroups - 建立 ChunkGroup 之间的父子关系
	 *
	 * 【核心工作】
	 * 1. 处理嵌套的异步依赖块
	 * 2. 建立 ChunkGroup 的引用关系
	 * 3. 确保加载顺序正确
	 *
	 * 【示例】
	 * 主 ChunkGroup (main)
	 *   ├─ 异步 ChunkGroup (lazy1)
	 *   └─ 异步 ChunkGroup (lazy2)
	 */
	logger.time("connectChunkGroups");
	connectChunkGroups(
		compilation,
		blocksWithNestedBlocks,
		blockConnections,
		chunkGroupInfoMap
	);
	logger.timeEnd("connectChunkGroups");

	// ===== PART THREE: 设置运行时 ⭐ =====
	/**
	 * 为每个 Chunk 设置正确的运行时
	 *
	 * 【运行时】
	 * 决定 Chunk 在哪个运行时环境中执行
	 * 不同的运行时可能有不同的模块和变量
	 */
	for (const [chunkGroup, chunkGroupInfo] of chunkGroupInfoMap) {
		for (const chunk of chunkGroup.chunks) {
			// 合并运行时规范
			chunk.runtime = mergeRuntime(chunk.runtime, chunkGroupInfo.runtime);
		}
	}

	// ===== 清理工作 =====
	/**
	 * 清理未连接的 ChunkGroup
	 *
	 * 【作用】
	 * 删除创建但没有被使用的 ChunkGroup：
	 * - 空的 ChunkGroup
	 * - 未被任何入口引用的 ChunkGroup
	 *
	 * 【为什么会产生】
	 * 某些条件依赖可能在运行时不激活
	 */
	logger.time("cleanup");
	cleanupUnconnectedGroups(compilation, allCreatedChunkGroups);
	logger.timeEnd("cleanup");
};

module.exports = buildChunkGraph;
