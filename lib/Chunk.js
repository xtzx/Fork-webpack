/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
*/

/**
 * lib/Chunk.js - Chunk 类定义 ⭐⭐⭐
 *
 * 【文件作用】
 * Chunk 是 webpack 的核心概念之一，代表一个代码块（最终会生成一个文件）
 *
 * 【什么是 Chunk】
 * Chunk 是一组模块的集合，它是：
 * - 代码分割的基本单元
 * - 输出文件的对应物（1 个 Chunk → 1 个 Bundle 文件）
 * - 异步加载的单元
 *
 * 【Chunk 的类型】
 *
 * 1. **入口 Chunk（Entry Chunk）**：
 *    - 从配置的入口创建
 *    - 包含入口模块及其同步依赖
 *    - 例如：main.js、app.js
 *
 * 2. **异步 Chunk（Async Chunk）**：
 *    - 从 import() 动态导入创建
 *    - 按需加载
 *    - 例如：lazy.js、0.js
 *
 * 3. **公共 Chunk（Common Chunk）**：
 *    - SplitChunksPlugin 提取的公共代码
 *    - 多个 Chunk 共享的模块
 *    - 例如：vendors.js、common.js
 *
 * 4. **运行时 Chunk（Runtime Chunk）**：
 *    - 只包含 webpack 运行时代码
 *    - optimization.runtimeChunk 配置
 *    - 例如：runtime.js
 *
 * 【Chunk 的生命周期】
 *
 * 1. 创建：compilation.addChunk(name)
 * 2. 分配模块：chunkGraph.connectChunkAndModule(chunk, module)
 * 3. 优化：SplitChunksPlugin 等调整
 * 4. 生成 ID：DeterministicChunkIdsPlugin
 * 5. 生成代码：JavascriptModulesPlugin.renderMain()
 * 6. 输出文件：emit 阶段写入磁盘
 *
 * 【核心属性】
 * - id: Chunk 的唯一标识符
 * - name: Chunk 的名称（用于入口 chunk）
 * - files: 生成的文件名集合
 * - hash: 内容哈希（用于缓存）
 * - runtime: 运行时规范
 *
 * 【与 Bundle 的关系】
 * Chunk（逻辑概念） → 生成代码 → Bundle（物理文件）
 *
 * 【与其他类的关系】
 * - ChunkGroup: Chunk 的分组（入口点、异步点）
 * - ChunkGraph: 管理 Chunk 和 Module 的关系
 * - Module: Chunk 包含的模块
 */

"use strict";

const ChunkGraph = require("./ChunkGraph");
const Entrypoint = require("./Entrypoint");
const { intersect } = require("./util/SetHelpers");
const SortableSet = require("./util/SortableSet");
const StringXor = require("./util/StringXor");
const {
	compareModulesByIdentifier,
	compareChunkGroupsByIndex,
	compareModulesById
} = require("./util/comparators");
const { createArrayToSetDeprecationSet } = require("./util/deprecation");
const { mergeRuntime } = require("./util/runtime");

/** @typedef {import("webpack-sources").Source} Source */
/** @typedef {import("./ChunkGraph").ChunkFilterPredicate} ChunkFilterPredicate */
/** @typedef {import("./ChunkGraph").ChunkSizeOptions} ChunkSizeOptions */
/** @typedef {import("./ChunkGraph").ModuleFilterPredicate} ModuleFilterPredicate */
/** @typedef {import("./ChunkGroup")} ChunkGroup */
/** @typedef {import("./ChunkGroup").ChunkGroupOptions} ChunkGroupOptions */
/** @typedef {import("./Compilation")} Compilation */
/** @typedef {import("./Compilation").AssetInfo} AssetInfo */
/** @typedef {import("./Compilation").PathData} PathData */
/** @typedef {import("./Entrypoint").EntryOptions} EntryOptions */
/** @typedef {import("./Module")} Module */
/** @typedef {import("./ModuleGraph")} ModuleGraph */
/** @typedef {import("./util/Hash")} Hash */
/** @typedef {import("./util/runtime").RuntimeSpec} RuntimeSpec */

/** @typedef {number | string} ChunkId */

const ChunkFilesSet = createArrayToSetDeprecationSet("chunk.files");

