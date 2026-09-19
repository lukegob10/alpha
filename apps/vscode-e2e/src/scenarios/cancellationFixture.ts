import { spawn } from "node:child_process"
import * as fs from "node:fs/promises"
import * as http from "node:http"
import * as path from "node:path"

export interface CancellationStreamObservation {
	requestCount: number
	responseStarted: boolean
	clientClosed: boolean
	clientClosedAt?: number
	closeReason?: "client" | "server"
}

export interface CancellationStreamFixture {
	readonly url: string
	readonly observation: CancellationStreamObservation
	close(): Promise<void>
}

/**
 * A localhost response which writes one chunk and then never finishes. The
 * server deliberately ignores the request's abort signal; only the client
 * closing its transport can make `clientClosed` true. This lets a host test
 * distinguish provider cancellation from fixture teardown.
 */
export async function startNonCooperativeHttpStream(): Promise<CancellationStreamFixture> {
	const observation: CancellationStreamObservation = {
		requestCount: 0,
		responseStarted: false,
		clientClosed: false,
	}
	let shuttingDown = false
	const sockets = new Set<import("node:net").Socket>()
	const server = http.createServer((request, response) => {
		if (request.url !== "/stream") {
			response.statusCode = 404
			response.end()
			return
		}

		observation.requestCount += 1
		response.statusCode = 200
		response.setHeader("content-type", "text/event-stream")
		response.setHeader("cache-control", "no-cache")
		response.setHeader("connection", "keep-alive")
		response.flushHeaders()
		response.write("data: cancellation-fixture-open\n\n")
		observation.responseStarted = true

		const recordClientClose = () => {
			if (shuttingDown || observation.clientClosed) return
			observation.clientClosed = true
			observation.clientClosedAt = Date.now()
			observation.closeReason = "client"
		}
		request.once("aborted", recordClientClose)
		response.once("close", recordClientClose)
	})
	server.on("connection", (socket) => {
		sockets.add(socket)
		socket.once("close", () => sockets.delete(socket))
	})

	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => reject(error)
		server.once("error", onError)
		server.listen(0, "127.0.0.1", () => {
			server.off("error", onError)
			resolve()
		})
	})
	const address = server.address()
	if (!address || typeof address === "string") throw new Error("Cancellation stream did not bind a TCP port")

	return {
		url: `http://127.0.0.1:${address.port}/stream`,
		observation,
		close: async () => {
			if (shuttingDown) return
			shuttingDown = true
			for (const socket of sockets) socket.destroy()
			await new Promise<void>((resolve) => server.close(() => resolve()))
		},
	}
}

export interface CancellationProviderObservation {
	taskId: string
	signalProvided: boolean
	fetchStartedWithSignal: boolean
	abortObserved: boolean
	abortObservedAt?: number
	streamReadAborted: boolean
}

/**
 * Records the provider-side cancellation path while keeping the HTTP reader
 * pending until the request's own signal closes it. The server remains
 * non-cooperative, so an observation can only pass after the actual client
 * transport closes.
 */
export class CancellationStreamAI {
	readonly id = `managed-agent-cancellation-${Date.now()}`
	removeFromCache?: () => void
	readonly observations = new Map<string, CancellationProviderObservation>()
	readonly entered = new Set<string>()
	private readonly roles = new Map<string, "root" | "stream" | "process">()
	private readonly turns = new Map<string, number>()
	private readonly release = new Set<() => void>()

	constructor(
		readonly streamUrl: string,
		readonly processCommand: string,
	) {}

	registerRole(taskId: string, role: "root" | "stream" | "process"): void {
		this.roles.set(taskId, role)
	}

