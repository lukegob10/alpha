import * as fs from "fs/promises"
import * as path from "path"
import { tmpdir } from "os"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ToolApprovalDecision, ToolApprovalRequest } from "@alpha-code/types"
import type { Task } from "../../task/Task"
import { AskIgnoredError } from "../../task/AskIgnoredError"
import { formatResponse } from "../../prompts/responses"
import { unescapeHtmlEntities } from "../../../utils/text-normalization"
import { ApplyPatchTool } from "../../tools/ApplyPatchTool"
import { readFileTool } from "../../tools/ReadFileTool"
import { ToolReadDeniedError } from "../../tools/BaseTool"
import { ToolRegistry, type ToolDescriptor } from "../../tools/ToolRegistry"
import { collectAgentResponse } from "../AgentResponseAccumulator"
import { AgentTurnEventLog, readAgentTurnEvents } from "../AgentTurnEventLog"
import type { AgentTurnEvent } from "../AgentTurnEvents"
import { ToolScheduler } from "../ToolScheduler"
import { createToolPolicySnapshot } from "../ToolPolicy"

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}

function makeTask() {
	const userMessageContent: any[] = []
	const task = {
		abort: false,
		taskId: "scheduler-test",
		didRejectTool: false,
		didToolFailInCurrentTurn: false,
		userMessageContent,
		userMessageContentReady: false,
		ask: async () => ({ response: "yesButtonClicked" }),
		say: async () => {},
		recordToolUsage: () => {},
		pushToolResultToUserContent(result: any) {
			if (
				userMessageContent.some(
					(item) => item.type === "tool_result" && item.tool_use_id === result.tool_use_id,
				)
			) {
				return false
			}
			userMessageContent.push(result)
			return true
		},
	} as unknown as Task

	return task
}

function descriptor(
	name: string,
	concurrency: ToolDescriptor["capabilities"]["concurrency"],
	execute: ToolDescriptor["execute"],
): ToolDescriptor {
	return {
		name,
		aliases: [],
		schema: {
			type: "function",
			function: {
				name,
				description: name,
				parameters: { type: "object", properties: {}, additionalProperties: false },
			},
		},
		capabilities: {
			concurrency,
			sideEffects: concurrency === "parallel" ? "none" : "task",
			controlFlow: concurrency === "barrier",
			requiresApproval: false,
		},
		getConcurrencyScope: (call) => path.resolve(tmpdir(), "scheduler-fixture", call.id ?? name),
		execute,
	}
}

function mcpDescriptor(name: string, execute: ToolDescriptor["execute"], parallelMcpRead = false): ToolDescriptor {
	return {
		...descriptor(name, "serial", execute),
		capabilities: {
			concurrency: "serial",
			sideEffects: "external",
			controlFlow: false,
			requiresApproval: true,
			...(parallelMcpRead ? { parallelMcpRead: true } : {}),
		},
	}
}

function response(...calls: Array<{ id: string; name: string; arguments?: Record<string, unknown> }>) {
	return {
		items: calls.map((call) => ({ type: "tool_call" as const, ...call, arguments: call.arguments ?? {} })),
		text: "",
		reasoning: "",
		toolCalls: calls.map((call) => ({ type: "tool_call" as const, ...call, arguments: call.arguments ?? {} })),
	}
}

function resultIds(task: Task): string[] {
	return (task.userMessageContent as any[])
		.filter((item) => item.type === "tool_result")
		.map((item) => item.tool_use_id)
}

