import * as assert from "assert"
import * as vscode from "vscode"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import {
	AlphaCodeEventName,
	type AlphaCodeSettings,
	type Ticket,
	type TicketRequest,
	type SkillMetadata,
} from "@alpha-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { waitFor } from "./utils"
import {
	FeatureScriptedAI,
	toolResultRecords,
	featureSkillName,
	assertFeatureToolResult,
	assertFeatureToolCall,
	assertFeatureTicketListResult,
	assertFeatureCommandResult,
} from "../scenarios/featureWorkflowFixture"
import { updateFilePatch } from "../scenarios/scriptedPatch"

const LIST_CALL_ID = "alpha-tickets-eager-list"
const TICKET_TOOLS = ["list_tickets", "read_ticket", "create_ticket", "update_ticket", "delete_ticket"]

type HistoryMessage = { role: string; content: unknown }
type TicketHost = {
	getLiveTask(taskId: string): { taskAsk?: { ask?: string }; approveAsk(): void } | undefined
	getTaskWithId(taskId: string): Promise<{ apiConversationHistory: HistoryMessage[] }>
}

class TicketsScriptedAI {
	readonly id = "alpha-tickets-eager-scripted"
	readonly requests: Array<{ messages: unknown[]; tools: unknown[] }> = []

	async *createMessage(
		_systemPrompt: string,
		messages: unknown[],
		metadata?: { taskId?: string; attemptId?: string; tools?: unknown[] },
	) {
		if (metadata?.attemptId === "title") {
			yield { type: "text" as const, text: "Fixture task" }
			return
		}
		assert.ok(metadata?.taskId, "Every provider request must belong to the real task")
		const tools = metadata.tools ?? []
		this.requests.push({ messages: structuredClone(messages), tools: structuredClone(tools) })

		if (this.requests.length === 1) {
			const names = tools.flatMap((tool) => {
				if (!tool || typeof tool !== "object" || !("function" in tool)) return []
				const fn = (tool as { function?: { name?: unknown } }).function
				return fn && typeof fn.name === "string" ? [fn.name] : []
			})
			for (const name of TICKET_TOOLS) {
				assert.ok(names.includes(name), `${name} must be eager in the first Alpha Tickets model request`)
			}
			yield {
				type: "tool_call" as const,
				id: LIST_CALL_ID,
				name: "list_tickets",
				arguments: JSON.stringify({ status: "in-progress" }),
			}
			return
		}

		assert.equal(this.requests.length, 2, "The fixture permits one list and one continuation")
		assertFeatureToolCall(messages, LIST_CALL_ID, "list_tickets", { status: "in-progress" })
		const listed = assertFeatureTicketListResult(messages, LIST_CALL_ID)
		assert.equal(listed.total, 0, "The isolated test workspace must start with no Tickets")
		assert.deepEqual(listed.tickets, [])
		yield { type: "text" as const, text: "There are no in-progress Alpha Tickets in this workspace." }
	}

	getModel() {
		return {
			id: this.id,
			info: { contextWindow: 16_000, maxTokens: 1_000, supportsImages: false, supportsPromptCache: false },
		}
	}

	async countTokens(content: unknown[]): Promise<number> {
		return content.reduce<number>((tokens, block) => tokens + Math.ceil(JSON.stringify(block).length / 4), 0)
	}

	async completePrompt(): Promise<string> {
		return ""
	}
}

