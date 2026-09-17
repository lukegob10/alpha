import { createHash } from "crypto"
import { execFile as execFileCallback } from "child_process"
import * as fs from "fs/promises"
import * as path from "path"
import { promisify } from "util"

import { classifyFailure, knownFailureCode } from "./classification"
import { projectJournalSource, readTaskSource, TaskSourceError } from "./journalProjection"
import {
	assertSafeRoot,
	ensureEvidenceRoot,
	isWithin,
	prepareEvidenceRun,
	readBounded,
	rejectSymlinkComponents,
	requireEvidenceRun,
} from "./paths"
import type {
	CaptureRunEvidenceOptions,
	CaptureRunEvidenceResult,
	EvidenceLimits,
	EvidenceManifest,
	RepositoryEvidence,
	RunEvidenceMetadata,
} from "./types"

const execFile = promisify(execFileCallback)
const DEFAULT_LIMITS: Required<EvidenceLimits> = {
	maxFiles: 1_000,
	maxFileBytes: 256 * 1_024,
	maxTaskSourceBytes: 4 * 1_024 * 1_024,
	maxJournalLineBytes: 256 * 1_024,
	maxTotalBytes: 8 * 1_024 * 1_024,
	maxTaskIds: 20,
	maxJournalEvents: 2_000,
}
const MAX_LIMITS: Required<EvidenceLimits> = {
	maxFiles: 10_000,
	maxFileBytes: 4 * 1_024 * 1_024,
	maxTaskSourceBytes: 64 * 1_024 * 1_024,
	maxJournalLineBytes: 4 * 1_024 * 1_024,
	maxTotalBytes: 64 * 1_024 * 1_024,
	maxTaskIds: 100,
	maxJournalEvents: 10_000,
}
const OMITTED_DIRECTORIES = new Set([".git", "node_modules", ".next", "dist", "build", "out", ".turbo"])
const SENSITIVE_FILE =
	/(^\.env(?:\.|$)|credentials?|secrets?|tokens?|\.pem$|\.key$|\.pfx$|\.p12$|^id_rsa$|^id_ed25519$)/i
const OUTCOMES = new Set(["passed", "failed", "cancelled", "blocked", "timed_out"])
const EVENT_TYPES = new Set([
	"turn_started",
	"phase_changed",
	"turn_terminal",
	"assistant_committed",
	"response_terminal",
	"tool_result",
	"tool_batch_started",
	"tool_batch_finished",
	"approval_request",
	"approval_result",
	"retry",
	"model_request_started",
	"request_usage",
	"turn_completed",
	"task_completed",
	"turn_failed",
	"task_failed",
	"turn_incomplete",
	"task_incomplete",
	"compaction_completed",
	"verification_result",
	"cancelled",
	"internal_task_started",
	"internal_task_completed",
])
const STATUSES = new Set([
	"starting",
	"running",
	"finalizing",
	"completed",
	"failed",
	"incomplete",
	"exhausted",
	"aborted",
	"cancelled",
	"success",
	"error",
	"denied",
	"approved",
	"blocked",
	"timed_out",
	"pending",
	"interrupted",
])

const sha256 = (content: Buffer | string): string => createHash("sha256").update(content).digest("hex")

function limitsWithDefaults(overrides: Partial<EvidenceLimits> = {}): Required<EvidenceLimits> {
	const limits = { ...DEFAULT_LIMITS }
	for (const key of Object.keys(DEFAULT_LIMITS) as Array<keyof EvidenceLimits>) {
		const value = overrides[key] ?? DEFAULT_LIMITS[key]
		if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_LIMITS[key]) {
			throw new Error(`Invalid evidence limit: ${key}`)
		}
		limits[key] = value
	}
	return limits
}

function identifier(value: string, name: string, model = false): string {
	const pattern = model ? /^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,127}$/ : /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
	if (typeof value !== "string" || !pattern.test(value) || value === "." || value === "..") {
		throw new Error(`Invalid evidence ${name}`)
	}
	return value
}

