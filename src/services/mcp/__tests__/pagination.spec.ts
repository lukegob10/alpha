import {
	collectPaginatedCatalog,
	DEFAULT_MCP_PAGINATION_TIMEOUT_MS,
	MAX_MCP_CATALOG_ITEMS,
	MAX_MCP_CATALOG_PAGES,
	MAX_MCP_PAGINATION_CURSOR_BYTES,
	validateMcpPaginationCursor,
	type McpCatalogPage,
} from "../pagination"

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, resolve, reject }
}

describe("validateMcpPaginationCursor", () => {
	it.each([
		{ name: "absent", cursor: undefined },
		{ name: "empty", cursor: "" },
		{ name: "ASCII byte limit", cursor: "x".repeat(MAX_MCP_PAGINATION_CURSOR_BYTES) },
		{ name: "UTF-8 byte limit", cursor: "🦊".repeat(MAX_MCP_PAGINATION_CURSOR_BYTES / 4) },
	])("accepts an $name cursor", ({ cursor }) => {
		expect(() => validateMcpPaginationCursor("tools/list", cursor)).not.toThrow()
	})

	it.each([
		{ name: "ASCII", cursor: "private-token" + "x".repeat(MAX_MCP_PAGINATION_CURSOR_BYTES) },
		{ name: "UTF-8", cursor: "é".repeat(MAX_MCP_PAGINATION_CURSOR_BYTES / 2 + 1) },
	])("rejects an oversized $name cursor without exposing its payload", ({ cursor }) => {
		expect(() => validateMcpPaginationCursor("resources/list", cursor)).toThrow(
			new Error(`resources/list returned a pagination cursor exceeding ${MAX_MCP_PAGINATION_CURSOR_BYTES} bytes`),
		)
	})

	it.each([null, false, 42])("rejects an invalid runtime cursor %j", (cursor) => {
		const unvalidatedCursor: unknown = cursor
		expect(() => {
			// @ts-expect-error Exercise the runtime boundary with an unvalidated cursor.
			validateMcpPaginationCursor("resources/templates/list", unvalidatedCursor)
		}).toThrow(new Error("resources/templates/list returned an invalid pagination cursor"))
	})
})

