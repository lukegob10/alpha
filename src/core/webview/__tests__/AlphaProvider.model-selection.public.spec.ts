import { createManagedPublicLifecycleHarness, type ScriptedTurn } from "./managedPublicLifecycleHarness"

import {
	AlphaCodeEventName,
	getModelId,
	subagentSpawnHandleSchema,
	type ModelInfo,
	type ProviderSettings,
	type ProviderSettingsWithId,
	type TaskLike,
} from "@alpha-code/types"
import { afterEach, describe, expect, it, vi } from "vitest"

import * as api from "../../../api"
import type { ApiHandlerCreateMessageMetadata } from "../../../api"
import { Task } from "../../task/Task"
import { readApiMessages, readTaskMessages } from "../../task-persistence"
import { spawnAgentTool } from "../../tools/SpawnAgentTool"
import { listProviderProfilesTool } from "../../tools/ListProviderProfilesTool"
import type { IndependentTaskModelSelection } from "../CrossTaskOrchestration"

type Harness = Awaited<ReturnType<typeof createManagedPublicLifecycleHarness>>
type Profile = ProviderSettingsWithId & { id: string; name: string }
type Request = { taskId: string; configuration: ProviderSettings; metadata: ApiHandlerCreateMessageMetadata }
const fixtures: Harness[] = []

const effortModelInfo: ModelInfo = {
	contextWindow: 128_000,
	maxTokens: 8_000,
	supportsImages: false,
	supportsPromptCache: false,
	supportsReasoningEffort: ["none", "low", "medium", "high"],
	reasoningEffort: "medium",
	inputPrice: 0,
	outputPrice: 0,
}

const parentProfile: Profile = {
	id: "scripted",
	name: "Scripted",
	apiProvider: "openai",
	openAiModelId: "parent-effort-model",
	openAiBaseUrl: "https://parent.example.invalid/v1",
	openAiApiKey: "fixture-parent-key",
}

const targetProfile: Profile = {
	id: "anthropic-profile",
	name: "Claude account",
	apiProvider: "anthropic",
	apiModelId: "claude-opus-5-5",
	apiKey: "fixture-target-key",
	anthropicBaseUrl: "https://api.anthropic.com",
}

function configuration(profile: Profile): ProviderSettings {
	const { id: _id, name: _name, ...settings } = profile
	return structuredClone(settings)
}

afterEach(async () => {
	try {
		for (const fixture of fixtures.splice(0)) await fixture.cleanup()
	} finally {
		vi.restoreAllMocks()
	}
})

async function createFixture(rootObjective?: string) {
	const requests: Request[] = []
	const rejectedModels = new Set<string>()
	const construct = api.buildApiHandler
	// Isolate provider transport and model discovery only. Every request below is
	// made by the real Task loop after routing, reasoning admission and persistence.
	vi.spyOn(api, "buildApiHandler").mockImplementation((settings) => {
		const captured = structuredClone(settings)
		const modelId = getModelId(captured) ?? "ws08-scripted"
		if (rejectedModels.has(modelId)) throw new Error("The scripted provider rejected the selected model")
		const handler = construct(settings)
		handler.getModel = () => ({ id: modelId, info: effortModelInfo })
		const createMessage = handler.createMessage.bind(handler)
		handler.createMessage = async function* (system, messages, metadata) {
			if (metadata && metadata.attemptId !== "title")
				requests.push({ taskId: metadata.taskId, configuration: structuredClone(captured), metadata })
			yield* createMessage(system, messages, metadata)
		}
		return handler
	})
	const fixture = await createManagedPublicLifecycleHarness({ maxLiveTasks: 3, rootObjective })
	fixtures.push(fixture)
	const profiles = new Map([parentProfile, targetProfile].map((profile) => [profile.id, structuredClone(profile)]))
	const manager = fixture.provider.providerSettingsManager
	vi.spyOn(manager, "getProfile").mockImplementation(async (params) => {
		const profile =
			"id" in params
				? profiles.get(params.id)
				: [...profiles.values()].find((candidate) => candidate.name === params.name)
		if (!profile) throw new Error("The requested fixture provider profile does not exist")
		return structuredClone(profile)
	})
	vi.spyOn(manager, "getAvailableProfile").mockImplementation(async (name) => {
		const profile = [...profiles.values()].find((candidate) => candidate.name === name)
		return profile ? configuration(profile) : undefined
	})
	vi.spyOn(manager, "listConfig").mockImplementation(async () =>
		[...profiles.values()].map((profile) => ({
			id: profile.id,
			name: profile.name,
			apiProvider: profile.apiProvider,
			modelId: getModelId(profile),
		})),
	)
	fixture.root.updateApiConfiguration(configuration(parentProfile))
	await fixture.root.updateReasoningPreference({ kind: "effort", effort: "high" })
	return { ...fixture, requests, profiles, rejectedModels }
}

