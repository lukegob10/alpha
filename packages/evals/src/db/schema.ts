import { pgTable, text, timestamp, integer, real, boolean, jsonb, uniqueIndex } from "drizzle-orm/pg-core"
import { relations } from "drizzle-orm"

import type { RooCodeSettings, ToolName, ToolUsage } from "@alpha-code/types"

import type { ExerciseLanguage } from "../exercises/index"
import type {
	ArtifactAccess,
	ArtifactKind,
	ArtifactUploadState,
	EvalEvent,
	TaskManifest,
	VariantManifest,
} from "../evidence/index"
import type { ExperimentManifest, ExperimentVariant, PairKey, TaskSetManifest } from "../experiments/index"
import type { GraderDiagnostic, GraderEvidence, GraderFailureClass, GraderStatus, GraderType } from "../grading/index"
import type { AttemptPhase, TrialTerminalStatus } from "../lifecycle/index"

/**
 * ExecutionMethod
 */

export type ExecutionMethod = "vscode" | "cli"

/**
 * runs
 */

export const runs = pgTable("runs", {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	taskMetricsId: integer("task_metrics_id").references(() => taskMetrics.id),
	model: text().notNull(),
	name: text(),
	description: text(),
	contextWindow: integer(),
	inputPrice: real(),
	outputPrice: real(),
	cacheWritesPrice: real(),
	cacheReadsPrice: real(),
	settings: jsonb().$type<RooCodeSettings>(),
	jobToken: text(),
	pid: integer(),
	socketPath: text("socket_path").notNull(),
	executionMethod: text("execution_method").default("vscode").notNull().$type<ExecutionMethod>(),
	concurrency: integer().default(2).notNull(),
	timeout: integer().default(5).notNull(),
	passed: integer().default(0).notNull(),
	failed: integer().default(0).notNull(),
	campaignTier: text("campaign_tier"),
	campaignHardCapUsd: real("campaign_hard_cap_usd"),
	taskCostCapUsd: real("task_cost_cap_usd"),
	estimatedCostUsd: real("estimated_cost_usd"),
	highCostApproved: boolean("high_cost_approved").default(false).notNull(),
	modelFallbackAllowed: boolean("model_fallback_allowed").default(false).notNull(),
	createdAt: timestamp("created_at").notNull(),
})

export const runsRelations = relations(runs, ({ one }) => ({
	taskMetrics: one(taskMetrics, { fields: [runs.taskMetricsId], references: [taskMetrics.id] }),
}))

export type Run = typeof runs.$inferSelect

export type InsertRun = Omit<typeof runs.$inferInsert, "id" | "createdAt">

export type UpdateRun = Partial<Omit<Run, "id" | "createdAt">>

/**
 * tasks
 */

export const tasks = pgTable(
	"tasks",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		runId: integer("run_id")
			.references(() => runs.id, { onDelete: "cascade" })
			.notNull(),
		taskMetricsId: integer("task_metrics_id").references(() => taskMetrics.id, { onDelete: "set null" }),
		language: text().notNull().$type<ExerciseLanguage>(),
		exercise: text().notNull(),
		benchmarkTaskIdentity: text("benchmark_task_identity"),
		benchmarkPartition: text("benchmark_partition"),
		iteration: integer().default(1).notNull(),
		passed: boolean(),
		startedAt: timestamp("started_at"),
		finishedAt: timestamp("finished_at"),
		createdAt: timestamp("created_at").notNull(),
	},
	(table) => [
		uniqueIndex("tasks_language_exercise_iteration_idx").on(
			table.runId,
			table.language,
			table.exercise,
			table.iteration,
		),
	],
)

export const tasksRelations = relations(tasks, ({ one }) => ({
	run: one(runs, { fields: [tasks.runId], references: [runs.id] }),
	taskMetrics: one(taskMetrics, { fields: [tasks.taskMetricsId], references: [taskMetrics.id] }),
	trial: one(trials),
}))

export type Task = typeof tasks.$inferSelect

export type InsertTask = Omit<typeof tasks.$inferInsert, "id" | "createdAt">

export type UpdateTask = Partial<Omit<Task, "id" | "createdAt">>

