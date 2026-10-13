import "./bootstrap.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { sandbox, type Sandbox } from "./helpers.ts";
import { runtimeFixture } from "./runtime-fixture.ts";
import { gitEnvelope } from "./git-fixture.ts";
import { createAcpRunner } from "../src/adapters/hosts/acp/runner.ts";
import {
	nativeRunners,
	nativeQuotaSources,
} from "../src/app/native-runners.ts";
import { openDaemonJobs } from "../src/app/jobs.ts";
import { defaultConfig, type AcpSettings } from "../src/core/domain/config.ts";
import {
	parseRuntimeConfig,
	renderRuntimeConfig,
} from "../src/platform/config.ts";
import { BosunError } from "../src/core/errors.ts";
import type { RunEvent, RunSpec } from "../src/core/ports/runner.ts";

// Invented protocol fixtures, not qualification of any real agent/version.
// ACP v1 primary references checked 2026-10-11:
// https://agentclientprotocol.com/protocol/v1/initialization
// https://agentclientprotocol.com/protocol/v1/prompt-turn
// https://agentclientprotocol.com/protocol/v1/session-config-options
// https://agentclientprotocol.com/protocol/v1/session-modes
const MODEL = "fixture-model:exact",
	EFFORT = "ultra";
const PROMPT =
	'Public task with "$HOME", `literal`, $(unchanged) and Unicode — exact.\n';
