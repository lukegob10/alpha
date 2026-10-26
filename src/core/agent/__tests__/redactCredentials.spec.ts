import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: async (globalStoragePath: string, taskId: string) => {
		const taskDirectory = path.join(globalStoragePath, taskId)
		await fs.mkdir(taskDirectory, { recursive: true })
		return taskDirectory
	},
}))

import { GlobalFileNames } from "../../../shared/globalFileNames"
import { AgentTurnEventLog } from "../AgentTurnEventLog"
import { AgentLifecycleJournal } from "../lifecycle/AgentLifecycleJournal"
import { redactAgentCredentialText } from "../redactCredentials"

describe("redactAgentCredentialText", () => {
	it.each(["password", "api_key", "client_secret", "refresh_token"])("redacts the quoted JSON key %s", (key) => {
		const text = JSON.stringify({ [key]: "private-value", count: 3 })
		const redacted = redactAgentCredentialText(text)
		expect(redacted).not.toContain("private-value")
		expect(redacted).toContain("[redacted]")
		expect(redacted).toContain('"count":3')
	})

	it.each(["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY", "githubAccessToken"])(
		"redacts the complete credential identifier %s in diagnostic text",
		(key) => {
			for (const text of [
				JSON.stringify({ [key]: "private-value", count: 3 }),
				`${key}=private-value; count=3`,
			]) {
				const redacted = redactAgentCredentialText(text)
				expect(redacted).not.toContain("private-value")
				expect(redacted).toContain(`${key}`)
				expect(redacted).toContain("[redacted]")
				expect(redacted).toContain(text.startsWith("{") ? '"count":3' : "count=3")
			}
		},
	)

	it("redacts prefixed authorization fields with their complete authentication parameters", () => {
		const redacted = redactAgentCredentialText(
			JSON.stringify({ HTTP_AUTHORIZATION: "Digest username=private-user, response=private-response", count: 3 }),
		)
		expect(redacted).not.toMatch(/private-user|private-response/)
		expect(redacted).toContain("HTTP_AUTHORIZATION")
		expect(redacted).toContain("[redacted]")
		expect(redacted).toContain('"count":3')
	})

	it.each([`"private\\\"value"`, `'private\\'value'`])("redacts the complete escaped value %s", (value) => {
		expect(redactAgentCredentialText(`password=${value}; count=3`)).toBe("password=[redacted]; count=3")
	})

	it("keeps unquoted fields and ordinary diagnostic text compatible", () => {
		expect(redactAgentCredentialText("password=private-value; count=3")).toBe("password=[redacted]; count=3")
		expect(redactAgentCredentialText("Task completed with count=3")).toBe("Task completed with count=3")
	})
})

describe("credential strings in persisted agent events", () => {
	let storagePath: string | undefined

	afterEach(async () => {
		if (storagePath) await fs.rm(storagePath, { recursive: true, force: true })
	})

	it("redacts JSON credential fields before either event journal persists them", async () => {
		storagePath = await fs.mkdtemp(path.join(os.tmpdir(), "agent-credential-redaction-"))
		const taskId = "task-redaction"
		const text = [
			JSON.stringify({
				password: "private-password",
				api_key: "private-api-key",
				OPENAI_API_KEY: "private-provider-key",
				githubAccessToken: "private-prefixed-token",
				HTTP_AUTHORIZATION: "Basic private-authorization",
				count: 3,
			}),
			"ANTHROPIC_API_KEY=private-env-key",
		].join("\n")
		const log = new AgentTurnEventLog(taskId, storagePath)
		const journal = new AgentLifecycleJournal(taskId, storagePath)
		try {
			await log.append({ type: "progress", text })
			await journal.append({
				version: 1,
				eventId: "failure",
				taskId,
				runId: "run-redaction",
				turnId: "turn-redaction",
				occurredAt: 1,
				type: "turn_failed",
				payload: { status: "failed", error: text },
			})
			await log.flush()
			for (const file of [
				path.join(storagePath, taskId, GlobalFileNames.agentTurnEvents),
				await journal.getEventsFilePath(),
			]) {
				const contents = await fs.readFile(file, "utf8")
				expect(contents).not.toMatch(
					/private-password|private-api-key|private-provider-key|private-prefixed-token|private-authorization|private-env-key/,
				)
				expect(contents).toContain("[redacted]")
			}
		} finally {
			await log.close()
			await journal.close()
		}
	})
})
