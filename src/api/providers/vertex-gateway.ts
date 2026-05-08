import { execFile } from "child_process"
import { readFileSync } from "fs"
import { homedir } from "os"
import { parse } from "shell-quote"
import { Agent, fetch as undiciFetch, getGlobalDispatcher, setGlobalDispatcher } from "undici"

import type { ProviderSettings } from "@roo-code/types"

export const DEFAULT_VERTEX_GATEWAY_HELIX_COMMAND = "helix auth access-token print -a"
export const DEFAULT_VERTEX_GATEWAY_TOKEN_REFRESH_MINUTES = 10
const TOKEN_COMMAND_TIMEOUT_MS = 30_000
const MIN_REFRESH_MINUTES = 1

let configuredCaBundlePath: string | undefined
let originalFetch: typeof fetch | undefined
let originalDispatcher: ReturnType<typeof getGlobalDispatcher> | undefined
let fetchPatched = false

export function getVertexGatewayHeaders(): Record<string, string> {
	return { "x-r2d2-soeid": process.env.USERNAME ?? process.env.USER ?? "" }
}

export function getVertexGatewayTokenRefreshMinutes(settings: ProviderSettings): number {
	const configured = settings.vertexGatewayTokenRefreshMinutes
	if (!Number.isFinite(configured) || !configured || configured < MIN_REFRESH_MINUTES) {
		return DEFAULT_VERTEX_GATEWAY_TOKEN_REFRESH_MINUTES
	}

	return Math.floor(configured)
}

export function parseVertexGatewayModelRoutingMap(value: string | undefined): Record<string, string> {
	if (!value?.trim()) {
		return {}
	}

	const parsed = JSON.parse(value)
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Vertex gateway model routing map must be a JSON object.")
	}

	const entries = Object.entries(parsed)
	if (
		!entries.every(
			(entry): entry is [string, string] =>
				entry[0].trim().length > 0 && typeof entry[1] === "string" && entry[1].trim().length > 0,
		)
	) {
		throw new Error("Vertex gateway model routing map must contain string model ID values.")
	}

	return Object.fromEntries(entries.map(([key, value]) => [key.trim(), value.trim()]))
}

export function resolveVertexGatewayModelId(modelId: string, routingMap: string | undefined): string {
	const routes = parseVertexGatewayModelRoutingMap(routingMap)
	const routedModelId = routes[modelId] || modelId
	return routedModelId.endsWith(":thinking") ? routedModelId.replace(":thinking", "") : routedModelId
}

export async function fetchVertexGatewayAccessToken(command = DEFAULT_VERTEX_GATEWAY_HELIX_COMMAND): Promise<string> {
	const [file, ...args] = parseVertexGatewayCommand(command)
	let stdout: string

	try {
		const result = await execFileUtf8(file, args)
		stdout = result.stdout
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		throw new Error(`Vertex gateway Helix command failed: ${message}`)
	}

	const token = String(stdout).trim()
	if (!token) {
		throw new Error("Vertex gateway Helix command returned an empty access token.")
	}

	return token
}

function execFileUtf8(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile(
			file,
			args,
			{
				encoding: "utf8",
				timeout: TOKEN_COMMAND_TIMEOUT_MS,
				windowsHide: true,
			},
			(error, stdout, stderr) => {
				if (error) {
					reject(error)
					return
				}

				resolve({ stdout: String(stdout), stderr: String(stderr) })
			},
		)
	})
}

export function createVertexGatewayRefreshHandler(settings: ProviderSettings) {
	const command = settings.vertexGatewayHelixCommand?.trim() || DEFAULT_VERTEX_GATEWAY_HELIX_COMMAND
	let cachedToken: { accessToken: string; expiresAt: number } | undefined

	return async () => {
		if (cachedToken && Date.now() < cachedToken.expiresAt) {
			return {
				access_token: cachedToken.accessToken,
				expiry_date: cachedToken.expiresAt,
			}
		}

		const accessToken = await fetchVertexGatewayAccessToken(command)
		const expiresInMs = getVertexGatewayTokenRefreshMinutes(settings) * 60_000
		const expiresAt = Date.now() + expiresInMs
		cachedToken = { accessToken, expiresAt }

		return {
			access_token: accessToken,
			expiry_date: expiresAt,
		}
	}
}

export function configureVertexGatewayCaBundle(caBundlePath: string | undefined): void {
	if (!caBundlePath?.trim()) {
		return
	}

	const expandedPath = expandHomePath(caBundlePath.trim())
	if (configuredCaBundlePath === expandedPath) {
		return
	}

	const ca = readFileSync(expandedPath, "utf8")
	const agent = new Agent({ connect: { ca } })

	originalDispatcher ??= getGlobalDispatcher()
	setGlobalDispatcher(agent)

	if (!fetchPatched) {
		originalFetch = globalThis.fetch
		globalThis.fetch = undiciFetch as unknown as typeof fetch
		fetchPatched = true
	}

	configuredCaBundlePath = expandedPath
}

export function resetVertexGatewayCaBundleForTests(): void {
	if (fetchPatched && originalFetch) {
		globalThis.fetch = originalFetch
	}

	fetchPatched = false
	originalFetch = undefined
	configuredCaBundlePath = undefined

	if (originalDispatcher) {
		setGlobalDispatcher(originalDispatcher)
		originalDispatcher = undefined
	}
}

function parseVertexGatewayCommand(command: string): string[] {
	const tokens = parse(command)
	const args: string[] = []

	for (const token of tokens) {
		if (typeof token !== "string") {
			throw new Error("Vertex gateway Helix command cannot contain shell operators or substitutions.")
		}

		if (token.trim()) {
			args.push(token)
		}
	}

	if (args.length === 0) {
		throw new Error("Vertex gateway Helix command cannot be empty.")
	}

	return args
}

function expandHomePath(filePath: string): string {
	if (filePath === "~") {
		return homedir()
	}

	if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
		return `${homedir()}${filePath.slice(1)}`
	}

	return filePath
}
