import { isLiveProviderIdentityReceipt } from "../liveProviderIdentity"
import {
	FAILURE_CLASSES,
	HOST_VERSIONS,
	PERFORMANCE_METRICS,
	type CampaignPerformance,
	type ScenarioResult,
} from "./types"

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value)
const safeId = (value: unknown): value is string =>
	typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)

/** Validate the process boundary before status indexing, reproduction, or budget arithmetic. */
export function validateScenarioResult(input: unknown): ScenarioResult {
	if (!isRecord(input) || !["passed", "failed", "blocked"].includes(String(input.status)) || !isRecord(input.usage)) {
		throw new Error("Invalid scenario result")
	}
	if (input.retentionFailed !== undefined && input.retentionFailed !== true)
		throw new Error("Invalid retention status")
	if (input.status === "passed" && (input.failure !== undefined || input.retentionFailed === true))
		throw new Error("Scenario success contradicts its failure evidence")
	for (const metric of ["requests", "inputTokens", "outputTokens", "cost"] as const) {
		const value = input.usage[metric]
		if (
			value !== null &&
			(typeof value !== "number" ||
				!Number.isFinite(value) ||
				value < 0 ||
				(metric !== "cost" && !Number.isSafeInteger(value)))
		)
			throw new Error("Invalid scenario usage")
	}
	if (input.status !== "passed" || input.failure !== undefined) {
		if (
			!isRecord(input.failure) ||
			!FAILURE_CLASSES.includes(input.failure.class as never) ||
			!safeId(input.failure.fingerprint)
		) {
			throw new Error("Invalid scenario failure")
		}
	}
	if (input.actualHostVersion !== undefined && !HOST_VERSIONS.includes(input.actualHostVersion as never)) {
		throw new Error("Invalid actual host version")
	}
	let model: ScenarioResult["model"]
	if (input.model !== undefined) {
		if (
			!isRecord(input.model) ||
			!safeId(input.model.id) ||
			(input.model.effort !== undefined && !safeId(input.model.effort))
		)
			throw new Error("Invalid actual model")
		model = { id: input.model.id, ...(input.model.effort === undefined ? {} : { effort: input.model.effort }) }
	}
	if (
		input.taskIds !== undefined &&
		(!Array.isArray(input.taskIds) || input.taskIds.length > 100 || !input.taskIds.every(safeId))
	)
		throw new Error("Invalid task IDs")
	if (input.providerIdentity !== undefined && !isLiveProviderIdentityReceipt(input.providerIdentity))
		throw new Error("Invalid live provider identity")
	let performance: CampaignPerformance | undefined
	if (input.performance !== undefined) {
		if (!isRecord(input.performance)) throw new Error("Invalid scenario performance")
		performance = {}
		for (const metric of PERFORMANCE_METRICS) {
			const value = input.performance[metric]
			if (value === undefined) continue
			if (
				value !== null &&
				(typeof value !== "number" ||
					!Number.isFinite(value) ||
					value < 0 ||
					((metric.endsWith("Tokens") || metric === "providerRetries") && !Number.isSafeInteger(value)))
			)
				throw new Error("Invalid scenario performance")
			if (
				(metric === "inputTokens" || metric === "outputTokens") &&
				value !== null &&
				input.usage[metric] !== null &&
				value !== input.usage[metric]
			)
				throw new Error("Inconsistent scenario token observations")
			performance[metric] = value as number | null
		}
	}
	// Deliberate projection: unknown fields may contain prompts or provider payloads.
	return {
		status: input.status as ScenarioResult["status"],
		...(input.retentionFailed ? { retentionFailed: true as const } : {}),
		usage: {
			requests: input.usage.requests as number | null,
			inputTokens: input.usage.inputTokens as number | null,
			outputTokens: input.usage.outputTokens as number | null,
			cost: input.usage.cost as number | null,
		},
		...(input.failure === undefined
			? {}
			: {
					failure: {
						class: (input.failure as { class: NonNullable<ScenarioResult["failure"]>["class"] }).class,
						fingerprint: (input.failure as { fingerprint: string }).fingerprint,
					},
				}),
		...(input.actualHostVersion === undefined
			? {}
			: { actualHostVersion: input.actualHostVersion as ScenarioResult["actualHostVersion"] }),
		...(model === undefined ? {} : { model }),
		...(input.taskIds === undefined ? {} : { taskIds: [...(input.taskIds as string[])] }),
		...(input.providerIdentity === undefined ? {} : { providerIdentity: structuredClone(input.providerIdentity) }),
		...(performance === undefined || Object.keys(performance).length === 0 ? {} : { performance }),
	}
}
