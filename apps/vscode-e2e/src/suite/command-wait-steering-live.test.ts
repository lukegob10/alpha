import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as vscode from "vscode"
import { toolNames, type AlphaCodeSettings, type LiveTaskMetadata, type ToolName } from "@alpha-code/types"

import { guardTaskApi, WorkflowRequestBudget } from "../scenarios/requestBudget"
import { inspectToolTransactions } from "../scenarios/transactionAssertions"
import { assertOwnedTestRoot } from "../testProfile"
import { record, type LiveTask } from "./live-file-tool-support"
import { captureLiveFixtureSettings } from "./live-provider-settings"
import { createCompletionReviewAcknowledger, withBoundedFixtureCleanup } from "./proportional-context-support"
import { waitFor } from "./utils"

interface SteeringTask extends LiveTask {
	getActiveBackgroundCommandExecutionIds(): string[]
	steerUserMessageDurably(text: string, images: string[], receiptId: string, expectedTurnId?: string): Promise<void>
	runPendingInterruptLifecycleHook(...args: unknown[]): Promise<void>
	pendingSteerMessage?: unknown
	steerMessageAwaitingPersistence: boolean
}

interface SteeringProvider {
	getValues(): AlphaCodeSettings
	setValues(values: AlphaCodeSettings): Promise<void>
	getLiveTaskMetadata(): Record<string, LiveTaskMetadata>
	on(event: "taskCreated", listener: (task: SteeringTask) => void): void
	off(event: "taskCreated", listener: (task: SteeringTask) => void): void
}

const script = "alpha-quiet-batch.cjs"
const launch = "node " + script
const nextCommand = "node --version"
const marker = "STEERED_BATCH_OK"
const receiptId = "live-steering-recovery"

const toolCalls = (task: LiveTask, name: string) =>
	task.apiConversationHistory.flatMap((message) => {
		const { content } = record(message)
		return Array.isArray(content)
			? content.map(record).filter((part) => part.type === "tool_use" && part.name === name)
			: []
	})

