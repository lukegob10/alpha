import { EventEmitter } from "node:events"
import * as path from "node:path"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import i18next from "i18next"
import common from "../../../i18n/locales/en/common.json"
import {
	runCompletionHooks,
	runLifecycleHooks,
	type CompletionHookCommand,
	type CompletionHookConfig,
	type CompletionHookRequest,
	type LifecycleHookRequest,
} from "../CompletionHooks"

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock("node:child_process", () => ({ spawn: spawnMock }))

beforeAll(() => {
	i18next.addResourceBundle("en", "common", common, true, true)
})

const OUTPUT_LIMIT_BYTES = 16_384
const command: CompletionHookCommand = { command: process.execPath, args: ["fixture-hook.js"], timeoutMs: 5_000 }
const base = {
	session_id: "retained-output-task",
	turn_id: "turn-1",
	cwd: process.cwd(),
	model: "fixture-model",
	permission_mode: "ask",
	transcript_path: null,
}

interface EventCase {
	event: LifecycleHookRequest["hook_event_name"]
	key: keyof CompletionHookConfig
	request: LifecycleHookRequest
}

const events: EventCase[] = [
	...(["Stop", "SubagentStop"] as const).map((event) => ({
		event,
		key: event === "Stop" ? ("stop" as const) : ("subagentStop" as const),
		request: { ...base, hook_event_name: event, stop_hook_active: false, last_assistant_message: "Finished." },
	})),
	{
		event: "SessionStart",
		key: "sessionStart",
		request: { ...base, hook_event_name: "SessionStart", source: "startup" },
	},
	{
		event: "SubagentStart",
		key: "subagentStart",
		request: { ...base, hook_event_name: "SubagentStart", agent_id: "child-1", agent_type: "worker" },
	},
	{
		event: "UserPromptSubmit",
		key: "userPromptSubmit",
		request: { ...base, hook_event_name: "UserPromptSubmit", prompt: "Original request" },
	},
	{
		event: "PreToolUse",
		key: "preToolUse",
		request: {
			...base,
			hook_event_name: "PreToolUse",
			tool_name: "read_file",
			tool_use_id: "call-1",
			tool_input: { path: "file.ts" },
		},
	},
	{
		event: "PostToolUse",
		key: "postToolUse",
		request: {
			...base,
			hook_event_name: "PostToolUse",
			tool_name: "read_file",
			tool_use_id: "call-1",
			tool_input: { path: "file.ts" },
			tool_response: { result: "read" },
		},
	},
	{
		event: "PermissionRequest",
		key: "permissionRequest",
		request: {
			...base,
			hook_event_name: "PermissionRequest",
			tool_name: "read_file",
			tool_input: { path: "file.ts" },
		},
	},
	{ event: "PreCompact", key: "preCompact", request: { ...base, hook_event_name: "PreCompact", trigger: "manual" } },
	{ event: "PostCompact", key: "postCompact", request: { ...base, hook_event_name: "PostCompact", trigger: "auto" } },
	{ event: "Interrupt", key: "interrupt", request: { ...base, hook_event_name: "Interrupt" } },
	{ event: "SessionEnd", key: "sessionEnd", request: { ...base, hook_event_name: "SessionEnd", reason: "other" } },
]

function eventCase(event: EventCase["event"]): EventCase {
	const result = events.find((candidate) => candidate.event === event)
	if (!result) throw new Error(`Missing event fixture: ${event}`)
	return result
}

function run(event: EventCase, signal = new AbortController().signal, commands = [command]) {
	const config: CompletionHookConfig = { stop: [], subagentStop: [] }
	config[event.key] = commands
	const request = event.request
	if (isCompletionRequest(request)) {
		return runCompletionHooks(config, request, signal)
	}
	return runLifecycleHooks(config, request, signal)
}

function isCompletionRequest(request: LifecycleHookRequest): request is CompletionHookRequest {
	return request.hook_event_name === "Stop" || request.hook_event_name === "SubagentStop"
}

