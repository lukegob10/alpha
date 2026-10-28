import { z } from "zod"
import { NATIVE_EXPERIMENT_CONDITION_SCOPES } from "@alpha-code/types"

import { canonicalJson, sha256 } from "../evidence/canonical"
import { executedModelSettingsDigest, parseExecutedExperimentCapture } from "../evidence/executedExperimentCapture"
import { campaignAgentIsolationSchema, sealCampaignExport, type CampaignExport } from "./campaign"
import { immutableIdentity } from "./identity"
import {
	experimentVariantSchema,
	pairKeySchema,
	taskSetManifestSchema,
	type ExperimentVariant,
	type ObservationStatus,
	type TrialObservation,
} from "./types"

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const measurement = z.number().finite().nonnegative().nullable()
const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable()

const assignmentBodySchema = z
	.object({
		schemaVersion: z.literal(1),
		runId: z.string().min(1),
		declaredAt: z.string().datetime(),
		decisionPlanDigest: digest,
		pair: pairKeySchema,
		taskSet: taskSetManifestSchema,
		task: z
			.object({
				definitionDigest: digest,
				fixtureDigest: digest,
				stagedFixtureDigest: digest.optional(),
				family: z.string().min(1),
				risk: z.enum(["low", "medium", "high", "critical"]),
				difficulty: z.enum(["foundation", "challenging", "frontier"]),
				capabilities: z.array(z.string().min(1)).min(1),
			})
			.strict(),
	})
	.strict()

export const problemSolvingExperimentAssignmentSchema = assignmentBodySchema.extend({ digest }).strict()
export type ProblemSolvingExperimentAssignment = z.infer<typeof problemSolvingExperimentAssignmentSchema>

/** A protocol label sealed before dispatch. It is never an observed execution identity. */
export function sealProblemSolvingExperimentAssignment(
	value: z.input<typeof assignmentBodySchema>,
): ProblemSolvingExperimentAssignment {
	const body = assignmentBodySchema.parse(value)
	validateAssignmentTask(body)
	return { ...body, digest: sha256(canonicalJson(body)) }
}

export function parseProblemSolvingExperimentAssignment(value: unknown): ProblemSolvingExperimentAssignment {
	const assignment = problemSolvingExperimentAssignmentSchema.parse(value)
	const { digest: recorded, ...body } = assignment
	if (recorded !== sha256(canonicalJson(body))) throw new Error("Experiment assignment digest mismatch")
	validateAssignmentTask(body)
	return assignment
}

function validateAssignmentTask(assignment: z.infer<typeof assignmentBodySchema>): void {
	const identities = assignment.taskSet.tasks.map(({ id, version }) => `${id}@${version}`)
	if (new Set(identities).size !== identities.length)
		throw new Error("Experiment task set contains duplicate identities")
	const task = assignment.taskSet.tasks.find(
		(task) => task.id === assignment.pair.taskId && task.version === assignment.pair.taskVersion,
	)
	if (!task || task.digest !== assignment.task.definitionDigest)
		throw new Error("Experiment assignment does not match its declared task definition")
}

const attemptSchema = z
	.object({
		taskId: z.string().min(1),
		taskVersion: z.number().int().positive(),
		taskDigest: digest,
		attemptId: z.string().min(1),
		providerMode: z.enum(["live-copilot", "scripted"]),
		model: z.object({ id: z.string().nullable(), effort: z.string().nullable() }),
		status: z.enum(["passed", "failed", "blocked", "cancelled"]),
		countsAsSolving: z.boolean(),
		graderDecision: z.enum(["passed", "outcome_failed", "safety_failed", "grader_error"]).nullable(),
		failureClass: z
			.enum(["provider", "infrastructure", "cancellation", "budget", "task", "authentication", "profile_busy"])
			.nullable(),
		usage: z.object({
			cost: measurement,
			inputTokens: tokenCount,
			outputTokens: tokenCount,
			requests: tokenCount,
		}),
		startedAt: z.string().datetime().optional(),
		completedAt: z.string().datetime().optional(),
		elapsedMs: z.number().finite().nonnegative().optional(),
		promptSha256: z.string().regex(/^[a-f0-9]{64}$/),
		experimentAssignment: problemSolvingExperimentAssignmentSchema.nullable().optional(),
		experimentIdentity: z.unknown().optional(),
	})
	.passthrough()

