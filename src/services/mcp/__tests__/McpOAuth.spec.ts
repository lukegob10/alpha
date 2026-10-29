import { auth } from "@modelcontextprotocol/sdk/client/auth.js"
import type { SecretStorage } from "vscode"
import * as vscode from "vscode"
import { createMcpOAuthFetch } from "../McpOAuth"
import { t } from "../../../i18n"
import nock from "nock"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

vi.mock("@modelcontextprotocol/sdk/client/auth.js", async (original) => ({
	...(await original<typeof import("@modelcontextprotocol/sdk/client/auth.js")>()),
	auth: vi.fn(),
}))

function fixture() {
	const values = new Map<string, string>()
	const secrets = {
		get: vi.fn(async (key: string) => values.get(key)),
		store: vi.fn(async (key: string, value: string) => {
			values.set(key, value)
		}),
		delete: vi.fn(async (key: string) => {
			values.delete(key)
		}),
	} as unknown as SecretStorage
	const controller = new AbortController()
	const fetcher = vi.fn<typeof fetch>()
	const rawRequest = createMcpOAuthFetch(
		new URL("https://mcp.example/tools"),
		"global:test",
		secrets,
		controller.signal,
		fetcher,
	)
	const request: typeof fetch = (input, init) =>
		rawRequest(input, {
			method: "POST",
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
			...init,
		})
	return { request, rawRequest, fetcher, secrets, controller, values }
}

afterEach(() => {
	vi.useRealTimers()
	nock.disableNetConnect()
	vi.restoreAllMocks()
	vi.mocked(auth).mockReset()
})

it("leaves public server requests unchanged without starting authorization", async () => {
	const fixtureValue = fixture()
	fixtureValue.fetcher.mockResolvedValue(new Response("ok"))
	expect((await fixtureValue.request("https://mcp.example/tools")).status).toBe(200)
	expect(auth).not.toHaveBeenCalled()
	expect(fixtureValue.secrets.store).not.toHaveBeenCalled()
})

it("uses SDK discovery/refresh on 401 and retries only once with the saved credential", async () => {
	const { request, fetcher, secrets } = fixture()
	fetcher
		.mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
		.mockResolvedValueOnce(new Response("ok"))
	vi.mocked(auth).mockImplementationOnce(async (provider) => {
		await provider.saveTokens({ access_token: "rotated", token_type: "Bearer", issuer: "https://issuer.example" })
		return "AUTHORIZED"
	})
	expect((await request("https://mcp.example/tools")).status).toBe(200)
	expect(fetcher).toHaveBeenCalledTimes(2)
	expect(new Headers(fetcher.mock.calls[1][1]?.headers).get("Authorization")).toBe("Bearer rotated")
	expect(secrets.store).toHaveBeenCalledWith(
		expect.stringMatching(/^mcp\.oauth\.[a-f0-9]{64}\.tokens$/),
		expect.stringContaining("rotated"),
	)
})

it("does not forward credentials or requests to a different origin", async () => {
	const { request, fetcher } = fixture()
	await expect(request("https://attacker.example/tools")).rejects.toThrow("cross origins")
	expect(fetcher).not.toHaveBeenCalled()
})

it("never authorizes or replays an SDK tools/call using its transport-wide signal", async () => {
	const { rawRequest, fetcher } = fixture()
	let finish!: (response: Response) => void
	let dispatched!: () => void
	const started = new Promise<void>((resolve) => {
		dispatched = resolve
	})
	fetcher.mockImplementationOnce(async () => {
		dispatched()
		return new Promise<Response>((resolve) => {
			finish = resolve
		})
	})
	const transport = new StreamableHTTPClientTransport(new URL("https://mcp.example/tools"), { fetch: rawRequest })
	await transport.start()
	try {
		const sending = transport.send({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "write", arguments: {} },
		})
		const failed = expect(sending).rejects.toThrow()
		await started
		// Logical request cancellation does not close the shared transport. A
		// late 401 must still fail this dispatch without login or replay.
		finish(new Response(null, { status: 401 }))
		await failed
		expect(fetcher).toHaveBeenCalledTimes(1)
		expect(auth).not.toHaveBeenCalled()
	} finally {
		await transport.close()
	}
})

it("rejects cancellation before network access", async () => {
	const { request, fetcher, controller } = fixture()
	controller.abort(new Error("connection replaced"))
	await expect(request("https://mcp.example/tools")).rejects.toThrow("connection replaced")
	expect(fetcher).not.toHaveBeenCalled()
})