const RESULT = "Exact public ACP result — complete.";
function fixture(sb: Sandbox, mode = "success") {
	const file = path.join(sb.root, "acp.cjs"),
		trace = path.join(sb.root, "acp.jsonl");
	fs.writeFileSync(
		file,
		String.raw`
const fs=require('node:fs'),readline=require('node:readline');
const mode=process.argv[2],trace=process.env.ACP_TRACE,session='fixture-session',model=${JSON.stringify(MODEL)},effort=${JSON.stringify(EFFORT)};
const record=row=>fs.appendFileSync(trace,JSON.stringify(row)+'\n');
record({start:true,pid:process.pid,cwd:process.cwd(),args:process.argv.slice(2),depth:process.env.BOSUN_DEPTH,caller:process.env.BOSUN_CALLER});
const send=row=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...row})+'\n');
const update=(value,sessionId=session)=>send({method:'session/update',params:{sessionId,update:value}});
let options=[{id:'native-model',name:'Model',type:'select',category:'_ignored',currentValue:'other',options:[{group:'models',name:'Models',options:[{value:model,name:'Exact'},{value:'other',name:'Other'}]}]},
 {id:'native-effort',name:'Reasoning',type:'select',currentValue:'low',options:[{value:effort,name:'Ultra'},{value:'low',name:'Low'}]}];
 let promptId,permissions=0;
function complete(){update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:${JSON.stringify(RESULT)}}});send({id:promptId,result:{stopReason:mode==='stop-refusal'?'refusal':mode==='stop-unknown'?'unknown':'end_turn'}});}
const rl=readline.createInterface({input:process.stdin});
rl.on('line',line=>{
 const row=JSON.parse(line);record(row);
 if(!row.method){if(++permissions===3)complete();return;}
 if(row.method==='initialize'){
  if(mode==='malformed'){process.stdout.write('{not-json}\n');return;}
  if(mode==='missing-jsonrpc'){process.stdout.write(JSON.stringify({id:row.id,result:{}})+'\n');return;}
  if(mode==='oversize'){process.stdout.write('x'.repeat(70000)+'\n');return;}
  const result={protocolVersion:mode==='protocol2'?2:1,agentInfo:{name:mode==='identity-name'?'other':'fixture-agent',version:mode==='identity-version'?'2.0':'1.0'},agentCapabilities:{},authMethods:[]};
  send({id:mode==='wrong-id'?999:row.id,result});if(mode==='duplicate-id')send({id:row.id,result});return;
 }
 if(row.method==='session/new'){
  if(mode==='missing-selector')options=options.filter(v=>v.id!=='native-model');
  if(mode==='missing-value')options[0].options[0].options=options[0].options[0].options.filter(v=>v.value!==model);
  if(mode==='duplicate-selector')options.push(options[0]);
  if(mode==='duplicate-value')options[0].options[0].options.push(options[0].options[0].options[0]);
  if(mode==='boolean-selector')options[0]={id:'native-model',name:'Model',type:'boolean',currentValue:true};
  send({id:row.id,result:{sessionId:session,configOptions:options}});
  if(mode==='history')update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OLD_HISTORY_CANARY'}});return;
 }
 if(row.method==='session/set_config_option'){
  if(mode==='lost-config'){process.exit(0);}
  if(mode!=='missing-ack')options.find(v=>v.id===row.params.configId).currentValue=row.params.value;
  if(row.params.configId==='native-model')options[1].currentValue='low';
  if(mode==='dependent-drift'&&row.params.configId==='native-effort')options[0].currentValue='other';
  send({id:row.id,result:{configOptions:mode==='incomplete-config'?options.filter(v=>v.id===row.params.configId):options}});
  if(mode==='interleaved-drift'&&row.params.configId==='native-model'){options[0].currentValue='other';update({sessionUpdate:'config_option_update',configOptions:options});}
  return;
 }
 if(row.method==='session/prompt'){
  promptId=row.id;
  if(mode==='lost-prompt')process.exit(0);
  if(['cancel','cancel-ignored','cancel-end-turn'].includes(mode))return;
  if(mode==='session-drift'){update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'WRONG_SCOPE_CANARY'}},'other');return;}
  if(mode==='config-drift'){options[0].currentValue='other';update({sessionUpdate:'config_option_update',configOptions:options});return;}
  if(mode==='permissions'){
   update({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'REASONING_CANARY'}});
   update({sessionUpdate:'tool_call',toolCallId:'tool1',title:'COMMAND_CANARY',kind:'execute',rawInput:{command:'COMMAND_CANARY'}});
   send({id:'permission1',method:'session/request_permission',params:{sessionId:session,toolCall:{toolCallId:'tool1',title:'SECRET_TITLE'},options:[{optionId:'allow',name:'Allow',kind:'allow_once'}]}});
   send({id:'filesystem1',method:'fs/read_text_file',params:{sessionId:session,path:'PERSONAL_PATH_CANARY'}});
   send({id:'terminal1',method:'terminal/create',params:{sessionId:session,command:'COMMAND_CANARY'}});
   update({sessionUpdate:'tool_call_update',toolCallId:'tool1',status:'completed',rawOutput:'OUTPUT_CANARY'});return;
  }
  if(mode==='tool-update-without-call'){update({sessionUpdate:'tool_call_update',toolCallId:'absent'});return;}
  if(['pending-tool','lost-tool-receipt','reopened-tool','invalid-tool-status'].includes(mode)){
   update({sessionUpdate:'tool_call',toolCallId:'tool1',status:mode==='pending-tool'?'pending':'in_progress',rawInput:{command:'COMMAND_CANARY'}});
   if(mode==='reopened-tool'){update({sessionUpdate:'tool_call_update',toolCallId:'tool1',status:'completed'});update({sessionUpdate:'tool_call_update',toolCallId:'tool1',status:'in_progress'});}
   if(mode==='invalid-tool-status')update({sessionUpdate:'tool_call_update',toolCallId:'tool1',status:'unknown'});
  }
  complete();return;
 }
 if(row.method==='session/cancel'){
  if(mode==='cancel-ignored')return;
  if(mode==='cancel-end-turn'){complete();return;}
  send({id:promptId,result:{stopReason:'cancelled'}});return;
 }
});
rl.on('close',()=>{record({closed:true});if(mode==='hang-close')setInterval(()=>{},1000);else process.exit(mode==='nonzero-close'?7:0);});
`,
		{ mode: 0o700 },
	);
	const profile: AcpSettings = {
		enabled: true,
		command: process.execPath,
		args: [file, mode, "literal $(argument)"],
		agentName: "fixture-agent",
		agentVersion: "1.0",
		protocolVersion: 1,
		timeoutMs: 3000,
		modelOption: "native-model",
		effortOption: "native-effort",
	};
	const env = sb.env({ ACP_TRACE: trace });
	const records = (): any[] =>
		fs.existsSync(trace)
			? fs
					.readFileSync(trace, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line))
			: [];
	return {
		profile,
		env,
		trace,
		records,
		runner: createAcpRunner({
			id: "acp-fixture",
			profile,
			env,
			killGraceMs: 50,
		}),
	};
}
function spec(sb: Sandbox, extra: Partial<RunSpec> = {}): RunSpec {
	return {
		prompt: PROMPT,
		privacy: "public",
		cwd: sb.home,
		access: "edit",
		model: MODEL,
		effort: EFFORT,
		signal: new AbortController().signal,
		...extra,
	};
}
async function collect(events: AsyncIterable<RunEvent>) {
	const values: RunEvent[] = [];
	for await (const event of events) values.push(event);
	return values;
}
const code = (name: string) => (error: unknown) =>
	error instanceof BosunError && error.code === name;
