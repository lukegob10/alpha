import {
	disabledSubagentAutoApprovalPolicy,
	type AlphaMessage,
	type ApprovalMode,
	type ModelInfo,
	type ProviderSettings,
} from "@alpha-code/types"
import path from "path"
import { describe, expect, it, vi } from "vitest"

import type { ApiHandler } from "../../../api"
import { AgentStepContextBuilder, type AgentStepSnapshot } from "../../agent/AgentStepContextBuilder"
import { isPathAllowed } from "../../agent/ToolPolicy"
import { createSubagentCommandApprovalPolicy } from "../../auto-approval/commands"
import type { TaskToolSurface } from "../../tools/TaskToolSurface"
import { Task } from "../Task"
import { TaskToolCatalogCache } from "../TaskToolCatalogCache"

vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: () => ({ isFeatureEnabled: false, isFeatureConfigured: false, isInitialized: false }),
	},
}))

const READ_COMMAND = "rg --no-config -n ALPHA_E2E_EARLY_READ_PROOF alpha-e2e-stream-read-proof.txt"
const LATER_READ_COMMAND = "rg --no-config -n ALPHA_E2E_LATER_READ_PROOF alpha-e2e-stream-read-proof.txt"

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => (resolve = done))
	return { promise, resolve }
}

function harness(apiProvider: "openai" | "vscode-lm" = "openai") {
	const state = {
		mode: "code",
		approvalMode: "ask" as ApprovalMode,
		autoCondenseContext: false,
		allowedCommands: [READ_COMMAND],
		deniedCommands: [] as string[],
		experiments: {},
	}
	const apiConfiguration: ProviderSettings = { apiProvider, apiModelId: "command-policy-model" }
	const api = {
		getModel: () => ({
			id: "command-policy-model",
			info: { contextWindow: 128_000, maxTokens: 4096, supportsImages: true } as ModelInfo,
		}),
		countTokens: vi.fn(async () => 1),
		streamCapabilities: { lifecycle: true, cancellation: true },
		createMessage: vi.fn<ApiHandler["createMessage"]>(async function* () {
			yield { type: "text", text: "Command policy fixture response" }
		}),
	} satisfies ApiHandler
	const provider = {
		context: {},
		getState: vi.fn(async () => ({ ...state })),
		getMcpHub: () => undefined,
		isTaskOnScreen: () => true,
		clearSubagentApproval: vi.fn(async () => {}),
	}
	const published: AlphaMessage[] = []
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "command-policy-capture",
		instanceId: "command-policy-capture-instance",
		taskKind: "primary",
		taskApprovalMode: "ask",
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
		apiConversationHistory: [{ role: "user", content: "Inspect the saved proof file" }],
		alphaMessages: [],
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
			task.alphaMessages.push(message)
			published.push(structuredClone(message))
			// A prompt is denied deterministically so a missing grant fails without waiting for UI input.
			if (!message.isAnswered) task.handleWebviewAskResponse("noButtonClicked")
		}),
	}) as Task
	return { task, state, api, provider, published }
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
		// The provider emits text only; command payloads are never executed by this fixture.
	}
}

function capturedStep(task: Task) {
	return Reflect.get(task, "currentAgentStep") as {
		snapshot: AgentStepSnapshot<ApiHandler, unknown>
		surface: TaskToolSurface
		getRequest: () => unknown
	}
}