/**
 * @typedef {Object} WithId an object who has an id property *
 * @property {string | number} id the id of the object
 */

/**
 * @deprecated
 * @typedef {Object} ChunkMaps
 * @property {Record<string|number, string>} hash
 * @property {Record<string|number, Record<string, string>>} contentHash
 * @property {Record<string|number, string>} name
 */

/**
 * @deprecated
 * @typedef {Object} ChunkModuleMaps
 * @property {Record<string|number, (string|number)[]>} id
 * @property {Record<string|number, string>} hash
 */

// 全局 debug ID 计数器（用于调试）
let debugId = 1000;

/**
 * Chunk - 代码块类（webpack 的输出单元）
 *
 * 【核心概念】
 * Chunk 是模块的封装单元，最终会被渲染成 bundle 文件
 *
 * 【一句话总结】
 * Chunk = 一组模块 + 元信息 → 最终输出一个文件
 */
class Chunk {
	/**
	 * Chunk 构造函数
	 *
	 * 【创建时机】
	 * 1. Seal 阶段开始：为每个入口创建 Chunk
	 * 2. buildChunkGraph：遇到异步依赖创建新 Chunk
	 * 3. SplitChunksPlugin：提取公共代码时创建 Chunk
	 * 4. RuntimeChunkPlugin：提取运行时创建 Chunk
	 *
	 * @param {string=} name - Chunk 名称（入口名、魔法注释名、或 undefined）
	 * @param {boolean} backCompat - 是否启用向后兼容
	 */
	constructor(name, backCompat = true) {
		// ===== 标识符 =====

		/**
		 * Chunk ID（唯一标识）
		 *
		 * 【类型】
		 * - number: 0, 1, 2, ...（默认）
		 * - string: 'main', 'vendors', ...（命名 chunk）
		 *
		 * 【何时赋值】
		 * 在 optimizeChunkIds 钩子阶段由 ID 插件赋值
		 *
		 * @type {ChunkId | null}
		 */
		this.id = null;

		/**
		 * Chunk ID 列表（通常只有一个，历史遗留）
		 * @type {ChunkId[] | null}
		 */
		this.ids = null;

		/**
		 * 调试 ID（全局唯一，用于开发调试）
		 * 每个 Chunk 创建时自增
		 * @type {number}
		 */
		this.debugId = debugId++;

		/**
		 * Chunk 名称
		 *
		 * 【来源】
		 * - 入口 chunk: entry 配置的 key（如 'main'）
		 * - 异步 chunk: webpackChunkName 魔法注释
		 * - 公共 chunk: cacheGroups 的 name 配置
		 * - 运行时 chunk: runtimeChunk 的 name 配置
		 *
		 * 【示例】
		 * entry: { app: './src/app.js' } → name: 'app'
		 * import(/* webpackChunkName: "lazy" *\/ './lazy.js') → name: 'lazy'
		 *
		 * @type {string | undefined}
		 */
		this.name = name;

		/**
		 * ID 名称提示集合
		 *
		 * 【用途】
		 * 当 Chunk 没有明确的 name 时，收集可能的名称提示
		 * 用于生成更友好的 Chunk 文件名
		 *
		 * @type {SortableSet<string>}
		 */
		this.idNameHints = new SortableSet();

		/**
		 * 阻止集成标记
		 *
		 * 【用途】
		 * 如果为 true，该 Chunk 不会被合并到其他 Chunk
		 * 用于运行时 Chunk 等特殊 Chunk
		 *
		 * @type {boolean}
		 */
		this.preventIntegration = false;

		/**
		 * 文件名模板（JS 文件）
		 *
		 * 【示例】
		 * - '[name].[contenthash].js'
		 * - 'static/js/[name].js'
		 * - 函数形式：(pathData) => `custom-${pathData.chunk.name}.js`
		 *
		 * @type {(string | function(PathData, AssetInfo=): string) | undefined}
		 */
		this.filenameTemplate = undefined;

		/**
		 * 文件名模板（CSS 文件）
		 * @type {(string | function(PathData, AssetInfo=): string) | undefined}
		 */
		this.cssFilenameTemplate = undefined;

		/**
		 * ChunkGroup 集合（该 Chunk 属于哪些 ChunkGroup）
		 *
		 * 【一对多关系】
		 * 一个 Chunk 可以属于多个 ChunkGroup
		 *
		 * @private
		 * @type {SortableSet<ChunkGroup>}
		 */
		this._groups = new SortableSet(undefined, compareChunkGroupsByIndex);

		/**
		 * 运行时规范
		 *
		 * 【作用】
		 * 指定该 Chunk 在哪个运行时环境中执行
		 * 多入口、多运行时场景需要区分
		 *
		 * @type {RuntimeSpec}
		 */
		this.runtime = undefined;

		// ===== 输出文件信息 =====

		/**
		 * 生成的文件名集合
		 *
		 * 【内容】
		 * 该 Chunk 生成的所有文件名：
		 * - 主文件：main.js
		 * - SourceMap：main.js.map
		 * - 其他关联文件
		 *
		 * @type {Set<string>}
		 */
		this.files = backCompat ? new ChunkFilesSet() : new Set();

		/**
		 * 辅助文件集合
		 *
		 * 【内容】
		 * 非主要的输出文件：
		 * - LICENSE 文件
		 * - .map 文件
		 *
		 * @type {Set<string>}
		 */
		this.auxiliaryFiles = new Set();

		// ===== 渲染状态 =====

		/**
		 * 是否已渲染
		 * 标记该 Chunk 是否已经生成代码
		 * @type {boolean}
		 */
		this.rendered = false;

		// ===== 哈希相关（用于缓存）⭐⭐ =====

		/**
		 * Chunk 哈希（完整哈希）
		 *
		 * 【用途】
		 * 用于 [chunkhash] 占位符
		 *
		 * @type {string=}
		 */
		this.hash = undefined;

		/**
		 * 内容哈希映射（按文件类型）
		 *
		 * 【用途】
		 * 用于 [contenthash] 占位符
		 *
		 * 【示例】
		 * {
		 *   'javascript': 'a1b2c3d4',  // JS 内容的哈希
		 *   'css': 'e5f6g7h8'           // CSS 内容的哈希
		 * }
		 *
		 * 【好处】
		 * JS 变化不会影响 CSS 的哈希，反之亦然
		 *
		 * @type {Record<string, string>}
		 */
		this.contentHash = Object.create(null);

		/**
		 * 渲染后的哈希（截断版）
		 *
		 * 【用途】
		 * 用于生成最终文件名的哈希部分
		 * 通常是完整哈希的前 8-20 位
		 *
		 * @type {string=}
		 */
		this.renderedHash = undefined;

		// ===== 其他元信息 =====

		/**
		 * Chunk 创建原因
		 *
		 * 【用途】
		 * 调试和统计，说明为什么创建这个 Chunk
		 * 例如："split chunk (cache group: vendors)"
		 *
		 * @type {string=}
		 */
		this.chunkReason = undefined;

		/**
		 * 是否是额外的异步 Chunk
		 *
		 * 【用途】
		 * 标记由优化插件创建的额外异步 Chunk
		 *
		 * @type {boolean}
		 */
		this.extraAsync = false;
	}

