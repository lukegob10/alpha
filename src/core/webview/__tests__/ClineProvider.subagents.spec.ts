import EventEmitter from "events"

import { managedSubagentWorktreeService } from "@alpha-code/core"
import { RooCodeEventName, type SubagentGroupState } from "@alpha-code/types"

import { ClineProvider } from "../ClineProvider"
import { AsyncSubagentRunManager } from "../../agent/AsyncSubagentRunManager"
import { AgentControlStore, InMemoryAgentControlPersistence } from "../../agent/AgentControlStore"
import { BoundedDelegationManager } from "../../agent/BoundedDelegationManager"
import { SubagentNicknameRegistry } from "../../agent/SubagentNicknameRegistry"
import { Task } from "../../task/Task"

afterEach(() => vi.restoreAllMocks())

const makeProviderHarness = (
	availableCapacity = 2,
	routingSettings: {
		subagentDefaultApiConfigId?: string
		subagentApiConfigByRole?: { explore?: string; review?: string }
	} = {},
	profiles: Array<Record<string, any>> = [],
) => {
	const agentControlStore = new AgentControlStore(new InMemoryAgentControlPersistence())
	const agentControlStoreReady = agentControlStore.initialize()
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
	const provider = Object.assign(Object.create(ClineProvider.prototype), {
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
		taskSessions: {
			getAvailableTaskCapacity: () => availableCapacity,
			getMaxLiveTasks: () => 3,
			getTask: () => undefined,
		},
		taskHistoryStore: { getAll: () => [] },
		subagentNicknameRegistry: new SubagentNicknameRegistry(),
		preparedSubagentGroups: new Map(),
		subagentGroupControllers: new Map(),
		reservedSubagentSlots: new Map(),
		publishedSubagentResults: new Set(),
		subagentDescriptors: new Map(),
		agentControlStore,
		agentControlStoreReady,
		agentControlRootStatusWrites: new Map(),
		asyncSubagentRunManager: { cancel: () => false, getSnapshot: () => undefined },
		getTaskWithId: vi.fn(async (taskId: string) => ({ historyItem: historyItems.get(taskId) })),
		updateTaskHistory: vi.fn(async (item: any) => {
			historyItems.set(item.id, item)
			return [...historyItems.values()]
		}),
		log: vi.fn(),
	}) as ClineProvider
	;(provider as any).__historyItems = historyItems
	return provider
}

const makeParent = () => ({
	taskId: "parent-1",
	taskKind: "primary",
	metadata: { task: "parent" },
	clineMessages: [] as any[],
	cwd: "F:/workspace",
	historyWorkspacePath: "F:/workspace",
	apiConfiguration: { apiProvider: "openai", apiModelId: "alpha-model" },
	getTaskMode: vi.fn(async () => "code"),
	getTaskApiConfigName: vi.fn(async () => "Parent"),
	getTaskCancellationSignal: vi.fn(() => new AbortController().signal),
	getTaskLifetimeCancellationSignal: vi.fn(() => new AbortController().signal),
	beginAgentWait: vi.fn(() => ({ signal: new AbortController().signal, dispose: vi.fn() })),
	upsertSubagentGroup: vi.fn(async () => undefined),
})