function validateMetadata(input: RunEvidenceMetadata, maxTaskIds: number): RunEvidenceMetadata {
	if (input.hostVersion !== null && !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(input.hostVersion))
		throw new Error("Actual host version is required")
	if (!OUTCOMES.has(input.outcome)) throw new Error("Invalid evidence outcome")
	if (!Array.isArray(input.taskIds) || input.taskIds.length > maxTaskIds)
		throw new Error("Too many evidence task IDs")
	for (const value of [input.startedAt, input.finishedAt]) {
		if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
			throw new Error("Invalid evidence timestamp")
	}
	if (Date.parse(input.finishedAt) < Date.parse(input.startedAt))
		throw new Error("Evidence timestamps are out of order")
	return {
		scenarioId: identifier(input.scenarioId, "scenario ID"),
		hostVersion: input.hostVersion,
		...(input.requestedHostVersion
			? { requestedHostVersion: identifier(input.requestedHostVersion, "requested host version") }
			: {}),
		provider: identifier(input.provider, "provider", true),
		...(input.modelId ? { modelId: identifier(input.modelId, "model ID", true) } : {}),
		...(input.reasoningEffort ? { reasoningEffort: identifier(input.reasoningEffort, "reasoning effort") } : {}),
		taskIds: [...new Set(input.taskIds.map((id) => identifier(id, "task ID")))],
		startedAt: new Date(input.startedAt).toISOString(),
		finishedAt: new Date(input.finishedAt).toISOString(),
		outcome: input.outcome,
	}
}

async function sourceRoot(value: string): Promise<string> {
	const root = assertSafeRoot(value)
	await rejectSymlinkComponents(root)
	if (!(await fs.stat(root)).isDirectory()) throw new Error("Evidence source must be a directory")
	return assertSafeRoot(await fs.realpath(root))
}

async function hashFile(filePath: string, limit: number): Promise<string> {
	await rejectSymlinkComponents(filePath)
	const before = await fs.lstat(filePath)
	if (!before.isFile() || before.size > limit) throw new Error("Evidence file exceeds its hash limit")
	const handle = await fs.open(filePath, "r")
	try {
		const stat = await handle.stat()
		if (stat.ino !== before.ino || stat.dev !== before.dev)
			throw new Error("Evidence source changed during capture")
		const hash = createHash("sha256")
		const buffer = Buffer.alloc(64 * 1_024)
		let position = 0
		while (true) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
			if (bytesRead === 0) break
			position += bytesRead
			if (position > limit) throw new Error("Evidence file exceeds its hash limit")
			hash.update(buffer.subarray(0, bytesRead))
		}
		const after = await handle.stat()
		if (after.size !== position || after.mtimeMs !== stat.mtimeMs)
			throw new Error("Evidence source changed during capture")
		return hash.digest("hex")
	} finally {
		await handle.close()
	}
}

/** Content-free repository snapshot. Keep the original fixture private if exact replay is required. */
export async function captureRepositoryEvidence(
	workspacePath: string,
	overrides?: Partial<EvidenceLimits>,
): Promise<RepositoryEvidence> {
	const limits = limitsWithDefaults(overrides)
	const root = await sourceRoot(workspacePath)
	const result: RepositoryEvidence = { files: [], complete: true, skipped: 0 }
	let bytes = 0
	let visited = 0
	const walk = async (directory: string, depth = 0): Promise<void> => {
		if (depth > 32 || visited >= limits.maxFiles) {
			result.complete = false
			result.skipped++
			return
		}
		await rejectSymlinkComponents(directory)
		const directoryHandle = await fs.opendir(directory)
		for await (const entry of directoryHandle) {
			if (++visited > limits.maxFiles) {
				result.complete = false
				result.skipped++
				break
			}
			if (OMITTED_DIRECTORIES.has(entry.name) || SENSITIVE_FILE.test(entry.name)) {
				result.skipped++
				continue
			}
			const filePath = path.join(directory, entry.name)
			if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
				result.complete = false
				result.skipped++
				continue
			}
			if (entry.isDirectory()) {
				await walk(filePath, depth + 1)
				continue
			}
			try {
				const stat = await fs.lstat(filePath)
				if (stat.size > limits.maxFileBytes || bytes + stat.size > limits.maxTotalBytes) {
					result.complete = false
					result.skipped++
					continue
				}
				const hash = await hashFile(filePath, limits.maxFileBytes)
				bytes += stat.size
				result.files.push({
					path: path.relative(root, filePath).split(path.sep).join("/"),
					bytes: stat.size,
					sha256: hash,
				})
			} catch {
				result.complete = false
				result.skipped++
			}
		}
	}
	await walk(root)
	result.files.sort((left, right) => left.path.localeCompare(right.path))
	try {
		const { stdout } = await execFile("git", ["-C", root, "rev-parse", "--verify", "HEAD"], {
			windowsHide: true,
			timeout: 5_000,
			maxBuffer: 1_024,
		})
		if (/^[a-f0-9]{40,64}$/.test(stdout.trim())) result.commit = stdout.trim()
	} catch {
		/* Non-Git workspaces are valid fixtures. */
	}
	return result
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

