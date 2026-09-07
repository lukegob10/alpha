import * as assert from "assert"
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"
import { agentLifecycleEventSchema, RooCodeEventName } from "@alpha-code/types"

import { isWithin, readBounded, rejectSymlinkComponents } from "../evidence/paths"
import { AGENT_CONTROL_TRANSACTION_LOCK, OFFLINE_QUARANTINE_SUFFIX } from "../evidence/storageRecovery"
import { STORAGE_RESTART_RECEIPT, type StorageRestartPhaseReceipt } from "../evidence/storageRestart"
import { waitFor } from "./utils"

class StorageRestartAI {
	readonly id = "storage-restart-scripted"
	requests = 0
	async *createMessage() {
		this.requests++
		assert.equal(this.requests, 1, "This shell-free scenario must not issue another provider request")
		yield { type: "text" as const, text: "Storage recovery verification completed." }
		yield { type: "usage" as const, inputTokens: 10, outputTokens: 5, totalCost: 0 }
	}
	getModel() {
		return {
			id: this.id,
			info: {
				contextWindow: 128_000,
				maxTokens: 8_192,
				supportsImages: false,
				supportsPromptCache: false,
				inputPrice: 0,
				outputPrice: 0,
			},
		}
	}
	async countTokens(content: unknown[]): Promise<number> {
		return Math.max(1, Math.ceil(JSON.stringify(content).length / 4))
	}
	async completePrompt(): Promise<string> {
		return ""
	}
}

interface StorageRestartProvider {
	agentControlStore: {
		persistence: { filePath: string; withTransaction<T>(operation: () => Promise<T>): Promise<T> }
	}
	getAgentLifecycleSnapshot(taskId: string): { status: string } | undefined
	getLiveTask(taskId: string):
		| {
				taskAsk?: { ask?: string }
				approveAsk(): void
				waitForTermination(): Promise<void>
		  }
		| undefined
}

