import type OpenAI from "openai"
import type Anthropic from "@anthropic-ai/sdk"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { BuildToolsOptions, BuildToolsResult } from "../build-tools"
import { buildNativeToolsArrayWithRestrictions } from "../build-tools"
import { getAvailableVSCodeBrowserToolNames } from "../../../services/browser/VSCodeBrowserTools"
import { countTokens } from "../../../utils/countTokens"
import { convertOpenAIToolsToAnthropic } from "../../prompts/tools/native-tools"
import { getNativeTools } from "../../prompts/tools/native-tools"
import { digestValue } from "../../agent/StepContext"
import { createAgentResponse, type AgentToolCall } from "../../agent/AgentResponse"
import {
	ToolScheduler,
	type ToolExecutionHost,
	type ToolSchedulerOutcome,
	type ToolSchedulerResult,
} from "../../agent/ToolScheduler"
import { TaskToolCatalogCache } from "../TaskToolCatalogCache"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { readFileTool } from "../../tools/ReadFileTool"
import { useMcpToolTool } from "../../tools/UseMcpToolTool"
import { canonicalizeToolName } from "../../tools/ToolRegistry"
import {
	createNor28CatalogFixture,
	createNor28Provider,
	getNor28ExposedServers,
	NOR28_LARGE_MCP_TOOL_COUNT,
	NOR28_SMALL_MCP_TOOL_NAMES,
} from "./fixtures/nor28-catalog"

vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: () => ({
			isFeatureEnabled: false,
			isFeatureConfigured: false,
			isInitialized: false,
		}),
	},
}))

afterEach(() => vi.restoreAllMocks())

/**
 * Focused run: `pnpm --dir src test -- core/task/__tests__/tool-catalog-measurement.spec.ts --no-silent`.
 */

type FunctionTool = OpenAI.Chat.ChatCompletionFunctionTool

interface TokenMeasurement {
	count: number
	wallTimeMs: number
	method: string
}

interface SerializedMeasurement extends TokenMeasurement {
	label: string
	jsonBytes: number
	functionCount: number
	functionNames: string[]
	/** Provider payloads that carry an explicit callable allow-list expose its size and names here. */
	allowedFunctionNames?: string[]
}

interface BuildMeasurement {
	label: string
	wallTimeMs: number
	result: BuildToolsResult
}

interface RoundTripMeasurement {
	modelCallName: string | undefined
	descriptorName: string | undefined
	allowedNameCount: number
	unresolvedAllowedNames: string[]
	disallowedNamesResolved: string[]
	schemaDescriptorMismatches: string[]
	stable: boolean
}

interface RepresentationMeasurement {
	openaiOrdinary: SerializedMeasurement
	anthropicOrdinary: SerializedMeasurement
	geminiHistoricalSuperset: SerializedMeasurement
	vertexHistoricalSuperset: SerializedMeasurement
}

interface CatalogCaseMeasurement {
	name: string
	request: {
		mode: string
		includeAllToolsWithRestrictions: boolean
		taskKind: "primary" | "subagent"
		disabledTools: string[]
		serverCount: number
		connectedServerCount: number
		fixtureMcpToolCount: number
	}
	rawNative: {
		staticCatalog: SerializedMeasurement
		requestCandidateCatalog: SerializedMeasurement
	}
	legacyResultTools: SerializedMeasurement
	effectiveSurfaceSchemas: SerializedMeasurement
	allowedFunctionNames: string[]
	registryDescriptorCount: number
	roundTrip: RoundTripMeasurement
	representations?: RepresentationMeasurement
	wallTimeMs: {
		ordinaryCold: number
		ordinaryWarm: number
		historicalSuperset: number
	}
}

interface WorkflowPayloadMeasurement {
	label: string
	jsonBytes: number
	tokenCount: number
	functionCount: number
}

interface WorkflowSampleMeasurement {
	phase: "cold" | "warm"
	modelToolRounds: number
	discoveryModelRounds: number
	extraModelRoundsComparedWithEager: number
	effectiveSchemaRequestCount: number
	effectiveSchemaBytes: number
	effectiveSchemaTokens: number
	resultBytes: number
	resultTokens: number
	effectiveSchemaPayloads: WorkflowPayloadMeasurement[]
	resultPayloads: WorkflowPayloadMeasurement[]
	buildWallTimeMs: number
	schedulerWallTimeMs: number
	localEndToEndWallTimeMs: number
	outcomeStatus: ToolSchedulerOutcome["status"]
	toolResultStatus: ToolSchedulerResult["status"]
	toolResultText: string
	effectPayload: unknown
}

interface CoreWorkflowSeries {
	samples: WorkflowSampleMeasurement[]
	effectiveSchemaDigests: string[]
}

interface CoreWorkflowMeasurement {
	toolName: "read_file"
	toolArguments: Record<string, unknown>
	eager: CoreWorkflowSeries
	cached: CoreWorkflowSeries
	effectiveSchemasUnchanged: {
		cold: boolean
		warm: boolean
	}
	modelRounds: {
		eagerCold: number
		cachedCold: number
		cachedExtraComparedWithEager: number
		discoveryCalls: number
	}
	equivalence: {
		toolResultStatusEqual: boolean
		toolResultTextEqual: boolean
		effectPayloadEqual: boolean
	}
	modelLatency: {
		measured: false
		assumedMs: 0
		note: string
	}
}

interface WorkflowMeasurement {
	toolName: string
	toolArguments: Record<string, unknown>
	eager: WorkflowSampleMeasurement[]
	deferred: WorkflowSampleMeasurement[]
	denied: {
		effectiveSchema: WorkflowPayloadMeasurement
		result: WorkflowPayloadMeasurement
		outcomeStatus: ToolSchedulerOutcome["status"]
		toolResultStatus: ToolSchedulerResult["status"]
		effectCalled: boolean
		initialToolCallable: boolean
	}
	fallback: {
		provider: "gemini"
		effectiveSchema: WorkflowPayloadMeasurement
		result: WorkflowPayloadMeasurement
		wallTimeMs: number
		discoveryCallable: boolean
		toolCallable: boolean
		outcomeStatus: ToolSchedulerOutcome["status"]
		toolResultStatus: ToolSchedulerResult["status"]
		effectCalled: boolean
	}
	equivalence: {
		toolResultStatusEqual: boolean
		toolResultTextEqual: boolean
		effectPayloadEqual: boolean
	}
	modelLatency: {
		measured: false
		assumedMs: 0
		note: string
	}
}

