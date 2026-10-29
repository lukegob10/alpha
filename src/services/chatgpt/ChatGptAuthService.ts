import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from "node:crypto"
import { createServer, type Server } from "node:http"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import * as lockfile from "proper-lockfile"
import type { Memento, SecretStorage } from "vscode"
import type { ChatGptAuthStatus } from "@alpha-code/types"

const ISSUER = "https://auth.openai.com"
const RESOURCE = "https://api.openai.com/v1"
const TOKEN_ENDPOINT = `${ISSUER}/api/accounts/oauth/token`
const SECRET_KEY = "alpha.chatgpt.registrations.v1"
const HOST_KEY = "alpha.chatgpt.hostId.v1"
const DIRECT_SCOPE = "chatgpt.tokens.use.direct"
const SCOPES = `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`
const REQUEST_TIMEOUT = 30_000
const MAX_CALLBACK_TARGET_LENGTH = 8192

interface Tokens {
	accessToken: string
	refreshToken: string
	idToken: string
	expiresAt: number
	refreshAt: number
	/** Issuer refresh floor, retained separately from the proactive expiry margin. */
	earliestRefreshAt?: number
	scopes: string[]
}

export interface ChatGptRequestAuthorization {
	readonly accessToken: string
	/** Captures the selected account/session generation for the entire request. */
	readonly signal: AbortSignal
}

interface Registration {
	id: string
	subject: string
	email?: string
	tokens?: Tokens
	availableModelIds?: string[]
}

interface SavedAccounts {
	version: 1
	activeId?: string
	accounts: Registration[]
}

interface SignInAttempt {
	controller: AbortController
	signal: AbortSignal
	operation: Promise<ChatGptAuthStatus>
	accountId?: string
}

export interface ChatGptAuthDependencies {
	secrets: Pick<SecretStorage, "get" | "store" | "delete"> & Partial<Pick<SecretStorage, "onDidChange">>
	globalState: Pick<Memento, "get" | "update">
	openExternal: (url: string) => PromiseLike<boolean>
	/** Shared per-extension lock marker; contains no credentials. */
	storagePath?: string
	fetch?: typeof fetch
	now?: () => number
}

export interface ChatGptSignInOptions {
	accountId?: string
	newAccount?: boolean
	signal?: AbortSignal
	timeoutMs?: number
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined
}

function sameSecret(left: string, right: string): boolean {
	const a = Buffer.from(left)
	const b = Buffer.from(right)
	return a.length === b.length && timingSafeEqual(a, b)
}

function authError(message: string, code?: string, status?: number): Error {
	return Object.assign(new Error(message), {
		retryable: false,
		...(code ? { code } : {}),
		...(status ? { status } : {}),
	})
}

async function withAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return operation
	signal.throwIfAborted()
	let onAbort!: () => void
	const cancelled = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(signal.reason)
		signal.addEventListener("abort", onAbort, { once: true })
	})
	try {
		return await Promise.race([operation, cancelled])
	} finally {
		signal.removeEventListener("abort", onAbort)
	}
}

/**
 * App-owned SIWC registrations; never reads Codex/Claude credentials or private endpoints.
 * OAuth lifecycle reviewed against openai/codex 7ac6081 login/server.rs and
 * oauth_session_login_tests.rs on 2026-10-28. The public SIWC dynamic-client flow
 * intentionally differs from Codex's first-party client registration.
 */
export class ChatGptAuthService {
	private static instance?: ChatGptAuthService
	private readonly fetcher: typeof fetch
	private readonly now: () => number
	private readonly lifetime = new AbortController()
	private session = new AbortController()
	private readonly listeners = new Set<(status: ChatGptAuthStatus) => void>()
	private saved: SavedAccounts = { version: 1, accounts: [] }
	private loaded?: Promise<void>
	private writes: Promise<unknown> = Promise.resolve()
	private discovery?: Promise<Record<string, unknown>>
	private readonly refreshes = new Map<string, Promise<string>>()
	private readonly pendingRotations = new Map<string, Tokens>()
	private readonly disconnectedAccounts = new Set<string>()
	private pending?: SignInAttempt
	private readonly signInAttempts = new Set<SignInAttempt>()
	private signOutOperation?: Promise<void>
	private signingOut = false
	private credentialLockRelease?: () => Promise<void>
	private secretSubscription?: { dispose(): void }

	static initialize(dependencies: ChatGptAuthDependencies): ChatGptAuthService {
		return (this.instance ??= new ChatGptAuthService(dependencies))
	}

	static getInstance(): ChatGptAuthService {
		if (!this.instance) throw authError("ChatGPT sign-in is not initialized. Reload Alpha Code and try again.")
		return this.instance
	}

	static tryGetInstance(): ChatGptAuthService | undefined {
		return this.instance
	}

