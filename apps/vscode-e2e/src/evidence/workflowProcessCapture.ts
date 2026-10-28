import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import { constants } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

type RecordValue = Record<string, unknown>
type Coverage = "complete" | "partial" | "unavailable"
type Method = (...args: unknown[]) => unknown
type ToolStatus = "success" | "error" | "denied" | "cancelled"

export interface WorkflowProcessTraceEvent {
	sequence: number
	timestamp: string
	type: string
	payload: RecordValue
}

export interface WorkflowProcessBinding {
	taskIdentity: string
	runId: string
	variantIdentity: string
	decisionPlanDigest: string
	pairDigest?: string
}

export interface WorkflowProcessRequirements {
	initialValidation: boolean
	finalValidation: boolean
	instructions: Array<{ id: string; digest: string; role?: string; before: "first-edit" | "first-model-request" }>
	hooks: Array<{ id: string; digest: string; before: "first-edit" | "completion" }>
}

export interface WorkflowProcessSnapshot {
	digest: string
	rows: Array<[string, string | null]>
}

export interface WorkflowProcessEvidence {
	schemaVersion: 1
	binding: WorkflowProcessBinding & {
		initialWorkspaceDigest?: string
		finalWorkspaceDigest: string
		workspaceRootDigest?: string
	}
	bindingComplete: boolean
	capture: {
		trace: Coverage
		sourceVersions: Coverage
		instructionDelivery: Coverage
		hookDelivery: Coverage
		commandContexts: Coverage
	}
	changedPaths: string[]
	validationCommands: Array<{ command: string; args: string[] }>
	trace: WorkflowProcessTraceEvent[]
	sourceVersions: Array<{ sequence: number; workspaceDigest: string; beforeWorkspaceDigest?: string }>
	commandContexts: Array<{ sequence: number; callId: string; actualCwdDigest: string }>
	instructions: Array<{ id: string; digest: string; deliveredSequence: number; role: "user" }>
	hooks: []
	requirements: WorkflowProcessRequirements
	diagnostics: { gaps: string[]; snapshotCount: number; snapshotDurationMs: number; sourceDigestAlgorithm: string }
}

const object = (value: unknown): RecordValue | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : undefined
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined)
const sha = (value: string | Buffer): string => `sha256:${createHash("sha256").update(value).digest("hex")}`
const portable = (value: string): string => value.split(path.sep).join("/")
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
const statuses = new Set<ToolStatus>(["success", "error", "denied", "cancelled"])
const commandTools = new Set(["exec_command", "shell", "execute_command", "write_stdin", "manage_command"])
const marker = ".alpha-e2e-owned.json"
const markerValue = { schemaVersion: 1, purpose: "alpha-vscode-e2e", kind: "workspace" }

/** Actual location identity is separate from the source-byte snapshot digest. */
export async function workflowProcessRootDigest(directory: string): Promise<string> {
	if (!path.isAbsolute(directory)) throw new Error("Command location must be absolute")
	const actual = portable(await fs.realpath(directory))
	return sha(process.platform === "win32" ? actual.toLowerCase() : actual)
}

function generated(relative: string): boolean {
	const parts = relative.split("/")
	return parts[0] === ".git" || parts.includes("__pycache__") || /\.py[co]$/.test(parts.at(-1) ?? "")
}

