import { createHash } from "crypto"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { Task } from "../Task"
import { GlobalFileNames } from "../../../shared/globalFileNames"
import { ProviderTranscriptStore } from "../../task-persistence/ProviderTranscriptStore"
import { readApiMessages, saveApiMessages, type ApiMessagesWritePrecondition } from "../../task-persistence/apiMessages"
import { TaskRewindStore } from "../../task-persistence/TaskRewindStore"
import { readTaskMessages, saveTaskMessages } from "../../task-persistence/taskMessages"

vi.mock("../../../utils/storage", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../utils/storage")>()),
	getTaskDirectoryPath: async (storagePath: string, taskId: string) => {
		const directory = path.join(storagePath, "tasks", taskId)
		await fs.mkdir(directory, { recursive: true })
		return directory
	},
}))

let storagePath: string

beforeEach(async () => {
	storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-task-preimage-"))
})

afterEach(async () => {
	vi.restoreAllMocks()
	await fs.rm(storagePath, { recursive: true, force: true })
})

function harness() {
	const taskId = "preimage-task"
	return Object.assign(Object.create(Task.prototype), {
		taskId,
		globalStoragePath: storagePath,
		apiConversationHistory: [{ role: "user" as const, content: "initial" }],
		apiConversationHistoryPersistenceKey: storagePath,
		apiConversationHistoryFailureGeneration: 0,
		apiConversationHistoryWritePrecondition: { missing: true },
		providerTranscriptStore: new ProviderTranscriptStore(taskId, storagePath),
		providerRef: { deref: () => undefined },
		environmentContext: { reset: vi.fn() },
	}) as Task
}

function coldSavedTask() {
	const task = harness()
	task.apiConversationHistory = []
	Reflect.set(task, "apiConversationHistoryWritePrecondition", "unobserved")
	task.overwriteAlphaMessages = vi.fn(async (messages) => {
		task.alphaMessages = messages
		await saveTaskMessages({ messages, taskId: task.taskId, globalStoragePath: storagePath })
		return true
	})
	return task
}

it("preserves an unobserved external transcript before a real Task save can overwrite it", async () => {
	const task = harness()
	expect(await task["saveApiConversationHistory"]()).toBe(true)
	const directory = path.join(storagePath, "tasks", task.taskId)
	const filePath = path.join(directory, GlobalFileNames.apiConversationHistory)
	const sidecarPath = path.join(directory, GlobalFileNames.providerTranscript)
	const sidecarBefore = await fs.readFile(sidecarPath)
	const externalBytes = Buffer.from(JSON.stringify([{ role: "user", content: "external concurrent work" }]))
	await fs.writeFile(filePath, externalBytes)
	task.apiConversationHistory.push({ role: "assistant", content: "stale local work" })
	vi.spyOn(console, "error").mockImplementation(() => undefined)

	expect(await task["saveApiConversationHistory"]()).toBe(false)
	expect(await fs.readFile(filePath)).toEqual(externalBytes)
	const digest = createHash("sha256").update(externalBytes).digest("hex")
	expect(await fs.readFile(`${filePath}.conflict_${digest}.json`)).toEqual(externalBytes)
	expect(await fs.readFile(sidecarPath)).toEqual(sidecarBefore)
})

it("uses the preceding durable write for queued saves and sidecar retries", async () => {
	const task = harness()
	const first = task["saveApiConversationHistory"]()
	task.apiConversationHistory.push({ role: "assistant", content: "second queued snapshot" })
	const second = task["saveApiConversationHistory"]()
	expect(await Promise.all([first, second])).toEqual([true, true])
	const store = task["providerTranscriptStore"]
	vi.spyOn(store, "commitAuthoritativeTranscript").mockRejectedValueOnce(new Error("sidecar unavailable"))
	task.apiConversationHistory.push({ role: "user", content: "third snapshot" })
	expect(await task["saveApiConversationHistory"]()).toBe(false)
	expect(await task["saveApiConversationHistory"]()).toBe(true)
	expect(await store.readMessages()).toEqual(task.apiConversationHistory)
})

it("captures a noncanonical legacy file during hydration before saving its continuation", async () => {
	const task = harness()
	const directory = path.join(storagePath, "tasks", task.taskId)
	await fs.mkdir(directory, { recursive: true })
	const filePath = path.join(directory, GlobalFileNames.apiConversationHistory)
	await fs.writeFile(filePath, `${JSON.stringify(task.apiConversationHistory, null, "\t")}\n`)
	task.apiConversationHistory = await task["getSavedApiConversationHistory"]({ hydrateOnly: true })
	task.apiConversationHistory.push({ role: "assistant", content: "continued after reload" })
	expect(await task["saveApiConversationHistory"]()).toBe(true)
})

