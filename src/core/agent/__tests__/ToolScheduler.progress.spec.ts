import path from "path"
import { tmpdir } from "os"

import { ToolRegistry, type ToolDescriptor } from "../../tools/ToolRegistry"
import { ToolRepetitionDetector } from "../../tools/ToolRepetitionDetector"
import type { AgentToolCall } from "../AgentResponse"
import { ToolScheduler, type ToolExecutionHost } from "../ToolScheduler"

const workspace = path.join(tmpdir(), "scheduler-progress-fixture")

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

function makeHost(): ToolExecutionHost {
	const host: ToolExecutionHost = {
		taskId: "progress-fixture",
		cwd: workspace,
		userMessageContent: [],
		say: async () => {},
		recordToolUsage: () => {},
		pushToolResultToUserContent(result) {
			if (
				host.hasToolResultForCall?.(result.tool_use_id) ||
				host.userMessageContent.some(
					(item) => item.type === "tool_result" && item.tool_use_id === result.tool_use_id,
				)
			)
				return false
			host.userMessageContent.push(result)
			return true
		},
	}
	return host
}

function descriptor(
	name: string,
	execute: ToolDescriptor["execute"],
	concurrency: "serial" | "parallel" = "serial",
): ToolDescriptor {
	return {
		name,
		aliases: [],
		schema: { type: "function", function: { name, description: name, parameters: { type: "object" } } },
		capabilities: {
			concurrency,
			sideEffects: concurrency === "parallel" ? "none" : "workspace",
			controlFlow: false,
			requiresApproval: false,
		},
		getConcurrencyScope: (call) => path.join(workspace, call.id ?? name),
		execute,
	}
}

function calls(name: string, count: number): AgentToolCall[] {
	return Array.from({ length: count }, (_, index) => ({
		type: "tool_call",
		id: `call-${index}`,
		name,
		arguments: { command: "pnpm test", index },
	}))
}

function receiptIds(host: ToolExecutionHost): string[] {
	return host.userMessageContent.flatMap((item) => (item.type === "tool_result" ? [item.tool_use_id] : []))
}

