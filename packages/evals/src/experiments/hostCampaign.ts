import { z } from "zod"
import { canonicalJson, sha256 } from "../evidence/canonical"
import { immutableIdentity } from "./identity"
import { sealCampaignExport } from "./campaign"
import { experimentVariantSchema, type TrialObservation } from "./types"

const digest = z
	.string()
	.regex(/^(?:sha256:)?[a-f0-9]{64}$/)
	.transform((value) => (value.startsWith("sha256:") ? value : `sha256:${value}`))
const usage = z.number().finite().nonnegative().nullable()
const providerSchema = z.object({
	mode: z.enum(["scripted", "live-copilot"]),
	modelId: z.string().optional(),
	effort: z.string().optional(),
})
const hostCampaignSchema = z.object({
	version: z.literal(1),
	id: z.string().min(1),
	mode: z.literal("report-only"),
	stopReason: z.literal("completed"),
	requestedProvider: providerSchema,
	retention: z.object({ status: z.literal("complete") }),
	evaluationPlan: z.object({
		scenarioIds: z.array(z.string().min(1)).min(1),
		hostVersions: z.array(z.string().min(1)).min(1),
		samples: z.number().int().positive().max(10_000),
	}),
	evaluationIdentity: z.object({
		extensionCommit: z.string().min(1),
		workingTreeDigest: digest,
		extensionBuildDigest: digest,
		harnessDigest: digest,
		configDigest: digest,
		taskSetDigest: digest,
		sourceComponentsDigest: digest,
		unchanged: z.literal(true),
		missing: z.array(z.string()).length(0),
	}),
	attempts: z
		.array(
			z.object({
				request: z.object({
					campaignId: z.string().min(1),
					provider: providerSchema,
					scenarioId: z.string().min(1),
					sample: z.number().int().nonnegative(),
					phase: z.string(),
					host: z.object({ version: z.string().min(1) }),
				}),
				result: z.object({
					retentionFailed: z.literal(false).optional(),
					status: z.enum(["passed", "failed", "blocked"]),
					actualHostVersion: z.string().optional(),
					model: z.object({ id: z.string(), effort: z.string().optional() }).optional(),
					failure: z
						.object({
							class: z.enum([
								"provider",
								"tool",
								"persistence",
								"lifecycle",
								"assertion",
								"authentication",
								"usage_limit",
								"unsafe_repair",
								"infrastructure",
							]),
						})
						.optional(),
					usage: z.object({ cost: usage, inputTokens: usage, outputTokens: usage }),
				}),
				elapsedMs: z.number().finite().nonnegative(),
				evidence: z.string().min(1),
				evidenceFailed: z.literal(false).optional(),
			}),
		)
		.min(1),
	repairs: z.array(z.unknown()).length(0),
})

