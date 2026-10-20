import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as vscode from "vscode"
import {
	AlphaCodeEventName,
	type AlphaMessage,
	type RequestUserInputAnswerMap,
	type RequestUserInputQuestion,
} from "@alpha-code/types"
import { uiFixtureBarrier } from "../ui/fixtureBarrier"
import { waitFor } from "./utils"

const CALL_ID = "native-question-wizard-fixture"
const CUSTOM_ANSWER = "Oracle 23ai on a local Docker host; use the existing database."
const QUESTIONS: RequestUserInputQuestion[] = [
	{
		id: "app_type",
		header: "App type",
		question: "What should the first version do?",
		options: [
			{
				label: "API + CRUD (Recommended)",
				description: "A small Go HTTP API backed by Oracle, with health and sample data endpoints.",
			},
			{
				label: "Load tester",
				description: "A Go CLI that sends concurrent requests to an API you already have.",
			},
			{ label: "Both", description: "An Oracle-backed API plus a mode to generate concurrent test traffic." },
		],
	},
	{
		id: "oracle",
		header: "Oracle",
		question: "What Oracle setup should it target?",
		options: [
			{
				label: "Existing Oracle (Recommended)",
				description:
					"Share the Oracle version and whether it runs locally, in a container, or on another host.",
			},
			{
				label: "Oracle Free in Docker",
				description: "Use Oracle Database Free for a local homelab development setup.",
			},
			{
				label: "Help me choose",
				description: "Recommend a driver and setup based on your homelab environment.",
			},
		],
	},
	{
		id: "workload",
		header: "Workload",
		question: "What should the initial concurrency test look like?",
		options: [
			{
				label: "Small smoke test (Recommended)",
				description: "Start with 10 concurrent clients and a modest request count.",
			},
			{ label: "I have targets", description: "Use your expected concurrency, duration, and read/write mix." },
			{ label: "Skip for now", description: "Build the API first and add load settings later." },
		],
	},
]
const EXPECTED_ANSWERS: RequestUserInputAnswerMap = {
	app_type: { answers: [QUESTIONS[0]!.options[0]!.label] },
	oracle: { answers: [CUSTOM_ANSWER] },
	workload: { answers: [QUESTIONS[2]!.options[0]!.label] },
}
const EXPECTED_RECEIPT = {
	questions: QUESTIONS.map((question) => ({
		header: question.header,
		question: question.question,
		answers: EXPECTED_ANSWERS[question.id]!.answers,
	})),
}

