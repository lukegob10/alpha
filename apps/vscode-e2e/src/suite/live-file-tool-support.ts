import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as vscode from "vscode"
import { RooCodeEventName, toolNames, type ClineMessage, type ToolName } from "@alpha-code/types"

import { readBoundedJson } from "../scenarios/extensionWorkflowHost"
import { guardTaskApi, WorkflowRequestBudget } from "../scenarios/requestBudget"
import { inspectToolTransactions } from "../scenarios/transactionAssertions"
import { assertOwnedTestRoot } from "../testProfile"
import { createCompletionReviewAcknowledger, withBoundedFixtureCleanup } from "./proportional-context-support"
import { waitFor } from "./utils"

interface LiveTask {
	taskId: string
	api: unknown
	didComplete?: boolean
	abort?: boolean
	taskAsk?: ClineMessage
	clineMessages: ClineMessage[]
	approveAsk(): void
	waitForTermination(): Promise<void>
	flushApiConversationHistoryPersistence(): Promise<void>
}

interface LiveProvider {
	on(event: "taskCreated", listener: (task: LiveTask) => void): void
	off(event: "taskCreated", listener: (task: LiveTask) => void): void
	getTaskWithId(id: string): Promise<{ taskDirPath: string }>
}

type JsonRecord = Record<string, unknown>
export const record = (value: unknown): JsonRecord => {
	assert.ok(value && typeof value === "object" && !Array.isArray(value))
	return value as JsonRecord
}
const text = (value: unknown): string =>
	typeof value === "string"
		? value
		: Array.isArray(value)
			? value.map((part) => text(record(part).text)).join("\n")
			: ""

export interface Transaction {
	name: string
	input: JsonRecord
	result: string
	isError: boolean
}

function transactions(history: unknown): Transaction[] {
	assert.ok(Array.isArray(history))
	const blocks = history.flatMap((message) => {
		const content = record(message).content
		return Array.isArray(content) ? content.map(record) : []
	})
	return blocks
		.filter((block) => block.type === "tool_use")
		.map((call) => {
			const result = blocks.find((block) => block.type === "tool_result" && block.tool_use_id === call.id)
			assert.ok(result, "Every real model tool call must have a persisted result")
			return {
				name: String(call.name),
				input: record(call.input),
				result: text(result.content),
				isError: result.is_error === true,
			}
		})
}

const scope =
	"Use only the named file tools inside live-file-tools. Do not use commands, delegate, or create unrelated files. These are intentional contract probes: do not repair deliberately invalid searches/edits or retry them. Finish with a concise report of the observed results."

