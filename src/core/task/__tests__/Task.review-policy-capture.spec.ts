import {
	type AlphaMessage,
	type ApprovalMode,
	type McpServer,
	type ModelInfo,
	type ProviderSettings,
} from "@alpha-code/types"
import { describe, expect, it, vi } from "vitest"

import type { ApiHandler } from "../../../api"
import { AgentStepContextBuilder, type AgentStepSnapshot } from "../../agent/AgentStepContextBuilder"
import type { TaskToolSurface } from "../../tools/TaskToolSurface"
import { Task } from "../Task"
import { TaskToolCatalogCache } from "../TaskToolCatalogCache"

vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: () => ({ isFeatureEnabled: false, isFeatureConfigured: false, isInitialized: false }),
	},
}))

const protectedWrite = JSON.stringify({ tool: "editedExistingFile", path: ".alphaignore", isOutsideWorkspace: false })
const mcpUse = JSON.stringify({ type: "use_mcp_tool", serverName: "fixture", source: "global", toolName: "lookup" })

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => (resolve = done))
	return { promise, resolve }
}

function harness(approvalMode: ApprovalMode = "auto", apiProvider: "openai" | "vscode-lm" = "openai") {
	const state = {
		mode: "code",
		approvalMode,
		autoCondenseContext: false,
		alwaysAllowWriteProtected: false,
		alwaysAllowMcp: false,
		mcpServers: [
			{
				name: "fixture",
				source: "global",
				config: "{}",
				status: "connected",
				tools: [{ name: "lookup", alwaysAllow: false }],
			},
		] as McpServer[],
		experiments: {},
	}
	let manualResponse: "yesButtonClicked" | "noButtonClicked" = "noButtonClicked"
	const apiConfiguration: ProviderSettings = { apiProvider, apiModelId: "review-policy-model" }
	const api = {
		getModel: () => ({
			id: "review-policy-model",
			info: { contextWindow: 128_000, maxTokens: 4096, supportsImages: true } as ModelInfo,
		}),
		countTokens: vi.fn(async () => 1),
		streamCapabilities: { lifecycle: true, cancellation: true },
		createMessage: vi.fn<ApiHandler["createMessage"]>(async function* () {
			yield { type: "text", text: "Review policy fixture response" }
		}),
	} satisfies ApiHandler
	const provider = {
		context: {},
		getState: vi.fn(async () => ({ ...state })),
		getMcpHub: () => undefined,
		isTaskOnScreen: vi.fn(() => true),
		clearSubagentApproval: vi.fn(async () => {}),
	}
	const published: AlphaMessage[] = []
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "review-policy-capture",
		instanceId: "review-policy-capture-instance",
		taskKind: "primary",
		taskApprovalMode: approvalMode,
		workspacePath: process.cwd(),
		abort: false,
		taskCancellationController: new AbortController(),
		api,
		apiConfiguration,
		effectiveApiConfiguration: { ...apiConfiguration },
		reasoningPreference: { kind: "default" },
		reasoningState: {
			requested: { kind: "default" },
			effective: { kind: "default" },
			capabilities: { kind: "unavailable", canDisable: false },
		},
		reasoningByHandler: new WeakMap(),
		retainedReasoningHandlers: new Set(),
		reasoningHandlerUsers: new Map(),
		providerRef: { deref: () => provider },
		apiConversationHistory: [{ role: "user", content: "Inspect the saved review-policy fixture" }],
		clineMessages: [],
		agentTurnStep: 0,
		agentStepContextBuilder: new AgentStepContextBuilder<ApiHandler, unknown>(),
		toolCatalogCache: new TaskToolCatalogCache(),
		getTaskMode: vi.fn(async () => "code"),
		getSystemPrompt: vi.fn(async () => "System prompt"),
		getCurrentProfileId: vi.fn(async () => "profile"),
		getTokenUsage: vi.fn(() => ({ contextTokens: 0 })),
		getTaskAllowedToolNames: () => undefined,
		shouldExposeAgentLifecycleTools: () => false,
		autoApprovalHandler: { checkAutoApprovalLimits: vi.fn(async () => ({ shouldProceed: true })) },
		ensureCanonicalLifecycleStepStarted: vi.fn(async () => {}),
		publishCanonicalLifecyclePhase: vi.fn(async () => {}),
		appendAgentTurnEvent: vi.fn(async () => {}),
		publishCanonicalLifecyclePendingToolResults: vi.fn(async () => {}),
		saveApiConversationHistory: vi.fn(async () => true),
		settleAllPersistedWaitAgentResultClaims: vi.fn(async () => {}),
		messageQueueService: { isEmpty: () => true },
		emit: vi.fn(),
		saveAlphaMessages: vi.fn(async () => true),
		updateAlphaMessage: vi.fn(async () => {}),
		addToAlphaMessages: vi.fn(async (message: AlphaMessage) => {
			task.clineMessages.push(message)
			published.push(structuredClone(message))
			if (!message.isAnswered) task.handleWebviewAskResponse(manualResponse)
		}),
	}) as Task
	return {
		task,
		state,
		api,
		provider,
		published,
		setManualResponse(response: typeof manualResponse) {
			manualResponse = response
		},
	}
}

