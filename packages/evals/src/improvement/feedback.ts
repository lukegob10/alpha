import { canonicalJson, sha256 } from "../evidence/canonical"
import { evidenceBundleDigest, validateEvidenceBundle } from "../evidence/integrity"
import { containsSecret } from "../evidence/redaction"
import type { ContentAddressedArtifactStore } from "../evidence/artifactStore"
import type { EvidenceBundle } from "../evidence/types"
import {
	evidenceReferenceSchema,
	feedbackInputSchema,
	feedbackReviewInputSchema,
	feedbackReviewSchema,
	feedbackSchema,
	improvementDigestSchema,
	type EvidenceReference,
	type Feedback,
	type FeedbackReview,
} from "./contracts"

export type FeedbackEvidenceContext = {
	bundle: EvidenceBundle
	store: ContentAddressedArtifactStore
	secrets?: string[]
	signal?: AbortSignal
}

export const FEEDBACK_EVIDENCE_LIMITS = {
	artifactBytes: 64 * 1024 * 1024,
	totalArtifactBytes: 128 * 1024 * 1024,
	metadataBytes: 16 * 1024 * 1024,
	eventPayloadBytes: 256 * 1024,
	verificationMs: 30_000,
} as const

/** Parse authentic content identity only; use validateFeedback before trusting its evidence references. */
export function parseFeedback(value: unknown): Feedback {
	const parsed = feedbackSchema.safeParse(value)
	if (!parsed.success) throw new Error("Invalid feedback record schema")
	assertDigest(parsed.data)
	assertSafeImprovementContent(parsed.data)
	return freezeRecord(parsed.data)
}

export function parseFeedbackReview(value: unknown): FeedbackReview {
	const parsed = feedbackReviewSchema.safeParse(value)
	if (!parsed.success) throw new Error("Invalid human feedback review schema")
	assertDigest(parsed.data)
	assertSafeImprovementContent(parsed.data)
	return freezeRecord(parsed.data)
}

export async function validateEvidenceReference(
	value: unknown,
	context: FeedbackEvidenceContext,
): Promise<EvidenceReference> {
	const parsed = evidenceReferenceSchema.safeParse(value)
	if (!parsed.success) throw new Error("Invalid feedback evidence reference")
	const reference = parsed.data
	// Validate a snapshot so concurrent callers cannot change the identity while CAS reads are pending.
	let bundle: EvidenceBundle
	try {
		assertBoundedJson(context.bundle, FEEDBACK_EVIDENCE_LIMITS.metadataBytes)
		bundle = structuredClone(context.bundle)
	} catch {
		throw new Error("Feedback requires bounded JSON evidence metadata")
	}
	if (
		!bundle ||
		bundle.schemaVersion !== 1 ||
		bundle.identityStatus === "legacy-unavailable" ||
		!bundle.taskIdentity ||
		!bundle.variantIdentity ||
		!improvementDigestSchema.safeParse(bundle.bundleDigest).success ||
		!Array.isArray(bundle.events) ||
		!Array.isArray(bundle.artifacts) ||
		bundle.events.length > 100_000 ||
		bundle.artifacts.length > 2_000
	)
		throw new Error("Feedback requires a bounded sealed attempt evidence bundle")
	let totalBytes = 0
	for (const artifact of bundle.artifacts) {
		if (
			!artifact ||
			!Number.isSafeInteger(artifact.sizeBytes) ||
			artifact.sizeBytes < 0 ||
			artifact.sizeBytes > FEEDBACK_EVIDENCE_LIMITS.artifactBytes
		)
			throw new Error("Feedback artifact size exceeds the evidence bounds")
		totalBytes += artifact.sizeBytes
		if (totalBytes > FEEDBACK_EVIDENCE_LIMITS.totalArtifactBytes)
			throw new Error("Feedback artifacts exceed the total evidence byte bound")
	}
	try {
		for (const event of bundle.events) assertBoundedJson(event.payload, FEEDBACK_EVIDENCE_LIMITS.eventPayloadBytes)
	} catch {
		throw new Error("Feedback event payload exceeds bounded JSON evidence")
	}
	if (
		reference.runId !== bundle.runId ||
		reference.trialId !== bundle.trialId ||
		reference.attemptId !== bundle.attemptId ||
		reference.bundleDigest !== bundle.bundleDigest
	)
		throw new Error("Feedback evidence identity mismatch")
	try {
		if (reference.bundleDigest !== evidenceBundleDigest(bundle)) throw new Error("Changed evidence bundle")
		const integrity = await verifyWithinDeadline((signal) => {
			const boundedStore: ContentAddressedArtifactStore = {
				put: (input) => context.store.put(input),
				get: async (artifact) => {
					if (signal.aborted) throw new Error("Evidence verification aborted")
					const bytes = await context.store.get(artifact)
					if (signal.aborted) throw new Error("Evidence verification aborted")
					if (bytes && bytes.byteLength > FEEDBACK_EVIDENCE_LIMITS.artifactBytes)
						throw new Error("Retained artifact exceeds the evidence byte bound")
					return bytes
				},
			}
			return validateEvidenceBundle(bundle, boundedStore)
		}, context.signal)
		if (!integrity.valid) throw new Error("Invalid evidence integrity")
	} catch {
		throw new Error("Feedback evidence failed sealed bundle or artifact integrity verification")
	}
	if (
		reference.eventSequence !== undefined &&
		!bundle.events.some(({ sequence }) => sequence === reference.eventSequence)
	)
		throw new Error("Feedback event anchor is missing from the sealed attempt")
	if (
		reference.artifactDigest !== undefined &&
		!bundle.artifacts.some(({ digest }) => digest === reference.artifactDigest)
	)
		throw new Error("Feedback artifact anchor is missing from the sealed attempt")
	return freezeRecord(reference)
}