interface GeminiVertexPayload {
	tools: Array<{
		functionDeclarations: Array<{
			name: string
			description?: string
			parametersJsonSchema?: unknown
		}>
	}>
	toolConfig?: {
		functionCallingConfig: {
			mode: "VALIDATED"
			allowedFunctionNames: string[]
		}
	}
}

function isFunctionTool(tool: OpenAI.Chat.ChatCompletionTool): tool is FunctionTool {
	return tool.type === "function"
}

function functionNames(tools: readonly OpenAI.Chat.ChatCompletionTool[]): string[] {
	return tools
		.filter(isFunctionTool)
		.map((tool) => canonicalizeToolName(tool.function.name))
		.sort()
}

function providerFunctionNames(value: unknown): string[] {
	if (!Array.isArray(value)) return []

	return value
		.flatMap((entry) => {
			if (!entry || typeof entry !== "object") return []
			const candidate = entry as {
				type?: unknown
				function?: { name?: unknown }
				name?: unknown
			}

			if (candidate.type === "function" && typeof candidate.function?.name === "string") {
				return [canonicalizeToolName(candidate.function.name)]
			}
			if (typeof candidate.name === "string") {
				return [canonicalizeToolName(candidate.name)]
			}
			return []
		})
		.sort()
}

function buildOptions(
	servers: readonly import("@alpha-code/types").McpServer[],
	overrides: Partial<BuildToolsOptions> = {},
): BuildToolsOptions {
	return {
		provider: createNor28Provider(servers) as unknown as BuildToolsOptions["provider"],
		cwd: "F:\\nor28-fixture",
		mode: "code",
		customModes: undefined,
		experiments: {},
		apiConfiguration: undefined,
		modelInfo: {
			contextWindow: 128_000,
			supportsPromptCache: false,
			supportsImages: false,
		},
		...overrides,
	}
}

function nativeCandidateCatalog(options: BuildToolsOptions): OpenAI.Chat.ChatCompletionTool[] {
	const isPlanMode = options.mode === "architect"
	return getNativeTools({
		supportsImages: options.modelInfo?.supportsImages ?? false,
		availableBrowserToolNames: getAvailableVSCodeBrowserToolNames(),
		taskKind: options.taskKind ?? "primary",
		agentKinds: isPlanMode ? ["explore", "review"] : undefined,
		planMode: isPlanMode,
	})
}

function serializedJson(value: unknown): string {
	const json = JSON.stringify(value)
	if (json === undefined) throw new Error("NOR-28 measurement value was not JSON serializable")
	return json
}

async function measureTokenCount(json: string): Promise<TokenMeasurement> {
	const started = performance.now()
	try {
		const count = await countTokens([{ type: "text", text: json }], { useWorker: false })
		return {
			count,
			wallTimeMs: Number((performance.now() - started).toFixed(3)),
			method: "repo:tiktoken/o200k_base*1.5-fudge",
		}
	} catch (error) {
		return {
			count: Math.max(1, Math.ceil(json.length / 4)),
			wallTimeMs: Number((performance.now() - started).toFixed(3)),
			method: `label:serialized-characters/4-fallback (${error instanceof Error ? error.message : String(error)})`,
		}
	}
}

async function measureSerialized(label: string, value: unknown): Promise<SerializedMeasurement> {
	const json = serializedJson(value)
	const tokenMeasurement = await measureTokenCount(json)
	const names = providerFunctionNames(value)
	return {
		label,
		jsonBytes: Buffer.byteLength(json, "utf8"),
		functionCount: names.length,
		functionNames: names,
		...tokenMeasurement,
	}
}

function toGeminiVertexPayload(result: BuildToolsResult): GeminiVertexPayload {
	const functionDeclarations = result.tools.filter(isFunctionTool).map((tool) => ({
		name: tool.function.name,
		description: tool.function.description,
		parametersJsonSchema: tool.function.parameters,
	}))
	const allowedFunctionNames = [...(result.allowedFunctionNames ?? result.surface?.allowedFunctionNames ?? [])].sort()

	return {
		tools: [{ functionDeclarations }],
		...(allowedFunctionNames.length > 0
			? {
					toolConfig: {
						functionCallingConfig: {
							mode: "VALIDATED" as const,
							allowedFunctionNames,
						},
					},
				}
			: {}),
	}
}

function measureRoundTrip(result: BuildToolsResult): RoundTripMeasurement {
	if (!result.surface) throw new Error("NOR-28 build result did not expose a captured task surface")

	const surface = result.surface
	const allowedNames = [...surface.allowedFunctionNames]
	const schemaByName = new Map(
		surface.schemas.filter(isFunctionTool).map((schema) => [canonicalizeToolName(schema.function.name), schema]),
	)
	const unresolvedAllowedNames = allowedNames.filter((name) => !surface.resolve(name))
	const disallowedNamesResolved = [...schemaByName.keys()].filter(
		(name) => !allowedNames.includes(name) && surface.resolve(name) !== undefined,
	)
	const schemaDescriptorMismatches = allowedNames.filter((name) => {
		const descriptor = surface.registry.resolve(name)
		const schema = schemaByName.get(canonicalizeToolName(name))
		return !descriptor || !schema || serializedJson(descriptor.schema) !== serializedJson(schema)
	})

	// This is a local JSON wire/descriptor probe. It does not call a model or make a
	// model quality claim; it only verifies that a deterministic model-shaped call
	// survives serialization and resolves through the captured execution surface.
	const modelCall = allowedNames.find((name) => name.startsWith("mcp--")) ?? allowedNames[0]
	const roundTrippedModelCall = modelCall
		? (JSON.parse(JSON.stringify({ id: "nor28-call-0", name: modelCall, arguments: {} })) as { name: string })
		: undefined
	const descriptor = roundTrippedModelCall ? surface.resolve(roundTrippedModelCall.name) : undefined

	return {
		modelCallName: roundTrippedModelCall?.name,
		descriptorName: descriptor?.name,
		allowedNameCount: allowedNames.length,
		unresolvedAllowedNames,
		disallowedNamesResolved,
		schemaDescriptorMismatches,
		stable:
			(!modelCall || descriptor?.name === canonicalizeToolName(modelCall)) &&
			unresolvedAllowedNames.length === 0 &&
			disallowedNamesResolved.length === 0 &&
			schemaDescriptorMismatches.length === 0,
	}
}

