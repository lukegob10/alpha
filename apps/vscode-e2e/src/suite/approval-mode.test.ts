import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import * as vscode from "vscode"
import { type AlphaMessage } from "@alpha-code/types"
import { createCompletionReviewAcknowledger, withBoundedFixtureCleanup } from "./proportional-context-support"
import { waitFor } from "./utils"

interface ApprovalTask {
	taskId: string
	didComplete: boolean
	abort: boolean
	taskAsk?: AlphaMessage
	clineMessages: AlphaMessage[]
	approveAsk(): void
	denyAsk(): void
	waitForTermination(): Promise<void>
}

interface Observation {
	task?: ApprovalTask
	requests: number
	calls: Array<{ name: string; arguments: Record<string, unknown> }>
}

const observations = new WeakMap<object, Observation>()

class ApprovalModeAI {
	readonly id = "approval-mode-host"
	removeFromCache?: () => void
	constructor(
		observation: Observation,
		private readonly resolveTask: (id: string) => ApprovalTask,
	) {
		observations.set(this, observation)
	}
	async *createMessage(_system: string, _messages: unknown[], metadata?: { taskId?: string }) {
		assert.ok(metadata?.taskId)
		const observation = observations.get(this)!
		observation.task = this.resolveTask(metadata.taskId)
		const index = observation.requests++
		if (index < observation.calls.length) {
			const call = observation.calls[index]!
			yield {
				type: "tool_call" as const,
				id: `approval-mode-${index}`,
				name: call.name,
				arguments: JSON.stringify(call.arguments),
			}
			return
		}
		assert.equal(index, observation.calls.length, "No unexpected model retries")
		yield { type: "text" as const, text: "Approval mode verified." }
	}
	getModel() {
		return { id: this.id, info: { contextWindow: 128_000, maxTokens: 8192, supportsPromptCache: false } }
	}
	async countTokens() {
		return 1
	}
	async completePrompt() {
		return ""
	}
}

async function runScriptedApproval(options: {
	approvalMode: "ask" | "auto" | "bypass"
	calls: Observation["calls"]
	onAsk?: (task: ApprovalTask, ask: AlphaMessage) => void
}): Promise<{ asks: string[]; workspace: string; outside: string }> {
	assert.equal(vscode.version, "1.122.1")
	const workspace = process.env.ALPHA_E2E_WORKSPACE
	const artifacts = process.env.ALPHA_E2E_ARTIFACTS_DIR
	assert.ok(workspace && artifacts)
	const outside = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-approval-mode-"))
	const configuration = globalThis.api.getConfiguration()
	const provider = (
		globalThis.api as unknown as {
			sidebarProvider: { getLiveTask(id: string): ApprovalTask | undefined }
		}
	).sidebarProvider
	const observation: Observation = { requests: 0, calls: options.calls }
	const scripted = new ApprovalModeAI(observation, (id) => {
		const task = provider.getLiveTask(id)
		assert.ok(task)
		return task
	})
	const acknowledgeCompletion = createCompletionReviewAcknowledger()
	const handled = new Set<number>()
	const asks: string[] = []
	await withBoundedFixtureCleanup(async () => {
		await globalThis.api.startNewTask({
			text: "Exercise the session approval dial.",
			configuration: {
				...configuration,
				apiProvider: "fake-ai",
				fakeAi: scripted,
				mode: "code",
				approvalMode: options.approvalMode,
				subagentDelegationPolicy: "explicit-only",
				deniedCommands: ["rm"],
				terminalShellIntegrationDisabled: true,
				enableCheckpoints: false,
				requestDelaySeconds: 0,
				writeDelayMs: 0,
			},
		})
		await waitFor(
			async () => {
				const task = observation.task
				const error = task?.clineMessages.find((message) => message.say === "error")
				assert.equal(error, undefined, error?.text)
				const ask = task?.taskAsk
				if (ask && !ask.partial && !handled.has(ask.ts)) {
					handled.add(ask.ts)
					asks.push(ask.ask ?? "")
					options.onAsk?.(task!, ask)
				}
				acknowledgeCompletion(task)
				return task?.didComplete === true
			},
			{ description: `${options.approvalMode} approval-mode host`, timeout: 150_000 },
		)
		await observation.task!.waitForTermination()
	}, [
		() => globalThis.api.clearCurrentTask(),
		() => scripted.removeFromCache?.(),
		() => globalThis.api.setConfiguration(configuration),
		() => fs.rm(outside, { recursive: true, force: true }),
	])
	return { asks, workspace, outside }
}