	constructor(private readonly dependencies: ChatGptAuthDependencies) {
		this.fetcher = dependencies.fetch ?? fetch
		this.now = dependencies.now ?? Date.now
		this.secretSubscription = dependencies.secrets.onDidChange?.((event) => {
			if (event.key !== SECRET_KEY || this.lifetime.signal.aborted) return
			const update = this.writes.then(async () => {
				await this.reload()
				this.emit()
			})
			this.writes = update.catch(() =>
				this.resetSession(authError("ChatGPT credentials changed and could not be read. Sign in again.")),
			)
		})
	}

	onDidChangeStatus(listener: (status: ChatGptAuthStatus) => void): { dispose(): void } {
		this.listeners.add(listener)
		return { dispose: () => this.listeners.delete(listener) }
	}

	async getStatus(): Promise<ChatGptAuthStatus> {
		await this.load()
		return this.status()
	}

	private status(): ChatGptAuthStatus {
		const active = this.saved.accounts.find(({ id }) => id === this.saved.activeId)
		return {
			connected:
				!this.signingOut &&
				Boolean(
					active && !this.disconnectedAccounts.has(active.id) && active.tokens?.scopes.includes(DIRECT_SCOPE),
				),
			connecting: Boolean(this.pending && !this.pending.signal.aborted),
			...(active
				? { accountId: active.id, email: active.email, availableModelIds: active.availableModelIds }
				: {}),
			accounts: this.saved.accounts.map(({ id, email, tokens }) => ({
				id,
				email,
				connected: !this.disconnectedAccounts.has(id) && Boolean(tokens?.scopes.includes(DIRECT_SCOPE)),
			})),
		}
	}

	private emit(): void {
		const status = this.status()
		for (const listener of this.listeners) {
			// A disposed presentation surface cannot interrupt credential persistence.
			try {
				listener(status)
			} catch {
				continue
			}
		}
	}

	private load(): Promise<void> {
		return (this.loaded ??= this.reload())
	}

	private async reload(): Promise<void> {
		const before = this.saved.accounts.find(({ id }) => id === this.saved.activeId)
		let raw: string | undefined
		try {
			raw = await this.dependencies.secrets.get(SECRET_KEY)
		} catch {
			throw authError("Could not read saved ChatGPT credentials. Check system credential storage and try again.")
		}
		if (!raw) {
			this.saved = { version: 1, accounts: [] }
			if (before) this.resetSession()
			return
		}
		try {
			const parsed: unknown = JSON.parse(raw)
			const source = record(parsed)
			if (source?.version !== 1 || !Array.isArray(source.accounts)) throw new Error()
			const accounts: Registration[] = source.accounts.map((candidate: unknown) => {
				const item = record(candidate)
				const id = text(item?.id)
				const subject = text(item?.subject)
				if (!id || !subject) throw new Error()
				const tokens = record(item?.tokens)
				if (
					tokens &&
					(!text(tokens.accessToken) ||
						!text(tokens.refreshToken) ||
						!text(tokens.idToken) ||
						typeof tokens.expiresAt !== "number" ||
						!Number.isFinite(tokens.expiresAt) ||
						typeof tokens.refreshAt !== "number" ||
						!Number.isFinite(tokens.refreshAt) ||
						(tokens.earliestRefreshAt !== undefined &&
							(typeof tokens.earliestRefreshAt !== "number" ||
								!Number.isFinite(tokens.earliestRefreshAt) ||
								tokens.earliestRefreshAt < 0)) ||
						!Array.isArray(tokens.scopes) ||
						!tokens.scopes.every((scope) => typeof scope === "string"))
				)
					throw new Error()
				return {
					id,
					subject,
					email: text(item?.email),
					...(tokens ? { tokens: tokens as unknown as Tokens } : {}),
					...(Array.isArray(item?.availableModelIds) &&
					item.availableModelIds.every((id) => typeof id === "string")
						? { availableModelIds: item.availableModelIds as string[] }
						: {}),
				}
			})
			if (new Set(accounts.map(({ id }) => id)).size !== accounts.length) throw new Error()
			this.saved = { version: 1, accounts, activeId: text(source.activeId) }
			const after = accounts.find(({ id }) => id === this.saved.activeId)
			if (
				before?.id !== after?.id ||
				before?.subject !== after?.subject ||
				(before?.tokens?.scopes.includes(DIRECT_SCOPE) && !after?.tokens?.scopes.includes(DIRECT_SCOPE))
			)
				this.resetSession()
		} catch {
			throw authError("Saved ChatGPT sign-in data is invalid. Sign out and connect again.")
		}
	}

	private mutate(update: (saved: SavedAccounts) => SavedAccounts, onCommit?: () => void): Promise<void> {
		return this.credentialTransaction(() => this.commit(update, onCommit))
	}

