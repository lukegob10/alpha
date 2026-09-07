import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as vscode from "vscode"
import { RooCodeEventName, toolNames, type RooCodeAPI } from "@alpha-code/types"

import { assertRunnerAncestry } from "../hostOwnership"
import { assertOwnedTestRoot } from "../testProfile"
import { readBounded, requireEvidenceRun, rejectSymlinkComponents } from "../evidence/paths"
import { inspectTaskLifecycle, inspectToolTransactions } from "../scenarios/transactionAssertions"
import { PairedScriptedAI } from "../scenarios/sharedStorageScriptedAI"
import {
	validateManifest,
	failureCode,
	ROLES,
	publish,
	readOptional,
	requireNonce,
	waitUntil,
	type HostIdentity,
	type PairManifest,
	type Role,
} from "../evidence/sharedStorageProtocol"

interface Task {
	taskAsk?: { ask?: string }
	approveAsk(): void
	waitForTermination(): Promise<void>
	flushApiConversationHistoryPersistence(): Promise<void>
}
interface Provider {
	contextProxy: { globalStorageUri: vscode.Uri }
	agentControlStoreReady: Promise<void>
	agentControlStore: { persistence: { filePath: string } }
	getLiveTask(taskId: string): Task | undefined
	getTaskWithId(taskId: string): Promise<{ taskDirPath: string }>
	getAgentLifecycleSnapshot(taskId: string): { status: string } | undefined
}