type ModelFixture = Awaited<ReturnType<typeof createFixture>>

function requestFor(fixture: ModelFixture, taskId: string): Request {
	const request = fixture.requests.filter((candidate) => candidate.taskId === taskId).at(-1)
	if (!request) throw new Error(`The actual Task did not make a provider request for ${taskId}`)
	return request
}

async function launchChild(fixture: ModelFixture, selection: Record<string, unknown>) {
	let child: { task: Task; turn: ScriptedTurn } | undefined
	const onCreated = (created: TaskLike) => {
		if (created.taskKind !== "subagent" || created.parentTaskId !== fixture.root.taskId) return
		if (!(created instanceof Task)) throw new Error("The spawn event must retain its real Task")
		child = { task: created, turn: fixture.queueTurn(created.taskId, "The selected model completed the review.") }
	}
	const results: unknown[] = []
	fixture.provider.on(AlphaCodeEventName.TaskCreated, onCreated)
	try {
		await spawnAgentTool.execute(
			{
				task_name: `selected_model_${fixture.childrenCaptured.length + 1}`,
				message: "Review the selected model route and report the result.",
				agent_type: "review",
				fork_turns: "none",
				...selection,
			},
			fixture.root,
			{
				askApproval: vi.fn(async () => true),
				handleError: async (_action, error) => {
					throw error
				},
				pushToolResult: (result) => {
					if (typeof result === "string" && result.startsWith("Error:")) throw new Error(result)
					results.push(JSON.parse(String(result)))
				},
			},
		)
		if (!child) throw new Error("The native spawn operation did not create an actual child Task")
		expect(results).toHaveLength(1)
		const handle = subagentSpawnHandleSchema.parse(results[0])
		expect(handle.taskId).toBe(child.task.taskId)
		await child.turn.entered
		return { ...child, handle }
	} finally {
		fixture.provider.off(AlphaCodeEventName.TaskCreated, onCreated)
	}
}

async function finishChild(fixture: ModelFixture, task: Task, turn: ScriptedTurn) {
	turn.release()
	expect(await fixture.runs.waitForResult(task.taskId)).toMatchObject({ status: "completed" })
	await fixture.settleFinalizations()
	await task.waitForTermination()
}

function captureIndependentTurn(fixture: ModelFixture) {
	let task: Task | undefined
	let turn: ScriptedTurn | undefined
	const onCreated = (created: TaskLike) => {
		if (created.taskKind !== "primary" || created.orchestrationParentTaskId !== fixture.root.taskId) return
		if (!(created instanceof Task)) throw new Error("The new-chat event must retain its real Task")
		task = created
		turn = fixture.queueTurn(created.taskId, "The selected model completed the new chat.")
	}
	fixture.provider.on(AlphaCodeEventName.TaskCreated, onCreated)
	return {
		get: () => {
			if (!task || !turn) throw new Error("The public new-chat operation did not create a Task")
			return { task, turn }
		},
		dispose: () => fixture.provider.off(AlphaCodeEventName.TaskCreated, onCreated),
	}
}

const newChatRequest = "Create a new thread using a different model and provider with low reasoning."

async function createIndependent(fixture: ModelFixture, selection: IndependentTaskModelSelection) {
	const captured = captureIndependentTurn(fixture)
	try {
		await fixture.provider.createIndependentTask(fixture.root, "Review a separate problem.", "shared", undefined, {
			...selection,
			notifyOnCompletion: false,
		})
		const child = captured.get()
		await child.turn.entered
		return child
	} finally {
		captured.dispose()
	}
}

async function finishIndependent(child: { task: Task; turn: ScriptedTurn }) {
	child.turn.release()
	await child.task.waitForTermination()
	expect(child.task.isCompleted()).toBe(true)
}

