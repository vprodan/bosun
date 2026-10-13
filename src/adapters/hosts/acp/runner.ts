import path from "node:path";
import { BosunError } from "../../../core/errors.ts";
import { requirePublicInput } from "../../../core/policy.ts";
import { screenPublicText } from "../../../core/secret-screen.ts";
import type { AcpSettings } from "../../../core/domain/config.ts";
import type { Env } from "../../../core/domain/inference.ts";
import type {
	AgentRunner,
	RunEvent,
	RunSpec,
} from "../../../core/ports/runner.ts";
import {
	executable,
	streamProcess,
	type ProcessInput,
} from "../../../platform/process.ts";
import { version } from "../../../platform/assets.ts";

type Options = {
	id: string;
	profile: AcpSettings;
	env: Env;
	killGraceMs?: number;
};
type Pending = {
	resolve(value: unknown): void;
	reject(error: BosunError): void;
	timer: ReturnType<typeof setTimeout>;
	accept?(value: unknown): void;
};
type Selector = { current: string; values: Set<string> };
const object = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 256): value is string =>
	typeof value === "string" &&
	!!value &&
	!/[\x00-\x1f\x7f]/.test(value) &&
	Buffer.byteLength(value) <= max;
const failed = (
	code: "unavailable" | "cancelled" | "timeout" = "unavailable",
) =>
	new BosunError(
		code,
		code === "cancelled"
			? "ACP execution cancelled"
			: code === "timeout"
				? "ACP execution timed out"
				: "ACP execution unavailable",
		{ details: { outcome: "unknown" } },
	);
function selectors(value: unknown): Map<string, Selector> {
	if (!Array.isArray(value) || value.length > 64) throw failed();
	const result = new Map<string, Selector>();
	for (const entry of value) {
		if (
			!object(entry) ||
			!text(entry.id) ||
			!text(entry.name) ||
			result.has(entry.id) ||
			entry.type !== "select" ||
			!text(entry.currentValue) ||
			!Array.isArray(entry.options) ||
			!entry.options.length ||
			entry.options.length > 128
		)
			throw failed();
		const values = new Set<string>();
		let grouped: boolean | undefined;
		const add = (option: unknown) => {
			if (
				!object(option) ||
				!text(option.value) ||
				!text(option.name) ||
				values.has(option.value) ||
				values.size >= 256
			)
				throw failed();
			values.add(option.value);
		};
		const groups = new Set<string>();
		for (const option of entry.options) {
			if (!object(option)) throw failed();
			const isGroup = Object.hasOwn(option, "group");
			if (grouped !== undefined && grouped !== isGroup) throw failed();
			grouped = isGroup;
			if (!isGroup) add(option);
			else {
				if (
					!text(option.group) ||
					!text(option.name) ||
					groups.has(option.group) ||
					!Array.isArray(option.options) ||
					!option.options.length ||
					option.options.length > 128
				)
					throw failed();
				groups.add(option.group);
				for (const item of option.options) add(item);
			}
		}
		if (!values.has(entry.currentValue)) throw failed();
		result.set(entry.id, { current: entry.currentValue, values });
	}
	return result;
}