	private async commit(update: (saved: SavedAccounts) => SavedAccounts, onCommit?: () => void): Promise<void> {
		const next = update(this.saved)
		try {
			await this.dependencies.secrets.store(SECRET_KEY, JSON.stringify(next))
		} catch {
			throw authError("Could not save ChatGPT credentials. Check your system credential storage and try again.")
		}
		this.saved = next
		onCommit?.()
		this.emit()
	}

	private credentialTransaction<T>(work: () => Promise<T>, allowCorrupt = false): Promise<T> {
		const operation = this.writes.then(async () => {
			this.lifetime.signal.throwIfAborted()
			if (!this.credentialLockRelease && this.dependencies.storagePath) {
				await mkdir(dirname(this.dependencies.storagePath), { recursive: true })
				try {
					this.credentialLockRelease = await this.acquireCredentialLock(this.dependencies.storagePath)
				} catch (error) {
					this.lifetime.signal.throwIfAborted()
					throw authError(
						"ChatGPT credentials are busy in another window. Wait for its sign-in or refresh to finish and try again.",
						typeof record(error)?.code === "string" ? (record(error)!.code as string) : undefined,
					)
				}
			}
			try {
				try {
					await this.reload()
				} catch (error) {
					if (!allowCorrupt) throw error
					this.saved = { version: 1, accounts: [] }
				}
				return await work()
			} finally {
				// A consumed refresh token must never be exposed to another window
				// while its validated replacement is waiting for secure persistence.
				if (!this.pendingRotations.size || this.lifetime.signal.aborted) await this.releaseCredentialLock()
			}
		})
		this.writes = operation.catch(() => undefined)
		return operation
	}

	private async acquireCredentialLock(storagePath: string): Promise<() => Promise<void>> {
		for (let attempt = 0; attempt <= 120; attempt++) {
			this.lifetime.signal.throwIfAborted()
			try {
				const release = await lockfile.lock(storagePath, {
					realpath: false,
					stale: 90_000,
					update: 10_000,
					retries: 0,
					onCompromised: () => {
						const error = authError(
							"ChatGPT credential ownership was lost. Reload Alpha Code before signing in again.",
						)
						this.lifetime.abort(error)
						this.session.abort(error)
					},
				})
				if (this.lifetime.signal.aborted) {
					await release()
					throw this.lifetime.signal.reason
				}
				return release
			} catch (error) {
				if (record(error)?.code !== "ELOCKED" || attempt === 120) throw error
			}
			let timer: ReturnType<typeof setTimeout> | undefined
			try {
				await withAbort(
					new Promise<void>((resolve) => {
						timer = setTimeout(resolve, 250)
					}),
					this.lifetime.signal,
				)
			} finally {
				clearTimeout(timer)
			}
		}
		throw authError("ChatGPT credential ownership could not be acquired.")
	}

	private async releaseCredentialLock(): Promise<void> {
		const release = this.credentialLockRelease
		this.credentialLockRelease = undefined
		if (release)
			await release().catch(() => {
				const error = authError("ChatGPT credential ownership could not be released. Reload Alpha Code.")
				this.lifetime.abort(error)
				this.session.abort(error)
			})
	}

	private async request(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
		const timeout = new AbortController()
		const timer = setTimeout(
			() => timeout.abort(new DOMException("ChatGPT request timed out", "TimeoutError")),
			REQUEST_TIMEOUT,
		)
		const linked = AbortSignal.any([this.lifetime.signal, timeout.signal, ...(signal ? [signal] : [])])
		try {
			linked.throwIfAborted()
			const response = await withAbort(
				Promise.resolve(this.fetcher(url, { ...init, redirect: "error", signal: linked })),
				linked,
			)
			const body = await withAbort(response.text(), linked)
			if (body.length > 1_000_000) throw authError("ChatGPT returned an oversized authentication response.")
			let value: unknown
			try {
				value = body ? JSON.parse(body) : undefined
			} catch {
				throw authError("ChatGPT returned an invalid authentication response.", undefined, response.status)
			}
			if (!response.ok) {
				const code = text(record(value)?.error)
				throw authError(
					`ChatGPT authentication request failed (HTTP ${response.status}). Please try signing in again.`,
					code && /^[a-z_]{1,80}$/.test(code) ? code : undefined,
					response.status,
				)
			}
			return value
		} catch (error) {
			if (linked.aborted) throw linked.reason
			if (error instanceof Error && "retryable" in error) throw error
			throw authError("Could not connect to ChatGPT. Check your connection and try again.")
		} finally {
			clearTimeout(timer)
		}
	}

	private getDiscovery(): Promise<Record<string, unknown>> {
		return (this.discovery ??= this.request(`${ISSUER}/.well-known/openid-configuration`)
			.then((value) => {
				const source = record(value)
				if (source?.issuer !== ISSUER) throw authError("ChatGPT identity discovery returned an invalid issuer.")
				return source
			})
			.catch((error) => {
				this.discovery = undefined
				throw error
			}))
	}

