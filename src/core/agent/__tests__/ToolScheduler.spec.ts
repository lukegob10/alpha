import * as fs from "fs/promises"
import * as path from "path"
import { tmpdir } from "os"
import { describe, expect, it, vi } from "vitest"

import type { Task } from "../../task/Task"
import { AskIgnoredError } from "../../task/AskIgnoredError"
import { formatResponse } from "../../prompts/responses"
import { ApplyPatchTool } from "../../tools/ApplyPatchTool"
import { readFileTool } from "../../tools/ReadFileTool"
import { ToolReadDeniedError } from "../../tools/BaseTool"
import { ToolRegistry, type ToolDescriptor } from "../../tools/ToolRegistry"
import { useMcpToolTool } from "../../tools/UseMcpToolTool"
import { collectAgentResponse } from "../AgentResponseAccumulator"
import { AgentTurnEventLog, readAgentTurnEvents } from "../AgentTurnEventLog"
import type { AgentTurnEvent } from "../AgentTurnEvents"
import { ToolScheduler } from "../ToolScheduler"
import { createToolPolicySnapshot } from "../ToolPolicy"

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
		getConcurrencyScope: (call) => path.resolve(tmpdir(), "scheduler-fixture", call.id ?? name),
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
	it("commits MCP validation failures as error receipts in provider history", async () => {
		const task = makeTask()
		Object.assign(task, {
			consecutiveMistakeCount: 0,
			recordToolError: () => {},
			lastMessageTs: 1,
			providerRef: {
				deref: () => ({ getMcpHub: () => undefined, postMessageToWebview: async () => {} }),
			},
		})
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(
			descriptor("use_mcp_tool", "serial", async ({ task: executionTask, call, callbacks }) => {
				await useMcpToolTool.execute(call.nativeArgs as any, executionTask, callbacks)
			}),
		)

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(
			response({
				id: "mcp-missing-hub",
				name: "use_mcp_tool",
				arguments: { server_name: "missing", tool_name: "lookup" },
			}),
		)

		expect(outcome.results[0].status).toBe("error")
		expect(task.userMessageContent).toContainEqual(
			expect.objectContaining({ type: "tool_result", tool_use_id: "mcp-missing-hub", is_error: true }),
		)
	})

	it("keeps MCP cancellation authoritative in scheduler status and provider history", async () => {
		const task = makeTask()
		const controller = new AbortController()
		const statuses: string[] = []
		let requestStarted!: () => void
		const started = new Promise<void>((resolve) => {
			requestStarted = resolve
		})
		Object.assign(task, {
			consecutiveMistakeCount: 0,
			recordToolError: () => {},
			lastMessageTs: 1,
			providerRef: {
				deref: () => ({
					getMcpHub: () => ({
						getAllServers: () => [{ name: "server", tools: [{ name: "lookup", description: "lookup" }] }],
						callTool: (...args: unknown[]) => {
							const signal = args[4] as AbortSignal
							requestStarted()
							return new Promise<never>((_, reject) => {
								signal.addEventListener("abort", () => reject(signal.reason), { once: true })
							})
						},
					}),
					postMessageToWebview: async (message: { text?: string }) => {
						if (message.text) statuses.push(JSON.parse(message.text).status)
					},
				}),
			},
		})
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(
			descriptor("use_mcp_tool", "serial", async ({ task: executionTask, call, callbacks }) => {
				await useMcpToolTool.execute(call.nativeArgs as any, executionTask, callbacks)
			}),
		)
		const run = new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
			signal: controller.signal,
			preserveAbortedResults: true,
		}).run(
			response({
				id: "mcp-cancelled",
				name: "use_mcp_tool",
				arguments: { server_name: "server", tool_name: "lookup" },
			}),
		)

		await started
		controller.abort(new Error("cancelled"))
		const outcome = await run
		expect(outcome.results[0].status).toBe("cancelled")
		expect(statuses).toEqual(["started", "error"])
		expect(task.userMessageContent).toContainEqual(
			expect.objectContaining({ type: "tool_result", tool_use_id: "mcp-cancelled", is_error: true }),
		)
	})

	it("publishes an invalid read_command_output artifact as an error history receipt", async () => {
		const task = makeTask() as any
		task.consecutiveMistakeCount = 0
		task.recordToolError = vi.fn()
		task.say = vi.fn().mockResolvedValue(undefined)
		task.providerRef = { deref: vi.fn() }
		const outcome = await new ToolScheduler({
			task,
			registry: new ToolRegistry(),
			mode: "code",
			validateCall: () => {},
			policy: createToolPolicySnapshot({ visibleTools: ["read_command_output"] }),
		}).run(
			response({
				id: "invalid-artifact",
				name: "read_command_output",
				arguments: { artifact_id: "../../secret.txt" },
			}),
		)

		expect(outcome.results).toHaveLength(1)
		expect(outcome.results[0]).toMatchObject({ name: "read_command_output", status: "error" })
		expect(task.didToolFailInCurrentTurn).toBe(true)
		expect(task.userMessageContent).toContainEqual(
			expect.objectContaining({ tool_use_id: "invalid-artifact", is_error: true }),
		)
	})

	it("retains earlier truthful receipts when a later read preflight rejects", async () => {
		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		const effects: string[] = []
		registry.register(
			descriptor("mutation", "serial", async ({ callbacks }) => {
				effects.push("mutation")
				callbacks.pushToolResult("already completed")
			}),
		)
		registry.register({
			...descriptor("read", "parallel", async () => {
				effects.push("unexpected")
			}),
			prepareParallelRead: async () => {
				throw new Error("state unavailable")
			},
		})
		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
			executionMode: "selective-parallel",
			policy: createToolPolicySnapshot({ visibleTools: ["mutation", "read"] }),
			readGrant: { enabled: true, workspaceRoot: tmpdir(), showIgnoredFiles: false },
		}).run(response({ id: "one", name: "mutation" }, { id: "two", name: "read" }))
		expect(effects).toEqual(["mutation"])
		expect(outcome.results.map(({ status, content }) => [status, content])).toEqual([
			["success", "already completed"],
			["error", expect.stringContaining("state unavailable")],
		])
		expect(resultIds(task)).toEqual(["one", "two"])
	})

	it("serializes overlapping and unknown scopes even when metadata claims parallel safety", async () => {
		for (const scope of [undefined, path.resolve(tmpdir(), "shared-scope")]) {
			const task = makeTask()
			const registry = new ToolRegistry({ includeBuiltIns: false })
			let active = 0
			let peak = 0
			registry.register({
				...descriptor("read", "parallel", async ({ callbacks }) => {
					active++
					peak = Math.max(peak, active)
					await Promise.resolve()
					callbacks.pushToolResult("read")
					active--
				}),
				getConcurrencyScope: () => scope,
			})
			await new ToolScheduler({
				task,
				registry,
				mode: "code",
				executionMode: "selective-parallel",
				validateCall: () => {},
			}).run(response({ id: "one", name: "read" }, { id: "two", name: "read" }))
			expect(peak).toBe(1)
		}
	})

	it.each([
		[
			"a serial descriptor",
			{
				concurrency: "serial" as const,
				sideEffects: "none" as const,
				controlFlow: false,
				requiresApproval: true,
			},
			undefined,
		],
		[
			"a captured serial policy",
			{
				concurrency: "parallel" as const,
				sideEffects: "none" as const,
				controlFlow: false,
				requiresApproval: true,
			},
			{
				concurrency: "serial" as const,
				sideEffects: "none" as const,
				controlFlow: false,
				requiresApproval: true,
			},
		],
	] as const)(
		"does not bypass %s with an audited parallel-read executor",
		async (_description, capabilities, policyCapabilities) => {
			const task = makeTask()
			const registry = new ToolRegistry({ includeBuiltIns: false })
			const execute = vi.fn(async ({ callbacks }: Parameters<ToolDescriptor["execute"]>[0]) => {
				callbacks.pushToolResult("legacy")
			})
			const prepareParallelRead = vi.fn(async () => ({
				scope: path.resolve(tmpdir(), "audited-read"),
				run: async () => async () => "prepared",
			}))
			registry.register({
				...descriptor("read", "parallel", execute),
				capabilities,
				prepareParallelRead,
			})
			const outcome = await new ToolScheduler({
				task,
				registry,
				mode: "code",
				executionMode: "selective-parallel",
				validateCall: () => {},
				policy: createToolPolicySnapshot({
					visibleTools: ["read"],
					autoApprovalEnabled: true,
					capabilities: policyCapabilities ? { read: policyCapabilities } : undefined,
				}),
				readGrant: { enabled: true, workspaceRoot: tmpdir(), showIgnoredFiles: false },
			}).run(response({ id: "read", name: "read" }))

			expect(prepareParallelRead).not.toHaveBeenCalled()
			expect(execute).toHaveBeenCalledOnce()
			expect(outcome.results[0]).toMatchObject({ status: "success", content: "legacy" })
		},
	)

	it("closes a lifecycle-rejected workspace mutation as denied", async () => {
		const task = makeTask()
		Object.assign(task, { canMutateWorkspace: () => false, providerRef: { deref: () => undefined } })
		const outcome = await new ToolScheduler({
			task,
			registry: new ToolRegistry(),
			mode: "code",
			validateCall: () => {},
			policy: createToolPolicySnapshot({ visibleTools: ["write_to_file"] }),
		}).run(
			response({
				id: "late-write",
				name: "write_to_file",
				arguments: { path: "fixture.txt", content: "must not write" },
			}),
		)

		expect(outcome.results[0].status).toBe("denied")
		expect(JSON.parse(String(outcome.results[0].content))).toMatchObject({ status: "denied" })
		expect(resultIds(task)).toEqual(["late-write"])
	})

	it.each([
		{ id: 42, name: "read" },
		{ id: "malformed-name", name: 42 },
	] as const)("turns malformed runtime call fields into one terminal error", async (call) => {
		const task = makeTask()
		const execute = vi.fn(async ({ callbacks }: Parameters<ToolDescriptor["execute"]>[0]) => {
			callbacks.pushToolResult("must not execute")
		})
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(descriptor("read", "serial", execute))
		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run([call as never])

		expect(outcome.results[0].status).toBe("error")
		expect(execute).not.toHaveBeenCalled()
		expect(resultIds(task)).toHaveLength(1)
	})

	it.each([
		["read_file", { path: "inside.txt", files: [{ path: "../outside.txt" }] }],
		["search_files", { queries: [{ path: "../outside", regex: "secret" }] }],
		["generate_image", { prompt: "fixture", path: "inside.png", image: "../outside.png" }],
	] as const)("rejects an out-of-policy nested path in %s before dispatch", async (name, argumentsValue) => {
		const task = makeTask()
		const execute = vi.fn(async ({ callbacks }: Parameters<ToolDescriptor["execute"]>[0]) => {
			callbacks.pushToolResult("must not execute")
		})
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(descriptor(name, "serial", execute))
		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
			policy: createToolPolicySnapshot({
				visibleTools: [name],
				execution: { workspaceRoots: [process.cwd()] },
			}),
		}).run(response({ id: `nested-${name}`, name, arguments: argumentsValue }))

		expect(outcome.results[0].status).toBe("error")
		expect(String(outcome.results[0].content)).toContain("outside the allowed workspace roots")
		expect(execute).not.toHaveBeenCalled()
	})

	it("rejects an unexpected approval without entering Task.ask from a parallel worker", async () => {
		const task = makeTask()
		const ask = vi.spyOn(task, "ask")
		const registry = new ToolRegistry({ includeBuiltIns: false })
		let effects = 0
		registry.register(
			descriptor("read", "parallel", async ({ callbacks }) => {
				if (await callbacks.askApproval("tool", "unexpected")) effects++
			}),
		)
		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			executionMode: "selective-parallel",
			validateCall: () => {},
		}).run(response({ id: "one", name: "read" }, { id: "two", name: "read" }))
		expect(outcome.results.map((result) => result.status)).toEqual(["denied", "denied"])
		expect(outcome.results.map((result) => JSON.parse(String(result.content)).status)).toEqual(["denied", "denied"])
		expect(ask).not.toHaveBeenCalled()
		expect(effects).toBe(0)
	})

	it.each(["prepare", "run", "finalize"] as const)(
		"publishes a denied receipt when read %s revokes approval",
		async (phase) => {
			const task = makeTask()
			const registry = new ToolRegistry({ includeBuiltIns: false })
			const deny = (): never => {
				throw new ToolReadDeniedError("Captured read approval was revoked.")
			}
			const execute = vi.fn(async () => {})
			registry.register({
				...descriptor("read", "parallel", execute),
				prepareParallelRead: async () => {
					if (phase === "prepare") deny()
					return {
						scope: path.resolve(tmpdir(), "denied-read"),
						run: async () => {
							if (phase === "run") deny()
							return async () => deny()
						},
					}
				},
			})
			const outcome = await new ToolScheduler({
				task,
				registry,
				mode: "code",
				executionMode: "selective-parallel",
				validateCall: () => {},
				policy: createToolPolicySnapshot({ visibleTools: ["read"], autoApprovalEnabled: true }),
				readGrant: { enabled: true, workspaceRoot: tmpdir(), showIgnoredFiles: false },
			}).run(response({ id: "revoked", name: "read" }))

			expect(execute).not.toHaveBeenCalled()
			expect(outcome.results[0].status).toBe("denied")
			const published = task.userMessageContent.filter((item) => item.type === "tool_result")
			expect(published).toHaveLength(1)
			expect(published[0]).toMatchObject({ tool_use_id: "revoked", is_error: true })
			expect(JSON.parse(String(published[0].content))).toMatchObject({
				status: "denied",
				message: expect.stringContaining("Captured read approval was revoked."),
			})
		},
	)

	it("rechecks cancellation after an awaited durability fence before dispatch", async () => {
		const task = makeTask()
		const controller = new AbortController()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		const execute = vi.fn(async () => {})
		registry.register(descriptor("read", "serial", execute))
		let release!: () => void
		let entered!: () => void
		const atFence = new Promise<void>((resolve) => {
			entered = resolve
		})
		const fence = new Promise<void>((resolve) => {
			release = resolve
		})
		const run = new ToolScheduler({
			task,
			registry,
			mode: "code",
			signal: controller.signal,
			preserveAbortedResults: true,
			validateCall: () => {},
			beforeEffect: async () => {
				entered()
				await fence
			},
		}).run(response({ id: "one", name: "read" }))
		await atFence
		controller.abort()
		release()
		expect((await run).results[0].status).toBe("cancelled")
		expect(execute).not.toHaveBeenCalled()
		expect(resultIds(task)).toEqual(["one"])
	})

	it("drains an ignored-signal worker after a sibling fence failure and prevents queued effects", async () => {
		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		let release!: () => void
		let firstStarted!: () => void
		let fenceFailed!: () => void
		const started = new Promise<void>((resolve) => {
			firstStarted = resolve
		})
		const failed = new Promise<void>((resolve) => {
			fenceFailed = resolve
		})
		const pending = new Promise<void>((resolve) => {
			release = resolve
		})
		const effects: string[] = []
		let firstSignal: AbortSignal | undefined
		registry.register(
			descriptor("read", "parallel", async ({ call, callbacks, signal }) => {
				effects.push(call.id!)
				firstSignal = signal
				firstStarted()
				await pending
				callbacks.pushToolResult("joined")
			}),
		)
		let finished = false
		const run = new ToolScheduler({
			task,
			registry,
			mode: "code",
			executionMode: "selective-parallel",
			maxConcurrency: 3,
			validateCall: () => {},
			beforeEffect: async (call) => {
				if (call.id === "two") {
					await started
					fenceFailed()
					throw new Error("fence failed")
				}
			},
		})
			.run(response({ id: "one", name: "read" }, { id: "two", name: "read" }, { id: "three", name: "read" }))
			.then((outcome) => {
				finished = true
				return outcome
			})
		await failed
		await Promise.resolve()
		expect(finished).toBe(false)
		expect(firstSignal?.aborted).toBe(true)
		release()
		const outcome = await run
		expect(effects).toEqual(["one"])
		expect(outcome.status).toBe("failed")
		expect(outcome.results.map((result) => result.status)).toEqual(["success", "error", "error"])
		expect(resultIds(task)).toEqual(["one", "two", "three"])
	})

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
		expect(
			cancelledTask.userMessageContent
				.filter((item) => item.type === "tool_result")
				.map((item) => JSON.parse(String(item.content)).status),
		).toEqual(["cancelled"])
	})

	it("preserves structured approval payloads without replacing the tool result", async () => {
		const task = makeTask()
		task.ask = async () =>
			({
				response: "objectResponse",
				text: JSON.stringify({ "first.ts": true, "second.ts": false }),
			}) as any
		const events: AgentTurnEvent[] = []
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(
			descriptor("read_file", "serial", async ({ callbacks }) => {
				const approval = await callbacks.askApprovalResponse?.("tool", "batch")
				callbacks.pushToolResult(JSON.stringify(approval))
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
		}).run(response({ id: "batch-read", name: "read_file" }))

		expect(outcome.results[0]).toMatchObject({ status: "denied" })
		expect(JSON.parse(String(outcome.results[0].content))).toEqual({
			response: "objectResponse",
			text: JSON.stringify({ "first.ts": true, "second.ts": false }),
		})
		expect(outcome.approvalRequestCount).toBe(1)
		expect(outcome.approvalDeniedCount).toBe(1)
		expect(events).toContainEqual(expect.objectContaining({ type: "approval_result", decision: "denied" }))
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
			executionMode: "selective-parallel",
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
		let releaseHandlers!: () => void
		const allHandlersStarted = new Promise<void>((resolve) => {
			releaseHandlers = resolve
		})
		registry.register(
			descriptor("read_file", "parallel", async ({ call, callbacks }) => {
				active += 1
				peak = Math.max(peak, active)
				if (active === 6) releaseHandlers()
				await allHandlersStarted
				callbacks.pushToolResult(`content-${call.id}`)
				active -= 1
			}),
		)

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			executionMode: "selective-parallel",
			maxConcurrency: 6,
			validateCall: () => {},
		}).run(normalized)

		expect(normalized.toolCalls).toHaveLength(6)
		expect(outcome.batchSize).toBe(6)
		expect(outcome.parallelBatchCount).toBe(1)
		expect(outcome.parallelToolCount).toBe(6)
		expect(peak).toBe(6)
		expect(outcome.approvalRequestCount).toBe(0)
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

	it("serializes real read_file handlers when approval metadata is required", async () => {
		const task = makeTask()
		const workspaceRoot = path.resolve(__dirname, "../../../..")
		Object.assign(task, {
			cwd: workspaceRoot,
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
			executionMode: "selective-parallel",
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

		expect(peak).toBe(1)
		expect(outcome.parallelBatchCount).toBe(0)
		expect(outcome.parallelToolCount).toBe(0)
		expect(outcome.results).toHaveLength(6)
		expect(outcome.results.every((result) => result.status === "success")).toBe(true)
		// ReadFileTool routes interactive prompts through the scheduler-owned mutex.
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
			executionMode: "selective-parallel",
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
		expect(outcome.results).toHaveLength(1)
		expect(outcome.results[0].status).toBe("cancelled")
		expect(resultIds(task)).toEqual([])
	})

	it("publishes cancelled running and pending receipts without changing earlier completed receipts", async () => {
		const task = makeTask()
		const controller = new AbortController()
		const events: AgentTurnEvent[] = []
		const executions: string[] = []
		let release!: () => void
		const pending = new Promise<void>((resolve) => {
			release = resolve
		})
		let markStarted!: () => void
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		const completedContent = JSON.stringify({ status: "success", message: "Durably completed earlier effect." })
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(
			descriptor("mutation", "serial", async ({ callbacks }) => {
				callbacks.pushToolResult(completedContent)
			}),
		)
		registry.register(
			descriptor("read", "parallel", async ({ call, callbacks }) => {
				executions.push(call.id!)
				if (executions.length === 2) markStarted()
				await pending
				callbacks.pushToolResult(JSON.stringify({ status: "success", message: "Late read result." }))
			}),
		)
		const run = new ToolScheduler({
			task,
			registry,
			mode: "code",
			executionMode: "selective-parallel",
			maxConcurrency: 2,
			validateCall: () => {},
			signal: controller.signal,
			preserveAbortedResults: true,
			onEvent: (event) => {
				events.push(event)
			},
		}).run(
			response(
				{ id: "completed", name: "mutation" },
				{ id: "running-a", name: "read" },
				{ id: "running-b", name: "read" },
				{ id: "pending", name: "read" },
			),
		)

		await started
		controller.abort()
		release()
		const outcome = await run
		const statuses = ["success", "cancelled", "cancelled", "cancelled"]
		const published = task.userMessageContent.filter((item) => item.type === "tool_result")
		expect(outcome.status).toBe("aborted")
		expect(executions).toEqual(["running-a", "running-b"])
		expect(outcome.results.map((result) => result.status)).toEqual(statuses)
		expect(outcome.results.map((result) => JSON.parse(String(result.content)).status)).toEqual(statuses)
		expect(published.map((result) => JSON.parse(String(result.content)).status)).toEqual(statuses)
		expect(published.map((result) => result.is_error)).toEqual([false, true, true, true])
		expect(resultIds(task)).toEqual(["completed", "running-a", "running-b", "pending"])
		expect(published[0].content).toBe(completedContent)
		expect(events.filter((event) => event.type === "tool_result").map((event) => event.status)).toEqual(statuses)
	})

	it("preserves deterministic receipts for every call when cancellation wins", async () => {
		const task = makeTask()
		const controller = new AbortController()
		const events: any[] = []
		let executions = 0
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(
			descriptor("read", "serial", async ({ callbacks }) => {
				executions += 1
				await wait(10)
				callbacks.pushToolResult("late")
			}),
		)

		const run = new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
			signal: controller.signal,
			preserveAbortedResults: true,
			onEvent: (event) => {
				events.push(event)
			},
		}).run(response({ id: "1", name: "read" }, { id: "2", name: "read" }))
		setTimeout(() => controller.abort(), 2)

		const outcome = await run
		expect(outcome.status).toBe("aborted")
		expect(executions).toBe(1)
		expect(outcome.results.map((result) => result.status)).toEqual(["cancelled", "cancelled"])
		expect(resultIds(task)).toEqual(["1", "2"])
		expect(task.userMessageContentReady).toBe(true)
		expect(events.filter((event) => event.type === "tool_result").map((event) => event.callId)).toEqual(["1", "2"])
	})

	it("fails closed when the transcript fence rejects before an effect", async () => {
		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		let executions = 0
		registry.register(
			descriptor("mutation", "serial", async ({ callbacks }) => {
				executions += 1
				callbacks.pushToolResult("must not run")
			}),
		)

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
			beforeEffect: async () => {
				throw new Error("provider transcript receipt is stale")
			},
		}).run(response({ id: "stale", name: "mutation" }, { id: "unstarted", name: "mutation" }))

		expect(outcome.status).toBe("failed")
		expect(outcome.failure).toEqual({
			kind: "effect_fence",
			callId: "stale",
			message: "provider transcript receipt is stale",
		})
		expect(outcome.results.map((result) => result.status)).toEqual(["error", "error"])
		expect(executions).toBe(0)
		expect(resultIds(task)).toEqual(["stale", "unstarted"])
		expect(task.userMessageContentReady).toBe(true)
	})

	it("preserves completed effects when a later transcript fence rejects", async () => {
		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		let executions = 0
		let fenceChecks = 0
		registry.register(
			descriptor("mutation", "serial", async ({ callbacks }) => {
				executions += 1
				callbacks.pushToolResult(`completed-${executions}`)
			}),
		)

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
			beforeEffect: async () => {
				fenceChecks += 1
				if (fenceChecks === 2) throw new Error("receipt invalidated after first effect")
			},
		}).run(
			response(
				{ id: "completed", name: "mutation" },
				{ id: "blocked", name: "mutation" },
				{ id: "unstarted", name: "mutation" },
			),
		)

		expect(outcome.status).toBe("failed")
		expect(outcome.failure).toEqual({
			kind: "effect_fence",
			callId: "blocked",
			message: "receipt invalidated after first effect",
		})
		expect(executions).toBe(1)
		expect(outcome.results.map((result) => result.status)).toEqual(["success", "error", "error"])
		expect(outcome.results[0].content).toBe("completed-1")
		expect(resultIds(task)).toEqual(["completed", "blocked", "unstarted"])
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

	it("defaults to serial execution even when descriptors are parallel-safe", async () => {
		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		let active = 0
		let peak = 0
		for (const name of ["first", "second"]) {
			registry.register(
				descriptor(name, "parallel", async ({ callbacks }) => {
					active += 1
					peak = Math.max(peak, active)
					await wait(2)
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
		}).run(response({ id: "1", name: "first" }, { id: "2", name: "second" }))

		expect(peak).toBe(1)
		expect(outcome.parallelBatchCount).toBe(0)
		expect(outcome.parallelToolCount).toBe(0)
		expect(resultIds(task)).toEqual(["1", "2"])
	})

	it("bounds selective-parallel windows and keeps completion commits in model order", async () => {
		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		let active = 0
		let peak = 0
		for (let index = 0; index < 7; index += 1) {
			const name = `read-${index}`
			registry.register(
				descriptor(name, "parallel", async ({ callbacks }) => {
					active += 1
					peak = Math.max(peak, active)
					await wait(index % 2 === 0 ? 5 : 1)
					callbacks.pushToolResult(name)
					active -= 1
				}),
			)
		}

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			executionMode: "selective-parallel",
			maxConcurrency: 3,
			validateCall: () => {},
		}).run(response(...Array.from({ length: 7 }, (_, index) => ({ id: `${index}`, name: `read-${index}` }))))

		expect(peak).toBeLessThanOrEqual(3)
		expect(peak).toBeGreaterThan(1)
		expect(outcome.parallelBatchCount).toBe(3)
		expect(outcome.parallelToolCount).toBe(7)
		expect(resultIds(task)).toEqual(["0", "1", "2", "3", "4", "5", "6"])
		expect((task.userMessageContent as any[]).map((item) => item.content)).toEqual([
			"read-0",
			"read-1",
			"read-2",
			"read-3",
			"read-4",
			"read-5",
			"read-6",
		])
	})

	it("keeps a side-effecting descriptor serial even if it is incorrectly marked parallel", async () => {
		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		let active = 0
		let peak = 0
		for (const name of ["mutation-one", "mutation-two"]) {
			registry.register({
				...descriptor(name, "parallel", async ({ callbacks }) => {
					active += 1
					peak = Math.max(peak, active)
					await wait(2)
					callbacks.pushToolResult(name)
					active -= 1
				}),
				capabilities: {
					concurrency: "parallel",
					sideEffects: "workspace",
					controlFlow: false,
					requiresApproval: false,
				},
			})
		}

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			executionMode: "selective-parallel",
			validateCall: () => {},
		}).run(response({ id: "1", name: "mutation-one" }, { id: "2", name: "mutation-two" }))

		expect(peak).toBe(1)
		expect(outcome.parallelBatchCount).toBe(0)
		expect(resultIds(task)).toEqual(["1", "2"])
	})

	it("accepts a narrow execution host without requiring a concrete Task", async () => {
		const userMessageContent: any[] = []
		const host = {
			taskId: "host-only",
			cwd: process.cwd(),
			abort: false,
			userMessageContent,
			say: async () => {},
			recordToolUsage: () => {},
			pushToolResultToUserContent(result: any) {
				userMessageContent.push(result)
				return true
			},
		}
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(descriptor("host_read", "serial", async ({ callbacks }) => callbacks.pushToolResult("ok")))

		const outcome = await new ToolScheduler({
			executionHost: host,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(response({ id: "host-call", name: "host_read" }))

		expect(outcome.status).toBe("completed")
		expect(outcome.results[0].content).toBe("ok")
		expect(userMessageContent.map((item) => item.tool_use_id)).toEqual(["host-call"])
	})

	it("releases an approval lane when cancellation arrives before the host responds", async () => {
		const task = makeTask()
		task.ask = async () => await new Promise<never>(() => {})
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(
			descriptor("approval_read", "parallel", async ({ callbacks }) => {
				if (await callbacks.askApproval("tool", "waiting")) {
					callbacks.pushToolResult("unexpected")
				}
			}),
		)
		const controller = new AbortController()
		const run = new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
			signal: controller.signal,
		}).run(response({ id: "approval-cancel", name: "approval_read" }))
		setTimeout(() => controller.abort(), 2)

		const outcome = await run
		expect(outcome.status).toBe("aborted")
		expect(outcome.results).toHaveLength(1)
		expect(outcome.results[0].status).toBe("cancelled")
		expect(resultIds(task)).toEqual([])
	})
})
