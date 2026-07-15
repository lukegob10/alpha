import type OpenAI from "openai"

import { digestValue } from "./StepContext"
import { createToolPolicySnapshot, type ToolPolicySnapshot } from "./ToolPolicy"

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
	return profiles[mode === "architect" || mode === "plan" ? "plan" : "work"]
}

export function executionProfileDigest(profile: UserExecutionProfile): string {
	return digestValue(profile)
}

export function applyExecutionProfile(
	profile: UserExecutionProfile,
	policy: ToolPolicySnapshot,
	schemas: OpenAI.Chat.ChatCompletionTool[],
): { policy: ToolPolicySnapshot; schemas: OpenAI.Chat.ChatCompletionTool[]; allowedFunctionNames: string[] } {
	const profileAllows = (name: string) => {
		if (profile.id === "work") return true
		const capability = policy.capabilities[name]
		return (
			name !== "execute_command" &&
			name !== "new_task" &&
			capability?.sideEffects === "none" &&
			!capability.controlFlow
		)
	}
	const allowedFunctionNames = policy.allowedTools.filter(profileAllows)
	const allowed = new Set(allowedFunctionNames)
	const visibleTools = policy.visibleTools.filter((name) => allowed.has(name))
	const filteredSchemas = schemas.filter((schema) => schema.type !== "function" || allowed.has(schema.function.name))
	const nextPolicy = createToolPolicySnapshot({
		visibleTools,
		allowedTools: allowedFunctionNames,
		disabledTools: policy.disabledTools,
		autoApprovalEnabled: policy.approval.autoApprovalEnabled,
		capabilities: Object.fromEntries(Object.entries(policy.capabilities).filter(([name]) => allowed.has(name))),
		outputLimits: policy.outputLimits,
		execution: policy.execution,
		digest: digestValue({
			profile: executionProfileDigest(profile),
			parentPolicy: policy.digest,
			allowedFunctionNames,
		}),
	})
	return { policy: nextPolicy, schemas: filteredSchemas, allowedFunctionNames }
}