	private trustedEndpoint(value: unknown): string {
		const url = typeof value === "string" ? new URL(value) : undefined
		if (!url || url.origin !== ISSUER || url.username || url.password || url.hash) {
			throw authError("ChatGPT identity discovery returned an invalid endpoint.")
		}
		return url.href
	}

	private async validateIdentity(
		idToken: string,
		clientId: string,
		nonce?: string,
	): Promise<{ subject: string; email?: string }> {
		try {
			if (idToken.length > 65_536) throw new Error()
			const [headerPart, payloadPart, signaturePart, extra] = idToken.split(".")
			if (!headerPart || !payloadPart || !signaturePart || extra !== undefined) throw new Error()
			const header = record(JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8")))
			const claims = record(JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")))
			if (header?.alg !== "RS256" || !text(header.kid) || !claims) throw new Error()
			const discovery = await this.getDiscovery()
			const jwks = record(await this.request(this.trustedEndpoint(discovery.jwks_uri)))
			if (!Array.isArray(jwks?.keys) || jwks.keys.length > 100) throw new Error()
			const matches = jwks.keys.filter((candidate: unknown) => {
				const key = record(candidate)
				return (
					key !== undefined &&
					key.kid === header.kid &&
					key.kty === "RSA" &&
					(!key.alg || key.alg === "RS256") &&
					(!key.use || key.use === "sig")
				)
			})
			if (matches.length !== 1) throw new Error()
			const key = createPublicKey({ key: matches[0], format: "jwk" })
			if (
				!verify(
					"RSA-SHA256",
					Buffer.from(`${headerPart}.${payloadPart}`),
					key,
					Buffer.from(signaturePart, "base64url"),
				)
			)
				throw new Error()
			const audience = claims.aud
			const audiences = typeof audience === "string" ? [audience] : Array.isArray(audience) ? audience : []
			if (
				claims.iss !== ISSUER ||
				!audiences.includes(clientId) ||
				(audiences.length > 1 && claims.azp !== clientId) ||
				typeof claims.exp !== "number" ||
				!Number.isFinite(claims.exp) ||
				claims.exp * 1000 <= this.now() ||
				(typeof claims.nbf === "number" && claims.nbf * 1000 > this.now() + 60_000) ||
				!text(claims.sub) ||
				(nonce !== undefined && (typeof claims.nonce !== "string" || !sameSecret(claims.nonce, nonce)))
			)
				throw new Error()
			return { subject: claims.sub as string, ...(text(claims.email) ? { email: claims.email as string } : {}) }
		} catch {
			throw authError("ChatGPT identity validation failed. Please sign in again.")
		}
	}

	private parseTokens(value: unknown, previous?: Tokens): Tokens {
		const source = record(value)
		const accessToken = text(source?.access_token)
		const refreshToken = text(source?.refresh_token)
		const idToken = text(source?.id_token) ?? previous?.idToken
		const expires = source?.expires_in
		const scopes = typeof source?.scope === "string" ? source.scope.split(/\s+/).filter(Boolean) : previous?.scopes
		if (
			!accessToken ||
			!refreshToken ||
			!idToken ||
			!scopes ||
			source?.token_type?.toString().toLowerCase() !== "bearer" ||
			typeof expires !== "number" ||
			!Number.isFinite(expires) ||
			expires <= 0
		) {
			throw authError("ChatGPT returned incomplete credentials. Please sign in again.")
		}
		const expiresAt = this.now() + expires * 1000
		const earliest = typeof source?.earliest_refresh_at === "number" ? source.earliest_refresh_at * 1000 : 0
		if (!Number.isFinite(expiresAt) || !Number.isFinite(earliest) || earliest < 0)
			throw authError("ChatGPT returned an invalid credential expiry.")
		return {
			accessToken,
			refreshToken,
			idToken,
			scopes,
			expiresAt,
			refreshAt: Math.max(expiresAt - 60_000, earliest),
			earliestRefreshAt: earliest,
		}
	}

	private async hostId(): Promise<string> {
		const existing = this.dependencies.globalState.get<string>(HOST_KEY)
		if (existing && /^urn:(uuid:|ietf:params:oauth:jwk-thumbprint:)/.test(existing)) return existing
		const id = `urn:uuid:${randomUUID()}`
		await this.dependencies.globalState.update(HOST_KEY, id)
		return id
	}

	async signIn(options: ChatGptSignInOptions = {}): Promise<ChatGptAuthStatus> {
		this.lifetime.signal.throwIfAborted()
		options.signal?.throwIfAborted()
		await this.load()
		this.lifetime.signal.throwIfAborted()
		options.signal?.throwIfAborted()
		if (this.signingOut) throw authError("Wait for ChatGPT sign-out to finish.")
		if (this.pending && !this.pending.controller.signal.aborted)
			return withAbort(this.pending.operation, options.signal)
		const controller = new AbortController()
		const signal = AbortSignal.any([
			controller.signal,
			this.lifetime.signal,
			...(options.signal ? [options.signal] : []),
		])
		const timeoutMs = options.timeoutMs ?? 180_000
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw authError("ChatGPT sign-in timeout must be positive.")
		const timer = setTimeout(
			() => controller.abort(new DOMException("ChatGPT sign-in timed out", "TimeoutError")),
			timeoutMs,
		)
		const attempt: SignInAttempt = { controller, signal, operation: Promise.resolve(this.status()) }
		this.pending = attempt
		this.signInAttempts.add(attempt)
		attempt.operation = this.performSignIn(options, signal, (id) => {
			attempt.accountId = id
		}).finally(() => {
			clearTimeout(timer)
			this.signInAttempts.delete(attempt)
			if (this.pending === attempt) this.pending = undefined
			this.emit()
		})
		this.emit()
		try {
			return await withAbort(attempt.operation, signal)
		} finally {
			if (signal.aborted) this.emit()
		}
	}

	private async performSignIn(
		options: ChatGptSignInOptions,
		signal: AbortSignal,
		registered: (id: string) => void,
	): Promise<ChatGptAuthStatus> {
		const id = options.accountId ?? this.saved.activeId
		const previous = options.newAccount ? undefined : this.saved.accounts.find((account) => account.id === id)
		if (options.accountId && !previous && !options.newAccount)
			throw authError("Saved ChatGPT account was not found.")
		const state = randomBytes(32).toString("base64url")
		const nonce = randomBytes(32).toString("base64url")
		const verifier = randomBytes(48).toString("base64url")
		let server: Server | undefined
		let close!: () => void
		try {
			const callback = new Promise<URL>((resolve, reject) => {
				server = createServer((request, response) => {
					let url: URL
					try {
						const target = request.url
						if (
							!target ||
							target.length > MAX_CALLBACK_TARGET_LENGTH ||
							!target.startsWith("/") ||
							target.startsWith("//") ||
							/[\s\\#]/u.test(target)
						)
							throw new Error()
						url = new URL(target, "http://127.0.0.1")
						if (url.origin !== "http://127.0.0.1") throw new Error()
					} catch {
						response.writeHead(400).end("Invalid sign-in callback request.")
						return
					}
					if (request.method !== "GET" || url.pathname !== "/auth/callback") {
						response.writeHead(404).end()
						return
					}
					if (
						url.searchParams.getAll("state").length !== 1 ||
						!sameSecret(url.searchParams.get("state") ?? "", state)
					) {
						response.writeHead(400).end("Invalid sign-in state. Return to Alpha Code.")
						return
					}
					response.setHeader("Content-Type", "text/plain; charset=utf-8")
					response.setHeader("Cache-Control", "no-store")
					response.setHeader("Content-Security-Policy", "default-src 'none'")
					response.writeHead(200).end("Sign-in received. You can return to Alpha Code.")
					resolve(url)
				})
				server.on("error", () => reject(authError("Could not start the ChatGPT sign-in callback listener.")))
			})
			void callback.catch(() => undefined)
			close = () => {
				server?.close()
				server?.closeAllConnections()
			}
			signal.addEventListener("abort", close, { once: true })
			await withAbort(
				new Promise<void>((resolve, reject) => {
					server!.once("error", reject)
					server!.listen(0, "127.0.0.1", resolve)
				}),
				signal,
			)
			signal.throwIfAborted()
			const address = server!.address()
			if (!address || typeof address === "string") throw authError("ChatGPT callback listener did not start.")
			const redirect = `http://127.0.0.1:${address.port}/auth/callback`
			const authorize = new URL(`${ISSUER}/api/accounts/authorize`)
			const parameters: Record<string, string> = {
				client_id: previous?.id ?? "dynamic_agent_client",
				ext_agent_host_id: await this.hostId(),
				response_type: "code",
				redirect_uri: redirect,
				scope: SCOPES,
				resource: RESOURCE,
				state,
				nonce,
				code_challenge_method: "S256",
				code_challenge: createHash("sha256").update(verifier).digest("base64url"),
			}
			if (!previous) parameters.agent_name_hint = "Alpha Code"
			if (previous?.tokens?.idToken) parameters.id_token_hint = previous.tokens.idToken
			if (previous?.email) parameters.login_hint = previous.email
			if (previous?.tokens && !previous.tokens.scopes.includes(DIRECT_SCOPE)) parameters.prompt = "consent"
			for (const [key, value] of Object.entries(parameters)) authorize.searchParams.set(key, value)
			let opened: boolean
			try {
				opened = await withAbort(Promise.resolve(this.dependencies.openExternal(authorize.href)), signal)
			} catch {
				signal.throwIfAborted()
				throw authError("Could not open your browser for ChatGPT sign-in.")
			}
			if (!opened) {
				throw authError("Could not open your browser for ChatGPT sign-in.")
			}
			const returned = await withAbort(callback, signal)
			close()
			signal.throwIfAborted()
			if (returned.searchParams.has("error"))
				throw authError("ChatGPT sign-in was declined. Enable ChatGPT plan usage to connect.")
			const clientId = returned.searchParams.get("client_id") ?? previous?.id
			const code = returned.searchParams.get("code")
			if (
				!clientId ||
				clientId === "dynamic_agent_client" ||
				!/^[A-Za-z0-9_.-]{1,256}$/.test(clientId) ||
				!code ||
				returned.searchParams.getAll("code").length !== 1 ||
				returned.searchParams.getAll("client_id").length > 1 ||
				(previous && clientId !== previous.id)
			) {
				throw authError("ChatGPT registration did not return the expected client identity.")
			}
			registered(clientId)
			// Once exchanged, persist the returned credential set even if its caller
			// cancels. Cancellation still prevents activating a different account.
			const result = await this.request(TOKEN_ENDPOINT, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "authorization_code",
					client_id: clientId,
					code,
					code_verifier: verifier,
					redirect_uri: redirect,
					resource: RESOURCE,
				}),
			})
			const tokens = this.parseTokens(result)
			const identity = await this.validateIdentity(tokens.idToken, clientId, nonce)
			if (previous && previous.subject !== identity.subject)
				throw authError("ChatGPT returned a different account. Add it as a new account instead.")
			const account: Registration = { id: clientId, ...identity, tokens }
			await this.refreshes.get(clientId)?.catch(() => undefined)
			await this.mutate(
				(saved) => ({
					...saved,
					accounts: [...saved.accounts.filter(({ id }) => id !== account.id), account],
					activeId: signal.aborted ? saved.activeId : account.id,
				}),
				() => {
					this.pendingRotations.delete(clientId)
					if (!signal.aborted) {
						this.disconnectedAccounts.delete(clientId)
						this.resetSession()
					}
				},
			)
			signal.throwIfAborted()
			if (!tokens.scopes.includes(DIRECT_SCOPE))
				throw authError(
					"ChatGPT plan usage was not enabled. Sign in again to enable it, or choose an API-key provider.",
				)
			await this.loadCatalog(account, signal)
			return this.status()
		} finally {
			if (close) {
				signal.removeEventListener("abort", close)
				close()
			}
		}
	}