const unknown = (error: unknown) =>
	error instanceof BosunError && error.details?.outcome === "unknown";
async function waitFor(check: () => boolean | Promise<boolean>) {
	for (let n = 0; n < 300; n++) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail("Synthetic protocol phase unavailable");
}

test("ACP profiles round-trip without changing native hosts/defaults; names, cardinality, selectors and protocol are bounded", () => {
	assert.deepEqual(defaultConfig().acp, {});
	const config = parseRuntimeConfig(
		'[acp.fixture]\nenabled=true\ncommand="fixture-agent"\nargs=["--acp"]\nagentName="fixture-agent"\nagentVersion="1.0"\nprotocolVersion=1\ntimeoutMs=1000\nmodelOption="native-model"\n',
	);
	assert.deepEqual(parseRuntimeConfig(renderRuntimeConfig(config)), config);
	for (const update of [
		"protocolVersion=2",
		"timeoutMs=1",
		'modelOption="same"\neffortOption="same"',
	])
		assert.throws(() =>
			parseRuntimeConfig(
				renderRuntimeConfig({ ...config, acp: {} }) +
					'\n[acp.fixture]\nenabled=true\ncommand="fixture-agent"\nargs=[]\nagentName="fixture-agent"\nagentVersion="1.0"\n' +
					(update.startsWith("protocol")
						? update
						: "protocolVersion=1\n" + update) +
					(update.startsWith("timeout") ? "" : "\ntimeoutMs=1000\n"),
			),
		);
	const tooMany = {
		...config,
		acp: Object.fromEntries(
			Array.from({ length: 17 }, (_, index) => [
				`profile-${index}`,
				config.acp.fixture,
			]),
		),
	};
	assert.throws(() => renderRuntimeConfig(tooMany));
	assert.throws(() =>
		parseRuntimeConfig(
			renderRuntimeConfig(config).replace("[acp.fixture]", '[acp."bad:name"]'),
		),
	);
});

test("ACP construction, private/access/secret/unsupported requests do not inspect environment or discover a command", async () => {
	const sb = sandbox();
	let reads = 0;
	try {
		const runner = createAcpRunner({
			id: "acp-fixture",
			get profile(): never {
				reads++;
				throw Error("PROFILE_CANARY");
			},
			get env(): never {
				reads++;
				throw Error("ENV_CANARY");
			},
		});
		assert.equal(reads, 0);
		for (const privacy of ["private", "unknown", undefined])
			await assert.rejects(
				collect(
					runner.run({
						...spec(sb),
						privacy,
						get prompt(): never {
							reads++;
							throw Error("PROMPT_CANARY");
						},
					} as RunSpec),
				),
				code("private_input"),
			);
		await assert.rejects(
			collect(runner.run(Object.create(spec(sb)))),
			code("private_input"),
		);
		for (const extra of [
			{ access: "read" },
			{ maxTurns: 1 },
			{ managed: { id: "managed", version: 1 } },
			{ mcp: [{ name: "x", command: "x", args: [] }] },
			{ env: { X: "y" } },
			{ prompt: 'api_key="sk-proj-' + "a".repeat(48) + '"' },
		])
			await assert.rejects(
				collect(runner.run(spec(sb, extra as Partial<RunSpec>))),
			);
		assert.equal(reads, 0);
		assert.deepEqual(sb.calls(), []);
	} finally {
		sb.cleanup();
	}
});

