import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { readApiMessages, saveApiMessages, type ApiMessage } from "../apiMessages"
import { getEffectiveApiHistory } from "../../condense"

let storage: string
beforeEach(async () => {
	storage = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-input-metadata-"))
})
afterEach(async () => {
	await fs.rm(storage, { recursive: true, force: true })
})

it("preserves host origin and consumption receipts in the canonical transcript through compaction and reload", async () => {
	const messages: ApiMessage[] = [
		{
			role: "user",
			content: "human input",
			input_origin: "human",
			queued_message_ids: ["accepted-input"],
			condenseParent: "summary",
		},
		{ role: "assistant", content: "answer", condenseParent: "summary" },
		{
			role: "user",
			content: "agent instruction",
			input_origin: "agent",
			agent_message_id: "agent-receipt",
			condenseParent: "summary",
		},
		{ role: "user", content: "summary", input_origin: "agent", isSummary: true, condenseId: "summary" },
	]
	await saveApiMessages({ taskId: "task", globalStoragePath: storage, messages })
	const restored = await readApiMessages({ taskId: "task", globalStoragePath: storage })
	expect(restored).toEqual(messages)
	expect(
		getEffectiveApiHistory(restored).some((message) => message.queued_message_ids?.includes("accepted-input")),
	).toBe(false)
	expect(restored.flatMap((message) => message.queued_message_ids ?? [])).toEqual(["accepted-input"])
	expect(restored.find((message) => message.agent_message_id === "agent-receipt")?.input_origin).toBe("agent")
})

it.each([
	{ input_origin: "model" },
	{ queued_message_ids: [""] },
	{ queued_message_ids: ["x".repeat(257)] },
	{ queued_message_ids: Array.from({ length: 101 }, (_, index) => `id-${index}`) },
])("rejects malformed input metadata without rewriting the saved history: %j", async (metadata) => {
	const dir = path.join(storage, "tasks", "task")
	await fs.mkdir(dir, { recursive: true })
	const file = path.join(dir, "api_conversation_history.json")
	const before = JSON.stringify([{ role: "user", content: "input", ...metadata }])
	await fs.writeFile(file, before, "utf8")
	await expect(readApiMessages({ taskId: "task", globalStoragePath: storage })).rejects.toMatchObject({
		code: "invalid_messages",
	})
	expect(await fs.readFile(file, "utf8")).toBe(before)
})
