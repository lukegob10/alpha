import fs from "node:fs/promises"
import { constants } from "node:fs"
import { randomUUID } from "node:crypto"
import path from "node:path"

import { z } from "zod"

import {
	FilesystemArtifactStore,
	type ContentAddressedArtifactStore,
	type PutArtifactInput,
} from "../evidence/artifactStore"
import { canonicalJson, sha256 } from "../evidence/canonical"
import { evidenceBundleDigest, validateEvidenceBundle } from "../evidence/integrity"
import { containsSecret } from "../evidence/redaction"
import type { ArtifactDescriptor, EvidenceBundle } from "../evidence/types"

const MAX_JSON_BYTES = 8 * 1024 * 1024
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
const MAX_BUNDLE_BYTES = 256 * 1024 * 1024
const MAX_STAGE_ANCESTRY = 256
const reservedPathComponent = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
const idSchema = z
	.string()
	.regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/)
	.refine((value) => !reservedPathComponent.test(value), "Reserved filesystem ID")
const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
export const improvementStageSchema = z.enum([
	"capture",
	"host-observation",
	"native-source",
	"harness-context",
	"execution-request",
	"feedback",
	"feedback-review",
	"regression-proposal",
	"materialization",
	"validation",
	"handoff",
	"reviewed-repair",
	"confirmation-plan",
	"confirmation",
	"report",
	"archived-regrade",
])
export type ImprovementStage = z.infer<typeof improvementStageSchema>

const artifactSchema = z
	.object({
		schemaVersion: z.literal(1),
		id: z.string().min(1).max(256),
		attemptId: z.string().min(1).max(256),
		kind: z.enum([
			"final_diff",
			"git_status",
			"tree_digest",
			"transcript",
			"final_response",
			"test_output",
			"extension_log",
			"environment_manifest",
			"usage",
			"stop_reason",
			"full_output",
			"grader_evidence",
			"workspace_snapshot",
			"other",
		]),
		digest: digestSchema,
		mediaType: z.string().min(1).max(256),
		sizeBytes: z.number().int().min(0).max(MAX_ARTIFACT_BYTES),
		access: z.enum(["private", "reviewer", "public"]),
		retention: z.enum(["campaign", "baseline", "permanent"]),
		uploadState: z.enum(["complete", "incomplete"]),
		captureStatus: z.enum(["captured", "captured-empty", "missing", "unavailable", "failed"]).optional(),
		createdAt: z.string().datetime(),
	})
	.strict()

export const stageReferenceSchema = z
	.object({
		id: idSchema,
		stage: improvementStageSchema,
		digest: digestSchema,
	})
	.strict()
export type StageReference = z.infer<typeof stageReferenceSchema>
const stageInputsSchema = z
	.array(stageReferenceSchema)
	.max(64)
	.refine(
		(inputs) => new Set(inputs.map(({ id }) => id)).size === inputs.length,
		"Improvement inputs must be unique prior stages",
	)
const stageManifestSchema = z
	.object({
		schemaVersion: z.literal(1),
		recordType: z.literal("improvement-stage"),
		iterationId: idSchema,
		id: idSchema,
		stage: improvementStageSchema,
		createdAt: z.string().datetime(),
		inputs: stageInputsSchema,
		requestDigest: digestSchema.optional(),
		artifact: artifactSchema,
		digest: digestSchema,
	})
	.strict()
export type StageManifest = z.infer<typeof stageManifestSchema>
export type StoredStage = { manifest: StageManifest; value: unknown }

