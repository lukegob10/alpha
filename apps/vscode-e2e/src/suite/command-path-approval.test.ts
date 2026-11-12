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
	alphaMessages: AlphaMessage[]
	approveAsk(): void
	waitForTermination(): Promise<void>
}
interface Observation {
	task?: ApprovalTask
	requests: number
	commands: Array<{ cmd: string; workdir?: string; tty?: boolean }>
}
const observations = new WeakMap<object, Observation>()
const powerShellLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`
class CommandPathAI {
	readonly id = "command-path-host"
	removeFromCache?: () => void
	constructor(
		observation: Observation,
		private readonly resolveTask: (id: string) => ApprovalTask,
		private readonly checkResponse: (system: string, messages: unknown[], index: number) => void,
	) {
		observations.set(this, observation)
	}
	async *createMessage(system: string, messages: unknown[], metadata?: { taskId?: string; attemptId?: string }) {
		if (metadata?.attemptId === "title") {
			yield { type: "text" as const, text: "Fixture task" }
			return
		}
		assert.ok(metadata?.taskId)
		const observation = observations.get(this)!
		observation.task = this.resolveTask(metadata.taskId)
		const index = observation.requests++
		this.checkResponse(system, messages, index)
		const command = observation.commands[index]
		if (command) {
			yield {
				type: "tool_call" as const,
				id: `path-command-${index}`,
				name: "exec_command",
				arguments: JSON.stringify({ ...command, yield_time_ms: 10_000 }),
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
		assert.equal(vscode.version, "1.141.0")
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
		const writeSentinel = (value: string) =>
			process.platform === "win32"
				? `Set-Content -LiteralPath ${powerShellLiteral(sentinel)} -Value ${value} -Encoding UTF8`
				: `echo ${value} > "${sentinel}"`
		const observation: Observation = {
			requests: 0,
			commands: [
				{ cmd: "node alpha-command-check.cjs" },
				{ cmd: writeSentinel("approved-once") },
				{ cmd: writeSentinel("approved-again") },
			],
		}
		const scripted = new CommandPathAI(
			observation,
			(id) => {
				const task = provider.getLiveTask(id)
				assert.ok(task)
				return task
			},
			(_system, messages, index) => {
				if (index === 1)
					assert.ok(JSON.stringify(messages).includes("ALPHA_COMMAND_OK"), "The inline script must run")
			},
		)
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
					approvalMode: "auto",
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
					const error = task?.alphaMessages.find((message) => message.say === "error")
					assert.equal(error, undefined, error?.text)
					const ask = task?.taskAsk
					if (
						ask?.ask === "command" &&
						ask.toolApprovalRequest?.commandPathApproval &&
						!handled.has(ask.ts)
					) {
						assert.deepEqual(ask.toolApprovalRequest.commandPathApproval.outsidePaths, [sentinel])
						assert.equal(ask.toolApprovalRequest.commandPathApproval.unresolved, false)
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

	if (process.platform === "win32") {
		test("uses Windows PowerShell 5.1 for pipes and TTY even with a Command Prompt profile", async () => {
			assert.equal(vscode.version, process.env.ALPHA_E2E_EXPECTED_VSCODE_VERSION ?? "1.141.0")
			const outside = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-windows-command-host-"))
			const pipesFile = path.join(outside, "piped input.txt")
			const ttyFile = path.join(outside, "terminal input.txt")
			const markers = ["PIPED caf\u00e9 \u4f60", "TERMINAL caf\u00e9 \u4f60"]
			const versionCheck =
				"if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) { throw 'Expected Windows PowerShell 5.1' }"
			const readFile = (file: string) =>
				`${versionCheck}; Get-Content -LiteralPath ${powerShellLiteral(file)} -Encoding UTF8`
			const observation: Observation = {
				requests: 0,
				commands: [
					{ cmd: readFile(path.basename(pipesFile)), workdir: outside },
					{ cmd: readFile(ttyFile), tty: true },
				],
			}
			const configuration = globalThis.api.getConfiguration()
			const provider = (
				globalThis.api as unknown as { sidebarProvider: { getLiveTask(id: string): ApprovalTask | undefined } }
			).sidebarProvider
			const scripted = new CommandPathAI(
				observation,
				(id) => {
					const task = provider.getLiveTask(id)
					assert.ok(task)
					return task
				},
				(system, messages, index) => {
					assert.match(system, /^Default Shell: .*\\WindowsPowerShell\\v1\.0\\powershell\.exe$/im)
					assert.ok(system.includes("use Windows PowerShell 5.1"))
					if (index > 0) {
						assert.ok(
							JSON.stringify(messages).includes(markers[index - 1]!),
							"Expected intact Unicode output",
						)
					}
				},
			)
			const terminalConfiguration = vscode.workspace.getConfiguration("terminal.integrated")
			const savedProfile = terminalConfiguration.inspect<string>("defaultProfile.windows")?.globalValue
			let ttyExecution: vscode.TerminalShellExecutionEndEvent | undefined
			const listener = vscode.window.onDidEndTerminalShellExecution((event) => {
				if (event.execution.commandLine.value.includes(path.basename(ttyFile))) ttyExecution = event
			})
			const acknowledgeCompletion = createCompletionReviewAcknowledger()
			await withBoundedFixtureCleanup(async () => {
				await fs.writeFile(pipesFile, markers[0]!, { flag: "wx" })
				await fs.writeFile(ttyFile, markers[1]!, { flag: "wx" })
				await terminalConfiguration.update(
					"defaultProfile.windows",
					"Command Prompt",
					vscode.ConfigurationTarget.Global,
				)
				await globalThis.api.startNewTask({
					text: "Read the two supplied external fixtures using pipes and an interactive terminal.",
					configuration: {
						...configuration,
						apiProvider: "fake-ai",
						fakeAi: scripted,
						mode: "code",
						approvalMode: "bypass",
						allowedCommands: [],
						deniedCommands: [],
						terminalShellIntegrationDisabled: false,
						enableCheckpoints: false,
						requestDelaySeconds: 0,
					},
				})
				await waitFor(
					() => {
						const task = observation.task
						const error = task?.alphaMessages.find((message) => message.say === "error")
						assert.equal(error, undefined, error?.text)
						assert.notEqual(task?.taskAsk?.ask, "command", "Full Access unexpectedly requested approval")
						acknowledgeCompletion(task)
						return task?.didComplete === true
					},
					{ description: "Windows PowerShell commands and final review", timeout: 120_000 },
				)
				await observation.task!.waitForTermination()
				assert.equal(observation.requests, 3)
				assert.ok(ttyExecution, "The TTY command must execute in a VS Code terminal")
				assert.equal(ttyExecution.exitCode, 0)
				const options = ttyExecution.terminal.creationOptions as vscode.TerminalOptions
				assert.match(options.shellPath ?? "", /\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i)
				assert.deepEqual(options.shellArgs, [])
			}, [
				() => globalThis.api.clearCurrentTask(),
				() => scripted.removeFromCache?.(),
				() => globalThis.api.setConfiguration(configuration),
				() =>
					terminalConfiguration.update(
						"defaultProfile.windows",
						savedProfile,
						vscode.ConfigurationTarget.Global,
					),
				() => listener.dispose(),
				() => ttyExecution?.terminal.dispose(),
				() => fs.rm(pipesFile, { force: true }),
				() => fs.rm(ttyFile, { force: true }),
				() => fs.rmdir(outside),
			])
		})
	}
})