/** Exact private repository-workspace digest: sorted rows, directory entries, raw bytes and pretty JSON newline. */
export async function snapshotWorkflowProcessWorkspace(
	workspace: string,
	limits: { entries?: number; fileBytes?: number; treeBytes?: number; timeoutMs?: number } = {},
): Promise<WorkflowProcessSnapshot> {
	const root = path.resolve(workspace)
	if (!path.isAbsolute(workspace) || root === path.parse(root).root || root === os.homedir())
		throw new Error("Process capture requires an owned absolute workspace")
	if ((await fs.realpath(root)) !== root || (await fs.lstat(root)).isSymbolicLink())
		throw new Error("Process workspace must not be linked")
	const bound = {
		entries: 1024,
		fileBytes: 8 * 1024 * 1024,
		treeBytes: 32 * 1024 * 1024,
		timeoutMs: 2_000,
		...limits,
	}
	for (const value of Object.values(bound))
		if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid snapshot bound")
	const deadline = Date.now() + bound.timeoutMs
	let entries = 0,
		bytes = 0
	const rows: WorkflowProcessSnapshot["rows"] = []
	const check = () => {
		if (Date.now() > deadline) throw new Error("Process source snapshot exceeded its deadline")
	}
	async function visit(directory: string): Promise<void> {
		check()
		const directoryBefore = await fs.lstat(directory)
		if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink())
			throw new Error("Source directory is not stable")
		const names = (await fs.readdir(directory)).sort(compare)
		for (const name of names) {
			check()
			if (++entries > bound.entries) throw new Error("Process source entry bound exceeded")
			const file = path.join(directory, name),
				relative = portable(path.relative(root, file))
			if (
				!relative ||
				relative.split("/").some((part) => !part || part === "." || part === ".." || part.includes(":"))
			)
				throw new Error("Invalid source path")
			const before = await fs.lstat(file)
			if (
				before.isSymbolicLink() ||
				(!before.isFile() && !before.isDirectory()) ||
				(before.isFile() && before.nlink !== 1)
			)
				throw new Error("Linked or special process source entry")
			if (generated(relative)) continue
			if (before.isDirectory()) {
				rows.push([`${relative}/`, null])
				await visit(file)
				const after = await fs.lstat(file)
				if (
					!after.isDirectory() ||
					after.isSymbolicLink() ||
					before.dev !== after.dev ||
					before.ino !== after.ino
				)
					throw new Error("Source directory changed during snapshot")
				continue
			}
			if (before.size > bound.fileBytes || (bytes += before.size) > bound.treeBytes)
				throw new Error("Process source byte bound exceeded")
			const descriptor = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
			try {
				const opened = await descriptor.stat()
				if (!opened.isFile() || opened.nlink !== 1 || before.dev !== opened.dev || before.ino !== opened.ino)
					throw new Error("Source file changed before read")
				const buffer = Buffer.alloc(before.size + 1)
				let readBytes = 0
				while (readBytes < buffer.length) {
					check()
					const read = await descriptor.read(buffer, readBytes, buffer.length - readBytes, readBytes)
					if (read.bytesRead === 0) break
					readBytes += read.bytesRead
				}
				const data = buffer.subarray(0, readBytes)
				const after = await descriptor.stat()
				const current = await fs.lstat(file)
				if (
					data.length !== before.size ||
					after.size !== before.size ||
					after.mtimeMs !== before.mtimeMs ||
					after.ctimeMs !== before.ctimeMs ||
					current.isSymbolicLink() ||
					!current.isFile() ||
					current.dev !== before.dev ||
					current.ino !== before.ino ||
					current.mtimeMs !== before.mtimeMs ||
					current.ctimeMs !== before.ctimeMs
				)
					throw new Error("Source file changed during read")
				if (relative === marker) {
					const value: unknown = JSON.parse(data.toString("utf8"))
					const record = object(value)
					if (
						!record ||
						Object.keys(record).length !== 3 ||
						Object.entries(markerValue).some(([key, value]) => record[key] !== value)
					)
						throw new Error("Invalid controller-owned workspace marker")
				} else rows.push([relative, sha(data)])
			} finally {
				await descriptor.close()
			}
		}
		const directoryAfter = await fs.lstat(directory)
		if (
			!directoryAfter.isDirectory() ||
			directoryAfter.isSymbolicLink() ||
			directoryBefore.dev !== directoryAfter.dev ||
			directoryBefore.ino !== directoryAfter.ino ||
			directoryBefore.mtimeMs !== directoryAfter.mtimeMs ||
			directoryBefore.ctimeMs !== directoryAfter.ctimeMs
		)
			throw new Error("Source directory changed during snapshot")
	}
	await visit(root)
	check()
	rows.sort(([a], [b]) => compare(a, b))
	return { rows, digest: sha(JSON.stringify(rows, null, 2) + "\n") }
}

function safeArguments(value: unknown): RecordValue {
	const source = object(value) ?? {}
	const output: RecordValue = {}
	for (const key of ["command", "cmd", "cwd", "workdir", "action", "session_id"])
		if (typeof source[key] === "string" && String(source[key]).length <= 32_768) output[key] = source[key]
	if (
		Array.isArray(source.args) &&
		source.args.length <= 128 &&
		source.args.every((arg) => typeof arg === "string" && arg.length <= 32_768) &&
		source.args.reduce((size, arg) => size + String(arg).length, 0) <= 32_768
	)
		output.args = [...source.args]
	return output
}