test("one ACP v1 process receives exact identity/model/effort/cwd/literal prompt and joins before done", async () => {
	const sb = sandbox();
	try {
		const f = fixture(sb),
			events = await collect(f.runner.run(spec(sb)));
		assert.deepEqual(events, [
			{ t: "text", text: RESULT },
			{ t: "done", code: 0, result: RESULT },
		]);
		const rows = f.records(),
			requests = rows.filter((row) => row.method);
		assert.equal(rows.filter((row) => row.start).length, 1);
		assert.deepEqual(
			requests.map((row) => row.method),
			[
				"initialize",
				"session/new",
				"session/set_config_option",
				"session/set_config_option",
				"session/prompt",
			],
		);
		assert.equal(requests[0].params.protocolVersion, 1);
		assert.deepEqual(requests[0].params.clientCapabilities, {});
		assert.deepEqual(requests[1].params, { cwd: sb.home, mcpServers: [] });
		assert.deepEqual(
			requests.slice(2, 4).map((row) => row.params),
			[
				{
					sessionId: "fixture-session",
					configId: "native-model",
					value: MODEL,
				},
				{
					sessionId: "fixture-session",
					configId: "native-effort",
					value: EFFORT,
				},
			],
		);
		assert.deepEqual(requests[4].params.prompt, [
			{ type: "text", text: PROMPT },
		]);
		assert.equal(rows[0].depth, "1");
		assert.equal(rows[0].caller, "model");
		assert.equal(rows[0].args[1], "literal $(argument)");
		assert.equal(rows.at(-1).closed, true);
		assert.throws(
			() => process.kill(rows[0].pid, 0),
			(error: NodeJS.ErrnoException) => error.code === "ESRCH",
		);
		assert.equal(f.runner.caps.readOnly, "unverified");
		assert.equal(f.runner.caps.billing, "unknown");
	} finally {
		sb.cleanup();
	}
});

test("ACP denies client permissions and filesystem calls while discarding tool arguments/results/reasoning", async () => {
	const sb = sandbox();
	try {
		const f = fixture(sb, "permissions"),
			events = await collect(f.runner.run(spec(sb)));
		assert.ok(
			events.some((event) => event.t === "tool" && event.name === "acp_tool"),
		);
		assert.ok(
			events.some(
				(event) => event.t === "permission" && event.decision === "deny",
			),
		);
		assert.doesNotMatch(JSON.stringify(events), /CANARY|SECRET_TITLE/);
		assert.deepEqual(
			f.records().find((row) => row.id === "permission1").result,
			{ outcome: { outcome: "cancelled" } },
		);
		assert.equal(
			f.records().find((row) => row.id === "filesystem1").error.code,
			-32601,
		);
		assert.equal(
			f.records().find((row) => row.id === "terminal1").error.code,
			-32601,
		);
		assert.equal(events.at(-1)?.t, "done");
	} finally {
		sb.cleanup();
	}
});

for (const mode of [
	"protocol2",
	"identity-name",
	"identity-version",
	"missing-selector",
	"missing-value",
	"duplicate-selector",
	"duplicate-value",
	"boolean-selector",
	"missing-ack",
	"dependent-drift",
	"interleaved-drift",
	"incomplete-config",
	"lost-config",
	"history",
])
	test(`ACP ${mode} fails before the original prompt; no retry or replay`, async () => {
		const sb = sandbox();
		try {
			const f = fixture(sb, mode);
			await assert.rejects(collect(f.runner.run(spec(sb))));
			assert.equal(f.records().filter((row) => row.start).length, 1);
			assert.equal(
				f.records().filter((row) => row.method === "session/prompt").length,
				0,
			);
		} finally {
			sb.cleanup();
		}
	});
