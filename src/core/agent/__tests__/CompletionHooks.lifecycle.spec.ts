import { EventEmitter } from "node:events"
import * as vscode from "vscode"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import i18next from "i18next"
import common from "../../../i18n/locales/en/common.json"
import {
	readCompletionHookConfig,
	runLifecycleHooks,
	type CompletionHookConfig,
	type CompletionHookCommand,
} from "../CompletionHooks"

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock("node:child_process", () => ({ spawn: spawnMock }))

beforeAll(() => {
	i18next.addResourceBundle("en", "common", common, true, true)
})

interface HookChild extends EventEmitter {
	stdin: EventEmitter & { end: ReturnType<typeof vi.fn> }
	stdout: EventEmitter
	stderr: EventEmitter
	kill: ReturnType<typeof vi.fn>
}

const baseRequest = {
	session_id: "lifecycle-task",
	turn_id: "turn-1",
	cwd: process.cwd(),
	model: "fixture-model",
	permission_mode: "ask",
	transcript_path: null,
}

const command: CompletionHookCommand = { command: process.execPath, args: ["fixture.js"] }

function config(extra: Partial<CompletionHookConfig> = {}): CompletionHookConfig {
	return { stop: [], subagentStop: [], ...extra }
}

function finish(child: HookChild, stdout: unknown, exitCode = 0, stderr = ""): void {
	if (stdout !== undefined) {
		child.stdout.emit("data", Buffer.from(typeof stdout === "string" ? stdout : JSON.stringify(stdout)))
	}
	if (stderr) child.stderr.emit("data", Buffer.from(stderr))
	child.emit("close", exitCode)
}