describe("ToolScheduler progress observation", () => {
	it("observes every changing serial effect before the next effect without committing receipts early", async () => {
		const host = makeHost()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		const detector = new ToolRepetitionDetector()
		detector.recordOutcome({
			toolName: "read_file",
			kind: "read",
			status: "success",
			scope: workspace,
			stateFingerprint: "0",
		})
		let version = 0
		let stopped = false
		const observed: number[] = []
		host.shouldStopRepeatedToolCall = () => stopped
		host.recordToolCallForStopping = (toolName, args, status) => {
			expect(receiptIds(host)).toEqual([])
			observed.push(version)
			stopped =
				detector.recordOutcome({
					toolName,
					args,
					status,
					kind: "mutation",
					scope: workspace,
					stateFingerprint: String(version),
				}).action === "stop"
		}
		registry.register(
			descriptor("mutation", async ({ callbacks }) => {
				version += 1
				callbacks.pushToolResult(`changed to version ${version}`)
			}),
		)

		const outcome = await new ToolScheduler({
			executionHost: host,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(calls("mutation", 16))
		expect(observed).toEqual(Array.from({ length: 16 }, (_, index) => index + 1))
		expect(stopped).toBe(false)
		expect(outcome.results.every((result) => result.status === "success")).toBe(true)
		expect(receiptIds(host)).toEqual(calls("mutation", 16).map((call) => call.id))
	})

	it("caps failed serial effects inside one model batch and retains every terminal receipt", async () => {
		const host = makeHost()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		const detector = new ToolRepetitionDetector()
		let effects = 0
		let stopped = false
		host.shouldStopRepeatedToolCall = () => stopped
		host.recordToolCallForStopping = (toolName, args, status) => {
			stopped =
				detector.recordOutcome({ toolName, args, status, kind: "check", scope: workspace }).action === "stop"
		}
		registry.register(
			descriptor("execute_command", async ({ callbacks }) => {
				effects += 1
				callbacks.setResultMetadata?.({ status: "error", exitCode: 1 })
				callbacks.pushToolResult("check failed")
			}),
		)

		const outcome = await new ToolScheduler({
			executionHost: host,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(calls("execute_command", 24))
		expect(effects).toBe(12)
		expect(outcome.results).toHaveLength(24)
		expect(outcome.results.slice(0, 12).every((result) => result.content === "check failed")).toBe(true)
		expect(outcome.results.slice(12).every((result) => String(result.content).includes("Stopping repeated"))).toBe(
			true,
		)
		expect(receiptIds(host)).toEqual(calls("execute_command", 24).map((call) => call.id))
	})

	it("awaits admitted evidence before starting the next serial effect", async () => {
		const host = makeHost()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		const entered = deferred()
		const release = deferred()
		const effects: string[] = []
		host.recordToolCallForStopping = async (_name, _args, _status, _category, result) => {
			if (result?.callId !== "call-0") return
			entered.resolve()
			await release.promise
		}
		registry.register(
			descriptor("mutation", async ({ call, callbacks }) => {
				effects.push(call.id!)
				callbacks.pushToolResult("changed")
			}),
		)

		const pending = new ToolScheduler({ executionHost: host, registry, mode: "code", validateCall: () => {} }).run(
			calls("mutation", 2),
		)
		await entered.promise
		expect(effects).toEqual(["call-0"])
		expect(receiptIds(host)).toEqual([])
		release.resolve()
		await pending
		expect(effects).toEqual(["call-0", "call-1"])
	})

	it("does not observe duplicate logical IDs or prior staged and persisted receipts", async () => {
		const host = makeHost()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		host.hasToolResultForCall = (id) => id === "persisted"
		host.userMessageContent.push({ type: "tool_result", tool_use_id: "pending", content: "prior pending result" })
		const observed: string[] = []
		host.recordToolCallForStopping = (_name, _args, _status, _category, result) => {
			observed.push(result!.callId)
		}
		registry.register(
			descriptor("read", async ({ callbacks }) => {
				callbacks.pushToolResult("read")
			}),
		)
		const response: AgentToolCall[] = ["persisted", "pending", "fresh", "fresh"].map((id) => ({
			type: "tool_call",
			id,
			name: "read",
			arguments: {},
		}))
		const scheduler = new ToolScheduler({ executionHost: host, registry, mode: "code", validateCall: () => {} })

		await scheduler.run(response)
		await scheduler.run(response)
		expect(observed).toEqual(["fresh"])
		expect(receiptIds(host)).toEqual(["pending", "fresh"])
	})

	it("observes parallel reads in model order with overshoot bounded to their active window", async () => {
		const host = makeHost()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		const detector = new ToolRepetitionDetector(3, { noProgressLimit: 1 })
		const releases = Array.from({ length: 3 }, deferred)
		const started = deferred()
		const effects: string[] = []
		const observed: string[] = []
		let stopped = false
		host.shouldStopRepeatedToolCall = () => stopped
		host.recordToolCallForStopping = (toolName, args, status, _category, result) => {
			observed.push(result!.callId)
			stopped =
				detector.recordOutcome({ toolName, args, status, kind: "read", scope: workspace }).action === "stop"
		}
		registry.register(
			descriptor(
				"read",
				async ({ call, callbacks }) => {
					effects.push(call.id!)
					if (effects.length === 3) started.resolve()
					await releases[Number(call.id!.split("-")[1])].promise
					callbacks.setResultMetadata?.({ status: "error" })
					callbacks.pushToolResult("read failed")
				},
				"parallel",
			),
		)

		const pending = new ToolScheduler({
			executionHost: host,
			registry,
			mode: "code",
			validateCall: () => {},
			executionMode: "selective-parallel",
			maxConcurrency: 3,
		}).run(calls("read", 8))
		await started.promise
		releases[2].resolve()
		releases[0].resolve()
		releases[1].resolve()
		await pending
		expect(effects).toEqual(["call-0", "call-1", "call-2"])
		expect(observed.slice(0, 3)).toEqual(["call-0", "call-1", "call-2"])
		expect(receiptIds(host)).toEqual(calls("read", 8).map((call) => call.id))
	})

	it("retains completed effects and prevents later effects when observing evidence fails", async () => {
		const host = makeHost()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		const effects: string[] = []
		host.recordToolCallForStopping = async () => {
			throw new Error("evidence persistence unavailable")
		}
		registry.register(
			descriptor("mutation", async ({ call, callbacks }) => {
				effects.push(call.id!)
				callbacks.pushToolResult("changed")
			}),
		)

		const outcome = await new ToolScheduler({
			executionHost: host,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(calls("mutation", 2))
		expect(effects).toEqual(["call-0"])
		expect(outcome.status).toBe("failed")
		expect(outcome.results[0]).toMatchObject({ status: "success", content: "changed" })
		expect(outcome.results[1].status).toBe("error")
		expect(receiptIds(host)).toEqual(["call-0", "call-1"])
	})
})