describe("ClineProvider bounded sub-agent preparation", () => {
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

		;(provider as any).taskSessions.getAvailableTaskCapacity = () => 1
		;(provider as any).taskSessions.getTask = (taskId: string) =>
			taskId === first.envelopes[0].id ? { taskId } : undefined

		await expect(
			provider.prepareSubagentGroup(parent as any, [
				{ objective: "Review the dispatcher", agent_kind: "review" },
			]),
		).resolves.toMatchObject({
			group: { agents: [{ objective: "Review the dispatcher" }] },
		})
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
				delegate: false,
				network: false,
				externalSideEffects: false,
			})
			expect(envelope.modelRoute).toMatchObject({
				id: "user-configured",
				provider: "openai",
				model: "alpha-model",
			})
			expect(envelope.budget.timeoutMs).toBe(120_000)
		}
		expect(prepared.group.agents.map((agent) => agent.nickname)).toEqual(["Beacon", "Cinder"])
		expect(new Set(prepared.group.agents.map((agent) => agent.nickname)).size).toBe(2)
		expect(parent.upsertSubagentGroup).toHaveBeenCalledWith(prepared.group)
	})

	it("snapshots different role profiles without changing the parent configuration", async () => {
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
					apiProvider: "openrouter",
					openRouterModelId: "fast/model",
					openRouterApiKey: "explore-secret",
				},
				{
					id: "review-id",
					name: "Deep Reviewer",
					apiProvider: "anthropic",
					apiModelId: "review-model",
					apiKey: "review-secret",
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
			expect.objectContaining({ provider: "openrouter", model: "fast/model" }),
			expect.objectContaining({ provider: "anthropic", model: "review-model" }),
		])
		expect(prepared.group.agents.map((agent) => agent.modelRoute)).toEqual([
			expect.objectContaining({ source: "role", profileId: "explore-id", profileName: "Fast Explorer" }),
			expect.objectContaining({ source: "role", profileId: "review-id", profileName: "Deep Reviewer" }),
		])
		expect(JSON.stringify(prepared.group)).not.toContain("secret")
		expect(parent.apiConfiguration).toEqual(originalParentConfiguration)
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

	it("launches concurrent children with their frozen role configurations", async () => {
		const provider = makeProviderHarness(
			2,
			{ subagentApiConfigByRole: { explore: "explore-id", review: "review-id" } },
			[
				{
					id: "explore-id",
					name: "Fast Explorer",
					apiProvider: "openrouter",
					openRouterModelId: "fast/model",
					openRouterApiKey: "explore-secret",
				},
				{
					id: "review-id",
					name: "Deep Reviewer",
					apiProvider: "anthropic",
					apiModelId: "review-model",
					apiKey: "review-secret",
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
					clineMessages: [
						{
							type: "say",
							say: "completion_result",
							text: `${options.subagentRole} complete`,
						},
					],
					getTokenUsage: () => ({ totalTokensIn: 10, totalTokensOut: 5 }),
					finalizeSubagentHistory: vi.fn(async () => undefined),
					cancelCurrentRequest: vi.fn(),
					abortTask: vi.fn(async () => undefined),
					start() {
						active++
						peak = Math.max(peak, active)
						setTimeout(() => {
							active--
							emitter.emit(RooCodeEventName.TaskCompleted, options.taskId, {
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
		expect(launchOptions.find((options) => options.subagentRole === "explore")).toMatchObject({
			taskApiConfigName: "Fast Explorer",
			apiConfiguration: { openRouterApiKey: "explore-secret", openRouterModelId: "fast/model" },
			subagentModelRoute: { profileId: "explore-id", modelId: "fast/model" },
		})
		expect(launchOptions.find((options) => options.subagentRole === "review")).toMatchObject({
			taskApiConfigName: "Deep Reviewer",
			apiConfiguration: { apiKey: "review-secret", apiModelId: "review-model" },
			subagentModelRoute: { profileId: "review-id", modelId: "review-model" },
		})
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
					clineMessages: [
						{
							type: "say",
							say: "completion_result",
							text: "The objective needs authority that this read-only agent does not have.",
						},
					],
					getTokenUsage: () => ({ totalTokensIn: 10, totalTokensOut: 5 }),
					finalizeSubagentHistory: vi.fn(async () => undefined),
					cancelCurrentRequest: vi.fn(),
					abortTask: vi.fn(async () => undefined),
					start() {
						emitter.emit(RooCodeEventName.TaskCompleted, options.taskId, {
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
		)
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

	it("fails a completed editing worker when its captured worktree has no changes", async () => {
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
			fileWriteScope: ["F:/workspace/docs"],
			gitRelativeFileScope: ["docs"],
		}
		const artifact = {
			id: "change-set-1",
			taskId: "worker-1",
			status: "pending_review" as const,
			createdAt: 10,
			updatedAt: 20,
			gitRoot: "F:/workspace",
			logicalWorkspace: "F:/workspace",
			logicalWorkspaceFromRoot: "",
			baselineCommit: "baseline",
			resultCommit: "result",
			writeScope: ["docs"],
			gitRelativeScope: ["docs"],
			fileWriteScope: ["F:/workspace/docs"],
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
					clineMessages: [
						{ type: "say", say: "completion_result", text: "Could not make the requested edit." },
					],
					getTokenUsage: () => ({ totalTokensIn: 10, totalTokensOut: 5 }),
					finalizeSubagentHistory: vi.fn(async () => {
						now += 50
					}),
					setSubagentChangeSet: vi.fn(),
					cancelCurrentRequest: vi.fn(),
					abortTask: vi.fn(async () => undefined),
					start() {
						emitter.emit(RooCodeEventName.TaskCompleted, options.taskId, {
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
				objective: "Create a bounded documentation change",
				agent_kind: "worker",
				write_scope: ["docs"],
			},
		])
		const result = await provider.runSubagentGroup(parent as any, prepared, new AbortController().signal)

		expect(result.status).toBe("failed")
		expect(result.agents[0]).toMatchObject({
			role: "worker",
			status: "failed",
			usage: { durationMs: 125 },
			changedFiles: [],
			verification: [{ label: "Worker command 1", status: "passed", detail: "Exit code 0" }],
			changeSet: { status: "unavailable", error: "No worker changes were captured." },
		})
		expect(result.agents[0]?.error).toContain("no changes were captured")
		expect(child.finalizeSubagentHistory).toHaveBeenCalledWith(
			"failed",
			expect.stringContaining("Worker report: Could not make the requested edit."),
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

	it("forbids nested delegation even when invoked outside catalog filtering", async () => {
		const provider = makeProviderHarness()
		const parent = { ...makeParent(), taskKind: "subagent" }

		await expect(
			provider.prepareSubagentGroup(parent as any, [{ objective: "nested", agent_kind: "explore" }]),
		).rejects.toThrow("cannot delegate")
	})

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
		const handle = await provider.launchPreparedSubagentGroup(parent as any, prepared, new AbortController().signal)

		expect(handle).toMatchObject({
			taskId: prepared.envelopes[0].id,
			groupId: prepared.group.groupId,
			parentTaskId: parent.taskId,
			status: "pending",
		})
		expect(Object.isFrozen(handle)).toBe(true)
		expect((provider as any).asyncSubagentRunManager.getResult(handle.taskId)).toBeUndefined()
		await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce())
		await vi.waitFor(() =>
			expect(updates.some((group) => group.status === "running" && group.agents[0].status === "running")).toBe(
				true,
			),
		)

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

		await vi.waitFor(() => expect(updates.at(-1)?.status).toBe("completed"))
		expect(updates.at(-1)?.executionMode).toBe("async")
		expect(updates.at(-1)?.agents[0]).toMatchObject({
			status: "completed",
			summary: "Parser inspected",
		})
		expect((provider as any).__historyItems.get(parent.taskId).childIds).toEqual([handle.taskId])
		expect((provider as any).preparedSubagentGroups.has(prepared.group.groupId)).toBe(true)
		expect((provider as any).asyncSubagentRunManager.getSnapshot(handle.taskId)).toMatchObject({
			status: "completed",
		})
		expect((provider as any).agentControlStore.getAgent(handle.taskId, parent.taskId)).toMatchObject({
			path: handle.path,
			status: "completed",
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

		const steerUserMessage = vi.fn(async () => undefined)
		liveChildren.set(firstHandle.taskId, {
			canAcceptSteerMessage: () => true,
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
		expect(steerUserMessage).toHaveBeenCalledWith("Focus on the reload race")
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
		expect(mailbox.events.some((event: any) => event.name === "agent_completed")).toBe(true)

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

	it("cancels a mailbox wait when the parent request is cancelled", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const request = new AbortController()
		const dispose = vi.fn()
		parent.beginAgentWait = vi.fn(() => ({ signal: request.signal, dispose }))

		const waiting = provider.waitForAgent(parent as any, 10_000)
		request.abort(new Error("parent request stopped"))

		await expect(waiting).resolves.toEqual({ timedOut: false, cancelled: true, events: [] })
		expect(dispose).toHaveBeenCalledOnce()
	})

	it("consumes mailbox results that were already injected into the parent model context", async () => {
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
		parent.clineMessages = [
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
		expect(listed.mailbox.unreadCount).toBe(0)

		await expect(provider.waitForAgent(parent as any, 10_000)).resolves.toEqual({
			timedOut: false,
			events: [],
			alreadyDelivered: true,
		})
		expect(
			(provider as any).agentControlStore.readMailbox(root.taskId, {
				rootTaskId: root.rootTaskId,
				includeDelivered: false,
			}).entries,
		).toEqual([])
	})

	it("claims a wait_agent result before automatic result injection can duplicate it", async () => {
		const provider = makeProviderHarness()
		const parentState = makeParent()
		delete (parentState as Partial<typeof parentState>).cwd
		const parent = Object.assign(Object.create(Task.prototype), parentState, {
			workspacePath: "F:/workspace",
		}) as Task
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
		parent.clineMessages = [
			{
				type: "say",
				say: "subagent_group",
				subagentGroup: {
					groupId: "group-wait-claimed",
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
							summary: "Ownership race inspected",
							usage: { durationMs: 1 },
						},
					],
				},
			},
		] as any
		parent.upsertSubagentGroup = vi.fn(async (group: SubagentGroupState) => {
			parent.clineMessages[0].subagentGroup = structuredClone(group)
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

		expect(parent.hasUndeliveredSpawnedSubagentResults()).toBe(true)
		const waited = (await provider.waitForAgent(parent, 10_000)) as any

		expect(waited).toMatchObject({
			timedOut: false,
			events: [expect.objectContaining({ name: "agent_completed" })],
		})
		expect(parent.upsertSubagentGroup).toHaveBeenCalledOnce()
		expect(parent.clineMessages[0].subagentGroup?.agents[0].resultDeliveredAt).toEqual(expect.any(Number))
		expect(parent.hasUndeliveredSpawnedSubagentResults()).toBe(false)
	})

	it("does not claim an automatic result for non-result mailbox events", async () => {
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
		parent.clineMessages = [
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
			events: [expect.objectContaining({ kind: "message" })],
		})
		expect(parent.upsertSubagentGroup).not.toHaveBeenCalled()
		expect(parent.clineMessages[0].subagentGroup.agents[0].resultDeliveredAt).toBeUndefined()
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
		expect((provider as any).agentControlStore.getAgent(parent.taskId, parent.taskId)?.status).toBe("interrupted")
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

	it("rehydrates an interrupted child for follow-up after a provider reload", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect recovery", agent_kind: "explore" },
		])
		const group = structuredClone(prepared.group)
		group.executionMode = "async"
		group.status = "interrupted"
		group.agents[0].status = "interrupted"
		parent.clineMessages = [{ subagentGroup: group }] as any

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
		;(provider as any).reservedSubagentSlots.clear()
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
					clineMessages: [{ type: "say", say: "completion_result", text: "Parser inspected" }],
					getTokenUsage: () => ({ totalTokensIn: 10, totalTokensOut: 5 }),
					finalizeSubagentHistory: vi.fn(async () => undefined),
					cancelCurrentRequest: vi.fn(),
					abortTask: vi.fn(async () => undefined),
					start() {
						emitter.emit(RooCodeEventName.TaskCompleted, options.taskId, {
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
					clineMessages: [{ type: "say", say: "completion_result", text: "Parser inspected" }],
					getTokenUsage: () => ({ totalTokensIn: 10, totalTokensOut: 5 }),
					finalizeSubagentHistory: vi.fn(async () => undefined),
					cancelCurrentRequest: vi.fn(),
					abortTask: vi.fn(async () => undefined),
					start() {
						emitter.emit(RooCodeEventName.TaskCompleted, options.taskId, {
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
	})

	it("preserves an already-requested parent cancellation as cancelled", async () => {
		const provider = makeProviderHarness()
		const parent = makeParent()
		const prepared = await provider.prepareSubagentGroup(parent as any, [
			{ objective: "Inspect the parser", agent_kind: "explore" },
		])
		const runner = vi.fn(async () => {
			throw new Error("an already-cancelled child must not launch")
		})
		;(provider as any).boundedDelegationManager = new BoundedDelegationManager(runner)
		const parentController = new AbortController()
		parentController.abort(new Error("Parent task cancelled by user"))

		const result = await provider.runSubagentGroup(parent as any, prepared, parentController.signal)

		expect(runner).not.toHaveBeenCalled()
		expect(result).toMatchObject({ status: "cancelled", agents: [{ status: "cancelled" }] })
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
	})

	it("summarizes useful partial work from an incomplete child transcript", () => {
		const provider = makeProviderHarness()
		const child = {
			clineMessages: [
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

		const inspected = (provider as any).getSubagentInspectedPaths(child)
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
			steerUserMessage: vi.fn(async () => undefined),
		}
		const sibling = {
			...target,
			taskId: siblingId,
			steerUserMessage: vi.fn(async () => undefined),
		}
		;(provider as any).getLiveTask = (taskId: string) =>
			taskId === targetId ? target : taskId === siblingId ? sibling : undefined

		await provider.steerSubagent(
			parent.taskId,
			prepared.group.groupId,
			targetId,
			"  Focus on cancellation edges.  ",
		)

		expect(target.steerUserMessage).toHaveBeenCalledWith("Focus on cancellation edges.")
		expect(sibling.steerUserMessage).not.toHaveBeenCalled()
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
			steerUserMessage: vi.fn(async () => undefined),
		}
		;(provider as any).getLiveTask = () => child

		await provider.steerSubagent(parent.taskId, prepared.group.groupId, agent.taskId, "Skip that command")

		expect(child.steerUserMessage).not.toHaveBeenCalled()
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

		expect(cancel).toHaveBeenCalledWith(prepared.group.agents[0].taskId, expect.any(Error))
		expect(prepared.group.agents[0]).toMatchObject({ status: "cancelling" })
		expect(prepared.group.agents[0].cancelRequestedAt).toEqual(expect.any(Number))
		expect(prepared.group.agents[1].status).toBe("running")
	})
})