describe("native lifecycle hook contracts", () => {
	let children: HookChild[]

	beforeEach(() => {
		children = []
		spawnMock.mockReset()
		spawnMock.mockImplementation(() => {
			const child = Object.assign(new EventEmitter(), {
				stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
				stdout: new EventEmitter(),
				stderr: new EventEmitter(),
				kill: vi.fn(),
			})
			children.push(child)
			return child
		})
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it("retains legacy completion config and validates configured lifecycle commands", () => {
		vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
			inspect: () => ({
				globalValue: {
					stop: [command],
					sessionStart: [command, { command: "relative-command" }],
					preToolUse: [command, { command: process.execPath, args: [123] }],
				},
			}),
		} as unknown as vscode.WorkspaceConfiguration)

		expect(readCompletionHookConfig()).toEqual({
			stop: [command],
			subagentStop: [],
			sessionStart: [command],
			preToolUse: [command],
		})
	})

	it("never installs executable hooks from workspace or workspace-folder configuration", () => {
		vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
			inspect: () => ({
				defaultValue: { stop: [], subagentStop: [] },
				workspaceValue: { stop: [command], sessionStart: [command], preToolUse: [command] },
				workspaceFolderValue: { subagentStop: [command], userPromptSubmit: [command], postToolUse: [command] },
			}),
			get: () => ({ stop: [command], preToolUse: [command] }),
		} as unknown as vscode.WorkspaceConfiguration)

		expect(readCompletionHookConfig()).toEqual({ stop: [], subagentStop: [] })
	})

	it("routes only the matching event, serializes typed context, and keeps no-shell execution", async () => {
		const request = { ...baseRequest, hook_event_name: "UserPromptSubmit" as const, prompt: "User request" }
		const pending = runLifecycleHooks(
			config({ sessionStart: [command], userPromptSubmit: [command] }),
			request,
			new AbortController().signal,
		)

		expect(spawnMock).toHaveBeenCalledExactlyOnceWith(
			process.execPath,
			["fixture.js"],
			expect.objectContaining({ cwd: request.cwd, shell: false, windowsHide: true }),
		)
		expect(children[0].stdin.end).toHaveBeenCalledExactlyOnceWith(JSON.stringify(request))
		finish(children[0], undefined)
		expect(await pending).toEqual({ warnings: [] })
	})

	it.each(["SessionStart", "SubagentStart"] as const)("accepts plain stdout context from %s", async (event) => {
		const request =
			event === "SessionStart"
				? { ...baseRequest, hook_event_name: event, source: "startup" as const }
				: { ...baseRequest, hook_event_name: event, agent_id: "child-task", agent_type: "worker" }
		const pending = runLifecycleHooks(
			config({ sessionStart: [command], subagentStart: [command] }),
			request,
			new AbortController().signal,
		)
		finish(children[0], "Session context")

		expect(await pending).toEqual({
			additionalContext: [{ hook_run_id: expect.any(String), text: "Session context" }],
			warnings: [],
		})
	})

	it("does not treat SessionStart exit 2 as model context", async () => {
		const pending = runLifecycleHooks(
			config({ sessionStart: [command] }),
			{ ...baseRequest, hook_event_name: "SessionStart", source: "startup" },
			new AbortController().signal,
		)
		finish(children[0], undefined, 2, "Must not inject this failed start")
		const outcome = await pending
		expect(outcome).not.toHaveProperty("additionalContext")
		expect(outcome).not.toHaveProperty("shouldStop")
		expect(outcome.warnings.length).toBeGreaterThan(0)
	})

	it("stops prompt submission on blocking feedback without presenting it as human input", async () => {
		const pending = runLifecycleHooks(
			config({ userPromptSubmit: [command] }),
			{ ...baseRequest, hook_event_name: "UserPromptSubmit", prompt: "Original user request" },
			new AbortController().signal,
		)
		finish(children[0], { decision: "block", reason: "Prompt rejected by user hook" })
		expect(await pending).toMatchObject({
			shouldStop: true,
			stopReason: "Prompt rejected by user hook",
			stopProvenance: {
				event: "UserPromptSubmit",
				fragments: [{ hook_run_id: expect.any(String), text: "Prompt rejected by user hook" }],
			},
		})
	})

	it("rejects a hook-specific response for a different lifecycle event", async () => {
		const pending = runLifecycleHooks(
			config({ postToolUse: [command] }),
			{
				...baseRequest,
				hook_event_name: "PostToolUse",
				tool_name: "read_file",
				tool_use_id: "call-1",
				tool_input: { path: "file.ts" },
				tool_response: { result: "read" },
			},
			new AbortController().signal,
		)
		finish(children[0], {
			hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "Wrong event context" },
		})
		const outcome = await pending
		expect(outcome).not.toHaveProperty("additionalContext")
		expect(outcome.warnings.length).toBeGreaterThan(0)
	})

	it("accepts PostToolUse context with per-run provenance", async () => {
		const pending = runLifecycleHooks(
			config({ postToolUse: [command] }),
			{
				...baseRequest,
				hook_event_name: "PostToolUse",
				tool_name: "read_file",
				tool_use_id: "call-1",
				tool_input: { path: "file.ts" },
				tool_response: { result: "read" },
			},
			new AbortController().signal,
		)
		finish(children[0], {
			hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "Observed result context" },
		})
		expect(await pending).toEqual({
			additionalContext: [{ hook_run_id: expect.any(String), text: "Observed result context" }],
			warnings: [],
		})
	})

	it("keeps post-tool continue:false as feedback without blocking the successful effect", async () => {
		const pending = runLifecycleHooks(
			config({ postToolUse: [command] }),
			{
				...baseRequest,
				hook_event_name: "PostToolUse",
				tool_name: "write_to_file",
				tool_use_id: "write-1",
				tool_input: { path: "file.ts", content: "written" },
				tool_response: { status: "success" },
			},
			new AbortController().signal,
		)
		finish(children[0], { continue: false, stopReason: "Review the completed write before continuing" })
		const outcome = await pending

		expect(outcome.feedbackMessage).toBe("Review the completed write before continuing")
		expect(outcome).not.toHaveProperty("shouldBlock")
		expect(outcome).not.toHaveProperty("shouldStop")
	})

	it("reports a post-tool block as feedback while retaining the completed-effect distinction", async () => {
		const pending = runLifecycleHooks(
			config({ postToolUse: [command] }),
			{
				...baseRequest,
				hook_event_name: "PostToolUse",
				tool_name: "write_to_file",
				tool_use_id: "write-1",
				tool_input: { path: "file.ts", content: "written" },
				tool_response: { status: "success" },
			},
			new AbortController().signal,
		)
		finish(children[0], { decision: "block", reason: "Inspect the completed write" })
		expect(await pending).toMatchObject({
			shouldBlock: true,
			blockReason: "Inspect the completed write",
			feedbackMessage: "Inspect the completed write",
		})
	})

	it("uses the last completed valid pre-tool rewrite rather than configuration order", async () => {
		const pending = runLifecycleHooks(
			config({ preToolUse: [command, command] }),
			{
				...baseRequest,
				hook_event_name: "PreToolUse",
				tool_name: "exec_command",
				tool_use_id: "call-1",
				tool_input: { command: "original" },
			},
			new AbortController().signal,
		)
		finish(children[1], {
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "allow",
				updatedInput: { command: "second-completed-first" },
			},
		})
		await Promise.resolve()
		finish(children[0], {
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "allow",
				updatedInput: { command: "first-completed-last" },
			},
		})
		expect(await pending).toMatchObject({ updatedInput: { command: "first-completed-last" }, warnings: [] })
	})

	it("lets a pre-tool denial dominate rewrites without creating permission authority", async () => {
		const pending = runLifecycleHooks(
			config({ preToolUse: [command, command] }),
			{
				...baseRequest,
				hook_event_name: "PreToolUse",
				tool_name: "exec_command",
				tool_use_id: "call-1",
				tool_input: { command: "original" },
			},
			new AbortController().signal,
		)
		finish(children[0], {
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: "Blocked by installed user hook",
			},
		})
		finish(children[1], {
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "allow",
				updatedInput: { command: "rewritten" },
			},
		})
		const outcome = await pending
		expect(outcome).toMatchObject({ shouldBlock: true, blockReason: "Blocked by installed user hook" })
		expect(outcome).not.toHaveProperty("updatedInput")
		expect(outcome).not.toHaveProperty("permissionDecision")
	})

	it.each(["allow", "ask"])("does not grant authority from unsupported permissionDecision %s", async (decision) => {
		const pending = runLifecycleHooks(
			config({ preToolUse: [command] }),
			{
				...baseRequest,
				hook_event_name: "PreToolUse",
				tool_name: "read_file",
				tool_use_id: "call-1",
				tool_input: { path: "file.ts" },
			},
			new AbortController().signal,
		)
		finish(children[0], { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision } })
		const outcome = await pending
		expect(outcome).not.toHaveProperty("updatedInput")
		expect(outcome).not.toHaveProperty("permissionDecision")
		expect(outcome.warnings.length).toBeGreaterThan(0)
	})

	it("bounds total injected context and keeps configured fragment order", async () => {
		const pending = runLifecycleHooks(
			config({ sessionStart: [command, command] }),
			{ ...baseRequest, hook_event_name: "SessionStart", source: "startup" },
			new AbortController().signal,
		)
		finish(children[1], "B".repeat(3_000))
		finish(children[0], "A".repeat(3_000))
		const outcome = await pending
		expect(outcome.additionalContext?.[0].text).toBe("A".repeat(3_000))
		expect(outcome.additionalContext?.map(({ text }) => text).join("\n\n").length).toBeLessThanOrEqual(4_000)
	})

	it("honors cancellation before spawn and drops late hook output after cancellation", async () => {
		const before = new AbortController()
		before.abort()
		expect(
			await runLifecycleHooks(
				config({ sessionStart: [command] }),
				{ ...baseRequest, hook_event_name: "SessionStart", source: "startup" },
				before.signal,
			),
		).toEqual({ warnings: [] })
		expect(spawnMock).not.toHaveBeenCalled()

		const controller = new AbortController()
		const pending = runLifecycleHooks(
			config({ userPromptSubmit: [command] }),
			{ ...baseRequest, hook_event_name: "UserPromptSubmit", prompt: "Original" },
			controller.signal,
		)
		controller.abort()
		finish(children[0], { decision: "block", reason: "Late output" })
		expect(await pending).toEqual({ warnings: [] })
	})

	it("applies the existing timeout to non-completion events", async () => {
		vi.useFakeTimers()
		const pending = runLifecycleHooks(
			config({ sessionStart: [{ ...command, timeoutMs: 100 }] }),
			{ ...baseRequest, hook_event_name: "SessionStart", source: "startup" },
			new AbortController().signal,
		)
		await vi.advanceTimersByTimeAsync(100)
		const outcome = await pending
		expect(outcome).not.toHaveProperty("additionalContext")
		expect(outcome.warnings.join(" ")).toContain("timed out")
	})

	it("reports unserializable tool context as a hook failure before starting a subprocess", async () => {
		const tool_response: Record<string, unknown> = {}
		tool_response.cycle = tool_response
		const outcome = await runLifecycleHooks(
			config({ postToolUse: [command] }),
			{
				...baseRequest,
				hook_event_name: "PostToolUse",
				tool_name: "read_file",
				tool_use_id: "call-1",
				tool_input: { path: "file.ts" },
				tool_response,
			},
			new AbortController().signal,
		)

		expect(outcome.warnings.length).toBeGreaterThan(0)
		expect(outcome).not.toHaveProperty("additionalContext")
		expect(spawnMock).not.toHaveBeenCalled()
	})
})
