import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs/promises"
import os from "os"
import path from "path"
import type { GlobalSettings } from "@alpha-code/types"
import type { ToolUse } from "../../../shared/tools"
import { TicketStore } from "../../../services/tickets/TicketStore"
import { checkAutoApproval } from "../../auto-approval"
import type { Task } from "../../task/Task"
import type { ToolCallbacks } from "../BaseTool"
import { executeTicketTool } from "../TicketTools"

describe("native ticket approvals with persisted storage", () => {
	let profileDirectory: string
	let workspace: string
	let store: TicketStore

	beforeEach(async () => {
		profileDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-ticket-approvals-"))
		workspace = path.join(profileDirectory, "project")
		await fs.mkdir(workspace)
		// Redirect only the profile root; exercise the real workspace resolution and disk transactions.
		const forWorkspace = TicketStore.forWorkspace.bind(TicketStore)
		vi.spyOn(TicketStore, "forWorkspace").mockImplementation((cwd) => forWorkspace(cwd, profileDirectory))
		store = await TicketStore.forWorkspace(workspace)
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(profileDirectory, { recursive: true, force: true })
	})

	function harness(state: GlobalSettings, manualDecision = false, afterApproval?: () => void | Promise<void>) {
		const manualApproval = vi.fn(async () => manualDecision)
		const task = { cwd: workspace, abort: false, canMutateWorkspace: () => true, say: vi.fn() }
		const callbacks = {
			askApproval: vi.fn<ToolCallbacks["askApproval"]>(async (ask, text, _progress, isProtected) => {
				const result = await checkAutoApproval({ state, ask, text, isProtected })
				const approved = result.decision === "approve" || (await manualApproval())
				await afterApproval?.()
				return approved
			}),
			handleError: vi.fn(),
			setResultMetadata: vi.fn(),
			pushToolResult: vi.fn(),
		} satisfies ToolCallbacks
		const run = async (name: ToolUse["name"], nativeArgs: ToolUse["nativeArgs"], signal?: AbortSignal) => {
			await executeTicketTool({
				task: task as unknown as Task,
				call: { type: "tool_use", name, params: {}, partial: false, nativeArgs },
				callbacks,
				signal,
			})
		}
		return { task, callbacks, manualApproval, run }
	}

	it.each([
		{ label: "both enabled", state: { autoApprovalEnabled: true, alwaysAllowTickets: true }, prompts: 0 },
		{ label: "category disabled", state: { autoApprovalEnabled: true, alwaysAllowTickets: false }, prompts: 2 },
		{ label: "master disabled", state: { autoApprovalEnabled: false, alwaysAllowTickets: true }, prompts: 2 },
		{ label: "legacy setting missing", state: { autoApprovalEnabled: true }, prompts: 2 },
	])("creates and completes with $label", async ({ state, prompts }) => {
		const { run, callbacks, manualApproval, task } = harness(state, true)
		await run("create_ticket", { name: "Verify approvals" })
		const created = await store.read("PRO-01")
		expect(created.status).toBe("backlog")
		await run("update_ticket", {
			id: created.id,
			expectedRevision: created.revision,
			status: "complete",
			implementationSummary: "Verified create and completion approvals.",
		})
		expect(await store.read(created.id)).toMatchObject({ status: "complete", completedAt: expect.any(String) })
		expect(manualApproval).toHaveBeenCalledTimes(prompts)
		expect(callbacks.setResultMetadata.mock.calls).toEqual([[{ status: "success" }], [{ status: "success" }]])
		expect(callbacks.pushToolResult).toHaveBeenCalledTimes(2)
		expect(task.say.mock.calls.map(([, text]) => JSON.parse(text).ticketActivity)).toEqual([
			expect.objectContaining({ operation: "create", state: "success", reference: "PRO-01" }),
			expect.objectContaining({ operation: "update", state: "success", reference: "PRO-01" }),
		])
	})

	it.each([
		{ autoApprovalEnabled: true, alwaysAllowTickets: false },
		{ autoApprovalEnabled: false, alwaysAllowTickets: true },
		{ autoApprovalEnabled: true },
	])("denial leaves storage unchanged for %j", async (state) => {
		const { run, callbacks, manualApproval, task } = harness(state)
		await run("create_ticket", { name: "Declined" })
		expect((await store.list()).total).toBe(0)
		await expect(fs.stat(path.join(profileDirectory, ".alpha"))).rejects.toMatchObject({ code: "ENOENT" })
		const existing = await store.create({ name: "Existing" })
		await run("update_ticket", {
			id: existing.id,
			expectedRevision: existing.revision,
			status: "complete",
			implementationSummary: "Declined completion",
		})
		expect(await store.read(existing.id)).toEqual(existing)
		expect(manualApproval).toHaveBeenCalledTimes(2)
		expect(callbacks.setResultMetadata.mock.calls).toEqual([[{ status: "denied" }], [{ status: "denied" }]])
		expect(callbacks.pushToolResult).toHaveBeenCalledTimes(2)
		expect(task.say).not.toHaveBeenCalled()
	})

	it("keeps reads approval-free and rejects stale or cross-project writes with auto approval enabled", async () => {
		const { run, callbacks, manualApproval } = harness({ autoApprovalEnabled: true, alwaysAllowTickets: true })
		const original = await store.create({ name: "Original" })
		const edited = await store.update({
			id: original.id,
			expectedRevision: original.revision,
			name: "External edit",
		})
		await run("list_tickets", {})
		await run("read_ticket", { id: original.id })
		expect(callbacks.askApproval).not.toHaveBeenCalled()
		await run("update_ticket", { id: original.id, expectedRevision: original.revision, name: "Stale overwrite" })
		expect(callbacks.setResultMetadata).toHaveBeenLastCalledWith({ status: "error" })
		expect(await store.read(original.id)).toEqual(edited)
		const otherWorkspace = path.join(profileDirectory, "other")
		await fs.mkdir(otherWorkspace)
		const otherStore = await TicketStore.forWorkspace(otherWorkspace)
		const foreign = await otherStore.create({ name: "Other project's ticket" })
		await run("update_ticket", { id: foreign.id, expectedRevision: foreign.revision, name: "Cross-project write" })
		expect(callbacks.setResultMetadata).toHaveBeenLastCalledWith({ status: "error" })
		expect(await otherStore.read(foreign.id)).toEqual(foreign)
		expect(manualApproval).not.toHaveBeenCalled()
	})

	it("cancellation after automatic approval prevents the disk write", async () => {
		const controller = new AbortController()
		const { run, callbacks, manualApproval, task } = harness(
			{ autoApprovalEnabled: true, alwaysAllowTickets: true },
			false,
			() => controller.abort(),
		)
		await run("create_ticket", { name: "Cancelled" }, controller.signal)
		expect(callbacks.setResultMetadata).toHaveBeenCalledExactlyOnceWith({ status: "cancelled" })
		expect(callbacks.pushToolResult).toHaveBeenCalledTimes(1)
		expect(manualApproval).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
		expect((await store.list()).total).toBe(0)
	})

	it.each([false, true])(
		"requires manual approval to delete even with ticket auto approval (approved=%s)",
		async (approved) => {
			const deleted = await store.create({ name: "Delete only this ticket" })
			const survivor = await store.create({ name: "Keep this ticket" })
			const { run, callbacks, manualApproval, task } = harness(
				{ autoApprovalEnabled: true, alwaysAllowTickets: true },
				approved,
			)
			await run("delete_ticket", { id: deleted.reference!, expectedRevision: deleted.revision })
			expect(manualApproval).toHaveBeenCalledTimes(1)
			expect(callbacks.setResultMetadata).toHaveBeenCalledExactlyOnceWith({
				status: approved ? "success" : "denied",
			})
			expect(callbacks.pushToolResult).toHaveBeenCalledTimes(1)
			expect(await store.read(survivor.id)).toEqual(survivor)
			if (approved) {
				await expect(store.read(deleted.id)).rejects.toThrow("not found")
				expect(JSON.parse(task.say.mock.calls[0][1]).ticketActivity).toMatchObject({
					operation: "delete",
					state: "success",
					name: deleted.name,
					reference: deleted.reference,
				})
			} else {
				expect(await store.read(deleted.id)).toEqual(deleted)
				expect(task.say).not.toHaveBeenCalled()
			}
			expect((await store.create({ name: "Next ticket" })).reference).toBe("PRO-03")
		},
	)

	it("preserves an external edit made while deletion approval is pending", async () => {
		const original = await store.create({ name: "Original" })
		const { run, callbacks, task } = harness(
			{ autoApprovalEnabled: true, alwaysAllowTickets: true },
			true,
			async () => {
				await store.update({
					id: original.id,
					expectedRevision: original.revision,
					name: "Edited during approval",
				})
			},
		)
		await run("delete_ticket", { id: original.id, expectedRevision: original.revision })
		expect(callbacks.setResultMetadata).toHaveBeenCalledExactlyOnceWith({ status: "error" })
		expect(callbacks.pushToolResult).toHaveBeenCalledTimes(1)
		expect((await store.read(original.id)).name).toBe("Edited during approval")
		expect(task.say).not.toHaveBeenCalled()
	})

	it("cancellation during deletion approval preserves the ticket", async () => {
		const ticket = await store.create({ name: "Keep cancelled deletion" })
		const controller = new AbortController()
		const { run, callbacks, task } = harness({ autoApprovalEnabled: true, alwaysAllowTickets: true }, true, () =>
			controller.abort(),
		)
		await run("delete_ticket", { id: ticket.id, expectedRevision: ticket.revision }, controller.signal)
		expect(callbacks.setResultMetadata).toHaveBeenCalledExactlyOnceWith({ status: "cancelled" })
		expect(await store.read(ticket.id)).toEqual(ticket)
		expect(task.say).not.toHaveBeenCalled()
	})
})