for (const mode of [
	"wrong-id",
	"duplicate-id",
	"malformed",
	"missing-jsonrpc",
	"oversize",
	"session-drift",
	"config-drift",
	"tool-update-without-call",
	"pending-tool",
	"lost-tool-receipt",
	"reopened-tool",
	"invalid-tool-status",
	"lost-prompt",
	"stop-unknown",
	"nonzero-close",
	"hang-close",
])
	test(`ACP ${mode} remains unknown without publishing completion or replaying`, async () => {
		const sb = sandbox();
		const events: RunEvent[] = [];
		try {
			const f = fixture(sb, mode);
			await assert.rejects(
				(async () => {
					for await (const event of f.runner.run(spec(sb))) events.push(event);
				})(),
				unknown,
			);
			assert.equal(
				events.some((event) => event.t === "done"),
				false,
			);
			assert.equal(f.records().filter((row) => row.start).length, 1);
			assert.ok(
				f.records().filter((row) => row.method === "session/prompt").length <=
					1,
			);
		} finally {
			sb.cleanup();
		}
	});

test("ACP known refusal returns a finite non-success receipt only after original process close", async () => {
	const sb = sandbox();
	try {
		const f = fixture(sb, "stop-refusal"),
			events = await collect(f.runner.run(spec(sb)));
		assert.deepEqual(events.at(-1), {
			t: "done",
			code: 1,
			result: "ACP stopped: refusal",
		});
		assert.equal(f.records().at(-1).closed, true);
	} finally {
		sb.cleanup();
	}
});
for (const mode of ["cancel", "cancel-ignored", "cancel-end-turn"])
	test(`ACP ${mode} waits for original prompt receipt and process termination; notification alone is not completion`, async () => {
		const sb = sandbox();
		const events: RunEvent[] = [];
		try {
			const f = fixture(sb, mode),
				control = new AbortController();
			const run = (async () => {
				for await (const event of f.runner.run(
					spec(sb, { signal: control.signal }),
				))
					events.push(event);
			})();
			const checked = mode === "cancel" ? run : assert.rejects(run, unknown);
			await waitFor(() =>
				f.records().some((row) => row.method === "session/prompt"),
			);
			control.abort();
			await checked;
			assert.equal(
				f.records().filter((row) => row.method === "session/cancel").length,
				1,
			);
			assert.equal(
				f.records().filter((row) => row.method === "session/prompt").length,
				1,
			);
			assert.equal(
				events.some((event) => event.t === "done"),
				mode === "cancel",
			);
			if (mode === "cancel")
				assert.deepEqual(events.at(-1), {
					t: "done",
					code: 1,
					result: "ACP stopped: cancelled",
				});
			assert.throws(
				() => process.kill(f.records()[0].pid, 0),
				(error: NodeJS.ErrnoException) => error.code === "ESRCH",
			);
		} finally {
			sb.cleanup();
		}
	});

