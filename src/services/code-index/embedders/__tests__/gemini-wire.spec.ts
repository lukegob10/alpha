import { GeminiEmbedder } from "../gemini"
import { EmbeddingRequestError } from "../../shared/embedding-retry"

function wireRequests(options: RequestInit): Array<{ content: { parts: { text: string }[] }; taskType?: string }> {
	const body = JSON.parse(options.body as string)
	return body.requests ?? [body]
}

describe("Gemini embedding wire contract", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
		vi.useRealTimers()
	})

	it.each(["gemini-embedding-001", "gemini-embedding-2"])(
		"batches %s with separate ordered vectors and retrieval roles",
		async (model) => {
			const fetch = vi.fn(async (_url: string, options: RequestInit) => {
				const requests = wireRequests(options)
				return new Response(JSON.stringify({ embeddings: requests.map((_, i) => ({ values: [i, 1] })) }))
			})
			vi.stubGlobal("fetch", fetch)
			const embedder = new GeminiEmbedder("test-key", model)
			await expect(embedder.createEmbeddings(["first", "second", "third"])).resolves.toMatchObject({
				embeddings: [
					[0, 1],
					[1, 1],
					[2, 1],
				],
			})
			expect(fetch).toHaveBeenCalledOnce()
			const [url, options] = fetch.mock.calls[0]
			expect(url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`)
			expect(new Headers(options.headers).get("x-goog-api-key")).toBe("test-key")
			const requests = wireRequests(options)
			expect(requests.map((request) => request.content.parts[0].text)).toEqual(
				model.includes("embedding-2")
					? ["first", "second", "third"].map((text) => `title: none | text: ${text}`)
					: ["first", "second", "third"],
			)
			if (!model.includes("embedding-2"))
				expect(requests.map((request) => request.taskType)).toEqual(Array(3).fill("RETRIEVAL_DOCUMENT"))
			await embedder.createEmbeddings(["find source"], undefined, "query")
			const query = wireRequests(fetch.mock.calls[1][1])[0]
			if (model.includes("embedding-2"))
				expect(query.content.parts[0].text).toBe("task: code retrieval | query: find source")
			else expect(query.taskType).toBe("CODE_RETRIEVAL_QUERY")
		},
	)

	it("bounds batch sizes and active requests across indexing and query callers", async () => {
		vi.useFakeTimers()
		let active = 0
		let maxActive = 0
		const sizes: number[] = []
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, options: RequestInit) => {
				const requests = wireRequests(options)
				sizes.push(requests.length)
				maxActive = Math.max(maxActive, ++active)
				await new Promise((resolve) =>
					setTimeout(resolve, requests[0].content.parts[0].text === "0" ? 100 : 10),
				)
				active--
				const embeddings = requests.map((request) => ({ values: [Number(request.content.parts[0].text), 1] }))
				return new Response(JSON.stringify({ embeddings }))
			}),
		)
		const embedder = new GeminiEmbedder("test-key")
		const texts = Array.from({ length: 121 }, (_, i) => String(i))
		const run = Promise.all([
			embedder.createEmbeddings(texts),
			embedder.createEmbeddings(["999"], undefined, "query"),
		])
		await vi.runAllTimersAsync()
		const [index, query] = await run
		expect(index.embeddings).toEqual(texts.map((text) => [Number(text), 1]))
		expect(query.embeddings).toEqual([[999, 1]])
		expect(sizes.sort((a, b) => a - b)).toEqual([1, 1, 60, 60])
		expect(maxActive).toBe(2)
	})

	it("accounts for each batched input in the configured request spacing", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(0)
		const starts: number[] = []
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, options: RequestInit) => {
				starts.push(Date.now())
				const requests = wireRequests(options)
				return new Response(JSON.stringify({ embeddings: requests.map(() => ({ values: [1, 0] })) }))
			}),
		)
		const embedder = new GeminiEmbedder("test-key", "gemini-embedding-001", 1)
		const run = Promise.all([embedder.createEmbeddings(["a", "b"]), embedder.createEmbeddings(["c", "d"])])
		await vi.runAllTimersAsync()
		await run
		expect(starts).toEqual([0, 2000])
	})

	it("uses Google's RetryInfo to pause queued requests after a 429", async () => {
		vi.useFakeTimers()
		vi.setSystemTime(0)
		const starts: number[] = []
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, options: RequestInit) => {
				starts.push(Date.now())
				if (starts.length === 1)
					return new Response(
						JSON.stringify({
							error: {
								code: 429,
								message: "Quota exhausted",
								details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "2s" }],
							},
						}),
						{ status: 429 },
					)
				const requests = wireRequests(options)
				const embeddings = requests.map(() => ({ values: [1, 0] }))
				return new Response(JSON.stringify({ embeddings }))
			}),
		)
		const embedder = new GeminiEmbedder("test-key")
		const run = embedder.createEmbeddings(Array(121).fill("fixture"))
		await vi.runAllTimersAsync()
		await run
		expect(starts.slice(2).every((time) => time >= 2000)).toBe(true)
		expect(starts).toHaveLength(4)
	})

	it("cancels a provider cooldown without further requests or retained timers", async () => {
		vi.useFakeTimers()
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: { code: 429, message: "Quota exhausted" } }), { status: 429 }),
		)
		vi.stubGlobal("fetch", fetch)
		const controller = new AbortController()
		const run = new GeminiEmbedder("test-key").createEmbeddings(
			["fixture"],
			undefined,
			"document",
			controller.signal,
		)
		const rejected = expect(run).rejects.toMatchObject({ name: "AbortError" })
		await vi.advanceTimersByTimeAsync(1)
		controller.abort()
		await rejected
		expect(fetch).toHaveBeenCalledOnce()
		expect(vi.getTimerCount()).toBe(0)
	})

	it("rejects incomplete batches instead of misaligning source vectors", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ embeddings: [{ values: [1, 0] }] }))),
		)
		await expect(new GeminiEmbedder("test-key").createEmbeddings(["first", "second"])).rejects.toThrow()
	})

	it.each([
		{ status: 429, attempts: 3 },
		{ status: 503, attempts: 3 },
		{ status: 401, attempts: 1 },
	])(
		"bounds actual HTTP attempts for $status and exposes a terminal provider failure",
		async ({ status, attempts }) => {
			vi.useFakeTimers()
			const fetch = vi.fn(
				async () =>
					new Response(JSON.stringify({ error: { code: status, message: "Fixture provider failure" } }), {
						status,
						headers: { "retry-after": "0" },
					}),
			)
			vi.stubGlobal("fetch", fetch)
			const rejected = expect(
				new GeminiEmbedder("test-key").createEmbeddings(["fixture"]),
			).rejects.toBeInstanceOf(EmbeddingRequestError)
			await vi.runAllTimersAsync()
			await rejected
			expect(fetch).toHaveBeenCalledTimes(attempts)
		},
	)

	it("splits long source chunks by the local token budget before the item-count limit", async () => {
		const sizes: number[] = []
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, options: RequestInit) => {
				const requests = wireRequests(options)
				sizes.push(requests.length)
				return new Response(JSON.stringify({ embeddings: requests.map(() => ({ values: [1, 0] })) }))
			}),
		)
		const embedder = new GeminiEmbedder("test-key")
		await expect(embedder.createEmbeddings(Array(25).fill("x".repeat(2048 * 4)))).resolves.toMatchObject({
			embeddings: Array(25).fill([1, 0]),
		})
		expect(sizes).toEqual([9, 9, 7])
		await expect(embedder.createEmbeddings(["x".repeat(2049 * 4)])).rejects.toThrow()
		expect(sizes).toHaveLength(3)
	})
})