	// TODO remove in webpack 6
	// BACKWARD-COMPAT START
	get entryModule() {
		const entryModules = Array.from(
			ChunkGraph.getChunkGraphForChunk(
				this,
				"Chunk.entryModule",
				"DEP_WEBPACK_CHUNK_ENTRY_MODULE"
			).getChunkEntryModulesIterable(this)
		);
		if (entryModules.length === 0) {
			return undefined;
		} else if (entryModules.length === 1) {
			return entryModules[0];
		} else {
			throw new Error(
				"Module.entryModule: Multiple entry modules are not supported by the deprecated API (Use the new ChunkGroup API)"
			);
		}
	}

	/**
	 * @returns {boolean} true, if the chunk contains an entry module
	 */
	hasEntryModule() {
		return (
			ChunkGraph.getChunkGraphForChunk(
				this,
				"Chunk.hasEntryModule",
				"DEP_WEBPACK_CHUNK_HAS_ENTRY_MODULE"
			).getNumberOfEntryModules(this) > 0
		);
	}

	/**
	 * @param {Module} module the module
	 * @returns {boolean} true, if the chunk could be added
	 */
	addModule(module) {
		const chunkGraph = ChunkGraph.getChunkGraphForChunk(
			this,
			"Chunk.addModule",
			"DEP_WEBPACK_CHUNK_ADD_MODULE"
		);
		if (chunkGraph.isModuleInChunk(module, this)) return false;
		chunkGraph.connectChunkAndModule(this, module);
		return true;
	}

