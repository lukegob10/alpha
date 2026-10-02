import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: async (storagePath: string, taskId: string) => {
		const directory = path.join(storagePath, taskId)
		await fs.mkdir(directory, { recursive: true })
		return directory
	},
}))

import { GlobalFileNames } from "../../../shared/globalFileNames"
import { AgentTurnEventLog, readAgentTurnEvents } from "../AgentTurnEventLog"
import { AgentLifecycleJournal, readAgentLifecycleEvents } from "../lifecycle"
import type { AgentTurnEvent } from "../AgentTurnEvents"

const ids = { taskId: "credential-evidence", runId: "run-1", turnId: "turn-1" }
const credential = "credential-fixture-do-not-persist"

describe("persisted agent evidence credential security", () => {
	let storagePath: string
	let log: AgentTurnEventLog
	let journal: AgentLifecycleJournal

	beforeEach(async () => {
		storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "agent-evidence-security-"))
		log = new AgentTurnEventLog(ids.taskId, storagePath, { runId: ids.runId })
		journal = await AgentLifecycleJournal.open(ids.taskId, storagePath)
	})

	afterEach(async () => {
		try {
			const closed = await Promise.allSettled([log.close(), journal.close()])
			for (const result of closed) if (result.status === "rejected") throw result.reason
		} finally {
			await fs.rm(storagePath, { recursive: true, force: true })
		}
	})

	it.each([
		["Bearer", `Authorization: Bearer ${credential}`],
		["Basic", `Authorization: Basic ${credential}`],
		["Digest parameters", `Authorization: Digest username="${credential}", nonce="${credential}"`],
		["Negotiate", `Authorization: Negotiate ${credential}`],
		["proxy credentials", `Proxy-Authorization: Basic ${credential}`],
		["quoted header", `authorization="Basic ${credential}"`],
		["mixed case and tab", `aUtHoRiZaTiOn:\tBasic\t${credential}`],
		["multiline colon assignment", `authorization:\n  "Basic ${credential}"`],
		["multiline equals assignment", `authorization =\n  'Basic ${credential}'`],
		["newline before colon", `Authorization\n:\n  "Basic ${credential}"`],
		["CRLF before quoted value", `Authorization:\r\n  "Basic ${credential}"`],
		["double-quoted multiline value", `Authorization: "Basic\n${credential}"`],
		["single-quoted multiline value", `Authorization: 'Basic\r\n${credential}'`],
	])(
		"removes %s credentials from both journal bytes and replay without mutating provider data",
		async (_case, header) => {
			const output = {
				stdout: `Verification started.\n${header}\nVerification failed with HTTP 401.`,
				failure: new Error(header),
				exitCode: 1,
			}
			const event: AgentTurnEvent = {
				type: "tool_result",
				callId: "call-1",
				name: "exec_command",
				status: "error",
				output,
			}

			await log.append(event)
			await journal.append({
				version: 1,
				eventId: "accepted",
				...ids,
				occurredAt: 1,
				type: "tool_call_accepted",
				payload: {
					item: {
						itemId: "call-item",
						type: "tool_call",
						toolCallId: "call-1",
						name: "exec_command",
						arguments: {},
						status: "accepted",
					},
				},
			})
			await journal.append({
				version: 1,
				eventId: "result",
				...ids,
				occurredAt: 2,
				type: "tool_result_recorded",
				payload: {
					item: { itemId: "result-item", type: "tool_result", toolCallId: "call-1", status: "error", output },
				},
			})
			await journal.writeSnapshot()
			await Promise.all([log.close(), journal.close()])

			const eventLogPath = path.join(storagePath, ids.taskId, GlobalFileNames.agentTurnEvents)
			for (const file of [eventLogPath, await journal.getEventsFilePath(), await journal.getSnapshotFilePath()]) {
				const persisted = await fs.readFile(file, "utf8")
				expect(persisted).not.toContain(credential)
				expect(persisted).toContain("[redacted]")
				expect(persisted).toContain("Verification failed with HTTP 401.")
			}

			const additive = await readAgentTurnEvents(ids.taskId, storagePath)
			const canonical = await readAgentLifecycleEvents(ids.taskId, storagePath)
			journal = await AgentLifecycleJournal.open(ids.taskId, storagePath)
			expect(JSON.stringify([additive, canonical, journal.getSnapshot()])).not.toContain(credential)
			expect(journal.getSnapshot()?.terminalToolCallIds).toEqual(["call-1"])
			expect(additive[0].event).toMatchObject({ status: "error", output: { exitCode: 1 } })
			expect(output.stdout).toContain(credential)
			expect(output.failure.message).toBe(header)
		},
	)
})