test("ACP registry stays lazy, disabled profiles are absent, quota stays unknown and read-only jobs never spawn", async () => {
	const sb = sandbox();
	let jobs: ReturnType<typeof openDaemonJobs> | undefined;
	try {
		const f = fixture(sb),
			config = defaultConfig();
		config.acp = {
			fixture: f.profile,
			disabled: { ...f.profile, enabled: false },
		};
		const factories = nativeRunners(config, f.env);
		assert.equal(fs.existsSync(f.trace), false);
		assert.equal(Object.hasOwn(factories, "acp-disabled"), false);
		assert.equal(
			Object.hasOwn(nativeQuotaSources(config, f.env, sb.home), "acp-fixture"),
			false,
		);
		jobs = openDaemonJobs({
			stateFile: path.join(sb.home, "jobs.db"),
			ownerFile: path.join(sb.home, "owner.db"),
			runners: factories,
		});
		jobs.recover();
		const scope = { projectId: "p_acp" },
			input = {
				privacy: "public" as const,
				requestId: "unknown",
				taskId: "unknown",
				runnerId: "acp-fixture",
				prompt: PROMPT,
				cwd: sb.home,
				access: "edit" as const,
				model: MODEL,
				effort: EFFORT,
			};
		const held = jobs.submit(input, scope).job;
		await jobs.runQueued();
		assert.equal(jobs.get(scope, held.id).state, "held");
		assert.equal(fs.existsSync(f.trace), false);
		const read = jobs.submit(
			{
				...input,
				requestId: "read",
				taskId: "read",
				access: "read",
				allowUnknownQuota: true,
			},
			scope,
		).job;
		await jobs.runQueued();
		assert.equal(jobs.get(scope, read.id).state, "held");
		assert.equal(jobs.get(scope, read.id).reason, "unsupported");
		assert.equal(fs.existsSync(f.trace), false);
		const allowed = jobs.submit(
			{
				...input,
				requestId: "allowed",
				taskId: "allowed",
				allowUnknownQuota: true,
			},
			scope,
		).job;
		await jobs.runQueued();
		assert.equal(jobs.get(scope, allowed.id).state, "succeeded");
		assert.equal(jobs.result(scope, allowed.id), RESULT);
		assert.equal(
			jobs.submit(
				{
					...input,
					requestId: "allowed",
					taskId: "allowed",
					allowUnknownQuota: true,
				},
				scope,
			).job.id,
			allowed.id,
		);
		await jobs.runQueued();
		assert.equal(
			f.records().filter((row) => row.method === "session/prompt").length,
			1,
		);
	} finally {
		await jobs?.close();
		sb.cleanup();
	}
});

