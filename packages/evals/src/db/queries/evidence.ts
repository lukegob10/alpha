import { asc, eq } from "drizzle-orm"

import {
	canonicalJson,
	manifestIdentity,
	sha256,
	type ArtifactDescriptor,
	type EvalEvent,
	type TaskManifest,
	type VariantManifest,
} from "../../evidence/index"
import type { EvidenceBundle } from "../../evidence/index"
import { client as db } from "../db"
import { artifacts, attempts, evalEvents, taskDefinitions, trials, variants } from "../schema"

export function persistEvalEvent(attemptId: number, event: EvalEvent) {
	return db
		.insert(evalEvents)
		.values({
			attemptId,
			schemaVersion: event.schemaVersion,
			sequence: event.sequence,
			timestamp: new Date(event.timestamp),
			type: event.type,
			payload: event.payload,
			payloadDigest: event.payloadDigest,
			redactionVersion: event.redactionVersion,
			late: event.late,
			createdAt: new Date(),
		})
		.onConflictDoNothing({ target: [evalEvents.attemptId, evalEvents.sequence] })
		.returning()
}

export function persistArtifactDescriptors(attemptId: number, descriptors: ArtifactDescriptor[], storageRoot: string) {
	if (descriptors.length === 0) return Promise.resolve([])
	return db
		.insert(artifacts)
		.values(
			descriptors.map((descriptor) => ({
				attemptId,
				schemaVersion: descriptor.schemaVersion,
				contentId: descriptor.id,
				kind: descriptor.kind,
				digest: descriptor.digest,
				mediaType: descriptor.mediaType,
				sizeBytes: descriptor.sizeBytes,
				access: descriptor.access,
				retention: descriptor.retention,
				uploadState: descriptor.uploadState,
				storageKey: `${storageRoot.replaceAll("\\", "/")}/sha256/${descriptor.digest.slice(7, 9)}/${descriptor.digest.slice(7)}`,
				createdAt: new Date(descriptor.createdAt),
			})),
		)
		.onConflictDoNothing({ target: [artifacts.attemptId, artifacts.kind, artifacts.digest] })
		.returning()
}

export function getEvalEvents(attemptId: number) {
	return db.query.evalEvents.findMany({
		where: eq(evalEvents.attemptId, attemptId),
		orderBy: asc(evalEvents.sequence),
	})
}

export function getArtifactDescriptors(attemptId: number) {
	return db.query.artifacts.findMany({ where: eq(artifacts.attemptId, attemptId), orderBy: asc(artifacts.id) })
}

export async function recordEvidenceIntegrity(input: {
	attemptId: number
	status: "pending" | "valid" | "invalid"
	taskIdentity: string
	variantIdentity: string
	bundleDigest?: string
}) {
	return db.transaction(async (tx) => {
		const [attempt] = await tx
			.update(attempts)
			.set({ evidenceStatus: input.status, evidenceBundleDigest: input.bundleDigest, updatedAt: new Date() })
			.where(eq(attempts.id, input.attemptId))
			.returning()
		if (!attempt) throw new Error(`Attempt ${input.attemptId} not found while recording evidence integrity`)
		await tx
			.update(trials)
			.set({
				taskDefinitionIdentity: input.taskIdentity,
				variantIdentity: input.variantIdentity,
				updatedAt: new Date(),
			})
			.where(eq(trials.id, attempt.trialId))
		return attempt
	})
}

export async function persistRuntimeIdentities(taskManifest: TaskManifest, variantManifest: VariantManifest) {
	const taskIdentity = manifestIdentity(taskManifest)
	const variantIdentity = manifestIdentity(variantManifest)
	await db.transaction(async (tx) => {
		await tx
			.insert(taskDefinitions)
			.values({
				identity: taskIdentity,
				schemaVersion: taskManifest.schemaVersion,
				manifest: taskManifest,
				manifestDigest: sha256(canonicalJson(taskManifest)),
				createdAt: new Date(),
			})
			.onConflictDoNothing()
		await tx
			.insert(variants)
			.values({
				identity: variantIdentity,
				schemaVersion: variantManifest.schemaVersion,
				manifest: variantManifest,
				manifestDigest: sha256(canonicalJson(variantManifest)),
				createdAt: new Date(),
			})
			.onConflictDoNothing()
	})
	return { taskIdentity, variantIdentity }
}

export async function getReconstructableEvidenceBundle(attemptId: number): Promise<EvidenceBundle> {
	const attempt = await db.query.attempts.findFirst({
		where: eq(attempts.id, attemptId),
		with: {
			trial: { with: { task: true } },
			events: { orderBy: asc(evalEvents.sequence) },
			artifacts: { orderBy: asc(artifacts.id) },
		},
	})
	if (!attempt) throw new Error(`Attempt ${attemptId} not found`)
	if (attempt.evidenceStatus !== "valid")
		throw new Error(`Attempt ${attemptId} evidence is ${attempt.evidenceStatus}`)
	if (!attempt.trial.taskDefinitionIdentity || !attempt.trial.variantIdentity)
		throw new Error(`Attempt ${attemptId} lacks immutable identities`)
	return {
		schemaVersion: 1,
		runId: String(attempt.trial.task.runId),
		trialId: String(attempt.trialId),
		attemptId: String(attempt.id),
		taskIdentity: attempt.trial.taskDefinitionIdentity,
		variantIdentity: attempt.trial.variantIdentity,
		events: attempt.events.map((event) => ({
			schemaVersion: 1,
			runId: String(attempt.trial.task.runId),
			trialId: String(attempt.trialId),
			attemptId: String(attempt.id),
			sequence: event.sequence,
			timestamp: event.timestamp.toISOString(),
			type: event.type,
			payload: event.payload,
			payloadDigest: event.payloadDigest,
			redactionVersion: "alpha-redaction-v1",
			late: event.late,
		})),
		artifacts: attempt.artifacts.map((artifact) => ({
			schemaVersion: 1,
			id: artifact.contentId,
			attemptId: String(attempt.id),
			kind: artifact.kind,
			digest: artifact.digest,
			mediaType: artifact.mediaType,
			sizeBytes: artifact.sizeBytes,
			access: artifact.access,
			retention: artifact.retention,
			uploadState: artifact.uploadState,
			createdAt: artifact.createdAt.toISOString(),
		})),
	}
}