	/**
	 * @param {Module} module the module
	 * @returns {void}
	 */
	removeModule(module) {
		ChunkGraph.getChunkGraphForChunk(
			this,
			"Chunk.removeModule",
			"DEP_WEBPACK_CHUNK_REMOVE_MODULE"
		).disconnectChunkAndModule(this, module);
	}

	/**
	 * @returns {number} the number of module which are contained in this chunk
	 */
	getNumberOfModules() {
		return ChunkGraph.getChunkGraphForChunk(
			this,
			"Chunk.getNumberOfModules",
			"DEP_WEBPACK_CHUNK_GET_NUMBER_OF_MODULES"
		).getNumberOfChunkModules(this);
	}

	get modulesIterable() {
		const chunkGraph = ChunkGraph.getChunkGraphForChunk(
			this,
			"Chunk.modulesIterable",
			"DEP_WEBPACK_CHUNK_MODULES_ITERABLE"
		);
		return chunkGraph.getOrderedChunkModulesIterable(
			this,
			compareModulesByIdentifier
		);
	}

	/**
	 * @param {Chunk} otherChunk the chunk to compare with
	 * @returns {-1|0|1} the comparison result
	 */
	compareTo(otherChunk) {
		const chunkGraph = ChunkGraph.getChunkGraphForChunk(
			this,
			"Chunk.compareTo",
			"DEP_WEBPACK_CHUNK_COMPARE_TO"
		);
		return chunkGraph.compareChunks(this, otherChunk);
	}

	/**
	 * @param {Module} module the module
	 * @returns {boolean} true, if the chunk contains the module
	 */
	containsModule(module) {
		return ChunkGraph.getChunkGraphForChunk(
			this,
			"Chunk.containsModule",
			"DEP_WEBPACK_CHUNK_CONTAINS_MODULE"
		).isModuleInChunk(module, this);
	}

	/**
	 * @returns {Module[]} the modules for this chunk
	 */
	getModules() {
		return ChunkGraph.getChunkGraphForChunk(
			this,
			"Chunk.getModules",
			"DEP_WEBPACK_CHUNK_GET_MODULES"
		).getChunkModules(this);
	}

	/**
	 * @returns {void}
	 */
	remove() {
		const chunkGraph = ChunkGraph.getChunkGraphForChunk(
			this,
			"Chunk.remove",
			"DEP_WEBPACK_CHUNK_REMOVE"
		);
		chunkGraph.disconnectChunk(this);
		this.disconnectFromGroups();
	}

	/**
	 * @param {Module} module the module
	 * @param {Chunk} otherChunk the target chunk
	 * @returns {void}
	 */
	moveModule(module, otherChunk) {
		const chunkGraph = ChunkGraph.getChunkGraphForChunk(
			this,
			"Chunk.moveModule",
			"DEP_WEBPACK_CHUNK_MOVE_MODULE"
		);
		chunkGraph.disconnectChunkAndModule(this, module);
		chunkGraph.connectChunkAndModule(otherChunk, module);
	}

	/**
	 * @param {Chunk} otherChunk the other chunk
	 * @returns {boolean} true, if the specified chunk has been integrated
	 */
	integrate(otherChunk) {
		const chunkGraph = ChunkGraph.getChunkGraphForChunk(
			this,
			"Chunk.integrate",
			"DEP_WEBPACK_CHUNK_INTEGRATE"
		);
		if (chunkGraph.canChunksBeIntegrated(this, otherChunk)) {
			chunkGraph.integrateChunks(this, otherChunk);
			return true;
		} else {
			return false;
		}
	}

	/**
	 * @param {Chunk} otherChunk the other chunk
	 * @returns {boolean} true, if chunks could be integrated
	 */
	canBeIntegrated(otherChunk) {
		const chunkGraph = ChunkGraph.getChunkGraphForChunk(
			this,
			"Chunk.canBeIntegrated",
			"DEP_WEBPACK_CHUNK_CAN_BE_INTEGRATED"
		);
		return chunkGraph.canChunksBeIntegrated(this, otherChunk);
	}

