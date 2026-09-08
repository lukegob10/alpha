import {
	createTicketSchema,
	updateTicketSchema,
	deleteTicketSchema,
	listTicketsSchema,
	ticketLocatorSchema,
	type ClineSayTool,
	type TicketActivity,
	type Ticket,
	type TicketList,
} from "@alpha-code/types"
import type { ToolExecutionContext } from "./ToolRegistry"
import { TicketStore } from "../../services/tickets/TicketStore"

export async function executeTicketTool({ task, call, callbacks, signal }: ToolExecutionContext): Promise<void> {
	if (call.partial) return
	signal ??= callbacks.signal
	const inspection = call.name === "list_tickets" ? "list" : call.name === "read_ticket" ? "read" : undefined
	const publish = async (activity: TicketActivity) => {
		// Presentation failure cannot change a completed operation into a retryable failure.
		try {
			await task.say("tool", JSON.stringify({ tool: "ticket", ticketActivity: activity } satisfies ClineSayTool))
		} catch {
			console.error("[Tickets] Could not publish ticket activity")
		}
	}
	try {
		signal?.throwIfAborted()
		if (task.abort) throw new Error("Ticket operation cancelled")
		const store = await TicketStore.forWorkspace(task.cwd)
		const approveMutation = async (
			operation: "create" | "update" | "delete",
			name: string,
			reference?: string,
		): Promise<boolean> => {
			const approved = await callbacks.askApproval(
				"tool",
				JSON.stringify({
					tool: "ticket",
					ticketActivity: {
						operation,
						state: "pending",
						name,
						...(reference ? { reference } : {}),
					},
				} satisfies ClineSayTool),
			)
			signal?.throwIfAborted()
			if (task.abort) throw new Error("Ticket operation cancelled")
			if (!approved) {
				callbacks.setResultMetadata?.({ status: "denied" })
				callbacks.pushToolResult(JSON.stringify({ status: "denied", message: "Ticket change declined" }))
				return false
			}
			if (!task.canMutateWorkspace()) throw new Error("Ticket operation cancelled")
			return true
		}
		signal?.throwIfAborted()
		if (task.abort) throw new Error("Ticket operation cancelled")
		let result: Ticket | TicketList
		switch (call.name) {
			case "list_tickets":
				result = await store.list(listTicketsSchema.parse(call.nativeArgs), signal)
				break
			case "read_ticket":
				result = await store.read(ticketLocatorSchema.parse((call.nativeArgs as { id?: unknown })?.id), signal)
				break
			case "create_ticket": {
				const input = createTicketSchema.parse(call.nativeArgs)
				if (!(await approveMutation("create", input.name))) return
				result = await store.create(input, signal)
				break
			}
			case "update_ticket": {
				const input = updateTicketSchema.parse(call.nativeArgs)
				const name = input.name ?? (await store.read(input.id, signal)).name
				if (!(await approveMutation("update", name))) return
				result = await store.update(input, signal)
				break
			}
			case "delete_ticket": {
				const input = deleteTicketSchema.parse(call.nativeArgs)
				const ticket = await store.read(input.id, signal)
				if (!(await approveMutation("delete", ticket.name, ticket.reference))) return
				result = await store.delete(input, signal)
				break
			}
			default:
				throw new Error(`Unknown ticket tool: ${call.name}`)
		}
		if ("tickets" in result) {
			await publish({
				operation: "list",
				state: "success",
				query: listTicketsSchema.parse(call.nativeArgs).query,
				total: result.total,
				matches: result.tickets
					.slice(0, 3)
					.map(({ id, name, reference }) => ({ name, reference, target: { project: store.projectId, id } })),
			})
		} else if (call.name === "delete_ticket") {
			await publish({ operation: "delete", state: "success", name: result.name, reference: result.reference })
		} else {
			await publish({
				operation: inspection === "read" ? "read" : call.name === "create_ticket" ? "create" : "update",
				state: "success",
				name: result.name,
				reference: result.reference,
				target: { project: store.projectId, id: result.id },
			})
		}
		callbacks.setResultMetadata?.({ status: "success" })
		callbacks.pushToolResult(JSON.stringify({ status: "success", result }))
	} catch (error) {
		const status = signal?.aborted || task.abort ? "cancelled" : "error"
		if (inspection) await publish({ operation: inspection, state: status })
		callbacks.setResultMetadata?.({ status })
		callbacks.pushToolResult(
			JSON.stringify({ status, message: error instanceof Error ? error.message : "Ticket operation failed" }),
		)
	}
}
