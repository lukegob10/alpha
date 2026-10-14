import { exec } from "node:child_process"
import { promisify } from "node:util"

const execAsync = promisify(exec)

const DEFAULT_HELIX_TOKEN_KEY = "access_token"
const DEFAULT_REFRESH_INTERVAL_MINUTES = 10
const MIN_REFRESH_INTERVAL_MINUTES = 1
const COMMAND_TIMEOUT_MS = 30_000
const MAX_OUTPUT_BUFFER_BYTES = 1_048_576
const MAX_REFRESH_JITTER_MS = 30_000
const REFRESH_RETRY_DELAY_MS = 60_000
const MIN_LIKELY_TOKEN_LENGTH = 20

export type HelixParseMode = "raw_stdout" | "json_field"

export interface HelixTokenManagerOptions {
	helixCommand: string
	helixParseMode?: HelixParseMode
	helixTokenKey?: string
	refreshIntervalMinutes?: number
}

type NormalizedHelixTokenManagerOptions = {
	helixCommand: string
	helixParseMode: HelixParseMode
	helixTokenKey: string
	refreshIntervalMinutes: number
}

export class HelixTokenManager {
	private static readonly instances = new Map<string, HelixTokenManager>()

	private readonly options: NormalizedHelixTokenManagerOptions
	private readonly refreshIntervalMs: number

	private cachedToken?: string
	private refreshPromise?: Promise<string>
	private refreshTimer?: ReturnType<typeof setTimeout>

	private constructor(options: HelixTokenManagerOptions) {
		this.options = HelixTokenManager.normalizeOptions(options)
		this.refreshIntervalMs = this.options.refreshIntervalMinutes * 60_000
	}

	public static getOrCreate(options: HelixTokenManagerOptions): HelixTokenManager {
		const normalized = HelixTokenManager.normalizeOptions(options)
		const cacheKey = JSON.stringify(normalized)
		const existing = HelixTokenManager.instances.get(cacheKey)

		if (existing) {
			return existing
		}

		const manager = new HelixTokenManager(normalized)
		HelixTokenManager.instances.set(cacheKey, manager)
		return manager
	}

	public async getToken(): Promise<string> {
		if (this.cachedToken) {
			return this.cachedToken
		}

		return this.refreshToken(false)
	}

	public async forceRefreshToken(): Promise<string> {
		return this.refreshToken(true)
	}

	private async refreshToken(forceRefresh: boolean): Promise<string> {
		if (!forceRefresh && this.cachedToken) {
			return this.cachedToken
		}

		if (this.refreshPromise) {
			return this.refreshPromise
		}

		this.refreshPromise = (async () => {
			const nextToken = await this.fetchTokenFromCommand()

			if (!nextToken) {
				throw new Error("Helix command output did not contain a valid access token.")
			}

			this.cachedToken = nextToken
			this.scheduleRefresh(this.refreshIntervalMs + this.getRefreshJitterMs())

			return nextToken
		})()

		try {
			return await this.refreshPromise
		} finally {
			this.refreshPromise = undefined
		}
	}

