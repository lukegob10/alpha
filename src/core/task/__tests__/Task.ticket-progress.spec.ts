import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { TicketStore } from "../../../services/tickets/TicketStore"
import { ToolRegistry } from "../../tools/ToolRegistry"
import { ToolRepetitionDetector } from "../../tools/ToolRepetitionDetector"
import { ToolScheduler, type ToolExecutionHost } from "../../agent/ToolScheduler"
import type { AgentToolCall } from "../../agent/AgentResponse"
import { AgentTurnEngine, type AgentTurnHost } from "../../agent/AgentTurnEngine"
import { Task } from "../Task"

describe("ticket progress through the scheduler and Task", () => {
	let profile: string
	let workspace: string
	let store: TicketStore

	beforeEach(async () => {
		profile = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-ticket-progress-"))
		workspace = path.join(profile, "project")
		await fs.mkdir(workspace)
		const forWorkspace = TicketStore.forWorkspace.bind(TicketStore)
		vi.spyOn(TicketStore, "forWorkspace").mockImplementation((cwd) => forWorkspace(cwd, profile))
		store = await TicketStore.forWorkspace(workspace)
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(profile, { recursive: true, force: true })
	})

	function harness(executionMode: "serial" | "selective-parallel" = "serial") {
		const controller = new AbortController()
		let stopped = false
		const suspend = vi.fn(() => {
			stopped = true
		})
		const task = Object.assign(Object.create(Task.prototype), {
			workspacePath: workspace,
			taskCancellationController: controller,
			pendingCommandVerification: Promise.resolve(),
			commandExecutionEvidence: new Map(),
			toolRepetitionDetector: new ToolRepetitionDetector(3, { noProgressLimit: 2, historyLimit: 8 }),
			userMessageContent: [],
			providerRef: { deref: () => ({ getVerificationProgressState: () => ({ stateFingerprint: "[]" }) }) },
			suspendAfterCurrentTurn: suspend,
			canMutateWorkspace: () => true,
			say: vi.fn(),
		}) as Task
		const observe = vi.fn(task.recordToolCallForStopping.bind(task))
		const host: ToolExecutionHost = {
			taskId: "ticket-progress",
			cwd: workspace,
			taskFacade: task,
			userMessageContent: [],
			say: async () => {},
			askApproval: async () => ({ response: "yesButtonClicked" }),
			recordToolUsage: () => {},
			recordToolCallForStopping: observe,
			shouldStopRepeatedToolCall: () => stopped,
			getToolRetryBlock: task.getToolRetryBlock.bind(task),
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
		const run = (calls: AgentToolCall[]) =>
			new ToolScheduler({
				executionHost: host,
				registry: new ToolRegistry(),
				mode: "code",
				executionMode,
				signal: controller.signal,
				preserveAbortedResults: true,
			}).run(calls)
		return { task, host, observe, suspend, run, controller }
	}

	it.each(["serial", "selective-parallel"] as const)(
		"finishes distinct deletions beyond the history window in %s mode",
		async (mode) => {
			const tickets = []
			for (let index = 0; index < 20; index++) tickets.push(await store.create({ name: `Cleanup ${index}` }))
			const { run, host, observe, suspend, task } = harness(mode)
			const calls: AgentToolCall[] = tickets.map((ticket, index) => ({
				type: "tool_call",
				id: `delete-${index}`,
				name: "delete_ticket",
				arguments: { id: ticket.reference, expectedRevision: ticket.revision },
			}))
			const turnHost: AgentTurnHost<number> = {
				shouldAbort: () => false,
				runStep: vi.fn(async (step) => {
					if (step === 0) {
						const outcome = await run(calls)
						return {
							response: { items: calls, toolCalls: calls, text: "", reasoning: "" },
							nextInput: 1,
							...(outcome.results.some((result) => result.status !== "success")
								? { status: "incomplete" as const }
								: {}),
						}
					}
					return {
						response: { items: [], toolCalls: [], text: "Deleted the requested tickets.", reasoning: "" },
						nextInput: "complete" as const,
					}
				}),
			}
			expect(await new AgentTurnEngine(turnHost).run(0)).toMatchObject({ status: "completed", steps: 2 })
			expect(turnHost.runStep).toHaveBeenCalledTimes(2)
			expect((await store.list()).total).toBe(0)
			expect(observe).toHaveBeenCalledTimes(tickets.length)
			expect(host.userMessageContent).toHaveLength(tickets.length)
			expect(suspend).not.toHaveBeenCalled()
			expect(Reflect.get(task, "userMessageContent")).toEqual([])
		},
	)

	it("credits incremental updates and revisiting externally changed tickets beyond the window", async () => {
		const { run, suspend, task } = harness()
		await run([{ type: "tool_call", id: "create", name: "create_ticket", arguments: { name: "Work item" } }])
		let ticket = await store.read("PRO-01")
		for (let index = 0; index < 20; index++) {
			const outcome = await run([
				{
					type: "tool_call",
					id: `update-${index}`,
					name: "update_ticket",
					arguments: {
						id: ticket.id,
						expectedRevision: ticket.revision,
						description: `Completed step ${index}`,
					},
				},
			])
			expect(outcome.results[0].status).toBe("success")
			ticket = await store.read(ticket.id)
			expect(ticket.description).toBe(`Completed step ${index}`)
			ticket = await store.update({
				id: ticket.id,
				expectedRevision: ticket.revision,
				context: `External detail ${index}`,
			})
			await run([
				{ type: "tool_call", id: `read-${index}`, name: "read_ticket", arguments: { id: ticket.reference } },
			])
		}
		expect(suspend).not.toHaveBeenCalled()
		expect(Reflect.get(task, "userMessageContent")).toEqual([])
	})

	it("recognizes distinct result pages and bounds repeated empty searches despite query churn", async () => {
		for (let index = 0; index < 12; index++) await store.create({ name: `Item ${index}` })
		const { run, suspend, task } = harness()
		for (let offset = 0; offset < 12; offset++) {
			await run([
				{ type: "tool_call", id: `page-${offset}`, name: "list_tickets", arguments: { limit: 1, offset } },
			])
		}
		expect(suspend).not.toHaveBeenCalled()
		for (let index = 0; index < 5; index++) {
			await run([
				{
					type: "tool_call",
					id: `empty-${index}`,
					name: "list_tickets",
					arguments: { query: `nonexistent${index}` },
				},
			])
		}
		expect(suspend).toHaveBeenCalledOnce()
		expect(Reflect.get(task, "userMessageContent")).toHaveLength(1)
	})

	it("bounds successful no-op updates without treating revision or locator spelling as progress", async () => {
		let ticket = await store.create({ name: "Stable" })
		const { run, suspend, task } = harness()
		for (let index = 0; index < 4; index++) {
			const outcome = await run([
				{
					type: "tool_call",
					id: `noop-${index}`,
					name: "update_ticket",
					arguments: {
						id: index % 2 ? ticket.reference : ticket.id,
						expectedRevision: ticket.revision,
						name: "  Stable  ",
					},
				},
			])
			expect(outcome.results[0].status).toBe("success")
			ticket = await store.read(ticket.id)
		}
		expect(ticket.name).toBe("Stable")
		expect(suspend).toHaveBeenCalledOnce()
		expect(Reflect.get(task, "userMessageContent")).toHaveLength(1)
	})

	it("preserves completed effects and independent work after an optional failed ticket operation", async () => {
		const { run, suspend, host } = harness()
		const outcome = await run([
			{ type: "tool_call", id: "create-before", name: "create_ticket", arguments: { name: "Before" } },
			{ type: "tool_call", id: "missing", name: "read_ticket", arguments: { id: "PRO-99" } },
			{ type: "tool_call", id: "create-after", name: "create_ticket", arguments: { name: "After" } },
		])
		expect(outcome.results.map((result) => result.status)).toEqual(["success", "error", "success"])
		expect((await store.list()).tickets.map((ticket) => ticket.name).sort()).toEqual(["After", "Before"])
		expect(host.userMessageContent).toHaveLength(3)
		expect(suspend).not.toHaveBeenCalled()
	})

	it("preserves completed deletions and cancels later effects when approval is interrupted", async () => {
		const tickets = []
		for (let index = 0; index < 3; index++) tickets.push(await store.create({ name: `Item ${index}` }))
		const { run, host, controller, suspend } = harness()
		let approvals = 0
		host.askApproval = async () => {
			if (++approvals === 2) controller.abort()
			return { response: "yesButtonClicked" }
		}
		const outcome = await run(
			tickets.map((ticket, index) => ({
				type: "tool_call",
				id: `delete-${index}`,
				name: "delete_ticket",
				arguments: { id: ticket.id, expectedRevision: ticket.revision },
			})),
		)
		expect(outcome.status).toBe("aborted")
		expect(outcome.results.map((result) => result.status)).toEqual(["success", "cancelled", "cancelled"])
		expect((await store.list()).tickets.map((ticket) => ticket.id).sort()).toEqual(
			tickets
				.slice(1)
				.map((ticket) => ticket.id)
				.sort(),
		)
		expect(host.userMessageContent).toHaveLength(3)
		expect(suspend).not.toHaveBeenCalled()
	})
})
