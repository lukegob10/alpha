import path from "path"
import crypto from "crypto"

import { digestValue } from "./StepContext"

export type InternalAgentKind = "general" | "explore" | "review" | "worker"
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
	worker: { expectedOutput: ["summary", "changed files", "verification", "remaining risks"] },
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
	/** Parent scope ceiling. Omitted only for legacy root callers whose requested roots are already authoritative. */
	parentWorkspaceRoots?: string[]
	allowedPaths?: string[]
	/** Optional narrower parent write scope used by nested-ready authority checks. */
	parentAllowedPaths?: string[]
	/** Entries in parentAllowedPaths that name exact files rather than directories. */
	parentFileAllowedPaths?: string[]
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

const ROLE_POLICY_CEILINGS: Record<InternalAgentKind, Pick<InternalTaskPolicy, (typeof AUTHORITY_KEYS)[number]>> = {
	general: {
		read: true,
		execute: true,
		mutate: true,
		delegate: true,
		network: true,
		externalSideEffects: true,
	},
	explore: {
		read: true,
		execute: false,
		mutate: false,
		delegate: false,
		network: false,
		externalSideEffects: false,
	},
	review: {
		read: true,
		execute: false,
		mutate: false,
		delegate: false,
		network: false,
		externalSideEffects: false,
	},
	worker: {
		read: true,
		execute: true,
		mutate: true,
		delegate: false,
		network: false,
		externalSideEffects: false,
	},
}

const isWithin = (root: string, candidate: string): boolean => {
	const relative = path.relative(path.resolve(root), path.resolve(candidate))
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function validateScope(
	roots: string[],
	allowedPaths: string[] | undefined,
	parentRoots: string[],
	parentAllowedPaths?: string[],
	parentFileAllowedPaths?: string[],
): void {
	if (roots.length === 0) throw new Error("Internal task scope requires at least one workspace root")
	if (parentRoots.length === 0) throw new Error("Parent task scope requires at least one workspace root")
	for (const root of roots) {
		if (!parentRoots.some((parentRoot) => isWithin(parentRoot, root))) {
			throw new Error(`Internal task workspace root widens parent scope: ${root}`)
		}
	}
	const resolvedParentAllowed = parentAllowedPaths?.map((candidate) =>
		path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(parentRoots[0], candidate),
	)
	const resolvedParentFiles = new Set(
		(parentFileAllowedPaths ?? []).map((candidate) =>
			path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(parentRoots[0], candidate),
		),
	)
	for (const candidate of allowedPaths ?? []) {
		const resolved = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(roots[0], candidate)
		if (!roots.some((root) => isWithin(root, resolved)))
			throw new Error(`Internal task path is outside parent scope: ${candidate}`)
		if (
			resolvedParentAllowed &&
			!resolvedParentAllowed.some((parentPath) =>
				resolvedParentFiles.has(parentPath) ? resolved === parentPath : isWithin(parentPath, resolved),
			)
		) {
			throw new Error(`Internal task path widens parent write scope: ${candidate}`)
		}
	}
}

export function resolveInternalTaskPolicy(
	parent: InternalTaskPolicy,
	requested: Partial<InternalTaskPolicy>,
	agentKind: InternalAgentKind,
): InternalTaskPolicy {
	const roleCeiling = ROLE_POLICY_CEILINGS[agentKind]
	for (const key of AUTHORITY_KEYS) {
		if (requested[key] === true && !parent[key])
			throw new Error(`Internal task cannot widen parent authority: ${key}`)
		if (requested[key] === true && !roleCeiling[key])
			throw new Error(`${agentKind} role cannot receive authority: ${key}`)
	}
	const requestedPolicy = { ...parent, ...requested }
	return {
		read: parent.read && requestedPolicy.read && roleCeiling.read,
		execute: parent.execute && requestedPolicy.execute && roleCeiling.execute,
		mutate: parent.mutate && requestedPolicy.mutate && roleCeiling.mutate,
		delegate: parent.delegate && requestedPolicy.delegate && roleCeiling.delegate,
		network: parent.network && requestedPolicy.network && roleCeiling.network,
		externalSideEffects:
			parent.externalSideEffects && requestedPolicy.externalSideEffects && roleCeiling.externalSideEffects,
		requireApproval: parent.requireApproval || requested.requireApproval === true,
	}
}

export function buildInternalTaskEnvelope(input: BuildInternalTaskEnvelopeInput): InternalTaskEnvelope {
	if (!input.objective.trim()) throw new Error("Internal task objective is required")
	if (input.agentKind && !(input.agentKind in internalAgentDefinitions))
		throw new Error(`Unknown agent kind: ${input.agentKind}`)
	const agentKind = (input.agentKind ?? "general") as InternalAgentKind
	const routeId = (input.modelRouteId ?? "balanced") as ModelRouteId
	if (!(routeId in modelRoutes)) throw new Error(`Unknown model route: ${input.modelRouteId}`)
	validateScope(
		input.workspaceRoots,
		input.allowedPaths,
		input.parentWorkspaceRoots ?? input.workspaceRoots,
		input.parentAllowedPaths,
		input.parentFileAllowedPaths,
	)

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
			(input.agentKind ? [...internalAgentDefinitions[agentKind].expectedOutput] : ["summary", "evidence"]),
		scope: {
			workspaceRoots: [...new Set(input.workspaceRoots.map((root) => path.resolve(root)))].sort(),
			allowedPaths: input.allowedPaths
				?.map((item) =>
					path.isAbsolute(item) ? path.resolve(item) : path.resolve(input.workspaceRoots[0], item),
				)
				.sort(),
			sharedWorkspace: input.sharedWorkspace ?? true,
			contextRefs: [...new Set(input.contextRefs ?? [])].sort(),
		},
		policy: resolveInternalTaskPolicy(input.parentPolicy, input.requestedPolicy, agentKind),
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

export function isValidInternalTaskEnvelope(envelope: InternalTaskEnvelope): boolean {
	const { digest, ...contents } = envelope
	return digest === digestValue(contents)
}