function containsPrompt(messages: unknown, expected: string): boolean {
	if (!Array.isArray(messages)) return false
	return messages.some((message) => {
		const row = object(message)
		if (!row || ![1, "user"].includes(row.role as string | number) || !Array.isArray(row.content)) return false
		return row.content.some((part) => {
			const content = object(part)
			return content?.value === expected || content?.text === expected
		})
	})
}

/** Opt-in E2E observer. Existing awaited effect fences remain authoritative; no user hook changes scheduling mode. */
export class WorkflowProcessCapture {
	private readonly gaps = new Set<string>()
	private readonly trace: WorkflowProcessTraceEvent[] = []
	private readonly versions: WorkflowProcessEvidence["sourceVersions"] = []
	private readonly commandContexts: WorkflowProcessEvidence["commandContexts"] = []
	private readonly calls = new Map<string, { name: string; args: RecordValue; acceptedSequence: number }>()
	private readonly before = new Map<string, WorkflowProcessSnapshot>()
	private readonly richResults = new Map<string, RecordValue>()
	private readonly terminalObserved = new Set<string>()
	private readonly terminalJoined = new Set<string>()
	private readonly activeEffects = new Set<string>()
	private readonly releases: Array<() => void> = []
	private readonly tasks = new Set<string>()
	private initial?: WorkflowProcessSnapshot
	private final?: WorkflowProcessSnapshot
	private workspaceRootDigest?: string
	private readonly initialReady: Promise<void>
	private snapshotCount = 0
	private snapshotDurationMs = 0
	private finalized = false
	private prompt?: { value: string; digest: string; matched: boolean }
	private lastRawResult?: string
	private pending = 0
	private traceBytes = 0
	private modelRequests = 0

	constructor(private readonly options: { workspace: string; instructionId?: string }) {
		this.initialReady = this.snapshot().then(async (snapshot) => {
			this.initial = snapshot
			if (snapshot) this.versions.push({ sequence: 0, workspaceDigest: snapshot.digest })
			try {
				this.workspaceRootDigest = await workflowProcessRootDigest(options.workspace)
			} catch {
				this.gaps.add("actual-workspace-location-unavailable")
			}
		})
	}

	async ready(): Promise<void> {
		await this.initialReady
	}

	onTaskPrompt(value: string): void {
		if (
			this.prompt ||
			this.finalized ||
			this.trace.length > 0 ||
			typeof value !== "string" ||
			!value ||
			value.length > 100_000
		) {
			this.gaps.add("task-prompt-admission-unavailable")
			return
		}
		this.prompt = { value, digest: sha(value), matched: false }
	}

	onModelRequest(messages: unknown): void {
		if (this.modelRequests++ > 0) return
		if (this.prompt && containsPrompt(messages, this.prompt.value)) this.prompt.matched = true
		else this.gaps.add("exact-task-prompt-delivery-not-observed")
	}

	private event(type: string, payload: RecordValue): number {
		if (this.trace.length >= 20_000) {
			this.gaps.add("trace-event-bound-exceeded")
			return this.trace.length
		}
		const size = Buffer.byteLength(JSON.stringify(payload), "utf8")
		if (this.traceBytes + size > 8 * 1024 * 1024) {
			this.gaps.add("trace-event-byte-bound-exceeded")
			return this.trace.length
		}
		this.traceBytes += size
		const sequence = this.trace.length + 1
		this.trace.push({ sequence, timestamp: new Date().toISOString(), type: `agent.turn.${type}`, payload })
		return sequence
	}

	private async snapshot(): Promise<WorkflowProcessSnapshot | undefined> {
		const started = performance.now()
		try {
			const snapshot = await snapshotWorkflowProcessWorkspace(this.options.workspace)
			this.snapshotCount++
			return snapshot
		} catch {
			this.gaps.add("source-snapshot-unavailable")
			return undefined
		} finally {
			this.snapshotDurationMs += Math.max(0, performance.now() - started)
		}
	}

