import type { ModelInfo, ProviderSettings } from "@alpha-code/types"
import * as vscode from "vscode"

import type { ApiHandler } from "../../../api"
import type { ApiStream } from "../../../api/transform/stream"
import { AgentStepContextBuilder, type AgentStepSnapshot } from "../../agent/AgentStepContextBuilder"
import { getSubagentCommandDecision } from "../../auto-approval/commands"
import { manageContext, willManageContext } from "../../context-management"
import { createTaskToolSurface } from "../../tools/TaskToolSurface"
import { ToolRegistry } from "../../tools/ToolRegistry"
import { AlphaProvider } from "../../webview/AlphaProvider"
import { buildNativeToolsArrayWithRestrictions } from "../build-tools"
import { Task } from "../Task"

vi.mock("../build-tools", async (importOriginal) => ({
	...(await importOriginal<typeof import("../build-tools")>()),
	buildNativeToolsArrayWithRestrictions: vi.fn(),
}))

vi.mock("../../context-management", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../context-management")>()),
	manageContext: vi.fn(),
	willManageContext: vi.fn(() => false),
}))

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => (resolve = done))
	return { promise, resolve }
}

function handler(id: string) {
	return {
		getModel: () => ({ id, info: { contextWindow: 128_000, maxTokens: 4096, supportsImages: true } as ModelInfo }),
		countTokens: vi.fn(async () => 10),
		prepareModel: vi.fn(async () => undefined),
		streamCapabilities: { lifecycle: true, cancellation: true },
		dispose: vi.fn(),
		createMessage: vi.fn<ApiHandler["createMessage"]>(async function* () {
			yield { type: "text", text: `${id} response` }
		}),
	} satisfies ApiHandler
}

function harness(apiConfigName: string | undefined, approvalMode: "ask" | "auto" = "ask") {
	const admittedHandler = handler("admitted-model")
	const admittedConfiguration: ProviderSettings = {
		apiProvider: "vertex",
		apiModelId: "admitted-model",
		reasoningEffort: "high",
	}
	const replacementHandler = handler("replacement-model")
	const replacementConfiguration: ProviderSettings = {
		apiProvider: "openai",
		openAiModelId: "replacement-model",
		reasoningEffort: "low",
	}
	const registry = new ToolRegistry({ includeBuiltIns: false })
	registry.register({
		name: "spawn_agent",
		aliases: [],
		schema: {
			type: "function",
			function: {
				name: "spawn_agent",
				description: "Spawn a child",
				parameters: { type: "object", properties: {} },
			},
		},
		capabilities: { concurrency: "serial", sideEffects: "none", controlFlow: true, requiresApproval: false },
		execute: vi.fn(async () => undefined),
	})
	const surface = createTaskToolSurface({
		registry,
		applyProfile: false,
		approvalMode,
		autoApprovalEnabled: approvalMode === "auto",
	})
	const liveState = {
		mode: "code",
		approvalMode,
		autoCondenseContext: false,
		autoApprovalEnabled: approvalMode === "auto",
		alwaysAllowWriteProtected: false,
		allowedCommands: ["git diff"],
		deniedCommands: ["git push"],
	}
	const provider = {
		getState: vi.fn(async () => structuredClone(liveState)),
	}
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "subagent-provider-boundary",
		instanceId: "subagent-provider-boundary-instance",
		taskKind: "primary",
		workspacePath: process.cwd(),
		abort: false,
		taskCancellationController: new AbortController(),
		api: admittedHandler,
		apiConfiguration: admittedConfiguration,
		effectiveApiConfiguration: { ...admittedConfiguration },
		_taskApiConfigName: apiConfigName,
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
		apiConversationHistory: [{ role: "user", content: "Original human request" }],
		clineMessages: [],
		agentTurnStep: 0,
		agentStepContextBuilder: new AgentStepContextBuilder<ApiHandler, unknown>(),
		getTaskMode: vi.fn(async () => "code"),
		getSystemPrompt: vi.fn(async () => "Admitted system prompt"),
		getCurrentProfileId: vi.fn(async () => "admitted-profile-id"),
		getTokenUsage: vi.fn(() => ({ contextTokens: 0 })),
		getTaskAllowedToolNames: () => undefined,
		shouldExposeAgentLifecycleTools: () => false,
		autoApprovalHandler: { checkAutoApprovalLimits: vi.fn(async () => ({ shouldProceed: true })) },
		ensureCanonicalLifecycleStepStarted: vi.fn(async () => undefined),
		publishCanonicalLifecyclePhase: vi.fn(async () => undefined),
		appendAgentTurnEvent: vi.fn(async () => undefined),
		publishCanonicalLifecyclePendingToolResults: vi.fn(async () => undefined),
		saveApiConversationHistory: vi.fn(async () => true),
		settleAllPersistedWaitAgentResultClaims: vi.fn(async () => undefined),
	}) as Task
	vi.mocked(buildNativeToolsArrayWithRestrictions).mockResolvedValue({
		tools: structuredClone([...surface.schemas]),
		allowedFunctionNames: [...surface.allowedFunctionNames],
		surface,
	})
	vi.mocked(manageContext).mockImplementation(async ({ messages }) => ({
		messages,
		summary: "",
		cost: 0,
		prevContextTokens: 0,
	}))
	const replaceLiveProfile = () => {
		task.api = replacementHandler
		task.apiConfiguration = replacementConfiguration
		Reflect.set(task, "effectiveApiConfiguration", { ...replacementConfiguration })
		task.setTaskApiConfigName("Replacement profile")
	}
	return {
		task,
		provider,
		liveState,
		admittedHandler,
		admittedConfiguration,
		replacementHandler,
		replacementConfiguration,
		replaceLiveProfile,
	}
}

