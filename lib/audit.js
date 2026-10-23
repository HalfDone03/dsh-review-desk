/**
 * 轻量审计日志：只记动作和状态，不记会话正文、工具输出、token。
 *
 * 文件是 JSONL；超过上限时滚动成 `.1`，只保留一代。
 *
 * @module dsh-review-desk/audit
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_VALUE = 240;

/**
 * 只保留标量，避免把整个请求/响应写进审计。
 * @param {unknown} value 值
 * @returns {string | number | boolean | undefined} 安全值
 */
function scalar(value) {
	if (typeof value === "string") {
		const text = value.replace(/\s+/gu, " ").trim();
		return text.length > MAX_VALUE ? `${text.slice(0, MAX_VALUE - 1)}…` : text;
	}
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "boolean") return value;
	return undefined;
}

/** 审计日志。 */
export class AuditLog {
	/**
	 * @param {object} [options] 选项
	 * @param {string} [options.path] 文件路径
	 * @param {boolean} [options.enabled] 是否写入
	 */
	constructor(options = {}) {
		this.path = options.path ?? "";
		this.enabled = options.enabled !== false && this.path !== "";
	}

	/**
	 * 追加一条。
	 * @param {string} action 动作
	 * @param {Record<string, unknown>} [detail] 字段
	 */
	append(action, detail = {}) {
		if (!this.enabled) return;
		const entry = { time: new Date().toISOString(), action };
		for (const [key, value] of Object.entries(detail)) {
			const safe = scalar(value);
			if (safe !== undefined) entry[key] = safe;
		}
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			if (existsSync(this.path) && statSync(this.path).size > MAX_BYTES) {
				renameSync(this.path, `${this.path}.1`);
			}
			appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
		} catch {
			// 审计失败不能影响主流程。
		}
	}

	/**
	 * 读取最后若干行，供 `/review-desk audit` 使用。
	 * @param {number} [limit] 行数
	 * @returns {string[]} 行
	 */
	tail(limit = 20) {
		if (!this.enabled || !existsSync(this.path)) return [];
		try {
			const lines = readFileSync(this.path, "utf8").split(/\r?\n/u).filter((line) => line !== "");
			return lines.slice(-Math.max(1, Math.min(200, limit)));
		} catch {
			return [];
		}
	}
}
