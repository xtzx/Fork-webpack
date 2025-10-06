#!/usr/bin/env node

/**
 * bin/webpack.js - webpack 命令行入口
 *
 * 【文件作用】
 * 这是执行 `webpack` 命令时的入口文件
 * 主要负责：
 * 1. 检查 webpack-cli 是否安装
 * 2. 如果未安装，提示用户安装
 * 3. 安装完成后，加载并运行 webpack-cli
 *
 * 【设计思想】
 * webpack 核心和 CLI 分离：
 * - webpack: 核心编译逻辑（本项目）
 * - webpack-cli: 命令行界面（独立包）
 *
 * 【执行流程】
 * 1. 检查 webpack-cli 是否已安装
 * 2. 如果已安装：直接运行
 * 3. 如果未安装：
 *    - 询问用户是否安装
 *    - 自动执行安装命令
 *    - 安装完成后运行
 *
 * 【注意事项】
 * - 支持 npm/yarn/pnpm 多种包管理器
 * - 支持 CommonJS 和 ESM 两种模块格式
 */

/**
 * 运行命令的工具函数
 * @param {string} command - 要运行的命令（如 npm、yarn、pnpm）
 * @param {string[]} args - 命令参数
 * @returns {Promise<void>} Promise
 */
const runCommand = (command, args) => {
	const cp = require("child_process");
	return new Promise((resolve, reject) => {
		// 使用 spawn 执行命令，继承父进程的 stdio
		const executedCommand = cp.spawn(command, args, {
			stdio: "inherit", // 输出直接显示到控制台
			shell: true       // 使用 shell 执行
		});

		// 监听错误事件
		executedCommand.on("error", error => {
			reject(error);
		});

		// 监听退出事件
		executedCommand.on("exit", code => {
			if (code === 0) {
				resolve(); // 成功
			} else {
				reject();  // 失败
			}
		});
	});
};

/**
 * 检查包是否已安装
 *
 * 【检查策略】
 * 1. 检查是否使用 PnP（Yarn Plug'n'Play）
 * 2. 从当前目录向上查找 node_modules
 * 3. 检查全局 node_modules 路径
 *
 * @param {string} packageName - 包名（如 'webpack-cli'）
 * @returns {boolean} 是否已安装
 */
const isInstalled = packageName => {
	// 1. 如果使用 Yarn PnP，认为已安装
	// PnP 不使用 node_modules，通过 .pnp.js 文件管理依赖
	if (process.versions.pnp) {
		return true;
	}

	const path = require("path");
	const fs = require("graceful-fs");

	// 2. 从当前目录向上查找 node_modules
	let dir = __dirname;

	do {
		try {
			// 检查 node_modules/packageName 是否存在
			if (
				fs.statSync(path.join(dir, "node_modules", packageName)).isDirectory()
			) {
				return true;
			}
		} catch (_error) {
			// 目录不存在，继续向上查找
		}
		// 向上一级目录
	} while (dir !== (dir = path.dirname(dir)));

	// 3. 检查全局 node_modules 路径
	// Node.js 内部的全局路径列表
	// 参考: https://github.com/nodejs/node/blob/v18.9.1/lib/internal/modules/cjs/loader.js#L1274
	// eslint-disable-next-line no-warning-comments
	// @ts-ignore
	for (const internalPath of require("module").globalPaths) {
		try {
			if (fs.statSync(path.join(internalPath, packageName)).isDirectory()) {
				return true;
			}
		} catch (_error) {
			// 路径不存在，继续检查下一个
		}
	}

	// 所有路径都没找到
	return false;
};

/**
 * 运行 CLI 工具
 *
 * 【兼容性处理】
 * 支持两种模块格式：
 * 1. ESM (ES Module): 使用 import()
 * 2. CommonJS: 使用 require()
 *
 * 【判断依据】
 * - package.json 中 type: "module"
 * - 或者入口文件是 .mjs 扩展名
 *
 * @param {CliOption} cli - CLI 配置对象
 * @returns {void}
 */
