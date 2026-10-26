import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as vscode from "vscode"

import {
	AlphaCodeEventName,
	agentLifecycleEventSchema,
	type AlphaCodeSettings,
	type TaskReasoningPreference,
	type TaskReasoningProjection,
} from "@alpha-code/types"

import { readBoundedJson } from "../scenarios/extensionWorkflowHost"
import { inspectTaskLifecycle, inspectToolTransactions } from "../scenarios/transactionAssertions"
import { withBoundedFixtureCleanup } from "./proportional-context-support"
import { assertRequestedHostVersion, setDefaultSuiteTimeout } from "./test-utils"
import { waitFor } from "./utils"

const MODEL_ID = "alpha-e2e-fixture-claude-sonnet-4.6"
const MODEL_FAMILY = "claude-sonnet-4.6"
const CALL_ID = "alpha-e2e-claude-read-1"
const PROOF_FILE = "alpha-e2e-claude-read-proof.txt"
const PROOF = "ALPHA_E2E_CLAUDE_READ_PROOF"
const READ_COMMAND = `rg --no-config -n ${PROOF} ${PROOF_FILE}`

interface FixturePart {
	kind: string
	value?: string | string[]
	id?: string
	metadata?: Record<string, unknown>
	callId?: string
	name?: string
	input?: unknown
	content?: FixturePart[]
}

interface FixtureRequest {
	modelId: string
	modelOptions?: { reasoningEffort?: string; _enableThinking?: boolean }
	includeEncryptedThinking?: boolean
	messages: Array<{ role: vscode.LanguageModelChatMessageRole; parts: FixturePart[] }>
	tools: string[]
}

interface FixtureControl {
	reset(scenario: "claude-tool-followup", options: { holdRequestIndexes: number[] }): void
	getRequests(): FixtureRequest[]
	releaseRequest(index: number): void
	releaseAll(): void
}

interface ContractTask {
	apiConfiguration: AlphaCodeSettings
	isInitialized?: boolean
	taskAsk?: { ask?: string }
	approveAsk(): void
	waitForTermination(): Promise<void>
	flushApiConversationHistoryPersistence(): Promise<void>
}

interface ContractProvider {
	getLiveTask(taskId: string): ContractTask | undefined
	getTaskWithId(taskId: string): Promise<{
		taskDirPath: string
		historyItem: { reasoningPreference?: TaskReasoningPreference }
	}>
	showTaskWithId(taskId: string): Promise<void>
	setTaskReasoningPreference(
		taskId: string | undefined,
		preference: TaskReasoningPreference,
	): Promise<TaskReasoningProjection>
}

const thinking = [
	{
		value: "Inspect the Claude fixture",
		id: "claude-thinking-1",
		metadata: { vscode_thinking_origin_api: "messages" },
	},
	{
		value: "",
		id: "claude-thinking-1",
		metadata: {
			encrypted_content: "synthetic-claude-encrypted-state",
			vscode_thinking_origin_api: "messages",
		},
	},
	{
		value: "",
		id: "",
		metadata: {
			vscode_reasoning_done: true,
			vscode_thinking_origin_api: "messages",
		},
	},
]

function assertClaudeReplay(request: FixtureRequest): void {
	assert.equal(request.modelId, MODEL_ID, "The task must keep its exact synthetic Claude model")
	const assistantIndex = request.messages.findIndex(({ parts }) =>
		parts.some((part) => part.kind === "tool_call" && part.callId === CALL_ID),
	)
	assert.ok(assistantIndex >= 0, "The Claude continuation omitted the accepted tool call")
	assert.equal(request.messages[assistantIndex]!.role, vscode.LanguageModelChatMessageRole.Assistant)
	assert.deepEqual(request.messages[assistantIndex]!.parts, [
		...thinking.map((part) => ({ kind: "thinking", ...part })),
		{ kind: "tool_call", callId: CALL_ID, name: "exec_command", input: { cmd: READ_COMMAND } },
	])
	const receipts = request.messages.flatMap(({ parts }, messageIndex) =>
		parts
			.filter((part) => part.kind === "tool_result" && part.callId === CALL_ID)
			.map((part) => ({ part, messageIndex })),
	)
	assert.equal(receipts.length, 1, "The Claude continuation must contain exactly one matching terminal receipt")
	assert.equal(receipts[0]!.messageIndex, assistantIndex + 1)
	assert.equal(request.messages[receipts[0]!.messageIndex]!.role, vscode.LanguageModelChatMessageRole.User)
	assert.ok(receipts[0]!.part.content?.some((part) => typeof part.value === "string" && part.value.includes(PROOF)))
}

