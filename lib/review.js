/**
 * 复验记录（review packet）采集与内存队列。
 *
 * 事件语义（已核对 DSH 源码）：
 *  - `tool/call`   { turn, step, callId, name, arguments }
 *  - `tool/result` { turn, step, message, error?, meta? }，callId 在 message.source.callId
 *  - `workspace/changes` 只带 turn；文件列表要 `ctx.workspaceChanges.summary(sessionId, seq)`
 *  - summary 只有 path/display/added/deleted，可能 binary/oversized；没有变更类型
 *
 * 不持久化、不保存完整工具输出；默认连参数值都不存，只存 key。
 *
 * @module dsh-review-desk/review
 */

/** 单条记录最多保留的文件数。 */
const MAX_FILES = 200;
/** 工具参数预览的最大字符数。 */
const ARG_PREVIEW = 160;

/**
 * 把工具参数压成可安全展示的摘要。
 * @param {unknown} args 参数
 * @param {boolean} includeValues 是否包含已知安全字段的值
 * @returns {{keys: string[], preview?: string}} 摘要
 */
function summarizeArgs(args, includeValues) {
	if (args === null || typeof args !== "object") return { keys: [] };
	const keys = Object.keys(args).sort();
	if (!includeValues) return { keys };
	const safe = ["command", "cmd", "path", "file_path", "filePath", "query", "url", "pattern"];
	const picked = [];
	for (const key of safe) {
		const value = args[key];
		if (typeof value === "string" && value.trim() !== "") {
			const text = value.replace(/\s+/gu, " ").trim();
			picked.push(`${key}=${text.length > ARG_PREVIEW ? `${text.slice(0, ARG_PREVIEW - 1)}…` : text}`);
		}
	}
	return picked.length === 0 ? { keys } : { keys, preview: picked.join(" ") };
}

/**
 * 从 turn/end 的 reason 里提取一个可读结论。
 * @param {unknown} reason 结束原因
 * @returns {{kind: string, message?: string}} 结论
 */
function reasonOf(reason) {
	if (reason === null || typeof reason !== "object") return { kind: "unknown" };
	const kind = typeof reason.kind === "string" ? reason.kind : "unknown";
	const error = reason.error ?? reason.failure;
	const message = typeof error?.message === "string"
		? error.message
		: typeof error?.code === "string" ? error.code : undefined;
	return message === undefined ? { kind } : { kind, message };
}

/** 一条复验记录的内存采集器。 */
export class ReviewStore {
	/**
	 * @param {object} [options] 选项
	 * @param {number} [options.limit] 最多保留条数
	 * @param {() => any} [options.workspaceChanges] 取 workspaceChanges 服务
	 * @param {boolean} [options.includeToolArgs] 是否保存参数值预览
	 * @param {() => number} [options.now] 时钟
	 */
	constructor(options = {}) {
		this.limit = Math.max(1, Math.round(options.limit ?? 50));
		this.workspaceChanges = options.workspaceChanges ?? (() => undefined);
		this.includeToolArgs = options.includeToolArgs === true;
		this.now = options.now ?? (() => Date.now());
		this.records = new Map();
		this.order = [];
	}

	/**
	 * 消费一个 session 事件。
	 * @param {any} session 会话
	 * @param {any} event 事件
	 * @returns {object | undefined} 完成时返回记录
	 */
	observe(session, event) {
		if (event === null || typeof event !== "object") return undefined;
		const sessionId = session?.header?.id ?? session?.id ?? "unknown";
		const data = event.data ?? {};
		const turn = Number(data.turn);

		if (event.type === "turn/start") {
			if (!Number.isSafeInteger(turn)) return undefined;
			const record = {
				id: `${sessionId}:${turn}`,
				sessionId,
				title: session?.header?.title ?? String(sessionId).slice(0, 8),
				cwd: session?.header?.cwd ?? "",
				turn,
				startedAt: this.now(),
				endedAt: undefined,
				durationMs: undefined,
				reason: undefined,
				tools: [],
				changes: { state: "unavailable", files: [], total: 0, added: 0, deleted: 0 },
				lastChangeSeq: undefined,
				evidenceState: "partial"
			};
			this.#put(record);
			return undefined;
		}

		const record = this.#forTurn(sessionId, turn);
		if (record === undefined) return undefined;

		if (event.type === "tool/call") {
			const callId = String(data.callId ?? "");
			if (callId === "") return undefined;
			if (!record.tools.some((tool) => tool.callId === callId)) {
				record.tools.push({
					callId,
					name: String(data.name ?? "unknown"),
					step: Number.isSafeInteger(Number(data.step)) ? Number(data.step) : undefined,
					startedAt: this.now(),
					status: "running",
					...summarizeArgs(data.arguments, this.includeToolArgs)
				});
			}
			return undefined;
		}

		if (event.type === "tool/result") {
			const callId = String(data.message?.source?.callId ?? data.callId ?? "");
			const tool = record.tools.find((entry) => entry.callId === callId);
			if (tool !== undefined) {
				const isError = data.message?.isError === true || data.error !== undefined;
				tool.status = isError ? "error" : "ok";
				tool.endedAt = this.now();
				const error = data.error ?? {};
				if (isError) {
					tool.error = String(error.message ?? error.code ?? "tool error").slice(0, 240);
				}
			}
			return undefined;
		}

		if (event.type === "workspace/changes") {
			if (Number.isSafeInteger(event.seq)) record.lastChangeSeq = event.seq;
			return undefined;
		}

		if (event.type !== "turn/end") return undefined;
		record.endedAt = this.now();
		record.durationMs = Math.max(0, record.endedAt - record.startedAt);
		record.reason = reasonOf(data.reason);
		record.changes = this.#readChanges(session, record);
		record.evidenceState = record.changes.state === "ok" ? "ok" : "partial";
		return record;
	}

