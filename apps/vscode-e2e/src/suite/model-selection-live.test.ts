import assert from "node:assert/strict"
import { randomInt, randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as vscode from "vscode"
import {
	AlphaCodeEventName,
	getVscodeLlmModelInfo,
	toolNames,
	type AlphaMessage,
	type HistoryItem,
	type ProviderSettings,
	type ProviderSettingsWithId,
	type TaskReasoningState,
} from "@alpha-code/types"

import { readBoundedJson } from "../scenarios/extensionWorkflowHost"
import { guardTaskApi, WorkflowRequestBudget } from "../scenarios/requestBudget"
import { inspectToolTransactions } from "../scenarios/transactionAssertions"
import { assertOwnedTestWorkspace } from "../testProfile"
import { record } from "./live-file-tool-support"
import { finalAssistantResponse } from "./live-transcript-support"
import { createCompletionReviewAcknowledger, withBoundedFixtureCleanup } from "./proportional-context-support"
import { waitFor } from "./utils"

interface ModelTask {
	taskId: string
	taskKind: string
	parentTaskId?: string
	orchestrationParentTaskId?: string
	api: unknown
	apiConfiguration: ProviderSettings
	didComplete: boolean
	taskAsk?: AlphaMessage
	alphaMessages: AlphaMessage[]
	approveAsk(): void
	getReasoningState(): TaskReasoningState
	waitForTermination(): Promise<void>
	flushApiConversationHistoryPersistence(): Promise<void>
}

interface ModelProvider {
	providerSettingsManager: {
		saveConfig(name: string, configuration: ProviderSettingsWithId): Promise<string>
		getProfile(query: { id: string }): Promise<ProviderSettingsWithId & { name: string }>
		deleteConfig(name: string, options: { expectedId: string }): Promise<unknown>
	}
	on(event: "taskCreated", listener: (task: ModelTask) => void): void
	off(event: "taskCreated", listener: (task: ModelTask) => void): void
	getTaskWithId(id: string): Promise<{ taskDirPath: string; historyItem: HistoryItem }>
	closeTask(id: string): Promise<void>
}

function toolCalls(history: unknown): Record<string, unknown>[] {
	assert.ok(Array.isArray(history))
	return history.flatMap((message) => {
		const content = record(message).content
		return Array.isArray(content) ? content.map(record).filter((part) => part.type === "tool_use") : []
	})
}

function terminalAnswer(history: unknown): string {
	const response = finalAssistantResponse(history)
	if (response.toolCallCount === 0) return response.text
	const completion = toolCalls(history).at(-1)
	assert.equal(completion?.name, "attempt_completion", "Only accepted completion intent can supply the final answer")
	const result = record(completion!.input).result
	assert.equal(typeof result, "string")
	return String(result)
}

function profileDiscoveries(history: unknown): { profile: Record<string, unknown>; resultMessageIndex: number }[] {
	assert.ok(Array.isArray(history))
	const discoveryCalls = new Set(
		toolCalls(history)
			.filter((call) => call.name === "list_provider_profiles")
			.map((call) => call.id),
	)
	return history.flatMap((message, resultMessageIndex) => {
		const content = record(message).content
		if (!Array.isArray(content)) return []
		return content.flatMap((value) => {
			const part = record(value)
			if (part.type !== "tool_result" || !discoveryCalls.has(part.tool_use_id)) return []
			assert.notEqual(part.is_error, true, "Saved-profile discovery must succeed")
			const text =
				typeof part.content === "string"
					? part.content
					: Array.isArray(part.content)
						? part.content
								.map((block) => record(block).text)
								.filter((text) => typeof text === "string")
								.join("\n")
						: ""
			const result = record(JSON.parse(text))
			assert.ok(Array.isArray(result.profiles), "Profile discovery must return structured saved metadata")
			return result.profiles.map((profile) => ({ profile: record(profile), resultMessageIndex }))
		})
	})
}

function toolCallMessageIndex(history: unknown, id: unknown): number {
	assert.ok(Array.isArray(history))
	return history.findIndex((message) => {
		const content = record(message).content
		return (
			Array.isArray(content) && content.some((part) => record(part).type === "tool_use" && record(part).id === id)
		)
	})
}

suite("Live conversational model selection", function () {
	this.timeout(420_000)

	for (const kind of ["subagent", "thread"] as const) {
		for (const selection of ["model", "profile"] as const) {
			const byProfile = selection === "profile"
			test(
				byProfile
					? `a normal prompt discovers a new saved profile and launches its configured ${kind}`
					: `a normal prompt launches a different-model ${kind} with independent reasoning`,
				async () => {
					assert.equal(
						process.env.ALPHA_E2E_PROVIDER_MODE,
						"live-copilot",
						"Real model decisions are required",
					)
					assert.equal(vscode.version, "1.138.0")
					assert.equal(process.env.ALPHA_E2E_EXPECTED_VSCODE_VERSION, "1.138.0")
					const workspace = process.env.ALPHA_E2E_WORKSPACE!
					await assertOwnedTestWorkspace(workspace, process.env.ALPHA_E2E_PROFILE_DIR)
					const parentModelId = process.env.ALPHA_E2E_ACTUAL_MODEL_ID
					const parentEffort = process.env.ALPHA_E2E_ACTUAL_REASONING_EFFORT
					const targetModelId = process.env.ALPHA_E2E_ROUTING_TARGET_MODEL_ID
					const targetEffort = "high"
					assert.ok(parentModelId && parentEffort, "The runner must select an exact parent model and effort")
					assert.ok(targetModelId, "Set ALPHA_E2E_ROUTING_TARGET_MODEL_ID to an exact discovered Copilot ID")
					assert.notEqual(parentModelId, targetModelId)
					assert.notEqual(
						parentEffort,
						targetEffort,
						"Different efforts must expose accidental parent inheritance",
					)
					const models = await vscode.lm.selectChatModels({ vendor: "copilot" })
					const parentModel = models.find((model) => model.id === parentModelId)
					const targetModel = models.find((model) => model.id === targetModelId)
					assert.ok(parentModel && targetModel, "Both exact models must exist in the saved profile")
					assert.equal(models.filter((model) => model.id === targetModelId).length, 1)
					const targetEfforts = getVscodeLlmModelInfo(targetModel)?.supportsReasoningEffort
					assert.ok(
						Array.isArray(targetEfforts) && targetEfforts.includes(targetEffort),
						"Choose a target whose requested effort is defined in Alpha's Copilot catalog",
					)
					const left = randomInt(13, 40)
					const right = randomInt(41, 80)
					const expected = left * right
					const profileName = `Live review ${randomUUID()}`
					let profileId: string | undefined
					const requestLimit = byProfile ? 14 : 12
					// No injected tool calls, model aliases, or prewritten responses: the live parent interprets this request.
					const prompt = byProfile
						? kind === "subagent"
							? `Please find my saved profile "${profileName}" and use it to launch one subagent. Use the model and reasoning already configured in that profile. Have it work out ${left} times ${right}, wait for its answer, then tell me the result here. Keep this chat on its current profile and model. No file changes or commands are needed.`
							: `Please find my saved profile "${profileName}" and use it to create a new thread in Alpha. Use that profile's configured model and reasoning. Ask the new thread to work out ${left} times ${right}, wait for its answer, and tell me the result here. Keep this chat on its current profile and model. No file changes or commands are needed.`
						: kind === "subagent"
							? `Please launch one subagent using ${targetModel.name} on GitHub Copilot with high reasoning. Have it independently work out ${left} times ${right}, wait for its answer, and tell me the result. Keep this chat on ${parentModel.name}. No file changes or commands are needed.`
							: `Please create a new thread in Alpha using ${targetModel.name} with high reasoning, using GitHub Copilot as the provider. Ask the new thread to work out ${left} times ${right}. Wait for its answer and tell me the result here. Keep this chat on ${parentModel.name}. No file changes or commands are needed.`
					const api = globalThis.api
					const provider = (api as unknown as { sidebarProvider: ModelProvider }).sidebarProvider
					const original = api.getConfiguration()
					assert.equal(original.apiProvider, "vscode-lm")
					assert.equal(original.vsCodeLmModelSelector?.id, parentModelId)
					const created = new Map<string, ModelTask>()
					const budgets = new Map<string, WorkflowRequestBudget>()
					const completed = new Map<string, number>()
					const acknowledgers = new Map<string, ReturnType<typeof createCompletionReviewAcknowledger>>()
					const releases: Array<() => void> = []
					const dispatches: {
						taskId: string
						modelId: string
						family: unknown
						effort: unknown
						tools: string[]
					}[] = []
					let rootId: string | undefined
					let passed = false
					let failure: string | undefined
					const onCreated = (task: ModelTask) => {
						created.set(task.taskId, task)
						rootId ??= task.taskId
						const isRoot = task.taskId === rootId
						const budget = new WorkflowRequestBudget(
							isRoot ? requestLimit - 4 : 4,
							isRoot ? parentModelId : targetModelId,
							isRoot ? parentEffort : targetEffort,
						)
						budget.onTaskRequest = (client, _messages, options) => {
							assert.ok(created.size <= 2, "Exactly one secondary task is requested")
							assert.ok(dispatches.length < requestLimit, "Shared live request cap exceeded")
							const modelOptions = record(record(options).modelOptions)
							const tools = record(options).tools
							const toolNames = Array.isArray(tools) ? tools.map((tool) => String(record(tool).name)) : []
							if (isRoot && !dispatches.some((request) => request.taskId === task.taskId)) {
								assert.ok(
									toolNames.includes(kind === "subagent" ? "spawn_agent" : "create_thread"),
									"The initial parent request must expose the authorized launch tool",
								)
								if (byProfile)
									assert.ok(
										toolNames.includes("list_provider_profiles"),
										"The live parent must receive saved-profile discovery",
									)
							}
							dispatches.push({
								taskId: task.taskId,
								modelId: String(client.id),
								family: client.family,
								effort: modelOptions.reasoningEffort,
								tools: toolNames,
							})
						}
						budgets.set(task.taskId, budget)
						acknowledgers.set(task.taskId, createCompletionReviewAcknowledger())
						releases.push(guardTaskApi(task, budget))
					}
					const onCompleted = (id: string) => completed.set(id, (completed.get(id) ?? 0) + 1)
					provider.on("taskCreated", onCreated)
					api.on(AlphaCodeEventName.TaskCompleted, onCompleted)
					const allowed = new Set<string>([
						"attempt_completion",
						"list_provider_profiles",
						...(kind === "subagent"
							? (["spawn_agent", "wait_agent"] as const)
							: (["create_thread", "wait_threads", "read_thread"] as const)),
					])
					const policyAllowed = new Set(allowed)
					// Saved exclusions for retired task tools also exclude their replacements.
					// Keep those names enabled in this fixture without exposing historical schemas.
					if (kind === "thread") {
						policyAllowed.add("create_task")
						policyAllowed.add("wait_task")
					}
					await withBoundedFixtureCleanup(async () => {
						try {
							if (byProfile) {
								// The real save path is deliberate: patching the presentation cache would hide discovery bugs.
								profileId = await provider.providerSettingsManager.saveConfig(profileName, {
									apiProvider: "vscode-lm",
									vsCodeLmModelSelector: {
										vendor: "copilot",
										id: targetModelId,
										family: targetModel.family,
									},
									enableReasoningEffort: true,
									reasoningEffort: targetEffort,
								})
								assert.ok(profileId)
								const savedProfile = await provider.providerSettingsManager.getProfile({
									id: profileId,
								})
								assert.equal(savedProfile.name, profileName)
								assert.equal(savedProfile.vsCodeLmModelSelector?.id, targetModelId)
							}
							const id = await api.startNewTask({
								text: prompt,
								presentationModelCalls: false,
								configuration: {
									...original,
									mode: "code",
									approvalMode: "auto",
									autoApprovalEnabled: true,
									alwaysAllowSubagents: true,
									alwaysAllowSubtasks: true,
									alwaysAllowReadOnly: true,
									alwaysAllowWrite: false,
									alwaysAllowExecute: false,
									alwaysAllowMcp: false,
									alwaysAllowFollowupQuestions: false,
									mcpEnabled: false,
									subagentsEnabled: true,
									maxConcurrentSubagents: 1,
									maxConcurrentTasks: 3,
									allowedMaxRequests: requestLimit,
									disabledTools: toolNames.filter((name) => !policyAllowed.has(name)),
									enableCheckpoints: false,
									requestDelaySeconds: 0,
								},
							})
							assert.equal(id, rootId)
							await waitFor(
								() => {
									for (const [id, task] of created) {
										const budget = budgets.get(id)!
										if (budget.failure) throw budget.failure
										assert.equal(budget.exhausted, false, "Live request budget exhausted")
										const ask = task.taskAsk
										if (ask && !ask.partial && !ask.isAnswered && !task.didComplete)
											assert.equal(
												ask.ask,
												"completion_result",
												`Unexpected live boundary: ${ask.ask}`,
											)
										acknowledgers.get(id)!(task)
									}
									if (completed.get(id) === 1)
										assert.equal(
											created.size,
											2,
											"The parent completed without launching the requested secondary task",
										)
									return (
										created.size === 2 && [...created.keys()].every((id) => completed.get(id) === 1)
									)
								},
								{
									timeout: 180_000,
									interval: 100,
									description: `live different-model ${kind} and parent completion`,
									onTimeout: () => ({
										tasks: [...created.values()].map((task) => ({
											id: task.taskId,
											kind: task.taskKind,
											completed: completed.get(task.taskId),
											ask: task.taskAsk?.ask,
											reasoning: task.getReasoningState(),
										})),
										dispatches,
									}),
								},
							)
							const root = created.get(id)!
							const secondary = [...created.values()].find((task) => task.taskId !== id)!
							assert.equal(secondary.taskKind, kind === "subagent" ? "subagent" : "primary")
							assert.equal(
								kind === "subagent" ? secondary.parentTaskId : secondary.orchestrationParentTaskId,
								id,
							)
							assert.equal(root.apiConfiguration.vsCodeLmModelSelector?.id, parentModelId)
							assert.equal(root.apiConfiguration.apiProvider, original.apiProvider)
							assert.deepEqual(
								root.apiConfiguration.vsCodeLmModelSelector,
								original.vsCodeLmModelSelector,
							)
							assert.deepEqual(root.getReasoningState().effective, {
								kind: "effort",
								effort: parentEffort,
							})
							assert.deepEqual(secondary.getReasoningState().effective, {
								kind: "effort",
								effort: targetEffort,
							})
							for (const task of created.values()) {
								await task.waitForTermination()
								await task.flushApiConversationHistoryPersistence()
								const saved = await provider.getTaskWithId(task.taskId)
								const history = await readBoundedJson(
									path.join(saved.taskDirPath, "api_conversation_history.json"),
								)
								assert.deepEqual(inspectToolTransactions(history).errors, [])
								assert.match(terminalAnswer(history), new RegExp(`\\b${expected}\\b`))
								assert.ok(
									dispatches.some((request) => request.taskId === task.taskId),
									"Each task must send a real request",
								)
								const calls = toolCalls(history)
								assert.ok(calls.every((call) => allowed.has(String(call.name))))
								if (task === root) {
									const launches = calls.filter(
										(call) => call.name === (kind === "subagent" ? "spawn_agent" : "create_thread"),
									)
									assert.equal(launches.length, 1)
									const selected = record(launches[0]!.input)
									if (byProfile) {
										const discovery = profileDiscoveries(history).find(
											({ profile }) => profile.id === profileId,
										)
										assert.ok(discovery, "The live parent must discover the newly saved profile")
										const discovered = discovery.profile
										assert.equal(discovered.name, profileName)
										assert.equal(discovered.provider, "vscode-lm")
										assert.equal(discovered.model, targetModelId)
										assert.ok(
											selected.profile === profileId || selected.profile === profileName,
											"Use the discovered stable profile ID or exact saved name",
										)
										assert.equal(
											selected.model ?? undefined,
											undefined,
											"The saved profile supplies its configured model",
										)
										assert.equal(
											selected.reasoning_effort ?? undefined,
											undefined,
											"The saved profile supplies its configured reasoning",
										)
										assert.ok(
											discovery.resultMessageIndex <
												toolCallMessageIndex(history, launches[0]!.id),
											"The model must receive the discovered profile before choosing its launch arguments",
										)
									} else {
										assert.equal(selected.model, targetModelId)
										assert.equal(selected.reasoning_effort, targetEffort)
									}
									assert.ok(
										calls.some(
											(call) =>
												call.name === (kind === "subagent" ? "wait_agent" : "wait_threads"),
										),
										"The live parent must collect the secondary result",
									)
								} else {
									const route =
										kind === "subagent"
											? saved.historyItem.subagentContextManifest?.modelRoute
											: saved.historyItem.threadModelRoute
									assert.equal(route?.provider, "vscode-lm")
									assert.equal(route?.modelId, targetModelId)
									if (byProfile) {
										assert.equal(route?.profileId, profileId)
										assert.equal(route?.profileName, profileName)
										assert.equal(route?.requestedReasoningEffort, undefined)
										assert.deepEqual(route?.reasoningConfiguration, {
											enableReasoningEffort: true,
											reasoningEffort: targetEffort,
										})
									} else assert.equal(route?.requestedReasoningEffort, targetEffort)
								}
							}
							passed = true
						} catch (error) {
							failure = error instanceof Error ? error.message : String(error)
							throw error
						} finally {
							await fs.writeFile(
								path.join(
									process.env.ALPHA_E2E_ARTIFACTS_DIR!,
									`live-${selection}-selection-${kind}.json`,
								),
								JSON.stringify(
									{
										schemaVersion: 1,
										passed,
										failure,
										hostVersion: vscode.version,
										profileDir: process.env.ALPHA_E2E_PROFILE_DIR,
										provider: "vscode-lm",
										vendor: "copilot",
										decisions: "live-model",
										prompt,
										expected,
										parentModelId,
										parentEffort,
										targetModelId,
										targetEffort,
										selection,
										...(byProfile
											? {
													savedProfile: { id: profileId, name: profileName },
													limitation:
														"Copilot parent and child; ChatGPT parent is not exercised",
												}
											: {}),
										requestLimit,
										dispatches,
										tasks: [...created.values()].map((task) => ({
											taskId: task.taskId,
											kind: task.taskKind,
											reasoning: task.getReasoningState(),
										})),
										completions: Object.fromEntries(completed),
									},
									null,
									2,
								),
								{ flag: "wx" },
							)
						}
					}, [
						async () => {
							for (const task of [...created.values()].reverse())
								if (task.taskKind === "primary") await provider.closeTask(task.taskId)
						},
						() => provider.off("taskCreated", onCreated),
						() => api.off(AlphaCodeEventName.TaskCompleted, onCompleted),
						() => {
							for (const release of releases.reverse()) release()
						},
						() => api.setConfiguration(original),
						async () => {
							if (profileId)
								await provider.providerSettingsManager.deleteConfig(profileName, {
									expectedId: profileId,
								})
						},
					])
				},
			)
		}
	}
})
