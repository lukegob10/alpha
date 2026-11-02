import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Ticket } from "@alpha-code/types"
import { NativeToolCallParser } from "../../assistant-message/NativeToolCallParser"
import { getInheritedSubagentToolNames } from "../../agent/SubagentPermissions"
import { resolveInternalTaskPolicy } from "../../agent/InternalTaskEnvelope"
import { TicketStore } from "../../../services/tickets/TicketStore"
import common from "../../../i18n/locales/en/common.json"
import { executeTicketTool } from "../TicketTools"
import { createTaskToolSurface } from "../TaskToolSurface"
import { ToolRegistry, type ToolExecutionContext } from "../ToolRegistry"
import { isToolAllowedForMode } from "../validateToolUse"

vi.mock("../../../i18n", () => ({
	t: (key: string, values: { count: number; references: string }) =>
		key === "common:ticketTools.deleteBatchSummary"
			? common.ticketTools.deleteBatchSummary
					.replace("{{count}}", String(values.count))
					.replace("{{references}}", values.references)
			: key,
}))

describe("native ticket batch deletion", () => {
	let home: string
	let workspace: string
	let store: TicketStore
	let tickets: Ticket[]
	beforeEach(async () => {
		home = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-ticket-batch-tool-"))
		workspace = path.join(home, "project")
		await fs.mkdir(workspace)
		store = await TicketStore.forWorkspace(workspace, home)
		const parent = await store.create({ name: "Parent", context: "Private requirement text" })
		const first = await store.create({ name: "Typed child", type: "bug", parentId: parent.id })
		const second = await store.create({ name: "Other child", type: "feature", parentId: parent.id })
		tickets = [parent, first, second]
		vi.spyOn(TicketStore, "forWorkspace").mockResolvedValue(store)
	})
	afterEach(async () => {
		vi.restoreAllMocks()
		TicketStore.disposeSearchCaches()
		await fs.rm(home, { recursive: true, force: true })
	})

	function setup() {
		const task = {
			cwd: workspace,
			abort: false,
			canMutateWorkspace: () => true,
			say: vi.fn().mockResolvedValue(undefined),
		}
		const callbacks = {
			askApproval: vi.fn().mockResolvedValue(true),
			pushToolResult: vi.fn(),
			setResultMetadata: vi.fn(),
			getRemainingOutputChars: vi.fn(() => 100000),
		}
		const args = { tickets: tickets.map(({ id, revision }) => ({ id, expectedRevision: revision })) }
		const execute = (input: unknown = args, signal?: AbortSignal) =>
			executeTicketTool({
				task,
				callbacks,
				signal,
				call: { name: "delete_tickets", nativeArgs: input },
			} as unknown as ToolExecutionContext)
		return { task, callbacks, args, execute }
	}

	it("lists all types with strict-provider null defaults, then deletes the returned batch in one approved action", async () => {
		const { task, callbacks } = setup()
		const raw = { query: null, status: null, typeFilter: null, offset: 0, limit: 100 }
		await executeTicketTool({
			task,
			callbacks,
			call: { name: "list_tickets", nativeArgs: raw },
		} as unknown as ToolExecutionContext)
		const listed = JSON.parse(callbacks.pushToolResult.mock.calls[0][0])
		expect(listed.status).toBe("success")
		expect(listed.result.total).toBe(3)
		expect(raw).toEqual({ query: null, status: null, typeFilter: null, offset: 0, limit: 100 })
		const readMany = vi.spyOn(store, "readMany")
		const remove = vi.spyOn(store, "deleteMany")
		const singularRemove = vi.spyOn(store, "delete")
		const input = {
			tickets: listed.result.tickets.map(({ id, revision }: Ticket) => ({ id, expectedRevision: revision })),
		}
		callbacks.pushToolResult.mockClear()
		callbacks.setResultMetadata.mockClear()
		task.say.mockClear()
		await executeTicketTool({
			task,
			callbacks,
			call: { name: "delete_tickets", nativeArgs: input },
		} as unknown as ToolExecutionContext)
		expect(readMany).toHaveBeenCalledExactlyOnceWith(
			input.tickets.map(({ id }: Ticket) => id),
			undefined,
		)
		expect(remove).toHaveBeenCalledExactlyOnceWith(input, undefined)
		expect(singularRemove).not.toHaveBeenCalled()
		expect(callbacks.askApproval).toHaveBeenCalledOnce()
		const approval = JSON.parse(callbacks.askApproval.mock.calls[0][1]).ticketActivity
		expect(approval).toMatchObject({ operation: "delete", state: "pending" })
		expect(approval.name).toContain("3 tickets")
		expect(approval.name.length).toBeLessThanOrEqual(200)
		expect(JSON.stringify(approval)).not.toContain("Private requirement text")
		expect(task.say).toHaveBeenCalledOnce()
		expect(JSON.parse(task.say.mock.calls[0][1]).ticketActivity).toMatchObject({
			operation: "delete",
			state: "success",
			name: approval.name,
		})
		expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(
			JSON.stringify({ status: "success", result: { deleted: 3 } }),
		)
		const metadata = callbacks.setResultMetadata.mock.calls[0][0]
		expect(metadata).toMatchObject({ status: "success", trustedProgress: { kind: "mutation" } })
		expect(metadata.trustedProgress.previousStateFingerprint).not.toBe(metadata.trustedProgress.stateFingerprint)
		expect((await store.list()).total).toBe(0)
	})

	it.each(["denied", "cancelled", "mutation-rights-lost"] as const)("does not commit a %s batch", async (outcome) => {
		const { task, callbacks, execute } = setup()
		const controller = new AbortController()
		callbacks.askApproval.mockImplementation(async () => {
			if (outcome === "cancelled") controller.abort(new Error("Stopped by user"))
			if (outcome === "mutation-rights-lost") task.canMutateWorkspace = () => false
			return outcome !== "denied"
		})
		const remove = vi.spyOn(store, "deleteMany")
		await execute(undefined, controller.signal)
		expect(callbacks.askApproval).toHaveBeenCalledOnce()
		expect(remove).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).toHaveBeenCalledOnce()
		expect(callbacks.setResultMetadata).toHaveBeenCalledOnce()
		expect(callbacks.setResultMetadata.mock.calls[0][0].status).toBe(
			outcome === "mutation-rights-lost" ? "error" : outcome,
		)
		expect(task.say).not.toHaveBeenCalled()
		expect((await store.list()).total).toBe(3)
	})

	it("rejects a ticket changed while batch approval is pending without deleting any other ticket", async () => {
		const { callbacks, execute } = setup()
		callbacks.askApproval.mockImplementation(async () => {
			await store.update({ id: tickets[1].id, expectedRevision: tickets[1].revision, name: "External change" })
			return true
		})
		await execute()
		expect(callbacks.pushToolResult).toHaveBeenCalledOnce()
		expect(callbacks.setResultMetadata).toHaveBeenCalledExactlyOnceWith({ status: "error" })
		expect((await store.list()).total).toBe(3)
		expect((await store.read(tickets[1].id)).name).toBe("External change")
	})

	it.each([false, true])(
		"reserves a bounded receipt before mutation even if approval consumes the budget: %s",
		async (afterApproval) => {
			const { callbacks, execute } = setup()
			callbacks.getRemainingOutputChars.mockReturnValue(32)
			if (afterApproval) callbacks.getRemainingOutputChars.mockReturnValueOnce(100000)
			const remove = vi.spyOn(store, "deleteMany")
			await execute()
			expect(callbacks.askApproval).toHaveBeenCalledTimes(afterApproval ? 1 : 0)
			expect(remove).not.toHaveBeenCalled()
			expect(callbacks.pushToolResult).toHaveBeenCalledOnce()
			expect(callbacks.setResultMetadata.mock.calls[0][0].status).toBe("error")
			expect((await store.list()).total).toBe(3)
		},
	)

	it("does not turn a committed deletion into a retryable error when activity publishing fails", async () => {
		const { task, callbacks, execute } = setup()
		task.say.mockRejectedValue(new Error("View closed"))
		vi.spyOn(console, "error").mockImplementation(() => {})
		await execute()
		expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(
			JSON.stringify({ status: "success", result: { deleted: 3 } }),
		)
		expect(callbacks.setResultMetadata.mock.calls[0][0].status).toBe("success")
		expect((await store.list()).total).toBe(0)
	})

	it("rejects invalid batches and missing tickets before asking for approval", async () => {
		const { callbacks, args, execute } = setup()
		await execute({ tickets: [] })
		expect(callbacks.askApproval).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).toHaveBeenCalledOnce()
		callbacks.pushToolResult.mockClear()
		await store.delete({ id: tickets[2].id, expectedRevision: tickets[2].revision })
		await execute(args)
		expect(callbacks.askApproval).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).toHaveBeenCalledOnce()
		expect((await store.list()).total).toBe(2)
	})

	it("parses the complete native batch without dropping transaction fields", () => {
		const { args } = setup()
		const parsed = NativeToolCallParser.parseToolCall({
			id: "delete-batch",
			name: "delete_tickets",
			arguments: JSON.stringify(args),
		})
		expect(parsed).toMatchObject({ name: "delete_tickets", nativeArgs: args })
	})

	it("uses the same serial mutation policy, edit mode, and inherited mutation cap as singular deletion", () => {
		const registry = new ToolRegistry()
		expect(registry.resolve("delete_tickets")).toMatchObject({
			capabilities: { concurrency: "serial", sideEffects: "external", requiresApproval: true },
		})
		expect(isToolAllowedForMode("delete_tickets", "code", [])).toBe(true)
		expect(isToolAllowedForMode("delete_tickets", "architect", [])).toBe(false)
		expect(createTaskToolSurface({ mode: "architect" }).isCallable("delete_tickets")).toBe(false)
		expect(
			createTaskToolSurface({ mode: "code", disabledTools: ["delete_tickets"] }).isCallable("delete_tickets"),
		).toBe(false)
		const caps = { execute: false, mutate: false, delegate: false, network: false, externalSideEffects: false }
		expect(getInheritedSubagentToolNames(["list_tickets", "delete_tickets"], caps, false)).toEqual(["list_tickets"])
		expect(
			getInheritedSubagentToolNames(["list_tickets", "delete_tickets"], { ...caps, mutate: true }, false),
		).toEqual(["list_tickets", "delete_tickets"])
	})

	it("keeps batch deletion unavailable to an Explore child with inherited read-only authority", () => {
		const parent = {
			read: true,
			execute: true,
			mutate: true,
			delegate: true,
			network: true,
			externalSideEffects: true,
			requireApproval: true,
		}
		const explore = resolveInternalTaskPolicy(
			parent,
			{ mutate: false, execute: false, network: false, externalSideEffects: false },
			"explore",
			"parent",
		)
		const inherited = getInheritedSubagentToolNames(["list_tickets", "delete_tickets"], explore, false)
		const child = createTaskToolSurface({ mode: "code", taskKind: "subagent", allowedToolNames: inherited })
		expect(child.isCallable("list_tickets")).toBe(true)
		expect(child.isCallable("delete_tickets")).toBe(false)
		expect(child.resolve("delete_tickets")).toBeUndefined()
	})
})
