import { z } from "zod"

export const IMPROVEMENT_SCHEMA_VERSION = 1 as const

export const improvementDigestSchema = z
	.string()
	.refine((value) => value.length === 71 && /^sha256:[a-f0-9]{64}$/.test(value), "Invalid SHA-256 identity")
export const improvementIdSchema = z
	.string()
	.max(128)
	.refine((value) => value.length <= 128 && /^[a-zA-Z0-9][a-zA-Z0-9._:@-]*$/.test(value), "Invalid record ID")

// These are bounded plain-text observations, never commands, prompts, or executable authority.
const observationText = z
	.string()
	.min(1)
	.max(2_000)
	.refine((value) => value.length <= 2_000 && value.trim().length > 0, "Text must contain a bounded observation")
	.refine((value) => value.length <= 2_000 && !hasUnsafeControls(value), {
		message: "Text contains unsafe control characters",
	})

const identityText = z
	.string()
	.min(1)
	.max(200)
	.refine(
		(value) => value.length <= 200 && value.trim() === value && !/\s/u.test(value) && !hasUnsafeControls(value),
		{
			message: "Reviewer and model identities must be bounded identifiers",
		},
	)

const createdAt = z.string().max(35).datetime({ offset: true })
const humanSourceSchema = z.object({ type: z.literal("human"), reviewerId: identityText }).strict()

export const feedbackSourceSchema = z.discriminatedUnion("type", [
	humanSourceSchema,
	z
		.object({
			type: z.literal("model"),
			reviewerId: identityText,
			modelIdentity: identityText,
			rubricIdentity: improvementDigestSchema,
		})
		.strict(),
])

export const evidenceReferenceSchema = z
	.object({
		runId: improvementIdSchema,
		trialId: improvementIdSchema,
		attemptId: improvementIdSchema,
		bundleDigest: improvementDigestSchema,
		eventSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
		artifactDigest: improvementDigestSchema.optional(),
	})
	.strict()

export const feedbackInputSchema = z
	.object({
		schemaVersion: z.literal(IMPROVEMENT_SCHEMA_VERSION),
		recordType: z.literal("feedback"),
		id: improvementIdSchema,
		createdAt,
		source: feedbackSourceSchema,
		finding: observationText,
		expectedBehavior: observationText,
		severity: z.enum(["low", "medium", "high", "critical"]),
		classification: z.enum([
			"missing-requirement",
			"execution-failure",
			"implementation-defect",
			"observability-defect",
		]),
		evidence: evidenceReferenceSchema,
	})
	.strict()

export const feedbackSchema = feedbackInputSchema.extend({ digest: improvementDigestSchema }).strict()

export const feedbackReviewInputSchema = z
	.object({
		schemaVersion: z.literal(IMPROVEMENT_SCHEMA_VERSION),
		recordType: z.literal("feedback-review"),
		id: improvementIdSchema,
		createdAt,
		source: humanSourceSchema,
		feedbackDigest: improvementDigestSchema,
		decision: z.enum(["accepted", "rejected", "needs-info"]),
		rationale: observationText,
	})
	.strict()

export const feedbackReviewSchema = feedbackReviewInputSchema.extend({ digest: improvementDigestSchema }).strict()

export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>
export type FeedbackSource = z.infer<typeof feedbackSourceSchema>
export type FeedbackInput = z.infer<typeof feedbackInputSchema>
export type Feedback = z.infer<typeof feedbackSchema>
export type FeedbackReviewInput = z.infer<typeof feedbackReviewInputSchema>
export type FeedbackReview = z.infer<typeof feedbackReviewSchema>

function hasUnsafeControls(value: string): boolean {
	return Array.from(value).some((character) => {
		const code = character.codePointAt(0) ?? 0
		return (
			(code < 32 && ![9, 10, 13].includes(code)) ||
			code === 127 ||
			(code >= 0x202a && code <= 0x202e) ||
			(code >= 0x2066 && code <= 0x2069)
		)
	})
}