	async *createMessage(
		_systemPrompt: string,
		_messages: unknown[],
		metadata?: { taskId?: string; signal?: AbortSignal },
	): AsyncGenerator<
		| { type: "text"; text: string }
		| { type: "tool_call"; id: string; name: string; arguments: string }
		| { type: "usage"; inputTokens: number; outputTokens: number; totalCost: number }
	> {
		const taskId = metadata?.taskId
		if (!taskId) throw new Error("Cancellation fixture provider request is missing taskId")
		const role = this.roles.get(taskId) ?? "root"
		const signal = metadata?.signal
		const observation: CancellationProviderObservation = {
			taskId,
			signalProvided: signal !== undefined,
			fetchStartedWithSignal: false,
			abortObserved: false,
			streamReadAborted: false,
		}
		this.observations.set(taskId, observation)
		if (signal) {
			const onAbort = () => {
				observation.abortObserved = true
				observation.abortObservedAt = Date.now()
			}
			if (signal.aborted) onAbort()
			else signal.addEventListener("abort", onAbort, { once: true })
		}

		const turn = this.turns.get(taskId) ?? 0
		this.turns.set(taskId, turn + 1)
		if (role === "process" && turn === 0) {
			this.entered.add(taskId)
			yield {
				type: "tool_call",
				id: `cancellation-process-${taskId}`,
				name: "execute_command",
				arguments: JSON.stringify({ command: this.processCommand, timeout: 120 }),
			}
			yield { type: "usage", inputTokens: 10, outputTokens: 5, totalCost: 0 }
			return
		}

		if (role === "stream" && turn === 0) {
			if (!signal) throw new Error("The stream fixture requires a provider AbortSignal")
			const response = await fetch(this.streamUrl, { signal })
			observation.fetchStartedWithSignal = true
			if (!response.body) throw new Error("Cancellation stream response did not expose a body")
			const reader = response.body.getReader()
			try {
				const first = await reader.read()
				if (first.done) throw new Error("Cancellation stream ended before its first chunk")
				this.entered.add(taskId)
				yield { type: "text", text: "cancellation-stream-open" }
				try {
					await reader.read()
					if (signal.aborted) observation.streamReadAborted = true
				} catch (error) {
					if (!signal.aborted) throw error
					observation.streamReadAborted = true
				}
			} finally {
				if (signal.aborted) observation.streamReadAborted = true
				reader.releaseLock()
			}
			yield { type: "usage", inputTokens: 10, outputTokens: 5, totalCost: 0 }
			return
		}

		if (role === "root" && turn === 0) {
			this.entered.add(taskId)
			yield { type: "text", text: "cancellation-root-open" }
			await new Promise<void>((resolve) => {
				const release = () => {
					this.release.delete(release)
					resolve()
				}
				this.release.add(release)
				if (signal?.aborted) release()
				else signal?.addEventListener("abort", release, { once: true })
			})
			yield { type: "usage", inputTokens: 10, outputTokens: 5, totalCost: 0 }
			return
		}

		yield { type: "text", text: "cancellation-fixture-terminal" }
		yield { type: "usage", inputTokens: 10, outputTokens: 5, totalCost: 0 }
	}

	dispose(): void {
		for (const release of this.release) release()
		this.release.clear()
	}

	getModel() {
		return {
			id: this.id,
			info: {
				contextWindow: 128_000,
				maxTokens: 8_192,
				supportsImages: false,
				supportsPromptCache: false,
				inputPrice: 0,
				outputPrice: 0,
			},
		}
	}

	async countTokens(content: unknown[]): Promise<number> {
		return Math.max(1, Math.ceil(JSON.stringify(content).length / 4))
	}

	async completePrompt(): Promise<string> {
		return ""
	}
}

export interface ProcessTreeFixture {
	directory: string
	commandPath: string
	descendantPath: string
	statePath: string
	command: string
}

/** Shared state must live in the parent workspace because managed Workers run in cloned worktrees. */
export const CANCELLATION_PROCESS_STATE_ENV = "ALPHA_CANCELLATION_PROCESS_STATE"

const PROCESS_COMMAND = `
const { spawn } = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")
const directory = __dirname
const statePath = process.env.${CANCELLATION_PROCESS_STATE_ENV} || path.join(directory, "process-tree-state.json")
const commandReceiptPath = statePath + ".command.json"
const descendantPath = path.join(directory, "descendant.cjs")
const writeReceipt = (receiptPath, receipt) => {
  const temporaryPath = receiptPath + "." + process.pid + ".tmp"
  fs.writeFileSync(temporaryPath, JSON.stringify(receipt))
  try {
    fs.renameSync(temporaryPath, receiptPath)
  } catch {
    try { fs.rmSync(receiptPath, { force: true }) } catch {}
    fs.renameSync(temporaryPath, receiptPath)
  }
}
const child = spawn(process.execPath, [descendantPath], { stdio: "ignore", windowsHide: true })
child.once("spawn", () => writeReceipt(commandReceiptPath, {
  commandPid: process.pid,
  descendantPid: child.pid,
  commandStartedAt: Date.now(),
  descendantStartedAt: Date.now(),
}))
setInterval(() => {}, 1_000)
`

