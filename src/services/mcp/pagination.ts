export const MAX_MCP_CATALOG_PAGES = 100
export const MAX_MCP_CATALOG_ITEMS = 2_048
export const MAX_MCP_PAGINATION_CURSOR_BYTES = 64 * 1024
export const DEFAULT_MCP_PAGINATION_TIMEOUT_MS = 30_000

export interface McpCatalogPage<T> {
	items: T[]
	nextCursor?: string
}

export interface McpCatalogPaginationOptions {
	signal?: AbortSignal
	timeoutMs?: number
}

type FetchCatalogPage<T> = (params: { cursor: string } | undefined, signal: AbortSignal) => Promise<McpCatalogPage<T>>

export function validateMcpPaginationCursor(method: string, cursor: string | undefined): void {
	if (cursor === undefined) return
	if (typeof cursor !== "string") {
		throw new Error(`${method} returned an invalid pagination cursor`)
	}
	if (Buffer.byteLength(cursor, "utf8") > MAX_MCP_PAGINATION_CURSOR_BYTES) {
		throw new Error(`${method} returned a pagination cursor exceeding ${MAX_MCP_PAGINATION_CURSOR_BYTES} bytes`)
	}
}

function fetchPageWithCancellation<T>(
	fetchPage: FetchCatalogPage<T>,
	params: { cursor: string } | undefined,
	signal: AbortSignal,
): Promise<McpCatalogPage<T>> {
	return new Promise((resolve, reject) => {
		let settled = false
		const finish = (settle: () => void) => {
			if (settled) return
			settled = true
			signal.removeEventListener("abort", onAbort)
			settle()
		}
		const onAbort = () => finish(() => reject(signal.reason))
		signal.addEventListener("abort", onAbort, { once: true })
		try {
			signal.throwIfAborted()
			// Both handlers remain attached to observe late settlement from transports that ignore abort.
			Promise.resolve(fetchPage(params, signal)).then(
				(page) => finish(() => resolve(page)),
				(error) => finish(() => reject(error)),
			)
		} catch (error) {
			finish(() => reject(error))
		}
	})
}

/** Resolves only when every page has been collected within the catalog and lifecycle bounds. */
export async function collectPaginatedCatalog<T>(
	method: string,
	fetchPage: FetchCatalogPage<T>,
	options: McpCatalogPaginationOptions = {},
): Promise<T[]> {
	const sourceSignal = options.signal
	sourceSignal?.throwIfAborted()
	const timeoutMs = options.timeoutMs ?? DEFAULT_MCP_PAGINATION_TIMEOUT_MS
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
		throw new Error(`${method} pagination timeout must be between 0 and 2147483647ms`)
	}

	const controller = new AbortController()
	const relayAbort = () => controller.abort(sourceSignal?.reason)
	sourceSignal?.addEventListener("abort", relayAbort, { once: true })
	const timeoutReason = new Error(`${method} pagination timed out after ${timeoutMs}ms`)
	const deadline = performance.now() + timeoutMs
	const timer = setTimeout(() => controller.abort(timeoutReason), timeoutMs)
	const assertActive = () => {
		// Check the monotonic deadline as well as the timer before dispatch or publication.
		if (!controller.signal.aborted && performance.now() >= deadline) controller.abort(timeoutReason)
		controller.signal.throwIfAborted()
	}

	try {
		const collected: T[] = []
		const seenCursors = new Set<string>()
		let cursor: string | undefined
		for (let pageCount = 0; pageCount < MAX_MCP_CATALOG_PAGES; pageCount++) {
			assertActive()
			const page = await fetchPageWithCancellation(
				fetchPage,
				cursor === undefined ? undefined : { cursor },
				controller.signal,
			)
			assertActive()
			if (page.items.length > MAX_MCP_CATALOG_ITEMS - collected.length) {
				throw new Error(`${method} exceeded the catalog limit of ${MAX_MCP_CATALOG_ITEMS} items`)
			}
			collected.push(...page.items)
			validateMcpPaginationCursor(method, page.nextCursor)
			if (page.nextCursor === undefined) return collected
			if (seenCursors.has(page.nextCursor)) {
				throw new Error(`${method} returned a repeated pagination cursor`)
			}
			seenCursors.add(page.nextCursor)
			cursor = page.nextCursor
		}
		throw new Error(`${method} exceeded the pagination limit of ${MAX_MCP_CATALOG_PAGES} pages`)
	} finally {
		clearTimeout(timer)
		sourceSignal?.removeEventListener("abort", relayAbort)
	}
}