	attachTask(value: unknown): () => void {
		const task = object(value)
		if (this.finalized || !task || !text(task.taskId) || this.tasks.has(String(task.taskId))) {
			this.gaps.add("task-observer-admission-unavailable")
			return () => {}
		}
		const methods = ["enqueueCanonicalLifecycleEvent", "appendAgentTurnEvent", "recordToolCallForStopping"] as const
		if (methods.some((name) => typeof task[name] !== "function")) {
			this.gaps.add("actual-effect-observer-boundary-unavailable")
			return () => {}
		}
		if (this.tasks.size) this.gaps.add("multiple-task-trace-scope")
		this.tasks.add(String(task.taskId))
		const restorers: Array<() => void> = []
		for (const name of methods) {
			const original = task[name] as Method
			const descriptor = Object.getOwnPropertyDescriptor(task, name)
			const wrapped = async (...args: unknown[]) => {
				this.pending++
				try {
					if (name === "enqueueCanonicalLifecycleEvent") {
						const result = await Reflect.apply(original, task, args)
						try {
							await this.lifecycle(task, args)
						} catch {
							this.gaps.add("lifecycle-observation-failed")
						}
						return result
					}
					if (name === "recordToolCallForStopping") {
						// The result is the scheduler's real structured process result, never parsed candidate output.
						try {
							await this.result(task, args)
						} catch {
							this.gaps.add("structured-result-observation-failed")
						}
						return await Reflect.apply(original, task, args)
					}
					const result = await Reflect.apply(original, task, args)
					try {
						await this.turnEvent(args[0])
					} catch {
						this.gaps.add("turn-observation-failed")
					}
					return result
				} catch (error) {
					this.gaps.add("observed-task-boundary-failed")
					throw error
				} finally {
					this.pending--
				}
			}
			Object.defineProperty(task, name, {
				configurable: true,
				enumerable: descriptor?.enumerable ?? false,
				writable: true,
				value: wrapped,
			})
			restorers.push(() => {
				if (task[name] !== wrapped) {
					this.gaps.add("task-observer-replaced")
					return
				}
				if (descriptor) Object.defineProperty(task, name, descriptor)
				else Reflect.deleteProperty(task, name)
			})
		}
		let released = false
		const release = () => {
			if (released) return
			released = true
			for (const restore of restorers.reverse()) restore()
		}
		this.releases.push(release)
		return release
	}

	private async lifecycle(task: RecordValue, args: unknown[]): Promise<void> {
		const type = args[0],
			payload = object(args[1]) ?? {}
		if (type !== "tool_call_accepted" && type !== "tool_effect_started") return
		const item = object(payload.item),
			callId = text(item?.toolCallId ?? payload.toolCallId)
		if (!callId) {
			this.gaps.add("canonical-call-identity-unavailable")
			return
		}
		let state: RecordValue | undefined
		try {
			if (typeof task.getCanonicalLifecycleSnapshot === "function")
				state = object(Reflect.apply(task.getCanonicalLifecycleSnapshot as Method, task, []))
		} catch {
			/* Missing durable ownership must not become positive evidence. */
		}
		const owned = state?.[type === "tool_call_accepted" ? "acceptedToolCallIds" : "effectStartedToolCallIds"]
		if (!Array.isArray(owned) || !owned.includes(callId)) {
			this.gaps.add("canonical-effect-ownership-unavailable")
			return
		}
		if (type === "tool_call_accepted") {
			if (this.calls.has(callId)) return
			const name = text(item?.name)
			if (!name) {
				this.gaps.add("accepted-tool-name-unavailable")
				return
			}
			const acceptedSequence = this.event(type, { callId, name })
			this.calls.set(callId, { name, args: safeArguments(item?.arguments), acceptedSequence })
			return
		}
		await this.initialReady
		if (this.activeEffects.size) this.gaps.add("overlapping-effect-source-windows")
		this.activeEffects.add(callId)
		const before = await this.snapshot()
		if (before) this.before.set(callId, before)
		else this.gaps.add("effect-before-source-unavailable")
	}

