import { describe, expect, it, vi } from "vitest"

import type { ContentAddressedArtifactStore } from "../../evidence/artifactStore"
import { canonicalJson, sha256 } from "../../evidence/canonical"
import { collectRequiredEvidence, type RequiredEvidence } from "../../evidence/collector"
import { EventJournal } from "../../evidence/eventJournal"
import { evidenceBundleDigest } from "../../evidence/integrity"
import { REQUIRED_ARTIFACT_KINDS, type EvidenceBundle } from "../../evidence/types"
import type { FeedbackInput, FeedbackReviewInput } from "../contracts"
import {
	assertFeedbackAppend,
	assertFeedbackReviewAppend,
	FEEDBACK_EVIDENCE_LIMITS,
	parseFeedback,
	parseFeedbackReview,
	sealFeedback,
	sealFeedbackReview,
	validateEvidenceReference,
	validateFeedback,
	validateFeedbackReview,
} from "../feedback"

async function fixture() {
	const bytes = new Map<string, Uint8Array>()
	const store: ContentAddressedArtifactStore = {
		put: async (input) => {
			const digest = sha256(input.bytes)
			bytes.set(digest, input.bytes)
			return {
				schemaVersion: 1,
				id: digest,
				attemptId: input.attemptId,
				kind: input.kind,
				digest,
				mediaType: input.mediaType,
				sizeBytes: input.bytes.byteLength,
				access: "reviewer",
				retention: "campaign",
				uploadState: "complete",
				captureStatus: input.bytes.byteLength ? "captured" : "captured-empty",
				createdAt: "2026-10-23T12:00:00.000Z",
			}
		},
		get: vi.fn(async (descriptor) => bytes.get(descriptor.digest)),
	}
	const evidence = Object.fromEntries(
		REQUIRED_ARTIFACT_KINDS.map((kind) => [kind, `${kind} evidence`]),
	) as RequiredEvidence
	const journal = new EventJournal({ runId: "run-1", trialId: "trial-1", attemptId: "attempt-1" })
	journal.append("attempt.completed", { status: "failed" })
	const bundle: EvidenceBundle = {
		schemaVersion: 1,
		runId: "run-1",
		trialId: "trial-1",
		attemptId: "attempt-1",
		taskIdentity: sha256("task"),
		variantIdentity: sha256("variant"),
		identityStatus: "attempt-bound",
		events: journal.all(),
		artifacts: await collectRequiredEvidence("attempt-1", evidence, store),
	}
	bundle.bundleDigest = evidenceBundleDigest(bundle)
	const firstEvent = bundle.events[0]
	const firstArtifact = bundle.artifacts[0]
	if (!firstEvent || !firstArtifact) throw new Error("Feedback fixture requires a retained event and artifact")
	const input: FeedbackInput = {
		schemaVersion: 1,
		recordType: "feedback",
		id: "feedback-1",
		createdAt: "2026-10-23T13:00:00.000Z",
		source: { type: "human", reviewerId: "reviewer-1" },
		finding: "The final response claims validation succeeded after the test command failed.",
		expectedBehavior: "Report the failed validation and preserve its nonzero exit status.",
		severity: "high",
		classification: "execution-failure",
		evidence: {
			runId: bundle.runId,
			trialId: bundle.trialId,
			attemptId: bundle.attemptId,
			bundleDigest: bundle.bundleDigest,
			eventSequence: 1,
			artifactDigest: firstArtifact.digest,
		},
	}
	const review: FeedbackReviewInput = {
		schemaVersion: 1,
		recordType: "feedback-review",
		id: "review-1",
		createdAt: "2026-10-23T14:00:00.000Z",
		source: { type: "human", reviewerId: "reviewer-2" },
		feedbackDigest: sha256("placeholder"),
		decision: "accepted",
		rationale: "The retained command result contradicts the final validation claim.",
	}
	return { bytes, store, bundle, firstEvent, firstArtifact, context: { bundle, store }, input, review }
}

