import fs from "fs/promises"
import os from "os"
import path from "path"
import { execa } from "execa"

import type { Task } from "../../task/Task"
import { ToolRegistry } from "../ToolRegistry"
import { ToolScheduler, type ToolExecutionHost } from "../../agent/ToolScheduler"
import { createTaskToolSurface } from "../TaskToolSurface"
import { getNativeTools } from "../../prompts/tools/native-tools"
import { NativeToolCallParser } from "../../assistant-message/NativeToolCallParser"

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

	it.each(["code", "architect"] as const)(
		"recovers retained audited-command output through native artifact reads in %s",
		async (mode) => {
			const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-command-artifact-")))
			try {
				const root = path.join(directory, "workspace")
				const storage = path.join(directory, "storage")
				await fs.mkdir(path.join(root, "src"), { recursive: true })
				const marker = "artifact RETAINED_MIDDLE_MARKER"
				const source = Array.from({ length: 1_500 }, (_, index) =>
					index === 750 ? marker : `artifact row ${index}: retained command output`,
				).join("\n")
				await fs.writeFile(path.join(root, "src", "output.txt"), source)
				const state = {
					disabledTools: [] as string[],
					allowedCommands: [],
					deniedCommands: [],
					terminalOutputPreviewSize: "small" as const,
				}
				const provider = {
					getValues: () => state,
					context: { globalStorageUri: { fsPath: storage } },
					postMessageToWebview: vi.fn(),
				}
				let activeMode: "code" | "architect" = "code"
				const task = {
					taskId: "audited-command-artifact",
					taskKind: "primary",
					cwd: root,
					taskMode: activeMode,
					abort: false,
					getTaskMode: async () => activeMode,
					providerRef: { deref: () => provider },
					lastMessageTs: 1_000,
					clineMessages: [],
					consecutiveMistakeCount: 0,
					recordToolError: vi.fn(),
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
				const surface = () =>
					createTaskToolSurface({
						schemas: getNativeTools({ planMode: activeMode === "architect" }),
						mode: activeMode,
						cwd: root,
						disabledTools: state.disabledTools,
					})
				let sequence = 0
				const run = async (name: "exec_command" | "write_stdin", args: Record<string, unknown>) => {
					const id = `artifact-call-${++sequence}`
					const call = NativeToolCallParser.parseToolCall({ id, name, arguments: JSON.stringify(args) })
					expect(call?.type).toBe("tool_use")
					if (call?.type !== "tool_use") throw new Error("Native artifact workflow call failed to parse")
					const captured = surface()
					const outcome = await new ToolScheduler({
						executionHost: host,
						registry: captured.registry,
						policy: captured.policy,
						mode: activeMode,
						executionMode: "selective-parallel",
					}).run([{ type: "tool_call", id, name: call.name, arguments: call.nativeArgs }])
					expect(outcome.results).toHaveLength(1)
					return outcome.results[0]
				}

				const command = await run("exec_command", { cmd: "rg -n artifact src" })
				expect(command, JSON.stringify(command)).toMatchObject({ status: "success", exitCode: 0 })
				// Retained command output remains readable after the host switches to Plan.
				activeMode = mode
				Object.assign(task, { taskMode: mode })
				expect(task.recordCommandInspectionResult).toHaveBeenCalledOnce()
				const executionId = vi.mocked(task.recordCommandInspectionResult).mock.calls[0][0].executionId
				const artifactId = `cmd-${executionId}.txt`
				expect(executionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
				const artifactDirectory = path.join(storage, "tasks", task.taskId, "command-output")
				const retained = await fs.readFile(path.join(artifactDirectory, artifactId), "utf8")
				expect(retained).toContain(marker)
				expect(String(command.content)).not.toContain(marker)
				const guidance = String(command.content).match(/Read artifact (\S+) with (\w+) using (\{[^\n]*\})\./)
				expect.soft(guidance?.[1]).toBe(artifactId)
				expect.soft(guidance?.[2]).toBe("write_stdin")
				const args = guidance
					? (JSON.parse(guidance[3]) as Record<string, unknown>)
					: { artifact_id: artifactId }
				expect(args).toEqual({ artifact_id: artifactId })

				const search = await run("write_stdin", { ...args, search: marker, limit: 1_024 })
				expect(search).toMatchObject({ status: "success", content: expect.stringContaining(marker) })
				expect(Buffer.byteLength(String(search.content))).toBeLessThanOrEqual(1_024)
				const first = await run("write_stdin", { ...args, limit: 512 })
				expect(first).toMatchObject({ status: "success", content: expect.stringContaining("artifact row 0") })
				expect(first.content).not.toContain(marker)
				expect(Buffer.byteLength(String(first.content))).toBeLessThanOrEqual(512)
				const readUi = vi.mocked(task.say).mock.calls.at(-1)?.[1]
				const cursor = JSON.parse(String(readUi)).nextOffset as number
				expect(cursor).toBeGreaterThan(0)
				expect(cursor).toBeLessThan(Buffer.byteLength(retained))
				const next = await run("write_stdin", { ...args, offset: cursor, limit: 512 })
				expect(next.status).toBe("success")
				expect(Buffer.byteLength(String(next.content))).toBeLessThanOrEqual(512)
				expect(next.content).not.toEqual(first.content)
				const offset = Buffer.byteLength(retained.slice(0, retained.indexOf(marker)))
				const middle = await run("write_stdin", { ...args, offset, limit: 512 })
				expect(middle).toMatchObject({ status: "success", content: expect.stringContaining(marker) })

				const numericArtifactId = "cmd-1706119234567.txt"
				await fs.copyFile(
					path.join(artifactDirectory, artifactId),
					path.join(artifactDirectory, numericArtifactId),
				)
				const historical = await run("write_stdin", {
					artifact_id: numericArtifactId,
					search: marker,
					limit: 1_024,
				})
				expect(historical).toMatchObject({ status: "success", content: expect.stringContaining(marker) })
				expect(host.userMessageContent).toHaveLength(6)
				expect(host.userMessageContent.every((item) => item.type === "tool_result" && !item.is_error)).toBe(
					true,
				)
				expect(host.askApproval).toHaveBeenCalledTimes(1)

				const originalTaskId = task.taskId
				Object.assign(task, { taskId: "other-task" })
				const foreign = await run("write_stdin", args)
				expect(foreign).toMatchObject({
					status: "error",
					content: expect.stringContaining("Artifact not found"),
				})
				expect(foreign.content).not.toContain(marker)
				Object.assign(task, { taskId: originalTaskId })
				state.disabledTools = ["write_stdin"]
				const disabled = await run("write_stdin", args)
				expect(disabled.status).not.toBe("success")
				expect(disabled.content).not.toContain(marker)
			} finally {
				await fs.rm(directory, { recursive: true, force: true })
			}
		},
	)
})