function validateRepositoryEvidence(snapshot: RepositoryEvidence, limits: EvidenceLimits): RepositoryEvidence {
	if (!Array.isArray(snapshot.files) || snapshot.files.length > limits.maxFiles)
		throw new Error("Invalid before snapshot")
	const files = snapshot.files.map((file) => {
		if (
			typeof file.path !== "string" ||
			file.path.length > 512 ||
			/[\\:]/.test(file.path) ||
			[...file.path].some((character) => character.charCodeAt(0) < 32) ||
			path.isAbsolute(file.path) ||
			file.path.split("/").some((part) => !part || part === "." || part === ".." || SENSITIVE_FILE.test(part)) ||
			!Number.isSafeInteger(file.bytes) ||
			file.bytes < 0 ||
			file.bytes > limits.maxFileBytes ||
			!/^[a-f0-9]{64}$/.test(file.sha256)
		) {
			throw new Error("Invalid before snapshot file")
		}
		return { path: file.path, bytes: file.bytes, sha256: file.sha256 }
	})
	return {
		...(typeof snapshot.commit === "string" && /^[a-f0-9]{40,64}$/.test(snapshot.commit)
			? { commit: snapshot.commit }
			: {}),
		files,
		complete: snapshot.complete === true,
		skipped: Number.isSafeInteger(snapshot.skipped) && snapshot.skipped >= 0 ? snapshot.skipped : 0,
	}
}

function projectJournalEvent(value: unknown): unknown {
	const raw = object(value)
	const event = object(raw?.event) ?? raw
	const payload = object(event?.payload) ?? event
	if (!event || typeof event.type !== "string" || !EVENT_TYPES.has(event.type)) return undefined
	const projected: Record<string, unknown> = { type: event.type }
	for (const key of [
		"sequence",
		"occurredAt",
		"attempt",
		"requestIndex",
		"inputTokens",
		"outputTokens",
		"cacheReadTokens",
		"batchSize",
		"durationMs",
		"exitCode",
	]) {
		const value = raw?.[key] ?? payload?.[key]
		if (typeof value === "number" && Number.isFinite(value)) projected[key] = value
	}
	for (const key of ["status", "phase", "decision"]) {
		const value = payload?.[key]
		if (typeof value === "string" && STATUSES.has(value)) projected[key] = value
	}
	const callId = payload?.callId
	if (typeof callId === "string") projected.callIdSha256 = sha256(callId)
	const code = knownFailureCode(payload?.code)
	if (code) projected.code = code
	return projected
}