export async function sealFeedback(value: unknown, context: FeedbackEvidenceContext): Promise<Feedback> {
	const parsed = feedbackInputSchema.safeParse(value)
	if (!parsed.success) throw new Error("Invalid feedback input schema")
	assertSafeImprovementContent(parsed.data, context.secrets)
	await validateEvidenceReference(parsed.data.evidence, context)
	return parseFeedback({ ...parsed.data, digest: sha256(canonicalJson(parsed.data)) })
}

export async function validateFeedback(value: unknown, context: FeedbackEvidenceContext): Promise<Feedback> {
	const feedback = parseFeedback(value)
	assertSafeImprovementContent(feedback, context.secrets)
	await validateEvidenceReference(feedback.evidence, context)
	return feedback
}

/** The trusted caller owns human authentication; an LLM response is never an adjudication input. */
export function sealFeedbackReview(value: unknown, feedback: Feedback): FeedbackReview {
	const parsed = feedbackReviewInputSchema.safeParse(value)
	if (!parsed.success) throw new Error("Invalid human feedback review input schema")
	const review = { ...parsed.data, digest: sha256(canonicalJson(parsed.data)) }
	return validateFeedbackReview(review, feedback)
}

export function validateFeedbackReview(value: unknown, feedback: Feedback): FeedbackReview {
	const review = parseFeedbackReview(value)
	const original = parseFeedback(feedback)
	if (review.feedbackDigest !== original.digest) throw new Error("Human review references different feedback")
	if (Date.parse(review.createdAt) < Date.parse(original.createdAt))
		throw new Error("Human review predates the referenced feedback")
	return review
}

export function assertFeedbackAppend(existing: readonly Feedback[], incoming: Feedback): void {
	assertAppend(existing.map(parseFeedback), parseFeedback(incoming))
}

export function assertFeedbackReviewAppend(existing: readonly FeedbackReview[], incoming: FeedbackReview): void {
	assertAppend(existing.map(parseFeedbackReview), parseFeedbackReview(incoming))
}