async function measureBuild(options: BuildToolsOptions, label: string): Promise<BuildMeasurement> {
	const started = performance.now()
	const result = await buildNativeToolsArrayWithRestrictions(options)
	return {
		label,
		wallTimeMs: Number((performance.now() - started).toFixed(3)),
		result,
	}
}

const NOR28_WORKFLOW_TOOL = "mcp--context7--get-library-readme"
const NOR28_WORKFLOW_ARGUMENTS = Object.freeze({ query: "NOR-28 deterministic workflow request" })
const NOR28_DISCOVERY_ARGUMENTS = Object.freeze({ query: "context7 library readme", limit: 1 })

interface ScheduledWorkflowCall {
	call: AgentToolCall
	host: ToolExecutionHost
	outcome: ToolSchedulerOutcome
	result: ToolSchedulerResult
	wallTimeMs: number
}

function createWorkflowCall(name: string, argumentsValue: Record<string, unknown>, id: string): AgentToolCall {
	return {
		type: "tool_call",
		id,
		name,
		arguments: argumentsValue,
	}
}

function createWorkflowHost(): ToolExecutionHost {
	const userMessageContent: Anthropic.ToolResultBlockParam[] = []
	return {
		taskId: "nor28-catalog-measurement",
		cwd: "F:\\nor28-fixture",
		userMessageContent,
		ask: vi.fn(async () => ({ response: "yesButtonClicked" as const })),
		say: vi.fn(async () => {}),
		recordToolUsage: vi.fn(),
		taskFacade: {} as never,
		pushToolResultToUserContent(result) {
			if (
				userMessageContent.some(
					(existing) => existing.type === "tool_result" && existing.tool_use_id === result.tool_use_id,
				)
			) {
				return false
			}
			userMessageContent.push(result)
			return true
		},
	}
}

async function executeWorkflowCall(surface: NonNullable<BuildToolsResult["surface"]>, call: AgentToolCall) {
	const host = createWorkflowHost()
	const started = performance.now()
	const outcome = await new ToolScheduler({
		executionHost: host,
		registry: surface.registry,
		policy: surface.policy,
		mode: "code",
		preserveAbortedResults: true,
		beforeEffect: () => {},
	}).run(createAgentResponse([call]))
	const result = outcome.results[0]
	if (!result) throw new Error(`NOR-28 scheduler did not return a result for ${call.name}`)
	return {
		call,
		host,
		outcome,
		result,
		wallTimeMs: Number((performance.now() - started).toFixed(3)),
	} satisfies ScheduledWorkflowCall
}

function persistedDiscoveryReceipt(call: AgentToolCall, host: ToolExecutionHost): ApiMessage[] {
	return [
		{
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id: call.id,
					name: call.name,
					input: call.arguments,
				},
			],
		},
		{
			role: "user",
			content: structuredClone(host.userMessageContent),
		},
	]
}

function workflowResultText(result: ToolSchedulerResult): string {
	if (typeof result.content === "string") return result.content
	return result.content
		.filter((block): block is Anthropic.TextBlockParam => block.type === "text")
		.map((block) => block.text)
		.join("\n")
}

async function compactWorkflowPayload(label: string, value: unknown): Promise<WorkflowPayloadMeasurement> {
	const measured = await measureSerialized(label, value)
	return {
		label,
		jsonBytes: measured.jsonBytes,
		tokenCount: measured.count,
		functionCount: measured.functionCount,
	}
}

async function createWorkflowSample(input: {
	phase: "cold" | "warm"
	builds: readonly BuildMeasurement[]
	executions: readonly ScheduledWorkflowCall[]
	effectPayloads: readonly unknown[]
	localEndToEndWallTimeMs: number
}): Promise<WorkflowSampleMeasurement> {
	const effectiveSchemaPayloads: WorkflowPayloadMeasurement[] = []
	for (const [index, build] of input.builds.entries()) {
		if (!build.result.surface) throw new Error("NOR-28 workflow build did not expose a task surface")
		effectiveSchemaPayloads.push(
			await compactWorkflowPayload(`${build.label}:effective-surface.schemas:${index}`, [
				...build.result.surface.schemas,
			]),
		)
	}

	const resultPayloads: WorkflowPayloadMeasurement[] = []
	for (const [index, execution] of input.executions.entries()) {
		resultPayloads.push(
			await compactWorkflowPayload(`${execution.call.name}:scheduler-result:${index}`, execution.result.content),
		)
	}

	const lastExecution = input.executions.at(-1)
	if (!lastExecution) throw new Error("NOR-28 workflow did not execute a tool call")
	return {
		phase: input.phase,
		modelToolRounds: input.executions.length,
		discoveryModelRounds: input.executions.filter((execution) => execution.call.name === "discover_tools").length,
		extraModelRoundsComparedWithEager: input.executions.length - 1,
		effectiveSchemaRequestCount: effectiveSchemaPayloads.length,
		effectiveSchemaBytes: effectiveSchemaPayloads.reduce((total, payload) => total + payload.jsonBytes, 0),
		effectiveSchemaTokens: effectiveSchemaPayloads.reduce((total, payload) => total + payload.tokenCount, 0),
		resultBytes: resultPayloads.reduce((total, payload) => total + payload.jsonBytes, 0),
		resultTokens: resultPayloads.reduce((total, payload) => total + payload.tokenCount, 0),
		effectiveSchemaPayloads,
		resultPayloads,
		buildWallTimeMs: input.builds.reduce((total, build) => total + build.wallTimeMs, 0),
		schedulerWallTimeMs: input.executions.reduce((total, execution) => total + execution.wallTimeMs, 0),
		localEndToEndWallTimeMs: input.localEndToEndWallTimeMs,
		outcomeStatus: lastExecution.outcome.status,
		toolResultStatus: lastExecution.result.status,
		toolResultText: workflowResultText(lastExecution.result),
		effectPayload: lastEffectPayload(input.effectPayloads),
	}
}