	private scheduleRefresh(delayMs: number) {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer)
		}

		this.refreshTimer = setTimeout(() => {
			void this.refreshToken(true).catch(() => {
				this.scheduleRefresh(Math.min(this.refreshIntervalMs, REFRESH_RETRY_DELAY_MS))
			})
		}, delayMs)

		if (typeof this.refreshTimer.unref === "function") {
			this.refreshTimer.unref()
		}
	}

	private getRefreshJitterMs(): number {
		return Math.floor(Math.random() * MAX_REFRESH_JITTER_MS)
	}

	private async fetchTokenFromCommand(): Promise<string> {
		let stdout = ""

		try {
			const result = await execAsync(this.options.helixCommand, {
				shell: process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh",
				windowsHide: true,
				timeout: COMMAND_TIMEOUT_MS,
				maxBuffer: MAX_OUTPUT_BUFFER_BYTES,
			})

			stdout = typeof result === "string" ? result : (result.stdout ?? "")
		} catch {
			throw new Error("Helix command failed while retrieving an access token.")
		}

		return this.parseTokenFromStdout(stdout)
	}

	private parseTokenFromStdout(stdout: string): string {
		if (this.options.helixParseMode === "raw_stdout") {
			return this.parseTokenFromRawStdout(stdout)
		}

		const parsed = this.safeParseJson(stdout)
		const extracted = this.readJsonField(parsed, this.options.helixTokenKey)

		if (typeof extracted === "string") {
			return this.normalizeAndValidateToken(extracted)
		}

		throw new Error("Helix command output did not contain the configured token field.")
	}

	private parseTokenFromRawStdout(stdout: string): string {
		const normalizedStdout = stdout.replace(/\r\n?/g, "\n")
		const lines = normalizedStdout
			.split("\n")
			.map((line) => this.normalizePotentialToken(line))
			.filter((line) => line.length > 0)

		if (lines.length === 1) {
			return this.normalizeAndValidateToken(lines[0])
		}

		for (const line of lines) {
			if (this.looksLikeAccessToken(line)) {
				return this.normalizeAndValidateToken(line)
			}
		}

		const bearerMatch = normalizedStdout.match(/\bBearer\s+([A-Za-z0-9._~+\/=-]+)/i)
		if (bearerMatch?.[1]) {
			return this.normalizeAndValidateToken(bearerMatch[1])
		}

		throw new Error(
			"Helix command output did not contain a valid header-safe access token. Ensure the command prints only the token or use helixParseMode=json_field.",
		)
	}

	private normalizePotentialToken(value: string): string {
		let token = value.trim()
		if (!token) {
			return ""
		}

		token = token.replace(/^Bearer\s+/i, "").trim()

		const wrapped = token.match(/^["'](.+)["']$/)
		if (wrapped?.[1]) {
			token = wrapped[1].trim()
		}

		return token
	}

	private looksLikeAccessToken(value: string): boolean {
		if (!this.isHeaderSafeToken(value)) {
			return false
		}

		if (value.length >= MIN_LIKELY_TOKEN_LENGTH) {
			return true
		}

		if (/^ya29\./i.test(value)) {
			return true
		}

		if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+/.test(value)) {
			return true
		}

		return value.length >= 10 && /[._-]/.test(value) && /[A-Za-z]/.test(value)
	}

	private normalizeAndValidateToken(value: string): string {
		const token = this.normalizePotentialToken(value)

		if (!token) {
			throw new Error("Helix command returned an empty access token.")
		}

		if (!this.isHeaderSafeToken(token)) {
			throw new Error(
				"Helix token output contains whitespace or invalid characters. Ensure the command returns only the access token.",
			)
		}

		return token
	}

	private isHeaderSafeToken(value: string): boolean {
		if (/\s/.test(value)) {
			return false
		}

		return !/[^\x21-\x7E]/.test(value)
	}

	private safeParseJson(value: string): unknown {
		try {
			return JSON.parse(value)
		} catch {
			throw new Error("Helix command output is not valid JSON.")
		}
	}

	private readJsonField(value: unknown, path: string): unknown {
		const segments = path
			.split(".")
			.map((segment) => segment.trim())
			.filter((segment) => segment.length > 0)

		if (segments.length === 0) {
			return undefined
		}

		let current: unknown = value
		for (const segment of segments) {
			if (!current || typeof current !== "object") {
				return undefined
			}

			current = (current as Record<string, unknown>)[segment]
		}

		return current
	}

	private static normalizeOptions(options: HelixTokenManagerOptions): NormalizedHelixTokenManagerOptions {
		const refreshIntervalMinutes = Math.max(
			MIN_REFRESH_INTERVAL_MINUTES,
			Number.isFinite(options.refreshIntervalMinutes) ? Math.floor(options.refreshIntervalMinutes as number) : 0,
		)

		return {
			helixCommand: options.helixCommand,
			helixParseMode: options.helixParseMode ?? "raw_stdout",
			helixTokenKey: options.helixTokenKey?.trim() || DEFAULT_HELIX_TOKEN_KEY,
			refreshIntervalMinutes:
				refreshIntervalMinutes > 0 ? refreshIntervalMinutes : DEFAULT_REFRESH_INTERVAL_MINUTES,
		}
	}
}
