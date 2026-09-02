import type OpenAI from "openai"

import { digestValue } from "../agent/StepContext"
import {
	applyExecutionProfile,
	executionProfileDigest,
	resolveExecutionProfile,
	type UserExecutionProfile,
	type UserExecutionProfileId,
} from "../agent/ExecutionProfile"
import { canonicalizeToolName, ToolRegistry, type ToolCapabilities, type ToolDescriptor } from "./ToolRegistry"
import {
	createToolPolicySnapshot,
	isToolAllowed,
	type ToolPolicyInput,
	type ToolPolicySnapshot,
	type ToolExecutionPolicy,
} from "../agent/ToolPolicy"

export type TaskToolSchema = OpenAI.Chat.ChatCompletionTool

/**
 * All inputs used to capture one model/tool boundary. The registry and
 * provider schema catalog are captured together so a later request cannot
 * accidentally combine a new schema list with an old executable map.
 */
export interface TaskToolSurfaceInput {
	/** Existing executable registry. If omitted, one is built from `schemas`. */
	registry?: ToolRegistry
	/** Provider-facing schemas captured for this step. */
	schemas?: readonly TaskToolSchema[]
	/** Alias accepted for integrations that call these tool definitions “tools”. */
	tools?: readonly TaskToolSchema[]
	/** Alias used by provider adapters for the same schema catalog. */
	providerSchemas?: readonly TaskToolSchema[]
	/** Names visible to the current task before profile restrictions are applied. */
	visibleToolNames?: readonly string[]
	/** Compatibility alias for `visibleToolNames`. */
	visibleTools?: readonly string[]
	/** Names callable by the current task before profile restrictions are applied. */
	allowedToolNames?: readonly string[]
	/** Compatibility alias for `allowedToolNames`. */
	allowedFunctionNames?: readonly string[]
	/** Explicit deny list. Aliases are canonicalized before policy construction. */
	disabledTools?: readonly string[]
	/** Compatibility alias for `disabledTools`. */
	disabledToolNames?: readonly string[]
	/** Existing policy snapshot or legacy input. Any supplied digest is ignored. */
	policy?: ToolPolicySnapshot | ToolPolicyInput
	profile?: UserExecutionProfile | UserExecutionProfileId | string
	/** Legacy mode used to resolve Work/Plan when `profile` is omitted. */
	mode?: string
	/** Preserve the provider superset while restricting callable names. */
	includeAllToolsWithRestrictions?: boolean
	/** The mode filter may already have applied legacy restrictions. */
	applyProfile?: boolean
	autoApprovalEnabled?: boolean
	capabilities?: Readonly<Record<string, ToolCapabilities>>
	outputLimits?: Readonly<Record<string, number>>
	execution?: ToolPolicyInput["execution"]
	cwd?: string
}

export interface TaskToolSurface {
	/** The sole executable descriptor registry for this captured surface. */
	readonly registry: ToolRegistry
	/** Schemas sent to the provider for this step. */
	readonly schemas: readonly TaskToolSchema[]
	/** Canonical names accepted by the policy. */
	readonly allowedFunctionNames: readonly string[]
	/** Immutable policy governing visibility and execution. */
	readonly policy: ToolPolicySnapshot
	/** Digest of the complete captured surface, computed locally. */
	readonly digest: string
	/** Resolved profile included for callers that need telemetry metadata. */
	readonly profile: UserExecutionProfile
	/** True when the provider receives a schema superset plus an allow-list. */
	readonly includeAllToolsWithRestrictions: boolean
	/** Policy-aware lookup that fails closed for hidden or disabled names. */
	readonly resolve: (name: string) => ToolDescriptor | undefined
	readonly isCallable: (name: string) => boolean
}

/** Backwards-friendly result/input names used by request-context builders. */
export type TaskToolSurfaceResult = TaskToolSurface
export type TaskToolSurfaceCaptureInput = TaskToolSurfaceInput