function capturedStep(task: Task) {
	return Reflect.get(task, "currentAgentStep") as {
		snapshot: AgentStepSnapshot<ApiHandler, unknown>
		requestId: string
		stepId: string
	}
}

async function* failBeforeFirstChunk(): ApiStream {
	yield* []
	throw new Error("First stream failed")
}

describe("Task subagent invoking provider boundary", () => {
	beforeEach(() => vi.clearAllMocks())
	afterEach(() => vi.restoreAllMocks())

	it.each(["named", "unnamed"] as const)(
		"keeps the admitted %s profile and matching name when live settings change during model preflight",
		async (kind) => {
			const admittedName = kind === "named" ? "Admitted profile" : undefined
			const { task, admittedHandler, admittedConfiguration, replacementHandler, replaceLiveProfile } =
				harness(admittedName)
			const entered = deferred()
			const released = deferred()
			admittedHandler.prepareModel.mockImplementationOnce(async () => {
				entered.resolve()
				await released.promise
			})
			const request = task.attemptApiRequest(0, { skipProviderRateLimit: true, ownerHandlesRetry: true })
			const firstChunk = request.next()
			void firstChunk.catch(() => undefined)
			try {
				await entered.promise
				expect(admittedHandler.createMessage).not.toHaveBeenCalled()
				replaceLiveProfile()
				released.resolve()
				await expect(firstChunk).resolves.toMatchObject({
					value: { type: "text", text: "admitted-model response" },
				})

				expect(admittedHandler.createMessage).toHaveBeenCalledOnce()
				expect(replacementHandler.createMessage).not.toHaveBeenCalled()
				expect(capturedStep(task).snapshot.runtime.getHandler()).toBe(admittedHandler)
				expect(capturedStep(task).snapshot.context.provider).toMatchObject({
					apiProvider: "vertex",
					modelId: "admitted-model",
				})
				const invocation = task.getSubagentInvocationContext()
				expect(invocation).toBeDefined()
				expect(invocation!.apiConfiguration).toEqual(admittedConfiguration)
				expect(invocation!.apiConfigName).toBe(admittedName)
				expect(invocation!.modelRoute).toMatchObject({
					provider: "vertex",
					modelId: "admitted-model",
					profileName: admittedName ?? "Parent profile",
				})
			} finally {
				released.resolve()
				await request.return(undefined)
			}
		},
	)

	it("freezes the resolved approval grant before model preparation and retains it through a transport retry", async () => {
		const { task, provider, liveState, admittedHandler } = harness("Admitted profile", "auto")
		const policyOwner = Object.create(AlphaProvider.prototype) as AlphaProvider
		const configurationReads = vi.spyOn(vscode.workspace, "getConfiguration")
		const returnedPolicies: Array<ReturnType<AlphaProvider["snapshotSubagentAutoApprovalPolicy"]>> = []
		const snapshot = vi.fn<AlphaProvider["snapshotSubagentAutoApprovalPolicy"]>(
			(settings, commandListsResolved) => {
				const readsBeforeSnapshot = configurationReads.mock.calls.length
				const policy = policyOwner.snapshotSubagentAutoApprovalPolicy(settings, commandListsResolved)
				expect(configurationReads).toHaveBeenCalledTimes(readsBeforeSnapshot)
				returnedPolicies.push(policy)
				return policy
			},
		)
		Object.assign(provider, { snapshotSubagentAutoApprovalPolicy: snapshot })
		const entered = deferred()
		const released = deferred()
		admittedHandler.prepareModel.mockImplementationOnce(async () => {
			entered.resolve()
			await released.promise
		})
		admittedHandler.createMessage.mockImplementationOnce(failBeforeFirstChunk)
		const request = task.attemptApiRequest(0, { skipProviderRateLimit: true, ownerHandlesRetry: true })
		const firstChunk = request.next()
		void firstChunk.catch(() => undefined)
		try {
			await entered.promise
			expect(snapshot).toHaveBeenCalledOnce()
			expect(snapshot).toHaveBeenCalledWith(
				expect.objectContaining({
					approvalMode: "auto",
					alwaysAllowWriteProtected: false,
					allowedCommands: ["git diff"],
					deniedCommands: ["git push"],
				}),
				true,
			)
			const returnedPolicy = returnedPolicies[0]
			const admittedPolicy = structuredClone(returnedPolicy)
			liveState.alwaysAllowWriteProtected = true
			liveState.deniedCommands = []
			released.resolve()
			await expect(firstChunk).rejects.toThrow("First stream failed")

			const invocation = task.getSubagentInvocationContext()!
			expect(invocation.autoApprovalPolicy).toEqual(admittedPolicy)
			expect(invocation.autoApprovalPolicy!.alwaysAllowWriteProtected).toBe(false)
			expect(
				getSubagentCommandDecision("git push origin HEAD", invocation.autoApprovalPolicy!.commandApproval),
			).toBe("auto_deny")
			expect(JSON.stringify(invocation.autoApprovalPolicy)).not.toContain("git push")
			expect(capturedStep(task).snapshot.context.policy.approval.mode).toBe("auto")

			// Neither the bridge's returned object nor an accessor's copy owns the private ceiling.
			returnedPolicy.alwaysAllowWriteProtected = true
			returnedPolicy.commandApproval.denied = []
			invocation.autoApprovalPolicy!.alwaysAllowWriteProtected = true
			invocation.autoApprovalPolicy!.commandApproval.denied = []
			expect(task.getSubagentInvocationContext()!.autoApprovalPolicy).toEqual(admittedPolicy)

			for await (const _chunk of task.attemptApiRequest(1, {
				skipProviderRateLimit: true,
				ownerHandlesRetry: true,
				retryCategory: "transport",
			})) {
				/* consume the retained attempt */
			}
			expect(task.getSubagentInvocationContext()!.autoApprovalPolicy).toEqual(admittedPolicy)
			expect(admittedHandler.prepareModel).toHaveBeenCalledOnce()

			for await (const _chunk of task.attemptApiRequest(0, {
				skipProviderRateLimit: true,
				ownerHandlesRetry: true,
			})) {
				/* consume the next step under its newly captured grant */
			}
			const nextPolicy = task.getSubagentInvocationContext()!.autoApprovalPolicy!
			expect(nextPolicy.alwaysAllowWriteProtected).toBe(true)
			expect(getSubagentCommandDecision("git push origin HEAD", nextPolicy.commandApproval)).toBe("auto_approve")
			expect(snapshot).toHaveBeenLastCalledWith(
				expect.objectContaining({ approvalMode: "auto", alwaysAllowWriteProtected: true, deniedCommands: [] }),
				true,
			)
		} finally {
			released.resolve()
			await request.return(undefined)
		}
	})

	it("retains the admitted child route across a transport retry and adopts the replacement on a new step", async () => {
		const { task, admittedHandler, replacementHandler, replacementConfiguration, replaceLiveProfile } =
			harness("Admitted profile")
		admittedHandler.createMessage.mockImplementationOnce(failBeforeFirstChunk)
		await expect(
			task.attemptApiRequest(0, { skipProviderRateLimit: true, ownerHandlesRetry: true }).next(),
		).rejects.toThrow("First stream failed")
		const original = task.getSubagentInvocationContext()
		const originalStep = capturedStep(task)
		replaceLiveProfile()

		for await (const _chunk of task.attemptApiRequest(1, {
			skipProviderRateLimit: true,
			ownerHandlesRetry: true,
			retryCategory: "transport",
		})) {
			/* consume the retained attempt */
		}
		expect(task.getSubagentInvocationContext()).toEqual(original)
		expect(capturedStep(task).requestId).toBe(originalStep.requestId)
		expect(capturedStep(task).stepId).toBe(originalStep.stepId)
		expect(admittedHandler.prepareModel).toHaveBeenCalledOnce()
		expect(admittedHandler.createMessage).toHaveBeenCalledTimes(2)
		expect(replacementHandler.createMessage).not.toHaveBeenCalled()

		for await (const _chunk of task.attemptApiRequest(0, {
			skipProviderRateLimit: true,
			ownerHandlesRetry: true,
		})) {
			/* consume the new logical step */
		}
		expect(replacementHandler.prepareModel).toHaveBeenCalledOnce()
		expect(replacementHandler.createMessage).toHaveBeenCalledOnce()
		expect(capturedStep(task).requestId).not.toBe(originalStep.requestId)
		expect(task.getSubagentInvocationContext()).toMatchObject({
			apiConfiguration: replacementConfiguration,
			apiConfigName: "Replacement profile",
			modelRoute: {
				provider: "openai",
				modelId: "replacement-model",
				profileName: "Replacement profile",
			},
		})
	})
})
