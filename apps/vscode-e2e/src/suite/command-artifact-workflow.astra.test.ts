import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as vscode from "vscode"
import {
	AlphaCodeEventName,
	agentLifecycleEventSchema,
	TaskLifecycleState,
	TaskStatus,
	type AlphaMessage,
	type ExtensionState,
} from "@alpha-code/types"

import { readBoundedJson } from "../scenarios/extensionWorkflowHost"
import { inspectTaskLifecycle, inspectToolTransactions } from "../scenarios/transactionAssertions"
import { withBoundedFixtureCleanup } from "./proportional-context-support"

type Mode = "code" | "architect"
interface ArtifactTask {
	taskId: string
	didComplete: boolean
	clineMessages: AlphaMessage[]
	getActiveAskTimestamp(): number | undefined
	getCommandExecutionEvidence(): readonly unknown[]
	waitForTermination(): Promise<void>
	flushApiConversationHistoryPersistence(): Promise<void>
}
interface ArtifactProvider {
	getLiveTask(id: string): ArtifactTask | undefined
	getTaskWithId(id: string): Promise<{ taskDirPath: string }>
	getStateToPostToWebview(): Promise<ExtensionState>
}
interface Observation {
	requests: number
	task?: ArtifactTask
	artifactId?: string
	readOffset?: number
	outputBytes?: number
	results: Map<string, string>
	fail(error: unknown): void
	removeFromCache?: () => void
}

const EXEC_CALL = "artifact-workflow-exec"
const SEARCH_CALL = "artifact-workflow-search"
const READ_CALL = "artifact-workflow-tail-read"
const TAIL_KEY = "ASTRA_ARTIFACT_TAIL_ANSWER"
const TAIL_MARKER = `${TAIL_KEY}=42`
const FINAL = `The full command output contains ${TAIL_MARKER}.`
const READ_LIMIT = 1024
const PLAN_ARTIFACT = "cmd-4ca7cce2-17b7-4bbd-80d3-1eb4735ae3ff.txt"
const OUTPUT = `${Array.from({ length: 256 }, (_, index) => `diagnostic-${String(index).padStart(3, "0")}: ${"x".repeat(80)}`).join("\n")}\n${TAIL_MARKER}\n`

// FakeAI configuration is serialized; promises, provider objects, and live tasks stay fixture-owned.
const fixtures = new WeakMap<object, { observation: Observation; provider: ArtifactProvider }>()

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

function historyBlocks(history: unknown): Record<string, unknown>[] {
	assert.ok(Array.isArray(history), "Provider history must be an array")
	const blocks: Record<string, unknown>[] = []
	for (const message of history) {
		const content = record(message)?.content
		if (!Array.isArray(content)) continue
		for (const value of content) {
			const block = record(value)
			if (block) blocks.push(block)
		}
	}
	return blocks
}

function resultFor(history: unknown, callId: string): string {
	const matches = historyBlocks(history).filter(
		(block) => block.type === "tool_result" && block.tool_use_id === callId,
	)
	assert.equal(matches.length, 1, `Expected exactly one terminal result for ${callId}`)
	const result = matches[0]!
	assert.equal(result.is_error, false, `${callId} must succeed through the native tool surface`)
	assert.ok(typeof result.content === "string", `${callId} must return inspectable command output`)
	return result.content
}

function artifactHint(receipt: string): string {
	assert.match(receipt, /^Process exited with code 0$/m)
	assert.ok(!receipt.includes(TAIL_MARKER), "The tail answer must be absent from the truncated command receipt")
	assert.ok(receipt.length < READ_LIMIT + 512, "The command receipt must remain bounded")
	const hint = /Output truncated\. Read artifact (cmd-\d+\.txt) with write_stdin using (\{[^\n]+\})\./.exec(receipt)
	assert.ok(hint, "The actual exec_command result must advertise an actionable write_stdin artifact hint")
	const input: unknown = JSON.parse(hint[2]!)
	assert.deepEqual(input, { artifact_id: hint[1] })
	return hint[1]!
}