suite("Ask / Auto / Full Access in the extension host", function () {
	this.timeout(180_000)

	test("Auto writes inside the opened workspace without asking", async () => {
		const { asks, workspace } = await runScriptedApproval({
			approvalMode: "auto",
			calls: [{ name: "write_to_file", arguments: { path: "src/approval-inside.txt", content: "inside" } }],
		})
		assert.deepEqual(
			asks.filter((ask) => ask !== "completion_result"),
			[],
		)
		assert.equal(await fs.readFile(path.join(workspace, "src", "approval-inside.txt"), "utf8"), "inside")
	})

	test("Auto still asks for a true-outside write", async () => {
		let rejected = false
		const outsideFile = path.join(os.tmpdir(), `alpha-approval-outside-${Date.now()}.txt`)
		const { asks } = await runScriptedApproval({
			approvalMode: "auto",
			calls: [
				{
					name: "write_to_file",
					arguments: { path: outsideFile, content: "outside" },
				},
			],
			onAsk: (task, ask) => {
				if (ask.ask === "tool") {
					rejected = true
					task.denyAsk()
				}
			},
		})
		assert.equal(rejected, true)
		assert.ok(asks.includes("tool"))
		await assert.rejects(fs.access(outsideFile))
	})

	test("Full Access auto-approves an outside write while the deny-list still denies", async () => {
		const outsideFile = path.join(os.tmpdir(), `alpha-approval-bypass-${Date.now()}.txt`)
		const { asks } = await runScriptedApproval({
			approvalMode: "bypass",
			calls: [
				{ name: "write_to_file", arguments: { path: outsideFile, content: "bypass" } },
				{ name: "shell", arguments: { command: "rm --help", timeout: 10 } },
			],
			onAsk: (task, ask) => {
				if (ask.ask === "command") task.denyAsk()
			},
		})
		assert.equal(await fs.readFile(outsideFile, "utf8"), "bypass")
		assert.ok(!asks.includes("tool"))
		assert.equal(asks.includes("command"), false, "deny-list must auto-deny rm without a human click")
		await fs.rm(outsideFile, { force: true })
	})

	test("Ask asks for an in-workspace write", async () => {
		let approved = false
		const { asks, workspace } = await runScriptedApproval({
			approvalMode: "ask",
			calls: [{ name: "write_to_file", arguments: { path: "src/approval-ask.txt", content: "ask" } }],
			onAsk: (task, ask) => {
				if (ask.ask === "tool") {
					approved = true
					task.approveAsk()
				}
			},
		})
		assert.equal(approved, true)
		assert.ok(asks.includes("tool"))
		assert.equal(await fs.readFile(path.join(workspace, "src", "approval-ask.txt"), "utf8"), "ask")
	})

	test("Auto + explicit-only spawn still raises a human spawn ask", async () => {
		let asked = false
		const { asks } = await runScriptedApproval({
			approvalMode: "auto",
			calls: [
				{
					name: "spawn_agent",
					arguments: {
						task_name: "approval_explore",
						fork_turns: "none",
						objective: "Inspect the opened workspace only.",
						agent_kind: "explore",
						write_scope: null,
						expected_output: null,
					},
				},
			],
			onAsk: (task, ask) => {
				if (ask.ask === "tool") {
					asked = true
					task.denyAsk()
				}
			},
		})
		assert.equal(asked, true)
		assert.ok(asks.includes("tool"), "explicit-only must keep a spawn dialog in Auto")
	})
})
