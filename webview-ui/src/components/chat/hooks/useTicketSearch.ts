import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { ticketSearchResponseSchema, type TicketSearchResponse } from "@alpha-code/types"
import { ContextMenuOptionType, type ContextMenuQueryItem } from "../../../utils/context-mentions"
import { vscode } from "../../../utils/vscode"

export function useTicketSearch(active: boolean, query: string, cwd: string): ContextMenuQueryItem[] {
	const { t } = useTranslation("tickets")
	const [response, setResponse] = useState<{ query: string; cwd: string; result: TicketSearchResponse }>()
	useEffect(() => {
		if (!active) return
		const requestId = `tickets-${crypto.randomUUID()}`
		const receive = (event: MessageEvent) => {
			if (event.data?.type !== "ticketSearchResults") return
			const parsed = ticketSearchResponseSchema.safeParse(event.data.ticketSearch)
			if (parsed.success && parsed.data.requestId === requestId) {
				clearTimeout(timeout)
				setResponse({ query, cwd, result: parsed.data })
			}
		}
		setResponse(undefined)
		window.addEventListener("message", receive)
		const timer = setTimeout(() => {
			if (query.length <= 200) vscode.postMessage({ type: "searchTickets", query, requestId })
		}, 200)
		const timeout = setTimeout(
			() =>
				setResponse({
					query,
					cwd,
					result: { type: "ticketSearchResults", requestId, tickets: [], error: true },
				}),
			15000,
		)
		return () => {
			clearTimeout(timer)
			clearTimeout(timeout)
			window.removeEventListener("message", receive)
		}
	}, [active, query, cwd])
	const current = response?.query === query && response.cwd === cwd ? response.result : undefined
	if (query.length > 200 || current?.error)
		return [{ type: ContextMenuOptionType.NoResults, label: t("activityLookupFailed") }]
	if (!current) return [{ type: ContextMenuOptionType.NoResults, label: t("activitySearching") }]
	if (!current.tickets.length) return [{ type: ContextMenuOptionType.NoResults, label: t("empty") }]
	return current.tickets.map((ticket) => ({
		type: ContextMenuOptionType.Ticket,
		value: `ticket:${ticket.reference ?? ticket.id}`,
		label: ticket.reference ? `${ticket.reference} · ${ticket.name}` : ticket.name,
		description: t(ticket.status),
	}))
}
