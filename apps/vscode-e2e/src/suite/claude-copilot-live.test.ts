import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as vscode from "vscode"
import { AlphaCodeEventName, type AlphaMessage } from "@alpha-code/types"

import { readBoundedJson } from "../scenarios/extensionWorkflowHost"
import { LiveResponseProbe } from "../scenarios/liveResponseProbe"
import { inspectToolTransactions } from "../scenarios/transactionAssertions"
import { assertOwnedTestRoot } from "../testProfile"
import {
	assertClaudeThinkingPersisted,
	assertClaudeThinkingRoundTrip,
	observeClaudeRequest,
	observeClaudeThinkingEmission,
	persistedClaudeThinkingDigests,
	type ClaudeRequestObservation,
	type ClaudeThinkingEmission,
} from "./claude-copilot-support"
import { record, runLiveCase, type LiveTask } from "./live-file-tool-support"
import { assistantVisibleText } from "./live-transcript-support"
import {
	assertLiveFileToolBoundary,
	createCompletionReviewAcknowledger,
	withBoundedFixtureCleanup,
} from "./proportional-context-support"
import { waitFor } from "./utils"

interface ClaudeProvider {
	on(event: "taskCreated", listener: (task: LiveTask) => void): void
	off(event: "taskCreated", listener: (task: LiveTask) => void): void
	getLiveTask(taskId: string): LiveTask | undefined
	getTaskWithId(taskId: string): Promise<{ taskDirPath: string }>
}

