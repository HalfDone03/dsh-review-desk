/**
 * dsh-review-desk — Host 侧插件。
 *
 * 把 DSH Web UI 放到一个私有 Win32 桌面，用户需要复验时再切过去；
 * 平时主桌面完全不受影响。原生部分在 bin/DshReviewDesktop.exe。
 *
 * 只依赖 node: 内置模块，便于在纯 Node 下做 mock 测试。
 *
 * @module dsh-review-desk
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AuditLog } from "./audit.js";
import { ReviewStore } from "./review.js";

/** 插件名（cordis 实例标识）。 */
export const name = "review-desk";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(HERE);
const DEFAULT_HELPER = join(PACKAGE_ROOT, "bin", "DshReviewDesktop.exe");

/** 默认配置；实际配置来自 cordis.patch.yml。 */
export const DEFAULTS = {
	/** 总开关 */
	enabled: true,
	/** 私有桌面名；固定名字便于重启后接管残留 */
	desktopName: "DSH-Review-Desk",
	/** Edge 可执行文件；留空用 helper 自动探测 */
	edgePath: "",
	/** DSH Web UI 地址；留空用 webServer.getOrigin() */
	url: "",
	/** 复验桌面内 panel 自动返回秒数；0 表示不自动返回 */
	panelSeconds: 0,
	/** 切过去后 watchdog 自动返回秒数；0 表示关闭 */
	autoReturnSeconds: 0,
	/** 状态文件；留空用 %LOCALAPPDATA%\dsh-review-desk\state.txt */
	statePath: "",
	/** Edge profile；留空用状态文件同目录的 edge-profile */
	profilePath: "",
	/** helper 路径；留空用包内 bin/DshReviewDesktop.exe */
	helperPath: "",
	/** 插件卸载时是否关闭复验桌面 */
	closeOnDispose: true,
	/** 内存中最多保留多少条复验记录 */
	reviewLimit: 50,
	/** 是否在复验记录里保存工具参数值（默认只存 key，避免密钥进日志） */
	reviewIncludeToolArgs: false,
	/** 是否写审计日志 */
	audit: true,
	/** 审计文件；留空用状态文件同目录的 audit.jsonl */
	auditPath: "",
	/** 是否把每个 turn/end 写审计（默认只记桌面动作） */
	auditTurns: false,
	/** `/review-desk run` 的超时秒数 */
	runTimeoutSeconds: 120,
	/** 返回给会话的最大输出字符数 */
	runOutputLimit: 20000
};

/**
 * 合并并校验配置。
 * @param {unknown} raw 部署配置
 * @returns {typeof DEFAULTS} 完整配置
 */
export function normalizeConfig(raw) {
	if (raw !== undefined && raw !== null && typeof raw !== "object") {
		throw new TypeError("review-desk: config must be an object");
	}
	const input = raw ?? {};
	const merged = { ...DEFAULTS, ...input };

	for (const key of ["enabled", "closeOnDispose", "reviewIncludeToolArgs", "audit", "auditTurns"]) {
		if (typeof merged[key] !== "boolean") {
			throw new TypeError(`review-desk: ${key} must be a boolean`);
		}
	}
	for (const key of ["desktopName", "edgePath", "url", "statePath", "profilePath", "helperPath", "auditPath"]) {
		if (typeof merged[key] !== "string") {
			throw new TypeError(`review-desk: ${key} must be a string`);
		}
	}
	for (const key of ["panelSeconds", "autoReturnSeconds", "runTimeoutSeconds"]) {
		const value = Number(merged[key]);
		if (!Number.isFinite(value) || value < 0 || value > 86400) {
			throw new RangeError(`review-desk: ${key} must be a number in [0, 86400]`);
		}
		merged[key] = Math.round(value);
	}
	{
		const value = Number(merged.runOutputLimit);
		if (!Number.isFinite(value) || value < 1000 || value > 200000) {
			throw new RangeError("review-desk: runOutputLimit must be a number in [1000, 200000]");
		}
		merged.runOutputLimit = Math.round(value);
	}
	{
		const value = Number(merged.reviewLimit);
		if (!Number.isFinite(value) || value < 1 || value > 500) {
			throw new RangeError("review-desk: reviewLimit must be a number in [1, 500]");
		}
		merged.reviewLimit = Math.round(value);
	}
	if (merged.desktopName.trim() === "") {
		throw new TypeError("review-desk: desktopName must not be empty");
	}
	return merged;
}

