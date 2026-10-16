import { EventEmitter } from "node:events"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import i18next from "i18next"
import common from "../../../i18n/locales/en/common.json"
import { runLifecycleHooks, type CompletionHookConfig } from "../CompletionHooks"

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

const base = {
	session_id: "lifecycle-task",
	turn_id: "turn-1",
	cwd: process.cwd(),
	model: "fixture-model",
	permission_mode: "ask",
	transcript_path: null,
}
const command = { command: process.execPath, args: ["fixture.js"] }
const config = (extra: Partial<CompletionHookConfig> = {}): CompletionHookConfig => ({
	stop: [],
	subagentStop: [],
	...extra,
})

function finish(child: HookChild, stdout?: unknown, exitCode = 0, stderr = ""): void {
	if (stdout !== undefined)
		child.stdout.emit("data", Buffer.from(typeof stdout === "string" ? stdout : JSON.stringify(stdout)))
	if (stderr) child.stderr.emit("data", Buffer.from(stderr))
	child.emit("close", exitCode)
}

describe("permission, compact, and cleanup hook contracts", () => {
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

	it.each([undefined, "", "   "])(
		"keeps PermissionRequest denial effective with blank message %j",
		async (message) => {
			const pending = runLifecycleHooks(
				config({ permissionRequest: [command] }),
				{
					...base,
					hook_event_name: "PermissionRequest",
					tool_name: "write_to_file",
					tool_input: { path: "file.ts" },
				},
				new AbortController().signal,
			)
			finish(children[0], {
				hookSpecificOutput: {
					hookEventName: "PermissionRequest",
					decision: { behavior: "deny", ...(message === undefined ? {} : { message }) },
				},
			})

			expect(await pending).toMatchObject({
				shouldBlock: true,
				blockReason: "PermissionRequest hook denied approval",
			})
		},
	)

	it("lets a PermissionRequest denial dominate advisory allow without creating an approval grant", async () => {
		const pending = runLifecycleHooks(
			config({ permissionRequest: [command, command] }),
			{
				...base,
				hook_event_name: "PermissionRequest",
				tool_name: "write_to_file",
				tool_input: { path: "file.ts" },
			},
			new AbortController().signal,
		)
		finish(children[0], {
			hookSpecificOutput: {
				hookEventName: "PermissionRequest",
				decision: { behavior: "deny", message: "Denied by user hook" },
			},
		})
		finish(children[1], {
			hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
		})
		const outcome = await pending

		expect(outcome).toMatchObject({ shouldBlock: true, blockReason: "Denied by user hook" })
		expect(outcome).not.toHaveProperty("updatedInput")
		expect(outcome).not.toHaveProperty("permissionDecision")
	})

	it("treats PermissionRequest allow as advisory while native approval remains required", async () => {
		const pending = runLifecycleHooks(
			config({ permissionRequest: [command] }),
			{ ...base, hook_event_name: "PermissionRequest", tool_name: "read_file", tool_input: { path: "file.ts" } },
			new AbortController().signal,
		)
		finish(children[0], {
			hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
		})
		const outcome = await pending

		expect(outcome).not.toHaveProperty("shouldBlock")
		expect(outcome).not.toHaveProperty("updatedInput")
		expect(outcome).not.toHaveProperty("permissionDecision")
		expect(outcome.warnings.join(" ")).toContain("native approval is still required")
	})

	it.each([{ updatedInput: {} }, { updatedPermissions: [] }, { interrupt: true }])(
		"rejects unsupported permission mutation %j",
		async (unsupported) => {
			const pending = runLifecycleHooks(
				config({ permissionRequest: [command] }),
				{
					...base,
					hook_event_name: "PermissionRequest",
					tool_name: "read_file",
					tool_input: { path: "file.ts" },
				},
				new AbortController().signal,
			)
			finish(children[0], {
				hookSpecificOutput: {
					hookEventName: "PermissionRequest",
					decision: { behavior: "allow", ...unsupported },
				},
			})
			const outcome = await pending

			expect(outcome.warnings.length).toBeGreaterThan(0)
			expect(outcome).not.toHaveProperty("updatedInput")
			expect(outcome).not.toHaveProperty("permissionDecision")
		},
	)

	it.each(["PreCompact", "PostCompact"] as const)("preserves a typed stop and trigger at %s", async (event) => {
		const request = {
			...base,
			hook_event_name: event,
			trigger: "manual" as const,
			transcript_path: "/fixture/session-transcript.jsonl",
			agent_id: "captured-child",
			agent_type: "worker",
			agent_transcript_path: "/fixture/child-transcript.jsonl",
		}
		const pending = runLifecycleHooks(
			config({ preCompact: [command], postCompact: [command] }),
			request,
			new AbortController().signal,
		)
		expect(children[0].stdin.end).toHaveBeenCalledOnce()
		const input = JSON.parse(children[0].stdin.end.mock.calls[0][0] as string)
		expect(input).toEqual({
			session_id: "lifecycle-task",
			turn_id: "turn-1",
			cwd: base.cwd,
			model: "fixture-model",
			transcript_path: "/fixture/session-transcript.jsonl",
			hook_event_name: event,
			trigger: "manual",
			agent_id: "captured-child",
			agent_type: "worker",
		})
		expect(input).not.toHaveProperty("permission_mode")
		expect(input).not.toHaveProperty("agent_transcript_path")
		finish(children[0], { continue: false, stopReason: "Inspect before continuing", systemMessage: "Compact note" })

		expect(await pending).toMatchObject({
			shouldStop: true,
			stopReason: "Inspect before continuing",
			warnings: ["Compact note"],
		})
	})

	it.each(["PreCompact", "PostCompact"] as const)(
		"keeps %s stateless when unknown context is returned",
		async (event) => {
			const pending = runLifecycleHooks(
				config({ preCompact: [command], postCompact: [command] }),
				{
					...base,
					hook_event_name: event,
					trigger: "auto",
					agent_transcript_path: "/fixture/child-transcript.jsonl",
				},
				new AbortController().signal,
			)
			expect(children[0].stdin.end).toHaveBeenCalledOnce()
			const input = JSON.parse(children[0].stdin.end.mock.calls[0][0] as string)
			expect(input).toEqual({
				session_id: "lifecycle-task",
				turn_id: "turn-1",
				cwd: base.cwd,
				model: "fixture-model",
				transcript_path: null,
				hook_event_name: event,
				trigger: "auto",
			})
			expect(input).not.toHaveProperty("permission_mode")
			expect(input).not.toHaveProperty("agent_transcript_path")
			finish(children[0], {
				hookSpecificOutput: { hookEventName: event, additionalContext: "Must not inject compact output" },
			})
			expect(await pending).not.toHaveProperty("additionalContext")
		},
	)

	it("does not turn a failed compact hook into a successful control result", async () => {
		const pending = runLifecycleHooks(
			config({ preCompact: [command] }),
			{ ...base, hook_event_name: "PreCompact", trigger: "manual" },
			new AbortController().signal,
		)
		finish(children[0], undefined, 2, "Hook failed")
		const outcome = await pending
		expect(outcome.warnings.length).toBeGreaterThan(0)
		expect(outcome).not.toHaveProperty("shouldStop")
	})

	it("keeps Interrupt output limited to system warnings without context or control authority", async () => {
		const pending = runLifecycleHooks(
			config({ interrupt: [command] }),
			{ ...base, hook_event_name: "Interrupt" },
			new AbortController().signal,
		)
		finish(children[0], { continue: false, stopReason: "Ignore", decision: "block", systemMessage: "Cleanup note" })
		expect(await pending).toEqual({ warnings: ["Cleanup note"] })
	})

	it("reports non-JSON Interrupt stdout instead of silently treating it as a successful hook", async () => {
		const pending = runLifecycleHooks(
			config({ interrupt: [command] }),
			{ ...base, hook_event_name: "Interrupt" },
			new AbortController().signal,
		)
		finish(children[0], "Not JSON")
		const outcome = await pending
		expect(outcome.warnings.length).toBeGreaterThan(0)
		expect(outcome).not.toHaveProperty("additionalContext")
	})

	it("ignores SessionEnd stdout even when it resembles control instructions or malformed JSON", async () => {
		const pending = runLifecycleHooks(
			config({ sessionEnd: [command] }),
			{ ...base, hook_event_name: "SessionEnd", reason: "other" },
			new AbortController().signal,
		)
		finish(children[0], "{invalid JSON with stop instruction")
		expect(await pending).toEqual({ warnings: [] })
	})

	it("uses a one-second default cleanup command timeout", async () => {
		vi.useFakeTimers()
		let settled = false
		const pending = runLifecycleHooks(
			config({ sessionEnd: [command] }),
			{ ...base, hook_event_name: "SessionEnd", reason: "other" },
			new AbortController().signal,
		)
		void pending.then(() => {
			settled = true
		})
		await vi.advanceTimersByTimeAsync(999)
		expect(settled).toBe(false)
		await vi.advanceTimersByTimeAsync(1)
		expect((await pending).warnings.join(" ")).toContain("timed out")
	})

	it("bounds the complete cleanup queue at three seconds instead of starting another batch", async () => {
		vi.useFakeTimers()
		vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
			const controller = new AbortController()
			setTimeout(() => controller.abort(new Error("Cleanup deadline")), milliseconds)
			return controller.signal
		})
		const pending = runLifecycleHooks(
			config({ sessionEnd: Array.from({ length: 8 }, () => ({ ...command, timeoutMs: 30_000 })) }),
			{ ...base, hook_event_name: "SessionEnd", reason: "other" },
			new AbortController().signal,
		)
		expect(spawnMock).toHaveBeenCalledTimes(4)
		await vi.advanceTimersByTimeAsync(3_000)
		await pending
		expect(spawnMock).toHaveBeenCalledTimes(4)
	})
})