	private async result(task: RecordValue, args: unknown[]): Promise<void> {
		const rich = object(args[4]),
			callId = text(rich?.callId)
		if (!rich || !callId || !text(args[0])) {
			this.gaps.add("structured-tool-result-unavailable")
			return
		}
		if (this.richResults.has(callId)) {
			this.gaps.add("duplicate-structured-tool-result")
			return
		}
		const retainedResult = { ...rich, arguments: safeArguments(args[1]) }
		this.richResults.set(callId, retainedResult)
		const name = String(args[0]),
			call = this.calls.get(callId)
		if (!call) this.gaps.add("terminal-call-acceptance-unavailable")
		const status = statuses.has(rich.executionStatus as ToolStatus) ? rich.executionStatus : rich.status
		const payload: RecordValue = { callId, name, status, handlerStatus: rich.status }
		let actualCwdDigest: string | undefined
		if (commandTools.has(name)) {
			const input = safeArguments(args[1])
			payload.command = input.command ?? input.cmd
			if (Array.isArray(input.args)) payload.args = input.args
			for (const key of ["exitCode", "executionStatus", "timedOut"])
				if (rich[key] !== undefined) payload[key] = rich[key]
			const failure = object(rich.failure)
			if (failure?.reason === "process_launch_failed") payload.launchFailed = true
			if (!this.before.has(callId)) this.gaps.add("command-before-source-unavailable")
			if (rich.executionStatus === "running" || rich.waitOutcome === "active")
				this.gaps.add("background-command-source-window-unsettled")
			try {
				const evidence =
					typeof task.getCommandExecutionEvidence === "function"
						? Reflect.apply(task.getCommandExecutionEvidence as Method, task, [])
						: undefined
				const matches = Array.isArray(evidence)
					? evidence.map(object).filter((row) => row?.toolCallId === callId)
					: []
				const actual = matches.length === 1 ? matches[0] : undefined
				const expectedStatus = rich.exitCode === 0 ? "succeeded" : "failed"
				if (
					!actual ||
					!text(actual.executionId) ||
					!text(actual.cwd) ||
					!text(actual.command) ||
					!Number.isInteger(actual.exitCode) ||
					actual.exitCode !== rich.exitCode ||
					actual.status !== expectedStatus ||
					!Number.isFinite(actual.startedAt) ||
					!Number.isFinite(actual.completedAt) ||
					Number(actual.completedAt) < Number(actual.startedAt) ||
					Number(actual.completedAt) > Date.now()
				)
					throw new Error("Actual completed command context is unavailable")
				actualCwdDigest = await workflowProcessRootDigest(String(actual.cwd))
				// The command admitted by the native process owner can differ from requested arguments after interception.
				payload.command = actual.command
				delete payload.args
				retainedResult.arguments = { command: String(actual.command) }
			} catch {
				this.gaps.add("actual-command-context-unavailable")
			}
		}
		const snapshot = await this.snapshot()
		if (snapshot && this.before.has(callId) && this.before.get(callId)!.digest !== snapshot.digest)
			payload.mutatesWorkspace = true
		const sequence = this.event("tool_result", payload)
		if (actualCwdDigest) this.commandContexts.push({ sequence, callId, actualCwdDigest })
		this.terminalObserved.add(callId)
		if (snapshot)
			this.versions.push({
				sequence,
				workspaceDigest: snapshot.digest,
				...(this.before.has(callId) ? { beforeWorkspaceDigest: this.before.get(callId)!.digest } : {}),
			})
		this.activeEffects.delete(callId)
	}

	private async turnEvent(value: unknown): Promise<void> {
		const event = object(value),
			type = text(event?.type)
		if (!event || !type) {
			this.gaps.add("invalid-canonical-turn-event")
			return
		}
		if (type === "tool_result") {
			const callId = text(event.callId),
				result = callId ? this.richResults.get(callId) : undefined
			if (callId && result) {
				if (result.status !== event.status || result.name !== event.name)
					this.gaps.add("terminal-receipt-join-contradiction")
				if (this.terminalJoined.has(callId)) this.gaps.add("duplicate-canonical-terminal-receipt")
				this.terminalJoined.add(callId)
				this.lastRawResult = callId
				return
			}
			// Denied/preflight/repetition-skip results may not enter the completed-effect observer.
			if (commandTools.has(String(event.name))) this.gaps.add("actual-command-context-unavailable")
			this.event(type, { callId, name: event.name, status: event.status, timedOut: event.timedOut })
			this.lastRawResult = callId
			return
		}
		if (type === "verification_result") {
			const result = this.lastRawResult ? this.richResults.get(this.lastRawResult) : undefined
			if (!result || result.name !== event.toolName) {
				this.gaps.add("verification-call-join-unavailable")
				return
			}
			const input = object(result.arguments) ?? {}
			this.event(type, {
				callId: result.callId,
				toolName: event.toolName,
				status: event.status,
				command: input.command ?? input.cmd,
				...(Array.isArray(input.args) ? { args: input.args } : {}),
				exitCode: event.exitCode,
			})
			return
		}
		this.lastRawResult = undefined
		const payload: RecordValue = {}
		for (const key of ["attempt", "purpose", "status", "reason", "callId", "name", "toolName"])
			if (typeof event[key] === "string" || typeof event[key] === "number" || typeof event[key] === "boolean")
				payload[key] = event[key]
		this.event(type, payload)
	}

