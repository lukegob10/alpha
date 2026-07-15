import path from "path"
import crypto from "crypto"

import { digestValue } from "./StepContext"

export type InternalAgentKind = "general" | "explore" | "review"
export type ModelRouteId = "fast" | "balanced" | "deep" | "user-configured"

export interface InternalTaskPolicy {
	read: boolean
	execute: boolean
	mutate: boolean
	delegate: boolean
	network: boolean
	externalSideEffects: boolean
	requireApproval: boolean
}

export interface InternalTaskEnvelope {
	id: string
	parentTaskId: string
	objective: string
	agentKind?: InternalAgentKind
	expectedOutput: string[]
	scope: { workspaceRoots: string[]; allowedPaths?: string[]; sharedWorkspace: boolean; contextRefs: string[] }
	policy: InternalTaskPolicy
	skills: Array<{ id: string; digest: string }>
	modelRoute: { id: ModelRouteId; provider?: string; model?: string; reasoning?: string }
	budget: {
		maxDepth: number
		maxConcurrency: number
		maxInputTokens: number
		maxOutputTokens: number
		timeoutMs: number
	}
	dependencies: string[]
	digest: string
}

export interface ResolvedSkill {
	id: string
	content: string
	digest?: string
}

export const internalAgentDefinitions = Object.freeze({
	general: { expectedOutput: ["summary", "evidence", "remaining risks"] },
	explore: { expectedOutput: ["findings", "file references", "open questions"] },
	review: { expectedOutput: ["findings by severity", "validation evidence", "remaining risks"] },
} satisfies Record<InternalAgentKind, { expectedOutput: string[] }>)

export const modelRoutes = Object.freeze({
	fast: { id: "fast", reasoning: "low" },
	balanced: { id: "balanced", reasoning: "medium" },
	deep: { id: "deep", reasoning: "high" },
	"user-configured": { id: "user-configured" },
} satisfies Record<ModelRouteId, { id: ModelRouteId; reasoning?: string }>)

export interface BuildInternalTaskEnvelopeInput {
	parentTaskId: string
	objective: string
	agentKind?: string
	expectedOutput?: string[]
	parentPolicy: InternalTaskPolicy
	requestedPolicy: Partial<InternalTaskPolicy>
	workspaceRoots: string[]
	allowedPaths?: string[]
	sharedWorkspace?: boolean
	contextRefs?: string[]
	skillIds?: string[]
	availableSkills?: ResolvedSkill[]
	modelRouteId?: string
	modelOverride?: { provider?: string; model?: string; reasoning?: string }
	budget?: Partial<InternalTaskEnvelope["budget"]>
	dependencies?: string[]
	id?: string
}

const AUTHORITY_KEYS = ["read", "execute", "mutate", "delegate", "network", "externalSideEffects"] as const

function validateScope(roots: string[], allowedPaths: string[] | undefined): void {
	if (roots.length === 0) throw new Error("Internal task scope requires at least one workspace root")
	for (const candidate of allowedPaths ?? []) {
		const resolved = path.resolve(candidate)
		if (
			!roots.some((root) => {
				const relative = path.relative(path.resolve(root), resolved)
				return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
			})
		)
			throw new Error(`Internal task path is outside parent scope: ${candidate}`)
	}
}

function resolvePolicy(parent: InternalTaskPolicy, requested: Partial<InternalTaskPolicy>): InternalTaskPolicy {
	for (const key of AUTHORITY_KEYS) {
		if (requested[key] === true && !parent[key])
			throw new Error(`Internal task cannot widen parent authority: ${key}`)
	}
	return {
		...parent,
		...requested,
		requireApproval: parent.requireApproval || requested.requireApproval === true,
	}
}

export function buildInternalTaskEnvelope(input: BuildInternalTaskEnvelopeInput): InternalTaskEnvelope {
	if (!input.objective.trim()) throw new Error("Internal task objective is required")
	if (input.agentKind && !(input.agentKind in internalAgentDefinitions))
		throw new Error(`Unknown agent kind: ${input.agentKind}`)
	const agentKind = input.agentKind as InternalAgentKind | undefined
	const routeId = (input.modelRouteId ?? "balanced") as ModelRouteId
	if (!(routeId in modelRoutes)) throw new Error(`Unknown model route: ${input.modelRouteId}`)
	validateScope(input.workspaceRoots, input.allowedPaths)

	const available = new Map((input.availableSkills ?? []).map((skill) => [skill.id, skill]))
	const skills = (input.skillIds ?? []).map((id) => {
		const skill = available.get(id)
		if (!skill) throw new Error(`Unknown skill: ${id}`)
		return { id, digest: skill.digest ?? digestValue(skill.content) }
	})
	const defaults = {
		maxDepth: 0,
		maxConcurrency: 1,
		maxInputTokens: 16_000,
		maxOutputTokens: 4_000,
		timeoutMs: 120_000,
	}
	const budget = { ...defaults, ...input.budget }
	if (Object.values(budget).some((value) => !Number.isFinite(value) || value < 0))
		throw new Error("Invalid internal task budget")
	const route = { ...modelRoutes[routeId], ...input.modelOverride, id: routeId }
	const withoutDigest = {
		id: input.id ?? crypto.randomUUID(),
		parentTaskId: input.parentTaskId,
		objective: input.objective.trim(),
		agentKind,
		expectedOutput:
			input.expectedOutput ??
			(agentKind ? [...internalAgentDefinitions[agentKind].expectedOutput] : ["summary", "evidence"]),
		scope: {
			workspaceRoots: [...new Set(input.workspaceRoots.map((root) => path.resolve(root)))].sort(),
			allowedPaths: input.allowedPaths?.map((item) => path.resolve(item)).sort(),
			sharedWorkspace: input.sharedWorkspace ?? true,
			contextRefs: [...new Set(input.contextRefs ?? [])].sort(),
		},
		policy: resolvePolicy(input.parentPolicy, input.requestedPolicy),
		skills,
		modelRoute: route,
		budget,
		dependencies: [...new Set(input.dependencies ?? [])].sort(),
	}
	return Object.freeze({ ...withoutDigest, digest: digestValue(withoutDigest) })
}

const SECRET_PATTERN = /(api.?key|secret|password|authorization|token)/i
export function serializeInternalTaskEnvelope(envelope: InternalTaskEnvelope): string {
	return JSON.stringify(envelope, (key, value) => (SECRET_PATTERN.test(key) ? "[redacted]" : value))
}