describe("collectPaginatedCatalog", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.useRealTimers()
	})

	it("collects all pages in server order, forwarding an empty cursor and one combined signal", async () => {
		const source = new AbortController()
		const signals: AbortSignal[] = []
		const fetchPage = vi.fn(async (params: { cursor: string } | undefined, signal: AbortSignal) => {
			signals.push(signal)
			switch (params?.cursor) {
				case undefined:
					return { items: ["first"], nextCursor: "" }
				case "":
					return { items: [], nextCursor: "last" }
				case "last":
					return { items: ["second", "third"] }
				default:
					throw new Error("Unexpected cursor")
			}
		})

		await expect(collectPaginatedCatalog("tools/list", fetchPage, { signal: source.signal })).resolves.toEqual([
			"first",
			"second",
			"third",
		])
		expect(fetchPage.mock.calls.map(([params]) => params)).toEqual([undefined, { cursor: "" }, { cursor: "last" }])
		expect(new Set(signals).size).toBe(1)
		expect(signals[0]).not.toBe(source.signal)
		expect(signals[0].aborted).toBe(false)
	})

	it("accepts an empty complete catalog", async () => {
		const fetchPage = vi.fn(async () => ({ items: [] }))
		await expect(collectPaginatedCatalog("resources/list", fetchPage)).resolves.toEqual([])
		expect(fetchPage).toHaveBeenCalledTimes(1)
	})

	it.each([
		["consecutive", ["private-cursor", "private-cursor"]],
		["nonconsecutive", ["private-cursor", "other", "private-cursor"]],
		["empty", ["", ""]],
	])("rejects a %s repeated cursor without requesting another page or exposing it", async (_name, cursors) => {
		let page = 0
		const fetchPage = vi.fn(async () => ({ items: [page], nextCursor: cursors[page++] }))
		await expect(collectPaginatedCatalog("resources/list", fetchPage)).rejects.toHaveProperty(
			"message",
			"resources/list returned a repeated pagination cursor",
		)
		expect(fetchPage).toHaveBeenCalledTimes(cursors.length)
	})

	it.each(["x".repeat(MAX_MCP_PAGINATION_CURSOR_BYTES + 1), "é".repeat(MAX_MCP_PAGINATION_CURSOR_BYTES / 2 + 1)])(
		"rejects an oversized UTF-8 cursor before following it",
		async (cursor) => {
			const fetchPage = vi.fn(async () => ({ items: ["incomplete"], nextCursor: cursor }))
			await expect(collectPaginatedCatalog("resources/list", fetchPage)).rejects.toHaveProperty(
				"message",
				`resources/list returned a pagination cursor exceeding ${MAX_MCP_PAGINATION_CURSOR_BYTES} bytes`,
			)
			expect(fetchPage).toHaveBeenCalledTimes(1)
		},
	)

	it("accepts a cursor exactly at the UTF-8 byte limit", async () => {
		const cursor = "🦊".repeat(MAX_MCP_PAGINATION_CURSOR_BYTES / 4)
		const fetchPage = vi.fn(async (params: { cursor: string } | undefined) => {
			if (params === undefined) return { items: ["first"], nextCursor: cursor }
			expect(params.cursor).toBe(cursor)
			return { items: ["last"] }
		})
		await expect(collectPaginatedCatalog("resources/templates/list", fetchPage)).resolves.toEqual(["first", "last"])
	})

	it("rejects excessive pagination after the maximum pages, without dispatching page 101", async () => {
		let page = 0
		const fetchPage = vi.fn(async () => ({ items: [], nextCursor: String(page++) }))
		await expect(collectPaginatedCatalog("tools/list", fetchPage)).rejects.toThrow(
			`tools/list exceeded the pagination limit of ${MAX_MCP_CATALOG_PAGES} pages`,
		)
		expect(fetchPage).toHaveBeenCalledTimes(MAX_MCP_CATALOG_PAGES)
	})

	it("accepts a catalog completing on the maximum page", async () => {
		let page = 0
		const fetchPage = vi.fn(async () => ({
			items: [page++],
			nextCursor: page < MAX_MCP_CATALOG_PAGES ? String(page) : undefined,
		}))
		await expect(collectPaginatedCatalog("prompts/list", fetchPage)).resolves.toEqual(
			Array.from({ length: MAX_MCP_CATALOG_PAGES }, (_, index) => index),
		)
		expect(fetchPage).toHaveBeenCalledTimes(MAX_MCP_CATALOG_PAGES)
	})

	it("rejects a single page exceeding the item limit", async () => {
		const fetchPage = vi.fn(async () => ({ items: Array(MAX_MCP_CATALOG_ITEMS + 1).fill("item") }))
		await expect(collectPaginatedCatalog("tools/list", fetchPage)).rejects.toThrow(
			`tools/list exceeded the catalog limit of ${MAX_MCP_CATALOG_ITEMS} items`,
		)
		expect(fetchPage).toHaveBeenCalledTimes(1)
	})

	it("rejects cumulative item overflow without returning earlier pages", async () => {
		const fetchPage = vi
			.fn()
			.mockResolvedValueOnce({ items: Array(MAX_MCP_CATALOG_ITEMS).fill("item"), nextCursor: "last" })
			.mockResolvedValueOnce({ items: ["overflow"], nextCursor: "unreachable" })
		await expect(collectPaginatedCatalog("tools/list", fetchPage)).rejects.toThrow(
			`tools/list exceeded the catalog limit of ${MAX_MCP_CATALOG_ITEMS} items`,
		)
		expect(fetchPage).toHaveBeenCalledTimes(2)
	})

	it("accepts exactly the item limit and follows an empty final page", async () => {
		const items = Array(MAX_MCP_CATALOG_ITEMS).fill("item")
		const fetchPage = vi
			.fn()
			.mockResolvedValueOnce({ items, nextCursor: "last" })
			.mockResolvedValueOnce({ items: [] })
		await expect(collectPaginatedCatalog("resources/list", fetchPage)).resolves.toEqual(items)
		expect(fetchPage).toHaveBeenCalledTimes(2)
	})

	it.each(["first", "later"])("preserves a %s page failure and rejects the complete collection", async (page) => {
		const error = new Error("Page failed")
		const fetchPage = vi.fn()
		if (page === "later") fetchPage.mockResolvedValueOnce({ items: ["partial"], nextCursor: "last" })
		fetchPage.mockRejectedValueOnce(error)
		await expect(collectPaginatedCatalog("resources/templates/list", fetchPage)).rejects.toBe(error)
		expect(fetchPage).toHaveBeenCalledTimes(page === "later" ? 2 : 1)
	})

	it("preserves synchronous page failures", async () => {
		const error = new Error("Synchronous page failure")
		const fetchPage = vi.fn(() => {
			throw error
		})
		await expect(collectPaginatedCatalog("tools/list", fetchPage)).rejects.toBe(error)
		expect(vi.getTimerCount()).toBe(0)
	})

	it.each(["resolve", "reject"])(
		"enforces the default timeout and observes late transport %s",
		async (lateResult) => {
			const page = deferred<McpCatalogPage<string>>()
			let signal: AbortSignal | undefined
			const fetchPage = vi.fn((_params, requestSignal: AbortSignal) => {
				signal = requestSignal
				return page.promise
			})
			const collection = collectPaginatedCatalog("resources/list", fetchPage)
			const rejection = expect(collection).rejects.toThrow(
				`resources/list pagination timed out after ${DEFAULT_MCP_PAGINATION_TIMEOUT_MS}ms`,
			)
			await vi.advanceTimersByTimeAsync(DEFAULT_MCP_PAGINATION_TIMEOUT_MS)
			await rejection
			expect(signal?.aborted).toBe(true)
			expect(vi.getTimerCount()).toBe(0)
			if (lateResult === "resolve") page.resolve({ items: ["too late"], nextCursor: "unreachable" })
			else page.reject(new Error("Late transport error"))
			await Promise.resolve()
			await Promise.resolve()
			expect(fetchPage).toHaveBeenCalledTimes(1)
		},
	)

	it.each([
		{ timeoutMs: 3_000, requests: 2 },
		{ timeoutMs: 5_000, requests: 3 },
	])("uses one overall $timeoutMs ms deadline across individually timely pages", async ({ timeoutMs, requests }) => {
		let page = 0
		const fetchPage = vi.fn(
			async () =>
				new Promise<McpCatalogPage<number>>((resolve) => {
					const currentPage = page++
					setTimeout(() => resolve({ items: [currentPage], nextCursor: String(currentPage) }), 2_000)
				}),
		)
		const collection = collectPaginatedCatalog("tools/list", fetchPage, { timeoutMs })
		const rejection = expect(collection).rejects.toThrow(`tools/list pagination timed out after ${timeoutMs}ms`)
		await vi.advanceTimersByTimeAsync(timeoutMs)
		await rejection
		expect(fetchPage).toHaveBeenCalledTimes(requests)
		await vi.advanceTimersByTimeAsync(1_000)
		expect(fetchPage).toHaveBeenCalledTimes(requests)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("does not dispatch with a zero timeout", async () => {
		const fetchPage = vi.fn(async () => ({ items: [] }))
		await expect(collectPaginatedCatalog("tools/list", fetchPage, { timeoutMs: 0 })).rejects.toThrow(
			"tools/list pagination timed out after 0ms",
		)
		expect(fetchPage).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
	})

	it.each([NaN, Infinity, -1, 2_147_483_648])("rejects an invalid timeout without dispatch", async (timeoutMs) => {
		const fetchPage = vi.fn(async () => ({ items: [] }))
		await expect(collectPaginatedCatalog("tools/list", fetchPage, { timeoutMs })).rejects.toThrow(
			"pagination timeout must be between 0 and 2147483647ms",
		)
		expect(fetchPage).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
	})

	it("does not dispatch when the lifecycle is already cancelled", async () => {
		const source = new AbortController()
		const reason = new DOMException("Connection replaced", "AbortError")
		source.abort(reason)
		const fetchPage = vi.fn(async () => ({ items: [] }))
		await expect(collectPaginatedCatalog("tools/list", fetchPage, { signal: source.signal })).rejects.toBe(reason)
		expect(fetchPage).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
	})

	it.each(["resolve", "reject"])(
		"settles promptly on cancellation and observes late transport %s without further dispatch",
		async (lateResult) => {
			const source = new AbortController()
			const reason = new DOMException("Connection replaced", "AbortError")
			const page = deferred<McpCatalogPage<string>>()
			let combinedSignal: AbortSignal | undefined
			const fetchPage = vi.fn((_params, signal: AbortSignal) => {
				combinedSignal = signal
				return page.promise
			})
			const collection = collectPaginatedCatalog("tools/list", fetchPage, { signal: source.signal })
			const rejection = expect(collection).rejects.toBe(reason)
			source.abort(reason)
			await rejection
			expect(combinedSignal?.aborted).toBe(true)
			expect(combinedSignal?.reason).toBe(reason)
			expect(vi.getTimerCount()).toBe(0)

			if (lateResult === "resolve") page.resolve({ items: ["obsolete"], nextCursor: "unreachable" })
			else page.reject(new Error("Late transport error"))
			await Promise.resolve()
			await Promise.resolve()
			expect(fetchPage).toHaveBeenCalledTimes(1)
		},
	)

	it("handles cancellation during page dispatch without returning its catalog", async () => {
		const source = new AbortController()
		const reason = new DOMException("Connection closed", "AbortError")
		const fetchPage = vi.fn(async () => {
			source.abort(reason)
			return { items: ["obsolete"], nextCursor: "unreachable" }
		})
		await expect(collectPaginatedCatalog("prompts/list", fetchPage, { signal: source.signal })).rejects.toBe(reason)
		expect(fetchPage).toHaveBeenCalledTimes(1)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("rejects cancellation between page responses before dispatching the continuation", async () => {
		const source = new AbortController()
		const reason = new DOMException("Connection replaced between pages", "AbortError")
		const firstPage = deferred<McpCatalogPage<string>>()
		const fetchPage = vi.fn(() => firstPage.promise)
		const collection = collectPaginatedCatalog("resources/list", fetchPage, { signal: source.signal })
		const rejection = expect(collection).rejects.toBe(reason)
		firstPage.resolve({ items: ["partial"], nextCursor: "second" })
		await Promise.resolve()
		source.abort(reason)
		await rejection
		expect(fetchPage).toHaveBeenCalledTimes(1)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("cleans the deadline and source listener after timing out", async () => {
		const source = new AbortController()
		const addListener = vi.spyOn(source.signal, "addEventListener")
		const removeListener = vi.spyOn(source.signal, "removeEventListener")
		const page = deferred<McpCatalogPage<string>>()
		const collection = collectPaginatedCatalog("resources/list", () => page.promise, {
			signal: source.signal,
			timeoutMs: 25,
		})
		const rejection = expect(collection).rejects.toThrow("resources/list pagination timed out after 25ms")
		await vi.advanceTimersByTimeAsync(25)
		await rejection
		expect(removeListener).toHaveBeenCalledWith("abort", addListener.mock.calls[0][1])
		expect(vi.getTimerCount()).toBe(0)
		page.resolve({ items: [] })
	})

	it.each(["success", "failure", "cancelled"])(
		"cleans timers and source abort listeners after %s",
		async (result) => {
			const source = new AbortController()
			const addListener = vi.spyOn(source.signal, "addEventListener")
			const removeListener = vi.spyOn(source.signal, "removeEventListener")
			let combinedSignal: AbortSignal | undefined
			const fetchPage = vi.fn(async (_params, signal: AbortSignal) => {
				combinedSignal = signal
				if (result === "failure") throw new Error("Page failed")
				if (result === "cancelled") source.abort()
				return { items: ["complete"] }
			})
			const collection = collectPaginatedCatalog("tools/list", fetchPage, { signal: source.signal })
			if (result === "success") await expect(collection).resolves.toEqual(["complete"])
			else if (result === "failure") await expect(collection).rejects.toThrow("Page failed")
			else await expect(collection).rejects.toMatchObject({ name: "AbortError" })
			expect(addListener).toHaveBeenCalledTimes(1)
			expect(removeListener).toHaveBeenCalledWith("abort", addListener.mock.calls[0][1])
			expect(vi.getTimerCount()).toBe(0)
			if (result !== "cancelled") {
				source.abort()
				expect(combinedSignal?.aborted).toBe(false)
			}
		},
	)
})
