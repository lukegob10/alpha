import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import * as vscode from "vscode"
import { type ClineMessage } from "@alpha-code/types"
import { createCompletionReviewAcknowledger, withBoundedFixtureCleanup } from "./proportional-context-support"
import { waitFor } from "./utils"

interface ApprovalTask {
	taskId: string
	didComplete: boolean
	abort: boolean
	taskAsk?: ClineMessage
	clineMessages: ClineMessage[]
	approveAsk(): void
	waitForTermination(): Promise<void>
}
interface Observation {
	task?: ApprovalTask
	requests: number
	commands: string[]
}
const observations = new WeakMap<object, Observation>()
class CommandPathAI {
	readonly id = "command-path-host"
	removeFromCache?: () => void
	constructor(
		observation: Observation,
		private readonly resolveTask: (id: string) => ApprovalTask,
	) {
		observations.set(this, observation)
	}
	async *createMessage(_system: string, messages: unknown[], metadata?: { taskId?: string }) {
		assert.ok(metadata?.taskId)
		const observation = observations.get(this)!
		observation.task = this.resolveTask(metadata.taskId)
		const index = observation.requests++
		if (index === 1) assert.ok(JSON.stringify(messages).includes("ALPHA_COMMAND_OK"), "The inline script must run")
		if (index < observation.commands.length) {
			yield {
				type: "tool_call" as const,
				id: `path-command-${index}`,
				name: "execute_command",
				arguments: JSON.stringify({ command: observation.commands[index], timeout: 90 }),
			}
		} else {
			assert.equal(index, observation.commands.length, "No unexpected model retries")
			yield { type: "text" as const, text: "Command and path approval verified." }
		}
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

suite("Command and path approval in the extension host", function () {
	this.timeout(180_000)
	test("auto-approves scripts and requests a new path approval for each outside write", async () => {
		assert.equal(vscode.version, "1.122.1")
		const workspace = process.env.ALPHA_E2E_WORKSPACE
		const artifacts = process.env.ALPHA_E2E_ARTIFACTS_DIR
		assert.ok(workspace && artifacts)
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-command-path-host-"))
		const sentinel = path.join(outside, "sentinel.txt")
		const scriptPath = path.join(workspace, "alpha-command-check.cjs")
		const outputPath = path.join(workspace, "alpha-command-result.txt")
		const configuration = globalThis.api.getConfiguration()
		const provider = (
			globalThis.api as unknown as {
				sidebarProvider: {
					getLiveTask(id: string): ApprovalTask | undefined
					context: { globalStorageUri: vscode.Uri }
				}
			}
		).sidebarProvider
		const observation: Observation = {
			requests: 0,
			commands: [
				"node alpha-command-check.cjs",
				`echo approved-once > "${sentinel}"`,
				`echo approved-again > "${sentinel}"`,
			],
		}
		const scripted = new CommandPathAI(observation, (id) => {
			const task = provider.getLiveTask(id)
			assert.ok(task)
			return task
		})
		const acknowledgeCompletion = createCompletionReviewAcknowledger()
		const handled = new Set<number>()
		let approvalCount = 0
		await withBoundedFixtureCleanup(async () => {
			await fs.writeFile(sentinel, "unchanged", { flag: "wx" })
			await fs.writeFile(
				scriptPath,
				"require('node:fs').writeFileSync('alpha-command-result.txt', 'inside'); console.log('ALPHA_COMMAND_OK');",
				{ flag: "wx" },
			)
			await globalThis.api.startNewTask({
				text: "Run the command checks and report the result.",
				configuration: {
					...configuration,
					apiProvider: "fake-ai",
					fakeAi: scripted,
					mode: "code",
					autoApprovalEnabled: true,
					alwaysAllowExecute: true,
					allowedCommands: ["*"],
					deniedCommands: [],
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
					if (ask?.ask === "command" && ask.progressStatus?.commandPathApproval && !handled.has(ask.ts)) {
						assert.deepEqual(ask.progressStatus.commandPathApproval.outsidePaths, [sentinel])
						assert.equal(ask.progressStatus.commandPathApproval.unresolved, false)
						assert.equal(
							(await fs.readFile(sentinel, "utf8")).trim(),
							approvalCount === 0 ? "unchanged" : "approved-once",
						)
						handled.add(ask.ts)
						approvalCount++
						task!.approveAsk()
					}
					acknowledgeCompletion(task)
					return task?.didComplete === true
				},
				{ description: "global command auto-approval and one-run path reviews", timeout: 150_000 },
			)
			await observation.task!.waitForTermination()
			assert.equal(observation.requests, 4)
			assert.equal(approvalCount, 2)
			assert.equal(await fs.readFile(outputPath, "utf8"), "inside")
			assert.equal((await fs.readFile(sentinel, "utf8")).trim(), "approved-again")
			assert.deepEqual(globalThis.api.getConfiguration().allowedCommands, ["*"])
			await assert.rejects(
				fs.access(path.join(provider.context.globalStorageUri.fsPath, "command-sandbox", "runtime")),
			)
			await fs.writeFile(
				path.join(artifacts, "command-path-approval.json"),
				JSON.stringify(
					{
						schemaVersion: 1,
						hostVersion: vscode.version,
						ordinaryCommandApprovals: 0,
						outsidePathApprovals: approvalCount,
						repeatedOutsideWriteAskedAgain: true,
						runtimeInstalled: false,
					},
					null,
					2,
				),
				{ flag: "wx" },
			)
		}, [
			() => globalThis.api.clearCurrentTask(),
			() => scripted.removeFromCache?.(),
			() => globalThis.api.setConfiguration(configuration),
			() => fs.rm(scriptPath, { force: true }),
			() => fs.rm(outputPath, { force: true }),
			() => fs.rm(outside, { recursive: true, force: true }),
		])
	})
})
