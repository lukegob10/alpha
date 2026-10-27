import EventEmitter from "events"
import fs from "fs/promises"
import os from "os"
import * as path from "path"
import i18next from "i18next"
import common from "../../../i18n/locales/en/common.json"

import { managedSubagentWorktreeService } from "@alpha-code/core"
import {
	finalizedSubagentContextManifestSchema,
	managedAgentTreeProjectionSchema,
	AlphaCodeEventName,
	subagentRootOrchestrationSummarySchema,
	TaskLifecycleState,
	TaskStatus,
	subagentContextManifestSchema,
	type SubagentGroupState,
} from "@alpha-code/types"

import { AlphaProvider } from "../AlphaProvider"
import { TaskSessionRegistry } from "../TaskSessionRegistry"
import { Task } from "../../task/Task"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { AsyncSubagentRunManager } from "../../agent/AsyncSubagentRunManager"
import { AgentControlStore, InMemoryAgentControlPersistence } from "../../agent/AgentControlStore"
import { BoundedDelegationManager, type InternalTaskRunner } from "../../agent/BoundedDelegationManager"
import { buildInternalTaskEnvelope } from "../../agent/InternalTaskEnvelope"
import {
	captureSubagentContext,
	isValidSubagentContextManifest,
	serializeSubagentContextManifest,
} from "../../agent/SubagentContextCapture"
import { digestValue } from "../../agent/StepContext"
import { SUBAGENT_CALLSIGNS, SubagentNicknameRegistry } from "../../agent/SubagentNicknameRegistry"
import { readTaskMessages, saveTaskMessages } from "../../task-persistence"
import { WorkspaceMutationCancelledError, WorkspaceMutationGate } from "../../task/WorkspaceMutationGate"
import { serializeAgentNotification } from "../../task-persistence/agentNotifications"
import { getSkillsCatalogSection, type SkillCatalogEntry } from "../../prompts/sections/skills"
import { GoalController } from "../../agent/goals/GoalController"
import type { GoalAccountingBinding } from "../../agent/GoalStepAccounting"
import { TaskGoalStore } from "../../task-persistence/TaskGoalStore"
import { GoalAccountingBindingStore } from "../../agent/goals/GoalAccountingBindingStore"
import { ShadowCheckpointService } from "../../../services/checkpoints/ShadowCheckpointService"
import { captureVerificationContent } from "../../agent/VerificationScope"

afterEach(() => vi.restoreAllMocks())

beforeAll(() => {
	i18next.addResourceBundle("en", "common", common, true, true)
})

const makeProviderHarness = (
	availableCapacity = 2,
	routingSettings: {
		subagentDefaultApiConfigId?: string
		subagentDefaultModel?: string
		subagentDefaultReasoningEffort?: "low" | "medium" | "high"
		subagentsEnabled?: boolean
		subagentAgentTypes?: Record<
			string,
			{
				description: string
				role?: "default" | "explore" | "review" | "worker"
				apiConfigId?: string
				model?: string
				reasoningEffort?: "low" | "medium" | "high"
				developerInstructions?: string
			}
		>
		subagentApiConfigByRole?: { explore?: string; review?: string; worker?: string }
		maxConcurrentSubagents?: number
		subagentDelegationPolicy?: "explicit-only" | "proactive"
		subagentMaxDepth?: number
		subagentRoleTimeoutsMs?: { explore?: number; review?: number; worker?: number }
		subagentMaxInputTokens?: number
		subagentMaxOutputTokens?: number
		subagentRootTokenBudget?: number | null
		subagentRootCostBudget?: number | null
		approvalMode?: "ask" | "auto" | "bypass"
		autoApprovalEnabled?: boolean
		alwaysAllowSubagents?: boolean
		alwaysAllowTickets?: boolean
		alwaysAllowReadOnly?: boolean
		alwaysAllowWrite?: boolean
		alwaysAllowReadOnlyOutsideWorkspace?: boolean
		alwaysAllowWriteOutsideWorkspace?: boolean
		alwaysAllowWriteProtected?: boolean
		alwaysAllowExecute?: boolean
		allowedCommands?: string[]
		deniedCommands?: string[]
	} = {},
	profiles: Array<Record<string, any>> = [],
) => {
	const agentControlStore = new AgentControlStore(new InMemoryAgentControlPersistence())
	const agentControlStoreReady = agentControlStore.initialize()
	const taskSessions = new TaskSessionRegistry(3)
	for (let index = 0; index < 3 - availableCapacity; index++) {
		taskSessions.register(
			{ taskId: `capacity-fixture-${index}`, taskKind: "primary", alphaMessages: [] } as unknown as Task,
			{ focus: false },
		)
	}
	const historyItems = new Map([
		[
			"parent-1",
			{
				id: "parent-1",
				number: 1,
				ts: 1,
				task: "parent",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			},
		],
	])
	const provider = Object.assign(Object.create(AlphaProvider.prototype), {
		agentControlStoreLoadedAt: Date.now(),
		contextProxy: {
			getValues: () => routingSettings,
			setValues: vi.fn(async (values: Record<string, unknown>) => Object.assign(routingSettings, values)),
		},
		providerSettingsManager: {
			getProfile: vi.fn(async (query: { id?: string; name?: string }) => {
				const profile = profiles.find((candidate) => candidate.id === query.id || candidate.name === query.name)
				if (!profile) throw new Error("Profile not found")
				return structuredClone(profile)
			}),
		},
		taskSessions,
		getSkillsManager: vi.fn(async () => Reflect.get(provider, "skillsManager")),
		taskHistoryStore: {
			get: () => undefined,
			getAll: () => [],
			upsert: vi.fn(async (item: any) => {
				historyItems.set(item.id, item)
			}),
		},
		subagentNicknameRegistry: new SubagentNicknameRegistry({ pickIndex: () => 0 }),
		preparedSubagentGroups: new Map(),
		subagentGroupControllers: new Map(),
		reservedSubagentSlots: new Map(),
		exhaustedSubagentRootBudgets: new Map(),
		publishedSubagentResults: new Set(),
		subagentDescriptors: new Map(),
		agentControlStore,
		agentControlStoreReady,
		agentControlRootStatusWrites: new Map(),
		taskLifecycleHistoryWrites: new Map(),
		agentFollowupAdmissions: new Map(),
		subagentRunFinalizations: new Map(),
		subagentResidencyEvictions: new Map(),
		agentLifecycleJournals: new Map(),
		agentLifecycleProjector: { clear: vi.fn() },
		agentLifecycleDegradedSignals: new Map(),
		publishedTaskTranscriptRevisions: new Map(),
		taskEventListeners: new Map(),
		taskStack: [],
		pendingManagedTaskCompletions: new Map(),
		workspaceMutationGate: new WorkspaceMutationGate(),
		boundedDelegationManager: { cancel: () => false },
		asyncSubagentRunManager: {
			cancel: () => false,
			getEvents: () => [],
			getSnapshot: () => undefined,
			getRunId: () => undefined,
			acknowledgeEvents: () => false,
			unload: () => false,
			listSnapshots: () => [],
			waitForResult: () => undefined,
			resolveRunTaskId: () => undefined,
		},
		getTaskWithId: vi.fn(async (taskId: string) => ({ historyItem: historyItems.get(taskId) })),
		updateTaskHistory: vi.fn(async (item: any) => {
			historyItems.set(item.id, item)
			return [...historyItems.values()]
		}),
		postTaskSessionStateToWebview: vi.fn().mockResolvedValue(undefined),
		postStateToWebviewWithoutTaskHistory: vi.fn().mockResolvedValue(undefined),
		log: vi.fn(),
	}) as AlphaProvider
	;(provider as any).__historyItems = historyItems
	return provider
}

const makeParent = () => ({
	admitAgentMessage: async (persist: () => Promise<unknown>) => persist(),
	taskId: "parent-1",
	taskKind: "primary",
	metadata: { task: "parent" },
	alphaMessages: [] as any[],
	apiConversationHistory: [] as any[],
	cwd: "F:/workspace",
	historyWorkspacePath: "F:/workspace",
	apiConfiguration: { apiProvider: "openai", openAiModelId: "alpha-model" },
	getTaskMode: vi.fn(async () => "code"),
	getTaskApiConfigName: vi.fn(async () => "Parent"),
	captureEffectiveInheritedInstructions: vi.fn(async () => ({
		effectiveText: "Language Preference: English",
		sources: [
			{
				kind: "aggregate",
				ref: "task:parent-1:effective-instructions:code",
				text: "Language Preference: English",
			},
		],
	})),
	getTaskCancellationSignal: vi.fn(() => new AbortController().signal),
	getTaskLifetimeCancellationSignal: vi.fn(() => new AbortController().signal),
	beginAgentWait: vi.fn(() => ({ signal: new AbortController().signal, dispose: vi.fn() })),
	forgetWaitAgentResultClaim: vi.fn(),
	hasRetainedWaitAgentResultClaim: vi.fn(() => false),
	hasDurablyPersistedWaitAgentClaim: vi.fn(() => false),
	stageWaitAgentNotifications: vi.fn(),
	getCommandExecutionEvidence: vi.fn(() => []),
	getSubagentFileWriteScope: vi.fn(() => []),
	emit: vi.fn(),
	say: vi.fn(async () => undefined),
	upsertSubagentGroup: vi.fn<(group: SubagentGroupState) => Promise<void>>(async () => undefined),
})

/** Use the real Task delivery fence while isolating transcript storage from the extension host. */
const makeMailboxRecipient = (provider: AlphaProvider, history: ApiMessage[] = []) => {
	const fields = {
		...makeParent(),
		abort: false,
		apiConversationHistory: history,
		providerRef: { deref: () => provider },
		agentMessageAdmissions: new Set(),
		agentMessageInbox: { deliver: async () => undefined, hasPending: () => false },
		saveApiConversationHistory: vi.fn(async () => true),
		addToApiConversationHistory: vi.fn(async (message: ApiMessage) => {
			history.push(message)
			return true
		}),
	}
	const task = Object.defineProperties(
		Object.create(Task.prototype),
		Object.fromEntries(
			Object.entries(fields).map(([key, value]) => [key, { value, writable: true, configurable: true }]),
		),
	) as Task
	return task
}

function ownedFinalization(entry: Promise<void> | { readonly promise: Promise<void> } | undefined) {
	return entry && ("promise" in entry ? entry.promise : entry)
}

describe("AlphaProvider root lifecycle ownership", () => {
	it.each(["pending", "completed", "interrupted", "failed", "timed_out", "cancelling"] as const)(
		"preserves a %s root during completion and evidence reconciliation",
		async (status) => {
			const provider = makeProviderHarness()
			const parent = makeParent()
			const store = Reflect.get(provider, "agentControlStore") as AgentControlStore
			await Reflect.get(provider, "agentControlStoreReady")
			await store.ensureRoot({
				taskId: parent.taskId,
				objective: "Retained task",
				status: status === "pending" ? "pending" : "running",
			})
			if (status !== "pending") await store.updateAgentStatus(parent.taskId, status, {}, parent.taskId)

			await provider.recordParentVerificationEvidence(parent as any)
			await provider.getParentCompletionDecision(parent as any)

			expect(store.getAgent(parent.taskId, parent.taskId)?.status).toBe(status)
		},
	)

	it("waits for an admitted lifecycle resume before resolving the root for immediate child work", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const store = Reflect.get(provider, "agentControlStore") as AgentControlStore
		await Reflect.get(provider, "agentControlStoreReady")
		await store.ensureRoot({ taskId: parent.taskId, objective: "Completed task", status: "running" })
		await provider.prepareTaskCompletionLifecycle(parent.taskId)
		let entered!: () => void
		const writing = new Promise<void>((resolve) => {
			entered = resolve
		})
		let release!: () => void
		const pending = new Promise<void>((resolve) => {
			release = resolve
		})
		const update = store.updateAgentStatus.bind(store)
		const statusWrites = vi.spyOn(store, "updateAgentStatus").mockImplementation(async (...args) => {
			if (args[1] === "pending") {
				entered()
				await pending
			}
			return update(...args)
		})
		const resume = (provider as any).updateAgentControlRootStatus(parent.taskId, "running") as Promise<void>
		await writing
		const resolving = (provider as any).ensureAgentControlRoot(parent) as Promise<{ status: string }>
		release()
		await expect(resolving).resolves.toMatchObject({ status: "running" })
		await resume
		expect(statusWrites.mock.calls.map(([, status]) => status)).toEqual(["pending", "running"])
		await expect(
			store.createAgent({
				taskId: "resumed-child",
				parentTaskId: parent.taskId,
				rootTaskId: parent.taskId,
				nickname: "resumed_child",
				role: "explore",
				objective: "Inspect resumed work",
				status: "pending",
			}),
		).resolves.toMatchObject({ parentTaskId: parent.taskId })
	})
})

describe("AlphaProvider bounded sub-agent preparation", () => {
	it("cancels Worker Git preparation before creating a child Task", async () => {
		const provider = makeProviderHarness()
		Reflect.set(provider, "context", { globalStorageUri: { fsPath: "F:/storage" } })
		const parent = makeParent()
		vi.spyOn(managedSubagentWorktreeService, "validateScope").mockResolvedValue({
			gitRoot: parent.cwd,
			logicalWorkspace: parent.cwd,
			logicalWorkspaceFromRoot: "",
			writeScope: ["value.ts"],
			gitRelativeScope: ["value.ts"],
			fileWriteScope: ["value.ts"],
			gitRelativeFileScope: ["value.ts"],
		})
		const prepared = await provider.prepareSubagentGroup(parent as unknown as Task, [
			{ objective: "Correct the source", agent_kind: "worker", write_scope: ["value.ts"] },
		])
		Reflect.get(provider, "finalizePreparedSubagentAuthorization").call(provider, prepared)
		const cancellation = new AbortController()
		let enterCreation!: () => void
		const creationEntered = new Promise<void>((resolve) => (enterCreation = resolve))
		const createTask = vi.fn()
		Reflect.set(provider, "createTask", createTask)
		vi.spyOn(managedSubagentWorktreeService, "create").mockImplementation(
			async (_storage, _taskId, _scope, options) => {
				expect(options?.signal).toBe(cancellation.signal)
				enterCreation()
				return await new Promise<never>((_resolve, reject) =>
					options!.signal.addEventListener("abort", () => reject(options!.signal.reason), { once: true }),
				)
			},
		)
		const run = Reflect.get(provider, "runSubagentEnvelope").call(
			provider,
			prepared.envelopes[0],
			cancellation.signal,
		) as Promise<unknown>
		void run.catch(() => undefined)
		await creationEntered
		const reason = new Error("Parent stopped during Git preparation")
		cancellation.abort(reason)
		await expect(run).rejects.toBe(reason)
		expect(createTask).not.toHaveBeenCalled()
	})

	it("publishes durable changed-file metadata for an inherited-permission Review result", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-shared-review-result-"))
		try {
			const provider = makeProviderHarness(2, { approvalMode: "bypass" })
			Reflect.set(provider, "context", { globalStorageUri: { fsPath: workspace } })
			const parent = { ...makeParent(), cwd: workspace, historyWorkspacePath: workspace }
			const prepared = await provider.prepareSubagentGroup(parent as unknown as Task, {
				task_name: "shared_correction",
				agent_type: "review",
				message: "Implement the authorized source correction",
			})
			await Reflect.get(provider, "ensurePreparedSubagentControlRecords").call(provider, parent, prepared)
			Reflect.set(
				provider,
				"createTask",
				vi.fn(async (_text: string, _images: unknown, _parent: unknown, options: Record<string, unknown>) => {
					const child = Object.assign(new EventEmitter(), options, {
						taskId: prepared.envelopes[0].id,
						cwd: workspace,
						alphaMessages: [{ type: "say", say: "completion_result", text: "Corrected the source." }],
						getTokenUsage: () => ({ totalTokensIn: 1, totalTokensOut: 1 }),
						getTaskLifetimeCancellationSignal: () => new AbortController().signal,
						persistFrozenSubagentInstructions: vi.fn(async () => undefined),
						finalizeSubagentHistory: vi.fn(async () => undefined),
						start: () => {
							void (async () => {
								await provider.reservePrimaryMutation(child as unknown as Task, "review-edit")
								await fs.writeFile(path.join(workspace, "value.ts"), "export const value = 2\n")
								await provider.recordPrimaryMutation(
									child as unknown as Task,
									await captureVerificationContent(workspace, ["value.ts"]),
									false,
									"review-edit",
								)
								child.emit(AlphaCodeEventName.TaskCompleted, child.taskId, child.getTokenUsage())
							})().catch((error: unknown) => child.emit("error", error))
						},
					})
					return child
				}),
			)
			const result = await Reflect.get(provider, "runSubagentEnvelope").call(
				provider,
				prepared.envelopes[0],
				new AbortController().signal,
			)
			expect(result).toMatchObject({ status: "completed", changedFiles: ["value.ts"] })
			expect(prepared.group.agents[0].changedFiles).toEqual(["value.ts"])
			expect(prepared.group.agents[0].requiresParentVerification).toBe(true)
		} finally {
			await fs.rm(workspace, { recursive: true, force: true })
		}
	})

	it.each(["explorer", "review"])(
		"allows an inherited-permission %s to delegate a Worker within its captured authority",
		async (agentType) => {
			const provider = makeProviderHarness(3, { maxConcurrentSubagents: 3, approvalMode: "bypass" })
			const root = makeParent()
			const direct = await provider.prepareSubagentGroup(root as unknown as Task, {
				task_name: "authorized_parent",
				agent_type: agentType,
				message: "Coordinate the authorized correction",
			})
			const manifest = Reflect.get(provider, "subagentDescriptors").get(direct.envelopes[0].id).contextManifest
			const parent = {
				...makeParent(),
				taskId: direct.envelopes[0].id,
				rootTaskId: root.taskId,
				taskKind: "subagent",
				subagentRole: direct.group.agents[0].role,
				subagentContextManifest: manifest,
			}
			vi.spyOn(managedSubagentWorktreeService, "validateScope").mockImplementation(
				async (workspacePath, scope) => ({
					gitRoot: workspacePath,
					logicalWorkspace: workspacePath,
					logicalWorkspaceFromRoot: "",
					writeScope: scope,
					gitRelativeScope: scope,
					fileWriteScope: [],
					gitRelativeFileScope: [],
				}),
			)

			const nested = await provider.prepareSubagentGroup(parent as unknown as Task, {
				task_name: "authorized_worker",
				agent_type: "worker",
				message: "Implement the authorized correction",
			})
			expect(nested.envelopes[0]).toMatchObject({
				parentTaskId: parent.taskId,
				rootTaskId: root.taskId,
				depth: 2,
				policy: { mutate: true, delegate: true },
				scope: { workspaceRoots: [path.resolve(parent.cwd)], allowedPaths: [path.resolve(parent.cwd)] },
			})
		},
	)

	it.each(["explorer", "review"])("inherits Full Access and the captured tool catalog for %s", async (agentType) => {
		const provider = makeProviderHarness(2, { approvalMode: "bypass" })
		const parent = makeParent()
		const instructions = await parent.captureEffectiveInheritedInstructions()
		Object.assign(parent, {
			getSubagentInvocationContext: () => ({
				mode: "code",
				apiConfiguration: parent.apiConfiguration,
				apiConfigName: "Parent",
				modelRoute: {
					source: "parent",
					resolution: "selected",
					profileName: "Parent",
					provider: "openai",
					modelId: "alpha-model",
				},
				history: [],
				finalAssistantMessageIndexes: [],
				instructions,
				allowedTools: [
					"exec_command",
					"apply_patch",
					"use_mcp_tool",
					"mcp__docs__search",
					"create_ticket",
					"spawn_agent",
				],
			}),
		})
		const prepared = await provider.prepareSubagentGroup(parent as any, {
			task_name: "inherit_permissions",
			agent_type: agentType,
			message: "Run the requested checks and implement the authorized correction",
		})
		const policy = Reflect.get(provider, "subagentDescriptors").get(prepared.envelopes[0].id).contextManifest
			.runtimePolicy
		expect(policy).toMatchObject({
			authorityModel: "parent",
			mode: "code",
			execute: true,
			mutate: true,
			network: true,
			externalSideEffects: true,
			writeScope: ["."],
			autoApproval: { alwaysAllowWrite: true, alwaysAllowExecute: true, alwaysAllowMcp: true },
		})
		expect(policy.allowedTools).toEqual(
			expect.arrayContaining(["apply_patch", "use_mcp_tool", "mcp--docs--search", "create_ticket"]),
		)
		expect(policy.allowedTools).not.toContain("delete_ticket")
		expect(prepared.requiresExplicitApproval).toBe(false)
	})

	it("keeps a new agent in its parent's Plan mode and write ceiling", async () => {
		const provider = makeProviderHarness(2, { approvalMode: "bypass" })
		const parent = makeParent()
		parent.getTaskMode.mockResolvedValue("architect")
		const prepared = await provider.prepareSubagentGroup(parent as any, {
			task_name: "plan_inspection",
			agent_type: "explorer",
			message: "Inspect the implementation",
		})
		const policy = Reflect.get(provider, "subagentDescriptors").get(prepared.envelopes[0].id).contextManifest
			.runtimePolicy
		expect(policy).toMatchObject({
			authorityModel: "parent",
			mode: "architect",
			mutate: false,
			network: false,
			externalSideEffects: false,
		})
		expect(policy.allowedTools).not.toContain("apply_patch")
		expect(policy.allowedTools).not.toContain("use_mcp_tool")
	})
	it.each(["budget_limited", "paused", "complete", "replacement"] as const)(
		"retains the invoking goal owner through queued launch after %s",
		async (stop) => {
			const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-goal-spawn-"))
			try {
				const provider = makeProviderHarness()
				Reflect.set(provider, "context", { globalStorageUri: { fsPath: storagePath } })
				const controller = new GoalController({
					taskId: "parent-1",
					store: new TaskGoalStore(storagePath, "parent-1"),
				})
				const goal = await controller.create({ objective: "Original objective", tokenBudget: 100 }, "user")
				const binding: GoalAccountingBinding = {
					controller,
					goalId: goal.goalId,
					goalTaskId: goal.taskId,
					controlVersion: goal.controlVersion,
					requestGeneration: controller.getRequestGeneration(),
				}
				const captured: Promise<GoalAccountingBinding | undefined> = Promise.resolve(binding)
				const parent = Object.assign(makeParent(), { captureGoalAccountingBinding: vi.fn(() => captured) })
				const prepared = await provider.prepareSubagentGroup(parent as unknown as Task, [
					{ objective: "Inspect the parser", agent_kind: "review" },
				])
				await expect(
					new GoalAccountingBindingStore(storagePath, prepared.envelopes[0]!.id).read(),
				).resolves.toMatchObject({
					owner: { goalTaskId: parent.taskId, goalId: goal.goalId, controlVersion: goal.controlVersion },
				})
				if (stop === "budget_limited") await controller.recordUsage("response-usage", 100, 0, goal.goalId)
				else await controller.updateStatus(stop === "paused" ? "paused" : "complete")
				if (stop === "replacement") await controller.create({ objective: "Replacement objective" }, "user")
				// Simulate the invoking root step being released before queued work launches.
				parent.captureGoalAccountingBinding.mockReturnValue(Promise.resolve(undefined))
				const create = vi
					.spyOn(provider, "createTask")
					.mockImplementation(async (_text, _images, _parent, options) => {
						expect(options?.goalAccountingBinding).toBe(captured)
						const owner = await options?.goalAccountingBinding
						expect(owner?.goalId).toBe(goal.goalId)
						expect(owner?.controller.isRequestCurrent(goal.goalId, binding.requestGeneration)).toBe(false)
						const emitter = new EventEmitter()
						return Object.assign(emitter, {
							taskId: options?.taskId,
							taskKind: "subagent",
							rootTaskId: parent.taskId,
							alphaMessages: [
								{ type: "say", say: "completion_result", text: "Retained owner inspected." },
							],
							getTokenUsage: () => ({ totalTokensIn: 0, totalTokensOut: 0, totalCost: 0 }),
							persistFrozenSubagentInstructions: vi.fn(async () => undefined),
							finalizeSubagentHistory: vi.fn(async () => undefined),
							cancelCurrentRequest: vi.fn(),
							abortTask: vi.fn(async () => undefined),
							start: () => emitter.emit(AlphaCodeEventName.TaskCompleted, options?.taskId, {}),
						}) as unknown as Task
					})
				Reflect.get(provider, "finalizePreparedSubagentAuthorization").call(provider, prepared)
				await Reflect.get(provider, "runSubagentEnvelope").call(
					provider,
					prepared.envelopes[0],
					new AbortController().signal,
				)
				expect(create).toHaveBeenCalledOnce()
				expect(parent.captureGoalAccountingBinding).toHaveBeenCalledOnce()
			} finally {
				await fs.rm(storagePath, { recursive: true, force: true })
			}
		},
	)

	it("persists a no-goal owner before a queued child can adopt a future root objective", async () => {
		const storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-goal-spawn-"))
		try {
			const provider = makeProviderHarness()
			Reflect.set(provider, "context", { globalStorageUri: { fsPath: storagePath } })
			const parent = Object.assign(makeParent(), {
				captureGoalAccountingBinding: vi.fn(async () => undefined),
			})
			const prepared = await provider.prepareSubagentGroup(parent as unknown as Task, [
				{ objective: "Inspect the parser", agent_kind: "review" },
			])
			await expect(
				new GoalAccountingBindingStore(storagePath, prepared.envelopes[0]!.id).read(),
			).resolves.toMatchObject({
				owner: null,
			})
		} finally {
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it.each(["auto", "bypass"] as const)(
		"keeps an Ask task's child authority below the global %s setting",
		async (approvalMode) => {
			const provider = makeProviderHarness(2, { approvalMode })
			const parent = { ...makeParent(), getStepApprovalMode: vi.fn(() => "ask") }
			const prepared = await provider.prepareSubagentGroup(parent as any, [
				{ objective: "Inspect under the parent task policy", agent_kind: "review" },
			])
			const descriptor = (provider as any).subagentDescriptors.get(prepared.envelopes[0].id)

			expect(prepared.requiresExplicitApproval).toBe(true)
			expect(descriptor.contextManifest.runtimePolicy.autoApproval).toMatchObject({
				alwaysAllowWrite: false,
				alwaysAllowExecute: false,
				alwaysAllowSubagents: false,
				alwaysAllowTickets: false,
				commandApproval: { allowAll: false },
			})
		},
	)

	it("narrows a Bypass task's child authority when the global setting is Ask", async () => {
		const provider = makeProviderHarness(2, { approvalMode: "ask" })
		const parent = { ...makeParent(), getStepApprovalMode: vi.fn(() => "bypass") }
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Respect the current narrower grant", agent_kind: "review" },
		])
		const descriptor = (provider as any).subagentDescriptors.get(prepared.envelopes[0].id)

		expect(prepared.requiresExplicitApproval).toBe(true)
		expect(descriptor.contextManifest.runtimePolicy.autoApproval).toMatchObject({
			alwaysAllowWrite: false,
			alwaysAllowExecute: false,
			alwaysAllowSubagents: false,
		})
	})

	it.each(["auto", "bypass"] as const)(
		"launches a default %s sub-agent without an approval dialog",
		async (approvalMode) => {
			const provider = makeProviderHarness(2, { approvalMode })
			const prepared = await provider.prepareSubagentGroup(makeParent() as any, [
				{ objective: "Inspect the workspace", agent_kind: "explore" },
			])
			expect(prepared.requiresExplicitApproval).toBe(false)
			const manifest = (provider as any).subagentDescriptors.get(prepared.envelopes[0].id).contextManifest
			expect(manifest.orchestration.delegationPolicy.authorization).toBe("session-policy")
		},
	)

	it("accepts a historical flat spawn request and retains its explicit approval", async () => {
		const provider = makeProviderHarness(2, { approvalMode: "ask", subagentDelegationPolicy: "explicit-only" })
		const parent = makeParent()
		const prepared = await provider.prepareSubagentGroup(parent as any, {
			task_name: "legacy_explore",
			objective: "Inspect the opened workspace only.",
			agent_kind: "explore",
			write_scope: null,
			expected_output: null,
		})
		expect(prepared.group.agents[0].role).toBe("explore")
		expect(prepared.requiresExplicitApproval).toBe(true)
	})

	it("does not freeze unavailable parent reasoning as an explicit custom agent override", async () => {
		const provider = makeProviderHarness(2, {
			subagentAgentTypes: {
				researcher: { description: "Inspects code", role: "explore", model: "configured-model" },
			},
		})
		const prepared = await provider.prepareSubagentGroup(makeParent() as any, {
			task_name: "research_agent",
			message: "Inspect the agent loop",
			agent_type: "researcher",
		})
		const descriptor = Reflect.get(provider, "subagentDescriptors").get(prepared.envelopes[0].id)
		expect(descriptor.modelRoute.apiConfiguration.openAiModelId).toBe("configured-model")
		expect(descriptor.modelRoute.apiConfiguration.reasoningEffort).toBeUndefined()
		expect(descriptor.modelRoute.apiConfiguration.enableReasoningEffort).toBeUndefined()
	})

	it("applies a named agent type after spawn defaults while inheriting the parent provider", async () => {
		const provider = makeProviderHarness(
			2,
			{
				subagentDefaultApiConfigId: "research-profile",
				subagentApiConfigByRole: { explore: "research-profile" },
				subagentAgentTypes: {
					researcher: {
						description: "Investigates code paths",
						role: "explore",
						apiConfigId: "research-profile",
						model: "configured-model",
						reasoningEffort: "medium",
						developerInstructions: "Cite the inspected source paths.",
					},
				},
			},
			[
				{
					id: "research-profile",
					name: "Research profile",
					apiProvider: "openai",
					openAiModelId: "original-model",
				},
			],
		)
		const parent = makeParent()
		const prepared = await provider.prepareSubagentGroup(parent as any, {
			task_name: "research_agent",
			message: "Inspect the agent loop",
			agent_type: "researcher",
			model: "spawn-model",
			reasoning_effort: "high",
		})
		expect(prepared.group.agents[0]).toMatchObject({
			role: "explore",
			modelRoute: {
				source: "spawn",
				profileName: "Parent",
				modelId: "configured-model",
				requestedModelId: "configured-model",
				requestedReasoningEffort: "medium",
			},
		})
		expect(prepared.group.agents[0].modelRoute?.profileId).toBeUndefined()
		const descriptor = (provider as any).subagentDescriptors.get(prepared.envelopes[0].id)
		expect(descriptor.inheritedInstructions).toContain("Cite the inspected source paths.")
		expect(descriptor.contextManifest.instructions.sources).toEqual(
			expect.arrayContaining([expect.objectContaining({ kind: "agent-type" })]),
		)
	})

	it.each(["none", "all", "1"] as const)(
		"applies a configured named type route and model for a %s history selection without widening Ask authority",
		async (forkTurns) => {
			const provider = makeProviderHarness(
				2,
				{
					approvalMode: "bypass",
					subagentDefaultApiConfigId: "default-profile",
					subagentApiConfigByRole: { review: "role-profile" },
					subagentAgentTypes: {
						auditor: {
							description: "Reviews independent evidence",
							role: "review",
							apiConfigId: "type-profile",
							model: "configured-type-model",
							reasoningEffort: "medium",
						},
					},
				},
				[
					{ id: "default-profile", name: "Default", apiProvider: "openai", openAiModelId: "default-model" },
					{ id: "role-profile", name: "Reviewer", apiProvider: "openai", openAiModelId: "role-model" },
					{
						id: "type-profile",
						name: "Auditor",
						apiProvider: "vertex",
						apiModelId: "profile-model",
						vertexJsonCredentials: "type-secret",
					},
				],
			)
			const parent = Object.assign(makeParent(), { getStepApprovalMode: vi.fn(() => "ask") })
			const prepared = await provider.prepareSubagentGroup(parent as any, {
				task_name: "audit_route",
				message: "Inspect the configured route",
				agent_type: "auditor",
				fork_turns: forkTurns,
			})
			const route = prepared.group.agents[0].modelRoute
			expect(route).toMatchObject({
				profileId: undefined,
				profileName: "Parent",
				provider: "openai",
				modelId: "configured-type-model",
				requestedReasoningEffort: "medium",
			})
			const descriptor = Reflect.get(provider, "subagentDescriptors").get(prepared.envelopes[0].id)
			expect(descriptor.modelRoute.apiConfiguration).toMatchObject({
				apiProvider: "openai",
				openAiModelId: "configured-type-model",
				reasoningEffort: "medium",
			})
			expect(prepared.inheritsParentPermissions).toBe(true)
			expect(prepared.requiresExplicitApproval).toBe(false)
			expect(descriptor.contextManifest.runtimePolicy).toMatchObject({
				authorityModel: "parent",
				mutate: true,
				execute: true,
				autoApproval: { alwaysAllowWrite: false, alwaysAllowExecute: false, alwaysAllowSubagents: false },
			})
			expect(JSON.stringify(prepared.group)).not.toContain("type-secret")
		},
	)

	it.each([
		["model", "spawn-model", "medium"],
		["effort", "configured-model", "high"],
	] as const)("applies the custom agent after a spawn %s choice", async (override, model, effort) => {
		const provider = makeProviderHarness(2, {
			subagentAgentTypes: {
				researcher: {
					description: "Inspects code",
					role: "review",
					model: "configured-model",
					reasoningEffort: "medium",
				},
			},
		})
		const prepared = await provider.prepareSubagentGroup(makeParent() as any, {
			task_name: "typed_override",
			message: "Inspect the effective model settings",
			agent_type: "researcher",
			fork_turns: "none",
			...(override === "model" ? { model } : { reasoning_effort: effort }),
		})
		expect(prepared.group.agents[0].modelRoute).toMatchObject({
			provider: "openai",
			modelId: "configured-model",
			requestedReasoningEffort: "medium",
		})
	})

	it("rejects an unconfigured named agent type before reserving capacity", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		await expect(
			provider.prepareSubagentGroup(parent as any, {
				task_name: "unknown_agent",
				message: "Inspect the agent loop",
				agent_type: "unconfigured",
			}),
		).rejects.toThrow("unknown agent_type 'unconfigured'")
		expect(parent.upsertSubagentGroup).not.toHaveBeenCalled()
	})

	it("turns a Codex default spawn into an approved editing worker with inherited provider overrides", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const validateScope = vi.spyOn(managedSubagentWorktreeService, "validateScope").mockResolvedValue({
			gitRoot: parent.cwd,
			logicalWorkspace: parent.cwd,
			logicalWorkspaceFromRoot: "",
			writeScope: ["."],
			gitRelativeScope: ["."],
			fileWriteScope: [],
			gitRelativeFileScope: [],
		})

		const prepared = await provider.prepareSubagentGroup(parent as any, {
			task_name: "implement_change",
			message: "Implement the requested change",
			model: "gpt-6-sol",
			reasoning_effort: "high",
		})

		expect(validateScope).toHaveBeenCalledWith(parent.cwd, ["."], { allowWorkspaceRoot: true })
		expect(prepared.group.agents[0]).toMatchObject({
			role: "worker",
			writeScope: ["."],
			modelRoute: {
				source: "spawn",
				provider: "openai",
				modelId: "gpt-6-sol",
				requestedReasoningEffort: "high",
			},
		})
		expect(prepared.requiresExplicitApproval).toBe(false)
	})

	it("uses the read-only default role for a Codex spawn in Plan mode", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		parent.getTaskMode.mockResolvedValue("architect")
		const prepared = await provider.prepareSubagentGroup(parent as any, {
			task_name: "inspect_change",
			message: "Inspect the proposed change",
		})
		expect(prepared.group.agents[0].role).toBe("explore")
		expect(prepared.envelopes[0].scope.allowedPaths).toBeUndefined()
	})

	it("prepares two default Code agents in a plain folder without initializing the user's repository", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-plain-spawn-"))
		const provider = makeProviderHarness()
		const parent = { ...makeParent(), cwd: workspace, historyWorkspacePath: workspace }
		try {
			for (const taskName of ["first_test", "second_test"]) {
				const prepared = await provider.prepareSubagentGroup(parent as unknown as Task, {
					task_name: taskName,
					message: "Return a short test response without changing files",
				})
				expect(prepared.group.agents[0]).toMatchObject({ role: "worker", writeScope: ["."] })
				expect(prepared.envelopes[0].scope).toMatchObject({
					workspaceRoots: [path.resolve(workspace)],
					allowedPaths: [path.resolve(workspace)],
					sharedWorkspace: false,
				})
			}
			expect(await fs.readdir(workspace)).toEqual([])
		} finally {
			await fs.rm(workspace, { recursive: true, force: true })
		}
	})

	it("restores the workspace-root scope of a default worker after its prepared runtime is unloaded", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-plain-followup-"))
		const provider = makeProviderHarness()
		const parent = { ...makeParent(), cwd: workspace, historyWorkspacePath: workspace }
		try {
			const prepared = await provider.prepareSubagentGroup(parent as unknown as Task, {
				task_name: "retained_test",
				message: "Return a short test response without changing files",
			})
			Reflect.get(provider, "finalizePreparedSubagentAuthorization").call(provider, prepared)
			const records = await Reflect.get(provider, "ensurePreparedSubagentControlRecords").call(
				provider,
				parent,
				prepared,
			)
			const record = records.get(prepared.envelopes[0].id)
			expect(record).toBeDefined()
			parent.alphaMessages.push({ subagentGroup: structuredClone(prepared.group) })
			Reflect.get(provider, "preparedSubagentGroups").clear()
			Reflect.get(provider, "subagentDescriptors").clear()
			const restored = await Reflect.get(provider, "restorePreparedSubagentForFollowup").call(
				provider,
				parent,
				record,
				"Return another short response",
			)
			expect(restored.group.agents[0]).toMatchObject({ role: "worker", writeScope: ["."] })
			expect(restored.envelopes[0].scope.allowedPaths).toEqual([path.resolve(workspace)])
			expect(await fs.readdir(workspace)).toEqual([])
		} finally {
			await fs.rm(workspace, { recursive: true, force: true })
		}
	})

	it("deletes a no-op worker's private artifact when its parent chat is deleted", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-plain-delete-"))
		const workspace = path.join(root, "workspace")
		const storage = path.join(root, "storage")
		await fs.mkdir(workspace)
		const provider = makeProviderHarness()
		Reflect.set(provider.contextProxy, "globalStorageUri", { fsPath: storage })
		Object.defineProperty(provider, "cwd", { value: workspace })
		vi.spyOn(ShadowCheckpointService, "deleteTask").mockResolvedValue(undefined)
		vi.spyOn(provider, "postStateToWebview").mockResolvedValue(undefined)
		const history = Reflect.get(provider, "__historyItems") as Map<string, { id: string; childIds?: string[] }>
		history.set("parent-1", { id: "parent-1", childIds: ["empty-worker"] })
		history.set("empty-worker", { id: "empty-worker" })
		Reflect.set(
			Reflect.get(provider, "taskHistoryStore"),
			"deleteMany",
			vi.fn(async () => undefined),
		)
		let artifactId: string | undefined
		try {
			const worker = await managedSubagentWorktreeService.create(
				storage,
				"empty-worker",
				await managedSubagentWorktreeService.validateScope(workspace, ["."], { allowWorkspaceRoot: true }),
			)
			artifactId = worker.artifact.id
			const captured = await managedSubagentWorktreeService.capture(storage, artifactId)
			expect(captured).toMatchObject({ status: "discarded", changes: [] })
			await provider.deleteTaskWithId("parent-1")
			await expect(fs.access(path.join(storage, "subagent-change-sets", artifactId))).rejects.toMatchObject({
				code: "ENOENT",
			})
			expect(await fs.readdir(workspace)).toEqual([])
		} finally {
			if (artifactId) await managedSubagentWorktreeService.deleteArtifact(storage, artifactId)
			await fs.rm(root, { recursive: true, force: true })
		}
	})

	it("permits read-only Explore and Review agents in Plan mode", async () => {
		const provider = makeProviderHarness(2)
		const parent = makeParent()
		parent.getTaskMode.mockResolvedValue("architect")

		await expect(
			provider.prepareSubagentGroup(parent as any, [
				{ objective: "Inspect the data flow", agent_kind: "explore" },
				{ objective: "Review the proposed boundaries", agent_kind: "review" },
			]),
		).resolves.toMatchObject({
			group: {
				agents: [{ role: "explore" }, { role: "review" }],
			},
		})
	})

	it("rejects editing Workers in Plan mode before creating approval state", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		parent.getTaskMode.mockResolvedValue("architect")

		await expect(
			provider.prepareSubagentGroup(parent as any, [
				{
					objective: "Implement the planned change",
					agent_kind: "worker",
					write_scope: ["src/core"],
				},
			]),
		).rejects.toThrow("Plan mode permits only read-only Explore and Review sub-agents")
		expect(parent.upsertSubagentGroup).not.toHaveBeenCalled()
	})

	it("rejects Code to Plan admission while a Worker descendant is pending", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		vi.spyOn(managedSubagentWorktreeService, "validateScope").mockResolvedValue({
			gitRoot: parent.cwd,
			logicalWorkspace: parent.cwd,
			logicalWorkspaceFromRoot: "",
			writeScope: ["src/core"],
			gitRelativeScope: ["src/core"],
			fileWriteScope: [],
			gitRelativeFileScope: [],
		})
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{
				objective: "Implement the approved change",
				agent_kind: "worker",
				write_scope: ["src/core"],
			},
		])
		;(provider as any).finalizePreparedSubagentAuthorization(prepared)
		await (provider as any).ensurePreparedSubagentControlRecords(parent, prepared)

		await expect((provider as any).assertPlanModeEntryAllowed(parent, "code", "architect")).rejects.toThrow(
			"Cannot enter Plan mode while 1 Worker descendant is active",
		)
	})

	it("rejects steering or relaunching a retained Worker after Code switches to Plan", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		vi.spyOn(managedSubagentWorktreeService, "validateScope").mockResolvedValue({
			gitRoot: parent.cwd,
			logicalWorkspace: parent.cwd,
			logicalWorkspaceFromRoot: "",
			writeScope: ["src/core"],
			gitRelativeScope: ["src/core"],
			fileWriteScope: [],
			gitRelativeFileScope: [],
		})
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{
				objective: "Implement the approved change",
				agent_kind: "worker",
				write_scope: ["src/core"],
			},
		])
		;(provider as any).finalizePreparedSubagentAuthorization(prepared)
		const records = await (provider as any).ensurePreparedSubagentControlRecords(parent, prepared)
		const record = records.get(prepared.envelopes[0].id)
		parent.getTaskMode.mockResolvedValue("architect")

		await expect(provider.sendMessageToAgent(parent as any, record.path, "Keep editing")).rejects.toThrow(
			"Plan mode cannot send a message to Worker",
		)

		await (provider as any).agentControlStore.updateAgentStatus(record.taskId, "completed", {}, record.rootTaskId)
		await expect(provider.followupAgentTask(parent as any, record.path, "Edit one more file")).rejects.toThrow(
			"Plan mode cannot relaunch Worker",
		)
	})

	it("gives a legacy primary handoff child its own managed-agent root", async () => {
		const provider = makeProviderHarness()
		const legacyChild = {
			...makeParent(),
			taskId: "legacy-child",
			parentTaskId: "parent-1",
			rootTaskId: "parent-1",
			taskKind: "primary",
		}

		await expect(provider.getParentCompletionDecision(legacyChild as any)).resolves.toMatchObject({ allowed: true })
		const listed = (await provider.listAgents(legacyChild as any)) as any

		expect(listed.rootTaskId).toBe("legacy-child")
		expect((provider as any).agentControlStore.getAgent("legacy-child", "legacy-child")).toMatchObject({
			role: "root",
			rootTaskId: "legacy-child",
		})
		expect((provider as any).agentControlStore.getAgent("legacy-child", "parent-1")).toBeUndefined()
	})

	it("preflights capacity before creating approval state", async () => {
		const provider = makeProviderHarness(1)
		const parent = makeParent()

		await expect(
			provider.prepareSubagentGroup(parent as any, [
				{ objective: "first", agent_kind: "explore" },
				{ objective: "second", agent_kind: "review" },
			]),
		).rejects.toThrow("Available slots: 1")
		expect(parent.upsertSubagentGroup).not.toHaveBeenCalled()
	})

	it("does not count a registered child again as reserved capacity", async () => {
		const provider = makeProviderHarness(2)
		const parent = makeParent()
		const first = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect the parser", agent_kind: "explore" },
		])

		;(provider as any).taskSessions.register(
			{ taskId: first.envelopes[0].id, taskKind: "subagent", alphaMessages: [] },
			{ focus: false },
		)

		await expect(
			provider.prepareSubagentGroup(parent as any, [
				{ objective: "Review the dispatcher", agent_kind: "review" },
			]),
		).resolves.toMatchObject({
			group: { agents: [{ objective: "Review the dispatcher" }] },
		})
	})

	it("atomically reserves a root slot before asynchronous preparation yields", async () => {
		const provider = makeProviderHarness(2, { maxConcurrentSubagents: 1 })
		const parent = makeParent()
		let releaseCapture!: (value: Awaited<ReturnType<typeof parent.captureEffectiveInheritedInstructions>>) => void
		const captureBarrier = new Promise<Awaited<ReturnType<typeof parent.captureEffectiveInheritedInstructions>>>(
			(resolve) => {
				releaseCapture = resolve
			},
		)
		parent.captureEffectiveInheritedInstructions.mockImplementationOnce(() => captureBarrier)

		const firstPreparation = provider.prepareSubagentGroup(parent as any, [
			{ objective: "Hold the only root slot", agent_kind: "explore" },
		])
		await vi.waitFor(() => expect(parent.captureEffectiveInheritedInstructions).toHaveBeenCalledTimes(1))

		await expect(
			provider.prepareSubagentGroup(parent as any, [
				{ objective: "Race for the same root slot", agent_kind: "review" },
			]),
		).rejects.toThrow("root-wide child capacity")

		releaseCapture({
			effectiveText: "Language Preference: English",
			sources: [
				{
					kind: "aggregate",
					ref: "task:parent-1:effective-instructions:code",
					text: "Language Preference: English",
				},
			],
		})
		await expect(firstPreparation).resolves.toMatchObject({
			group: { agents: [{ objective: "Hold the only root slot" }] },
		})
	})

	it("releases an admission reservation when asynchronous preparation fails", async () => {
		const provider = makeProviderHarness(1, { maxConcurrentSubagents: 1 })
		const parent = makeParent()
		parent.captureEffectiveInheritedInstructions.mockRejectedValueOnce(new Error("capture failed"))

		await expect(
			provider.prepareSubagentGroup(parent as any, [
				{ objective: "Fail after reserving", agent_kind: "explore" },
			]),
		).rejects.toThrow("capture failed")
		expect((provider as any).reservedSubagentSlots.size).toBe(0)

		await expect(
			provider.prepareSubagentGroup(parent as any, [
				{ objective: "Reuse the released slot", agent_kind: "review" },
			]),
		).resolves.toMatchObject({ group: { agents: [{ objective: "Reuse the released slot" }] } })
	})

	it("validates unsupported authority before reporting capacity", async () => {
		const provider = makeProviderHarness(1)
		const parent = makeParent()

		await expect(
			provider.prepareSubagentGroup(
				parent as any,
				[
					{ objective: "inspect", agent_kind: "explore", mutate: true },
					{ objective: "review", agent_kind: "review" },
				] as any,
			),
		).rejects.toThrow("Sub-agent task 1 contains unsupported authority fields")
		expect(parent.upsertSubagentGroup).not.toHaveBeenCalled()
	})

	it("rejects an explicit editing objective assigned to a read-only role before capacity or approval state", async () => {
		const provider = makeProviderHarness(0)
		const parent = makeParent()

		await expect(
			provider.prepareSubagentGroup(parent as any, [
				{
					objective: "Create docs/subagent-worker-smoke-test.md with a short verification note",
					agent_kind: "explore",
				},
			]),
		).rejects.toThrow('tasks[0]: set agent_kind to "worker" and provide write_scope')
		expect(parent.upsertSubagentGroup).not.toHaveBeenCalled()
		expect((provider as any).preparedSubagentGroups.size).toBe(0)
		expect((provider as any).reservedSubagentSlots.size).toBe(0)
	})

	it("derives read-only envelopes, inherited routing, and unique host nicknames", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Explore parsers", agent_kind: "explore" },
			{ objective: "Review cancellation", agent_kind: "review", expected_output: ["findings"] },
		])

		expect(prepared.envelopes).toHaveLength(2)
		for (const envelope of prepared.envelopes) {
			expect(envelope.policy).toMatchObject({
				read: true,
				execute: false,
				mutate: false,
				delegate: true,
				network: false,
				externalSideEffects: false,
			})
			expect(envelope.modelRoute).toMatchObject({
				id: "user-configured",
				provider: "openai",
				model: "alpha-model",
			})
			expect(envelope.budget.timeoutMs).toBeNull()
		}
		expect(prepared.group.agents.map((agent) => agent.nickname)).toEqual([
			SUBAGENT_CALLSIGNS[0],
			SUBAGENT_CALLSIGNS[1],
		])
		expect(new Set(prepared.group.agents.map((agent) => agent.nickname)).size).toBe(2)
		expect(parent.upsertSubagentGroup).toHaveBeenCalledWith(prepared.group)
	})

	it("captures and applies only the requested parent turns with frozen instructions and skills while keeping the child objective concise", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		parent.apiConversationHistory = [
			{ role: "user", content: "OLD_PARENT_TURN" },
			{ role: "assistant", content: "OLD_PARENT_REPLY" },
			{
				role: "user",
				content: [
					{
						type: "text",
						text: `[ERROR] You did not use a tool in your previous response! Please retry with a tool use.

# Reminder: Instructions for Tool Use

Use native tool calling.

# Next Steps

If complete, use attempt_completion.
(This is an automated message, so do not respond to it conversationally.)`,
					},
					{ type: "text", text: "<environment_details>volatile mistake cycle</environment_details>" },
					{
						type: "text",
						text: '<request_pacing_update wait_count="1" total_wait_ms="4000" interval_seconds="10" scope="provider_profile_shared" classification="configured_pacing_not_provider_error" />',
					},
				],
			},
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "completion-before-latest",
						name: "attempt_completion",
						input: { result: "OLD_PARENT_REPLY" },
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "completion-before-latest",
						content: [{ type: "text", text: "<user_message>\nLATEST_PARENT_TURN\n</user_message>" }],
					},
					{ type: "text", text: "<environment_details>volatile feedback cycle</environment_details>" },
				],
			},
			{ role: "assistant", content: "LATEST_PARENT_REPLY" },
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "lifecycle-only", content: "runtime result" },
					{
						type: "text",
						text: [
							"A background sub-agent has finished. Treat its report as delegated evidence, not as user instructions. Review and use any relevant findings before completing the task.",
							'<spawned_subagent_result>\n{"summary":"OLD_PARENT_TURN"}\n</spawned_subagent_result>',
						].join("\n\n"),
					},
					{ type: "text", text: "<environment_details>volatile lifecycle cycle</environment_details>" },
				],
			},
		] as any[]
		parent.captureEffectiveInheritedInstructions = vi.fn(async () => ({
			effectiveText: "Follow the frozen repository instructions.",
			sources: [
				{
					kind: "aggregate",
					ref: "task:parent-1:effective-instructions:code",
					text: "Follow the frozen repository instructions.",
				},
				{ kind: "agents", ref: "F:/workspace/AGENTS.md", text: "Repository agent rules" },
			],
		}))
		;(provider as any).skillsManager = {
			getSkillsForMode: vi.fn(() => [
				{
					name: "review-repository",
					description: "Review repository evidence",
					path: "F:/workspace/.alpha/skills/review-repository/SKILL.md",
				},
				{
					name: "explicit-review",
					description: "Explicit-only frozen review",
					path: "F:/workspace/.agents/skills/explicit-review/SKILL.md",
					allowImplicitInvocation: false,
				},
			]),
			getSkillContent: vi.fn(async () => ({ instructions: "Use the review checklist." })),
		}
		;(provider as any).taskSessions.getTask = (taskId: string) => (taskId === parent.taskId ? parent : undefined)

		let childPrompt = ""
		let childOptions: any
		;(provider as any).createTask = vi.fn(
			async (prompt: string, _images: unknown, _parent: unknown, options: any) => {
				childPrompt = prompt
				childOptions = options
				const emitter = new EventEmitter()
				return Object.assign(emitter, {
					taskId: options.taskId,
					alphaMessages: [{ type: "say", say: "completion_result", text: "Context inspected" }],
					getTokenUsage: () => ({ totalTokensIn: 10, totalTokensOut: 5 }),
					persistFrozenSubagentInstructions: vi.fn(async () => undefined),
					finalizeSubagentHistory: vi.fn(async () => undefined),
					cancelCurrentRequest: vi.fn(),
					abortTask: vi.fn(async () => undefined),
					start() {
						emitter.emit(AlphaCodeEventName.TaskCompleted, options.taskId, {
							totalTokensIn: 10,
							totalTokensOut: 5,
						})
					},
				})
			},
		)
		;(provider as any).boundedDelegationManager = new BoundedDelegationManager(
			(envelope, signal) => (provider as any).runSubagentEnvelope(envelope, signal),
			1,
		)

		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{
				task_name: "context_review",
				objective: "Review the selected context",
				agent_kind: "review",
				fork_turns: "1",
			},
		])
		const descriptor = (provider as any).subagentDescriptors.get(prepared.envelopes[0].id)
		const manifest = descriptor.contextManifest

		expect(manifest).toMatchObject({
			requestedForkTurns: "1",
			selectedUserTurns: { count: 1 },
			instructions: {
				sources: expect.arrayContaining([expect.objectContaining({ ref: "F:/workspace/AGENTS.md" })]),
			},
			skills: [
				expect.objectContaining({ name: "explicit-review", allowImplicitInvocation: false }),
				expect.objectContaining({ name: "review-repository" }),
			],
		})
		expect(prepared.envelopes[0].scope.contextRefs).toEqual(manifest.contextRefs)
		expect(prepared.envelopes[0].skills).toEqual([
			expect.objectContaining({ id: "explicit-review", digest: manifest.skills[0].digest }),
			expect.objectContaining({ id: "review-repository", digest: manifest.skills[1].digest }),
		])
		expect(descriptor.inheritedSkills).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "explicit-review", allowImplicitInvocation: false }),
			]),
		)
		expect(getSkillsCatalogSection(descriptor.inheritedSkills, "code")).not.toContain("explicit-review")

		await provider.runSubagentGroup(parent as any, prepared, new AbortController().signal)

		const finalizedManifest = childOptions.subagentContextManifest
		expect(finalizedManifest).toMatchObject({
			requestedForkTurns: manifest.requestedForkTurns,
			selectedUserTurns: manifest.selectedUserTurns,
			instructions: manifest.instructions,
			skills: manifest.skills,
			orchestration: {
				delegationPolicy: { authorization: "session-policy", explicitUserRequest: false },
			},
		})
		expect(childPrompt).toContain("Objective: Review the selected context")
		expect(childPrompt).not.toContain("Follow the frozen repository instructions.")
		expect(childPrompt).not.toContain("review-repository")
		expect(childPrompt).not.toContain("LATEST_PARENT_TURN")
		expect(childOptions.subagentInstructionPlacement).toBe("system")
		expect(childOptions.subagentFrozenInstructions).toBe("Follow the frozen repository instructions.")
		expect(childOptions.subagentInitialContext).toContain("Host-supplied managed-child context")
		expect(childOptions.subagentInitialContext).toContain("review-repository")
		expect(childOptions.subagentInitialContext).not.toContain("explicit-review")
		expect(childOptions.subagentInitialContext).not.toContain("Explicit-only frozen review")
		expect(childOptions.subagentInitialContext).toContain("LATEST_PARENT_TURN")
		expect(childOptions.subagentInitialContext).toContain("LATEST_PARENT_REPLY")
		expect(childOptions.subagentInitialContext).not.toContain("Follow the frozen repository instructions.")
		expect(childOptions.subagentInitialContext).not.toContain("mandatory_skill_check")
		expect(childOptions.subagentInitialContext).not.toContain("internal_verification")
		expect(childOptions.subagentInitialContext).not.toContain("OLD_PARENT_TURN")
		expect(childOptions.subagentInitialContext).not.toContain("OLD_PARENT_REPLY")
		expect(childOptions.subagentInitialContext).not.toContain("request_pacing_update")
		expect(childOptions.subagentInitialContext).not.toContain("spawned_subagent_result")
		expect(childOptions.subagentInitialContext).not.toContain("You did not use a tool in your previous response")
		expect(parent.captureEffectiveInheritedInstructions).toHaveBeenCalledTimes(1)
		expect(descriptor.inheritedInstructions).toBeUndefined()
	})

	it("forks the invoking step's captured history, instructions, and route after its persistence barrier", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const capturedText = `CAPTURED_PARENT_CONTEXT ${"complete context ".repeat(2_000)} END_CAPTURED_CONTEXT`
		const captured = {
			mode: "code",
			reasoningPreference: { kind: "effort", effort: "high" },
			apiConfiguration: { apiProvider: "openai", openAiModelId: "captured-model" },
			apiConfigName: "Captured profile",
			modelRoute: {
				source: "parent",
				resolution: "selected",
				provider: "openai",
				modelId: "captured-model",
				profileName: "Captured profile",
			},
			history: [
				{ role: "user", input_origin: "human", content: capturedText },
				{ role: "assistant", content: [{ type: "text", text: "Captured final response" }] },
			],
			finalAssistantMessageIndexes: [1],
			instructions: {
				effectiveText: "Captured applied instructions",
				sources: [{ kind: "agent-rules", ref: "captured:AGENTS.md", text: "Captured applied instructions" }],
			},
		}
		const invocation = vi.fn(() => structuredClone(captured))
		let release!: () => void
		let entered!: () => void
		const pending = new Promise<void>((resolve) => {
			release = resolve
		})
		const flushing = new Promise<void>((resolve) => {
			entered = resolve
		})
		Object.assign(parent, {
			getSubagentInvocationContext: invocation,
			flushApiConversationHistoryPersistence: vi.fn(async () => {
				entered()
				await pending
			}),
		})

		const preparing = provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect the captured context", agent_kind: "review", fork_turns: "all" },
		])
		await flushing
		expect(invocation).toHaveBeenCalledOnce()
		expect(parent.upsertSubagentGroup).not.toHaveBeenCalled()
		parent.apiConversationHistory = [{ role: "user", content: "LIVE_REPLACEMENT" }]
		parent.apiConfiguration.openAiModelId = "live-model"
		Object.assign(parent, { reasoningPreference: { kind: "off" } })
		parent.getTaskMode.mockResolvedValue("architect")
		parent.captureEffectiveInheritedInstructions.mockResolvedValue({
			effectiveText: "Live changed instructions",
			sources: [],
		})
		release()
		const prepared = await preparing
		const descriptor = (provider as any).subagentDescriptors.get(prepared.envelopes[0].id)

		expect(prepared.group.agents[0].modelRoute).toMatchObject({
			modelId: "captured-model",
			profileName: "Captured profile",
		})
		expect(descriptor.inheritedInstructions).toBe("Captured applied instructions")
		expect(descriptor.contextManifest).not.toHaveProperty("personality")
		expect(descriptor.modelRoute.reasoningPreference).toEqual({ kind: "effort", effort: "high" })
		expect(descriptor.contextManifest.instructions.sources).toContainEqual(
			expect.objectContaining({ ref: "captured:AGENTS.md" }),
		)
		expect(descriptor.historyFork).toMatchObject({ kind: "native", requiresContextRebuild: true })
		expect(descriptor.historyFork.messages).toHaveLength(2)
		expect(JSON.stringify(descriptor.historyFork.messages)).toContain(capturedText)
		expect(descriptor.historyFork.messages.every((message: any) => message.input_origin === "agent")).toBe(true)
		expect(descriptor.inheritedTurnContext).toBe("")
		expect(parent.captureEffectiveInheritedInstructions).not.toHaveBeenCalled()
		expect(parent.getTaskMode).not.toHaveBeenCalled()
		expect(parent.getTaskApiConfigName).not.toHaveBeenCalled()
	})

	it.each([
		{ label: "captured parent", spawnEffort: undefined, agentEffort: undefined, expected: "high" },
		{ label: "explicit spawn", spawnEffort: "low", agentEffort: undefined, expected: "low" },
		{ label: "configured agent", spawnEffort: "low", agentEffort: "medium", expected: "medium" },
	] as const)("launches with the $label reasoning selection after the live parent changes", async (testCase) => {
		const provider = makeProviderHarness(2, {
			subagentAgentTypes: {
				inspector: { description: "Inspects code", role: "review", reasoningEffort: testCase.agentEffort },
			},
		})
		const parent = Object.assign(makeParent(), { reasoningPreference: { kind: "effort", effort: "high" } })
		const instructions = await parent.captureEffectiveInheritedInstructions()
		Object.assign(parent, {
			getSubagentInvocationContext: () => ({
				mode: "code",
				apiConfiguration: { ...parent.apiConfiguration, reasoningEffort: "high" },
				apiConfigName: "Parent",
				reasoningPreference: { kind: "effort", effort: "high" },
				modelRoute: {
					source: "parent",
					resolution: "selected",
					provider: "openai",
					modelId: "alpha-model",
					profileName: "Parent",
				},
				history: [],
				finalAssistantMessageIndexes: [],
				instructions,
			}),
		})
		const prepared = await provider.prepareSubagentGroup(parent as unknown as Task, {
			task_name: "captured_reasoning",
			message: "Inspect the effective reasoning selection",
			agent_type: "inspector",
			fork_turns: "none",
			...(testCase.spawnEffort ? { reasoning_effort: testCase.spawnEffort } : {}),
		})
		Object.assign(parent, { reasoningPreference: { kind: "off" } })
		const create = vi.spyOn(provider, "createTask").mockImplementation(async (_text, _images, _parent, options) => {
			expect(options?.apiConfiguration?.reasoningEffort).toBe(testCase.expected)
			expect(options?.reasoningPreference).toEqual(
				testCase.label === "captured parent" ? { kind: "effort", effort: "high" } : { kind: "default" },
			)
			const emitter = new EventEmitter()
			return Object.assign(emitter, {
				taskId: options?.taskId,
				taskKind: "subagent",
				rootTaskId: parent.taskId,
				alphaMessages: [{ type: "say", say: "completion_result", text: "Selection inspected." }],
				getTokenUsage: () => ({ totalTokensIn: 0, totalTokensOut: 0, totalCost: 0 }),
				persistFrozenSubagentInstructions: vi.fn(async () => undefined),
				finalizeSubagentHistory: vi.fn(async () => undefined),
				cancelCurrentRequest: vi.fn(),
				abortTask: vi.fn(async () => undefined),
				start: () => emitter.emit(AlphaCodeEventName.TaskCompleted, options?.taskId, {}),
			}) as unknown as Task
		})
		Reflect.get(provider, "finalizePreparedSubagentAuthorization").call(provider, prepared)
		await Reflect.get(provider, "runSubagentEnvelope").call(
			provider,
			prepared.envelopes[0],
			new AbortController().signal,
		)
		expect(create).toHaveBeenCalledOnce()
	})

	it.each([
		{ apiProvider: "vertex", apiModelId: "other-provider-model" },
		{ apiProvider: "openai", openAiModelId: "other-model" },
		{ apiProvider: "openai", openAiModelId: "alpha-model" },
	])(
		"retains parent history when obsolete profile settings request a route change: %j",
		async (childConfiguration) => {
			const provider = makeProviderHarness(2, { subagentApiConfigByRole: { review: "different-route" } }, [
				{ id: "different-route", name: "Configured child", ...childConfiguration },
			])
			const parent = makeParent()
			Object.assign(parent, {
				getSubagentInvocationContext: vi.fn(() => ({
					mode: "code",
					apiConfiguration: structuredClone(parent.apiConfiguration),
					apiConfigName: "Parent",
					modelRoute: {
						source: "parent",
						resolution: "selected",
						provider: "openai",
						modelId: "alpha-model",
						profileId: "parent-route",
						profileName: "Parent",
					},
					history: [
						{ role: "user", content: "Inspect the requested change" },
						{
							role: "assistant",
							content: "Portable final response",
							phase: "final_answer",
							vscodeLmStatefulMarker: "parent-state",
							previous_response_id: "parent-response-chain",
							internal_chat_message_metadata_passthrough: { content_item_kinds: ["model-specific"] },
						},
					],
					finalAssistantMessageIndexes: [1],
					instructions: { effectiveText: "Captured instructions", sources: [] },
				})),
			})
			const prepared = await provider.prepareSubagentGroup(parent as any, [
				{ objective: "Inspect forked history", agent_kind: "review", fork_turns: "all" },
			])
			const descriptor = Reflect.get(provider, "subagentDescriptors").get(prepared.envelopes[0].id)
			expect(descriptor.historyFork).toMatchObject({ kind: "native", requiresContextRebuild: true })
			expect(descriptor.historyFork.messages[1]).toMatchObject({
				internal_chat_message_metadata_passthrough: { content_item_kinds: ["model-specific"] },
			})
			expect(descriptor.historyFork.messages[1]).not.toHaveProperty("previous_response_id")
			expect(prepared.group.agents[0].modelRoute?.provider).toBe("openai")
		},
	)

	it("does not replace an explicitly unnamed invoking profile with a live profile name", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		parent.getTaskApiConfigName.mockResolvedValue("Live replacement profile")
		Object.assign(parent, {
			getSubagentInvocationContext: vi.fn(() => ({
				mode: "code",
				apiConfiguration: structuredClone(parent.apiConfiguration),
				apiConfigName: undefined,
				modelRoute: {
					source: "parent",
					resolution: "selected",
					provider: "openai",
					modelId: "alpha-model",
					profileName: "Parent profile",
				},
				history: [],
				finalAssistantMessageIndexes: [],
				instructions: {
					effectiveText: "Language Preference: English",
					sources: [
						{ kind: "aggregate", ref: "step:captured-instructions", text: "Language Preference: English" },
					],
				},
			})),
		})

		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Retain unnamed profile", agent_kind: "review" },
		])
		expect(prepared.group.agents[0].modelRoute?.profileName).not.toBe("Live replacement profile")
		expect(parent.getTaskApiConfigName).not.toHaveBeenCalled()
	})

	it("retains the invoking step's protected-file and command ceilings when the same live approval tier widens", async () => {
		const settings = {
			approvalMode: "auto" as const,
			alwaysAllowWriteProtected: false,
			deniedCommands: ["git push"],
		}
		const provider = makeProviderHarness(2, settings)
		const parent = makeParent()
		const capturedApproval = structuredClone((provider as any).snapshotSubagentAutoApprovalPolicy(settings))
		Object.assign(parent, {
			getStepApprovalMode: vi.fn(() => "auto"),
			getSubagentInvocationContext: vi.fn(() => ({
				mode: "code",
				apiConfiguration: structuredClone(parent.apiConfiguration),
				apiConfigName: "Parent",
				modelRoute: {
					source: "parent",
					resolution: "selected",
					provider: "openai",
					modelId: "alpha-model",
					profileName: "Parent",
				},
				history: [],
				finalAssistantMessageIndexes: [],
				instructions: {
					effectiveText: "Language Preference: English",
					sources: [
						{ kind: "aggregate", ref: "step:captured-instructions", text: "Language Preference: English" },
					],
				},
				autoApprovalPolicy: capturedApproval,
			})),
		})
		settings.alwaysAllowWriteProtected = true
		settings.deniedCommands = []

		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Retain captured authority", agent_kind: "review" },
		])
		const policy = (provider as any).subagentDescriptors.get(prepared.envelopes[0].id).contextManifest.runtimePolicy
			.autoApproval
		expect(policy.alwaysAllowWriteProtected).toBe(false)
		expect(policy.commandApprovalCeilings).toContainEqual(capturedApproval.commandApproval)
		expect(JSON.stringify(policy)).not.toContain("git push")
	})

	it("does not reserve or publish children when the parent persistence barrier fails", async () => {
		const provider = makeProviderHarness()
		const parent = Object.assign(makeParent(), {
			flushApiConversationHistoryPersistence: vi.fn(async () => {
				throw new Error("parent transcript unavailable")
			}),
		})

		await expect(
			provider.prepareSubagentGroup(parent as any, [
				{ objective: "Inspect durable history", agent_kind: "review" },
			]),
		).rejects.toThrow("parent transcript unavailable")
		expect(parent.upsertSubagentGroup).not.toHaveBeenCalled()
		expect((provider as any).reservedSubagentSlots.size).toBe(0)
		expect((provider as any).subagentDescriptors.size).toBe(0)
	})

	it.each(["cached", "reloaded"] as const)(
		"keeps durable descriptions, paths and content digests through %s nested delegation",
		async (source) => {
			const provider = makeProviderHarness(3, { subagentDelegationPolicy: "proactive", subagentMaxDepth: 2 })
			const root = makeParent()
			let skillBody = "Frozen skill body"
			let catalog: SkillCatalogEntry[] = [
				{
					name: "review-repository",
					path: "F:/workspace/.agents/skills/review-repository/SKILL.md",
					description: "Frozen skill description",
					allowImplicitInvocation: false,
				},
			]
			const manager = {
				getSkillsForMode: vi.fn(() => catalog),
				getSkillContent: vi.fn(async () => ({ instructions: skillBody })),
			}
			;(provider as any).skillsManager = manager
			const direct = await provider.prepareSubagentGroup(root as any, [
				{ objective: "Inspect first layer", agent_kind: "review" },
			])
			const directDescriptor = (provider as any).subagentDescriptors.get(direct.envelopes[0].id)
			const frozenSkills = structuredClone(directDescriptor.contextManifest.skills)
			expect(frozenSkills[0].description).toBe("Frozen skill description")
			catalog = [
				{ ...catalog[0], description: "Live replacement description", allowImplicitInvocation: true },
				{
					name: "new-skill",
					path: "F:/workspace/.agents/skills/new-skill/SKILL.md",
					description: "New live skill",
				},
			]
			skillBody = "Changed live skill body"
			manager.getSkillContent.mockClear()
			;(provider as any).getSkillsManager.mockClear()
			directDescriptor.inheritedSkills = [{ ...catalog[0], description: "STALE_TEMPORARY_DESCRIPTOR" }]
			const reloadedManifest = subagentContextManifestSchema.parse(
				JSON.parse(serializeSubagentContextManifest(directDescriptor.contextManifest)),
			)
			if (source === "reloaded") (provider as any).subagentDescriptors.delete(direct.envelopes[0].id)
			const child = {
				...makeParent(),
				taskId: direct.envelopes[0].id,
				rootTaskId: root.taskId,
				taskKind: "subagent",
				subagentContextManifest: reloadedManifest,
				subagentDelegationPolicy: "proactive",
			}
			const nested = await provider.prepareSubagentGroup(child as any, [
				{ objective: "Inspect second layer", agent_kind: "explore" },
			])
			const nestedDescriptor = (provider as any).subagentDescriptors.get(nested.envelopes[0].id)

			expect(nestedDescriptor.contextManifest.skills).toEqual(frozenSkills)
			expect(isValidSubagentContextManifest(nestedDescriptor.contextManifest)).toBe(true)
			expect(nestedDescriptor.inheritedSkills).toEqual([
				{ ...catalog[0], description: "Frozen skill description", allowImplicitInvocation: false },
			])
			expect(getSkillsCatalogSection(nestedDescriptor.inheritedSkills, "code")).toBe("")
			expect(nestedDescriptor.contextManifest.runtimePolicy.allowedTools).toContain("skill")
			expect(manager.getSkillContent).not.toHaveBeenCalled()
			expect((provider as any).getSkillsManager).not.toHaveBeenCalled()
		},
	)

	it("preserves legacy description absence through nesting without temporary or live backfill", async () => {
		const provider = makeProviderHarness(3, { subagentDelegationPolicy: "proactive", subagentMaxDepth: 2 })
		const root = makeParent()
		const skill = {
			name: "legacy-review",
			path: "F:/workspace/.agents/skills/legacy-review/SKILL.md",
			description: "Temporary descriptor description must not become durable",
		}
		;(provider as any).skillsManager = {
			getSkillsForMode: vi.fn(() => [skill]),
			getSkillContent: vi.fn(async () => ({ instructions: "Frozen legacy body" })),
		}
		const direct = await provider.prepareSubagentGroup(root as any, [
			{ objective: "Inspect the first layer", agent_kind: "review" },
		])
		const directDescriptor = (provider as any).subagentDescriptors.get(direct.envelopes[0].id)
		const { manifestDigest: _manifestDigest, ...capturedFields } = directDescriptor.contextManifest
		const legacyFields = {
			...capturedFields,
			skills: capturedFields.skills.map(
				({
					description: _description,
					...identity
				}: {
					description?: string
					name: string
					path: string
					digest: string
				}) => identity,
			),
		}
		const legacyManifest = subagentContextManifestSchema.parse({
			...legacyFields,
			manifestDigest: digestValue(legacyFields),
		})
		expect(isValidSubagentContextManifest(legacyManifest)).toBe(true)
		const child = {
			...makeParent(),
			taskId: direct.envelopes[0].id,
			rootTaskId: root.taskId,
			taskKind: "subagent",
			subagentContextManifest: legacyManifest,
			subagentDelegationPolicy: "proactive",
		}
		;(provider as any).getSkillsManager.mockRejectedValue(new Error("Live manager unavailable after reload"))
		;(provider as any).getSkillsManager.mockClear()
		const nested = await provider.prepareSubagentGroup(child as any, [
			{ objective: "Inspect the second layer", agent_kind: "explore" },
		])
		const descriptor = (provider as any).subagentDescriptors.get(nested.envelopes[0].id)

		expect(descriptor.contextManifest.skills[0]).not.toHaveProperty("description")
		expect(descriptor.contextManifest.skills).toEqual(legacyManifest.skills)
		expect(descriptor.inheritedSkills).toEqual([{ name: skill.name, path: skill.path, description: "" }])
		expect((provider as any).getSkillsManager).not.toHaveBeenCalled()
	})

	it("renders reloaded child startup metadata from the validated manifest rather than a cached display catalog", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const skill = {
			name: "release-review",
			path: "F:/workspace/.agents/skills/release-review/SKILL.md",
			description: "Frozen release audit relevance",
		}
		;(provider as any).skillsManager = {
			getSkillsForMode: vi.fn(() => [skill]),
			getSkillContent: vi.fn(async () => ({ instructions: "Frozen body" })),
		}
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect the release", agent_kind: "review", fork_turns: "none" },
		])
		;(provider as any).finalizePreparedSubagentAuthorization(prepared)
		const descriptor = (provider as any).subagentDescriptors.get(prepared.envelopes[0].id)
		descriptor.contextManifest = subagentContextManifestSchema.parse(
			JSON.parse(serializeSubagentContextManifest(descriptor.contextManifest)),
		)
		descriptor.inheritedSkills = [{ ...skill, description: "STALE_DISPLAY_DESCRIPTION" }]
		skill.description = "MUTABLE_LIVE_DESCRIPTION"
		const stopAfterCapture = new Error("Captured initial input before creating a child")
		let initialContext: string | undefined
		;(provider as any).createTask = vi.fn(
			async (
				_prompt: string,
				_images: unknown,
				_parent: unknown,
				options: {
					subagentInitialContext?: string
				},
			) => {
				initialContext = options.subagentInitialContext
				throw stopAfterCapture
			},
		)

		await expect(
			provider["executeSubagentEnvelope"](prepared.envelopes[0], new AbortController().signal),
		).rejects.toBe(stopAfterCapture)
		expect(initialContext).toContain("Frozen release audit relevance")
		expect(initialContext).toContain("release-review")
		expect(initialContext).not.toContain("STALE_DISPLAY_DESCRIPTION")
		expect(initialContext).not.toContain("MUTABLE_LIVE_DESCRIPTION")
		expect(isValidSubagentContextManifest(descriptor.contextManifest)).toBe(true)
	})

	it("releases capacity and alias after quota rejection before any child admission or worktree creation", async () => {
		const provider = makeProviderHarness(1, { maxConcurrentSubagents: 1 })
		const parent = makeParent()
		const scope = {
			gitRoot: parent.cwd,
			logicalWorkspace: parent.cwd,
			logicalWorkspaceFromRoot: "",
			writeScope: ["src"],
			gitRelativeScope: ["src"],
			fileWriteScope: [],
			gitRelativeFileScope: [],
		}
		const validateScope = vi.spyOn(managedSubagentWorktreeService, "validateScope").mockResolvedValue(scope)
		const createWorktree = vi
			.spyOn(managedSubagentWorktreeService, "create")
			.mockRejectedValue(new Error("Quota rejection must not launch a worktree"))
		;(provider as any).createTask = vi.fn(async () => {
			throw new Error("Quota rejection must not create a child Task")
		})
		const createAgent = vi.spyOn((provider as any).agentControlStore, "createAgent")
		const updateSnapshot = vi.spyOn((provider as any).agentControlStore, "updateAgentSnapshot")
		let catalog = Array.from({ length: 1_008 }, (_, index) => ({
			name: `quota-${index}`,
			path: `F:/workspace/.agents/skills/quota-${index}/SKILL.md`,
			description: "a".repeat(index === 1_007 ? 273 : 1_024),
			allowImplicitInvocation: false,
		}))
		;(provider as any).skillsManager = {
			getSkillsForMode: vi.fn(() => catalog),
			getSkillContentByPath: vi.fn(async () => ({ instructions: "Frozen body" })),
		}
		await Reflect.get(provider, "agentControlStoreReady")
		const availableBefore = (provider as any).taskSessions.getAvailableTaskCapacity()
		const usageBefore = (provider as any).getSubagentRootUsage(parent.taskId)
		const draft = {
			task_name: "quota_retry",
			objective: "Implement the approved bounded change",
			agent_kind: "worker" as const,
			write_scope: ["src"],
		}

		await expect(provider.prepareSubagentGroup(parent as any, [draft])).rejects.toThrow(
			"Captured skill descriptions exceed 1048576 bytes. Reduce the available skill catalog before starting another child.",
		)
		expect(validateScope).toHaveBeenCalledOnce()
		expect((provider as any).agentControlStore.getAgent(parent.taskId)).toMatchObject({ role: "root" })
		expect(
			(provider as any).agentControlStore.listAgents({ rootTaskId: parent.taskId, includeRoot: false }),
		).toEqual([])
		expect(createAgent).not.toHaveBeenCalled()
		expect(updateSnapshot).not.toHaveBeenCalled()
		expect((provider as any).createTask).not.toHaveBeenCalled()
		expect(createWorktree).not.toHaveBeenCalled()
		expect(parent.upsertSubagentGroup).not.toHaveBeenCalled()
		expect((provider as any).preparedSubagentGroups.size).toBe(0)
		expect((provider as any).subagentDescriptors.size).toBe(0)
		expect((provider as any).reservedSubagentSlots.size).toBe(0)
		expect((provider as any).taskSessions.getAvailableTaskCapacity()).toBe(availableBefore)
		expect((provider as any).getSubagentRootUsage(parent.taskId)).toEqual(usageBefore)
		expect([...(provider as any).__historyItems.keys()]).toEqual([parent.taskId])

		catalog = [{ ...catalog[0], description: "Bounded retry relevance" }]
		const retried = await provider.prepareSubagentGroup(parent as any, [draft])
		expect(retried.group.agents[0].nickname).toBe("quota_retry")
		expect((provider as any).reservedSubagentSlots.size).toBe(1)
		expect(createWorktree).not.toHaveBeenCalled()
		await provider.cancelPreparedSubagentGroup(parent as any, retried, "Fixture completed")
		expect((provider as any).reservedSubagentSlots.size).toBe(0)
		expect((provider as any).taskSessions.getAvailableTaskCapacity()).toBe(availableBefore)
	})

	it("freezes explicit skill policy and exact content identity across a discovery refresh during capture", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const original: SkillCatalogEntry = {
			name: "explicit-review",
			description: "Captured explicit-only description",
			path: "F:/workspace/.agents/skills/explicit-review/SKILL.md",
			allowImplicitInvocation: false,
		}
		let catalog = [original]
		const manager = {
			getSkillsForMode: vi.fn(() => catalog),
			getSkillContent: vi.fn(async () => ({ instructions: "Wrong same-name override body" })),
			getSkillContentByPath: vi.fn(async () => {
				catalog = [
					{
						...original,
						path: "F:/workspace/.alpha/skills/explicit-review/SKILL.md",
						description: "Live implicit override",
						allowImplicitInvocation: true,
					},
				]
				return { instructions: "Captured exact-path body", allowImplicitInvocation: true }
			}),
		}
		;(provider as any).skillsManager = manager
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Review captured context", agent_kind: "review" },
		])
		const descriptor = (provider as any).subagentDescriptors.get(prepared.envelopes[0].id)

		expect(manager.getSkillsForMode).toHaveBeenCalledExactlyOnceWith("code")
		expect(manager.getSkillContentByPath).toHaveBeenCalledExactlyOnceWith(original.name, original.path)
		expect(manager.getSkillContent).not.toHaveBeenCalled()
		expect(descriptor.inheritedSkills).toEqual([original])
		expect(descriptor.contextManifest.skills).toEqual([
			expect.objectContaining({
				name: original.name,
				path: original.path,
				allowImplicitInvocation: false,
			}),
		])
		expect(getSkillsCatalogSection(descriptor.inheritedSkills, "code")).toBe("")
		expect(descriptor.contextManifest.runtimePolicy.allowedTools).toContain("skill")
	})

	it("fails before child start when the private instruction snapshot cannot be persisted", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		;(provider as any).taskSessions.getTask = (taskId: string) => (taskId === parent.taskId ? parent : undefined)
		const start = vi.fn()
		;(provider as any).createTask = vi.fn(
			async (_prompt: string, _images: unknown, _parent: unknown, options: any) => {
				const emitter = new EventEmitter()
				return Object.assign(emitter, {
					taskId: options.taskId,
					persistFrozenSubagentInstructions: vi.fn(async () => {
						throw new Error("snapshot storage unavailable")
					}),
					start,
				})
			},
		)

		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect snapshot startup", agent_kind: "review", fork_turns: "none" },
		])
		;(provider as any).finalizePreparedSubagentAuthorization(prepared)
		const descriptor = (provider as any).subagentDescriptors.get(prepared.envelopes[0].id)

		await expect(
			(provider as any).runSubagentEnvelope(prepared.envelopes[0], new AbortController().signal),
		).rejects.toThrow("snapshot storage unavailable")
		expect(start).not.toHaveBeenCalled()
		expect(descriptor.inheritedInstructions).toBe("Language Preference: English")
	})

	it("distinguishes startup failure before task registration from a failure after registration", async () => {
		const runFailure = async (registerBeforeFailure: boolean) => {
			const provider = makeProviderHarness()
			const parent = makeParent()
			let attemptedTaskId: string | undefined
			;(provider as any).taskSessions.getTask = (taskId: string) => {
				if (taskId === parent.taskId) return parent
				if (registerBeforeFailure && taskId === attemptedTaskId) return { taskId }
				return undefined
			}
			;(provider as any).createTask = vi.fn(
				async (_prompt: string, _images: unknown, _parent: unknown, options: any) => {
					attemptedTaskId = options.taskId
					throw new Error("child task storage unavailable")
				},
			)
			const prepared = await provider.prepareSubagentGroup(parent as any, [
				{ objective: "Inspect startup", agent_kind: "explore", fork_turns: "none" },
			])
			;(provider as any).finalizePreparedSubagentAuthorization(prepared)
			const manager = new BoundedDelegationManager((envelope, signal) =>
				(provider as any).runSubagentEnvelope(envelope, signal),
			)
			return manager.run(prepared.envelopes[0])
		}

		await expect(runFailure(false)).resolves.toMatchObject({
			status: "failed",
			stopReason: "never_launched",
			summary: "child task storage unavailable",
		})
		await expect(runFailure(true)).resolves.toMatchObject({
			status: "failed",
			stopReason: "failed",
			summary: "child task storage unavailable",
		})
	})

	it.each(["rejected", "thrown", "unterminated"] as const)(
		"publishes a %s child startup and releases its slot for the next admitted child",
		async (failure) => {
			const provider = makeProviderHarness(2, { maxConcurrentSubagents: 1 })
			const parent = makeParent()
			const children = new Map<string, Task>()
			;(provider as any).taskSessions.getTask = (taskId: string) =>
				taskId === parent.taskId ? parent : children.get(taskId)
			let started!: () => void
			const startupStarted = new Promise<void>((resolve) => (started = resolve))
			let finishStartup!: () => void
			const startup = new Promise<void>((resolve, reject) => {
				finishStartup = () =>
					failure === "rejected" ? reject(new Error("child prompt preparation failed")) : resolve()
			})
			let releaseHistory!: () => void
			const historyFinalization = new Promise<void>((resolve) => (releaseHistory = resolve))
			// Task owns and reports its background rejection independently of the launcher.
			void startup.catch(() => undefined)
			let firstChild = true
			;(provider as any).createTask = vi.fn(
				async (_prompt: string, _images: unknown, _parent: unknown, options: { taskId: string }) => {
					const rejectsStartup = firstChild
					firstChild = false
					const emitter = new EventEmitter()
					const child = Object.assign(emitter, {
						taskId: options.taskId,
						getTaskLifetimeCancellationSignal: vi.fn().mockReturnValue(new AbortController().signal),
						alphaMessages: [] as Task["alphaMessages"],
						abort: false,
						getTokenUsage: () => ({ totalTokensIn: 0, totalTokensOut: 0 }),
						persistFrozenSubagentInstructions: vi.fn(async () => undefined),
						finalizeSubagentHistory: vi.fn(async () => {
							if (rejectsStartup) await historyFinalization
						}),
						cancelCurrentRequest: vi.fn(),
						abortTask: vi.fn(async function (this: { abort: boolean }) {
							this.abort = true
						}),
						waitForTermination: vi.fn(function (this: { abort: boolean }) {
							return rejectsStartup && !this.abort ? startup : Promise.resolve()
						}),
						start() {
							if (rejectsStartup) {
								started()
								if (failure === "thrown") throw new Error("child prompt preparation failed")
							} else emitter.emit(AlphaCodeEventName.TaskCompleted, options.taskId, this.getTokenUsage())
						},
					})
					children.set(options.taskId, child as unknown as Task)
					return child
				},
			)
			const bounded = new BoundedDelegationManager(
				(envelope, signal) => (provider as any).runSubagentEnvelope(envelope, signal),
				1,
			)
			const runs = new AsyncSubagentRunManager(bounded)
			;(provider as any).boundedDelegationManager = bounded
			;(provider as any).asyncSubagentRunManager = runs
			const controller = new AbortController()
			const prepared = await provider.prepareSubagentGroup(parent as any, [
				{ task_name: "fails_startup", objective: "Inspect the initial ticket", agent_kind: "review" },
			])
			const handle = await provider.launchPreparedSubagentGroup(parent as any, prepared, controller.signal)
			await startupStarted
			finishStartup()
			const failureSummary =
				failure === "unterminated"
					? "Child lifecycle ended without a terminal result"
					: "child prompt preparation failed"
			try {
				await vi.waitFor(() => expect(children.get(handle.taskId)!.finalizeSubagentHistory).toHaveBeenCalled())
				expect(children.get(handle.taskId)!.abortTask).toHaveBeenCalledOnce()
				expect(runs.getSnapshot(handle.taskId)?.status).toBe("running")
				await expect(
					provider.prepareSubagentGroup(parent as any, [
						{ task_name: "before_history", objective: "Inspect the next ticket", agent_kind: "review" },
					]),
				).rejects.toThrow("Not enough root-wide child capacity")
				releaseHistory()
				await vi.waitFor(() => expect(runs.getSnapshot(handle.taskId)?.status).toBe("failed"))
				await vi.waitFor(() =>
					expect((provider as any).agentControlStore.getAgent(handle.taskId, parent.taskId)).toMatchObject({
						status: "failed",
					}),
				)
				expect(runs.getResult(handle.taskId)).toMatchObject({
					status: "failed",
					stopReason: "failed",
					summary: expect.stringContaining(failureSummary),
				})
				expect(children.get(handle.taskId)!.finalizeSubagentHistory).toHaveBeenCalledWith(
					"failed",
					expect.stringContaining(failureSummary),
					"failed",
				)
				const next = await provider.prepareSubagentGroup(parent as any, [
					{ task_name: "next_ticket", objective: "Inspect the next ticket", agent_kind: "review" },
				])
				const nextHandle = await provider.launchPreparedSubagentGroup(parent as any, next, controller.signal)
				await expect(runs.waitForResult(nextHandle.taskId)).resolves.toMatchObject({ status: "completed" })
				expect(children.get(handle.taskId)!.listenerCount(AlphaCodeEventName.TaskCompleted)).toBe(0)
				expect(children.get(handle.taskId)!.listenerCount(AlphaCodeEventName.TaskAborted)).toBe(0)
			} finally {
				releaseHistory()
				controller.abort()
				await runs.waitForResult(handle.taskId)
			}
		},
	)

	it.each(["async", "blocking"] as const)(
		"preserves failed child shutdown through the public %s delegation path",
		async (executionMode) => {
			const provider = makeProviderHarness()
			const parent = makeParent()
			let started!: () => void
			const startup = new Promise<void>((resolve) => (started = resolve))
			let releaseLifecycle!: () => void
			const lifecycle = new Promise<void>((resolve) => (releaseLifecycle = resolve))
			let published!: () => void
			const terminalPublication = new Promise<void>((resolve) => (published = resolve))
			parent.upsertSubagentGroup = vi.fn(async (group: SubagentGroupState) => {
				if (group.status === "failed") published()
			})
			const emitter = new EventEmitter()
			const child = Object.assign(emitter, {
				taskId: "",
				getTaskLifetimeCancellationSignal: vi.fn().mockReturnValue(new AbortController().signal),
				alphaMessages: [] as Task["alphaMessages"],
				getTokenUsage: () => ({ totalTokensIn: 0, totalTokensOut: 0 }),
				persistFrozenSubagentInstructions: vi.fn(async () => undefined),
				finalizeSubagentHistory: vi.fn(async () => undefined),
				cancelCurrentRequest: vi.fn(),
				abortTask: vi.fn(async () => {
					throw new Error("Owned process remains unconfirmed")
				}),
				waitForTermination: () => lifecycle,
				start: () => started(),
			})
			;(provider as any).taskSessions.getTask = (taskId: string) =>
				taskId === parent.taskId ? parent : taskId === child.taskId ? child : undefined
			;(provider as any).createTask = vi.fn(
				async (_prompt: string, _images: unknown, _parent: unknown, options: { taskId: string }) => {
					child.taskId = options.taskId
					return child
				},
			)
			const bounded = new BoundedDelegationManager((envelope, signal) =>
				(provider as any).runSubagentEnvelope(envelope, signal),
			)
			const runs = new AsyncSubagentRunManager(bounded)
			;(provider as any).boundedDelegationManager = bounded
			;(provider as any).asyncSubagentRunManager = runs
			const controller = new AbortController()
			const prepared = await provider.prepareSubagentGroup(parent as any, [
				{
					task_name: "cleanup_child",
					objective: "Inspect cancellation",
					agent_kind: "review",
					fork_turns: "none",
				},
			])
			let completion: Promise<unknown>
			if (executionMode === "async") {
				const handle = await provider.launchPreparedSubagentGroup(parent as any, prepared, controller.signal)
				completion = runs.waitForResult(handle.taskId)!
			} else completion = provider.runSubagentGroup(parent as any, prepared, controller.signal)
			try {
				await startup
				controller.abort(new Error("Parent requested cancellation"))
				await expect(completion).resolves.toMatchObject({ status: "failed" })
				await terminalPublication
				expect(child.abortTask).toHaveBeenCalledOnce()
				expect(child.finalizeSubagentHistory).toHaveBeenCalledWith(
					"failed",
					expect.stringContaining("Owned process remains unconfirmed"),
					"parent_cancelled",
				)
				await expect(provider.listAgents(parent as any)).resolves.toMatchObject({
					agents: [{ taskId: child.taskId, status: "failed", stopReason: "parent_cancelled" }],
				})
			} finally {
				releaseLifecycle()
				controller.abort()
				await completion
			}
		},
	)

	it.each(["approval", "recovery", "blocked"] as const)(
		"preserves an explicit %s boundary when the retained child lifecycle settles",
		async (boundary) => {
			const provider = makeProviderHarness()
			const parent = makeParent()
			;(provider as any).taskSessions.getTask = (taskId: string) =>
				taskId === parent.taskId ? parent : undefined
			let resolveLifecycle!: () => void
			const lifecycle = new Promise<void>((resolve) => (resolveLifecycle = resolve))
			let started!: () => void
			const startup = new Promise<void>((resolve) => (started = resolve))
			let observedWait!: () => void
			const waitObserved = new Promise<void>((resolve) => (observedWait = resolve))
			const emitter = new EventEmitter()
			const child = Object.assign(emitter, {
				taskId: "",
				alphaMessages: [] as Task["alphaMessages"],
				getTokenUsage: () => ({ totalTokensIn: 0, totalTokensOut: 0 }),
				persistFrozenSubagentInstructions: vi.fn(async () => undefined),
				finalizeSubagentHistory: vi.fn(async () => undefined),
				cancelCurrentRequest: vi.fn(),
				abortTask: vi.fn(async () => undefined),
				waitForTermination: vi.fn(() => lifecycle),
				isCompleted: () => boundary === "blocked",
				subagentCompletionOutcome: boundary === "blocked" ? ("blocked" as const) : undefined,
				hasPendingAsk: () => {
					observedWait()
					return boundary === "approval"
				},
				taskAsk: boundary === "recovery" ? { ts: 1, type: "ask", ask: "resume_task" } : undefined,
				start: () => started(),
			})
			;(provider as any).createTask = vi.fn(
				async (_prompt: string, _images: unknown, _parent: unknown, options: { taskId: string }) => {
					child.taskId = options.taskId
					return child
				},
			)
			const bounded = new BoundedDelegationManager((envelope, signal) =>
				(provider as any).runSubagentEnvelope(envelope, signal),
			)
			const runs = new AsyncSubagentRunManager(bounded)
			;(provider as any).boundedDelegationManager = bounded
			;(provider as any).asyncSubagentRunManager = runs
			const controller = new AbortController()
			const prepared = await provider.prepareSubagentGroup(parent as any, [
				{ objective: "Inspect the retained ticket", agent_kind: "review" },
			])
			const handle = await provider.launchPreparedSubagentGroup(parent as any, prepared, controller.signal)
			await startup
			resolveLifecycle()
			try {
				if (boundary !== "blocked") {
					await waitObserved
					expect(runs.getSnapshot(handle.taskId)?.status).toBe("running")
					expect(child.finalizeSubagentHistory).not.toHaveBeenCalled()
					expect(child.abortTask).not.toHaveBeenCalled()
					emitter.emit(AlphaCodeEventName.TaskCompleted, child.taskId, child.getTokenUsage())
				}
				await expect(runs.waitForResult(handle.taskId)).resolves.toMatchObject({
					status: boundary === "blocked" ? "blocked" : "completed",
				})
				expect(child.abortTask).not.toHaveBeenCalled()
			} finally {
				controller.abort()
				await runs.waitForResult(handle.taskId)
			}
		},
	)

	it("allows a requested task name that belongs to a different root task", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		await (provider as any).agentControlStoreReady
		const historicalRoot = await (provider as any).agentControlStore.ensureRoot({
			taskId: "historical-root",
			nickname: "root",
			objective: "Previous lifecycle test",
		})
		for (const [taskId, nickname, role] of [
			["historical-backend", "backend_review", "explore"],
			["historical-frontend", "frontend_review", "review"],
		] as const) {
			await (provider as any).agentControlStore.createAgent({
				taskId,
				parentTaskId: historicalRoot.taskId,
				rootTaskId: historicalRoot.rootTaskId,
				nickname,
				role,
				objective: "Previous review",
				status: "completed",
			})
		}
		;(provider as any).taskHistoryStore.getAll = () => [
			{
				id: "historical-backend",
				rootTaskId: "historical-root",
				parentTaskId: "historical-root",
				subagentNickname: "backend_review",
			},
			{
				id: "historical-frontend",
				rootTaskId: "historical-root",
				parentTaskId: "historical-root",
				subagentNickname: "frontend_review",
			},
		]
		;(provider as any).subagentDescriptors.set("historical-backend", {
			parent: { taskId: "historical-root" },
			nickname: "backend_review",
		})

		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ task_name: "backend_review", objective: "Inspect the backend", agent_kind: "explore" },
			{ task_name: "frontend_review", objective: "Inspect the frontend", agent_kind: "review" },
		])

		expect(prepared.group.agents.map((agent) => agent.nickname)).toEqual(["backend_review", "frontend_review"])
	})

	it("reuses a requested task name across roots prepared by the same provider", async () => {
		const provider = makeProviderHarness()
		const firstParent = makeParent()
		const secondParent = { ...makeParent(), taskId: "parent-2" }
		const drafts = [{ task_name: "history_churn_child", objective: "Inspect this root", agent_kind: "explore" }]

		const first = await provider.prepareSubagentGroup(firstParent as any, drafts)
		expect(first.group).toMatchObject({
			parentTaskId: firstParent.taskId,
			agents: [{ nickname: "history_churn_child" }],
		})

		const second = await provider.prepareSubagentGroup(secondParent as any, drafts)
		expect(second.group).toMatchObject({
			parentTaskId: secondParent.taskId,
			agents: [{ nickname: "history_churn_child" }],
		})
		expect(second.group.agents[0]!.taskId).not.toBe(first.group.agents[0]!.taskId)
	})

	it("keeps pending alias reservations scoped to their root during concurrent preparation", async () => {
		const provider = makeProviderHarness()
		const firstParent = makeParent()
		const secondParent = { ...makeParent(), taskId: "parent-2" }
		const captured = await firstParent.captureEffectiveInheritedInstructions()
		let entered!: () => void
		const captureEntered = new Promise<void>((resolve) => (entered = resolve))
		let release!: () => void
		const captureRelease = new Promise<void>((resolve) => (release = resolve))
		firstParent.captureEffectiveInheritedInstructions.mockImplementationOnce(async () => {
			entered()
			await captureRelease
			return captured
		})
		const drafts = [{ task_name: "shared_alias", objective: "Inspect this root", agent_kind: "review" }]
		const first = provider.prepareSubagentGroup(firstParent as any, drafts)
		try {
			await captureEntered
			await expect(provider.prepareSubagentGroup(firstParent as any, drafts)).rejects.toThrow("already in use")
			await expect(provider.prepareSubagentGroup(secondParent as any, drafts)).resolves.toMatchObject({
				group: { parentTaskId: secondParent.taskId, agents: [{ nickname: "shared_alias" }] },
			})
		} finally {
			release()
			await first
		}
	})

	it("reuses an alias after asynchronous preparation failure and never-launched cancellation", async () => {
		const provider = makeProviderHarness(1, { maxConcurrentSubagents: 1 })
		const parent = makeParent()
		const drafts = [{ task_name: "retry_alias", objective: "Inspect this root", agent_kind: "explore" }]
		parent.captureEffectiveInheritedInstructions.mockRejectedValueOnce(new Error("capture failed"))
		await expect(provider.prepareSubagentGroup(parent as any, drafts)).rejects.toThrow("capture failed")
		const first = await provider.prepareSubagentGroup(parent as any, drafts)
		await provider.cancelPreparedSubagentGroup(parent as any, first, "Preparation cancelled")
		await expect(provider.prepareSubagentGroup(parent as any, drafts)).resolves.toMatchObject({
			group: { agents: [{ nickname: "retry_alias" }] },
		})
	})

	it("rolls back an alias rejected by root capacity without releasing the admitted sibling", async () => {
		const provider = makeProviderHarness(2, { maxConcurrentSubagents: 1 })
		const parent = makeParent()
		const first = await provider.prepareSubagentGroup(parent as any, [
			{ task_name: "admitted_alias", objective: "Inspect this root", agent_kind: "explore" },
		])
		const drafts = [{ task_name: "retry_alias", objective: "Inspect another case", agent_kind: "review" }]
		await expect(provider.prepareSubagentGroup(parent as any, drafts)).rejects.toThrow("root-wide child capacity")
		await expect(
			provider.prepareSubagentGroup(parent as any, [
				{ task_name: "admitted_alias", objective: "Collide with the admitted child", agent_kind: "review" },
			]),
		).rejects.toThrow("already in use")
		await provider.cancelPreparedSubagentGroup(parent as any, first, "Preparation cancelled")
		await expect(provider.prepareSubagentGroup(parent as any, drafts)).resolves.toMatchObject({
			group: { agents: [{ nickname: "retry_alias" }] },
		})
	})

	it("releases unlaunched reservations even when persisting the cancelled card fails", async () => {
		const provider = makeProviderHarness(1, { maxConcurrentSubagents: 1 })
		const parent = makeParent()
		const drafts = [{ task_name: "cancel_retry", objective: "Inspect this root", agent_kind: "explore" }]
		const prepared = await provider.prepareSubagentGroup(parent as any, drafts)
		const failure = new Error("Cancelled card persistence failed")
		parent.upsertSubagentGroup.mockRejectedValueOnce(failure)

		await expect(provider.cancelPreparedSubagentGroup(parent as any, prepared, "Approval denied")).rejects.toBe(
			failure,
		)
		expect(prepared.group.status).toBe("cancelled")
		expect(Reflect.get(provider, "preparedSubagentGroups").has(prepared.group.groupId)).toBe(false)
		expect(Reflect.get(provider, "reservedSubagentSlots").has(prepared.group.groupId)).toBe(false)
		expect(Reflect.get(provider, "subagentDescriptors").has(prepared.envelopes[0].id)).toBe(false)
		await expect(provider.cancelPreparedSubagentGroup(parent as any, prepared, "Retry cancellation")).resolves.toBe(
			undefined,
		)
		await expect(provider.prepareSubagentGroup(parent as any, drafts)).resolves.toMatchObject({
			group: { agents: [{ nickname: "cancel_retry" }] },
		})
	})

	it("routes a shared alias to the caller's root after both preparations launch", async () => {
		const provider = makeProviderHarness()
		const firstParent = makeParent()
		const secondParent = { ...makeParent(), taskId: "parent-2" }
		let release!: () => void
		const finish = new Promise<void>((resolve) => (release = resolve))
		const bounded = new BoundedDelegationManager(async (envelope) => {
			await finish
			return {
				taskId: envelope.id,
				status: "completed" as const,
				summary: "Reviewed",
				evidence: [],
				changedFiles: [],
				verification: [],
				remainingRisks: [],
				usage: { durationMs: 1 },
			}
		})
		const runs = new AsyncSubagentRunManager(bounded)
		;(provider as any).boundedDelegationManager = bounded
		;(provider as any).asyncSubagentRunManager = runs
		const drafts = [{ task_name: "shared_alias", objective: "Inspect this root", agent_kind: "review" }]
		const first = await provider.prepareSubagentGroup(firstParent as any, drafts)
		const second = await provider.prepareSubagentGroup(secondParent as any, drafts)
		const firstHandle = await provider.launchPreparedSubagentGroup(
			firstParent as any,
			first,
			new AbortController().signal,
		)
		const secondHandle = await provider.launchPreparedSubagentGroup(
			secondParent as any,
			second,
			new AbortController().signal,
		)
		try {
			await expect(
				provider.sendMessageToAgent(firstParent as any, "shared_alias", "First root message"),
			).resolves.toMatchObject({ taskId: firstHandle.taskId, path: firstHandle.path, delivery: "buffered" })
			await expect(
				provider.sendMessageToAgent(secondParent as any, "shared_alias", "Second root message"),
			).resolves.toMatchObject({ taskId: secondHandle.taskId, path: secondHandle.path, delivery: "buffered" })
			await expect(provider.listAgents(firstParent as any)).resolves.toMatchObject({
				rootTaskId: firstParent.taskId,
				agents: [{ taskId: firstHandle.taskId }],
			})
			await expect(provider.listAgents(secondParent as any)).resolves.toMatchObject({
				rootTaskId: secondParent.taskId,
				agents: [{ taskId: secondHandle.taskId }],
			})
		} finally {
			release()
			await Promise.all([runs.waitForResult(firstHandle.taskId), runs.waitForResult(secondHandle.taskId)])
		}
	})

	it("rejects a requested task name retained in the current root task", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const root = await (provider as any).ensureAgentControlRoot(parent)
		await (provider as any).agentControlStore.createAgent({
			taskId: "retained-backend",
			parentTaskId: root.taskId,
			rootTaskId: root.rootTaskId,
			nickname: "backend_review",
			role: "explore",
			objective: "Retained backend review",
			status: "completed",
		})

		await expect(
			provider.prepareSubagentGroup(parent as any, [
				{ task_name: "backend_review", objective: "Inspect the backend again", agent_kind: "explore" },
			]),
		).rejects.toThrow('Sub-agent task_name "backend_review" is already in use')
	})

	it("ignores obsolete role profiles and inherits the parent without exposing credentials", async () => {
		const provider = makeProviderHarness(
			2,
			{
				subagentDefaultApiConfigId: "default-id",
				subagentApiConfigByRole: { explore: "explore-id", review: "review-id" },
			},
			[
				{
					id: "explore-id",
					name: "Fast Explorer",
					apiProvider: "openai",
					openAiModelId: "fast/model",
					openAiApiKey: "explore-secret",
				},
				{
					id: "review-id",
					name: "Deep Reviewer",
					apiProvider: "vertex",
					apiModelId: "review-model",
					vertexJsonCredentials: "review-secret",
				},
			],
		)
		const parent = makeParent()
		const originalParentConfiguration = structuredClone(parent.apiConfiguration)

		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Explore", agent_kind: "explore" },
			{ objective: "Review", agent_kind: "review" },
		])

		expect(prepared.envelopes.map((envelope) => envelope.modelRoute)).toEqual([
			expect.objectContaining({ provider: "openai", model: "alpha-model" }),
			expect.objectContaining({ provider: "openai", model: "alpha-model" }),
		])
		expect(prepared.group.agents.map((agent) => agent.modelRoute)).toEqual([
			expect.objectContaining({ source: "parent", profileName: "Parent", modelId: "alpha-model" }),
			expect.objectContaining({ source: "parent", profileName: "Parent", modelId: "alpha-model" }),
		])
		expect(JSON.stringify(prepared.group)).not.toContain("secret")
		expect(parent.apiConfiguration).toEqual(originalParentConfiguration)
	})

	it.each(["explore", "review"] as const)(
		"ignores obsolete profile defaults for an unrouted %s role",
		async (role) => {
			const provider = makeProviderHarness(2, { subagentDefaultApiConfigId: "default-id" }, [
				{ id: "default-id", name: "Default child", apiProvider: "openai", openAiModelId: "default-model" },
			])
			const prepared = await provider.prepareSubagentGroup(makeParent() as any, [
				{ objective: "Inspect the configured default", agent_kind: role },
			])
			expect(prepared.group.agents[0].modelRoute).toMatchObject({
				source: "parent",
				profileName: "Parent",
				modelId: "alpha-model",
			})
		},
	)

	it.each([
		["missing-id", "missing"],
		["unconfigured-id", "unconfigured"],
	] as const)(
		"ignores an obsolete %s role profile instead of selecting another provider",
		async (profileId, _reason) => {
			const provider = makeProviderHarness(
				2,
				{ subagentDefaultApiConfigId: "default-id", subagentApiConfigByRole: { review: profileId } },
				[
					{ id: "default-id", name: "Default child", apiProvider: "openai", openAiModelId: "default-model" },
					{ id: "unconfigured-id", name: "Incomplete" },
				],
			)
			const prepared = await provider.prepareSubagentGroup(makeParent() as any, [
				{ objective: "Inspect the unavailable profile", agent_kind: "review" },
			])
			expect(prepared.group.agents[0].modelRoute).toMatchObject({
				source: "parent",
				resolution: "selected",
				profileName: "Parent",
				modelId: "alpha-model",
			})
		},
	)

	it("ignores stale role routes when restoring a manifest-less child", async () => {
		const provider = makeProviderHarness(
			2,
			{
				subagentDefaultApiConfigId: "default-id",
				subagentApiConfigByRole: { explore: "explore-id" },
			},
			[
				{ id: "default-id", name: "Legacy default", apiProvider: "vertex", apiModelId: "old-default" },
				{ id: "explore-id", name: "Legacy explorer", apiProvider: "openai", openAiModelId: "old-explore" },
			],
		)
		const parent = makeParent()

		const restored = await (provider as any).restoreCapturedSubagentModelRoute(
			parent,
			"explore",
			{ id: "legacy-child" },
			undefined,
		)

		expect(restored.route).toMatchObject({
			source: "parent",
			profileName: "Parent",
			provider: "openai",
			modelId: "alpha-model",
		})
		expect(restored.apiConfiguration).toMatchObject({ apiProvider: "openai", openAiModelId: "alpha-model" })
	})

	it("restores a historical child profile without applying today's role or default routes", async () => {
		const provider = makeProviderHarness(
			2,
			{ subagentDefaultApiConfigId: "new-default", subagentApiConfigByRole: { explore: "new-role" } },
			[
				{
					id: "historical-id",
					name: "Historical child",
					apiProvider: "vertex",
					apiModelId: "historical-model",
				},
				{ id: "new-default", name: "New default", apiProvider: "openai", openAiModelId: "new-default-model" },
				{ id: "new-role", name: "New explorer", apiProvider: "openai", openAiModelId: "new-role-model" },
			],
		)
		const restored = await (provider as any).restoreCapturedSubagentModelRoute(
			makeParent(),
			"explore",
			{ id: "historical-child", apiConfigName: "Historical child" },
			undefined,
		)
		expect(restored.route).toMatchObject({
			profileId: "historical-id",
			profileName: "Historical child",
			provider: "vertex",
			modelId: "historical-model",
		})
		expect(restored.apiConfiguration).toMatchObject({ apiProvider: "vertex", apiModelId: "historical-model" })
	})

	it("fails closed when a known historical child profile has been deleted", async () => {
		const provider = makeProviderHarness(2, { subagentDefaultApiConfigId: "new-default" })
		await expect(
			(provider as any).restoreCapturedSubagentModelRoute(
				makeParent(),
				"review",
				{ id: "historical-child", apiConfigName: "Deleted child profile" },
				undefined,
			),
		).rejects.toThrow("Cannot resume child")
	})

	it.each(["manifest", "history"] as const)(
		"restores a captured route by stable ID from %s despite changed routing settings",
		async (source) => {
			const profiles = [
				{ id: "captured-id", name: "Captured child", apiProvider: "vertex", apiModelId: "profile-model" },
				{
					id: "replacement-id",
					name: "Replacement",
					apiProvider: "openai",
					openAiModelId: "replacement-model",
				},
			]
			const settings = { subagentApiConfigByRole: { review: "captured-id" } }
			const provider = makeProviderHarness(2, settings, profiles)
			const parent = makeParent()
			const prepared = await provider.prepareSubagentGroup(parent as any, {
				task_name: "captured_route",
				message: "Inspect captured settings",
				agent_type: "review",
				model: "captured-model",
				reasoning_effort: "high",
			})
			const manifest = Reflect.get(provider, "subagentDescriptors").get(prepared.envelopes[0].id).contextManifest
			// Simulate a legacy route captured before profile routing was retired.
			manifest.modelRoute = {
				source: "role",
				resolution: "selected",
				profileId: "captured-id",
				profileName: "Captured child",
				provider: "vertex",
				modelId: "captured-model",
				requestedModelId: "captured-model",
				requestedReasoningEffort: "high",
			}
			settings.subagentApiConfigByRole.review = "replacement-id"
			profiles[0].name = "Renamed captured child"
			profiles[0].apiModelId = "changed-profile-model"
			const restored = await (provider as any).restoreCapturedSubagentModelRoute(
				parent,
				"review",
				{
					id: prepared.envelopes[0].id,
					apiConfigName: "Captured child",
					...(source === "history" ? { subagentModelRoute: manifest.modelRoute } : {}),
				},
				source === "manifest" ? manifest : undefined,
			)
			expect(restored.apiConfigName).toBe("Renamed captured child")
			expect(restored.route).toMatchObject({
				profileId: "captured-id",
				provider: "vertex",
				modelId: "captured-model",
			})
			expect(restored.apiConfiguration).toMatchObject({
				apiProvider: "vertex",
				apiModelId: "captured-model",
				reasoningEffort: "high",
			})
		},
	)

	it.each([
		{ apiProvider: "openai", openAiModelId: "other-model" },
		{ apiProvider: "vertex", apiModelId: "captured-model" },
	])("rejects captured profile drift on reload: %j", async (changedConfiguration) => {
		const profiles: Array<Record<string, unknown>> = [
			{ id: "captured-id", name: "Captured child", apiProvider: "openai", openAiModelId: "captured-model" },
		]
		const provider = makeProviderHarness(2, { subagentDefaultApiConfigId: "captured-id" }, profiles)
		const parent = makeParent()
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect captured route", agent_kind: "review" },
		])
		const manifest = Reflect.get(provider, "subagentDescriptors").get(prepared.envelopes[0].id).contextManifest
		manifest.modelRoute = {
			source: "default",
			resolution: "selected",
			profileId: "captured-id",
			profileName: "Captured child",
			provider: "openai",
			modelId: "captured-model",
		}
		Object.assign(profiles[0], changedConfiguration)
		await expect(
			(provider as any).restoreCapturedSubagentModelRoute(
				parent,
				"review",
				{ id: prepared.envelopes[0].id },
				manifest,
			),
		).rejects.toThrow("Cannot resume child: captured")
	})

	it("captures configured Worker routing before an awaited workspace-scope check", async () => {
		const settings = { subagentDefaultModel: "captured-model" }
		const provider = makeProviderHarness(2, settings, [
			{ id: "captured-worker", name: "Captured Worker", apiProvider: "openai", openAiModelId: "captured-model" },
			{ id: "later-worker", name: "Later Worker", apiProvider: "openai", openAiModelId: "later-model" },
		])
		const parent = makeParent()
		let entered!: () => void
		const checkingScope = new Promise<void>((resolve) => (entered = resolve))
		let release!: () => void
		const pendingScope = new Promise<void>((resolve) => (release = resolve))
		vi.spyOn(managedSubagentWorktreeService, "validateScope").mockImplementation(async () => {
			entered()
			await pendingScope
			return {
				gitRoot: parent.cwd,
				logicalWorkspace: parent.cwd,
				logicalWorkspaceFromRoot: "",
				writeScope: ["."],
				gitRelativeScope: ["."],
				fileWriteScope: [],
				gitRelativeFileScope: [],
			}
		})
		const preparing = provider.prepareSubagentGroup(parent as any, {
			task_name: "frozen_worker_route",
			message: "Inspect the captured Worker route",
			fork_turns: "none",
		})
		await checkingScope
		settings.subagentDefaultModel = "later-model"
		release()
		const prepared = await preparing
		expect(prepared.group.agents[0].modelRoute).toMatchObject({
			source: "spawn",
			modelId: "captured-model",
		})
	})

	it("clears deleted profile references without disturbing another role", async () => {
		const settings = {
			subagentDefaultApiConfigId: "deleted-id",
			subagentApiConfigByRole: { explore: "deleted-id", review: "review-id" },
		}
		const provider = makeProviderHarness(2, settings)

		await provider.clearSubagentProfileReferences("deleted-id")

		expect((provider as any).contextProxy.setValues).toHaveBeenCalledWith({
			subagentDefaultApiConfigId: undefined,
			subagentApiConfigByRole: { review: "review-id" },
		})
	})

	it("launches concurrent children with the inherited parent route", async () => {
		const provider = makeProviderHarness(
			2,
			{ subagentApiConfigByRole: { explore: "explore-id", review: "review-id" } },
			[
				{
					id: "explore-id",
					name: "Fast Explorer",
					apiProvider: "openai",
					openAiModelId: "fast/model",
					openAiApiKey: "explore-secret",
				},
				{
					id: "review-id",
					name: "Deep Reviewer",
					apiProvider: "vertex",
					apiModelId: "review-model",
					vertexJsonCredentials: "review-secret",
				},
			],
		)
		const parent = makeParent()
		const parentSnapshot = structuredClone(parent.apiConfiguration)
		;(provider as any).taskSessions.getTask = (taskId: string) => (taskId === parent.taskId ? parent : undefined)

		let active = 0
		let peak = 0
		const launchOptions: any[] = []
		;(provider as any).createTask = vi.fn(
			async (_text: string, _images: unknown, _parent: unknown, options: any) => {
				launchOptions.push(options)
				const emitter = new EventEmitter()
				const child = Object.assign(emitter, {
					taskId: options.taskId,
					alphaMessages: [
						{
							type: "say",
							say: "completion_result",
							text: `${options.subagentRole} complete`,
						},
					],
					getTokenUsage: () => ({ totalTokensIn: 10, totalTokensOut: 5 }),
					persistFrozenSubagentInstructions: vi.fn(async () => undefined),
					finalizeSubagentHistory: vi.fn(async () => undefined),
					cancelCurrentRequest: vi.fn(),
					abortTask: vi.fn(async () => undefined),
					start() {
						active++
						peak = Math.max(peak, active)
						setTimeout(() => {
							active--
							emitter.emit(AlphaCodeEventName.TaskCompleted, options.taskId, {
								totalTokensIn: 10,
								totalTokensOut: 5,
							})
						}, 5)
					},
				})
				return child
			},
		)
		;(provider as any).boundedDelegationManager = new BoundedDelegationManager(
			(envelope, signal) => (provider as any).runSubagentEnvelope(envelope, signal),
			2,
		)

		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Explore", agent_kind: "explore" },
			{ objective: "Review", agent_kind: "review" },
		])
		const result = await provider.runSubagentGroup(parent as any, prepared, new AbortController().signal)

		expect(peak).toBe(2)
		expect(result.status).toBe("completed")
		expect(launchOptions).toHaveLength(2)
		for (const options of launchOptions) {
			expect(options).toMatchObject({
				taskApiConfigName: "Parent",
				apiConfiguration: parentSnapshot,
				subagentModelRoute: { source: "parent", modelId: "alpha-model" },
			})
		}
		expect(parent.apiConfiguration).toEqual(parentSnapshot)
	})

	it("preserves an explicitly blocked read-only completion as a blocked child", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		;(provider as any).taskSessions.getTask = (taskId: string) => (taskId === parent.taskId ? parent : undefined)

		let child: any
		;(provider as any).createTask = vi.fn(
			async (_text: string, _images: unknown, _parent: unknown, options: any) => {
				const emitter = new EventEmitter()
				child = Object.assign(emitter, {
					taskId: options.taskId,
					subagentCompletionOutcome: "blocked",
					alphaMessages: [
						{
							type: "say",
							say: "completion_result",
							text: "The objective needs authority that this read-only agent does not have.",
						},
					],
					getTokenUsage: () => ({ totalTokensIn: 10, totalTokensOut: 5 }),
					persistFrozenSubagentInstructions: vi.fn(async () => undefined),
					finalizeSubagentHistory: vi.fn(async () => undefined),
					cancelCurrentRequest: vi.fn(),
					abortTask: vi.fn(async () => undefined),
					start() {
						emitter.emit(AlphaCodeEventName.TaskCompleted, options.taskId, {
							totalTokensIn: 10,
							totalTokensOut: 5,
						})
					},
				})
				return child
			},
		)
		;(provider as any).boundedDelegationManager = new BoundedDelegationManager(
			(envelope, signal) => (provider as any).runSubagentEnvelope(envelope, signal),
			2,
		)

		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect an unavailable generated artifact", agent_kind: "explore" },
		])
		const result = await provider.runSubagentGroup(parent as any, prepared, new AbortController().signal)

		expect(result.status).toBe("failed")
		expect(result.agents[0]).toMatchObject({
			status: "blocked",
			summary: "The objective needs authority that this read-only agent does not have.",
		})
		expect(child.finalizeSubagentHistory).toHaveBeenCalledWith(
			"blocked",
			"The objective needs authority that this read-only agent does not have.",
			"completed",
		)
	})

	it.each([
		{
			label: "input",
			settings: { subagentMaxInputTokens: 10 },
			usage: { totalTokensIn: 11, totalTokensOut: 0, totalCost: 0 },
			stopReason: "input_token_limit",
			summary: "Sub-agent input token limit exceeded (11/10).",
		},
		{
			label: "output",
			settings: { subagentMaxOutputTokens: 10 },
			usage: { totalTokensIn: 0, totalTokensOut: 11, totalCost: 0 },
			stopReason: "output_token_limit",
			summary: "Sub-agent output token limit exceeded (11/10).",
		},
	] as const)("completes a child despite a retired $label token limit", async (testCase) => {
		const provider = makeProviderHarness(2, testCase.settings)
		const parent = makeParent()
		let child: any
		;(provider as any).createTask = vi.fn(
			async (_text: string, _images: unknown, _parent: unknown, options: any) => {
				const emitter = new EventEmitter()
				child = Object.assign(emitter, {
					taskId: options.taskId,
					getTaskLifetimeCancellationSignal: vi.fn().mockReturnValue(new AbortController().signal),
					taskKind: "subagent",
					rootTaskId: parent.taskId,
					alphaMessages: [
						{ type: "say", say: "completion_result", text: "This report exceeds the frozen limit." },
					],
					getTokenUsage: () => testCase.usage,
					persistFrozenSubagentInstructions: vi.fn(async () => undefined),
					finalizeSubagentHistory: vi.fn(async () => undefined),
					cancelCurrentRequest: vi.fn(),
					abortTask: vi.fn(async () => undefined),
					start() {
						emitter.emit(AlphaCodeEventName.TaskCompleted, options.taskId, testCase.usage)
					},
				})
				return child
			},
		)

		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: `Exercise the ${testCase.label} token ceiling`, agent_kind: "review" },
		])
		;(provider as any).finalizePreparedSubagentAuthorization(prepared)

		const result = await (provider as any).runSubagentEnvelope(prepared.envelopes[0], new AbortController().signal)

		expect(result).toMatchObject({ status: "completed", stopReason: "completed" })
		expect(prepared.group.agents[0]).toMatchObject({ status: "completed", stopReason: "completed" })
		expect(child.cancelCurrentRequest).not.toHaveBeenCalled()
		expect(child.abortTask).not.toHaveBeenCalled()
		expect(child.finalizeSubagentHistory).toHaveBeenCalledWith(
			"completed",
			"This report exceeds the frozen limit.",
			"completed",
		)
	})

	it("lets a default-budget child continue after three ordinary model requests", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const usage = { totalTokensIn: 22_084, totalTokensOut: 5_035, totalCost: 0 }
		let child: any
		;(provider as any).createTask = vi.fn(
			async (_text: string, _images: unknown, _parent: unknown, options: any) => {
				const emitter = new EventEmitter()
				child = Object.assign(emitter, {
					taskId: options.taskId,
					taskKind: "subagent",
					rootTaskId: parent.taskId,
					alphaMessages: [{ type: "say", say: "completion_result", text: "Review complete." }],
					getTokenUsage: () => usage,
					persistFrozenSubagentInstructions: vi.fn(async () => undefined),
					finalizeSubagentHistory: vi.fn(async () => undefined),
					cancelCurrentRequest: vi.fn(),
					abortTask: vi.fn(async () => undefined),
					start() {
						emitter.emit(AlphaCodeEventName.TaskCompleted, options.taskId, usage)
					},
				})
				return child
			},
		)

		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect existing test coverage", agent_kind: "review" },
		])
		;(provider as any).finalizePreparedSubagentAuthorization(prepared)

		const result = await (provider as any).runSubagentEnvelope(prepared.envelopes[0], new AbortController().signal)

		expect(result).toMatchObject({ status: "completed", summary: "Review complete." })
		expect(child.cancelCurrentRequest).not.toHaveBeenCalled()
		expect(child.abortTask).not.toHaveBeenCalled()
	})

	it("does not reuse a retained completion report when an immediate follow-up cancellation has no report", async () => {
		vi.spyOn(Date, "now").mockReturnValue(200)
		const provider = makeProviderHarness()
		const parent = makeParent()
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect the parser", agent_kind: "explore" },
		])
		;(provider as any).finalizePreparedSubagentAuthorization(prepared)
		const taskId = prepared.envelopes[0].id
		prepared.group.agents[0].startedAt = 200
		;(provider as any).__historyItems.set(taskId, {
			id: taskId,
			number: 2,
			ts: 100,
			task: "Inspect the parser",
			status: "completed",
			tokensIn: 10,
			tokensOut: 5,
			totalCost: 0,
		})
		;(provider as any).subagentDescriptors.get(taskId).pendingFollowup = "Check the cancellation edge case"

		let child: any
		let resolveAbort!: () => void
		;(provider as any).createTaskWithHistoryItem = vi.fn(async () => {
			const emitter = new EventEmitter()
			child = Object.assign(emitter, {
				taskId,
				getTaskLifetimeCancellationSignal: vi.fn().mockReturnValue(new AbortController().signal),
				alphaMessages: [
					// Deliberately collides with the current run's startedAt. Runtime message
					// boundaries, not timestamps, must keep this report out of the result.
					{ ts: 200, type: "say", say: "completion_result", text: "Initial retained report" },
					{
						ts: 110,
						type: "ask",
						ask: "tool",
						text: JSON.stringify({ tool: "readFile", path: "src/old-run.ts" }),
					},
				],
				getTokenUsage: () => ({ totalTokensIn: 10, totalTokensOut: 5 }),
				finalizeSubagentHistory: vi.fn(async () => undefined),
				cancelCurrentRequest: vi.fn(),
				abortTask: vi.fn(
					async () =>
						await new Promise<void>((resolve) => {
							resolveAbort = resolve
						}),
				),
				resumeSubagentFollowup: vi.fn(async () => await new Promise<void>(() => undefined)),
			})
			return child
		})

		const controller = new AbortController()
		const run = (provider as any).runSubagentEnvelope(prepared.envelopes[0], controller.signal)
		await vi.waitFor(() => expect(child.resumeSubagentFollowup).toHaveBeenCalledOnce())
		controller.abort(new Error("Follow-up cancelled by parent"))
		await vi.waitFor(() => expect(child.abortTask).toHaveBeenCalledOnce())
		let runSettled = false
		void run.then(() => {
			runSettled = true
		})
		await Promise.resolve()
		expect(runSettled).toBe(false)
		resolveAbort()
		const result = await run

		expect(result).toMatchObject({
			status: "cancelled",
			summary: "Cancelled before producing a final report. The partial transcript is preserved.",
			evidence: [],
		})
		expect(result.summary).not.toContain("Initial retained report")
		expect(result.summary).not.toContain("src/old-run.ts")
		expect(child.finalizeSubagentHistory).toHaveBeenCalledWith("cancelled", result.summary, "cancelled")
	})

	it("fails closed when cancellation cannot prove child cleanup", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		let child: any
		;(provider as any).createTask = vi.fn(
			async (_text: string, _images: unknown, _parent: unknown, options: any) => {
				const emitter = new EventEmitter()
				child = Object.assign(emitter, {
					taskId: options.taskId,
					getTaskLifetimeCancellationSignal: vi.fn().mockReturnValue(new AbortController().signal),
					taskKind: "subagent",
					rootTaskId: parent.taskId,
					alphaMessages: [],
					getTokenUsage: () => ({ totalTokensIn: 10, totalTokensOut: 5, totalCost: 0 }),
					persistFrozenSubagentInstructions: vi.fn(async () => undefined),
					finalizeSubagentHistory: vi.fn(async () => undefined),
					cancelCurrentRequest: vi.fn(),
					abortTask: vi.fn(async () => {
						throw new Error("process tree still alive")
					}),
					start: vi.fn(),
				})
				return child
			},
		)

		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Exercise cleanup failure", agent_kind: "review" },
		])
		;(provider as any).finalizePreparedSubagentAuthorization(prepared)
		const controller = new AbortController()
		const run = (provider as any).runSubagentEnvelope(prepared.envelopes[0], controller.signal)
		await vi.waitFor(() => expect(child?.start).toHaveBeenCalledOnce())

		controller.abort(new Error("Cancelled by parent"))
		const result = await run

		expect(result).toMatchObject({
			status: "failed",
			stopReason: "cancelled",
		})
		expect(result.summary).toContain("process tree still alive")
		expect(child.cancelCurrentRequest).toHaveBeenCalledOnce()
		expect(child.abortTask).toHaveBeenCalledOnce()
		expect(child.finalizeSubagentHistory).toHaveBeenCalledWith("failed", result.summary, "cancelled")
	})

	describe("retained follow-up lifecycle settlement", () => {
		const setupRetainedRun = async () => {
			const provider = makeProviderHarness()
			const parent = makeParent()
			const prepared = await provider.prepareSubagentGroup(parent as any, [
				{ objective: "Inspect the retained turn", agent_kind: "review" },
			])
			;(provider as any).finalizePreparedSubagentAuthorization(prepared)
			const taskId = prepared.envelopes[0].id
			;(provider as any).__historyItems.set(taskId, {
				id: taskId,
				number: 2,
				ts: 100,
				task: "Inspect the retained turn",
				status: "completed",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			})
			;(provider as any).subagentDescriptors.get(taskId).pendingFollowup = "Continue the retained turn"
			const root = await (provider as any).ensureAgentControlRoot(parent)
			await (provider as any).agentControlStore.createAgent({
				taskId,
				parentTaskId: root.taskId,
				rootTaskId: root.rootTaskId,
				groupId: prepared.group.groupId,
				nickname: prepared.group.agents[0].nickname,
				role: "review",
				objective: "Inspect the retained turn",
				status: "interrupted",
			})
			return { provider, prepared, taskId }
		}

		it.each(["failed", "incomplete", "exhausted"] as const)(
			"settles a fulfilled %s continuation without a terminal Task event",
			async (outcome) => {
				const { provider, prepared, taskId } = await setupRetainedRun()
				const child = Object.assign(new EventEmitter(), {
					taskId,
					getTaskLifetimeCancellationSignal: vi.fn().mockReturnValue(new AbortController().signal),
					alphaMessages: [],
					getTokenUsage: () => ({ totalTokensIn: 0, totalTokensOut: 0 }),
					finalizeSubagentHistory: vi.fn(async () => undefined),
					cancelCurrentRequest: vi.fn(),
					abortTask: vi.fn(async () => undefined),
					isCompleted: () => false,
					hasPendingAsk: () => false,
					resumeSubagentFollowup: vi.fn(async () => {
						child.emit(AlphaCodeEventName.Message, {
							action: "created",
							message: { ts: 201, type: "say", say: "error", text: `Turn ${outcome}` },
						})
					}),
				})
				;(provider as any).createTaskWithHistoryItem = vi.fn(async () => child)

				const result = await (provider as any).runSubagentEnvelope(
					prepared.envelopes[0],
					new AbortController().signal,
				)

				expect(result).toMatchObject({ status: "failed", stopReason: "failed" })
				expect(result.summary).toContain("Child lifecycle ended without a terminal result")
				expect(child.abortTask).toHaveBeenCalledOnce()
				expect(child.finalizeSubagentHistory).toHaveBeenCalledOnce()
			},
		)

		it.each(["completed", "blocked"] as const)(
			"settles a fulfilled %s continuation once when its Task event arrives late",
			async (outcome) => {
				const { provider, prepared, taskId } = await setupRetainedRun()
				const child = Object.assign(new EventEmitter(), {
					taskId,
					alphaMessages: [],
					getTokenUsage: () => ({ totalTokensIn: 0, totalTokensOut: 0 }),
					finalizeSubagentHistory: vi.fn(async () => undefined),
					cancelCurrentRequest: vi.fn(),
					abortTask: vi.fn(async () => undefined),
					isCompleted: () => true,
					subagentCompletionOutcome: outcome,
					resumeSubagentFollowup: vi.fn(async () => {
						child.emit(AlphaCodeEventName.Message, {
							action: "created",
							message: {
								ts: 201,
								type: "say",
								say: "completion_result",
								text: "Current continuation report",
							},
						})
					}),
				})
				;(provider as any).createTaskWithHistoryItem = vi.fn(async () => child)

				await expect(
					(provider as any).runSubagentEnvelope(prepared.envelopes[0], new AbortController().signal),
				).resolves.toMatchObject({
					status: outcome,
					stopReason: "completed",
					summary: "Current continuation report",
				})
				child.emit(AlphaCodeEventName.TaskCompleted, taskId, child.getTokenUsage())

				expect(child.abortTask).not.toHaveBeenCalled()
				expect(child.finalizeSubagentHistory).toHaveBeenCalledOnce()
			},
		)

		it.each(["active-ask", "task-ask"] as const)(
			"keeps a fulfilled continuation with a genuine %s pending until cancellation",
			async (askKind) => {
				const { provider, prepared, taskId } = await setupRetainedRun()
				const child = Object.assign(new EventEmitter(), {
					taskId,
					getTaskLifetimeCancellationSignal: vi.fn().mockReturnValue(new AbortController().signal),
					alphaMessages: [],
					getTokenUsage: () => ({ totalTokensIn: 0, totalTokensOut: 0 }),
					finalizeSubagentHistory: vi.fn(async () => undefined),
					cancelCurrentRequest: vi.fn(),
					abortTask: vi.fn(async () => undefined),
					isCompleted: () => false,
					hasPendingAsk: () => askKind === "active-ask",
					taskAsk: askKind === "task-ask" ? "tool" : undefined,
					resumeSubagentFollowup: vi.fn(async () => undefined),
				})
				;(provider as any).createTaskWithHistoryItem = vi.fn(async () => child)
				const controller = new AbortController()
				vi.useFakeTimers()
				const run = (provider as any).runSubagentEnvelope(prepared.envelopes[0], controller.signal)
				let settled = false
				void run.then(() => (settled = true))
				try {
					await vi.advanceTimersByTimeAsync(0)
					expect(child.resumeSubagentFollowup).toHaveBeenCalledOnce()
					expect(settled).toBe(false)
					expect(child.abortTask).not.toHaveBeenCalled()
					controller.abort(new Error("Pending ask cancelled by parent"))
					await expect(run).resolves.toMatchObject({ status: "cancelled" })
					expect(child.abortTask).toHaveBeenCalledOnce()
					expect(child.finalizeSubagentHistory).toHaveBeenCalledOnce()
				} finally {
					controller.abort()
					await run
					vi.useRealTimers()
				}
			},
		)

		it("joins rejected-continuation cleanup and settles once when cancellation races it", async () => {
			const { provider, prepared, taskId } = await setupRetainedRun()
			let enterCleanup!: () => void
			const cleanupEntered = new Promise<void>((resolve) => (enterCleanup = resolve))
			let releaseCleanup!: () => void
			const cleanup = new Promise<void>((resolve) => (releaseCleanup = resolve))
			const child = Object.assign(new EventEmitter(), {
				taskId,
				getTaskLifetimeCancellationSignal: vi.fn().mockReturnValue(new AbortController().signal),
				alphaMessages: [],
				getTokenUsage: () => ({ totalTokensIn: 0, totalTokensOut: 0 }),
				finalizeSubagentHistory: vi.fn(async () => undefined),
				cancelCurrentRequest: vi.fn(),
				abortTask: vi.fn(async () => {
					enterCleanup()
					await cleanup
				}),
				resumeSubagentFollowup: vi.fn(async () => {
					throw new Error("Retained loop failed")
				}),
			})
			;(provider as any).createTaskWithHistoryItem = vi.fn(async () => child)
			const stopDescendants = vi.spyOn(provider as any, "cancelManagedTaskDescendants").mockResolvedValue([])
			const controller = new AbortController()
			const run = (provider as any).runSubagentEnvelope(prepared.envelopes[0], controller.signal)
			try {
				await cleanupEntered
				expect(stopDescendants).toHaveBeenCalledOnce()
				expect(child.cancelCurrentRequest).toHaveBeenCalledOnce()
				expect(child.finalizeSubagentHistory).not.toHaveBeenCalled()
				controller.abort(new Error("Parent cancelled during cleanup"))
				releaseCleanup()
				await expect(run).resolves.toMatchObject({ status: "failed", stopReason: "failed" })
				expect(child.abortTask).toHaveBeenCalledOnce()
				expect(child.finalizeSubagentHistory).toHaveBeenCalledOnce()
			} finally {
				releaseCleanup()
				controller.abort()
				await run
			}
		})
	})

	it("uses the current report when a retained follow-up completes successfully", async () => {
		vi.spyOn(Date, "now").mockReturnValue(200)
		const provider = makeProviderHarness()
		const parent = makeParent()
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect the parser", agent_kind: "explore" },
		])
		;(provider as any).finalizePreparedSubagentAuthorization(prepared)
		const taskId = prepared.envelopes[0].id
		const goalAccountingBinding = Promise.resolve(undefined)
		const admissionOrder: string[] = []
		;(provider as any).subagentDescriptors.get(taskId).goalAccountingBinding = goalAccountingBinding
		prepared.group.agents[0].startedAt = 200
		;(provider as any).__historyItems.set(taskId, {
			id: taskId,
			number: 2,
			ts: 100,
			task: "Inspect the parser",
			status: "completed",
			tokensIn: 10,
			tokensOut: 5,
			totalCost: 0,
		})
		;(provider as any).subagentDescriptors.get(taskId).pendingFollowup = "Check one more edge case"
		const root = await (provider as any).ensureAgentControlRoot(parent)
		await (provider as any).agentControlStore.createAgent({
			taskId,
			parentTaskId: root.taskId,
			rootTaskId: root.rootTaskId,
			groupId: prepared.group.groupId,
			nickname: prepared.group.agents[0].nickname,
			role: prepared.group.agents[0].role,
			objective: prepared.group.agents[0].objective,
			status: "interrupted",
		})
		const legacySteering = await (provider as any).agentControlStore.appendEvent({
			rootTaskId: parent.taskId,
			sender: parent.taskId,
			recipient: taskId,
			kind: "message",
			name: "parent_message",
			payload: { message: "PING_BEFORE_INTERRUPT" },
		})
		await (provider as any).agentControlStore.markDelivered(taskId, legacySteering.entry.sequence, parent.taskId)

		let child: any
		;(provider as any).createTaskWithHistoryItem = vi.fn(async () => {
			const emitter = new EventEmitter()
			child = Object.assign(emitter, {
				taskId,
				alphaMessages: [{ ts: 200, type: "say", say: "completion_result", text: "Initial retained report" }],
				getTokenUsage: () => ({ totalTokensIn: 15, totalTokensOut: 8 }),
				readmitGoalAccountingBinding: vi.fn(async () => {
					admissionOrder.push("admitted")
				}),
				finalizeSubagentHistory: vi.fn(async () => undefined),
				cancelCurrentRequest: vi.fn(),
				abortTask: vi.fn(async () => undefined),
				resumeSubagentFollowup: vi.fn(async (instruction: string, onPersisted?: () => Promise<void>) => {
					admissionOrder.push("resumed")
					expect(instruction).toBe("Check one more edge case")
					await provider.deliverAgentMessages(
						{ taskId, taskKind: "subagent", rootTaskId: parent.taskId } as any,
						async (message) => {
							expect(message.text).toBe("PING_BEFORE_INTERRUPT")
						},
					)
					await onPersisted?.()
					const message = {
						ts: 201,
						type: "say",
						say: "completion_result",
						text: "Current follow-up report",
					}
					child.alphaMessages.push(message)
					emitter.emit(AlphaCodeEventName.Message, { action: "created", message })
					emitter.emit(AlphaCodeEventName.TaskCompleted, taskId, {
						totalTokensIn: 15,
						totalTokensOut: 8,
					})
				}),
			})
			return child
		})

		const result = await (provider as any).runSubagentEnvelope(prepared.envelopes[0], new AbortController().signal)

		expect(result).toMatchObject({ status: "completed", summary: "Current follow-up report" })
		expect(child.readmitGoalAccountingBinding).toHaveBeenCalledWith(goalAccountingBinding, parent)
		expect(admissionOrder).toEqual(["admitted", "resumed"])
		expect(result.summary).not.toContain("Initial retained report")
		expect(child.finalizeSubagentHistory).toHaveBeenCalledWith("completed", "Current follow-up report", "completed")
		expect(
			(provider as any).agentControlStore.getUnacknowledgedMailboxEntries(taskId, {
				rootTaskId: parent.taskId,
				kinds: ["message"],
			}),
		).toEqual([])
	})

	it("does not overwrite an agent's completion timestamp during group finalization", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		;(provider as any).taskSessions.getTask = (taskId: string) => (taskId === parent.taskId ? parent : undefined)
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect the parser", agent_kind: "explore" },
		])
		const agent = prepared.group.agents[0]
		agent.completedAt = 1_234

		await (provider as any).applySubagentResult(prepared, {
			taskId: agent.taskId,
			status: "completed",
			summary: "Parser inspected",
			usage: { durationMs: 10 },
			changedFiles: [],
		})

		expect(agent.completedAt).toBe(1_234)
	})

	it("completes a Worker whose objective is satisfied without a repository change", async () => {
		let now = 1_000
		vi.spyOn(Date, "now").mockImplementation(() => now)
		const provider = makeProviderHarness()
		const parent = {
			...makeParent(),
			historyWorkspacePath: "F:/workspace",
		}
		;(provider as any).context = { globalStorageUri: { fsPath: "F:/storage" } }
		;(provider as any).taskSessions.getTask = (taskId: string) => (taskId === parent.taskId ? parent : undefined)

		const scope = {
			gitRoot: "F:/workspace",
			logicalWorkspace: "F:/workspace",
			logicalWorkspaceFromRoot: "",
			writeScope: ["docs"],
			gitRelativeScope: ["docs"],
			fileWriteScope: ["docs"],
			gitRelativeFileScope: ["docs"],
		}
		const artifact = {
			id: "change-set-1",
			taskId: "worker-1",
			status: "discarded" as const,
			createdAt: 10,
			updatedAt: 20,
			gitRoot: "F:/workspace",
			logicalWorkspace: "F:/workspace",
			logicalWorkspaceFromRoot: "",
			baselineCommit: "baseline",
			resultCommit: "result",
			writeScope: ["docs"],
			gitRelativeScope: ["docs"],
			fileWriteScope: ["docs"],
			gitRelativeFileScope: ["docs"],
			patchFile: "changes.patch",
			changes: [],
		}

		vi.spyOn(managedSubagentWorktreeService, "validateScope").mockResolvedValue(scope)
		vi.spyOn(managedSubagentWorktreeService, "create").mockResolvedValue({
			artifact: { ...artifact, status: "active", worktreePath: "F:/storage/worktree" },
			workspacePath: "F:/storage/worktree",
		})
		vi.spyOn(managedSubagentWorktreeService, "capture").mockImplementation(async () => {
			now += 75
			return artifact
		})

		let child: any
		;(provider as any).createTask = vi.fn(
			async (_text: string, _images: unknown, _parent: unknown, options: any) => {
				const emitter = new EventEmitter()
				child = Object.assign(emitter, {
					taskId: options.taskId,
					getCommandExecutionEvidence: () => [
						{
							toolCallId: "worker-command",
							executionId: "worker-execution",
							status: "succeeded",
							exitCode: 0,
							startedAt: 1,
							completedAt: 2,
						},
					],
					alphaMessages: [
						{ type: "say", say: "completion_result", text: "No documentation change was needed." },
					],
					getTokenUsage: () => ({ totalTokensIn: 10, totalTokensOut: 5 }),
					persistFrozenSubagentInstructions: vi.fn(async () => undefined),
					finalizeSubagentHistory: vi.fn(async () => {
						now += 50
					}),
					setSubagentChangeSet: vi.fn(),
					cancelCurrentRequest: vi.fn(),
					abortTask: vi.fn(async () => undefined),
					start() {
						emitter.emit(AlphaCodeEventName.TaskCompleted, options.taskId, {
							totalTokensIn: 10,
							totalTokensOut: 5,
						})
					},
				})
				return child
			},
		)
		;(provider as any).boundedDelegationManager = new BoundedDelegationManager(
			(envelope, signal) => (provider as any).runSubagentEnvelope(envelope, signal),
			2,
		)

		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{
				objective: "Review whether a bounded documentation change is needed; apply it only if required",
				agent_kind: "worker",
				write_scope: ["docs"],
			},
		])
		const result = await provider.runSubagentGroup(parent as any, prepared, new AbortController().signal)

		expect(result.status).toBe("completed")
		expect(result.agents[0]).toMatchObject({
			role: "worker",
			status: "completed",
			usage: { durationMs: 125 },
			changedFiles: [],
			verification: [{ label: "Worker command 1", status: "passed", detail: "Exit code 0" }],
		})
		expect(result.agents[0]?.changeSet).toBeUndefined()
		expect(child.setSubagentChangeSet).not.toHaveBeenCalled()
		expect(result.agents[0]?.summary).toBe("No documentation change was needed.")
		expect(result.agents[0]?.error).toBeUndefined()
		expect((provider as any).agentControlStore.getVerificationObligations({ parentTaskId: parent.taskId })).toEqual(
			[],
		)
		expect(child.finalizeSubagentHistory).toHaveBeenCalledWith(
			"completed",
			"No documentation change was needed.",
			"completed",
		)
	})

	it("derives credential-free worker verification from structured command results", () => {
		const provider = makeProviderHarness()
		const child = {
			getCommandExecutionEvidence: () => [
				{
					toolCallId: "command-1",
					executionId: "execution-1",
					status: "succeeded",
					exitCode: 0,
					startedAt: 1,
					completedAt: 2,
				},
				{
					toolCallId: "command-2",
					executionId: "execution-2",
					status: "failed",
					exitCode: 2,
					startedAt: 3,
					completedAt: 4,
				},
				{
					toolCallId: "command-3",
					executionId: "execution-3",
					status: "running",
					startedAt: 5,
				},
			],
		}

		const results = (provider as any).getWorkerCommandResults(child)
		const display = (provider as any).getWorkerVerification(results)

		expect(results).toEqual([
			{ status: "passed", exitCode: 0 },
			{ status: "failed", exitCode: 2 },
			{ status: "running", exitCode: undefined },
		])
		expect(display).toEqual([
			{ label: "Worker command 1", status: "passed", detail: "Exit code 0" },
			{ label: "Worker command 2", status: "failed", detail: "Exit code 2" },
			{
				label: "Worker command 3",
				status: "running",
				detail: "The command is still running.",
			},
		])
		expect(JSON.stringify(display)).not.toContain("SECRET_VALUE")
	})

	it("reports that targeted verification was not run when a worker used no commands", () => {
		const provider = makeProviderHarness()
		expect((provider as any).getWorkerVerification([])).toEqual([
			{
				label: "Targeted verification",
				status: "not_run",
				detail: "The worker did not run a verification command.",
			},
		])
	})

	it("rejects public drafts that attempt to smuggle authority fields", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()

		await expect(
			provider.prepareSubagentGroup(parent as any, [
				{ objective: "Edit anyway", agent_kind: "review", mutate: true } as any,
			]),
		).rejects.toThrow("unsupported authority fields")
	})

	it("keeps explicit-only approval provisional during preparation and freezes group approval at launch", async () => {
		const provider = makeProviderHarness(2, { approvalMode: "ask", subagentMaxDepth: 2 })
		const parent = makeParent()
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect nested lifecycle", agent_kind: "review" },
		])
		const taskId = prepared.envelopes[0].id
		const before = (provider as any).subagentDescriptors.get(taskId).contextManifest

		expect(prepared.requiresExplicitApproval).toBe(true)
		expect(before.orchestration.delegationPolicy).toMatchObject({
			policy: "explicit-only",
			authorization: "pending-approval",
			explicitUserRequest: false,
		})
		expect(finalizedSubagentContextManifestSchema.safeParse(before).success).toBe(false)

		vi.spyOn(provider as any, "startPreparedSubagentRun").mockResolvedValue({ taskId })
		await provider.launchPreparedSubagentGroup(parent as any, prepared, new AbortController().signal)

		const after = (provider as any).subagentDescriptors.get(taskId).contextManifest
		expect(after.orchestration.delegationPolicy).toMatchObject({
			policy: "explicit-only",
			authorization: "group-approval",
			explicitUserRequest: true,
		})
		expect(finalizedSubagentContextManifestSchema.safeParse(after).success).toBe(true)
		expect(after.manifestDigest).not.toBe(before.manifestDigest)
	})

	it("ignores the retired proactive setting while preserving session grants and task opt-in", async () => {
		const autoApproval = {
			approvalMode: "auto" as const,
			autoApprovalEnabled: true,
			alwaysAllowSubagents: true,
			alwaysAllowReadOnly: true,
		}
		const proactiveProvider = makeProviderHarness(2, {
			...autoApproval,
			subagentDelegationPolicy: "proactive",
		})
		const proactiveParent = makeParent()
		const proactive = await proactiveProvider.prepareSubagentGroup(proactiveParent as any, [
			{ objective: "Proactively inspect recovery", agent_kind: "explore" },
		])
		const proactiveManifest = (proactiveProvider as any).subagentDescriptors.get(
			proactive.envelopes[0].id,
		).contextManifest
		expect(proactive.requiresExplicitApproval).toBe(false)
		expect(proactiveManifest.orchestration.delegationPolicy).toMatchObject({
			policy: "explicit-only",
			source: "default",
			authorization: "session-policy",
			explicitUserRequest: false,
		})
		expect(finalizedSubagentContextManifestSchema.safeParse(proactiveManifest).success).toBe(true)

		const optedInProvider = makeProviderHarness(2, autoApproval)
		const optedInParent = { ...makeParent(), subagentDelegationExplicitlyEnabled: true }
		const optedIn = await optedInProvider.prepareSubagentGroup(optedInParent as any, [
			{ objective: "Inspect with persisted task opt-in", agent_kind: "review" },
		])
		const optedInManifest = (optedInProvider as any).subagentDescriptors.get(
			optedIn.envelopes[0].id,
		).contextManifest
		expect(optedIn.requiresExplicitApproval).toBe(false)
		expect(optedInManifest.orchestration.delegationPolicy).toMatchObject({
			policy: "explicit-only",
			authorization: "task-opt-in",
			explicitUserRequest: true,
		})
		expect(finalizedSubagentContextManifestSchema.safeParse(optedInManifest).success).toBe(true)
	})

	it("freezes the parent auto-approval ceiling into every descendant manifest", async () => {
		const provider = makeProviderHarness(3, {
			approvalMode: "auto",
			autoApprovalEnabled: true,
			alwaysAllowSubagents: true,
			alwaysAllowReadOnly: true,
			alwaysAllowWrite: true,
			alwaysAllowExecute: true,
			allowedCommands: ["git diff"],
			deniedCommands: ["git push"],
			subagentDelegationPolicy: "proactive",
			subagentMaxDepth: 2,
		})
		const root = makeParent()
		const direct = await provider.prepareSubagentGroup(root as any, [
			{ objective: "Inspect the first layer", agent_kind: "review" },
		])
		const directManifest = (provider as any).subagentDescriptors.get(direct.envelopes[0].id).contextManifest

		expect(directManifest.runtimePolicy.autoApproval).toMatchObject({
			autoApprovalEnabled: true,
			alwaysAllowReadOnly: true,
			alwaysAllowWrite: true,
			alwaysAllowExecute: true,
			alwaysAllowSubagents: true,
			commandApproval: {
				algorithm: "sha256-salted-argv-v2",
				allowAll: true,
				denyAll: false,
				allowed: [expect.objectContaining({ tokenCount: 2 })],
				denied: [expect.objectContaining({ tokenCount: 2 })],
			},
		})
		expect(JSON.stringify(directManifest.runtimePolicy.autoApproval)).not.toContain("git diff")
		expect(JSON.stringify(directManifest.runtimePolicy.autoApproval)).not.toContain("git push")

		await (provider as any).contextProxy.setValues({
			approvalMode: "ask",
		})
		const child = {
			...makeParent(),
			taskId: direct.envelopes[0].id,
			rootTaskId: root.taskId,
			taskKind: "subagent",
			subagentContextManifest: directManifest,
			subagentDelegationPolicy: "proactive",
		}
		const nested = await provider.prepareSubagentGroup(child as any, [
			{ objective: "Inspect the second layer", agent_kind: "explore" },
		])
		const nestedManifest = (provider as any).subagentDescriptors.get(nested.envelopes[0].id).contextManifest

		expect(nested.requiresExplicitApproval).toBe(true)
		expect(nestedManifest.runtimePolicy.autoApproval).toMatchObject({
			autoApprovalEnabled: true,
			alwaysAllowWrite: false,
			alwaysAllowExecute: false,
			alwaysAllowSubagents: false,
			alwaysAllowTickets: false,
			commandApprovalCeilings: expect.arrayContaining([
				directManifest.runtimePolicy.autoApproval.commandApproval,
			]),
		})
		expect(nestedManifest.runtimePolicy.autoApproval.commandApprovalCeilings).toHaveLength(1)
	})

	it.each([
		{ captured: "ask" as const, live: "auto" as const, expectedCaptured: false, expectedNested: false },
		{ captured: "auto" as const, live: "ask" as const, expectedCaptured: true, expectedNested: false },
		{ captured: "auto" as const, live: "auto" as const, expectedCaptured: true, expectedNested: true },
		{ captured: "auto" as const, live: "bypass" as const, expectedCaptured: true, expectedNested: true },
	])(
		"freezes ticket approval through nested delegation: %j",
		async ({ captured, live, expectedCaptured, expectedNested }) => {
			const provider = makeProviderHarness(3, {
				approvalMode: captured,
				subagentDelegationPolicy: "proactive",
				subagentMaxDepth: 2,
			})
			const root = makeParent()
			const direct = await provider.prepareSubagentGroup(root as any, [
				{ objective: "Inspect ticket state", agent_kind: "review" },
			])
			const manifest = (provider as any).subagentDescriptors.get(direct.envelopes[0].id).contextManifest
			expect(manifest.runtimePolicy.autoApproval.alwaysAllowTickets).toBe(expectedCaptured)
			await provider.contextProxy.setValues({ approvalMode: live })
			const child = {
				...makeParent(),
				taskId: direct.envelopes[0].id,
				rootTaskId: root.taskId,
				taskKind: "subagent",
				subagentContextManifest: manifest,
				subagentDelegationPolicy: "proactive",
			}
			const nested = await provider.prepareSubagentGroup(child as any, [
				{ objective: "Inspect nested ticket state", agent_kind: "explore" },
			])
			const nestedManifest = (provider as any).subagentDescriptors.get(nested.envelopes[0].id).contextManifest
			expect(nestedManifest.runtimePolicy.autoApproval.alwaysAllowTickets).toBe(expectedNested)
			expect(manifest.runtimePolicy.autoApproval.alwaysAllowTickets).toBe(expectedCaptured)
		},
	)

	it("requires explicit approval when a retained parent predates approval capture", async () => {
		const provider = makeProviderHarness(3, {
			approvalMode: "auto",
			autoApprovalEnabled: true,
			alwaysAllowSubagents: true,
			alwaysAllowReadOnly: true,
			alwaysAllowWrite: true,
			subagentDelegationPolicy: "proactive",
			subagentMaxDepth: 2,
		})
		const root = makeParent()
		const direct = await provider.prepareSubagentGroup(root as any, [
			{ objective: "Capture a modern child", agent_kind: "review" },
		])
		const legacyManifest = structuredClone(
			(provider as any).subagentDescriptors.get(direct.envelopes[0].id).contextManifest,
		)
		delete legacyManifest.runtimePolicy.autoApproval

		const retainedChild = {
			...makeParent(),
			taskId: direct.envelopes[0].id,
			rootTaskId: root.taskId,
			taskKind: "subagent",
			subagentContextManifest: legacyManifest,
			subagentDelegationPolicy: "proactive",
		}
		const nested = await provider.prepareSubagentGroup(retainedChild as any, [
			{ objective: "Do not inherit widened live settings", agent_kind: "explore" },
		])
		const nestedManifest = (provider as any).subagentDescriptors.get(nested.envelopes[0].id).contextManifest

		expect(nested.requiresExplicitApproval).toBe(true)
		expect(nestedManifest.runtimePolicy.autoApproval).toMatchObject({
			autoApprovalEnabled: false,
			alwaysAllowReadOnly: false,
			alwaysAllowWrite: false,
			alwaysAllowExecute: false,
			alwaysAllowSubagents: false,
		})
	})

	it("captures leftover chip grants without widening them to inferred Ask", async () => {
		const provider = makeProviderHarness(2, {
			autoApprovalEnabled: false,
			alwaysAllowReadOnly: false,
			alwaysAllowWrite: false,
			alwaysAllowExecute: false,
			allowedCommands: ["git"],
			subagentDelegationPolicy: "explicit-only",
		})
		const parent = makeParent()
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Keep the leftover grant", agent_kind: "explore" },
		])
		const manifest = (provider as any).subagentDescriptors.get(prepared.envelopes[0].id).contextManifest
		expect(prepared.requiresExplicitApproval).toBe(true)
		expect(manifest.runtimePolicy.autoApproval).toMatchObject({
			autoApprovalEnabled: false,
			alwaysAllowReadOnly: false,
			alwaysAllowWrite: false,
			alwaysAllowExecute: false,
		})
	})

	it("uses the Auto or Full Access session grant for explicit-only delegation", async () => {
		for (const approvalMode of ["auto", "bypass"] as const) {
			const provider = makeProviderHarness(2, {
				approvalMode,
				subagentDelegationPolicy: "explicit-only",
			})
			const parent = makeParent()
			const prepared = await provider.prepareSubagentGroup(parent as any, [
				{ objective: "Inspect without a spawn dialog", agent_kind: "explore" },
			])
			const manifest = (provider as any).subagentDescriptors.get(prepared.envelopes[0].id).contextManifest
			expect(prepared.requiresExplicitApproval).toBe(false)
			expect(manifest.orchestration.delegationPolicy).toMatchObject({
				policy: "explicit-only",
				authorization: "session-policy",
				explicitUserRequest: false,
			})
			expect(finalizedSubagentContextManifestSchema.safeParse(manifest).success).toBe(true)
		}
	})

	it("still requires a human spawn click for explicit-only in Ask", async () => {
		const provider = makeProviderHarness(2, {
			approvalMode: "ask",
			subagentDelegationPolicy: "explicit-only",
		})
		const parent = makeParent()
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect after the group card", agent_kind: "review" },
		])
		const manifest = (provider as any).subagentDescriptors.get(prepared.envelopes[0].id).contextManifest
		expect(prepared.requiresExplicitApproval).toBe(true)
		expect(manifest.orchestration.delegationPolicy).toMatchObject({
			policy: "explicit-only",
			authorization: "pending-approval",
			explicitUserRequest: false,
		})
	})

	it("does not let a live Bypass setting widen an Auto child's captured grant", async () => {
		const provider = makeProviderHarness(3, {
			approvalMode: "auto",
			subagentDelegationPolicy: "proactive",
			subagentMaxDepth: 2,
		})
		const root = makeParent()
		const direct = await provider.prepareSubagentGroup(root as any, [
			{ objective: "Capture an Auto child", agent_kind: "review" },
		])
		const manifest = (provider as any).subagentDescriptors.get(direct.envelopes[0].id).contextManifest
		expect(manifest.runtimePolicy.autoApproval.alwaysAllowWriteOutsideWorkspace).toBe(false)
		await provider.contextProxy.setValues({ approvalMode: "bypass" })
		const child = {
			...makeParent(),
			taskId: direct.envelopes[0].id,
			rootTaskId: root.taskId,
			taskKind: "subagent",
			subagentContextManifest: manifest,
			subagentDelegationPolicy: "proactive",
		}
		const nested = await provider.prepareSubagentGroup(child as any, [
			{ objective: "Stay under the Auto ceiling", agent_kind: "explore" },
		])
		const nestedManifest = (provider as any).subagentDescriptors.get(nested.envelopes[0].id).contextManifest
		expect(nestedManifest.runtimePolicy.autoApproval.alwaysAllowWriteOutsideWorkspace).toBe(false)
	})

	it("applies a live explicit-only setting as a narrowing cap to an open proactive task", async () => {
		const provider = makeProviderHarness(2, {
			approvalMode: "ask",
			autoApprovalEnabled: true,
			alwaysAllowSubagents: true,
			alwaysAllowReadOnly: true,
			subagentDelegationPolicy: "explicit-only",
		})
		const parent = { ...makeParent(), subagentDelegationPolicy: "proactive" as const }

		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect without proactive authority", agent_kind: "review" },
		])
		const manifest = (provider as any).subagentDescriptors.get(prepared.envelopes[0].id).contextManifest

		expect(prepared.requiresExplicitApproval).toBe(true)
		expect(manifest.orchestration.delegationPolicy).toMatchObject({
			policy: "explicit-only",
			authorization: "pending-approval",
			explicitUserRequest: false,
		})
		expect(finalizedSubagentContextManifestSchema.safeParse(manifest).success).toBe(false)
	})

	it("permits nested read-only agents without a depth ceiling while denying authority widening", async () => {
		const provider = makeProviderHarness(2, {
			maxConcurrentSubagents: 3,
			subagentDelegationPolicy: "proactive",
			subagentMaxDepth: 2,
		})
		const root = makeParent()
		const direct = await provider.prepareSubagentGroup(root as any, [
			{ objective: "Inspect the first layer", agent_kind: "review" },
		])
		const directTaskId = direct.envelopes[0].id
		const directManifest = (provider as any).subagentDescriptors.get(directTaskId).contextManifest
		const child = {
			...makeParent(),
			taskId: directTaskId,
			rootTaskId: root.taskId,
			taskKind: "subagent",
			subagentContextManifest: directManifest,
			subagentDelegationPolicy: "proactive",
		}

		const nested = await provider.prepareSubagentGroup(child as any, [
			{ objective: "Inspect the second layer", agent_kind: "explore" },
		])
		expect(nested.envelopes[0]).toMatchObject({
			rootTaskId: root.taskId,
			parentTaskId: directTaskId,
			depth: 2,
			policy: { read: true, execute: false, mutate: false, delegate: true },
			budget: { maxDepth: null, maxConcurrency: 3 },
		})

		const nestedTaskId = nested.envelopes[0].id
		const grandchild = {
			...makeParent(),
			taskId: nestedTaskId,
			rootTaskId: root.taskId,
			taskKind: "subagent",
			subagentContextManifest: (provider as any).subagentDescriptors.get(nestedTaskId).contextManifest,
			subagentDelegationPolicy: "proactive",
		}
		;(provider as any).releaseSubagentGroup(direct.group.groupId)
		const third = await provider.prepareSubagentGroup(grandchild as any, [
			{ objective: "Inspect a deeper layer", agent_kind: "explore" },
		])
		expect(third.envelopes[0]).toMatchObject({ depth: 3, budget: { maxDepth: null } })
		;(provider as any).releaseSubagentGroup(third.group.groupId)
		await expect(
			provider.prepareSubagentGroup(child as any, [
				{
					objective: "Mutate from a nested child",
					agent_kind: "worker",
					write_scope: ["src/nested.ts"],
				},
			]),
		).rejects.toThrow("authority_denied: only a managed Worker")

		const narrowed = structuredClone(directManifest)
		narrowed.runtimePolicy.delegate = false
		await expect(
			provider.prepareSubagentGroup({ ...child, subagentContextManifest: narrowed } as any, [
				{ objective: "Delegate without authority", agent_kind: "explore" },
			]),
		).rejects.toThrow("authority_denied")
	})

	it("allows a Worker to layer one nested Worker only within its frozen directory and exact-file scope", async () => {
		const provider = makeProviderHarness(3, {
			maxConcurrentSubagents: 3,
			subagentDelegationPolicy: "proactive",
			subagentMaxDepth: 2,
		})
		const validateScope = vi
			.spyOn(managedSubagentWorktreeService, "validateScope")
			.mockImplementation(async (workspacePath, requestedScope) => ({
				gitRoot: workspacePath,
				logicalWorkspace: workspacePath,
				logicalWorkspaceFromRoot: "",
				writeScope: [...requestedScope],
				gitRelativeScope: [...requestedScope],
				fileWriteScope: requestedScope.filter(
					(candidate) => candidate.endsWith(".json") || candidate.endsWith(".ts"),
				),
				gitRelativeFileScope: requestedScope.filter(
					(candidate) => candidate.endsWith(".json") || candidate.endsWith(".ts"),
				),
			}))
		const root = makeParent()
		const direct = await provider.prepareSubagentGroup(root as any, [
			{
				objective: "Own the outer private checkout",
				agent_kind: "worker",
				write_scope: ["src", "config.json"],
			},
		])
		const directTaskId = direct.envelopes[0].id
		const directManifest = (provider as any).subagentDescriptors.get(directTaskId).contextManifest
		const privateCheckout = "F:/storage/subagent-worktrees/outer-worker"
		const workerParent = {
			...makeParent(),
			taskId: directTaskId,
			rootTaskId: root.taskId,
			taskKind: "subagent",
			subagentRole: "worker",
			cwd: privateCheckout,
			subagentContextManifest: directManifest,
			subagentDelegationPolicy: "proactive",
			getSubagentFileWriteScope: vi.fn(() => ["config.json"]),
		}

		const nested = await provider.prepareSubagentGroup(workerParent as any, [
			{
				objective: "Implement one nested source change",
				agent_kind: "worker",
				write_scope: ["src/nested.ts"],
			},
		])
		expect(nested.envelopes[0]).toMatchObject({
			rootTaskId: root.taskId,
			parentTaskId: directTaskId,
			depth: 2,
			policy: { read: true, execute: true, mutate: true, delegate: true },
			scope: {
				workspaceRoots: [expect.stringMatching(/subagent-worktrees[\\/]outer-worker$/)],
				allowedPaths: [expect.stringMatching(/src[\\/]nested\.ts$/)],
				sharedWorkspace: false,
			},
		})
		expect(validateScope).toHaveBeenLastCalledWith(privateCheckout, ["src/nested.ts"])
		expect(
			(provider as any).subagentDescriptors.get(nested.envelopes[0].id).contextManifest.runtimePolicy,
		).toMatchObject({
			role: "worker",
			writeScope: ["src/nested.ts"],
			fileWriteScope: ["src/nested.ts"],
		})

		await expect(
			provider.prepareSubagentGroup(workerParent as any, [
				{
					objective: "Escape the owning Worker scope",
					agent_kind: "worker",
					write_scope: ["docs/outside.ts"],
				},
			]),
		).rejects.toThrow("widens parent write scope")
		await expect(
			provider.prepareSubagentGroup(workerParent as any, [
				{
					objective: "Treat an exact file as a directory",
					agent_kind: "worker",
					write_scope: ["config.json/child.ts"],
				},
			]),
		).rejects.toThrow("widens parent write scope")
	})

	it("enforces a root child cap independently while leaving another root's slot available", async () => {
		const provider = makeProviderHarness(2, {
			maxConcurrentSubagents: 1,
			subagentDelegationPolicy: "proactive",
			subagentMaxDepth: 2,
		})
		const firstRoot = makeParent()
		await provider.prepareSubagentGroup(firstRoot as any, [
			{ objective: "Use the first root slot", agent_kind: "explore" },
		])

		await expect(
			provider.prepareSubagentGroup(firstRoot as any, [
				{ objective: "Exceed only the first root cap", agent_kind: "review" },
			]),
		).rejects.toThrow("root-wide child capacity")

		const secondRoot = { ...makeParent(), taskId: "root-2", metadata: { task: "second root" } }
		await expect(
			provider.prepareSubagentGroup(secondRoot as any, [
				{ objective: "Use the other root slot", agent_kind: "review" },
			]),
		).resolves.toMatchObject({
			envelopes: [{ rootTaskId: "root-2", parentTaskId: "root-2", depth: 1 }],
		})
	})

	it("routes a nested terminal result only to the immediate parent mailbox", async () => {
		const provider = makeProviderHarness()
		const rootParent = makeParent()
		const root = await (provider as any).ensureAgentControlRoot(rootParent)
		const child = await (provider as any).agentControlStore.createAgent({
			taskId: "child-mailbox",
			parentTaskId: root.taskId,
			rootTaskId: root.rootTaskId,
			nickname: "Mailbox Child",
			role: "review",
			objective: "Own descendant results",
			status: "running",
		})
		const grandchild = await (provider as any).agentControlStore.createAgent({
			taskId: "grandchild-mailbox",
			parentTaskId: child.taskId,
			rootTaskId: root.rootTaskId,
			nickname: "Mailbox Grandchild",
			role: "explore",
			objective: "Publish a nested result",
			status: "running",
		})

		await (provider as any).persistSpawnedSubagentLifecycle({ taskId: child.taskId }, grandchild, {
			eventId: "nested-result-event",
			sequence: 1,
			runId: "nested-run",
			type: "completed",
			taskId: grandchild.taskId,
			groupId: "nested-group",
			parentTaskId: child.taskId,
			occurredAt: 2_000,
			snapshot: {
				taskId: grandchild.taskId,
				nickname: grandchild.nickname,
				role: "explore",
				objective: grandchild.objective,
				status: "completed",
				summary: "Nested result complete",
				completedAt: 2_000,
				usage: { durationMs: 10 },
				stopReason: "completed",
			},
		})

		expect(
			(provider as any).agentControlStore.readMailbox(child.taskId, { rootTaskId: root.rootTaskId }).entries,
		).toEqual([
			expect.objectContaining({
				senderTaskId: grandchild.taskId,
				recipientTaskId: child.taskId,
				kind: "result",
				name: "agent_completed",
				payload: expect.objectContaining({ stopReason: "completed" }),
			}),
		])
		expect(
			(provider as any).agentControlStore.readMailbox(root.taskId, { rootTaskId: root.rootTaskId }).entries,
		).toEqual([])
	})

	it("uses the immediate owner for a terminal descendant follow-up and serializes concurrent admission", async () => {
		const provider = makeProviderHarness(3)
		const rootTask = makeParent()
		const root = await Reflect.get(provider, "ensureAgentControlRoot").call(provider, rootTask)
		const store = Reflect.get(provider, "agentControlStore") as AgentControlStore
		const parentRecord = await store.createAgent({
			taskId: "nested-owner",
			parentTaskId: root.taskId,
			rootTaskId: root.rootTaskId,
			nickname: "Owner",
			role: "review",
			objective: "Own child",
			status: "running",
		})
		const owner = {
			...makeParent(),
			taskId: parentRecord.taskId,
			taskKind: "subagent",
			rootTaskId: root.rootTaskId,
		}
		const child = await store.createAgent({
			taskId: "nested-followup",
			parentTaskId: owner.taskId,
			rootTaskId: root.rootTaskId,
			groupId: "nested-followup-group",
			nickname: "Nested",
			role: "review",
			objective: "Review",
			status: "interrupted",
		})
		const prepared = {
			group: {
				groupId: child.groupId,
				parentTaskId: owner.taskId,
				agents: [
					{
						taskId: child.taskId,
						nickname: child.nickname,
						role: child.role,
						status: "interrupted",
						usage: {},
					},
				],
			},
			envelopes: [{ id: child.taskId, parentTaskId: owner.taskId }],
		}
		Reflect.get(provider, "subagentDescriptors").set(child.taskId, { parent: owner })
		vi.spyOn(provider as any, "synchronizeParentVerificationObligations").mockResolvedValue(undefined)
		vi.spyOn(provider as any, "assertRetainedAgentRelaunchCapacity").mockImplementation(() => undefined)
		let entered!: () => void
		let release!: () => void
		const restoring = new Promise<void>((resolve) => {
			entered = resolve
		})
		const barrier = new Promise<void>((resolve) => {
			release = resolve
		})
		const restore = vi.spyOn(provider as any, "restorePreparedSubagentForFollowup").mockImplementation(async () => {
			entered()
			await barrier
			return prepared
		})
		const start = vi
			.spyOn(provider as any, "startPreparedSubagentRun")
			.mockImplementation(async (_owner: any, _group: unknown, _signal: unknown, record: any) => ({
				taskId: record.taskId,
				path: record.path,
				parentTaskId: _owner.taskId,
			}))
		const first = provider.followupAgentTask(rootTask as any, child.path, "First follow-up")
		await restoring
		const second = provider.followupAgentTask(rootTask as any, child.path, "Second follow-up")
		release()
		await expect(first).resolves.toMatchObject({ parentTaskId: owner.taskId, followup: true })
		await expect(second).resolves.toMatchObject({ delivery: "buffered", followup: true })
		expect(restore).toHaveBeenCalledOnce()
		expect(restore).toHaveBeenCalledWith(
			owner,
			expect.objectContaining({ taskId: child.taskId }),
			"First follow-up",
			undefined,
		)
		expect(start).toHaveBeenCalledOnce()
		expect(start.mock.calls[0][0]).toBe(owner)
		expect(owner.upsertSubagentGroup).toHaveBeenCalledOnce()
		expect(rootTask.upsertSubagentGroup).not.toHaveBeenCalled()
		expect(store.getUnacknowledgedMailboxEntries(child.taskId, { kinds: ["message"] })).toEqual([
			expect.objectContaining({ payload: { message: "Second follow-up" } }),
		])
		expect(Reflect.get(provider, "agentFollowupAdmissions").size).toBe(0)
	})

	it.each(["verification", "mailbox-admission"] as const)(
		"relaunches when completion wins during follow-up %s and joins predecessor publication",
		async (raceBoundary) => {
			const provider = makeProviderHarness(3)
			const parent = makeParent()
			;(provider as any).taskSessions.getTask = (taskId: string) =>
				taskId === parent.taskId ? parent : undefined
			const prepared = await provider.prepareSubagentGroup(parent as any, [
				{ objective: "Inspect continuation admission", agent_kind: "review" },
			])
			;(provider as any).finalizePreparedSubagentAuthorization(prepared)
			const taskId = prepared.envelopes[0].id
			const root = await (provider as any).ensureAgentControlRoot(parent)
			const store = (provider as any).agentControlStore as AgentControlStore
			await store.createAgent({
				taskId,
				parentTaskId: root.taskId,
				rootTaskId: root.rootTaskId,
				groupId: prepared.group.groupId,
				nickname: prepared.group.agents[0].nickname,
				role: "review",
				objective: prepared.group.agents[0].objective,
				status: "running",
			})
			let reachedCompletion!: () => void
			const completed = new Promise<void>((resolve) => (reachedCompletion = resolve))
			let releaseFinalization!: () => void
			const finalization = new Promise<void>((resolve) => (releaseFinalization = resolve))
			const priorFinalization =
				typeof Reflect.get(provider, "ownsSubagentFinalizationRecord") === "function"
					? Object.freeze({
							promise: finalization,
							parent,
							parentSignal: parent.getTaskLifetimeCancellationSignal(),
							operation: Object.freeze({}),
							admissionController: new AbortController(),
							taskIds: Object.freeze([taskId]),
							phase: "admitting",
						})
					: finalization
			;(provider as any).subagentRunFinalizations.set(taskId, priorFinalization)
			void finalization.then(() => {
				if ((provider as any).subagentRunFinalizations.get(taskId) === priorFinalization) {
					;(provider as any).subagentRunFinalizations.delete(taskId)
				}
			})
			const completePriorRun = async () => {
				prepared.group.status = "completed"
				prepared.group.agents[0].status = "completed"
				await store.updateAgentStatus(taskId, "completed", {}, root.rootTaskId)
				reachedCompletion()
			}
			if (raceBoundary === "verification") {
				vi.spyOn(provider as any, "synchronizeParentVerificationObligations").mockImplementationOnce(
					completePriorRun,
				)
			} else {
				const append = store.appendEventWhileRecipientActive.bind(store)
				vi.spyOn(store, "appendEventWhileRecipientActive").mockImplementationOnce(async (input) => {
					await completePriorRun()
					return append(input)
				})
			}
			const bounded = new BoundedDelegationManager(async (envelope) => ({
				taskId: envelope.id,
				status: "completed",
				summary: "Continuation complete",
				evidence: [],
				changedFiles: [],
				verification: [],
				remainingRisks: [],
				usage: { durationMs: 1 },
			}))
			;(provider as any).boundedDelegationManager = bounded
			;(provider as any).asyncSubagentRunManager = new AsyncSubagentRunManager(bounded)
			const start = vi.spyOn(provider as any, "startPreparedSubagentRun")
			const followup = provider.followupAgentTask(parent as any, taskId, "Inspect the next case")
			try {
				await completed
				expect(start).not.toHaveBeenCalled()
				releaseFinalization()
				await expect(followup).resolves.toMatchObject({ taskId, followup: true, runId: expect.any(String) })
				await ownedFinalization((provider as any).subagentRunFinalizations.get(taskId))
				expect(start).toHaveBeenCalledOnce()
				expect(store.getUnacknowledgedMailboxEntries(taskId, { kinds: ["message"] })).toEqual([])
				expect(store.getUnacknowledgedMailboxEntries(taskId, { kinds: ["followup"] })).toEqual([
					expect.objectContaining({ payload: { message: "Inspect the next case" } }),
				])
			} finally {
				releaseFinalization()
				await followup
			}
		},
	)

	it("rejects an unloaded nested owner before changing its stopped child's lifecycle", async () => {
		const provider = makeProviderHarness()
		const rootTask = makeParent()
		const root = await Reflect.get(provider, "ensureAgentControlRoot").call(provider, rootTask)
		const store = Reflect.get(provider, "agentControlStore") as AgentControlStore
		await store.createAgent({
			taskId: "unloaded-owner",
			parentTaskId: root.taskId,
			rootTaskId: root.rootTaskId,
			nickname: "Owner",
			role: "review",
			objective: "Own child",
			status: "running",
		})
		const child = await store.createAgent({
			taskId: "unloaded-nested",
			parentTaskId: "unloaded-owner",
			rootTaskId: root.rootTaskId,
			nickname: "Nested",
			role: "review",
			objective: "Review",
			status: "interrupted",
		})
		await store.updateAgentStatus("unloaded-owner", "interrupted", {}, root.rootTaskId)
		vi.spyOn(provider as any, "synchronizeParentVerificationObligations").mockResolvedValue(undefined)
		await expect(provider.followupAgentTask(rootTask as any, child.path, "Resume")).rejects.toThrow(
			"Open the immediate parent",
		)
		expect(store.getAgent(child.taskId, root.rootTaskId)?.status).toBe("interrupted")
		expect(store.getUnacknowledgedMailboxEntries(child.taskId)).toEqual([])
	})

	it("cancels descendants deepest-first and distinguishes direct-child from deeper target causes", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const root = await (provider as any).ensureAgentControlRoot(parent)
		const child = await (provider as any).agentControlStore.createAgent({
			taskId: "cancel-child",
			parentTaskId: root.taskId,
			rootTaskId: root.rootTaskId,
			nickname: "Cancel Child",
			role: "review",
			objective: "Own a cancellable subtree",
			status: "running",
		})
		const grandchild = await (provider as any).agentControlStore.createAgent({
			taskId: "cancel-grandchild",
			parentTaskId: child.taskId,
			rootTaskId: root.rootTaskId,
			nickname: "Cancel Grandchild",
			role: "explore",
			objective: "Own a deeper child",
			status: "running",
		})
		const deepest = await (provider as any).agentControlStore.createAgent({
			taskId: "cancel-deepest",
			parentTaskId: grandchild.taskId,
			rootTaskId: root.rootTaskId,
			nickname: "Cancel Deepest",
			role: "explore",
			objective: "Be cancelled first",
			status: "running",
		})
		const settlementOrder: string[] = []
		const cancel = vi.fn((taskId: string, _reason: string | Error, _stopReason?: string) => {
			settlementOrder.push(`cancel:${taskId}`)
			return true
		})
		const waitForResult = vi.fn((taskId: string) => {
			settlementOrder.push(`settle:${taskId}`)
			return Promise.resolve(undefined)
		})
		;(provider as any).asyncSubagentRunManager = {
			cancel,
			waitForResult,
			getSnapshot: () => undefined,
			resolveRunTaskId: () => undefined,
		}

		const direct = (await provider.cancelAgent(parent as any, child.taskId, "cancel direct subtree")) as any
		expect(direct).toMatchObject({
			taskId: child.taskId,
			status: "cancelling",
			descendantTaskIds: [grandchild.taskId, deepest.taskId],
		})
		expect(cancel.mock.calls.map(([taskId, _reason, stopReason]) => [taskId, stopReason])).toEqual([
			[deepest.taskId, "ancestor_cancelled"],
			[grandchild.taskId, "parent_cancelled"],
			[child.taskId, "parent_cancelled"],
		])
		expect(settlementOrder).toEqual([
			`cancel:${deepest.taskId}`,
			`settle:${deepest.taskId}`,
			`cancel:${grandchild.taskId}`,
			`settle:${grandchild.taskId}`,
			`cancel:${child.taskId}`,
			`settle:${child.taskId}`,
		])

		cancel.mockClear()
		settlementOrder.length = 0
		const deeper = (await provider.cancelAgent(parent as any, grandchild.taskId, "cancel deeper subtree")) as any
		expect(deeper.descendantTaskIds).toEqual([deepest.taskId])
		expect(cancel.mock.calls.map(([taskId, _reason, stopReason]) => [taskId, stopReason])).toEqual([
			[deepest.taskId, "parent_cancelled"],
			[grandchild.taskId, "ancestor_cancelled"],
		])
	})

	it.each(["async", "blocking"] as const)(
		"propagates a failed %s descendant settlement before removing its ancestor layer",
		async (executionMode) => {
			const provider = makeProviderHarness()
			const parent = makeParent()
			const root = await (provider as any).ensureAgentControlRoot(parent)
			const store = (provider as any).agentControlStore as AgentControlStore
			const ancestor = await store.createAgent({
				taskId: "cleanup-ancestor",
				parentTaskId: root.taskId,
				rootTaskId: root.rootTaskId,
				nickname: "ancestor",
				role: "review",
				objective: "Own a child layer",
				status: "running",
			})
			const descendant = await store.createAgent({
				taskId: "cleanup-descendant",
				parentTaskId: ancestor.taskId,
				rootTaskId: root.rootTaskId,
				nickname: "descendant",
				role: "review",
				objective: "Keep an owned layer",
				status: "running",
			})
			const taskEnvelope = (taskId: string, parentTaskId: string, depth: number) =>
				buildInternalTaskEnvelope({
					id: taskId,
					parentTaskId,
					rootTaskId: root.rootTaskId,
					depth,
					agentKind: "review",
					objective: "Inspect cleanup",
					workspaceRoots: [parent.cwd],
					budget: { maxDepth: 2 },
					parentPolicy: {
						read: true,
						execute: false,
						mutate: false,
						delegate: true,
						network: false,
						externalSideEffects: false,
						requireApproval: false,
					},
					requestedPolicy: {},
				})
			let entered!: () => void
			const bothStarted = new Promise<void>((resolve) => (entered = resolve))
			let releaseAncestor!: () => void
			const ancestorFinished = new Promise<void>((resolve) => (releaseAncestor = resolve))
			let ancestorSignal: AbortSignal | undefined
			let started = 0
			const bounded = new BoundedDelegationManager(async (item, signal) => {
				const stopped = new Promise<void>((resolve) => {
					if (signal.aborted) resolve()
					else signal.addEventListener("abort", () => resolve(), { once: true })
				})
				if (item.id === ancestor.taskId) ancestorSignal = signal
				if (++started === 2) entered()
				if (item.id === descendant.taskId) await stopped
				else await Promise.race([stopped, ancestorFinished])
				return {
					taskId: item.id,
					status: item.id === descendant.taskId ? ("failed" as const) : ("completed" as const),
					summary: item.id === descendant.taskId ? "Descendant cleanup is unconfirmed" : "Ancestor retained",
					evidence: [],
					changedFiles: [],
					verification: [],
					remainingRisks: [],
					usage: { durationMs: 1 },
				}
			})
			const runs = new AsyncSubagentRunManager(bounded)
			;(provider as any).boundedDelegationManager = bounded
			;(provider as any).asyncSubagentRunManager = runs
			const controller = new AbortController()
			const ancestorCompletion = bounded.run(taskEnvelope(ancestor.taskId, parent.taskId, 1), controller.signal)
			const envelope = taskEnvelope(descendant.taskId, ancestor.taskId, 2)
			let descendantCompletion: Promise<unknown>
			if (executionMode === "async") {
				runs.launch(
					envelope,
					{
						groupId: "descendant-group",
						path: descendant.path,
						nickname: descendant.nickname,
						role: "review",
					},
					controller.signal,
				)
				descendantCompletion = runs.waitForResult(descendant.taskId)!
			} else descendantCompletion = bounded.run(envelope, controller.signal)
			try {
				await bothStarted
				await expect(provider.cancelAgent(parent as any, ancestor.taskId, "Stop the subtree")).rejects.toThrow(
					`Managed descendant ${descendant.taskId} did not settle cleanly (status=failed, stopReason=parent_cancelled)`,
				)
				expect(ancestorSignal?.aborted).toBe(false)
				await expect(descendantCompletion).resolves.toMatchObject({
					status: "failed",
					stopReason: "parent_cancelled",
				})
			} finally {
				releaseAncestor()
				controller.abort()
				await Promise.all([ancestorCompletion, descendantCompletion])
			}
		},
	)

	it.each(["cancelAgent", "cancelTask"] as const)(
		"finishes an independent branch through %s when another descendant fails cleanup",
		async (caller) => {
			const provider = makeProviderHarness()
			const parent = Object.assign(makeParent(), {
				instanceId: "cancellation-owner",
				cancelCurrentRequest: vi.fn(),
				abortTask: vi.fn(async () => undefined),
				lifecycleRuntime: {
					join: vi.fn(async () => undefined),
					waitForPersistence: vi.fn(async () => undefined),
				},
			})
			;(provider as any).taskSessions.getTask = (taskId: string) =>
				taskId === parent.taskId ? parent : undefined
			const rehydrate = vi.spyOn(provider, "createTaskWithHistoryItem").mockResolvedValue(parent as any)
			const root = await (provider as any).ensureAgentControlRoot(parent)
			const store = (provider as any).agentControlStore as AgentControlStore
			const ancestor = await store.createAgent({
				taskId: "branch-owner",
				parentTaskId: root.taskId,
				rootTaskId: root.rootTaskId,
				nickname: "branch_owner",
				role: "review",
				objective: "Own independent cleanup branches",
				status: "running",
			})
			const branches = []
			for (const nickname of ["failed_branch", "independent_branch"]) {
				branches.push(
					await store.createAgent({
						taskId: nickname,
						parentTaskId: ancestor.taskId,
						rootTaskId: root.rootTaskId,
						nickname,
						role: "review",
						objective: "Settle an owned branch",
						status: "running",
					}),
				)
			}
			const failed = branches[0]!
			const independent = branches[1]!
			const records = [ancestor, failed, independent]
			let entered!: () => void
			const allStarted = new Promise<void>((resolve) => (entered = resolve))
			let releaseAncestor!: () => void
			const ancestorFinished = new Promise<void>((resolve) => (releaseAncestor = resolve))
			const signals = new Map<string, AbortSignal>()
			const bounded = new BoundedDelegationManager(async (item, signal) => {
				signals.set(item.id, signal)
				const stopped = new Promise<void>((resolve) => {
					if (signal.aborted) resolve()
					else signal.addEventListener("abort", () => resolve(), { once: true })
				})
				if (signals.size === records.length) entered()
				if (item.id === ancestor.taskId) await Promise.race([stopped, ancestorFinished])
				else await stopped
				return {
					taskId: item.id,
					status: item.id === failed.taskId ? "failed" : "completed",
					summary: "Owned branch settlement",
					evidence: [],
					changedFiles: [],
					verification: [],
					remainingRisks: [],
					usage: { durationMs: 1 },
				}
			}, 3)
			;(provider as any).boundedDelegationManager = bounded
			;(provider as any).asyncSubagentRunManager = new AsyncSubagentRunManager(bounded)
			const controller = new AbortController()
			const completions = records.map((record) =>
				bounded.run(
					buildInternalTaskEnvelope({
						id: record.taskId,
						parentTaskId: record.parentTaskId!,
						rootTaskId: root.rootTaskId,
						depth: record.taskId === ancestor.taskId ? 1 : 2,
						agentKind: "review",
						objective: "Inspect cleanup",
						workspaceRoots: [parent.cwd],
						budget: { maxDepth: 2 },
						parentPolicy: {
							read: true,
							execute: false,
							mutate: false,
							delegate: true,
							network: false,
							externalSideEffects: false,
							requireApproval: false,
						},
						requestedPolicy: {},
					}),
					controller.signal,
				),
			)
			try {
				await allStarted
				const cancellation =
					caller === "cancelAgent"
						? provider.cancelAgent(parent as any, ancestor.taskId, "Stop owned branches")
						: provider.cancelTask(parent.taskId, "webview_stop")
				await expect(cancellation).rejects.toThrow(`Managed descendant ${failed.taskId} did not settle cleanly`)
				expect(signals.get(independent.taskId)?.aborted).toBe(true)
				await expect(completions[2]).resolves.toMatchObject({
					status: "cancelled",
					stopReason: caller === "cancelAgent" ? "parent_cancelled" : "ancestor_cancelled",
				})
				expect(signals.get(ancestor.taskId)?.aborted).toBe(false)
				expect(store.getAgent(ancestor.taskId, root.rootTaskId)?.status).toBe("running")
				const intentRecipients = store
					.getRecentRootMailboxEntries(root.rootTaskId, 20)
					.entries.filter((event) => event.name === "cancel_requested")
					.sort((left, right) => left.sequence - right.sequence)
					.map((event) => event.recipientTaskId)
				expect(intentRecipients).toEqual([failed.taskId, independent.taskId, ancestor.taskId])
				expect(rehydrate).not.toHaveBeenCalled()
				if (caller === "cancelTask") {
					expect(parent.abortTask).toHaveBeenCalledOnce()
					expect(parent.lifecycleRuntime.join).toHaveBeenCalledOnce()
				}
			} finally {
				releaseAncestor()
				controller.abort()
				await Promise.all(completions)
			}
		},
	)

	it("runs two mocked children concurrently, publishes live progress, and returns one ordered result", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const updates: Array<{ status: string; agents: Array<{ taskId: string; status: string }> }> = []
		parent.upsertSubagentGroup = vi.fn(async (group: SubagentGroupState) => {
			updates.push(structuredClone(group))
		})
		;(provider as any).taskSessions.getTask = (taskId: string) => (taskId === parent.taskId ? parent : undefined)

		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect the parser", agent_kind: "explore" },
			{ objective: "Review the dispatcher", agent_kind: "review" },
		])

		let active = 0
		let peak = 0
		let started = 0
		let resolveBothStarted!: () => void
		const bothStarted = new Promise<void>((resolve) => (resolveBothStarted = resolve))
		const release = new Map<string, () => void>()
		;(provider as any).boundedDelegationManager = new BoundedDelegationManager(async (envelope) => {
			active++
			peak = Math.max(peak, active)
			started++
			if (started === 2) resolveBothStarted()
			await new Promise<void>((resolve) => release.set(envelope.id, resolve))
			active--

			const result = {
				taskId: envelope.id,
				status: "completed" as const,
				summary: `${envelope.objective} complete`,
				evidence: [],
				changedFiles: [],
				verification: [],
				remainingRisks: [],
				usage: { durationMs: 10 },
			}
			await (provider as any).applySubagentResult(prepared, result)
			return result
		})

		const run = provider.runSubagentGroup(parent as any, prepared, new AbortController().signal)
		await bothStarted
		expect(peak).toBe(2)

		release.get(prepared.envelopes[0].id)?.()
		await vi.waitFor(() =>
			expect(
				updates.some(
					(update) =>
						update.status === "running" &&
						update.agents.filter((agent) => agent.status === "completed").length === 1,
				),
			).toBe(true),
		)
		release.get(prepared.envelopes[1].id)?.()

		const result = await run
		expect(result).toMatchObject({
			groupId: prepared.group.groupId,
			status: "completed",
		})
		expect(result.agents.map((agent) => agent.taskId)).toEqual(prepared.envelopes.map((envelope) => envelope.id))
		expect((provider as any).__historyItems.get(parent.taskId).childIds).toEqual(
			prepared.envelopes.map((envelope) => envelope.id),
		)
		expect(updates.at(-1)?.status).toBe("completed")
	})

	it("returns a spawn handle before completion and publishes lifecycle state in the background", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const updates: SubagentGroupState[] = []
		parent.upsertSubagentGroup = vi.fn(async (group: SubagentGroupState) => {
			updates.push(structuredClone(group))
		})

		let finish!: (result: any) => void
		const runner = vi.fn(
			async (_envelope: { id: string }) =>
				await new Promise<any>((resolve) => {
					finish = resolve
				}),
		)
		const bounded = new BoundedDelegationManager(runner)
		;(provider as any).boundedDelegationManager = bounded
		;(provider as any).asyncSubagentRunManager = new AsyncSubagentRunManager(bounded)

		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect the parser", agent_kind: "explore" },
		])
		const expectedManifest = structuredClone(
			(provider as any).subagentDescriptors.get(prepared.envelopes[0].id).contextManifest,
		)
		expect(prepared.requiresExplicitApproval).toBe(false)
		expect(expectedManifest.orchestration.delegationPolicy).toEqual({
			policy: "explicit-only",
			source: "default",
			authorization: "session-policy",
			explicitUserRequest: false,
		})
		expect(finalizedSubagentContextManifestSchema.safeParse(expectedManifest).success).toBe(true)
		const handle = await provider.launchPreparedSubagentGroup(parent as any, prepared, new AbortController().signal)
		const finalization = ownedFinalization((provider as any).subagentRunFinalizations.get(handle.taskId))
		expect(finalization).toBeDefined()

		expect(handle).toMatchObject({
			taskId: prepared.envelopes[0].id,
			groupId: prepared.group.groupId,
			parentTaskId: parent.taskId,
			status: "pending",
		})
		expect(Object.isFrozen(handle)).toBe(true)
		expect(parent.emit).toHaveBeenCalledOnce()
		expect(parent.emit).toHaveBeenCalledWith(AlphaCodeEventName.TaskSpawned, handle.taskId)
		expect((provider as any).asyncSubagentRunManager.getResult(handle.taskId)).toBeUndefined()
		await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce())
		await vi.waitFor(() =>
			expect(updates.some((group) => group.status === "running" && group.agents[0].status === "running")).toBe(
				true,
			),
		)
		expect((provider as any).preparedSubagentGroups.has(prepared.group.groupId)).toBe(true)
		expect((provider as any).subagentDescriptors.get(handle.taskId).contextManifest).toEqual(expectedManifest)

		finish({
			taskId: handle.taskId,
			status: "completed",
			summary: "Parser inspected",
			evidence: [],
			changedFiles: [],
			verification: [],
			remainingRisks: [],
			usage: { durationMs: 10 },
		})

		await finalization
		await (provider as any).pruneRetainedSubagentRuntimes()
		expect(updates.at(-1)?.status).toBe("completed")
		expect(updates.at(-1)?.executionMode).toBe("async")
		expect(updates.at(-1)?.agents[0]).toMatchObject({
			status: "completed",
			summary: "Parser inspected",
		})
		expect((provider as any).__historyItems.get(parent.taskId).childIds).toEqual([handle.taskId])
		expect((provider as any).preparedSubagentGroups.has(prepared.group.groupId)).toBe(false)
		expect((provider as any).subagentDescriptors.has(handle.taskId)).toBe(false)
		expect((provider as any).asyncSubagentRunManager.getSnapshot(handle.taskId)).toMatchObject({
			status: "completed",
		})
		expect((provider as any).agentControlStore.getAgent(handle.taskId, parent.taskId)).toMatchObject({
			path: handle.path,
			status: "completed",
			snapshot: {
				contextManifest: expectedManifest,
			},
		})
	})

	it.each(["async", "blocking"] as const)(
		"joins the previous %s terminal publication before admitting a retained follow-up",
		async (execution) => {
			const provider = makeProviderHarness(2, { maxConcurrentSubagents: 1 })
			const parent = makeParent()
			;(provider as any).taskSessions.getTask = (taskId: string) =>
				taskId === parent.taskId ? parent : undefined
			let entered!: () => void
			const publicationEntered = new Promise<void>((resolve) => (entered = resolve))
			let releasePublication!: () => void
			const publication = new Promise<void>((resolve) => (releasePublication = resolve))
			let blockFirstPublication = true
			parent.upsertSubagentGroup = vi.fn(async (group: SubagentGroupState) => {
				if (group.status === "completed" && blockFirstPublication) {
					blockFirstPublication = false
					entered()
					await publication
				}
				parent.alphaMessages.splice(0, parent.alphaMessages.length, { subagentGroup: structuredClone(group) })
			})
			const completed = (taskId: string) => ({
				taskId,
				status: "completed" as const,
				summary: "Reviewed",
				evidence: [],
				changedFiles: [],
				verification: [],
				remainingRisks: [],
				usage: { durationMs: 1 },
			})
			let releaseFirst!: () => void
			const firstCompletion = new Promise<void>((resolve) => (releaseFirst = resolve))
			let enteredRunner!: () => void
			const runnerEntered = new Promise<void>((resolve) => (enteredRunner = resolve))
			const runner = vi.fn<InternalTaskRunner>(async (envelope, signal) => {
				if (runner.mock.calls.length === 1) {
					enteredRunner()
					await firstCompletion
					return completed(envelope.id)
				}
				await new Promise<void>((resolve) => {
					if (signal.aborted) resolve()
					else signal.addEventListener("abort", () => resolve(), { once: true })
				})
				return completed(envelope.id)
			})
			const bounded = new BoundedDelegationManager(runner)
			const runs = new AsyncSubagentRunManager(bounded)
			;(provider as any).boundedDelegationManager = bounded
			;(provider as any).asyncSubagentRunManager = runs
			const controller = new AbortController()
			const prepared = await provider.prepareSubagentGroup(parent as any, [
				{ task_name: "retained_alias", objective: "Inspect this root", agent_kind: "review" },
			])
			const firstTaskId = prepared.envelopes[0].id
			const initialRun =
				execution === "async"
					? provider.launchPreparedSubagentGroup(parent as any, prepared, controller.signal)
					: provider.runSubagentGroup(parent as any, prepared, controller.signal)
			await runnerEntered
			const firstRunId = runs.getEvents(firstTaskId).at(0)?.runId
			releaseFirst()
			await publicationEntered
			vi.useFakeTimers()
			let followup: Promise<unknown> | undefined
			try {
				if (execution === "async") expect(firstRunId).toEqual(expect.any(String))
				let admitted = false
				followup = provider.followupAgentTask(parent as any, firstTaskId, "Inspect the next case")
				void followup.then(
					() => (admitted = true),
					() => undefined,
				)
				// Drain the deterministic mock admission queue without advancing a deadline.
				await vi.advanceTimersByTimeAsync(0)
				expect(admitted).toBe(false)
				expect(runner).toHaveBeenCalledOnce()
				releasePublication()
				const second = (await followup) as any
				expect(second).toMatchObject({ taskId: firstTaskId, followup: true })
				expect(second.runId).not.toBe(firstRunId)
				const retained = (await provider.listAgents(parent as any)) as any
				const groupId = retained.agents.find((agent: any) => agent.taskId === firstTaskId).groupId
				await provider.cancelSubagentGroup(parent.taskId, groupId)
				await expect(runs.waitForResult(firstTaskId)).resolves.toMatchObject({
					status: "cancelled",
					stopReason: "parent_cancelled",
				})
			} finally {
				releasePublication()
				controller.abort()
				await followup?.catch(() => undefined)
				runs.cancel(firstTaskId, "Test cleanup", "parent_cancelled")
				await runs.waitForResult(firstTaskId)
				await initialRun.catch(() => undefined)
				await vi.advanceTimersByTimeAsync(0)
				vi.useRealTimers()
			}
		},
	)

	it("exposes the root launch limits before the first child and freezes them at preparation", async () => {
		const routingSettings: Parameters<typeof makeProviderHarness>[1] = {
			maxConcurrentSubagents: 3,
			subagentDelegationPolicy: "proactive",
			subagentMaxDepth: 2,
			subagentRoleTimeoutsMs: { explore: 120_000, review: 120_000, worker: 900_000 },
			subagentMaxInputTokens: 250_000,
			subagentMaxOutputTokens: 16_000,
			subagentRootTokenBudget: null,
			subagentRootCostBudget: null,
		}
		const provider = makeProviderHarness(3, routingSettings)
		const parent = makeParent()
		const expectedLimits = {
			maxConcurrentTasks: 3,
			maxConcurrentSubagents: 3,
			maxInputTokens: null,
			maxOutputTokens: null,
			roleTimeoutsMs: null,
			rootTokenBudget: null,
			rootCostBudget: null,
		}

		const beforePreparation = (await provider.listAgents(parent as any)) as any
		expect(beforePreparation.agents).toEqual([])
		expect(beforePreparation.rootOrchestration).toEqual({
			source: "configured",
			delegationPolicy: "explicit-only",
			maxDepth: null,
			limits: expectedLimits,
		})
		expect(subagentRootOrchestrationSummarySchema.safeParse(beforePreparation.rootOrchestration).success).toBe(true)

		await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Freeze the root launch contract", agent_kind: "review" },
		])
		Object.assign(routingSettings, {
			maxConcurrentSubagents: 8,
			subagentDelegationPolicy: "explicit-only",
			subagentMaxDepth: 5,
			subagentMaxInputTokens: 999_999,
			subagentMaxOutputTokens: 99_999,
		})

		const afterPreparation = (await provider.listAgents(parent as any)) as any
		expect(afterPreparation.rootOrchestration).toEqual({
			source: "frozen",
			delegationPolicy: "explicit-only",
			maxDepth: null,
			limits: expectedLimits,
		})
	})

	it("supports the complete nonblocking lifecycle for two concurrent agents", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const liveChildren = new Map<string, any>()
		;(provider as any).taskSessions.getTask = (taskId: string) => liveChildren.get(taskId)

		let invocation = 0
		const runs = new Map<string, { resolve: (result: any) => void; reject: (error: unknown) => void }>()
		const bounded = new BoundedDelegationManager(
			async (envelope, signal) =>
				await new Promise<any>((resolve, reject) => {
					const key = `${envelope.id}:${++invocation}`
					runs.set(key, { resolve, reject })
					signal.addEventListener("abort", () => reject(signal.reason), { once: true })
				}),
			2,
		)
		;(provider as any).boundedDelegationManager = bounded
		;(provider as any).asyncSubagentRunManager = new AsyncSubagentRunManager(bounded)

		const first = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect lifecycle state", agent_kind: "explore" },
		])
		const firstHandle = await provider.launchPreparedSubagentGroup(
			parent as any,
			first,
			new AbortController().signal,
		)
		const second = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Review cancellation", agent_kind: "review" },
		])
		const secondHandle = await provider.launchPreparedSubagentGroup(
			parent as any,
			second,
			new AbortController().signal,
		)

		const steerUserMessage = vi.fn(
			async (_message: string, _images: string[] | undefined, onPersisted?: () => Promise<void> | void) => {
				await onPersisted?.()
			},
		)
		liveChildren.set(firstHandle.taskId, {
			canAcceptSteerMessage: () => true,
			admitAgentMessage: async (persist: () => Promise<unknown>) => persist(),
			steerUserMessage,
		})
		liveChildren.set(secondHandle.taskId, {})
		await vi.waitFor(() => expect(runs.size).toBe(2))

		const localWork = { completed: true }
		const listed = (await provider.listAgents(parent as any)) as any
		expect(localWork.completed).toBe(true)
		expect(listed.agents).toHaveLength(2)
		expect(listed.agents.every((agent: any) => agent.path.startsWith("/root/"))).toBe(true)
		expect(listed.mailbox.unreadCount).toBe(0)

		await provider.sendMessageToAgent(parent as any, firstHandle.path, "Focus on the reload race")
		expect(steerUserMessage).not.toHaveBeenCalled()
		await provider.cancelAgent(parent as any, secondHandle.taskId, "No longer needed")

		const firstRun = [...runs.entries()].find(([key]) => key.startsWith(`${firstHandle.taskId}:`))![1]
		firstRun.resolve({
			taskId: firstHandle.taskId,
			status: "completed",
			summary: "Lifecycle state inspected",
			evidence: [],
			changedFiles: [],
			verification: [],
			remainingRisks: [],
			usage: { durationMs: 1 },
		})
		await vi.waitFor(() =>
			expect((provider as any).agentControlStore.getAgent(firstHandle.taskId, parent.taskId)?.status).toBe(
				"completed",
			),
		)
		await vi.waitFor(() =>
			expect((provider as any).agentControlStore.getAgent(secondHandle.taskId, parent.taskId)?.status).toBe(
				"cancelled",
			),
		)

		const mailbox = (await provider.waitForAgent(parent as any, 10_000)) as any
		expect(mailbox.timedOut).toBe(false)
		expect(mailbox.eventCount).toBeGreaterThan(0)
		expect(parent.stageWaitAgentNotifications).toHaveBeenCalledWith(
			mailbox.claimId,
			expect.arrayContaining([expect.objectContaining({ name: "agent_completed" })]),
		)

		const followup = (await provider.followupAgentTask(
			parent as any,
			firstHandle.path,
			"Check one more edge case",
		)) as any
		expect(followup.taskId).toBe(firstHandle.taskId)
		await vi.waitFor(() => expect(runs.size).toBe(3))
		const followupRun = [...runs.entries()].find(
			([key]) => key.startsWith(`${firstHandle.taskId}:`) && runs.get(key) !== firstRun,
		)![1]
		followupRun.resolve({
			taskId: firstHandle.taskId,
			status: "completed",
			summary: "Follow-up complete",
			evidence: [],
			changedFiles: [],
			verification: [],
			remainingRisks: [],
			usage: { durationMs: 1 },
		})
		await vi.waitFor(() =>
			expect((provider as any).agentControlStore.getAgent(firstHandle.taskId, parent.taskId)?.status).toBe(
				"completed",
			),
		)

		liveChildren.clear()
		await provider.closeAgent(parent as any, firstHandle.taskId)
		await provider.closeAgent(parent as any, secondHandle.taskId)
		const afterClose = (await provider.listAgents(parent as any)) as any
		expect(afterClose.agents).toEqual([])
	})

	it("allows passive child replies to root and same-tree peers without granting lifecycle control", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const root = await Reflect.get(provider, "ensureAgentControlRoot").call(provider, parent)
		const store = Reflect.get(provider, "agentControlStore") as AgentControlStore
		const sender = await store.createAgent({
			taskId: "sender",
			parentTaskId: root.taskId,
			rootTaskId: root.rootTaskId,
			nickname: "Sender",
			role: "review",
			objective: "Reply",
			status: "running",
		})
		const peer = await store.createAgent({
			taskId: "peer",
			parentTaskId: root.taskId,
			rootTaskId: root.rootTaskId,
			nickname: "Peer",
			role: "review",
			objective: "Review",
			status: "running",
		})
		const childTask = {
			...makeParent(),
			taskId: sender.taskId,
			taskKind: "subagent",
			rootTaskId: root.rootTaskId,
			parentTaskId: root.taskId,
		}
		Reflect.get(provider, "subagentDescriptors").set(peer.taskId, { parent })

		await expect(
			provider.sendMessageToAgent(childTask as any, "/root", "Finding for parent"),
		).resolves.toMatchObject({ taskId: root.taskId, delivery: "buffered" })
		await provider.sendMessageToAgent(childTask as any, peer.path, "Finding for peer")
		expect(store.getUnacknowledgedMailboxEntries(root.taskId, { kinds: ["message"] })).toEqual([
			expect.objectContaining({ senderTaskId: sender.taskId, name: "agent_message" }),
		])
		expect(store.getUnacknowledgedMailboxEntries(peer.taskId, { kinds: ["message"] })).toEqual([
			expect.objectContaining({ senderTaskId: sender.taskId, name: "agent_message" }),
		])
		await expect(provider.followupAgentTask(childTask as any, peer.path, "Restart peer")).rejects.toThrow(
			"outside the caller's managed subtree",
		)
		await expect(provider.sendMessageToAgent(childTask as any, sender.path, "Self")).rejects.toThrow("itself")
		await store.ensureRoot({ taskId: "other-root", status: "running" })
		await expect(provider.sendMessageToAgent(childTask as any, "other-root", "Cross tree")).rejects.toThrow(
			"Unknown agent message recipient",
		)
	})

	it.each(["completed", "interrupted"] as const)(
		"buffers passive mail for a retained %s peer without admitting a new run",
		async (status) => {
			const provider = makeProviderHarness()
			const parent = makeParent()
			const root = await Reflect.get(provider, "ensureAgentControlRoot").call(provider, parent)
			const store = Reflect.get(provider, "agentControlStore") as AgentControlStore
			const sender = await store.createAgent({
				taskId: "passive-sender",
				parentTaskId: root.taskId,
				nickname: "Sender",
				role: "review",
				objective: "Share findings",
				status: "running",
			})
			const peer = await store.createAgent({
				taskId: "passive-recipient",
				parentTaskId: root.taskId,
				nickname: "Recipient",
				role: "review",
				objective: "Retain findings",
				status: "running",
			})
			await store.updateAgentStatus(peer.taskId, status, {}, root.taskId)
			const senderTask = { ...makeParent(), taskId: sender.taskId, taskKind: "subagent", rootTaskId: root.taskId }
			const relaunch = vi.spyOn(provider, "followupAgentTask")
			await expect(
				provider.sendMessageToAgent(senderTask as any, peer.path, "Use this on your next turn"),
			).resolves.toMatchObject({
				taskId: peer.taskId,
				status,
				delivery: "buffered",
			})
			expect(store.getAgent(peer.taskId, root.taskId)?.status).toBe(status)
			expect(relaunch).not.toHaveBeenCalled()
			expect(store.getUnacknowledgedMailboxEntries(peer.taskId, { kinds: ["message"] })).toEqual([
				expect.objectContaining({
					senderTaskId: sender.taskId,
					payload: { message: "Use this on your next turn" },
				}),
			])
			await store.closeAgent(peer.taskId, root.taskId)
			await expect(provider.sendMessageToAgent(senderTask as any, peer.path, "After close")).rejects.toThrow(
				"Unknown agent message recipient",
			)
		},
	)

	it("automatically delivers completed turns once in mailbox order while retaining ordinary interruption", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const root = await Reflect.get(provider, "ensureAgentControlRoot").call(provider, parent)
		const store = Reflect.get(provider, "agentControlStore") as AgentControlStore
		const child = await store.createAgent({
			taskId: "automatic-result-child",
			parentTaskId: root.taskId,
			nickname: "Child",
			role: "review",
			objective: "Complete more than one turn",
			status: "completed",
		})
		for (const [eventId, status] of [
			["run-one", "completed"],
			["ordinary-stop", "interrupted"],
			["run-two", "completed"],
			["run-failed", "failed"],
			["run-blocked", "blocked"],
			["run-timeout", "timed_out"],
			["user-stop", "cancelled"],
		]) {
			await store.appendEvent({
				eventId,
				sender: child.taskId,
				recipient: root.taskId,
				kind: "result",
				name: `agent_${status}`,
				payload: { taskId: child.taskId, status, summary: eventId },
			})
		}
		const persist = vi.fn(async (_message: { id: string; notification?: { eventId: string } }) => undefined)
		await provider.deliverAgentMessages(parent as any, persist)
		await provider.deliverAgentMessages(parent as any, persist)
		expect(persist.mock.calls.map(([message]) => [message.id, message.notification?.eventId])).toEqual([
			["run-one", "run-one"],
			["run-two", "run-two"],
			["run-failed", "run-failed"],
			["run-blocked", "run-blocked"],
			["run-timeout", "run-timeout"],
		])
		expect(store.getUnacknowledgedMailboxEntries(parent.taskId, { kinds: ["result"] })).toEqual([
			expect.objectContaining({ eventId: "ordinary-stop" }),
			expect.objectContaining({ eventId: "user-stop" }),
		])
		expect(
			store
				.getUnacknowledgedMailboxEntries(parent.taskId, { kinds: ["result"] })
				.every((entry) => !entry.claimId),
		).toBe(true)
	})

	it("replays automatic result claims after partial transcript failure and reload without repeating persisted bodies", async () => {
		const persistence = new InMemoryAgentControlPersistence()
		const store = new AgentControlStore(persistence)
		await store.initialize()
		await store.ensureRoot({ taskId: "parent-1", status: "running" })
		const child = await store.createAgent({
			taskId: "replay-child",
			parentTaskId: "parent-1",
			nickname: "Child",
			role: "review",
			objective: "Publish follow-up turns",
			status: "completed",
		})
		for (const eventId of ["replay-first-turn", "replay-next-turn"]) {
			await store.appendEvent({
				eventId,
				sender: child.taskId,
				recipient: "parent-1",
				kind: "result",
				name: "agent_completed",
				payload: { taskId: child.taskId, status: "completed", summary: eventId },
			})
		}
		const provider = makeProviderHarness()
		Reflect.set(provider, "agentControlStore", store)
		Reflect.set(provider, "agentControlStoreReady", Promise.resolve())
		const task = makeMailboxRecipient(provider)
		vi.mocked(task["addToApiConversationHistory"])
			.mockImplementationOnce(async (message) => {
				task.apiConversationHistory.push(message)
				return true
			})
			.mockResolvedValueOnce(false)
		await expect(task["deliverAgentMessages"]()).rejects.toThrow("Agent message was not persisted")
		expect(task.apiConversationHistory.map((message) => message.agent_message_id)).toEqual(["replay-first-turn"])
		expect(store.getUnacknowledgedMailboxEntries(task.taskId).every((entry) => !entry.claimId)).toBe(true)

		const reloaded = new AgentControlStore(persistence)
		await reloaded.initialize()
		Reflect.set(provider, "agentControlStore", reloaded)
		const recipient = makeMailboxRecipient(provider, structuredClone(task.apiConversationHistory))
		await recipient["deliverAgentMessages"]()
		await recipient["deliverAgentMessages"]()
		expect(recipient.apiConversationHistory.map((message) => message.agent_message_id)).toEqual([
			"replay-first-turn",
			"replay-next-turn",
		])
		expect(recipient.apiConversationHistory.every((message) => message.input_origin === "agent")).toBe(true)
		expect(reloaded.getUnacknowledgedMailboxEntries(task.taskId, { kinds: ["result"] })).toEqual([])
	})

	it("honors a retained wait claim and reconciles its durable receipt before automatic delivery", async () => {
		const provider = makeProviderHarness()
		const task = makeMailboxRecipient(provider)
		const root = await Reflect.get(provider, "ensureAgentControlRoot").call(provider, task)
		const store = Reflect.get(provider, "agentControlStore") as AgentControlStore
		const child = await store.createAgent({
			taskId: "wait-auto-child",
			parentTaskId: root.taskId,
			nickname: "Child",
			role: "review",
			objective: "One delivery owner",
			status: "completed",
		})
		await store.appendEvent({
			eventId: "wait-owned-turn",
			sender: child.taskId,
			recipient: root.taskId,
			kind: "result",
			name: "agent_completed",
			payload: { taskId: child.taskId, status: "completed", summary: "Wait already read this body" },
		})
		const wait = (await provider.waitForAgent(task, 10_000)) as { claimId: string }
		vi.mocked(task.hasRetainedWaitAgentResultClaim).mockReturnValue(true)
		await task["deliverAgentMessages"]()
		expect(task.apiConversationHistory).toEqual([])
		const entries = store.getUnacknowledgedMailboxEntries(task.taskId)
		task.apiConversationHistory.push(
			{ role: "assistant", content: [{ type: "tool_use", id: "wait-replay", name: "wait_agent", input: {} }] },
			{
				role: "user",
				input_origin: "agent",
				content: [
					{
						type: "tool_result",
						tool_use_id: "wait-replay",
						content: JSON.stringify({
							source: "managed_agent_mailbox",
							claimId: wait.claimId,
							eventCount: 1,
						}),
					},
					{ type: "text", text: serializeAgentNotification(entries[0]) },
				],
			},
		)
		vi.mocked(task.hasRetainedWaitAgentResultClaim).mockReturnValue(false)
		await task["deliverAgentMessages"]()
		expect(task.apiConversationHistory).toHaveLength(2)
		expect(store.getUnacknowledgedMailboxEntries(task.taskId)).toEqual([])
	})

	it("defers completed result mail after a final answer while keeping active descendants blocking", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const root = await Reflect.get(provider, "ensureAgentControlRoot").call(provider, parent)
		const store = Reflect.get(provider, "agentControlStore") as AgentControlStore
		const child = await store.createAgent({
			taskId: "late-result-child",
			parentTaskId: root.taskId,
			nickname: "Child",
			role: "review",
			objective: "Finish after the final response",
			status: "completed",
		})
		await store.appendEvent({
			eventId: "late-final-result",
			sender: child.taskId,
			recipient: root.taskId,
			kind: "result",
			name: "agent_completed",
			payload: { taskId: child.taskId, status: "completed" },
		})
		await expect(
			provider.getParentCompletionDecision(parent as any, { deferResultNotifications: true }),
		).resolves.toMatchObject({ allowed: true })
		expect(store.getUnacknowledgedMailboxEntries(parent.taskId, { kinds: ["result"] })).toHaveLength(1)
		await store.createAgent({
			taskId: "required-active-child",
			parentTaskId: root.taskId,
			nickname: "Active",
			role: "review",
			objective: "Still required",
			status: "running",
		})
		await expect(
			provider.getParentCompletionDecision(parent as any, { deferResultNotifications: true }),
		).resolves.toMatchObject({
			allowed: false,
			activeDescendantCount: 1,
			unconsumedResultCount: 0,
		})
	})

	it("buffers multiple pre-launch messages and delivers them in order only at the recipient boundary", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ task_name: "backend_review", objective: "Inspect lifecycle state", agent_kind: "review" },
		])
		const records = await (provider as any).ensurePreparedSubagentControlRecords(parent, prepared)
		const record = records.get(prepared.envelopes[0].id)!
		const child = { taskId: record.taskId, taskKind: "subagent", rootTaskId: parent.taskId }
		await expect(provider.sendMessageToAgent(parent as any, record.taskId, "First message")).resolves.toMatchObject(
			{ delivery: "buffered" },
		)
		await provider.sendMessageToAgent(parent as any, record.taskId, "Second message")
		expect(provider.hasPendingAgentMessages(child as any)).toBe(true)
		const persist = vi.fn(async (_message: { text: string }) => undefined)
		await provider.deliverAgentMessages(child as any, persist)
		expect(persist.mock.calls.map(([message]) => message.text)).toEqual(["First message", "Second message"])
		expect(provider.hasPendingAgentMessages(child as any)).toBe(false)
	})

	it("delivers a message appended after the child's first boundary on its next boundary", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ task_name: "startup_race", objective: "Receive the parent message", agent_kind: "review" },
		])
		const store = (provider as any).agentControlStore as AgentControlStore
		await (provider as any).ensurePreparedSubagentControlRecords(parent, prepared)
		const record = store.getAgent(prepared.envelopes[0].id, parent.taskId)!
		const child = { taskId: record.taskId, taskKind: "subagent", rootTaskId: parent.taskId }
		let beginAppend!: () => void
		const started = new Promise<void>((resolve) => {
			beginAppend = resolve
		})
		let finishAppend!: () => void
		const gate = new Promise<void>((resolve) => {
			finishAppend = resolve
		})
		const appendEvent = store.appendEvent.bind(store)
		vi.spyOn(store, "appendEvent").mockImplementation(async (input) => {
			beginAppend()
			await gate
			return appendEvent(input)
		})
		const sending = provider.sendMessageToAgent(parent as any, record.taskId, "Message after startup")
		await started
		const persist = vi.fn(async (_message: { text: string }) => undefined)
		await provider.deliverAgentMessages(child as any, persist)
		expect(persist).not.toHaveBeenCalled()
		finishAppend()
		await sending
		await provider.deliverAgentMessages(child as any, persist)
		expect(persist).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: "Message after startup" }))
	})

	it("keeps messages durable during an approval and retries failed transcript persistence without acknowledging other events", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const root = await (provider as any).ensureAgentControlRoot(parent)
		const store = (provider as any).agentControlStore as AgentControlStore
		const record = await store.createAgent({
			taskId: "live-message-child",
			parentTaskId: root.taskId,
			rootTaskId: root.rootTaskId,
			nickname: "Live child",
			role: "review",
			objective: "Exercise durable messages",
			status: "running",
		})
		const child = {
			taskId: record.taskId,
			taskKind: "subagent",
			rootTaskId: root.rootTaskId,
			taskAsk: "tool",
			canAcceptSteerMessage: () => false,
			admitAgentMessage: async (persist: () => Promise<unknown>) => persist(),
			steerUserMessage: vi.fn(),
			submitUserMessage: vi.fn(),
		}
		;(provider as any).taskSessions.getTask = (id: string) => (id === record.taskId ? child : undefined)
		await store.appendEvent({
			rootTaskId: root.rootTaskId,
			sender: root.taskId,
			recipient: record.taskId,
			kind: "result",
			name: "unrelated_result",
			payload: { taskId: root.taskId },
		})
		await provider.sendMessageToAgent(parent as any, record.taskId, "Persist me before acknowledging")
		expect(child.steerUserMessage).not.toHaveBeenCalled()
		expect(child.submitUserMessage).not.toHaveBeenCalled()
		await expect(
			provider.deliverAgentMessages(child as any, async () => {
				throw new Error("disk failure")
			}),
		).rejects.toThrow("disk failure")
		expect(provider.hasPendingAgentMessages(child as any)).toBe(true)
		const persist = vi.fn(async (_message: { text: string }) => undefined)
		await provider.deliverAgentMessages(child as any, persist)
		expect(persist).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ text: "Persist me before acknowledging" }),
		)
		expect(store.getUnacknowledgedMailboxEntries(record.taskId, { rootTaskId: root.rootTaskId })).toEqual([
			expect.objectContaining({ name: "unrelated_result" }),
		])
	})

	it("returns a compact agent projection without terminal reports or mailbox payloads", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const root = await (provider as any).ensureAgentControlRoot(parent)
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{
				task_name: "compact_child",
				objective: "Review the lifecycle projection",
				agent_kind: "review",
			},
		])
		vi.spyOn(provider as any, "startPreparedSubagentRun").mockResolvedValue({
			taskId: prepared.envelopes[0].id,
		})
		await provider.launchPreparedSubagentGroup(parent as any, prepared, new AbortController().signal)
		const contextManifest = (provider as any).subagentDescriptors.get(prepared.envelopes[0].id).contextManifest
		const leakedReport = `UNBOUNDED_REPORT_${"x".repeat(100_000)}`
		const child = (provider as any).agentControlStore.getAgent(prepared.envelopes[0].id, root.rootTaskId)
		await (provider as any).agentControlStore.updateAgentStatus(
			child.taskId,
			"completed",
			{
				snapshot: {
					phase: "completed",
					summary: leakedReport,
					modelRouteId: "review-route",
					usage: { inputTokens: 12, outputTokens: 3 },
					contextManifest,
					metadata: { report: leakedReport },
				},
				terminalResult: {
					status: "completed",
					summary: leakedReport,
					error: leakedReport,
					changedFiles: [leakedReport],
					completedAt: 2,
				},
			},
			root.rootTaskId,
		)
		await (provider as any).agentControlStore.appendEvent({
			rootTaskId: root.rootTaskId,
			sender: child.taskId,
			recipient: root.taskId,
			kind: "message",
			name: "large_child_message",
			payload: { report: leakedReport },
		})

		const listed = (await provider.listAgents(parent as any)) as any
		const serialized = JSON.stringify(listed)

		expect(listed.observedAt).toEqual(expect.any(Number))
		expect(listed.mailbox.unreadCount).toBe(1)
		expect(listed.agents).toEqual([
			expect.objectContaining({
				taskId: child.taskId,
				path: child.path,
				parentTaskId: root.taskId,
				rootTaskId: root.rootTaskId,
				groupId: prepared.group.groupId,
				nickname: child.nickname,
				role: "review",
				objective: "Review the lifecycle projection",
				status: "completed",
				phase: "completed",
				modelRouteId: "review-route",
				usage: { inputTokens: 12, outputTokens: 3 },
				delegationPolicy: "explicit-only",
				delegationPolicyProvenance: {
					policy: "explicit-only",
					source: "default",
					authorization: "session-policy",
					explicitUserRequest: false,
				},
				resultAvailable: true,
			}),
		])
		expect(typeof listed.agents[0].delegationPolicy).toBe("string")
		expect(listed.agents[0]).not.toHaveProperty("snapshot")
		expect(listed.agents[0]).not.toHaveProperty("terminalResult")
		expect(serialized).not.toContain("UNBOUNDED_REPORT_")
		expect(serialized.length).toBeLessThan(2_000)
	})

	it("projects the durable nested registry into a bounded reload-safe webview contract", async () => {
		const provider = makeProviderHarness(3, {
			maxConcurrentSubagents: 3,
			subagentDelegationPolicy: "proactive",
			subagentMaxDepth: 3,
			subagentRootTokenBudget: 50_000,
			subagentRootCostBudget: 5,
		})
		const parent = makeParent()
		const root = await (provider as any).ensureAgentControlRoot(parent)
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{
				task_name: "durable_parent",
				objective: "Own a nested durable child",
				agent_kind: "review",
			},
		])
		vi.spyOn(provider as any, "startPreparedSubagentRun").mockResolvedValue({
			taskId: prepared.envelopes[0].id,
		})
		await provider.launchPreparedSubagentGroup(parent as any, prepared, new AbortController().signal)
		const child = (provider as any).agentControlStore.getAgent(prepared.envelopes[0].id, root.rootTaskId)
		await (provider as any).agentControlStore.updateAgentStatus(child.taskId, "running", {}, root.rootTaskId)
		const directManifest = (provider as any).subagentDescriptors.get(child.taskId).contextManifest
		const nestedManifest = structuredClone(directManifest)
		nestedManifest.parentTaskId = child.taskId
		nestedManifest.orchestration.ancestry.parentTaskId = child.taskId
		nestedManifest.orchestration.ancestry.depth = 2
		const leakedReport = `PRIVATE_REPORT_${"x".repeat(10_000)}`
		const grandchild = await (provider as any).agentControlStore.createAgent({
			taskId: "durable-grandchild",
			parentTaskId: child.taskId,
			rootTaskId: root.rootTaskId,
			groupId: "nested-group",
			nickname: "Nested Review",
			role: "review",
			objective: "Validate durable projection nesting",
			status: "completed",
			snapshot: {
				phase: "reporting",
				summary: leakedReport,
				stopReason: "root_cost_budget",
				usage: { inputTokens: 120, outputTokens: 30, cost: 0.75 },
				contextManifest: nestedManifest,
				metadata: { report: leakedReport },
			},
		})
		await (provider as any).agentControlStore.appendEvent({
			rootTaskId: root.rootTaskId,
			sender: grandchild.taskId,
			recipient: root.taskId,
			kind: "result",
			name: "agent_completed",
			payload: { report: leakedReport },
		})
		;(provider as any).agentControlStoreLoadedAt = Date.now() + 1
		const getFullSnapshot = vi.spyOn((provider as any).agentControlStore, "getSnapshot")

		const projection = await (provider as any).buildManagedAgentTreeProjection(
			parent,
			(provider as any).getResolvedSubagentOrchestrationSettings(),
		)

		expect(managedAgentTreeProjectionSchema.safeParse(projection).success).toBe(true)
		expect(projection).toMatchObject({
			rootTaskId: root.rootTaskId,
			reloadedAt: expect.any(Number),
			capacity: { active: 1, queued: 0, terminal: 1, limit: 3 },
			budgets: { tokenLimit: null, costLimit: null },
		})
		expect(projection.nodes).toEqual([
			expect.objectContaining({ taskId: root.taskId, path: "/root", depth: 0, role: "root" }),
			expect.objectContaining({
				taskId: child.taskId,
				parentTaskId: root.taskId,
				path: "/root/durable-parent",
				depth: 1,
				maxDepth: null,
				delegationPolicy: "explicit-only",
			}),
			expect.objectContaining({
				taskId: grandchild.taskId,
				parentTaskId: child.taskId,
				path: "/root/durable-parent/nested-review",
				depth: 2,
				stopReason: "root_cost_budget",
				usage: expect.objectContaining({ inputTokens: 120, outputTokens: 30, cost: 0.75, durationMs: 0 }),
			}),
		])
		expect(projection.activity).toEqual([
			expect.objectContaining({
				senderTaskId: grandchild.taskId,
				kind: "result",
				name: "agent_completed",
				summary: "Agent completed",
			}),
		])
		const serialized = JSON.stringify(projection)
		expect(serialized).not.toContain("contextManifest")
		expect(serialized).not.toContain("payload")
		expect(serialized).not.toContain("PRIVATE_REPORT_")
		expect(getFullSnapshot).not.toHaveBeenCalled()
	})

	it("returns immediately instead of waiting when the current tree has no active agents", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const request = new AbortController()
		parent.beginAgentWait = vi.fn(() => ({ signal: request.signal, dispose: vi.fn() }))

		const waiting = provider.waitForAgent(parent as any, 10_000)
		const result = await Promise.race([
			waiting,
			new Promise<"still-waiting">((resolve) => setTimeout(() => resolve("still-waiting"), 50)),
		])
		if (result === "still-waiting") request.abort(new Error("test cleanup"))

		expect(result).toEqual({ timedOut: false, noActiveAgents: true, events: [] })
		expect(parent.beginAgentWait).not.toHaveBeenCalled()
	})

	it.each([NaN, Infinity, 3_600_001, 10_000.5])(
		"rejects an invalid host wait deadline %s before reading the mailbox",
		async (timeoutMs) => {
			const provider = makeProviderHarness()
			const initialize = vi.spyOn(provider as any, "ensureAgentControlRoot")
			await expect(provider.waitForAgent(makeParent() as any, timeoutMs)).rejects.toThrow(
				"timeout_ms must be an integer",
			)
			expect(initialize).not.toHaveBeenCalled()
		},
	)

	it.each(["default-deadline", "explicit-deadline", "activity", "cancel"] as const)(
		"settles a blocking wait on %s and disposes its timer and subscription",
		async (scenario) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
			try {
				const provider = makeProviderHarness()
				const parent = makeParent()
				const root = await (provider as any).ensureAgentControlRoot(parent)
				const store = (provider as any).agentControlStore as AgentControlStore
				await store.createAgent({
					taskId: "waiting-child",
					parentTaskId: root.taskId,
					rootTaskId: root.rootTaskId,
					nickname: "Waiting",
					role: "review",
					objective: "Wait",
					status: "running",
				})
				const controller = new AbortController()
				const dispose = vi.fn()
				parent.beginAgentWait = vi.fn(() => ({ signal: controller.signal, dispose }))
				const unsubscribe = vi.fn()
				const subscribe = store.subscribe.bind(store)
				vi.spyOn(store, "subscribe").mockImplementation((listener) => {
					const release = subscribe(listener)
					return () => {
						unsubscribe()
						release()
					}
				})
				const waiting = provider.waitForAgent(
					parent as any,
					scenario === "explicit-deadline" ? 10_000 : undefined,
				)
				await vi.waitFor(() => expect(store.subscribe).toHaveBeenCalledOnce())
				const duration =
					scenario === "default-deadline" ? 120_000 : scenario === "explicit-deadline" ? 10_000 : 1_000
				await vi.advanceTimersByTimeAsync(duration)
				if (scenario === "activity")
					await store.appendEvent({
						rootTaskId: root.rootTaskId,
						sender: "waiting-child",
						recipient: root.taskId,
						kind: "message",
						name: "agent_progress",
					})
				if (scenario === "cancel") controller.abort()
				expect(await waiting).toMatchObject(
					scenario === "cancel"
						? { cancelled: true, timedOut: false }
						: { timedOut: scenario !== "activity" },
				)
				expect(dispose).toHaveBeenCalledOnce()
				expect(unsubscribe).toHaveBeenCalledOnce()
				expect(vi.getTimerCount()).toBe(0)
			} finally {
				vi.useRealTimers()
			}
		},
	)

	it("collects a child result after 95 seconds across default waits with no timer leak", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		try {
			const provider = makeProviderHarness()
			const parent = makeParent()
			const root = await (provider as any).ensureAgentControlRoot(parent)
			const store = (provider as any).agentControlStore as AgentControlStore
			await store.createAgent({
				taskId: "slow-child",
				parentTaskId: root.taskId,
				rootTaskId: root.rootTaskId,
				nickname: "Slow child",
				role: "review",
				objective: "Complete after 95 seconds",
				status: "running",
			})
			const dispose = vi.fn()
			parent.beginAgentWait = vi.fn(() => ({ signal: new AbortController().signal, dispose }))
			const waitCalls = vi.spyOn(provider, "waitForAgent")
			let elapsedMs = 0
			let result: unknown
			while (elapsedMs < 95_000) {
				const waiting = provider.waitForAgent(parent as any)
				await vi.waitFor(() => expect(parent.beginAgentWait).toHaveBeenCalledTimes(waitCalls.mock.calls.length))
				// Observe the actual host timer, then advance only until that deadline or child delivery.
				let settled = false
				void waiting.then(() => {
					settled = true
				})
				while (!settled && elapsedMs < 95_000) {
					await vi.advanceTimersByTimeAsync(5_000)
					elapsedMs += 5_000
					await store.flush()
				}
				if (elapsedMs === 95_000) {
					await store.appendEvent({
						rootTaskId: root.rootTaskId,
						sender: "slow-child",
						recipient: root.taskId,
						kind: "result",
						name: "agent_completed",
						payload: { taskId: "slow-child", status: "completed", summary: "Verified result" },
					})
				}
				result = await waiting
			}
			expect(result).toMatchObject({
				timedOut: false,
				eventCount: 1,
			})
			expect(parent.stageWaitAgentNotifications).toHaveBeenCalledWith((result as any).claimId, [
				expect.objectContaining({ name: "agent_completed" }),
			])
			expect(waitCalls).toHaveBeenCalledTimes(4)
			expect(dispose).toHaveBeenCalledTimes(4)
			expect(vi.getTimerCount()).toBe(0)
		} finally {
			vi.useRealTimers()
		}
	})

	it("wakes a registered child's idle wait for passive parent mail without consuming or steering it", async () => {
		const provider = makeProviderHarness()
		const rootTask = makeParent()
		const root = await (provider as any).ensureAgentControlRoot(rootTask)
		const child = await (provider as any).agentControlStore.createAgent({
			taskId: "waiting-child",
			parentTaskId: root.taskId,
			rootTaskId: root.rootTaskId,
			nickname: "Waiting child",
			role: "review",
			objective: "Wait for immediate-parent control",
			status: "running",
		})
		const request = new AbortController()
		const dispose = vi.fn()
		const store = Reflect.get(provider, "agentControlStore") as AgentControlStore
		let registered!: () => void
		const subscribed = new Promise<void>((resolve) => {
			registered = resolve
		})
		const subscribe = store.subscribe.bind(store)
		vi.spyOn(store, "subscribe").mockImplementation((listener) => {
			const unsubscribe = subscribe(listener)
			registered()
			return unsubscribe
		})
		const childTask = {
			...makeParent(),
			taskId: child.taskId,
			taskKind: "subagent",
			rootTaskId: root.rootTaskId,
			parentTaskId: root.taskId,
			beginAgentWait: vi.fn(() => ({ signal: request.signal, dispose })),
		}

		const waiting = provider.waitForAgent(childTask as any, 10_000)
		try {
			await subscribed
			expect(childTask.beginAgentWait).toHaveBeenCalledOnce()

			await (provider as any).agentControlStore.appendEvent({
				rootTaskId: root.rootTaskId,
				sender: root.taskId,
				recipient: child.taskId,
				kind: "message",
				name: "parent_message",
				payload: { message: "CANCEL_NOW" },
			})
			await expect(waiting).resolves.toMatchObject({
				timedOut: false,
				mailboxActivity: true,
			})
			expect(request.signal.aborted).toBe(false)
			expect(childTask.stageWaitAgentNotifications).not.toHaveBeenCalled()
			expect(
				(provider as any).agentControlStore.getUnacknowledgedMailboxEntries(child.taskId, {
					rootTaskId: root.rootTaskId,
				}),
			).toEqual([expect.objectContaining({ senderTaskId: root.taskId, name: "parent_message" })])
			expect(dispose).toHaveBeenCalledOnce()
		} finally {
			request.abort(new Error("test cleanup"))
		}
	})

	it("routes nested agent progress only to the immediate parent and lets wait_agent claim it once", async () => {
		const provider = makeProviderHarness(3)
		const rootTask = makeParent()
		const root = await (provider as any).ensureAgentControlRoot(rootTask)
		const child = await (provider as any).agentControlStore.createAgent({
			taskId: "progress-child",
			parentTaskId: root.taskId,
			rootTaskId: root.rootTaskId,
			nickname: "Progress child",
			role: "review",
			objective: "Own nested progress",
			status: "running",
		})
		const grandchild = await (provider as any).agentControlStore.createAgent({
			taskId: "progress-grandchild",
			parentTaskId: child.taskId,
			rootTaskId: root.rootTaskId,
			nickname: "Progress grandchild",
			role: "review",
			objective: "Report nested progress",
			status: "running",
		})
		const childTask = {
			...makeParent(),
			taskId: child.taskId,
			taskKind: "subagent",
			rootTaskId: root.rootTaskId,
			parentTaskId: root.taskId,
		}
		const grandchildTask = {
			...makeParent(),
			taskId: grandchild.taskId,
			taskKind: "subagent",
			// Reproduce the retained depth-two identity written by the broken build:
			// the live field points at the immediate parent while the frozen manifest
			// and durable agent record retain the real orchestration root.
			rootTaskId: child.taskId,
			subagentContextManifest: {
				orchestration: { ancestry: { rootTaskId: root.rootTaskId } },
			},
			// A stale or spoofed live field must not override the durable frozen parent.
			parentTaskId: root.taskId,
		}

		const result = (await provider.reportAgentProgress(
			grandchildTask as any,
			"Nested audit is halfway complete.",
		)) as any
		expect(result).toMatchObject({
			taskId: grandchild.taskId,
			parentTaskId: child.taskId,
			parentPath: child.path,
			delivery: "buffered",
			event: {
				senderTaskId: grandchild.taskId,
				recipientTaskId: child.taskId,
				kind: "message",
				name: "agent_progress",
				payload: { message: "Nested audit is halfway complete." },
			},
		})
		expect(
			(provider as any).agentControlStore.readMailbox(root.taskId, {
				rootTaskId: root.rootTaskId,
				includeDelivered: false,
			}).entries,
		).toEqual([])

		const automatic = await provider.claimAutomaticSubagentResults(childTask as any, [grandchild.taskId])
		expect(automatic.taskIds).toEqual([])
		const waited = (await provider.waitForAgent(childTask as any, 10_000)) as any
		expect(waited).toMatchObject({
			timedOut: false,
			eventCount: 1,
			updatedAgents: [{ taskId: grandchild.taskId, path: grandchild.path }],
		})
		expect(childTask.stageWaitAgentNotifications).toHaveBeenCalledWith(waited.claimId, [
			expect.objectContaining({
				senderTaskId: grandchild.taskId,
				recipientTaskId: child.taskId,
				kind: "message",
				name: "agent_progress",
			}),
		])
		expect(
			(provider as any).agentControlStore.readMailbox(child.taskId, {
				rootTaskId: root.rootTaskId,
				includeDelivered: false,
			}).entries,
		).toEqual([])
	})

	it("rejects report_progress from roots and when the frozen immediate parent is missing", async () => {
		const provider = makeProviderHarness()
		const rootTask = makeParent()
		await expect(provider.reportAgentProgress(rootTask as any, "Root update")).rejects.toThrow(
			"only to managed sub-agents",
		)

		const root = await (provider as any).ensureAgentControlRoot(rootTask)
		const child = await (provider as any).agentControlStore.createAgent({
			taskId: "orphaned-progress-child",
			parentTaskId: root.taskId,
			rootTaskId: root.rootTaskId,
			nickname: "Orphaned progress child",
			role: "review",
			objective: "Expose a missing durable parent",
			status: "running",
		})
		const childTask = {
			...makeParent(),
			taskId: child.taskId,
			taskKind: "subagent",
			rootTaskId: root.rootTaskId,
			parentTaskId: root.taskId,
		}
		const getAgent = vi
			.spyOn((provider as any).agentControlStore, "getAgent")
			.mockReturnValueOnce(child)
			.mockReturnValueOnce(undefined)

		await expect(provider.reportAgentProgress(childTask as any, "Still working")).rejects.toThrow(
			`Immediate parent ${root.taskId}`,
		)
		expect(getAgent).toHaveBeenCalledTimes(2)
	})

	it("cancels a mailbox wait when the parent request is cancelled", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const root = await (provider as any).ensureAgentControlRoot(parent)
		await (provider as any).agentControlStore.createAgent({
			taskId: "running-child",
			parentTaskId: root.taskId,
			rootTaskId: root.rootTaskId,
			nickname: "Running child",
			role: "explore",
			objective: "Keep the mailbox wait active",
			status: "running",
		})
		const request = new AbortController()
		const dispose = vi.fn()
		parent.beginAgentWait = vi.fn(() => ({ signal: request.signal, dispose }))

		const waiting = provider.waitForAgent(parent as any, 10_000)
		request.abort(new Error("parent request stopped"))

		await expect(waiting).resolves.toEqual({ timedOut: false, cancelled: true, events: [] })
		expect(dispose).toHaveBeenCalledOnce()
	})

	it("leaves a notification that arrives after a native wait claim available for the next wait", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const root = await (provider as any).ensureAgentControlRoot(parent)
		await (provider as any).agentControlStore.createAgent({
			taskId: "running-child-read-race",
			parentTaskId: root.taskId,
			rootTaskId: root.rootTaskId,
			nickname: "Running child",
			role: "review",
			objective: "Keep the mailbox wait active",
			status: "running",
		})

		let releaseFirstClaim!: () => void
		const firstClaimBlocked = new Promise<void>((resolve) => (releaseFirstClaim = resolve))
		let announceFirstClaim!: () => void
		const firstClaimStarted = new Promise<void>((resolve) => (announceFirstClaim = resolve))
		const store = (provider as any).agentControlStore as AgentControlStore
		const originalClaimMailbox = store.claimMailbox.bind(store)
		let blocked = false
		vi.spyOn(store, "claimMailbox").mockImplementation(async (...args) => {
			const claim = await originalClaimMailbox(...args)
			if (!blocked && claim.entries.some((entry) => entry.name === "first_update")) {
				blocked = true
				announceFirstClaim()
				await firstClaimBlocked
			}
			return claim
		})

		const waiting = provider.waitForAgent(parent as any, 10_000)
		await vi.waitFor(() => expect(parent.beginAgentWait).toHaveBeenCalledOnce())
		// Let the post-subscribe race-closing read observe an empty mailbox first.
		await (provider as any).agentControlStore.flush()
		await (provider as any).agentControlStore.appendEvent({
			rootTaskId: root.rootTaskId,
			sender: "running-child-read-race",
			recipient: root.taskId,
			kind: "message",
			name: "first_update",
		})
		await firstClaimStarted
		await (provider as any).agentControlStore.appendEvent({
			rootTaskId: root.rootTaskId,
			sender: "running-child-read-race",
			recipient: root.taskId,
			kind: "message",
			name: "second_update",
		})
		await new Promise<void>((resolve) => setImmediate(resolve))

		releaseFirstClaim()
		await expect(waiting).resolves.toMatchObject({
			timedOut: false,
			source: "managed_agent_mailbox",
			claimId: expect.any(String),
			eventCount: 1,
		})
		expect(parent.stageWaitAgentNotifications).toHaveBeenCalledWith(expect.any(String), [
			expect.objectContaining({ name: "first_update" }),
		])
		expect(
			store
				.getUnacknowledgedMailboxEntries(root.taskId, { rootTaskId: root.rootTaskId })
				.map(({ name, claimChannel }: { name: string; claimChannel?: string }) => ({ name, claimChannel })),
		).toEqual([
			{ name: "first_update", claimChannel: "wait" },
			{ name: "second_update", claimChannel: undefined },
		])
	})

	it("does not treat lifecycle rendering as consumption of a native wait result", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const root = await (provider as any).ensureAgentControlRoot(parent)
		const child = await (provider as any).agentControlStore.createAgent({
			taskId: "child-delivered",
			parentTaskId: root.taskId,
			rootTaskId: root.rootTaskId,
			groupId: "group-delivered",
			nickname: "Delivered",
			role: "explore",
			objective: "Inspect delivery",
			status: "completed",
		})
		parent.alphaMessages = [
			{
				subagentGroup: {
					groupId: "group-delivered",
					parentTaskId: parent.taskId,
					executionMode: "async",
					status: "completed",
					createdAt: 1,
					completedAt: 2,
					agents: [
						{
							taskId: child.taskId,
							nickname: child.nickname,
							role: child.role,
							objective: child.objective,
							status: "completed",
							completedAt: 2,
							resultDeliveredAt: 3,
							usage: { durationMs: 1 },
						},
					],
				},
			},
		] as any
		await (provider as any).agentControlStore.appendEvent({
			rootTaskId: root.rootTaskId,
			sender: child.taskId,
			recipient: root.taskId,
			kind: "result",
			name: "agent_completed",
			payload: { taskId: child.taskId, status: "completed" },
		})

		const listed = (await provider.listAgents(parent as any)) as any
		expect(listed.mailbox.unreadCount).toBe(1)

		const waited = (await provider.waitForAgent(parent as any, 10_000)) as any
		expect(waited).toMatchObject({
			timedOut: false,
			source: "managed_agent_mailbox",
			claimId: expect.any(String),
			eventCount: 1,
			updatedAgents: [{ taskId: child.taskId, path: child.path }],
		})
		expect(waited).not.toHaveProperty("events")
		expect(parent.stageWaitAgentNotifications).toHaveBeenCalledWith(waited.claimId, [
			expect.objectContaining({
				kind: "result",
				name: "agent_completed",
				senderTaskId: child.taskId,
				payload: expect.objectContaining({ status: "completed" }),
			}),
		])
		expect(
			(provider as any).agentControlStore.getUnacknowledgedMailboxEntries(root.taskId, {
				rootTaskId: root.rootTaskId,
				kinds: ["result"],
			}),
		).toEqual([expect.objectContaining({ claimId: waited.claimId, claimChannel: "wait" })])

		await provider.acknowledgeWaitAgentResults(parent as any, waited.claimId)
		expect(
			(provider as any).agentControlStore.getUnacknowledgedMailboxEntries(root.taskId, {
				rootTaskId: root.rootTaskId,
				kinds: ["result"],
			}),
		).toEqual([])
	})

	it("bounds one wait summary and leaves later mailbox entries for the next claim", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const root = await (provider as any).ensureAgentControlRoot(parent)
		const child = await (provider as any).agentControlStore.createAgent({
			taskId: "chatty-child",
			parentTaskId: root.taskId,
			rootTaskId: root.rootTaskId,
			nickname: "Chatty",
			role: "review",
			objective: "Send updates",
			status: "running",
		})
		for (let index = 0; index < 17; index++) {
			await (provider as any).agentControlStore.appendEvent({
				rootTaskId: root.rootTaskId,
				sender: child.taskId,
				recipient: root.taskId,
				kind: "message",
				name: "agent_progress",
				payload: { message: `Update ${index}` },
			})
		}
		const waited = (await provider.waitForAgent(parent as any, 10_000)) as any
		expect(waited).toMatchObject({ eventCount: 16, updatedAgents: [{ taskId: child.taskId, path: child.path }] })
		expect(waited).not.toHaveProperty("events")
		expect((parent.stageWaitAgentNotifications as any).mock.lastCall[1]).toHaveLength(16)
		expect(
			(provider as any).agentControlStore.getUnacknowledgedMailboxEntries(root.taskId, {
				rootTaskId: root.rootTaskId,
			}),
		).toHaveLength(17)
	})

	it("claims a native wait result without mutating its lifecycle projection", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const root = await (provider as any).ensureAgentControlRoot(parent)
		const child = await (provider as any).agentControlStore.createAgent({
			taskId: "child-wait-claimed",
			parentTaskId: root.taskId,
			rootTaskId: root.rootTaskId,
			groupId: "group-wait-claimed",
			nickname: "Claimed",
			role: "review",
			objective: "Review result ownership",
			status: "completed",
		})
		const liveGroup: SubagentGroupState = {
			groupId: "group-wait-claimed",
			parentTaskId: parent.taskId,
			executionMode: "async",
			status: "running",
			createdAt: 1,
			agents: [
				{
					taskId: child.taskId,
					nickname: child.nickname,
					role: child.role,
					objective: child.objective,
					status: "running",
					startedAt: 1,
					summary: "Ownership race inspected",
					usage: { durationMs: 1 },
				},
			],
		}
		parent.alphaMessages = [
			{
				type: "say",
				say: "subagent_group",
				subagentGroup: structuredClone(liveGroup),
			},
		] as any
		;(provider as any).preparedSubagentGroups.set(liveGroup.groupId, {
			group: liveGroup,
			envelopes: [],
		})
		parent.upsertSubagentGroup = vi.fn(async (group: SubagentGroupState) => {
			parent.alphaMessages[0].subagentGroup = structuredClone(group)
		})
		await (provider as any).agentControlStore.appendEvent({
			rootTaskId: root.rootTaskId,
			sender: child.taskId,
			recipient: root.taskId,
			kind: "result",
			name: "agent_completed",
			payload: {
				taskId: child.taskId,
				groupId: "group-wait-claimed",
				status: "completed",
			},
		})

		// The durable result event can be published just before the retained group
		// receives its terminal status. wait_agent must claim it without using the
		// lifecycle row as a consumption receipt.
		const waited = (await provider.waitForAgent(parent as any, 10_000)) as any

		expect(waited).toMatchObject({
			timedOut: false,
			source: "managed_agent_mailbox",
			claimId: expect.any(String),
			eventCount: 1,
			updatedAgents: [{ taskId: child.taskId, path: child.path }],
		})
		expect(parent.stageWaitAgentNotifications).toHaveBeenCalledWith(waited.claimId, [
			expect.objectContaining({
				name: "agent_completed",
				senderTaskId: child.taskId,
				payload: expect.objectContaining({ status: "completed" }),
			}),
		])
		expect(parent.upsertSubagentGroup).not.toHaveBeenCalled()
		expect(parent.alphaMessages[0].subagentGroup?.agents[0].resultDeliveredAt).toBeUndefined()
		expect(
			(provider as any).agentControlStore.getUnacknowledgedMailboxEntries(root.taskId, {
				rootTaskId: root.rootTaskId,
				kinds: ["result"],
			}),
		).toEqual([expect.objectContaining({ claimId: waited.claimId, claimChannel: "wait" })])

		liveGroup.status = "completed"
		liveGroup.completedAt = 2
		liveGroup.agents[0].status = "completed"
		liveGroup.agents[0].completedAt = 2
		await (parent.upsertSubagentGroup as any)(liveGroup)

		expect(parent.upsertSubagentGroup).toHaveBeenCalledOnce()
		expect(parent.alphaMessages[0].subagentGroup?.agents[0].resultDeliveredAt).toBeUndefined()
	})

	it("returns ordered completion, failure, and cancellation provenance and blocks completion until its native receipt", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const root = await (provider as any).ensureAgentControlRoot(parent)
		const terminalAgents = await Promise.all([
			(provider as any).agentControlStore.createAgent({
				taskId: "child-completed-native",
				parentTaskId: root.taskId,
				rootTaskId: root.rootTaskId,
				nickname: "Completed native",
				role: "explore",
				objective: "Complete the audit",
				status: "completed",
			}),
			(provider as any).agentControlStore.createAgent({
				taskId: "child-failed-native",
				parentTaskId: root.taskId,
				rootTaskId: root.rootTaskId,
				nickname: "Failed native",
				role: "review",
				objective: "Fail with evidence",
				status: "failed",
			}),
			(provider as any).agentControlStore.createAgent({
				taskId: "child-cancelled-native",
				parentTaskId: root.taskId,
				rootTaskId: root.rootTaskId,
				nickname: "Cancelled native",
				role: "review",
				objective: "Cancel with evidence",
				status: "cancelled",
			}),
		])
		const terminalPayloads = [
			{ taskId: terminalAgents[0].taskId, status: "completed", summary: "Audit complete." },
			{
				taskId: terminalAgents[1].taskId,
				status: "failed",
				summary: "Audit failed.",
				stopReason: "runtime_error",
			},
			{
				taskId: terminalAgents[2].taskId,
				status: "cancelled",
				summary: "Audit cancelled.",
				stopReason: "parent_cancelled",
			},
		]
		for (const [index, payload] of terminalPayloads.entries()) {
			await (provider as any).agentControlStore.appendEvent({
				eventId: `terminal-native-${index + 1}`,
				rootTaskId: root.rootTaskId,
				sender: payload.taskId,
				recipient: root.taskId,
				kind: "result",
				name: `agent_${payload.status}`,
				payload,
			})
		}

		const firstWait = (await provider.waitForAgent(parent as any, 10_000)) as any
		expect(firstWait).toMatchObject({
			timedOut: false,
			source: "managed_agent_mailbox",
			claimId: expect.any(String),
			eventCount: 3,
		})
		expect(firstWait).not.toHaveProperty("events")
		const firstNotifications = (parent.stageWaitAgentNotifications as any).mock.lastCall[1]
		expect(
			firstNotifications.map((event: any) => ({
				eventId: event.eventId,
				senderTaskId: event.senderTaskId,
				senderPath: event.senderPath,
				status: event.payload.status,
				summary: event.payload.summary,
				stopReason: event.payload.stopReason,
			})),
		).toEqual([
			{
				eventId: "terminal-native-1",
				senderTaskId: terminalAgents[0].taskId,
				senderPath: terminalAgents[0].path,
				status: "completed",
				summary: "Audit complete.",
				stopReason: undefined,
			},
			{
				eventId: "terminal-native-2",
				senderTaskId: terminalAgents[1].taskId,
				senderPath: terminalAgents[1].path,
				status: "failed",
				summary: "Audit failed.",
				stopReason: "runtime_error",
			},
			{
				eventId: "terminal-native-3",
				senderTaskId: terminalAgents[2].taskId,
				senderPath: terminalAgents[2].path,
				status: "cancelled",
				summary: "Audit cancelled.",
				stopReason: "parent_cancelled",
			},
		])

		// Returning/rendering a wait result is not a durable receipt. The completion
		// gate releases the orphaned claim for retry but keeps all results blocking.
		await expect(provider.getParentCompletionDecision(parent as any)).resolves.toMatchObject({
			allowed: false,
			message: expect.stringContaining("3 immediate-parent terminal results remain unconsumed"),
		})
		const retried = (await provider.waitForAgent(parent as any, 10_000)) as any
		expect(retried.claimId).not.toBe(firstWait.claimId)
		const retriedNotifications = (parent.stageWaitAgentNotifications as any).mock.lastCall[1]
		expect(retriedNotifications.map((event: any) => event.eventId)).toEqual([
			"terminal-native-1",
			"terminal-native-2",
			"terminal-native-3",
		])

		parent.apiConversationHistory = [
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "call-terminal-native", name: "wait_agent", input: {} }],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call-terminal-native",
						content: JSON.stringify(retried),
					},
					...retriedNotifications.map((event: any) => ({
						type: "text",
						text: serializeAgentNotification(event),
					})),
				],
			},
		] as any
		await expect(provider.getParentCompletionDecision(parent as any)).resolves.toMatchObject({ allowed: true })
		expect(
			(provider as any).agentControlStore.getUnacknowledgedMailboxEntries(root.taskId, {
				rootTaskId: root.rootTaskId,
				kinds: ["result"],
			}),
		).toEqual([])
		await expect(provider.waitForAgent(parent as any, 10_000)).resolves.toEqual({
			timedOut: false,
			noActiveAgents: true,
			events: [],
		})
	})

	it("returns non-result mailbox events without mutating the lifecycle projection", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const root = await (provider as any).ensureAgentControlRoot(parent)
		const child = await (provider as any).agentControlStore.createAgent({
			taskId: "child-message-only",
			parentTaskId: root.taskId,
			rootTaskId: root.rootTaskId,
			groupId: "group-message-only",
			nickname: "Messenger",
			role: "explore",
			objective: "Send a mailbox update",
			status: "completed",
		})
		parent.alphaMessages = [
			{
				subagentGroup: {
					groupId: "group-message-only",
					parentTaskId: parent.taskId,
					executionMode: "async",
					status: "completed",
					createdAt: 1,
					completedAt: 2,
					agents: [
						{
							taskId: child.taskId,
							nickname: child.nickname,
							role: child.role,
							objective: child.objective,
							status: "completed",
							completedAt: 2,
							usage: { durationMs: 1 },
						},
					],
				},
			},
		] as any
		await (provider as any).agentControlStore.appendEvent({
			rootTaskId: root.rootTaskId,
			sender: child.taskId,
			recipient: root.taskId,
			kind: "message",
			name: "child_message",
			payload: { taskId: child.taskId, message: "Still not a result" },
		})

		await expect(provider.waitForAgent(parent as any, 10_000)).resolves.toMatchObject({
			timedOut: false,
			eventCount: 1,
		})
		expect(parent.stageWaitAgentNotifications).toHaveBeenCalledWith(expect.any(String), [
			expect.objectContaining({ kind: "message" }),
		])
		expect(parent.upsertSubagentGroup).not.toHaveBeenCalled()
		expect(parent.alphaMessages[0].subagentGroup.agents[0].resultDeliveredAt).toBeUndefined()
	})

	it("lets two targeted terminal waits claim only their own results and leaves lifecycle traffic unread", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const root = await (provider as any).ensureAgentControlRoot(parent)
		const first = await (provider as any).agentControlStore.createAgent({
			taskId: "targeted-first",
			parentTaskId: root.taskId,
			rootTaskId: root.rootTaskId,
			nickname: "First",
			role: "review",
			objective: "Finish first",
			status: "completed",
		})
		const second = await (provider as any).agentControlStore.createAgent({
			taskId: "targeted-second",
			parentTaskId: root.taskId,
			rootTaskId: root.rootTaskId,
			nickname: "Second",
			role: "review",
			objective: "Finish second",
			status: "completed",
		})
		await (provider as any).agentControlStore.appendEvent({
			rootTaskId: root.rootTaskId,
			sender: first.taskId,
			recipient: root.taskId,
			kind: "lifecycle",
			name: "agent_started",
			payload: { phase: "running" },
		})
		for (const record of [first, second]) {
			await (provider as any).agentControlStore.appendEvent({
				rootTaskId: root.rootTaskId,
				sender: record.taskId,
				recipient: root.taskId,
				kind: "result",
				name: "agent_completed",
				payload: { taskId: record.taskId, status: "completed" },
			})
		}

		const runId = `${second.taskId}:24671585-d309-4b5b-9847-3244e4769d74`
		vi.spyOn((provider as any).asyncSubagentRunManager, "resolveRunTaskId").mockImplementation((target) =>
			target === runId ? second.taskId : undefined,
		)
		const waited = (await provider.waitForAgent(parent as any, 10_000, {
			target: runId,
			untilTerminal: true,
		})) as any

		expect(waited).toMatchObject({
			timedOut: false,
			source: "managed_agent_mailbox",
			claimId: expect.any(String),
			eventCount: 1,
			updatedAgents: [{ taskId: second.taskId, path: second.path }],
		})
		expect(
			(provider as any).agentControlStore
				.getUnacknowledgedMailboxEntries(root.taskId, { rootTaskId: root.rootTaskId })
				.map((entry: any) => [entry.kind, entry.senderTaskId, entry.claimId]),
		).toEqual([
			["lifecycle", first.taskId, undefined],
			["result", first.taskId, undefined],
			["result", second.taskId, waited.claimId],
		])
		await provider.acknowledgeWaitAgentResults(parent as any, waited.claimId)
		const firstWaited = (await provider.waitForAgent(parent as any, 10_000, {
			target: first.path,
			untilTerminal: true,
		})) as any
		expect(firstWaited).toMatchObject({
			timedOut: false,
			source: "managed_agent_mailbox",
			claimId: expect.any(String),
			eventCount: 1,
			updatedAgents: [{ taskId: first.taskId, path: first.path }],
		})
		expect(
			(provider as any).agentControlStore
				.getUnacknowledgedMailboxEntries(root.taskId, { rootTaskId: root.rootTaskId })
				.map((entry: any) => [entry.kind, entry.senderTaskId, entry.claimId]),
		).toEqual([
			["lifecycle", first.taskId, undefined],
			["result", first.taskId, firstWaited.claimId],
		])
		await provider.acknowledgeWaitAgentResults(parent as any, firstWaited.claimId)
		expect(
			(provider as any).agentControlStore.getUnacknowledgedMailboxEntries(root.taskId, {
				rootTaskId: root.rootTaskId,
			}),
		).toEqual([expect.objectContaining({ kind: "lifecycle", senderTaskId: first.taskId })])
	})

	it("waits through the terminal-status publication window until the matching result exists", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const root = await (provider as any).ensureAgentControlRoot(parent)
		const child = await (provider as any).agentControlStore.createAgent({
			taskId: "terminal-publication-race",
			parentTaskId: root.taskId,
			rootTaskId: root.rootTaskId,
			nickname: "Publication race",
			role: "review",
			objective: "Publish a result after status",
			status: "completed",
		})

		const waiting = provider.waitForAgent(parent as any, 10_000, {
			target: child.taskId,
			untilTerminal: true,
		})
		await vi.waitFor(() => expect(parent.beginAgentWait).toHaveBeenCalledOnce())
		await (provider as any).agentControlStore.appendEvent({
			rootTaskId: root.rootTaskId,
			sender: child.taskId,
			recipient: root.taskId,
			kind: "result",
			name: "agent_completed",
			payload: { taskId: child.taskId, status: "completed" },
		})

		await expect(waiting).resolves.toMatchObject({
			timedOut: false,
			eventCount: 1,
			updatedAgents: [{ taskId: child.taskId, path: child.path }],
		})
	})

	it("claims a targeted terminal result committed between the first claim and publication scan", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const root = await (provider as any).ensureAgentControlRoot(parent)
		const child = await (provider as any).agentControlStore.createAgent({
			taskId: "terminal-claim-scan-race",
			parentTaskId: root.taskId,
			rootTaskId: root.rootTaskId,
			nickname: "Claim scan race",
			role: "review",
			objective: "Publish between claim and scan",
			status: "completed",
		})
		await (provider as any).agentControlStore.appendEvent({
			rootTaskId: root.rootTaskId,
			sender: child.taskId,
			recipient: root.taskId,
			kind: "lifecycle",
			name: "agent_started",
			payload: { phase: "running" },
		})
		const store = (provider as any).agentControlStore
		const claimMailbox = store.claimMailbox.bind(store)
		let claimCount = 0
		const claimSpy = vi.spyOn(store, "claimMailbox").mockImplementation(async (...args: any[]) => {
			const claim = await claimMailbox(...args)
			claimCount++
			if (claimCount === 1) {
				await store.appendEvent({
					rootTaskId: root.rootTaskId,
					sender: child.taskId,
					recipient: root.taskId,
					kind: "result",
					name: "agent_completed",
					payload: { taskId: child.taskId, status: "completed" },
				})
			}
			return claim
		})

		const waited = (await provider.waitForAgent(parent as any, 10_000, {
			target: child.taskId,
			untilTerminal: true,
		})) as any

		expect(claimSpy).toHaveBeenCalledTimes(2)
		expect(waited).toMatchObject({
			timedOut: false,
			source: "managed_agent_mailbox",
			claimId: expect.any(String),
			eventCount: 1,
			updatedAgents: [{ taskId: child.taskId, path: child.path }],
		})
		await provider.acknowledgeWaitAgentResults(parent as any, waited.claimId)
		expect(store.getUnacknowledgedMailboxEntries(root.taskId, { rootTaskId: root.rootTaskId })).toEqual([
			expect.objectContaining({ kind: "lifecycle", senderTaskId: child.taskId }),
		])
	})

	it("rejects targeted terminal waits for descendants owned by another immediate parent", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const root = await (provider as any).ensureAgentControlRoot(parent)
		const child = await (provider as any).agentControlStore.createAgent({
			taskId: "target-parent",
			parentTaskId: root.taskId,
			rootTaskId: root.rootTaskId,
			nickname: "Target parent",
			role: "review",
			objective: "Own the nested result",
			status: "running",
		})
		const grandchild = await (provider as any).agentControlStore.createAgent({
			taskId: "target-grandchild",
			parentTaskId: child.taskId,
			rootTaskId: root.rootTaskId,
			nickname: "Target grandchild",
			role: "review",
			objective: "Finish below the caller",
			status: "running",
		})

		await expect(
			provider.waitForAgent(parent as any, 10_000, {
				target: grandchild.path,
				untilTerminal: true,
			}),
		).rejects.toThrow("not an immediate child")
	})

	it("persists root completion, interruption, and resumption transitions", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		await (provider as any).ensureAgentControlRoot(parent)

		await (provider as any).updateAgentControlRootStatus(parent.taskId, "completed")
		expect((provider as any).agentControlStore.getAgent(parent.taskId, parent.taskId)?.status).toBe("completed")

		await (provider as any).updateAgentControlRootStatus(parent.taskId, "running")
		expect((provider as any).agentControlStore.getAgent(parent.taskId, parent.taskId)?.status).toBe("running")

		await (provider as any).updateAgentControlRootStatus(parent.taskId, "interrupted")
		await (provider as any).agentControlStore.updateAgentSnapshot(
			parent.taskId,
			{ stopReason: "interrupted" },
			parent.taskId,
		)
		expect((provider as any).agentControlStore.getAgent(parent.taskId, parent.taskId)).toMatchObject({
			status: "interrupted",
			snapshot: { stopReason: "interrupted" },
		})

		await (provider as any).updateAgentControlRootStatus(parent.taskId, "completed")
		expect((provider as any).agentControlStore.getAgent(parent.taskId, parent.taskId)).toMatchObject({
			status: "completed",
		})
		expect(
			(provider as any).agentControlStore.getAgent(parent.taskId, parent.taskId)?.snapshot?.stopReason,
		).toBeUndefined()
	})

	it("persists a terminal root before publishing task completion", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		await (provider as any).ensureAgentControlRoot(parent)
		const publicationOrder: string[] = []
		;(provider as any).markTaskLifecycle = vi.fn(() => {
			expect((provider as any).agentControlStore.getAgent(parent.taskId, parent.taskId)?.status).toBe("completed")
			publicationOrder.push("lifecycle")
		})
		;(provider as any).emit = vi.fn((event: AlphaCodeEventName) => {
			if (event === AlphaCodeEventName.TaskCompleted) {
				expect((provider as any).agentControlStore.getAgent(parent.taskId, parent.taskId)?.status).toBe(
					"completed",
				)
				publicationOrder.push("event")
			}
			return true
		})

		await (provider as any).completeTaskLifecycle(parent.taskId, { totalTokensIn: 1 }, {})

		expect(publicationOrder).toEqual(["lifecycle", "event"])
	})

	it("keeps a completion-result candidate waiting without publishing terminal state", async () => {
		const provider = makeProviderHarness()
		const parent = { ...makeParent(), taskAsk: { ask: "completion_result" } }
		await (provider as any).ensureAgentControlRoot(parent)
		const initialRootStatus = (provider as any).agentControlStore.getAgent(parent.taskId, parent.taskId)?.status
		const publicationOrder: string[] = []
		;(provider as any).markTaskLifecycle = vi.fn(
			(_taskId: string, lifecycle: TaskLifecycleState, waitingReason?: string) => {
				expect(lifecycle).toBe(TaskLifecycleState.Waiting)
				expect(waitingReason).toBe("completion")
				expect((provider as any).agentControlStore.getAgent(parent.taskId, parent.taskId)?.status).toBe(
					initialRootStatus,
				)
				publicationOrder.push("lifecycle")
			},
		)
		;(provider as any).emit = vi.fn((event: AlphaCodeEventName) => {
			expect(event).not.toBe(AlphaCodeEventName.TaskCompleted)
			if (event === AlphaCodeEventName.TaskIdle) publicationOrder.push("event")
			return true
		})

		await (provider as any).completeIdleTaskLifecycle(parent, parent.taskId)

		expect((provider as any).agentControlStore.getAgent(parent.taskId, parent.taskId)?.status).toBe(
			initialRootStatus,
		)
		expect(publicationOrder).toEqual(["lifecycle", "event"])
	})

	it("serializes overlapping root lifecycle transitions in publication order", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		await (provider as any).ensureAgentControlRoot(parent)

		const completed = (provider as any).updateAgentControlRootStatus(parent.taskId, "completed")
		const resumed = (provider as any).updateAgentControlRootStatus(parent.taskId, "running")
		await Promise.all([completed, resumed])

		expect((provider as any).agentControlStore.getAgent(parent.taskId, parent.taskId)?.status).toBe("running")
	})

	it("reconciles a prepared but never-launched nested group owned by an active task", async () => {
		const globalStoragePath = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-prelaunch-recovery-"))
		try {
			const provider = makeProviderHarness()
			const histories = new Map<string, any>([
				[
					"recovery-root",
					{
						id: "recovery-root",
						number: 1,
						ts: 1,
						task: "Recovery root",
						status: "active",
						tokensIn: 0,
						tokensOut: 0,
						totalCost: 0,
					},
				],
				[
					"approval-parent",
					{
						id: "approval-parent",
						rootTaskId: "recovery-root",
						parentTaskId: "recovery-root",
						taskKind: "subagent",
						number: 2,
						ts: 2,
						task: "Approval parent",
						status: "active",
						tokensIn: 0,
						tokensOut: 0,
						totalCost: 0,
					},
				],
			])
			;(provider as any).context = { globalStorageUri: { fsPath: globalStoragePath } }
			;(provider as any).taskHistoryStore = {
				get: (taskId: string) => histories.get(taskId),
				getAll: () => [...histories.values()],
				upsert: vi.fn(async (item: any) => {
					histories.set(item.id, item)
				}),
			}

			const group: SubagentGroupState = {
				groupId: "pending-nested-group",
				parentTaskId: "approval-parent",
				status: "pending",
				createdAt: 3,
				agents: [
					{
						taskId: "approval-child",
						nickname: "approval_child",
						role: "review",
						objective: "Wait for explicit launch approval",
						status: "pending",
						phase: "queued",
						phaseStartedAt: 3,
						usage: { durationMs: 0 },
					},
				],
			}
			await saveTaskMessages({
				taskId: "approval-parent",
				globalStoragePath,
				messages: [{ ts: 3, type: "say", say: "subagent_group", subagentGroup: group }],
			})

			await (provider as any).reconcileInterruptedSubagentState()

			const messages = await readTaskMessages({ taskId: "approval-parent", globalStoragePath })
			const recovered = messages[0]?.subagentGroup
			expect(recovered?.status).toBe("cancelled")
			expect(recovered?.agents[0]).toMatchObject({
				status: "cancelled",
				stopReason: "never_launched",
				error: expect.stringContaining("never launched"),
			})
			expect(recovered?.agents[0].error).not.toContain("resume")
			expect(histories.get("approval-parent")?.status).toBe("interrupted")
		} finally {
			await fs.rm(globalStoragePath, { recursive: true, force: true })
		}
	})

	it("releases a reload-preserved native wait claim without a receipt and redelivers the same event once", async () => {
		const persistence = new InMemoryAgentControlPersistence()
		const beforeReload = new AgentControlStore(persistence)
		await beforeReload.initialize()
		await beforeReload.ensureRoot({ taskId: "parent-1", status: "running" })
		await beforeReload.createAgent({
			taskId: "reload-child-unpersisted",
			parentTaskId: "parent-1",
			groupId: "reload-group-unpersisted",
			nickname: "Reload child unpersisted",
			role: "review",
			objective: "Retain an unpersisted wait claim",
			status: "completed",
		})
		await beforeReload.appendEvent({
			eventId: "reload-result-unpersisted",
			sender: "reload-child-unpersisted",
			recipient: "parent-1",
			kind: "result",
			name: "agent_completed",
			payload: { taskId: "reload-child-unpersisted", status: "completed", summary: "Recovered." },
		})
		const abandoned = await beforeReload.claimMailbox("parent-1", { channel: "wait", kinds: ["result"] })
		await beforeReload.updateAgentStatus("parent-1", "interrupted")

		const afterReload = new AgentControlStore(persistence)
		await afterReload.initialize()
		const provider = makeProviderHarness()
		;(provider as any).agentControlStore = afterReload
		;(provider as any).agentControlStoreReady = Promise.resolve()

		const waited = (await provider.waitForAgent(makeParent() as any, 10_000)) as any
		expect(waited).toMatchObject({
			timedOut: false,
			source: "managed_agent_mailbox",
			claimId: expect.any(String),
			eventCount: 1,
		})
		expect(waited.claimId).not.toBe(abandoned.claimId)
		expect(afterReload.getUnacknowledgedMailboxEntries("parent-1", { kinds: ["result"] })).toEqual([
			expect.objectContaining({ eventId: "reload-result-unpersisted", claimId: waited.claimId }),
		])
	})

	it.each(["canonical", "legacy", "empty-canonical", "matching"] as const)(
		"ACKs a reload-preserved native wait claim with %s IDs without redelivery",
		async (alias) => {
			const persistence = new InMemoryAgentControlPersistence()
			const beforeReload = new AgentControlStore(persistence)
			await beforeReload.initialize()
			await beforeReload.ensureRoot({ taskId: "parent-1", status: "interrupted" })
			await beforeReload.appendEvent({
				eventId: "reload-result-persisted",
				recipient: "parent-1",
				kind: "result",
				name: "agent_failed",
				payload: { taskId: "reload-child-persisted", status: "failed", stopReason: "runtime_error" },
			})
			const claimed = await beforeReload.claimMailbox("parent-1", { channel: "wait", kinds: ["result"] })

			const afterReload = new AgentControlStore(persistence)
			await afterReload.initialize()
			const provider = makeProviderHarness()
			;(provider as any).agentControlStore = afterReload
			;(provider as any).agentControlStoreReady = Promise.resolve()
			const parent = makeParent()
			const callId = "call.reload.receipt"
			const resultId = "call_reload_receipt"
			const call =
				alias === "canonical"
					? { type: "tool_use", id: callId, name: "wait_agent", input: {} }
					: {
							type: "tool_call",
							id: alias === "legacy" ? undefined : alias === "empty-canonical" ? "" : callId,
							tool_call_id: callId,
							name: "wait_agent",
							input: {},
						}
			parent.apiConversationHistory = [
				{
					role: "assistant",
					content: [call],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							...(alias === "canonical"
								? { tool_use_id: resultId }
								: {
										tool_use_id:
											alias === "legacy"
												? undefined
												: alias === "empty-canonical"
													? ""
													: resultId,
										tool_call_id: resultId,
									}),
							content: JSON.stringify({
								timedOut: false,
								source: "managed_agent_mailbox",
								claimId: claimed.claimId,
								eventCount: claimed.entries.length,
							}),
						},
						{
							type: "text",
							text: serializeAgentNotification(claimed.entries[0]),
						},
					],
				},
			] as any

			await expect(provider.waitForAgent(parent as any, 10_000)).resolves.toEqual({
				timedOut: false,
				events: [],
				alreadyDelivered: true,
			})
			expect(parent.forgetWaitAgentResultClaim).toHaveBeenCalledWith(claimed.claimId)
			expect(afterReload.getUnacknowledgedMailboxEntries("parent-1", { kinds: ["result"] })).toEqual([])
			await expect(provider.waitForAgent(parent as any, 10_000)).resolves.toEqual({
				timedOut: false,
				noActiveAgents: true,
				events: [],
			})
		},
	)

	it("redelivers a reload-preserved claim when its wait receipt lacks child notifications", async () => {
		const persistence = new InMemoryAgentControlPersistence()
		const beforeReload = new AgentControlStore(persistence)
		await beforeReload.initialize()
		await beforeReload.ensureRoot({ taskId: "parent-1", status: "interrupted" })
		await beforeReload.appendEvent({
			eventId: "reload-missing-notification",
			recipient: "parent-1",
			kind: "result",
			name: "agent_completed",
			payload: { taskId: "child", status: "completed" },
		})
		const abandoned = await beforeReload.claimMailbox("parent-1", { channel: "wait", kinds: ["result"] })
		const reloaded = new AgentControlStore(persistence)
		await reloaded.initialize()
		const provider = makeProviderHarness()
		;(provider as any).agentControlStore = reloaded
		;(provider as any).agentControlStoreReady = Promise.resolve()
		const parent = makeParent()
		parent.apiConversationHistory = [
			{ role: "assistant", content: [{ type: "tool_use", id: "call-missing", name: "wait_agent", input: {} }] },
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "call-missing",
						content: JSON.stringify({
							source: "managed_agent_mailbox",
							claimId: abandoned.claimId,
							eventCount: 1,
						}),
					},
				],
			},
		] as any

		const waited = (await provider.waitForAgent(parent as any, 10_000)) as any
		expect(waited).toMatchObject({ eventCount: 1, claimId: expect.any(String) })
		expect(waited.claimId).not.toBe(abandoned.claimId)
		expect(parent.stageWaitAgentNotifications).toHaveBeenCalledWith(waited.claimId, [
			expect.objectContaining({ eventId: "reload-missing-notification" }),
		])
	})

	it("recovers a legacy orchestration omission without reviving execution limits", async () => {
		const provider = makeProviderHarness(2, {
			maxConcurrentSubagents: 8,
			subagentDelegationPolicy: "proactive",
			subagentMaxDepth: 5,
			subagentRoleTimeoutsMs: { explore: 600_000 },
			subagentMaxInputTokens: 64_000,
			subagentMaxOutputTokens: 12_000,
		})
		const parent = makeParent()
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect legacy recovery", agent_kind: "explore", fork_turns: "none" },
		])
		const taskId = prepared.envelopes[0].id
		const { manifest: legacyManifest } = captureSubagentContext({
			parentTaskId: parent.taskId,
			capturedAt: 1,
			forkTurns: "none",
			history: [],
			instructions: await parent.captureEffectiveInheritedInstructions(),
			skills: [],
			cwd: parent.cwd,
			workspaceRoots: [parent.cwd],
			modelRoute: {
				source: "parent",
				resolution: "selected",
				profileName: "Parent",
				provider: "openai",
				modelId: "alpha-model",
			},
			runtimePolicy: {
				role: "explore",
				read: true,
				execute: false,
				mutate: false,
				delegate: false,
				network: false,
				externalSideEffects: false,
				requireApproval: false,
				allowedTools: ["read_file", "attempt_completion"],
				workspaceRoots: [parent.cwd],
			},
		})
		expect(legacyManifest.orchestration).toBeUndefined()
		;(provider as any).__historyItems.set(taskId, {
			id: taskId,
			number: 2,
			ts: 2,
			task: "Inspect legacy recovery",
			apiConfigName: "Parent",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			subagentContextManifest: legacyManifest,
		})
		const group = structuredClone(prepared.group)
		group.executionMode = "async"
		group.status = "interrupted"
		group.agents[0].status = "interrupted"
		parent.alphaMessages = [{ subagentGroup: group }] as any

		const root = await (provider as any).ensureAgentControlRoot(parent)
		const retained = await (provider as any).agentControlStore.createAgent({
			taskId,
			parentTaskId: root.taskId,
			rootTaskId: root.rootTaskId,
			groupId: group.groupId,
			nickname: group.agents[0].nickname,
			role: group.agents[0].role,
			objective: group.agents[0].objective,
			status: "interrupted",
			snapshot: { contextManifest: legacyManifest },
		})
		;(provider as any).preparedSubagentGroups.clear()
		;(provider as any).subagentDescriptors.clear()
		;(provider as any).reservedSubagentSlots.clear()

		const restored = await (provider as any).restorePreparedSubagentForFollowup(
			parent,
			retained,
			"Verify legacy defaults",
		)
		const migratedManifest = (provider as any).subagentDescriptors.get(taskId).contextManifest

		expect(finalizedSubagentContextManifestSchema.safeParse(migratedManifest).success).toBe(true)
		expect(migratedManifest.orchestration).toMatchObject({
			ancestry: {
				rootTaskId: parent.taskId,
				parentTaskId: parent.taskId,
				depth: 1,
				maxDepth: null,
			},
			delegationPolicy: {
				policy: "explicit-only",
				source: "default",
				authorization: "group-approval",
				explicitUserRequest: true,
			},
			limits: {
				maxConcurrentTasks: 3,
				maxConcurrentSubagents: 3,
				maxInputTokens: null,
				maxOutputTokens: null,
				timeoutMs: null,
			},
		})
		expect(restored.envelopes[0].budget).toMatchObject({
			maxDepth: null,
			maxConcurrency: 3,
			maxInputTokens: null,
			maxOutputTokens: null,
			timeoutMs: null,
		})
		expect((provider as any).__historyItems.get(taskId).subagentContextManifest).toEqual(migratedManifest)
		expect(
			(provider as any).agentControlStore.getAgent(taskId, root.rootTaskId)?.snapshot?.contextManifest,
		).toEqual(migratedManifest)
	})

	it("rehydrates a child with its frozen delegation policy without reviving role timeouts", async () => {
		const routingSettings: Parameters<typeof makeProviderHarness>[1] = {
			approvalMode: "auto",
			subagentDelegationPolicy: "proactive",
			subagentRoleTimeoutsMs: { explore: 180_000 },
			autoApprovalEnabled: true,
			alwaysAllowSubagents: true,
			alwaysAllowReadOnly: true,
			alwaysAllowExecute: true,
			allowedCommands: ["git diff"],
			deniedCommands: ["git push"],
		}
		const provider = makeProviderHarness(2, routingSettings)
		const parent = makeParent()
		parent.apiConversationHistory = [{ role: "user", content: "ORIGINAL_FROZEN_PARENT_TURN" }]
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect recovery", agent_kind: "explore", fork_turns: "all" },
		])
		;(provider as any).finalizePreparedSubagentAuthorization(prepared)
		const capturedManifest = structuredClone(
			(provider as any).subagentDescriptors.get(prepared.envelopes[0].id).contextManifest,
		)
		expect(capturedManifest.selectedUserTurns).toMatchObject({ count: 1, refs: [expect.any(Object)] })
		expect(capturedManifest.orchestration).toMatchObject({
			delegationPolicy: { policy: "explicit-only" },
			limits: { timeoutMs: null },
		})
		expect(capturedManifest.runtimePolicy.autoApproval).toMatchObject({
			autoApprovalEnabled: true,
			alwaysAllowReadOnly: true,
			alwaysAllowExecute: true,
			alwaysAllowSubagents: true,
			commandApproval: {
				allowAll: true,
				denyAll: false,
				allowed: [expect.objectContaining({ tokenCount: 2 })],
				denied: [expect.objectContaining({ tokenCount: 2 })],
			},
		})
		;(provider as any).__historyItems.set(prepared.envelopes[0].id, {
			id: prepared.envelopes[0].id,
			number: 2,
			ts: 2,
			task: "Inspect recovery",
			apiConfigName: "Parent",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			subagentContextManifest: capturedManifest,
		})
		const group = structuredClone(prepared.group)
		group.executionMode = "async"
		group.status = "interrupted"
		group.agents[0].status = "interrupted"
		parent.alphaMessages = [{ subagentGroup: group }] as any

		const root = await (provider as any).ensureAgentControlRoot(parent)
		const retained = await (provider as any).agentControlStore.createAgent({
			taskId: prepared.envelopes[0].id,
			parentTaskId: root.taskId,
			rootTaskId: root.rootTaskId,
			groupId: group.groupId,
			nickname: group.agents[0].nickname,
			role: group.agents[0].role,
			objective: group.agents[0].objective,
			status: "interrupted",
			snapshot: { contextManifest: capturedManifest },
		})
		;(provider as any).preparedSubagentGroups.clear()
		;(provider as any).subagentDescriptors.clear()
		;(provider as any).reservedSubagentSlots.clear()
		routingSettings.subagentDelegationPolicy = "explicit-only"
		routingSettings.subagentRoleTimeoutsMs = { explore: 600_000 }
		routingSettings.autoApprovalEnabled = false
		routingSettings.alwaysAllowSubagents = false
		routingSettings.alwaysAllowExecute = false
		routingSettings.allowedCommands = ["*"]
		routingSettings.deniedCommands = []
		parent.apiConversationHistory = [{ role: "user", content: "NEW_PARENT_TURN_MUST_NOT_BE_CAPTURED" }]
		parent.captureEffectiveInheritedInstructions.mockClear()
		const startPreparedSubagentRun = vi.fn(
			async (_parent: any, restored: any, _signal: AbortSignal, record: any) => ({
				taskId: record.taskId,
				runId: `${record.taskId}:reloaded`,
				groupId: restored.group.groupId,
				parentTaskId: parent.taskId,
				path: record.path,
				nickname: record.nickname,
				role: record.role,
				status: "pending",
				createdAt: Date.now(),
			}),
		)
		;(provider as any).startPreparedSubagentRun = startPreparedSubagentRun
		await expect(provider.requiresExplicitAgentFollowupApproval(parent as any, retained.path)).resolves.toBe(false)

		const result = (await provider.followupAgentTask(
			parent as any,
			retained.path,
			"Inspect the restored edge case",
		)) as any

		expect(result).toMatchObject({ taskId: retained.taskId, path: retained.path, followup: true })
		expect(startPreparedSubagentRun).toHaveBeenCalledWith(
			parent,
			expect.objectContaining({
				group: expect.objectContaining({
					groupId: retained.groupId,
					status: "pending",
					agents: [expect.objectContaining({ taskId: retained.taskId, status: "pending" })],
				}),
			}),
			expect.any(AbortSignal),
			expect.objectContaining({ taskId: retained.taskId, status: "pending" }),
			false,
		)
		expect((provider as any).subagentDescriptors.get(retained.taskId)?.pendingFollowup).toBe(
			"Inspect the restored edge case",
		)
		expect((provider as any).subagentDescriptors.get(retained.taskId)?.contextManifest).toEqual(capturedManifest)
		expect(
			(provider as any).subagentDescriptors.get(retained.taskId)?.contextManifest.runtimePolicy.autoApproval,
		).toEqual(capturedManifest.runtimePolicy.autoApproval)
		const restored = startPreparedSubagentRun.mock.calls[0][1]
		expect(restored.envelopes[0].budget.timeoutMs).toBeNull()
		expect(restored.envelopes[0].budget.timeoutMs).not.toBe(routingSettings.subagentRoleTimeoutsMs.explore)
		expect(restored.envelopes[0].scope.contextRefs).toEqual(capturedManifest.contextRefs)
		expect(restored.envelopes[0].skills).toEqual(
			capturedManifest.skills.map((skill: any) => ({ id: skill.name, digest: skill.digest })),
		)
		expect(parent.captureEffectiveInheritedInstructions).not.toHaveBeenCalled()
	})

	it("queues a follow-up for a running child without starting an overlapping run", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const root = await (provider as any).ensureAgentControlRoot(parent)
		const child = await (provider as any).agentControlStore.createAgent({
			taskId: "running-followup-child",
			parentTaskId: root.taskId,
			rootTaskId: root.rootTaskId,
			nickname: "Review",
			role: "review",
			objective: "Review while running",
			status: "running",
		})
		;(provider as any).subagentDescriptors.set(child.taskId, {})
		const start = vi.spyOn(provider as any, "startPreparedSubagentRun")

		await expect(
			provider.followupAgentTask(parent as any, child.path, "Check the second case"),
		).resolves.toMatchObject({
			taskId: child.taskId,
			followup: true,
			delivery: "buffered",
		})
		expect(start).not.toHaveBeenCalled()
		expect(
			(provider as any).agentControlStore.getUnacknowledgedMailboxEntries(child.taskId, {
				rootTaskId: parent.taskId,
				kinds: ["message"],
			}),
		).toEqual([expect.objectContaining({ payload: { message: "Check the second case" } })])
		expect(
			(provider as any).agentControlStore.getUnacknowledgedMailboxEntries(child.taskId, {
				rootTaskId: root.rootTaskId,
			}),
		).toEqual([
			expect.objectContaining({
				senderTaskId: root.taskId,
				name: "parent_message",
				payload: { message: "Check the second case" },
			}),
		])
	})

	it("rejects a follow-up when the original child never created a retained task", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const root = await (provider as any).ensureAgentControlRoot(parent)
		const child = await (provider as any).agentControlStore.createAgent({
			taskId: "never-launched-followup-child",
			parentTaskId: root.taskId,
			rootTaskId: root.rootTaskId,
			groupId: "never-launched-group",
			nickname: "Missing child",
			role: "review",
			objective: "Exercise failed startup",
			status: "failed",
			snapshot: { stopReason: "never_launched" },
		})

		await expect(provider.requiresExplicitAgentFollowupApproval(parent as any, child.path)).rejects.toThrow(
			"never launched and has no retained task",
		)
		await expect(provider.followupAgentTask(parent as any, child.path, "Try the review again")).rejects.toThrow(
			"Start a new spawn_agent request",
		)
	})

	it("buffers a live running follow-up through the child's next input boundary", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const root = await (provider as any).ensureAgentControlRoot(parent)
		const child = await (provider as any).agentControlStore.createAgent({
			taskId: "live-followup-child",
			parentTaskId: root.taskId,
			rootTaskId: root.rootTaskId,
			nickname: "Live review",
			role: "review",
			objective: "Review while running",
			status: "running",
		})
		const steerUserMessage = vi.fn(async () => undefined)
		;(provider as any).taskSessions.getTask = (taskId: string) =>
			taskId === child.taskId
				? {
						canAcceptSteerMessage: () => true,
						admitAgentMessage: async (persist: () => Promise<unknown>) => persist(),
						steerUserMessage,
					}
				: undefined
		const start = vi.spyOn(provider as any, "startPreparedSubagentRun")

		await expect(
			provider.followupAgentTask(parent as any, child.path, "Check the live case"),
		).resolves.toMatchObject({
			taskId: child.taskId,
			followup: true,
			delivery: "buffered",
		})
		expect(steerUserMessage).not.toHaveBeenCalled()
		expect(start).not.toHaveBeenCalled()
	})

	it("permits a restored follow-up despite a historical root-budget stop reason", async () => {
		const routingSettings = { subagentRootCostBudget: 1 as number | null }
		const provider = makeProviderHarness(2, routingSettings)
		const parent = makeParent()
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect root budget recovery", agent_kind: "review", fork_turns: "none" },
		])
		;(provider as any).finalizePreparedSubagentAuthorization(prepared)
		const taskId = prepared.envelopes[0].id
		const capturedManifest = structuredClone((provider as any).subagentDescriptors.get(taskId).contextManifest)
		;(provider as any).__historyItems.set(taskId, {
			id: taskId,
			number: 2,
			ts: 2,
			task: "Inspect root budget recovery",
			apiConfigName: "Parent",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 1,
			subagentContextManifest: capturedManifest,
		})
		const group = structuredClone(prepared.group)
		group.executionMode = "async"
		group.status = "completed"
		group.agents[0].status = "completed"
		parent.alphaMessages = [{ subagentGroup: group }] as any

		const root = await (provider as any).ensureAgentControlRoot(parent)
		const retained = await (provider as any).agentControlStore.createAgent({
			taskId,
			parentTaskId: root.taskId,
			rootTaskId: root.rootTaskId,
			groupId: group.groupId,
			nickname: group.agents[0].nickname,
			role: group.agents[0].role,
			objective: group.agents[0].objective,
			status: "completed",
			snapshot: { contextManifest: capturedManifest },
		})
		const exhaustedSibling = await (provider as any).agentControlStore.createAgent({
			taskId: "root-budget-sentinel",
			parentTaskId: root.taskId,
			rootTaskId: root.rootTaskId,
			nickname: "Budget Sentinel",
			role: "explore",
			objective: "Retain the root-wide terminal cause",
			status: "failed",
			snapshot: { stopReason: "root_cost_budget" },
		})
		await (provider as any).agentControlStore.updateAgentStatus(
			exhaustedSibling.taskId,
			"failed",
			{
				terminalResult: {
					status: "failed",
					error: "Root cost budget exhausted",
					completedAt: 2,
					stopReason: "root_cost_budget",
				},
			},
			root.rootTaskId,
		)
		;(provider as any).preparedSubagentGroups.clear()
		;(provider as any).subagentDescriptors.clear()
		;(provider as any).reservedSubagentSlots.clear()
		;(provider as any).exhaustedSubagentRootBudgets.clear()
		routingSettings.subagentRootCostBudget = null

		const restored = await (provider as any).restorePreparedSubagentForFollowup(
			parent,
			retained,
			"Try after reload",
		)
		expect(() =>
			(provider as any).assertRetainedAgentRelaunchCapacity(retained, restored, capturedManifest),
		).not.toThrow()
	})

	it("rejects a tampered retained context manifest instead of recapturing on follow-up", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect recovery", agent_kind: "review", fork_turns: "none" },
		])
		const group = structuredClone(prepared.group)
		group.executionMode = "async"
		group.status = "interrupted"
		group.agents[0].status = "interrupted"
		parent.alphaMessages = [{ subagentGroup: group }] as any
		const tamperedManifest = structuredClone(
			(provider as any).subagentDescriptors.get(prepared.envelopes[0].id).contextManifest,
		)
		tamperedManifest.manifestDigest = "b".repeat(64)
		;(provider as any).__historyItems.set(prepared.envelopes[0].id, {
			id: prepared.envelopes[0].id,
			number: 2,
			ts: 2,
			task: "Inspect recovery",
			apiConfigName: "Parent",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			subagentContextManifest: tamperedManifest,
		})
		const root = await (provider as any).ensureAgentControlRoot(parent)
		const retained = await (provider as any).agentControlStore.createAgent({
			taskId: prepared.envelopes[0].id,
			parentTaskId: root.taskId,
			rootTaskId: root.rootTaskId,
			groupId: group.groupId,
			nickname: group.agents[0].nickname,
			role: group.agents[0].role,
			objective: group.agents[0].objective,
			status: "interrupted",
		})
		;(provider as any).preparedSubagentGroups.clear()
		;(provider as any).subagentDescriptors.clear()

		await expect(
			(provider as any).restorePreparedSubagentForFollowup(parent, retained, "Inspect again"),
		).rejects.toThrow("retained an invalid context manifest")
		expect(parent.captureEffectiveInheritedInstructions).toHaveBeenCalledOnce()
	})

	it("publishes each child terminal result once before the aggregate terminal update", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		;(provider as any).taskSessions.getTask = (taskId: string) => (taskId === parent.taskId ? parent : undefined)
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect the parser", agent_kind: "explore" },
		])
		const updates: SubagentGroupState[] = []
		parent.upsertSubagentGroup = vi.fn(async (group: SubagentGroupState) => {
			updates.push(structuredClone(group))
		})
		;(provider as any).createTask = vi.fn(
			async (_text: string, _images: unknown, _parent: unknown, options: any) => {
				const emitter = new EventEmitter()
				return Object.assign(emitter, {
					taskId: options.taskId,
					alphaMessages: [{ type: "say", say: "completion_result", text: "Parser inspected" }],
					getTokenUsage: () => ({ totalTokensIn: 10, totalTokensOut: 5 }),
					persistFrozenSubagentInstructions: vi.fn(async () => undefined),
					finalizeSubagentHistory: vi.fn(async () => undefined),
					cancelCurrentRequest: vi.fn(),
					abortTask: vi.fn(async () => undefined),
					start() {
						emitter.emit(AlphaCodeEventName.TaskCompleted, options.taskId, {
							totalTokensIn: 10,
							totalTokensOut: 5,
						})
					},
				})
			},
		)
		;(provider as any).boundedDelegationManager = new BoundedDelegationManager(
			(envelope, signal) => (provider as any).runSubagentEnvelope(envelope, signal),
			2,
		)

		const result = await provider.runSubagentGroup(parent as any, prepared, new AbortController().signal)

		expect(result.status).toBe("completed")
		expect(updates.at(-1)?.executionMode).toBe("blocking")
		expect(
			updates.filter((update) => update.status === "running" && update.agents[0]?.status === "completed"),
		).toHaveLength(1)
		expect(updates.at(-1)?.status).toBe("completed")
	})

	describe("blocking child lifecycle compatibility", () => {
		const setupCompletedBatch = async (retainRuntime = false) => {
			const provider = makeProviderHarness(3)
			const parent = makeParent()
			const sessions = Reflect.get(provider, "taskSessions") as TaskSessionRegistry
			sessions.register(parent as unknown as Task, { focus: false })
			sessions.markLifecycle(parent.taskId, TaskLifecycleState.Running)
			parent.upsertSubagentGroup = vi.fn(async (group: SubagentGroupState) => {
				const existing = parent.alphaMessages.find(
					(message) => message.subagentGroup?.groupId === group.groupId,
				)
				if (existing) existing.subagentGroup = structuredClone(group)
				else parent.alphaMessages.push({ subagentGroup: structuredClone(group) })
			})
			const result = (taskId: string, summary: string) => ({
				taskId,
				status: "completed" as const,
				summary,
				evidence: [],
				changedFiles: [],
				verification: [],
				remainingRisks: [],
				usage: { durationMs: 1 },
			})
			const retainedTasks = new Map<string, { task: Task; lifetimeSignal: AbortSignal }>()
			const bounded = new BoundedDelegationManager(async (envelope) => {
				if (retainRuntime) {
					// Registry component fixture: model terminal ownership without a Task loop or disposal.
					const lifetimeSignal = new AbortController().signal
					const child = {
						taskId: envelope.id,
						taskKind: "subagent",
						taskStatus: TaskStatus.Idle,
						subagentGroupId: prepared.group.groupId,
						rootTaskId: parent.taskId,
						parentTask: parent,
						alphaMessages: [],
						isStreaming: false,
						isCompleted: () => true,
						getTaskCancellationSignal: () => lifetimeSignal,
						getTaskLifetimeCancellationSignal: () => lifetimeSignal,
					} as unknown as Task
					sessions.register(child, { focus: false })
					sessions.markLifecycle(child.taskId, TaskLifecycleState.Completed)
					retainedTasks.set(child.taskId, { task: child, lifetimeSignal })
				}
				return result(envelope.id, "Original report")
			})
			;(provider as any).boundedDelegationManager = bounded
			;(provider as any).asyncSubagentRunManager = new AsyncSubagentRunManager(bounded)
			const prepared = await provider.prepareSubagentGroup(parent as any, [
				{ objective: "Inspect the first boundary", agent_kind: "review" },
				{ objective: "Inspect the second boundary", agent_kind: "review" },
			])
			const descriptors = new Map(
				prepared.envelopes.map((envelope) => [
					envelope.id,
					(provider as any).subagentDescriptors.get(envelope.id),
				]),
			)
			const frozenManifests = new Map(
				[...descriptors].map(([taskId, descriptor]) => {
					const manifest = structuredClone(descriptor.contextManifest)
					expect(finalizedSubagentContextManifestSchema.safeParse(manifest).success).toBe(true)
					return [taskId, manifest] as const
				}),
			)
			expect((provider as any).preparedSubagentGroups.get(prepared.group.groupId)).toBe(prepared)
			for (const [taskId, descriptor] of descriptors) {
				expect((provider as any).subagentDescriptors.get(taskId)).toBe(descriptor)
			}
			const completion = provider.runSubagentGroup(parent as any, prepared, new AbortController().signal)
			const finalization = ownedFinalization(
				(provider as any).subagentRunFinalizations.get(prepared.envelopes[0].id),
			)
			expect(finalization).toBeDefined()
			await completion
			await finalization
			await (provider as any).pruneRetainedSubagentRuntimes()
			const store = Reflect.get(provider, "agentControlStore") as AgentControlStore
			const expectCompletedBatchState = () => {
				// Blocking completion releases preparation caches independently of resident child ownership.
				expect((provider as any).preparedSubagentGroups.get(prepared.group.groupId)).toBeUndefined()
				expect((provider as any).preparedSubagentGroups.size).toBe(0)
				expect((provider as any).subagentDescriptors.size).toBe(0)
				expect(sessions.getTerminalSubagentTasks()).toHaveLength(retainRuntime ? prepared.envelopes.length : 0)
				for (const { id } of prepared.envelopes) {
					const retained = retainedTasks.get(id)
					expect(provider.getLiveTask(id)).toBe(retained?.task)
					expect(sessions.ownsTask(id)).toBe(retainRuntime)
					expect((provider as any).subagentDescriptors.get(id)).toBeUndefined()
					if (retained) {
						expect(retained.task.subagentGroupId).toBe(prepared.group.groupId)
						expect(retained.task.parentTask).toBe(parent)
						expect(retained.task.taskStatus).toBe(TaskStatus.Idle)
						expect(retained.task.isStreaming).toBe(false)
						expect(retained.task.isCompleted()).toBe(true)
						expect(retained.task.getTaskCancellationSignal()).toBe(retained.lifetimeSignal)
						expect(retained.task.getTaskLifetimeCancellationSignal()).toBe(retained.lifetimeSignal)
						expect(retained.lifetimeSignal.aborted).toBe(false)
					}
					expect(store.getAgent(id, parent.taskId)?.snapshot?.contextManifest).toEqual(
						frozenManifests.get(id),
					)
				}
			}
			expectCompletedBatchState()
			return { provider, parent, prepared, result, expectCompletedBatchState }
		}

		it.each(["persisted", "retained"] as const)(
			"resumes %s siblings concurrently without replacing the original batch",
			async (source) => {
				const { provider, parent, prepared, result } = await setupCompletedBatch(source === "retained")
				const originalGroup = structuredClone(parent.alphaMessages[0].subagentGroup)
				const store = (provider as any).agentControlStore as AgentControlStore
				const manifests = prepared.envelopes.map(
					(envelope) => store.getAgent(envelope.id, parent.taskId)!.snapshot!.contextManifest,
				)
				const pending = new Map<string, (value: ReturnType<typeof result>) => void>()
				let entered!: () => void
				const bothRunning = new Promise<void>((resolve) => (entered = resolve))
				const bounded = new BoundedDelegationManager(
					async (envelope, signal) =>
						await new Promise<ReturnType<typeof result>>((resolve, reject) => {
							pending.set(envelope.id, resolve)
							signal.addEventListener("abort", () => reject(signal.reason), { once: true })
							if (pending.size === 2) entered()
						}),
				)
				const runs = new AsyncSubagentRunManager(bounded)
				;(provider as any).boundedDelegationManager = bounded
				;(provider as any).asyncSubagentRunManager = runs
				const handles = await Promise.all(
					prepared.envelopes.map(
						(envelope) =>
							provider.followupAgentTask(
								parent as any,
								envelope.id,
								"Inspect a continuation",
							) as Promise<any>,
					),
				)
				try {
					await bothRunning
					expect(new Set(handles.map((handle) => handle.groupId)).size).toBe(2)
					expect(handles.every((handle) => handle.groupId !== prepared.group.groupId)).toBe(true)
					for (const [index, handle] of handles.entries()) {
						expect(store.getAgent(handle.taskId, parent.taskId)?.groupId).toBe(handle.groupId)
						expect((provider as any).subagentDescriptors.get(handle.taskId).contextManifest).toEqual(
							manifests[index],
						)
					}
					expect(
						parent.alphaMessages.find(
							(message) => message.subagentGroup?.groupId === prepared.group.groupId,
						),
					).toMatchObject({ subagentGroup: originalGroup })
					pending.get(handles[0].taskId)!(result(handles[0].taskId, "First continuation report"))
					await ownedFinalization((provider as any).subagentRunFinalizations.get(handles[0].taskId))
					expect((provider as any).subagentGroupControllers.has(handles[0].groupId)).toBe(false)
					expect((provider as any).subagentGroupControllers.has(handles[1].groupId)).toBe(true)
					pending.get(handles[1].taskId)!(result(handles[1].taskId, "Second continuation report"))
					await ownedFinalization((provider as any).subagentRunFinalizations.get(handles[1].taskId))
					expect(
						parent.alphaMessages.find(
							(message) => message.subagentGroup?.groupId === prepared.group.groupId,
						),
					).toMatchObject({ subagentGroup: originalGroup })
					const continuedGroups = parent.alphaMessages
						.flatMap((message) => (message.subagentGroup ? [message.subagentGroup] : []))
						.filter((group) => group.groupId !== prepared.group.groupId)
					expect(continuedGroups).toHaveLength(2)
					expect(
						continuedGroups.every((group) => group.agents.length === 1 && group.status === "completed"),
					).toBe(true)
					;(provider as any).preparedSubagentGroups.clear()
					;(provider as any).subagentDescriptors.clear()
					const restored = await (provider as any).restorePreparedSubagentForFollowup(
						parent,
						store.getAgent(handles[0].taskId, parent.taskId),
						"Resume after reload",
					)
					expect(restored.group.groupId).toBe(handles[0].groupId)
					expect((provider as any).subagentDescriptors.get(handles[0].taskId).contextManifest).toEqual(
						manifests[0],
					)
				} finally {
					for (const handle of handles) {
						runs.cancel(handle.taskId, "Test cleanup")
						await runs.waitForResult(handle.taskId)
						await ownedFinalization((provider as any).subagentRunFinalizations.get(handle.taskId))
					}
				}
			},
		)

		it.each(["persisted", "retained"] as const)(
			"rolls back failed %s child admission without replacing the original group",
			async (source) => {
				const { provider, parent, prepared, expectCompletedBatchState } = await setupCompletedBatch(
					source === "retained",
				)
				const store = (provider as any).agentControlStore as AgentControlStore
				const taskId = prepared.envelopes[1].id
				const previous = store.getAgent(taskId, parent.taskId)!
				const previousDescriptor = (provider as any).subagentDescriptors.get(taskId)
				const originalMessages = structuredClone(parent.alphaMessages)
				vi.spyOn(provider as any, "startPreparedSubagentRun").mockRejectedValueOnce(
					new Error("Continuation startup publication failed"),
				)

				await expect(
					provider.followupAgentTask(parent as any, taskId, "Continue after the batch"),
				).rejects.toThrow("Continuation startup publication failed")
				await (provider as any).pruneRetainedSubagentRuntimes()

				expect(store.getAgent(taskId, parent.taskId)).toEqual({
					...previous,
					pendingFollowupEventId: expect.any(String),
				})
				expect(parent.alphaMessages).toEqual(originalMessages)
				expect((provider as any).preparedSubagentGroups.size).toBe(0)
				expect((provider as any).subagentDescriptors.get(taskId)).toBe(previousDescriptor)
				expect(store.getUnacknowledgedMailboxEntries(taskId, { kinds: ["followup"] })).toEqual([
					expect.objectContaining({ payload: { message: "Continue after the batch" } }),
				])
				expectCompletedBatchState()
			},
		)

		it("releases a per-child continuation after capacity denial while preserving its resident child", async () => {
			const { provider, parent, prepared, expectCompletedBatchState } = await setupCompletedBatch(true)
			const taskId = prepared.envelopes[0].id
			const store = (provider as any).agentControlStore as AgentControlStore
			const previous = store.getAgent(taskId, parent.taskId)
			const descriptor = (provider as any).subagentDescriptors.get(taskId)
			const originalMessages = structuredClone(parent.alphaMessages)
			vi.spyOn(provider as any, "assertRetainedAgentRelaunchCapacity").mockImplementationOnce(() => {
				throw new Error("No continuation capacity")
			})

			await expect(provider.followupAgentTask(parent as any, taskId, "Continue after the batch")).rejects.toThrow(
				"No continuation capacity",
			)
			await (provider as any).pruneRetainedSubagentRuntimes()

			expect(store.getAgent(taskId, parent.taskId)).toEqual(previous)
			expect((provider as any).preparedSubagentGroups.size).toBe(0)
			expect((provider as any).subagentDescriptors.get(taskId)).toBe(descriptor)
			expect(parent.alphaMessages).toEqual(originalMessages)
			expect(store.getUnacknowledgedMailboxEntries(taskId, { kinds: ["followup"] })).toEqual([])
			expectCompletedBatchState()
		})

		it("recovers a batch continuation after a crash between durable admission and runner launch", async () => {
			const { provider, parent, prepared } = await setupCompletedBatch()
			const taskId = prepared.envelopes[1].id
			const store = (provider as any).agentControlStore as AgentControlStore
			const originalMessages = structuredClone(parent.alphaMessages)
			const manifest = store.getAgent(taskId, parent.taskId)!.snapshot!.contextManifest
			;(provider as any).__historyItems.set(taskId, {
				id: taskId,
				number: 2,
				ts: 1,
				task: "Inspect the second boundary",
				status: "completed",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				subagentGroupId: prepared.group.groupId,
				subagentContextManifest: manifest,
			})
			let crashedState: ReturnType<AgentControlStore["getSnapshot"]> | undefined
			const launch = vi.spyOn(provider as any, "startPreparedSubagentRun").mockImplementationOnce(async () => {
				crashedState = store.getSnapshot()
				throw new Error("Host stopped before runner launch")
			})
			await expect(
				provider.followupAgentTask(parent as any, taskId, "Resume the admitted continuation"),
			).rejects.toThrow("Host stopped before runner launch")
			launch.mockRestore()
			expect(crashedState).toBeDefined()
			const reloaded = new AgentControlStore(new InMemoryAgentControlPersistence(crashedState))
			await reloaded.initialize()
			const interrupted = reloaded.getAgent(taskId, parent.taskId)!
			expect(interrupted).toMatchObject({ status: "interrupted", pendingFollowupEventId: expect.any(String) })
			expect(interrupted.groupId).not.toBe(prepared.group.groupId)
			expect(parent.alphaMessages).toEqual(originalMessages)
			;(provider as any).agentControlStore = reloaded
			;(provider as any).agentControlStoreReady = Promise.resolve()
			;(provider as any).preparedSubagentGroups.clear()
			;(provider as any).subagentDescriptors.clear()

			const resumed = (await provider.followupAgentTask(
				parent as any,
				taskId,
				"Resume the admitted continuation",
			)) as any
			await ownedFinalization((provider as any).subagentRunFinalizations.get(taskId))

			expect(resumed).toMatchObject({ taskId, groupId: interrupted.groupId, followup: true })
			expect(
				reloaded.getSnapshot().mailbox.filter((entry) => entry.eventId === interrupted.pendingFollowupEventId),
			).toHaveLength(1)
			expect(reloaded.getAgent(taskId, parent.taskId)?.snapshot?.contextManifest).toEqual(manifest)
			expect(
				parent.alphaMessages.find((message) => message.subagentGroup?.groupId === prepared.group.groupId),
			).toEqual(originalMessages[0])
			expect(parent.alphaMessages).toHaveLength(2)
		})

		it.each(["original", "advanced"] as const)(
			"recovers a continuation while its first summary is committing and child history is %s",
			async (historyLocation) => {
				const { provider, parent, prepared, result } = await setupCompletedBatch()
				const taskId = prepared.envelopes[1].id
				const store = (provider as any).agentControlStore as AgentControlStore
				const originalMessages = structuredClone(parent.alphaMessages)
				const manifest = store.getAgent(taskId, parent.taskId)!.snapshot!.contextManifest
				const childHistory = {
					id: taskId,
					number: 2,
					ts: 1,
					task: "Inspect the second boundary",
					status: "completed",
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
					subagentGroupId: prepared.group.groupId,
					subagentContextManifest: manifest,
				}
				;(provider as any).__historyItems.set(taskId, childHistory)
				let releaseSummary!: () => void
				const summaryGate = new Promise<void>((resolve) => (releaseSummary = resolve))
				let enterSummary!: () => void
				const summaryStarted = new Promise<void>((resolve) => (enterSummary = resolve))
				const persistGroup: (group: SubagentGroupState) => Promise<void> = parent.upsertSubagentGroup
				let firstSummary = true
				let initialSummary: SubagentGroupState | undefined
				parent.upsertSubagentGroup = vi.fn(async (group: SubagentGroupState) => {
					if (firstSummary && group.groupId !== prepared.group.groupId) {
						firstSummary = false
						initialSummary = structuredClone(group)
						enterSummary()
						await summaryGate
					}
					await persistGroup(group)
				})
				const bounded = new BoundedDelegationManager(
					async (envelope, signal) =>
						await new Promise<ReturnType<typeof result>>((_resolve, reject) => {
							if (signal.aborted) reject(signal.reason)
							else signal.addEventListener("abort", () => reject(signal.reason), { once: true })
						}),
				)
				const runs = new AsyncSubagentRunManager(bounded)
				;(provider as any).boundedDelegationManager = bounded
				;(provider as any).asyncSubagentRunManager = runs
				const handle = (await provider.followupAgentTask(
					parent as any,
					taskId,
					"Resume the admitted turn",
				)) as any
				try {
					await summaryStarted
					expect(initialSummary).toMatchObject({
						executionMode: "async",
						status: "pending",
						agents: [{ taskId, status: "pending" }],
					})
					const crashedState = store.getSnapshot()
					const receipt = crashedState.mailbox.find(
						(entry) => entry.recipientTaskId === taskId && entry.kind === "followup",
					)!
					expect(parent.alphaMessages).toEqual(originalMessages)
					const reloaded = new AgentControlStore(new InMemoryAgentControlPersistence(crashedState))
					await reloaded.initialize()
					const interrupted = reloaded.getAgent(taskId, parent.taskId)!
					const recoveredProvider = makeProviderHarness(3)
					;(recoveredProvider as any).agentControlStore = reloaded
					;(recoveredProvider as any).agentControlStoreReady = Promise.resolve()
					;(recoveredProvider as any).__historyItems.set(taskId, {
						...childHistory,
						subagentGroupId: historyLocation === "advanced" ? handle.groupId : childHistory.subagentGroupId,
					})
					const recoveredParent = makeParent()
					recoveredParent.alphaMessages = structuredClone(originalMessages)
					const restoration = (recoveredProvider as any).restorePreparedSubagentForFollowup(
						recoveredParent,
						interrupted,
						"Resume the admitted turn",
					)
					await expect(restoration).resolves.toMatchObject({
						group: { groupId: handle.groupId, agents: [{ taskId }] },
					})
					expect(interrupted.pendingFollowupEventId).toBe(receipt.eventId)
					expect(
						reloaded.getSnapshot().mailbox.filter((entry) => entry.eventId === receipt.eventId),
					).toHaveLength(1)
					expect((recoveredProvider as any).subagentDescriptors.get(taskId).contextManifest).toEqual(manifest)
					expect(recoveredParent.alphaMessages).toEqual(originalMessages)
					const missingReceiptState = structuredClone(crashedState)
					missingReceiptState.mailbox = missingReceiptState.mailbox.filter(
						(entry) => entry.eventId !== receipt.eventId,
					)
					const missingReceipt = new AgentControlStore(
						new InMemoryAgentControlPersistence(missingReceiptState),
					)
					await missingReceipt.initialize()
					;(recoveredProvider as any).agentControlStore = missingReceipt
					;(recoveredProvider as any).preparedSubagentGroups.clear()
					;(recoveredProvider as any).subagentDescriptors.clear()
					await expect(
						(recoveredProvider as any).restorePreparedSubagentForFollowup(
							recoveredParent,
							missingReceipt.getAgent(taskId, parent.taskId),
							"Resume the admitted turn",
						),
					).rejects.toThrow("no persisted transcript summary")
				} finally {
					releaseSummary()
					runs.cancel(taskId, "Test cleanup")
					await runs.waitForResult(taskId)
					await ownedFinalization((provider as any).subagentRunFinalizations.get(taskId))
				}
			},
		)

		it("retains the exact admission when the first continuation summary cannot be persisted", async () => {
			const { provider, parent, prepared, result } = await setupCompletedBatch()
			const taskId = prepared.envelopes[1].id
			const store = (provider as any).agentControlStore as AgentControlStore
			const originalMessages = structuredClone(parent.alphaMessages)
			let finishRun!: (value: ReturnType<typeof result>) => void
			const resultGate = new Promise<ReturnType<typeof result>>((resolve) => (finishRun = resolve))
			const bounded = new BoundedDelegationManager(async () => await resultGate)
			;(provider as any).boundedDelegationManager = bounded
			;(provider as any).asyncSubagentRunManager = new AsyncSubagentRunManager(bounded)
			let rejectSummary!: () => void
			const summaryStarted = new Promise<void>((resolve) => (rejectSummary = resolve))
			parent.upsertSubagentGroup = vi.fn(async () => {
				rejectSummary()
				throw new Error("Continuation summary persistence failed")
			})
			const handle = (await provider.followupAgentTask(
				parent as any,
				taskId,
				"Resume after publication recovers",
			)) as any
			const finalization = ownedFinalization(
				(provider as any).subagentRunFinalizations.get(taskId),
			) as Promise<void>
			try {
				await summaryStarted
				finishRun(result(taskId, "The child ran before the summary could commit"))
				await expect(finalization).rejects.toThrow("Continuation summary persistence failed")
				const retained = store.getAgent(taskId, parent.taskId)!
				expect(retained).toMatchObject({
					status: "pending",
					groupId: handle.groupId,
					pendingFollowupEventId: expect.any(String),
				})
				expect(
					store.getSnapshot().mailbox.filter((entry) => entry.eventId === retained.pendingFollowupEventId),
				).toEqual([
					expect.objectContaining({
						kind: "followup",
						payload: { message: "Resume after publication recovers" },
					}),
				])
				expect(parent.alphaMessages).toEqual(originalMessages)
				const reloaded = new AgentControlStore(new InMemoryAgentControlPersistence(store.getSnapshot()))
				await reloaded.initialize()
				const recoveredProvider = makeProviderHarness(3)
				;(recoveredProvider as any).agentControlStore = reloaded
				;(recoveredProvider as any).agentControlStoreReady = Promise.resolve()
				const recoveredParent = makeParent()
				recoveredParent.alphaMessages = structuredClone(originalMessages)
				await expect(
					(recoveredProvider as any).restorePreparedSubagentForFollowup(
						recoveredParent,
						reloaded.getAgent(taskId, parent.taskId),
						"Resume after publication recovers",
					),
				).resolves.toMatchObject({ group: { groupId: handle.groupId, agents: [{ taskId }] } })
			} finally {
				finishRun(result(taskId, "Test cleanup"))
				await finalization.catch(() => undefined)
				;(provider as any).releaseSubagentGroup(handle.groupId)
			}
		})

		it("lets the root interrupt a nested blocking child through its bounded run owner", async () => {
			const provider = makeProviderHarness(3)
			const parent = makeParent()
			const root = await (provider as any).ensureAgentControlRoot(parent)
			const store = (provider as any).agentControlStore as AgentControlStore
			const owner = await store.createAgent({
				taskId: "blocking-owner",
				parentTaskId: root.taskId,
				nickname: "Owner",
				role: "review",
				objective: "Own a blocking descendant",
				status: "running",
			})
			const taskId = "nested-blocking-child"
			await store.createAgent({
				taskId,
				parentTaskId: owner.taskId,
				nickname: "Nested blocking child",
				role: "review",
				objective: "Inspect the nested boundary",
				status: "running",
			})
			const envelope = buildInternalTaskEnvelope({
				id: taskId,
				parentTaskId: owner.taskId,
				rootTaskId: root.taskId,
				depth: 2,
				objective: "Inspect the nested boundary",
				expectedOutput: [],
				parentPolicy: {
					read: true,
					mutate: false,
					execute: false,
					delegate: false,
					network: false,
					externalSideEffects: false,
					requireApproval: true,
				},
				requestedPolicy: { read: true },
				workspaceRoots: [parent.cwd],
				parentWorkspaceRoots: [parent.cwd],
				modelRouteId: "user-configured",
				budget: {
					maxDepth: 2,
					maxConcurrency: 2,
					timeoutMs: 120_000,
					maxInputTokens: 1_000,
					maxOutputTokens: 1_000,
				},
			})
			let entered!: () => void
			const running = new Promise<void>((resolve) => (entered = resolve))
			const bounded = new BoundedDelegationManager(async (item, signal) => {
				entered()
				await new Promise<void>((resolve) => {
					if (signal.aborted) resolve()
					else signal.addEventListener("abort", () => resolve(), { once: true })
				})
				return {
					taskId: item.id,
					status: "completed",
					summary: "Stopped",
					evidence: [],
					changedFiles: [],
					verification: [],
					remainingRisks: [],
					usage: { durationMs: 1 },
				}
			})
			;(provider as any).boundedDelegationManager = bounded
			;(provider as any).asyncSubagentRunManager = new AsyncSubagentRunManager(bounded)
			const completion = bounded.run(envelope)
			await running
			try {
				await expect(provider.interruptAgent(parent as any, taskId)).resolves.toEqual({
					previous_status: "running",
				})
				await expect(completion).resolves.toMatchObject({ status: "interrupted", stopReason: "interrupted" })
				expect(store.getUnacknowledgedMailboxEntries(taskId, { kinds: ["control"] })).toEqual([
					expect.objectContaining({ name: "interrupt_requested", senderTaskId: root.taskId }),
				])
			} finally {
				bounded.cancel(taskId, "Test cleanup")
				await completion
			}
		})
	})

	it("registers blocking children before launch and durably closes their synchronous lifecycle", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		;(provider as any).taskSessions.getTask = (taskId: string) => (taskId === parent.taskId ? parent : undefined)
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect the parser", agent_kind: "explore" },
			{ objective: "Review the dispatcher", agent_kind: "review" },
		])
		const store = (provider as any).agentControlStore as AgentControlStore
		const observedStatuses: string[] = []
		;(provider as any).boundedDelegationManager = new BoundedDelegationManager(async (envelope) => {
			const record = store.getAgent(envelope.id, parent.taskId)
			expect(record).toMatchObject({
				taskId: envelope.id,
				parentTaskId: parent.taskId,
				groupId: prepared.group.groupId,
				status: "running",
			})
			observedStatuses.push(record!.status)

			const decision = await provider.getParentCompletionDecision({
				taskId: envelope.id,
				rootTaskId: parent.taskId,
				taskKind: "subagent",
				subagentRole: "review",
			} as any)
			expect(decision.allowed).toBe(true)

			return {
				taskId: envelope.id,
				status: "completed" as const,
				summary: `Completed ${envelope.objective}`,
				evidence: [],
				changedFiles: [],
				verification: [],
				remainingRisks: [],
				usage: { durationMs: 10 },
				stopReason: "completed" as const,
			}
		})

		const result = await provider.runSubagentGroup(parent as any, prepared, new AbortController().signal)

		expect(result.status).toBe("completed")
		expect(observedStatuses).toEqual(["running", "running"])
		for (const envelope of prepared.envelopes) {
			const record = store.getAgent(envelope.id, parent.taskId)
			expect(record).toMatchObject({
				status: "completed",
				terminalResult: {
					status: "completed",
					stopReason: "completed",
					metadata: { delivery: "delegate_task" },
				},
				snapshot: { metadata: { delivery: "delegate_task" } },
			})
		}
		expect(store.getUnacknowledgedMailboxEntries(parent.taskId, { kinds: ["result"] })).toEqual([])
		await expect(provider.getParentCompletionDecision(parent as any)).resolves.toMatchObject({ allowed: true })
		await expect(
			provider.waitForAgent(parent as any, 10_000, {
				target: prepared.envelopes[0].id,
				untilTerminal: true,
			}),
		).resolves.toMatchObject({
			timedOut: false,
			events: [],
			alreadyDelivered: true,
			target: { taskId: prepared.envelopes[0].id, status: "completed" },
		})
	})

	it("retries a transient child-result persistence failure without changing the child outcome", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		;(provider as any).taskSessions.getTask = (taskId: string) => (taskId === parent.taskId ? parent : undefined)
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect the parser", agent_kind: "explore" },
		])
		let terminalAttempts = 0
		const successfulUpdates: SubagentGroupState[] = []
		parent.upsertSubagentGroup = vi.fn(async (group: SubagentGroupState) => {
			if (group.status === "running" && group.agents[0]?.status === "completed") {
				terminalAttempts++
				if (terminalAttempts === 1) throw new Error("temporary message-store failure")
			}
			successfulUpdates.push(structuredClone(group))
		})
		;(provider as any).createTask = vi.fn(
			async (_text: string, _images: unknown, _parent: unknown, options: any) => {
				const emitter = new EventEmitter()
				return Object.assign(emitter, {
					taskId: options.taskId,
					alphaMessages: [{ type: "say", say: "completion_result", text: "Parser inspected" }],
					getTokenUsage: () => ({ totalTokensIn: 10, totalTokensOut: 5 }),
					persistFrozenSubagentInstructions: vi.fn(async () => undefined),
					finalizeSubagentHistory: vi.fn(async () => undefined),
					cancelCurrentRequest: vi.fn(),
					abortTask: vi.fn(async () => undefined),
					start() {
						emitter.emit(AlphaCodeEventName.TaskCompleted, options.taskId, {
							totalTokensIn: 10,
							totalTokensOut: 5,
						})
					},
				})
			},
		)
		;(provider as any).boundedDelegationManager = new BoundedDelegationManager(
			(envelope, signal) => (provider as any).runSubagentEnvelope(envelope, signal),
			2,
		)

		const result = await provider.runSubagentGroup(parent as any, prepared, new AbortController().signal)

		expect(terminalAttempts).toBe(2)
		expect(result).toMatchObject({ status: "completed", agents: [{ status: "completed" }] })
		expect(
			successfulUpdates.filter(
				(update) => update.status === "running" && update.agents[0]?.status === "completed",
			),
		).toHaveLength(1)
		expect((provider as any).log).toHaveBeenCalledWith(expect.stringContaining("temporary message-store failure"))
	})

	it("reports unexpected launch-state persistence failures as failed rather than cancelled", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect the parser", agent_kind: "explore" },
		])
		parent.upsertSubagentGroup = vi
			.fn()
			.mockRejectedValueOnce(new Error("message store unavailable"))
			.mockResolvedValue(undefined)
		;(provider as any).boundedDelegationManager = {
			runBatch: vi.fn(async () => []),
		}

		const result = await provider.runSubagentGroup(parent as any, prepared, new AbortController().signal)

		expect(result).toMatchObject({
			status: "failed",
			agents: [{ status: "failed", error: "message store unavailable" }],
		})
		expect(parent.upsertSubagentGroup).toHaveBeenLastCalledWith(prepared.group)
		const record = (provider as any).agentControlStore.getAgent(prepared.envelopes[0].id, parent.taskId)
		expect(record).toMatchObject({
			status: "failed",
			terminalResult: {
				status: "failed",
				error: "message store unavailable",
				metadata: { delivery: "delegate_task" },
			},
		})
		await expect(provider.getParentCompletionDecision(parent as any)).resolves.toMatchObject({ allowed: true })
	})

	const prepareCancelledAdmission = async (
		role: "explore" | "worker",
		source: "invoking" | "lifetime",
		abortBeforeEntry = true,
	) => {
		const provider = makeProviderHarness(3)
		const committedCards = new Map<string, SubagentGroupState>()
		const cancelledAttempts: SubagentGroupState[] = []
		const publication: {
			failure?: { reason: unknown }
			beforeCommit?: (guard?: () => boolean) => Promise<void>
		} = {}
		const parent = {
			...makeParent(),
			upsertSubagentGroup: vi.fn(async (group: SubagentGroupState, guard?: () => boolean) => {
				// Model Task's awaited persistence port; never retain its mutable preparation object.
				const snapshot = structuredClone(group)
				if (snapshot.status === "cancelled") {
					cancelledAttempts.push(snapshot)
					if (guard && !guard()) return
					await publication.beforeCommit?.(guard)
					if (guard && !guard()) return
					if (publication.failure) throw publication.failure.reason
				}
				committedCards.set(snapshot.groupId, snapshot)
			}),
		}
		const invoking = new AbortController()
		const lifetime = new AbortController()
		parent.getTaskCancellationSignal.mockReturnValue(invoking.signal)
		parent.getTaskLifetimeCancellationSignal.mockReturnValue(lifetime.signal)
		const sessions = Reflect.get(provider, "taskSessions") as TaskSessionRegistry
		sessions.register(parent as unknown as Task, { focus: false })
		sessions.markLifecycle(parent.taskId, TaskLifecycleState.Running)
		const availableBefore = sessions.getAvailableTaskCapacity()
		if (role === "worker") {
			vi.spyOn(managedSubagentWorktreeService, "validateScope").mockResolvedValue({
				gitRoot: parent.cwd,
				logicalWorkspace: parent.cwd,
				logicalWorkspaceFromRoot: "",
				writeScope: ["src"],
				gitRelativeScope: ["src"],
				fileWriteScope: [],
				gitRelativeFileScope: [],
			})
		}
		const createWorktree = vi
			.spyOn(managedSubagentWorktreeService, "create")
			.mockRejectedValue(new Error("Cancelled admission must not create a worktree"))
		const createTask = vi.fn(async () => {
			throw new Error("Cancelled admission must not create a child Task")
		})
		;(provider as any).createTask = createTask
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{
				task_name: "cancelled_admission",
				objective: "Inspect the parser",
				agent_kind: role,
				...(role === "worker" ? { write_scope: ["src"] } : {}),
			},
		])
		const pendingCard = structuredClone(committedCards.get(prepared.group.groupId))
		expect(pendingCard).toMatchObject({ status: "pending", agents: [{ status: "pending" }] })
		expect(committedCards.get(prepared.group.groupId)).not.toBe(prepared.group)
		expect((provider as any).preparedSubagentGroups.get(prepared.group.groupId)).toBe(prepared)
		expect((provider as any).subagentDescriptors.has(prepared.envelopes[0].id)).toBe(true)
		expect((provider as any).reservedSubagentSlots.has(prepared.group.groupId)).toBe(true)
		expect(sessions.getReservedTaskSlots(parent.taskId, () => false)).toEqual({ total: 1, root: 1 })
		const store = Reflect.get(provider, "agentControlStore") as AgentControlStore
		const storeBefore = structuredClone(store.getSnapshot())
		const runner = vi.fn(async () => {
			throw new Error("an already-cancelled child must not launch")
		})
		const bounded = new BoundedDelegationManager(runner)
		const runBatch = vi.spyOn(bounded, "runBatch")
		const runs = new AsyncSubagentRunManager(bounded)
		;(provider as any).boundedDelegationManager = bounded
		;(provider as any).asyncSubagentRunManager = runs
		const reason = new Error("Parent task cancelled by user")
		if (abortBeforeEntry) (source === "invoking" ? invoking : lifetime).abort(reason)
		const start = (execution: "blocking" | "async") => {
			if (execution === "blocking") return provider.runSubagentGroup(parent as any, prepared, invoking.signal)
			return provider.launchPreparedSubagentGroup(parent as any, prepared, invoking.signal)
		}
		const finalizations = Reflect.get(provider, "subagentRunFinalizations") as Map<
			string,
			Parameters<typeof ownedFinalization>[0]
		>
		const expectResourcesReleased = () => {
			expect(runner).not.toHaveBeenCalled()
			expect(runBatch).not.toHaveBeenCalled()
			expect(createTask).not.toHaveBeenCalled()
			expect(createWorktree).not.toHaveBeenCalled()
			expect(runs.listSnapshots()).toEqual([])
			expect(provider.getLiveTask(prepared.envelopes[0].id)).toBeUndefined()
			expect(store.getAgent(prepared.envelopes[0].id, parent.taskId)).toBeUndefined()
			expect(store.getSnapshot()).toEqual(storeBefore)
			expect((provider as any).preparedSubagentGroups.size).toBe(0)
			expect((provider as any).subagentDescriptors.size).toBe(0)
			expect((provider as any).subagentGroupControllers.size).toBe(0)
			expect((provider as any).reservedSubagentSlots.size).toBe(0)
			expect(sessions.getReservedTaskSlots(parent.taskId, () => false)).toEqual({ total: 0, root: 0 })
			expect(sessions.getAvailableTaskCapacity()).toBe(availableBefore)
		}
		const expectReleased = () => {
			expectResourcesReleased()
			expect(prepared.group).toMatchObject({
				status: "cancelled",
				completedAt: expect.any(Number),
				agents: [{ status: "cancelled", completedAt: expect.any(Number) }],
			})
		}
		return {
			parent,
			prepared,
			committedCards,
			pendingCard,
			publication,
			reason,
			start,
			finalizations,
			expectReleased,
			expectResourcesReleased,
			invoking,
			lifetime,
			cancelledAttempts,
			gate: Reflect.get(provider, "workspaceMutationGate") as WorkspaceMutationGate,
		}
	}

	it.each([
		["blocking", "invoking", "explore"],
		["blocking", "lifetime", "explore"],
		["async", "invoking", "explore"],
		["async", "lifetime", "explore"],
		["blocking", "invoking", "worker"],
		["blocking", "lifetime", "worker"],
		["async", "invoking", "worker"],
		["async", "lifetime", "worker"],
	] as const)(
		"publishes cancelled preparation after %s %s %s pre-admission cancellation",
		async (execution, source, role) => {
			const fixture = await prepareCancelledAdmission(role, source)
			const admission = fixture.start(execution)
			const finalization = ownedFinalization(fixture.finalizations.get(fixture.prepared.envelopes[0].id))
			const settlement = Promise.allSettled([admission, finalization])
			expect(finalization).toBeDefined()
			expect(fixture.finalizations.get(fixture.prepared.envelopes[0].id)).toMatchObject({ phase: "admitting" })
			await settlement
			await expect(admission).rejects.toBe(fixture.reason)
			await expect(finalization).resolves.toBeUndefined()
			fixture.expectReleased()
			expect(fixture.cancelledAttempts).toHaveLength(1)
			expect(fixture.committedCards.get(fixture.prepared.group.groupId)).toMatchObject({
				groupId: fixture.prepared.group.groupId,
				status: "cancelled",
				completedAt: expect.any(Number),
				agents: [
					{
						taskId: fixture.prepared.envelopes[0].id,
						status: "cancelled",
						completedAt: expect.any(Number),
					},
				],
			})
			expect(fixture.finalizations.size).toBe(0)
		},
	)

	it.each([
		["blocking", "explore", "distinct"],
		["async", "explore", "distinct"],
		["blocking", "explore", "same"],
		["async", "explore", "same"],
		["blocking", "worker", "undefined"],
		["async", "worker", "undefined"],
		["blocking", "worker", "null"],
		["async", "worker", "null"],
	] as const)(
		"retains %s %s pre-admission publication failure %s after releasing resources",
		async (execution, role, kind) => {
			const fixture = await prepareCancelledAdmission(role, "invoking")
			const failure =
				kind === "same"
					? fixture.reason
					: kind === "undefined"
						? undefined
						: kind === "null"
							? null
							: new Error("Cancelled card persistence failed")
			fixture.publication.failure = { reason: failure }
			const admission = fixture.start(execution)
			const finalization = ownedFinalization(fixture.finalizations.get(fixture.prepared.envelopes[0].id))
			const settlement = Promise.allSettled([admission, finalization])
			expect(finalization).toBeDefined()
			expect(fixture.finalizations.get(fixture.prepared.envelopes[0].id)).toMatchObject({ phase: "admitting" })
			await settlement
			await expect(admission).rejects.toBe(failure)
			await expect(finalization).rejects.toBe(failure)
			fixture.expectReleased()
			expect(fixture.cancelledAttempts).toHaveLength(1)
			expect(fixture.committedCards.get(fixture.prepared.group.groupId)).toEqual(fixture.pendingCard)
			expect(fixture.parent.upsertSubagentGroup.mock.calls.at(-1)?.[0]).toEqual(fixture.prepared.group)
			expect(ownedFinalization(fixture.finalizations.get(fixture.prepared.envelopes[0].id))).toBe(finalization)
		},
	)

	it.each([
		["blocking", "invoking"],
		["blocking", "lifetime"],
		["async", "invoking"],
		["async", "lifetime"],
	] as const)("publishes queued %s Worker cancellation after %s null signal", async (execution, first) => {
		const fixture = await prepareCancelledAdmission("worker", first, false)
		let entered!: () => void
		const gateEntered = new Promise<void>((resolve) => (entered = resolve))
		let release!: () => void
		const held = new Promise<void>((resolve) => (release = resolve))
		const holder = fixture.gate.run("gate-holder", "Hold Worker admission", async () => {
			entered()
			await held
		})
		await gateEntered
		const admission = fixture.start(execution)
		const finalization = ownedFinalization(fixture.finalizations.get(fixture.prepared.envelopes[0].id))
		const settlement = Promise.allSettled([admission, finalization])
		try {
			expect(fixture.finalizations.get(fixture.prepared.envelopes[0].id)).toMatchObject({ phase: "admitting" })
			;(first === "invoking" ? fixture.invoking : fixture.lifetime).abort(null)
			;(first === "invoking" ? fixture.lifetime : fixture.invoking).abort(new Error("Later cancellation"))
			await settlement
			await expect(admission).rejects.toBe(null)
			await expect(finalization).resolves.toBeUndefined()
			fixture.expectReleased()
			expect(fixture.cancelledAttempts).toHaveLength(1)
			expect(fixture.committedCards.get(fixture.prepared.group.groupId)).toMatchObject({ status: "cancelled" })
			expect(fixture.finalizations.size).toBe(0)
		} finally {
			release()
			await holder
			await settlement
		}
	})

	it.each([
		["blocking", "owned"],
		["async", "owned"],
		["blocking", "replaced"],
		["async", "replaced"],
	] as const)("joins %s cancelled card publication with %s parent ownership", async (execution, ownership) => {
		const fixture = await prepareCancelledAdmission("explore", "invoking")
		let entered!: (guard: (() => boolean) | undefined) => void
		const publicationEntered = new Promise<(() => boolean) | undefined>((resolve) => (entered = resolve))
		let release!: () => void
		const held = new Promise<void>((resolve) => (release = resolve))
		fixture.publication.beforeCommit = async (guard) => {
			entered(guard)
			await held
		}
		const admission = fixture.start(execution)
		const finalization = ownedFinalization(fixture.finalizations.get(fixture.prepared.envelopes[0].id))
		let finalizationSettled = false
		void finalization?.then(
			() => {
				finalizationSettled = true
			},
			() => {
				finalizationSettled = true
			},
		)
		const settlement = Promise.allSettled([admission, finalization])
		try {
			const first = await Promise.race([
				publicationEntered.then((guard) => ({ kind: "publication" as const, guard })),
				settlement.then(() => ({ kind: "settled" as const })),
			])
			expect(first.kind).toBe("publication")
			if (first.kind !== "publication" || !first.guard) throw new Error("Missing publication ownership guard")
			expect(first.guard()).toBe(true)
			expect(finalizationSettled).toBe(false)
			expect(fixture.committedCards.get(fixture.prepared.group.groupId)).toEqual(fixture.pendingCard)
			const replacementLifetime = new AbortController()
			const replacement = structuredClone(fixture.pendingCard!)
			if (ownership === "replaced") {
				fixture.parent.getTaskLifetimeCancellationSignal.mockReturnValue(replacementLifetime.signal)
				replacement.status = "running"
				replacement.agents[0].summary = "Replacement owner card"
				fixture.committedCards.set(replacement.groupId, replacement)
				expect(first.guard()).toBe(false)
			}
			release()
			await settlement
			await expect(admission).rejects.toBe(fixture.reason)
			await expect(finalization).resolves.toBeUndefined()
			fixture.expectReleased()
			expect(fixture.cancelledAttempts).toHaveLength(1)
			expect(fixture.finalizations.size).toBe(0)
			if (ownership === "replaced") {
				expect(fixture.committedCards.get(replacement.groupId)).toBe(replacement)
				expect(replacementLifetime.signal.aborted).toBe(false)
			} else {
				expect(fixture.committedCards.get(fixture.prepared.group.groupId)).toMatchObject({
					status: "cancelled",
				})
			}
		} finally {
			release()
			await settlement
		}
	})

	it.each(["blocking", "async"] as const)("retains typed %s Worker callback failure", async (execution) => {
		const fixture = await prepareCancelledAdmission("worker", "invoking", false)
		const failure = new WorkspaceMutationCancelledError(fixture.parent.taskId, "Mode callback persistence failure")
		fixture.parent.getTaskMode.mockImplementationOnce(async () => {
			fixture.invoking.abort(fixture.reason)
			throw failure
		})
		const admission = fixture.start(execution)
		const finalization = ownedFinalization(fixture.finalizations.get(fixture.prepared.envelopes[0].id))
		await Promise.allSettled([admission, finalization])
		await expect(admission).rejects.toBe(failure)
		await expect(finalization).rejects.toBe(failure)
		fixture.expectResourcesReleased()
		expect(fixture.cancelledAttempts).toEqual([])
		expect(fixture.committedCards.get(fixture.prepared.group.groupId)).toEqual(fixture.pendingCard)
	})

	it("registers children before publishing running state so immediate cancellation is not lost", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		;(provider as any).taskSessions.getTask = (taskId: string) => (taskId === parent.taskId ? parent : undefined)
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect the parser", agent_kind: "explore" },
		])
		const runner = vi.fn(async () => {
			throw new Error("cancelled child should not reach the runner")
		})
		;(provider as any).boundedDelegationManager = new BoundedDelegationManager(runner)

		let requestedCancel = false
		parent.upsertSubagentGroup = vi.fn(async (group: SubagentGroupState) => {
			if (group.status !== "running" || requestedCancel) return
			requestedCancel = true
			await provider.cancelSubagent(parent.taskId, group.groupId, group.agents[0].taskId)
		})

		const result = await provider.runSubagentGroup(parent as any, prepared, new AbortController().signal)

		expect(requestedCancel).toBe(true)
		expect(runner).not.toHaveBeenCalled()
		expect(result).toMatchObject({
			status: "cancelled",
			agents: [{ status: "cancelled" }],
		})
		const record = (provider as any).agentControlStore.getAgent(prepared.envelopes[0].id, parent.taskId)
		expect(record).toMatchObject({
			status: "cancelled",
			terminalResult: {
				status: "cancelled",
				metadata: { delivery: "delegate_task" },
			},
		})
		await expect(provider.getParentCompletionDecision(parent as any)).resolves.toMatchObject({ allowed: true })
	})

	it("summarizes useful partial work from an incomplete child transcript", () => {
		const provider = makeProviderHarness()
		const child = {
			alphaMessages: [
				{
					type: "ask",
					ask: "tool",
					text: JSON.stringify({ tool: "readFile", path: "src/server.ts" }),
				},
				{
					type: "ask",
					ask: "tool",
					text: JSON.stringify({
						tool: "readFile",
						batchFiles: [{ path: "src/router.ts" }, { path: "src/auth.ts" }],
					}),
				},
			],
		}

		const inspected = (provider as any).getSubagentInspectedPaths(child.alphaMessages)
		const summary = (provider as any).describeIncompleteSubagent("timed_out", inspected)

		expect(inspected).toEqual(["src/server.ts", "src/router.ts", "src/auth.ts"])
		expect(summary).toContain("Timed out after inspecting 3 files")
		expect(summary).toContain("The partial transcript is preserved")
	})

	it("maps generic child events to stable execution phases", () => {
		const provider = makeProviderHarness()
		const phaseFor = (message: Record<string, unknown>) => (provider as any).getSubagentPhaseForMessage(message)

		expect(phaseFor({ type: "say", say: "api_req_started" })).toBe("working")
		expect(phaseFor({ type: "say", say: "api_req_rate_limit_wait", partial: true })).toBe("waiting")
		expect(phaseFor({ type: "say", say: "api_req_rate_limit_wait", partial: false })).toBe("working")
		expect(phaseFor({ type: "say", say: "completion_result", partial: true })).toBe("reporting")
		expect(phaseFor({ type: "say", say: "completion_result", partial: false })).toBe("finalizing")
		expect(phaseFor({ type: "say", say: "text" })).toBeUndefined()
	})

	it("reports mixed child outcomes as partial without disturbing result order", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		;(provider as any).taskSessions.getTask = (taskId: string) => (taskId === parent.taskId ? parent : undefined)
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect arbitrary subsystem A", agent_kind: "explore" },
			{ objective: "Review arbitrary subsystem B", agent_kind: "review" },
		])
		;(provider as any).boundedDelegationManager = new BoundedDelegationManager(async (envelope) => ({
			taskId: envelope.id,
			status: envelope.id === prepared.envelopes[0].id ? ("completed" as const) : ("failed" as const),
			summary: envelope.id === prepared.envelopes[0].id ? "useful findings" : "provider failed",
			evidence: [],
			changedFiles: [],
			verification: [],
			remainingRisks: [],
			usage: { durationMs: 10 },
		}))

		const result = await provider.runSubagentGroup(parent as any, prepared, new AbortController().signal)

		expect(result.status).toBe("partial")
		expect(result.agents.map((agent) => agent.taskId)).toEqual(prepared.envelopes.map((item) => item.id))
		expect(result.agents[0]).toMatchObject({ status: "completed", summary: "useful findings" })
		expect(result.agents[1]).toMatchObject({ status: "failed", error: "provider failed" })
	})

	it.each([true, false])("preserves a pending child approval when persistence fails (%s)", async (approved) => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect an approval", agent_kind: "explore" },
		])
		const agent = prepared.group.agents[0]
		agent.status = "running"
		const pendingApproval = { id: "approval-retry", type: "command" as const, operation: "pnpm test", createdAt: 1 }
		agent.pendingApproval = pendingApproval
		const child = { approveAsk: vi.fn(), denyAsk: vi.fn(), getActiveAskTimestamp: vi.fn(() => 1) }
		;(provider as any).getLiveTask = () => child
		const failure = new Error("Approval card persistence failed")
		parent.upsertSubagentGroup.mockRejectedValueOnce(failure)
		const respond = () =>
			provider.respondToSubagentApproval(
				parent.taskId,
				prepared.group.groupId,
				agent.taskId,
				pendingApproval.id,
				approved,
			)

		await expect(respond()).rejects.toBe(failure)
		expect(agent.pendingApproval).toBe(pendingApproval)
		expect(child.approveAsk).not.toHaveBeenCalled()
		expect(child.denyAsk).not.toHaveBeenCalled()
		await respond()
		await respond()
		expect(agent.pendingApproval).toBeUndefined()
		expect(child.approveAsk).toHaveBeenCalledTimes(approved ? 1 : 0)
		expect(child.denyAsk).toHaveBeenCalledTimes(approved ? 0 : 1)
	})

	it("excludes duplicate approval actions while the parent card is committing", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect an approval", agent_kind: "explore" },
		])
		const agent = prepared.group.agents[0]
		agent.status = "running"
		agent.pendingApproval = { id: "approval-commit", type: "command", operation: "pnpm test", createdAt: 1 }
		const child = { approveAsk: vi.fn(), denyAsk: vi.fn(), getActiveAskTimestamp: vi.fn(() => 1) }
		;(provider as any).getLiveTask = () => child
		let entered!: () => void
		const committing = new Promise<void>((resolve) => (entered = resolve))
		let release!: () => void
		const commit = new Promise<void>((resolve) => (release = resolve))
		parent.upsertSubagentGroup.mockImplementationOnce(async () => {
			entered()
			await commit
		})
		const first = provider.respondToSubagentApproval(
			parent.taskId,
			prepared.group.groupId,
			agent.taskId,
			"approval-commit",
			true,
		)
		try {
			await committing
			await provider.respondToSubagentApproval(
				parent.taskId,
				prepared.group.groupId,
				agent.taskId,
				"approval-commit",
				false,
			)
			expect(child.approveAsk).not.toHaveBeenCalled()
			expect(child.denyAsk).not.toHaveBeenCalled()
		} finally {
			release()
			await first
		}
		expect(child.approveAsk).toHaveBeenCalledOnce()
		expect(child.denyAsk).not.toHaveBeenCalled()
	})

	it.each(["replacement", "cancellation"] as const)(
		"does not restore an older approval after %s during a failed commit",
		async (boundary) => {
			const provider = makeProviderHarness()
			const parent = makeParent()
			const prepared = await provider.prepareSubagentGroup(parent as any, [
				{ objective: "Inspect an approval", agent_kind: "explore" },
			])
			const agent = prepared.group.agents[0]
			agent.status = "running"
			agent.pendingApproval = { id: "approval-old", type: "command", operation: "pnpm test", createdAt: 1 }
			const replacement = {
				id: "approval-new",
				type: "command" as const,
				operation: "pnpm check-types",
				createdAt: 2,
			}
			const child = { approveAsk: vi.fn(), denyAsk: vi.fn(), getActiveAskTimestamp: vi.fn(() => 1) }
			;(provider as any).getLiveTask = () => child
			const failure = new Error("Approval card persistence failed")
			parent.upsertSubagentGroup.mockImplementationOnce(async () => {
				if (boundary === "replacement") agent.pendingApproval = replacement
				else agent.status = "cancelled"
				throw failure
			})
			await expect(
				provider.respondToSubagentApproval(
					parent.taskId,
					prepared.group.groupId,
					agent.taskId,
					"approval-old",
					true,
				),
			).rejects.toBe(failure)
			expect(agent.pendingApproval).toBe(boundary === "replacement" ? replacement : undefined)
			expect(child.approveAsk).not.toHaveBeenCalled()
			expect(child.denyAsk).not.toHaveBeenCalled()
		},
	)

	it("keeps an approval pending when its owning descriptor is unavailable", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect an approval", agent_kind: "explore" },
		])
		const agent = prepared.group.agents[0]
		agent.status = "running"
		const pendingApproval = { id: "approval-owner", type: "command" as const, operation: "pnpm test", createdAt: 1 }
		agent.pendingApproval = pendingApproval
		const child = { approveAsk: vi.fn(), denyAsk: vi.fn(), getActiveAskTimestamp: vi.fn(() => 1) }
		;(provider as any).getLiveTask = () => child
		Reflect.get(provider, "subagentDescriptors").delete(agent.taskId)
		parent.upsertSubagentGroup.mockClear()
		await expect(
			provider.respondToSubagentApproval(
				parent.taskId,
				prepared.group.groupId,
				agent.taskId,
				pendingApproval.id,
				true,
			),
		).rejects.toThrow("owning parent")
		expect(agent.pendingApproval).toBe(pendingApproval)
		expect(parent.upsertSubagentGroup).not.toHaveBeenCalled()
		expect(child.approveAsk).not.toHaveBeenCalled()
		expect(child.denyAsk).not.toHaveBeenCalled()
	})

	it.each(["approval", "ask", "child", "group"] as const)(
		"does not resolve a stale child approval after %s replacement during a successful commit",
		async (boundary) => {
			const provider = makeProviderHarness()
			const parent = makeParent()
			const prepared = await provider.prepareSubagentGroup(parent as any, [
				{ objective: "Inspect an approval", agent_kind: "explore" },
			])
			const agent = prepared.group.agents[0]
			agent.status = "running"
			agent.pendingApproval = { id: "approval-before", type: "command", operation: "pnpm test", createdAt: 1 }
			const child = { approveAsk: vi.fn(), denyAsk: vi.fn(), getActiveAskTimestamp: vi.fn(() => 1) }
			;(provider as any).getLiveTask = () => child
			let entered!: () => void
			const committing = new Promise<void>((resolve) => (entered = resolve))
			let release!: () => void
			const commit = new Promise<void>((resolve) => (release = resolve))
			parent.upsertSubagentGroup.mockImplementationOnce(async () => {
				entered()
				await commit
			})
			const responding = provider.respondToSubagentApproval(
				parent.taskId,
				prepared.group.groupId,
				agent.taskId,
				"approval-before",
				true,
			)
			try {
				await committing
				if (boundary === "approval") {
					agent.pendingApproval = {
						id: "approval-after",
						type: "command",
						operation: "pnpm check-types",
						createdAt: 2,
					}
				} else if (boundary === "ask") {
					child.getActiveAskTimestamp.mockReturnValue(2)
				} else if (boundary === "child") {
					;(provider as any).getLiveTask = () => ({ ...child })
				} else {
					prepared.group = structuredClone(prepared.group)
				}
			} finally {
				release()
				await responding
			}
			expect(child.approveAsk).not.toHaveBeenCalled()
			expect(child.denyAsk).not.toHaveBeenCalled()
			if (boundary === "approval") expect(agent.pendingApproval?.id).toBe("approval-after")
		},
	)

	it("steers only the selected live child and persists lifecycle metadata", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect the parser", agent_kind: "explore" },
			{ objective: "Review the dispatcher", agent_kind: "review" },
		])
		prepared.group.status = "running"
		prepared.group.agents.forEach((agent) => {
			agent.status = "running"
		})
		const targetId = prepared.group.agents[0].taskId
		const siblingId = prepared.group.agents[1].taskId
		const target = {
			taskId: targetId,
			parentTaskId: parent.taskId,
			subagentGroupId: prepared.group.groupId,
			canAcceptSteerMessage: vi.fn(() => true),
			steerUserMessageDurably: vi.fn(async () => undefined),
		}
		const sibling = {
			...target,
			taskId: siblingId,
			steerUserMessageDurably: vi.fn(async () => undefined),
		}
		;(provider as any).getLiveTask = (taskId: string) =>
			taskId === targetId ? target : taskId === siblingId ? sibling : undefined

		await expect(
			provider.steerSubagent(parent.taskId, prepared.group.groupId, targetId, "  Focus on cancellation edges.  "),
		).resolves.toBe(true)

		expect(target.steerUserMessageDurably).toHaveBeenCalledWith(
			"Focus on cancellation edges.",
			undefined,
			expect.any(String),
		)
		expect(sibling.steerUserMessageDurably).not.toHaveBeenCalled()
		expect(prepared.group.agents[0]).toMatchObject({ phase: "steering", steerCount: 1 })
		expect(prepared.group.agents[0].lastSteeredAt).toEqual(expect.any(Number))
		expect(parent.upsertSubagentGroup).toHaveBeenLastCalledWith(prepared.group)
	})

	it("does not steer through a pending child approval", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect a file", agent_kind: "explore" },
		])
		prepared.group.status = "running"
		const agent = prepared.group.agents[0]
		agent.status = "running"
		agent.pendingApproval = {
			id: "approval-1",
			type: "command",
			operation: "pnpm test",
			createdAt: Date.now(),
		}
		const child = {
			taskId: agent.taskId,
			parentTaskId: parent.taskId,
			subagentGroupId: prepared.group.groupId,
			canAcceptSteerMessage: vi.fn(() => true),
			steerUserMessageDurably: vi.fn(async () => undefined),
		}
		;(provider as any).getLiveTask = () => child

		await expect(
			provider.steerSubagent(parent.taskId, prepared.group.groupId, agent.taskId, "Skip that command"),
		).resolves.toBe(false)

		expect(child.steerUserMessageDurably).not.toHaveBeenCalled()
	})

	it("does not publish steering metadata when the child rejects admission", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect a file", agent_kind: "explore" },
		])
		const agent = prepared.group.agents[0]
		agent.status = "running"
		agent.phase = "working"
		const child = {
			taskId: agent.taskId,
			parentTaskId: parent.taskId,
			subagentGroupId: prepared.group.groupId,
			canAcceptSteerMessage: vi.fn(() => true),
			steerUserMessageDurably: vi.fn(async () => {
				throw new Error("steer rejected")
			}),
			hasAcceptedQueuedUserMessage: vi.fn(async () => false),
		}
		;(provider as any).getLiveTask = () => child
		parent.upsertSubagentGroup.mockClear()
		await expect(
			provider.steerSubagent(parent.taskId, prepared.group.groupId, agent.taskId, "Focus on safety"),
		).rejects.toThrow("steer rejected")
		expect(agent).toMatchObject({ phase: "working" })
		expect(agent.steerCount).toBeUndefined()
		expect(agent.lastSteeredAt).toBeUndefined()
		expect(parent.upsertSubagentGroup).not.toHaveBeenCalled()
	})

	it("acknowledges a retained queued instruction when immediate steering loses its boundary", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect a file", agent_kind: "explore" },
		])
		const agent = prepared.group.agents[0]
		agent.status = "running"
		const child = {
			taskId: agent.taskId,
			parentTaskId: parent.taskId,
			subagentGroupId: prepared.group.groupId,
			canAcceptSteerMessage: vi.fn(() => true),
			hasAcceptedQueuedUserMessage: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
			steerUserMessageDurably: vi.fn().mockRejectedValue(new Error("steering boundary changed")),
		}
		;(provider as any).getLiveTask = () => child
		await expect(
			provider.steerSubagent(
				parent.taskId,
				prepared.group.groupId,
				agent.taskId,
				"arbitrary input",
				"retained-input-id",
			),
		).resolves.toBe(true)
		expect(child.hasAcceptedQueuedUserMessage).toHaveBeenCalledTimes(2)
		expect(agent).toMatchObject({ phase: "steering", steerCount: 1 })
		await expect(
			provider.steerSubagent(
				parent.taskId,
				prepared.group.groupId,
				agent.taskId,
				"arbitrary input",
				"retained-input-id",
			),
		).resolves.toBe(true)
		expect(child.steerUserMessageDurably).toHaveBeenCalledOnce()
		expect(agent.steerCount).toBe(1)
	})

	it("accepts durable steering even when saving the parent projection fails", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect a file", agent_kind: "explore" },
		])
		const agent = prepared.group.agents[0]
		agent.status = "running"
		const child = {
			taskId: agent.taskId,
			parentTaskId: parent.taskId,
			subagentGroupId: prepared.group.groupId,
			canAcceptSteerMessage: vi.fn(() => true),
			hasAcceptedQueuedUserMessage: vi.fn(async () => false),
			steerUserMessageDurably: vi.fn(async () => undefined),
		}
		;(provider as any).getLiveTask = () => child
		parent.upsertSubagentGroup.mockRejectedValueOnce(new Error("projection save failed"))
		await expect(
			provider.steerSubagent(
				parent.taskId,
				prepared.group.groupId,
				agent.taskId,
				"Focus on safety",
				"accepted-steer",
			),
		).resolves.toBe(true)
		expect(child.steerUserMessageDurably).toHaveBeenCalledExactlyOnceWith(
			"Focus on safety",
			undefined,
			"accepted-steer",
		)
		expect(agent).toMatchObject({ phase: "steering", steerCount: 1, lastSteeredAt: expect.any(Number) })
	})

	it("acknowledges an accepted steering request retry without steering or incrementing metadata again", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect a file", agent_kind: "explore" },
		])
		const agent = prepared.group.agents[0]
		agent.status = "running"
		agent.steerCount = 1
		agent.lastSteeredAt = 101
		const child = {
			taskId: agent.taskId,
			parentTaskId: parent.taskId,
			subagentGroupId: prepared.group.groupId,
			canAcceptSteerMessage: vi.fn(() => false),
			hasAcceptedQueuedUserMessage: vi.fn(async () => true),
			steerUserMessageDurably: vi.fn(async () => undefined),
		}
		;(provider as any).getLiveTask = () => child
		parent.upsertSubagentGroup.mockClear()
		await expect(
			provider.steerSubagent(
				parent.taskId,
				prepared.group.groupId,
				agent.taskId,
				"Focus on safety",
				"accepted-steer",
			),
		).resolves.toBe(true)
		expect(child.hasAcceptedQueuedUserMessage).toHaveBeenCalledExactlyOnceWith("accepted-steer")
		expect(child.steerUserMessageDurably).not.toHaveBeenCalled()
		expect(agent).toMatchObject({ steerCount: 1, lastSteeredAt: 101 })
		expect(parent.upsertSubagentGroup).not.toHaveBeenCalled()
	})

	it("cancels one agent without changing its running sibling", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect A", agent_kind: "explore" },
			{ objective: "Inspect B", agent_kind: "review" },
		])
		prepared.group.status = "running"
		prepared.group.agents.forEach((agent) => {
			agent.status = "running"
		})
		const cancel = vi.fn(() => true)
		;(provider as any).boundedDelegationManager = { cancel }

		await provider.cancelSubagent(parent.taskId, prepared.group.groupId, prepared.group.agents[0].taskId)

		expect(cancel).toHaveBeenCalledWith(prepared.group.agents[0].taskId, expect.any(Error), "parent_cancelled")
		expect(prepared.group.agents[0]).toMatchObject({ status: "cancelling" })
		expect(prepared.group.agents[0].cancelRequestedAt).toEqual(expect.any(Number))
		expect(prepared.group.agents[1].status).toBe("running")
	})
})
