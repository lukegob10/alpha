import * as fs from "fs/promises"
import * as path from "path"
import { tmpdir } from "os"
import { describe, expect, it } from "vitest"

import type { Task } from "../../task/Task"
import { AskIgnoredError } from "../../task/AskIgnoredError"
import { formatResponse } from "../../prompts/responses"
import { ApplyPatchTool } from "../../tools/ApplyPatchTool"
import { readFileTool } from "../../tools/ReadFileTool"
import { ToolRegistry, type ToolDescriptor } from "../../tools/ToolRegistry"
import { collectAgentResponse } from "../AgentResponseAccumulator"
import { AgentTurnEventLog, readAgentTurnEvents } from "../AgentTurnEventLog"
import { ToolScheduler } from "../ToolScheduler"

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function makeTask() {
	const userMessageContent: any[] = []
	const task = {
		abort: false,
		taskId: "scheduler-test",
		didRejectTool: false,
		didToolFailInCurrentTurn: false,
		userMessageContent,
		userMessageContentReady: false,
		ask: async () => ({ response: "yesButtonClicked" }),
		say: async () => {},
		recordToolUsage: () => {},
		pushToolResultToUserContent(result: any) {
			if (
				userMessageContent.some(
					(item) => item.type === "tool_result" && item.tool_use_id === result.tool_use_id,
				)
			) {
				return false
			}
			userMessageContent.push(result)
			return true
		},
	} as unknown as Task

	return task
}

function descriptor(
	name: string,
	concurrency: ToolDescriptor["capabilities"]["concurrency"],
	execute: ToolDescriptor["execute"],
): ToolDescriptor {
	return {
		name,
		aliases: [],
		schema: {
			type: "function",
			function: {
				name,
				description: name,
				parameters: { type: "object", properties: {}, additionalProperties: false },
			},
		},
		capabilities: {
			concurrency,
			sideEffects: concurrency === "parallel" ? "none" : "task",
			controlFlow: concurrency === "barrier",
			requiresApproval: false,
		},
		execute,
	}
}

function response(...calls: Array<{ id: string; name: string; arguments?: Record<string, unknown> }>) {
	return {
		items: calls.map((call) => ({ type: "tool_call" as const, ...call, arguments: call.arguments ?? {} })),
		text: "",
		reasoning: "",
		toolCalls: calls.map((call) => ({ type: "tool_call" as const, ...call, arguments: call.arguments ?? {} })),
	}
}

function resultIds(task: Task): string[] {
	return (task.userMessageContent as any[])
		.filter((item) => item.type === "tool_result")
		.map((item) => item.tool_use_id)
}