const bundleSchema = z
	.object({
		schemaVersion: z.literal(1),
		runId: z.string().min(1).max(256),
		trialId: z.string().min(1).max(256),
		attemptId: z.string().min(1).max(256),
		taskIdentity: z.string().min(1).max(512),
		variantIdentity: z.string().min(1).max(512),
		identityStatus: z.literal("attempt-bound").optional(),
		bundleDigest: digestSchema,
		events: z
			.array(
				z
					.object({
						schemaVersion: z.literal(1),
						runId: z.string().min(1).max(256),
						trialId: z.string().min(1).max(256),
						attemptId: z.string().min(1).max(256),
						sequence: z.number().int().positive(),
						timestamp: z.string().datetime(),
						type: z.string().min(1).max(256),
						payload: z.unknown(),
						payloadDigest: digestSchema,
						redactionVersion: z.literal("alpha-redaction-v1"),
						late: z.boolean(),
					})
					.strict(),
			)
			.min(1)
			.max(50000),
		artifacts: z.array(artifactSchema).min(1).max(128),
	})
	.strict()

export function stageReference(manifest: StageManifest): StageReference {
	return { id: manifest.id, stage: manifest.stage, digest: manifest.digest }
}

export function parseImprovementEvidenceBundle(value: unknown): EvidenceBundle {
	const parsed = bundleSchema.parse(value)
	for (const event of parsed.events)
		if (!Object.hasOwn(event, "payload")) throw new Error("Evidence event payload is required")
	return { ...parsed, events: parsed.events.map((event) => ({ ...event, payload: event.payload })) }
}

export function assertPrivateContent(value: unknown, secrets: string[] = []): void {
	const serialized = typeof value === "string" ? value : canonicalJson(value)
	if (
		containsSecret(value, secrets) ||
		/\b(?:Bearer\s+[a-zA-Z0-9._~-]{12,}|sk-(?:proj-|svcacct-)?[a-zA-Z0-9_-]{20,})/.test(serialized)
	)
		throw new Error("Improvement input contains credentials; redact at the source before sealing")
	const inspect = (item: unknown): void => {
		if (Array.isArray(item)) {
			for (const child of item) inspect(child)
			return
		}
		if (!item || typeof item !== "object") return
		for (const [key, child] of Object.entries(item)) {
			if (
				/^(?:authorization|cookie|credentials?|password|secret|api[-_]?key|access[-_]?token|refresh[-_]?token)$/i.test(
					key,
				) &&
				typeof child === "string" &&
				child.length > 0 &&
				!child.startsWith("[REDACTED:")
			)
				throw new Error("Improvement input contains credentials; redact at the source before sealing")
			inspect(child)
		}
	}
	inspect(value)
}

/** Reject traversal and symlinks in every component, including ancestors of an explicitly selected root. */
async function checkedPath(absolutePath: string, createDirectories = false): Promise<void> {
	if (!path.isAbsolute(absolutePath) || absolutePath.includes("\0"))
		throw new Error("An absolute owned path is required")
	if (absolutePath.split(/[\\/]/).some((component) => component === "." || component === ".."))
		throw new Error("Path traversal is forbidden")
	const parsed = path.parse(absolutePath)
	let current = parsed.root
	for (const component of path.relative(parsed.root, absolutePath).split(path.sep).filter(Boolean)) {
		if (component === "." || component === ".." || component.includes(":") || reservedPathComponent.test(component))
			throw new Error("Path traversal or reserved filesystem component is forbidden")
		current = path.join(current, component)
		try {
			const stat = await fs.lstat(current)
			if (stat.isSymbolicLink()) throw new Error("Symlink paths are forbidden for improvement artifacts")
			if (createDirectories && !stat.isDirectory()) throw new Error("Improvement directory path contains a file")
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !createDirectories) throw error
			try {
				await fs.mkdir(current, { mode: 0o700 })
			} catch (mkdirError) {
				if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError
			}
			const stat = await fs.lstat(current)
			if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe improvement directory")
		}
	}
}