it("aborts held discovery HTTP when the authorization deadline expires", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
	const { request, fetcher } = fixture()
	let discoverySignal: AbortSignal | undefined
	let started!: () => void
	const discoveryStarted = new Promise<void>((resolve) => {
		started = resolve
	})
	fetcher.mockResolvedValueOnce(new Response(null, { status: 401 }))
	fetcher.mockImplementationOnce(async (_input, init) => {
		discoverySignal = init?.signal ?? undefined
		started()
		return new Promise<Response>(() => {})
	})
	vi.mocked(auth).mockImplementationOnce(async (_provider, options) => {
		await options.fetchFn!("https://issuer.example/.well-known/oauth-authorization-server")
		return "AUTHORIZED"
	})
	const result = request("https://mcp.example/tools")
	const rejected = expect(result).rejects.toThrow("timed out")
	await discoveryStarted
	expect(discoverySignal?.aborted).toBe(false)
	await vi.advanceTimersByTimeAsync(120_000)
	await rejected
	expect(discoverySignal?.aborted).toBe(true)
	expect(vi.getTimerCount()).toBe(0)
})

it("does not begin browser authorization after the calling request was cancelled at 401", async () => {
	const { request, fetcher } = fixture()
	const caller = new AbortController()
	fetcher.mockImplementationOnce(async () => {
		caller.abort(new Error("tool cancelled"))
		return new Response(null, { status: 401 })
	})
	const open = vi.spyOn(vscode.env, "openExternal")
	await expect(request("https://mcp.example/tools", { signal: caller.signal })).rejects.toThrow("tool cancelled")
	expect(auth).not.toHaveBeenCalled()
	expect(open).not.toHaveBeenCalled()
})

it("does not repeat authorization indefinitely if the new credential is rejected", async () => {
	const { request, fetcher } = fixture()
	fetcher.mockImplementation(async () => new Response(null, { status: 401 }))
	vi.mocked(auth).mockImplementationOnce(async (provider) => {
		await provider.saveTokens({ access_token: "rejected", token_type: "Bearer" })
		return "AUTHORIZED"
	})
	expect((await request("https://mcp.example/tools")).status).toBe(401)
	expect(fetcher).toHaveBeenCalledTimes(2)
})

it("requires explicit browser consent and closes the callback on refusal", async () => {
	const { request, fetcher } = fixture()
	fetcher.mockResolvedValue(new Response(null, { status: 401 }))
	vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined)
	const open = vi.spyOn(vscode.env, "openExternal")
	vi.mocked(auth).mockImplementationOnce(async (provider) => {
		await provider.redirectToAuthorization(new URL("https://issuer.example/authorize"))
		return "REDIRECT"
	})
	await expect(request("https://mcp.example/tools")).rejects.toThrow("declined")
	expect(open).not.toHaveBeenCalled()
})

it("rejects an insecure authorization endpoint before opening a browser", async () => {
	const { request, fetcher } = fixture()
	fetcher.mockResolvedValue(new Response(null, { status: 401 }))
	const open = vi.spyOn(vscode.env, "openExternal")
	vi.mocked(auth).mockImplementationOnce(async (provider) => {
		await provider.redirectToAuthorization(new URL("http://issuer.example/authorize"))
		return "REDIRECT"
	})
	await expect(request("https://mcp.example/tools")).rejects.toThrow("HTTPS")
	expect(open).not.toHaveBeenCalled()
})

it("validates callback state and exchanges the code with its connection-owned PKCE verifier", async () => {
	nock.enableNetConnect("127.0.0.1")
	const { request, fetcher } = fixture()
	fetcher.mockResolvedValueOnce(new Response(null, { status: 401 })).mockResolvedValueOnce(new Response("ok"))
	vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(t("common:mcpOAuth.openBrowser") as never)
	let callbackUrl = ""
	let expectedState = ""
	vi.spyOn(vscode.env, "openExternal").mockImplementation(async () => {
		const wrong = await fetch(callbackUrl + "?state=wrong&code=wrong")
		expect(wrong.status).toBe(400)
		const correct = await fetch(callbackUrl + "?state=" + expectedState + "&code=verified")
		expect(correct.status).toBe(200)
		return true
	})
	vi.mocked(auth)
		.mockImplementationOnce(async (provider) => {
			callbackUrl = String(provider.redirectUrl)
			await provider.saveCodeVerifier("pkce-verifier")
			const url = new URL("https://issuer.example/authorize")
			expectedState = await provider.state!()
			url.searchParams.set("state", expectedState)
			await provider.redirectToAuthorization(url)
			return "REDIRECT"
		})
		.mockImplementationOnce(async (provider, options) => {
			expect(options.authorizationCode).toBe("verified")
			expect(await provider.codeVerifier()).toBe("pkce-verifier")
			await provider.saveTokens({ access_token: "signed-in", token_type: "Bearer" })
			return "AUTHORIZED"
		})
	expect((await request("https://mcp.example/tools")).status).toBe(200)
})