describe("ToolScheduler", () => {
	it("reports command exit status and bounded redacted verification output", async () => {
		const task = makeTask()
		const events: any[] = []
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(
			descriptor("execute_command", "serial", async ({ call, callbacks }) => {
				const command = String((call.nativeArgs as { command?: string }).command)
				callbacks.setResultMetadata?.({
					status: command.includes("fail") ? "error" : "success",
					exitCode: command.includes("fail") ? 128 : 0,
				})
				callbacks.pushToolResult(`apiKey=secret-token\n${"output ".repeat(2_000)}`)
			}),
		)

		const scheduler = new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
			onEvent: (event) => {
				events.push(event)
			},
		})

		await scheduler.run(response({ id: "success", name: "execute_command", arguments: { command: "npm test" } }))
		await scheduler.run(
			response({ id: "failure", name: "execute_command", arguments: { command: "npm test --fail" } }),
		)

		const verificationResults = events.filter((event) => event.type === "verification_result")
		expect(verificationResults.map((event) => [event.status, event.exitCode])).toEqual([
			["success", 0],
			["error", 128],
		])
		expect(verificationResults[0].output).toContain("apiKey=[redacted]")
		expect(verificationResults[0].output).not.toContain("secret-token")
		expect(verificationResults[0].output.length).toBeLessThanOrEqual(8_000)
		expect(verificationResults[0].output).toContain("[truncated]")
	})

	it("reports denied and cancelled command verification results", async () => {
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(
			descriptor("execute_command", "serial", async ({ callbacks }) => {
				if (await callbacks.askApproval("command", "npm test")) {
					callbacks.pushToolResult("should not run")
				}
			}),
		)

		const deniedEvents: any[] = []
		const deniedTask = makeTask()
		deniedTask.ask = async () => ({ response: "noButtonClicked" }) as any
		await new ToolScheduler({
			task: deniedTask,
			registry,
			mode: "code",
			validateCall: () => {},
			onEvent: (event) => {
				deniedEvents.push(event)
			},
		}).run(response({ id: "denied", name: "execute_command", arguments: { command: "npm test" } }))

		const cancelledEvents: any[] = []
		const cancelledTask = makeTask()
		cancelledTask.ask = async () => ({ response: "messageResponse" }) as any
		await new ToolScheduler({
			task: cancelledTask,
			registry,
			mode: "code",
			validateCall: () => {},
			onEvent: (event) => {
				cancelledEvents.push(event)
			},
		}).run(response({ id: "cancelled", name: "execute_command", arguments: { command: "npm test" } }))

		expect(deniedEvents.find((event) => event.type === "verification_result").status).toBe("denied")
		expect(cancelledEvents.find((event) => event.type === "verification_result").status).toBe("cancelled")
	})

	it("emits error telemetry for a stale apply_patch mismatch", async () => {
		const workspace = await fs.mkdtemp(path.join(tmpdir(), "stale-apply-patch-"))
		const telemetryStorage = await fs.mkdtemp(path.join(tmpdir(), "stale-apply-patch-events-"))
		const filePath = path.join(workspace, "harness-stale-edit-test.txt")
		const externallyChanged = "status = externally changed\nmarker = preserve-me\nexternal_change = true\n"
		await fs.writeFile(filePath, externallyChanged, "utf8")

		try {
			const task = makeTask()
			Object.assign(task, {
				cwd: workspace,
				consecutiveMistakeCount: 0,
				recordToolError: () => {},
			})
			const events: any[] = []
			const eventLog = new AgentTurnEventLog("stale-apply-patch", telemetryStorage)
			const registry = new ToolRegistry({ includeBuiltIns: false })
			registry.register({
				...descriptor("apply_patch", "serial", async ({ task: executionTask, call, callbacks }) => {
					await new ApplyPatchTool().execute(call.nativeArgs as { patch: string }, executionTask, callbacks)
				}),
			})

			const outcome = await new ToolScheduler({
				task,
				registry,
				mode: "code",
				validateCall: () => {},
				onEvent: async (event) => {
					events.push(event)
					await eventLog.append(event)
				},
			}).run(
				response({
					id: "stale-apply-patch",
					name: "apply_patch",
					arguments: {
						patch: [
							"*** Begin Patch",
							"*** Update File: harness-stale-edit-test.txt",
							"@@",
							"-status = baseline",
							"+status = updated by agent",
							"*** End Patch",
						].join("\n"),
					},
				}),
			)

			expect(outcome.results[0]?.status).toBe("error")
			expect(events.find((event) => event.type === "tool_result").status).toBe("error")
			const persistedEvents = await readAgentTurnEvents("stale-apply-patch", telemetryStorage)
			expect(persistedEvents.find((record) => record.event.type === "tool_result")?.event).toMatchObject({
				type: "tool_result",
				name: "apply_patch",
				status: "error",
			})
			expect(await fs.readFile(filePath, "utf8")).toBe(externallyChanged)
		} finally {
			await fs.rm(workspace, { recursive: true, force: true })
			await fs.rm(telemetryStorage, { recursive: true, force: true })
		}
	})

	it("normalizes structured native tool results before emitting tool telemetry", async () => {
		const cases = [
			{
				id: "stale-apply-patch",
				name: "apply_patch",
				result: formatResponse.toolError("Failed to process patch: Failed to find expected lines..."),
				status: "error",
			},
			{
				id: "successful-apply-patch",
				name: "apply_patch",
				result: "Applied patch successfully.",
				status: "success",
			},
			{
				id: "denied-tool",
				name: "read_file",
				result: formatResponse.toolDenied(),
				status: "denied",
			},
			{
				id: "cancelled-tool",
				name: "read_file",
				result: JSON.stringify({ status: "cancelled", message: "Tool execution was cancelled." }),
				status: "cancelled",
			},
		] as const
		const task = makeTask()
		const events: any[] = []
		const outcomes = []

		for (const testCase of cases) {
			const registry = new ToolRegistry({ includeBuiltIns: false })
			registry.register(
				descriptor(testCase.name, "serial", async ({ callbacks }) => {
					callbacks.pushToolResult(testCase.result)
				}),
			)
			outcomes.push(
				await new ToolScheduler({
					task,
					registry,
					mode: "code",
					validateCall: () => {},
					onEvent: (event) => {
						events.push(event)
					},
				}).run(response({ id: testCase.id, name: testCase.name })),
			)
		}

		expect(outcomes.map((outcome) => outcome.results[0]?.status)).toEqual(cases.map(({ status }) => status))
		expect(events.filter((event) => event.type === "tool_result").map((event) => event.status)).toEqual(
			cases.map(({ status }) => status),
		)
		expect((task.userMessageContent as any[]).map((item) => item.content)).toEqual(
			cases.map(({ result }) => result),
		)
	})

	it("does not report a verification result for a still-running command", async () => {
		const task = makeTask()
		const events: any[] = []
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(
			descriptor("execute_command", "serial", async ({ callbacks }) => {
				callbacks.pushToolResult("Command is still running in the background.")
			}),
		)

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
			onEvent: (event) => {
				events.push(event)
			},
		}).run(response({ id: "running", name: "execute_command", arguments: { command: "npm test" } }))

		expect(outcome.results[0].status).toBe("success")
		expect(events.filter((event) => event.type === "verification_result")).toHaveLength(0)
	})

	it("preserves two provider stream tool calls through normalization into execution", async () => {
		const normalized = await collectAgentResponse(
			(async function* () {
				yield { type: "tool_call_partial", index: 0, id: "1", name: "read_file" } as const
				yield { type: "tool_call_partial", index: 0, arguments: '{"path":"a.ts"}' } as const
				yield { type: "tool_call_partial", index: 1, id: "2", name: "list_files" } as const
				yield { type: "tool_call_partial", index: 1, arguments: '{"path":"src"}' } as const
			})(),
		)
		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		let peak = 0
		let active = 0

		for (const name of ["read_file", "list_files"]) {
			registry.register(
				descriptor(name, "parallel", async ({ callbacks }) => {
					active += 1
					peak = Math.max(peak, active)
					await wait(5)
					callbacks.pushToolResult(name)
					active -= 1
				}),
			)
		}

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(normalized)

		expect(normalized.toolCalls).toHaveLength(2)
		expect(outcome.parallelBatchCount).toBe(1)
		expect(peak).toBe(2)
		expect(resultIds(task)).toEqual(["1", "2"])
	})

	it("collects and executes six independent reads as one ordered parallel batch", async () => {
		const normalized = await collectAgentResponse(
			(async function* () {
				for (let index = 0; index < 6; index += 1) {
					yield {
						type: "tool_call_partial",
						index,
						id: `call-${index + 1}`,
						name: "read_file",
					} as const
					yield {
						type: "tool_call_partial",
						index,
						arguments: JSON.stringify({ path: `file-${index + 1}.ts` }),
					} as const
				}
			})(),
		)
		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		let active = 0
		let peak = 0
		let approvalsInFlight = 0
		let peakApprovals = 0
		task.ask = async () => {
			approvalsInFlight += 1
			peakApprovals = Math.max(peakApprovals, approvalsInFlight)
			await wait(1)
			approvalsInFlight -= 1
			return { response: "yesButtonClicked" } as any
		}
		registry.register(
			descriptor("read_file", "parallel", async ({ call, callbacks }) => {
				expect(await callbacks.askApproval("tool", "read file")).toBe(true)
				active += 1
				peak = Math.max(peak, active)
				await wait(100)
				callbacks.pushToolResult(`content-${call.id}`)
				active -= 1
			}),
		)

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(normalized)

		expect(normalized.toolCalls).toHaveLength(6)
		expect(outcome.batchSize).toBe(6)
		expect(outcome.parallelBatchCount).toBe(1)
		expect(outcome.parallelToolCount).toBe(6)
		expect(peak).toBe(6)
		expect(peakApprovals).toBe(1)
		expect(outcome.approvalRequestCount).toBe(6)
		expect(outcome.approvalDeniedCount).toBe(0)
		expect(outcome.approvalCancelledCount).toBe(0)
		expect(outcome.supersededAskCount).toBe(0)
		expect(outcome.completedToolResultCount).toBe(6)
		expect(outcome.results.every((result) => result.status === "success")).toBe(true)
		expect((task.userMessageContent as any[]).map((item) => item.content)).toEqual([
			"content-call-1",
			"content-call-2",
			"content-call-3",
			"content-call-4",
			"content-call-5",
			"content-call-6",
		])
		expect(resultIds(task)).toEqual(["call-1", "call-2", "call-3", "call-4", "call-5", "call-6"])
		expect(outcome.status).toBe("completed")
		expect(task.userMessageContentReady).toBe(true)
	})

	it("runs six real read_file handlers concurrently and returns all contents", async () => {
		const task = makeTask()
		Object.assign(task, {
			cwd: process.cwd(),
			api: { getModel: () => ({ info: { supportsImages: false } }) },
			consecutiveMistakeCount: 0,
			rooIgnoreController: { validateAccess: () => true },
			fileContextTracker: { trackFileContext: async () => {} },
			providerRef: { deref: () => ({ getState: async () => ({}) }) },
			recordToolError: () => {},
		})

		const files = [
			"src/core/agent/AgentResponse.ts",
			"src/core/agent/AgentResponseAccumulator.ts",
			"src/core/agent/AgentTurnEvents.ts",
			"src/core/agent/AgentTurnTelemetry.ts",
			"src/core/agent/ToolScheduler.ts",
			"src/core/tools/ToolRegistry.ts",
		]
		const registry = new ToolRegistry({ includeBuiltIns: false })
		let active = 0
		let peak = 0
		registry.register({
			name: "read_file",
			aliases: [],
			schema: {
				type: "function",
				function: {
					name: "read_file",
					description: "Read a file",
					parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
				},
			},
			capabilities: {
				concurrency: "parallel",
				sideEffects: "none",
				controlFlow: false,
				requiresApproval: true,
			},
			execute: async ({ task: executionTask, call, callbacks }) => {
				active += 1
				peak = Math.max(peak, active)
				await wait(1)
				try {
					await readFileTool.execute(call.nativeArgs as any, executionTask, callbacks)
				} finally {
					active -= 1
				}
			},
		})

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(
			response(
				...files.map((file, index) => ({
					id: `real-read-${index + 1}`,
					name: "read_file",
					arguments: { path: file },
				})),
			),
		)

		expect(peak).toBe(6)
		expect(outcome.results).toHaveLength(6)
		expect(outcome.results.every((result) => result.status === "success")).toBe(true)
		expect(outcome.approvalRequestCount).toBe(6)
		expect(outcome.supersededAskCount).toBe(0)
		expect(outcome.completedToolResultCount).toBe(6)
		expect(outcome.results.map((result) => (typeof result.content === "string" ? result.content : ""))).toEqual(
			files.map((file) => expect.stringContaining(`File: ${file}`)),
		)
	})

	it("isolates a denied read while approved sibling reads complete", async () => {
		const task = makeTask()
		let askIndex = 0
		task.ask = async () => ({ response: askIndex++ === 1 ? "noButtonClicked" : "yesButtonClicked" }) as any
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(
			descriptor("read_file", "parallel", async ({ callbacks }) => {
				if (await callbacks.askApproval("tool", "read file")) {
					callbacks.pushToolResult("file contents")
				}
			}),
		)

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(response({ id: "1", name: "read_file" }, { id: "2", name: "read_file" }, { id: "3", name: "read_file" }))

		expect(outcome.results.map((result) => result.status)).toEqual(["success", "denied", "success"])
		expect(outcome.approvalRequestCount).toBe(3)
		expect(outcome.approvalDeniedCount).toBe(1)
		expect(outcome.supersededAskCount).toBe(0)
		expect(resultIds(task)).toEqual(["1", "2", "3"])
	})

	it("turns a superseded approval into an explicit result instead of swallowing it", async () => {
		const task = makeTask()
		task.ask = async () => {
			throw new AskIgnoredError("superseded")
		}
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(
			descriptor("read_file", "parallel", async ({ callbacks }) => {
				if (await callbacks.askApproval("tool", "read file")) {
					callbacks.pushToolResult("unexpected")
				}
			}),
		)

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(response({ id: "superseded", name: "read_file" }))

		expect(outcome.supersededAskCount).toBe(1)
		expect(outcome.results[0].status).toBe("error")
		expect(outcome.results[0].content).toContain("superseded")
		expect(resultIds(task)).toEqual(["superseded"])
	})

	it("runs contiguous parallel tools concurrently and commits results in model order", async () => {
		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		let active = 0
		let peak = 0

		for (const [name, delay] of [
			["read_one", 30],
			["read_two", 5],
		] as const) {
			registry.register(
				descriptor(name, "parallel", async ({ callbacks }) => {
					active += 1
					peak = Math.max(peak, active)
					await wait(delay)
					callbacks.pushToolResult(name)
					active -= 1
				}),
			)
		}

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(response({ id: "1", name: "read_one" }, { id: "2", name: "read_two" }))

		expect(outcome.status).toBe("completed")
		expect(peak).toBe(2)
		expect(outcome.batchSize).toBe(2)
		expect(outcome.parallelBatchCount).toBe(1)
		expect(outcome.durationMs).toBeGreaterThanOrEqual(0)
		expect(resultIds(task)).toEqual(["1", "2"])
	})

	it("keeps serial tools from overlapping and stops parallel phases at a serial tool", async () => {
		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		let active = 0
		let peak = 0

		for (const [name, concurrency] of [
			["read", "parallel"],
			["command", "serial"],
			["read_after", "parallel"],
		] as const) {
			registry.register(
				descriptor(name, concurrency, async ({ callbacks }) => {
					active += 1
					peak = Math.max(peak, active)
					await wait(5)
					callbacks.pushToolResult(name)
					active -= 1
				}),
			)
		}

		await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(response({ id: "1", name: "read" }, { id: "2", name: "command" }, { id: "3", name: "read_after" }))

		expect(peak).toBe(1)
		expect(resultIds(task)).toEqual(["1", "2", "3"])
	})

	it("never overlaps two mutation calls", async () => {
		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		let active = 0
		let peak = 0

		for (const name of ["edit_one", "edit_two"]) {
			registry.register(
				descriptor(name, "serial", async ({ callbacks }) => {
					active += 1
					peak = Math.max(peak, active)
					await wait(5)
					callbacks.pushToolResult(name)
					active -= 1
				}),
			)
		}

		await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(response({ id: "1", name: "edit_one" }, { id: "2", name: "edit_two" }))

		expect(peak).toBe(1)
		expect(resultIds(task)).toEqual(["1", "2"])
	})

	it("isolates failures, deduplicates callbacks, and synthesizes empty output", async () => {
		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(
			descriptor("fails", "parallel", async ({ callbacks }) => {
				callbacks.pushToolResult("first")
				callbacks.pushToolResult("duplicate")
				throw new Error("boom")
			}),
		)
		registry.register(descriptor("empty", "parallel", async () => {}))

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(response({ id: "1", name: "fails" }, { id: "2", name: "empty" }))

		expect(outcome.results.map((result) => result.status)).toEqual(["error", "success"])
		expect(resultIds(task)).toEqual(["1", "2"])
		expect((task.userMessageContent as any[])[0].content).toBe("first")
		expect((task.userMessageContent as any[])[1].content).toBe("(tool did not return anything)")
	})

	it("executes a valid call when a later normalized call is malformed", async () => {
		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		let executed = 0
		registry.register(
			descriptor("read_one", "parallel", async ({ callbacks }) => {
				executed += 1
				callbacks.pushToolResult("valid")
			}),
		)
		registry.register(descriptor("read_two", "parallel", async () => void (executed += 100)))

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run({
			items: [
				{ type: "tool_call", id: "1", name: "read_one", arguments: {} },
				{ type: "error", message: "Unable to parse arguments", callId: "2", toolName: "read_two" },
			],
			text: "",
			reasoning: "",
			toolCalls: [{ type: "tool_call", id: "1", name: "read_one", arguments: {} }],
		})

		expect(executed).toBe(1)
		expect(outcome.results).toHaveLength(1)
		expect(outcome.batchSize).toBe(1)
		expect(resultIds(task)).toEqual(["1"])
	})

	it("serializes approval prompts while allowing approved sibling reads to run", async () => {
		const task = makeTask()
		let approvalsInFlight = 0
		let peakApprovals = 0
		task.ask = async () => {
			approvalsInFlight += 1
			peakApprovals = Math.max(peakApprovals, approvalsInFlight)
			await wait(5)
			approvalsInFlight -= 1
			return { response: "yesButtonClicked" } as any
		}

		const registry = new ToolRegistry({ includeBuiltIns: false })
		for (const name of ["read_one", "read_two"]) {
			registry.register(
				descriptor(name, "parallel", async ({ callbacks }) => {
					if (await callbacks.askApproval("tool", name)) {
						callbacks.pushToolResult(name)
					}
				}),
			)
		}

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(response({ id: "1", name: "read_one" }, { id: "2", name: "read_two" }))

		expect(outcome.status).toBe("completed")
		expect(peakApprovals).toBe(1)
		expect(resultIds(task)).toEqual(["1", "2"])
	})

	it("rejects mixed barrier batches without executing any call", async () => {
		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		let executions = 0
		registry.register(descriptor("read", "parallel", async () => void (executions += 1)))
		registry.register(descriptor("complete", "barrier", async () => void (executions += 1)))

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(response({ id: "1", name: "read" }, { id: "2", name: "complete" }))

		expect(executions).toBe(0)
		expect(outcome.results).toHaveLength(2)
		expect(resultIds(task)).toEqual(["1", "2"])
	})

	it("does not commit results after cancellation", async () => {
		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(
			descriptor("read", "parallel", async ({ callbacks }) => {
				await wait(20)
				callbacks.pushToolResult("late")
			}),
		)

		const run = new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(response({ id: "1", name: "read" }))
		setTimeout(() => {
			task.abort = true
		}, 5)

		const outcome = await run
		expect(outcome.status).toBe("aborted")
		expect(resultIds(task)).toEqual([])
	})

	it("enforces policy visibility and bounds tool output", async () => {
		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		let executions = 0
		registry.register({
			...descriptor("read", "parallel", async ({ callbacks }) => {
				executions += 1
				callbacks.pushToolResult("0123456789abcdefghijklmnopqrstuvwxyz")
			}),
			maxOutputChars: 100,
		})

		const policy = {
			visibleTools: ["read"],
			allowedTools: ["read"],
			disabledTools: [],
			approval: { autoApprovalEnabled: false, liveRevalidation: true },
			capabilities: {},
			outputLimits: { read: 16 },
			execution: {
				sandboxMode: "workspace-write",
				workspaceRoots: [],
				command: { allowedPrefixes: [], deniedPrefixes: [], userTimeoutMs: 0, timeoutAllowlist: [] },
				cancellation: "abort-process",
			},
			summary: "Sandbox: workspace-write",
			digest: "policy",
		} as const
		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
			policy,
		}).run(response({ id: "1", name: "read" }))

		expect(executions).toBe(1)
		expect(outcome.outputTruncatedCount).toBe(1)
		expect(outcome.results[0].truncated).toBe(true)
		expect(String((task.userMessageContent as any[])[0].content)).toContain("truncated")

		const hiddenTask = makeTask()
		const hiddenOutcome = await new ToolScheduler({
			task: hiddenTask,
			registry,
			mode: "code",
			validateCall: () => {},
			policy: { ...policy, visibleTools: [], allowedTools: [] },
		}).run(response({ id: "2", name: "read" }))

		expect(hiddenOutcome.results[0].status).toBe("error")
		expect(String((hiddenTask.userMessageContent as any[])[0].content)).toContain("not allowed")
	})

	it("passes the cancellation signal into active tool execution", async () => {
		const task = makeTask()
		const controller = new AbortController()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(
			descriptor("read", "parallel", async ({ callbacks, signal }) => {
				await wait(10)
				expect(signal?.aborted).toBe(true)
				callbacks.pushToolResult("cancelled")
			}),
		)

		const run = new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
			signal: controller.signal,
		}).run(response({ id: "1", name: "read" }))
		setTimeout(() => controller.abort(), 2)

		const outcome = await run
		expect(outcome.status).toBe("aborted")
		expect(resultIds(task)).toEqual([])
	})
})