	cancelSignIn(): void {
		this.pending?.controller.abort(new DOMException("ChatGPT sign-in cancelled", "AbortError"))
		this.emit()
	}

	private cancelAllSignIns(): SignInAttempt[] {
		// Cancellation ends the caller's wait before an exchanged credential set
		// finishes persisting. Cleanup must join those older workers too.
		const attempts = [...this.signInAttempts]
		for (const attempt of attempts)
			attempt.controller.abort(new DOMException("ChatGPT sign-in cancelled", "AbortError"))
		return attempts
	}

	private resetSession(
		reason: unknown = new DOMException("ChatGPT account changed or signed out", "AbortError"),
	): void {
		this.session.abort(reason)
		this.session = new AbortController()
	}

	private async loadCatalog(account: Registration, signal?: AbortSignal): Promise<void> {
		if (!account.tokens) return
		const source = record(
			await this.request(
				`${RESOURCE}/models`,
				{ headers: { Authorization: `Bearer ${account.tokens.accessToken}` } },
				signal,
			),
		)
		if (!Array.isArray(source?.models)) throw authError("ChatGPT returned an invalid account model catalog.")
		const ids = source.models.flatMap((candidate: unknown) => {
			const model = record(candidate)
			return model?.visibility === "list" && text(model.slug) ? [model.slug as string] : []
		})
		await this.mutate((saved) => ({
			...saved,
			accounts: saved.accounts.map((item) =>
				item.id === account.id ? { ...item, availableModelIds: ids } : item,
			),
		}))
	}