export async function readBoundedFile(absolutePath: string, maxBytes = MAX_JSON_BYTES): Promise<Uint8Array> {
	await checkedPath(absolutePath)
	const before = await fs.lstat(absolutePath)
	if (!before.isFile() || before.size > maxBytes) throw new Error("Improvement input is not a bounded regular file")
	const handle = await fs.open(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
	try {
		const opened = await handle.stat()
		if (!opened.isFile() || opened.size !== before.size || opened.dev !== before.dev || opened.ino !== before.ino)
			throw new Error("Improvement input changed while opening")
		const bytes = Buffer.alloc(opened.size + 1)
		let offset = 0
		while (offset < bytes.length) {
			const result = await handle.read(bytes, offset, bytes.length - offset, offset)
			if (!result.bytesRead) break
			offset += result.bytesRead
		}
		const after = await handle.stat()
		await checkedPath(absolutePath)
		const retained = await fs.lstat(absolutePath)
		if (
			offset !== opened.size ||
			after.size !== opened.size ||
			after.mtimeMs !== opened.mtimeMs ||
			after.ctimeMs !== opened.ctimeMs ||
			retained.ino !== opened.ino ||
			retained.dev !== opened.dev ||
			retained.size !== opened.size ||
			retained.mtimeMs !== opened.mtimeMs ||
			retained.ctimeMs !== opened.ctimeMs
		)
			throw new Error("Improvement input changed while reading")
		return bytes.subarray(0, offset)
	} finally {
		await handle.close()
	}
}

export async function readBoundedJson(absolutePath: string): Promise<unknown> {
	try {
		return JSON.parse(new TextDecoder().decode(await readBoundedFile(absolutePath)))
	} catch (error) {
		if (error instanceof SyntaxError) throw new Error("Improvement input must contain valid JSON")
		throw error
	}
}

export async function readOwnedFile(
	root: string,
	relativePath: string,
	maxBytes = MAX_JSON_BYTES,
): Promise<Uint8Array> {
	if (
		!relativePath ||
		relativePath.includes("\\") ||
		relativePath.includes(":") ||
		path.isAbsolute(relativePath) ||
		relativePath.split("/").some((part) => !part || part === "." || part === "..")
	)
		throw new Error("A contained relative file path is required")
	await checkedPath(root)
	return readBoundedFile(path.join(root, ...relativePath.split("/")), maxBytes)
}

export async function ensureOwnedDirectory(absolutePath: string): Promise<void> {
	await checkedPath(absolutePath, true)
}

export async function writeOwnedJson(root: string, relativePath: string, value: unknown): Promise<void> {
	if (
		!relativePath ||
		relativePath.includes("\\") ||
		relativePath.includes(":") ||
		path.isAbsolute(relativePath) ||
		relativePath.split("/").some((part) => !part || part === "." || part === "..")
	)
		throw new Error("A contained output path is required")
	await checkedPath(root)
	const target = path.join(root, ...relativePath.split("/"))
	await checkedPath(path.dirname(target))
	const bytes = canonicalJson(value) + "\n"
	if (Buffer.byteLength(bytes) > MAX_JSON_BYTES) throw new Error("Improvement output exceeds its JSON byte budget")
	const temporary = path.join(path.dirname(target), `.publish-${randomUUID()}.partial`)
	try {
		const handle = await fs.open(temporary, "wx", 0o600)
		try {
			await handle.writeFile(bytes)
			await handle.sync()
		} finally {
			await handle.close()
		}
		await checkedPath(path.dirname(target))
		await fs.link(temporary, target)
	} finally {
		await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error
		})
	}
}

