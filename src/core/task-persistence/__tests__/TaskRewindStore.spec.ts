import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import type { AlphaMessage } from "@alpha-code/types"

import { TASK_REWIND_FILE_NAME, TaskRewindStore } from "../TaskRewindStore"
import type { ApiMessage } from "../apiMessages"
import * as atomicWrite from "../atomicWrite"

let directory: string
const uiMessages: AlphaMessage[] = [{ ts: 100, type: "say", say: "text", text: "retained prompt" }]
const apiHistory: ApiMessage[] = [{ ts: 100, role: "user", content: "retained prompt" }]
const exclusion = { runId: "run", turnId: "turn", toolCallIds: ["removed-call"] }

beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-task-rewind-"))
})

afterEach(async () => {
	vi.restoreAllMocks()
	const resolved = path.resolve(directory)
	expect(path.dirname(resolved)).toBe(path.resolve(os.tmpdir()))
	expect(path.basename(resolved)).toMatch(/^alpha-task-rewind-/)
	await fs.rm(resolved, { recursive: true, force: true })
})

const store = () => new TaskRewindStore(directory, "task")
const receiptPath = () => path.join(directory, "tasks", "task", TASK_REWIND_FILE_NAME)

describe("conversation rewind write-ahead receipt", () => {
	it("leaves old tasks without rewind receipts or newly created directories", async () => {
		expect(await store().read()).toBeUndefined()
		expect(await fs.readdir(directory)).toEqual([])
	})

	it("retains exact target projections across a crash between UI and API writes", async () => {
		const record = await store().begin(uiMessages, apiHistory, exclusion)
		const uiFile = path.join(directory, "tasks", "task", "ui.json")
		const apiFile = path.join(directory, "tasks", "task", "api.json")
		await fs.writeFile(apiFile, JSON.stringify([...apiHistory, { role: "assistant", content: "deleted" }]))
		await fs.writeFile(uiFile, JSON.stringify(uiMessages))

		// A fresh instance represents reload after only the UI replacement reached disk.
		const recovered = await store().read()
		expect(recovered).toEqual(record)
		await fs.writeFile(uiFile, JSON.stringify(recovered!.pending!.uiMessages))
		await fs.writeFile(apiFile, JSON.stringify(recovered!.pending!.apiHistory))
		await store().complete(record.rewindId)
		await store().complete(record.rewindId)

		expect(JSON.parse(await fs.readFile(apiFile, "utf8"))).toEqual(apiHistory)
		expect(await store().read()).toEqual({ ...record, pending: undefined })
	})

	it("keeps exclusions cumulative for repeated rewinds and scopes reused call IDs to their turn", async () => {
		const first = await store().begin(uiMessages, apiHistory, exclusion)
		await store().complete(first.rewindId)
		const second = await store().begin([], [], { ...exclusion, toolCallIds: ["another-call", "removed-call"] })
		await store().complete(second.rewindId)
		const third = await store().begin([], [], { ...exclusion, turnId: "next-turn" })
		expect(third.exclusions).toEqual([
			{ ...exclusion, toolCallIds: ["removed-call", "another-call"] },
			{ ...exclusion, turnId: "next-turn" },
		])
	})

	it("rejects another rewind until the pending projection replacements finish", async () => {
		const first = await store().begin(uiMessages, apiHistory, exclusion)
		await expect(store().begin([], [])).rejects.toThrow("previous conversation rewind must finish")
		expect(await store().read()).toEqual(first)
	})

	it("does not let an older completion remove the current pending rewind", async () => {
		const first = await store().begin(uiMessages, apiHistory, exclusion)
		await store().complete(first.rewindId)
		const second = await store().begin([], [])
		await expect(store().complete(first.rewindId)).rejects.toThrow("receipt changed")
		expect(await store().read()).toEqual(second)
	})

	it("preserves pending recovery targets when completing the receipt fails", async () => {
		const first = await store().begin(uiMessages, apiHistory, exclusion)
		vi.spyOn(atomicWrite, "atomicWriteJson").mockRejectedValueOnce(new Error("disk failure"))
		await expect(store().complete(first.rewindId)).rejects.toThrow("disk failure")
		expect(await store().read()).toEqual(first)
	})

	it("fails closed for malformed and wrong-task receipts without rewriting them", async () => {
		await store().begin(uiMessages, apiHistory, exclusion)
		for (const contents of ["{", JSON.stringify({ schemaVersion: 1, taskId: "other-task" })]) {
			await fs.writeFile(receiptPath(), contents)
			await expect(store().read()).rejects.toThrow()
			expect(await fs.readFile(receiptPath(), "utf8")).toBe(contents)
		}
	})
})