function assertAppend(
	existing: readonly { id: string; digest: string }[],
	incoming: { id: string; digest: string },
): void {
	const identities = new Map<string, string>()
	for (const record of [...existing, incoming]) {
		const previous = identities.get(record.id)
		if (previous && previous !== record.digest) throw new Error("Immutable feedback record ID cannot be rewritten")
		identities.set(record.id, record.digest)
	}
}

function assertDigest(record: { digest: string }): void {
	const { digest, ...content } = record
	if (digest !== sha256(canonicalJson(content))) throw new Error("Feedback record digest mismatch")
}

/** Reject credentials before sealing or materializing improvement data; never rewrite reviewed bytes. */
export function assertSafeImprovementContent(value: unknown, secrets: string[] = []): void {
	if (
		containsSecret(value, secrets) ||
		/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:Bearer|Basic)\s+[a-zA-Z0-9+/_.=-]{8,}|\bsk-[a-zA-Z0-9_-]{16,}/u.test(
			canonicalJson(value),
		)
	)
		throw new Error("Improvement records must not contain credentials or configured secrets")
}

function freezeRecord<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value)) freezeRecord(child)
		Object.freeze(value)
	}
	return value
}

export function assertBoundedJson(value: unknown, maxBytes: number): void {
	let remaining = maxBytes
	let nodes = 0
	const ancestors = new Set<object>()
	function visit(child: unknown, depth: number): void {
		if (++nodes > 250_000 || depth > 32) throw new Error("Evidence JSON structure exceeds bounds")
		if (child === null || typeof child === "boolean") remaining -= 5
		else if (typeof child === "number" && Number.isFinite(child)) remaining -= 24
		else if (typeof child === "string") {
			if (child.length > remaining) throw new Error("Evidence JSON text exceeds bounds")
			remaining -= Buffer.byteLength(JSON.stringify(child), "utf8")
		} else if (child && typeof child === "object") {
			if (ancestors.has(child)) throw new Error("Cyclic evidence JSON")
			const prototype = Object.getPrototypeOf(child)
			if (!Array.isArray(child) && prototype !== Object.prototype && prototype !== null)
				throw new Error("Evidence must contain only plain JSON objects")
			const descriptors = Object.getOwnPropertyDescriptors(child)
			const keys = Reflect.ownKeys(descriptors)
			if (keys.length > 100_001) throw new Error("Evidence JSON collection exceeds bounds")
			ancestors.add(child)
			remaining -= 2
			for (const key of keys) {
				if (Array.isArray(child) && key === "length") continue
				if (typeof key !== "string") throw new Error("Evidence JSON cannot contain symbol keys")
				const descriptor = descriptors[key]
				if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable)
					throw new Error("Evidence JSON cannot contain accessors or hidden values")
				visit(key, depth + 1)
				visit(descriptor.value, depth + 1)
			}
			ancestors.delete(child)
		} else throw new Error("Evidence must contain only finite JSON values")
		if (remaining < 0) throw new Error("Evidence JSON byte size exceeds bounds")
	}
	visit(value, 0)
}

export async function verifyWithinDeadline<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (signal?.aborted) throw new Error("Evidence verification aborted")
	const controller = new AbortController()
	let timer: ReturnType<typeof setTimeout> | undefined
	let onAbort: (() => void) | undefined
	const interrupted = new Promise<never>((_resolve, reject) => {
		const stop = () => {
			controller.abort()
			reject(new Error("Evidence verification interrupted"))
		}
		timer = setTimeout(stop, FEEDBACK_EVIDENCE_LIMITS.verificationMs)
		onAbort = stop
		signal?.addEventListener("abort", onAbort, { once: true })
	})
	try {
		return await Promise.race([operation(controller.signal), interrupted])
	} finally {
		if (timer) clearTimeout(timer)
		if (onAbort) signal?.removeEventListener("abort", onAbort)
	}
}