const campaignInputSchema = z
	.object({
		schemaVersion: z.literal(1),
		runId: z.string().min(1),
		taskSet: taskSetManifestSchema,
		assignments: z.array(problemSolvingExperimentAssignmentSchema).default([]),
		attempts: z.array(attemptSchema),
		agentIsolation: campaignAgentIsolationSchema.optional(),
	})
	.passthrough()

type Attempt = z.infer<typeof attemptSchema>
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right)
const pairIdentity = (value: unknown) => canonicalJson(pairKeySchema.parse(value))

function statusOf(attempt: Attempt): ObservationStatus {
	if (attempt.graderDecision === "grader_error") return "grader_error"
	if (attempt.failureClass === "cancellation" || attempt.status === "cancelled") return "cancelled"
	if (["authentication", "profile_busy", "infrastructure", "provider"].includes(attempt.failureClass ?? ""))
		return "infrastructure_error"
	if (attempt.failureClass === "budget") return "budget_exhausted"
	if (attempt.graderDecision === "safety_failed") return "safety_failed"
	if (attempt.status === "passed" && attempt.graderDecision === "passed" && attempt.failureClass === null)
		return "passed"
	if (attempt.status === "blocked") return "human_handoff"
	return "outcome_failed"
}

/**
 * Adapt producer receipts into the shared campaign format. Declaration fields cannot fill observed identity gaps.
 * Historical and incomplete evidence stays readable, with no scoreable observations or invented variant fields.
 */
