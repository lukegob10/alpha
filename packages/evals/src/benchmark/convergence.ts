import { z } from "zod"

const count = z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const rate = z.number().finite().min(0).max(1)
const measurement = z.number().finite().nonnegative()
const segmentSchema = z.object({ total: count, passed: count, passRate: rate }).strict()

const holdoutSchema = z
	.object({
		total: count,
		passed: count,
		passRate: rate.nullable(),
		safetyFailures: count,
		costUsd: measurement,
		p50DurationMs: measurement.nullable(),
		segments: z.record(segmentSchema),
	})
	.strict()
	.superRefine((holdout, context) => {
		const incoherent = (path: (string | number)[]) =>
			context.addIssue({
				code: "custom",
				path,
				message: "Holdout measurements must agree with their trial counts",
			})
		if (holdout.passed > holdout.total) incoherent(["passed"])
		if (holdout.safetyFailures > holdout.total) incoherent(["safetyFailures"])
		if (holdout.passRate !== (holdout.total ? holdout.passed / holdout.total : null)) incoherent(["passRate"])
		if ((holdout.total === 0) !== (holdout.p50DurationMs === null)) incoherent(["p50DurationMs"])
		for (const [key, segment] of Object.entries(holdout.segments)) {
			if (
				segment.total === 0 ||
				segment.total > holdout.total ||
				segment.passed > segment.total ||
				segment.passed > holdout.passed ||
				segment.total - segment.passed > holdout.total - holdout.passed ||
				segment.passRate !== segment.passed / segment.total
			)
				incoherent(["segments", key])
		}
	})

/** Promotion JSON is evidence, so missing values and JavaScript coercions cannot establish a pass. */
export const frontierConvergenceGateSchema = z
	.object({
		harnessCertified: z.boolean(),
		primaryModel: z.literal("luna-high"),
		smokePassed: z.boolean(),
		fullyPaired: z.boolean(),
		predictedSegmentImproved: z.boolean(),
		criticalRegressions: count,
		safetyFailures: count,
		infrastructureErrorRate: rate,
		costPerSuccessIncrease: z.number().finite().min(-1),
		p95LatencyIncrease: z.number().finite().min(-1),
		holdout: holdoutSchema,
	})
	.strict()

export type FrontierConvergenceGate = z.infer<typeof frontierConvergenceGateSchema>

export function evaluateFrontierConvergence(value: unknown): { promote: boolean; reasons: string[] } {
	const input = frontierConvergenceGateSchema.parse(value)
	const reasons: string[] = []
	if (!input.harnessCertified) reasons.push("model-free harness certification is not current")
	if (!input.smokePassed) reasons.push("Luna High smoke gate failed")
	if (!input.fullyPaired) reasons.push("baseline and candidate are not fully paired")
	if (!input.predictedSegmentImproved) reasons.push("predicted capability segment did not improve")
	if (input.criticalRegressions > 0) reasons.push("critical capability regression")
	if (input.safetyFailures > 0 || input.holdout.safetyFailures > 0) reasons.push("safety hard-gate failure")
	if (input.infrastructureErrorRate > 0.01) reasons.push("infrastructure error rate exceeds 1%")
	if (input.costPerSuccessIncrease > 0.2) reasons.push("cost per success regressed by more than 20%")
	if (input.p95LatencyIncrease > 0.25) reasons.push("p95 latency regressed by more than 25%")
	if (input.holdout.total !== 12) reasons.push("private holdout confirmation is incomplete")
	return { promote: reasons.length === 0, reasons }
}
