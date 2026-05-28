import { z } from "zod"

export const goalSeekScoreDirectionSchema = z.enum(["maximize", "minimize"])
export type GoalSeekScoreDirection = z.infer<typeof goalSeekScoreDirectionSchema>

export const goalSeekVerifierSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("prompt"), prompt: z.string() }),
	z.object({ type: z.literal("command"), command: z.string(), timeoutMs: z.number().int().positive().optional() }),
	z.object({
		type: z.literal("promptAndCommand"),
		prompt: z.string(),
		command: z.string(),
		timeoutMs: z.number().int().positive().optional(),
	}),
])
export type GoalSeekVerifier = z.infer<typeof goalSeekVerifierSchema>

export const goalSeekRankingWeightsSchema = z.object({
	expectedReward: z.number().default(1),
	directoryRisk: z.number().default(0.8),
	complexity: z.number().default(0.7),
	regressionRisk: z.number().default(0.8),
	reversibility: z.number().default(0.5),
})
export type GoalSeekRankingWeights = z.infer<typeof goalSeekRankingWeightsSchema>

export const goalSeekCandidateSchema = z.object({
	id: z.string(),
	title: z.string(),
	rationale: z.string(),
	expectedRewardImpact: z.number(),
	affectedPaths: z.array(z.string()).default([]),
	directoryRisk: z.number(),
	complexity: z.number(),
	regressionRisk: z.number(),
	reversibility: z.number(),
	utilityScore: z.number(),
})
export type GoalSeekCandidate = z.infer<typeof goalSeekCandidateSchema>

export const goalSeekVerifierResultSchema = z.object({
	score: z.number(),
	direction: goalSeekScoreDirectionSchema,
	improved: z.boolean(),
	passedTarget: z.boolean(),
	reason: z.string(),
	nextInstructions: z.string().optional(),
	rawOutput: z.string().optional(),
})
export type GoalSeekVerifierResult = z.infer<typeof goalSeekVerifierResultSchema>

export const goalSeekAttemptStatusSchema = z.enum([
	"planning",
	"implementing",
	"verifying",
	"accepted",
	"reverted",
	"failed",
	"canceled",
])
export type GoalSeekAttemptStatus = z.infer<typeof goalSeekAttemptStatusSchema>

export const goalSeekAttemptSchema = z.object({
	id: z.string(),
	runId: z.string(),
	iteration: z.number().int().positive(),
	status: goalSeekAttemptStatusSchema,
	candidates: z.array(goalSeekCandidateSchema).default([]),
	selectedCandidateId: z.string().optional(),
	checkpointRef: z.string().optional(),
	implementationTaskId: z.string().optional(),
	verifierTaskId: z.string().optional(),
	verifierResult: goalSeekVerifierResultSchema.optional(),
	startedAt: z.number(),
	finishedAt: z.number().optional(),
	summary: z.string().optional(),
	error: z.string().optional(),
})
export type GoalSeekAttempt = z.infer<typeof goalSeekAttemptSchema>

export const goalSeekRunStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "canceled"])
export type GoalSeekRunStatus = z.infer<typeof goalSeekRunStatusSchema>

export const goalSeekExitReasonSchema = z.enum([
	"target_reached",
	"max_attempts_reached",
	"failed_attempt_limit_reached",
	"canceled",
	"error",
])
export type GoalSeekExitReason = z.infer<typeof goalSeekExitReasonSchema>

export const goalSeekRunSchema = z.object({
	id: z.string(),
	jobId: z.string(),
	status: goalSeekRunStatusSchema,
	startedAt: z.number(),
	finishedAt: z.number().optional(),
	currentIteration: z.number().int().nonnegative().default(0),
	failedAttempts: z.number().int().nonnegative().default(0),
	bestScore: z.number().optional(),
	bestAttemptId: z.string().optional(),
	exitReason: goalSeekExitReasonSchema.optional(),
	error: z.string().optional(),
})
export type GoalSeekRun = z.infer<typeof goalSeekRunSchema>

export const goalSeekJobSchema = z.object({
	id: z.string(),
	name: z.string(),
	goal: z.string(),
	verifier: goalSeekVerifierSchema,
	direction: goalSeekScoreDirectionSchema,
	targetScore: z.number(),
	maxAttempts: z.number().int().positive().default(10),
	maxFailedAttempts: z.number().int().nonnegative().default(3),
	candidateCount: z.number().int().positive().default(10),
	mode: z.string().optional(),
	workspace: z.string().optional(),
	rankingWeights: goalSeekRankingWeightsSchema.default({}),
	createdAt: z.number(),
	updatedAt: z.number(),
	lastRunId: z.string().optional(),
	lastRunStatus: goalSeekRunStatusSchema.optional(),
	lastRunSummary: z.string().optional(),
})
export type GoalSeekJob = z.infer<typeof goalSeekJobSchema>

export const goalSeekStateSchema = z.object({
	jobs: z.array(goalSeekJobSchema),
	runs: z.array(goalSeekRunSchema),
	attempts: z.array(goalSeekAttemptSchema),
})
export type GoalSeekState = z.infer<typeof goalSeekStateSchema>

export type CreateGoalSeekJobPayload = {
	name: string
	goal: string
	verifier: GoalSeekVerifier
	direction: GoalSeekScoreDirection
	targetScore: number
	maxAttempts?: number
	maxFailedAttempts?: number
	candidateCount?: number
	mode?: string
	workspace?: string
	rankingWeights?: GoalSeekRankingWeights
}

export type UpdateGoalSeekJobPayload = Partial<CreateGoalSeekJobPayload>
