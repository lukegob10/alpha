import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { AlphaMessage } from "@alpha-code/types"

import { readTaskMessages, saveTaskMessages } from "../taskMessages"

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return { ...actual, rename: vi.fn(actual.rename) }
})

let storage: string

beforeEach(async () => {
	storage = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-ui-transcript-commit-"))
})

afterEach(async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename)
	await actual.rm(storage, { recursive: true, force: true })
})

it("keeps the saved transcript readable until its replacement commits", async () => {
	const input = { taskId: "recipient", globalStoragePath: storage, requireExisting: true }
	const previous: AlphaMessage[] = [{ ts: 1, type: "say", say: "text", text: "Saved answer" }]
	const next: AlphaMessage[] = [...previous, { ts: 2, type: "say", say: "text", text: "Next answer" }]
	await saveTaskMessages({ ...input, messages: previous })
	const file = path.join(storage, "tasks", input.taskId, "ui_messages.json")
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	let release!: () => void
	let entered!: () => void
	const commitBarrier = new Promise<void>((resolve) => (release = resolve))
	const replacementReady = new Promise<void>((resolve) => (entered = resolve))
	vi.mocked(fs.rename).mockImplementation(async (source, destination) => {
		if (destination === file && path.basename(String(source)).includes(".new_")) {
			entered()
			await commitBarrier
		}
		await actual.rename(source, destination)
	})
	const save = saveTaskMessages({ ...input, messages: next })
	await replacementReady
	const [duringSave] = await Promise.allSettled([readTaskMessages(input)]).finally(() => release())
	await save
	expect(duringSave).toEqual({ status: "fulfilled", value: previous })
	expect(await readTaskMessages(input)).toEqual(next)
	expect(await fs.readdir(path.dirname(file))).toEqual(["ui_messages.json"])
})

it("retains the previous transcript when replacement fails without needing a rollback rename", async () => {
	const input = { taskId: "recipient", globalStoragePath: storage, requireExisting: true }
	const previous: AlphaMessage[] = [{ ts: 1, type: "say", say: "text", text: "Keep this answer" }]
	await saveTaskMessages({ ...input, messages: previous })
	const file = path.join(storage, "tasks", input.taskId, "ui_messages.json")
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	const failure = Object.assign(new Error("replacement failed"), { code: "EIO" })
	vi.mocked(fs.rename)
		.mockClear()
		.mockImplementation(async (source, destination) => {
			if (destination === file) throw failure
			await actual.rename(source, destination)
		})
	await expect(
		saveTaskMessages({ ...input, messages: [{ ts: 2, type: "say", say: "text", text: "Uncommitted" }] }),
	).rejects.toBe(failure)
	expect(await readTaskMessages(input)).toEqual(previous)
	expect(fs.rename).toHaveBeenCalledOnce()
	expect(await fs.readdir(path.dirname(file))).toEqual(["ui_messages.json"])
})