/**
 * 解析 DSH Web UI 根地址。
 * @param {any} ctx cordis 上下文
 * @param {typeof DEFAULTS} config 配置
 * @returns {string} URL
 */
function resolveUrl(ctx, config) {
	if (config.url.trim() !== "") return config.url.trim();
	const webserver = ctx?.get?.("webServer") ?? ctx?.webServer;
	if (webserver !== undefined && typeof webserver.getOrigin === "function") {
		return webserver.getOrigin();
	}
	throw new Error("review-desk: 没有 webServer.getOrigin()，请在配置里填 url");
}

/**
 * PowerShell 单引号字面量转义。
 * @param {string} value 原值
 * @returns {string} 带引号的字面量
 */
function psQuote(value) {
	return `'${String(value).replace(/'/gu, "''")}'`;
}

/**
 * 取状态文件路径。
 * @param {typeof DEFAULTS} config 配置
 * @returns {string} 绝对路径
 */
function resolveStatePath(config) {
	if (config.statePath.trim() !== "") return resolve(config.statePath.trim());
	const base = process.env.LOCALAPPDATA || process.env.APPDATA || tmpdir();
	return join(base, "dsh-review-desk", "state.txt");
}

/**
 * 取 profile 路径。
 * @param {typeof DEFAULTS} config 配置
 * @param {string} statePath 状态文件
 * @returns {string} 绝对路径
 */
function resolveProfilePath(config, statePath) {
	if (config.profilePath.trim() !== "") return resolve(config.profilePath.trim());
	return join(dirname(statePath), "edge-profile");
}

/**
 * 取 helper 路径。
 * @param {typeof DEFAULTS} config 配置
 * @returns {string} 绝对路径
 */
function resolveHelperPath(config) {
	if (config.helperPath.trim() !== "") return resolve(config.helperPath.trim());
	return DEFAULT_HELPER;
}

/**
 * 运行一次 helper，收集 stdout/stderr。
 * @param {string} helper helper 路径
 * @param {string[]} args 参数
 * @param {number} [timeoutMs] 超时
 * @returns {Promise<{code:number, stdout:string, stderr:string}>} 结果
 */
function runHelper(helper, args, timeoutMs = 30000) {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const child = spawn(helper, args, {
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"]
		});

		const finish = (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
		};

		const timer = setTimeout(() => {
			try { child.kill(); } catch {}
			finish(-1);
		}, timeoutMs);

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk) => { stdout += chunk; });
		child.stderr?.on("data", (chunk) => { stderr += chunk; });
		child.on("error", (error) => {
			stderr += String(error?.message ?? error);
			finish(-1);
		});
		// panel/Edge 可能继承 stdout 管道；只等 close 会一直挂着。
		// exit 一旦触发就收尾，并主动销毁管道，避免 Node 事件循环被拖住。
		child.on("exit", (code) => {
			child.stdout?.destroy();
			child.stderr?.destroy();
			setTimeout(() => finish(code ?? -1), 50);
		});
		child.on("close", (code) => finish(code ?? -1));
	});
}

/**
 * 统一解释 helper 结果。
 * @param {{code:number, stdout:string, stderr:string}} result 结果
 * @returns {{ok:boolean, text:string}} 结果
 */
function interpret(result) {
	const text = result.stdout || result.stderr || "helper 没有输出";
	return { ok: result.code === 0, text };
}

/**
 * 构造插件实例（便于 mock 测试）。
 * @param {any} ctx cordis 上下文
 * @param {object} rawConfig 原始配置
 * @returns {{dispose: () => Promise<void>, status: () => Promise<object>}} 控制器
 */