interface PolicySource {
	visibleTools: readonly string[]
	allowedTools: readonly string[]
	disabledTools: readonly string[]
	autoApprovalEnabled: boolean
	capabilities?: Readonly<Record<string, ToolCapabilities>>
	outputLimits?: Readonly<Record<string, number>>
	execution?: ToolPolicyInput["execution"] | ToolExecutionPolicy
}

function isPolicySnapshot(value: ToolPolicySnapshot | ToolPolicyInput): value is ToolPolicySnapshot {
	return "approval" in value && "summary" in value
}

function asPolicySource(policy: TaskToolSurfaceInput["policy"]): PolicySource | undefined {
	if (!policy) return undefined
	if (isPolicySnapshot(policy)) {
		return {
			visibleTools: policy.visibleTools,
			allowedTools: policy.allowedTools,
			disabledTools: policy.disabledTools,
			autoApprovalEnabled: policy.approval.autoApprovalEnabled,
			capabilities: policy.capabilities,
			outputLimits: policy.outputLimits,
			execution: policy.execution,
		}
	}
	return {
		visibleTools: policy.visibleTools,
		allowedTools: policy.allowedTools ?? policy.visibleTools,
		disabledTools: policy.disabledTools ?? [],
		autoApprovalEnabled: policy.autoApprovalEnabled === true,
		capabilities: policy.capabilities,
		outputLimits: policy.outputLimits,
		execution: policy.execution,
	}
}

function canonicalSchema(schema: TaskToolSchema): TaskToolSchema {
	if (schema.type !== "function") return freezeValue(structuredClone(schema))
	const name = canonicalizeToolName(schema.function.name)
	const normalized = name === schema.function.name ? schema : { ...schema, function: { ...schema.function, name } }
	return freezeValue(structuredClone(normalized))
}

function freezeValue<T>(value: T, seen = new WeakSet<object>()): T {
	if (!value || typeof value !== "object" || seen.has(value as object)) return value
	seen.add(value as object)
	for (const child of Object.values(value as Record<string, unknown>)) {
		freezeValue(child, seen)
	}
	return Object.freeze(value)
}

/**
 * Deduplicate provider definitions by canonical name and retain only schemas
 * that have one executable descriptor. Unknown functions remain unavailable;
 * keeping them in an allow-list would create a model/runtime split.
 */
function normalizeSchemas(
	schemas: readonly TaskToolSchema[],
	registry: ToolRegistry,
	includeAllToolsWithRestrictions: boolean,
	allowedNames?: ReadonlySet<string>,
): TaskToolSchema[] {
	const result: TaskToolSchema[] = []
	const seen = new Set<string>()
	for (const source of schemas) {
		const schema = canonicalSchema(source)
		if (schema.type !== "function") {
			result.push(schema)
			continue
		}

		const name = schema.function.name
		if (seen.has(name) || !registry.resolve(name)) continue
		if (!includeAllToolsWithRestrictions && allowedNames && !allowedNames.has(name)) continue
		seen.add(name)
		result.push(schema)
	}
	return result
}

function functionNames(schemas: readonly TaskToolSchema[]): string[] {
	return [
		...new Set(
			schemas
				.filter((schema): schema is OpenAI.Chat.ChatCompletionFunctionTool => schema.type === "function")
				.map((schema) => canonicalizeToolName(schema.function.name)),
		),
	].sort()
}

function descriptorCapabilities(
	registry: ToolRegistry,
	provided?: Readonly<Record<string, ToolCapabilities>>,
): Readonly<Record<string, ToolCapabilities>> {
	const result: Record<string, ToolCapabilities> = {}
	for (const descriptor of registry.list()) {
		// Registry metadata is authoritative. A provided map is only used for
		// descriptors that predate capability metadata in a compatibility caller.
		result[descriptor.name] = descriptor.capabilities ?? provided?.[descriptor.name]
	}
	return result
}

