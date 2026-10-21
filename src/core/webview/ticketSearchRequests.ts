const MAX_TICKET_SEARCH_LANES_PER_PROVIDER = 8
const DRAFT_SEARCH_KEY = Symbol("draft-ticket-search")

interface PendingSearch {
	run: (signal: AbortSignal) => Promise<void>
	resolve: () => void
	reject: (error: unknown) => void
}

interface SearchLane {
	controller: AbortController
	pending?: PendingSearch
}

const searchesByProvider = new WeakMap<object, Map<string | symbol, SearchLane>>()

/** Read-only picker work bypasses command queues, with one reader and one latest query per conversation. */
export function enqueueTicketSearch(
	provider: object,
	taskId: string | undefined,
	run: PendingSearch["run"],
): Promise<void> {
	let searches = searchesByProvider.get(provider)
	if (!searches) {
		searches = new Map()
		searchesByProvider.set(provider, searches)
	}
	const key = taskId ?? DRAFT_SEARCH_KEY
	const existing = searches.get(key)
	if (!existing && searches.size >= MAX_TICKET_SEARCH_LANES_PER_PROVIDER) {
		return Promise.reject(new Error("Too many concurrent ticket searches"))
	}
	const lane = existing ?? { controller: new AbortController() }
	searches.set(key, lane)
	return new Promise<void>((resolve, reject) => {
		const request = { run, resolve, reject }
		if (existing) {
			lane.pending?.resolve()
			lane.pending = request
			lane.controller.abort()
			return
		}
		void drainSearches(searches, key, lane, request)
	})
}

async function drainSearches(
	searches: Map<string | symbol, SearchLane>,
	key: string | symbol,
	lane: SearchLane,
	first: PendingSearch,
): Promise<void> {
	let request: PendingSearch | undefined = first
	while (request) {
		try {
			await request.run(lane.controller.signal)
		} catch (error) {
			if (!lane.controller.signal.aborted) request.reject(error)
		}
		request.resolve()
		request = lane.pending
		lane.pending = undefined
		if (request) lane.controller = new AbortController()
	}
	if (searches.get(key) === lane) searches.delete(key)
}

/** Cancel before joining provider disposal; shared store indexing retains its own lifecycle. */
export function cancelTicketSearches(provider: object): void {
	for (const lane of searchesByProvider.get(provider)?.values() ?? []) {
		lane.controller.abort()
		lane.pending?.resolve()
		lane.pending = undefined
	}
	searchesByProvider.delete(provider)
}