	/**
	 * @returns {boolean} true, if this chunk contains no module
	 */
	isEmpty() {
		const chunkGraph = ChunkGraph.getChunkGraphForChunk(
			this,
			"Chunk.isEmpty",
			"DEP_WEBPACK_CHUNK_IS_EMPTY"
		);
		return chunkGraph.getNumberOfChunkModules(this) === 0;
	}

	/**
	 * @returns {number} total size of all modules in this chunk
	 */
	modulesSize() {
		const chunkGraph = ChunkGraph.getChunkGraphForChunk(
			this,
			"Chunk.modulesSize",
			"DEP_WEBPACK_CHUNK_MODULES_SIZE"
		);
		return chunkGraph.getChunkModulesSize(this);
	}

	/**
	 * @param {ChunkSizeOptions} options options object
	 * @returns {number} total size of this chunk
	 */
	size(options = {}) {
		const chunkGraph = ChunkGraph.getChunkGraphForChunk(
			this,
			"Chunk.size",
			"DEP_WEBPACK_CHUNK_SIZE"
		);
		return chunkGraph.getChunkSize(this, options);
	}

	/**
	 * @param {Chunk} otherChunk the other chunk
	 * @param {ChunkSizeOptions} options options object
	 * @returns {number} total size of the chunk or false if the chunk can't be integrated
	 */
	integratedSize(otherChunk, options) {
		const chunkGraph = ChunkGraph.getChunkGraphForChunk(
			this,
			"Chunk.integratedSize",
			"DEP_WEBPACK_CHUNK_INTEGRATED_SIZE"
		);
		return chunkGraph.getIntegratedChunksSize(this, otherChunk, options);
	}

	/**
	 * @param {ModuleFilterPredicate} filterFn function used to filter modules
	 * @returns {ChunkModuleMaps} module map information
	 */
	getChunkModuleMaps(filterFn) {
		const chunkGraph = ChunkGraph.getChunkGraphForChunk(
			this,
			"Chunk.getChunkModuleMaps",
			"DEP_WEBPACK_CHUNK_GET_CHUNK_MODULE_MAPS"
		);
		/** @type {Record<string|number, (string|number)[]>} */
		const chunkModuleIdMap = Object.create(null);
		/** @type {Record<string|number, string>} */
		const chunkModuleHashMap = Object.create(null);

		for (const asyncChunk of this.getAllAsyncChunks()) {
			/** @type {ChunkId[] | undefined} */
			let array;
			for (const module of chunkGraph.getOrderedChunkModulesIterable(
				asyncChunk,
				compareModulesById(chunkGraph)
			)) {
				if (filterFn(module)) {
					if (array === undefined) {
						array = [];
						chunkModuleIdMap[/** @type {ChunkId} */ (asyncChunk.id)] = array;
					}
					const moduleId = chunkGraph.getModuleId(module);
					array.push(moduleId);
					chunkModuleHashMap[moduleId] = chunkGraph.getRenderedModuleHash(
						module,
						undefined
					);
				}
			}
		}

		return {
			id: chunkModuleIdMap,
			hash: chunkModuleHashMap
		};
	}

	/**
	 * @param {ModuleFilterPredicate} filterFn predicate function used to filter modules
	 * @param {ChunkFilterPredicate=} filterChunkFn predicate function used to filter chunks
	 * @returns {boolean} return true if module exists in graph
	 */
	hasModuleInGraph(filterFn, filterChunkFn) {
		const chunkGraph = ChunkGraph.getChunkGraphForChunk(
			this,
			"Chunk.hasModuleInGraph",
			"DEP_WEBPACK_CHUNK_HAS_MODULE_IN_GRAPH"
		);
		return chunkGraph.hasModuleInGraph(this, filterFn, filterChunkFn);
	}

