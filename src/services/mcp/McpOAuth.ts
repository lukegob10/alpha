import { createHash, randomUUID } from "node:crypto"
import { createServer } from "node:http"
import type { SecretStorage } from "vscode"
import * as vscode from "vscode"
import {
	auth,
	extractWWWAuthenticateParams,
	type OAuthClientProvider,
	type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js"
import {
	OAuthTokensSchema,
	OAuthClientInformationFullSchema,
	type OAuthTokens,
	type OAuthClientInformationMixed,
	type OAuthClientMetadata,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import { t } from "../../i18n"

type Fetch = typeof globalThis.fetch

function withAbort<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted()
	return new Promise((resolve, reject) => {
		const cancel = () => reject(signal.reason ?? new Error("MCP authorization cancelled"))
		signal.addEventListener("abort", cancel, { once: true })
		Promise.resolve(work).then(
			(value) => {
				signal.removeEventListener("abort", cancel)
				resolve(value)
			},
			(error) => {
				signal.removeEventListener("abort", cancel)
				reject(error)
			},
		)
		if (signal.aborted) cancel()
	})
}

function secureUrl(value: string | URL): URL {
	const url = new URL(value)
	if (
		url.username ||
		url.password ||
		(url.protocol !== "https:" &&
			!(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
	) {
		throw new Error("MCP authorization requires HTTPS or a loopback URL")
	}
	return url
}

/** SDK 2026 authorization flow; credentials are scoped to one configured server, never model-visible. */
export function createMcpOAuthFetch(
	serverUrl: URL,
	identity: string,
	secrets: SecretStorage,
	signal: AbortSignal,
	fetcher: Fetch = globalThis.fetch,
): Fetch {
	const server = secureUrl(serverUrl)
	const key = `mcp.oauth.${createHash("sha256")
		.update(identity + "\n" + server.href)
		.digest("hex")}`
	let pending: Promise<void> | undefined
	let verifier: string | undefined
	let redirectUrl: string | undefined
	let state: string | undefined
	let callback: ReturnType<typeof createServer> | undefined
	let receiveCode: Promise<string> | undefined
	let rejectCode: ((error: Error) => void) | undefined
	let timer: ReturnType<typeof setTimeout> | undefined
	let discovery: OAuthDiscoveryState | undefined
	let authSignal = signal
	const closeCallback = () => {
		if (timer) clearTimeout(timer)
		timer = undefined
		callback?.closeAllConnections()
		callback?.close()
		callback = undefined
	}
	const abort = () => {
		rejectCode?.(new Error("MCP authorization cancelled"))
		closeCallback()
	}
	const read = async (suffix: string) => {
		signal.throwIfAborted()
		const value = await secrets.get(`${key}.${suffix}`)
		return value ? JSON.parse(value) : undefined
	}
	const save = async (suffix: string, value: unknown) => {
		authSignal.throwIfAborted()
		await secrets.store(`${key}.${suffix}`, JSON.stringify(value))
	}
	const authFetch: Fetch = async (input, init) => {
		secureUrl(input instanceof Request ? input.url : input.toString())
		// Never forward a credential-bearing registration/token POST through a redirect.
		const operationSignal = authSignal
		return withAbort(fetcher(input, { ...init, redirect: "error", signal: operationSignal }), operationSignal)
	}
	const provider: OAuthClientProvider = {
		discoveryState: () => discovery,
		saveDiscoveryState: (value) => {
			discovery = value
		},
		get redirectUrl() {
			return redirectUrl
		},
		get clientMetadata(): OAuthClientMetadata {
			return {
				client_name: "Alpha Code",
				redirect_uris: redirectUrl ? [redirectUrl] : [],
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
				token_endpoint_auth_method: "none",
			}
		},
		state: () => (state ??= randomUUID()),
		clientInformation: async () => {
			const value = await read("client")
			if (value === undefined) return undefined
			const client = OAuthClientInformationFullSchema.parse(value)
			// Dynamic loopback ports change between login attempts. A new authorization
			// registers its exact callback; stored refresh tokens remain usable independently.
			const tokens = OAuthTokensSchema.safeParse(await read("tokens"))
			const canRefresh = tokens.success && Boolean(tokens.data.refresh_token)
			return !canRefresh && redirectUrl && !client.redirect_uris.includes(redirectUrl) ? undefined : client
		},
		saveClientInformation: (value: OAuthClientInformationMixed) => save("client", value),
		tokens: async () => {
			const value = await read("tokens")
			return value === undefined ? undefined : OAuthTokensSchema.parse(value)
		},
		saveTokens: (value: OAuthTokens) => save("tokens", value),
		saveCodeVerifier: (value) => {
			verifier = value
		},
		codeVerifier: () => {
			if (!verifier) throw new Error("MCP authorization verifier unavailable")
			return verifier
		},
		invalidateCredentials: async (scope) => {
			if (scope === "all" || scope === "client") await secrets.delete(`${key}.client`)
			if (scope === "all" || scope === "tokens") await secrets.delete(`${key}.tokens`)
			if (scope === "all" || scope === "verifier") verifier = undefined
		},
		redirectToAuthorization: async (url) => {
			secureUrl(url)
			authSignal.throwIfAborted()
			const answer = await withAbort(
				vscode.window.showInformationMessage(
					t("common:mcpOAuth.authorize", { server: server.origin, issuer: url.origin }),
					{ modal: true },
					t("common:mcpOAuth.openBrowser"),
				),
				authSignal,
			)
			authSignal.throwIfAborted()
			if (answer !== t("common:mcpOAuth.openBrowser")) throw new Error("MCP authorization declined")
			if (!(await vscode.env.openExternal(vscode.Uri.parse(url.href))))
				throw new Error("MCP authorization browser unavailable")
			if (!receiveCode) throw new Error("MCP callback unavailable")
			const code = await receiveCode
			closeCallback()
			const result = await auth(provider, { serverUrl: server, authorizationCode: code, fetchFn: authFetch })
			if (result !== "AUTHORIZED") throw new Error("MCP authorization incomplete")
		},
	}
	const authorize = async (response: Response) => {
		const challenge = extractWWWAuthenticateParams(response)
		const deadline = new AbortController()
		const operationSignal = AbortSignal.any([authSignal, deadline.signal])
		authSignal = operationSignal
		state = randomUUID()
		// Loopback listener exists only for this bounded, connection-owned authorization attempt.
		receiveCode = new Promise<string>((resolve, reject) => {
			rejectCode = reject
			callback = createServer((request, reply) => {
				const url = new URL(request.url ?? "/", "http://127.0.0.1")
				if (
					request.method !== "GET" ||
					url.pathname !== "/callback" ||
					url.searchParams.get("state") !== state
				) {
					reply.writeHead(400).end()
					return
				}
				const code = url.searchParams.get("code")
				reply
					.writeHead(code ? 200 : 400, { "Content-Type": "text/plain", "Cache-Control": "no-store" })
					.end(t("common:mcpOAuth.browserComplete"))
				if (code && code.length <= 8192) resolve(code)
				else reject(new Error("MCP authorization callback failed"))
			})
		})
		void receiveCode.catch(() => undefined)
		try {
			authSignal.throwIfAborted()
			authSignal.addEventListener("abort", abort, { once: true })
			timer = setTimeout(() => {
				deadline.abort(new Error("MCP authorization timed out"))
			}, 120_000)
			await new Promise<void>((resolve, reject) => {
				callback!.once("error", reject)
				callback!.listen(0, "127.0.0.1", resolve)
			})
			const address = callback!.address()
			if (!address || typeof address === "string") throw new Error("MCP callback address unavailable")
			redirectUrl = `http://127.0.0.1:${address.port}/callback`
			const result = await withAbort(
				auth(provider, { serverUrl: server, ...challenge, fetchFn: authFetch }),
				operationSignal,
			)
			if (result !== "AUTHORIZED" && !(await provider.tokens())) throw new Error("MCP authorization incomplete")
		} finally {
			authSignal.removeEventListener("abort", abort)
			closeCallback()
			verifier = undefined
			receiveCode = undefined
			rejectCode = undefined
		}
	}
	return async (input, init) => {
		const requestSignal = AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])])
		requestSignal.throwIfAborted()
		const target = new URL(input instanceof Request ? input.url : input.toString())
		if (target.origin !== server.origin) throw new Error("MCP credentials cannot cross origins")
		const headers = new Headers(init?.headers)
		const stored = await provider.tokens()
		if (stored) headers.set("Authorization", `Bearer ${stored.access_token}`)
		const request = () =>
			fetcher(input, {
				...init,
				headers,
				redirect: "error",
				signal: requestSignal,
			})
		const response = await request()
		if (response.status !== 401) return response
		// The SDK's fetch signal belongs to the transport, not an individual tool
		// request. Never replay a tools/call after interactive login: its logical
		// task may already have cancelled while the connection remains alive.
		let initialization = false
		if (typeof init?.body === "string") {
			try {
				const message: unknown = JSON.parse(init.body)
				initialization =
					typeof message === "object" &&
					message !== null &&
					"method" in message &&
					message.method === "initialize"
			} catch {
				/* Malformed protocol messages are not authorization entry points. */
			}
		}
		if (!initialization) return response
		await response.body?.cancel()
		requestSignal.throwIfAborted()
		if (!pending) {
			authSignal = requestSignal
			pending = authorize(response).finally(() => {
				pending = undefined
				authSignal = signal
			})
		}
		await withAbort(pending, requestSignal)
		requestSignal.throwIfAborted()
		const tokens = await provider.tokens()
		if (!tokens) throw new Error("MCP authorization token unavailable")
		headers.set("Authorization", `Bearer ${tokens.access_token}`)
		return request()
	}
}
