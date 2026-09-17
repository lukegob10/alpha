import * as path from "node:path"
import { HOST_VERSIONS, type CampaignConfig, type CampaignHost, type CampaignRepair } from "./types"

const object = (value: unknown): Record<string, unknown> => {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid campaign object")
	return value as Record<string, unknown>
}
const identifier = (value: unknown): string => {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
		throw new Error("Invalid campaign identifier")
	}
	return value
}
const modelIdentifier = (value: unknown): string => {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)) {
		throw new Error("Invalid model identifier")
	}
	return value
}
const boundedString = (value: unknown): string => {
	if (typeof value !== "string" || !value || value.length > 4_096 || value.includes("\0")) {
		throw new Error("Invalid campaign string")
	}
	return value
}
const integer = (value: unknown, max: number): number => {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
		throw new Error("Invalid campaign budget")
	}
	return value
}
const list = (value: unknown, max: number): unknown[] => {
	if (!Array.isArray(value) || value.length === 0 || value.length > max) throw new Error("Invalid campaign list")
	return value
}
const uniqueIds = (value: unknown, max: number): string[] => {
	const ids = list(value, max).map(identifier)
	if (new Set(ids).size !== ids.length) throw new Error("Duplicate campaign identifier")
	return ids
}

export function parseCampaignConfig(input: unknown, enableReviewedPatches = false): CampaignConfig {
	const value = object(input)
	const provider = object(value.provider)
	if (provider.mode !== "scripted" && provider.mode !== "live-copilot") throw new Error("Invalid campaign provider")
	const budgets = object(value.budgets)
	const hosts: CampaignHost[] = list(value.hosts, 2).map((entry) => {
		const host = object(entry)
		if (!HOST_VERSIONS.includes(host.version as CampaignHost["version"]))
			throw new Error("Unsupported host version")
		const executable = host.executable === undefined ? undefined : boundedString(host.executable)
		if (executable && !path.isAbsolute(executable)) throw new Error("Host executable must be absolute")
		return { version: host.version as CampaignHost["version"], ...(executable ? { executable } : {}) }
	})
	if (new Set(hosts.map((host) => host.version)).size !== hosts.length) throw new Error("Duplicate host version")
	const config: CampaignConfig = {
		id: identifier(value.id),
		hosts,
		scenarioIds: uniqueIds(value.scenarioIds, 50),
		samples: integer(value.samples, 100),
		provider: {
			mode: provider.mode,
			...(provider.modelId === undefined ? {} : { modelId: modelIdentifier(provider.modelId) }),
			...(provider.effort === undefined ? {} : { effort: identifier(provider.effort) }),
		},
		budgets: {
			maxIterations: integer(budgets.maxIterations, 1_000),
			maxRequests: integer(budgets.maxRequests, 100_000),
			maxDurationMs: integer(budgets.maxDurationMs, 43_200_000),
			attemptTimeoutMs: integer(budgets.attemptTimeoutMs, 1_200_000),
		},
		maxReproductions: integer(value.maxReproductions ?? 2, 10),
	}
	if (provider.mode === "live-copilot" && !config.provider.modelId)
		throw new Error("Live campaigns require a model ID")
	if (value.storageBudget !== undefined) {
		const storage = object(value.storageBudget)
		config.storageBudget = {
			maxBytes: integer(storage.maxBytes ?? 10 * 1024 ** 3, 100 * 1024 ** 3),
			maxEntries: integer(storage.maxEntries ?? 100_000, 1_000_000),
			maxDepth: integer(storage.maxDepth ?? 32, 32),
		}
	}
	if (value.repair !== undefined) {
		const repair = object(value.repair)
		if (!enableReviewedPatches || repair.enabled !== true)
			throw new Error("Reviewed patches require explicit opt-in")
		const sourceRoot = boundedString(repair.sourceRoot)
		if (!path.isAbsolute(sourceRoot)) throw new Error("Repair source root must be absolute")
		const plans: CampaignRepair[] = list(repair.plans, 10).map((entry) => {
			const plan = object(entry)
			const patch = object(plan.patch)
			return {
				scenarioId: identifier(plan.scenarioId),
				regressionScenarioId: identifier(plan.regressionScenarioId),
				neighborScenarioIds: uniqueIds(plan.neighborScenarioIds, 20),
				diagnosisId: identifier(plan.diagnosisId),
				patch: {
					id: identifier(patch.id),
					edits: list(patch.edits, 10).map((entry) => {
						const edit = object(entry)
						if (typeof edit.replacement !== "string" || Buffer.byteLength(edit.replacement) > 262_144) {
							throw new Error("Invalid patch replacement")
						}
						if (typeof edit.expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(edit.expectedSha256)) {
							throw new Error("Invalid patch hash")
						}
						return {
							path: boundedString(edit.path),
							expectedSha256: edit.expectedSha256,
							replacement: edit.replacement,
						}
					}),
				},
			}
		})
		if (new Set(plans.map((plan) => plan.scenarioId)).size !== plans.length)
			throw new Error("Duplicate repair scenario")
		config.repair = {
			enabled: true,
			sourceRoot,
			allowedPaths: list(repair.allowedPaths, 10).map(boundedString),
			plans,
		}
	}
	return config
}