	async selectAccount(accountId: string): Promise<ChatGptAuthStatus> {
		await this.load()
		if (this.signingOut) throw authError("Wait for ChatGPT sign-out to finish.")
		if (!this.saved.accounts.some(({ id }) => id === accountId))
			throw authError("Saved ChatGPT account was not found.")
		this.cancelSignIn()
		this.resetSession()
		await this.mutate(
			(saved) => ({ ...saved, activeId: accountId }),
			() => this.resetSession(),
		)
		const account = this.saved.accounts.find(({ id }) => id === accountId)!
		if (!this.disconnectedAccounts.has(account.id) && account.tokens?.scopes.includes(DIRECT_SCOPE)) {
			await this.getAccessToken()
			await this.loadCatalog(this.saved.accounts.find(({ id }) => id === accountId)!)
		}
		return this.status()
	}

	async authorizeRequest(signal?: AbortSignal): Promise<ChatGptRequestAuthorization> {
		await this.load()
		signal?.throwIfAborted()
		this.lifetime.signal.throwIfAborted()
		const session = this.session.signal
		const account = this.saved.accounts.find(({ id }) => id === this.saved.activeId)
		if (
			this.signingOut ||
			!account?.tokens?.scopes.includes(DIRECT_SCOPE) ||
			this.disconnectedAccounts.has(account.id)
		)
			throw authError("Sign in with ChatGPT and enable plan usage before starting a request.")
		const accessToken =
			account.tokens.refreshAt > this.now() && account.tokens.expiresAt > this.now()
				? account.tokens.accessToken
				: await withAbort(this.refresh(account), AbortSignal.any([session, ...(signal ? [signal] : [])]))
		session.throwIfAborted()
		signal?.throwIfAborted()
		return { accessToken, signal: session }
	}

