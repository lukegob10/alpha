import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { spawn } from "child_process"
import { build } from "esbuild"

import type { AlphaMessage } from "@alpha-code/types"
import { readApiMessages, saveApiMessages, type ApiMessage } from "../apiMessages"
import { ProviderTranscriptStore } from "../ProviderTranscriptStore"
import { TaskRewindStore } from "../TaskRewindStore"
import { readTaskMessages, saveTaskMessages } from "../taskMessages"

// Storage configuration belongs to the VS Code adapter. These component crash tests pin one owned directory.
vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: async (storage: string, taskId: string) => {
		const directory = path.join(storage, "tasks", taskId)
		await fs.mkdir(directory, { recursive: true })
		return directory
	},
	resolveExistingTaskDirectoryPathReadOnly: async (storage: string, taskId: string) =>
		path.join(storage, "tasks", taskId),
}))

const taskId = "process-loss-task"
const originalProviderState: ApiMessage & { opaqueProviderState: unknown } = {
	role: "assistant",
	ts: 2,
	encrypted_content: "retained-opaque+/=\nbytes",
	opaqueProviderState: { beforeRewind: ["keep", { unknownFutureField: true }] },
	content: [
		{ type: "thinking", thinking: "Retain this earlier signed item.", signature: "retained-signature" },
		{ type: "text", text: "The original task is ready." },
	],
}
const original: ApiMessage[] = [
	{ role: "user", content: "Retain the original task instruction.", ts: 1 },
	originalProviderState,
]
const providerAssistant: ApiMessage & { opaqueProviderState: unknown } = {
	role: "assistant",
	ts: 3,
	encrypted_content: "opaque+/=\r\nbytes",
	reasoning_details: [{ type: "reasoning.encrypted", data: "opaque-detail", signature: "original-signature" }],
	opaqueProviderState: { ordered: ["first", { future: "preserve" }, "last"] },
	content: [
		{ type: "thinking", thinking: "Preserve these signed bytes.", signature: "signed-thinking" },
		{ type: "tool_use", id: "effect-call", name: "exec_command", input: { cmd: "owned-fixture-effect" } },
	],
}
const assistant = [...original, providerAssistant]
const complete: ApiMessage[] = [
	...assistant,
	{
		role: "user",
		ts: 4,
		content: [{ type: "tool_result", tool_use_id: "effect-call", content: "committed", is_error: false }],
	},
]
const uiOriginal: AlphaMessage[] = [
	{ ts: 1, type: "say", say: "text", text: "Retained instruction" },
	{ ts: 2, type: "say", say: "text", text: "Remove this later answer" },
]
const uiRewound = uiOriginal.slice(0, 1)