function installSyntheticMcpEffect(): unknown[] {
	const effectPayloads: unknown[] = []
	vi.spyOn(useMcpToolTool, "handle").mockImplementation(async (_task, block, callbacks) => {
		if (await callbacks.askApproval("use_mcp_server", "NOR-28 synthetic MCP approval")) {
			effectPayloads.push(structuredClone(block.nativeArgs))
			callbacks.pushToolResult("NOR-28 synthetic MCP result")
		}
	})
	return effectPayloads
}

const NOR28_CORE_TOOL = "read_file" as const
const NOR28_CORE_ARGUMENTS = Object.freeze({ path: "nor28-core-workflow.txt" })

function installSyntheticReadFileEffect(): unknown[] {
	const effectPayloads: unknown[] = []
	vi.spyOn(readFileTool, "handle").mockImplementation(async (_task, block, callbacks) => {
		effectPayloads.push(structuredClone(block.nativeArgs))
		callbacks.pushToolResult("NOR-28 synthetic read_file result")
	})
	return effectPayloads
}

async function measureCoreWorkflowSeries(
	servers: readonly import("@alpha-code/types").McpServer[],
	useCache: boolean,
	effectPayloads: unknown[],
): Promise<CoreWorkflowSeries> {
	const options = buildOptions(servers, {
		apiConfiguration: { apiProvider: "anthropic" },
		...(useCache ? { catalogCache: new TaskToolCatalogCache(), discoveryHistory: [] } : {}),
	})
	const samples: WorkflowSampleMeasurement[] = []
	const effectiveSchemaDigests: string[] = []

	for (const phase of ["cold", "warm"] as const) {
		const localStarted = performance.now()
		const build = await measureBuild(options, `${useCache ? "cached" : "eager"}:core:${phase}:build`)
		if (!build.result.surface) throw new Error("NOR-28 core workflow build did not expose a task surface")
		expect(build.result.surface.isCallable(NOR28_CORE_TOOL)).toBe(true)
		expect(build.result.surface.isCallable("discover_tools")).toBe(false)
		effectiveSchemaDigests.push(digestValue([...build.result.surface.schemas]))
		const execution = await executeWorkflowCall(
			build.result.surface,
			createWorkflowCall(
				NOR28_CORE_TOOL,
				{ ...NOR28_CORE_ARGUMENTS },
				`core-${useCache ? "cached" : "eager"}-${phase}`,
			),
		)
		expect(execution.result.status).toBe("success")
		samples.push(
			await createWorkflowSample({
				phase,
				builds: [build],
				executions: [execution],
				effectPayloads,
				localEndToEndWallTimeMs: Number((performance.now() - localStarted).toFixed(3)),
			}),
		)
	}

	return { samples, effectiveSchemaDigests }
}

async function measureCoreWorkflow(
	servers: readonly import("@alpha-code/types").McpServer[],
): Promise<CoreWorkflowMeasurement> {
	const effectPayloads = installSyntheticReadFileEffect()
	const eager = await measureCoreWorkflowSeries(servers, false, effectPayloads)
	effectPayloads.splice(0)
	const cached = await measureCoreWorkflowSeries(servers, true, effectPayloads)

	return {
		toolName: NOR28_CORE_TOOL,
		toolArguments: { ...NOR28_CORE_ARGUMENTS },
		eager,
		cached,
		effectiveSchemasUnchanged: {
			cold: eager.effectiveSchemaDigests[0] === cached.effectiveSchemaDigests[0],
			warm: eager.effectiveSchemaDigests[1] === cached.effectiveSchemaDigests[1],
		},
		modelRounds: {
			eagerCold: eager.samples[0]?.modelToolRounds ?? 0,
			cachedCold: cached.samples[0]?.modelToolRounds ?? 0,
			cachedExtraComparedWithEager: cached.samples[0]?.extraModelRoundsComparedWithEager ?? 0,
			discoveryCalls: cached.samples.reduce((total, sample) => total + sample.discoveryModelRounds, 0),
		},
		equivalence: {
			toolResultStatusEqual: eager.samples[0]?.toolResultStatus === cached.samples[0]?.toolResultStatus,
			toolResultTextEqual: eager.samples[0]?.toolResultText === cached.samples[0]?.toolResultText,
			effectPayloadEqual:
				serializedJson(eager.samples[0]?.effectPayload) === serializedJson(cached.samples[0]?.effectPayload),
		},
		modelLatency: {
			measured: false,
			assumedMs: 0,
			note: "No live provider call was made; model/tool round counts are logical workflow steps only.",
		},
	}
}

function lastEffectPayload(effectPayloads: readonly unknown[]): unknown {
	return effectPayloads.length > 0 ? effectPayloads[effectPayloads.length - 1] : undefined
}

async function measureEagerWorkflow(
	servers: readonly import("@alpha-code/types").McpServer[],
	effectPayloads: unknown[],
): Promise<WorkflowSampleMeasurement[]> {
	const options = buildOptions(servers, { apiConfiguration: { apiProvider: "anthropic" } })
	const samples: WorkflowSampleMeasurement[] = []

	for (const phase of ["cold", "warm"] as const) {
		const localStarted = performance.now()
		const build = await measureBuild(options, `eager:${phase}:build`)
		if (!build.result.surface) throw new Error("NOR-28 eager workflow build did not expose a task surface")
		const execution = await executeWorkflowCall(
			build.result.surface,
			createWorkflowCall(NOR28_WORKFLOW_TOOL, { ...NOR28_WORKFLOW_ARGUMENTS }, `eager-${phase}`),
		)
		samples.push(
			await createWorkflowSample({
				phase,
				builds: [build],
				executions: [execution],
				effectPayloads,
				localEndToEndWallTimeMs: Number((performance.now() - localStarted).toFixed(3)),
			}),
		)
	}

	return samples
}

