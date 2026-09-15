import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { checkAutoApproval } from "../../auto-approval"
import type { Task } from "../../task/Task"
import { ToolRegistry } from "../../tools/ToolRegistry"
import { writeToFileTool } from "../../tools/WriteToFileTool"
import { applyPatchTool } from "../../tools/ApplyPatchTool"
import { createToolPolicySnapshot } from "../ToolPolicy"
import { ToolScheduler, type ToolExecutionHost } from "../ToolScheduler"

describe("outside workspace execution", () => {
	let directory: string
	let cwd: string
	let outside: string
	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-outside-access-"))
		cwd = path.join(directory, "workspace")
		outside = path.join(directory, "outside")
		await fs.mkdir(cwd)
		await fs.mkdir(outside)
	})
	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(directory, { recursive: true, force: true })
	})

	function harness(name: string, args: Record<string, unknown>, allowOutside = true, humanApproves = true) {
		const prompt = vi.fn(async () => humanApproves)
		const provider = {
			getState: async () => ({}),
			runWorkspaceMutation: async (_task: unknown, _label: string, run: () => Promise<void>) => run(),
			reservePrimaryMutation: vi.fn(),
			releasePrimaryMutation: vi.fn(),
			recordPrimaryMutation: vi.fn(async () => true),
		}
		const host: ToolExecutionHost = {
			taskId: "outside-access",
			cwd,
			userMessageContent: [],
			say: vi.fn(),
			recordToolUsage: vi.fn(),
			askApproval: vi.fn<NonNullable<ToolExecutionHost["askApproval"]>>(
				async (ask, text, _progress, isProtected, requiresExplicitApproval) => {
					const result = await checkAutoApproval({
						ask,
						text,
						isProtected,
						requiresExplicitApproval,
						state: {
							autoApprovalEnabled: true,
							alwaysAllowReadOnly: true,
							alwaysAllowReadOnlyOutsideWorkspace: true,
							alwaysAllowWrite: true,
							alwaysAllowWriteOutsideWorkspace: true,
							alwaysAllowExecute: true,
							allowedCommands: ["*"],
						},
					})
					return {
						response:
							result.decision === "approve" || (result.decision === "ask" && (await prompt()))
								? "yesButtonClicked"
								: "noButtonClicked",
					}
				},
			),
			pushToolResultToUserContent(result) {
				this.userMessageContent.push(result)
				return true
			},
		}
		host.taskFacade = Object.assign({}, host, {
			taskKind: "primary",
			providerRef: { deref: () => provider },
			checkpointSave: vi.fn(),
		}) as unknown as Task
		const policy = createToolPolicySnapshot({
			visibleTools: [name],
			execution: {
				workspaceRoots: [cwd],
				...(allowOutside ? { outsideWorkspace: "approval" as const } : {}),
			},
		})
		const call = { type: "tool_call" as const, id: "call", name, arguments: args }
		const run = (registry: ToolRegistry) =>
			new ToolScheduler({
				executionHost: host,
				registry,
				policy: createToolPolicySnapshot({
					...policy,
					autoApprovalEnabled: true,
					capabilities: { [name]: registry.resolve(name)!.capabilities },
				}),
				mode: "code",
				validateCall: () => {},
				readGrant: { enabled: true, workspaceRoot: cwd, showIgnoredFiles: false },
			}).run({
				items: [call],
				toolCalls: [call],
				text: "",
				reasoning: "",
			})
		return { host, prompt, provider, run }
	}

	it("falls back to the approved native listing path outside the parallel read grant", async () => {
		await fs.writeFile(path.join(outside, "code.ts"), "export const outside = true")
		const fixture = harness("list_files", { path: "../outside" })
		const outcome = await fixture.run(new ToolRegistry())
		expect(outcome.results[0].status).toBe("success")
		expect(outcome.results[0].content).toContain("code.ts")
		expect(fixture.prompt).not.toHaveBeenCalled()
	})

	function inspection(name: string, execute: () => Promise<void> = async () => {}) {
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register({
			name,
			aliases: [],
			schema: { type: "function", function: { name, parameters: { type: "object" } } },
			capabilities: { concurrency: "serial", sideEffects: "none", requiresApproval: true, controlFlow: false },
			execute: async ({ callbacks }) => {
				if (
					await callbacks.askApproval(
						name === "execute_command" ? "command" : "tool",
						name === "execute_command"
							? "node script.js"
							: JSON.stringify({ tool: "readFile", isOutsideWorkspace: true }),
					)
				) {
					await execute()
					callbacks.pushToolResult("inspected")
				}
			},
		})
		return registry
	}

	it.each(["read_file", "list_files", "search_files"])(
		"admits %s outside the root through existing read approvals",
		async (name) => {
			const args =
				name === "read_file"
					? { files: [{ path: "../outside/code.ts" }] }
					: name === "search_files"
						? { queries: [{ path: "../outside", regex: "code" }] }
						: { path: "../outside" }
			const allowed = harness(name, args)
			expect((await allowed.run(inspection(name))).results[0].status).toBe("success")
			expect(allowed.prompt).not.toHaveBeenCalled()
			const restricted = harness(name, args, false)
			expect((await restricted.run(inspection(name))).results[0].status).toBe("error")
			expect(restricted.host.askApproval).not.toHaveBeenCalled()
		},
	)

	it.each([undefined, "../outside"])(
		"requires explicit approval for a host command with cwd %s",
		async (commandCwd) => {
			const fixture = harness("execute_command", { command: "node script.js", cwd: commandCwd }, true, false)
			const effect = vi.fn()
			expect((await fixture.run(inspection("execute_command", effect))).results[0].status).toBe("denied")
			expect(fixture.prompt).toHaveBeenCalledOnce()
			expect(effect).not.toHaveBeenCalled()
		},
	)

	it.each([true, false])(
		"runs an external write only after the human decision %s and excludes it from workspace receipts",
		async (approve) => {
			const target = path.join(outside, "file.txt")
			await fs.writeFile(target, "original")
			const fixture = harness("write_to_file", { path: target, content: "changed" }, true, approve)
			vi.spyOn(writeToFileTool, "handle").mockImplementation(async (_task, _call, callbacks) => {
				// The scheduler must enforce the boundary even if a tool omits its presentation flag.
				if (await callbacks.askApproval("tool", JSON.stringify({ tool: "editedExistingFile" }))) {
					await fs.writeFile(target, "changed")
					callbacks.pushToolResult("written")
				}
			})
			expect((await fixture.run(new ToolRegistry())).results[0].status).toBe(approve ? "success" : "denied")
			expect(fixture.prompt).toHaveBeenCalledOnce()
			expect(await fs.readFile(target, "utf8")).toBe(approve ? "changed" : "original")
			expect(fixture.provider.reservePrimaryMutation).not.toHaveBeenCalled()
			expect(fixture.provider.recordPrimaryMutation).not.toHaveBeenCalled()
		},
	)

	it("keeps workspace mutation receipts for the in-workspace portion of a mixed patch", async () => {
		const fixture = harness("apply_patch", {
			patch: "*** Begin Patch\n*** Add File: local.txt\n+local\n*** Add File: ../outside/other.txt\n+other\n*** End Patch",
		})
		vi.spyOn(applyPatchTool, "handle").mockImplementation(async (_task, _call, callbacks) => {
			if (await callbacks.askApproval("tool", JSON.stringify({ tool: "appliedDiff" }))) {
				await fs.writeFile(path.join(cwd, "local.txt"), "local")
				await fs.writeFile(path.join(outside, "other.txt"), "other")
				callbacks.pushToolResult("written")
			}
		})
		expect((await fixture.run(new ToolRegistry())).results[0].status).toBe("success")
		expect(fixture.prompt).toHaveBeenCalledOnce()
		expect(fixture.provider.recordPrimaryMutation).toHaveBeenCalledWith(
			expect.anything(),
			{ "local.txt": expect.stringMatching(/^[a-f0-9]{64}$/) },
			false,
			"call",
		)
	})

	it("rejects patch move destinations outside a restricted root before execution", async () => {
		const fixture = harness(
			"apply_patch",
			{
				patch: "*** Begin Patch\n*** Update File: local.txt\n*** Move to: ../outside/moved.txt\n@@\n-old\n+new\n*** End Patch",
			},
			false,
		)
		const result = await fixture.run(inspection("apply_patch"))
		expect(result.results[0].status).toBe("error")
		expect(result.results[0].content).toContain("outside the allowed workspace roots")
		expect(fixture.host.askApproval).not.toHaveBeenCalled()
	})

	it("requires approval for an outward junction and rejects a retargeted junction during approval", async () => {
		const link = path.join(cwd, "linked")
		await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir")
		const fixture = harness("write_to_file", { path: "linked/file.txt", content: "changed" })
		const effect = vi.fn()
		vi.spyOn(writeToFileTool, "handle").mockImplementation(async (_task, _call, callbacks) => {
			if (await callbacks.askApproval("tool", JSON.stringify({ tool: "newFileCreated" }))) effect()
		})
		fixture.prompt.mockImplementation(async () => {
			await fs.unlink(link)
			await fs.symlink(cwd, link, process.platform === "win32" ? "junction" : "dir")
			return true
		})
		expect((await fixture.run(new ToolRegistry())).results[0].status).toBe("denied")
		expect(fixture.prompt).toHaveBeenCalledOnce()
		expect(effect).not.toHaveBeenCalled()
	})
})