/**
 * taskMetrics
 */

export const taskMetrics = pgTable("taskMetrics", {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	tokensIn: integer("tokens_in").notNull(),
	tokensOut: integer("tokens_out").notNull(),
	tokensContext: integer("tokens_context").notNull(),
	cacheWrites: integer("cache_writes").notNull(),
	cacheReads: integer("cache_reads").notNull(),
	cost: real().notNull(),
	duration: integer().notNull(),
	toolUsage: jsonb("tool_usage").$type<ToolUsage>(),
	requestUsage: jsonb("request_usage").$type<unknown[]>(),
	createdAt: timestamp("created_at").notNull(),
})

export type TaskMetrics = typeof taskMetrics.$inferSelect

export type InsertTaskMetrics = Omit<typeof taskMetrics.$inferInsert, "id" | "createdAt">

export type UpdateTaskMetrics = Partial<Omit<TaskMetrics, "id" | "createdAt">>

/**
 * Trials and attempts
 */

export const trials = pgTable("trials", {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	taskId: integer("task_id")
		.references(() => tasks.id, { onDelete: "cascade" })
		.notNull()
		.unique(),
	status: text().default("pending").notNull().$type<"pending" | "running" | TrialTerminalStatus>(),
	firstAttemptStatus: text("first_attempt_status").$type<TrialTerminalStatus>(),
	retryAssisted: boolean("retry_assisted").default(false).notNull(),
	attemptCount: integer("attempt_count").default(0).notNull(),
	version: integer().default(0).notNull(),
	taskDefinitionIdentity: text("task_definition_identity"),
	variantIdentity: text("variant_identity"),
	startedAt: timestamp("started_at"),
	finishedAt: timestamp("finished_at"),
	createdAt: timestamp("created_at").notNull(),
	updatedAt: timestamp("updated_at").notNull(),
})

export const attempts = pgTable(
	"attempts",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		trialId: integer("trial_id")
			.references(() => trials.id, { onDelete: "cascade" })
			.notNull(),
		attemptNumber: integer("attempt_number").notNull(),
		phase: text().default("created").notNull().$type<AttemptPhase>(),
		terminalStatus: text("terminal_status").$type<TrialTerminalStatus>(),
		failureCode: text("failure_code"),
		failureDetail: text("failure_detail"),
		version: integer().default(0).notNull(),
		evidenceStatus: text("evidence_status")
			.default("legacy_missing")
			.notNull()
			.$type<"legacy_missing" | "pending" | "valid" | "invalid">(),
		evidenceBundleDigest: text("evidence_bundle_digest"),
		startedAt: timestamp("started_at"),
		finishedAt: timestamp("finished_at"),
		createdAt: timestamp("created_at").notNull(),
		updatedAt: timestamp("updated_at").notNull(),
	},
	(table) => [uniqueIndex("attempts_trial_attempt_number_idx").on(table.trialId, table.attemptNumber)],
)

export const trialsRelations = relations(trials, ({ one, many }) => ({
	task: one(tasks, { fields: [trials.taskId], references: [tasks.id] }),
	attempts: many(attempts),
}))

export const attemptsRelations = relations(attempts, ({ one, many }) => ({
	trial: one(trials, { fields: [attempts.trialId], references: [trials.id] }),
	graderResults: many(graderResults),
	events: many(evalEvents),
	artifacts: many(artifacts),
}))

export type Trial = typeof trials.$inferSelect
export type Attempt = typeof attempts.$inferSelect

/**
 * Grader results and reconstructable evidence
 */

export const graderResults = pgTable(
	"graderResults",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		attemptId: integer("attempt_id")
			.references(() => attempts.id, { onDelete: "cascade" })
			.notNull(),
		graderId: text("grader_id").notNull(),
		graderVersion: integer("grader_version").notNull(),
		graderType: text("grader_type").notNull().$type<GraderType>(),
		status: text().notNull().$type<GraderStatus>(),
		hardGate: boolean("hard_gate").notNull(),
		failureClass: text("failure_class").notNull().$type<GraderFailureClass>(),
		startedAt: timestamp("started_at").notNull(),
		finishedAt: timestamp("finished_at").notNull(),
		durationMs: integer("duration_ms").notNull(),
		diagnostics: jsonb().notNull().$type<GraderDiagnostic[]>(),
		evidence: jsonb().notNull().$type<GraderEvidence[]>(),
		error: text(),
		createdAt: timestamp("created_at").notNull(),
	},
	(table) => [
		uniqueIndex("grader_results_attempt_identity_idx").on(table.attemptId, table.graderId, table.graderVersion),
	],
)

