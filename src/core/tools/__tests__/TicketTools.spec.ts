import { NativeToolCallParser } from "../../assistant-message/NativeToolCallParser"
import { afterEach, describe, expect, it, vi } from "vitest"
import { executeTicketTool } from "../TicketTools"
import { TicketStore } from "../../../services/tickets/TicketStore"
import type { ToolExecutionContext } from "../ToolRegistry"
import { ToolRegistry } from "../ToolRegistry"
import { isToolAllowedForMode } from "../validateToolUse"

describe("native tickets", () => {
	afterEach(() => vi.restoreAllMocks())
	it.each(["list_tickets", "read_ticket"] as const)(
		"publishes %s evidence without exposing ticket contents in chat",
		async (name) => {
			const ticket = {
				id: "a97392fe-59bf-4f80-8a10-51b2cb62a38f",
				reference: "PM-01",
				name: "Backend cleanup",
				context: "Full private context",
			}
			const result = name === "list_tickets" ? { tickets: [ticket], total: 1, invalidFiles: [] } : ticket
			const read = vi.fn().mockResolvedValue(ticket)
			vi.spyOn(TicketStore, "forWorkspace").mockResolvedValue({
				read,
				projectId: "project-hash",
				list: vi.fn().mockResolvedValue(result),
			} as unknown as TicketStore)
			const task = { cwd: "/project", abort: false, say: vi.fn() }
			const callbacks = { askApproval: vi.fn(), setResultMetadata: vi.fn(), pushToolResult: vi.fn() }
			await executeTicketTool({
				task,
				callbacks,
				call: { name, nativeArgs: name === "list_tickets" ? { query: "backend cleanup" } : { id: "PM1" } },
			} as unknown as ToolExecutionContext)
			const activity = JSON.parse(task.say.mock.calls[0][1]).ticketActivity
			expect(activity).toMatchObject({ operation: name === "list_tickets" ? "list" : "read", state: "success" })
			expect(JSON.stringify(activity)).toContain("PM-01")
			expect(JSON.stringify(activity)).not.toContain("Full private context")
			expect(callbacks.askApproval).not.toHaveBeenCalled()
			expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(
				JSON.stringify({ status: "success", result }),
			)
			if (name === "read_ticket") expect(read).toHaveBeenCalledWith("PM1", undefined)
			expect(name === "read_ticket" ? activity.target : activity.matches[0].target).toEqual({
				project: "project-hash",
				id: ticket.id,
			})
		},
	)
	it("reports an empty search and failed read without claiming that a ticket loaded", async () => {
		vi.spyOn(TicketStore, "forWorkspace").mockResolvedValue({
			list: vi.fn().mockResolvedValue({ tickets: [], total: 0, invalidFiles: [] }),
			read: vi.fn().mockRejectedValue(new Error("Ticket not found")),
		} as unknown as TicketStore)
		const task = { cwd: "/project", abort: false, say: vi.fn() }
		const callbacks = { setResultMetadata: vi.fn(), pushToolResult: vi.fn() }
		await executeTicketTool({
			task,
			callbacks,
			call: { name: "list_tickets", nativeArgs: {} },
		} as unknown as ToolExecutionContext)
		await executeTicketTool({
			task,
			callbacks,
			call: { name: "read_ticket", nativeArgs: { id: "PM-99" } },
		} as unknown as ToolExecutionContext)
		expect(JSON.parse(task.say.mock.calls[0][1]).ticketActivity).toMatchObject({
			operation: "list",
			state: "success",
			total: 0,
			matches: [],
		})
		expect(JSON.parse(task.say.mock.calls[1][1]).ticketActivity).toEqual({ operation: "read", state: "error" })
		expect(callbacks.setResultMetadata).toHaveBeenLastCalledWith({ status: "error" })
	})
	it.each([
		{ name: "create_ticket" as const, args: { name: "Ticket", description: "Text", type: "bug" } },
		{ name: "update_ticket" as const, args: { id: "PM-01", expectedRevision: "v1", type: null } },
		{ name: "list_tickets" as const, args: { type: "feature" } },
		{ name: "delete_ticket" as const, args: { id: "PM-01", expectedRevision: "v1" } },
	])("preserves native $name structured arguments", ({ name, args }) => {
		const call = NativeToolCallParser.parseToolCall({
			id: "ticket-call",
			name,
			arguments: JSON.stringify(args),
		})
		// Task assigns the stream call ID after parsing, as for other built-in tools.
		expect(call).toMatchObject({ name, nativeArgs: args })
	})
	it("exposes read tools in Plan while restricting writes", () => {
		const registry = new ToolRegistry()
		for (const name of ["create_ticket", "update_ticket", "list_tickets"] as const) {
			expect(registry.resolve(name)?.schema).toMatchObject({
				function: {
					parameters: {
						properties: {
							type: { type: ["string", "null"], enum: ["bug", "feature", "improvement", null] },
						},
					},
				},
			})
		}
		for (const name of ["list_tickets", "read_ticket"] as const) {
			expect(registry.resolve(name)?.capabilities.sideEffects).toBe("none")
			expect(isToolAllowedForMode(name, "architect", [])).toBe(true)
		}
		for (const name of ["create_ticket", "update_ticket", "delete_ticket"] as const) {
			expect(registry.resolve(name)?.capabilities).toMatchObject({
				concurrency: "serial",
				sideEffects: "external",
				requiresApproval: true,
			})
			expect(isToolAllowedForMode(name, "architect", [])).toBe(false)
			expect(isToolAllowedForMode(name, "code", [])).toBe(true)
		}
		expect(registry.resolve("delete_ticket")?.schema).toMatchObject({
			function: {
				name: "delete_ticket",
				parameters: { required: ["id", "expectedRevision"], additionalProperties: false },
			},
		})
	})

	it.each(["approved", "denied", "cancelled"] as const)("handles %s ticket deletion", async (outcome) => {
		const result = { id: "a97392fe-59bf-4f80-8a10-51b2cb62a38f", reference: "PM-01", name: "Ticket" }
		const controller = new AbortController()
		const remove = vi.fn().mockResolvedValue(result)
		vi.spyOn(TicketStore, "forWorkspace").mockResolvedValue({
			projectId: "project",
			read: vi.fn().mockResolvedValue(result),
			delete: remove,
		} as unknown as TicketStore)
		const task = { cwd: "/project", abort: false, canMutateWorkspace: () => true, say: vi.fn() }
		const callbacks = {
			askApproval: vi.fn(async () => {
				if (outcome === "cancelled") controller.abort()
				return outcome === "approved"
			}),
			pushToolResult: vi.fn(),
			setResultMetadata: vi.fn(),
		}
		const input = { id: "PM-01", expectedRevision: "v1" }
		await executeTicketTool({
			task,
			callbacks,
			signal: controller.signal,
			call: { name: "delete_ticket", nativeArgs: input },
		} as unknown as ToolExecutionContext)
		expect(callbacks.askApproval).toHaveBeenCalledExactlyOnceWith(
			"tool",
			JSON.stringify({
				tool: "ticket",
				ticketActivity: { operation: "delete", state: "pending", name: "Ticket", reference: "PM-01" },
			}),
		)
		expect(callbacks.pushToolResult).toHaveBeenCalledTimes(1)
		expect(callbacks.setResultMetadata).toHaveBeenCalledWith({
			status: outcome === "approved" ? "success" : outcome,
		})
		if (outcome === "approved") {
			expect(remove).toHaveBeenCalledExactlyOnceWith(input, controller.signal)
			expect(JSON.parse(task.say.mock.calls[0][1]).ticketActivity).toEqual({
				operation: "delete",
				state: "success",
				name: "Ticket",
				reference: "PM-01",
			})
		} else {
			expect(remove).not.toHaveBeenCalled()
			expect(task.say).not.toHaveBeenCalled()
		}
	})

	it("rejects unrecognized ticket dispatch without falling through to update", async () => {
		const update = vi.fn()
		vi.spyOn(TicketStore, "forWorkspace").mockResolvedValue({ update } as unknown as TicketStore)
		const callbacks = { pushToolResult: vi.fn(), setResultMetadata: vi.fn() }
		await executeTicketTool({
			task: { cwd: "/project", abort: false },
			callbacks,
			call: { name: "unknown_ticket", nativeArgs: { id: "PM-01", expectedRevision: "v1" } },
		} as unknown as ToolExecutionContext)
		expect(update).not.toHaveBeenCalled()
		expect(callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
	})

	it.each(["create_ticket", "update_ticket"] as const)("returns denied without an unapproved %s", async (name) => {
		const write = vi.fn()
		const spy = vi.spyOn(TicketStore, "forWorkspace").mockResolvedValue({
			projectId: "project",
			create: write,
			update: write,
			read: vi.fn().mockResolvedValue({ name: "Ticket" }),
		} as unknown as TicketStore)
		const callbacks = {
			askApproval: vi.fn().mockResolvedValue(false),
			pushToolResult: vi.fn(),
			setResultMetadata: vi.fn(),
		}
		await executeTicketTool({
			task: { cwd: "/project", abort: false },
			call: {
				name,
				nativeArgs:
					name === "create_ticket"
						? { name: "Ticket" }
						: { id: "PM-01", expectedRevision: "v1", status: "complete" },
			},
			callbacks,
		} as unknown as ToolExecutionContext)
		expect(write).not.toHaveBeenCalled()
		expect(callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "denied" })
		expect(callbacks.pushToolResult).toHaveBeenCalledTimes(1)
		spy.mockRestore()
	})

	it.each(["create_ticket", "update_ticket", "delete_ticket"] as const)(
		"confirms %s only after saving and preserves structured results for the model",
		async (name) => {
			const operation = name === "create_ticket" ? "create" : name === "update_ticket" ? "update" : "delete"
			const result = {
				id: "a97392fe-59bf-4f80-8a10-51b2cb62a38f",
				name: "Saved ticket",
				description: "Full model context",
			}
			let finish!: (value: typeof result) => void
			const saved = new Promise<typeof result>((resolve) => {
				finish = resolve
			})
			let started!: () => void
			const writing = new Promise<void>((resolve) => {
				started = resolve
			})
			const write = vi.fn(() => {
				started()
				return saved
			})
			vi.spyOn(TicketStore, "forWorkspace").mockResolvedValue({
				create: write,
				projectId: "project-hash",
				update: write,
				delete: write,
				read: vi.fn().mockResolvedValue(result),
			} as unknown as TicketStore)
			const task = { cwd: "/project", abort: false, canMutateWorkspace: () => true, say: vi.fn() }
			const callbacks = {
				askApproval: vi.fn().mockResolvedValue(true),
				pushToolResult: vi.fn(),
				setResultMetadata: vi.fn(),
			}
			const running = executeTicketTool({
				task,
				callbacks,
				call: {
					name,
					nativeArgs:
						name === "create_ticket" ? { name: result.name } : { id: result.id, expectedRevision: "v1" },
				},
			} as unknown as ToolExecutionContext)
			await writing
			expect(task.say).not.toHaveBeenCalled()
			expect(JSON.parse(callbacks.askApproval.mock.calls[0][1])).toEqual({
				tool: "ticket",
				ticketActivity: {
					operation,
					state: "pending",
					name: result.name,
				},
			})
			expect(callbacks.askApproval.mock.calls[0]).toHaveLength(2)
			finish(result)
			await running
			expect(task.say).toHaveBeenCalledWith(
				"tool",
				JSON.stringify({
					tool: "ticket",
					ticketActivity: {
						operation,
						state: "success",
						name: result.name,
						...(operation !== "delete" ? { target: { project: "project-hash", id: result.id } } : {}),
					},
				}),
			)
			expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(
				JSON.stringify({ status: "success", result }),
			)
		},
	)

	it.each(["failed", "cancelled", "denied"])("never confirms a %s ticket write", async (outcome) => {
		const controller = new AbortController()
		const create = vi.fn().mockRejectedValue(new Error("Save failed"))
		vi.spyOn(TicketStore, "forWorkspace").mockResolvedValue({ create } as unknown as TicketStore)
		const task = { cwd: "/project", abort: false, canMutateWorkspace: () => true, say: vi.fn() }
		const callbacks = {
			askApproval: vi.fn(async () => {
				if (outcome === "cancelled") controller.abort()
				return outcome !== "denied"
			}),
			pushToolResult: vi.fn(),
			setResultMetadata: vi.fn(),
		}
		await executeTicketTool({
			task,
			callbacks,
			signal: controller.signal,
			call: { name: "create_ticket", nativeArgs: { name: "Ticket" } },
		} as unknown as ToolExecutionContext)
		expect(task.say).not.toHaveBeenCalled()
		expect(callbacks.setResultMetadata).toHaveBeenCalledWith({ status: outcome === "failed" ? "error" : outcome })
		expect(callbacks.pushToolResult).toHaveBeenCalledTimes(1)
		if (outcome !== "failed") expect(create).not.toHaveBeenCalled()
	})

	it("keeps a committed write successful when the chat notification fails", async () => {
		const result = { name: "Saved" }
		vi.spyOn(TicketStore, "forWorkspace").mockResolvedValue({
			create: vi.fn().mockResolvedValue(result),
		} as unknown as TicketStore)
		vi.spyOn(console, "error").mockImplementation(() => {})
		const task = {
			cwd: "/project",
			abort: false,
			canMutateWorkspace: () => true,
			say: vi.fn().mockRejectedValue(new Error("Closed")),
		}
		const callbacks = {
			askApproval: vi.fn().mockResolvedValue(true),
			pushToolResult: vi.fn(),
			setResultMetadata: vi.fn(),
		}
		await executeTicketTool({
			task,
			callbacks,
			call: { name: "create_ticket", nativeArgs: { name: "Saved" } },
		} as unknown as ToolExecutionContext)
		expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ status: "success", result }))
	})
})