	/**
	 * @deprecated
	 * @param {boolean} realHash whether the full hash or the rendered hash is to be used
	 * @returns {ChunkMaps} the chunk map information
	 */
	getChunkMaps(realHash) {
		/** @type {Record<string|number, string>} */
		const chunkHashMap = Object.create(null);
		/** @type {Record<string|number, Record<string, string>>} */
		const chunkContentHashMap = Object.create(null);
		/** @type {Record<string|number, string>} */
		const chunkNameMap = Object.create(null);

		for (const chunk of this.getAllAsyncChunks()) {
			const id = /** @type {ChunkId} */ (chunk.id);
			chunkHashMap[id] =
				/** @type {string} */
				(realHash ? chunk.hash : chunk.renderedHash);
			for (const key of Object.keys(chunk.contentHash)) {
				if (!chunkContentHashMap[key]) {
					chunkContentHashMap[key] = Object.create(null);
				}
				chunkContentHashMap[key][id] = chunk.contentHash[key];
			}
			if (chunk.name) {
				chunkNameMap[id] = chunk.name;
			}
		}

		return {
			hash: chunkHashMap,
			contentHash: chunkContentHashMap,
			name: chunkNameMap
		};
	}
	// BACKWARD-COMPAT END

	/**
	 * @returns {boolean} whether or not the Chunk will have a runtime
	 */
	hasRuntime() {
		for (const chunkGroup of this._groups) {
			if (
				chunkGroup instanceof Entrypoint &&
				chunkGroup.getRuntimeChunk() === this
			) {
				return true;
			}
		}
		return false;
	}

	/**
	 * @returns {boolean} whether or not this chunk can be an initial chunk
	 */
	canBeInitial() {
		for (const chunkGroup of this._groups) {
			if (chunkGroup.isInitial()) return true;
		}
		return false;
	}

	/**
	 * @returns {boolean} whether this chunk can only be an initial chunk
	 */
	isOnlyInitial() {
		if (this._groups.size <= 0) return false;
		for (const chunkGroup of this._groups) {
			if (!chunkGroup.isInitial()) return false;
		}
		return true;
	}

	/**
	 * @returns {EntryOptions | undefined} the entry options for this chunk
	 */
	getEntryOptions() {
		for (const chunkGroup of this._groups) {
			if (chunkGroup instanceof Entrypoint) {
				return chunkGroup.options;
			}
		}
		return undefined;
	}

	/**
	 * @param {ChunkGroup} chunkGroup the chunkGroup the chunk is being added
	 * @returns {void}
	 */
	addGroup(chunkGroup) {
		this._groups.add(chunkGroup);
	}

	/**
	 * @param {ChunkGroup} chunkGroup the chunkGroup the chunk is being removed from
	 * @returns {void}
	 */
	removeGroup(chunkGroup) {
		this._groups.delete(chunkGroup);
	}

	/**
	 * @param {ChunkGroup} chunkGroup the chunkGroup to check
	 * @returns {boolean} returns true if chunk has chunkGroup reference and exists in chunkGroup
	 */
	isInGroup(chunkGroup) {
		return this._groups.has(chunkGroup);
	}

	/**
	 * @returns {number} the amount of groups that the said chunk is in
	 */
	getNumberOfGroups() {
		return this._groups.size;
	}

	/**
	 * @returns {SortableSet<ChunkGroup>} the chunkGroups that the said chunk is referenced in
	 */
	get groupsIterable() {
		this._groups.sort();
		return this._groups;
	}

	/**
	 * @returns {void}
	 */
	disconnectFromGroups() {
		for (const chunkGroup of this._groups) {
			chunkGroup.removeChunk(this);
		}
	}

	/**
	 * @param {Chunk} newChunk the new chunk that will be split out of
	 * @returns {void}
	 */
	split(newChunk) {
		for (const chunkGroup of this._groups) {
			chunkGroup.insertChunk(newChunk, this);
			newChunk.addGroup(chunkGroup);
		}
		for (const idHint of this.idNameHints) {
			newChunk.idNameHints.add(idHint);
		}
		newChunk.runtime = mergeRuntime(newChunk.runtime, this.runtime);
	}

