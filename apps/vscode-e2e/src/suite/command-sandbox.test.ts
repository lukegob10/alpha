import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import * as vscode from "vscode"
import { type ClineMessage } from "@alpha-code/types"
import { createCompletionReviewAcknowledger, withBoundedFixtureCleanup } from "./proportional-context-support"
import { waitFor } from "./utils"

interface SandboxTask {
	taskId: string
	didComplete: boolean
	abort: boolean
	taskAsk?: ClineMessage
	clineMessages: ClineMessage[]
	approveAsk(): void
	waitForTermination(): Promise<void>
}

interface Observation {
	task?: SandboxTask
	requests: number
}

// Keep host objects outside the serializable fake-provider configuration.
const observations = new WeakMap<object, Observation>()
class SandboxAI {
	readonly id = "command-sandbox-host"
	removeFromCache?: () => void
	constructor(
		observation: Observation,
		private readonly resolveTask: (id: string) => SandboxTask,
	) {
		observations.set(this, observation)
	}
	async *createMessage(_system: string, messages: unknown[], metadata?: { taskId?: string }) {
		assert.ok(metadata?.taskId)
		const observation = observations.get(this)!
		observation.task = this.resolveTask(metadata.taskId)
		observation.requests++
		if (observation.requests === 1) {
			yield {
				type: "tool_call" as const,
				id: "sandbox-command",
				name: "execute_command",
				arguments: JSON.stringify({ command: "node alpha-sandbox-check.cjs", timeout: 90 }),
			}
		} else {
			assert.equal(observation.requests, 2, "A failed sandbox command must not be hidden by a model retry")
			assert.ok(JSON.stringify(messages).includes("ALPHA_SCOPE_OK"), "The actual sandbox command must succeed")
			yield { type: "text" as const, text: "Sandbox command verified." }
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

suite("Native command sandbox in the extension host", function () {
	this.timeout(360_000)
	test("auto-approves the saved wildcard and enforces the write scope through the production launcher", async () => {
		assert.equal(vscode.version, "1.122.1")
		const workspace = process.env.ALPHA_E2E_WORKSPACE
		const artifacts = process.env.ALPHA_E2E_ARTIFACTS_DIR
		assert.ok(workspace && artifacts)
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-sandbox-host-outside-"))
		const sentinel = path.join(outside, "sentinel.txt")
		const scriptPath = path.join(workspace, "alpha-sandbox-check.cjs")
		const outputPath = path.join(workspace, "alpha-sandbox-result.txt")
		const configuration = globalThis.api.getConfiguration()
		const provider = (
			globalThis.api as unknown as { sidebarProvider: { getLiveTask(id: string): SandboxTask | undefined } }
		).sidebarProvider
		const observation: Observation = { requests: 0 }
		const scripted = new SandboxAI(observation, (id) => {
			const task = provider.getLiveTask(id)
			assert.ok(task)
			return task
		})
		const acknowledgeCompletion = createCompletionReviewAcknowledger()
		await withBoundedFixtureCleanup(async () => {
			await fs.writeFile(sentinel, "unchanged", { flag: "wx" })
			await fs.writeFile(
				scriptPath,
				`
const fs = require('node:fs'), assert = require('node:assert/strict');
const sentinel = ${JSON.stringify(sentinel)};
assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged');
for (const operation of [() => fs.writeFileSync(sentinel, 'escaped'), () => fs.unlinkSync(sentinel)]) {
 assert.throws(operation, error => ['EPERM', 'EACCES', 'EROFS'].includes(error.code));
}
fs.writeFileSync('alpha-sandbox-result.txt', 'inside');
console.log('ALPHA_SCOPE_OK');
`,
				{ flag: "wx" },
			)
			await globalThis.api.startNewTask({
				text: "Run the sandbox check script and report whether it succeeds.",
				configuration: {
					...configuration,
					apiProvider: "fake-ai",
					fakeAi: scripted,
					mode: "code",
					autoApprovalEnabled: true,
					alwaysAllowExecute: true,
					allowedCommands: ["*"],
					deniedCommands: [],
					enableCheckpoints: false,
					requestDelaySeconds: 0,
					writeDelayMs: 0,
				},
			})
			await waitFor(
				() => {
					const task = observation.task
					const error = task?.clineMessages.find((message) => message.say === "error")
					assert.equal(error, undefined, error?.text)
					acknowledgeCompletion(task)
					return task?.didComplete === true
				},
				{ description: "automatically approved native command", timeout: 330_000 },
			)
			await observation.task!.waitForTermination()
			assert.equal(observation.requests, 2)
			assert.equal(await fs.readFile(outputPath, "utf8"), "inside")
			assert.equal(await fs.readFile(sentinel, "utf8"), "unchanged")
			assert.deepEqual(globalThis.api.getConfiguration().allowedCommands, ["*"])
			await fs.writeFile(
				path.join(artifacts, "command-sandbox.json"),
				JSON.stringify(
					{
						schemaVersion: 1,
						hostVersion: vscode.version,
						taskId: observation.task!.taskId,
						requests: observation.requests,
						commandApprovalsByHarness: 0,
						insideWrite: true,
						outsideWriteBlocked: true,
						outsideDeleteBlocked: true,
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