const DESCENDANT_SCRIPT = `
const fs = require("node:fs")
const path = require("node:path")
const statePath = process.env.${CANCELLATION_PROCESS_STATE_ENV} || path.join(__dirname, "process-tree-state.json")
const descendantReceiptPath = statePath + ".descendant.json"
const temporaryPath = descendantReceiptPath + "." + process.pid + ".tmp"
fs.writeFileSync(temporaryPath, JSON.stringify({
  descendantReadyAt: Date.now(),
  descendantActualPid: process.pid,
  descendantParentPid: process.ppid,
}))
try {
  fs.renameSync(temporaryPath, descendantReceiptPath)
} catch {
  try { fs.rmSync(descendantReceiptPath, { force: true }) } catch {}
  fs.renameSync(temporaryPath, descendantReceiptPath)
}
setInterval(() => {}, 1_000)
`

export async function writeProcessTreeFixture(workspace: string): Promise<ProcessTreeFixture> {
	const directory = path.join(workspace, ".alpha-cancellation")
	await fs.mkdir(directory, { recursive: true })
	const commandPath = path.join(directory, "command.cjs")
	const descendantPath = path.join(directory, "descendant.cjs")
	const statePath = path.join(directory, "process-tree-state.json")
	await Promise.all([
		fs.rm(`${statePath}.command.json`, { force: true }),
		fs.rm(`${statePath}.descendant.json`, { force: true }),
		fs.writeFile(commandPath, PROCESS_COMMAND, { encoding: "utf8", flag: "w" }),
		fs.writeFile(descendantPath, DESCENDANT_SCRIPT, { encoding: "utf8", flag: "w" }),
		fs.writeFile(statePath, "{}\n", { encoding: "utf8", flag: "w" }),
	])
	return {
		directory,
		commandPath,
		descendantPath,
		statePath,
		command: "node .alpha-cancellation/command.cjs",
	}
}

export interface ProcessTreeObservation {
	commandPid?: number
	descendantPid?: number
	descendantActualPid?: number
	descendantParentPid?: number
	commandStartedAt?: number
	descendantStartedAt?: number
	descendantReadyAt?: number
}

const readJsonReceipt = async (receiptPath: string): Promise<Record<string, unknown>> => {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		try {
			const contents = await fs.readFile(receiptPath, "utf8")
			const parsed = JSON.parse(contents) as unknown
			return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {}
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code
			if (code !== "ENOENT" && !(error instanceof SyntaxError)) throw error
			if (attempt === 4) return {}
			await new Promise((resolve) => setTimeout(resolve, 10))
		}
	}
	return {}
}

export async function readProcessTreeObservation(statePath: string): Promise<ProcessTreeObservation> {
	const [base, command, descendant] = await Promise.all([
		readJsonReceipt(statePath),
		readJsonReceipt(`${statePath}.command.json`),
		readJsonReceipt(`${statePath}.descendant.json`),
	])
	const commandObservation = { ...base, ...command } as ProcessTreeObservation
	const descendantMatchesCommand =
		typeof commandObservation.commandPid === "number" &&
		typeof commandObservation.descendantPid === "number" &&
		descendant.descendantActualPid === commandObservation.descendantPid &&
		descendant.descendantParentPid === commandObservation.commandPid
	return descendantMatchesCommand
		? ({ ...commandObservation, ...descendant } as ProcessTreeObservation)
		: commandObservation
}

export function isProcessAlive(pid: number | undefined): boolean {
	if (!pid || !Number.isInteger(pid) || pid <= 0) return false
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
		throw error
	}
}

export async function terminateProcessTree(observation: ProcessTreeObservation): Promise<void> {
	const pids = [observation.commandPid, observation.descendantActualPid, observation.descendantPid].filter(
		(pid): pid is number => typeof pid === "number",
	)
	if (pids.length === 0) return
	if (process.platform === "win32") {
		await new Promise<void>((resolve) => {
			const child = spawn("taskkill", ["/PID", String(pids[0]), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
			})
			child.once("exit", () => resolve())
			child.once("error", () => resolve())
		})
		return
	}
	for (const pid of [...pids].reverse()) {
		try {
			process.kill(pid, "SIGKILL")
		} catch {
			/* The process may already have been reaped by the cancellation path. */
		}
	}
}