export const graderResultsRelations = relations(graderResults, ({ one }) => ({
	attempt: one(attempts, { fields: [graderResults.attemptId], references: [attempts.id] }),
}))

export const evalEvents = pgTable(
	"eval_events",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		attemptId: integer("attempt_id")
			.references(() => attempts.id, { onDelete: "cascade" })
			.notNull(),
		schemaVersion: integer("schema_version").default(1).notNull(),
		sequence: integer().notNull(),
		timestamp: timestamp().notNull(),
		type: text().notNull(),
		payload: jsonb().notNull().$type<EvalEvent["payload"]>(),
		payloadDigest: text("payload_digest").notNull(),
		redactionVersion: text("redaction_version").notNull(),
		late: boolean().default(false).notNull(),
		createdAt: timestamp("created_at").notNull(),
	},
	(table) => [uniqueIndex("eval_events_attempt_sequence_idx").on(table.attemptId, table.sequence)],
)

export const artifacts = pgTable(
	"artifacts",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		attemptId: integer("attempt_id")
			.references(() => attempts.id, { onDelete: "cascade" })
			.notNull(),
		schemaVersion: integer("schema_version").default(1).notNull(),
		contentId: text("content_id").notNull(),
		kind: text().notNull().$type<ArtifactKind>(),
		digest: text().notNull(),
		mediaType: text("media_type").notNull(),
		sizeBytes: integer("size_bytes").notNull(),
		access: text().notNull().$type<ArtifactAccess>(),
		retention: text().notNull().$type<"campaign" | "baseline" | "permanent">(),
		uploadState: text("upload_state").notNull().$type<ArtifactUploadState>(),
		storageKey: text("storage_key").notNull(),
		createdAt: timestamp("created_at").notNull(),
	},
	(table) => [uniqueIndex("artifacts_attempt_kind_digest_idx").on(table.attemptId, table.kind, table.digest)],
)

export const evalEventsRelations = relations(evalEvents, ({ one }) => ({
	attempt: one(attempts, { fields: [evalEvents.attemptId], references: [attempts.id] }),
}))

export const artifactsRelations = relations(artifacts, ({ one }) => ({
	attempt: one(attempts, { fields: [artifacts.attemptId], references: [attempts.id] }),
}))

export const taskDefinitions = pgTable(
	"task_definitions",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		identity: text().notNull().unique(),
		schemaVersion: integer("schema_version").default(1).notNull(),
		manifest: jsonb().notNull().$type<TaskManifest>(),
		manifestDigest: text("manifest_digest").notNull(),
		createdAt: timestamp("created_at").notNull(),
	},
	(table) => [uniqueIndex("task_definitions_digest_idx").on(table.manifestDigest)],
)

export const variants = pgTable(
	"variants",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		identity: text().notNull().unique(),
		schemaVersion: integer("schema_version").default(1).notNull(),
		manifest: jsonb().notNull().$type<VariantManifest>(),
		manifestDigest: text("manifest_digest").notNull(),
		createdAt: timestamp("created_at").notNull(),
	},
	(table) => [uniqueIndex("variants_digest_idx").on(table.manifestDigest)],
)

/**
 * Append-only experiment governance
 */

export const experimentTaskSets = pgTable("experiment_task_sets", {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	identity: text().notNull().unique(),
	manifest: jsonb().notNull().$type<TaskSetManifest>(),
	digest: text().notNull(),
	createdAt: timestamp("created_at").notNull(),
})

export const experimentVariants = pgTable("experiment_variants", {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	identity: text().notNull().unique(),
	manifest: jsonb().notNull().$type<ExperimentVariant>(),
	digest: text().notNull(),
	createdAt: timestamp("created_at").notNull(),
})