/** Adapts the existing host runner's owned build receipts; never launches another runtime. */
export function exportHostCampaign(value: unknown, options: { timeWindow: string }) {
	if (!options.timeWindow.trim()) throw new Error("A predeclared pair time window is required")
	const campaign = hostCampaignSchema.parse(value)
	const identity = campaign.evaluationIdentity
	const source = identity.sourceComponentsDigest
	if (campaign.attempts.some(({ result }) => result.status === "passed" && result.failure))
		throw new Error("Campaign result contradicts its failure classification")
	if (campaign.attempts.some(({ result }) => result.status !== "passed" && !result.failure))
		throw new Error("Campaign result is missing its failure classification")
	const samples = campaign.attempts.filter(({ request }) => request.phase === "sample")
	if (!samples.length) throw new Error("Campaign contains no sample attempts")
	const provider = campaign.requestedProvider
	const plan = campaign.evaluationPlan
	if (
		new Set(plan.scenarioIds).size !== plan.scenarioIds.length ||
		new Set(plan.hostVersions).size !== plan.hostVersions.length ||
		plan.scenarioIds.length * plan.hostVersions.length * plan.samples > 100_000
	)
		throw new Error("Campaign sample plan contains duplicate entries or exceeds the reporting bound")
	const cellKey = (scenario: string, host: string, sample: number) => JSON.stringify([scenario, host, sample])
	const expected = new Set(
		campaign.evaluationPlan.scenarioIds.flatMap((scenario) =>
			campaign.evaluationPlan.hostVersions.flatMap((host) =>
				Array.from({ length: campaign.evaluationPlan.samples }, (_, index) =>
					cellKey(scenario, host, index + 1),
				),
			),
		),
	)
	if (expected.size !== samples.length) throw new Error("Campaign sample matrix is incomplete or contains duplicates")
	for (const { request, result } of samples) {
		if (!expected.delete(cellKey(request.scenarioId, request.host.version, request.sample)))
			throw new Error("Campaign sample is outside expected matrix or duplicated")
		if (request.campaignId !== campaign.id || canonicalJson(request.provider) !== canonicalJson(provider))
			throw new Error("Campaign sample request provenance mismatch")
		if (result.actualHostVersion !== request.host.version)
			throw new Error("Campaign actual host version is missing or mismatched")
		if (
			provider.mode === "live-copilot" &&
			(!provider.modelId || result.model?.id !== provider.modelId || result.model?.effort !== provider.effort)
		)
			throw new Error("Campaign actual model or effort is missing or mismatched")
	}
	const hosts = [...new Set(samples.map(({ result }) => result.actualHostVersion))].sort()
	const config = identity.configDigest
	const variant = experimentVariantSchema.parse({
		schemaVersion: 1,
		id: "host-campaign",
		extensionCommit: identity.extensionCommit,
		workingTreeDigest: identity.workingTreeDigest,
		extensionBuildDigest: identity.extensionBuildDigest,
		model: provider.mode === "scripted" ? "scripted" : provider.modelId,
		modelSettingsDigest: sha256(canonicalJson(provider)),
		promptDigest: source,
		toolSchemaDigest: source,
		toolImplementationDigest: source,
		skillBundleDigest: source,
		policyDigest: source,
		compactionDigest: source,
		runnerImageDigest: sha256(canonicalJson({ harnessDigest: identity.harnessDigest, hosts })),
		resourceProfileDigest: config,
		permissionDigest: config,
		networkMode: "host-campaign-config",
		retryPolicyDigest: config,
	})
	const taskId = (scenario: string, host: string) => `${scenario}:vscode-${host}`
	const taskIds = [...new Set(samples.map(({ request }) => taskId(request.scenarioId, request.host.version)))].sort()
	const taskSet = {
		schemaVersion: 1 as const,
		id: "host-scenarios",
		version: 1,
		tasks: taskIds.map((id) => ({
			id,
			version: 1,
			digest: sha256(canonicalJson({ id, taskSetDigest: identity.taskSetDigest })),
		})),
	}
	const observations = samples.map(({ request, result, elapsedMs }): TrialObservation => {
		const status =
			result.status === "passed"
				? "passed"
				: result.failure?.class === "infrastructure" ||
					  result.failure?.class === "authentication" ||
					  result.failure?.class === "usage_limit"
					? "infrastructure_error"
					: result.failure?.class === "unsafe_repair"
						? "safety_failed"
						: result.status === "blocked"
							? "human_handoff"
							: "outcome_failed"
		return {
			taskId: taskId(request.scenarioId, request.host.version),
			taskVersion: 1,
			// This is a pairing block label, not a claim of deterministic provider sampling.
			seed: 0,
			repetition: request.sample,
			timeWindow: options.timeWindow,
			resourceProfileDigest: config,
			permissionDigest: config,
			networkMode: variant.networkMode,
			retryPolicyDigest: config,
			variantIdentity: immutableIdentity(variant),
			status,
			firstAttemptStatus: status,
			retryAssisted: false,
			cost: result.usage.cost,
			tokens:
				result.usage.inputTokens === null || result.usage.outputTokens === null
					? null
					: result.usage.inputTokens + result.usage.outputTokens,
			latencyMs: elapsedMs,
			capabilities: ["host-contract"],
			risk: "high",
			family: "host-scenarios",
			difficulty: "foundation",
			repository: "alpha-code",
		}
	})
	return sealCampaignExport({
		schemaVersion: 1,
		runId: campaign.id,
		executionFidelity: "actual-host",
		decisionSource: provider.mode === "scripted" ? "scripted" : "live",
		identityScope: "conservative-whole-source",
		accounting: {
			totalAttempts: campaign.attempts.length,
			scoredSamples: samples.length,
			diagnosticAttempts: campaign.attempts.length - samples.length,
			totalCost: campaign.attempts.some(({ result }) => result.usage.cost === null)
				? null
				: campaign.attempts.reduce((sum, { result }) => sum + (result.usage.cost ?? 0), 0),
		},
		variant,
		taskSet,
		observations,
		incomplete: [],
	})
}