export async function run(): Promise<void> {
	let directory: string | undefined
	let manifest: PairManifest | undefined
	let role: Role | undefined
	let model: PairedScriptedAI | undefined
	let stage = "bootstrap"
	try {
		const artifactsRoot = process.env.ALPHA_PAIR_ARTIFACTS
		const runId = process.env.ALPHA_PAIR_RUN_ID
		assert.ok(artifactsRoot && runId)
		directory = await requireEvidenceRun(artifactsRoot, runId)
		manifest = validateManifest(await readOptional(directory, "pair-manifest.json"))
		assert.equal(manifest.runId, runId)
		assert.equal(manifest.nonce, process.env.ALPHA_PAIR_NONCE)
		assert.equal(manifest.artifactsRoot, artifactsRoot)
		assert.ok(Number.isFinite(manifest.deadline) && manifest.deadline > Date.now())
		assert.equal(vscode.version, manifest.hostVersion)
		assert.ok(vscode.workspace.workspaceFile?.scheme === "file")
		const workspaceFile = await fs.realpath(vscode.workspace.workspaceFile.fsPath)
		role = ROLES.find((candidate) => manifest!.roles[candidate].workspaceFile === workspaceFile)
		assert.ok(role)
		await assertOwnedTestRoot(manifest.profileRoot, "profile")
		await assertOwnedTestRoot(manifest.roles[role].workspace, "workspace")
		assert.equal(vscode.workspace.workspaceFolders?.length, 1)
		const folder = vscode.workspace.workspaceFolders?.[0]
		assert.ok(folder)
		assert.equal(await fs.realpath(folder.uri.fsPath), manifest.roles[role].workspace)
		await assertRunnerAncestry(manifest.controllerPid)
		await publish(directory, `boot-${role}.json`, {
			runId,
			nonce: manifest.nonce,
			role,
			pid: process.pid,
			hostVersion: vscode.version,
			workspaceFile,
		})
		stage = "activation"
		const extension = vscode.extensions.getExtension<RooCodeAPI>(process.env.ALPHA_PAIR_EXTENSION_ID!)
		assert.ok(extension)
		const api = await extension.activate()
		await vscode.commands.executeCommand("alpha.SidebarProvider.focus")
		await waitUntil(async () => api.isReady(), manifest.deadline, "sidebar_timeout")
		const provider = (api as unknown as { sidebarProvider: Provider }).sidebarProvider
		await provider.agentControlStoreReady
		await rejectSymlinkComponents(provider.agentControlStore.persistence.filePath)
		const storagePath = await fs.realpath(provider.contextProxy.globalStorageUri.fsPath)
		assert.equal(await fs.realpath(path.dirname(provider.agentControlStore.persistence.filePath)), storagePath)
		assert.equal(path.basename(provider.agentControlStore.persistence.filePath), "agent_control.json")
		const identity: HostIdentity = {
			runId,
			nonce: manifest.nonce,
			role,
			pid: process.pid,
			hostVersion: vscode.version,
			workspaceFile,
			storagePath,
			persistenceFile: path.join(storagePath, "agent_control.json"),
		}
		await publish(directory, `ready-${role}.json`, identity)
		const waitPhase = async (name: string) =>
			waitUntil(
				async () => {
					const value = await readOptional(directory!, `${name}.json`)
					if (value === undefined) return false
					requireNonce(value, manifest!)
					return true
				},
				manifest!.deadline,
				`${name}_timeout`,
			)
		stage = "start_barrier"
		await waitPhase("start")
		model = new PairedScriptedAI(manifest.nonce, role, async () => {
			await publish(directory!, `entered-${role}.json`, identity)
			await waitPhase("respond")
		})
		const completed = new Set<string>()
		const onCompleted = (id: string) => completed.add(id)
		api.on(RooCodeEventName.TaskCompleted, onCompleted)
		try {
			stage = "configuration"
			const configuration = {
				...api.getConfiguration(),
				apiProvider: "fake-ai" as const,
				fakeAi: model,
				mode: "ask",
				disabledTools: [...toolNames],
				mcpEnabled: false,
				autoApprovalEnabled: true,
				alwaysAllowModeSwitch: true,
				alwaysAllowExecute: false,
				alwaysAllowWrite: false,
				alwaysAllowMcp: false,
				alwaysAllowSubagents: false,
				alwaysAllowSubtasks: false,
				enableCheckpoints: false,
				requestDelaySeconds: 0,
				writeDelayMs: 0,
			}
			await api.setConfiguration(configuration)
			stage = "task_start"
			const taskId = await api.startNewTask({
				configuration,
				text: "Reply briefly without using tools or commands.",
			})
			await publish(directory, `task-${role}.json`, { ...identity, taskId })
			stage = "task_await"
			let approved = false
			await waitUntil(
				async () => {
					const ask = provider.getLiveTask(taskId)?.taskAsk?.ask
					if (ask === "completion_result" && !approved) {
						approved = true
						provider.getLiveTask(taskId)!.approveAsk()
					} else if (ask && ask !== "completion_result") throw new Error("unexpected_task_ask")
					return completed.has(taskId) && provider.getAgentLifecycleSnapshot(taskId)?.status === "completed"
				},
				manifest.deadline,
				"task_timeout",
			)
			stage = "durability"
			const task = provider.getLiveTask(taskId)
			assert.ok(task)
			await task.waitForTermination()
			await task.flushApiConversationHistoryPersistence()
			const { taskDirPath } = await provider.getTaskWithId(taskId)
			assert.equal(await fs.realpath(taskDirPath), await fs.realpath(path.join(storagePath, "tasks", taskId)))
			const journal = (await readBounded(path.join(taskDirPath, "agent_lifecycle_events.jsonl"), 262_144))
				.toString("utf8")
				.split(/\r?\n/)
				.filter(Boolean)
				.map((line) => JSON.parse(line))
			const lifecycle = inspectTaskLifecycle(journal, taskId)
			assert.deepEqual(lifecycle.errors, [])
			assert.equal(lifecycle.completedTurns, 1)
			const history = JSON.parse(
				(await readBounded(path.join(taskDirPath, "api_conversation_history.json"), 262_144)).toString("utf8"),
			)
			assert.ok(Array.isArray(history) && history.length > 0)
			assert.deepEqual(inspectToolTransactions(history), { callCount: 0, resultCount: 0, errors: [] })
			assert.equal(model.requests, 1)
			await publish(directory, `done-${role}.json`, {
				...identity,
				taskId,
				requests: model.requests,
				terminalCount: 1,
			})
		} finally {
			api.off(RooCodeEventName.TaskCompleted, onCompleted)
		}
	} catch (error) {
		if (directory && manifest && role) {
			await publish(directory, `failed-${role}.json`, {
				runId: manifest.runId,
				nonce: manifest.nonce,
				role,
				stage,
				code: failureCode(error),
				requests: model?.requests ?? 0,
			})
		} else {
			// A bootstrap failure is still fail-closed: the controller cannot collect two identities.
			console.error("paired-host bootstrap failed")
		}
	}
	// Deliberately do not signal EH test completion: either host could otherwise shut down the application.
	// The bounded external controller owns and terminates the whole still-live family after collecting both outcomes.
	await new Promise<void>(() => {})
}