export const experiments = pgTable("experiments", {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	identity: text().notNull().unique(),
	template: text().notNull().$type<"harness_only" | "model_only">(),
	taskSetIdentity: text("task_set_identity").notNull(),
	controlVariantIdentity: text("control_variant_identity").notNull(),
	candidateVariantIdentity: text("candidate_variant_identity").notNull(),
	manifest: jsonb().notNull().$type<ExperimentManifest>(),
	digest: text().notNull(),
	createdAt: timestamp("created_at").notNull(),
})

export const experimentPairs = pgTable(
	"experiment_pairs",
	{
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		experimentId: integer("experiment_id")
			.references(() => experiments.id, { onDelete: "restrict" })
			.notNull(),
		pairKey: jsonb("pair_key").notNull().$type<PairKey>(),
		pairDigest: text("pair_digest").notNull(),
		controlTrialId: integer("control_trial_id").references(() => trials.id, { onDelete: "restrict" }),
		candidateTrialId: integer("candidate_trial_id").references(() => trials.id, { onDelete: "restrict" }),
		createdAt: timestamp("created_at").notNull(),
	},
	(table) => [uniqueIndex("experiment_pairs_identity_idx").on(table.experimentId, table.pairDigest)],
)

export const experimentReports = pgTable("experiment_reports", {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	experimentId: integer("experiment_id")
		.references(() => experiments.id, { onDelete: "restrict" })
		.notNull()
		.unique(),
	report: jsonb().notNull().$type<Record<string, unknown>>(),
	digest: text().notNull(),
	createdAt: timestamp("created_at").notNull(),
})

export const baselines = pgTable("baselines", {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	identity: text().notNull().unique(),
	variantIdentity: text("variant_identity").notNull(),
	taskSetIdentity: text("task_set_identity").notNull(),
	reportDigest: text("report_digest").notNull(),
	createdBy: text("created_by").notNull(),
	createdAt: timestamp("created_at").notNull(),
})

export const promotions = pgTable("promotions", {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	baselineIdentity: text("baseline_identity").notNull(),
	rollbackBaselineIdentity: text("rollback_baseline_identity").notNull(),
	experimentIdentity: text("experiment_identity").notNull(),
	policyId: text("policy_id").notNull(),
	reviewer: text().notNull(),
	rationale: text().notNull(),
	decision: text().notNull().$type<"accepted" | "rejected">(),
	reasons: jsonb().notNull().$type<string[]>(),
	createdAt: timestamp("created_at").notNull(),
})

/**
 * toolErrors
 */

export const toolErrors = pgTable("toolErrors", {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	runId: integer("run_id").references(() => runs.id, { onDelete: "cascade" }),
	taskId: integer("task_id").references(() => tasks.id, { onDelete: "cascade" }),
	toolName: text("tool_name").notNull().$type<ToolName>(),
	error: text().notNull(),
	createdAt: timestamp("created_at").notNull(),
})

export const toolErrorsRelations = relations(toolErrors, ({ one }) => ({
	run: one(runs, { fields: [toolErrors.runId], references: [runs.id] }),
	task: one(tasks, { fields: [toolErrors.taskId], references: [tasks.id] }),
}))

export type ToolError = typeof toolErrors.$inferSelect

export type InsertToolError = Omit<typeof toolErrors.$inferInsert, "id" | "createdAt">

export type UpdateToolError = Partial<Omit<ToolError, "id" | "createdAt">>

/**
 * schema
 */

export const schema = {
	runs,
	runsRelations,
	tasks,
	tasksRelations,
	taskMetrics,
	trials,
	trialsRelations,
	attempts,
	attemptsRelations,
	graderResults,
	graderResultsRelations,
	evalEvents,
	evalEventsRelations,
	artifacts,
	artifactsRelations,
	taskDefinitions,
	variants,
	experimentTaskSets,
	experimentVariants,
	experiments,
	experimentPairs,
	experimentReports,
	baselines,
	promotions,
	toolErrors,
	toolErrorsRelations,
}