it.each(["before-api-write", "after-api-write"])(
	"recovers a pending rewind %s before ordinary hydration",
	async (crash) => {
		const original = harness()
		expect(await original["saveApiConversationHistory"]()).toBe(true)
		const pendingUi = [{ ts: 100, type: "say" as const, say: "text" as const, text: "retained" }]
		const pendingApi = [{ role: "user" as const, content: "retained" }]
		const rewind = new TaskRewindStore(storagePath, original.taskId)
		await rewind.begin(pendingUi, pendingApi)
		if (crash === "after-api-write") {
			await saveApiMessages({ messages: pendingApi, taskId: original.taskId, globalStoragePath: storagePath })
		}
		const cold = coldSavedTask()
		await cold["recoverConversationRewind"]()
		expect((await rewind.read())?.pending).toBeUndefined()
		expect(await readApiMessages({ taskId: cold.taskId, globalStoragePath: storagePath })).toEqual(pendingApi)
		expect(await readTaskMessages({ taskId: cold.taskId, globalStoragePath: storagePath })).toEqual(pendingUi)
		expect(await cold["providerTranscriptStore"].readMessages()).toEqual(pendingApi)
	},
)

it("keeps pending rewind recovery fenced after its source was already observed", async () => {
	const original = harness()
	expect(await original["saveApiConversationHistory"]()).toBe(true)
	const rewind = new TaskRewindStore(storagePath, original.taskId)
	await rewind.begin([], [{ role: "user", content: "rewind target" }])
	const cold = coldSavedTask()
	await cold["getSavedApiConversationHistory"]({ hydrateOnly: true })
	const filePath = path.join(storagePath, "tasks", cold.taskId, GlobalFileNames.apiConversationHistory)
	const externalBytes = Buffer.from(JSON.stringify([{ role: "user", content: "external after observation" }]))
	await fs.writeFile(filePath, externalBytes)
	vi.spyOn(console, "error").mockImplementation(() => undefined)
	await expect(cold["recoverConversationRewind"]()).rejects.toThrow("provider history could not be durably saved")
	expect((await rewind.read())?.pending).toBeDefined()
	expect(await fs.readFile(filePath)).toEqual(externalBytes)
})

it("does not adopt an existing authority for a new task's overwrite", async () => {
	const task = harness()
	const filePath = path.join(storagePath, "tasks", task.taskId, GlobalFileNames.apiConversationHistory)
	await fs.mkdir(path.dirname(filePath), { recursive: true })
	const externalBytes = Buffer.from(JSON.stringify([{ role: "user", content: "external existing task" }]))
	await fs.writeFile(filePath, externalBytes)
	vi.spyOn(console, "error").mockImplementation(() => undefined)
	expect(await task.overwriteApiConversationHistory([{ role: "user", content: "new task" }])).toBe(false)
	expect(await fs.readFile(filePath)).toEqual(externalBytes)
})

it.each([false, true])("uses a cold parent's captured source preimage (external edit: %s)", async (externalEdit) => {
	const original = harness()
	expect(await original["saveApiConversationHistory"]()).toBe(true)
	let sourcePrecondition: ApiMessagesWritePrecondition | undefined
	const source = await readApiMessages({
		taskId: original.taskId,
		globalStoragePath: storagePath,
		onRead: (precondition) => (sourcePrecondition = precondition),
	})
	const next = [...source, { role: "user" as const, content: "delegated child result" }]
	const filePath = path.join(storagePath, "tasks", original.taskId, GlobalFileNames.apiConversationHistory)
	const externalBytes = Buffer.from(JSON.stringify([{ role: "user", content: "newer external parent work" }]))
	if (externalEdit) await fs.writeFile(filePath, externalBytes)
	const cold = coldSavedTask()
	vi.spyOn(console, "error").mockImplementation(() => undefined)
	expect(await cold.overwriteApiConversationHistory(next, undefined, sourcePrecondition)).toBe(!externalEdit)
	if (externalEdit) expect(await fs.readFile(filePath)).toEqual(externalBytes)
	else expect(await cold["providerTranscriptStore"].readMessages()).toEqual(next)
})