suite("Live GPT command wait and steering recovery", function () {
	this.timeout(220_000)

	test("backs off quiet polling and delivers the accepted steer on the first request after Continue", async () => {
		assert.equal(vscode.version, "1.141.0")
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "live-copilot")
		const modelId = process.env.ALPHA_E2E_ACTUAL_MODEL_ID
		assert.match(modelId ?? "", /^gpt-/)
		const workspace = process.env.ALPHA_E2E_WORKSPACE!
		await assertOwnedTestRoot(workspace, "workspace")
		const scriptPath = path.join(workspace, script)
		const readyPath = path.join(workspace, "alpha-quiet-batch.ready")
		const stopPath = path.join(workspace, "alpha-quiet-batch.stop")
		await fs.writeFile(
			scriptPath,
			[
				"const fs = require('node:fs')",
				"fs.writeFileSync(" + JSON.stringify(readyPath) + ", String(process.pid))",
				"const loop = setInterval(() => { if (fs.existsSync(" +
					JSON.stringify(stopPath) +
					")) clearInterval(loop) }, 25)",
				"setTimeout(() => clearInterval(loop), 150_000).unref()",
			].join("\n"),
			{ flag: "wx" },
		)

		const api = globalThis.api
		assert.equal(api.getConfiguration().vsCodeLmModelSelector?.id, modelId)
		const provider = (api as unknown as { sidebarProvider: SteeringProvider }).sidebarProvider
		const allowed = new Set<ToolName>([
			"exec_command",
			"execute_command",
			"shell",
			"write_stdin",
			"attempt_completion",
		])
		const settings = captureLiveFixtureSettings(provider, {
			mode: "code",
			disabledTools: toolNames.filter((name) => !allowed.has(name)),
			approvalMode: "auto",
			autoApprovalEnabled: true,
			alwaysAllowExecute: true,
			allowedCommands: [launch, nextCommand],
			deniedCommands: [],
			alwaysAllowReadOnly: true,
			alwaysAllowWrite: false,
			alwaysAllowMcp: false,
			alwaysAllowSubagents: false,
			alwaysAllowSubtasks: false,
			enableCheckpoints: false,
			terminalShellIntegrationDisabled: true,
			requestDelaySeconds: 0,
		})
		const budget = new WorkflowRequestBudget(8, modelId)
		const acknowledge = createCompletionReviewAcknowledger()
		let task: SteeringTask | undefined
		let releaseGuard: (() => void) | undefined
		let restoreHook: (() => void) | undefined
		let sentContinue = false
		let resumedWithSteering = false
		let faultTriggered = false
		const onCreated = (created: SteeringTask) => {
			task = created
			releaseGuard = guardTaskApi(created, budget)
		}
		budget.onTaskRequest = (_client, messages) => {
			if (!sentContinue || resumedWithSteering) return
			assert.equal(JSON.stringify(messages).split(marker).length, 2, "Continue must deliver the steer once")
			resumedWithSteering = true
		}
		provider.on("taskCreated", onCreated)

		await withBoundedFixtureCleanup(async () => {
			await api.startNewTask({
				configuration: settings.configuration,
				presentationModelCalls: false,
				text: [
					"Run this fixture in the background with one exec_command, cmd " +
						JSON.stringify(launch) +
						", tty false.",
					"Leave the process running. Then check the same returned session twice using write_stdin.",
					"Wait for the first poll's result before making the second poll.",
					"For both polls supply only session_id and empty chars. Omit yield_time_ms.",
					"Do not stop the process. I will steer the next action while it runs.",
				].join("\n"),
			})
			assert.ok(task)
			const running = task
			let extendedWaitStartedAt: number | undefined
			const approve = () => {
				if (budget.failure) throw budget.failure
				const ask = running.taskAsk
				if (ask?.ask !== "command" || ask.isAnswered) return
				const command = ask.text?.split("\n")[0]
				assert.ok(command === launch || command === nextCommand, "Approve only the two fixture commands")
				running.approveAsk()
			}
			await waitFor(
				() => {
					approve()
					const polls = toolCalls(running, "write_stdin")
					const startedAt = provider.getLiveTaskMetadata()[running.taskId]?.commandWaitStartedAt
					if (polls.length !== 2 || startedAt === undefined) return false
					for (const poll of polls) assert.ok(record(poll.input).yield_time_ms == null)
					extendedWaitStartedAt ??= startedAt
					assert.equal(startedAt, extendedWaitStartedAt)
					return Date.now() - startedAt >= 6_000
				},
				{
					timeout: 110_000,
					interval: 100,
					description: "the second default poll to remain active beyond five seconds",
				},
			)
			assert.ok(extendedWaitStartedAt !== undefined)
			const quietWaitMs = Date.now() - extendedWaitStartedAt
			const pid = Number(await fs.readFile(readyPath, "utf8"))
			assert.ok(Number.isSafeInteger(pid) && pid > 0)
			process.kill(pid, 0)
			const [executionId] = running.getActiveBackgroundCommandExecutionIds()
			assert.ok(executionId)
			const originalHook = running.runPendingInterruptLifecycleHook
			running.runPendingInterruptLifecycleHook = async function (...args) {
				if (!faultTriggered && this.steerMessageAwaitingPersistence && !this.pendingSteerMessage) {
					faultTriggered = true
					throw new Error("Fixture request preparation failure after steering selection")
				}
				await originalHook.apply(this, args)
			}
			restoreHook = () => {
				running.runPendingInterruptLifecycleHook = originalHook
			}
			const turnId = provider.getLiveTaskMetadata()[running.taskId]?.turnId
			await running.steerUserMessageDurably(
				"Stop checking the original process and leave it running. Run node --version once and reply " +
					marker +
					".",
				[],
				receiptId,
				turnId,
			)
			await waitFor(() => faultTriggered && running.taskAsk?.ask === "resume_task", {
				timeout: 15_000,
				description: "the injected failure to offer Continue",
			})
			assert.equal(provider.getLiveTaskMetadata()[running.taskId]?.commandWaitStartedAt, undefined)
			sentContinue = true
			running.approveAsk()
			await waitFor(
				() => {
					approve()
					acknowledge(running)
					return running.didComplete === true
				},
				{ timeout: 65_000, interval: 100, description: "GPT to execute the steered follow-up and finish" },
			)
			await running.waitForTermination()
			assert.ok(resumedWithSteering)
			assert.equal(toolCalls(running, "write_stdin").length, 2)
			assert.deepEqual(
				toolCalls(running, "exec_command").map((call) => record(call.input).cmd),
				[launch, nextCommand],
			)
			assert.deepEqual(inspectToolTransactions(running.apiConversationHistory).errors, [])
			assert.deepEqual(running.getActiveBackgroundCommandExecutionIds(), [executionId])
			assert.equal(
				running.apiConversationHistory.filter((message) => {
					const ids = record(message).queued_message_ids
					return Array.isArray(ids) && ids.includes(receiptId)
				}).length,
				1,
			)
			assert.ok(
				running.alphaMessages.some(
					(row) => (row.say === "text" || row.say === "completion_result") && row.text?.includes(marker),
				),
			)
			process.kill(pid, 0)
			await fs.writeFile(
				path.join(process.env.ALPHA_E2E_ARTIFACTS_DIR!, "command-wait-steering.json"),
				JSON.stringify({
					hostVersion: vscode.version,
					modelId,
					reasoningEffort: process.env.ALPHA_E2E_ACTUAL_REASONING_EFFORT,
					requests: budget.used,
					quietWaitMs,
					commandPolls: 2,
					steeringDeliveries: 1,
					originalCommandAlive: true,
				}),
				{ flag: "wx" },
			)
			console.log(
				`Live steering recovery verified on ${vscode.version} with ${modelId} (${budget.used} requests)`,
			)
		}, [
			() => fs.writeFile(stopPath, "stop", { flag: "wx" }),
			() => api.clearCurrentTask(),
			() => provider.off("taskCreated", onCreated),
			() => restoreHook?.(),
			() => releaseGuard?.(),
			() => settings.restore(),
			async () => {
				for (const owned of [scriptPath, readyPath, stopPath]) await fs.rm(owned, { force: true })
			},
		])
	})
})
