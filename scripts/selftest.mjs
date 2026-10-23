#!/usr/bin/env node
/**
 * Dependency-free unit tests for the host-side modules.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLog } from "../lib/audit.js";
import { apply, normalizeConfig } from "../lib/index.js";
import { ReviewStore } from "../lib/review.js";

const session = {
	id: "session-1",
	header: { id: "session-1", title: "demo", cwd: "C:/work/demo" }
};

let clock = 1_000;
const now = () => (clock += 10);

function makeStore(overrides = {}) {
	return new ReviewStore({
		now,
		workspaceChanges: () => ({
			summary: () => ({
				files: [
					{ path: "src/a.ts", display: "src/a.ts", added: 12, deleted: 3 },
					{ path: "img/logo.png", display: "img/logo.png", added: 0, deleted: 0, binary: true }
				],
				total: 2,
				added: 12,
				deleted: 3
			})
		}),
		...overrides
	});
}

function feedSuccess(store) {
	store.observe(session, { type: "turn/start", data: { turn: 1 } });
	store.observe(session, {
		type: "tool/call",
		data: {
			turn: 1,
			step: 1,
			callId: "call-1",
			name: "bash",
			arguments: { command: "echo hi", token: "super-secret-token" }
		}
	});
	store.observe(session, {
		type: "tool/result",
		data: { turn: 1, step: 1, message: { source: { callId: "call-1" }, isError: false } }
	});
	store.observe(session, { type: "workspace/changes", seq: 7, data: { turn: 1 } });
	return store.observe(session, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
}

// 1. Successful packet, summary read at turn/end, no argument values by default.
{
	const store = makeStore();
	const record = feedSuccess(store);
	assert.ok(record, "turn/end returns the completed record");
	assert.equal(record.id, "session-1:1");
	assert.equal(record.reason.kind, "completed");
	assert.equal(record.tools.length, 1);
	assert.equal(record.tools[0].status, "ok");
	assert.deepEqual(record.tools[0].keys, ["command", "token"]);
	assert.equal(record.changes.state, "ok");
	assert.equal(record.changes.total, 2);
	assert.equal(record.changes.files[0].display, "src/a.ts");
	assert.equal(record.changes.files[1].binary, true);
	assert.equal(record.evidenceState, "ok");
	assert.equal(JSON.stringify(record).includes("super-secret-token"), false, "argument values must not leak");
	assert.equal(store.list().length, 1);
	assert.equal(store.get("1")?.id, "session-1:1");
}

// 2. Missing summary degrades to partial, never fabricates files.
{
	const store = makeStore({ workspaceChanges: () => ({ summary: () => undefined }) });
	const record = feedSuccess(store);
	assert.equal(record.changes.state, "partial");
	assert.equal(record.changes.files.length, 0);
	assert.equal(record.evidenceState, "partial");
}

// 3. No workspace/changes event is unavailable.
{
	const store = makeStore();
	store.observe(session, { type: "turn/start", data: { turn: 2 } });
	const record = store.observe(session, { type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } });
	assert.equal(record.changes.state, "unavailable");
	assert.equal(record.changes.files.length, 0);
}

// 4. Tool errors are recorded without output bodies.
{
	const store = makeStore();
	store.observe(session, { type: "turn/start", data: { turn: 3 } });
	store.observe(session, { type: "tool/call", data: { turn: 3, callId: "c3", name: "pwsh", arguments: {} } });
	store.observe(session, {
		type: "tool/result",
		data: {
			turn: 3,
			message: { source: { callId: "c3" }, isError: true },
			error: { code: "E_TOOL", message: "boom" }
		}
	});
	const record = store.observe(session, { type: "turn/end", data: { turn: 3, reason: { kind: "failed" } } });
	assert.equal(record.tools[0].status, "error");
	assert.equal(record.tools[0].error, "boom");
	assert.equal(JSON.stringify(record).includes("stdout"), false);
}

// 5. Config validation.
{
	const config = normalizeConfig({});
	assert.equal(config.desktopName, "DSH-Review-Desk");
	assert.equal(config.reviewLimit, 50);
	assert.equal(config.audit, true);
	assert.throws(() => normalizeConfig({ enabled: "yes" }), TypeError);
	assert.throws(() => normalizeConfig({ reviewLimit: 0 }), RangeError);
	assert.throws(() => normalizeConfig({ desktopName: " " }), TypeError);
}

// 6. Audit log appends JSONL and tails it.
{
	const dir = mkdtempSync(join(tmpdir(), "dsh-review-desk-"));
	try {
		const audit = new AuditLog({ path: join(dir, "audit.jsonl") });
		audit.append("prepare", { ok: true, desktop: "DSH-Review-Desk" });
		audit.append("close", { ok: true, error: "line\nbreak" });
		const lines = audit.tail(10);
		assert.equal(lines.length, 2);
		const first = JSON.parse(lines[0]);
		assert.equal(first.action, "prepare");
		assert.equal(first.ok, true);
		assert.equal(first.desktop, "DSH-Review-Desk");
		assert.equal(JSON.parse(lines[1]).error, "line break");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// 7. apply must wait for the commands service instead of reading it eagerly.
{
	let definition;
	let injected;
	const ctx = {
		inject(services, callback) {
			injected = { services, callback };
		},
		get(name) {
			if (name === "commands") throw new Error("commands must be injected, not read eagerly");
			return undefined;
		},
		provide() {},
		on() {},
		effect() {},
		logger: { info() {}, warn() {} }
	};
	apply(ctx, {
		statePath: join(tmpdir(), "dsh-review-desk-apply-state.txt"),
		profilePath: join(tmpdir(), "dsh-review-desk-apply-profile")
	});
	assert.deepEqual(injected.services, ["commands"]);
	injected.callback({
		commands: {
			register(value) {
				definition = value;
				return () => {};
			}
		}
	});
	assert.equal(definition.name, "review-desk");
	assert.equal(typeof definition.handler, "function");
}

// 8. Private-desktop command runner: config and empty-command guard.
{
	const config = normalizeConfig({});
	assert.equal(config.runTimeoutSeconds, 120);
	assert.equal(config.runOutputLimit, 20000);
	assert.throws(() => normalizeConfig({ runTimeoutSeconds: -1 }), RangeError);
	assert.throws(() => normalizeConfig({ runOutputLimit: 10 }), RangeError);

	let definition;
	const ctx = {
		inject(_services, callback) {
			callback({
				commands: {
					register(value) {
						definition = value;
						return () => {};
					}
				}
			});
		},
		get() { return undefined; },
		provide() {},
		on() {},
		effect() {},
		logger: { info() {}, warn() {} }
	};
	apply(ctx, {
		statePath: join(tmpdir(), "dsh-review-desk-run-state.txt"),
		profilePath: join(tmpdir(), "dsh-review-desk-run-profile")
	});
	const result = await definition.handler({ rawInput: "run" });
	assert.equal(result.kind, "error");
	assert.match(result.text, /用法/u);
}

console.log("OK 8 test groups");
