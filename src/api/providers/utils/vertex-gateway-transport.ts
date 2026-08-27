import { promises as fs } from "node:fs"
import path from "node:path"

let configuredPemPath: string | undefined
let fetchPatchedToUndici = false

export async function configureVertexGatewayTransport(pemCaBundlePath: string): Promise<string> {
	return configurePemCaTransport(pemCaBundlePath, "Vertex gateway")
}

export async function configurePemCaTransport(pemCaBundlePath: string, providerName = "Gateway"): Promise<string> {
	const resolvedPemPath = path.resolve(pemCaBundlePath)
	await assertPemPathExists(resolvedPemPath, providerName)

	// Parity with Python/Google tooling expectations.
	process.env.SSL_CERT_FILE = resolvedPemPath

	// Runtime fallback. Note that Node typically reads this at process start.
	process.env.NODE_EXTRA_CA_CERTS = resolvedPemPath

	// Respect debug proxy mode if already configured by Roo's network proxy helper.
	if (process.env.GLOBAL_AGENT_HTTP_PROXY || process.env.GLOBAL_AGENT_HTTPS_PROXY) {
		configuredPemPath = resolvedPemPath
		return resolvedPemPath
	}

	const pemContents = await fs.readFile(resolvedPemPath, "utf8")
	if (!pemContents.trim()) {
		throw new Error(`${providerName} PEM CA bundle is empty: ${resolvedPemPath}`)
	}

	// Ensure Node's fetch uses undici and a dispatcher with explicit CA trust.
	try {
		const {
			Agent,
			setGlobalDispatcher,
			fetch: undiciFetch,
		} = (await import("undici")) as unknown as {
			Agent: new (options: { connect: { ca: string } }) => unknown
			setGlobalDispatcher: (dispatcher: unknown) => void
			fetch: unknown
		}

		const dispatcher = new Agent({
			connect: {
				ca: pemContents,
			},
		})

		setGlobalDispatcher(dispatcher)

		if (!fetchPatchedToUndici && typeof globalThis.fetch === "function" && globalThis.fetch !== undiciFetch) {
			globalThis.fetch = undiciFetch as typeof fetch
			fetchPatchedToUndici = true
		}
	} catch {
		// Runtime already has NODE_EXTRA_CA_CERTS set as fallback.
	}

	configuredPemPath = resolvedPemPath
	return resolvedPemPath
}

export function isVertexGatewayTransportConfiguredForPem(pemCaBundlePath: string): boolean {
	return configuredPemPath === path.resolve(pemCaBundlePath)
}

async function assertPemPathExists(resolvedPemPath: string, providerName: string): Promise<void> {
	let stats

	try {
		stats = await fs.stat(resolvedPemPath)
	} catch {
		throw new Error(`${providerName} PEM CA bundle path does not exist: ${resolvedPemPath}`)
	}

	if (!stats.isFile()) {
		throw new Error(`${providerName} PEM CA bundle path is not a file: ${resolvedPemPath}`)
	}
}