function routeFields(history: Awaited<ReturnType<Harness["provider"]["getTaskWithId"]>>["historyItem"]) {
	return {
		apiConfigName: history.apiConfigName,
		reasoningPreference: history.reasoningPreference,
		threadModelOverride: history.threadModelOverride,
		threadModelRoute: history.threadModelRoute,
	}
}

describe("AlphaProvider public model selection", () => {
	it("launches the saved Haiku profile from a ChatGPT parent without sending Haiku to ChatGPT", async () => {
		const fixture = await createFixture("Launch a Haiku 5-5 sub-agent, say hello, and report back here.")
		const parentConfiguration: ProviderSettings = { apiProvider: "openai-codex", apiModelId: "gpt-6.1-sol" }
		fixture.root.updateApiConfiguration(parentConfiguration)
		const haiku: Profile = {
			id: "haiku-profile",
			name: "Hiaku 5.5",
			apiProvider: "vscode-lm",
			vsCodeLmModelSelector: { vendor: "copilot", family: "claude-haiku-5.5" },
		}
		fixture.profiles.set(haiku.id, haiku)
		fixture.settings.listApiConfigMeta = []
		const parentTurn = fixture.queueTurn(fixture.root.taskId, "The main chat retained its ChatGPT connection.")
		fixture.root.start()
		await parentTurn.entered
		expect(JSON.stringify(parentTurn.request?.tools)).toContain("list_provider_profiles")
		const results: unknown[] = []
		const askApproval = vi.fn(async () => true)
		await listProviderProfilesTool.execute({ query: "haiku" }, fixture.root, {
			askApproval,
			handleError: async (_action, error) => {
				throw error
			},
			pushToolResult: (result) => results.push(JSON.parse(String(result))),
		})
		expect(askApproval).not.toHaveBeenCalled()
		expect(results).toEqual([
			expect.objectContaining({
				profiles: [
					expect.objectContaining({
						id: haiku.id,
						name: haiku.name,
						provider: "vscode-lm",
						model: "claude-haiku-5.5",
					}),
				],
			}),
		])
		const discovered = results[0] as { profiles: Array<{ id: string }> }
		const child = await launchChild(fixture, { profile: discovered.profiles[0].id })
		expect(requestFor(fixture, child.task.taskId).configuration).toEqual(configuration(haiku))
		expect(child.task.subagentModelRoute).toMatchObject({
			profileId: haiku.id,
			profileName: haiku.name,
			provider: "vscode-lm",
			modelId: "claude-haiku-5.5",
		})
		expect(fixture.root.apiConfiguration).toEqual(parentConfiguration)
		expect(
			fixture.requests.some(
				(request) =>
					request.configuration.apiProvider === "openai-codex" &&
					getModelId(request.configuration) !== "gpt-6.1-sol",
			),
		).toBe(false)
		await finishChild(fixture, child.task, child.turn)
	})

	it("routes an explicit saved provider profile and effort into the actual child request without changing its parent", async () => {
		const fixture = await createFixture()
		const originalConfiguration = structuredClone(fixture.root.apiConfiguration)
		const originalPreference = structuredClone(fixture.root.reasoningPreference)
		const originalMode = fixture.root.getTaskApprovalMode()
		const parentTurn = fixture.queueTurn(fixture.root.taskId, "Integrate the model routing reviews.")
		fixture.root.start()
		await parentTurn.entered
		const inherited = await launchChild(fixture, {})
		const inheritedWrites = inherited.task.isToolAllowedForTask("apply_patch")
		const inheritedCommands = inherited.task.isToolAllowedForTask("exec_command")
		await finishChild(fixture, inherited.task, inherited.turn)
		const child = await launchChild(fixture, {
			provider: "anthropic",
			profile: targetProfile.id,
			model: targetProfile.apiModelId,
			reasoning_effort: "low",
		})
		expect(requestFor(fixture, child.task.taskId).configuration).toMatchObject({
			apiProvider: "anthropic",
			apiKey: targetProfile.apiKey,
			anthropicBaseUrl: targetProfile.anthropicBaseUrl,
			apiModelId: targetProfile.apiModelId,
			reasoningEffort: "low",
		})
		expect(requestFor(fixture, child.task.taskId).configuration.openAiApiKey).toBeUndefined()
		expect(child.task.getReasoningState().effective).toEqual({ kind: "effort", effort: "low" })
		expect(child.task.getTaskApprovalMode()).toBe(originalMode)
		expect(child.task.isToolAllowedForTask("apply_patch")).toBe(inheritedWrites)
		expect(child.task.isToolAllowedForTask("exec_command")).toBe(inheritedCommands)
		expect(fixture.root.apiConfiguration).toEqual(originalConfiguration)
		expect(fixture.root.reasoningPreference).toEqual(originalPreference)
		expect(fixture.root.getTaskApprovalMode()).toBe(originalMode)
		await finishChild(fixture, child.task, child.turn)
	})

	it("rejects unavailable explicit profiles before a child Task or model request is admitted", async () => {
		const fixture = await createFixture(newChatRequest)
		const created = vi.fn()
		fixture.provider.on(AlphaCodeEventName.TaskCreated, created)
		try {
			await expect(
				fixture.provider.prepareSubagentGroup(fixture.root, {
					task_name: "missing_profile",
					message: "Review the selected model route.",
					agent_type: "review",
					fork_turns: "none",
					profile: "missing-profile",
				}),
			).rejects.toThrow(/profile/i)
			await expect(
				fixture.provider.createIndependentTask(
					fixture.root,
					"Review a separate problem.",
					"shared",
					undefined,
					{
						profile: "missing-profile",
						notifyOnCompletion: false,
					},
				),
			).rejects.toThrow(/profile/i)
			expect(created).not.toHaveBeenCalled()
			expect(fixture.requests).toEqual([])
			expect(fixture.root.apiConfiguration).toEqual(configuration(parentProfile))
			// A failed resolution must release its reservation for the next valid launch.
			const child = await launchChild(fixture, { profile: targetProfile.id, reasoning_effort: "low" })
			await finishChild(fixture, child.task, child.turn)
		} finally {
			fixture.provider.off(AlphaCodeEventName.TaskCreated, created)
		}
	})

	it("restores a cold sub-agent's selected account, model and effort after automatic runtime eviction", async () => {
		const fixture = await createFixture()
		const child = await launchChild(fixture, {
			provider: "anthropic",
			profile: targetProfile.id,
			model: targetProfile.apiModelId,
			reasoning_effort: "low",
		})
		await finishChild(fixture, child.task, child.turn)
		const selectedRoute = structuredClone(child.task.subagentModelRoute)
		const approvalMode = child.task.getTaskApprovalMode()
		const mayWrite = child.task.isToolAllowedForTask("apply_patch")
		for (const label of ["pressure-one", "pressure-two", "pressure-three"]) await fixture.spawnCompletedChild(label)
		await fixture.settleFinalizations({ includeResidency: true })
		expect(fixture.provider.getLiveTask(child.task.taskId) === undefined).toBe(true)
		fixture.profiles.set(targetProfile.id, {
			...targetProfile,
			apiKey: "fixture-rotated-child-key",
			apiModelId: "claude-sonnet-5-5",
			reasoningEffort: "high",
			enableReasoningEffort: true,
		})
		const next = fixture.queueTurn(child.task.taskId, "The cold sub-agent kept its captured model and effort.")
		await fixture.provider.followupAgentTask(fixture.root, child.handle.path, "Recheck the saved review.")
		await next.entered
		const successor = fixture.provider.getLiveTask(child.task.taskId)
		if (!(successor instanceof Task)) throw new Error("Cold follow-up did not restore the actual child Task")
		expect(successor).not.toBe(child.task)
		expect(successor.subagentModelRoute).toEqual(selectedRoute)
		expect(requestFor(fixture, successor.taskId).configuration).toMatchObject({
			apiProvider: "anthropic",
			apiKey: "fixture-rotated-child-key",
			apiModelId: targetProfile.apiModelId,
			reasoningEffort: "low",
		})
		expect(successor.getTaskApprovalMode()).toBe(approvalMode)
		expect(successor.isToolAllowedForTask("apply_patch")).toBe(mayWrite)
		expect(fixture.root.apiConfiguration).toEqual(configuration(parentProfile))
		expect(fixture.root.reasoningPreference).toEqual({ kind: "effort", effort: "high" })
		await finishChild(fixture, successor, next)
	})

	it("selects a catalog Copilot family independently of the parent's pinned opaque host ID", async () => {
		const fixture = await createFixture()
		const pinned: ProviderSettings = {
			apiProvider: "vscode-lm",
			vsCodeLmModelSelector: { vendor: "copilot", family: "gpt-6-luna", id: "opaque-parent-route" },
		}
		fixture.root.updateApiConfiguration(pinned)
		fixture.profiles.set(parentProfile.id, { ...parentProfile, ...pinned })
		const child = await launchChild(fixture, { model: "claude-opus-5.5" })
		expect(requestFor(fixture, child.task.taskId).configuration.vsCodeLmModelSelector).toEqual({
			vendor: "copilot",
			family: "claude-opus-5.5",
		})
		expect(fixture.root.apiConfiguration).toEqual(pinned)
		await finishChild(fixture, child.task, child.turn)
	})

	it("uses a new chat's selected model default instead of its parent's task reasoning override", async () => {
		const fixture = await createFixture("Create a new thread using target-effort-model.")
		const captured = captureIndependentTurn(fixture)
		try {
			await fixture.provider.createIndependentTask(
				fixture.root,
				"Review a separate problem.",
				"shared",
				undefined,
				{
					model: "target-effort-model",
					notifyOnCompletion: false,
				},
			)
			const child = captured.get()
			await child.turn.entered
			expect(requestFor(fixture, child.task.taskId).configuration).toMatchObject({
				apiProvider: "openai",
				openAiModelId: "target-effort-model",
				openAiApiKey: parentProfile.openAiApiKey,
			})
			expect(child.task.reasoningPreference).toEqual({ kind: "default" })
			expect(child.task.getReasoningState().effective).toEqual({ kind: "effort", effort: "medium" })
			expect(requestFor(fixture, child.task.taskId).configuration.reasoningEffort).not.toBe("high")
			expect(fixture.root.reasoningPreference).toEqual({ kind: "effort", effort: "high" })
			child.turn.release()
			await child.task.waitForTermination()
		} finally {
			captured.dispose()
		}
	})

	it("passes native create_thread provider, profile, model and reasoning through to the new Task request", async () => {
		const fixture = await createFixture(newChatRequest)
		const originalConfiguration = structuredClone(fixture.root.apiConfiguration)
		const captured = captureIndependentTurn(fixture)
		const toolCallId = "create-selected-thread"
		const firstParentTurn = fixture.queueTurn(fixture.root.taskId, "Launch the requested chat.", [
			{
				type: "tool_call",
				id: toolCallId,
				name: "create_thread",
				arguments: JSON.stringify({
					prompt: "Review a separate problem.",
					provider: "anthropic",
					profile: targetProfile.name,
					model: targetProfile.apiModelId,
					reasoning_effort: "low",
				}),
			},
		])
		const finalParentTurn = fixture.queueTurn(fixture.root.taskId, "Created the requested chat.")
		try {
			fixture.root.start()
			await firstParentTurn.entered
			firstParentTurn.release()
			await finalParentTurn.entered
			const child = captured.get()
			await child.turn.entered
			const results = fixture.root.apiConversationHistory.flatMap((message) =>
				message.role === "user" && Array.isArray(message.content)
					? message.content.filter(
							(block) => block.type === "tool_result" && block.tool_use_id === toolCallId,
						)
					: [],
			)
			expect(results).toHaveLength(1)
			const receipt = results[0]
			if (receipt.type !== "tool_result") throw new Error("The native new-chat call must retain its tool result")
			expect(receipt.is_error).not.toBe(true)
			const text =
				typeof receipt.content === "string"
					? receipt.content
					: receipt.content?.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
			expect(JSON.parse(text ?? "")).toEqual({ threadId: child.task.taskId })
			expect(requestFor(fixture, child.task.taskId).configuration).toMatchObject({
				apiProvider: "anthropic",
				apiKey: targetProfile.apiKey,
				anthropicBaseUrl: targetProfile.anthropicBaseUrl,
				apiModelId: targetProfile.apiModelId,
				reasoningEffort: "low",
			})
			expect(await child.task.getTaskApiConfigName()).toBe(targetProfile.name)
			expect(child.task.getTaskApprovalMode()).toBe(fixture.root.getTaskApprovalMode())
			expect(child.task.getReasoningState().effective).toEqual({ kind: "effort", effort: "low" })
			expect(fixture.root.apiConfiguration).toEqual(originalConfiguration)
			expect(fixture.root.reasoningPreference).toEqual({ kind: "effort", effort: "high" })
			await finishIndependent(child)
			finalParentTurn.release()
			await fixture.root.waitForTermination()
		} finally {
			captured.dispose()
		}
	})

	it("restores a cold new chat's saved profile, selected model and explicit effort when its account defaults change", async () => {
		const fixture = await createFixture(newChatRequest)
		const child = await createIndependent(fixture, {
			provider: "anthropic",
			profile: targetProfile.id,
			model: targetProfile.apiModelId,
			reasoningEffort: "low",
		})
		await finishIndependent(child)
		const saved = (await fixture.provider.getTaskWithId(child.task.taskId)).historyItem
		expect(routeFields(saved)).toMatchObject({
			apiConfigName: targetProfile.name,
			threadModelOverride: targetProfile.apiModelId,
			threadModelRoute: {
				profileId: targetProfile.id,
				provider: "anthropic",
				modelId: targetProfile.apiModelId,
				requestedReasoningEffort: "low",
			},
		})
		expect(JSON.stringify(saved)).not.toContain(targetProfile.apiKey)
		expect(JSON.stringify(saved)).not.toContain(parentProfile.openAiApiKey)
		await fixture.provider.removeTaskFromStack({ taskId: child.task.taskId })
		expect(fixture.provider.getLiveTask(child.task.taskId)).toBeUndefined()
		fixture.profiles.set(targetProfile.id, {
			...targetProfile,
			apiKey: "fixture-rotated-target-key",
			apiModelId: "claude-sonnet-5-5",
			reasoningEffort: "high",
			enableReasoningEffort: true,
		})
		const restored = captureIndependentTurn(fixture)
		try {
			await fixture.provider.sendIndependentTaskMessage(
				fixture.root,
				child.task.taskId,
				"Continue the saved review.",
			)
			const successor = restored.get()
			await successor.turn.entered
			expect(successor.task).not.toBe(child.task)
			expect(successor.task.taskId).toBe(child.task.taskId)
			expect(requestFor(fixture, child.task.taskId).configuration).toMatchObject({
				apiProvider: "anthropic",
				apiKey: "fixture-rotated-target-key",
				apiModelId: targetProfile.apiModelId,
				reasoningEffort: "low",
			})
			expect(successor.task.getTaskApprovalMode()).toBe(child.task.getTaskApprovalMode())
			expect(successor.task.getReasoningState().effective).toEqual({ kind: "effort", effort: "low" })
			expect(fixture.root.apiConfiguration).toEqual(configuration(parentProfile))
			await finishIndependent(successor)
		} finally {
			restored.dispose()
		}
	})

	it("preserves an existing idle chat's explicit effort when only its model changes", async () => {
		const fixture = await createFixture(newChatRequest)
		const child = await createIndependent(fixture, { model: "initial-effort-model" })
		await child.task.updateReasoningPreference({ kind: "effort", effort: "low" })
		await finishIndependent(child)
		const next = fixture.queueTurn(child.task.taskId, "The new model retained the existing chat's effort.")
		await fixture.provider.sendIndependentTaskMessage(fixture.root, child.task.taskId, "Review the next case.", {
			model: "followup-effort-model",
		})
		await next.entered
		expect(requestFor(fixture, child.task.taskId).configuration).toMatchObject({
			apiProvider: "openai",
			openAiApiKey: parentProfile.openAiApiKey,
			openAiBaseUrl: parentProfile.openAiBaseUrl,
			openAiModelId: "followup-effort-model",
			reasoningEffort: "low",
		})
		expect(child.task.getReasoningState().effective).toEqual({ kind: "effort", effort: "low" })
		expect(fixture.root.reasoningPreference).toEqual({ kind: "effort", effort: "high" })
		await finishIndependent({ task: child.task, turn: next })
	})

	it("rejects busy route changes and failed idle constructions while retaining the prior handler and saved selection", async () => {
		const fixture = await createFixture(newChatRequest)
		const child = await createIndependent(fixture, { model: "initial-effort-model" })
		await child.task.updateReasoningPreference({ kind: "effort", effort: "low" })
		const originalHandler = child.task.api
		const originalConfiguration = structuredClone(child.task.apiConfiguration)
		const originalPreference = structuredClone(child.task.reasoningPreference)
		const originalRoute = routeFields((await fixture.provider.getTaskWithId(child.task.taskId)).historyItem)
		await expect(
			fixture.provider.sendIndependentTaskMessage(
				fixture.root,
				child.task.taskId,
				"BUSY_INPUT_MUST_NOT_BE_ACCEPTED",
				{
					model: "busy-replacement-model",
				},
			),
		).rejects.toThrow(/idle/)
		expect(child.task.api).toBe(originalHandler)
		expect(child.task.apiConfiguration).toEqual(originalConfiguration)
		await finishIndependent(child)
		fixture.rejectedModels.add("rejected-fixture-model")
		await expect(
			fixture.provider.sendIndependentTaskMessage(
				fixture.root,
				child.task.taskId,
				"FAILED_INPUT_MUST_NOT_BE_ACCEPTED",
				{
					model: "rejected-fixture-model",
				},
			),
		).rejects.toThrow("The scripted provider rejected the selected model")
		expect(child.task.api).toBe(originalHandler)
		expect(child.task.apiConfiguration).toEqual(originalConfiguration)
		expect(child.task.reasoningPreference).toEqual(originalPreference)
		expect(routeFields((await fixture.provider.getTaskWithId(child.task.taskId)).historyItem)).toEqual(
			originalRoute,
		)
		const messages = await readApiMessages({ taskId: child.task.taskId, globalStoragePath: fixture.storagePath })
		expect(JSON.stringify(messages)).not.toContain("INPUT_MUST_NOT_BE_ACCEPTED")
	})

	it("cleans up a real cold provisional runtime when its replacement provider rejects admission after hydration", async () => {
		const fixture = await createFixture(newChatRequest)
		const child = await createIndependent(fixture, { model: "initial-effort-model" })
		await child.task.updateReasoningPreference({ kind: "effort", effort: "low" })
		await finishIndependent(child)
		await fixture.provider.removeTaskFromStack({ taskId: child.task.taskId })
		const saved = (await fixture.provider.getTaskWithId(child.task.taskId)).historyItem
		const storage = { taskId: child.task.taskId, globalStoragePath: fixture.storagePath }
		const originalTranscript = await readApiMessages(storage)
		const originalUi = await readTaskMessages(storage)
		let provisional: Task | undefined
		const rejectAfterHydration = (created: TaskLike) => {
			if (created.taskId !== child.task.taskId) return
			if (!(created instanceof Task)) throw new Error("Cold restoration must create a real Task")
			provisional = created
			// Model discovery succeeded, but this account becomes unavailable before
			// the owning host commits the new route. No task or storage method is replaced.
			fixture.rejectedModels.add("rejected-fixture-model")
		}
		fixture.provider.on(AlphaCodeEventName.TaskCreated, rejectAfterHydration)
		try {
			await expect(
				fixture.provider.sendIndependentTaskMessage(fixture.root, child.task.taskId, "FAILED_COLD_INPUT", {
					model: "rejected-fixture-model",
				}),
			).rejects.toThrow("The scripted provider rejected the selected model")
			expect(provisional).toBeInstanceOf(Task)
			expect(fixture.provider.getLiveTask(child.task.taskId) === undefined).toBe(true)
			expect(fixture.taskSessions.canCreateTask()).toBe(true)
			expect(routeFields((await fixture.provider.getTaskWithId(child.task.taskId)).historyItem)).toEqual(
				routeFields(saved),
			)
			expect(fixture.requests.filter((request) => request.taskId === child.task.taskId)).toHaveLength(1)
			const messages = await readApiMessages(storage)
			expect(messages).toEqual(originalTranscript)
			expect(await readTaskMessages(storage)).toEqual(originalUi)
			expect(JSON.stringify(messages)).not.toContain("FAILED_COLD_INPUT")
		} finally {
			fixture.provider.off(AlphaCodeEventName.TaskCreated, rejectAfterHydration)
		}
	})
})