	/**
	 * @param {Hash} hash hash (will be modified)
	 * @param {ChunkGraph} chunkGraph the chunk graph
	 * @returns {void}
	 */
	updateHash(hash, chunkGraph) {
		hash.update(
			`${this.id} ${this.ids ? this.ids.join() : ""} ${this.name || ""} `
		);
		const xor = new StringXor();
		for (const m of chunkGraph.getChunkModulesIterable(this)) {
			xor.add(chunkGraph.getModuleHash(m, this.runtime));
		}
		xor.updateHash(hash);
		const entryModules =
			chunkGraph.getChunkEntryModulesWithChunkGroupIterable(this);
		for (const [m, chunkGroup] of entryModules) {
			hash.update(
				`entry${chunkGraph.getModuleId(m)}${
					/** @type {ChunkGroup} */ (chunkGroup).id
				}`
			);
		}
	}

	/**
	 * @returns {Set<Chunk>} a set of all the async chunks
	 */
	getAllAsyncChunks() {
		const queue = new Set();
		const chunks = new Set();

		const initialChunks = intersect(
			Array.from(this.groupsIterable, g => new Set(g.chunks))
		);

		const initialQueue = new Set(this.groupsIterable);

		for (const chunkGroup of initialQueue) {
			for (const child of chunkGroup.childrenIterable) {
				if (child instanceof Entrypoint) {
					initialQueue.add(child);
				} else {
					queue.add(child);
				}
			}
		}

		for (const chunkGroup of queue) {
			for (const chunk of chunkGroup.chunks) {
				if (!initialChunks.has(chunk)) {
					chunks.add(chunk);
				}
			}
			for (const child of chunkGroup.childrenIterable) {
				queue.add(child);
			}
		}

		return chunks;
	}

	/**
	 * @returns {Set<Chunk>} a set of all the initial chunks (including itself)
	 */
	getAllInitialChunks() {
		const chunks = new Set();
		const queue = new Set(this.groupsIterable);
		for (const group of queue) {
			if (group.isInitial()) {
				for (const c of group.chunks) chunks.add(c);
				for (const g of group.childrenIterable) queue.add(g);
			}
		}
		return chunks;
	}

	/**
	 * @returns {Set<Chunk>} a set of all the referenced chunks (including itself)
	 */
	getAllReferencedChunks() {
		const queue = new Set(this.groupsIterable);
		const chunks = new Set();

		for (const chunkGroup of queue) {
			for (const chunk of chunkGroup.chunks) {
				chunks.add(chunk);
			}
			for (const child of chunkGroup.childrenIterable) {
				queue.add(child);
			}
		}

		return chunks;
	}

	/**
	 * @returns {Set<Entrypoint>} a set of all the referenced entrypoints
	 */
	getAllReferencedAsyncEntrypoints() {
		const queue = new Set(this.groupsIterable);
		const entrypoints = new Set();

		for (const chunkGroup of queue) {
			for (const entrypoint of chunkGroup.asyncEntrypointsIterable) {
				entrypoints.add(entrypoint);
			}
			for (const child of chunkGroup.childrenIterable) {
				queue.add(child);
			}
		}

		return entrypoints;
	}

	/**
	 * @returns {boolean} true, if the chunk references async chunks
	 */
	hasAsyncChunks() {
		const queue = new Set();

		const initialChunks = intersect(
			Array.from(this.groupsIterable, g => new Set(g.chunks))
		);

		for (const chunkGroup of this.groupsIterable) {
			for (const child of chunkGroup.childrenIterable) {
				queue.add(child);
			}
		}

		for (const chunkGroup of queue) {
			for (const chunk of chunkGroup.chunks) {
				if (!initialChunks.has(chunk)) {
					return true;
				}
			}
			for (const child of chunkGroup.childrenIterable) {
				queue.add(child);
			}
		}

		return false;
	}