	/** One admission recovery; account changes cannot redirect a rejected request. */
	async recoverUnauthorizedRequest(
		authorization: ChatGptRequestAuthorization,
		signal?: AbortSignal,
	): Promise<ChatGptRequestAuthorization> {
		await this.load()
		signal?.throwIfAborted()
		this.lifetime.signal.throwIfAborted()
		this.assertAuthorizationCurrent(authorization)
		const account = this.saved.accounts.find(({ id }) => id === this.saved.activeId)
		if (
			this.signingOut ||
			!account?.tokens?.scopes.includes(DIRECT_SCOPE) ||
			this.disconnectedAccounts.has(account.id)
		)
			throw authError("Sign in with ChatGPT before starting a request.")
		const accessToken = await withAbort(
			this.refresh(account, authorization),
			AbortSignal.any([authorization.signal, ...(signal ? [signal] : [])]),
		)
		signal?.throwIfAborted()
		this.assertAuthorizationCurrent(authorization)
		return { accessToken, signal: authorization.signal }
	}

	private assertAuthorizationCurrent(authorization: ChatGptRequestAuthorization): void {
		authorization.signal.throwIfAborted()
		if (authorization.signal !== this.session.signal)
			throw authError("The ChatGPT account session changed. Retry with the selected account.")
	}

	async getAccessToken(signal?: AbortSignal): Promise<string> {
		return (await this.authorizeRequest(signal)).accessToken
	}

	private refresh(account: Registration, rejected?: ChatGptRequestAuthorization): Promise<string> {
		const pending = this.refreshes.get(account.id)
		if (pending) return pending
		const operation = this.credentialTransaction(async () => {
			if (rejected) this.assertAuthorizationCurrent(rejected)
			if (this.saved.activeId !== account.id)
				throw authError("The active ChatGPT account changed. Retry with the selected account.")
			const current = this.saved.accounts.find(({ id }) => id === account.id)
			if (!current?.tokens?.scopes.includes(DIRECT_SCOPE) || this.disconnectedAccounts.has(account.id))
				throw authError("Sign in with ChatGPT before starting a request.")
			const previous = current.tokens
			let tokens = this.pendingRotations.get(account.id)
			if (!tokens && previous.expiresAt > this.now() && previous.refreshAt > this.now()) {
				// Another window's replacement is usable without rotating it again. Legacy
				// token sets did not retain the issuer floor, so keep their scheduled bound.
				const rejectedCurrentToken = rejected && sameSecret(previous.accessToken, rejected.accessToken)
				if (!rejectedCurrentToken || (previous.earliestRefreshAt ?? previous.refreshAt) > this.now())
					return previous.accessToken
			}
			try {
				if (!tokens) {
					const result = await this.request(TOKEN_ENDPOINT, {
						method: "POST",
						headers: { "Content-Type": "application/x-www-form-urlencoded" },
						body: new URLSearchParams({
							grant_type: "refresh_token",
							client_id: account.id,
							refresh_token: previous.refreshToken,
							resource: RESOURCE,
						}),
					})
					tokens = this.parseTokens(result, previous)
					if (tokens.idToken !== previous.idToken) {
						const identity = await this.validateIdentity(tokens.idToken, account.id)
						if (identity.subject !== account.subject)
							throw authError("ChatGPT refreshed a different account identity. Sign in again.")
					}
					this.pendingRotations.set(account.id, tokens)
				}
				const replacement = tokens
				await this.commit((saved) => ({
					...saved,
					accounts: saved.accounts.map((item) =>
						item.id === account.id ? { ...item, tokens: replacement } : item,
					),
				}))
				this.pendingRotations.delete(account.id)
				if (!tokens.scopes.includes(DIRECT_SCOPE))
					throw authError("ChatGPT plan usage is no longer enabled. Sign in again.")
				return tokens.accessToken
			} catch (error) {
				const code = record(error)?.code
				if (
					typeof code === "string" &&
					[
						"invalid_grant",
						"invalid_refresh_token",
						"token_expired",
						"refresh_token_expired",
						"refresh_token_invalidated",
						"refresh_token_reused",
					].includes(code)
				) {
					this.disconnectedAccounts.add(account.id)
					if (this.saved.activeId === account.id) this.resetSession(error)
					await this.commit((saved) => ({
						...saved,
						accounts: saved.accounts.map((item) =>
							item.id === account.id ? { ...item, tokens: undefined } : item,
						),
					}))
				}
				throw error
			}
		}).finally(() => {
			this.refreshes.delete(account.id)
		})
		this.refreshes.set(account.id, operation)
		return operation
	}