describe("sealed improvement feedback", () => {
	it("binds human observations to a real sealed attempt and freezes nested content", async () => {
		const { input, context } = await fixture()
		const record = await sealFeedback(input, context)
		expect(record.digest).toBe(sha256(canonicalJson(input)))
		expect(await validateFeedback(JSON.parse(JSON.stringify(record)), context)).toEqual(record)
		expect(Object.isFrozen(record)).toBe(true)
		expect(Object.isFrozen(record.evidence)).toBe(true)
		expect(Object.isFrozen(record.source)).toBe(true)
		expect(input).not.toHaveProperty("digest")
	})

	it("retains model and rubric identity without granting human review authority", async () => {
		const { input, context, review } = await fixture()
		const source = {
			type: "model" as const,
			reviewerId: "model-review",
			modelIdentity: "test-model",
			rubricIdentity: sha256("rubric"),
		}
		const record = await sealFeedback({ ...input, source }, context)
		expect(record.source).toEqual(source)
		expect(() => sealFeedbackReview({ ...review, feedbackDigest: record.digest, source }, record)).toThrow(
			"human feedback review",
		)
		const humanReview = sealFeedbackReview({ ...review, feedbackDigest: record.digest }, record)
		expect(validateFeedbackReview(humanReview, record).decision).toBe("accepted")
	})

	it.each(["runId", "trialId", "attemptId", "bundleDigest"] as const)(
		"rejects a different evidence %s",
		async (key) => {
			const { input, context } = await fixture()
			const different = key === "bundleDigest" ? sha256("other") : "other"
			await expect(
				sealFeedback({ ...input, evidence: { ...input.evidence, [key]: different } }, context),
			).rejects.toThrow("identity mismatch")
		},
	)

	it.each([{ eventSequence: 2 }, { artifactDigest: sha256("invented") }])(
		"rejects invented anchor %j",
		async (anchor) => {
			const { input, context } = await fixture()
			await expect(
				sealFeedback({ ...input, evidence: { ...input.evidence, ...anchor } }, context),
			).rejects.toThrow("anchor is missing")
		},
	)

	it("rejects changed event content even when its payload hash is recomputed", async () => {
		const { firstEvent, input, context } = await fixture()
		firstEvent.payload = { status: "passed" }
		firstEvent.payloadDigest = sha256(canonicalJson(firstEvent.payload))
		await expect(sealFeedback(input, context)).rejects.toThrow("integrity verification")
	})

	it.each(["missing", "corrupt"])("rejects %s retained artifact bytes", async (mode) => {
		const { firstArtifact, input, context, bytes } = await fixture()
		const digest = firstArtifact.digest
		if (mode === "missing") bytes.delete(digest)
		else bytes.set(digest, new TextEncoder().encode("changed"))
		await expect(sealFeedback(input, context)).rejects.toThrow("integrity verification")
	})

	it.each(["legacy", "unsealed"])("rejects %s evidence attribution", async (mode) => {
		const { bundle, input, context } = await fixture()
		if (mode === "legacy") bundle.identityStatus = "legacy-unavailable"
		else delete bundle.bundleDigest
		await expect(sealFeedback(input, context)).rejects.toThrow("sealed attempt")
	})

	it("detects changed feedback bytes and does not permit record ID rewriting", async () => {
		const { input, context } = await fixture()
		const original = await sealFeedback(input, context)
		expect(() => parseFeedback({ ...original, expectedBehavior: "Pretend success." })).toThrow("digest mismatch")
		const changed = await sealFeedback({ ...input, finding: "A different observation." }, context)
		expect(() => assertFeedbackAppend([original], changed)).toThrow("cannot be rewritten")
		expect(() => assertFeedbackAppend([original], original)).not.toThrow()
		expect(original.finding).toBe(input.finding)
	})

	it.each([
		{ finding: "x".repeat(2_001) },
		{ finding: "   " },
		{ finding: "unsafe\u0000text" },
		{ finding: "unsafe\u202etext" },
		{ id: "../escape" },
		{ source: { type: "human", reviewerId: "user", modelIdentity: "hidden-model" } },
		{ source: { type: "model", reviewerId: "model", modelIdentity: "model" } },
		{ arbitraryInstructions: "Execute an unrelated command." },
	])("rejects unsafe or unsupported input %j", async (change) => {
		const { input, context } = await fixture()
		await expect(sealFeedback({ ...input, ...change }, context)).rejects.toThrow("input schema")
	})

	it.each(["line1\nline2", "a\\b", "sk-thisIsASecretKeyValue1234567890"])(
		"rejects configured secret variants",
		async (secret) => {
			const { input, context } = await fixture()
			await expect(
				sealFeedback({ ...input, finding: `Observed ${secret}` }, { ...context, secrets: [secret] }),
			).rejects.toThrow("credentials")
		},
	)

	it("rejects credential text without configured secrets", async () => {
		const { input, context } = await fixture()
		await expect(
			sealFeedback({ ...input, finding: "Authorization: Bearer abcdef0123456789" }, context),
		).rejects.toThrow("credentials")
	})

	it("binds separate immutable human adjudications to exact feedback bytes", async () => {
		const { input, context, review } = await fixture()
		const feedback = await sealFeedback(input, context)
		const accepted = sealFeedbackReview({ ...review, feedbackDigest: feedback.digest }, feedback)
		expect(parseFeedbackReview(JSON.parse(JSON.stringify(accepted)))).toEqual(accepted)
		expect(() => validateFeedbackReview({ ...accepted, decision: "rejected" }, feedback)).toThrow("digest mismatch")
		const rejected = sealFeedbackReview(
			{ ...review, feedbackDigest: feedback.digest, decision: "rejected" },
			feedback,
		)
		expect(() => assertFeedbackReviewAppend([accepted], rejected)).toThrow("cannot be rewritten")
		expect(() => assertFeedbackReviewAppend([accepted], accepted)).not.toThrow()
		expect(() => sealFeedbackReview(review, feedback)).toThrow("different feedback")
		expect(() =>
			sealFeedbackReview(
				{ ...review, feedbackDigest: feedback.digest, createdAt: "2026-10-23T12:00:00.000Z" },
				feedback,
			),
		).toThrow("predates")
	})

	it.each([-1, 1.5, Number.POSITIVE_INFINITY, FEEDBACK_EVIDENCE_LIMITS.artifactBytes + 1])(
		"rejects invalid artifact size %s before CAS reads",
		async (sizeBytes) => {
			const { input, context, firstArtifact, store } = await fixture()
			firstArtifact.sizeBytes = sizeBytes
			await expect(sealFeedback(input, context)).rejects.toThrow(/bounds|bounded JSON/)
			expect(store.get).not.toHaveBeenCalled()
		},
	)

	it("rejects excessive total artifact claims before CAS reads", async () => {
		const { input, context, bundle, store } = await fixture()
		for (const artifact of bundle.artifacts) artifact.sizeBytes = FEEDBACK_EVIDENCE_LIMITS.artifactBytes
		await expect(sealFeedback(input, context)).rejects.toThrow("total evidence byte bound")
		expect(store.get).not.toHaveBeenCalled()
	})

	it("rejects cyclic and oversized event payload metadata without leaking content", async () => {
		const { input, context, firstEvent, store } = await fixture()
		const payload: { secret: string; cycle?: unknown } = { secret: "private-canary" }
		payload.cycle = payload
		firstEvent.payload = payload
		await expect(sealFeedback(input, context)).rejects.toThrow("bounded JSON evidence metadata")
		firstEvent.payload = "x".repeat(FEEDBACK_EVIDENCE_LIMITS.eventPayloadBytes + 1)
		await expect(sealFeedback(input, context)).rejects.toThrow("event payload")
		expect(store.get).not.toHaveBeenCalled()
	})

	it("rejects non-JSON and accessor payloads before evaluating untrusted getters", async () => {
		const { input, context, firstEvent, store } = await fixture()
		firstEvent.payload = new Date("2026-10-23T12:00:00Z")
		await expect(sealFeedback(input, context)).rejects.toThrow("bounded JSON evidence metadata")
		const getter = vi.fn(() => "private-canary")
		firstEvent.payload = Object.defineProperty({}, "secret", { enumerable: true, get: getter })
		await expect(sealFeedback(input, context)).rejects.toThrow("bounded JSON evidence metadata")
		expect(getter).not.toHaveBeenCalled()
		expect(store.get).not.toHaveBeenCalled()
	})

	it("aborts a hanging CAS verification", async () => {
		const { input, context } = await fixture()
		const controller = new AbortController()
		const get = vi.fn(() => new Promise<undefined>(() => {}))
		const validation = validateEvidenceReference(input.evidence, {
			...context,
			store: { ...context.store, get },
			signal: controller.signal,
		})
		controller.abort()
		await expect(validation).rejects.toThrow("integrity verification")
		expect(get).toHaveBeenCalledTimes(1)
	})

	it("does not issue further CAS reads after the verification deadline", async () => {
		vi.useFakeTimers()
		try {
			const { input, context, bytes, firstArtifact } = await fixture()
			let finishFirstRead: ((value: Uint8Array | undefined) => void) | undefined
			const get = vi.fn(() => new Promise<Uint8Array | undefined>((resolve) => (finishFirstRead = resolve)))
			const validation = validateEvidenceReference(input.evidence, {
				...context,
				store: { ...context.store, get },
			})
			const rejection = expect(validation).rejects.toThrow("integrity verification")
			await vi.advanceTimersByTimeAsync(FEEDBACK_EVIDENCE_LIMITS.verificationMs)
			await rejection
			finishFirstRead?.(bytes.get(firstArtifact.digest))
			await vi.advanceTimersByTimeAsync(0)
			expect(get).toHaveBeenCalledTimes(1)
		} finally {
			vi.useRealTimers()
		}
	})
})
