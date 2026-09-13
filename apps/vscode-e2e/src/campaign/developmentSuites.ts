import { alphaReasoningEfforts } from "../liveModelSelection"
import { WORKFLOW_SCENARIO_IDS, type WorkflowScenarioId } from "../scenarios/contracts"
import { parseCampaignConfig } from "./config"
import { HOST_VERSIONS, type CampaignConfig, type CampaignHost } from "./types"
import { RELIABILITY_ACCEPTANCE_SCENARIO_IDS, isReliabilityScenario } from "../scenarios/reliabilityCatalog"

export const DEVELOPMENT_SUITE_NAMES = ["smoke", "development", "soak", "reliability", "core"] as const
export type DevelopmentSuiteName = (typeof DEVELOPMENT_SUITE_NAMES)[number]

export interface DevelopmentSuiteOptions {
	suite: string
	id: string
	provider: "scripted" | "live-copilot"
	modelId?: string
	effort?: string
	host?: CampaignHost
	maxRequests?: number
	samples?: number
}

/** Routine core-loop coverage; broader reliability and long-context acceptance remain separate. */
export const CORE_SCENARIO_IDS = [
	"dev-git-inspect",
	"dev-refactor",
	"dev-search-recovery",
	"completion-idle",
	"provider-empty-recovery",
	"provider-error-recovery",
	"stream-cancel-recovery",
	"reload-continuation",
	"background-isolation",
] as const satisfies readonly WorkflowScenarioId[]

const MAX_REPRODUCTIONS = 2
const ATTEMPT_TIMEOUT_MS = 10 * 60 * 1_000
const MINUTE_MS = 60 * 1_000
const HOUR_MS = 60 * MINUTE_MS

const DEFAULT_HOSTS: readonly CampaignHost[] = HOST_VERSIONS.map((version) => ({ version }))

interface SuiteDefinition {
	scenarioIds: readonly WorkflowScenarioId[]
	samples: number
	maxRequests: number
	maxDurationMs: number
}

const SUITE_DEFINITIONS: Record<DevelopmentSuiteName, SuiteDefinition> = {
	core: {
		scenarioIds: CORE_SCENARIO_IDS,
		samples: 1,
		maxRequests: 300,
		maxDurationMs: 2 * HOUR_MS,
	},
	smoke: {
		scenarioIds: ["dev-git-inspect", "dev-repo-bootstrap", "review-edit-test-commit-followup"],
		samples: 1,
		maxRequests: 300,
		maxDurationMs: 30 * MINUTE_MS,
	},
	development: {
		scenarioIds: WORKFLOW_SCENARIO_IDS.filter((id) => !isReliabilityScenario(id)),
		samples: 1,
		maxRequests: 1_200,
		maxDurationMs: 2 * HOUR_MS,
	},
	soak: {
		scenarioIds: WORKFLOW_SCENARIO_IDS.filter((id) => !isReliabilityScenario(id)),
		samples: 3,
		maxRequests: 3_000,
		maxDurationMs: 6 * HOUR_MS,
	},
	reliability: {
		scenarioIds: RELIABILITY_ACCEPTANCE_SCENARIO_IDS,
		samples: 1,
		maxRequests: 1_200,
		maxDurationMs: 2 * HOUR_MS,
	},
}

function isSupportedEffort(value: unknown): value is (typeof alphaReasoningEfforts)[number] {
	return typeof value === "string" && alphaReasoningEfforts.includes(value as (typeof alphaReasoningEfforts)[number])
}

export function createDevelopmentSuite(options: DevelopmentSuiteOptions): CampaignConfig {
	if (!options || typeof options !== "object" || Array.isArray(options))
		throw new Error("Invalid development suite options")

	if (!DEVELOPMENT_SUITE_NAMES.includes(options.suite as DevelopmentSuiteName))
		throw new Error("Invalid development suite")
	if (options.provider !== "scripted" && options.provider !== "live-copilot")
		throw new Error("Invalid development suite provider")
	if (["reliability", "core"].includes(options.suite) && options.provider !== "live-copilot")
		throw new Error("Reliability acceptance requires live Copilot")

	if (options.provider === "scripted" && (options.modelId !== undefined || options.effort !== undefined))
		throw new Error("Scripted development suites do not accept model or effort")
	if (options.provider === "live-copilot") {
		if (typeof options.modelId !== "string" || options.modelId.length === 0)
			throw new Error("Live development suites require an exact model ID")
		if (!isSupportedEffort(options.effort))
			throw new Error("Live development suites require an explicit supported effort")
	}

	const definition = SUITE_DEFINITIONS[options.suite as DevelopmentSuiteName]
	// Routine runs use the release-gating host. Forward compatibility costs an explicit additional run.
	const defaultHosts = options.suite === "core" ? DEFAULT_HOSTS.slice(0, 1) : DEFAULT_HOSTS
	const hosts = options.host === undefined ? defaultHosts.map((host) => ({ ...host })) : [options.host]
	const scenarioIds = [...definition.scenarioIds]
	const samples = options.samples ?? definition.samples

	return parseCampaignConfig({
		id: options.id,
		hosts,
		scenarioIds,
		samples,
		provider: {
			mode: options.provider,
			...(options.modelId === undefined ? {} : { modelId: options.modelId }),
			...(options.effort === undefined ? {} : { effort: options.effort }),
		},
		budgets: {
			maxIterations: scenarioIds.length * hosts.length * samples * (MAX_REPRODUCTIONS + 1),
			maxRequests: options.maxRequests ?? definition.maxRequests,
			maxDurationMs: definition.maxDurationMs,
			attemptTimeoutMs: ATTEMPT_TIMEOUT_MS,
		},
		maxReproductions: MAX_REPRODUCTIONS,
	})
}