	/**
	 * @param {ChunkGraph} chunkGraph the chunk graph
	 * @param {ChunkFilterPredicate=} filterFn function used to filter chunks
	 * @returns {Record<string, (string | number)[]>} a record object of names to lists of child ids(?)
	 */
	getChildIdsByOrders(chunkGraph, filterFn) {
		/** @type {Map<string, {order: number, group: ChunkGroup}[]>} */
		const lists = new Map();
		for (const group of this.groupsIterable) {
			if (group.chunks[group.chunks.length - 1] === this) {
				for (const childGroup of group.childrenIterable) {
					for (const key of Object.keys(childGroup.options)) {
						if (key.endsWith("Order")) {
							const name = key.slice(0, key.length - "Order".length);
							let list = lists.get(name);
							if (list === undefined) {
								list = [];
								lists.set(name, list);
							}
							list.push({
								order:
									/** @type {number} */
									(
										childGroup.options[
											/** @type {keyof ChunkGroupOptions} */ (key)
										]
									),
								group: childGroup
							});
						}
					}
				}
			}
		}
		/** @type {Record<string, (string | number)[]>} */
		const result = Object.create(null);
		for (const [name, list] of lists) {
			list.sort((a, b) => {
				const cmp = b.order - a.order;
				if (cmp !== 0) return cmp;
				return a.group.compareTo(chunkGraph, b.group);
			});
			/** @type {Set<string | number>} */
			const chunkIdSet = new Set();
			for (const item of list) {
				for (const chunk of item.group.chunks) {
					if (filterFn && !filterFn(chunk, chunkGraph)) continue;
					chunkIdSet.add(/** @type {ChunkId} */ (chunk.id));
				}
			}
			if (chunkIdSet.size > 0) {
				result[name] = Array.from(chunkIdSet);
			}
		}
		return result;
	}

	/**
	 * @param {ChunkGraph} chunkGraph the chunk graph
	 * @param {string} type option name
	 * @returns {{ onChunks: Chunk[], chunks: Set<Chunk> }[] | undefined} referenced chunks for a specific type
	 */
	getChildrenOfTypeInOrder(chunkGraph, type) {
		const list = [];
		for (const group of this.groupsIterable) {
			for (const childGroup of group.childrenIterable) {
				const order =
					childGroup.options[/** @type {keyof ChunkGroupOptions} */ (type)];
				if (order === undefined) continue;
				list.push({
					order,
					group,
					childGroup
				});
			}
		}
		if (list.length === 0) return undefined;
		list.sort((a, b) => {
			const cmp =
				/** @type {number} */ (b.order) - /** @type {number} */ (a.order);
			if (cmp !== 0) return cmp;
			return a.group.compareTo(chunkGraph, b.group);
		});
		const result = [];
		let lastEntry;
		for (const { group, childGroup } of list) {
			if (lastEntry && lastEntry.onChunks === group.chunks) {
				for (const chunk of childGroup.chunks) {
					lastEntry.chunks.add(chunk);
				}
			} else {
				result.push(
					(lastEntry = {
						onChunks: group.chunks,
						chunks: new Set(childGroup.chunks)
					})
				);
			}
		}
		return result;
	}

	/**
	 * @param {ChunkGraph} chunkGraph the chunk graph
	 * @param {boolean=} includeDirectChildren include direct children (by default only children of async children are included)
	 * @param {ChunkFilterPredicate=} filterFn function used to filter chunks
	 * @returns {Record<string|number, Record<string, (string | number)[]>>} a record object of names to lists of child ids(?) by chunk id
	 */
	getChildIdsByOrdersMap(chunkGraph, includeDirectChildren, filterFn) {
		/** @type {Record<string|number, Record<string, (string | number)[]>>} */
		const chunkMaps = Object.create(null);

		/**
		 * @param {Chunk} chunk a chunk
		 * @returns {void}
		 */
		const addChildIdsByOrdersToMap = chunk => {
			const data = chunk.getChildIdsByOrders(chunkGraph, filterFn);
			for (const key of Object.keys(data)) {
				let chunkMap = chunkMaps[key];
				if (chunkMap === undefined) {
					chunkMaps[key] = chunkMap = Object.create(null);
				}
				chunkMap[/** @type {ChunkId} */ (chunk.id)] = data[key];
			}
		};

		if (includeDirectChildren) {
			/** @type {Set<Chunk>} */
			const chunks = new Set();
			for (const chunkGroup of this.groupsIterable) {
				for (const chunk of chunkGroup.chunks) {
					chunks.add(chunk);
				}
			}
			for (const chunk of chunks) {
				addChildIdsByOrdersToMap(chunk);
			}
		}

		for (const chunk of this.getAllAsyncChunks()) {
			addChildIdsByOrdersToMap(chunk);
		}

		return chunkMaps;
	}
}

module.exports = Chunk;
