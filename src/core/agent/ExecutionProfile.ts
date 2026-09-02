import type OpenAI from "openai"

import { digestValue } from "./StepContext"
import { createToolPolicySnapshot, type ToolPolicySnapshot } from "./ToolPolicy"
import { canonicalizeToolName, ToolRegistry } from "../tools/ToolRegistry"

export type UserExecutionProfileId = "work" | "plan"

export interface UserExecutionProfile {
	id: UserExecutionProfileId
	displayName: string
	promptFragmentId: string
	policyTemplateId: string
	defaultModelRouteId?: string
}

const profiles = {
	work: {
		id: "work",
		displayName: "Work",
		promptFragmentId: "work",
		policyTemplateId: "work-full",
		defaultModelRouteId: "balanced",
	},
	plan: {
		id: "plan",
		displayName: "Plan",
		promptFragmentId: "plan",
		policyTemplateId: "plan-inspect-only",
		defaultModelRouteId: "balanced",
	},
} as const satisfies Record<UserExecutionProfileId, UserExecutionProfile>

export const userExecutionProfiles: Readonly<Record<UserExecutionProfileId, UserExecutionProfile>> =
	Object.freeze(profiles)

export function resolveExecutionProfile(mode: string): UserExecutionProfile {
	const normalizedMode = mode.trim().toLowerCase()
	return profiles[normalizedMode === "architect" || normalizedMode === "plan" ? "plan" : "work"]
}

export function executionProfileDigest(profile: UserExecutionProfile): string {
	return digestValue(profile)
}

export interface ExecutionProfileApplicationOptions {
	/** Restrict the result to descriptors present in this registry. */
	registry?: ToolRegistry
	/** Keep all provider schemas while restricting callable names (Gemini/Vertex). */
	includeAllToolsWithRestrictions?: boolean
}

export interface ExecutionProfileApplication {
	policy: ToolPolicySnapshot
	/** Schemas visible to the model after profile filtering. */
	schemas: OpenAI.Chat.ChatCompletionTool[]
	/** Canonical names accepted by the execution policy. */
	allowedFunctionNames: string[]
}

function schemaName(schema: OpenAI.Chat.ChatCompletionTool): string | undefined {
	return schema.type === "function" ? canonicalizeToolName(schema.function.name) : undefined
}

function canonicalSchema(schema: OpenAI.Chat.ChatCompletionTool): OpenAI.Chat.ChatCompletionTool {
	if (schema.type !== "function") return schema
	const name = canonicalizeToolName(schema.function.name)
	return name === schema.function.name ? schema : { ...schema, function: { ...schema.function, name } }
}

function isToolRegistry(
	value: OpenAI.Chat.ChatCompletionTool[] | readonly OpenAI.Chat.ChatCompletionTool[] | ToolRegistry,
): value is ToolRegistry {
	return value instanceof ToolRegistry
}

export function applyExecutionProfile(
	profile: UserExecutionProfile,
	policy: ToolPolicySnapshot,
	schemasOrRegistry: OpenAI.Chat.ChatCompletionTool[] | readonly OpenAI.Chat.ChatCompletionTool[] | ToolRegistry,
	options: ExecutionProfileApplicationOptions = {},
): ExecutionProfileApplication {
	const registryInput = isToolRegistry(schemasOrRegistry) ? schemasOrRegistry : undefined
	const schemas = registryInput
		? registryInput.getSchemas()
		: [...(schemasOrRegistry as readonly OpenAI.Chat.ChatCompletionTool[])]
	const registry = registryInput ?? options.registry
	const profileAllows = (name: string) => {
		const canonical = canonicalizeToolName(name)
		if (profile.id === "work") return true
		const capability = policy.capabilities[canonical]
		return (
			canonical !== "execute_command" &&
			canonical !== "new_task" &&
			capability?.sideEffects === "none" &&
			!capability.controlFlow
		)
	}
	const registryNames = registry ? new Set(registry.list().map((descriptor) => descriptor.name)) : undefined
	const allowedFunctionNames = policy.allowedTools.filter(
		(name) => profileAllows(name) && (!registryNames || registryNames.has(canonicalizeToolName(name))),
	)
	const allowed = new Set(allowedFunctionNames)
	const visibleTools = policy.visibleTools.filter((name) => allowed.has(name))
	const filteredSchemas = schemas.map(canonicalSchema).filter((schema) => {
		const name = schemaName(schema)
		if (!name) return true
		return allowed.has(name) && (!registryNames || registryNames.has(name))
	})
	const nextPolicy = createToolPolicySnapshot({
		visibleTools: options.includeAllToolsWithRestrictions ? policy.visibleTools : visibleTools,
		allowedTools: allowedFunctionNames,
		disabledTools: policy.disabledTools,
		autoApprovalEnabled: policy.approval.autoApprovalEnabled,
		capabilities: Object.fromEntries(
			Object.entries(policy.capabilities).filter(([name]) => allowed.has(canonicalizeToolName(name))),
		),
		outputLimits: policy.outputLimits,
		execution: policy.execution,
		// Kept as a compatibility argument for older call sites; policy creation
		// computes its own digest and intentionally ignores this value.
		digest: digestValue({
			profile: executionProfileDigest(profile),
			parentPolicy: policy.digest,
			allowedFunctionNames,
		}),
	})

	if (options.includeAllToolsWithRestrictions) {
		// The provider-facing superset is intentionally retained for history
		// compatibility. Only allowedFunctionNames and the policy govern calls.
		return { policy: nextPolicy, schemas: schemas.map(canonicalSchema), allowedFunctionNames }
	}

	return { policy: nextPolicy, schemas: filteredSchemas, allowedFunctionNames }
}