async function captureRequest(
	task: Task,
	retryAttempt = 0,
	options: NonNullable<Parameters<Task["attemptApiRequest"]>[1]> = {},
): Promise<void> {
	for await (const _chunk of task.attemptApiRequest(retryAttempt, {
		skipProviderRateLimit: true,
		ownerHandlesRetry: true,
		...options,
	})) {
		// No file or MCP operation runs; the real request path only admits its immutable policy.
	}
}

function capturedStep(task: Task) {
	return Reflect.get(task, "currentAgentStep") as {
		snapshot: AgentStepSnapshot<ApiHandler, unknown>
		surface: TaskToolSurface
		getRequest: () => unknown
	}
}

function enableReviewOptions(state: ReturnType<typeof harness>["state"]) {
	state.alwaysAllowWriteProtected = true
	state.alwaysAllowMcp = true
	state.mcpServers[0].tools![0].alwaysAllow = true
}

describe("Task captured protected-file and MCP review policy", () => {
	it.each(["openai", "vscode-lm"] as const)(
		"does not broaden an admitted %s step when global review options are enabled",
		async (apiProvider) => {
			const { task, state, published } = harness("auto", apiProvider)
			await captureRequest(task)
			enableReviewOptions(state)

			await expect(task.ask("tool", protectedWrite, undefined, undefined, true)).resolves.toMatchObject({
				response: "noButtonClicked",
			})
			expect(published.at(-1)).not.toHaveProperty("isAnswered", true)
			await expect(task.ask("use_mcp_server", mcpUse)).resolves.toMatchObject({ response: "noButtonClicked" })
			expect(published.at(-1)).not.toHaveProperty("isAnswered", true)
		},
	)

	it("freezes nested MCP options before asynchronous prompt preflight", async () => {
		const { task, state, published } = harness()
		state.alwaysAllowMcp = true
		const promptStarted = deferred<void>()
		const prompt = deferred<string>()
		Reflect.set(
			task,
			"getSystemPrompt",
			vi.fn(async () => {
				promptStarted.resolve()
				return prompt.promise
			}),
		)
		const capturing = captureRequest(task)
		await promptStarted.promise
		state.alwaysAllowWriteProtected = true
		state.mcpServers[0].tools![0].alwaysAllow = true
		state.mcpServers[0].tools!.push({ name: "later", alwaysAllow: true })
		state.mcpServers.push({
			...state.mcpServers[0],
			source: "project",
			tools: [{ name: "lookup", alwaysAllow: true }],
		})
		prompt.resolve("System prompt")
		await capturing

		const { surface, snapshot } = capturedStep(task)
		expect(surface.policy.approval.reviewPolicy).toEqual({
			protectedWriteAllowed: false,
			mcp: { enabled: true, grants: [] },
		})
		expect(snapshot.context.policy.approval.reviewPolicy).toEqual(surface.policy.approval.reviewPolicy)
		expect(Object.isFrozen(surface.policy.approval.reviewPolicy?.mcp.grants)).toBe(true)
		await expect(task.ask("tool", protectedWrite, undefined, undefined, true)).resolves.toMatchObject({
			response: "noButtonClicked",
		})
		await expect(task.ask("use_mcp_server", mcpUse)).resolves.toMatchObject({ response: "noButtonClicked" })
		expect(published.at(-1)).not.toHaveProperty("isAnswered", true)
	})

	it("honors live protected-file, MCP global, and exact-grant revocations", async () => {
		const { task, state, published } = harness()
		enableReviewOptions(state)
		await captureRequest(task)
		await expect(task.ask("tool", protectedWrite, undefined, undefined, true)).resolves.toMatchObject({
			response: "yesButtonClicked",
		})
		await expect(task.ask("use_mcp_server", mcpUse)).resolves.toMatchObject({ response: "yesButtonClicked" })
		state.alwaysAllowWriteProtected = false
		await expect(task.ask("tool", protectedWrite, undefined, undefined, true)).resolves.toMatchObject({
			response: "noButtonClicked",
		})
		expect(published.at(-1)).not.toHaveProperty("isAnswered", true)
		state.alwaysAllowMcp = false
		await expect(task.ask("use_mcp_server", mcpUse)).resolves.toMatchObject({ response: "noButtonClicked" })
		state.alwaysAllowMcp = true
		state.mcpServers[0].tools![0].alwaysAllow = false
		await expect(task.ask("use_mcp_server", mcpUse)).resolves.toMatchObject({ response: "noButtonClicked" })
		expect(published.at(-1)).not.toHaveProperty("isAnswered", true)
	})

	it.each(["transport", "rate-limit"] as const)(
		"retains the same review ceiling through a %s retry",
		async (retryCategory) => {
			const { task, state, api } = harness()
			api.createMessage.mockImplementationOnce(async function* () {
				yield* []
				throw new Error("Fixture transport failed before first chunk")
			})
			await expect(captureRequest(task)).rejects.toThrow("Fixture transport failed before first chunk")
			const original = capturedStep(task)
			enableReviewOptions(state)
			await captureRequest(task, 1, { retryCategory })

			const retried = capturedStep(task)
			expect(retried.surface).toBe(original.surface)
			expect(retried.snapshot.context.contextId).toBe(original.snapshot.context.contextId)
			expect(retried.snapshot.context.retryAttempt).toBe(1)
			await expect(task.ask("tool", protectedWrite, undefined, undefined, true)).resolves.toMatchObject({
				response: "noButtonClicked",
			})
			await expect(task.ask("use_mcp_server", mcpUse)).resolves.toMatchObject({ response: "noButtonClicked" })
		},
	)

	it("refreshes catalog identity only at a new step and reuses an unchanged review ceiling", async () => {
		const { task, state } = harness()
		await captureRequest(task)
		const original = capturedStep(task)
		enableReviewOptions(state)
		await captureRequest(task)
		const next = capturedStep(task)

		expect(next.surface).not.toBe(original.surface)
		expect(next.surface.policy.digest).not.toBe(original.surface.policy.digest)
		expect(next.surface.policy.approval.reviewPolicy).toMatchObject({
			protectedWriteAllowed: true,
			mcp: { enabled: true },
		})
		expect(original.surface.policy.approval.reviewPolicy).toEqual({
			protectedWriteAllowed: false,
			mcp: { enabled: false, grants: [] },
		})
		await expect(task.ask("tool", protectedWrite, undefined, undefined, true)).resolves.toMatchObject({
			response: "yesButtonClicked",
		})
		await expect(task.ask("use_mcp_server", mcpUse)).resolves.toMatchObject({ response: "yesButtonClicked" })
		await captureRequest(task)
		expect(capturedStep(task).surface).toBe(next.surface)
	})

	it("still accepts an explicit approval for one call without broadening the step", async () => {
		const { task, published, setManualResponse } = harness()
		await captureRequest(task)
		setManualResponse("yesButtonClicked")
		await expect(task.ask("tool", protectedWrite, undefined, undefined, true)).resolves.toMatchObject({
			response: "yesButtonClicked",
		})
		expect(published.at(-1)).not.toHaveProperty("isAnswered", true)
		setManualResponse("noButtonClicked")
		await expect(task.ask("tool", protectedWrite, undefined, undefined, true)).resolves.toMatchObject({
			response: "noButtonClicked",
		})
		expect(capturedStep(task).surface.policy.approval.reviewPolicy?.protectedWriteAllowed).toBe(false)
	})

	it("applies the same captured ceiling to an offscreen task", async () => {
		const { task, state, provider } = harness()
		provider.isTaskOnScreen.mockReturnValue(false)
		await captureRequest(task)
		enableReviewOptions(state)

		await expect(task.ask("tool", protectedWrite, undefined, undefined, true)).resolves.toMatchObject({
			response: "noButtonClicked",
		})
		await expect(task.ask("use_mcp_server", mcpUse)).resolves.toMatchObject({ response: "noButtonClicked" })
	})

	it("keeps a source-less approval bound to its captured server when same-name sources reorder", async () => {
		const { task, state, published } = harness()
		enableReviewOptions(state)
		state.mcpServers.push({
			...state.mcpServers[0],
			source: "project",
			tools: [{ name: "lookup", alwaysAllow: false }],
		})
		await captureRequest(task)
		state.mcpServers.reverse()
		state.mcpServers[0].tools![0].alwaysAllow = true

		// This exercises the supported source-less approval payload, without claiming a modern registry dispatch.
		await expect(
			task.ask(
				"use_mcp_server",
				JSON.stringify({
					type: "use_mcp_tool",
					serverName: "fixture",
					toolName: "lookup",
				}),
			),
		).resolves.toMatchObject({ response: "noButtonClicked" })
		expect(published.at(-1)).not.toHaveProperty("isAnswered", true)
		await expect(task.ask("use_mcp_server", mcpUse)).resolves.toMatchObject({ response: "yesButtonClicked" })
	})

	it("preserves pre-admission legacy settings while missing admitted review data fails closed", async () => {
		const { task, state } = harness()
		enableReviewOptions(state)
		await expect(task.ask("tool", protectedWrite, undefined, undefined, true)).resolves.toMatchObject({
			response: "yesButtonClicked",
		})
		await captureRequest(task)
		const step = capturedStep(task)
		const { reviewPolicy: _reviewPolicy, ...legacyApproval } = step.snapshot.context.policy.approval
		Reflect.set(task, "currentAgentStep", {
			...step,
			snapshot: {
				...step.snapshot,
				context: {
					...step.snapshot.context,
					policy: { ...step.snapshot.context.policy, approval: legacyApproval },
				},
			},
		})

		await expect(task.ask("tool", protectedWrite, undefined, undefined, true)).resolves.toMatchObject({
			response: "noButtonClicked",
		})
		await expect(task.ask("use_mcp_server", mcpUse)).resolves.toMatchObject({ response: "noButtonClicked" })
	})

	it.each(["openai", "vscode-lm"] as const)(
		"requires MCP review through public Task.ask after late settings enablement for %s",
		async (apiProvider) => {
			const { task, state, api, published } = harness("auto", apiProvider)
			await captureRequest(task)
			expect(api.createMessage).toHaveBeenCalledTimes(1)
			enableReviewOptions(state)

			await expect(task.ask("use_mcp_server", mcpUse)).resolves.toMatchObject({ response: "noButtonClicked" })
			expect(published.at(-1)).not.toHaveProperty("isAnswered", true)
		},
	)
})