describe("owned process loss at transcript and rewind commit boundaries", () => {
	let fixtureDirectory: string
	let directory: string
	let writer: string

	beforeAll(async () => {
		fixtureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-transcript-process-loss-"))
		writer = path.join(fixtureDirectory, "writer.cjs")
		await build({
			entryPoints: [path.join(__dirname, "fixtures", "transcript-crash-writer.ts")],
			outfile: writer,
			bundle: true,
			platform: "node",
			format: "cjs",
			logLevel: "silent",
			plugins: [
				{
					name: "owned-storage-adapter",
					setup(builder) {
						builder.onResolve({ filter: /utils[\\/]storage$/ }, () => ({
							path: "owned-storage-adapter",
							namespace: "fixture",
						}))
						builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
							contents: `
								const fs = require("fs/promises")
								const path = require("path")
								exports.getTaskDirectoryPath = async (storage, taskId) => {
									const directory = path.join(storage, "tasks", taskId)
									await fs.mkdir(directory, { recursive: true })
									return directory
								}
								exports.resolveExistingTaskDirectoryPathReadOnly = async (storage, taskId) => path.join(storage, "tasks", taskId)
							`,
						}))
					},
				},
			],
		})
	})

	afterAll(async () => {
		expect(path.dirname(path.resolve(fixtureDirectory))).toBe(path.resolve(os.tmpdir()))
		expect(path.basename(fixtureDirectory)).toMatch(/^alpha-transcript-process-loss-/)
		await fs.rm(fixtureDirectory, { recursive: true, force: true })
	})

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(fixtureDirectory, "case-"))
		await fs.writeFile(path.join(directory, "effect.log"), "")
		await fs.writeFile(
			path.join(directory, "fixture.json"),
			JSON.stringify({ taskId, assistant, complete, rewound: original, uiRewound }),
		)
		const receipt = await saveApiMessages({ taskId, globalStoragePath: directory, messages: original })
		await new ProviderTranscriptStore(taskId, directory).commitAuthoritativeTranscript(receipt)
		await saveTaskMessages({ taskId, globalStoragePath: directory, messages: uiOriginal })
	})

	afterEach(async () => {
		expect(path.dirname(path.resolve(directory))).toBe(path.resolve(fixtureDirectory))
		expect(path.basename(directory)).toMatch(/^case-/)
		await fs.rm(directory, { recursive: true, force: true })
	})

	async function killAt(phase: string) {
		const child = spawn(process.execPath, [writer, directory, phase], {
			stdio: ["ignore", "ignore", "pipe", "ipc"],
			windowsHide: true,
		})
		child.stderr?.resume()
		const exited = new Promise<void>((resolve) => child.once("close", () => resolve()))
		const ready = new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("Crash fixture did not reach its barrier")), 10_000)
			child.once("message", (message) => {
				clearTimeout(timeout)
				if (
					message !== null &&
					typeof message === "object" &&
					"kind" in message &&
					message.kind === "ready" &&
					"phase" in message &&
					message.phase === phase
				)
					resolve()
				else reject(new Error("Crash fixture reported a different boundary"))
			})
			child.once("error", (error) => {
				clearTimeout(timeout)
				reject(error)
			})
			child.once("exit", () => {
				clearTimeout(timeout)
				reject(new Error("Crash fixture exited before its barrier"))
			})
		})
		try {
			await ready
			expect(child.kill("SIGKILL")).toBe(true)
			await exited
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
			await exited
		}
		// The owner has exited. Advance only its orphaned lease timestamps, avoiding a 31-second stale-lock sleep.
		for (const name of ["api_conversation_history.json", "provider_transcript.json", "task_rewind.json"]) {
			const lock = path.join(directory, "tasks", taskId, `${name}.lock`)
			try {
				expect((await fs.lstat(lock)).isDirectory()).toBe(true)
				await fs.utimes(lock, new Date(0), new Date(0))
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			}
		}
	}

	it.each([
		"assistant-partial-temp",
		"assistant-before-rename",
		"assistant-committed",
		"effect-committed",
		"result-before-rename",
		"result-committed",
		"sidecar-before-rename",
		"sidecar-committed",
	])("retains exact authoritative bytes and provider state after process loss at %s", async (phase) => {
		await killAt(phase)
		const beforeAssistant = phase === "assistant-partial-temp" || phase === "assistant-before-rename"
		const resultPersisted = ["result-committed", "sidecar-before-rename", "sidecar-committed"].includes(phase)
		const expected = beforeAssistant ? original : resultPersisted ? complete : assistant
		const options = { taskId, globalStoragePath: directory }
		const retained = await readApiMessages(options)
		expect(retained).toEqual(expected)
		if (phase === "assistant-partial-temp") {
			const taskDirectory = path.join(directory, "tasks", taskId)
			const interrupted = (await fs.readdir(taskDirectory)).find((name) =>
				name.startsWith(".api_conversation_history.json.new_"),
			)
			expect(interrupted).toBeDefined()
			expect(await fs.readFile(path.join(taskDirectory, interrupted!), "utf8")).toBe('{"partial":')
		}
		if (!beforeAssistant) expect(retained[original.length]).toEqual(providerAssistant)
		const effectStarted = !beforeAssistant && phase !== "assistant-committed"
		expect(await fs.readFile(path.join(directory, "effect.log"), "utf8")).toBe(effectStarted ? "committed\n" : "")
		const restarted = new ProviderTranscriptStore(taskId, directory)
		if (resultPersisted && phase !== "sidecar-committed") {
			await expect(restarted.read()).rejects.toMatchObject({ code: "digest_mismatch" })
			// Rebinding the existing authoritative snapshot retries persistence, never the dummy effect.
			const receipt = await saveApiMessages({ ...options, messages: retained })
			const repaired = await restarted.commitAuthoritativeTranscript(receipt)
			expect(await restarted.commitAuthoritativeTranscript(receipt)).toEqual(repaired)
		}
		expect((await restarted.read()).messages).toEqual(expected)
		expect((await new ProviderTranscriptStore(taskId, directory).read()).messages).toEqual(expected)
		expect(await fs.readFile(path.join(directory, "effect.log"), "utf8")).toBe(effectStarted ? "committed\n" : "")
		// An interrupted call remains visibly unresolved; persistence must not manufacture a success receipt.
		const results = retained.flatMap((message) =>
			Array.isArray(message.content) ? message.content.filter((block) => block.type === "tool_result") : [],
		)
		expect(results).toHaveLength(resultPersisted ? 1 : 0)
	})

	it.each(["rewind-receipt", "rewind-ui", "rewind-api", "rewind-complete"])(
		"replays exact rewind targets idempotently after process loss at %s",
		async (phase) => {
			const options = { taskId, globalStoragePath: directory }
			const current = await saveApiMessages({ ...options, messages: complete })
			await new ProviderTranscriptStore(taskId, directory).commitAuthoritativeTranscript(current)
			await killAt(phase)
			const rewind = new TaskRewindStore(directory, taskId)
			const recovered = await rewind.read()
			expect(recovered?.exclusions).toEqual([
				{ runId: "crash-run", turnId: "removed-turn", toolCallIds: ["removed-call"] },
			])
			expect(await readTaskMessages({ ...options, requireExisting: true })).toEqual(
				phase === "rewind-receipt" ? uiOriginal : uiRewound,
			)
			expect(await readApiMessages(options)).toEqual(
				phase === "rewind-receipt" || phase === "rewind-ui" ? complete : original,
			)
			if (phase === "rewind-complete") expect(recovered?.pending).toBeUndefined()
			else {
				expect(recovered?.pending).toEqual({ uiMessages: uiRewound, apiHistory: original })
				await saveTaskMessages({ ...options, messages: recovered!.pending!.uiMessages })
				const receipt = await saveApiMessages({ ...options, messages: recovered!.pending!.apiHistory })
				await new ProviderTranscriptStore(taskId, directory).commitAuthoritativeTranscript(receipt)
				await rewind.complete(recovered!.rewindId)
				await rewind.complete(recovered!.rewindId)
			}
			expect(await readTaskMessages({ ...options, requireExisting: true })).toEqual(uiRewound)
			expect((await new ProviderTranscriptStore(taskId, directory).read()).messages).toEqual(original)
			expect((await new TaskRewindStore(directory, taskId).read())?.pending).toBeUndefined()
		},
	)
})