	signOut(): Promise<void> {
		return (this.signOutOperation ??= this.performSignOut().finally(() => {
			this.signOutOperation = undefined
		}))
	}

	private async performSignOut(): Promise<void> {
		this.cancelSignIn()
		await this.load()
		this.signingOut = true
		const attempts = this.cancelAllSignIns()
		this.resetSession()
		this.emit()
		const accountId = this.saved.activeId
		if (accountId) this.disconnectedAccounts.add(accountId)
		let confirmed = true
		try {
			await Promise.allSettled(attempts.map(({ operation }) => operation))
			const ids = new Set([accountId, ...attempts.map(({ accountId }) => accountId)])
			for (const id of ids) {
				if (!id) continue
				this.disconnectedAccounts.add(id)
				await this.refreshes.get(id)?.catch(() => undefined)
			}
			await this.credentialTransaction(async () => {
				for (const id of ids) {
					if (!id) continue
					const account = this.saved.accounts.find((account) => account.id === id)
					if (account?.tokens)
						confirmed =
							(await this.revoke({
								...account,
								tokens: this.pendingRotations.get(id) ?? account.tokens,
							})) && confirmed
				}
				await this.commit((saved) => ({
					...saved,
					accounts: saved.accounts.map((account) =>
						ids.has(account.id) ? { ...account, tokens: undefined } : account,
					),
				}))
				for (const id of ids) if (id) this.pendingRotations.delete(id)
			})
		} finally {
			this.signingOut = false
			this.emit()
		}
		if (!confirmed)
			throw authError(
				"Signed out locally. Remote revocation was not confirmed; disconnect Alpha Code in ChatGPT Settings to end the remote session.",
				"chatgpt_revocation_unconfirmed",
			)
	}

	private async revoke(account: Registration): Promise<boolean> {
		if (!account.tokens) return true
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const discovery = await this.getDiscovery()
				await this.request(this.trustedEndpoint(discovery.revocation_endpoint), {
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({
						token: account.tokens.refreshToken,
						token_type_hint: "refresh_token",
						client_id: account.id,
					}),
				})
				return true
			} catch (error) {
				const status = record(error)?.status
				if (this.lifetime.signal.aborted || (typeof status === "number" && status < 500)) break
				if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt))
			}
		}
		return false
	}

	async resetAccounts(): Promise<void> {
		await this.signOutOperation?.catch(() => undefined)
		this.cancelSignIn()
		await this.load().catch(() => {
			this.saved = { version: 1, accounts: [] }
		})
		this.signingOut = true
		const attempts = this.cancelAllSignIns()
		for (const account of this.saved.accounts) this.disconnectedAccounts.add(account.id)
		this.resetSession()
		this.emit()
		try {
			await Promise.allSettled(attempts.map(({ operation }) => operation))
			for (const account of this.saved.accounts) this.disconnectedAccounts.add(account.id)
			await Promise.allSettled(this.refreshes.values())
			await this.credentialTransaction(async () => {
				for (const account of this.saved.accounts)
					await this.revoke({ ...account, tokens: this.pendingRotations.get(account.id) ?? account.tokens })
				try {
					await this.dependencies.secrets.delete(SECRET_KEY)
				} catch {
					throw authError(
						"Could not clear saved ChatGPT credentials. Check system credential storage and try again.",
					)
				}
				this.saved = { version: 1, accounts: [] }
				this.loaded = Promise.resolve()
				this.pendingRotations.clear()
				this.disconnectedAccounts.clear()
			}, true)
		} finally {
			this.signingOut = false
			this.emit()
		}
	}

	async dispose(): Promise<void> {
		this.cancelSignIn()
		const attempts = this.cancelAllSignIns()
		this.lifetime.abort(new DOMException("ChatGPT sign-in service disposed", "AbortError"))
		this.session.abort(this.lifetime.signal.reason)
		this.listeners.clear()
		this.secretSubscription?.dispose()
		if (ChatGptAuthService.instance === this) ChatGptAuthService.instance = undefined
		await Promise.allSettled(attempts.map(({ operation }) => operation))
		await this.writes
		await this.releaseCredentialLock()
	}
}
