import fs from "fs/promises"
import os from "os"
import path from "path"
import { execa } from "execa"

import type { Task } from "../../task/Task"
import { ToolRegistry } from "../ToolRegistry"
import { ToolScheduler, type ToolExecutionHost } from "../../agent/ToolScheduler"
import { createTaskToolSurface } from "../TaskToolSurface"

describe("command reads through the built-in registry and real subprocesses", () => {
	it("returns four real rg inspections in order with four individual approvals", async () => {
		const check = await execa("rg", ["--version"], { reject: false })
		if (check.failed) throw new Error("This host integration test requires rg on PATH")
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-real-command-batch-")))
		try {
			await fs.mkdir(path.join(root, "src"))
			await fs.writeFile(path.join(root, "src", "sample.txt"), "needle one\nneedle two\n")
			const state = { disabledTools: [], allowedCommands: [], deniedCommands: [] }
			const provider = { getValues: () => state, context: {}, postMessageToWebview: vi.fn() }
			const task = {
				taskId: "real-command-batch",
				taskKind: "primary",
				cwd: root,
				taskMode: "code",
				abort: false,
				getTaskMode: async () => "code",
				providerRef: { deref: () => provider },
				lastMessageTs: 1000,
				clineMessages: [],
				recordCommandInspectionResult: vi.fn(),
				say: vi.fn(),
			} as unknown as Task
			const host: ToolExecutionHost = {
				taskId: task.taskId,
				cwd: root,
				taskFacade: task,
				userMessageContent: [],
				say: async () => {},
				recordToolUsage: vi.fn(),
				askApproval: vi.fn(async () => {
					task.lastMessageTs = (task.lastMessageTs ?? 0) + 1
					task.clineMessages.push({ ts: task.lastMessageTs, type: "ask", ask: "command" })
					return { response: "yesButtonClicked" as const }
				}),
				pushToolResultToUserContent(result) {
					host.userMessageContent.push(result)
					return true
				},
			}
			const surface = createTaskToolSurface({ registry: new ToolRegistry(), mode: "code", cwd: root })
			const outcome = await new ToolScheduler({
				executionHost: host,
				registry: surface.registry,
				policy: surface.policy,
				mode: "code",
				executionMode: "selective-parallel",
			}).run(
				["rg --files src", "rg -n one src", "rg -n two src", "rg -l needle src"].map((command, index) => ({
					type: "tool_call" as const,
					id: `read-${index}`,
					name: "execute_command",
					arguments: { command },
				})),
			)
			expect(outcome.results.map(({ status, exitCode }) => [status, exitCode])).toEqual(
				Array.from({ length: 4 }, () => ["success", 0]),
			)
			expect(outcome.results.map(({ callId }) => callId)).toEqual(["read-0", "read-1", "read-2", "read-3"])
			expect(host.askApproval).toHaveBeenCalledTimes(4)
			expect(task.recordCommandInspectionResult).toHaveBeenCalledTimes(4)
			expect(vi.mocked(task.say).mock.calls.map((args) => args[6]?.commandExecutionId)).toEqual([
				"1001",
				"1002",
				"1003",
				"1004",
			])
			expect(await fs.readFile(path.join(root, "src", "sample.txt"), "utf8")).toBe("needle one\nneedle two\n")
		} finally {
			await fs.rm(root, { recursive: true, force: true })
		}
	})
})