function assertToolSurface(tools: unknown, mode: Mode): void {
	assert.ok(Array.isArray(tools), "The scripted provider must inspect the actual captured tool surface")
	const functions = tools.map((tool) => record(record(tool)?.function))
	for (const retired of ["manage_command", "read_command_output"]) {
		assert.ok(!functions.some((tool) => tool?.name === retired), `${retired} must remain hidden`)
	}
	const reader = functions.find((tool) => tool?.name === "write_stdin")
	assert.ok(reader, "write_stdin must be available for task-owned output retrieval")
	const parameters = record(reader.parameters)
	const properties = record(parameters?.properties)
	assert.ok(record(properties?.artifact_id), "The advertised schema must admit artifact_id")
	for (const name of ["search", "offset", "limit"]) assert.ok(record(properties?.[name]))
	if (mode === "architect") {
		assert.deepEqual(parameters?.required, ["artifact_id"])
		for (const control of ["session_id", "chars", "yield_time_ms", "max_output_tokens"]) {
			assert.ok(!properties || !(control in properties), `Plan must not advertise ${control} session controls`)
		}
	} else {
		assert.ok(record(properties?.session_id), "Code must retain the existing numeric command session branch")
		assert.ok(functions.some((tool) => tool?.name === "exec_command"))
	}
}