export async function runLiveCase(
	id: string,
	tools: ToolName[],
	files: Record<string, string>,
	prompt: string,
	verify: (calls: Transaction[], messages: ClineMessage[], workspace: string, answer: string) => Promise<void>,
	options: { scope?: string } = {},
) {
	assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "live-copilot", "This suite requires a real Copilot model")
	const workspace = process.env.ALPHA_E2E_WORKSPACE!
	await assertOwnedTestRoot(workspace)
	for (const [relative, content] of Object.entries(files)) {
		const target = path.join(workspace, relative)
		await fs.mkdir(path.dirname(target), { recursive: true })
		await fs.writeFile(target, content, { flag: "wx" })
	}
	const api = globalThis.api
	const original = api.getConfiguration()
	const provider = (api as unknown as { sidebarProvider: LiveProvider }).sidebarProvider
	const budget = new WorkflowRequestBudget(12, process.env.ALPHA_E2E_ACTUAL_MODEL_ID)
	const releases: Array<() => void> = []
	let task: LiveTask | undefined
	let completed = 0
	const onCreated = (created: LiveTask) => {
		task = created
		releases.push(guardTaskApi(created, budget))
	}
	const onCompleted = (taskId: string) => {
		if (taskId === task?.taskId) completed++
	}
	provider.on("taskCreated", onCreated)
	api.on(RooCodeEventName.TaskCompleted, onCompleted)
	const allowed = new Set<ToolName>(["read_file", "attempt_completion", ...tools])
	const startedAt = Date.now()
	let calls: Transaction[] = []
	let answer = ""
	let passed = false
	let failure: string | undefined
	const acknowledge = createCompletionReviewAcknowledger()
	await withBoundedFixtureCleanup(async () => {
		try {
			await api.startNewTask({
				configuration: {
					...original,
					mode: "code",
					disabledTools: toolNames.filter((name) => !allowed.has(name)),
					autoApprovalEnabled: true,
					alwaysAllowReadOnly: true,
					alwaysAllowReadOnlyOutsideWorkspace: false,
					alwaysAllowWrite: true,
					alwaysAllowWriteOutsideWorkspace: false,
					alwaysAllowWriteProtected: false,
					alwaysAllowExecute: false,
					alwaysAllowMcp: false,
					mcpEnabled: false,
					alwaysAllowSubagents: false,
					alwaysAllowSubtasks: false,
					alwaysAllowFollowupQuestions: false,
					allowedMaxRequests: budget.limit,
					enableCheckpoints: false,
					requestDelaySeconds: 0,
					writeDelayMs: 0,
				},
				text: `${options.scope ?? scope}\n${prompt}`,
			})
			await waitFor(
				() => {
					if (budget.failure) throw budget.failure
					assert.equal(budget.exhausted, false, "Live request budget exhausted")
					const ask = task?.taskAsk
					if (ask && !ask.partial && !task?.didComplete)
						assert.equal(ask.ask, "completion_result", `Unexpected boundary: ${ask.ask}`)
					acknowledge(task)
					return completed > 0
				},
				{ timeout: 180_000, interval: 100, description: `${id} live completion` },
			)
			assert.ok(task)
			await waitFor(
				async () => {
					await task!.waitForTermination()
					await task!.flushApiConversationHistoryPersistence()
					return true
				},
				{ timeout: 15_000, description: "file-tool evidence durability" },
			)
			const { taskDirPath } = await provider.getTaskWithId(task.taskId)
			const history = await readBoundedJson(path.join(taskDirPath, "api_conversation_history.json"))
			assert.deepEqual(inspectToolTransactions(history).errors, [])
			calls = transactions(history)
			assert.ok(Array.isArray(history))
			answer = [
				...history
					.filter((message) => record(message).role === "assistant")
					.map((message) => text(record(message).content)),
				...calls
					.filter((call) => call.name === "attempt_completion")
					.map((call) => (typeof call.input.result === "string" ? call.input.result : "")),
			]
				.filter((value) => value.trim())
				.join("\n")
			assert.ok(budget.used > 0, "The task must dispatch real requests to the selected model")
			assert.equal(completed, 1)
			assert.ok(
				calls.every((call) => allowed.has(call.name as ToolName)),
				"No alternate tool may bypass the probe",
			)
			await verify(calls, task.clineMessages, workspace, answer)
			passed = true
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error)
			throw error
		} finally {
			const fileHashes: Record<string, string> = {}
			for (const relative of Object.keys(files))
				fileHashes[relative] = createHash("sha256")
					.update(await fs.readFile(path.join(workspace, relative)))
					.digest("hex")
			await fs.writeFile(
				path.join(process.env.ALPHA_E2E_ARTIFACTS_DIR!, `${id}.json`),
				JSON.stringify(
					{
						schemaVersion: 1,
						passed,
						failure,
						hostVersion: vscode.version,
						provider: "live-copilot",
						model: budget.model,
						effort: process.env.ALPHA_E2E_ACTUAL_REASONING_EFFORT,
						requests: budget.used,
						elapsedMs: Date.now() - startedAt,
						resultChars: calls.reduce((sum, call) => sum + call.result.length, 0),
						answer,
						requestLimit: budget.limit,
						taskId: task?.taskId,
						completed,
						calls,
						fileHashes,
					},
					null,
					2,
				),
				{ flag: "wx" },
			)
		}
	}, [
		() => api.clearCurrentTask(),
		() => provider.off("taskCreated", onCreated),
		() => api.off(RooCodeEventName.TaskCompleted, onCompleted),
		() => {
			for (const release of releases.reverse()) release()
		},
		() => api.setConfiguration(original),
	])
}
