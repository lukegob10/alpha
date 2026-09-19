import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import * as vscode from "vscode"
import {
	agentControlStateSchema,
	type AlphaCodeSettings,
	type HistoryItem,
	type SubagentGroupState,
	type SubagentSpawnHandle,
	type SubagentChangeSetActionResult,
	type SubagentChangeSetActionCapability,
} from "@alpha-code/types"
import { readBounded } from "../evidence/paths"
import { waitFor } from "./utils"

const execute = promisify(execFile)
const RECEIPT = "nested-restart.json"
interface LiveTask {
	taskId: string
	taskAsk?: { ask?: string }
	approveAsk(): void
	flushApiConversationHistoryPersistence(): Promise<void>
	getTaskLifetimeCancellationSignal(): AbortSignal
}
interface Prepared {
	group: SubagentGroupState
	requiresExplicitApproval?: boolean
}
interface Provider {
	taskHistoryStoreReady: Promise<void>
	agentControlStoreReady: Promise<void>
	agentControlStore: { getSnapshot(): unknown }
	getLiveTask(id: string): LiveTask | undefined
	getTaskWithId(id: string): Promise<{ historyItem: HistoryItem; taskDirPath: string }>
	prepareSubagentGroup(parent: LiveTask, drafts: unknown): Promise<Prepared>
	launchPreparedSubagentGroup(parent: LiveTask, prepared: Prepared, signal: AbortSignal): Promise<SubagentSpawnHandle>
	showTaskWithId(id: string): Promise<void>
	createTaskWithHistoryItem(
		history: HistoryItem,
		options: { preserveExisting: boolean; subagentRuntime: { apiConfiguration: AlphaCodeSettings } },
	): Promise<LiveTask>
	cancelAgent(parent: LiveTask, target: string): Promise<unknown>
	closeAgent(parent: LiveTask, target: string): Promise<unknown>
	discardSubagentChangeSet(
		parentId: string,
		groupId: string,
		changeSetId: string,
	): Promise<SubagentChangeSetActionResult>
	getSubagentChangeSetActionCapability(
		parentId: string,
		groupId: string,
		changeSetId: string,
	): Promise<SubagentChangeSetActionCapability>
	flushGlobalStateWriteThrough(): Promise<void>
}

// Open streams keep real tasks active until the externally controlled host termination.
// No model-generated statement is used as delegation authorization.
class HoldingAI {
	id = "nested-restart-scripted"
	removeFromCache?: () => void
	readonly entered = new Set<string>()
	private readonly release = new Set<() => void>()
	private readonly turns = new Map<string, number>()
	nestedId?: string
	async *createMessage(_system: string, _messages: unknown[], metadata?: { taskId?: string }) {
		const id = metadata?.taskId
		assert.ok(id)
		const turn = this.turns.get(id) ?? 0
		this.turns.set(id, turn + 1)
		if (id === this.nestedId && turn === 0) {
			yield {
				type: "tool_call" as const,
				id: `write-${id}`,
				name: "write_to_file",
				arguments: JSON.stringify({ path: "scope/nested.json", content: '{"recovered":true}\n' }),
			}
			return
		}
		yield { type: "text" as const, text: "The controlled restart fixture is holding this task open." }
		this.entered.add(id)
		await new Promise<void>((resolve) => this.release.add(resolve))
	}
	dispose() {
		for (const release of this.release) release()
		this.release.clear()
	}
	getModel() {
		return {
			id: this.id,
			info: {
				contextWindow: 128_000,
				maxTokens: 8192,
				supportsImages: false,
				supportsPromptCache: false,
				inputPrice: 0,
				outputPrice: 0,
			},
		}
	}
	async countTokens(content: unknown[]) {
		return Math.max(1, Math.ceil(JSON.stringify(content).length / 4))
	}
	async completePrompt() {
		return ""
	}
}