async function measureDeferredWorkflow(
	servers: readonly import("@alpha-code/types").McpServer[],
	effectPayloads: unknown[],
): Promise<WorkflowSampleMeasurement[]> {
	const options = buildOptions(servers, {
		apiConfiguration: { apiProvider: "anthropic" },
		catalogCache: new TaskToolCatalogCache(),
		discoveryHistory: [],
	})
	const initialStarted = performance.now()
	const initial = await measureBuild(options, "deferred:cold:initial-build")
	if (!initial.result.surface) throw new Error("NOR-28 deferred workflow initial build did not expose a task surface")
	expect(initial.result.surface.isCallable("discover_tools")).toBe(true)
	expect(initial.result.surface.isCallable(NOR28_WORKFLOW_TOOL)).toBe(false)

	const discoveryCall = createWorkflowCall("discover_tools", { ...NOR28_DISCOVERY_ARGUMENTS }, "deferred-discovery")
	const discovery = await executeWorkflowCall(initial.result.surface, discoveryCall)
	expect(discovery.result.status).toBe("success")
	expect(typeof discovery.result.content).toBe("string")
	const discoveryPayload = JSON.parse(discovery.result.content as string) as {
		tools?: Array<{ name?: unknown }>
	}
	expect(discoveryPayload.tools?.some((tool) => tool.name === NOR28_WORKFLOW_TOOL)).toBe(true)
	expect(initial.result.surface.isCallable(NOR28_WORKFLOW_TOOL)).toBe(false)
	const history = persistedDiscoveryReceipt(discoveryCall, discovery.host)

	const next = await measureBuild({ ...options, discoveryHistory: history }, "deferred:cold:next-build")
	if (!next.result.surface) throw new Error("NOR-28 deferred workflow next build did not expose a task surface")
	expect(next.result.surface.isCallable(NOR28_WORKFLOW_TOOL)).toBe(true)
	const targetExecution = await executeWorkflowCall(
		next.result.surface,
		createWorkflowCall(NOR28_WORKFLOW_TOOL, { ...NOR28_WORKFLOW_ARGUMENTS }, "deferred-target"),
	)

	const samples = [
		await createWorkflowSample({
			phase: "cold",
			builds: [initial, next],
			executions: [discovery, targetExecution],
			effectPayloads,
			localEndToEndWallTimeMs: Number((performance.now() - initialStarted).toFixed(3)),
		}),
	]

	const warmStarted = performance.now()
	const warm = await measureBuild({ ...options, discoveryHistory: history }, "deferred:warm:next-build")
	if (!warm.result.surface) throw new Error("NOR-28 deferred workflow warm build did not expose a task surface")
	expect(warm.result.surface).toBe(next.result.surface)
	const warmExecution = await executeWorkflowCall(
		warm.result.surface,
		createWorkflowCall(NOR28_WORKFLOW_TOOL, { ...NOR28_WORKFLOW_ARGUMENTS }, "deferred-warm-target"),
	)
	samples.push(
		await createWorkflowSample({
			phase: "warm",
			builds: [warm],
			executions: [warmExecution],
			effectPayloads,
			localEndToEndWallTimeMs: Number((performance.now() - warmStarted).toFixed(3)),
		}),
	)

	return samples
}

async function measureWorkflowComparison(
	servers: readonly import("@alpha-code/types").McpServer[],
): Promise<WorkflowMeasurement> {
	const effectPayloads = installSyntheticMcpEffect()
	const eager = await measureEagerWorkflow(servers, effectPayloads)
	effectPayloads.splice(0)
	const deferred = await measureDeferredWorkflow(servers, effectPayloads)

	effectPayloads.splice(0)
	const deniedOptions = buildOptions(servers, {
		apiConfiguration: { apiProvider: "anthropic" },
		catalogCache: new TaskToolCatalogCache(),
		discoveryHistory: [],
	})
	const deniedBuild = await measureBuild(deniedOptions, "denied:initial-build")
	if (!deniedBuild.result.surface) throw new Error("NOR-28 denied workflow build did not expose a task surface")
	const deniedRun = await executeWorkflowCall(
		deniedBuild.result.surface,
		createWorkflowCall(NOR28_WORKFLOW_TOOL, { ...NOR28_WORKFLOW_ARGUMENTS }, "denied-target"),
	)
	const deniedEffectCalled = effectPayloads.length > 0
	const deniedSchema = await compactWorkflowPayload("denied:effective-surface.schemas", [
		...deniedBuild.result.surface.schemas,
	])
	const deniedResult = await compactWorkflowPayload("denied:scheduler-result", deniedRun.result.content)

	effectPayloads.splice(0)
	const fallbackOptions = buildOptions(servers, {
		apiConfiguration: { apiProvider: "gemini" },
		catalogCache: new TaskToolCatalogCache(),
		includeAllToolsWithRestrictions: true,
	})
	const fallbackStarted = performance.now()
	const fallbackBuild = await measureBuild(fallbackOptions, "fallback:gemini-build")
	if (!fallbackBuild.result.surface) throw new Error("NOR-28 fallback build did not expose a task surface")
	const fallbackRun = await executeWorkflowCall(
		fallbackBuild.result.surface,
		createWorkflowCall(NOR28_WORKFLOW_TOOL, { ...NOR28_WORKFLOW_ARGUMENTS }, "fallback-target"),
	)
	const fallbackEffectCalled = effectPayloads.length > 0
	const fallbackWallTimeMs = Number((performance.now() - fallbackStarted).toFixed(3))
	const fallbackSchema = await compactWorkflowPayload("fallback:effective-surface.schemas", [
		...fallbackBuild.result.surface.schemas,
	])
	const fallbackResult = await compactWorkflowPayload("fallback:scheduler-result", fallbackRun.result.content)

	return {
		toolName: NOR28_WORKFLOW_TOOL,
		toolArguments: { ...NOR28_WORKFLOW_ARGUMENTS },
		eager,
		deferred,
		denied: {
			effectiveSchema: deniedSchema,
			result: deniedResult,
			outcomeStatus: deniedRun.outcome.status,
			toolResultStatus: deniedRun.result.status,
			effectCalled: deniedEffectCalled,
			initialToolCallable: deniedBuild.result.surface.isCallable(NOR28_WORKFLOW_TOOL),
		},
		fallback: {
			provider: "gemini",
			effectiveSchema: fallbackSchema,
			result: fallbackResult,
			wallTimeMs: fallbackWallTimeMs,
			discoveryCallable: fallbackBuild.result.surface.isCallable("discover_tools"),
			toolCallable: fallbackBuild.result.surface.isCallable(NOR28_WORKFLOW_TOOL),
			outcomeStatus: fallbackRun.outcome.status,
			toolResultStatus: fallbackRun.result.status,
			effectCalled: fallbackEffectCalled,
		},
		equivalence: {
			toolResultStatusEqual: eager[0].toolResultStatus === deferred[0].toolResultStatus,
			toolResultTextEqual: eager[0].toolResultText === deferred[0].toolResultText,
			effectPayloadEqual: serializedJson(eager[0].effectPayload) === serializedJson(deferred[0].effectPayload),
		},
		modelLatency: {
			measured: false,
			assumedMs: 0,
			note: "No live provider call was made; model/tool round counts are logical workflow steps only.",
		},
	}
}

