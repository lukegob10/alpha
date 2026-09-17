import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"

import type { ApiHandler } from "../../src/api"
import { AgentStepContextBuilder } from "../../src/core/agent/AgentStepContextBuilder"
import { AgentRetryPolicy } from "../../src/core/agent/AgentRetryPolicy"
import type { ApiMessage } from "../../src/core/task-persistence/apiMessages"
import { Task } from "../../src/core/task/Task"
import { TaskToolCatalogCache } from "../../src/core/task/TaskToolCatalogCache"
import { buildNativeToolsArrayWithRestrictions } from "../../src/core/task/build-tools"
import { getNativeTools } from "../../src/core/prompts/tools/native-tools"
import { createNor28CatalogFixture, createNor28Provider } from "../../src/core/task/__tests__/fixtures/nor28-catalog"
import { countTokens } from "../../src/utils/countTokens"

vi.mock("../../src/core/task/build-tools", async (original) => {
	const module = await original<typeof import("../../src/core/task/build-tools")>()
	return { ...module, buildNativeToolsArrayWithRestrictions: vi.fn(module.buildNativeToolsArrayWithRestrictions) }
})
vi.mock("../../src/core/prompts/tools/native-tools", async (original) => {
	const module = await original<typeof import("../../src/core/prompts/tools/native-tools")>()
	return { ...module, getNativeTools: vi.fn(module.getNativeTools) }
})
vi.mock("../../src/services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: () => ({ isFeatureEnabled: false, isFeatureConfigured: false, isInitialized: false }),
	},
}))

const root = path.resolve(__dirname, "../..")
const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const fixture = createNor28CatalogFixture()
const systemPrompt = "Use the supplied read evidence to answer the bounded question. Preserve tool transactions."
const history: ApiMessage[] = [
	{ role: "user", content: "What is the default retry limit in src/config.js?" },
	{
		role: "assistant",
		content: [{ type: "tool_use", id: "fixture-read", name: "read_file", input: { path: "src/config.js" } }],
		reasoning_details: [{ type: "reasoning.encrypted", data: "public-fixture-state" }],
	},
	{ role: "user", content: [{ type: "tool_result", tool_use_id: "fixture-read", content: "1 | retryLimit = 3" }] },
]

function harness(servers: Parameters<typeof createNor28Provider>[0]) {
	const handler = {
		getModel: () => ({
			id: "nor36-local-fixture",
			info: { contextWindow: 128_000, maxTokens: 4096, supportsImages: false, supportsPromptCache: false },
		}),
		countTokens: vi.fn(async (content) => countTokens(content, { useWorker: false })),
		createMessage: vi.fn<ApiHandler["createMessage"]>(async function* () {
			yield { type: "text", text: "The default retry limit is 3 (src/config.js:1)." }
		}),
	} satisfies ApiHandler
	const provider = {
		...createNor28Provider(servers),
		getState: async () => ({
			mode: "code",
			autoCondenseContext: true,
			autoApprovalEnabled: true,
			alwaysAllowReadOnly: true,
		}),
	}
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "nor36-preflight-fixture",
		instanceId: "nor36-preflight-fixture",
		taskKind: "primary",
		workspacePath: root,
		abort: false,
		api: handler,
		apiConfiguration: { apiProvider: "openai", apiModelId: "nor36-local-fixture" },
		providerRef: { deref: () => provider },
		apiConversationHistory: structuredClone(history),
		clineMessages: [],
		agentTurnStep: 0,
		agentStepContextBuilder: new AgentStepContextBuilder<ApiHandler, unknown>(),
		agentRetryPolicy: new AgentRetryPolicy({ maxAttempts: 2, jitter: "none", baseDelayMs: 0 }),
		toolCatalogCache: new TaskToolCatalogCache(),
		getTaskMode: async () => "code",
		getSystemPrompt: async () => systemPrompt,
		getCurrentProfileId: async () => "fixture-profile",
		getTokenUsage: () => ({ contextTokens: 100 }),
		getTaskAllowedToolNames: () => undefined,
		shouldExposeAgentLifecycleTools: () => false,
		autoApprovalHandler: { checkAutoApprovalLimits: async () => ({ shouldProceed: true }) },
		ensureCanonicalLifecycleStepStarted: async () => {},
		publishCanonicalLifecyclePhase: async () => {},
		appendAgentTurnEvent: async () => {},
		publishCanonicalLifecyclePendingToolResults: async () => {},
		saveApiConversationHistory: async () => true,
		settleAllPersistedWaitAgentResultClaims: async () => {},
	}) as Task
	return { task, handler }
}