function descriptorOutputLimits(
	registry: ToolRegistry,
	provided?: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
	const result: Record<string, number> = {}
	for (const [name, limit] of Object.entries(provided ?? {})) {
		result[canonicalizeToolName(name)] = limit
	}
	for (const descriptor of registry.list()) {
		if (descriptor.maxOutputChars === undefined) continue
		const existing = result[descriptor.name]
		result[descriptor.name] =
			existing === undefined ? descriptor.maxOutputChars : Math.min(existing, descriptor.maxOutputChars)
	}
	return result
}

function fingerprintRegistry(registry: ToolRegistry): unknown {
	return registry
		.list()
		.map((descriptor) => ({
			name: descriptor.name,
			aliases: [...descriptor.aliases].sort(),
			schema: descriptor.schema,
			capabilities: descriptor.capabilities,
			maxOutputChars: descriptor.maxOutputChars,
		}))
		.sort((left, right) => left.name.localeCompare(right.name))
}

function resolveProfile(input: TaskToolSurfaceInput): UserExecutionProfile {
	if (!input.profile) return resolveExecutionProfile(input.mode ?? "code")
	if (typeof input.profile === "string") return resolveExecutionProfile(input.profile)
	return input.profile
}

function executionInput(
	input: TaskToolSurfaceInput,
	source: PolicySource | undefined,
): ToolPolicyInput["execution"] | undefined {
	if (input.execution) return input.execution
	if (!source?.execution) return input.cwd ? { workspaceRoots: [input.cwd] } : undefined
	const execution = source.execution
	return {
		sandboxMode: execution.sandboxMode,
		workspaceRoots: execution.workspaceRoots,
		command: execution.command,
		cancellation: execution.cancellation,
	}
}

/**
 * Capture one coherent model/runtime tool surface.
 *
 * The operation is intentionally synchronous: callers must provide already
 * captured schemas/registry state, so no live provider lookup can change half
 * of the result. Legacy callers can use `buildTaskToolSurface` in build-tools
 * for the asynchronous provider/catalog step.
 */
