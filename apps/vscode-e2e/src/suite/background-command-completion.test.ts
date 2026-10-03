import { strict as assert } from "node:assert"
import { randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as vscode from "vscode"
import { AlphaCodeEventName, TaskLifecycleState, type AlphaMessage, type ExtensionState } from "@alpha-code/types"

import { readBoundedJson } from "../scenarios/extensionWorkflowHost"
import { inspectTaskLifecycle, inspectToolTransactions } from "../scenarios/transactionAssertions"
import { createCompletionReviewAcknowledger, withBoundedFixtureCleanup } from "./proportional-context-support"
import { waitFor } from "./utils"

interface LaunchTask {
	taskId: string
	didComplete: boolean
	abort: boolean
	taskAsk?: AlphaMessage
	clineMessages: AlphaMessage[]
	approveAsk(): void
	waitForTermination(): Promise<void>
	flushApiConversationHistoryPersistence(): Promise<void>
	getActiveBackgroundCommandExecutionIds(): string[]
	getCommandExecutionEvidence(): Array<{ executionId: string; status: string; exitCode?: number }>
}

interface LaunchProvider {
	getLiveTask(id: string): LaunchTask | undefined
	getTaskWithId(id: string): Promise<{ taskDirPath: string }>
	getStateToPostToWebview(): Promise<ExtensionState>
	getParentCompletionDecision(task: LaunchTask): Promise<{ allowed: boolean }>
	agentControlStore: {
		getVerificationObligations(filter: { parentTaskId: string }): Array<{ mutationReservations?: string[] }>
	}
}

interface Observation {
	requests: number
	task?: LaunchTask
	finalCandidateAt?: number
	completedAt?: number
	removeFromCache?: () => void
	resolveTask(id: string): LaunchTask
	ready(): Promise<void>
}

// Settings serialization must not traverse live Task or provider objects.
const observations = new WeakMap<object, Observation>()
class LaunchAI {
	constructor(
		readonly id: string,
		private readonly commands: string[],
		observation: Observation,
	) {
		observations.set(this, observation)
	}
	get removeFromCache() {
		return observations.get(this)!.removeFromCache
	}
	set removeFromCache(value: (() => void) | undefined) {
		observations.get(this)!.removeFromCache = value
	}
	async *createMessage(_system: string, _messages: unknown[], metadata?: { taskId?: string }) {
		const observation = observations.get(this)!
		assert.ok(metadata?.taskId)
		observation.task = observation.resolveTask(metadata.taskId)
		const request = observation.requests++
		assert.ok(request <= this.commands.length, "Launch completion must not require a repair request")
		if (request < this.commands.length) {
			yield {
				type: "tool_call" as const,
				id: "launch-" + request,
				name: "exec_command",
				arguments: JSON.stringify({ cmd: this.commands[request], yield_time_ms: 1000 }),
			}
			return
		}
		await observation.ready()
		observation.finalCandidateAt = Date.now()
		yield { type: "text" as const, text: "The application is ready and remains running." }
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

function serverSource(prefix: string, electron: boolean, artifacts: string): string {
	return [
		"const fs = require('node:fs'), path = require('node:path'), http = require('node:http')",
		"const role = process.argv.at(-1), receipt = path.join(" +
			JSON.stringify(artifacts) +
			"," +
			JSON.stringify(prefix) +
			" + '-' + role + '.json')",
		"let desktop, window, server",
		"async function start() {",
		"if(role === 'frontend') fs.writeFileSync(" + JSON.stringify(prefix + "-runtime.log") + ",'ready')",
		...(electron
			? [
					"desktop = require('electron').app",
					"desktop.setPath('userData', " + JSON.stringify(path.join(artifacts, prefix + "-user-data")) + ")",
					"await desktop.whenReady()",
					"window = new (require('electron').BrowserWindow)({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}})",
					"await window.loadURL('data:text/html,<title>Alpha launch fixture</title><h1>READY</h1>')",
					"if (await window.webContents.executeJavaScript('document.querySelector(\"h1\").textContent') !== 'READY') throw new Error('Renderer not ready')",
				]
			: []),
		"server = http.createServer((request,response) => {",
		"if (request.url === '/shutdown') { response.end('stopping'); server.close(() => {fs.writeFileSync(receipt + '.stopped','stopped'); if(desktop) desktop.quit()}); return }",
		"response.setHeader('Content-Type','application/json')",
		"response.end(JSON.stringify({role,ready:true,rendererReady:" +
			electron +
			",version:process.versions.electron ?? null}))",
		"})",
		"server.listen(0,'127.0.0.1',() => {const url='http://127.0.0.1:'+server.address().port; fs.writeFileSync(receipt,JSON.stringify({role,url})); console.log('READY '+role+' '+url)})",
		// Bound an abandoned fixture independently of the extension cleanup path.
		"setTimeout(() => {server.close(); if(desktop) desktop.quit()},120000).unref()",
		"}",
		"start().catch(error => {console.error(error); if(desktop) desktop.exit(1); else process.exitCode=1})",
	].join("\n")
}

suite("Background application launch completion", function () {
	this.timeout(180_000)
	// HTTP launches run in every exact-host smoke gate. A supplied Electron binary
	// also exercises a real renderer without adding a dependency to Alpha.
	const applications = process.env.ALPHA_E2E_ELECTRON_BINARY ? ["web", "electron"] : ["web"]
	for (const application of applications) {
		for (const terminal of ["execa", "vscode"] as const) {
			test(application + " via " + terminal + ": completes once while owned processes remain alive", async () => {
				assert.equal(vscode.version, "1.125.0")
				assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
				const workspace = process.env.ALPHA_E2E_WORKSPACE
				const artifacts = process.env.ALPHA_E2E_ARTIFACTS_DIR
				assert.ok(workspace && artifacts)
				assert.equal(
					await fs.realpath(vscode.workspace.workspaceFolders![0]!.uri.fsPath),
					await fs.realpath(workspace),
				)
				const prefix = "alpha-launch-" + randomUUID()
				const scriptName = prefix + ".cjs",
					launcherName = prefix + "-launcher.cjs"
				const roles = application === "web" ? ["frontend", "backend"] : ["desktop"]
				const urls = new Map<string, string>()
				const configuration = globalThis.api.getConfiguration()
				const provider = (globalThis.api as unknown as { sidebarProvider: LaunchProvider }).sidebarProvider
				const observation: Observation = {
					requests: 0,
					resolveTask(id) {
						const task = provider.getLiveTask(id)
						assert.ok(task)
						return task
					},
					async ready() {
						for (const role of roles) {
							await waitFor(
								async () => {
									try {
										const receipt = JSON.parse(
											await fs.readFile(
												path.join(artifacts, prefix + "-" + role + ".json"),
												"utf8",
											),
										) as { url: string }
										const response = await fetch(receipt.url, { signal: AbortSignal.timeout(2000) })
										const health = (await response.json()) as {
											role: string
											ready: boolean
											rendererReady: boolean
										}
										assert.equal(health.role, role)
										assert.equal(health.ready, true)
										assert.equal(health.rendererReady, application === "electron")
										urls.set(role, receipt.url)
										return true
									} catch (error) {
										if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
										throw error
									}
								},
								{ description: role + " application readiness", timeout: 15_000 },
							)
						}
					},
				}
				const scripted = new LaunchAI(
					application + "-" + terminal + "-" + prefix,
					roles.map(
						(role) => "node " + (application === "electron" ? launcherName : scriptName) + " " + role,
					),
					observation,
				)
				let completions = 0
				const onCompleted = (id: string) => {
					if (id === observation.task?.taskId) {
						completions++
						observation.completedAt = Date.now()
					}
				}
				globalThis.api.on(AlphaCodeEventName.TaskCompleted, onCompleted)
				const acknowledgeCompletion = createCompletionReviewAcknowledger()
				await withBoundedFixtureCleanup(async () => {
					await fs.writeFile(
						path.join(workspace, scriptName),
						serverSource(prefix, application === "electron", artifacts),
						{ flag: "wx" },
					)
					if (application === "electron") {
						await fs.writeFile(
							path.join(workspace, launcherName),
							"const {spawn}=require('node:child_process'); const env={...process.env}; delete env.ELECTRON_RUN_AS_NODE; const child=spawn(" +
								JSON.stringify(process.env.ALPHA_E2E_ELECTRON_BINARY) +
								",[" +
								JSON.stringify(scriptName) +
								",process.argv.at(-1)],{env,stdio:'inherit',windowsHide:true}); child.on('error',e=>{console.error(e);process.exitCode=1}); child.on('exit',code=>{process.exitCode=code??1});\n",
							{ flag: "wx" },
						)
					}
					await globalThis.api.startNewTask({
						text:
							application === "web"
								? "Start the frontend and backend development applications. Leave them running."
								: "Launch the Electron development application. Leave it running.",
						configuration: {
							...configuration,
							apiProvider: "fake-ai",
							fakeAi: scripted,
							mode: "code",
							approvalMode: "auto",
							allowedCommands: ["node"],
							deniedCommands: [],
							terminalShellIntegrationDisabled: terminal === "execa",
							enableCheckpoints: false,
							requestDelaySeconds: 0,
							writeDelayMs: 0,
						},
					})
					await waitFor(
						() => {
							acknowledgeCompletion(observation.task)
							return completions > 0
						},
						{
							description: "launch task completion with live application",
							// Windows commands can each yield for 10s before the completion candidate exists.
							// Measure the unchanged 30s completion deadline from that candidate below.
							timeout: 60_000,
							onTimeout: () => ({
								commands: observation.task?.getCommandExecutionEvidence(),
								messages: observation.task?.clineMessages.slice(-6),
							}),
						},
					)
					const task = observation.task!
					await task.waitForTermination()
					await task.flushApiConversationHistoryPersistence()
					await observation.ready()
					const evidence = task.getCommandExecutionEvidence()
					const owned = task.getActiveBackgroundCommandExecutionIds()
					const reservations = provider.agentControlStore
						.getVerificationObligations({ parentTaskId: task.taskId })
						.flatMap((item) => item.mutationReservations ?? [])
					const { taskDirPath } = await provider.getTaskWithId(task.taskId)
					const history = await readBoundedJson(path.join(taskDirPath, "api_conversation_history.json"))
					const transactions = inspectToolTransactions(history)
					const lifecycle = inspectTaskLifecycle(
						await readBoundedJson(path.join(taskDirPath, "agent_lifecycle_events.jsonl"), true),
						task.taskId,
					)
					const state = await provider.getStateToPostToWebview()
					const completionLatencyMs = observation.completedAt! - observation.finalCandidateAt!
					await fs.writeFile(
						path.join(artifacts, "background-launch-" + application + "-" + terminal + ".json"),
						JSON.stringify(
							{
								hostVersion: vscode.version,
								application,
								terminal,
								requests: observation.requests,
								completions,
								completionLatencyMs,
								evidence,
								owned,
								reservations,
								transactions,
								lifecycle,
								projected: state.liveTasksById?.[task.taskId],
							},
							null,
							2,
						),
						{ flag: "wx" },
					)
					assert.equal(task.didComplete, true)
					assert.equal(task.abort, false)
					assert.equal(completions, 1)
					assert.ok(
						Number.isFinite(completionLatencyMs) && completionLatencyMs < 30_000,
						"The final candidate must complete before the runtime's 30s unresolved-command deadline",
					)
					assert.equal(observation.requests, roles.length + 1)
					assert.equal(evidence.length, roles.length)
					assert.ok(evidence.every((item) => item.status === "running" && item.exitCode === undefined))
					assert.deepEqual(owned, evidence.map((item) => item.executionId).sort())
					assert.deepEqual([...reservations].sort(), owned)
					assert.equal((await provider.getParentCompletionDecision(task)).allowed, true)
					assert.equal(state.liveTasksById?.[task.taskId]?.lifecycle, TaskLifecycleState.Completed)
					assert.deepEqual(transactions.errors, [])
					assert.equal(transactions.callCount, roles.length)
					assert.deepEqual(lifecycle.errors, [])
					assert.equal(lifecycle.completedTurns, 1)
					assert.equal(lifecycle.failedTurns + lifecycle.cancelledTurns, 0)
					for (const url of urls.values())
						await fetch(url + "/shutdown", { signal: AbortSignal.timeout(2000) })
					await waitFor(
						() =>
							task
								.getCommandExecutionEvidence()
								.every((item) => item.status === "succeeded" && item.exitCode === 0),
						{ description: "physical application exits and final receipts", timeout: 15_000 },
					)
					await waitFor(
						() =>
							provider.agentControlStore
								.getVerificationObligations({ parentTaskId: task.taskId })
								.every((item) => !item.mutationReservations?.length),
						{ description: "durable application receipt settlement", timeout: 15_000 },
					)
					assert.equal(completions, 1, "Physical exit must not complete the turn again")
					if (application === "web") {
						await waitFor(
							() =>
								task.clineMessages.some((message) => {
									if (message.say !== "tool" || message.partial || !message.text) return false
									const payload = JSON.parse(message.text) as {
										tool?: string
										path?: string
										commandExecutionId?: string
									}
									return (
										payload.tool === "appliedDiff" &&
										payload.path === prefix + "-runtime.log" &&
										payload.commandExecutionId === evidence[0]!.executionId
									)
								}),
							{ description: "final background workspace change projection", timeout: 15_000 },
						)
					}
					await fs.writeFile(
						path.join(artifacts, "background-launch-" + application + "-" + terminal + "-settled.json"),
						JSON.stringify(
							{
								evidence: task.getCommandExecutionEvidence(),
								obligations: provider.agentControlStore.getVerificationObligations({
									parentTaskId: task.taskId,
								}),
								completions,
							},
							null,
							2,
						),
						{ flag: "wx" },
					)
				}, [
					async () => {
						for (const url of urls.values()) {
							try {
								await fetch(url + "/shutdown", { signal: AbortSignal.timeout(1000) })
							} catch {
								/* Already stopped by the test or task cancellation. */
							}
						}
					},
					() => globalThis.api.clearCurrentTask(),
					() => globalThis.api.off(AlphaCodeEventName.TaskCompleted, onCompleted),
					() => scripted.removeFromCache?.(),
					() => globalThis.api.setConfiguration(configuration),
					async () => {
						for (const name of [scriptName, launcherName, prefix + "-runtime.log"])
							await fs.rm(path.join(workspace, name), { force: true })
						for (const name of roles.flatMap((role) => [
							prefix + "-" + role + ".json",
							prefix + "-" + role + ".json.stopped",
						]))
							await fs.rm(path.join(artifacts, name), { force: true })
						const userData = path.resolve(artifacts, prefix + "-user-data")
						assert.equal(path.dirname(userData), path.resolve(artifacts))
						await fs.rm(userData, { recursive: true, force: true })
					},
				])
			})
		}
	}
})