function assertCapturedSurfaceMatchesSchemas(result: BuildToolsResult): void {
	if (!result.surface) throw new Error("NOR-28 build result did not expose a captured task surface")

	for (const schema of result.surface.schemas.filter(isFunctionTool)) {
		const descriptor = result.surface.registry.resolve(schema.function.name)
		expect(descriptor, `missing executable descriptor for ${schema.function.name}`).toBeDefined()
		expect(descriptor?.schema).toEqual(schema)
	}

	for (const name of result.surface.allowedFunctionNames) {
		expect(result.surface.resolve(name), `allowed tool ${name} must resolve`).toBeDefined()
	}
}

async function measureCatalogCase(
	name: string,
	servers: readonly import("@alpha-code/types").McpServer[],
	overrides: Partial<BuildToolsOptions> = {},
	includeRepresentations = true,
): Promise<CatalogCaseMeasurement> {
	const ordinaryOptions = buildOptions(servers, { ...overrides, includeAllToolsWithRestrictions: false })
	const ordinaryCold = await measureBuild(ordinaryOptions, `${name}:ordinary:cold`)
	const ordinaryWarm = await measureBuild(ordinaryOptions, `${name}:ordinary:warm`)
	const historicalOptions = buildOptions(servers, { ...overrides, includeAllToolsWithRestrictions: true })
	const historicalSuperset = await measureBuild(historicalOptions, `${name}:historical-superset`)

	const ordinaryResult = ordinaryCold.result
	const historicalResult = historicalSuperset.result
	assertCapturedSurfaceMatchesSchemas(ordinaryResult)
	assertCapturedSurfaceMatchesSchemas(historicalResult)
	expect(ordinaryWarm.result.digest).toBe(ordinaryResult.digest)
	expect(ordinaryWarm.result.surface?.digest).toBe(ordinaryResult.surface?.digest)

	const staticNativeCatalog = getNativeTools()
	const requestCandidateCatalog = nativeCandidateCatalog(ordinaryOptions)
	const ordinaryLegacyTools = ordinaryResult.tools
	const ordinaryEffectiveSchemas = [...(ordinaryResult.surface?.schemas ?? ordinaryResult.schemas ?? [])]
	const historicalPayload = toGeminiVertexPayload(historicalResult)
	const exposedServers = getNor28ExposedServers(servers)

	const rawNative = {
		staticCatalog: await measureSerialized("raw-native-static-catalog", staticNativeCatalog),
		requestCandidateCatalog: await measureSerialized(
			"raw-native-request-candidate-catalog",
			requestCandidateCatalog,
		),
	}
	const legacyResultTools = await measureSerialized(`${name}:legacy-result.tools`, ordinaryLegacyTools)
	const effectiveSurfaceSchemas = await measureSerialized(
		`${name}:effective-surface.schemas`,
		ordinaryEffectiveSchemas,
	)

	const report: CatalogCaseMeasurement = {
		name,
		request: {
			mode: ordinaryOptions.mode ?? "undefined",
			includeAllToolsWithRestrictions: false,
			taskKind: ordinaryOptions.taskKind ?? "primary",
			disabledTools: [...(ordinaryOptions.disabledTools ?? [])],
			serverCount: servers.length,
			connectedServerCount: exposedServers.filter((server) => server.status === "connected").length,
			fixtureMcpToolCount: exposedServers.reduce(
				(count, server) =>
					count + (server.tools?.filter((tool) => tool.enabledForPrompt !== false).length ?? 0),
				0,
			),
		},
		rawNative,
		legacyResultTools,
		effectiveSurfaceSchemas,
		allowedFunctionNames: [
			...(ordinaryResult.surface?.allowedFunctionNames ?? ordinaryResult.allowedFunctionNames ?? []),
		],
		registryDescriptorCount: ordinaryResult.surface?.registry.list().length ?? 0,
		roundTrip: measureRoundTrip(ordinaryResult),
		wallTimeMs: {
			ordinaryCold: ordinaryCold.wallTimeMs,
			ordinaryWarm: ordinaryWarm.wallTimeMs,
			historicalSuperset: historicalSuperset.wallTimeMs,
		},
	}

	if (includeRepresentations) {
		const anthropicTools = convertOpenAIToolsToAnthropic(ordinaryEffectiveSchemas)
		const geminiVertexSerialized = serializedJson(historicalPayload)
		const geminiVertexTokens = await measureTokenCount(geminiVertexSerialized)
		const geminiVertexMeasurement: SerializedMeasurement = {
			label: `${name}:gemini-vertex-historical-superset`,
			jsonBytes: Buffer.byteLength(geminiVertexSerialized, "utf8"),
			functionCount: historicalPayload.tools[0]?.functionDeclarations.length ?? 0,
			functionNames: historicalResult.tools
				.filter(isFunctionTool)
				.map((tool) => tool.function.name)
				.sort(),
			allowedFunctionNames: historicalPayload.toolConfig?.functionCallingConfig.allowedFunctionNames,
			...geminiVertexTokens,
		}
		const representations: RepresentationMeasurement = {
			openaiOrdinary: legacyResultTools,
			anthropicOrdinary: await measureSerialized(`${name}:anthropic-converted`, anthropicTools),
			geminiHistoricalSuperset: geminiVertexMeasurement,
			// VertexHandler inherits the Gemini function declaration path. Keep a
			// separate labeled record so later before/after runs can compare routes.
			vertexHistoricalSuperset: { ...geminiVertexMeasurement, label: `${name}:vertex-historical-superset` },
		}
		report.representations = representations
	}

	return report
}