function projectConversation(buffer: Buffer): unknown {
	const messages: unknown = JSON.parse(buffer.toString("utf8"))
	if (!Array.isArray(messages)) throw new Error("Invalid conversation evidence")
	return messages.map((entry) => {
		const message = object(entry)
		const blocks = Array.isArray(message?.content) ? message.content : []
		return {
			role: message?.role === "assistant" || message?.role === "user" ? message.role : "unknown",
			tools: blocks.flatMap((value) => {
				const block = object(value)
				if (block?.type === "tool_use" && typeof block.id === "string") {
					return [{ type: "call", idSha256: sha256(block.id) }]
				}
				if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
					return [{ type: "result", idSha256: sha256(block.tool_use_id), isError: block.is_error === true }]
				}
				return []
			}),
		}
	})
}

/** Await before runner cleanup. A failed or incomplete capture never authorizes deleting original sources. */
export async function captureRunEvidence(options: CaptureRunEvidenceOptions): Promise<CaptureRunEvidenceResult> {
	const limits = limitsWithDefaults(options.limits)
	const metadata = validateMetadata(options.metadata, limits.maxTaskIds)
	const runId = identifier(options.runId, "run ID")
	const root = await ensureEvidenceRoot(options.artifactsRoot)
	const sources: EvidenceManifest["retainedSources"] = []
	for (const [kind, candidate] of [
		["workspace", options.workspacePath],
		["storage", options.storagePath],
		["logs", options.logsPath],
	] as const) {
		if (!candidate) continue
		const resolved = await sourceRoot(candidate)
		if (!options.assertSourceOwned) throw new Error("Capture requires the runner's test-source ownership validator")
		await options.assertSourceOwned(resolved)
		if (isWithin(root, resolved) || isWithin(resolved, root))
			throw new Error("Evidence and source directories must not overlap")
		sources.push({ kind, path: resolved })
	}
	let artifactDirectory: string
	try {
		artifactDirectory = await requireEvidenceRun(root, runId)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		;({ artifactDirectory } = await prepareEvidenceRun({ artifactsRoot: root, runId }))
	}
	// Each prepared run gets exactly one capture attempt. A partial failure remains inspectable, never overwritten.
	await fs.writeFile(path.join(artifactDirectory, ".capture-started"), "1", { flag: "wx", mode: 0o600 })
	const manifest: EvidenceManifest = {
		kind: "alpha-vscode-e2e-run-evidence",
		version: 1,
		runId,
		finalized: true,
		metadata,
		summary: classifyFailure(metadata.outcome, options.failure),
		captureComplete: true,
		warnings: [],
		artifacts: [],
		retainedSources: sources,
		taskEvidence: [],
	}
	let written = 0
	const warn = (code: string) => {
		manifest.captureComplete = false
		if (!manifest.warnings.includes(code)) manifest.warnings.push(code)
	}
	const write = async (name: string, value: unknown): Promise<boolean> => {
		const content = Buffer.from(JSON.stringify(value, null, 2))
		if (written + content.length > limits.maxTotalBytes || manifest.artifacts.length >= limits.maxFiles) {
			warn("ARTIFACT_LIMIT")
			return false
		}
		await fs.writeFile(path.join(artifactDirectory, name), content, { flag: "wx", mode: 0o600 })
		written += content.length
		manifest.artifacts.push({ path: name, bytes: content.length, sha256: sha256(content) })
		return true
	}
	if (options.bundlePath) {
		try {
			manifest.bundleSha256 = await hashFile(options.bundlePath, 512 * 1_024 * 1_024)
		} catch {
			warn("BUNDLE_UNAVAILABLE")
		}
	}
	if (options.repositoryBefore) {
		const before = validateRepositoryEvidence(options.repositoryBefore, limits)
		if (!before.complete) warn("REPOSITORY_BEFORE_INCOMPLETE")
		await write("repository-before.json", before)
	}
	const workspace = sources.find((source) => source.kind === "workspace")
	if (workspace) {
		const after = await captureRepositoryEvidence(workspace.path, limits)
		if (!after.complete) warn("REPOSITORY_INCOMPLETE")
		await write("repository-after.json", after)
	}
	const storage = sources.find((source) => source.kind === "storage")
	if (storage) {
		try {
			const content = await readTaskSource(
				path.join(storage.path, "agent_control.json"),
				limits.maxTaskSourceBytes,
			)
			const state = object(JSON.parse(content.toString("utf8")))
			if (!state) throw new Error("Invalid agent-control evidence")
			const counts: Record<string, number> = {}
			for (const key of ["agents", "tombstones", "mailbox", "verificationObligations"]) {
				const value = state[key]
				if (Array.isArray(value)) counts[key] = value.length
			}
			await write("agent-control-summary.json", {
				sourceBytes: content.length,
				sourceSha256: sha256(content),
				counts,
			})
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				await write("agent-control-summary.json", { state: "absent" })
			else {
				if (error instanceof TaskSourceError) warn(error.warning)
				warn("CONTROL_EVIDENCE_INCOMPLETE")
			}
		}
		for (const taskId of metadata.taskIds) {
			for (const fileName of [
				"agent_lifecycle_events.jsonl",
				"agent_turn_events.jsonl",
				"api_conversation_history.json",
			]) {
				try {
					const filePath = path.join(storage.path, "tasks", taskId, fileName)
					let projected: unknown
					if (fileName.endsWith(".jsonl")) {
						projected = await projectJournalSource(
							filePath,
							{
								maxSourceBytes: limits.maxTaskSourceBytes,
								maxLineBytes: limits.maxJournalLineBytes,
								maxEvents: limits.maxJournalEvents,
							},
							projectJournalEvent,
						)
					} else {
						const content = await readTaskSource(filePath, limits.maxTaskSourceBytes)
						projected = {
							sourceBytes: content.length,
							sourceSha256: sha256(content),
							projection: projectConversation(content),
						}
					}
					const captured = await write(`${taskId}-${fileName}.projection.json`, projected)
					manifest.taskEvidence.push({
						taskId,
						file: fileName,
						status: captured ? "captured" : "incomplete",
					})
				} catch (error) {
					if (error instanceof TaskSourceError) warn(error.warning)
					const absent = (error as NodeJS.ErrnoException).code === "ENOENT"
					manifest.taskEvidence.push({ taskId, file: fileName, status: absent ? "absent" : "incomplete" })
					// A pre-provider failure may have no API transcript; lifecycle absence is never silently complete.
					if (!absent || fileName !== "api_conversation_history.json") warn("TASK_EVIDENCE_INCOMPLETE")
				}
			}
		}
		try {
			const lock = path.join(storage.path, "agent_control.json.transaction.lock")
			await rejectSymlinkComponents(lock)
			const stat = await fs.lstat(lock)
			let state = "legacy-ownerless"
			let ownerBytes: number | undefined
			if (stat.isDirectory()) {
				try {
					const owner = await readBounded(path.join(lock, "owner.json"), 1_024)
					ownerBytes = owner.length
					state = owner.length === 0 ? "empty-owner" : "unreadable-owner"
					try {
						const parsed = object(JSON.parse(owner.toString("utf8")))
						if (parsed && Number.isSafeInteger(parsed.pid) && typeof parsed.token === "string")
							state = "recorded-owner"
					} catch {
						/* Keep only structural evidence, never malformed bytes. */
					}
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
						state = "unreadable-owner"
						warn("LOCK_EVIDENCE_INCOMPLETE")
					}
				}
			}
			await write("storage-lock.json", { state, ownerBytes })
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				await write("storage-lock.json", { state: "absent" })
			else warn("LOCK_EVIDENCE_INCOMPLETE")
		}
	}
	const logs = sources.find((source) => source.kind === "logs")
	if (logs) {
		// Log text can contain provider payloads. Record bounded file identity only, retaining raw logs in place.
		const snapshot = await captureRepositoryEvidence(logs.path, limits)
		if (!snapshot.complete) warn("LOG_EVIDENCE_INCOMPLETE")
		await write("logs-index.json", snapshot)
	}
	const manifestPath = path.join(artifactDirectory, "manifest.json")
	await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 })
	return { artifactDirectory, manifestPath, summary: manifest.summary, captureComplete: manifest.captureComplete }
}