/** The existing CAS layout and writer remain authoritative; this adapter bounds and checks its filesystem boundary. */
export function privateArtifactStore(root: string, secrets: string[] = []): ContentAddressedArtifactStore {
	const delegate = new FilesystemArtifactStore(root)
	const artifactPath = (digest: string) => {
		const hex = digestSchema.parse(digest).slice(7)
		return path.join(root, "sha256", hex.slice(0, 2), hex)
	}
	return {
		async put(input: PutArtifactInput) {
			if (input.bytes.byteLength > MAX_ARTIFACT_BYTES)
				throw new Error("Improvement artifact exceeds its byte budget")
			assertPrivateContent(new TextDecoder().decode(input.bytes), secrets)
			await checkedPath(root, true)
			const target = artifactPath(sha256(input.bytes))
			await checkedPath(path.dirname(target), true)
			try {
				await checkedPath(target)
				const existing = await readBoundedFile(target, input.bytes.byteLength)
				if (existing.byteLength !== input.bytes.byteLength || sha256(existing) !== sha256(input.bytes))
					throw new Error("Existing improvement CAS content differs from its digest")
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			}
			return delegate.put({ ...input, access: "private" })
		},
		async get(descriptor: ArtifactDescriptor) {
			artifactSchema.parse(descriptor)
			try {
				await checkedPath(root)
				const bytes = await readBoundedFile(artifactPath(descriptor.digest), descriptor.sizeBytes)
				if (bytes.length !== descriptor.sizeBytes || sha256(bytes) !== descriptor.digest)
					throw new Error("Improvement CAS content differs from its descriptor")
				return bytes
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
				throw error
			}
		},
	}
}