suite("Nested managed-agent host restart", function () {
	this.timeout(120_000)
	test("retains hierarchy, routes results, releases capacity and recovers Worker artifacts", async function () {
		const workspace = process.env.ALPHA_E2E_WORKSPACE!
		const artifacts = process.env.ALPHA_E2E_ARTIFACTS_DIR!
		const phase = process.env.ALPHA_E2E_NESTED_PHASE
		if (!phase) {
			this.skip()
			return
		}
		assert.ok(phase === "prepare" || phase === "recover")
		assert.equal(vscode.version, "1.122.1")
		const api = globalThis.api
		const provider = (api as unknown as { sidebarProvider: Provider }).sidebarProvider
		await Promise.all([provider.taskHistoryStoreReady, provider.agentControlStoreReady])
		const model = new HoldingAI()
		const configuration: AlphaCodeSettings = {
			apiProvider: "fake-ai",
			fakeAi: model,
			mode: "code",
			autoApprovalEnabled: true,
			alwaysAllowReadOnly: true,
			alwaysAllowWrite: true,
			alwaysAllowSubagents: true,
			alwaysAllowExecute: false,
			alwaysAllowFollowupQuestions: false,
			mcpEnabled: false,
			enableCheckpoints: false,
			requestDelaySeconds: 0,
			writeDelayMs: 0,
			maxConcurrentTasks: 3,
			maxConcurrentSubagents: 2,
			subagentMaxDepth: 2,
			subagentDelegationPolicy: "proactive",
			subagentRoleTimeoutsMs: { worker: 120_000 },
			subagentMaxInputTokens: 250_000,
			subagentMaxOutputTokens: 16_000,
			subagentRootTokenBudget: null,
			subagentRootCostBudget: null,
		}
		await api.setConfiguration(configuration)
		const snapshot = () => agentControlStateSchema.parse(provider.agentControlStore.getSnapshot())
		const launch = async (parent: LiveTask, name: string, role: "worker" | "review", scope?: string[]) => {
			const prepared = await provider.prepareSubagentGroup(parent, [
				{
					task_name: name,
					agent_kind: role,
					fork_turns: "none",
					objective: "Hold for the controlled host restart.",
					...(scope ? { write_scope: scope } : {}),
				},
			])
			assert.notEqual(
				prepared.requiresExplicitApproval,
				true,
				"Fixture must use actual proactive auto-approval settings",
			)
			if (name === "nested") model.nestedId = prepared.group.agents[0]!.taskId
			return provider.launchPreparedSubagentGroup(parent, prepared, parent.getTaskLifetimeCancellationSignal())
		}
		try {
			if (phase === "prepare") {
				await fs.mkdir(path.join(workspace, "scope"), { recursive: true })
				await fs.writeFile(path.join(workspace, "scope/nested.json"), '{"recovered":false}\n', { flag: "wx" })
				for (const args of [
					["init"],
					["add", "."],
					[
						"-c",
						"user.name=Alpha E2E",
						"-c",
						"user.email=e2e@local.invalid",
						"commit",
						"-m",
						"restart fixture",
					],
				])
					await execute("git", args, { cwd: workspace, windowsHide: true })
				const rootId = await api.startNewTask({
					configuration,
					text: "Hold for the controlled restart fixture.",
				})
				await waitFor(() => model.entered.has(rootId), { timeout: 30_000 })
				const root = provider.getLiveTask(rootId)!
				const outer = await launch(root, "outer", "worker", ["scope"])
				await waitFor(() => model.entered.has(outer.taskId), { timeout: 30_000 })
				const nested = await launch(provider.getLiveTask(outer.taskId)!, "nested", "worker", [
					"scope/nested.json",
				])
				await waitFor(() => model.entered.has(nested.taskId), { timeout: 30_000 })
				const before = snapshot()
				assert.equal(before.agents.filter((agent) => agent.rootTaskId === rootId).length, 3)
				await assert.rejects(launch(root, "over_capacity", "review"), /capacity|concurrent|limit|slots/i)
				for (const id of [rootId, outer.taskId, nested.taskId])
					await provider.getLiveTask(id)!.flushApiConversationHistoryPersistence()
				await provider.flushGlobalStateWriteThrough()
				await fs.writeFile(
					path.join(artifacts, RECEIPT),
					JSON.stringify({
						phase,
						pid: process.pid,
						rootId,
						outerId: outer.taskId,
						nestedId: nested.taskId,
						capacityDenied: true,
						state: before,
					}),
					{ flag: "wx" },
				)
				// Abruptly terminate only this owned extension-host process. No deactivate/cleanup callback runs.
				process.exit(73)
			} else {
				const priorPath = process.env.ALPHA_E2E_NESTED_PRIOR!
				const prior = JSON.parse((await readBounded(priorPath, 2 * 1024 * 1024)).toString("utf8")) as {
					rootId: string
					outerId: string
					nestedId: string
				}
				const state = snapshot()
				const records = [prior.rootId, prior.outerId, prior.nestedId].map((id) => {
					const matches = state.agents.filter((agent) => agent.taskId === id)
					assert.equal(matches.length, 1)
					assert.equal(matches[0]!.status, "interrupted")
					return matches[0]!
				})
				assert.equal(records[1]!.parentTaskId, prior.rootId)
				assert.equal(records[2]!.parentTaskId, prior.outerId)
				const results = state.mailbox.filter(
					(event) =>
						event.kind === "result" && [prior.outerId, prior.nestedId].includes(event.senderTaskId ?? ""),
				)
				for (const [sender, recipient] of [
					[prior.outerId, prior.rootId],
					[prior.nestedId, prior.outerId],
				]) {
					const events = results.filter((event) => event.senderTaskId === sender)
					assert.equal(events.length, 1, "Recovered terminal result must exist exactly once")
					assert.equal(events[0]!.recipientTaskId, recipient)
				}
				const outerHistory = (await provider.getTaskWithId(prior.outerId)).historyItem
				const nestedHistory = (await provider.getTaskWithId(prior.nestedId)).historyItem
				assert.equal(nestedHistory.subagentChangeSet?.status, "pending_review")
				assert.ok(["unavailable", "discarded"].includes(outerHistory.subagentChangeSet?.status ?? ""))
				const storage = path.dirname(path.dirname((await provider.getTaskWithId(prior.rootId)).taskDirPath))
				let orphanWorktrees: string[]
				try {
					orphanWorktrees = await fs.readdir(path.join(storage, "subagent-worktrees"))
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
					orphanWorktrees = []
				}
				assert.deepEqual(orphanWorktrees, [], "Recovered Worker worktrees must not remain live or orphaned")
				// Executable fake-provider callbacks cannot survive serialization. Supply them through
				// the existing rehydration adapter while preserving the persisted task identity/policy.
				const root = await provider.createTaskWithHistoryItem(
					(await provider.getTaskWithId(prior.rootId)).historyItem,
					{ preserveExisting: true, subagentRuntime: { apiConfiguration: configuration } },
				)
				assert.ok(root)
				await waitFor(
					() => root.taskAsk?.ask === "resume_task" || root.taskAsk?.ask === "resume_completed_task",
					{ timeout: 30_000 },
				)
				root.approveAsk()
				await waitFor(
					() =>
						model.entered.has(prior.rootId) &&
						snapshot().agents.find((agent) => agent.taskId === prior.rootId)?.status === "running",
					{ timeout: 30_000 },
				)
				const replacement = await launch(root, "capacity_probe", "review")
				await waitFor(() => model.entered.has(replacement.taskId), { timeout: 30_000 })
				await provider.cancelAgent(root, replacement.taskId)
				await waitFor(
					() =>
						snapshot().agents.find((agent) => agent.taskId === replacement.taskId)?.status === "cancelled",
					{ timeout: 30_000 },
				)
				await provider.closeAgent(root, replacement.taskId)
				const changeSet = nestedHistory.subagentChangeSet!
				await provider.showTaskWithId(prior.outerId)
				await waitFor(
					async () =>
						(
							await provider.getSubagentChangeSetActionCapability(
								prior.outerId,
								records[2]!.groupId!,
								changeSet.id,
							)
						).actions.discard.allowed,
					{ timeout: 30_000 },
				)
				const discarded = await provider.discardSubagentChangeSet(
					prior.outerId,
					records[2]!.groupId!,
					changeSet.id,
				)
				assert.equal(discarded.success, true, discarded.message)
				assert.equal(discarded.changeSetStatus, "discarded")
				assert.equal(
					await fs.readFile(path.join(workspace, "scope/nested.json"), "utf8"),
					'{"recovered":false}\n',
				)
				await fs.writeFile(
					path.join(artifacts, RECEIPT),
					JSON.stringify({
						phase,
						pid: process.pid,
						rootId: prior.rootId,
						outerId: prior.outerId,
						nestedId: prior.nestedId,
						identityPreserved: true,
						immediateParentResults: results.map(({ eventId, senderTaskId, recipientTaskId }) => ({
							eventId,
							senderTaskId,
							recipientTaskId,
						})),
						capacityReused: true,
						partialWorkerRecovered: true,
						emptyWorkerRecovered: true,
						nestedDiscarded: true,
					}),
					{ flag: "wx" },
				)
			}
		} finally {
			model.dispose()
		}
	})
})
