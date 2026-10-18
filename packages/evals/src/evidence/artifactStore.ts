import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

import { sha256 } from "./canonical"
import { EVIDENCE_SCHEMA_VERSION, type ArtifactDescriptor, type ArtifactKind } from "./types"

export type PutArtifactInput = {
	attemptId: string
	kind: ArtifactKind
	bytes: Uint8Array
	mediaType: string
	access?: ArtifactDescriptor["access"]
	retention?: ArtifactDescriptor["retention"]
	createdAt?: string
}

export interface ContentAddressedArtifactStore {
	put(input: PutArtifactInput): Promise<ArtifactDescriptor>
	get(descriptor: ArtifactDescriptor): Promise<Uint8Array | undefined>
}

export class FilesystemArtifactStore implements ContentAddressedArtifactStore {
	constructor(private readonly root: string) {}

	async put(input: PutArtifactInput): Promise<ArtifactDescriptor> {
		const digest = sha256(input.bytes)
		const hex = digest.slice("sha256:".length)
		const target = path.join(this.root, "sha256", hex.slice(0, 2), hex)
		await fs.mkdir(path.dirname(target), { recursive: true })
		try {
			const existing = await fs.readFile(target)
			if (sha256(existing) !== digest) throw new Error(`Artifact collision at ${target}`)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			const partial = `${target}.${randomUUID()}.partial`
			try {
				await fs.writeFile(partial, input.bytes, { flag: "wx" })
				await fs.rename(partial, target)
			} finally {
				await fs.rm(partial, { force: true })
			}
			// Retire staging files left by the previous single-writer format after publishing complete bytes.
			await fs.rm(`${target}.partial`, { force: true })
		}
		return {
			schemaVersion: EVIDENCE_SCHEMA_VERSION,
			id: digest,
			attemptId: input.attemptId,
			kind: input.kind,
			digest,
			mediaType: input.mediaType,
			sizeBytes: input.bytes.byteLength,
			access: input.access ?? "reviewer",
			retention: input.retention ?? "campaign",
			uploadState: "complete",
			createdAt: input.createdAt ?? new Date().toISOString(),
		}
	}

	async get(descriptor: ArtifactDescriptor): Promise<Uint8Array | undefined> {
		const hex = descriptor.digest.slice("sha256:".length)
		try {
			return await fs.readFile(path.join(this.root, "sha256", hex.slice(0, 2), hex))
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
			throw error
		}
	}
}