suite("Alpha Tickets eager tool acceptance", function () {
	setDefaultSuiteTimeout(this)

	test("offers all Ticket tools immediately and executes a real list with paired history", async () => {
		assert.equal(vscode.version, "1.138.0")
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
		const api = globalThis.api
		const provider = (api as unknown as { sidebarProvider?: TicketHost }).sidebarProvider
		assert.ok(provider)
		const original = api.getConfiguration()
		const model = new TicketsScriptedAI()
		const completions: string[] = []
		const onCompleted = (taskId: string) => completions.push(taskId)
		api.on(AlphaCodeEventName.TaskCompleted, onCompleted)
		try {
			const configuration: AlphaCodeSettings = {
				...original,
				apiProvider: "fake-ai",
				fakeAi: model,
				mode: "code",
				approvalMode: "auto",
				requestDelaySeconds: 0,
				writeDelayMs: 0,
				enableCheckpoints: false,
			}
			const taskId = await api.startNewTask({ configuration, text: "Which Alpha Tickets are in progress?" })
			await waitFor(
				() => {
					const task = provider.getLiveTask(taskId)
					if (task?.taskAsk?.ask === "completion_result") task.approveAsk()
					return completions.filter((id) => id === taskId).length === 1
				},
				{ timeout: 60_000, description: "the eager Alpha Tickets lookup to complete once" },
			)
			assert.equal(model.requests.length, 2)
			const persisted = (await provider.getTaskWithId(taskId)).apiConversationHistory
			assertFeatureToolCall(persisted, LIST_CALL_ID, "list_tickets", { status: "in-progress" })
			assert.deepEqual(assertFeatureTicketListResult(persisted, LIST_CALL_ID), { tickets: [], total: 0 })
		} finally {
			api.off(AlphaCodeEventName.TaskCompleted, onCompleted)
			await api.clearCurrentTask().catch(() => undefined)
			await api.setConfiguration(original)
		}
	})

	test("links a Ticket repair to a real skill task, rejects stale completion, reloads and preserves cancelled edits", async () => {
		assert.equal(vscode.version, "1.138.0")
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
		const workspace = process.env.ALPHA_E2E_WORKSPACE
		assert.ok(workspace)
		type Store = {
			workspace: string
			projectId: string
			create(input: { name: string; description: string; successCriteria: string }): Promise<Ticket>
			read(id: string): Promise<Ticket>
			markdownPath(id: string): Promise<string>
			delete(input: { id: string; expectedRevision: string }): Promise<unknown>
		}
		type Panel = {
			projects: Map<string, Store>
			panel?: vscode.WebviewPanel
			open(): Promise<void>
			receive(message: TicketRequest | { type: "ticketsReady" }): Promise<void>
		}
		type LinkedTask = {
			taskId: string
			taskAsk?: { ask?: string; partial?: boolean }
			abortTask(): Promise<void>
			approveAsk(): void
			waitForTermination(): Promise<void>
			flushApiConversationHistoryPersistence(): Promise<void>
		}
		const api = globalThis.api
		const internals = api as unknown as {
			context: { subscriptions: unknown[] }
			sidebarProvider: Omit<TicketHost, "getLiveTask"> & {
				createTask(
					text: string,
					images: undefined,
					parent: undefined,
					options: { startTask: false },
					configuration: AlphaCodeSettings,
				): Promise<LinkedTask>
				getLiveTask(id: string): LinkedTask | undefined
				getSkillsManager(): { refreshSkills(): Promise<SkillMetadata[]> }
			}
		}
		const panel = internals.context.subscriptions.find((entry): entry is Panel => {
			if (!entry || typeof entry !== "object") return false
			const candidate = entry as Partial<Panel>
			return (
				candidate.projects instanceof Map &&
				typeof candidate.open === "function" &&
				typeof candidate.receive === "function"
			)
		})
		assert.ok(panel, "The activated production Ticket panel must own the work request")
		const directory = await fs.mkdtemp(path.join(workspace, "ticket-workflow-"))
		const relative = path.relative(workspace, directory).replaceAll("\\", "/")
		const skillName = featureSkillName(directory)
		const skillDirectory = path.join(workspace, ".alpha", "skills", skillName)
		const before = "module.exports.total = (values) => values.reduce((sum, value) => sum + value)\n"
		const after = "module.exports.total = (values) => values.reduce((sum, value) => sum + value, 0)\n"
		const external = "\n## External editor note\nPreserve this concurrent user note.\n"
		let store: Store | undefined
		let activeTicket: Ticket | undefined
		let cancelling = false
		const tickets: string[] = []
		const linkedTasks: string[] = []
		const original = api.getConfiguration()
		let registration: LinkedTask | undefined
		const model: FeatureScriptedAI = new FeatureScriptedAI(async (request) => {
			assert.ok(activeTicket && store)
			if (request.ordinal === 1) return { name: "read_ticket", arguments: { id: activeTicket.id } }
			if (cancelling) {
				assert.equal(request.ordinal, 2)
				const current = await store.read(activeTicket.id)
				return {
					name: "update_ticket",
					arguments: { id: current.id, expectedRevision: current.revision, status: "complete" },
				}
			}
			if (request.ordinal === 2) return { name: "skill", arguments: { skill: skillName } }
			if (request.ordinal === 3) {
				assertFeatureToolResult(request.messages, `${model.id}-2`, {
					error: false,
					marker: "TICKET_REPAIR_SKILL",
				})
				return { name: "exec_command", arguments: { cmd: `node "${relative}/verify.cjs"` } }
			}
			if (request.ordinal === 4) {
				assertFeatureCommandResult(request.messages, `${model.id}-3`, {
					exitCode: 1,
					marker: "TypeError: Reduce of empty array with no initial value",
				})
				return {
					name: "apply_patch",
					arguments: { patch: updateFilePatch(`${relative}/total.cjs`, before, after) },
				}
			}
			if (request.ordinal === 5)
				return { name: "exec_command", arguments: { cmd: `node "${relative}/verify.cjs"` } }
			if (request.ordinal === 6) {
				assertFeatureCommandResult(request.messages, `${model.id}-5`, {
					exitCode: 0,
					marker: "TICKET_REPAIR_VERIFIED",
				})
				const current = await store.read(activeTicket.id)
				await fs.appendFile(await store.markdownPath(current.id), external)
				return {
					name: "update_ticket",
					arguments: {
						id: current.id,
						expectedRevision: current.revision,
						status: "complete",
						implementationSummary: "Verified empty and nonempty totals.",
					},
				}
			}
			if (request.ordinal === 7) {
				assert.equal(
					(await store.read(activeTicket.id)).status,
					"in-progress",
					"A stale write cannot complete the Ticket",
				)
				assert.ok(
					toolResultRecords(request.messages).some(
						(record) => record.status === "error" && String(record.message).includes("changed"),
					),
				)
				return { name: "read_ticket", arguments: { id: activeTicket.id } }
			}
			if (request.ordinal === 8) {
				const current = toolResultRecords(request.messages)
					.reverse()
					.find((record) => record.id === activeTicket!.id && typeof record.revision === "string")
				assert.ok(current)
				return {
					name: "update_ticket",
					arguments: {
						id: activeTicket.id,
						expectedRevision: current.revision,
						status: "complete",
						implementationSummary: "Verified empty and nonempty totals after the final edit.",
					},
				}
			}
			assert.equal(request.ordinal, 9)
			assert.equal((await store.read(activeTicket.id)).status, "complete")
			return undefined
		})
		try {
			await fs.mkdir(skillDirectory, { recursive: true })
			await fs.writeFile(
				path.join(skillDirectory, "SKILL.md"),
				`---\nname: ${skillName}\ndescription: Repair the owned Ticket total fixture\n---\nTICKET_REPAIR_SKILL\nFix ${relative}/total.cjs, run node "${relative}/verify.cjs" after the final edit, and complete the Ticket only after verification succeeds.\n`,
			)
			await fs.writeFile(path.join(directory, "total.cjs"), before)
			await fs.writeFile(
				path.join(directory, "verify.cjs"),
				"const assert=require('node:assert/strict');const {total}=require('./total.cjs');assert.equal(total([]),0);assert.equal(total([2,-3,4]),3);console.log('TICKET_REPAIR_VERIFIED')\n",
			)
			registration = await internals.sidebarProvider.createTask(
				"Register the owned Ticket fixture provider.",
				undefined,
				undefined,
				{ startTask: false },
				{
					...original,
					apiProvider: "fake-ai",
					fakeAi: model,
					mode: "code",
					approvalMode: "bypass",
					enableCheckpoints: false,
					requestDelaySeconds: 0,
					writeDelayMs: 0,
				},
			)
			await internals.sidebarProvider.getSkillsManager().refreshSkills()
			await panel.open()
			await panel.receive({ type: "ticketsReady" })
			store = [...panel.projects.values()].find(
				(candidate) => path.resolve(candidate.workspace) === path.resolve(workspace),
			)
			assert.ok(store)
			activeTicket = await store.create({
				name: "Repair empty totals",
				description: `Fix ${relative}/total.cjs using ${skillName}.`,
				successCriteria:
					"Empty totals are zero, signed totals are correct, and verification passes after the final edit.",
			})
			tickets.push(activeTicket.id)
			await panel.receive({
				type: "ticketRequest",
				requestId: "owned-ticket-work",
				project: store.projectId,
				operation: { action: "work", id: activeTicket.id, expectedRevision: activeTicket.revision },
			})
			const linked = await store.read(activeTicket.id)
			const taskId = linked.linkedTaskIds.at(-1)
			assert.ok(taskId, "The real work action must persist linkage before the first model request")
			linkedTasks.push(taskId)
			await waitFor(
				() => {
					model.assertHealthy()
					return model.requests.filter((request) => request.taskId === taskId).length === 9
				},
				{
					timeout: 90_000,
					description: "the linked Ticket repair and stale-write recovery",
				},
			)
			const task = internals.sidebarProvider.getLiveTask(taskId)
			assert.ok(task)
			if (task.taskAsk?.ask === "completion_result") task.approveAsk()
			await task.waitForTermination()
			await task.flushApiConversationHistoryPersistence()
			model.assertHealthy()
			assert.equal(await fs.readFile(path.join(directory, "total.cjs"), "utf8"), after)
			const completed = await store.read(activeTicket.id)
			assert.equal(completed.status, "complete")
			assert.deepEqual(completed.linkedTaskIds, [taskId])
			assert.ok((await fs.readFile(await store.markdownPath(completed.id), "utf8")).includes(external.trim()))
			const history = (await internals.sidebarProvider.getTaskWithId(taskId)).apiConversationHistory
			for (let ordinal = 1; ordinal <= 8; ordinal++) {
				const callId = `${model.id}-${ordinal}`
				assert.equal(
					history.filter(
						(message) => message.role === "assistant" && JSON.stringify(message.content).includes(callId),
					).length,
					1,
				)
				assert.equal(
					history.filter(
						(message) => message.role === "user" && JSON.stringify(message.content).includes(callId),
					).length,
					1,
				)
			}
			panel.panel?.dispose()
			await panel.open()
			await panel.receive({ type: "ticketsReady" })
			const reloaded = panel.projects.get(store.projectId)
			assert.ok(reloaded)
			assert.notEqual(reloaded, store, "Reopen must reconstruct the production Ticket store")
			assert.equal((await reloaded.read(completed.id)).status, "complete")
			store = reloaded
			cancelling = true
			await api.setConfiguration({ approvalMode: "ask" })
			activeTicket = await store.create({
				name: "Cancelled repair",
				description: "Do not complete an interrupted repair.",
				successCriteria: "Only verified work can complete.",
			})
			tickets.push(activeTicket.id)
			await panel.receive({
				type: "ticketRequest",
				requestId: "owned-ticket-cancel",
				project: store.projectId,
				operation: { action: "work", id: activeTicket.id, expectedRevision: activeTicket.revision },
			})
			const cancelledId = (await store.read(activeTicket.id)).linkedTaskIds.at(-1)
			assert.ok(cancelledId)
			linkedTasks.push(cancelledId)
			await waitFor(
				() => {
					model.assertHealthy()
					return internals.sidebarProvider.getLiveTask(cancelledId)?.taskAsk?.ask === "tool"
				},
				{
					description: "the Ticket completion waiting for approval",
				},
			)
			await fs.appendFile(await store.markdownPath(activeTicket.id), external)
			const cancelledTask = internals.sidebarProvider.getLiveTask(cancelledId)!
			await cancelledTask.abortTask()
			await cancelledTask.waitForTermination()
			await cancelledTask.flushApiConversationHistoryPersistence()
			const cancelledHistory = (await internals.sidebarProvider.getTaskWithId(cancelledId)).apiConversationHistory
			const cancellationResults = toolResultRecords(cancelledHistory).filter(
				(record) => record.type === "tool_result" && record.tool_use_id === `${model.id}-2`,
			)
			assert.equal(cancellationResults.length, 1)
			assert.equal(cancellationResults[0]!.is_error, true, "The cancelled Ticket write cannot persist as success")
			assert.equal(model.requests.filter((request) => request.taskId === cancelledId).length, 2)
			assert.equal((await store.read(activeTicket.id)).status, "in-progress")
			assert.ok((await fs.readFile(await store.markdownPath(activeTicket.id), "utf8")).includes(external.trim()))
		} finally {
			for (const id of linkedTasks) await internals.sidebarProvider.getLiveTask(id)?.abortTask()
			await registration?.abortTask()
			if (store)
				for (const id of tickets) {
					const current = await store.read(id)
					await store.delete({ id, expectedRevision: current.revision })
				}
			panel.panel?.dispose()
			await api.clearCurrentTask()
			await api.setConfiguration(original)
			model.dispose()
			await fs.rm(skillDirectory, { recursive: true, force: true })
			await fs.rm(directory, { recursive: true, force: true })
			await internals.sidebarProvider.getSkillsManager().refreshSkills()
		}
	})
})