suite("Live Claude through GitHub Copilot", function () {
	this.timeout(380_000)

	test("reads, patches, verifies, and resumes the same Claude task with its emitted thinking state", async () => {
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "live-copilot")
		assert.equal(vscode.version, "1.138.0", "Claude live acceptance requires the exact reference host")
		assert.equal(process.env.ALPHA_E2E_EXPECTED_VSCODE_VERSION, "1.138.0")
		const modelId = process.env.ALPHA_E2E_ACTUAL_MODEL_ID
		const family = process.env.ALPHA_E2E_ACTUAL_MODEL_FAMILY
		assert.ok(modelId && family, "An actually discovered Claude model must be selected explicitly")
		assert.equal(modelId, process.env.ALPHA_E2E_MODEL_ID)
		assert.match(family, /^claude-/i, "A GPT or other family cannot satisfy Claude live acceptance")
		const profile = process.env.ALPHA_E2E_PROFILE_DIR
		assert.ok(profile)
		await assertOwnedTestRoot(profile)
		const api = globalThis.api
		assert.equal(api.getConfiguration().apiProvider, "vscode-lm")
		assert.equal(api.getConfiguration().vsCodeLmModelSelector?.vendor, "copilot")
		assert.equal(api.getConfiguration().vsCodeLmModelSelector?.id, modelId)
		const provider = (api as unknown as { sidebarProvider: ClaudeProvider }).sidebarProvider
		const observations: ClaudeRequestObservation[] = []
		const emissions: ClaudeThinkingEmission[] = []
		const ThinkingPart = (
			vscode as typeof vscode & {
				LanguageModelThinkingPart?: new (
					value: string | string[],
					id?: string,
					metadata?: Record<string, unknown>,
				) => object
			}
		).LanguageModelThinkingPart
		const responseProbe = new LiveResponseProbe((part, request) =>
			observeClaudeThinkingEmission(
				emissions,
				request,
				part,
				typeof ThinkingPart === "function" && part instanceof ThinkingPart,
			),
		)
		let createdTasks = 0
		const onCreated = () => {
			createdTasks++
		}
		provider.on("taskCreated", onCreated)
		const directory = "live-claude-copilot"
		const file = `${directory}/config.cjs`
		const original = 'module.exports = { enabled: false, label: "keep $& literal" }\n'
		const expected = original.replace("enabled: false", "enabled: true")
		const inspect = `node ${directory}/inspect.cjs`
		const verify = `node ${directory}/verify.cjs`
		const patch = `*** Begin Patch\n*** Update File: ${file}\n@@\n-${original.trimEnd()}\n+${expected.trimEnd()}\n*** End Patch`
		let taskId: string | undefined
		let requestsBeforeFollowup = 0
		let thinkingParts = 0
		let nativeThinkingParts = 0
		let thinkingReplay: "verified" | "not-emitted" | "unverified" = "unverified"
		let completedTurns = 0
		let passed = false
		await withBoundedFixtureCleanup(async () => {
			try {
				await runLiveCase(
					"claude-copilot-tools",
					["exec_command", "apply_patch"],
					{
						[file]: original,
						[`${directory}/inspect.cjs`]: `console.log(require("node:fs").readFileSync(${JSON.stringify(file)}, "utf8"))\n`,
						[`${directory}/verify.cjs`]: `require("node:assert/strict").equal(require("node:fs").readFileSync(${JSON.stringify(file)}, "utf8"), ${JSON.stringify(expected)})\nconsole.log("CLAUDE_PATCH_VERIFIED")\n`,
					},
					`Inspect ${file} with exec_command using this exact cmd: ${JSON.stringify(inspect)}. Then use exactly one apply_patch with this exact patch: ${JSON.stringify(patch)}. Verify using exec_command with this exact cmd: ${JSON.stringify(verify)}. Finish with a concise answer including CLAUDE_PATCH_VERIFIED.`,
					async (calls, _messages, workspace, answer, task) => {
						taskId = task.taskId
						completedTurns = 1
						assert.equal(createdTasks, 1)
						assert.deepEqual(
							calls.filter((call) => call.name !== "attempt_completion").map((call) => call.name),
							["exec_command", "apply_patch", "exec_command"],
						)
						assert.ok(
							calls.every((call) => !call.isError),
							"Claude must receive successful, paired tool receipts",
						)
						assert.equal(calls[0]!.input.cmd, inspect)
						assert.equal(calls[1]!.input.patch, patch)
						assert.equal(calls[2]!.input.cmd, verify)
						assert.match(calls[0]!.result, /enabled: false/)
						assert.match(calls[2]!.result, /CLAUDE_PATCH_VERIFIED/)
						assert.match(answer, /CLAUDE_PATCH_VERIFIED/)
						assert.equal(await fs.readFile(path.join(workspace, file), "utf8"), expected)
						const { taskDirPath } = await provider.getTaskWithId(task.taskId)
						const historyFile = path.join(taskDirPath, "api_conversation_history.json")
						const before = await readBoundedJson(historyFile)
						assertClaudeThinkingPersisted(emissions, before)
						const emittedBeforeFollowup = structuredClone(emissions)
						const thinkingDigests = persistedClaudeThinkingDigests(before)
						thinkingParts = thinkingDigests.length
						assert.ok(Array.isArray(before))
						nativeThinkingParts = emissions.reduce(
							(sum, emission) => sum + emission.nativeThinkingDigests.length,
							0,
						)
						requestsBeforeFollowup = observations.length
						assert.ok(requestsBeforeFollowup > 0, "Live labels require actual selected-model requests")
						const feedback = `Run exec_command with exactly ${JSON.stringify(verify)} once to verify the existing file again. Make no further edits. Use the previous conversation's receipts and finish with CLAUDE_FOLLOWUP_VERIFIED.`
						const previousTimestamp = task.clineMessages.at(-1)?.ts ?? 0
						let admitted = false
						let followupCompleted = 0
						const onFeedback = (event: { taskId: string; action: string; message: AlphaMessage }) => {
							if (
								event.taskId === task.taskId &&
								event.action === "created" &&
								event.message.say === "user_feedback" &&
								event.message.partial !== true &&
								event.message.ts > previousTimestamp &&
								event.message.text === feedback
							)
								admitted = true
						}
						const onCompleted = (id: string) => {
							if (id === task.taskId) followupCompleted++
						}
						api.on(AlphaCodeEventName.Message, onFeedback)
						api.on(AlphaCodeEventName.TaskCompleted, onCompleted)
						try {
							assert.ok(api.getCurrentTaskStack().includes(task.taskId))
							await api.sendMessage(feedback)
							const acknowledge = createCompletionReviewAcknowledger()
							await waitFor(
								() => {
									assert.equal(
										provider.getLiveTask(task.taskId),
										task,
										"Followup must retain the exact task instance",
									)
									assertLiveFileToolBoundary(task, [inspect, verify])
									acknowledge(task)
									return admitted && followupCompleted > 0
								},
								{ timeout: 150_000, interval: 100, description: "Claude same-task followup" },
							)
							await waitFor(
								async () => {
									await task.waitForTermination()
									await task.flushApiConversationHistoryPersistence()
									return true
								},
								{ timeout: 15_000, description: "Claude followup evidence durability" },
							)
							assert.equal(followupCompleted, 1)
							completedTurns++
						} finally {
							api.off(AlphaCodeEventName.Message, onFeedback)
							api.off(AlphaCodeEventName.TaskCompleted, onCompleted)
						}
						assert.equal(createdTasks, 1, "A continuation must not launch a replacement task")
						assert.ok(observations.length > requestsBeforeFollowup)
						thinkingReplay = assertClaudeThinkingRoundTrip(
							emittedBeforeFollowup,
							before,
							observations[requestsBeforeFollowup]!.thinkingDigests,
						)
						assert.ok(observations.every((request) => request.tools.includes("apply_patch")))
						const after = await readBoundedJson(historyFile)
						assertClaudeThinkingPersisted(emissions, after)
						assert.equal(
							responseProbe.observations.length,
							observations.length,
							"Every dispatched task request must have an observed provider response",
						)
						assert.ok(
							responseProbe.observations.every((response) => response.ended),
							"Every observed response must finish before evidence is accepted",
						)
						assert.deepEqual(inspectToolTransactions(after).errors, [])
						assert.ok(Array.isArray(before) && Array.isArray(after))
						const followup = after.slice(before.length).map(record)
						const blocks = followup.flatMap((message) =>
							Array.isArray(message.content) ? message.content.map(record) : [],
						)
						const toolCalls = blocks.filter((block) => block.type === "tool_use")
						assert.deepEqual(
							toolCalls.filter((call) => call.name !== "attempt_completion").map((call) => call.name),
							["exec_command"],
						)
						assert.equal(record(toolCalls[0]!.input).cmd, verify)
						const verificationResult = blocks.find(
							(block) => block.type === "tool_result" && block.tool_use_id === toolCalls[0]!.id,
						)
						assert.ok(verificationResult)
						assert.notEqual(verificationResult.is_error, true, "Followup verification must succeed")
						assert.match(JSON.stringify(verificationResult.content), /CLAUDE_PATCH_VERIFIED/)
						const final = followup
							.filter((message) => message.role === "assistant")
							.map((message) => assistantVisibleText(message.content))
							.join("\n")
						const completionText = toolCalls
							.filter((call) => call.name === "attempt_completion")
							.map((call) => record(call.input).result)
							.join("\n")
						assert.match(`${final}\n${completionText}`, /CLAUDE_FOLLOWUP_VERIFIED/)
						assert.equal(await fs.readFile(path.join(workspace, file), "utf8"), expected)
					},
					{
						scope: `Work only in ${directory}. Use only the named read-only commands and the single requested patch. Do not delegate or create unrelated files.`,
						commands: [inspect, verify],
						requestLimit: 12,
						onTaskRequest: (client, messages, options) =>
							observeClaudeRequest({ modelId, family }, observations, client, messages, options),
						responseProbe,
					},
				)
				passed = true
			} finally {
				await fs.writeFile(
					path.join(process.env.ALPHA_E2E_ARTIFACTS_DIR!, "claude-copilot-live.json"),
					JSON.stringify(
						{
							schemaVersion: 1,
							passed,
							provider: "live-copilot",
							hostVersion: vscode.version,
							profile,
							modelId,
							family,
							effort: process.env.ALPHA_E2E_ACTUAL_REASONING_EFFORT,
							taskId,
							completedTurns,
							requestLimit: 12,
							taskRequestAttempts: observations.length,
							requestsBeforeFollowup,
							thinkingParts,
							nativeThinkingParts,
							thinkingReplay: passed ? thinkingReplay : "unverified",
							emittedThinkingParts: emissions.reduce(
								(sum, emission) => sum + emission.thinkingDigests.length,
								0,
							),
							emittedNativeThinkingParts: emissions.reduce(
								(sum, emission) => sum + emission.nativeThinkingDigests.length,
								0,
							),
							emissions,
							responseObservations: responseProbe.observations,
							observations,
						},
						null,
						2,
					),
					{ flag: "wx" },
				)
			}
		}, [() => provider.off("taskCreated", onCreated)])
	})
})
