import { createHash, generateKeyPairSync, sign } from "node:crypto"
import nock from "nock"
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createConnection } from "node:net"

import { ChatGptAuthService, type ChatGptSignInOptions } from "../ChatGptAuthService"

const SECRET_KEY = "alpha.chatgpt.registrations.v1"
const ISSUER = "https://auth.openai.com"
const now = Date.parse("2026-10-28T12:00:00Z")
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" }
const services: ChatGptAuthService[] = []
const directories: string[] = []

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((settle) => (resolve = settle))
	return { promise, resolve }
}

function jwt(claims: Record<string, unknown>, options: { signature?: string; issuer?: string } = {}) {
	const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key" })).toString("base64url")
	const payload = Buffer.from(
		JSON.stringify({ iss: options.issuer ?? ISSUER, sub: "user-one", exp: now / 1000 + 3600, ...claims }),
	).toString("base64url")
	const signature =
		options.signature ?? sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url")
	return `${header}.${payload}.${signature}`
}

function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), { status })
}

function rawCallbackRequest(authorize: URL, target: string): Promise<string> {
	const callback = new URL(authorize.searchParams.get("redirect_uri")!)
	return new Promise((resolve, reject) => {
		const socket = createConnection({ host: "127.0.0.1", port: Number(callback.port) })
		let response = ""
		socket.setEncoding("utf8")
		socket.setTimeout(2000, () => socket.destroy(new Error("Callback test socket timed out")))
		socket.on("data", (data) => {
			response += data
		})
		socket.once("error", reject)
		socket.once("close", () => resolve(response))
		socket.once("connect", () =>
			socket.end(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${callback.port}\r\nConnection: close\r\n\r\n`),
		)
	})
}

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "alpha-chatgpt-auth-test-"))
	directories.push(directory)
	const secrets = new Map<string, string>()
	const global = new Map<string, unknown>()
	const secretListeners = new Set<(event: { key: string }) => void>()
	const secretStore = {
		get: vi.fn(async (key: string) => secrets.get(key)),
		store: vi.fn(async (key: string, value: string) => {
			secrets.set(key, value)
			for (const listener of secretListeners) listener({ key })
		}),
		delete: vi.fn(async (key: string) => {
			secrets.delete(key)
			for (const listener of secretListeners) listener({ key })
		}),
		onDidChange: (listener: (event: { key: string }) => void) => {
			secretListeners.add(listener)
			return { dispose: () => secretListeners.delete(listener) }
		},
	}
	const opened: URL[] = []
	const waiters: Array<(url: URL) => void> = []
	let latest!: URL
	let subject = "user-one"
	let identityOverrides: Record<string, unknown> = {}
	let signature: string | undefined
	let scopes = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
	let tokenHandler: ((body: URLSearchParams) => Promise<Response> | Response) | undefined
	let revokeHandler: (() => Promise<Response> | Response) | undefined
	const tokenEntered = deferred<void>()
	const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input)
		if (url === `${ISSUER}/.well-known/openid-configuration`)
			return json({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks`, revocation_endpoint: `${ISSUER}/revoke` })
		if (url === `${ISSUER}/jwks`) return json({ keys: [jwk] })
		if (url === `${ISSUER}/revoke`) return revokeHandler ? revokeHandler() : new Response(null, { status: 200 })
		if (url === "https://api.openai.com/v1/models")
			return json({
				models: [
					{ slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" },
					{ slug: "hidden", visibility: "hide" },
				],
			})
		if (url === `${ISSUER}/api/accounts/oauth/token`) {
			const body = new URLSearchParams(String(init?.body))
			tokenEntered.resolve()
			if (tokenHandler) return tokenHandler(body)
			return json({
				access_token: "access-one",
				refresh_token: "refresh-one",
				id_token: jwt(
					{
						aud: body.get("client_id"),
						nonce: latest.searchParams.get("nonce"),
						email: "same@example.test",
						sub: subject,
						...identityOverrides,
					},
					{ signature },
				),
				token_type: "Bearer",
				expires_in: 3600,
				scope: scopes,
			})
		}
		throw new Error("Unexpected test endpoint")
	}) as unknown as typeof fetch & ReturnType<typeof vi.fn>
	const create = (options: { observe?: boolean } = {}) => {
		const service = new ChatGptAuthService({
			secrets:
				options.observe === false
					? { get: secretStore.get, store: secretStore.store, delete: secretStore.delete }
					: secretStore,
			storagePath: join(directory, "auth-transaction"),
			globalState: {
				get: <T>(key: string) => global.get(key) as T | undefined,
				update: async (key, value) => {
					global.set(key, value)
				},
			},
			openExternal: async (url) => {
				latest = new URL(url)
				const waiter = waiters.shift()
				if (waiter) waiter(latest)
				else opened.push(latest)
				return true
			},
			fetch: fetcher,
			now: () => now,
		})
		services.push(service)
		return service
	}
	const service = create()
	const nextBrowser = () =>
		opened.length ? Promise.resolve(opened.shift()!) : new Promise<URL>((resolve) => waiters.push(resolve))
	const callback = async (authorize: URL, values: Record<string, string> = {}) => {
		const url = new URL(authorize.searchParams.get("redirect_uri")!)
		url.searchParams.set("state", authorize.searchParams.get("state")!)
		url.searchParams.set("code", "test-code")
		url.searchParams.set(
			"client_id",
			authorize.searchParams.get("client_id") === "dynamic_agent_client"
				? "oaiapp_one"
				: authorize.searchParams.get("client_id")!,
		)
		for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value)
		return fetch(url)
	}
	const login = async (options?: ChatGptSignInOptions, values?: Record<string, string>) => {
		const operation = service.signIn(options)
		const browser = await nextBrowser()
		await callback(browser, values)
		return { operation, browser }
	}
	return {
		service,
		create,
		secrets,
		secretStore,
		global,
		fetcher,
		nextBrowser,
		callback,
		login,
		tokenEntered,
		setSubject: (value: string) => {
			subject = value
		},
		setIdentity: (value: Record<string, unknown>) => {
			identityOverrides = value
		},
		setSignature: (value: string) => {
			signature = value
		},
		setScopes: (value: string) => {
			scopes = value
		},
		setTokenHandler: (value: typeof tokenHandler) => {
			tokenHandler = value
		},
		setRevokeHandler: (value: typeof revokeHandler) => {
			revokeHandler = value
		},
		stored: () => JSON.parse(secrets.get(SECRET_KEY)!),
	}
}

