import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, realpath } from "node:fs/promises"
import * as path from "node:path"

import { TestRunError } from "./runFailure"

export const LIVE_PROVIDER_EXTENSION_ID = "github.copilot-chat" as const
const MAX_ENTRYPOINT_BYTES = 128 * 1024 * 1024

export type LiveProviderExtensionSnapshot = {
	id: typeof LIVE_PROVIDER_EXTENSION_ID
	version: string | null
	entrypointSha256: string | null
}

export type LiveProviderIdentityReceipt = {
	schemaVersion: 1
	before: LiveProviderExtensionSnapshot
	after: LiveProviderExtensionSnapshot
	status: "unchanged" | "changed" | "unknown"
}

type ExtensionIdentitySource = { packageJSON: unknown; extensionPath: string }

/** Only the provider's declared version and executing entrypoint hash leave its installation. */
export async function captureLiveProviderExtension(
	extension: ExtensionIdentitySource | undefined,
): Promise<LiveProviderExtensionSnapshot> {
	const snapshot: LiveProviderExtensionSnapshot = {
		id: LIVE_PROVIDER_EXTENSION_ID,
		version: null,
		entrypointSha256: null,
	}
	if (!extension) return snapshot
	try {
		const manifest = extension.packageJSON
		if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return snapshot
		const { version, main } = manifest as Record<string, unknown>
		if (
			typeof version === "string" &&
			version.length <= 128 &&
			/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version)
		)
			snapshot.version = version
		if (
			typeof main !== "string" ||
			main.length > 1_024 ||
			main.includes("\0") ||
			!path.isAbsolute(extension.extensionPath)
		)
			return snapshot
		const root = await realpath(extension.extensionPath)
		const declared = path.resolve(root, main)
		const contained = (candidate: string) => {
			const relative = path.relative(root, candidate)
			return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
		}
		if (!contained(declared)) return snapshot
		// VS Code extension manifests may omit the .js suffix consumed by Node's entrypoint resolver.
		const entrypoint = await realpath(declared).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT" || path.extname(declared)) throw error
			return realpath(`${declared}.js`)
		})
		if (!contained(entrypoint)) return snapshot
		const before = await lstat(entrypoint)
		if (!before.isFile() || before.size > MAX_ENTRYPOINT_BYTES) return snapshot
		const hash = createHash("sha256")
		let bytes = 0
		for await (const chunk of createReadStream(entrypoint)) {
			bytes += chunk.length
			if (bytes > MAX_ENTRYPOINT_BYTES) throw new Error("Provider entrypoint exceeds identity bound")
			hash.update(chunk)
		}
		const after = await lstat(entrypoint)
		if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) return snapshot
		snapshot.entrypointSha256 = hash.digest("hex")
	} catch {
		// An unavailable build is an unknown condition, never an inferred stable provider.
	}
	return snapshot
}

export function compareLiveProviderIdentity(
	before: LiveProviderExtensionSnapshot,
	after: LiveProviderExtensionSnapshot,
): LiveProviderIdentityReceipt {
	const changed =
		(before.version !== null && after.version !== null && before.version !== after.version) ||
		(before.entrypointSha256 !== null &&
			after.entrypointSha256 !== null &&
			before.entrypointSha256 !== after.entrypointSha256)
	const known =
		before.version !== null &&
		after.version !== null &&
		before.entrypointSha256 !== null &&
		after.entrypointSha256 !== null
	return { schemaVersion: 1, before, after, status: changed ? "changed" : known ? "unchanged" : "unknown" }
}

export function isLiveProviderIdentityReceipt(value: unknown): value is LiveProviderIdentityReceipt {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false
	const receipt = value as Record<string, unknown>
	if (receipt.schemaVersion !== 1 || !["unchanged", "changed", "unknown"].includes(String(receipt.status)))
		return false
	const snapshot = (entry: unknown): entry is LiveProviderExtensionSnapshot => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false
		const candidate = entry as Record<string, unknown>
		return (
			Object.keys(candidate).every((key) => ["id", "version", "entrypointSha256"].includes(key)) &&
			candidate.id === LIVE_PROVIDER_EXTENSION_ID &&
			(candidate.version === null ||
				(typeof candidate.version === "string" &&
					candidate.version.length <= 128 &&
					/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(candidate.version))) &&
			(candidate.entrypointSha256 === null ||
				(typeof candidate.entrypointSha256 === "string" && /^[a-f0-9]{64}$/.test(candidate.entrypointSha256)))
		)
	}
	return (
		Object.keys(receipt).every((key) => ["schemaVersion", "before", "after", "status"].includes(key)) &&
		snapshot(receipt.before) &&
		snapshot(receipt.after) &&
		compareLiveProviderIdentity(receipt.before, receipt.after).status === receipt.status
	)
}

/** Publish observed conditions even after a failed suite; unknown conditions cannot establish a live pass. */
export async function withLiveProviderIdentity(
	run: () => Promise<void>,
	provider: () => ExtensionIdentitySource | undefined,
	publish: (receipt: LiveProviderIdentityReceipt) => Promise<void>,
	options: { setup?: boolean } = {},
): Promise<void> {
	const before = await captureLiveProviderExtension(provider())
	let failed = false
	let failure: unknown
	try {
		await run()
	} catch (error) {
		failed = true
		failure = error
	}
	const receipt = compareLiveProviderIdentity(before, await captureLiveProviderExtension(provider()))
	await publish(receipt)
	if (failed) throw failure
	// Installing/updating the provider is intentional during setup; setup is never scored evaluation evidence.
	if (!options.setup && receipt.status !== "unchanged")
		throw new TestRunError(
			"provider-unavailable",
			"The live provider implementation changed or could not be identified",
		)
}