suite("Claude Copilot deterministic extension-host contract", function () {
	setDefaultSuiteTimeout(this)
	let fixture: FixtureControl
	let provider: ContractProvider

	suiteSetup(async () => {
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "vscode-lm-fixture")
		assert.equal(
			assertRequestedHostVersion(vscode.version, process.env.ALPHA_E2E_EXPECTED_VSCODE_VERSION),
			"1.138.0",
		)
		const fixtureId = process.env.ALPHA_E2E_VSCODE_LM_FIXTURE_ID
		assert.ok(fixtureId, "The deterministic Claude suite requires the runner-owned fixture")
		const extension = vscode.extensions.getExtension<FixtureControl>(fixtureId)
		assert.ok(extension)
		fixture = extension.isActive ? extension.exports : await extension.activate()
		const host = globalThis.api as unknown as { sidebarProvider?: ContractProvider }
		assert.ok(host.sidebarProvider)
		provider = host.sidebarProvider
	})

	test("requests and replays encrypted Claude thinking after a real tool result and saved-task reload", async () => {
		const selected = await vscode.lm.selectChatModels({ vendor: "copilot", id: MODEL_ID })
		assert.equal(selected.length, 1)
		assert.equal(selected[0]!.id, MODEL_ID)
		assert.equal(selected[0]!.vendor, "copilot")
		assert.equal(selected[0]!.family, MODEL_FAMILY)
		const workspace = vscode.workspace.workspaceFolders?.[0]
		assert.ok(workspace)
		const proofPath = path.join(workspace.uri.fsPath, PROOF_FILE)
		await fs.writeFile(proofPath, `${PROOF}\n`, { encoding: "utf8", flag: "wx" })
		fixture.reset("claude-tool-followup", { holdRequestIndexes: [0, 1, 2] })
		const completed = new Map<string, number>()
		const onCompleted = (taskId: string) => completed.set(taskId, (completed.get(taskId) ?? 0) + 1)
		globalThis.api.on(AlphaCodeEventName.TaskCompleted, onCompleted)

		await withBoundedFixtureCleanup(async () => {
			const taskId = await globalThis.api.startNewTask({
				configuration: {
					...globalThis.api.getConfiguration(),
					apiProvider: "vscode-lm",
					vsCodeLmModelSelector: { vendor: "copilot", family: MODEL_FAMILY, id: MODEL_ID, version: "1.0.0" },
					enableReasoningEffort: true,
					reasoningEffort: "high",
					newTaskReasoningPreference: { kind: "default" },
					mode: "code",
					autoApprovalEnabled: true,
					alwaysAllowReadOnly: true,
					alwaysAllowExecute: true,
					allowedCommands: [READ_COMMAND],
					requestDelaySeconds: 0,
					writeDelayMs: 0,
					enableCheckpoints: false,
				},
				text: "Read the Claude fixture proof using the available command, then finish briefly.",
			})
			const waitForRequests = (count: number) =>
				waitFor(() => fixture.getRequests().length >= count, {
					interval: 25,
					description: `Claude fixture request ${count}`,
				})
			const finishTurn = async (count: number) => {
				await waitFor(
					() =>
						(completed.get(taskId) ?? 0) >= count ||
						["completion_result", "resume_completed_task"].includes(
							provider.getLiveTask(taskId)?.taskAsk?.ask ?? "",
						),
					{ interval: 25, description: `Claude task completion ${count}` },
				)
				if ((completed.get(taskId) ?? 0) < count) provider.getLiveTask(taskId)!.approveAsk()
				await waitFor(() => (completed.get(taskId) ?? 0) >= count, {
					interval: 25,
					description: `Claude completion event ${count}`,
				})
				const task = provider.getLiveTask(taskId)!
				await task.waitForTermination()
				await task.flushApiConversationHistoryPersistence()
			}

			await waitForRequests(1)
			const firstTask = provider.getLiveTask(taskId)
			assert.ok(firstTask)
			const first = fixture.getRequests()[0]!
			assert.equal(first.modelId, MODEL_ID)
			assert.equal(first.modelOptions?.reasoningEffort, "high")
			assert.equal(first.modelOptions?._enableThinking, true)
			assert.equal(first.includeEncryptedThinking, true)
			assert.ok(first.tools.includes("exec_command"))
			assert.ok(first.tools.includes("apply_patch"))
			assert.ok(!first.tools.includes("edit"))
			assert.ok(!first.tools.includes("switch_mode"))
			fixture.releaseRequest(0)
			await waitForRequests(2)
			assertClaudeReplay(fixture.getRequests()[1]!)
			fixture.releaseRequest(1)
			await finishTurn(1)

			const { taskDirPath } = await provider.getTaskWithId(taskId)
			const history = await readBoundedJson(path.join(taskDirPath, "api_conversation_history.json"))
			assert.deepEqual(inspectToolTransactions(history), { callCount: 1, resultCount: 1, errors: [] })
			assert.ok(Array.isArray(history))
			const assistant = history.find((message) =>
				message.content?.some?.(
					(part: { type: string; id?: string }) => part.type === "tool_use" && part.id === CALL_ID,
				),
			)
			assert.ok(assistant)
			assert.deepEqual(
				assistant.content.filter((part: { type: string }) => part.type === "vscode_lm_thinking"),
				thinking.map((part) => ({
					type: "vscode_lm_thinking",
					...part,
					modelId: MODEL_ID,
					modelVendor: "copilot",
					modelVersion: "1.0.0",
				})),
			)

			await globalThis.api.clearCurrentTask()
			await provider.showTaskWithId(taskId)
			// Selection returns before the restored Task hydrates. Match the normal workflow host's resume barrier
			// before asking the task to persist a setting, so an empty constructor transcript cannot be saved.
			await waitFor(
				() => {
					const restored = provider.getLiveTask(taskId)
					return (
						restored?.isInitialized === true &&
						["resume_task", "resume_completed_task"].includes(restored.taskAsk?.ask ?? "")
					)
				},
				{ interval: 25, description: "the saved Claude task to hydrate at its resume boundary" },
			)
			assert.notEqual(provider.getLiveTask(taskId), firstTask)
			assert.equal(fixture.getRequests().length, 2, "Reload must not start an unsolicited Claude request")
			const disabled = await provider.setTaskReasoningPreference(taskId, { kind: "off" })
			assert.deepEqual(disabled.requested, { kind: "off" })
			assert.deepEqual((await provider.getTaskWithId(taskId)).historyItem.reasoningPreference, { kind: "off" })
			await globalThis.api.sendMessage("Continue from the saved Claude read proof and finish briefly.")
			await waitForRequests(3)
			assert.deepEqual(globalThis.api.getCurrentTaskStack(), [taskId])
			const followup = fixture.getRequests()[2]!
			assertClaudeReplay(followup)
			assert.equal(followup.modelOptions?.reasoningEffort, undefined)
			assert.equal(followup.modelOptions?._enableThinking, undefined)
			assert.equal(
				followup.includeEncryptedThinking,
				true,
				"Disabling new thinking must still retain replay state",
			)
			fixture.releaseRequest(2)
			await finishTurn(2)
			assert.equal(fixture.getRequests().length, 3)
			assert.equal(completed.get(taskId), 2)
			const finalHistory = await readBoundedJson(path.join(taskDirPath, "api_conversation_history.json"))
			const events = await readBoundedJson(path.join(taskDirPath, "agent_lifecycle_events.jsonl"), true)
			assert.deepEqual(inspectToolTransactions(finalHistory), { callCount: 1, resultCount: 1, errors: [] })
			assert.deepEqual(inspectTaskLifecycle(events, taskId, { apiHistory: finalHistory }).errors, [])
			assert.ok(Array.isArray(events))
			const results = events.flatMap((value) => {
				const event = agentLifecycleEventSchema.parse(value)
				return event.type === "tool_result_recorded" && event.payload.item.toolCallId === CALL_ID
					? [event.payload.item]
					: []
			})
			assert.equal(results.length, 1)
			assert.equal(results[0]!.status, "success")
		}, [
			() => fixture.releaseAll(),
			() => globalThis.api.clearCurrentTask(),
			() => globalThis.api.off(AlphaCodeEventName.TaskCompleted, onCompleted),
			() => provider.setTaskReasoningPreference(undefined, { kind: "default" }),
			() => fs.rm(proofPath, { force: true }),
		])
	})
})