beforeEach(() => nock.enableNetConnect(/^127\.0\.0\.1(?::\d+)?$/))

afterEach(async () => {
	for (const service of services.splice(0)) await service.dispose()
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
	nock.disableNetConnect()
	vi.useRealTimers()
})

describe("official ChatGPT authentication", () => {
	it("registers its own PKCE client, verifies identity, and keeps tokens out of status", async () => {
		const f = fixture()
		expect(f.fetcher).not.toHaveBeenCalled()
		const changes: unknown[] = []
		f.service.onDidChangeStatus((status) => changes.push(status))
		const { operation, browser } = await f.login()
		const status = await operation
		expect(browser.origin).toBe(ISSUER)
		expect(browser.pathname).toBe("/api/accounts/authorize")
		expect(browser.searchParams.get("client_id")).toBe("dynamic_agent_client")
		expect(browser.searchParams.get("agent_name_hint")).toBe("Alpha Code")
		expect(browser.searchParams.get("scope")).toContain("chatgpt.tokens.use.direct")
		expect(browser.searchParams.get("ext_agent_host_id")).toMatch(/^urn:uuid:/)
		const tokenCall = f.fetcher.mock.calls.find(([url]) => String(url).endsWith("/oauth/token"))!
		const body = new URLSearchParams(String(tokenCall[1]?.body))
		expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(
			browser.searchParams.get("code_challenge"),
		)
		expect(body.get("client_id")).toBe("oaiapp_one")
		expect(body.get("redirect_uri")).toBe(browser.searchParams.get("redirect_uri"))
		expect(body.has("client_secret")).toBe(false)
		expect(status).toMatchObject({
			connected: true,
			email: "same@example.test",
			accountId: "oaiapp_one",
			availableModelIds: ["gpt-6.1-sol"],
		})
		expect(JSON.stringify(changes)).not.toMatch(/access-one|refresh-one|idToken|subject/)
		expect(f.stored().accounts[0].tokens.refreshToken).toBe("refresh-one")
		expect(await f.service.getAccessToken()).toBe("access-one")
		expect(f.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/models"))).toHaveLength(1)
	})

	it("rejects invalid callback state without consuming a valid pending sign-in", async () => {
		const f = fixture()
		const operation = f.service.signIn()
		const browser = await f.nextBrowser()
		expect((await f.callback(browser, { state: "attacker" })).status).toBe(400)
		expect(f.fetcher).not.toHaveBeenCalled()
		await f.callback(browser)
		await expect(operation).resolves.toMatchObject({ connected: true })
	})

	it("rejects malformed, absolute, authority, and oversized request targets without ending sign-in", async () => {
		const f = fixture()
		const operation = f.service.signIn()
		const browser = await f.nextBrowser()
		for (const target of [
			"http://[bad",
			"http://attacker.test/auth/callback",
			"//attacker.test/auth/callback",
			"/\\attacker.test/auth/callback",
			`/auth/callback?padding=${"x".repeat(8192)}`,
		]) {
			expect(await rawCallbackRequest(browser, target)).toMatch(/^HTTP\/1\.1 400 /)
		}
		expect(f.fetcher).not.toHaveBeenCalled()
		await f.callback(browser)
		await expect(operation).resolves.toMatchObject({ connected: true })
	})

	it.each([
		{ name: "nonce", overrides: { nonce: "wrong" } },
		{ name: "audience", overrides: { aud: "another-client" } },
		{ name: "issuer", overrides: { iss: "https://attacker.test" } },
		{ name: "expiration", overrides: { exp: now / 1000 - 1 } },
		{ name: "subject", overrides: { sub: "" } },
	])("rejects a signed ID token with invalid $name", async ({ overrides }) => {
		const f = fixture()
		f.setIdentity(overrides)
		const operation = f.service.signIn()
		const assertion = expect(operation).rejects.toThrow("identity validation failed")
		const browser = await f.nextBrowser()
		await f.callback(browser)
		await assertion
		expect(f.secrets.size).toBe(0)
	})

	it("verifies the ID-token signature", async () => {
		const f = fixture()
		f.setSignature(Buffer.alloc(256).toString("base64url"))
		const operation = f.service.signIn()
		const assertion = expect(operation).rejects.toThrow("identity validation failed")
		await f.callback(await f.nextBrowser())
		await assertion
		expect(f.secrets.size).toBe(0)
	})

	it("retains a validated registration without enabling inference when direct consent is missing", async () => {
		const f = fixture()
		f.setScopes("openid profile email offline_access")
		const operation = f.service.signIn()
		const assertion = expect(operation).rejects.toThrow("plan usage was not enabled")
		await f.callback(await f.nextBrowser())
		await assertion
		expect(await f.service.getStatus()).toMatchObject({ connected: false, email: "same@example.test" })
		expect(f.stored().accounts[0].subject).toBe("user-one")
		await expect(f.service.getAccessToken()).rejects.toThrow("enable plan usage")
		expect(f.fetcher.mock.calls.some(([url]) => String(url).endsWith("/models"))).toBe(false)
	})

	it("cancels the loopback listener promptly and makes no token request", async () => {
		const f = fixture()
		const operation = f.service.signIn()
		const assertion = expect(operation).rejects.toMatchObject({ name: "AbortError" })
		const browser = await f.nextBrowser()
		f.service.cancelSignIn()
		await assertion
		expect(await f.service.getStatus()).toMatchObject({ connected: false, connecting: false })
		await expect(f.callback(browser)).rejects.toThrow()
		expect(f.fetcher).not.toHaveBeenCalled()
	})

	it("times out the browser callback and closes its listener", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const f = fixture()
		const operation = f.service.signIn({ timeoutMs: 1000 })
		const assertion = expect(operation).rejects.toMatchObject({ name: "TimeoutError" })
		const browser = await f.nextBrowser()
		await vi.advanceTimersByTimeAsync(1000)
		await assertion
		expect((await f.service.getStatus()).connecting).toBe(false)
		await expect(f.callback(browser)).rejects.toThrow()
	})

	it("times out a token endpoint that ignores cancellation without persisting credentials", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const f = fixture()
		const entered = deferred<void>()
		f.setTokenHandler(() => {
			entered.resolve()
			return new Promise(() => undefined)
		})
		const operation = f.service.signIn()
		const assertion = expect(operation).rejects.toMatchObject({ name: "TimeoutError" })
		await f.callback(await f.nextBrowser())
		await entered.promise
		await vi.advanceTimersByTimeAsync(30_000)
		await assertion
		expect(f.secrets.has(SECRET_KEY)).toBe(false)
		expect(f.fetcher.mock.calls.every(([, request]) => request?.redirect === "error")).toBe(true)
	})

	it("reauthorizes with the issued client and preserves its identity and host", async () => {
		const f = fixture()
		const first = await f.login()
		await first.operation
		const second = await f.login()
		await second.operation
		expect(second.browser.searchParams.get("client_id")).toBe("oaiapp_one")
		expect(second.browser.searchParams.has("agent_name_hint")).toBe(false)
		expect(second.browser.searchParams.get("id_token_hint")).toBeTruthy()
		expect(second.browser.searchParams.get("ext_agent_host_id")).toBe(
			first.browser.searchParams.get("ext_agent_host_id"),
		)
		f.setSubject("different-user")
		const operation = f.service.signIn()
		const assertion = expect(operation).rejects.toThrow("different account")
		await f.callback(await f.nextBrowser())
		await assertion
		expect(f.stored().accounts[0].subject).toBe("user-one")
	})

	it("keeps same-email registrations separate and loads the catalog only on connection changes", async () => {
		const f = fixture()
		const first = await f.login()
		await first.operation
		const oldSession = (await f.service.authorizeRequest()).signal
		f.setSubject("user-two")
		const second = await f.login({ newAccount: true }, { client_id: "oaiapp_two" })
		await second.operation
		expect(oldSession.aborted).toBe(true)
		expect((await f.service.getStatus()).accounts).toHaveLength(2)
		await f.service.selectAccount("oaiapp_one")
		expect((await f.service.getStatus()).accountId).toBe("oaiapp_one")
		await f.service.getAccessToken()
		await f.service.getAccessToken()
		expect(f.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/models"))).toHaveLength(3)
	})

	it("refreshes a rejected credential before scheduled refresh when the issuer permits it", async () => {
		const f = fixture()
		await (
			await f.login()
		).operation
		const admitted = await f.service.authorizeRequest()
		f.setTokenHandler(() =>
			json({ access_token: "access-two", refresh_token: "refresh-two", token_type: "Bearer", expires_in: 3600 }),
		)
		const recovered = await f.service.recoverUnauthorizedRequest(admitted)
		expect(recovered).toEqual({ accessToken: "access-two", signal: admitted.signal })
		expect(f.stored().accounts[0].tokens.refreshToken).toBe("refresh-two")
		expect(f.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/oauth/token"))).toHaveLength(2)
	})

	it.each(["issuer", "legacy"] as const)("honors the %s not-before limit during 401 recovery", async (kind) => {
		const f = fixture()
		await (
			await f.login()
		).operation
		const saved = f.stored()
		if (kind === "issuer") saved.accounts[0].tokens.earliestRefreshAt = now + 120_000
		else delete saved.accounts[0].tokens.earliestRefreshAt
		f.secrets.set(SECRET_KEY, JSON.stringify(saved))
		const service = f.create()
		const admitted = await service.authorizeRequest()
		await expect(service.recoverUnauthorizedRequest(admitted)).resolves.toEqual(admitted)
		expect(f.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/oauth/token"))).toHaveLength(1)
	})

	it("rejects recovery from an older account generation", async () => {
		const f = fixture()
		await (
			await f.login()
		).operation
		const admitted = await f.service.authorizeRequest()
		await f.service.selectAccount("oaiapp_one")
		await expect(f.service.recoverUnauthorizedRequest(admitted)).rejects.toMatchObject({ name: "AbortError" })
		expect(f.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/oauth/token"))).toHaveLength(1)
	})

	it("shares concurrent admission recovery while a cancelled caller leaves token rotation owned", async () => {
		const f = fixture()
		await (
			await f.login()
		).operation
		const admitted = await f.service.authorizeRequest()
		const entered = deferred<void>()
		const response = deferred<Response>()
		f.setTokenHandler(() => {
			entered.resolve()
			return response.promise
		})
		const controller = new AbortController()
		const first = f.service.recoverUnauthorizedRequest(admitted, controller.signal)
		const cancelled = expect(first).rejects.toMatchObject({ name: "AbortError" })
		await entered.promise
		const other = f.service.recoverUnauthorizedRequest(admitted)
		controller.abort()
		await cancelled
		response.resolve(
			json({ access_token: "access-two", refresh_token: "refresh-two", token_type: "Bearer", expires_in: 3600 }),
		)
		await expect(other).resolves.toEqual({ accessToken: "access-two", signal: admitted.signal })
		expect(f.stored().accounts[0].tokens.refreshToken).toBe("refresh-two")
		expect(f.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/oauth/token"))).toHaveLength(2)
	})

	it("does not return recovered credentials after the selected account generation changes mid-refresh", async () => {
		const f = fixture()
		await (
			await f.login()
		).operation
		const admitted = await f.service.authorizeRequest()
		const entered = deferred<void>()
		const response = deferred<Response>()
		f.setTokenHandler(() => {
			entered.resolve()
			return response.promise
		})
		const recovery = f.service.recoverUnauthorizedRequest(admitted)
		const rejected = expect(recovery).rejects.toMatchObject({ name: "AbortError" })
		await entered.promise
		const generationChanged = new Promise<void>((resolve) =>
			admitted.signal.addEventListener("abort", () => resolve(), { once: true }),
		)
		const selected = f.service.selectAccount("oaiapp_one")
		await generationChanged
		await rejected
		response.resolve(
			json({ access_token: "access-two", refresh_token: "refresh-two", token_type: "Bearer", expires_in: 3600 }),
		)
		await selected
		expect(f.stored().accounts[0].tokens.refreshToken).toBe("refresh-two")
	})

	it("reuses another window's rotated token instead of refreshing its replacement", async () => {
		const f = fixture()
		await (
			await f.login()
		).operation
		const service = f.create({ observe: false })
		const admitted = await service.authorizeRequest()
		const saved = f.stored()
		saved.accounts[0].tokens.accessToken = "access-two"
		saved.accounts[0].tokens.refreshToken = "refresh-two"
		f.secrets.set(SECRET_KEY, JSON.stringify(saved))
		await expect(service.recoverUnauthorizedRequest(admitted)).resolves.toMatchObject({ accessToken: "access-two" })
		expect(f.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/oauth/token"))).toHaveLength(1)
	})

	it("serializes rotating refresh and persists its result after one caller cancels", async () => {
		const f = fixture()
		const first = await f.login()
		await first.operation
		const saved = f.stored()
		saved.accounts[0].tokens.refreshAt = now - 1
		f.secrets.set(SECRET_KEY, JSON.stringify(saved))
		const service = f.create()
		const entered = deferred<void>()
		const response = deferred<Response>()
		f.setTokenHandler((body) => {
			expect(body.get("grant_type")).toBe("refresh_token")
			expect(body.get("client_id")).toBe("oaiapp_one")
			entered.resolve()
			return response.promise
		})
		const controller = new AbortController()
		const cancelled = service.getAccessToken(controller.signal)
		const assertion = expect(cancelled).rejects.toMatchObject({ name: "AbortError" })
		await entered.promise
		const other = service.getAccessToken()
		controller.abort()
		await assertion
		response.resolve(
			json({ access_token: "access-two", refresh_token: "refresh-two", token_type: "Bearer", expires_in: 3600 }),
		)
		await expect(other).resolves.toBe("access-two")
		expect(f.stored().accounts[0].tokens.refreshToken).toBe("refresh-two")
		expect(f.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/oauth/token"))).toHaveLength(2)
	})

	it("retries persistence of a rotated token without exchanging the consumed refresh token again", async () => {
		const f = fixture()
		await (
			await f.login()
		).operation
		const saved = f.stored()
		saved.accounts[0].tokens.refreshAt = now - 1
		f.secrets.set(SECRET_KEY, JSON.stringify(saved))
		const service = f.create()
		f.setTokenHandler(() =>
			json({ access_token: "access-two", refresh_token: "refresh-two", token_type: "Bearer", expires_in: 3600 }),
		)
		f.secretStore.store.mockRejectedValueOnce(new Error("secret-do-not-display"))
		await expect(service.getAccessToken()).rejects.toThrow("Could not save ChatGPT credentials")
		expect(f.stored().accounts[0].tokens.refreshToken).toBe("refresh-one")
		await expect(service.getAccessToken()).resolves.toBe("access-two")
		expect(f.stored().accounts[0].tokens.refreshToken).toBe("refresh-two")
		expect(f.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/oauth/token"))).toHaveLength(2)
	})

	it("reloads another window's rotation under the credential lock before exchanging a stale refresh token", async () => {
		const f = fixture()
		await (
			await f.login()
		).operation
		const saved = f.stored()
		saved.accounts[0].tokens.refreshAt = now - 1
		f.secrets.set(SECRET_KEY, JSON.stringify(saved))
		const first = f.create({ observe: false })
		const second = f.create({ observe: false })
		await first.getStatus()
		await second.getStatus()
		let exchanges = 0
		f.setTokenHandler((body) => {
			exchanges++
			expect(body.get("refresh_token")).toBe("refresh-one")
			return exchanges === 1
				? json({
						access_token: "access-two",
						refresh_token: "refresh-two",
						token_type: "Bearer",
						expires_in: 3600,
					})
				: json({ error: "invalid_grant" }, 400)
		})
		await expect(first.getAccessToken()).resolves.toBe("access-two")
		await expect(second.getAccessToken()).resolves.toBe("access-two")
		expect(exchanges).toBe(1)
		expect(f.stored().accounts[0].tokens.refreshToken).toBe("refresh-two")
	})

	it("keeps the cross-window refresh lease until a pending rotation can be saved", async () => {
		const f = fixture()
		await (
			await f.login()
		).operation
		const saved = f.stored()
		saved.accounts[0].tokens.refreshAt = now - 1
		f.secrets.set(SECRET_KEY, JSON.stringify(saved))
		const first = f.create({ observe: false })
		const second = f.create({ observe: false })
		await first.getStatus()
		await second.getStatus()
		let exchanges = 0
		f.setTokenHandler(() => {
			exchanges++
			return exchanges === 1
				? json({
						access_token: "access-two",
						refresh_token: "refresh-two",
						token_type: "Bearer",
						expires_in: 3600,
					})
				: json({ error: "invalid_grant" }, 400)
		})
		f.secretStore.store.mockRejectedValueOnce(new Error("locked-system-store"))
		await expect(first.getAccessToken()).rejects.toThrow("Could not save")
		const waiting = second.getAccessToken()
		await expect(first.getAccessToken()).resolves.toBe("access-two")
		await expect(waiting).resolves.toBe("access-two")
		expect(exchanges).toBe(1)
		expect(f.stored().accounts[0].tokens.refreshToken).toBe("refresh-two")
	})

	it("observes another window's sign-out and cancels its in-flight session", async () => {
		const f = fixture()
		await (
			await f.login()
		).operation
		const second = f.create()
		const admitted = await second.authorizeRequest()
		const disconnected = deferred<void>()
		second.onDidChangeStatus((status) => {
			if (!status.connected) disconnected.resolve()
		})
		await f.service.signOut()
		await disconnected.promise
		expect(admitted.signal.aborted).toBe(true)
		await expect(second.authorizeRequest()).rejects.toThrow("Sign in")
	})

	it("aborts requests admitted during an account switch before publishing the new account", async () => {
		const f = fixture()
		await (
			await f.login()
		).operation
		f.setSubject("user-two")
		await (
			await f.login({ newAccount: true }, { client_id: "oaiapp_two" })
		).operation
		const entered = deferred<void>()
		const release = deferred<void>()
		f.secretStore.store.mockImplementationOnce(async (key, value) => {
			entered.resolve()
			await release.promise
			f.secrets.set(key, value)
		})
		const switching = f.service.selectAccount("oaiapp_one")
		await entered.promise
		const during = await f.service.authorizeRequest()
		let observed = false
		f.service.onDidChangeStatus((status) => {
			if (status.accountId === "oaiapp_one") {
				expect(during.signal.aborted).toBe(true)
				observed = true
			}
		})
		release.resolve()
		await switching
		expect(observed).toBe(true)
		expect(during.signal.aborted).toBe(true)
		expect((await f.service.authorizeRequest()).signal.aborted).toBe(false)
	})

	it.each([
		{ code: "invalid_grant", clears: true },
		{ code: "temporarily_unavailable", clears: false },
	])("handles refresh $code without losing the client registration", async ({ code, clears }) => {
		const f = fixture()
		const first = await f.login()
		await first.operation
		const saved = f.stored()
		saved.accounts[0].tokens.refreshAt = now - 1
		f.secrets.set(SECRET_KEY, JSON.stringify(saved))
		const service = f.create()
		f.setTokenHandler(() => json({ error: code, error_description: "secret-do-not-display" }, clears ? 400 : 503))
		await expect(service.getAccessToken()).rejects.toThrow("HTTP")
		expect(f.stored().accounts[0].id).toBe("oaiapp_one")
		expect(Boolean(f.stored().accounts[0].tokens)).toBe(!clears)
	})

	it("revokes the renewable session, aborts requests, and retains registration after local sign-out", async () => {
		const f = fixture()
		const first = await f.login()
		await first.operation
		const authorized = await f.service.authorizeRequest()
		await f.service.signOut()
		expect(authorized.signal.aborted).toBe(true)
		expect(f.stored().accounts[0].tokens).toBeUndefined()
		expect((await f.service.getStatus()).accounts).toEqual([
			{ id: "oaiapp_one", email: "same@example.test", connected: false },
		])
		const revokeCall = f.fetcher.mock.calls.find(([url]) => String(url).endsWith("/revoke"))!
		expect(new URLSearchParams(String(revokeCall[1]?.body)).get("token")).toBe("refresh-one")
		await expect(f.service.getAccessToken()).rejects.toThrow("Sign in")
		const next = await f.login()
		await next.operation
		expect(next.browser.searchParams.get("client_id")).toBe("oaiapp_one")
		expect(next.browser.searchParams.has("id_token_hint")).toBe(false)
	})

	it("finishes local sign-out and reports unconfirmed remote revocation", async () => {
		const f = fixture()
		const first = await f.login()
		await first.operation
		f.setRevokeHandler(() => json({ error: "denied", error_description: "secret-do-not-display" }, 403))
		await expect(f.service.signOut()).rejects.toThrow("Remote revocation was not confirmed")
		expect(f.stored().accounts[0].tokens).toBeUndefined()
		expect((await f.service.getStatus()).connected).toBe(false)
	})

	it("keeps inference disconnected if clearing credentials fails during sign-out", async () => {
		const f = fixture()
		await (
			await f.login()
		).operation
		const request = await f.service.authorizeRequest()
		f.setRevokeHandler(() => json({ error: "denied" }, 403))
		f.secretStore.store.mockRejectedValueOnce(new Error("system-storage-failed"))
		await expect(f.service.signOut()).rejects.toThrow("Could not save ChatGPT credentials")
		expect(request.signal.aborted).toBe(true)
		expect((await f.service.getStatus()).connected).toBe(false)
		await expect(f.service.authorizeRequest()).rejects.toThrow("Sign in")
		await (
			await f.login()
		).operation
		expect((await f.service.getStatus()).connected).toBe(true)
	})

	it("does not resurrect tokens when sign-out races a successful code exchange", async () => {
		const f = fixture()
		const entered = deferred<void>()
		const response = deferred<Response>()
		f.setTokenHandler(() => {
			entered.resolve()
			return response.promise
		})
		const operation = f.service.signIn()
		const assertion = expect(operation).rejects.toMatchObject({ name: "AbortError" })
		const browser = await f.nextBrowser()
		await f.callback(browser)
		await entered.promise
		const logout = f.service.signOut()
		let signedOut = false
		void logout.then(() => {
			signedOut = true
		})
		await assertion
		expect(signedOut).toBe(false)
		response.resolve(
			json({
				access_token: "access-late",
				refresh_token: "refresh-late",
				id_token: jwt({ aud: "oaiapp_one", nonce: browser.searchParams.get("nonce") }),
				token_type: "Bearer",
				expires_in: 3600,
				scope: "chatgpt.tokens.use.direct",
			}),
		)
		await logout
		expect((await f.service.getStatus()).connected).toBe(false)
		expect(f.stored().accounts.every((account: { tokens?: unknown }) => !account.tokens)).toBe(true)
		expect(
			f.fetcher.mock.calls.some(
				([url, request]) =>
					String(url).endsWith("/revoke") &&
					new URLSearchParams(String(request?.body)).get("token") === "refresh-late",
			),
		).toBe(true)
	})

	it("resets all accounts and credentials while retaining the stable host ID", async () => {
		const f = fixture()
		const first = await f.login()
		await first.operation
		f.setSubject("user-two")
		await (
			await f.login({ newAccount: true }, { client_id: "oaiapp_two" })
		).operation
		const active = await f.service.authorizeRequest()
		await f.service.resetAccounts()
		expect(active.signal.aborted).toBe(true)
		expect(f.secrets.has(SECRET_KEY)).toBe(false)
		expect(await f.service.getStatus()).toMatchObject({ connected: false, connecting: false, accounts: [] })
		expect(f.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/revoke"))).toHaveLength(2)
		const next = await f.login()
		await next.operation
		expect(next.browser.searchParams.get("ext_agent_host_id")).toBe(
			first.browser.searchParams.get("ext_agent_host_id"),
		)
		expect(next.browser.searchParams.get("client_id")).toBe("dynamic_agent_client")
	})

	it.each(["signOut", "resetAccounts"] as const)(
		"%s joins an older cancelled exchange after a newer sign-in finishes",
		async (action) => {
			const f = fixture()
			const entered = deferred<void>()
			const response = deferred<Response>()
			f.setTokenHandler(() => {
				entered.resolve()
				return response.promise
			})
			const first = f.service.signIn()
			const cancelled = expect(first).rejects.toMatchObject({ name: "AbortError" })
			const browser = await f.nextBrowser()
			await f.callback(browser, { client_id: "oaiapp_older" })
			await entered.promise
			f.service.cancelSignIn()
			await cancelled
			f.setTokenHandler(undefined)
			await (
				await f.login({ newAccount: true }, { client_id: "oaiapp_newer" })
			).operation
			const persisted = deferred<void>()
			const store = f.secretStore.store.getMockImplementation()!
			f.secretStore.store.mockImplementation(async (key, value) => {
				await store(key, value)
				if (
					JSON.parse(value).accounts.some(
						(account: { id: string; tokens?: unknown }) => account.id === "oaiapp_older" && account.tokens,
					)
				)
					persisted.resolve()
			})
			const started = deferred<void>()
			f.service.onDidChangeStatus((status) => {
				if (!status.connected) started.resolve()
			})
			const cleanup = f.service[action]()
			await started.promise
			response.resolve(
				json({
					access_token: "access-older",
					refresh_token: "refresh-older",
					id_token: jwt({ aud: "oaiapp_older", nonce: browser.searchParams.get("nonce") }),
					token_type: "Bearer",
					expires_in: 3600,
					scope: "chatgpt.tokens.use.direct",
				}),
			)
			await persisted.promise
			await cleanup
			expect((await f.service.getStatus()).connected).toBe(false)
			if (action === "resetAccounts") expect(f.secrets.has(SECRET_KEY)).toBe(false)
			else expect(f.stored().accounts.every((account: { tokens?: unknown }) => !account.tokens)).toBe(true)
			expect(
				f.fetcher.mock.calls.some(
					([url, request]) =>
						String(url).endsWith("/revoke") &&
						new URLSearchParams(String(request?.body)).get("token") === "refresh-older",
				),
			).toBe(true)
		},
	)

	it("disposes every cancelled exchange and newer callback before returning", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const f = fixture()
		const entered = deferred<void>()
		const response = deferred<Response>()
		f.setTokenHandler(() => {
			entered.resolve()
			return response.promise
		})
		const first = f.service.signIn()
		const cancelledFirst = expect(first).rejects.toMatchObject({ name: "AbortError" })
		const firstBrowser = await f.nextBrowser()
		await f.callback(firstBrowser, { client_id: "oaiapp_older" })
		await entered.promise
		f.service.cancelSignIn()
		await cancelledFirst
		const second = f.service.signIn({ newAccount: true })
		const cancelledSecond = expect(second).rejects.toMatchObject({ name: "AbortError" })
		const secondBrowser = await f.nextBrowser()
		await f.service.dispose()
		await cancelledSecond
		expect(vi.getTimerCount()).toBe(0)
		await expect(f.callback(secondBrowser)).rejects.toThrow()
		response.resolve(
			json({
				access_token: "access-older",
				refresh_token: "refresh-older",
				id_token: "unused",
				token_type: "Bearer",
				expires_in: 3600,
				scope: "chatgpt.tokens.use.direct",
			}),
		)
		expect(f.secrets.has(SECRET_KEY)).toBe(false)
	})
})