export function exportProblemSolvingCampaign(value: unknown): CampaignExport {
	const input = campaignInputSchema.parse(value)
	const incomplete: CampaignExport["incomplete"] = []
	const fail = (reason: string, taskId?: string) => incomplete.push({ ...(taskId ? { taskId } : {}), reason })
	const frame = new Set(input.taskSet.tasks.map((task) => `${task.id}@${task.version}`))
	if (frame.size !== input.taskSet.tasks.length) throw new Error("Campaign task set contains duplicate identities")
	const planned = new Map<string, ProblemSolvingExperimentAssignment>()
	for (const value of input.assignments) {
		const assignment = parseProblemSolvingExperimentAssignment(value)
		if (assignment.runId !== input.runId || !same(assignment.taskSet, input.taskSet))
			throw new Error("Campaign assignment run or task set mismatch")
		const key = pairIdentity(assignment.pair)
		if (planned.has(key)) throw new Error("Campaign contains duplicate planned pairs")
		planned.set(key, assignment)
	}
	if (!planned.size) fail("predeclared_experiment_assignments_unavailable")
	for (const task of input.taskSet.tasks)
		if (
			!input.assignments.some(
				(assignment) => assignment.pair.taskId === task.id && assignment.pair.taskVersion === task.version,
			)
		)
			fail("task_set_task_has_no_planned_assignment", task.id)
	const attemptIds = new Set<string>(),
		observedPairs = new Set<string>()
	const observations: TrialObservation[] = []
	let variant: ExperimentVariant | null = null
	let identityScope: CampaignExport["identityScope"]
	let nativeConditionScopes = 0
	const providerModes = new Set(input.attempts.map(({ providerMode }) => providerMode))
	if (providerModes.size > 1) fail("mixed_scripted_and_live_attempts")
	for (const attempt of input.attempts) {
		if (!frame.has(`${attempt.taskId}@${attempt.taskVersion}`))
			throw new Error("Attempt is outside the declared task set")
		if (attemptIds.has(attempt.attemptId)) throw new Error("Campaign contains duplicate attempt identities")
		attemptIds.add(attempt.attemptId)
		if (
			attempt.countsAsSolving &&
			(attempt.providerMode !== "live-copilot" ||
				attempt.status !== "passed" ||
				attempt.graderDecision !== "passed" ||
				attempt.failureClass)
		)
			throw new Error("Attempt solving claim contradicts retained host or grader results")
		const assignment = attempt.experimentAssignment
		if (!assignment) {
			fail("attempt_experiment_assignment_unavailable", attempt.taskId)
			continue
		}
		parseProblemSolvingExperimentAssignment(assignment)
		const key = pairIdentity(assignment.pair)
		const expected = planned.get(key)
		if (!expected || !same(assignment, expected)) throw new Error("Attempt differs from the predeclared assignment")
		if (observedPairs.has(key)) throw new Error("Campaign contains duplicate observed pairs")
		observedPairs.add(key)
		if (
			attempt.taskId !== assignment.pair.taskId ||
			attempt.taskVersion !== assignment.pair.taskVersion ||
			attempt.taskDigest !== assignment.task.fixtureDigest
		)
			throw new Error("Attempt source task differs from its declared fixture identity")
		if (!attempt.startedAt || !attempt.completedAt || attempt.elapsedMs === undefined) {
			fail("attempt_execution_timing_unavailable", attempt.taskId)
			continue
		}
		if (
			Date.parse(attempt.startedAt) < Date.parse(assignment.declaredAt) ||
			Date.parse(attempt.completedAt) < Date.parse(attempt.startedAt)
		)
			throw new Error("Attempt execution timing contradicts the predeclared assignment")
		const wallSpan = Date.parse(attempt.completedAt) - Date.parse(attempt.startedAt)
		// The host span is measured with a monotonic clock; permit millisecond timestamp precision and 0.1% clock drift.
		if (Math.abs(attempt.elapsedMs - wallSpan) > Math.max(10, wallSpan * 0.001))
			throw new Error("Attempt elapsed duration contradicts retained execution timestamps")
		if (!attempt.experimentIdentity) {
			fail("executed_variant_identity_unavailable", attempt.taskId)
			continue
		}
		const capture = parseExecutedExperimentCapture(attempt.experimentIdentity)
		if (capture.conditionScopes) {
			if (!same(capture.conditionScopes, NATIVE_EXPERIMENT_CONDITION_SCOPES))
				throw new Error("Native fixed-condition identity scope is unsupported")
			nativeConditionScopes++
		}
		if (capture.attemptId !== attempt.attemptId || capture.assignmentDigest !== assignment.digest)
			throw new Error("Native identity capture belongs to another attempt or assignment")
		if (capture.pairDigest !== undefined && capture.pairDigest !== sha256(pairIdentity(assignment.pair)))
			throw new Error("Native identity capture belongs to another declared pair")
		if (
			capture.task.id !== attempt.taskId ||
			capture.task.version !== attempt.taskVersion ||
			capture.task.digest !== attempt.taskDigest
		)
			throw new Error("Native identity capture belongs to another source task")
		if (
			Date.parse(capture.capturedAt) < Date.parse(attempt.startedAt) ||
			Date.parse(capture.capturedAt) > Date.parse(attempt.completedAt)
		)
			throw new Error("Native identity capture timestamp is outside the actual attempt")
		if (
			capture.observed.taskPromptDigest !== undefined &&
			capture.observed.taskPromptDigest !== "sha256:" + attempt.promptSha256
		)
			throw new Error("Native task prompt measurement differs from the dispatched task prompt")
		if (capture.status !== "captured" || !capture.observedVariant) {
			fail("executed_variant_identity_incomplete:" + capture.missing.join(","), attempt.taskId)
			continue
		}
		if (!capture.pairDigest) {
			fail("native_pair_binding_unavailable", attempt.taskId)
			continue
		}
		if (
			assignment.task.stagedFixtureDigest &&
			(capture.observed.stagedFixtureDigest !== assignment.task.stagedFixtureDigest ||
				capture.observed.stagedFixtureAlgorithm !== "source-tree-pretty-json-v1")
		)
			throw new Error("Native staged workspace differs from the prelaunch measured source snapshot")
		if (!capture.observed.taskPromptDigest)
			throw new Error("Native identity capture is missing the dispatched task prompt measurement")
		const observed = experimentVariantSchema.parse(capture.observedVariant)
		if (
			observed.model !== attempt.model.id ||
			capture.observed.model !== attempt.model.id ||
			!attempt.model.effort ||
			capture.observed.reasoningEffort !== attempt.model.effort ||
			capture.observed.modelSettingsDigest !== observed.modelSettingsDigest ||
			!capture.requests.length ||
			capture.requests.some(
				(request) =>
					request.model !== observed.model ||
					request.reasoningEffort !== attempt.model.effort ||
					request.modelSettingsDigest !== observed.modelSettingsDigest ||
					request.modelSettingsDigest !==
						executedModelSettingsDigest(request.model, attempt.model.effort!, request.optionsDigest),
			)
		)
			throw new Error("Observed native model identity differs from the attempt receipt")
		if (
			capture.requests.some(
				(request) =>
					Date.parse(request.startedAt) < Date.parse(attempt.startedAt!) ||
					Date.parse(request.startedAt) > Date.parse(capture.capturedAt),
			)
		)
			throw new Error("Observed native request timing is outside the captured attempt")
		for (const field of [
			"resourceProfileDigest",
			"permissionDigest",
			"networkMode",
			"retryPolicyDigest",
		] as const) {
			if (observed[field] !== assignment.pair[field])
				throw new Error(`Observed native ${field} differs from pair conditions`)
		}
		if (variant && !same(observed, variant)) throw new Error("Campaign contains multiple executed variants")
		if (identityScope && capture.identityScope !== identityScope)
			throw new Error("Campaign identity precision changed")
		variant = observed
		identityScope = capture.identityScope
		const inputTokens = attempt.usage.inputTokens,
			outputTokens = attempt.usage.outputTokens
		const tokens =
			inputTokens !== null && outputTokens !== null && Number.isSafeInteger(inputTokens + outputTokens)
				? inputTokens + outputTokens
				: null
		const status = statusOf(attempt)
		observations.push({
			...assignment.pair,
			variantIdentity: immutableIdentity(observed),
			runId: input.runId,
			status,
			firstAttemptStatus: status,
			retryAssisted: false,
			cost: attempt.usage.cost,
			tokens,
			latencyMs: attempt.elapsedMs,
			performance: { inputTokens, outputTokens },
			decisionPlanDigest: assignment.decisionPlanDigest,
			startedAt: attempt.startedAt,
			capturedTimeWindow: assignment.pair.timeWindow,
			family: assignment.task.family,
			risk: assignment.task.risk,
			difficulty: assignment.task.difficulty,
			capabilities: assignment.task.capabilities,
		})
	}
	for (const [key, assignment] of planned)
		if (!observedPairs.has(key)) fail("planned_attempt_unavailable", assignment.pair.taskId)
	if (!input.attempts.length) fail("campaign_has_no_attempts")
	const completed = input.attempts.length
	const knownCost = input.attempts.every(({ usage }) => usage.cost !== null)
	const totalCost = knownCost ? input.attempts.reduce((sum, { usage }) => sum + usage.cost!, 0) : null
	if (totalCost !== null && !Number.isFinite(totalCost)) throw new Error("Campaign cost accounting overflow")
	return sealCampaignExport({
		schemaVersion: 1,
		runId: input.runId,
		executionFidelity: "actual-host",
		decisionSource: providerModes.size === 1 && providerModes.has("live-copilot") ? "live" : "scripted",
		...(identityScope ? { identityScope } : {}),
		...(input.agentIsolation ? { agentIsolation: input.agentIsolation } : {}),
		...(nativeConditionScopes > 0 && nativeConditionScopes === input.attempts.length
			? { conditionIdentityScope: "native-host-protocol-v1" as const }
			: {}),
		variant: incomplete.length ? null : variant,
		taskSet: input.taskSet,
		observations: incomplete.length ? [] : observations,
		incomplete,
		accounting: {
			totalAttempts: completed,
			scoredSamples: incomplete.length ? 0 : observations.length,
			diagnosticAttempts: incomplete.length ? completed : 0,
			totalCost,
			sampling: {
				planned: planned.size,
				completed,
				passed: input.attempts.filter(({ status }) => status === "passed").length,
				failed: input.attempts.filter(({ status }) => status === "failed").length,
				blocked: input.attempts.filter(({ status }) => status === "blocked" || status === "cancelled").length,
				notRun: Math.max(0, planned.size - observedPairs.size),
				diagnosticAttempts: incomplete.length ? completed : 0,
			},
		},
	})
}
