import { z } from "zod"

import { graderTypes, type EvalTraceEvent, type GraderResult, type GraderRunResult, type GraderSpec } from "./types"

const nonempty = z.string().min(1)
const count = z.number().int().nonnegative()
const testFile = nonempty.refine(
	(value) =>
		!value.includes("\\") &&
		!value.includes(":") &&
		![...value].some((character) => character.charCodeAt(0) < 32) &&
		!value.startsWith("/") &&
		value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
)
const expectedTest = z
	.object({
		file: testFile,
		name: nonempty,
		assertions: z.number().int().positive(),
	})
	.strict()
const testExecution = z
	.object({
		runner: z.literal("node-test"),
		expectedTests: z
			.array(expectedTest)
			.min(1)
			.refine(
				(tests) => new Set(tests.map(({ file, name }) => JSON.stringify([file, name]))).size === tests.length,
			),
		sourceDigests: z
			.array(z.object({ file: testFile, digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict())
			.min(1)
			.optional(),
	})
	.strict()
	.refine(({ expectedTests, sourceDigests }) => {
		if (!sourceDigests) return true
		const files = new Set(expectedTests.map(({ file }) => file))
		return (
			sourceDigests.length === files.size &&
			new Set(sourceDigests.map(({ file }) => file)).size === files.size &&
			sourceDigests.every(({ file }) => files.has(file))
		)
	})
const command = z.object({ command: nonempty, args: z.array(z.string()) }).strict()
const base = {
	id: nonempty,
	version: z.number().int().positive(),
	hardGate: z.boolean(),
	failureClass: z.enum(["outcome", "safety"]),
}
// Criteria are execution inputs: an unknown key must not silently discard an authored check.
const specSchema: z.ZodType<GraderSpec> = z.union([
	z
		.object({
			...base,
			type: z.literal("command"),
			commands: z.array(command.extend({ testExecution: testExecution.optional() })).min(1),
			cwd: z.enum(["workspace", "hidden"]),
			timeoutMs: z.number().int().positive(),
			maxOutputBytes: z.number().int().positive(),
		})
		.strict(),
	z
		.object({
			...base,
			type: z.literal("filesystem"),
			assertions: z
				.array(
					z.discriminatedUnion("kind", [
						z.object({ kind: z.literal("exists"), path: nonempty }).strict(),
						z.object({ kind: z.literal("absent"), path: nonempty }).strict(),
						z.object({ kind: z.literal("content-equals"), path: nonempty, expected: z.string() }).strict(),
						z
							.object({
								kind: z.literal("digest-equals"),
								path: nonempty,
								expected: z.string().regex(/^sha256:[a-f0-9]{64}$/),
							})
							.strict(),
						z
							.object({
								kind: z.literal("content-matches"),
								path: nonempty,
								pattern: nonempty,
								flags: z.string().optional(),
							})
							.strict(),
					]),
				)
				.min(1),
		})
		.strict(),
	z
		.object({
			...base,
			type: z.literal("diff-policy"),
			allowed: z.array(nonempty).optional(),
			forbidden: z.array(nonempty).optional(),
			maxChangedFiles: count.optional(),
		})
		.strict()
		.refine((spec) => spec.allowed !== undefined || !!spec.forbidden?.length || spec.maxChangedFiles !== undefined),
	z
		.object({
			...base,
			type: z.literal("trace-assertion"),
			assertions: z
				.array(
					z.discriminatedUnion("kind", [
						z.object({ kind: z.literal("present"), eventType: nonempty }).strict(),
						z.object({ kind: z.literal("absent"), eventType: nonempty }).strict(),
						z.object({ kind: z.literal("ordered"), before: nonempty, after: nonempty }).strict(),
						z.object({ kind: z.literal("count-max"), eventType: nonempty, max: count }).strict(),
						z
							.object({
								kind: z.literal("verification-after-last-mutation"),
								commands: z.array(command).min(1).optional(),
							})
							.strict(),
					]),
				)
				.min(1),
		})
		.strict(),
	z
		.object({
			...base,
			type: z.literal("static-analysis"),
			files: z
				.array(
					z
						.object({
							path: nonempty,
							parseAs: z.enum(["text", "json"]).optional(),
							requiredPatterns: z.array(nonempty).optional(),
							forbiddenPatterns: z.array(nonempty).optional(),
						})
						.strict(),
				)
				.optional(),
			scanChangedFiles: z
				.object({ extensions: z.array(nonempty).min(1), forbiddenPatterns: z.array(nonempty).min(1) })
				.strict()
				.optional(),
		})
		.strict()
		.refine((spec) => !!spec.files?.length || spec.scanChangedFiles !== undefined),
	z
		.object({
			...base,
			type: z.literal("usage-policy"),
			maxModelCalls: count,
			maxToolCalls: count,
			maxCostUsd: z.number().finite().nonnegative(),
		})
		.strict(),
])

const resultSchema = z.object({
	graderId: nonempty,
	graderVersion: z.number().int().positive(),
	type: z.enum(graderTypes),
	status: z.enum(["passed", "failed", "error"]),
	hardGate: z.boolean(),
	failureClass: z.enum(["outcome", "safety"]),
	diagnostics: z.array(
		z.object({
			code: nonempty,
			message: nonempty,
			path: z.string().optional(),
			severity: z.enum(["info", "warning", "error"]),
		}),
	),
	evidence: z.array(
		z.object({
			id: nonempty,
			kind: z.enum(["stdout", "stderr", "file", "diff", "trace", "report"]),
			mediaType: nonempty,
			digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
			byteLength: count,
			metadata: z.record(z.unknown()).optional(),
		}),
	),
	error: nonempty.optional(),
})

export function validateGraderSpec(spec: GraderSpec): void {
	if (!specSchema.safeParse(spec).success) throw new Error(`Invalid or empty grader criteria: ${spec.id}`)
}

export function hasValidGraderEvidence(value: unknown): boolean {
	const parsed = resultSchema.safeParse(value)
	if (!parsed.success) return false
	if (parsed.data.status !== "error" && parsed.data.evidence.length === 0) return false
	if (parsed.data.status !== "error" && parsed.data.error !== undefined) return false
	return (
		parsed.data.status !== "passed" ||
		(parsed.data.error === undefined && !parsed.data.diagnostics.some(({ severity }) => severity === "error"))
	)
}

export function validateGraderResult(
	spec: GraderSpec,
	value: unknown,
): Omit<GraderResult, "startedAt" | "finishedAt" | "durationMs"> {
	const parsed = resultSchema.safeParse(value)
	if (!parsed.success || !hasValidGraderEvidence(value)) throw new Error(`Invalid grader result evidence: ${spec.id}`)
	const result = parsed.data
	if (
		result.graderId !== spec.id ||
		result.graderVersion !== spec.version ||
		result.type !== spec.type ||
		result.hardGate !== spec.hardGate ||
		result.failureClass !== spec.failureClass
	)
		throw new Error(`Grader result does not match its configured identity and policy: ${spec.id}`)
	if (
		result.status === "passed" &&
		(result.error !== undefined || result.diagnostics.some(({ severity }) => severity === "error"))
	) {
		throw new Error(`Contradictory passing grader result: ${spec.id}`)
	}
	return result
}

const runSchema = z.object({
	decision: z.enum(["passed", "outcome_failed", "safety_failed", "grader_error"]),
	results: z
		.array(
			resultSchema.extend({
				startedAt: z.string().datetime({ offset: true }),
				finishedAt: z.string().datetime({ offset: true }),
				durationMs: count,
			}),
		)
		.min(1),
})

export function parseGraderRun(value: unknown): GraderRunResult {
	const parsed = runSchema.safeParse(value)
	if (!parsed.success || !parsed.data.results.every(hasValidGraderEvidence))
		throw new Error("Invalid grader run evidence")
	const identities = new Set<string>()
	for (const result of parsed.data.results) {
		const identity = `${result.graderId}@${result.graderVersion}`
		if (identities.has(identity) || Date.parse(result.finishedAt) < Date.parse(result.startedAt))
			throw new Error("Invalid grader run identity or timing")
		identities.add(identity)
	}
	return parsed.data
}

const traceSchema = z
	.array(
		z.object({
			sequence: count,
			type: nonempty,
			timestamp: z.string().datetime({ offset: true }),
		}),
	)
	.min(1)

export function validateTraceEvidence(trace: EvalTraceEvent[]): void {
	if (!traceSchema.safeParse(trace).success) throw new Error("Missing or invalid grader trace evidence")
	for (let index = 1; index < trace.length; index++) {
		if (trace[index]!.sequence <= trace[index - 1]!.sequence) {
			throw new Error("Grader trace sequence must be strictly increasing")
		}
	}
}
