import { z } from "zod"

import { REQUIRED_ARTIFACT_KINDS } from "../evidence/index"

export const certificationKindSchema = z.enum([
	"known_pass",
	"functional_failure",
	"forbidden_path",
	"hidden_grader_access",
	"agent_timeout",
	"grader_timeout",
	"setup_failure",
	"artifact_corruption",
	"missing_event",
	"duplicate_event",
	"infrastructure_retry",
	"agent_retry",
	"cancellation",
	"network_violation",
	"secret_redaction",
	"nondeterministic_grader",
])

const terminal = z.enum([
	"passed",
	"outcome_failed",
	"safety_failed",
	"budget_exhausted",
	"agent_error",
	"infrastructure_error",
	"grader_error",
	"cancelled",
	"human_handoff",
])

export const certificationResultSchema = z.object({
	terminalStatus: terminal,
	attemptStatuses: z.array(terminal).min(1),
	graders: z.array(
		z.object({ id: z.string(), status: z.enum(["passed", "failed", "error"]), hardGate: z.boolean() }),
	),
	requiredArtifacts: z.array(z.enum(REQUIRED_ARTIFACT_KINDS)),
	eventIntegrityValid: z.boolean(),
	artifactsComplete: z.boolean(),
	retryCount: z.number().int().nonnegative(),
	metrics: z.object({
		outcome: z.boolean(),
		reliability: z.boolean(),
		infrastructure: z.boolean(),
		safety: z.boolean(),
	}),
})

export const certificationScenarioSchema = z.object({
	id: z.string().min(1),
	version: z.literal(1),
	kind: certificationKindSchema,
	seed: z.number().int(),
	expected: certificationResultSchema,
})

export const certificationSuiteSchema = z.object({
	schemaVersion: z.literal(1),
	id: z.string().min(1),
	concurrency: z.number().int().positive(),
	scenarios: z.array(certificationScenarioSchema).min(12).max(16),
})

export type CertificationKind = z.infer<typeof certificationKindSchema>
export type CertificationResult = z.infer<typeof certificationResultSchema>
export type CertificationScenario = z.infer<typeof certificationScenarioSchema>
export type CertificationSuite = z.infer<typeof certificationSuiteSchema>