const runCli = cli => {
	const path = require("path");
	// 解析 CLI 包的 package.json 路径
	const pkgPath = require.resolve(`${cli.package}/package.json`);
	// eslint-disable-next-line node/no-missing-require
	const pkg = require(pkgPath);

	// 判断是 ESM 还是 CommonJS
	if (pkg.type === "module" || /\.mjs/i.test(pkg.bin[cli.binName])) {
		// ESM 模块：使用动态 import()
		// eslint-disable-next-line node/no-unsupported-features/es-syntax
		import(path.resolve(path.dirname(pkgPath), pkg.bin[cli.binName])).catch(
			error => {
				console.error(error);
				process.exitCode = 1;
			}
		);
	} else {
		// CommonJS 模块：使用 require()
		// eslint-disable-next-line node/no-missing-require
		require(path.resolve(path.dirname(pkgPath), pkg.bin[cli.binName]));
	}
};

/**
 * @typedef {Object} CliOption
 * @property {string} name display name
 * @property {string} package npm package name
 * @property {string} binName name of the executable file
 * @property {boolean} installed currently installed?
 * @property {string} url homepage
 */

/** @type {CliOption} */
// CLI 配置对象
const cli = {
	name: "webpack-cli",
	package: "webpack-cli",
	binName: "webpack-cli",
	installed: isInstalled("webpack-cli"), // 检查是否已安装
	url: "https://github.com/webpack/webpack-cli"
};

// ========== 主流程 ==========

if (!cli.installed) {
	// 情况1: webpack-cli 未安装，需要提示用户安装

	const path = require("path");
	const fs = require("graceful-fs");
	const readLine = require("readline");

	const notify =
		"CLI for webpack must be installed.\n" + `  ${cli.name} (${cli.url})\n`;

	console.error(notify);

	// 自动检测包管理器（根据 lock 文件）
	let packageManager;

	if (fs.existsSync(path.resolve(process.cwd(), "yarn.lock"))) {
		packageManager = "yarn";
	} else if (fs.existsSync(path.resolve(process.cwd(), "pnpm-lock.yaml"))) {
		packageManager = "pnpm";
	} else {
		packageManager = "npm"; // 默认使用 npm
	}

	// 构建安装命令参数
	// yarn: yarn add -D
	// npm/pnpm: npm/pnpm install -D
	const installOptions = [packageManager === "yarn" ? "add" : "install", "-D"];

	console.error(
		`We will use "${packageManager}" to install the CLI via "${packageManager} ${installOptions.join(
			" "
		)} ${cli.package}".`
	);

	// 询问用户是否安装
	const question = `Do you want to install 'webpack-cli' (yes/no): `;

	const questionInterface = readLine.createInterface({
		input: process.stdin,
		output: process.stderr
	});

	// 预设退出码为 1（失败）
	// 如果用户同意安装，会在回调中重置为 0
	// 这样处理是为了应对 STDIN 非终端模式下回调不执行的情况
	process.exitCode = 1;

	questionInterface.question(question, answer => {
		questionInterface.close();

		// 判断用户回答（y/yes 开头视为同意）
		const normalizedAnswer = answer.toLowerCase().startsWith("y");

		if (!normalizedAnswer) {
			// 用户拒绝安装
			console.error(
				"You need to install 'webpack-cli' to use webpack via CLI.\n" +
					"You can also install the CLI manually."
			);

			return; // 退出码保持为 1
		}

		// 用户同意安装，重置退出码
		process.exitCode = 0;

		console.log(
			`Installing '${
				cli.package
			}' (running '${packageManager} ${installOptions.join(" ")} ${
				cli.package
			}')...`
		);

		// 执行安装命令
		runCommand(packageManager, installOptions.concat(cli.package))
			.then(() => {
				// 安装成功，运行 CLI
				runCli(cli);
			})
			.catch(error => {
				// 安装失败
				console.error(error);
				process.exitCode = 1;
			});
	});
} else {
	// 情况2: webpack-cli 已安装，直接运行
	runCli(cli);
}