	async finalize(input: {
		binding: WorkflowProcessBinding
		validationCommands: WorkflowProcessEvidence["validationCommands"]
		requirements: WorkflowProcessRequirements
	}): Promise<WorkflowProcessEvidence> {
		if (this.finalized) throw new Error("Process capture is already finalized")
		await this.initialReady
		if (this.pending || this.activeEffects.size) this.gaps.add("task-effects-not-settled-before-final-capture")
		this.finalized = true
		for (const release of this.releases.reverse()) release()
		this.final = await this.snapshot()
		for (const callId of this.terminalObserved)
			if (!this.terminalJoined.has(callId)) this.gaps.add("observed-result-missing-canonical-terminal-join")
		if (!this.tasks.size) this.gaps.add("task-observer-not-attached")
		if (this.final) {
			const last = this.versions.at(-1)
			if (last?.sequence === this.trace.length) {
				if (last.workspaceDigest !== this.final.digest) {
					this.gaps.add("final-source-changed-without-later-canonical-anchor")
					this.versions.push({ sequence: this.trace.length, workspaceDigest: this.final.digest })
				}
			} else this.versions.push({ sequence: this.trace.length, workspaceDigest: this.final.digest })
		}
		const variantComplete = !input.binding.variantIdentity.startsWith("unavailable:")
		const bindingComplete = variantComplete && this.initial !== undefined && this.final !== undefined
		if (!variantComplete) this.gaps.add("executed-variant-binding-unavailable")
		const initialRows = new Map(this.initial?.rows ?? []),
			finalRows = new Map(this.final?.rows ?? [])
		const changedPaths = [...new Set([...initialRows.keys(), ...finalRows.keys()])]
			.filter((file) => initialRows.get(file) !== finalRows.get(file))
			.sort(compare)
		const sourceGaps = [...this.gaps].some((gap) =>
			/source|snapshot|settled|effect-ownership|observer|call-identity|trace-event|scope|structured-tool-result/.test(
				gap,
			),
		)
		const traceGaps = [...this.gaps].some(
			(gap) =>
				!gap.includes("prompt") &&
				!gap.includes("variant") &&
				!gap.includes("source-snapshot") &&
				!gap.includes("command-context") &&
				!gap.includes("workspace-location"),
		)
		const sourceVersions = [...new Map(this.versions.map((row) => [row.sequence, row])).values()].sort(
			(a, b) => a.sequence - b.sequence,
		)
		return {
			schemaVersion: 1,
			binding: {
				...input.binding,
				...(this.workspaceRootDigest ? { workspaceRootDigest: this.workspaceRootDigest } : {}),
				...(this.initial ? { initialWorkspaceDigest: this.initial.digest } : {}),
				finalWorkspaceDigest: this.final?.digest ?? "unavailable:final-workspace",
			},
			bindingComplete,
			capture: {
				trace: traceGaps ? "partial" : "complete",
				sourceVersions: sourceGaps || !this.initial || !this.final ? "partial" : "complete",
				instructionDelivery: this.prompt?.matched ? "complete" : "unavailable",
				hookDelivery: "unavailable",
				commandContexts:
					this.gaps.has("actual-command-context-unavailable") || !this.workspaceRootDigest
						? "unavailable"
						: "complete",
			},
			changedPaths,
			validationCommands: input.validationCommands.map((command) => ({
				command: command.command,
				args: [...command.args],
			})),
			trace: this.trace.map((event) => ({ ...event, payload: { ...event.payload } })),
			sourceVersions,
			commandContexts: this.commandContexts.map((context) => ({ ...context })),
			instructions: this.prompt?.matched
				? [
						{
							id: this.options.instructionId ?? "task-prompt",
							digest: this.prompt.digest,
							deliveredSequence: 0,
							role: "user",
						},
					]
				: [],
			hooks: [],
			requirements: structuredClone(input.requirements),
			diagnostics: {
				gaps: [...this.gaps].sort(compare),
				snapshotCount: this.snapshotCount,
				snapshotDurationMs: this.snapshotDurationMs,
				sourceDigestAlgorithm: "sha256-pretty-json-sorted-path-raw-file-digest-rows-v1",
			},
		}
	}
}