// ACP v1, one new session and one prompt. No authentication, resume, retry or
// native managed-session capability is inferred from protocol support. A client
// without fs/terminal capabilities cannot constrain an agent's own tool stack.
export function createAcpRunner(options: Options): AgentRunner {
	return {
		id: options.id,
		caps: Object.freeze({
			vendor: "acp",
			readOnly: "unverified",
			sandbox: "unverified",
			mcpInject: "unsupported",
			effort: "verified",
			localBackend: "unverified",
			billing: "unknown",
		}),
		async detect(env) {
			const command = executable(options.profile.command, env);
			return command
				? {
						installed: true,
						path: command,
						notes: ["protocol_identity_unverified"],
					}
				: { installed: false };
		},
		async *run(spec: RunSpec): AsyncGenerator<RunEvent> {
			requirePublicInput(spec);
			if (spec.access !== "read" && spec.access !== "edit")
				throw new BosunError("invalid", "Invalid ACP access");
			if (spec.access === "read")
				throw new BosunError(
					"unverified",
					"ACP read-only tool policy is unverified",
				);
			if (
				spec.managed !== undefined ||
				spec.maxTurns !== undefined ||
				(spec.mcp !== undefined &&
					(!Array.isArray(spec.mcp) || spec.mcp.length !== 0)) ||
				spec.env !== undefined
			)
				throw new BosunError("unsupported", "ACP execution option unsupported");
			if (
				!text(spec.cwd, 4096) ||
				!path.isAbsolute(spec.cwd) ||
				path.resolve(spec.cwd) !== spec.cwd ||
				!text(spec.model) ||
				(spec.effort !== undefined && !text(spec.effort)) ||
				typeof spec.prompt !== "string" ||
				!spec.prompt.trim() ||
				spec.prompt.includes("\0") ||
				Buffer.byteLength(spec.prompt) > 32768
			)
				throw new BosunError("invalid", "Invalid ACP request");
			screenPublicText(spec.prompt);
			if (spec.signal.aborted)
				throw new BosunError("cancelled", "ACP execution cancelled");
			const profile = options.profile;
			if (
				!/^acp-[a-z][a-z0-9-]{0,39}$/.test(options.id) ||
				profile.protocolVersion !== 1 ||
				!profile.enabled ||
				!text(profile.command, 4096) ||
				!text(profile.agentName, 200) ||
				!text(profile.agentVersion, 200) ||
				!Array.isArray(profile.args) ||
				profile.args.length > 64 ||
				profile.args.some(
					(arg) =>
						typeof arg !== "string" ||
						arg.includes("\0") ||
						Buffer.byteLength(arg) > 4096,
				) ||
				!Number.isSafeInteger(profile.timeoutMs) ||
				profile.timeoutMs < 1000 ||
				profile.timeoutMs > 86400000
			)
				throw new BosunError("invalid", "Invalid ACP profile");
			if (
				!text(profile.modelOption, 200) ||
				(spec.effort !== undefined && !text(profile.effortOption, 200)) ||
				profile.modelOption === profile.effortOption
			)
				throw new BosunError("unverified", "ACP selection is unverified");
			const env = { ...options.env, BOSUN_DEPTH: "1", BOSUN_CALLER: "model" };
			const command = executable(profile.command, env);
			if (!command)
				throw new BosunError("unavailable", "ACP executable unavailable");
			const control = new AbortController();
			const pending = new Map<number, Pending>();
			const events: RunEvent[] = [];
			const inboundIds = new Set<string>();
			const tools = new Map<string, string>();
			const acknowledged = new Map<string, string>();
			let input: ProcessInput | undefined;
			let failure: BosunError | undefined;
			let session: string | undefined;
			let state: Map<string, Selector> | undefined;
			let counter = 0;
			let messages = 0;
			let eventCount = 0;
			let outputBytes = 0;
			let promptStarted = false;
			let promptFinished = false;
			let cancelled = false;
			let closed = false;
			let terminated = false;
			let nativeExit:
				| { code: number | null; signal: NodeJS.Signals | null }
				| undefined;
			let result = "";
			let wake: (() => void) | undefined;
			let cancelTimer: ReturnType<typeof setTimeout> | undefined;
			let attach!: () => void;
			let attachFailed!: (error: BosunError) => void;
			const attached = new Promise<void>((resolve, reject) => {
				attach = resolve;
				attachFailed = reject;
			});
			const notify = () => {
				const previous = wake;
				wake = undefined;
				previous?.();
			};
			const stop = (error: BosunError) => {
				failure ??= error;
				control.abort();
				notify();
			};
			const emit = (event: RunEvent) => {
				if (++eventCount > 1024 || events.length >= 128) throw failed();
				events.push(event);
				notify();
			};
			const confirm = (optionsValue: unknown) => {
				state = selectors(optionsValue);
				for (const [id, selected] of acknowledged)
					if (
						state.get(id)?.current !== selected ||
						!state.get(id)?.values.has(selected)
					)
						throw failed();
			};
			const send = (body: Record<string, unknown>) =>
				input!.write(JSON.stringify({ jsonrpc: "2.0", ...body }) + "\n");
			const cancel = () => {
				if (cancelled || closed) return;
				cancelled = true;
				if (!promptStarted || promptFinished || !session) {
					stop(failed("cancelled"));
					return;
				}
				// The original prompt response, not this notification, is the receipt.
				void send({
					method: "session/cancel",
					params: { sessionId: session },
				}).catch(() => stop(failed("cancelled")));
				cancelTimer = setTimeout(
					() => stop(failed("cancelled")),
					Math.min(1000, profile.timeoutMs),
				);
				cancelTimer.unref();
				notify();
			};
			spec.signal.addEventListener("abort", cancel, { once: true });
			const pump = (async () => {
				try {
					for await (const event of streamProcess({
						command,
						args: profile.args,
						cwd: spec.cwd,
						env,
						signal: control.signal,
						timeoutMs: profile.timeoutMs,
						killGraceMs: options.killGraceMs,
						maxOutputBytes: 1048576,
						maxLineBytes: 65536,
						stdin(channel) {
							input = channel;
							attach();
						},
						onClosed() {
							terminated = true;
						},
					})) {
						if (event.t === "exit") {
							nativeExit = event;
							continue;
						}
						if (++messages > 2048) throw failed();
						let row: unknown;
						try {
							row = JSON.parse(event.text);
						} catch {
							throw failed();
						}
						if (!object(row) || row.jsonrpc !== "2.0") throw failed();
						if (Object.hasOwn(row, "method")) {
							if (
								!text(row.method, 160) ||
								Object.hasOwn(row, "result") ||
								Object.hasOwn(row, "error") ||
								!object(row.params)
							)
								throw failed();
							if (Object.hasOwn(row, "id")) {
								if (
									!(
										(Number.isSafeInteger(row.id) && Number(row.id) >= 0) ||
										text(row.id)
									) ||
									inboundIds.size >= 256
								)
									throw failed();
								const key = `${typeof row.id}:${row.id}`;
								if (inboundIds.has(key)) throw failed();
								inboundIds.add(key);
								if (row.method === "session/request_permission") {
									if (
										!promptStarted ||
										promptFinished ||
										row.params.sessionId !== session ||
										!object(row.params.toolCall) ||
										!text(row.params.toolCall.toolCallId) ||
										!Array.isArray(row.params.options) ||
										row.params.options.length > 32
									)
										throw failed();
									await send({
										id: row.id,
										result: { outcome: { outcome: "cancelled" } },
									});
									emit({ t: "permission", tool: "acp_tool", decision: "deny" });
								} else
									await send({
										id: row.id,
										error: {
											code: -32601,
											message: "Client operation unavailable",
										},
									});
								continue;
							}
							if (
								row.method !== "session/update" ||
								!session ||
								row.params.sessionId !== session ||
								!object(row.params.update)
							)
								throw failed();
							const update = row.params.update;
							if (update.sessionUpdate === "config_option_update") {
								confirm(update.configOptions);
								continue;
							}
							if (
								[
									"available_commands_update",
									"current_mode_update",
									"session_info_update",
									"usage_update",
								].includes(String(update.sessionUpdate))
							)
								continue;
							if (!promptStarted || promptFinished) throw failed();
							switch (update.sessionUpdate) {
								case "agent_message_chunk":
									if (
										!object(update.content) ||
										update.content.type !== "text" ||
										typeof update.content.text !== "string" ||
										update.content.text.includes("\0") ||
										Buffer.byteLength(update.content.text) > 32768 ||
										(outputBytes += Buffer.byteLength(update.content.text)) >
											262144
									)
										throw failed();
									result += update.content.text;
									emit({ t: "text", text: update.content.text });
									break;
								case "tool_call":
									if (
										!text(update.toolCallId) ||
										tools.has(update.toolCallId) ||
										tools.size >= 256
									)
										throw failed();
									if (
										update.status !== undefined &&
										!["pending", "in_progress", "completed", "failed"].includes(
											String(update.status),
										)
									)
										throw failed();
									tools.set(
										update.toolCallId,
										update.status === undefined
											? "pending"
											: String(update.status),
									);
									emit({ t: "tool", name: "acp_tool" });
									break;
								case "tool_call_update":
									if (!text(update.toolCallId) || !tools.has(update.toolCallId))
										throw failed();
									if (update.status !== undefined) {
										const previous = tools.get(update.toolCallId)!;
										if (
											![
												"pending",
												"in_progress",
												"completed",
												"failed",
											].includes(String(update.status)) ||
											(["completed", "failed"].includes(previous) &&
												update.status !== previous)
										)
											throw failed();
										tools.set(update.toolCallId, String(update.status));
									}
									break;
								case "agent_thought_chunk":
								case "user_message_chunk":
								case "plan":
									break;
								default:
									throw failed();
							}
							continue;
						}
						if (
							!Number.isSafeInteger(row.id) ||
							!pending.has(Number(row.id)) ||
							Object.hasOwn(row, "result") === Object.hasOwn(row, "error")
						)
							throw failed();
						const operation = pending.get(Number(row.id))!;
						pending.delete(Number(row.id));
						clearTimeout(operation.timer);
						if (Object.hasOwn(row, "error")) operation.reject(failed());
						else {
							try {
								operation.accept?.(row.result);
								operation.resolve(row.result);
							} catch {
								operation.reject(failed());
								throw failed();
							}
						}
					}
					if (
						pending.size ||
						!promptFinished ||
						nativeExit?.code !== 0 ||
						nativeExit.signal !== null
					)
						throw failed();
				} catch (error) {
					failure ??=
						error instanceof BosunError &&
						["cancelled", "timeout"].includes(error.code)
							? failed(error.code as "cancelled" | "timeout")
							: failed();
				} finally {
					closed = true;
					notify();
					attachFailed(failure ?? failed());
					for (const operation of pending.values()) {
						clearTimeout(operation.timer);
						operation.reject(failure ?? failed());
					}
					pending.clear();
				}
			})();
			async function request(
				method: string,
				params: Record<string, unknown>,
				accept?: (value: unknown) => void,
			): Promise<unknown> {
				if (!input || closed || failure || counter >= 16 || pending.size)
					throw failure ?? failed();
				const id = ++counter;
				const response = new Promise<unknown>((resolve, reject) => {
					const timer = setTimeout(
						() => stop(failed("timeout")),
						method === "session/prompt"
							? profile.timeoutMs
							: Math.min(10000, profile.timeoutMs),
					);
					timer.unref();
					pending.set(id, { resolve, reject, timer, accept });
				});
				void send({ id, method, params }).catch(() => stop(failed()));
				return response;
			}
			try {
				if (spec.signal.aborted) cancel();
				await attached;
				const initialized = await request("initialize", {
					protocolVersion: 1,
					clientCapabilities: {},
					clientInfo: { name: "bosun", version },
				});
				if (
					!object(initialized) ||
					initialized.protocolVersion !== 1 ||
					!object(initialized.agentInfo) ||
					initialized.agentInfo.name !== profile.agentName ||
					initialized.agentInfo.version !== profile.agentVersion ||
					!object(initialized.agentCapabilities)
				)
					throw new BosunError(
						"unverified",
						"ACP protocol identity is unverified",
					);
				await request(
					"session/new",
					{ cwd: spec.cwd, mcpServers: [] },
					(created) => {
						if (!object(created) || !text(created.sessionId)) throw failed();
						session = created.sessionId;
						confirm(created.configOptions);
					},
				);
				for (const [id, value] of [
					[profile.modelOption!, spec.model!],
					...(spec.effort === undefined
						? []
						: [[profile.effortOption!, spec.effort]]),
				]) {
					if (!state?.get(id)?.values.has(value))
						throw new BosunError(
							"unverified",
							"ACP selected value is unavailable",
						);
					await request(
						"session/set_config_option",
						{ sessionId: session, configId: id, value },
						(updated) => {
							if (!object(updated)) throw failed();
							acknowledged.set(id, value);
							confirm(updated.configOptions);
						},
					);
				}
				if (failure || cancelled) throw failure ?? failed("cancelled");
				promptStarted = true;
				let receipt: unknown;
				let settled = false;
				const prompted = request(
					"session/prompt",
					{ sessionId: session, prompt: [{ type: "text", text: spec.prompt }] },
					() => {
						promptFinished = true;
					},
				).then(
					(value) => {
						receipt = value;
						settled = true;
						notify();
					},
					(error) => {
						stop(error);
						settled = true;
					},
				);
				while (!settled && !failure) {
					while (events.length) yield events.shift()!;
					if (!settled && !failure && !events.length)
						await new Promise<void>((resolve) => {
							wake = resolve;
						});
				}
				await prompted;
				promptFinished = true;
				if (cancelTimer) clearTimeout(cancelTimer);
				if (
					failure ||
					!object(receipt) ||
					![
						"end_turn",
						"max_tokens",
						"max_turn_requests",
						"refusal",
						"cancelled",
					].includes(String(receipt.stopReason)) ||
					[...tools.values()].some(
						(status) => !["completed", "failed"].includes(status),
					)
				)
					throw failure ?? failed();
				// Close the one original process before publishing a completion receipt.
				input!.end();
				const joinTimer = setTimeout(() => stop(failed()), 1000);
				joinTimer.unref();
				try {
					await pump;
				} finally {
					clearTimeout(joinTimer);
				}
				if (
					failure ||
					!terminated ||
					nativeExit?.code !== 0 ||
					nativeExit.signal !== null
				)
					throw failure ?? failed();
				while (events.length) yield events.shift()!;
				if (cancelled && receipt.stopReason !== "cancelled")
					throw failed("cancelled");
				yield {
					t: "done",
					code: receipt.stopReason === "end_turn" ? 0 : 1,
					result:
						receipt.stopReason === "end_turn"
							? result
							: `ACP stopped: ${receipt.stopReason}`,
				};
			} finally {
				if (!closed) control.abort();
				await pump;
				if (cancelTimer) clearTimeout(cancelTimer);
				spec.signal.removeEventListener("abort", cancel);
				if (!terminated) throw failed();
			}
		},
	};
}