test("configured ACP CLI run uses the selected lazy adapter through daemon contracts and preserves original job identity", async () => {
	const sb = sandbox();
	const protocol = fixture(sb);
	let runtime: Awaited<ReturnType<typeof runtimeFixture>> | undefined;
	const config = defaultConfig();
	config.acp.fixture = protocol.profile;
	const toml = renderRuntimeConfig(config);
	try {
		runtime = await runtimeFixture(toml, {
			env: { ACP_TRACE: protocol.trace },
			runners: {
				"acp-fixture": (signal) =>
					nativeRunners(parseRuntimeConfig(toml), runtime!.env)["acp-fixture"](
						signal,
					),
				codex: () => {
					throw Error("WRONG_HOST_CANARY");
				},
			},
		});
		for (const args of [
			["run", PROMPT, "--runner", "acp-fixture"],
			[
				"run",
				PROMPT,
				"--runner",
				"acp-fixture",
				"--host",
				"codex",
				"--model",
				MODEL,
			],
			["run", PROMPT, "--runner", "acp-disabled", "--model", MODEL],
		]) {
			assert.notEqual((await runtime.cli(args)).code, 0);
			assert.equal(protocol.records().length, 0);
		}
		const args = [
			"run",
			PROMPT,
			"--runner",
			"acp-fixture",
			"--model",
			MODEL,
			"--effort",
			EFFORT,
			"--request-id",
			"acp-cli-original",
			"--allow-unknown-quota",
		];
		const queued = await runtime.cli(args);
		assert.equal(queued.code, 0, queued.err);
		const job = JSON.parse(queued.out).job;
		await waitFor(() => protocol.records().some((row) => row.closed));
		await waitFor(
			async () =>
				!["queued", "running"].includes(
					(await runtime!.rpc("job.get", { id: job.id })).state,
				),
		);
		const completed = await runtime.rpc("job.get", { id: job.id });
		assert.equal(completed.state, "succeeded");
		assert.equal(completed.runnerId, "acp-fixture");
		assert.equal(
			(await runtime.rpc("job.result", { id: job.id })).result,
			RESULT,
		);
		const repeated = await runtime.cli(args);
		assert.equal(repeated.code, 0);
		assert.equal(JSON.parse(repeated.out).job.id, job.id);
		assert.equal(
			protocol.records().filter((row) => row.method === "session/prompt")
				.length,
			1,
		);
		assert.equal(protocol.records()[0].cwd, runtime.workspace);
		await gitEnvelope(runtime.sb, async () => {
			const spin = await runtime!.cli([
				"spin",
				PROMPT,
				"--name",
				"acp-task",
				"--runner",
				"acp-fixture",
				"--model",
				MODEL,
				"--effort",
				EFFORT,
				"--request-id",
				"acp-spin-original",
				"--allow-unknown-quota",
			]);
			assert.equal(spin.code, 0, spin.err);
			const created = JSON.parse(spin.out);
			assert.equal(created.record.state, "ready");
			const waited = await runtime!.cli(["job", "wait", created.job.id]);
			assert.equal(waited.code, 0, waited.err);
			assert.equal(JSON.parse(waited.out).state, "succeeded");
			assert.equal(
				protocol
					.records()
					.filter((row) => row.start)
					.at(-1).cwd,
				created.record.path,
			);
			const next = await runtime!.cli([
				"workspace",
				"run",
				created.record.id,
				PROMPT,
				"--version",
				String(created.record.version),
				"--runner",
				"acp-fixture",
				"--model",
				MODEL,
				"--effort",
				EFFORT,
				"--request-id",
				"acp-workspace-original",
				"--allow-unknown-quota",
			]);
			assert.equal(next.code, 0, next.err);
			const queued = JSON.parse(next.out);
			const nextWait = await runtime!.cli(["job", "wait", queued.job.id]);
			assert.equal(nextWait.code, 0, nextWait.err);
			assert.equal(JSON.parse(nextWait.out).state, "succeeded");
			assert.equal(
				protocol
					.records()
					.filter((row) => row.start)
					.at(-1).cwd,
				created.record.path,
			);
			assert.equal(
				protocol.records().filter((row) => row.method === "session/prompt")
					.length,
				3,
			);
		});
	} finally {
		await runtime?.close();
		sb.cleanup();
	}
});

test("lost ACP prompt receipt is durable unknown through daemon reopen and duplicate/release cannot replay", async () => {
	const sb = sandbox();
	let jobs: ReturnType<typeof openDaemonJobs> | undefined;
	try {
		const f = fixture(sb, "lost-prompt"),
			config = defaultConfig();
		config.acp.fixture = f.profile;
		const options = {
			stateFile: path.join(sb.home, "jobs.db"),
			ownerFile: path.join(sb.home, "owner.db"),
			runners: nativeRunners(config, f.env),
		};
		const scope = { projectId: "p_acp" },
			input = {
				privacy: "public" as const,
				requestId: "lost",
				taskId: "lost",
				runnerId: "acp-fixture",
				prompt: PROMPT,
				cwd: sb.home,
				access: "edit" as const,
				model: MODEL,
				effort: EFFORT,
				allowUnknownQuota: true,
			};
		jobs = openDaemonJobs(options);
		jobs.recover();
		const original = jobs.submit(input, scope).job;
		await jobs.runQueued();
		assert.equal(jobs.get(scope, original.id).state, "unknown");
		await jobs.close();
		jobs = openDaemonJobs(options);
		jobs.recover();
		assert.equal(jobs.get(scope, original.id).state, "unknown");
		assert.equal(jobs.submit(input, scope).job.id, original.id);
		await assert.rejects(jobs.release(scope, original.id), code("conflict"));
		await jobs.runQueued();
		assert.equal(
			f.records().filter((row) => row.method === "session/prompt").length,
			1,
		);
		assert.equal(f.records().filter((row) => row.start).length, 1);
	} finally {
		await jobs?.close();
		sb.cleanup();
	}
});
