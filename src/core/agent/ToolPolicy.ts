import type { ToolConcurrency, ToolSideEffects } from "../tools/ToolRegistry"
import { canonicalizeToolName } from "../tools/ToolRegistry"
import path from "path"

import { digestValue } from "./StepContext"

export const DEFAULT_TOOL_OUTPUT_LIMIT = 32_000

export interface ToolPolicyCapability {
	concurrency: ToolConcurrency
	sideEffects: ToolSideEffects
	controlFlow: boolean
	requiresApproval: boolean
}

export type ToolSandboxMode = "workspace-write"

export interface ToolCommandPolicy {
	allowedPrefixes: readonly string[]
	deniedPrefixes: readonly string[]
	/** User-configured timeout in milliseconds; zero means no user timeout. */
	userTimeoutMs: number
	/** Commands matching these prefixes are exempt from the user timeout. */
	timeoutAllowlist: readonly string[]
}

export interface ToolExecutionPolicy {
	sandboxMode: ToolSandboxMode
	workspaceRoots: readonly string[]
	command: ToolCommandPolicy
	cancellation: "abort-process"
}

export interface ToolPolicySnapshot {
	visibleTools: readonly string[]
	allowedTools: readonly string[]
	disabledTools: readonly string[]
	approval: {
		autoApprovalEnabled: boolean
		liveRevalidation: boolean
	}
	capabilities: Readonly<Record<string, ToolPolicyCapability>>
	outputLimits: Readonly<Record<string, number>>
	execution: ToolExecutionPolicy
	/** Short, sanitized description safe to include in model instructions. */
	summary: string
	/** Digest of the normalized policy. This is always computed locally. */
	digest: string
}

export interface ToolPolicyInput {
	visibleTools: readonly string[]
	allowedTools?: readonly string[]
	disabledTools?: readonly string[]
	autoApprovalEnabled?: boolean
	capabilities?: Readonly<Record<string, ToolPolicyCapability>>
	outputLimits?: Readonly<Record<string, number>>
	execution?: {
		sandboxMode?: ToolSandboxMode
		workspaceRoots?: readonly string[]
		command?: Partial<ToolCommandPolicy>
		cancellation?: "abort-process"
	}
	/**
	 * Legacy compatibility field. It is deliberately ignored; callers cannot
	 * choose the identity of a policy snapshot.
	 */
	digest?: string
}

/** Compute a policy digest from normalized snapshot content. */
export function computeToolPolicyDigest(policy: Omit<ToolPolicySnapshot, "digest">): string {
	return digestValue(policy)
}

function uniqueNames(names: readonly string[]): string[] {
	return [...new Set(names.map((name) => canonicalizeToolName(name)))].sort()
}

function canonicalizeRecord<T>(record: Readonly<Record<string, T>> | undefined): Record<string, T> {
	const result: Record<string, T> = {}
	for (const [name, value] of Object.entries(record ?? {})) {
		result[canonicalizeToolName(name)] = value
	}
	return result
}

export function createToolPolicySnapshot(input: ToolPolicyInput): ToolPolicySnapshot {
	const visibleTools = uniqueNames(input.visibleTools)
	const disabledTools = uniqueNames(input.disabledTools ?? [])
	const disabled = new Set(disabledTools)
	const visible = new Set(visibleTools)
	const allowedTools = uniqueNames(input.allowedTools ?? visibleTools).filter(
		(name) => visible.has(name) && !disabled.has(name),
	)
	const capabilities = canonicalizeRecord(input.capabilities)
	const outputLimits = Object.fromEntries(
		Object.entries(canonicalizeRecord(input.outputLimits)).map(([name, limit]) => [
			name,
			Math.max(1, Math.floor(limit)),
		]),
	)
	const executionInput = input.execution ?? {}
	const commandInput = executionInput.command ?? {}
	const execution: ToolExecutionPolicy = {
		sandboxMode: "workspace-write",
		workspaceRoots: uniqueNames(executionInput.workspaceRoots ?? []),
		command: {
			allowedPrefixes: uniqueNames(commandInput.allowedPrefixes ?? []),
			deniedPrefixes: uniqueNames(commandInput.deniedPrefixes ?? []),
			userTimeoutMs: Math.max(0, Math.floor(commandInput.userTimeoutMs ?? 0)),
			timeoutAllowlist: uniqueNames(commandInput.timeoutAllowlist ?? []),
		},
		cancellation: "abort-process",
	}
	const summary = formatToolPolicySummary(execution, input.autoApprovalEnabled === true, outputLimits)
	const normalized = {
		visibleTools: Object.freeze(visibleTools),
		allowedTools: Object.freeze(allowedTools),
		disabledTools: Object.freeze(disabledTools),
		approval: Object.freeze({
			autoApprovalEnabled: input.autoApprovalEnabled === true,
			liveRevalidation: true,
		}),
		capabilities: Object.freeze(
			Object.fromEntries(
				Object.entries(capabilities).map(([name, capability]) => [name, Object.freeze({ ...capability })]),
			),
		),
		outputLimits: Object.freeze(outputLimits),
		execution: Object.freeze({
			...execution,
			workspaceRoots: Object.freeze([...execution.workspaceRoots]),
			command: Object.freeze({
				...execution.command,
				allowedPrefixes: Object.freeze([...execution.command.allowedPrefixes]),
				deniedPrefixes: Object.freeze([...execution.command.deniedPrefixes]),
				timeoutAllowlist: Object.freeze([...execution.command.timeoutAllowlist]),
			}),
		}),
		summary,
	}

	// Never use input.digest here. Older callers still pass it, but the
	// normalized snapshot is the sole source of truth for policy identity.
	return Object.freeze({
		...normalized,
		digest: computeToolPolicyDigest(normalized),
	})
}

