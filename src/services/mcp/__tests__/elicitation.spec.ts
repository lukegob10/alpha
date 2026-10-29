import { afterEach, expect, it, vi } from "vitest"
import { McpElicitationRouter } from "../elicitation"

const form = {
	method: "elicitation/create" as const,
	params: {
		message: "Select a region",
		requestedSchema: {
			type: "object" as const,
			properties: { region: { type: "string" as const, enum: ["east", "west"] } },
			required: ["region"],
		},
	},
}
afterEach(() => vi.useRealTimers())

it("cancels unsolicited requests", async () => {
	expect(await new McpElicitationRouter().handle(form, new AbortController().signal)).toEqual({ action: "cancel" })
})

it("cancels URL requests without opening a browser or asking for data", async () => {
	const router = new McpElicitationRouter()
	const signal = new AbortController().signal
	const ask = vi.fn(async () => undefined)
	const request = {
		method: "elicitation/create" as const,
		params: { mode: "url" as const, message: "Login", url: "https://example.com", elicitationId: "login" },
	}
	expect(await router.run({ signal, ask }, () => router.handle(request, signal))).toEqual({ action: "cancel" })
	expect(ask).not.toHaveBeenCalled()
})

it("cancels an outstanding question when its originating call ends", async () => {
	const router = new McpElicitationRouter()
	const signal = new AbortController().signal
	let pending!: Promise<unknown>
	let questionSignal!: AbortSignal
	await router.run(
		{
			signal,
			ask: (_message, _schema, ownedSignal) => {
				questionSignal = ownedSignal
				return new Promise(() => {})
			},
		},
		async () => {
			pending = router.handle(form, signal)
		},
	)
	expect(await pending).toEqual({ action: "cancel" })
	expect(questionSignal.aborted).toBe(true)
})

it.each([
	['{"region":"east"}', { action: "accept", content: { region: "east" } }],
	['{"region":"invalid"}', { action: "decline" }],
	['{"region":"east","secret":"extra"}', { action: "decline" }],
	["not json", { action: "decline" }],
	[undefined, { action: "cancel" }],
])("validates the explicit human answer %s", async (answer, expected) => {
	const router = new McpElicitationRouter()
	const signal = new AbortController().signal
	const ask = vi.fn(async () => answer)
	const result = await router.run({ signal, ask }, () => router.handle(form, signal))
	expect(result).toEqual(expected)
	expect(ask).toHaveBeenCalledOnce()
})

it("cancels ambiguous cross-task requests without asking either task", async () => {
	const router = new McpElicitationRouter()
	const signal = new AbortController().signal
	const ask = vi.fn(async () => undefined)
	const result = await router.run({ signal, ask }, () =>
		router.run({ signal, ask }, () => router.handle(form, signal)),
	)
	expect(result).toEqual({ action: "cancel" })
	expect(ask).not.toHaveBeenCalled()
})

it.each(["owner", "server", "timeout"] as const)("cancels a held form on %s cancellation", async (cause) => {
	vi.useFakeTimers()
	const router = new McpElicitationRouter()
	const owner = new AbortController()
	const server = new AbortController()
	const result = router.run({ signal: owner.signal, ask: () => new Promise(() => {}) }, () =>
		router.handle(form, server.signal),
	)
	if (cause === "owner") owner.abort()
	else if (cause === "server") server.abort()
	else await vi.advanceTimersByTimeAsync(60_000)
	expect(await result).toEqual({ action: "cancel" })
	expect(vi.getTimerCount()).toBe(0)
})