export function createTaskToolSurface(input: TaskToolSurfaceInput = {}): TaskToolSurface {
	const capturedSchemas = [...(input.schemas ?? input.providerSchemas ?? input.tools ?? [])]
	const registry =
		input.registry ?? new ToolRegistry(capturedSchemas.length > 0 ? { nativeTools: capturedSchemas } : {})
	const providerSchemas = capturedSchemas.length > 0 ? capturedSchemas : registry.getSchemas()
	const source = asPolicySource(input.policy)
	const includeAllToolsWithRestrictions = input.includeAllToolsWithRestrictions === true
	const profile = resolveProfile(input)

	// Registry descriptors are immutable after capture. This prevents a later
	// registration from making the digest and executable surface disagree.
	registry.seal()

	const allSchemas = normalizeSchemas(providerSchemas, registry, true)
	const schemaNames = functionNames(allSchemas)
	const schemaNameSet = new Set(schemaNames)
	const requestedVisibleNames = input.visibleToolNames ?? input.visibleTools ?? source?.visibleTools ?? schemaNames
	const policyVisibleSet = source ? new Set(source.visibleTools.map(canonicalizeToolName)) : undefined
	const visibleNames = requestedVisibleNames
		.map(canonicalizeToolName)
		.filter((name) => schemaNameSet.has(name) && (!policyVisibleSet || policyVisibleSet.has(name)))
	const visibleSet = new Set(visibleNames)
	const requestedAllowedNames =
		input.allowedToolNames ?? input.allowedFunctionNames ?? source?.allowedTools ?? visibleNames
	const policyAllowedSet = source ? new Set(source.allowedTools.map(canonicalizeToolName)) : undefined
	const candidateAllowedNames = requestedAllowedNames
		.map(canonicalizeToolName)
		.filter((name) => visibleSet.has(name) && (!policyAllowedSet || policyAllowedSet.has(name)))
	const disabledNames = [
		...(input.disabledTools ?? []),
		...(input.disabledToolNames ?? []),
		...(source?.disabledTools ?? []),
	].map(canonicalizeToolName)

	const basePolicy = createToolPolicySnapshot({
		visibleTools: visibleNames,
		allowedTools: candidateAllowedNames,
		disabledTools: disabledNames,
		autoApprovalEnabled: input.autoApprovalEnabled ?? source?.autoApprovalEnabled,
		capabilities: descriptorCapabilities(registry, input.capabilities ?? source?.capabilities),
		outputLimits: descriptorOutputLimits(registry, input.outputLimits ?? source?.outputLimits),
		execution: executionInput(input, source),
	})

	const profileResult =
		input.applyProfile === false
			? {
					policy: basePolicy,
					schemas: allSchemas,
					allowedFunctionNames: [...basePolicy.allowedTools],
				}
			: applyExecutionProfile(profile, basePolicy, allSchemas, {
					registry,
					includeAllToolsWithRestrictions,
				})

	const allowedNames = new Set(profileResult.allowedFunctionNames.map(canonicalizeToolName))
	const modelSchemas = normalizeSchemas(
		allSchemas,
		registry,
		includeAllToolsWithRestrictions,
		includeAllToolsWithRestrictions ? undefined : allowedNames,
	)
	const modelSchemaNames = functionNames(modelSchemas)
	const modelSchemaNameSet = new Set(modelSchemaNames)
	const allowedFunctionNames = [...new Set(profileResult.allowedFunctionNames)]
		.map(canonicalizeToolName)
		.filter((name) => modelSchemaNameSet.has(name) && isToolAllowed(basePolicy, name) && allowedNames.has(name))
		.sort()

	// Rehydrate the policy from the same captured names after profile filtering.
	// This is not a second mode restriction: it preserves the provider superset's
	// visibility while replacing only the callable set and computed digest.
	const finalVisibleNames = modelSchemaNames
	const finalPolicy = createToolPolicySnapshot({
		visibleTools: finalVisibleNames,
		allowedTools: allowedFunctionNames,
		disabledTools: disabledNames,
		autoApprovalEnabled: basePolicy.approval.autoApprovalEnabled,
		capabilities: descriptorCapabilities(registry, basePolicy.capabilities),
		outputLimits: basePolicy.outputLimits,
		execution: basePolicy.execution,
	})

	const digest = digestValue({
		registry: fingerprintRegistry(registry),
		schemas: modelSchemas,
		allowedFunctionNames,
		policy: finalPolicy,
		profile: { id: profile.id, digest: executionProfileDigest(profile) },
		includeAllToolsWithRestrictions,
	})

	const frozenSchemas = Object.freeze([...modelSchemas])
	const frozenAllowedNames = Object.freeze([...allowedFunctionNames])
	const surface: TaskToolSurface = {
		registry,
		schemas: frozenSchemas,
		allowedFunctionNames: frozenAllowedNames,
		policy: finalPolicy,
		digest,
		profile,
		includeAllToolsWithRestrictions,
		resolve: (name: string) => {
			const canonical = canonicalizeToolName(name)
			return frozenAllowedNames.includes(canonical) && isToolAllowed(finalPolicy, canonical)
				? registry.resolve(canonical)
				: undefined
		},
		isCallable: (name: string) => {
			const canonical = canonicalizeToolName(name)
			return frozenAllowedNames.includes(canonical) && isToolAllowed(finalPolicy, canonical)
		},
	}
	return Object.freeze(surface)
}

/** Backwards-friendly aliases for callers that describe capture as a build. */
export const captureTaskToolSurface = createTaskToolSurface
export const buildTaskToolSurface = createTaskToolSurface
export const createTaskToolSurfaceSnapshot = createTaskToolSurface