class ArtifactWorkflowAI {
	readonly id: string
	constructor(
		private readonly mode: Mode,
		private readonly fixture: string,
		observation: Observation,
		provider: ArtifactProvider,
	) {
		this.id = `astra-command-artifact-${mode}`
		fixtures.set(this, { observation, provider })
	}
	get removeFromCache() {
		return fixtures.get(this)!.observation.removeFromCache
	}
	set removeFromCache(value: (() => void) | undefined) {
		fixtures.get(this)!.observation.removeFromCache = value
	}
	async *createMessage(_system: string, messages: unknown[], metadata?: { taskId?: string; tools?: unknown[] }) {
		const { observation, provider } = fixtures.get(this)!
		try {
			assert.ok(metadata?.taskId)
			const task = provider.getLiveTask(metadata.taskId)
			assert.ok(task)
			observation.task = task
			assertToolSurface(metadata.tools, this.mode)
			const request = ++observation.requests
			const step = request + (this.mode === "architect" ? 1 : 0)
			assert.ok(step <= 4, "Artifact recovery must finish without a synthetic repair or confirmation request")
			assert.deepEqual(inspectToolTransactions(messages).errors, [])
			assert.ok(!JSON.stringify(messages).includes("You did not use a tool in your previous response"))
			if (step === 1) {
				yield {
					type: "tool_call" as const,
					id: EXEC_CALL,
					name: "exec_command",
					arguments: JSON.stringify({
						cmd: "node emit-output.cjs",
						workdir: this.fixture,
						yield_time_ms: 10_000,
						max_output_tokens: 256,
					}),
				}
				return
			}
			if (step === 2) {
				if (this.mode === "code") {
					const receipt = resultFor(messages, EXEC_CALL)
					observation.results.set(EXEC_CALL, receipt)
					observation.artifactId = artifactHint(receipt)
				} else {
					// This Plan fixture seeds only its own task's read artifact; it never executes a command.
					const { taskDirPath } = await provider.getTaskWithId(task.taskId)
					const outputDir = path.join(taskDirPath, "command-output")
					await fs.mkdir(outputDir, { recursive: true })
					await fs.writeFile(path.join(outputDir, PLAN_ARTIFACT), OUTPUT, { flag: "wx" })
					observation.artifactId = PLAN_ARTIFACT
				}
				yield {
					type: "tool_call" as const,
					id: SEARCH_CALL,
					name: "write_stdin",
					arguments: JSON.stringify({
						artifact_id: observation.artifactId,
						search: TAIL_KEY,
						limit: READ_LIMIT,
					}),
				}
				return
			}
			if (step === 3) {
				const search = resultFor(messages, SEARCH_CALL)
				observation.results.set(SEARCH_CALL, search)
				assert.match(search, /Total matches: 1 \| Showing 1/)
				assert.ok(search.includes(TAIL_MARKER), "Artifact search must recover the hidden tail answer")
				assert.ok(Buffer.byteLength(search) <= READ_LIMIT)
				assert.equal(
					search.split("\n")[0],
					`[Command Output: ${observation.artifactId}] (search: "${TAIL_KEY}")`,
				)
				assert.deepEqual(
					search
						.split("\n")
						.slice(3)
						.map((line) => line.trimStart()),
					[`${OUTPUT.split("\n").indexOf(TAIL_MARKER) + 1} | ${TAIL_MARKER}`],
				)
				const range = /Showing bytes 0-(\d+)/.exec(search)
				assert.ok(range, "A complete bounded search must report the observed artifact byte range")
				observation.outputBytes = Number(range[1])
				assert.equal(observation.outputBytes, Buffer.byteLength(OUTPUT))
				assert.ok(observation.outputBytes > 20 * 1024, "The fixture must produce real persisted output")
				observation.readOffset = observation.outputBytes - 256
				yield {
					type: "tool_call" as const,
					id: READ_CALL,
					name: "write_stdin",
					arguments: JSON.stringify({
						artifact_id: observation.artifactId,
						offset: observation.readOffset,
						limit: READ_LIMIT,
					}),
				}
				return
			}
			const tail = resultFor(messages, READ_CALL)
			observation.results.set(READ_CALL, tail)
			assert.ok(tail.includes(TAIL_MARKER), "The byte-offset read must recover the same answer")
			assert.ok(tail.includes(`Showing bytes ${observation.readOffset}-${observation.outputBytes} | COMPLETE`))
			assert.ok(Buffer.byteLength(tail) <= READ_LIMIT)
			assert.equal(tail.split("\n")[0], `[Command Output: ${observation.artifactId}]`)
			const output = Buffer.from(OUTPUT)
			const firstLine = output.subarray(0, observation.readOffset).toString("utf8").split("\n").length
			assert.deepEqual(
				tail.split("\n").slice(2),
				output
					.subarray(observation.readOffset)
					.toString("utf8")
					.split("\n")
					.map((line, index) => `${firstLine + index} | ${line}`),
				"The byte-offset read must return the exact persisted suffix with correct source line numbers",
			)
			yield { type: "text" as const, text: FINAL }
		} catch (error) {
			observation.fail(error)
			throw error
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

// This host proof covers canonical tool effects and persistence. Transient parser-preview
// agreement is covered directly by NativeToolCallParser.write-stdin.spec.ts.
suite("Native command artifact workflow", function () {
	this.timeout(120_000)
	for (const mode of ["code", "architect"] as const) {
		test(
			mode === "code"
				? "exec_command's real truncation hint recovers the tail through write_stdin and completes once"
				: "Plan reads a seeded UUID task-owned artifact without command-session authority",
			async () => {
				assert.equal(vscode.version, "1.138.0")
				assert.equal(process.env.ALPHA_E2E_PROVIDER_MODE, "scripted")
				const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
				const artifacts = process.env.ALPHA_E2E_ARTIFACTS_DIR
				assert.ok(workspace && artifacts)
				const fixture = await fs.mkdtemp(path.join(workspace, ".alpha-artifact-workflow-"))
				const provider = (globalThis.api as unknown as { sidebarProvider: ArtifactProvider }).sidebarProvider
				const configuration = globalThis.api.getConfiguration()
				let complete!: () => void
				let fail!: (error: unknown) => void
				const completed = new Promise<void>((resolve, reject) => {
					complete = resolve
					fail = reject
				})
				// Provider assertions can reject before startNewTask returns; retain that failure for the awaited latch.
				void completed.catch(() => undefined)
				const observation: Observation = {
					requests: 0,
					results: new Map(),
					fail,
				}
				const scripted = new ArtifactWorkflowAI(mode, fixture, observation, provider)
				let completions = 0
				let deadline: NodeJS.Timeout | undefined
				const onCompleted = (id: string) => {
					if (id !== observation.task?.taskId) return
					completions++
					complete()
				}
				globalThis.api.on(AlphaCodeEventName.TaskCompleted, onCompleted)
				await withBoundedFixtureCleanup(async () => {
					if (mode === "code") {
						await fs.writeFile(
							path.join(fixture, "emit-output.cjs"),
							`process.stdout.write(${JSON.stringify(OUTPUT)})\n`,
							{
								flag: "wx",
							},
						)
					}
					deadline = setTimeout(
						() => fail(new Error("Artifact workflow did not complete within 30000 ms")),
						30_000,
					)
					await globalThis.api.startNewTask({
						text:
							mode === "code"
								? "Run emit-output.cjs and recover the hidden tail answer from its persisted output. Report the answer."
								: "Read the fixture's existing task-owned command artifact and report its tail answer in Plan mode.",
						configuration: {
							...configuration,
							apiProvider: "fake-ai",
							fakeAi: scripted,
							mode,
							approvalMode: "auto",
							autoApprovalEnabled: true,
							alwaysAllowReadOnly: true,
							alwaysAllowExecute: mode === "code",
							allowedCommands: mode === "code" ? ["node"] : [],
							deniedCommands: [],
							terminalShellIntegrationDisabled: true,
							terminalOutputPreviewSize: "small",
							enableCheckpoints: false,
							requestDelaySeconds: 0,
							writeDelayMs: 0,
						},
					})
					await completed
					clearTimeout(deadline)
					const task = observation.task!
					await task.waitForTermination()
					await task.flushApiConversationHistoryPersistence()
					const { taskDirPath } = await provider.getTaskWithId(task.taskId)
					const history = await readBoundedJson(path.join(taskDirPath, "api_conversation_history.json"))
					const events = await readBoundedJson(path.join(taskDirPath, "agent_lifecycle_events.jsonl"), true)
					const transactions = inspectToolTransactions(history)
					const lifecycle = inspectTaskLifecycle(events, task.taskId)
					assert.ok(Array.isArray(events))
					const taskEvents = events
						.map((event: unknown) => agentLifecycleEventSchema.parse(event))
						.filter((event) => event.taskId === task.taskId)
					const toolResults = taskEvents
						.filter((event) => event.type === "tool_result_recorded")
						.map((event) => event.payload.item)
					const readMetadata = task.clineMessages
						.filter((message) => message.type === "say" && message.say === "tool" && !message.partial)
						.map((message) => {
							assert.equal(typeof message.text, "string")
							return record(JSON.parse(message.text!))
						})
						.filter((metadata) => metadata?.tool === "readCommandOutput")
					const state = await provider.getStateToPostToWebview()
					const snapshot = state.agentLifecycleSnapshots?.[task.taskId]
					const projected = state.liveTasksById?.[task.taskId]
					const callIds = mode === "code" ? [EXEC_CALL, SEARCH_CALL, READ_CALL] : [SEARCH_CALL, READ_CALL]
					assert.ok(observation.artifactId)
					if (mode === "code") assert.match(observation.artifactId, /^cmd-\d+\.txt$/)
					else assert.equal(observation.artifactId, PLAN_ARTIFACT)
					const artifact = await fs.open(
						path.join(taskDirPath, "command-output", observation.artifactId),
						"r",
					)
					let persistedOutputBytes: number
					try {
						const stat = await artifact.stat()
						assert.ok(stat.isFile() && stat.size > 20 * 1024 && stat.size < 32 * 1024)
						persistedOutputBytes = stat.size
						const tail = Buffer.alloc(256)
						const { bytesRead } = await artifact.read(tail, 0, tail.length, stat.size - tail.length)
						assert.ok(tail.subarray(0, bytesRead).toString("utf8").endsWith(`${TAIL_MARKER}\n`))
					} finally {
						await artifact.close()
					}
					await fs.writeFile(
						path.join(artifacts, `command-artifact-workflow-${mode}.json`),
						JSON.stringify({
							schemaVersion: 1,
							hostVersion: vscode.version,
							provider: "scripted",
							mode,
							artifactOrigin: mode === "code" ? "exec_command" : "fixture-seeded-task-artifact",
							requests: observation.requests,
							completions,
							artifactId: observation.artifactId,
							persistedOutputBytes,
							readOffset: observation.readOffset,
							resultBytes: Object.fromEntries(
								[...observation.results].map(([id, text]) => [id, Buffer.byteLength(text)]),
							),
							transactions,
							lifecycle,
							canonicalStatus: snapshot?.status,
							toolResultStatuses: Object.fromEntries(
								toolResults.map((item) => [item.toolCallId, item.status]),
							),
							readMetadata,
						}),
						{ flag: "wx" },
					)
					assert.equal(observation.requests, callIds.length + 1)
					assert.equal(completions, 1)
					assert.equal(task.didComplete, true)
					assert.equal(persistedOutputBytes, observation.outputBytes)
					assert.deepEqual(transactions, {
						callCount: callIds.length,
						resultCount: callIds.length,
						errors: [],
					})
					assert.deepEqual(lifecycle, {
						completedTurns: 1,
						cancelledTurns: 0,
						failedTurns: 0,
						errors: [],
					})
					assert.equal(snapshot?.status, "completed")
					assert.deepEqual(snapshot?.acceptedToolCallIds, callIds)
					assert.deepEqual(snapshot?.terminalToolCallIds, callIds)
					const terminals = taskEvents.filter((event) => event.type === "turn_terminal")
					assert.equal(terminals.length, 1)
					assert.equal(snapshot?.terminalEventId, terminals[0]!.eventId)
					assert.deepEqual(
						toolResults.map((item) => item.toolCallId),
						callIds,
					)
					for (const item of toolResults) {
						assert.equal(
							item.status,
							"success",
							`${item.toolCallId} must have a successful canonical terminal result`,
						)
						assert.equal(item.output, resultFor(history, item.toolCallId))
					}
					assert.deepEqual(readMetadata, [
						{
							tool: "readCommandOutput",
							readStart: 0,
							readEnd: persistedOutputBytes,
							totalBytes: persistedOutputBytes,
							searchPattern: TAIL_KEY,
							matchCount: 1,
							searchMatchCountExact: true,
							searchBytesRead: persistedOutputBytes,
							searchTruncated: false,
							searchIncomplete: false,
							nextOffset: persistedOutputBytes,
						},
						{
							tool: "readCommandOutput",
							readStart: observation.readOffset,
							readEnd: persistedOutputBytes,
							totalBytes: persistedOutputBytes,
							nextOffset: persistedOutputBytes,
						},
					])
					for (const id of callIds) assert.equal(resultFor(history, id), observation.results.get(id))
					const calls = historyBlocks(history).filter((block) => block.type === "tool_use")
					assert.deepEqual(
						calls.map((call) => call.name),
						mode === "code"
							? ["exec_command", "write_stdin", "write_stdin"]
							: ["write_stdin", "write_stdin"],
					)
					assert.deepEqual(calls.find((call) => call.id === SEARCH_CALL)?.input, {
						artifact_id: observation.artifactId,
						search: TAIL_KEY,
						limit: READ_LIMIT,
					})
					assert.deepEqual(calls.find((call) => call.id === READ_CALL)?.input, {
						artifact_id: observation.artifactId,
						offset: observation.readOffset,
						limit: READ_LIMIT,
					})
					if (mode === "code")
						assert.equal(artifactHint(resultFor(history, EXEC_CALL)), observation.artifactId)
					else
						assert.deepEqual(
							task.getCommandExecutionEvidence(),
							[],
							"Plan artifact reads must not execute commands",
						)
					assert.equal(projected?.lifecycle, TaskLifecycleState.Completed)
					assert.equal(projected?.status, TaskStatus.Idle)
					assert.equal(projected?.isTurnActive, false)
					assert.equal(projected?.isWaitingForInput, false)
					assert.equal(task.getActiveAskTimestamp(), undefined)
					const finalMessages = task.clineMessages.filter(
						(message) => message.type === "say" && message.say === "completion_result" && !message.partial,
					)
					assert.equal(finalMessages.length, 1)
					assert.equal(
						finalMessages[0]!.text,
						mode === "architect" ? `<proposed_plan>\n${FINAL}\n</proposed_plan>` : FINAL,
					)
					const assistantItems = taskEvents
						.filter((event) => event.type === "item_added")
						.map((event) => event.payload.item)
						.filter((item) => item.type === "assistant_text")
					assert.equal(assistantItems.length, 1)
					assert.ok(assistantItems[0]?.type === "assistant_text")
					assert.equal(assistantItems[0].text, FINAL)
					assert.equal(
						historyBlocks(history).filter((block) => block.type === "text" && block.text === FINAL).length,
						1,
					)
					assert.ok(
						!task.clineMessages.some(
							(message) =>
								message.say === "error" ||
								message.ask === "api_req_failed" ||
								message.ask === "resume_task" ||
								message.ask === "completion_result",
						),
					)
				}, [
					() => clearTimeout(deadline),
					() => globalThis.api.clearCurrentTask(),
					() => globalThis.api.off(AlphaCodeEventName.TaskCompleted, onCompleted),
					() => scripted.removeFromCache?.(),
					() => globalThis.api.setConfiguration(configuration),
					async () => {
						assert.equal(path.dirname(path.resolve(fixture)), path.resolve(workspace))
						assert.ok(path.basename(fixture).startsWith(".alpha-artifact-workflow-"))
						await fs.rm(fixture, { recursive: true, force: true })
					},
				])
			},
		)
	}
})
