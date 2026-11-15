import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import {
	normalizeTicketReference,
	normalizeTicketNumberQuery,
	ticketSearchResponseSchema,
	type TicketSearchResponse,
} from "@alpha-code/types"
import { ContextMenuOptionType, type ContextMenuQueryItem } from "../../../utils/context-mentions"
import { createDebounce } from "../../../utils/debounce"
import { vscode } from "../../../utils/vscode"

export function useTicketSearch(active: boolean, query: string, cwd: string, taskId?: string): ContextMenuQueryItem[] {
	const { t } = useTranslation("tickets")
	const fuzzySearch = useMemo(() => createDebounce(50), [])
	const searchScope = useMemo(
		() => (active && query.length <= 200 ? { query, cwd, taskId } : undefined),
		[active, query, cwd, taskId],
	)
	const [response, setResponse] = useState<{
		scope: NonNullable<typeof searchScope>
		result: TicketSearchResponse
	}>()
	useEffect(() => () => fuzzySearch.cancel(), [fuzzySearch])
	useEffect(() => {
		if (!searchScope) {
			fuzzySearch.cancel()
			return
		}
		const { query, taskId } = searchScope
		let timer: ReturnType<typeof setTimeout> | undefined
		let receive: ((event: MessageEvent) => void) | undefined
		let cancelled = false
		const stopListening = () => {
			clearTimeout(timer)
			if (receive) window.removeEventListener("message", receive)
		}
		const search = () => {
			if (cancelled) return
			const requestId = `tickets-${crypto.randomUUID()}`
			receive = (event) => {
				if (event.data?.type !== "ticketSearchResults" || event.data.ticketSearch?.requestId !== requestId)
					return
				const parsed = ticketSearchResponseSchema.safeParse(event.data.ticketSearch)
				if (parsed.success) {
					stopListening()
					setResponse({ scope: searchScope, result: parsed.data })
				}
			}
			window.addEventListener("message", receive)
			timer = setTimeout(() => {
				stopListening()
				setResponse({
					scope: searchScope,
					result: { type: "ticketSearchResults", requestId, tickets: [], error: true },
				})
			}, 15_000)
			vscode.postMessage({
				type: "searchTickets",
				query,
				requestId,
				...(taskId ? { taskId } : { workspaceScope: true }),
			})
		}
		if (query === "" || normalizeTicketReference(query) || normalizeTicketNumberQuery(query) !== undefined) {
			fuzzySearch.cancel()
			queueMicrotask(search)
		} else {
			fuzzySearch.schedule(search)
		}
		return () => {
			cancelled = true
			stopListening()
		}
	}, [searchScope, fuzzySearch])
	if (!active) return []
	const current = response?.scope === searchScope ? response?.result : undefined
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