async function measureFilteringProbe(
	name: string,
	servers: readonly import("@alpha-code/types").McpServer[],
	overrides: Partial<BuildToolsOptions>,
) {
	const options = buildOptions(servers, overrides)
	const measured = await measureBuild(options, `${name}:filtering-probe`)
	assertCapturedSurfaceMatchesSchemas(measured.result)
	return {
		name,
		wallTimeMs: measured.wallTimeMs,
		legacyToolCount: measured.result.tools.length,
		effectiveSchemaCount: measured.result.surface?.schemas.length ?? measured.result.schemas?.length ?? 0,
		mcpEffectiveNames: functionNames(measured.result.surface?.schemas ?? measured.result.schemas ?? []).filter(
			(name) => name.startsWith("mcp--"),
		),
		allowedFunctionNames: [
			...(measured.result.surface?.allowedFunctionNames ?? measured.result.allowedFunctionNames ?? []),
		],
		roundTrip: measureRoundTrip(measured.result),
	}
}

describe("NOR-28 tool catalog baseline measurement", () => {
	it("records no-MCP and large-MCP ordinary/superset baseline payloads", async () => {
		const fixture = createNor28CatalogFixture()
		expect(fixture.largeMcpToolCount).toBeGreaterThanOrEqual(40)
		expect(fixture.smallMcpToolCount).toBe(2)

		const noMcp = await measureCatalogCase("no-mcp", fixture.noMcpServers)
		const large = await measureCatalogCase("large-mcp", fixture.largeServers)

		expect(noMcp.effectiveSurfaceSchemas.functionNames.filter((name) => name.startsWith("mcp--"))).toEqual([])
		expect(large.effectiveSurfaceSchemas.functionCount).toBeGreaterThan(noMcp.effectiveSurfaceSchemas.functionCount)
		expect(large.effectiveSurfaceSchemas.functionNames).toContain("mcp--context7--resolve-library-id")
		expect(large.effectiveSurfaceSchemas.functionNames).not.toContain(fixture.disabledPromptMcpTool)
		expect(large.effectiveSurfaceSchemas.functionNames).not.toContain("mcp--disabled-archive--search-archive")
		expect(large.effectiveSurfaceSchemas.functionNames).not.toContain("mcp--offline-docs--offline-tool")
		expect(large.roundTrip.stable).toBe(true)
		expect(noMcp.roundTrip.stable).toBe(true)

		console.log(
			"NOR-28 baseline measurement",
			JSON.stringify({
				fixture: {
					largeMcpToolCount: NOR28_LARGE_MCP_TOOL_COUNT,
					smallMcpToolNames: NOR28_SMALL_MCP_TOOL_NAMES,
				},
				cases: [noMcp, large],
				tokenMetric:
					"repo countTokens with tiktoken/o200k_base and its 1.5 fudge factor; counts serialized JSON only and exclude provider framing/token overhead",
				modelRoundTrip:
					"synthetic deterministic JSON model-shaped call resolved through the captured registry; no live model usage or quality claim",
			}),
		)
	})

	it("exercises small, mode, disabled, child, and connection filtering paths", async () => {
		const fixture = createNor28CatalogFixture()
		const small = await measureCatalogCase("small-mcp", fixture.smallServers)
		const architect = await measureFilteringProbe("architect-mode", fixture.largeServers, { mode: "architect" })
		const disabled = await measureFilteringProbe("disabled-tools", fixture.largeServers, {
			disabledTools: [fixture.disabledNativeTool, fixture.disabledMcpTool],
		})
		const child = await measureFilteringProbe("managed-child", fixture.largeServers, {
			taskKind: "subagent",
			allowedToolNames: [
				"read_file",
				"attempt_completion",
				fixture.disabledMcpTool,
			] as BuildToolsOptions["allowedToolNames"],
		})

		expect(small.effectiveSurfaceSchemas.functionNames.filter((name) => name.startsWith("mcp--"))).toHaveLength(2)
		expect(architect.mcpEffectiveNames).toEqual([])
		expect(disabled.allowedFunctionNames).not.toContain(fixture.disabledNativeTool)
		expect(disabled.allowedFunctionNames).not.toContain(fixture.disabledMcpTool)
		expect(child.mcpEffectiveNames).toContain(fixture.disabledMcpTool)
		expect(child.allowedFunctionNames).toEqual(["attempt_completion", "read_file", fixture.disabledMcpTool].sort())
		expect(child.roundTrip.stable).toBe(true)
		expect(
			getNor28ExposedServers(fixture.largeServers).some((server) => server.name === fixture.disabledServerName),
		).toBe(false)
		expect(
			getNor28ExposedServers(fixture.largeServers).some(
				(server) => server.name === fixture.disconnectedServerName,
			),
		).toBe(true)

		console.log(
			"NOR-28 filtering baseline",
			JSON.stringify({
				fixture: {
					largeMcpToolCount: NOR28_LARGE_MCP_TOOL_COUNT,
					smallMcpToolCount: fixture.smallMcpToolCount,
					disabledNativeTool: fixture.disabledNativeTool,
					disabledMcpTool: fixture.disabledMcpTool,
					disabledPromptMcpTool: fixture.disabledPromptMcpTool,
					disabledServerName: fixture.disabledServerName,
					disconnectedServerName: fixture.disconnectedServerName,
				},
				cases: { small, architect, disabled, child },
			}),
		)
	})

	it("measures eager versus deferred execution with scheduler, fallback, and denied paths", async () => {
		const fixture = createNor28CatalogFixture()
		const comparison = await measureWorkflowComparison(fixture.largeServers)

		expect(comparison.eager).toHaveLength(2)
		expect(comparison.deferred).toHaveLength(2)
		expect(comparison.eager[0].phase).toBe("cold")
		expect(comparison.eager[1].phase).toBe("warm")
		expect(comparison.deferred[0].phase).toBe("cold")
		expect(comparison.deferred[1].phase).toBe("warm")
		expect(comparison.eager[0].toolResultStatus).toBe("success")
		expect(comparison.deferred[0].toolResultStatus).toBe("success")
		expect(comparison.deferred[0].discoveryModelRounds).toBe(1)
		expect(comparison.deferred[0].extraModelRoundsComparedWithEager).toBe(1)
		expect(comparison.deferred[0].effectiveSchemaRequestCount).toBe(2)
		expect(comparison.deferred[0].resultPayloads).toHaveLength(2)
		expect(comparison.deferred[0].effectiveSchemaBytes).toBeLessThan(comparison.eager[0].effectiveSchemaBytes)
		expect(comparison.deferred[0].resultBytes).toBeGreaterThan(comparison.eager[0].resultBytes)
		expect(comparison.equivalence).toEqual({
			toolResultStatusEqual: true,
			toolResultTextEqual: true,
			effectPayloadEqual: true,
		})
		expect(comparison.denied.initialToolCallable).toBe(false)
		expect(comparison.denied.effectCalled).toBe(false)
		expect(comparison.denied.toolResultStatus).not.toBe("success")
		expect(comparison.fallback.discoveryCallable).toBe(false)
		expect(comparison.fallback.toolCallable).toBe(true)
		expect(comparison.fallback.toolResultStatus).toBe("success")
		expect(comparison.fallback.effectCalled).toBe(true)
		expect(comparison.modelLatency).toEqual({
			measured: false,
			assumedMs: 0,
			note: "No live provider call was made; model/tool round counts are logical workflow steps only.",
		})

		console.log(
			"NOR-28 eager/deferred workflow measurement",
			JSON.stringify({
				fixture: {
					largeMcpToolCount: NOR28_LARGE_MCP_TOOL_COUNT,
					toolName: comparison.toolName,
				},
				comparison,
				tokenMetric:
					"repo countTokens with tiktoken/o200k_base and its 1.5 fudge factor; counts serialized JSON only and exclude provider framing/token overhead",
			}),
		)
	})

	it("measures matched core-only eager versus cached execution", async () => {
		const fixture = createNor28CatalogFixture()
		const comparison = await measureCoreWorkflow(fixture.noMcpServers)

		expect(comparison.eager.samples).toHaveLength(2)
		expect(comparison.cached.samples).toHaveLength(2)
		expect(comparison.effectiveSchemasUnchanged).toEqual({ cold: true, warm: true })
		expect(comparison.eager.samples[0].effectiveSchemaRequestCount).toBe(1)
		expect(comparison.cached.samples[0].effectiveSchemaRequestCount).toBe(1)
		expect(comparison.eager.samples[0].effectiveSchemaBytes).toBe(comparison.cached.samples[0].effectiveSchemaBytes)
		expect(comparison.eager.samples[0].effectiveSchemaTokens).toBe(
			comparison.cached.samples[0].effectiveSchemaTokens,
		)
		expect(comparison.eager.samples[1].effectiveSchemaBytes).toBe(comparison.cached.samples[1].effectiveSchemaBytes)
		expect(comparison.eager.samples[1].effectiveSchemaTokens).toBe(
			comparison.cached.samples[1].effectiveSchemaTokens,
		)
		expect(comparison.eager.samples[0].modelToolRounds).toBe(1)
		expect(comparison.cached.samples[0].modelToolRounds).toBe(1)
		expect(comparison.eager.samples[0].discoveryModelRounds).toBe(0)
		expect(comparison.cached.samples[0].discoveryModelRounds).toBe(0)
		expect(comparison.cached.samples[0].extraModelRoundsComparedWithEager).toBe(0)
		expect(comparison.cached.samples[1].extraModelRoundsComparedWithEager).toBe(0)
		expect(comparison.eager.samples[0].toolResultStatus).toBe("success")
		expect(comparison.cached.samples[0].toolResultStatus).toBe("success")
		expect(comparison.equivalence).toEqual({
			toolResultStatusEqual: true,
			toolResultTextEqual: true,
			effectPayloadEqual: true,
		})
		expect(comparison.modelRounds).toEqual({
			eagerCold: 1,
			cachedCold: 1,
			cachedExtraComparedWithEager: 0,
			discoveryCalls: 0,
		})
		expect(comparison.modelLatency).toEqual({
			measured: false,
			assumedMs: 0,
			note: "No live provider call was made; model/tool round counts are logical workflow steps only.",
		})

		console.log(
			"NOR-28 core-only eager/cached workflow measurement",
			JSON.stringify({
				fixture: { toolName: comparison.toolName, mcpToolCount: 0 },
				comparison,
				tokenMetric:
					"repo countTokens with tiktoken/o200k_base and its 1.5 fudge factor; counts serialized JSON only and exclude provider framing/token overhead",
			}),
		)
	})
})