export function createPlugin(ctx, rawConfig) {
	const config = normalizeConfig(rawConfig);
	const helper = resolveHelperPath(config);
	const statePath = resolveStatePath(config);
	const profilePath = resolveProfilePath(config, statePath);
	let disposed = false;
	let deskOpen = false;
	let pending = Promise.resolve();
	const reviews = new ReviewStore({
		limit: config.reviewLimit,
		includeToolArgs: config.reviewIncludeToolArgs,
		workspaceChanges: () => ctx?.get?.("workspaceChanges") ?? ctx?.workspaceChanges
	});
	const audit = new AuditLog({
		enabled: config.audit,
		path: config.auditPath.trim() !== "" ? resolve(config.auditPath.trim()) : join(dirname(statePath), "audit.jsonl")
	});

	/**
	 * 串行执行 helper，避免 open/close 交错。
	 * @param {string[]} args 参数
	 * @param {number} [timeoutMs] 超时
	 * @returns {Promise<{code:number, stdout:string, stderr:string}>} 结果
	 */
	const run = (args, timeoutMs) => {
		const next = pending.then(() => runHelper(helper, args, timeoutMs));
		pending = next.then(() => undefined, () => undefined);
		return next;
	};

	/**
	 * 拼公共参数。
	 * @returns {string[]} 参数
	 */
	const common = () => [
		"--desktop", config.desktopName,
		"--state", statePath,
		"--profile", profilePath
	];

	/**
	 * 只准备复验桌面：创建桌面、启动 Edge/panel，但绝不切屏。
	 * 这是默认应该走的路径；用户当前桌面不受影响。
	 * @returns {Promise<{ok:boolean, text:string}>} 结果
	 */
	const prepare = async () => {
		if (!config.enabled) return { ok: false, text: "review-desk 已禁用" };
		if (!existsSync(helper)) {
			return { ok: false, text: `helper 不存在：${helper}` };
		}
		const url = resolveUrl(ctx, config);
		const args = ["ensure", ...common(), "--url", url, "--panelSeconds", String(config.panelSeconds)];
		if (config.edgePath.trim() !== "") args.push("--edge", config.edgePath.trim());
		const result = interpret(await run(args, 45000));
		audit.append("prepare", { ok: result.ok, desktop: config.desktopName, error: result.ok ? undefined : result.text });
		return result;
	};

	/**
	 * 打开或复用复验桌面，并把当前桌面切过去。
	 * 这是显式动作；不要在任何自动流程里调用。
	 * @returns {Promise<{ok:boolean, text:string}>} 结果
	 */
	const open = async () => {
		if (!config.enabled) return { ok: false, text: "review-desk 已禁用" };
		if (!existsSync(helper)) {
			return { ok: false, text: `helper 不存在：${helper}` };
		}
		const url = resolveUrl(ctx, config);
		const args = ["open", ...common(), "--url", url, "--panelSeconds", String(config.panelSeconds)];
		if (config.edgePath.trim() !== "") args.push("--edge", config.edgePath.trim());

		if (config.autoReturnSeconds > 0) {
			const watchdog = spawn(helper, ["watchdog", "--seconds", String(config.autoReturnSeconds)], {
				detached: true,
				windowsHide: true,
				stdio: "ignore"
			});
			watchdog.unref();
		}

		const result = await run(args, 45000);
		const interpreted = interpret(result);
		if (interpreted.ok) deskOpen = true;
		audit.append("open", { ok: interpreted.ok, desktop: config.desktopName, error: interpreted.ok ? undefined : interpreted.text });
		return interpreted;
	};

	/**
	 * 切回默认桌面。
	 * @returns {Promise<{ok:boolean, text:string}>} 结果
	 */
	const returnHome = async () => {
		const result = await run(["return", "--state", statePath], 15000);
		const interpreted = interpret(result);
		if (interpreted.ok) deskOpen = false;
		audit.append("return", { ok: interpreted.ok, error: interpreted.ok ? undefined : interpreted.text });
		return interpreted;
	};

	/**
	 * 关闭复验桌面、清理进程和 profile。
	 * @returns {Promise<{ok:boolean, text:string}>} 结果
	 */
	const close = async () => {
		const result = await run(["close", "--state", statePath], 30000);
		const interpreted = interpret(result);
		if (interpreted.ok) deskOpen = false;
		audit.append("close", { ok: interpreted.ok, error: interpreted.ok ? undefined : interpreted.text });
		return interpreted;
	};

	/**
	 * 读取状态。
	 * @returns {Promise<object>} 状态
	 */
	const status = async () => {
		const result = await run(["status", "--state", statePath], 10000);
		const interpreted = interpret(result);
		return {
			ok: interpreted.ok,
			text: interpreted.text,
			deskOpen,
			helper,
			statePath,
			profilePath,
			...parseStatus(result.stdout)
		};
	};

	/**
	 * 在复验桌面里跑一段 PowerShell。
	 *
	 * 关键：helper 用 `STARTUPINFO.lpDesktop` 把 powershell.exe 放到私有桌面；
	 * 它派生出来的 GUI 子进程也继承这个桌面，所以不会出现在当前桌面。
	 * 这里只执行，不切屏。
	 *
	 * @param {string} command PowerShell 命令
	 * @returns {Promise<{ok:boolean, text:string, exitCode?:number, output?:string}>} 结果
	 */
	const runTask = async (command) => {
		if (!config.enabled) return { ok: false, text: "review-desk 已禁用" };
		if (!existsSync(helper)) return { ok: false, text: `helper 不存在：${helper}` };
		const scriptBody = String(command ?? "").trim();
		if (scriptBody === "") {
			return { ok: false, text: "用法：/review-desk run <PowerShell 命令>" };
		}

		const work = join(tmpdir(), "dsh-review-desk");
		mkdirSync(work, { recursive: true });
		const id = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
		const scriptPath = join(work, `run-${id}.ps1`);
		const logPath = join(work, `run-${id}.log`);
		const cwd = process.cwd();
		const script = [
			"$ErrorActionPreference = 'Stop'",
			"[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
			"$OutputEncoding = [Console]::OutputEncoding",
			`Set-Location -LiteralPath ${psQuote(cwd)}`,
			scriptBody,
			"exit $LASTEXITCODE"
		].join("\r\n");

		try {
			// Windows PowerShell 5.1 的 -File 在没有 BOM 时按 ANSI 解码；
			// 带中文路径的 cwd 会变成乱码，所以显式写 UTF-8 BOM。
			writeFileSync(scriptPath, `\uFEFF${script}`, "utf8");
		} catch (error) {
			return { ok: false, text: `无法写任务脚本：${error?.message ?? error}` };
		}

		const timeoutMs = Math.max(1000, config.runTimeoutSeconds * 1000);
		const args = [
			"run",
			...common(),
			"--script", scriptPath,
			"--log", logPath,
			"--cwd", cwd,
			"--timeout", String(timeoutMs)
		];

		let result;
		try {
			result = await run(args, timeoutMs + 15000);
		} finally {
			try { unlinkSync(scriptPath); } catch {}
		}

		let output = "";
		try {
			output = readFileSync(logPath, "utf8");
		} catch {}
		try { unlinkSync(logPath); } catch {}

		const header = result.stdout.split(/\r?\n/u).find((line) => line.startsWith("OK run ")) ?? "";
		const exitMatch = /(?:^|\s)exit=(\d+)/u.exec(header);
		const exitCode = exitMatch ? Number(exitMatch[1]) : result.code;
		const timedOut = /(?:^|\s)timeout=1(?:$|\s)/u.test(header);
		let body = output.trim();
		if (body.length > config.runOutputLimit) {
			body = `${body.slice(0, config.runOutputLimit)}\n…（输出已截断，共 ${body.length} 字符）`;
		}

		const ok = result.code === 0 && !timedOut;
		const summary = timedOut
			? `任务超时（${config.runTimeoutSeconds}s），已在复验桌面终止`
			: ok
				? `任务完成，exit=${exitCode}`
				: `任务失败，exit=${exitCode}`;
		const text = [`${summary}（复验桌面，未切屏）`, body].filter((part) => part !== "").join("\n\n");
		audit.append("run", { ok, exitCode, timedOut, command: scriptBody.slice(0, 200) });
		return { ok, text, exitCode, output: body };
	};

	/**
	 * 执行一个动作。
	 * @param {string} action 动作
	 * @param {string} [arg] 参数（show/run 用）
	 * @returns {Promise<{ok:boolean, text:string}>} 结果
	 */
	const act = async (action, arg) => {
		switch (action) {
			case "prepare":
			case "ensure":
				return prepare();
			case "open": return open();
			case "return": return returnHome();
			case "close": return close();
			case "status": {
				const s = await status();
				return { ok: s.ok, text: s.text };
			}
			case "list":
			case "reviews":
				return { ok: true, text: formatReviewList(reviews.list(20)) };
			case "show": {
				const record = reviews.get(arg ?? "");
				return record === undefined
					? { ok: false, text: `找不到复验记录：${arg ?? ""}（先 /review-desk list）` }
					: { ok: true, text: formatReview(record) };
			}
			case "audit": {
				const lines = audit.tail(20);
				return { ok: true, text: lines.length === 0 ? "还没有审计记录" : lines.join("\n") };
			}
			case "run":
			case "exec":
				return runTask(arg ?? "");
			default:
				return { ok: false, text: `未知动作：${action}（可用 prepare / open / return / close / status / list / show / audit / run）` };
		}
	};

	// 复验记录：只观察，不阻塞 turn。任何采集异常都吞掉，不能影响 DSH。
	ctx.on?.("session/event", (session, event) => {
		try {
			reviews.observe(session, event);
			if (config.auditTurns && event?.type === "turn/end") {
				audit.append("turn/end", {
					sessionId: session?.header?.id ?? session?.id,
					turn: event.data?.turn,
					reason: event.data?.reason?.kind
				});
			}
		} catch (error) {
			ctx?.logger?.warn?.(`review-desk: review observe failed: ${error?.message ?? error}`);
		}
	});

	// 命令：/review-desk prepare|open|return|close|status|list|show
	// 不能在 apply 顶层直接 ctx.get('commands')：bundle apply 时依赖服务可能还没 active，
	// 会抛 inactive context，导致整个插件加载失败。用 inject 等 commands 就绪。
	const registerCommands = (commands) => {
		if (commands === undefined || commands === null || typeof commands.register !== "function") return undefined;
		return commands.register({
			name: "review-desk",
			description: "DSH 后台复验桌面：prepare 只后台准备，open 显式切过去，list/show 看复验记录",
			input: { hint: "prepare | open | return | close | status | list | show <turn> | audit | run <命令>" },
			handler: async (invocation) => {
				const raw = String(invocation?.rawInput ?? "").trim();
				const parts = raw.split(/\s+/u).filter((part) => part !== "");
				const action = (parts[0] || "status").toLowerCase();
				const rest = raw.slice(parts[0]?.length ?? 0).trim().replace(/^--\s*/u, "");
				const result = await act(action, rest);
				return result.ok
					? { kind: "success", text: result.text }
					: { kind: "error", text: result.text };
			}
		});
	};

	if (typeof ctx.inject === "function") {
		ctx.inject(["commands"], (scope) => registerCommands(scope.commands));
	} else {
		registerCommands(ctx?.get?.("commands") ?? ctx?.commands);
	}

	// 插件卸载时尽量把桌面收掉，避免留下不可见进程。
	ctx.effect?.(() => async () => {
		if (disposed) return;
		disposed = true;
		if (!config.closeOnDispose || !existsSync(helper)) return;
		await run(["close", "--state", statePath], 30000).catch(() => undefined);
	});

	// 给后续客户端面板/路由用的 Host 服务；当前只有命令层消费。
	// 服务名冲突等异常不能让整个插件加载失败。
	try {
		ctx.provide?.("reviewDesk", {
			prepare,
			open,
			returnHome,
			close,
			status,
			run: runTask,
			reviews
		});
	} catch (error) {
		ctx?.logger?.warn?.(`review-desk: provide reviewDesk failed: ${error?.message ?? error}`);
	}

	// 记录一行启动日志，方便排查 helper 路径。
	ctx?.logger?.info?.(`review-desk: helper=${helper} state=${statePath}`);

	return {
		dispose: async () => {
			if (disposed) return;
			disposed = true;
			if (config.closeOnDispose && existsSync(helper)) {
				await run(["close", "--state", statePath], 30000).catch(() => undefined);
			}
		},
		status,
		prepare,
		open,
		returnHome,
		close
	};
}