suite("Actual profile storage restart", function () {
	this.timeout(180_000)
	test("observes the bounded requested phase through the actual task API", async function () {
		const phase = process.env.ALPHA_E2E_STORAGE_RESTART_PHASE
		if (!phase) {
			this.skip()
			return
		}
		assert.ok(phase === "fault" || phase === "healthy")
		assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
		assert.equal(process.env.ALPHA_E2E_SCENARIO_ID, "storage-restart")
		const profile = process.env.ALPHA_E2E_PROFILE_DIR
		const artifactsDir = process.env.ALPHA_E2E_ARTIFACTS_DIR
		const runId = process.env.ALPHA_E2E_RUN_ID
		const scenarioResultPath = process.env.ALPHA_E2E_SCENARIO_RESULT_PATH
		assert.ok(profile && artifactsDir && runId && scenarioResultPath)
		assert.equal(path.dirname(path.resolve(scenarioResultPath)), path.resolve(artifactsDir))
		const api = globalThis.api
		const provider = (api as unknown as { sidebarProvider: StorageRestartProvider }).sidebarProvider
		const persistence = provider.agentControlStore.persistence
		await rejectSymlinkComponents(persistence.filePath)
		const storagePath = await fs.realpath(path.dirname(persistence.filePath))
		assert.ok(
			isWithin(await fs.realpath(profile), storagePath),
			"The actual Alpha storage must belong to the dedicated profile",
		)
		assert.equal(path.basename(persistence.filePath), "agent_control.json")
		const lockPath = path.join(storagePath, AGENT_CONTROL_TRANSACTION_LOCK)
		const preservedOwner = path.join(
			phase === "fault" ? lockPath : `${lockPath}${OFFLINE_QUARANTINE_SUFFIX}`,
			"owner.json",
		)
		assert.equal(
			(await readBounded(preservedOwner, 1_024)).length,
			0,
			"The original empty-owner evidence must remain intact",
		)

		const model = new StorageRestartAI()
		const completed = new Set<string>()
		const onCompleted = (taskId: string) => {
			completed.add(taskId)
		}
		api.on(RooCodeEventName.TaskCompleted, onCompleted)
		try {
			const taskId = await api.startNewTask({
				configuration: {
					...api.getConfiguration(),
					apiProvider: "fake-ai",
					fakeAi: model,
					mode: "ask",
					alwaysAllowModeSwitch: true,
					autoApprovalEnabled: true,
					requestDelaySeconds: 0,
					writeDelayMs: 0,
					enableCheckpoints: false,
				},
				text: "Reply with one brief storage verification acknowledgement. Do not use tools or commands.",
			})
			// Record the started task before awaiting a terminal state, so a crash cannot hide its history from capture.
			await fs.writeFile(scenarioResultPath, JSON.stringify({ runId, taskIds: [taskId] }), {
				flag: "wx",
				mode: 0o600,
			})
			let approved = false
			await waitFor(
				() => {
					const task = provider.getLiveTask(taskId)
					if (phase === "fault") {
						return (
							provider.getAgentLifecycleSnapshot(taskId)?.status === "failed" &&
							task?.taskAsk?.ask === "resume_task"
						)
					}
					if (task?.taskAsk?.ask === "completion_result" && !approved) {
						approved = true
						task.approveAsk()
					}
					return completed.has(taskId) && provider.getAgentLifecycleSnapshot(taskId)?.status === "completed"
				},
				{ timeout: 90_000, description: `storage restart ${phase} terminal task` },
			)
			assert.equal(model.requests, phase === "fault" ? 0 : 1)
			if (phase === "fault") {
				// Probe the same production persistence object to establish the typed cause, without changing its timeout or lock.
				await assert.rejects(
					persistence.withTransaction(async () => {
						assert.fail("An operation must never execute under the seeded unknown owner")
					}),
					(error: unknown) => error instanceof Error && (error as { code?: string }).code === "ELOCKOWNER",
				)
				assert.equal(completed.size, 0)
			} else {
				await provider.getLiveTask(taskId)?.waitForTermination()
				assert.ok(await api.isTaskInHistory(taskId))
				const history = JSON.parse(
					(
						await readBounded(
							path.join(storagePath, "tasks", taskId, "api_conversation_history.json"),
							256 * 1_024,
						)
					).toString("utf8"),
				) as unknown
				assert.ok(
					Array.isArray(history) && history.length > 0,
					"The healthy task must persist its provider history",
				)
			}
			const journal = await readBounded(
				path.join(storagePath, "tasks", taskId, "agent_lifecycle_events.jsonl"),
				256 * 1_024,
			)
			const events = journal
				.toString("utf8")
				.split(/\r?\n/)
				.filter(Boolean)
				.map((line) => agentLifecycleEventSchema.parse(JSON.parse(line)))
			assert.ok(events.every((event) => event.taskId === taskId))
			const terminals = events.filter((event) => event.type === "turn_terminal")
			assert.equal(terminals.length, 1, "Exactly one durable terminal event is required")
			const terminal = terminals[0]
			assert.ok(terminal)
			assert.equal(terminal.payload.status, phase === "fault" ? "failed" : "completed")
			const receipt: StorageRestartPhaseReceipt = {
				schemaVersion: 1,
				scenarioId: "storage-restart",
				phase,
				runId,
				hostVersion: vscode.version,
				extensionHostPid: process.pid,
				storagePath,
				taskId,
				providerRequests: model.requests,
				terminalCount: 1,
				status: phase === "fault" ? "failed" : "completed",
				code: phase === "fault" ? "ELOCKOWNER" : "OK",
			}
			await fs.writeFile(path.join(artifactsDir, STORAGE_RESTART_RECEIPT), JSON.stringify(receipt, null, 2), {
				flag: "wx",
				mode: 0o600,
			})
		} finally {
			api.off(RooCodeEventName.TaskCompleted, onCompleted)
		}
	})
})