export class ImprovementArtifactStore {
	readonly artifacts: ContentAddressedArtifactStore
	private constructor(
		readonly root: string,
		readonly iterationId: string,
		private readonly secrets: string[],
	) {
		this.artifacts = privateArtifactStore(path.join(root, "artifacts"), secrets)
	}
	static async open(options: {
		root: string
		iterationId: string
		secrets?: string[]
	}): Promise<ImprovementArtifactStore> {
		idSchema.parse(options.iterationId)
		await checkedPath(options.root, true)
		await checkedPath(path.join(options.root, "iterations", options.iterationId, "records"), true)
		return new ImprovementArtifactStore(options.root, options.iterationId, options.secrets ?? [])
	}
	private recordPath(id: string): string {
		return path.join(this.root, "iterations", this.iterationId, "records", `${idSchema.parse(id)}.json`)
	}
	async read(idOrRef: string | StageReference): Promise<StoredStage> {
		return this.readWithAncestors(idOrRef, new Set(), new Map())
	}
	private async readWithAncestors(
		idOrRef: string | StageReference,
		active: Set<string>,
		validated: Map<string, StoredStage>,
	): Promise<StoredStage> {
		const id = typeof idOrRef === "string" ? idOrRef : stageReferenceSchema.parse(idOrRef).id
		const prior = validated.get(id)
		if (prior) {
			if (
				typeof idOrRef !== "string" &&
				(idOrRef.digest !== prior.manifest.digest || idOrRef.stage !== prior.manifest.stage)
			)
				throw new Error("Improvement stage reference does not match immutable input")
			return prior
		}
		if (active.has(id) || validated.size + active.size >= MAX_STAGE_ANCESTRY)
			throw new Error("Improvement ancestry is cyclic or exceeds its bound")
		active.add(id)
		try {
			const manifest = stageManifestSchema.parse(await readBoundedJson(this.recordPath(id)))
			const { digest, ...body } = manifest
			if (
				manifest.id !== id ||
				manifest.iterationId !== this.iterationId ||
				digest !== sha256(canonicalJson(body))
			)
				throw new Error("Improvement stage identity or seal mismatch")
			if (typeof idOrRef !== "string" && (idOrRef.digest !== digest || idOrRef.stage !== manifest.stage))
				throw new Error("Improvement stage reference does not match immutable input")
			if (manifest.artifact.access !== "private" || manifest.artifact.attemptId !== this.iterationId)
				throw new Error("Improvement stage artifact must be private and iteration-bound")
			const bytes = await this.artifacts.get(manifest.artifact)
			if (
				!bytes ||
				bytes.byteLength > MAX_JSON_BYTES ||
				bytes.byteLength !== manifest.artifact.sizeBytes ||
				sha256(bytes) !== manifest.artifact.digest
			)
				throw new Error("Improvement stage artifact is missing or corrupt")
			const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
			assertPrivateContent(value, this.secrets)
			for (const input of manifest.inputs) await this.readWithAncestors(input, active, validated)
			const stored = { manifest, value }
			validated.set(id, stored)
			return stored
		} finally {
			active.delete(id)
		}
	}
	async write(input: {
		id: string
		stage: ImprovementStage
		inputs?: StageReference[]
		requestDigest?: string
		value: unknown
	}): Promise<StoredStage> {
		// Capture the complete request before ancestry reads yield to caller-owned mutable objects.
		const id = idSchema.parse(input.id)
		const stage = improvementStageSchema.parse(input.stage)
		const requestDigest = input.requestDigest === undefined ? undefined : digestSchema.parse(input.requestDigest)
		const inputs = stageInputsSchema.parse(input.inputs ?? [])
		if (inputs.some((ref) => ref.id === id)) throw new Error("Improvement inputs must be unique prior stages")
		const serialized = canonicalJson(input.value)
		if (typeof serialized !== "string" || Buffer.byteLength(serialized) > MAX_JSON_BYTES)
			throw new Error("Improvement stage exceeds its JSON byte budget")
		const value: unknown = JSON.parse(serialized)
		assertPrivateContent(value, this.secrets)
		// Publication must fit the reader's combined graph, including the new record itself.
		const active = new Set([id])
		const validated = new Map<string, StoredStage>()
		for (const ref of inputs) await this.readWithAncestors(ref, active, validated)
		const contentDigest = sha256(serialized)
		const matching = (stored: StoredStage) => {
			if (
				stored.manifest.stage !== stage ||
				stored.manifest.artifact.digest !== contentDigest ||
				canonicalJson(stored.manifest.inputs) !== canonicalJson(inputs) ||
				stored.manifest.requestDigest !== requestDigest
			)
				throw new Error("Improvement ID already records different immutable content")
			return stored
		}
		try {
			return matching(await this.read(id))
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		}
		const artifact = await this.artifacts.put({
			attemptId: this.iterationId,
			kind: "other",
			bytes: new TextEncoder().encode(serialized),
			mediaType: "application/json",
			access: "private",
		})
		const body = {
			schemaVersion: 1 as const,
			recordType: "improvement-stage" as const,
			iterationId: this.iterationId,
			id,
			stage,
			createdAt: new Date().toISOString(),
			inputs,
			artifact,
			...(requestDigest ? { requestDigest } : {}),
		}
		const manifest = stageManifestSchema.parse({ ...body, digest: sha256(canonicalJson(body)) })
		const target = this.recordPath(id)
		await checkedPath(path.dirname(target))
		try {
			await writeOwnedJson(path.dirname(target), path.basename(target), manifest)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
			return matching(await this.read(id))
		}
		return { manifest, value }
	}
	async importEvidence(value: unknown, sourceArtifactsRoot: string): Promise<EvidenceBundle> {
		const bundle = parseImprovementEvidenceBundle(value)
		if (bundle.bundleDigest !== evidenceBundleDigest(bundle)) throw new Error("Evidence source seal mismatch")
		if (
			new Set(bundle.artifacts.map(({ kind, digest }) => `${kind}:${digest}`)).size !== bundle.artifacts.length ||
			bundle.artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0) > MAX_BUNDLE_BYTES
		)
			throw new Error("Evidence artifacts duplicate IDs or exceed the import byte budget")
		assertPrivateContent(bundle, this.secrets)
		await checkedPath(sourceArtifactsRoot)
		const source = privateArtifactStore(sourceArtifactsRoot, this.secrets)
		const integrity = await validateEvidenceBundle(bundle, source)
		if (!integrity.valid)
			throw new Error(
				`Evidence source failed integrity: ${[...new Set(integrity.issues.map(({ code }) => code))].join(", ")}`,
			)
		for (const descriptor of bundle.artifacts) {
			const bytes = await source.get(descriptor)
			if (!bytes) throw new Error("Evidence source artifact disappeared during import")
			const copied = await this.artifacts.put({ ...descriptor, bytes })
			if (copied.digest !== descriptor.digest) throw new Error("Evidence artifact changed during import")
		}
		return bundle
	}
}
