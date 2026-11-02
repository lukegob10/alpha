import { EventEmitter } from "node:events"
import i18next from "i18next"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import common from "../../../i18n/locales/en/common.json"
import {
	runLifecycleHooks,
	type CompletionHookConfig,
	type CompletionHookRequest,
	type LifecycleHookRequest,
} from "../CompletionHooks"

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock("node:child_process", () => ({ spawn: spawnMock }))

const base = {
	session_id: "schema-task",
	turn_id: "schema-turn",
	cwd: process.cwd(),
	model: "fixture-model",
	permission_mode: "ask",
	transcript_path: null,
}
interface EventCase {
	key: keyof CompletionHookConfig
	request: Exclude<LifecycleHookRequest, CompletionHookRequest>
}
const cases: EventCase[] = [
	{ key: "sessionStart", request: { ...base, hook_event_name: "SessionStart", source: "startup" } },
	{
		key: "subagentStart",
		request: { ...base, hook_event_name: "SubagentStart", agent_id: "child", agent_type: "worker" },
	},
	{ key: "userPromptSubmit", request: { ...base, hook_event_name: "UserPromptSubmit", prompt: "Do the work" } },
	{
		key: "preToolUse",
		request: {
			...base,
			hook_event_name: "PreToolUse",
			tool_name: "read_file",
			tool_use_id: "call",
			tool_input: {},
		},
	},
	{
		key: "postToolUse",
		request: {
			...base,
			hook_event_name: "PostToolUse",
			tool_name: "read_file",
			tool_use_id: "call",
			tool_input: {},
			tool_response: "result",
		},
	},
	{
		key: "permissionRequest",
		request: { ...base, hook_event_name: "PermissionRequest", tool_name: "read_file", tool_input: {} },
	},
	{ key: "preCompact", request: { ...base, hook_event_name: "PreCompact", trigger: "auto" } },
	{ key: "postCompact", request: { ...base, hook_event_name: "PostCompact", trigger: "manual" } },
	{ key: "interrupt", request: { ...base, hook_event_name: "Interrupt" } },
]

function child() {
	return Object.assign(new EventEmitter(), {
		stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
	})
}

let children: ReturnType<typeof child>[]

beforeAll(() => i18next.addResourceBundle("en", "common", common, true, true))
beforeEach(() => {
	children = []
	spawnMock.mockReset().mockImplementation(() => {
		const spawned = child()
		children.push(spawned)
		return spawned
	})
})

async function run(test: EventCase, output: unknown, advisory = false) {
	const config: CompletionHookConfig = { stop: [], subagentStop: [], [test.key]: [{ command: process.execPath }] }
	const pending = runLifecycleHooks(config, test.request, new AbortController().signal, { advisory })
	children[0].stdout.emit("data", Buffer.from(JSON.stringify(output)))
	children[0].emit("close", 0)
	return pending
}

function eventCase(key: EventCase["key"]): EventCase {
	const test = cases.find((test) => test.key === key)
	if (!test) throw new Error(`Unknown fixture event ${key}`)
	return test
}

describe("lifecycle output schema compatibility", () => {
	it.each(cases)("rejects unknown top-level fields before applying any $key output", async (test) => {
		const outcome = await run(test, { systemMessage: "Must not publish invalid output", unknown: true })
		expect(outcome).toEqual({ warnings: [expect.stringContaining("invalid or unsupported JSON")] })
	})

	it.each(cases)("accepts nullable optional strings and omitted optional objects at $key", async (test) => {
		const event = test.request.hook_event_name
		const output: Record<string, unknown> = { systemMessage: null }
		if (event !== "Interrupt") output.stopReason = null
		if (!["Interrupt", "PreCompact", "PostCompact"].includes(event)) output.hookSpecificOutput = null
		if (["PreToolUse", "PostToolUse", "UserPromptSubmit"].includes(event)) {
			output.decision = null
			output.reason = null
		}
		expect(await run(test, output)).toEqual({ warnings: [] })
	})

	it.each([
		"sessionStart",
		"subagentStart",
		"userPromptSubmit",
		"preToolUse",
		"postToolUse",
		"permissionRequest",
	] as const)(
		"rejects unknown fields within $key hookSpecificOutput in synchronous and advisory hooks",
		async (key) => {
			for (const advisory of [false, true]) {
				const test = eventCase(key)
				children = []
				const outcome = await run(
					test,
					{
						hookSpecificOutput: { hookEventName: test.request.hook_event_name, unknown: true },
					},
					advisory,
				)
				expect(outcome).toEqual({ warnings: [expect.stringContaining("invalid or unsupported JSON")] })
			}
		},
	)

	it("accepts null optional pre-tool control fields without fabricating a decision", async () => {
		expect(
			await run(eventCase("preToolUse"), {
				stopReason: null,
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					permissionDecision: null,
					permissionDecisionReason: null,
					updatedInput: null,
					additionalContext: "Context without a control decision",
				},
			}),
		).toMatchObject({
			warnings: [],
			additionalContext: [{ text: "Context without a control decision" }],
		})
	})

	it("treats null reserved permission fields as absent and retains denial", async () => {
		expect(
			await run(eventCase("permissionRequest"), {
				hookSpecificOutput: {
					hookEventName: "PermissionRequest",
					decision: {
						behavior: "deny",
						message: null,
						updatedInput: null,
						updatedPermissions: null,
						interrupt: false,
					},
				},
			}),
		).toMatchObject({ warnings: [], shouldBlock: true, blockReason: "PermissionRequest hook denied approval" })
	})

	it("rejects unknown or incorrectly typed nested permission fields", async () => {
		for (const decision of [
			{ behavior: "deny", unknown: true },
			{ behavior: "deny", interrupt: null },
		]) {
			children = []
			expect(
				await run(eventCase("permissionRequest"), {
					hookSpecificOutput: { hookEventName: "PermissionRequest", decision },
				}),
			).toEqual({ warnings: [expect.stringContaining("invalid or unsupported JSON")] })
		}
	})

	it.each(["userPromptSubmit", "postToolUse"] as const)(
		"does not inject context from a malformed blocking %s result",
		async (key) => {
			const test = eventCase(key)
			const outcome = await run(test, {
				decision: "block",
				hookSpecificOutput: {
					hookEventName: test.request.hook_event_name,
					additionalContext: "Must not inject",
				},
			})
			expect(outcome.warnings.length).toBeGreaterThan(0)
			expect(outcome).not.toHaveProperty("additionalContext")
		},
	)

	it("keeps post-tool continue:false ahead of unsupported control semantics without injecting invalid context", async () => {
		expect(
			await run(eventCase("postToolUse"), {
				continue: false,
				suppressOutput: true,
				reason: "Inspect this completed effect",
				hookSpecificOutput: {
					hookEventName: "PostToolUse",
					updatedMCPToolOutput: {},
					additionalContext: "Must not inject",
				},
			}),
		).toEqual({ warnings: [], feedbackMessage: "Inspect this completed effect" })
	})
})