describe("NOR36 production request preflight measurement", () => {
	it("records identical continuation workloads without prescribing catalog build counts", async () => {
		const samples = []
		for (const [catalog, servers] of [
			["none", fixture.noMcpServers],
			["small", fixture.smallServers],
			["large", fixture.largeServers],
		] as const) {
			for (let sampleIndex = 0; sampleIndex < 3; sampleIndex++) {
				vi.mocked(buildNativeToolsArrayWithRestrictions).mockClear()
				vi.mocked(getNativeTools).mockClear()
				const { task, handler } = harness(servers)
				const stream = task.attemptApiRequest(0, { skipProviderRateLimit: true, ownerHandlesRetry: true })
				const chunks = []
				try {
					for await (const chunk of stream) chunks.push(chunk)
				} finally {
					await stream.return(undefined)
				}
				expect(handler.createMessage).toHaveBeenCalledTimes(1)
				expect(chunks).toEqual([{ type: "text", text: "The default retry limit is 3 (src/config.js:1)." }])
				const [prompt, messages, metadata] = handler.createMessage.mock.calls[0]
				expect(prompt).toBe(systemPrompt)
				expect(messages).toEqual(history)
				expect(metadata?.tools?.length).toBeGreaterThan(0)
				const {
					taskId: _taskId,
					requestId: _requestId,
					attemptId: _attemptId,
					signal: _signal,
					deadline: _deadline,
					...logicalMetadata
				} = metadata!
				const logicalRequest = JSON.stringify({ prompt, messages, metadata: logicalMetadata })
				expect(logicalRequest).not.toContain(root)
				expect(logicalRequest).not.toContain(JSON.stringify(root).slice(1, -1))
				const builds = vi.mocked(buildNativeToolsArrayWithRestrictions)
				const finalBuild = builds.mock.calls.at(-1)?.[0]
				expect(finalBuild?.autoApprovalEnabled).toBe(true)
				expect(finalBuild?.readGrant).toEqual({ enabled: true, workspaceRoot: root, showIgnoredFiles: false })
				const finalResult = builds.mock.results.at(-1)
				expect(finalResult?.type).toBe("return")
				const finalSurface = (await finalResult!.value).surface
				expect(finalSurface).toBeDefined()
				const serialized = {
					system: prompt,
					messages: JSON.stringify(messages),
					schemas: JSON.stringify(metadata?.tools),
				}
				const inputBytes = Object.fromEntries(
					Object.entries(serialized).map(([key, value]) => [key, Buffer.byteLength(value)]),
				)
				const localInputTokenEstimates: Record<string, number> = {}
				for (const [key, value] of Object.entries(serialized)) {
					localInputTokenEstimates[key] = await countTokens([{ type: "text", text: value }], {
						useWorker: false,
					})
				}
				samples.push({
					catalog,
					sampleIndex,
					catalogBuildCalls: builds.mock.calls.length,
					nativeSchemaFactoryCalls: vi.mocked(getNativeTools).mock.calls.length,
					providerRequests: handler.createMessage.mock.calls.length,
					emittedToolCalls: 0,
					commandsExecuted: 0,
					inputBytes,
					localInputTokenEstimates,
					outputTextBytes: Buffer.byteLength("The default retry limit is 3 (src/config.js:1)."),
					requestDigest: digest(logicalRequest),
					toolSchemaDigest: digest(serialized.schemas),
					quality: "request-and-response-parity-passed",
					providerTokens: null,
				})
			}
		}
		for (const catalog of ["none", "small", "large"]) {
			const group = samples.filter((sample) => sample.catalog === catalog)
			expect(new Set(group.map((sample) => sample.requestDigest)).size).toBe(1)
		}
		const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
		const report = {
			schemaVersion: 1,
			benchmark: "nor36-production-request-preflight",
			revision: git("rev-parse", "HEAD"),
			workingTree: git("status", "--porcelain") ? "modified" : "clean",
			node: process.version,
			harnessDigest: digest(await fs.readFile(__filename, "utf8")),
			fixtureDigest: digest(JSON.stringify({ fixture, history, systemPrompt })),
			configuration: "openai-fixture-code-autoapproval-readgrant-low-context-v1",
			cache: "fresh task catalog per sample; shared process tokenizer; provider prompt caching disabled",
			boundary:
				"Task.attemptApiRequest with real context manager, catalog builder and step capture; injected lifecycle/UI/provider",
			tokenMethod:
				"Alpha local o200k_base estimator with 1.5 safety multiplier over separate text/JSON parts; not provider usage",
			providerTokens: null,
			wholeTaskCompletion: null,
			timeToUsefulAnswerMs: null,
			samples,
		}
		if (process.env.ALPHA_NOR36_PREFLIGHT_REPORT) {
			await fs.writeFile(process.env.ALPHA_NOR36_PREFLIGHT_REPORT, `${JSON.stringify(report, null, 2)}\n`)
		}
		console.log(JSON.stringify(report))
	})
})