interface InputTask {
	taskKind: string
	taskAsk?: AlphaMessage
	clineMessages: AlphaMessage[]
	approveAsk(): void
	waitForTermination(): Promise<void>
	flushApiConversationHistoryPersistence(): Promise<void>
}
interface InputHost {
	getLiveTask(id: string): InputTask | undefined
	showTaskWithId(id: string): Promise<void>
	getTaskWithId(id: string): Promise<{ apiConversationHistory: unknown[]; uiMessagesFilePath: string }>
	postStateToWebview(): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function resultsFor(history: unknown[], callId: string): Record<string, unknown>[] {
	return history.flatMap((message) => {
		if (!isRecord(message) || !Array.isArray(message.content)) return []
		return message.content.filter(
			(block): block is Record<string, unknown> =>
				isRecord(block) && block.type === "tool_result" && block.tool_use_id === callId,
		)
	})
}

// Request observations stay outside serializable provider settings and persisted task configuration.
const requests = new WeakMap<object, unknown[][]>()
class InputWizardAI {
	readonly id = "request-user-input-ui-scripted"
	constructor() {
		requests.set(this, [])
	}
	getRequests() {
		return requests.get(this)!
	}
	async *createMessage(_system: string, messages: unknown[], metadata?: { taskId?: string; tools?: unknown[] }) {
		assert.ok(metadata?.taskId)
		const observed = this.getRequests()
		observed.push(structuredClone(messages))
		if (observed.length === 1) {
			assert.ok(
				metadata.tools?.some(
					(tool) => isRecord(tool) && isRecord(tool.function) && tool.function.name === "request_user_input",
				),
				"The root task must advertise the native question tool",
			)
			yield {
				type: "tool_call" as const,
				id: CALL_ID,
				name: "request_user_input",
				arguments: JSON.stringify({ questions: QUESTIONS }),
			}
			return
		}
		assert.equal(observed.length, 2, "One submitted answer packet must resume the model exactly once")
		const matches = resultsFor(messages, CALL_ID)
		assert.equal(matches.length, 1, "The model must receive exactly one result for the question call")
		assert.equal(typeof matches[0]!.content, "string")
		assert.deepEqual(JSON.parse(matches[0]!.content as string), { answers: EXPECTED_ANSWERS })
		yield { type: "text" as const, text: "The setup choices are recorded. I can continue using them." }
	}
	getModel() {
		return {
			id: this.id,
			info: {
				contextWindow: 128_000,
				maxTokens: 4096,
				supportsPromptCache: false,
				experimental_supported_tools: ["request_user_input"],
			},
		}
	}
	async countTokens() {
		return 1
	}
	async completePrompt() {
		return ""
	}
}

suite("Rendered native question wizard", function () {
	this.timeout(240_000)
	test("preserves drafts, sends one packet, and keeps full receipts after task and webview reload", async function () {
		if (!process.env.ALPHA_UI_ACCEPTANCE_NONCE) this.skip()
		assert.equal(vscode.version, "1.138.0")
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
		const api = globalThis.api
		const original = api.getConfiguration()
		const provider = (api as unknown as { sidebarProvider: InputHost }).sidebarProvider
		const model = new InputWizardAI()
		const completed: string[] = []
		const onCompleted = (id: string) => completed.push(id)
		api.on(AlphaCodeEventName.TaskCompleted, onCompleted)
		try {
			await vscode.workspace
				.getConfiguration("workbench")
				.update("colorTheme", "Default Dark Modern", vscode.ConfigurationTarget.Global)
			await vscode.commands.executeCommand("alpha.SidebarProvider.focus")
			const taskId = await api.startNewTask({
				text: "Choose the first version, Oracle setup, and initial concurrency workload before continuing.",
				configuration: {
					...original,
					apiProvider: "fake-ai",
					fakeAi: model,
					mode: "architect",
					approvalMode: "ask",
					autoApprovalEnabled: false,
					alwaysAllowFollowupQuestions: false,
					enableCheckpoints: false,
					requestDelaySeconds: 0,
					writeDelayMs: 0,
				},
			})
			await waitFor(() => provider.getLiveTask(taskId)?.taskAsk?.ask === "followup", { timeout: 30_000 })
			const task = provider.getLiveTask(taskId)
			assert.ok(task)
			assert.equal(task.taskKind, "primary")
			await provider.postStateToWebview()
			await uiFixtureBarrier("input-wizard", {
				version: vscode.version,
				taskId,
				questions: QUESTIONS,
				expectedAnswers: EXPECTED_ANSWERS,
				customAnswer: CUSTOM_ANSWER,
			})
			assert.equal(model.getRequests().length, 1, "Drafts and review must not send an answer to the model")
			assert.equal(task.taskAsk?.ask, "followup", "Review must retain the pending ask")
			assert.equal(task.clineMessages.filter((message) => message.userInputResponse).length, 0)
			await uiFixtureBarrier("input-send", { version: vscode.version, taskId })
			await waitFor(
				() => {
					if (task.taskAsk?.ask === "completion_result") task.approveAsk()
					return completed.filter((id) => id === taskId).length === 1
				},
				{ timeout: 30_000, description: "native answers to resume and complete the scripted turn" },
			)
			await task.waitForTermination()
			await task.flushApiConversationHistoryPersistence()
			assert.equal(model.getRequests().length, 2)
			assert.equal(completed.filter((id) => id === taskId).length, 1)
			const saved = await provider.getTaskWithId(taskId)
			assert.equal(resultsFor(saved.apiConversationHistory, CALL_ID).length, 1)
			const messages = JSON.parse(await fs.readFile(saved.uiMessagesFilePath, "utf8")) as AlphaMessage[]
			const receipts = messages.filter((message) => message.userInputResponse)
			assert.equal(receipts.length, 1)
			assert.deepEqual(receipts[0]!.userInputResponse, EXPECTED_RECEIPT)
			await uiFixtureBarrier("input-receipt-dark", { version: vscode.version, taskId })
			await vscode.workspace
				.getConfiguration("workbench")
				.update("colorTheme", "Default Light Modern", vscode.ConfigurationTarget.Global)
			await uiFixtureBarrier("input-receipt-light", { version: vscode.version, taskId })
			await api.clearCurrentTask()
			assert.equal(provider.getLiveTask(taskId), undefined, "Reopen must start without an in-memory task")
			await provider.showTaskWithId(taskId)
			await waitFor(
				() => Boolean(provider.getLiveTask(taskId)?.clineMessages.some((message) => message.userInputResponse)),
				{ timeout: 15_000 },
			)
			assert.deepEqual(
				provider.getLiveTask(taskId)!.clineMessages.find((message) => message.userInputResponse)
					?.userInputResponse,
				EXPECTED_RECEIPT,
			)
			await provider.postStateToWebview()
			await uiFixtureBarrier("input-receipt-reopened", { version: vscode.version, taskId })
			const reloadCommand = "workbench.action.webview.reloadWebviewAction"
			assert.ok((await vscode.commands.getCommands()).includes(reloadCommand))
			await vscode.commands.executeCommand(reloadCommand)
			await uiFixtureBarrier("input-receipt-reloaded", { version: vscode.version, taskId })
			assert.equal(
				model.getRequests().length,
				2,
				"Reopening and webview reload must not repeat the answered call",
			)
		} finally {
			api.off(AlphaCodeEventName.TaskCompleted, onCompleted)
			await api.clearCurrentTask().catch(() => undefined)
			await api.setConfiguration(original)
		}
	})
})