describe("ToolScheduler", () => {
	describe("packaged skill reference reads", () => {
		let fixture: string
		let extension: string
		let reference: string
		let task: Task
		let registry: ToolRegistry
		let execute: ReturnType<typeof vi.fn>

		beforeEach(async () => {
			fixture = await fs.mkdtemp(path.join(tmpdir(), "alpha-bundled-read-"))
			extension = path.join(fixture, "extension")
			reference = path.join(extension, "webview-ui/build/artifact-kit/v1/reference.md")
			await fs.mkdir(path.dirname(reference), { recursive: true })
			await fs.writeFile(reference, "Packaged authoring reference")
			task = makeTask()
			Object.assign(task, { cwd: path.join(fixture, "workspace") })
			registry = new ToolRegistry({ includeBuiltIns: false })
			execute = vi.fn(async ({ callbacks }) => {
				if (await callbacks.askApproval("tool", "read resource")) callbacks.pushToolResult("Resource read")
			})
			for (const name of ["read_file", "write_to_file", "list_files", "search_files"]) {
				registry.register(descriptor(name, "serial", execute))
			}
		})

		afterEach(async () => {
			await fs.rm(fixture, { recursive: true, force: true })
		})

		const run = async (
			name: string,
			args: Record<string, unknown>,
			extensionPath: string | undefined = extension,
			disabled = false,
		) => {
			return new ToolScheduler({
				task,
				registry,
				mode: "code",
				bundledSkillExtensionPath: extensionPath,
				policy: createToolPolicySnapshot({
					visibleTools: [name],
					disabledTools: disabled ? [name] : [],
					execution: { workspaceRoots: [task.cwd] },
				}),
				validateCall: () => {},
			}).run(response({ id: "resource", name, arguments: args }))
		}

		it("admits the installed reference through normal read approval without widening workspace roots", async () => {
			const ask = vi.fn(async () => ({ response: "yesButtonClicked" as const }))
			task.ask = ask
			const outcome = await run("read_file", { path: reference })
			expect(outcome.results[0].status).toBe("success")
			expect(ask).toHaveBeenCalledTimes(1)
			expect(execute).toHaveBeenCalledTimes(1)
		})

		it.each(["review", "spec", "report"])("admits only the installed %s example", async (example) => {
			const file = path.join(path.dirname(reference), "examples", `${example}.html`)
			await fs.mkdir(path.dirname(file), { recursive: true })
			await fs.writeFile(file, "Example")
			expect((await run("read_file", { files: [{ path: file }] })).results[0].status).toBe("success")
		})

		it("preserves denied approval and disabled-tool policy", async () => {
			task.ask = vi.fn(async () => ({ response: "noButtonClicked" })) as Task["ask"]
			expect((await run("read_file", { path: reference })).results[0].status).toBe("denied")
			execute.mockClear()
			expect((await run("read_file", { path: reference }, extension, true)).results[0].status).toBe("error")
			expect(execute).not.toHaveBeenCalled()
		})

		it.each(["write_to_file", "list_files", "search_files"])(
			"does not admit %s on an otherwise known resource",
			async (name) => {
				expect((await run(name, { path: reference })).results[0].status).toBe("error")
				expect(execute).not.toHaveBeenCalled()
			},
		)

		it("rejects arbitrary bundled files, traversal, mixed reads, and missing trusted installation", async () => {
			for (const candidate of [
				path.join(extension, "package.json"),
				`${path.dirname(reference)}${path.sep}examples${path.sep}..${path.sep}reference.md`,
			]) {
				expect((await run("read_file", { path: candidate })).results[0].status).toBe("error")
			}
			expect(
				(await run("read_file", { files: [{ path: reference }, { path: path.join(fixture, "secret") }] }))
					.results[0].status,
			).toBe("error")
			expect((await run("read_file", { path: reference }, "")).results[0].status).toBe("error")
			expect(execute).not.toHaveBeenCalled()
		})

		it("rejects a known example path when its parent directory is a symlink outside the bundle", async () => {
			const outside = path.join(fixture, "outside")
			await fs.mkdir(outside)
			await fs.writeFile(path.join(outside, "review.html"), "Private content")
			await fs.symlink(
				outside,
				path.join(path.dirname(reference), "examples"),
				process.platform === "win32" ? "junction" : "dir",
			)
			expect(
				(await run("read_file", { path: path.join(path.dirname(reference), "examples/review.html") }))
					.results[0].status,
			).toBe("error")
			expect(execute).not.toHaveBeenCalled()
		})
	})

	it("commits MCP validation failures as error receipts in provider history", async () => {
		const task = makeTask()
		Object.assign(task, {
			consecutiveMistakeCount: 0,
			recordToolError: () => {},
			lastMessageTs: 1,
			providerRef: {
				deref: () => ({ getMcpHub: () => undefined, postMessageToWebview: async () => {} }),
			},
		})
		const registry = new ToolRegistry({
			nativeTools: [],
			mcpTools: [descriptor("mcp--missing--lookup", "serial", async () => {}).schema],
		})

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(
			response({
				id: "mcp-missing-hub",
				name: "mcp--missing--lookup",
			}),
		)

		expect(outcome.results[0].status).toBe("error")
		expect(task.userMessageContent).toContainEqual(
			expect.objectContaining({ type: "tool_result", tool_use_id: "mcp-missing-hub", is_error: true }),
		)
	})

	it("keeps MCP cancellation authoritative in scheduler status and provider history", async () => {
		const task = makeTask()
		const controller = new AbortController()
		const statuses: string[] = []
		let requestStarted!: () => void
		const started = new Promise<void>((resolve) => {
			requestStarted = resolve
		})
		Object.assign(task, {
			consecutiveMistakeCount: 0,
			recordToolError: () => {},
			lastMessageTs: 1,
			providerRef: {
				deref: () => ({
					getMcpHub: () => ({
						getAllServers: () => [{ name: "server", tools: [{ name: "lookup", description: "lookup" }] }],
						callTool: (...args: unknown[]) => {
							const signal = args[4] as AbortSignal
							requestStarted()
							return new Promise<never>((_, reject) => {
								signal.addEventListener("abort", () => reject(signal.reason), { once: true })
							})
						},
					}),
					postMessageToWebview: async (message: { text?: string }) => {
						if (message.text) statuses.push(JSON.parse(message.text).status)
					},
				}),
			},
		})
		const registry = new ToolRegistry({
			nativeTools: [],
			mcpTools: [descriptor("mcp--server--lookup", "serial", async () => {}).schema],
		})
		const run = new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
			signal: controller.signal,
			preserveAbortedResults: true,
		}).run(
			response({
				id: "mcp-cancelled",
				name: "mcp--server--lookup",
			}),
		)

		await started
		controller.abort(new Error("cancelled"))
		const outcome = await run
		expect(outcome.results[0].status).toBe("cancelled")
		expect(statuses).toEqual(["started", "error"])
		expect(task.userMessageContent).toContainEqual(
			expect.objectContaining({ type: "tool_result", tool_use_id: "mcp-cancelled", is_error: true }),
		)
	})

	it("publishes an unavailable write_stdin session as an error history receipt", async () => {
		const task = makeTask() as any
		task.consecutiveMistakeCount = 0
		task.recordToolError = vi.fn()
		task.say = vi.fn().mockResolvedValue(undefined)
		task.providerRef = { deref: vi.fn() }
		const outcome = await new ToolScheduler({
			task,
			registry: new ToolRegistry(),
			mode: "code",
			validateCall: () => {},
			policy: createToolPolicySnapshot({ visibleTools: ["write_stdin"] }),
		}).run(
			response({
				id: "missing-session",
				name: "write_stdin",
				arguments: { session_id: 999 },
			}),
		)

		expect(outcome.results).toHaveLength(1)
		expect(outcome.results[0]).toMatchObject({ name: "write_stdin", status: "error" })
		expect(task.didToolFailInCurrentTurn).toBe(true)
		expect(task.userMessageContent).toContainEqual(
			expect.objectContaining({ tool_use_id: "missing-session", is_error: true }),
		)
	})

	it("retains earlier truthful receipts when a later read preflight rejects", async () => {
		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		const effects: string[] = []
		registry.register(
			descriptor("mutation", "serial", async ({ callbacks }) => {
				effects.push("mutation")
				callbacks.pushToolResult("already completed")
			}),
		)
		registry.register({
			...descriptor("read", "parallel", async () => {
				effects.push("unexpected")
			}),
			prepareParallelRead: async () => {
				throw new Error("state unavailable")
			},
		})
		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
			executionMode: "selective-parallel",
			policy: createToolPolicySnapshot({ visibleTools: ["mutation", "read"] }),
			readGrant: { enabled: true, workspaceRoot: tmpdir(), showIgnoredFiles: false },
		}).run(response({ id: "one", name: "mutation" }, { id: "two", name: "read" }))
		expect(effects).toEqual(["mutation"])
		expect(outcome.results.map(({ status, content }) => [status, content])).toEqual([
			["success", "already completed"],
			["error", expect.stringContaining("state unavailable")],
		])
		expect(resultIds(task)).toEqual(["one", "two"])
	})

	it("serializes overlapping and unknown scopes even when metadata claims parallel safety", async () => {
		for (const scope of [undefined, path.resolve(tmpdir(), "shared-scope")]) {
			const task = makeTask()
			const registry = new ToolRegistry({ includeBuiltIns: false })
			let active = 0
			let peak = 0
			registry.register({
				...descriptor("read", "parallel", async ({ callbacks }) => {
					active++
					peak = Math.max(peak, active)
					await Promise.resolve()
					callbacks.pushToolResult("read")
					active--
				}),
				getConcurrencyScope: () => scope,
			})
			await new ToolScheduler({
				task,
				registry,
				mode: "code",
				executionMode: "selective-parallel",
				validateCall: () => {},
			}).run(response({ id: "one", name: "read" }, { id: "two", name: "read" }))
			expect(peak).toBe(1)
		}
	})

	it.each([
		[
			"a serial descriptor",
			{
				concurrency: "serial" as const,
				sideEffects: "none" as const,
				controlFlow: false,
				requiresApproval: true,
			},
			undefined,
		],
		[
			"a captured serial policy",
			{
				concurrency: "parallel" as const,
				sideEffects: "none" as const,
				controlFlow: false,
				requiresApproval: true,
			},
			{
				concurrency: "serial" as const,
				sideEffects: "none" as const,
				controlFlow: false,
				requiresApproval: true,
			},
		],
	] as const)(
		"does not bypass %s with an audited parallel-read executor",
		async (_description, capabilities, policyCapabilities) => {
			const task = makeTask()
			const registry = new ToolRegistry({ includeBuiltIns: false })
			const execute = vi.fn(async ({ callbacks }: Parameters<ToolDescriptor["execute"]>[0]) => {
				callbacks.pushToolResult("legacy")
			})
			const prepareParallelRead = vi.fn(async () => ({
				scope: path.resolve(tmpdir(), "audited-read"),
				run: async () => async () => "prepared",
			}))
			registry.register({
				...descriptor("read", "parallel", execute),
				capabilities,
				prepareParallelRead,
			})
			const outcome = await new ToolScheduler({
				task,
				registry,
				mode: "code",
				executionMode: "selective-parallel",
				validateCall: () => {},
				policy: createToolPolicySnapshot({
					visibleTools: ["read"],
					autoApprovalEnabled: true,
					capabilities: policyCapabilities ? { read: policyCapabilities } : undefined,
				}),
				readGrant: { enabled: true, workspaceRoot: tmpdir(), showIgnoredFiles: false },
			}).run(response({ id: "read", name: "read" }))

			expect(prepareParallelRead).not.toHaveBeenCalled()
			expect(execute).toHaveBeenCalledOnce()
			expect(outcome.results[0]).toMatchObject({ status: "success", content: "legacy" })
		},
	)

	it("closes a lifecycle-rejected apply_patch mutation as denied without touching the workspace", async () => {
		const workspace = await fs.mkdtemp(path.join(tmpdir(), "alpha-lifecycle-rejected-patch-"))
		const target = path.join(workspace, "fixture.txt")
		const task = makeTask()
		const checkpointSave = vi.fn()
		Object.assign(task, {
			cwd: workspace,
			canMutateWorkspace: () => false,
			checkpointSave,
			providerRef: { deref: () => undefined },
		})
		const registry = new ToolRegistry()
		expect(registry.resolve("apply_patch")).toBeDefined()

		try {
			const outcome = await new ToolScheduler({
				task,
				registry,
				mode: "code",
				validateCall: () => {},
				policy: createToolPolicySnapshot({ visibleTools: ["apply_patch"] }),
			}).run(
				response({
					id: "late-patch",
					name: "apply_patch",
					arguments: {
						patch: "*** Begin Patch\n*** Add File: fixture.txt\n+must not write\n*** End Patch",
					},
				}),
			)

			expect(outcome.results[0]).toMatchObject({ name: "apply_patch", status: "denied" })
			expect(JSON.parse(String(outcome.results[0].content))).toMatchObject({ status: "denied" })
			expect(resultIds(task)).toEqual(["late-patch"])
			expect(checkpointSave).not.toHaveBeenCalled()
			await expect(fs.access(target)).rejects.toThrow()
		} finally {
			await fs.rm(workspace, { recursive: true, force: true })
		}
	})

	it.each([
		{ id: 42, name: "read" },
		{ id: "malformed-name", name: 42 },
	] as const)("turns malformed runtime call fields into one terminal error", async (call) => {
		const task = makeTask()
		const execute = vi.fn(async ({ callbacks }: Parameters<ToolDescriptor["execute"]>[0]) => {
			callbacks.pushToolResult("must not execute")
		})
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(descriptor("read", "serial", execute))
		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run([call as never])

		expect(outcome.results[0].status).toBe("error")
		expect(execute).not.toHaveBeenCalled()
		expect(resultIds(task)).toHaveLength(1)
	})

	it.each([
		["read_file", { path: "inside.txt", files: [{ path: "../outside.txt" }] }],
		["search_files", { queries: [{ path: "../outside", regex: "secret" }] }],
		["generate_image", { prompt: "fixture", path: "inside.png", image: "../outside.png" }],
		["generate_image", { prompt: "fixture", path: process.cwd() }],
	] as const)("rejects an out-of-policy nested path in %s before dispatch", async (name, argumentsValue) => {
		const task = makeTask()
		const execute = vi.fn(async ({ callbacks }: Parameters<ToolDescriptor["execute"]>[0]) => {
			callbacks.pushToolResult("must not execute")
		})
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(descriptor(name, "serial", execute))
		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
			policy: createToolPolicySnapshot({
				visibleTools: [name],
				execution: { workspaceRoots: [process.cwd()] },
			}),
		}).run(response({ id: `nested-${name}`, name, arguments: argumentsValue }))

		expect(outcome.results[0].status).toBe("error")
		expect(String(outcome.results[0].content)).toContain("outside the allowed workspace roots")
		expect(execute).not.toHaveBeenCalled()
	})

	it("executes remapped worker file tools against the private worktree only", async () => {
		const tempRoot = await fs.mkdtemp(path.join(tmpdir(), "alpha-worker-sched-"))
		try {
			const logicalWorkspace = path.join(tempRoot, "workspace")
			const worktree = path.join(tempRoot, "worktree")
			await fs.mkdir(path.join(logicalWorkspace, "src", "nested"), { recursive: true })
			await fs.mkdir(path.join(worktree, "src", "nested"), { recursive: true })
			await fs.writeFile(path.join(logicalWorkspace, "src", "nested", "read.ts"), "parent-read")
			await fs.writeFile(path.join(worktree, "src", "nested", "read.ts"), "worktree-read")
			const resolveNativePath = (cwd: string, candidate: string) =>
				path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(cwd, candidate)
			const execute = vi.fn(async ({ call, callbacks }: Parameters<ToolDescriptor["execute"]>[0]) => {
				const args = (call.nativeArgs ?? {}) as Record<string, unknown>
				if (call.name === "write_to_file" && typeof args.path === "string") {
					const dest = resolveNativePath(worktree, args.path)
					await fs.mkdir(path.dirname(dest), { recursive: true })
					await fs.writeFile(dest, String(args.content ?? ""))
					callbacks.pushToolResult("written")
					return
				}
				if (call.name === "read_file" && Array.isArray(args.files)) {
					const nested = args.files[0] as { path?: string } | undefined
					if (typeof nested?.path !== "string") throw new Error("nested read path missing")
					callbacks.pushToolResult(await fs.readFile(resolveNativePath(worktree, nested.path), "utf8"))
					return
				}
				if (call.name === "apply_patch" && typeof args.patch === "string") {
					const match = args.patch.match(/^\*\*\* Add File: (.+)$/m)
					if (!match?.[1]) throw new Error("patch destination missing")
					const dest = resolveNativePath(worktree, match[1])
					await fs.mkdir(path.dirname(dest), { recursive: true })
					await fs.writeFile(dest, "patched")
					callbacks.pushToolResult("patched")
					return
				}
				if (call.name === "shell") {
					callbacks.pushToolResult("must not execute parent shell writes")
					return
				}
				callbacks.pushToolResult("ok")
			})
			const task = Object.assign(makeTask(), {
				taskKind: "subagent",
				subagentRole: "worker",
				cwd: worktree,
				historyWorkspacePath: logicalWorkspace,
			}) as Task
			const registry = new ToolRegistry({ includeBuiltIns: false })
			for (const name of ["write_to_file", "read_file", "apply_patch", "shell"]) {
				registry.register(descriptor(name, "serial", execute))
			}
			const scheduler = new ToolScheduler({
				task,
				registry,
				mode: "code",
				validateCall: () => {},
				policy: createToolPolicySnapshot({
					visibleTools: ["write_to_file", "read_file", "apply_patch", "shell"],
					execution: { workspaceRoots: [worktree] },
				}),
			})
			const logicalWrite = path.join(logicalWorkspace, "src", "nested", "foo.ts")
			const written = await scheduler.run(
				response({
					id: "logical-write",
					name: "write_to_file",
					arguments: { path: logicalWrite, content: "worktree-only" },
				}),
			)
			expect(written.results[0].status).toBe("success")
			expect(await fs.readFile(path.join(worktree, "src", "nested", "foo.ts"), "utf8")).toBe("worktree-only")
			await expect(fs.access(logicalWrite)).rejects.toMatchObject({ code: "ENOENT" })

			const nestedRead = await scheduler.run(
				response({
					id: "logical-read",
					name: "read_file",
					arguments: { files: [{ path: path.join(logicalWorkspace, "src", "nested", "read.ts") }] },
				}),
			)
			expect(nestedRead.results[0].status).toBe("success")
			expect(String(nestedRead.results[0].content)).toContain("worktree-read")

			const logicalPatch = path.join(logicalWorkspace, "src", "nested", "patched.ts")
			const patched = await scheduler.run(
				response({
					id: "logical-patch",
					name: "apply_patch",
					arguments: {
						patch: `*** Begin Patch\n*** Add File: ${logicalPatch}\n+patched\n*** End Patch`,
					},
				}),
			)
			expect(patched.results[0].status).toBe("success")
			expect(await fs.readFile(path.join(worktree, "src", "nested", "patched.ts"), "utf8")).toBe("patched")
			await expect(fs.access(logicalPatch)).rejects.toMatchObject({ code: "ENOENT" })

			execute.mockClear()
			const parentShellDest = path.join(logicalWorkspace, "src", "nested", "leaked.ts")
			const rejectedShell = await scheduler.run(
				response({
					id: "parent-shell",
					name: "shell",
					arguments: { command: `echo leaked > "${parentShellDest}"` },
				}),
			)
			expect(rejectedShell.results[0].status).toBe("error")
			expect(String(rejectedShell.results[0].content)).toMatch(/scope|outside/i)
			expect(execute).not.toHaveBeenCalled()
			await expect(fs.access(parentShellDest)).rejects.toMatchObject({ code: "ENOENT" })
			await expect(fs.access(path.join(worktree, "src", "nested", "leaked.ts"))).rejects.toMatchObject({
				code: "ENOENT",
			})

			execute.mockClear()
			const mentioned = await scheduler.run(
				response({
					id: "mention-only",
					name: "shell",
					arguments: { command: `echo "${logicalWrite}"` },
				}),
			)
			expect(mentioned.results[0].status).toBe("success")
			expect(execute).toHaveBeenCalledOnce()
			expect((execute.mock.calls[0]?.[0].call.nativeArgs as { command?: string }).command).toBe(
				`echo "${logicalWrite}"`,
			)

			execute.mockClear()
			const rejected = await scheduler.run(
				response({
					id: "true-outside",
					name: "write_to_file",
					arguments: { path: path.join(tempRoot, "other", "file.ts"), content: "no" },
				}),
			)
			expect(rejected.results[0].status).toBe("error")
			expect(String(rejected.results[0].content)).toContain("outside the allowed workspace roots")
			expect(execute).not.toHaveBeenCalled()
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true })
		}
	})

	it("rejects an unexpected approval without entering Task.ask from a parallel worker", async () => {
		const task = makeTask()
		const ask = vi.spyOn(task, "ask")
		const registry = new ToolRegistry({ includeBuiltIns: false })
		let effects = 0
		registry.register(
			descriptor("read", "parallel", async ({ callbacks }) => {
				if (await callbacks.askApproval("tool", "unexpected")) effects++
			}),
		)
		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			executionMode: "selective-parallel",
			validateCall: () => {},
		}).run(response({ id: "one", name: "read" }, { id: "two", name: "read" }))
		expect(outcome.results.map((result) => result.status)).toEqual(["denied", "denied"])
		expect(outcome.results.map((result) => JSON.parse(String(result.content)).status)).toEqual(["denied", "denied"])
		expect(ask).not.toHaveBeenCalled()
		expect(effects).toBe(0)
	})

	it.each(["prepare", "run", "finalize"] as const)(
		"publishes a denied receipt when read %s revokes approval",
		async (phase) => {
			const task = makeTask()
			const registry = new ToolRegistry({ includeBuiltIns: false })
			const deny = (): never => {
				throw new ToolReadDeniedError("Captured read approval was revoked.")
			}
			const execute = vi.fn(async () => {})
			registry.register({
				...descriptor("read", "parallel", execute),
				prepareParallelRead: async () => {
					if (phase === "prepare") deny()
					return {
						scope: path.resolve(tmpdir(), "denied-read"),
						run: async () => {
							if (phase === "run") deny()
							return async () => deny()
						},
					}
				},
			})
			const outcome = await new ToolScheduler({
				task,
				registry,
				mode: "code",
				executionMode: "selective-parallel",
				validateCall: () => {},
				policy: createToolPolicySnapshot({ visibleTools: ["read"], autoApprovalEnabled: true }),
				readGrant: { enabled: true, workspaceRoot: tmpdir(), showIgnoredFiles: false },
			}).run(response({ id: "revoked", name: "read" }))

			expect(execute).not.toHaveBeenCalled()
			expect(outcome.results[0].status).toBe("denied")
			const published = task.userMessageContent.filter((item) => item.type === "tool_result")
			expect(published).toHaveLength(1)
			expect(published[0]).toMatchObject({ tool_use_id: "revoked", is_error: true })
			expect(JSON.parse(String(published[0].content))).toMatchObject({
				status: "denied",
				message: expect.stringContaining("Captured read approval was revoked."),
			})
		},
	)

	it("rechecks cancellation after an awaited durability fence before dispatch", async () => {
		const task = makeTask()
		const controller = new AbortController()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		const execute = vi.fn(async () => {})
		registry.register(descriptor("read", "serial", execute))
		let release!: () => void
		let entered!: () => void
		const atFence = new Promise<void>((resolve) => {
			entered = resolve
		})
		const fence = new Promise<void>((resolve) => {
			release = resolve
		})
		const run = new ToolScheduler({
			task,
			registry,
			mode: "code",
			signal: controller.signal,
			preserveAbortedResults: true,
			validateCall: () => {},
			beforeEffect: async () => {
				entered()
				await fence
			},
		}).run(response({ id: "one", name: "read" }))
		await atFence
		controller.abort()
		release()
		expect((await run).results[0].status).toBe("cancelled")
		expect(execute).not.toHaveBeenCalled()
		expect(resultIds(task)).toEqual(["one"])
	})

	it("records an effect-start intent after approval and before an approved effect", async () => {
		const task = makeTask()
		const timeline: string[] = []
		let effectCount = 0
		const registry = new ToolRegistry({ includeBuiltIns: false })
		const mutate = descriptor("mutate", "serial", async ({ callbacks }) => {
			if (await callbacks.askApproval("tool", "mutate a record")) {
				timeline.push("effect")
				effectCount += 1
				callbacks.pushToolResult("done")
			}
		})
		mutate.capabilities = { ...mutate.capabilities, sideEffects: "external", requiresApproval: true }
		registry.register(mutate)

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
			onEffectStart: async () => {
				timeline.push("intent")
			},
			onEvent: (event) => {
				if (event.type === "approval_result" && event.decision === "approved") timeline.push("approved")
			},
		}).run(response({ id: "approved-effect", name: "mutate" }))

		expect(outcome.results[0]?.status).toBe("success")
		expect(timeline).toEqual(["approved", "intent", "effect"])
		expect(effectCount).toBe(1)
	})

	it("does not mark a denied effect and blocks a direct effect when intent persistence fails", async () => {
		const deniedTask = makeTask()
		deniedTask.ask = async () => ({ response: "noButtonClicked" }) as any
		const deniedRegistry = new ToolRegistry({ includeBuiltIns: false })
		const deniedEffect = vi.fn()
		const deniedDescriptor = descriptor("mutate", "serial", async ({ callbacks }) => {
			if (await callbacks.askApproval("tool", "mutate a record")) deniedEffect()
		})
		deniedDescriptor.capabilities = {
			...deniedDescriptor.capabilities,
			sideEffects: "external",
			requiresApproval: true,
		}
		deniedRegistry.register(deniedDescriptor)
		const deniedIntent = vi.fn()
		const denied = await new ToolScheduler({
			task: deniedTask,
			registry: deniedRegistry,
			mode: "code",
			validateCall: () => {},
			onEffectStart: deniedIntent,
		}).run(response({ id: "denied-effect", name: "mutate" }))
		expect(denied.results[0]?.status).toBe("denied")
		expect(deniedIntent).not.toHaveBeenCalled()
		expect(deniedEffect).not.toHaveBeenCalled()

		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		const execute = vi.fn(async () => {})
		const direct = descriptor("direct_mutate", "serial", execute)
		direct.capabilities = { ...direct.capabilities, sideEffects: "workspace", requiresApproval: false }
		registry.register(direct)
		const intentFailure = new Error("journal sync failed")
		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
			onEffectStart: async () => {
				throw intentFailure
			},
		}).run(response({ id: "blocked-effect", name: "direct_mutate" }))

		expect(outcome.status).toBe("failed")
		expect(outcome.results[0]?.status).toBe("error")
		expect(execute).not.toHaveBeenCalled()
		expect(resultIds(task)).toEqual(["blocked-effect"])
	})

	it("reports an unknown outcome when cancellation follows a durable effect-start intent", async () => {
		const task = makeTask()
		const controller = new AbortController()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		let effectStarted!: () => void
		const started = new Promise<void>((resolve) => {
			effectStarted = resolve
		})
		const execute = vi.fn(async ({ signal }: Parameters<ToolDescriptor["execute"]>[0]) => {
			effectStarted()
			await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }))
		})
		const direct = descriptor("direct_mutate", "serial", execute)
		direct.capabilities = { ...direct.capabilities, sideEffects: "external", requiresApproval: false }
		registry.register(direct)
		const run = new ToolScheduler({
			task,
			registry,
			mode: "code",
			signal: controller.signal,
			validateCall: () => {},
			onEffectStart: async () => {},
		}).run(response({ id: "interrupted-effect", name: "direct_mutate" }))

		await started
		controller.abort(new Error("cancel after dispatch"))
		const outcome = await run
		expect(outcome.results[0]).toMatchObject({ status: "cancelled" })
		expect(String(outcome.results[0]?.content)).toContain("outcome is unknown")
		expect(execute).toHaveBeenCalledOnce()
	})

	it("drains an ignored-signal worker after a sibling fence failure and prevents queued effects", async () => {
		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		let release!: () => void
		let firstStarted!: () => void
		let fenceFailed!: () => void
		const started = new Promise<void>((resolve) => {
			firstStarted = resolve
		})
		const failed = new Promise<void>((resolve) => {
			fenceFailed = resolve
		})
		const pending = new Promise<void>((resolve) => {
			release = resolve
		})
		const effects: string[] = []
		let firstSignal: AbortSignal | undefined
		registry.register(
			descriptor("read", "parallel", async ({ call, callbacks, signal }) => {
				effects.push(call.id!)
				firstSignal = signal
				firstStarted()
				await pending
				callbacks.pushToolResult("joined")
			}),
		)
		let finished = false
		const run = new ToolScheduler({
			task,
			registry,
			mode: "code",
			executionMode: "selective-parallel",
			maxConcurrency: 3,
			validateCall: () => {},
			beforeEffect: async (call) => {
				if (call.id === "two") {
					await started
					fenceFailed()
					throw new Error("fence failed")
				}
			},
		})
			.run(response({ id: "one", name: "read" }, { id: "two", name: "read" }, { id: "three", name: "read" }))
			.then((outcome) => {
				finished = true
				return outcome
			})
		await failed
		await Promise.resolve()
		expect(finished).toBe(false)
		expect(firstSignal?.aborted).toBe(true)
		release()
		const outcome = await run
		expect(effects).toEqual(["one"])
		expect(outcome.status).toBe("failed")
		expect(outcome.results.map((result) => result.status)).toEqual(["success", "error", "error"])
		expect(resultIds(task)).toEqual(["one", "two", "three"])
	})

	it("reports command exit status and bounded redacted verification output", async () => {
		const task = makeTask()
		const events: any[] = []
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(
			descriptor("execute_command", "serial", async ({ call, callbacks }) => {
				const command = String((call.nativeArgs as { command?: string }).command)
				callbacks.setResultMetadata?.({
					status: command.includes("fail") ? "error" : "success",
					exitCode: command.includes("fail") ? 128 : 0,
				})
				callbacks.pushToolResult(`apiKey=secret-token\n${"output ".repeat(2_000)}`)
			}),
		)

		const scheduler = new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
			onEvent: (event) => {
				events.push(event)
			},
		})

		await scheduler.run(response({ id: "success", name: "execute_command", arguments: { command: "npm test" } }))
		await scheduler.run(
			response({ id: "failure", name: "execute_command", arguments: { command: "npm test --fail" } }),
		)

		const verificationResults = events.filter((event) => event.type === "verification_result")
		expect(verificationResults.map((event) => [event.status, event.exitCode])).toEqual([
			["success", 0],
			["error", 128],
		])
		expect(verificationResults[0].output).toContain("apiKey=[redacted]")
		expect(verificationResults[0].output).not.toContain("secret-token")
		expect(verificationResults[0].output.length).toBeLessThanOrEqual(8_000)
		expect(verificationResults[0].output).toContain("[truncated]")
	})

	it("reports denied and cancelled command verification results", async () => {
		const registry = new ToolRegistry({ includeBuiltIns: false })
		const command = descriptor("execute_command", "serial", async ({ callbacks }) => {
			if (await callbacks.askApproval("command", "npm test")) {
				callbacks.pushToolResult("should not run")
			}
		})
		command.capabilities = { ...command.capabilities, requiresApproval: true }
		registry.register(command)

		const deniedEvents: any[] = []
		const deniedTask = makeTask()
		deniedTask.ask = async () => ({ response: "noButtonClicked" }) as any
		await new ToolScheduler({
			task: deniedTask,
			registry,
			mode: "code",
			validateCall: () => {},
			onEvent: (event) => {
				deniedEvents.push(event)
			},
		}).run(response({ id: "denied", name: "execute_command", arguments: { command: "npm test" } }))

		const cancelledEvents: any[] = []
		const cancelledTask = makeTask()
		cancelledTask.ask = async () => ({ response: "messageResponse" }) as any
		await new ToolScheduler({
			task: cancelledTask,
			registry,
			mode: "code",
			validateCall: () => {},
			onEvent: (event) => {
				cancelledEvents.push(event)
			},
		}).run(response({ id: "cancelled", name: "execute_command", arguments: { command: "npm test" } }))

		expect(deniedEvents.find((event) => event.type === "verification_result").status).toBe("denied")
		expect(cancelledEvents.find((event) => event.type === "verification_result").status).toBe("cancelled")
		expect(
			cancelledTask.userMessageContent
				.filter((item) => item.type === "tool_result")
				.map((item) => JSON.parse(String(item.content)).status),
		).toEqual(["cancelled"])
	})

	it("lets task cancellation win when an approval resolves with a late denial", async () => {
		const task = makeTask()
		task.ask = async () => {
			task.abort = true
			return { response: "noButtonClicked" } as any
		}
		const events: AgentTurnEvent[] = []
		const registry = new ToolRegistry({ includeBuiltIns: false })
		const write = descriptor("write_file", "serial", async ({ callbacks }) => {
			if (await callbacks.askApproval("tool", "write file")) callbacks.pushToolResult("written")
		})
		write.capabilities = { ...write.capabilities, requiresApproval: true }
		registry.register(write)

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
			onEvent: (event) => {
				events.push(event)
			},
		}).run(response({ id: "late-denial", name: "write_file" }))

		expect(outcome.results[0]).toMatchObject({ status: "cancelled" })
		expect(outcome.approvalCancelledCount).toBe(1)
		expect(outcome.approvalDeniedCount).toBe(0)
		expect(events).toContainEqual(expect.objectContaining({ type: "approval_result", decision: "cancelled" }))
		expect(events).not.toContainEqual(expect.objectContaining({ type: "approval_result", decision: "denied" }))
	})

	it("preserves structured approval payloads without replacing the tool result", async () => {
		const task = makeTask()
		task.ask = async () =>
			({
				response: "objectResponse",
				text: JSON.stringify({ "first.ts": true, "second.ts": false }),
			}) as any
		const events: AgentTurnEvent[] = []
		const registry = new ToolRegistry({ includeBuiltIns: false })
		const read = descriptor("read_file", "serial", async ({ callbacks }) => {
			const approval = await callbacks.askApprovalResponse?.("tool", "batch")
			callbacks.pushToolResult(JSON.stringify(approval))
		})
		read.capabilities = { ...read.capabilities, requiresApproval: true }
		registry.register(read)

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
			onEvent: (event) => {
				events.push(event)
			},
		}).run(response({ id: "batch-read", name: "read_file" }))

		expect(outcome.results[0]).toMatchObject({ status: "denied" })
		expect(JSON.parse(String(outcome.results[0].content))).toEqual({
			response: "objectResponse",
			text: JSON.stringify({ "first.ts": true, "second.ts": false }),
		})
		expect(outcome.approvalRequestCount).toBe(1)
		expect(outcome.approvalDeniedCount).toBe(1)
		expect(events).toContainEqual(expect.objectContaining({ type: "approval_result", decision: "denied" }))
	})

	it("routes a typed one-time approval through the shared effect boundary", async () => {
		const task = makeTask()
		const legacyAsk = vi.spyOn(task, "ask")
		const requestToolApproval = vi.fn(async (_request: ToolApprovalRequest) => ({
			decision: "approve_once" as const,
		}))
		const execute = vi.fn(async ({ callbacks }: Parameters<ToolDescriptor["execute"]>[0]) => {
			if (await callbacks.askApproval("tool", "read private.txt")) callbacks.pushToolResult("read")
		})
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(descriptor("read_file", "serial", execute))
		Object.assign(task, { requestToolApproval, cwd: "/workspace" })

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(response({ id: "typed-once", name: "read_file", arguments: { path: "private.txt" } }))

		expect(outcome.results[0]).toMatchObject({ status: "success", content: "read" })
		expect(requestToolApproval).toHaveBeenCalledOnce()
		expect(requestToolApproval.mock.calls[0][0]).toMatchObject({
			taskId: "scheduler-test",
			callId: "typed-once",
			toolName: "read_file",
			askType: "tool",
			description: "read private.txt",
			availableDecisions: expect.arrayContaining(["approve_once", "approve_session", "deny", "abort"]),
		})
		expect(requestToolApproval.mock.calls[0][0]).not.toHaveProperty("arguments")
		expect(legacyAsk).not.toHaveBeenCalled()
	})

	it("gives a repeated provider call ID a fresh approval request identity across turns", async () => {
		const task = makeTask()
		const requestToolApproval = vi.fn(async (_request: ToolApprovalRequest) => ({ decision: "deny" as const }))
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(
			descriptor("read_file", "serial", async ({ callbacks }) => {
				if (await callbacks.askApproval("tool", "read private.txt")) callbacks.pushToolResult("read")
			}),
		)
		Object.assign(task, { requestToolApproval, cwd: "/workspace" })
		const runTurn = () =>
			new ToolScheduler({ task, registry, mode: "code", validateCall: () => {} }).run(
				response({ id: "reused-provider-call-id", name: "read_file", arguments: { path: "private.txt" } }),
			)

		await runTurn()
		await runTurn()

		const requests = requestToolApproval.mock.calls.map(([request]) => request)
		expect(requests).toHaveLength(2)
		expect(requests[0]).toMatchObject({ taskId: "scheduler-test", callId: "reused-provider-call-id" })
		expect(requests[1]).toMatchObject({ taskId: "scheduler-test", callId: "reused-provider-call-id" })
		expect(requests[1]!.requestId).not.toBe(requests[0]!.requestId)
	})

	it("includes the effective command working directory in a typed approval request", async () => {
		const task = makeTask()
		const workspace = path.join(tmpdir(), "approval-command-workspace")
		const requestToolApproval = vi.fn(async (_request: ToolApprovalRequest) => ({
			decision: "approve_once" as const,
		}))
		const execute = vi.fn(async ({ callbacks }: Parameters<ToolDescriptor["execute"]>[0]) => {
			if (await callbacks.askApproval("command", "git status")) callbacks.pushToolResult("done")
		})
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(descriptor("shell", "serial", execute))
		Object.assign(task, { requestToolApproval, cwd: workspace })

		const outcome = await new ToolScheduler({ task, registry, mode: "code", validateCall: () => {} }).run(
			response({ id: "typed-command-cwd", name: "shell", arguments: { cmd: "git status", workdir: "packages" } }),
		)

		expect(outcome.results[0]).toMatchObject({ status: "success", content: "done" })
		expect(requestToolApproval.mock.calls[0]![0]).toMatchObject({
			askType: "command",
			cwd: path.resolve(workspace, "packages"),
		})
	})

	it.each([
		{ name: "command", arguments: { cmd: "git status", command: "echo unsafe" } },
		{ name: "working directory", arguments: { cmd: "git status", cwd: ".", workdir: "../outside" } },
	])("rejects conflicting exec_command $name aliases before approval or execution", async ({ arguments: args }) => {
		const task = makeTask()
		const workspace = path.join(tmpdir(), "conflicting-command-alias-workspace")
		const requestToolApproval = vi.fn(async () => ({ decision: "approve_once" as const }))
		const execute = vi.fn(async ({ callbacks }: Parameters<ToolDescriptor["execute"]>[0]) => {
			if (await callbacks.askApproval("command", "git status")) callbacks.pushToolResult("ran")
		})
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(descriptor("exec_command", "serial", execute))
		Object.assign(task, { requestToolApproval, cwd: workspace })

		const outcome = await new ToolScheduler({ task, registry, mode: "code", validateCall: () => {} }).run(
			response({ id: "conflicting-exec-aliases", name: "exec_command", arguments: args }),
		)

		expect(outcome.results[0].status).toBe("error")
		expect(String(outcome.results[0].content)).toContain("conflicting")
		expect(requestToolApproval).not.toHaveBeenCalled()
		expect(execute).not.toHaveBeenCalled()
	})

	it("applies a denied command prefix to the command text that the terminal executes", async () => {
		const task = makeTask()
		const requestToolApproval = vi.fn(async () => ({ decision: "approve_once" as const }))
		const execute = vi.fn(async ({ call, callbacks }: Parameters<ToolDescriptor["execute"]>[0]) => {
			const command = unescapeHtmlEntities(String((call.nativeArgs as Record<string, unknown>).command))
			if (await callbacks.askApproval("command", command)) callbacks.pushToolResult("ran")
		})
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(descriptor("exec_command", "serial", execute))
		Object.assign(task, { requestToolApproval, cwd: path.join(tmpdir(), "encoded-denied-command-workspace") })
		const policy = createToolPolicySnapshot({
			visibleTools: ["exec_command"],
			execution: { command: { deniedPrefixes: ["echo 'blocked'"] } },
		})

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			policy,
			validateCall: () => {},
		}).run(
			response({
				id: "encoded-denied-command",
				name: "exec_command",
				arguments: { cmd: "echo &#39;blocked&#39;" },
			}),
		)

		expect(outcome.results[0].status).toBe("denied")
		expect(requestToolApproval).not.toHaveBeenCalled()
		expect(execute).not.toHaveBeenCalled()
	})

	it("uses exec_command for live approval and receipt identity while replaying legacy command names", async () => {
		const task = makeTask()
		const workspace = path.join(tmpdir(), "canonical-command-identity-workspace")
		const requestToolApproval = vi.fn(async (_request: ToolApprovalRequest) => ({
			decision: "approve_once" as const,
		}))
		const recordToolUsage = vi.fn()
		const recordToolCallForStopping = vi.fn()
		const shouldStopRepeatedToolCall = vi.fn((_name: string, _args: unknown) => false)
		const calls: Array<{ name: string; originalName?: string; command: unknown }> = []
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register({
			...descriptor("exec_command", "serial", async ({ call, callbacks }) => {
				const command = (call.nativeArgs as Record<string, unknown> | undefined)?.command
				calls.push({ name: call.name, originalName: call.originalName, command })
				if (await callbacks.askApproval("command", String(command))) callbacks.pushToolResult("ran")
			}),
			capabilities: {
				concurrency: "serial",
				sideEffects: "workspace",
				controlFlow: false,
				requiresApproval: true,
			},
		})
		Object.assign(task, {
			requestToolApproval,
			recordToolUsage,
			recordToolCallForStopping,
			shouldStopRepeatedToolCall,
			cwd: workspace,
		})
		const policy = createToolPolicySnapshot({
			visibleTools: ["exec_command"],
			allowedTools: ["exec_command"],
			approvalMode: "ask",
			capabilities: {
				exec_command: registry.resolve("exec_command")!.capabilities,
			},
		})
		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			policy,
			validateCall: () => {},
		}).run(
			response(
				{ id: "live-exec", name: "exec_command", arguments: { cmd: "git status", workdir: "packages" } },
				{ id: "replay-shell", name: "shell", arguments: { command: "git diff", cwd: "packages" } },
				{
					id: "replay-execute-command",
					name: "execute_command",
					arguments: { command: "git log -1", cwd: "packages" },
				},
			),
		)

		expect(outcome.results.map(({ name, status }) => ({ name, status }))).toEqual([
			{ name: "exec_command", status: "success" },
			{ name: "shell", status: "success" },
			{ name: "execute_command", status: "success" },
		])
		expect(calls).toEqual([
			{ name: "exec_command", originalName: undefined, command: "git status" },
			{ name: "exec_command", originalName: "shell", command: "git diff" },
			{ name: "exec_command", originalName: "execute_command", command: "git log -1" },
		])
		expect(requestToolApproval.mock.calls.map(([request]) => request.toolName)).toEqual([
			"exec_command",
			"exec_command",
			"exec_command",
		])
		expect(recordToolUsage.mock.calls).toEqual([["exec_command"], ["exec_command"], ["exec_command"]])
		expect(shouldStopRepeatedToolCall.mock.calls.map(([name]) => name)).toEqual(Array(6).fill("exec_command"))
		expect(recordToolCallForStopping.mock.calls.map(([name]) => name)).toEqual([
			"exec_command",
			"exec_command",
			"exec_command",
		])
		expect(resultIds(task)).toEqual(["live-exec", "replay-shell", "replay-execute-command"])
	})

	it("reuses a session grant only for the same exact tool request in that task", async () => {
		const task = makeTask()
		const requestToolApproval = vi.fn(async () => ({ decision: "approve_session" as const }))
		const execute = vi.fn(async ({ callbacks }: Parameters<ToolDescriptor["execute"]>[0]) => {
			if (await callbacks.askApproval("tool", "read private.txt")) callbacks.pushToolResult("read")
		})
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(descriptor("read_file", "serial", execute))
		Object.assign(task, { requestToolApproval, cwd: "/workspace" })
		const run = (callId: string, file = "private.txt") =>
			new ToolScheduler({ task, registry, mode: "code", validateCall: () => {} }).run(
				response({ id: callId, name: "read_file", arguments: { path: file } }),
			)

		const first = await run("session-1")
		const secondEvents: AgentTurnEvent[] = []
		const second = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
			onEvent: (event) => {
				secondEvents.push(event)
			},
		}).run(response({ id: "session-2", name: "read_file", arguments: { path: "private.txt" } }))
		const differentRequest = await run("session-3", "other.txt")

		expect(first.results[0].status).toBe("success")
		expect(second.results[0].status).toBe("success")
		expect(differentRequest.results[0].status).toBe("success")
		expect(requestToolApproval).toHaveBeenCalledTimes(2)
		expect(secondEvents).toContainEqual(
			expect.objectContaining({
				type: "approval_result",
				decision: "approved",
				reason: "Approved by an exact task-session grant.",
			}),
		)
	})

	it("records typed denial feedback and does not execute the requested effect", async () => {
		const task = makeTask()
		const say = vi.fn(async () => {})
		const requestToolApproval = vi.fn(async () => ({
			decision: "deny" as const,
			feedback: "Check the requested file path first.",
		}))
		let effects = 0
		const execute = vi.fn(async ({ callbacks }: Parameters<ToolDescriptor["execute"]>[0]) => {
			if (await callbacks.askApproval("tool", "read private.txt")) {
				effects += 1
				callbacks.pushToolResult("read")
			}
		})
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(descriptor("read_file", "serial", execute))
		Object.assign(task, { requestToolApproval, say })

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(response({ id: "typed-deny", name: "read_file" }))

		expect(outcome.results[0].status).toBe("denied")
		expect(outcome.approvalDeniedCount).toBe(1)
		expect(execute).toHaveBeenCalledOnce()
		expect(effects).toBe(0)
		expect(say).toHaveBeenCalledWith("user_feedback", "Check the requested file path first.")
		expect(String(outcome.results[0].content)).toContain("Check the requested file path first.")
	})

	it("aborts the scheduler batch when a typed approval is cancelled", async () => {
		const task = makeTask()
		const requestToolApproval = vi.fn(async () => ({ decision: "abort" as const }))
		let effects = 0
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(
			descriptor("read_file", "serial", async ({ callbacks }) => {
				if (await callbacks.askApproval("tool", "read private.txt")) effects++
			}),
		)
		Object.assign(task, { requestToolApproval })

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(response({ id: "typed-abort-1", name: "read_file" }, { id: "typed-abort-2", name: "read_file" }))

		expect(outcome.status).toBe("aborted")
		expect(outcome.results.map((result) => result.status)).toEqual(["cancelled", "cancelled"])
		expect(effects).toBe(0)
		expect(requestToolApproval).toHaveBeenCalledOnce()
	})

	it("closes a timed out typed approval as a cancelled result with timeout metadata", async () => {
		const task = makeTask()
		const requestToolApproval = vi.fn(async () => ({ decision: "timeout" as const }))
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(
			descriptor("read_file", "serial", async ({ callbacks }) => {
				if (await callbacks.askApproval("tool", "read private.txt")) callbacks.pushToolResult("read")
			}),
		)
		Object.assign(task, { requestToolApproval })

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(response({ id: "typed-timeout", name: "read_file" }))

		expect(outcome.status).toBe("completed")
		expect(outcome.results[0]).toMatchObject({ status: "cancelled", timedOut: true })
	})

	it("offers an exact-command session grant bound to the reviewed command, full arguments, and cwd", async () => {
		const task = makeTask()
		Object.assign(task, { cwd: "/workspace" })
		const requestToolApproval = vi.fn(async (request: ToolApprovalRequest) =>
			request.availableDecisions.includes("approve_with_amendment")
				? ({ decision: "approve_with_amendment", amendment: request.proposedAmendment! } as const)
				: ({ decision: "approve_once" } as const),
		)
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(
			descriptor("run_command", "serial", async ({ call, callbacks }) => {
				const args = call.nativeArgs as { command: string }
				if (await callbacks.askApproval("command", args.command)) callbacks.pushToolResult("ran")
			}),
		)
		Object.assign(task, { requestToolApproval })
		const run = (callId: string, command: string, cwd = "/workspace", events: AgentTurnEvent[] = []) =>
			new ToolScheduler({
				task,
				registry,
				mode: "code",
				validateCall: () => {},
				onEvent: (event) => {
					events.push(event)
				},
			}).run(response({ id: callId, name: "run_command", arguments: { command, cwd } }))

		const firstEvents: AgentTurnEvent[] = []
		const first = await run("typed-amendment", "git status --short", "/workspace", firstEvents)
		const sameRequest = await run("typed-amendment-repeat", "git status --short")
		const changedCommand = await run("typed-amendment-command-change", "git diff")
		const changedCwd = await run("typed-amendment-cwd-change", "git status --short", "/other")

		expect(first.results[0]).toMatchObject({ status: "success", content: "ran" })
		expect(sameRequest.results[0]).toMatchObject({ status: "success", content: "ran" })
		expect(changedCommand.results[0]).toMatchObject({ status: "success", content: "ran" })
		expect(changedCwd.results[0]).toMatchObject({ status: "success", content: "ran" })
		expect(requestToolApproval).toHaveBeenCalledTimes(3)
		expect(requestToolApproval.mock.calls[0][0].proposedAmendment).toEqual({
			kind: "exact_command",
			command: "git status --short",
		})
		expect(requestToolApproval.mock.calls[0][0].availableDecisions).toContain("approve_with_amendment")
		expect(requestToolApproval.mock.calls[0][0].availableDecisions).not.toContain("approve_session")
		expect(firstEvents).toContainEqual(
			expect.objectContaining({
				type: "approval_result",
				decision: "approved",
				reason: "Approved for this exact command and request in the task session.",
			}),
		)
	})

	it("persists an explicitly approved safe prefix and withholds the choice for dynamic shell commands", async () => {
		const task = makeTask()
		const savedPrefixes: string[] = []
		const persistCommandApprovalPrefix = vi.fn(async (prefix: string) => {
			savedPrefixes.push(prefix)
			return true
		})
		const requestToolApproval = vi.fn(
			async (request: ToolApprovalRequest): Promise<ToolApprovalDecision> =>
				request.proposedPersistentAmendment
					? { decision: "approve_persistently", amendment: request.proposedPersistentAmendment }
					: { decision: "approve_once" },
		)
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(
			descriptor("run_command", "serial", async ({ call, callbacks }) => {
				const command = (call.nativeArgs as { command: string }).command
				if (await callbacks.askApproval("command", command)) callbacks.pushToolResult("ran")
			}),
		)
		Object.assign(task, {
			taskKind: "primary",
			cwd: "/workspace",
			persistCommandApprovalPrefix,
			requestToolApproval,
		})

		const run = (id: string, command: string) =>
			new ToolScheduler({ task, registry, mode: "code", validateCall: () => {} }).run(
				response({ id, name: "run_command", arguments: { command } }),
			)
		const safe = await run("persistent-prefix-safe", "git status --short")
		const dynamic = await run("persistent-prefix-dynamic", "$COMMAND --help")

		expect(safe.results[0]).toMatchObject({ status: "success", content: "ran" })
		expect(dynamic.results[0]).toMatchObject({ status: "success", content: "ran" })
		expect(savedPrefixes).toEqual(["git status --short"])
		expect(requestToolApproval.mock.calls[0]![0].availableDecisions).toContain("approve_persistently")
		expect(requestToolApproval.mock.calls[1]![0].availableDecisions).not.toContain("approve_persistently")
		expect(requestToolApproval.mock.calls[1]![0].proposedPersistentAmendment).toBeUndefined()
	})

	it("rejects an exact-command session grant that does not match the reviewed command", async () => {
		const task = makeTask()
		const requestToolApproval = vi.fn(async () => ({
			decision: "approve_with_amendment" as const,
			amendment: { kind: "exact_command" as const, command: "git clean -xfd" },
		}))
		let effects = 0
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(
			descriptor("run_command", "serial", async ({ callbacks }) => {
				if (await callbacks.askApproval("command", "git status --short")) effects += 1
			}),
		)
		Object.assign(task, { requestToolApproval })

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(response({ id: "typed-amendment-mismatch", name: "run_command" }))

		expect(outcome.results[0].status).toBe("error")
		expect(effects).toBe(0)
		expect(requestToolApproval).toHaveBeenCalledOnce()
	})

	it("does not leave an exact-command session grant when the approval is cancelled", async () => {
		const task = makeTask()
		const controller = new AbortController()
		let announceWaiting: (() => void) | undefined
		let releaseApproval: ((decision: ToolApprovalDecision) => void) | undefined
		const waiting = new Promise<void>((resolve) => {
			announceWaiting = resolve
		})
		const firstApproval = new Promise<ToolApprovalDecision>((resolve) => {
			releaseApproval = resolve
		})
		const requestToolApproval = vi
			.fn<(request: ToolApprovalRequest) => Promise<ToolApprovalDecision | undefined>>()
			.mockImplementationOnce(async () => {
				announceWaiting?.()
				return firstApproval
			})
			.mockImplementationOnce(async (request) => ({
				decision: "approve_with_amendment",
				amendment: request.proposedAmendment!,
			}))
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(
			descriptor("run_command", "serial", async ({ call, callbacks }) => {
				const args = call.nativeArgs as { command: string }
				if (await callbacks.askApproval("command", args.command)) callbacks.pushToolResult("ran")
			}),
		)
		Object.assign(task, { requestToolApproval, cwd: "/workspace" })
		const commandResponse = response({
			id: "typed-amendment-cancelled",
			name: "run_command",
			arguments: { command: "git status --short" },
		})

		const pending = new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
			signal: controller.signal,
		}).run(commandResponse)
		await waiting
		controller.abort(new Error("cancelled while approval was pending"))
		const cancelled = await pending
		releaseApproval?.({ decision: "approve_once" })
		const next = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(response({ ...commandResponse.toolCalls[0]!, id: "typed-amendment-after-cancel" }))

		expect(cancelled.results[0].status).toBe("cancelled")
		expect(next.results[0]).toMatchObject({ status: "success", content: "ran" })
		expect(requestToolApproval).toHaveBeenCalledTimes(2)
	})

	it("does not offer session grants for forced or explicitly required command approvals", async () => {
		const task = makeTask()
		const requestToolApproval = vi.fn(async (_request: ToolApprovalRequest) => ({
			decision: "approve_once" as const,
		}))
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(
			descriptor("run_command", "serial", async ({ callbacks }) => {
				await callbacks.askApproval("command", "git status --short", undefined, true)
				await callbacks.askApproval("command", "git status --short", undefined, false, true)
			}),
		)
		Object.assign(task, { requestToolApproval, cwd: "/workspace" })

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(response({ id: "typed-forced-and-explicit", name: "run_command" }))

		expect(outcome.results[0].status).toBe("success")
		expect(requestToolApproval).toHaveBeenCalledTimes(2)
		for (const [request] of requestToolApproval.mock.calls) {
			expect(request.availableDecisions).toEqual(["approve_once", "deny", "abort"])
			expect(request.proposedAmendment).toBeUndefined()
		}
	})

	it("does not offer an exact-command session grant for an out-of-scope command path", async () => {
		const workspace = await fs.mkdtemp(path.join(tmpdir(), "exact-command-grant-path-"))
		try {
			const task = makeTask()
			const requestToolApproval = vi.fn(async (_request: ToolApprovalRequest) => ({
				decision: "approve_once" as const,
			}))
			const registry = new ToolRegistry({ includeBuiltIns: false })
			registry.register(
				descriptor("shell", "serial", async ({ callbacks }) => {
					await callbacks.askApproval("command", "touch ../outside.txt")
				}),
			)
			const persistCommandApprovalPrefix = vi.fn(async () => true)
			Object.assign(task, {
				requestToolApproval,
				cwd: workspace,
				taskKind: "primary",
				persistCommandApprovalPrefix,
			})

			const outcome = await new ToolScheduler({
				task,
				registry,
				mode: "code",
				policy: createToolPolicySnapshot({
					visibleTools: ["shell"],
					allowedTools: ["shell"],
					execution: { workspaceRoots: [workspace], outsideWorkspace: "approval" },
				}),
				validateCall: () => {},
			}).run(
				response({
					id: "typed-outside-command",
					name: "shell",
					arguments: { command: "touch ../outside.txt" },
				}),
			)

			expect(outcome.results[0].status).toBe("success")
			expect(requestToolApproval).toHaveBeenCalledOnce()
			const [approvalRequest] = requestToolApproval.mock.calls[0]!
			expect(approvalRequest.commandPathApproval).toMatchObject({
				outsidePaths: [expect.any(String)],
				unresolved: false,
			})
			expect(approvalRequest.availableDecisions).toEqual(["approve_once", "deny", "abort"])
			expect(approvalRequest.proposedAmendment).toBeUndefined()
			expect(approvalRequest.proposedPersistentAmendment).toBeUndefined()
			expect(persistCommandApprovalPrefix).not.toHaveBeenCalled()
		} finally {
			await fs.rm(workspace, { recursive: true, force: true })
		}
	})

	it("emits error telemetry for a stale apply_patch mismatch", async () => {
		const workspace = await fs.mkdtemp(path.join(tmpdir(), "stale-apply-patch-"))
		const telemetryStorage = await fs.mkdtemp(path.join(tmpdir(), "stale-apply-patch-events-"))
		const filePath = path.join(workspace, "harness-stale-edit-test.txt")
		const externallyChanged = "status = externally changed\nmarker = preserve-me\nexternal_change = true\n"
		await fs.writeFile(filePath, externallyChanged, "utf8")

		try {
			const task = makeTask()
			Object.assign(task, {
				cwd: workspace,
				consecutiveMistakeCount: 0,
				recordToolError: () => {},
				alphaIgnoreController: { validateAccess: () => true },
			})
			const events: any[] = []
			const eventLog = new AgentTurnEventLog("stale-apply-patch", telemetryStorage)
			const registry = new ToolRegistry({ includeBuiltIns: false })
			registry.register({
				...descriptor("apply_patch", "serial", async ({ task: executionTask, call, callbacks }) => {
					await new ApplyPatchTool().execute(call.nativeArgs as { patch: string }, executionTask, callbacks)
				}),
			})

			const outcome = await new ToolScheduler({
				task,
				registry,
				mode: "code",
				validateCall: () => {},
				onEvent: async (event) => {
					events.push(event)
					await eventLog.append(event)
				},
			}).run(
				response({
					id: "stale-apply-patch",
					name: "apply_patch",
					arguments: {
						patch: [
							"*** Begin Patch",
							"*** Update File: harness-stale-edit-test.txt",
							"@@",
							"-status = baseline",
							"+status = updated by agent",
							"*** End Patch",
						].join("\n"),
					},
				}),
			)

			expect(outcome.results[0]?.status).toBe("error")
			expect(events.find((event) => event.type === "tool_result").status).toBe("error")
			const persistedEvents = await readAgentTurnEvents("stale-apply-patch", telemetryStorage)
			expect(persistedEvents.find((record) => record.event.type === "tool_result")?.event).toMatchObject({
				type: "tool_result",
				name: "apply_patch",
				status: "error",
			})
			expect(await fs.readFile(filePath, "utf8")).toBe(externallyChanged)
		} finally {
			await fs.rm(workspace, { recursive: true, force: true })
			await fs.rm(telemetryStorage, { recursive: true, force: true })
		}
	})

	it("normalizes structured native tool results before emitting tool telemetry", async () => {
		const cases = [
			{
				id: "stale-apply-patch",
				name: "apply_patch",
				result: formatResponse.toolError("Failed to process patch: Failed to find expected lines..."),
				status: "error",
			},
			{
				id: "successful-apply-patch",
				name: "apply_patch",
				result: "Applied patch successfully.",
				status: "success",
			},
			{
				id: "denied-tool",
				name: "read_file",
				result: formatResponse.toolDenied(),
				status: "denied",
			},
			{
				id: "cancelled-tool",
				name: "read_file",
				result: JSON.stringify({ status: "cancelled", message: "Tool execution was cancelled." }),
				status: "cancelled",
			},
		] as const
		const task = makeTask()
		const events: any[] = []
		const outcomes = []

		for (const testCase of cases) {
			const registry = new ToolRegistry({ includeBuiltIns: false })
			const stub = descriptor(testCase.name, "serial", async ({ callbacks }) => {
				callbacks.pushToolResult(testCase.result)
			})
			stub.capabilities = { ...stub.capabilities, sideEffects: "none" }
			registry.register(stub)
			outcomes.push(
				await new ToolScheduler({
					task,
					registry,
					mode: "code",
					validateCall: () => {},
					onEvent: (event) => {
						events.push(event)
					},
				}).run(
					response({
						id: testCase.id,
						name: testCase.name,
						arguments:
							testCase.name === "apply_patch"
								? { patch: "*** Begin Patch\n*** Add File: fixture.txt\n+fixture\n*** End Patch" }
								: {},
					}),
				),
			)
		}

		expect(outcomes.map((outcome) => outcome.results[0]?.status)).toEqual(cases.map(({ status }) => status))
		expect(events.filter((event) => event.type === "tool_result").map((event) => event.status)).toEqual(
			cases.map(({ status }) => status),
		)
		expect((task.userMessageContent as any[]).map((item) => item.content)).toEqual(
			cases.map(({ result }) => result),
		)
	})

	it("treats opaque tool JSON as data while preserving handler-owned failures", async () => {
		const task = makeTask()
		const events: AgentTurnEvent[] = []
		const registry = new ToolRegistry({ includeBuiltIns: false })
		const payload = JSON.stringify({ status: "error", message: "This is the tool's data." })
		const opaque = descriptor("opaque_tool", "serial", async ({ callbacks }) => {
			callbacks.pushToolResult(payload)
		})
		opaque.statusSource = "handler"
		registry.register(opaque)

		const scheduler = new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
			onEvent: (event) => {
				events.push(event)
			},
		})
		const success = await scheduler.run(response({ id: "opaque-success", name: "opaque_tool" }))
		expect(success.results[0]).toMatchObject({ status: "success", content: payload })
		expect(events.filter((event) => event.type === "tool_result")).toMatchObject([
			{ callId: "opaque-success", status: "success" },
		])
		expect(resultIds(task)).toEqual(["opaque-success"])

		const failed = descriptor("opaque_failure", "serial", async ({ callbacks }) => {
			callbacks.setResultMetadata?.({ status: "error" })
			callbacks.pushToolResult(JSON.stringify({ status: "success", message: "Failed at the handler." }))
		})
		failed.statusSource = "handler"
		registry.register(failed)
		const failure = await scheduler.run(response({ id: "opaque-failure", name: "opaque_failure" }))
		expect(failure.results[0]?.status).toBe("error")
		expect(resultIds(task)).toEqual(["opaque-success", "opaque-failure"])
	})

	it("does not let a successful custom tool JSON payload impersonate a failed call", async () => {
		const task = makeTask()
		Object.assign(task, { getTaskMode: async () => "code" })
		const payload = JSON.stringify({ status: "error", message: "A domain result, not an execution failure." })
		const registry = new ToolRegistry({
			includeBuiltIns: false,
			customTools: [
				{
					definition: {
						name: "custom_status_data",
						description: "Returns structured domain data",
						execute: async () => payload,
					},
					schema: descriptor("custom_status_data", "serial", async () => {}).schema,
				},
				{
					definition: {
						name: "custom_status_failure",
						description: "Throws before returning data",
						execute: async () => {
							throw new Error("execution failed")
						},
					},
					schema: descriptor("custom_status_failure", "serial", async () => {}).schema,
				},
			],
		})
		const result = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(response({ id: "custom-status-data", name: "custom_status_data" }))
		expect(result.results[0]).toMatchObject({ status: "success", content: payload })
		const failure = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(response({ id: "custom-status-failure", name: "custom_status_failure" }))
		expect(failure.results[0]?.status).toBe("error")
		expect(resultIds(task)).toEqual(["custom-status-data", "custom-status-failure"])
	})

	it("uses MCP response metadata instead of status-looking server content", async () => {
		const task = makeTask()
		Object.assign(task, {
			consecutiveMistakeCount: 0,
			recordToolError: () => {},
			lastMessageTs: 1,
			providerRef: {
				deref: () => ({
					getMcpHub: () => ({
						getAllServers: () => [{ name: "server", tools: [{ name: "lookup", description: "lookup" }] }],
						callTool: async () => ({
							content: [{ type: "text", text: JSON.stringify({ status: "error", value: 42 }) }],
							isError: false,
						}),
					}),
					postMessageToWebview: async () => {},
				}),
			},
		})
		const registry = new ToolRegistry({
			nativeTools: [],
			mcpTools: [descriptor("mcp--server--lookup", "serial", async () => {}).schema],
		})
		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(response({ id: "mcp-status-data", name: "mcp--server--lookup" }))
		expect(outcome.results[0]).toMatchObject({
			status: "success",
			content: JSON.stringify({ status: "error", value: 42 }),
		})
		expect(resultIds(task)).toEqual(["mcp-status-data"])

		const legacyOutcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(
			response({
				id: "legacy-mcp-status-data",
				name: "use_mcp_tool",
				arguments: { server_name: "server", tool_name: "lookup" },
			}),
		)
		expect(legacyOutcome.results[0]).toMatchObject({
			callId: "legacy-mcp-status-data",
			name: "use_mcp_tool",
			status: "error",
		})
		expect(String(legacyOutcome.results[0]?.content)).toContain("not registered")
		expect(resultIds(task)).toEqual(["mcp-status-data", "legacy-mcp-status-data"])
	})

	it("does not report a verification result for a still-running command", async () => {
		const task = makeTask()
		const events: any[] = []
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(
			descriptor("execute_command", "serial", async ({ callbacks }) => {
				callbacks.pushToolResult("Command is still running in the background.")
			}),
		)

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
			onEvent: (event) => {
				events.push(event)
			},
		}).run(response({ id: "running", name: "execute_command", arguments: { command: "npm test" } }))

		expect(outcome.results[0].status).toBe("success")
		expect(events.filter((event) => event.type === "verification_result")).toHaveLength(0)
	})

	it("preserves two provider stream tool calls through normalization into execution", async () => {
		const normalized = await collectAgentResponse(
			(async function* () {
				yield { type: "tool_call_partial", index: 0, id: "1", name: "read_file" } as const
				yield { type: "tool_call_partial", index: 0, arguments: '{"path":"a.ts"}' } as const
				yield { type: "tool_call_partial", index: 1, id: "2", name: "list_files" } as const
				yield { type: "tool_call_partial", index: 1, arguments: '{"path":"src"}' } as const
			})(),
		)
		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		let peak = 0
		let active = 0

		for (const name of ["read_file", "list_files"]) {
			registry.register(
				descriptor(name, "parallel", async ({ callbacks }) => {
					active += 1
					peak = Math.max(peak, active)
					await wait(5)
					callbacks.pushToolResult(name)
					active -= 1
				}),
			)
		}

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			executionMode: "selective-parallel",
			validateCall: () => {},
		}).run(normalized)

		expect(normalized.toolCalls).toHaveLength(2)
		expect(outcome.parallelBatchCount).toBe(1)
		expect(peak).toBe(2)
		expect(resultIds(task)).toEqual(["1", "2"])
	})

	it("collects and executes six independent reads as one ordered parallel batch", async () => {
		const normalized = await collectAgentResponse(
			(async function* () {
				for (let index = 0; index < 6; index += 1) {
					yield {
						type: "tool_call_partial",
						index,
						id: `call-${index + 1}`,
						name: "read_file",
					} as const
					yield {
						type: "tool_call_partial",
						index,
						arguments: JSON.stringify({ path: `file-${index + 1}.ts` }),
					} as const
				}
			})(),
		)
		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		let active = 0
		let peak = 0
		let releaseHandlers!: () => void
		const allHandlersStarted = new Promise<void>((resolve) => {
			releaseHandlers = resolve
		})
		registry.register(
			descriptor("read_file", "parallel", async ({ call, callbacks }) => {
				active += 1
				peak = Math.max(peak, active)
				if (active === 6) releaseHandlers()
				await allHandlersStarted
				callbacks.pushToolResult(`content-${call.id}`)
				active -= 1
			}),
		)

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			executionMode: "selective-parallel",
			maxConcurrency: 6,
			validateCall: () => {},
		}).run(normalized)

		expect(normalized.toolCalls).toHaveLength(6)
		expect(outcome.batchSize).toBe(6)
		expect(outcome.parallelBatchCount).toBe(1)
		expect(outcome.parallelToolCount).toBe(6)
		expect(peak).toBe(6)
		expect(outcome.approvalRequestCount).toBe(0)
		expect(outcome.approvalDeniedCount).toBe(0)
		expect(outcome.approvalCancelledCount).toBe(0)
		expect(outcome.supersededAskCount).toBe(0)
		expect(outcome.completedToolResultCount).toBe(6)
		expect(outcome.results.every((result) => result.status === "success")).toBe(true)
		expect((task.userMessageContent as any[]).map((item) => item.content)).toEqual([
			"content-call-1",
			"content-call-2",
			"content-call-3",
			"content-call-4",
			"content-call-5",
			"content-call-6",
		])
		expect(resultIds(task)).toEqual(["call-1", "call-2", "call-3", "call-4", "call-5", "call-6"])
		expect(outcome.status).toBe("completed")
		expect(task.userMessageContentReady).toBe(true)
	})

	it("serializes real read_file handlers when approval metadata is required", async () => {
		const task = makeTask()
		const workspaceRoot = path.resolve(__dirname, "../../../..")
		Object.assign(task, {
			cwd: workspaceRoot,
			api: { getModel: () => ({ info: { supportsImages: false } }) },
			consecutiveMistakeCount: 0,
			alphaIgnoreController: { validateAccess: () => true },
			fileContextTracker: { trackFileContext: async () => {} },
			providerRef: { deref: () => ({ getState: async () => ({}) }) },
			recordToolError: () => {},
		})

		const files = [
			"src/core/agent/AgentResponse.ts",
			"src/core/agent/AgentResponseAccumulator.ts",
			"src/core/agent/AgentTurnEvents.ts",
			"src/core/agent/AgentTurnTelemetry.ts",
			"src/core/agent/ToolScheduler.ts",
			"src/core/tools/ToolRegistry.ts",
		]
		const registry = new ToolRegistry({ includeBuiltIns: false })
		let active = 0
		let peak = 0
		registry.register({
			name: "read_file",
			aliases: [],
			schema: {
				type: "function",
				function: {
					name: "read_file",
					description: "Read a file",
					parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
				},
			},
			capabilities: {
				concurrency: "parallel",
				sideEffects: "none",
				controlFlow: false,
				requiresApproval: true,
			},
			execute: async ({ task: executionTask, call, callbacks }) => {
				active += 1
				peak = Math.max(peak, active)
				await wait(1)
				try {
					await readFileTool.execute(call.nativeArgs as any, executionTask, callbacks)
				} finally {
					active -= 1
				}
			},
		})

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			executionMode: "selective-parallel",
			validateCall: () => {},
		}).run(
			response(
				...files.map((file, index) => ({
					id: `real-read-${index + 1}`,
					name: "read_file",
					arguments: { path: file },
				})),
			),
		)

		expect(peak).toBe(1)
		expect(outcome.parallelBatchCount).toBe(0)
		expect(outcome.parallelToolCount).toBe(0)
		expect(outcome.results).toHaveLength(6)
		expect(outcome.results.every((result) => result.status === "success")).toBe(true)
		// ReadFileTool routes interactive prompts through the scheduler-owned mutex.
		expect(outcome.approvalRequestCount).toBe(6)
		expect(outcome.supersededAskCount).toBe(0)
		expect(outcome.completedToolResultCount).toBe(6)
		expect(outcome.results.map((result) => (typeof result.content === "string" ? result.content : ""))).toEqual(
			files.map((file) => expect.stringContaining(`File: ${file}`)),
		)
	})

	it("isolates a denied read while approved sibling reads complete", async () => {
		const task = makeTask()
		let askIndex = 0
		task.ask = async () => ({ response: askIndex++ === 1 ? "noButtonClicked" : "yesButtonClicked" }) as any
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(
			descriptor("read_file", "parallel", async ({ callbacks }) => {
				if (await callbacks.askApproval("tool", "read file")) {
					callbacks.pushToolResult("file contents")
				}
			}),
		)

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(response({ id: "1", name: "read_file" }, { id: "2", name: "read_file" }, { id: "3", name: "read_file" }))

		expect(outcome.results.map((result) => result.status)).toEqual(["success", "denied", "success"])
		expect(outcome.approvalRequestCount).toBe(3)
		expect(outcome.approvalDeniedCount).toBe(1)
		expect(outcome.supersededAskCount).toBe(0)
		expect(resultIds(task)).toEqual(["1", "2", "3"])
	})

	it("turns a superseded approval into an explicit result instead of swallowing it", async () => {
		const task = makeTask()
		task.ask = async () => {
			throw new AskIgnoredError("superseded")
		}
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(
			descriptor("read_file", "parallel", async ({ callbacks }) => {
				if (await callbacks.askApproval("tool", "read file")) {
					callbacks.pushToolResult("unexpected")
				}
			}),
		)

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(response({ id: "superseded", name: "read_file" }))

		expect(outcome.supersededAskCount).toBe(1)
		expect(outcome.results[0].status).toBe("error")
		expect(outcome.results[0].content).toContain("superseded")
		expect(resultIds(task)).toEqual(["superseded"])
	})

	it("runs contiguous parallel tools concurrently and commits results in model order", async () => {
		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		let active = 0
		let peak = 0

		for (const [name, delay] of [
			["read_one", 30],
			["read_two", 5],
		] as const) {
			registry.register(
				descriptor(name, "parallel", async ({ callbacks }) => {
					active += 1
					peak = Math.max(peak, active)
					await wait(delay)
					callbacks.pushToolResult(name)
					active -= 1
				}),
			)
		}

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			executionMode: "selective-parallel",
			validateCall: () => {},
		}).run(response({ id: "1", name: "read_one" }, { id: "2", name: "read_two" }))

		expect(outcome.status).toBe("completed")
		expect(peak).toBe(2)
		expect(outcome.batchSize).toBe(2)
		expect(outcome.parallelBatchCount).toBe(1)
		expect(outcome.durationMs).toBeGreaterThanOrEqual(0)
		expect(resultIds(task)).toEqual(["1", "2"])
	})

	it("settles direct MCP read approvals before overlap and commits their results in model order", async () => {
		const task = makeTask()
		const approvals: string[] = []
		task.ask = vi.fn(async (_type: string, description: string) => {
			approvals.push(`settled:${description}`)
			return { response: "yesButtonClicked" as const }
		}) as Task["ask"]
		const registry = new ToolRegistry({ includeBuiltIns: false })
		const firstStarted = deferred()
		const secondStarted = deferred()
		const releaseFirst = deferred()
		const releaseSecond = deferred()
		let active = 0
		let peak = 0
		const effects: string[] = []
		const approvalsAtEffectStart: number[] = []
		const capabilities: ToolDescriptor["capabilities"] = {
			concurrency: "serial",
			sideEffects: "external",
			controlFlow: false,
			requiresApproval: true,
			parallelMcpRead: true,
		}
		for (const id of ["first", "second"]) {
			const name = `mcp--calendar--${id}`
			registry.register({
				...mcpDescriptor(
					name,
					async ({ call, callbacks }) => {
						const callId = String(call.id)
						if (!(await callbacks.askApproval("use_mcp_server", `approval-${callId}`))) return
						approvalsAtEffectStart.push(approvals.length)
						effects.push(callId)
						active++
						peak = Math.max(peak, active)
						if (callId === "first") {
							firstStarted.resolve()
							await releaseFirst.promise
						} else {
							secondStarted.resolve()
							await releaseSecond.promise
						}
						callbacks.pushToolResult(`result-${callId}`)
						active--
					},
					true,
				),
			})
		}
		const policy = createToolPolicySnapshot({
			visibleTools: ["mcp--calendar--first", "mcp--calendar--second"],
			capabilities: {
				"mcp--calendar--first": capabilities,
				"mcp--calendar--second": capabilities,
			},
		})
		const running = new ToolScheduler({
			task,
			registry,
			mode: "code",
			executionMode: "selective-parallel",
			policy,
			validateCall: () => {},
		}).run(response({ id: "first", name: "mcp--calendar--first" }, { id: "second", name: "mcp--calendar--second" }))

		await Promise.all([firstStarted.promise, secondStarted.promise])
		expect(approvals).toEqual(["settled:approval-first", "settled:approval-second"])
		expect(peak).toBe(2)
		releaseSecond.resolve()
		releaseFirst.resolve()
		const outcome = await running

		expect(outcome).toMatchObject({ status: "completed", parallelBatchCount: 1, parallelToolCount: 2 })
		expect(outcome.approvalRequestCount).toBe(2)
		expect(task.ask).toHaveBeenCalledTimes(2)
		expect(effects).toEqual(["first", "second"])
		expect(approvalsAtEffectStart).toEqual([2, 2])
		expect(outcome.results.map(({ status, content }) => [status, content])).toEqual([
			["success", "result-first"],
			["success", "result-second"],
		])
		expect(resultIds(task)).toEqual(["first", "second"])
	})

	it("publishes a denied MCP read preflight once without replaying or dispatching it", async () => {
		const task = makeTask()
		task.ask = vi.fn(async () => ({ response: "noButtonClicked" as const })) as Task["ask"]
		const registry = new ToolRegistry({ includeBuiltIns: false })
		const execute = vi.fn(async ({ callbacks }: Parameters<ToolDescriptor["execute"]>[0]) => {
			if (await callbacks.askApproval("use_mcp_server", "deny MCP read")) callbacks.pushToolResult("dispatched")
		})
		const read = mcpDescriptor("mcp--calendar--lookup", execute, true)
		registry.register(read)
		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			executionMode: "selective-parallel",
			policy: createToolPolicySnapshot({
				visibleTools: [read.name],
				capabilities: { [read.name]: read.capabilities },
			}),
			validateCall: () => {},
		}).run(response({ id: "denied", name: read.name }))

		expect(outcome.results[0].status).toBe("denied")
		expect(outcome.approvalRequestCount).toBe(1)
		expect(task.ask).toHaveBeenCalledOnce()
		expect(execute).toHaveBeenCalledOnce()
		expect(resultIds(task)).toEqual(["denied"])
		expect((task.userMessageContent as any[])[0].is_error).toBe(true)
	})

	it.each([
		["missing descriptor metadata", false, true],
		["missing captured metadata", true, false],
		["false captured metadata", true, false],
		["MCP writes", false, true],
	] as const)("keeps direct MCP calls serial with %s", async (_caseName, descriptorHint, writeCall) => {
		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		let active = 0
		let peak = 0
		const releaseFirst = deferred()
		const firstStarted = deferred()
		for (const id of ["first", "second"]) {
			const name = `mcp--calendar--${writeCall ? "write" : "lookup"}_${id}`
			registry.register({
				...mcpDescriptor(
					name,
					async ({ call, callbacks }) => {
						if (!(await callbacks.askApproval("use_mcp_server", `approval-${call.id}`))) return
						active++
						peak = Math.max(peak, active)
						if (call.id === "first") {
							firstStarted.resolve()
							await releaseFirst.promise
						}
						callbacks.pushToolResult(`result-${call.id}`)
						active--
					},
					descriptorHint && !writeCall,
				),
			})
		}
		const names = [
			`mcp--calendar--${writeCall ? "write" : "lookup"}_first`,
			`mcp--calendar--${writeCall ? "write" : "lookup"}_second`,
		]
		const policyCapabilities = names.reduce<Record<string, ToolDescriptor["capabilities"]>>((values, name) => {
			const descriptor = registry.resolve(name)!
			values[name] = { ...descriptor.capabilities }
			if (descriptorHint && !writeCall) {
				if (_caseName === "missing captured metadata") delete values[name].parallelMcpRead
				else values[name].parallelMcpRead = _caseName === "false captured metadata" ? false : true
			}
			return values
		}, {})
		const running = new ToolScheduler({
			task,
			registry,
			mode: "code",
			executionMode: "selective-parallel",
			policy: createToolPolicySnapshot({ visibleTools: names, capabilities: policyCapabilities }),
			validateCall: () => {},
		}).run(response({ id: "first", name: names[0] }, { id: "second", name: names[1] }))
		await firstStarted.promise
		releaseFirst.resolve()
		const outcome = await running

		expect(peak).toBe(1)
		expect(outcome.parallelToolCount).toBe(0)
		expect(resultIds(task)).toEqual(["first", "second"])
	})

	it("keeps serial tools from overlapping and stops parallel phases at a serial tool", async () => {
		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		let active = 0
		let peak = 0

		for (const [name, concurrency] of [
			["read", "parallel"],
			["command", "serial"],
			["read_after", "parallel"],
		] as const) {
			registry.register(
				descriptor(name, concurrency, async ({ callbacks }) => {
					active += 1
					peak = Math.max(peak, active)
					await wait(5)
					callbacks.pushToolResult(name)
					active -= 1
				}),
			)
		}

		await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(response({ id: "1", name: "read" }, { id: "2", name: "command" }, { id: "3", name: "read_after" }))

		expect(peak).toBe(1)
		expect(resultIds(task)).toEqual(["1", "2", "3"])
	})

	it("never overlaps two mutation calls", async () => {
		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		let active = 0
		let peak = 0

		for (const name of ["edit_one", "edit_two"]) {
			registry.register(
				descriptor(name, "serial", async ({ callbacks }) => {
					active += 1
					peak = Math.max(peak, active)
					await wait(5)
					callbacks.pushToolResult(name)
					active -= 1
				}),
			)
		}

		await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(response({ id: "1", name: "edit_one" }, { id: "2", name: "edit_two" }))

		expect(peak).toBe(1)
		expect(resultIds(task)).toEqual(["1", "2"])
	})

	it("isolates failures, deduplicates callbacks, and synthesizes empty output", async () => {
		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(
			descriptor("fails", "parallel", async ({ callbacks }) => {
				callbacks.pushToolResult("first")
				callbacks.pushToolResult("duplicate")
				throw new Error("boom")
			}),
		)
		registry.register(descriptor("empty", "parallel", async () => {}))

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(response({ id: "1", name: "fails" }, { id: "2", name: "empty" }))

		expect(outcome.results.map((result) => result.status)).toEqual(["error", "success"])
		expect(resultIds(task)).toEqual(["1", "2"])
		expect((task.userMessageContent as any[])[0].content).toBe("first")
		expect((task.userMessageContent as any[])[1].content).toBe("(tool did not return anything)")
	})

	it("executes a valid call when a later normalized call is malformed", async () => {
		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		let executed = 0
		registry.register(
			descriptor("read_one", "parallel", async ({ callbacks }) => {
				executed += 1
				callbacks.pushToolResult("valid")
			}),
		)
		registry.register(descriptor("read_two", "parallel", async () => void (executed += 100)))

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run({
			items: [
				{ type: "tool_call", id: "1", name: "read_one", arguments: {} },
				{ type: "error", message: "Unable to parse arguments", callId: "2", toolName: "read_two" },
			],
			text: "",
			reasoning: "",
			toolCalls: [{ type: "tool_call", id: "1", name: "read_one", arguments: {} }],
		})

		expect(executed).toBe(1)
		expect(outcome.results).toHaveLength(1)
		expect(outcome.batchSize).toBe(1)
		expect(resultIds(task)).toEqual(["1"])
	})

	it("serializes approval prompts while allowing approved sibling reads to run", async () => {
		const task = makeTask()
		let approvalsInFlight = 0
		let peakApprovals = 0
		task.ask = async () => {
			approvalsInFlight += 1
			peakApprovals = Math.max(peakApprovals, approvalsInFlight)
			await wait(5)
			approvalsInFlight -= 1
			return { response: "yesButtonClicked" } as any
		}

		const registry = new ToolRegistry({ includeBuiltIns: false })
		for (const name of ["read_one", "read_two"]) {
			registry.register(
				descriptor(name, "parallel", async ({ callbacks }) => {
					if (await callbacks.askApproval("tool", name)) {
						callbacks.pushToolResult(name)
					}
				}),
			)
		}

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(response({ id: "1", name: "read_one" }, { id: "2", name: "read_two" }))

		expect(outcome.status).toBe("completed")
		expect(peakApprovals).toBe(1)
		expect(resultIds(task)).toEqual(["1", "2"])
	})

	it("fences a barrier between the settled prefix and queued suffix", async () => {
		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		let activePrefixReads = 0
		let activePrefixReadsAtBarrier = -1
		let barrierFinished = false
		let suffixStartedAfterBarrier = false
		let startedPrefixReads = 0
		let releasePrefix!: () => void
		let signalPrefixStarted!: () => void
		let releaseBarrierApproval!: () => void
		let signalBarrierApproval!: () => void
		const prefixRelease = new Promise<void>((resolve) => {
			releasePrefix = resolve
		})
		const prefixStarted = new Promise<void>((resolve) => {
			signalPrefixStarted = resolve
		})
		const barrierApprovalRelease = new Promise<void>((resolve) => {
			releaseBarrierApproval = resolve
		})
		const barrierApprovalStarted = new Promise<void>((resolve) => {
			signalBarrierApproval = resolve
		})
		const prefixRead = async ({ callbacks }: Parameters<ToolDescriptor["execute"]>[0]) => {
			activePrefixReads += 1
			startedPrefixReads += 1
			if (startedPrefixReads === 2) signalPrefixStarted()
			await prefixRelease
			callbacks.pushToolResult("read complete")
			activePrefixReads -= 1
		}
		registry.register(descriptor("read_one", "parallel", prefixRead))
		registry.register(descriptor("read_two", "parallel", prefixRead))
		registry.register({
			...descriptor("complete", "barrier", async ({ callbacks }) => {
				activePrefixReadsAtBarrier = activePrefixReads
				if (await callbacks.askApproval("tool", "Approve completion")) {
					barrierFinished = true
					callbacks.pushToolResult("barrier complete")
				}
			}),
			capabilities: {
				concurrency: "barrier",
				sideEffects: "task",
				controlFlow: true,
				requiresApproval: true,
			},
		})
		registry.register(
			descriptor("read_after", "parallel", async ({ callbacks }) => {
				suffixStartedAfterBarrier = barrierFinished
				callbacks.pushToolResult("suffix complete")
			}),
		)
		let approvalCalls = 0
		task.ask = async () => {
			approvalCalls += 1
			signalBarrierApproval()
			await barrierApprovalRelease
			return { response: "yesButtonClicked" } as any
		}

		const run = new ToolScheduler({
			task,
			registry,
			mode: "code",
			executionMode: "selective-parallel",
			maxConcurrency: 2,
			validateCall: () => {},
		}).run(
			response(
				{ id: "1", name: "read_one" },
				{ id: "2", name: "read_two" },
				{ id: "3", name: "complete" },
				{ id: "4", name: "read_after" },
			),
		)

		await prefixStarted
		expect(activePrefixReads).toBe(2)
		expect(activePrefixReadsAtBarrier).toBe(-1)
		expect(approvalCalls).toBe(0)
		releasePrefix()
		await barrierApprovalStarted
		expect(activePrefixReadsAtBarrier).toBe(0)
		expect(approvalCalls).toBe(1)
		expect(suffixStartedAfterBarrier).toBe(false)
		releaseBarrierApproval()
		const outcome = await run

		expect(outcome.status).toBe("completed")
		expect(outcome.results).toHaveLength(4)
		expect(outcome.results.map((result) => result.status)).toEqual(["success", "success", "success", "success"])
		expect(suffixStartedAfterBarrier).toBe(true)
		expect(resultIds(task)).toEqual(["1", "2", "3", "4"])
	})

	it("cancels a barrier and gives every queued suffix call one terminal receipt", async () => {
		const task = makeTask()
		const controller = new AbortController()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		let barrierStarted!: () => void
		const barrierStartedPromise = new Promise<void>((resolve) => {
			barrierStarted = resolve
		})
		const suffix = vi.fn()
		registry.register(
			descriptor("read", "parallel", async ({ callbacks }) => {
				callbacks.pushToolResult("prefix complete")
			}),
		)
		registry.register(
			descriptor("wait", "barrier", async ({ signal }) => {
				if (!signal) throw new Error("The scheduler must pass its cancellation signal to barriers.")
				barrierStarted()
				await new Promise<void>((resolve) => {
					if (signal.aborted) {
						resolve()
					} else {
						signal.addEventListener("abort", () => resolve(), { once: true })
					}
				})
			}),
		)
		registry.register(
			descriptor("read_after", "parallel", async ({ callbacks }) => {
				suffix()
				callbacks.pushToolResult("must not start")
			}),
		)

		const run = new ToolScheduler({
			task,
			registry,
			mode: "code",
			executionMode: "selective-parallel",
			validateCall: () => {},
			signal: controller.signal,
			preserveAbortedResults: true,
		}).run(
			response(
				{ id: "prefix", name: "read" },
				{ id: "barrier", name: "wait" },
				{ id: "suffix", name: "read_after" },
			),
		)

		await barrierStartedPromise
		controller.abort()
		const outcome = await run

		expect(outcome.status).toBe("aborted")
		expect(outcome.results.map((result) => result.status)).toEqual(["success", "cancelled", "cancelled"])
		expect(resultIds(task)).toEqual(["prefix", "barrier", "suffix"])
		expect(new Set(resultIds(task)).size).toBe(3)
		expect(suffix).not.toHaveBeenCalled()
	})

	it("does not commit results after cancellation", async () => {
		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(
			descriptor("read", "parallel", async ({ callbacks }) => {
				await wait(20)
				callbacks.pushToolResult("late")
			}),
		)

		const run = new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(response({ id: "1", name: "read" }))
		setTimeout(() => {
			task.abort = true
		}, 5)

		const outcome = await run
		expect(outcome.status).toBe("aborted")
		expect(outcome.results).toHaveLength(1)
		expect(outcome.results[0].status).toBe("cancelled")
		expect(resultIds(task)).toEqual([])
	})

	it("publishes cancelled running and pending receipts without changing earlier completed receipts", async () => {
		const task = makeTask()
		const controller = new AbortController()
		const events: AgentTurnEvent[] = []
		const executions: string[] = []
		let release!: () => void
		const pending = new Promise<void>((resolve) => {
			release = resolve
		})
		let markStarted!: () => void
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		const completedContent = JSON.stringify({ status: "success", message: "Durably completed earlier effect." })
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(
			descriptor("mutation", "serial", async ({ callbacks }) => {
				callbacks.pushToolResult(completedContent)
			}),
		)
		registry.register(
			descriptor("read", "parallel", async ({ call, callbacks }) => {
				executions.push(call.id!)
				if (executions.length === 2) markStarted()
				await pending
				callbacks.pushToolResult(JSON.stringify({ status: "success", message: "Late read result." }))
			}),
		)
		const run = new ToolScheduler({
			task,
			registry,
			mode: "code",
			executionMode: "selective-parallel",
			maxConcurrency: 2,
			validateCall: () => {},
			signal: controller.signal,
			preserveAbortedResults: true,
			onEvent: (event) => {
				events.push(event)
			},
		}).run(
			response(
				{ id: "completed", name: "mutation" },
				{ id: "running-a", name: "read" },
				{ id: "running-b", name: "read" },
				{ id: "pending", name: "read" },
			),
		)

		await started
		controller.abort()
		release()
		const outcome = await run
		const statuses = ["success", "cancelled", "cancelled", "cancelled"]
		const published = task.userMessageContent.filter((item) => item.type === "tool_result")
		expect(outcome.status).toBe("aborted")
		expect(executions).toEqual(["running-a", "running-b"])
		expect(outcome.results.map((result) => result.status)).toEqual(statuses)
		expect(outcome.results.map((result) => JSON.parse(String(result.content)).status)).toEqual(statuses)
		expect(published.map((result) => JSON.parse(String(result.content)).status)).toEqual(statuses)
		expect(published.map((result) => result.is_error)).toEqual([false, true, true, true])
		expect(resultIds(task)).toEqual(["completed", "running-a", "running-b", "pending"])
		expect(published[0].content).toBe(completedContent)
		expect(events.filter((event) => event.type === "tool_result").map((event) => event.status)).toEqual(statuses)
	})

	it("preserves deterministic receipts for every call when cancellation wins", async () => {
		const task = makeTask()
		const controller = new AbortController()
		const events: any[] = []
		let executions = 0
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(
			descriptor("read", "serial", async ({ callbacks }) => {
				executions += 1
				await wait(10)
				callbacks.pushToolResult("late")
			}),
		)

		const run = new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
			signal: controller.signal,
			preserveAbortedResults: true,
			onEvent: (event) => {
				events.push(event)
			},
		}).run(response({ id: "1", name: "read" }, { id: "2", name: "read" }))
		setTimeout(() => controller.abort(), 2)

		const outcome = await run
		expect(outcome.status).toBe("aborted")
		expect(executions).toBe(1)
		expect(outcome.results.map((result) => result.status)).toEqual(["cancelled", "cancelled"])
		expect(resultIds(task)).toEqual(["1", "2"])
		expect(task.userMessageContentReady).toBe(true)
		expect(events.filter((event) => event.type === "tool_result").map((event) => event.callId)).toEqual(["1", "2"])
	})

	it("fails closed when the transcript fence rejects before an effect", async () => {
		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		let executions = 0
		registry.register(
			descriptor("mutation", "serial", async ({ callbacks }) => {
				executions += 1
				callbacks.pushToolResult("must not run")
			}),
		)

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
			beforeEffect: async () => {
				throw new Error("provider transcript receipt is stale")
			},
		}).run(response({ id: "stale", name: "mutation" }, { id: "unstarted", name: "mutation" }))

		expect(outcome.status).toBe("failed")
		expect(outcome.failure).toEqual({
			kind: "effect_fence",
			callId: "stale",
			message: "provider transcript receipt is stale",
		})
		expect(outcome.results.map((result) => result.status)).toEqual(["error", "error"])
		expect(executions).toBe(0)
		expect(resultIds(task)).toEqual(["stale", "unstarted"])
		expect(task.userMessageContentReady).toBe(true)
	})

	it("preserves completed effects when a later transcript fence rejects", async () => {
		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		let executions = 0
		let fenceChecks = 0
		registry.register(
			descriptor("mutation", "serial", async ({ callbacks }) => {
				executions += 1
				callbacks.pushToolResult(`completed-${executions}`)
			}),
		)

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
			beforeEffect: async () => {
				fenceChecks += 1
				if (fenceChecks === 2) throw new Error("receipt invalidated after first effect")
			},
		}).run(
			response(
				{ id: "completed", name: "mutation" },
				{ id: "blocked", name: "mutation" },
				{ id: "unstarted", name: "mutation" },
			),
		)

		expect(outcome.status).toBe("failed")
		expect(outcome.failure).toEqual({
			kind: "effect_fence",
			callId: "blocked",
			message: "receipt invalidated after first effect",
		})
		expect(executions).toBe(1)
		expect(outcome.results.map((result) => result.status)).toEqual(["success", "error", "error"])
		expect(outcome.results[0].content).toBe("completed-1")
		expect(resultIds(task)).toEqual(["completed", "blocked", "unstarted"])
	})

	it("enforces policy visibility and bounds tool output", async () => {
		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		let executions = 0
		registry.register({
			...descriptor("read", "parallel", async ({ callbacks }) => {
				executions += 1
				callbacks.pushToolResult("0123456789abcdefghijklmnopqrstuvwxyz")
			}),
			maxOutputChars: 100,
		})

		const policy = {
			visibleTools: ["read"],
			allowedTools: ["read"],
			disabledTools: [],
			approval: { autoApprovalEnabled: false, liveRevalidation: true },
			capabilities: {},
			outputLimits: { read: 16 },
			execution: {
				sandboxMode: "workspace-write",
				workspaceRoots: [],
				command: { allowedPrefixes: [], deniedPrefixes: [], userTimeoutMs: 0, timeoutAllowlist: [] },
				cancellation: "abort-process",
			},
			summary: "Sandbox: workspace-write",
			digest: "policy",
		} as const
		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
			policy,
		}).run(response({ id: "1", name: "read" }))

		expect(executions).toBe(1)
		expect(outcome.outputTruncatedCount).toBe(1)
		expect(outcome.results[0].truncated).toBe(true)
		expect(String((task.userMessageContent as any[])[0].content)).toContain("truncated")

		const hiddenTask = makeTask()
		const hiddenOutcome = await new ToolScheduler({
			task: hiddenTask,
			registry,
			mode: "code",
			validateCall: () => {},
			policy: { ...policy, visibleTools: [], allowedTools: [] },
		}).run(response({ id: "2", name: "read" }))

		expect(hiddenOutcome.results[0].status).toBe("error")
		expect(String((hiddenTask.userMessageContent as any[])[0].content)).toContain("not allowed")
	})

	it("passes the cancellation signal into active tool execution", async () => {
		const task = makeTask()
		const controller = new AbortController()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(
			descriptor("read", "parallel", async ({ callbacks, signal }) => {
				await wait(10)
				expect(signal?.aborted).toBe(true)
				callbacks.pushToolResult("cancelled")
			}),
		)

		const run = new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
			signal: controller.signal,
		}).run(response({ id: "1", name: "read" }))
		setTimeout(() => controller.abort(), 2)

		const outcome = await run
		expect(outcome.status).toBe("aborted")
		expect(resultIds(task)).toEqual([])
	})

	it("defaults to serial execution even when descriptors are parallel-safe", async () => {
		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		let active = 0
		let peak = 0
		for (const name of ["first", "second"]) {
			registry.register(
				descriptor(name, "parallel", async ({ callbacks }) => {
					active += 1
					peak = Math.max(peak, active)
					await wait(2)
					callbacks.pushToolResult(name)
					active -= 1
				}),
			)
		}

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(response({ id: "1", name: "first" }, { id: "2", name: "second" }))

		expect(peak).toBe(1)
		expect(outcome.parallelBatchCount).toBe(0)
		expect(outcome.parallelToolCount).toBe(0)
		expect(resultIds(task)).toEqual(["1", "2"])
	})

	it("bounds selective-parallel windows and keeps completion commits in model order", async () => {
		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		let active = 0
		let peak = 0
		for (let index = 0; index < 7; index += 1) {
			const name = `read-${index}`
			registry.register(
				descriptor(name, "parallel", async ({ callbacks }) => {
					active += 1
					peak = Math.max(peak, active)
					await wait(index % 2 === 0 ? 5 : 1)
					callbacks.pushToolResult(name)
					active -= 1
				}),
			)
		}

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			executionMode: "selective-parallel",
			maxConcurrency: 3,
			validateCall: () => {},
		}).run(response(...Array.from({ length: 7 }, (_, index) => ({ id: `${index}`, name: `read-${index}` }))))

		expect(peak).toBeLessThanOrEqual(3)
		expect(peak).toBeGreaterThan(1)
		expect(outcome.parallelBatchCount).toBe(3)
		expect(outcome.parallelToolCount).toBe(7)
		expect(resultIds(task)).toEqual(["0", "1", "2", "3", "4", "5", "6"])
		expect((task.userMessageContent as any[]).map((item) => item.content)).toEqual([
			"read-0",
			"read-1",
			"read-2",
			"read-3",
			"read-4",
			"read-5",
			"read-6",
		])
	})

	it("keeps a side-effecting descriptor serial even if it is incorrectly marked parallel", async () => {
		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		let active = 0
		let peak = 0
		for (const name of ["mutation-one", "mutation-two"]) {
			registry.register({
				...descriptor(name, "parallel", async ({ callbacks }) => {
					active += 1
					peak = Math.max(peak, active)
					await wait(2)
					callbacks.pushToolResult(name)
					active -= 1
				}),
				capabilities: {
					concurrency: "parallel",
					sideEffects: "workspace",
					controlFlow: false,
					requiresApproval: false,
				},
			})
		}

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			executionMode: "selective-parallel",
			validateCall: () => {},
		}).run(response({ id: "1", name: "mutation-one" }, { id: "2", name: "mutation-two" }))

		expect(peak).toBe(1)
		expect(outcome.parallelBatchCount).toBe(0)
		expect(resultIds(task)).toEqual(["1", "2"])
	})

	it("forwards a spawn explicit-approval flag independently of tool auto-approval", async () => {
		const task = makeTask()
		const ask = vi.fn(async () => ({ response: "noButtonClicked" as const }))
		task.ask = ask
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(
			descriptor("spawn_agent", "serial", async ({ callbacks }) => {
				const approved = await callbacks.askApproval(
					"tool",
					'{"tool":"spawnAgent"}',
					undefined,
					undefined,
					true,
				)
				callbacks.pushToolResult(approved ? "launched" : "denied")
			}),
		)
		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(response({ id: "spawn-explicit", name: "spawn_agent" }))

		expect(ask).toHaveBeenCalledWith("tool", '{"tool":"spawnAgent"}', false, undefined, false, true)
		expect(outcome.results[0].status).toBe("denied")
	})

	it("accepts a narrow execution host without requiring a concrete Task", async () => {
		const userMessageContent: any[] = []
		const host = {
			taskId: "host-only",
			cwd: process.cwd(),
			abort: false,
			userMessageContent,
			say: async () => {},
			recordToolUsage: () => {},
			pushToolResultToUserContent(result: any) {
				userMessageContent.push(result)
				return true
			},
		}
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(descriptor("host_read", "serial", async ({ callbacks }) => callbacks.pushToolResult("ok")))

		const outcome = await new ToolScheduler({
			executionHost: host,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(response({ id: "host-call", name: "host_read" }))

		expect(outcome.status).toBe("completed")
		expect(outcome.results[0].content).toBe("ok")
		expect(userMessageContent.map((item) => item.tool_use_id)).toEqual(["host-call"])
	})

	it("carries a command sidecar through the scheduler without rewriting provider history", async () => {
		const task = makeTask()
		const registry = new ToolRegistry({ includeBuiltIns: false })
		const commandResult = {
			wall_time_seconds: 0.125,
			output: "ready",
			session_id: 1,
		}
		const legacyContent =
			"Chunk ID: write-1\nWall time: 0.1250 seconds\nProcess running with session ID 1\nOutput:\nready"
		registry.register(
			descriptor("write_stdin", "serial", async ({ callbacks }) => {
				callbacks.pushToolResult(legacyContent)
				callbacks.setResultMetadata?.({ status: "success", executionStatus: "running", commandResult })
			}),
		)

		const outcome = await new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run(response({ id: "write-1", name: "write_stdin" }))

		expect(outcome.status).toBe("completed")
		expect(outcome.results[0]).toMatchObject({
			status: "success",
			executionStatus: "running",
			content: legacyContent,
			commandResult,
		})
		expect(task.userMessageContent).toContainEqual(
			expect.objectContaining({
				type: "tool_result",
				tool_use_id: "write-1",
				content: legacyContent,
			}),
		)
	})

	it("releases an approval lane when cancellation arrives before the host responds", async () => {
		const task = makeTask()
		task.ask = async () => await new Promise<never>(() => {})
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register(
			descriptor("approval_read", "parallel", async ({ callbacks }) => {
				if (await callbacks.askApproval("tool", "waiting")) {
					callbacks.pushToolResult("unexpected")
				}
			}),
		)
		const controller = new AbortController()
		const run = new ToolScheduler({
			task,
			registry,
			mode: "code",
			validateCall: () => {},
			signal: controller.signal,
		}).run(response({ id: "approval-cancel", name: "approval_read" }))
		setTimeout(() => controller.abort(), 2)

		const outcome = await run
		expect(outcome.status).toBe("aborted")
		expect(outcome.results).toHaveLength(1)
		expect(outcome.results[0].status).toBe("cancelled")
		expect(resultIds(task)).toEqual([])
	})
})