	/**
	 * 最近记录，新的在前。
	 * @param {number} [limit] 条数
	 * @returns {object[]} 记录副本
	 */
	list(limit = 20) {
		const count = Math.max(1, Math.min(this.limit, Math.round(limit)));
		return this.order.slice(-count).reverse().map((id) => this.records.get(id));
	}

	/**
	 * 按 id 或 turn 取一条。
	 * @param {string | number} key id 或 turn
	 * @returns {object | undefined} 记录
	 */
	get(key) {
		const text = String(key);
		const direct = this.records.get(text);
		if (direct !== undefined) return direct;
		for (const id of this.order) {
			const record = this.records.get(id);
			if (record !== undefined && String(record.turn) === text) return record;
		}
		return undefined;
	}

	/** 清空。 */
	clear() {
		this.records.clear();
		this.order.length = 0;
	}

	/**
	 * 找当前 turn 的草稿；没有就补一个。
	 * @param {string} sessionId 会话 id
	 * @param {number} turn turn
	 * @returns {object | undefined} 记录
	 */
	#forTurn(sessionId, turn) {
		if (!Number.isSafeInteger(turn)) return undefined;
		const id = `${sessionId}:${turn}`;
		let record = this.records.get(id);
		if (record === undefined) {
			record = {
				id,
				sessionId,
				title: String(sessionId).slice(0, 8),
				cwd: "",
				turn,
				startedAt: this.now(),
				endedAt: undefined,
				durationMs: undefined,
				reason: undefined,
				tools: [],
				changes: { state: "unavailable", files: [], total: 0, added: 0, deleted: 0 },
				lastChangeSeq: undefined,
				evidenceState: "partial"
			};
			this.#put(record);
		}
		return record;
	}

	/**
	 * 读 workspace summary；任何缺失都标 partial，不伪造。
	 * @param {any} session 会话
	 * @param {object} record 记录
	 * @returns {{state: string, files: object[], total: number, added: number, deleted: number, note?: string}} 变更摘要
	 */
	#readChanges(session, record) {
		if (!Number.isSafeInteger(record.lastChangeSeq)) {
			return { state: "unavailable", files: [], total: 0, added: 0, deleted: 0, note: "本轮没有 workspace/changes 事件" };
		}
		let service;
		try {
			service = this.workspaceChanges();
		} catch {
			service = undefined;
		}
		if (service === undefined || typeof service.summary !== "function") {
			return { state: "unavailable", files: [], total: 0, added: 0, deleted: 0, note: "workspaceChanges 服务不可用" };
		}
		let summary;
		try {
			summary = service.summary(session.id ?? session.header?.id, record.lastChangeSeq);
		} catch {
			summary = undefined;
		}
		if (summary === undefined || summary === null) {
			return { state: "partial", files: [], total: 0, added: 0, deleted: 0, note: "summary 尚未就绪或会话已释放" };
		}
		const files = Array.isArray(summary.files) ? summary.files.slice(0, MAX_FILES).map((file) => ({
			path: String(file?.path ?? ""),
			display: String(file?.display ?? file?.path ?? ""),
			added: Number(file?.added ?? 0),
			deleted: Number(file?.deleted ?? 0),
			...(file?.binary === true ? { binary: true } : {}),
			...(file?.oversized === true ? { oversized: true } : {})
		})) : [];
		return {
			state: "ok",
			files,
			total: Number(summary.total ?? files.length),
			added: Number(summary.added ?? 0),
			deleted: Number(summary.deleted ?? 0),
			...(summary.snapshot === undefined ? {} : { snapshot: summary.snapshot })
		};
	}

	/**
	 * 放入并保持上限。
	 * @param {object} record 记录
	 */
	#put(record) {
		if (!this.records.has(record.id)) this.order.push(record.id);
		this.records.set(record.id, record);
		while (this.order.length > this.limit) {
			const id = this.order.shift();
			if (id !== undefined) this.records.delete(id);
		}
	}
}