/**
 * 复验记录列表的可读文本。
 * @param {object[]} records 记录
 * @returns {string} 文本
 */
function formatReviewList(records) {
	if (records.length === 0) return "还没有复验记录；跑完一个 turn 后再 /review-desk list";
	return records.map((record) => {
		const reason = record.reason?.kind ?? "running";
		const duration = record.durationMs === undefined ? "?" : `${record.durationMs}ms`;
		return `${record.id}  ${reason}  tools=${record.tools.length}  files=${record.changes.files.length}/${record.changes.total}  ${duration}`;
	}).join("\n");
}

/**
 * 单条复验记录的可读文本。
 * @param {object} record 记录
 * @returns {string} 文本
 */
function formatReview(record) {
	const text = JSON.stringify(record, null, 2);
	return text.length > 6000 ? `${text.slice(0, 5999)}…` : text;
}

/**
 * 把 helper 的 `k=v` 输出解析成对象。
 * @param {string} text 输出
 * @returns {Record<string, string>} 字段
 */
function parseStatus(text) {
	const out = {};
	for (const line of String(text ?? "").split(/\r?\n/u)) {
		const eq = line.indexOf("=");
		if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
	}
	return out;
}

/**
 * cordis 插件入口。
 * @param {any} ctx cordis 上下文
 * @param {object} rawConfig 部署配置
 */
export function apply(ctx, rawConfig) {
	createPlugin(ctx, rawConfig);
}
