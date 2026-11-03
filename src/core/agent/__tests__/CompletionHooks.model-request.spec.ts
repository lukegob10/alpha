import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { runLifecycleHooks, type CompletionHookConfig } from "../CompletionHooks"

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock("node:child_process", () => ({ spawn: spawnMock }))

const command = { command: process.execPath }
const base = {
	session_id: "session",
	turn_id: "turn",
	cwd: process.cwd(),
	model: "model",
	permission_mode: "ask",
	transcript_path: null,
}
const config: CompletionHookConfig = {
	stop: [],
	subagentStop: [],
	preModelRequest: [command],
	postModelRequest: [command],
}
let children: Array<
	EventEmitter & {
		stdin: EventEmitter & { end: ReturnType<typeof vi.fn> }
		stdout: EventEmitter
		stderr: EventEmitter
	}
>

beforeEach(() => {
	children = []
	spawnMock.mockImplementation(() => {
		const child = Object.assign(new EventEmitter(), {
			stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
			stdout: new EventEmitter(),
			stderr: new EventEmitter(),
		})
		children.push(child)
		return child
	})
})

describe("observation-only model request hooks", () => {
	it.each(["PreModelRequest", "PostModelRequest"] as const)(
		"ignores all %s stdout without changing model input or control",
		async (event) => {
			const request =
				event === "PreModelRequest"
					? { ...base, hook_event_name: event }
					: { ...base, hook_event_name: event, status: "completed" as const, error: null, token_usage: null }
			const pending = runLifecycleHooks(config, request, new AbortController().signal)
			const child = children[0]
			child.stdout.emit(
				"data",
				Buffer.from(
					JSON.stringify({
						continue: false,
						decision: "block",
						stopReason: "Do not stop",
						systemMessage: "Run more commands",
						hookSpecificOutput: {
							hookEventName: event,
							additionalContext: "Injected input",
							updatedInput: { cmd: "changed" },
						},
					}),
				),
			)
			child.emit("close", 0)
			expect(await pending).toEqual({ warnings: [] })
			const input = JSON.parse(child.stdin.end.mock.calls[0][0])
			expect(input).toEqual(
				expect.objectContaining({
					session_id: "session",
					turn_id: "turn",
					model: "model",
					hook_event_name: event,
				}),
			)
			expect(input).not.toHaveProperty("permission_mode")
			if (event === "PostModelRequest")
				expect(input).toMatchObject({ status: "completed", error: null, token_usage: null })
		},
	)

	it("keeps exit-code 2 diagnostic instead of producing a continuation", async () => {
		const pending = runLifecycleHooks(
			config,
			{ ...base, hook_event_name: "PreModelRequest" },
			new AbortController().signal,
		)
		children[0].stderr.emit("data", Buffer.from("Run another model request"))
		children[0].emit("close", 2)
		const result = await pending
		expect(result.warnings).toHaveLength(1)
		expect(result).not.toHaveProperty("additionalContext")
		expect(result).not.toHaveProperty("shouldStop")
		expect(result).not.toHaveProperty("shouldBlock")
	})

	it("keeps asynchronous observer JSON out of the later context drain", async () => {
		let background!: (signal: AbortSignal) => Promise<unknown>
		const scheduleAsync = vi.fn((_event, run) => {
			background = run
			return true
		})
		await runLifecycleHooks(
			{ ...config, preModelRequest: [{ ...command, async: true }] },
			{ ...base, hook_event_name: "PreModelRequest" },
			new AbortController().signal,
			{ scheduleAsync },
		)
		const pending = background(new AbortController().signal)
		children[0].stdout.emit("data", Buffer.from('{"systemMessage":"Do more work","continue":false}'))
		children[0].emit("close", 0)
		expect(await pending).toEqual({ warnings: [] })
	})
})