function failure(event: EventCase, reason: string): string {
	const label = event.event === "Stop" || event.event === "SubagentStop" ? "Completion" : event.event
	return `${label} hook ${reason}.`
}

function fakeChild(pid: number) {
	return Object.assign(new EventEmitter(), {
		pid,
		stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
		stdout: new EventEmitter(),
		stderr: new EventEmitter(),
		kill: vi.fn(() => true),
	})
}

type HookChild = ReturnType<typeof fakeChild>

function watchedChunk(buffer: Buffer) {
	return {
		buffer,
		copy: vi.spyOn(buffer, "copy"),
		decode: vi.spyOn(buffer, "toString"),
	}
}

describe("bounded retained hook output through the public runners", () => {
	let hooks: HookChild[]
	let killers: HookChild[]
	let platform: PropertyDescriptor
	let onKillerSpawn: (() => void) | undefined
	let taskkillPath: string

	beforeEach(() => {
		vi.useFakeTimers()
		platform = Object.getOwnPropertyDescriptor(process, "platform")!
		Object.defineProperty(process, "platform", { ...platform, value: "win32" })
		vi.stubEnv("SystemRoot", process.cwd())
		taskkillPath = path.join(process.cwd(), "System32", "taskkill.exe")
		// Even the POSIX controls below must never signal a real process.
		vi.spyOn(process, "kill").mockImplementation(() => true)
		vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
			const controller = new AbortController()
			setTimeout(() => controller.abort(new Error("Controlled cleanup deadline")), milliseconds)
			return controller.signal
		})
		hooks = []
		killers = []
		onKillerSpawn = undefined
		spawnMock.mockReset()
		spawnMock.mockImplementation((executable: string) => {
			const child = fakeChild(700 + hooks.length + killers.length)
			if (executable === taskkillPath) {
				killers.push(child)
				const reentrant = onKillerSpawn
				onKillerSpawn = undefined
				reentrant?.()
			} else {
				hooks.push(child)
			}
			return child
		})
	})

	afterEach(() => {
		vi.clearAllTimers()
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
		Object.defineProperty(process, "platform", platform)
		vi.useRealTimers()
	})

	it.each(events)("rejects combined raw stdout/stderr above the inclusive budget at $event", async (event) => {
		const pending = run(event)
		const child = hooks[0]
		child.stdout.emit("data", Buffer.from("{}".padEnd(4_096, " ")))
		child.stderr.emit("data", Buffer.alloc(4_096, " "))
		child.stdout.emit("data", Buffer.alloc(4_096, " "))
		child.stderr.emit("data", Buffer.alloc(4_096, " "))
		expect(killers).toHaveLength(0)
		child.stderr.emit("data", Buffer.from(" "))
		expect(killers).toHaveLength(1)
		child.emit("close", 0)
		killers[0].emit("close", 0)

		expect(await pending).toEqual({ warnings: [failure(event, "output limit exceeded")] })
	})

	it.each(events)("accepts exactly the combined raw byte budget at $event", async (event) => {
		const pending = run(event)
		hooks[0].stdout.emit("data", Buffer.from(JSON.stringify({ systemMessage: "Boundary note" }).padEnd(8_192, " ")))
		hooks[0].stderr.emit("data", Buffer.alloc(8_192, " "))
		hooks[0].emit("close", 0)

		expect(await pending).toEqual({ warnings: event.event === "SessionEnd" ? [] : ["Boundary note"] })
		expect(killers).toHaveLength(0)
	})

	it("rejects an oversized single chunk before copying or decoding it and ignores repeated late chunks", async () => {
		const event = eventCase("Stop")
		const pending = run(event)
		const settled = vi.fn()
		void pending.then(settled)
		const oversized = watchedChunk(Buffer.alloc(1_048_576, "x"))
		hooks[0].stdout.emit("data", oversized.buffer)
		expect(killers).toHaveLength(1)
		expect(oversized.copy).not.toHaveBeenCalled()
		expect(oversized.decode).not.toHaveBeenCalled()

		const late = watchedChunk(Buffer.alloc(4_096, "y"))
		for (let index = 0; index < 16; index++) {
			hooks[0].stdout.emit("data", late.buffer)
			hooks[0].stderr.emit("data", late.buffer)
		}
		hooks[0].emit("close", 0)
		await vi.advanceTimersByTimeAsync(0)
		expect(settled).not.toHaveBeenCalled()
		expect(killers).toHaveLength(1)
		expect(late.copy).not.toHaveBeenCalled()
		expect(late.decode).not.toHaveBeenCalled()
		killers[0].emit("close", 0)

		expect(await pending).toEqual({ warnings: [failure(event, "output limit exceeded")] })
		expect(settled).toHaveBeenCalledTimes(1)
	})

	it.each(["data", "error", "close", "abort"] as const)(
		"keeps first-failure ownership during reentrant %s at killer startup",
		async (reentrantEvent) => {
			const event = eventCase("Stop")
			const controller = new AbortController()
			const pending = run(event, controller.signal)
			const settled = vi.fn()
			void pending.then(settled)
			const late = watchedChunk(Buffer.from("late"))
			onKillerSpawn = () => {
				if (reentrantEvent === "data") {
					hooks[0].stdout.emit("data", late.buffer)
					hooks[0].stderr.emit("data", late.buffer)
				} else if (reentrantEvent === "error") {
					hooks[0].emit("error", new Error("Reentrant hook error"))
				} else if (reentrantEvent === "close") {
					hooks[0].emit("close", 0)
				} else {
					controller.abort()
				}
			}
			hooks[0].stdout.emit("data", Buffer.alloc(OUTPUT_LIMIT_BYTES + 1, "x"))

			await vi.advanceTimersByTimeAsync(0)
			expect(settled).not.toHaveBeenCalled()
			expect(killers).toHaveLength(1)
			expect(late.copy).not.toHaveBeenCalled()
			expect(late.decode).not.toHaveBeenCalled()
			killers[0].emit("close", 0)
			expect(await pending).toEqual({ warnings: [failure(event, "output limit exceeded")] })
		},
	)

	it("copies an admitted small view into exact independent storage before its source changes", async () => {
		const pending = run(eventCase("Stop"))
		const encoded = Buffer.from(JSON.stringify({ decision: "block", reason: "Captured view" }))
		const backing = Buffer.alloc(1_048_576)
		const view = backing.subarray(123, 123 + encoded.length)
		encoded.copy(view)
		const observed = watchedChunk(view)
		hooks[0].stdout.emit("data", view)

		expect(observed.copy).toHaveBeenCalledTimes(1)
		expect(observed.decode).not.toHaveBeenCalled()
		const destination = observed.copy.mock.calls[0][0]
		expect(Buffer.isBuffer(destination)).toBe(true)
		expect(destination.byteLength).toBe(encoded.length)
		expect(destination.buffer).not.toBe(view.buffer)
		expect(destination.buffer.byteLength).toBe(encoded.length)
		view.fill(0)
		hooks[0].emit("close", 0)

		expect(await pending).toEqual({
			prompt: "Captured view",
			fragments: [{ hook_run_id: expect.any(String), text: "Captured view" }],
			warnings: [],
		})
	})

	it("preserves a JSON continuation when every UTF8 byte arrives separately", async () => {
		const pending = run(eventCase("Stop"))
		const reason = "Inspect café 🙂 before finishing"
		const encoded = Buffer.from(JSON.stringify({ decision: "block", reason }))
		for (const byte of encoded) hooks[0].stdout.emit("data", Buffer.from([byte]))
		hooks[0].emit("close", 0)

		expect(await pending).toEqual({
			prompt: reason,
			fragments: [{ hook_run_id: expect.any(String), text: reason }],
			warnings: [],
		})
	})

	it("preserves split UTF8 in stderr continuation independently from stdout", async () => {
		const pending = run(eventCase("SubagentStop"))
		const reason = "Review résumé 🙂"
		const stderr = Buffer.from(reason)
		const stdout = Buffer.from(JSON.stringify({ systemMessage: "Ignored on exit 2 é" }))
		for (let index = 0; index < Math.max(stderr.length, stdout.length); index++) {
			if (index < stderr.length) hooks[0].stderr.emit("data", stderr.subarray(index, index + 1))
			if (index < stdout.length) hooks[0].stdout.emit("data", stdout.subarray(index, index + 1))
		}
		hooks[0].emit("close", 2)

		expect(await pending).toEqual({
			prompt: reason,
			fragments: [{ hook_run_id: expect.any(String), text: reason }],
			warnings: [],
		})
	})

	it("preserves split UTF8 in lifecycle-specific JSON without mixing decoder state between streams", async () => {
		const pending = run(eventCase("UserPromptSubmit"))
		const reason = "Inspect dépôt 🙂"
		const stdout = Buffer.from(JSON.stringify({ decision: "block", reason }))
		const stderr = Buffer.from("Unrelated stderr €")
		for (let index = 0; index < Math.max(stdout.length, stderr.length); index++) {
			if (index < stdout.length) hooks[0].stdout.emit("data", stdout.subarray(index, index + 1))
			if (index < stderr.length) hooks[0].stderr.emit("data", stderr.subarray(index, index + 1))
		}
		hooks[0].emit("close", 0)

		expect(await pending).toMatchObject({
			shouldStop: true,
			stopReason: reason,
			stopProvenance: {
				event: "UserPromptSubmit",
				fragments: [{ hook_run_id: expect.any(String), text: reason }],
			},
			warnings: [],
		})
	})

	it("decodes malformed bytes lossily once, including an incomplete sequence at stream end", async () => {
		const pending = run(eventCase("SessionStart"))
		hooks[0].stdout.emit("data", Buffer.from([0x66, 0x80, 0xc3, 0x28, 0xe2]))
		hooks[0].stdout.emit("data", Buffer.from([0x82]))
		hooks[0].emit("close", 0)

		expect(await pending).toEqual({
			additionalContext: [{ hook_run_id: expect.any(String), text: "f\uFFFD\uFFFD(\uFFFD" }],
			warnings: [],
		})
	})

	it("charges malformed bytes as raw bytes even when replacement text encodes to more bytes", async () => {
		const pending = run(eventCase("SessionStart"))
		hooks[0].stdout.emit("data", Buffer.alloc(OUTPUT_LIMIT_BYTES, 0xff))
		expect(killers).toHaveLength(0)
		hooks[0].emit("close", 0)

		expect(await pending).toEqual({
			additionalContext: [{ hook_run_id: expect.any(String), text: "\uFFFD".repeat(4_000) }],
			warnings: [],
		})
	})

	it("ignores empty stdout and stderr chunks without copying or decoding", async () => {
		const pending = run(eventCase("Stop"))
		const empty = watchedChunk(Buffer.alloc(0))
		for (let count = 0; count < 32; count++) {
			hooks[0].stdout.emit("data", empty.buffer)
			hooks[0].stderr.emit("data", empty.buffer)
		}
		expect(empty.copy).not.toHaveBeenCalled()
		expect(empty.decode).not.toHaveBeenCalled()
		hooks[0].emit("close", 0)
		expect(await pending).toEqual({ warnings: [] })
	})

	it("retains a separate byte budget for each concurrently owned command", async () => {
		const pending = run(eventCase("Stop"), new AbortController().signal, [command, command])
		for (let index = 0; index < 2; index++) {
			const output = JSON.stringify({ systemMessage: `Command ${index}` }).padEnd(OUTPUT_LIMIT_BYTES, " ")
			hooks[index].stdout.emit("data", Buffer.from(output))
		}
		hooks[1].emit("close", 0)
		hooks[0].emit("close", 0)

		expect(await pending).toEqual({ warnings: ["Command 0", "Command 1"] })
		expect(killers).toHaveLength(0)
	})

	it.each(["Stop", "SessionStart", "SessionEnd"] as const)(
		"does not start %s after preexisting cancellation",
		async (event) => {
			const controller = new AbortController()
			controller.abort()

			expect(await run(eventCase(event), controller.signal)).toEqual({ warnings: [] })
			expect(spawnMock).not.toHaveBeenCalled()
		},
	)

	it.each(["Stop", "UserPromptSubmit", "SessionEnd"] as const)(
		"discards late output and waits for owned termination after %s cancellation",
		async (event) => {
			const controller = new AbortController()
			const pending = run(eventCase(event), controller.signal)
			const settled = vi.fn()
			void pending.then(settled)
			hooks[0].stdout.emit("data", Buffer.from('{"continue":'))
			controller.abort()
			expect(killers).toHaveLength(1)
			const late = watchedChunk(Buffer.from('false,"stopReason":"Must not reach caller"}'))
			hooks[0].stdout.emit("data", late.buffer)
			hooks[0].stderr.emit("data", late.buffer)
			hooks[0].emit("close", 0)
			await vi.advanceTimersByTimeAsync(0)
			expect(settled).not.toHaveBeenCalled()
			expect(late.copy).not.toHaveBeenCalled()
			expect(late.decode).not.toHaveBeenCalled()
			killers[0].emit("close", 0)

			expect(await pending).toEqual({ warnings: [] })
			expect(settled).toHaveBeenCalledTimes(1)
		},
	)

	it.each(["Stop", "SessionStart", "Interrupt"] as const)(
		"keeps %s timeout ownership while delayed killer output is drained",
		async (eventName) => {
			const event = eventCase(eventName)
			const pending = run(event, new AbortController().signal, [{ ...command, timeoutMs: 100 }])
			const settled = vi.fn()
			void pending.then(settled)
			await vi.advanceTimersByTimeAsync(99)
			expect(killers).toHaveLength(0)
			await vi.advanceTimersByTimeAsync(1)
			expect(killers).toHaveLength(1)
			const late = watchedChunk(Buffer.from('{"systemMessage":"Must not publish"}'))
			hooks[0].stdout.emit("data", late.buffer)
			hooks[0].stderr.emit("data", late.buffer)
			hooks[0].emit("close", 0)
			await vi.advanceTimersByTimeAsync(0)
			expect(settled).not.toHaveBeenCalled()
			expect(late.copy).not.toHaveBeenCalled()
			expect(late.decode).not.toHaveBeenCalled()
			killers[0].emit("close", 0)

			expect(await pending).toEqual({ warnings: [failure(event, "timed out")] })
		},
	)

	it("retains the first failure after cancellation and releases its timer and abort listener once", async () => {
		const event = eventCase("Stop")
		const controller = new AbortController()
		const addListener = vi.spyOn(controller.signal, "addEventListener")
		const removeListener = vi.spyOn(controller.signal, "removeEventListener")
		const pending = run(event, controller.signal)
		const settled = vi.fn()
		void pending.then(settled)
		hooks[0].stdout.emit("data", Buffer.alloc(OUTPUT_LIMIT_BYTES + 1))
		controller.abort()
		hooks[0].emit("error", new Error("Late child error"))
		hooks[0].emit("close", 0)
		await vi.advanceTimersByTimeAsync(0)
		expect(settled).not.toHaveBeenCalled()
		expect(killers).toHaveLength(1)
		killers[0].emit("close", 0)

		expect(await pending).toEqual({ warnings: [failure(event, "output limit exceeded")] })
		const listener = addListener.mock.calls.find(([type]) => type === "abort")?.[1]
		expect(listener).toBeDefined()
		expect(removeListener).toHaveBeenCalledExactlyOnceWith("abort", listener)
		expect(vi.getTimerCount()).toBe(0)
		hooks[0].emit("close", 0)
		hooks[0].stdout.emit("data", Buffer.from("late"))
		await vi.advanceTimersByTimeAsync(30_000)
		expect(settled).toHaveBeenCalledTimes(1)
		expect(killers).toHaveLength(1)
	})

	it("ignores late data and duplicate close after successful settlement", async () => {
		const pending = run(eventCase("Stop"))
		const settled = vi.fn()
		void pending.then(settled)
		hooks[0].stdout.emit("data", Buffer.from(JSON.stringify({ systemMessage: "Finished once" })))
		hooks[0].emit("close", 0)
		const outcome = await pending
		expect(outcome).toEqual({ warnings: ["Finished once"] })
		const late = watchedChunk(Buffer.alloc(OUTPUT_LIMIT_BYTES + 1))
		hooks[0].stdout.emit("data", late.buffer)
		hooks[0].stderr.emit("data", late.buffer)
		hooks[0].emit("close", 2)
		await vi.advanceTimersByTimeAsync(30_000)

		expect(late.copy).not.toHaveBeenCalled()
		expect(late.decode).not.toHaveBeenCalled()
		expect(settled).toHaveBeenCalledExactlyOnceWith(outcome)
		expect(killers).toHaveLength(0)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("uses the existing two-second Windows killer grace without accepting the hook's early close", async () => {
		const event = eventCase("Stop")
		const pending = run(event)
		const settled = vi.fn()
		void pending.then(settled)
		hooks[0].stderr.emit("data", Buffer.alloc(OUTPUT_LIMIT_BYTES + 1))
		hooks[0].emit("close", 0)
		await vi.advanceTimersByTimeAsync(1_999)
		expect(settled).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)

		expect(await pending).toEqual({ warnings: [failure(event, "output limit exceeded")] })
		expect(killers[0].kill).toHaveBeenCalledExactlyOnceWith("SIGKILL")
		expect(hooks[0].kill).toHaveBeenCalledExactlyOnceWith("SIGKILL")
		expect(vi.getTimerCount()).toBe(0)
	})

	it("keeps no-shell Windows tree termination and tolerates killer spawn failure", async () => {
		const event = eventCase("Stop")
		const pending = run(event)
		spawnMock.mockImplementationOnce(() => {
			throw new Error("Controlled taskkill spawn failure")
		})
		hooks[0].stderr.emit("data", Buffer.alloc(OUTPUT_LIMIT_BYTES + 1))

		expect(await pending).toEqual({ warnings: [failure(event, "output limit exceeded")] })
		expect(spawnMock).toHaveBeenNthCalledWith(2, taskkillPath, ["/PID", String(hooks[0].pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
			shell: false,
		})
		expect(hooks[0].kill).toHaveBeenCalledExactlyOnceWith("SIGKILL")
	})

	it.each([false, true])("keeps POSIX group ownership with direct-child fallback=%s", async (groupFailure) => {
		Object.defineProperty(process, "platform", { ...platform, value: "linux" })
		if (groupFailure) {
			vi.mocked(process.kill).mockImplementation(() => {
				throw new Error("Controlled missing group")
			})
		}
		const event = eventCase("Stop")
		const pending = run(event)
		hooks[0].stdout.emit("data", Buffer.alloc(OUTPUT_LIMIT_BYTES + 1))

		expect(await pending).toEqual({ warnings: [failure(event, "output limit exceeded")] })
		expect(process.kill).toHaveBeenCalledExactlyOnceWith(-hooks[0].pid, "SIGKILL")
		expect(hooks[0].kill).toHaveBeenCalledTimes(groupFailure ? 1 : 0)
		expect(spawnMock).toHaveBeenCalledTimes(1)
	})
})