export function isToolAllowed(policy: ToolPolicySnapshot | undefined, name: string): boolean {
	if (!policy) {
		return true
	}

	const canonical = canonicalizeToolName(name)
	const names = canonical === name ? [canonical] : [canonical, name]
	return (
		names.some((candidate) => policy.visibleTools.includes(candidate)) &&
		names.some((candidate) => policy.allowedTools.includes(candidate)) &&
		!names.some((candidate) => policy.disabledTools.includes(candidate))
	)
}

export function getToolOutputLimit(policy: ToolPolicySnapshot | undefined, name: string): number {
	if (!policy) return DEFAULT_TOOL_OUTPUT_LIMIT
	const canonical = canonicalizeToolName(name)
	return policy.outputLimits[canonical] ?? policy.outputLimits[name] ?? DEFAULT_TOOL_OUTPUT_LIMIT
}

export function isPathAllowed(policy: ToolPolicySnapshot | undefined, candidate: string, cwd?: string): boolean {
	const roots = policy?.execution.workspaceRoots ?? []
	if (roots.length === 0) return true

	const resolvedCandidate = path.resolve(cwd ?? roots[0], candidate)
	return roots.some((root) => {
		const resolvedRoot = path.resolve(root)
		const relative = path.relative(resolvedRoot, resolvedCandidate)
		return (
			relative === "" ||
			(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
		)
	})
}

export function resolveCommandTimeoutMs(
	policy: ToolPolicySnapshot | undefined,
	requestedTimeoutMs: number,
	command: string,
): number {
	const userTimeoutMs = policy?.execution.command.userTimeoutMs ?? 0
	const allowlisted = (policy?.execution.command.timeoutAllowlist ?? []).some((prefix) =>
		command.trim().startsWith(prefix.trim()),
	)
	const configuredTimeouts = [requestedTimeoutMs, allowlisted ? 0 : userTimeoutMs].filter((value) => value > 0)
	return configuredTimeouts.length > 0 ? Math.min(...configuredTimeouts) : 0
}

export function isCommandDeniedByPolicy(policy: ToolPolicySnapshot | undefined, command: string): boolean {
	const denied = policy?.execution.command.deniedPrefixes ?? []
	const allowed = policy?.execution.command.allowedPrefixes ?? []
	if (denied.length === 0) return false

	const normalized = command.trim().toLowerCase()
	const longest = (prefixes: readonly string[]) =>
		prefixes
			.map((prefix) => prefix.trim().toLowerCase())
			.filter((prefix) => prefix === "*" || normalized.startsWith(prefix))
			.sort((left, right) => right.length - left.length)[0]

	const deniedMatch = longest(denied)
	const allowedMatch = longest(allowed)
	return Boolean(deniedMatch && (!allowedMatch || deniedMatch.length >= allowedMatch.length))
}

function formatToolPolicySummary(
	execution: ToolExecutionPolicy,
	autoApprovalEnabled: boolean,
	outputLimits: Readonly<Record<string, number>>,
): string {
	const timeout = execution.command.userTimeoutMs > 0 ? `${execution.command.userTimeoutMs}ms` : "none"
	const outputLimit = Math.max(0, ...Object.values(outputLimits)) || DEFAULT_TOOL_OUTPUT_LIMIT
	return [
		`Sandbox: ${execution.sandboxMode}`,
		`Workspace roots: ${execution.workspaceRoots.join(", ") || "task workspace"}`,
		`Command approval: ${autoApprovalEnabled ? "auto-approval may apply; policy is revalidated" : "approval required"}`,
		`Command timeout: ${timeout}`,
		`Tool output limit: ${outputLimit} characters; large command output may be available as an artifact`,
		"Cancellation: aborts active tool processes",
	].join("\n")
}
