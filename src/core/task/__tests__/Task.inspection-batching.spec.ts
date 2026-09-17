import fs from "fs/promises"
import os from "os"
import path from "path"

import { AgentTurnEngine, type AgentTurnHost } from "../../agent/AgentTurnEngine"
import { ToolScheduler, type ToolExecutionHost } from "../../agent/ToolScheduler"
import { getTrustedCommandExploration } from "../../tools/CommandExploration"
import { ToolRegistry } from "../../tools/ToolRegistry"
import { ToolRepetitionDetector } from "../../tools/ToolRepetitionDetector"
import { Task } from "../Task"

// Same successful inspections and stable evidence. Only the scripted provider's
// calls per response differ; this measures request counts, not live-model behavior.
const commands = [
	...Array.from({ length: 4 }, (_, index) => `git show HEAD:src/file-${index}.ts`),
	...Array.from({ length: 8 }, (_, index) => `rg -n symbol${index} src`),
]

describe("inspection batches through the turn engine, scheduler and Task", () => {
	let workspace: string

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-inspection-batching-"))
		workspace = await fs.realpath(workspace)
		await fs.mkdir(path.join(workspace, "src"))
	})

	afterEach(async () => {
		await fs.rm(workspace, { recursive: true, force: true })
	})

	it.each([1, 4])("completes the same investigation with %i calls per model response", async (batchSize) => {
		let stopped = false
		let active = 0
		let peakActive = 0
		const task = Object.assign(Object.create(Task.prototype), {
			workspacePath: workspace,
			taskCancellationController: new AbortController(),
			pendingCommandVerification: Promise.resolve(),
			commandExecutionEvidence: new Map(),
			toolRepetitionDetector: new ToolRepetitionDetector(3, { noProgressLimit: 2 }),
			userMessageContent: [],
			providerRef: {
				deref: () => ({
					getVerificationProgressState: () => ({
						stateFingerprint: "unchanged-workspace",
						evidenceFingerprint: "unchanged-verification",
					}),
				}),
			},
			suspendAfterCurrentTurn: () => {
				stopped = true
			},
		}) as Task
		const executed: string[] = []
		const host: ToolExecutionHost = {
			taskId: "inspection-batching",
			cwd: workspace,
			userMessageContent: [],
			say: async () => {},
			recordToolUsage: () => {},
			askApproval: vi.fn(async () => ({ response: "yesButtonClicked" as const })),
			recordToolCallForStopping: task.recordToolCallForStopping.bind(task),
			shouldStopRepeatedToolCall: () => stopped,
			pushToolResultToUserContent(result) {
				if (
					host.userMessageContent.some(
						(item) => item.type === "tool_result" && item.tool_use_id === result.tool_use_id,
					)
				)
					return false
				host.userMessageContent.push(result)
				return true
			},
		}
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register({
			name: "execute_command",
			aliases: [],
			schema: { type: "function", function: { name: "execute_command", parameters: { type: "object" } } },
			capabilities: {
				concurrency: "serial",
				sideEffects: "workspace",
				controlFlow: false,
				requiresApproval: true,
			},
			execute: async ({ call, callbacks }) => {
				const args = call.nativeArgs
				if (!args || !("command" in args) || typeof args.command !== "string") {
					throw new Error("Inspection fixture requires a command")
				}
				const command = args.command
				active++
				peakActive = Math.max(peakActive, active)
				try {
					if (!(await callbacks.askApproval("command", command))) return
					executed.push(command)
					const trustedExploration = await getTrustedCommandExploration({
						command,
						workspaceRoot: workspace,
						cwd: workspace,
						executionStatus: "succeeded",
						exitCode: 0,
					})
					expect(trustedExploration).toBeDefined()
					callbacks.setResultMetadata?.({
						status: "success",
						executionStatus: "success",
						exitCode: 0,
						trustedExploration,
					})
					callbacks.pushToolResult("fixture inspection result")
				} finally {
					active--
				}
			},
		})
		const turnHost: AgentTurnHost<number> = {
			shouldAbort: () => false,
			runStep: vi.fn(async (offset) => {
				if (offset === commands.length) {
					return {
						response: { items: [], toolCalls: [], text: "Review complete.", reasoning: "" },
						nextInput: "complete" as const,
					}
				}
				const calls = commands.slice(offset, offset + batchSize).map((command, index) => ({
					type: "tool_call" as const,
					id: `inspection-${offset + index}`,
					name: "execute_command",
					arguments: { command },
				}))
				const outcome = await new ToolScheduler({
					executionHost: host,
					registry,
					mode: "code",
					executionMode: "selective-parallel",
				}).run(calls)
				expect(outcome.results.filter(({ status }) => status !== "success")).toEqual([])
				expect(stopped).toBe(false)
				return {
					response: { items: calls, toolCalls: calls, text: "", reasoning: "" },
					nextInput: offset + calls.length,
				}
			}),
		}
		const outcome = await new AgentTurnEngine(turnHost).run(0)
		if (outcome.status === "failed") throw outcome.error ?? new Error(outcome.reason)
		expect(outcome).toMatchObject({ status: "completed", steps: commands.length / batchSize + 1 })
		expect(executed).toEqual(commands)
		expect(host.askApproval).toHaveBeenCalledTimes(commands.length)
		expect(peakActive).toBe(1)
		expect(host.userMessageContent.map((item) => item.type === "tool_result" && item.tool_use_id)).toEqual(
			commands.map((_, index) => `inspection-${index}`),
		)
		expect(task.userMessageContent).toEqual([])

		// Cosmetic changes to the same successful search still exhaust recovery.
		for (const decoration of ["--line-number", "--no-heading", "--color never", "-H"]) {
			const command = `rg ${decoration} symbol0 src`
			const trustedExploration = await getTrustedCommandExploration({
				command,
				workspaceRoot: workspace,
				cwd: workspace,
				executionStatus: "succeeded",
				exitCode: 0,
			})
			await task.recordToolCallForStopping("execute_command", { command }, "success", "read", {
				callId: decoration,
				name: "execute_command",
				status: "success",
				executionStatus: "success",
				exitCode: 0,
				content: "fixture inspection result",
				durationMs: 0,
				trustedExploration,
			})
		}
		expect(stopped).toBe(true)
		expect(task.userMessageContent).toHaveLength(1)
	})
})
