const MAX_SEARCH_LANES_PER_KIND = 8
const DRAFT_SEARCH_KEY = Symbol("draft-picker-search")

interface PendingSearch {
	run: (signal: AbortSignal) => Promise<void>
	resolve: () => void
	reject: (error: unknown) => void
}

interface SearchLane {
	controller: AbortController
	pending?: PendingSearch
}

type SearchLanes = Map<string | symbol, SearchLane>
type SearchKind = "ticket" | "file"

const searchesByProvider = new WeakMap<object, Record<SearchKind, SearchLanes>>()

/** Read-only picker work bypasses command queues, with one reader and one latest query per conversation. */
export function enqueueTicketSearch(
	provider: object,
	taskId: string | undefined,
	run: PendingSearch["run"],
): Promise<void> {
	return enqueueSearch(provider, "ticket", taskId, run)
}

export function enqueueFileSearch(
	provider: object,
	taskId: string | undefined,
	run: PendingSearch["run"],
): Promise<void> {
	return enqueueSearch(provider, "file", taskId, run)
}

function enqueueSearch(
	provider: object,
	kind: SearchKind,
	taskId: string | undefined,
	run: PendingSearch["run"],
): Promise<void> {
	let scopes = searchesByProvider.get(provider)
	if (!scopes) {
		scopes = { ticket: new Map(), file: new Map() }
		searchesByProvider.set(provider, scopes)
	}
	// Each picker retains its existing admission capacity and cannot supersede another kind's reader.
	const searches = scopes[kind]
	const key = taskId ?? DRAFT_SEARCH_KEY
	const existing = searches.get(key)
	if (!existing && searches.size >= MAX_SEARCH_LANES_PER_KIND) {
		return Promise.reject(new Error(`Too many concurrent ${kind} searches`))
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
	searches: SearchLanes,
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

/** Both picker kinds use this existing view/disposal hook; store indexing retains its own lifecycle. */
export function cancelTicketSearches(provider: object): void {
	const scopes = searchesByProvider.get(provider)
	if (!scopes) return
	for (const searches of Object.values(scopes)) {
		for (const lane of searches.values()) {
			lane.controller.abort()
			lane.pending?.resolve()
			lane.pending = undefined
		}
	}
	searchesByProvider.delete(provider)
}