describe("Task command policy capture", () => {
	it.each(["openai", "vscode-lm"] as const)(
		"auto-approves a saved exact Ask command from the real admitted %s request surface",
		async (apiProvider) => {
			const { task, published } = harness(apiProvider)
			await captureRequest(task)

			await expect(task.ask("command", READ_COMMAND)).resolves.toMatchObject({ response: "yesButtonClicked" })
			expect(published).toHaveLength(1)
			expect(published[0]).toMatchObject({ ask: "command", text: READ_COMMAND, isAnswered: true })
			expect(capturedStep(task).surface.policy.execution.command.allowedPrefixes).toEqual([READ_COMMAND])
		},
	)

	it("freezes command rules before async preflight while new live grants and denies only narrow the step", async () => {
		const { task, state, published } = harness()
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
		state.allowedCommands.push(LATER_READ_COMMAND)
		state.deniedCommands.push(READ_COMMAND)
		prompt.resolve("System prompt")
		await capturing

		const { surface, snapshot } = capturedStep(task)
		expect(surface.policy.execution.command.allowedPrefixes).toEqual([READ_COMMAND])
		expect(surface.policy.execution.command.deniedPrefixes).toEqual([])
		expect(snapshot.context.policy.execution.command).toEqual(surface.policy.execution.command)
		expect(Object.isFrozen(surface.policy.execution.command.allowedPrefixes)).toBe(true)
		expect(Object.isFrozen(surface.policy.execution.command.deniedPrefixes)).toBe(true)
		await expect(task.ask("command", LATER_READ_COMMAND)).resolves.toMatchObject({ response: "noButtonClicked" })
		expect(published.at(-1)).not.toHaveProperty("isAnswered", true)
		await expect(task.ask("command", READ_COMMAND)).resolves.toMatchObject({ response: "noButtonClicked" })
		expect(published.at(-1)).toHaveProperty("isAnswered", true)
	})

	it("requires review after live settings remove an admitted Ask grant", async () => {
		const { task, state, published } = harness()
		await captureRequest(task)
		state.allowedCommands.splice(0)

		await expect(task.ask("command", READ_COMMAND)).resolves.toMatchObject({ response: "noButtonClicked" })
		expect(published.at(-1)).not.toHaveProperty("isAnswered", true)
		expect(capturedStep(task).surface.policy.execution.command.allowedPrefixes).toEqual([READ_COMMAND])
	})

	it("retains an admitted command denial after live settings remove it", async () => {
		const { task, state, published } = harness()
		state.deniedCommands.push(READ_COMMAND)
		await captureRequest(task)
		state.deniedCommands.splice(0)

		await expect(task.ask("command", READ_COMMAND)).resolves.toMatchObject({ response: "noButtonClicked" })
		expect(published.at(-1)).toHaveProperty("isAnswered", true)
		expect(capturedStep(task).surface.policy.execution.command.deniedPrefixes).toEqual([READ_COMMAND])
	})

	it.each(["transport", "rate-limit"] as const)(
		"retains the admitted command surface through a %s retry after settings change",
		async (retryCategory) => {
			const { task, state, api, published } = harness()
			api.createMessage.mockImplementationOnce(async function* () {
				yield* []
				throw new Error("Fixture transport failed before first chunk")
			})
			await expect(captureRequest(task)).rejects.toThrow("Fixture transport failed before first chunk")
			const original = capturedStep(task)
			state.allowedCommands.push(LATER_READ_COMMAND)
			state.deniedCommands.push("git push")
			await captureRequest(task, 1, { retryCategory })

			const retried = capturedStep(task)
			expect(retried.surface).toBe(original.surface)
			expect(retried.snapshot.context.contextId).toBe(original.snapshot.context.contextId)
			expect(retried.snapshot.context.retryAttempt).toBe(1)
			expect(retried.surface.policy.execution.command.allowedPrefixes).toEqual([READ_COMMAND])
			expect(retried.surface.policy.execution.command.deniedPrefixes).toEqual([])
			await expect(task.ask("command", READ_COMMAND)).resolves.toMatchObject({ response: "yesButtonClicked" })
			await expect(task.ask("command", LATER_READ_COMMAND)).resolves.toMatchObject({
				response: "noButtonClicked",
			})
			expect(published.at(-1)).not.toHaveProperty("isAnswered", true)
		},
	)

	it("refreshes the cached command policy at a new step and reuses it while settings remain unchanged", async () => {
		const { task, state } = harness()
		await captureRequest(task)
		const original = capturedStep(task)
		state.allowedCommands.push(LATER_READ_COMMAND)
		state.deniedCommands.push("git push")
		await captureRequest(task)
		const next = capturedStep(task)

		expect(next.surface).not.toBe(original.surface)
		expect(next.surface.policy.digest).not.toBe(original.surface.policy.digest)
		expect(next.surface.policy.execution.command.allowedPrefixes).toEqual([READ_COMMAND, LATER_READ_COMMAND].sort())
		expect(next.surface.policy.execution.command.deniedPrefixes).toEqual(["git push"])
		expect(original.surface.policy.execution.command.allowedPrefixes).toEqual([READ_COMMAND])
		expect(original.surface.policy.execution.command.deniedPrefixes).toEqual([])
		await expect(task.ask("command", LATER_READ_COMMAND)).resolves.toMatchObject({ response: "yesButtonClicked" })
		await expect(task.ask("command", "git push origin main")).resolves.toMatchObject({
			response: "noButtonClicked",
		})
		await captureRequest(task)
		expect(capturedStep(task).surface).toBe(next.surface)
	})

	it("preserves primary workspace and outside-review policy when command rules are captured", async () => {
		const { task } = harness()
		await captureRequest(task)
		const { policy } = capturedStep(task).surface

		expect(policy.execution.workspaceRoots).toEqual([task.cwd])
		expect(policy.execution.outsideWorkspace).toBe("approval")
		expect(isPathAllowed(policy, "alpha-e2e-stream-read-proof.txt", task.cwd)).toBe(true)
		expect(isPathAllowed(policy, path.resolve(task.cwd, "..", "outside-proof.txt"))).toBe(false)
	})

	it("forks the exact callable parent catalog from the invoking step without sharing mutable names", async () => {
		const { task } = harness()
		await captureRequest(task)
		const { policy } = capturedStep(task).surface
		const invocation = task.getSubagentInvocationContext()
		expect(invocation?.allowedTools).toEqual(policy.allowedTools)
		invocation?.allowedTools?.push("ungranted-tool")
		expect(task.getSubagentInvocationContext()?.allowedTools).not.toContain("ungranted-tool")
	})

	it("retains the inherited child command ceiling and outside-workspace restriction", async () => {
		const { task, state, published } = harness()
		state.approvalMode = "auto"
		state.allowedCommands = ["*"]
		Object.assign(task, {
			taskKind: "subagent",
			subagentRole: "worker",
			taskApprovalMode: "auto",
			subagentContextManifest: {
				runtimePolicy: {
					autoApproval: {
						...disabledSubagentAutoApprovalPolicy,
						autoApprovalEnabled: true,
						alwaysAllowReadOnly: true,
						alwaysAllowWrite: true,
						alwaysAllowExecute: true,
						commandApproval: createSubagentCommandApprovalPolicy([READ_COMMAND], [], "a".repeat(64)),
					},
				},
			},
		})
		await captureRequest(task)

		const { policy } = capturedStep(task).surface
		expect(policy.execution.workspaceRoots).toEqual([task.cwd])
		expect(policy.execution.outsideWorkspace).toBeUndefined()
		expect(isPathAllowed(policy, "alpha-e2e-stream-read-proof.txt", task.cwd)).toBe(true)
		expect(isPathAllowed(policy, path.resolve(task.cwd, "..", "outside-proof.txt"))).toBe(false)
		await expect(task.ask("command", READ_COMMAND)).resolves.toMatchObject({ response: "yesButtonClicked" })
		await expect(task.ask("command", LATER_READ_COMMAND)).resolves.toMatchObject({ response: "noButtonClicked" })
		expect(published.at(-1)).not.toHaveProperty("isAnswered", true)
	})
})
