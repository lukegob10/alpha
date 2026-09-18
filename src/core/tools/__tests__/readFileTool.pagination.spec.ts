import * as fs from "fs/promises"
import { readFileTool } from "../ReadFileTool"
import type { Task } from "../../task/Task"
import type { ReadFileToolParams } from "@alpha-code/types"
import { ToolRegistry } from "../ToolRegistry"
import { ToolScheduler, type ToolExecutionHost } from "../../agent/ToolScheduler"
import { NativeToolCallParser } from "../../assistant-message/NativeToolCallParser"

vi.mock("fs/promises", () => ({ readFile: vi.fn(), stat: vi.fn() }))
vi.mock("isbinaryfile", () => ({ isBinaryFile: vi.fn(async () => false) }))

function harness(content: string, budget = 32_000) {
	vi.mocked(fs.readFile).mockResolvedValue(Buffer.from(content))
	vi.mocked(fs.stat).mockResolvedValue({ isDirectory: () => false } as Awaited<ReturnType<typeof fs.stat>>)
	const task = {
		cwd: "/workspace",
		api: { getModel: () => ({ info: {} }) },
		alphaIgnoreController: { validateAccess: () => true },
		fileContextTracker: { trackFileContext: vi.fn() },
		providerRef: { deref: () => ({ getState: async () => ({}) }) },
		say: vi.fn(),
	}
	const callbacks = {
		pushToolResult: vi.fn(),
		askApproval: vi.fn(async () => true),
		askApprovalResponse: vi.fn(async () => ({ response: "yesButtonClicked" as const })),
		handleError: vi.fn(),
		setResultMetadata: vi.fn(),
		getRemainingOutputChars: () => budget,
	}
	return {
		task,
		callbacks,
		async read(params: ReadFileToolParams) {
			callbacks.pushToolResult.mockClear()
			await readFileTool.execute(params, task as unknown as Task, callbacks)
			return String(callbacks.pushToolResult.mock.calls[0]?.[0])
		},
	}
}

function continuation(text: string): ReadFileToolParams {
	const match = text.match(/^Continuation: (.+)$/m)
	expect(match, "A partial read must expose its actual continuation").not.toBeNull()
	return JSON.parse(match![1]) as ReadFileToolParams
}

describe("read_file delivered evidence", () => {
	it("returns an out-of-bounds offset to the model for repair without an extension diagnostic", async () => {
		const { read, task, callbacks } = harness(
			Array.from({ length: 72 }, (_, index) => `line ${index + 1}`).join("\n"),
		)
		const file = ".agents/skills/skill-builder/templates/skill/SKILL.template.md"
		const result = await read({ path: file, offset: 180 })
		expect(result).toContain("offset 180 is beyond file end (72 lines)")
		expect(result).toContain("1-72")
		expect(result).toContain("omit offset")
		expect(callbacks.pushToolResult).toHaveBeenCalledOnce()
		expect(callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
		expect(task.say).not.toHaveBeenCalledWith("error", expect.anything())
		expect(task.fileContextTracker.trackFileContext).not.toHaveBeenCalled()

		callbacks.setResultMetadata.mockClear()
		const corrected = await read({ path: file, offset: 60 })
		expect(corrected).toContain("60 | line 60")
		expect(corrected).toContain("72 | line 72")
		expect(callbacks.setResultMetadata).toHaveBeenCalledWith(expect.objectContaining({ status: "success" }))
		expect(task.say).not.toHaveBeenCalledWith("error", expect.anything())
	})

	it("keeps valid batch reads when another file has an out-of-bounds offset", async () => {
		const { read, task, callbacks } = harness("first\nsecond")
		const result = await read({
			files: [
				{ path: "short.md", offset: 180 },
				{ path: "valid.md", offset: 2 },
			],
		})
		expect(result).toContain("offset 180 is beyond file end (2 lines)")
		expect(result).toContain("File: valid.md\n2 | second")
		expect(callbacks.pushToolResult).toHaveBeenCalledOnce()
		const metadata = Object.assign({}, ...callbacks.setResultMetadata.mock.calls.map(([value]) => value))
		expect(metadata.status).toBe("error")
		expect(metadata.trustedProgress).toHaveLength(1)
		expect(task.say).not.toHaveBeenCalledWith("error", expect.anything())
	})

	it("rejects altered cursors as invalid rather than reporting a file change", async () => {
		const { read, task } = harness("one\ntwo\nthree")
		const next = continuation(await read({ path: "one.ts", limit: 1 }))
		const cursor = next.continuation!
		expect(cursor.length).toBeLessThan(160)
		expect(
			await read({ ...next, continuation: cursor.slice(0, -1) + (cursor.endsWith("a") ? "b" : "a") }),
		).toContain("Invalid read continuation. Copy the complete continuation exactly")
		expect(await read(next)).toContain("2 | two")
		expect(task.say).not.toHaveBeenCalledWith("error", expect.anything())
	})

	it("continues legacy v1 cursors from saved tool results", async () => {
		const { createHash } = await import("crypto")
		const path = await import("path")
		const hash = (value: string) => createHash("sha256").update(value).digest("hex")
		const { read } = harness("one\ntwo\nthree")
		const cursor = Buffer.from(
			JSON.stringify({
				v: 1,
				file: hash(path.resolve("/workspace", "one.ts")),
				version: hash("one\ntwo\nthree"),
				ranges: [[2, 3]],
				column: 0,
				limit: 2,
			}),
		).toString("base64url")
		expect(await read({ path: "one.ts", continuation: cursor })).toBe("File: one.ts\n2 | two\n3 | three")
	})
	it("reports an invalid indentation anchor as an error rather than an empty successful read", async () => {
		const { read, task, callbacks } = harness("one\ntwo")
		const result = await read({ path: "short.ts", mode: "indentation", indentation: { anchor_line: 10 } })
		expect(result).toContain("anchor_line 10 is out of range")
		expect(callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
		expect(result).toContain("Read a valid anchor")
		expect(task.say).not.toHaveBeenCalledWith("error", expect.anything())
	})

	it.each([[[2, 2]], ["2-2"]])("reads saved range formats after parser normalization: %j", async (range) => {
		const parsed = NativeToolCallParser.parseToolCall({
			id: "saved-read",
			name: "read_file",
			arguments: JSON.stringify({ files: [{ path: "saved.ts", line_ranges: [range] }] }),
		})
		expect(parsed?.type).toBe("tool_use")
		if (parsed?.type !== "tool_use" || !parsed.nativeArgs) throw new Error("Expected a parsed file read")
		const { read } = harness("one\ntwo\nthree")
		const result = await read(parsed.nativeArgs)
		expect(result).toBe("File: saved.ts\n2 | two")
	})

	it("preserves the continuation through the real scheduler with approval feedback", async () => {
		const { task } = harness("source data ".repeat(6).concat("\n").repeat(500))
		const host: ToolExecutionHost = {
			taskId: "read-budget",
			cwd: task.cwd,
			userMessageContent: [],
			say: async () => {},
			recordToolUsage: () => {},
			askApproval: async () => ({ response: "yesButtonClicked", text: "Check the relevant section." }),
			pushToolResultToUserContent: (result) => {
				host.userMessageContent.push(result)
				return true
			},
		}
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register({
			name: "read_file",
			aliases: [],
			schema: { type: "function", function: { name: "read_file", parameters: { type: "object" } } },
			capabilities: { concurrency: "serial", sideEffects: "none", requiresApproval: true, controlFlow: false },
			maxOutputChars: 1600,
			execute: async ({ callbacks }) =>
				readFileTool.execute({ path: "large.ts" }, task as unknown as Task, callbacks),
		})
		const result = await new ToolScheduler({
			executionHost: host,
			registry,
			mode: "code",
			validateCall: () => {},
		}).run([{ type: "tool_call", id: "read-1", name: "read_file", arguments: { path: "large.ts" } }])
		expect(result.results[0].status).toBe("success")
		expect(result.results[0].truncated).toBe(false)
		const content = String(result.results[0].content)
		expect(content.length).toBeLessThanOrEqual(1600)
		expect(content).toContain("Check the relevant section.")
		expect(content).toContain("Continuation:")
		expect(result.results[0].trustedProgress).toBeDefined()
		expect(host.userMessageContent).toHaveLength(1)
	})

	it("delivers one failed read result and allows a corrected request through the scheduler", async () => {
		const { task } = harness(Array.from({ length: 72 }, (_, index) => `line ${index + 1}`).join("\n"))
		const host: ToolExecutionHost = {
			taskId: "read-recovery",
			cwd: task.cwd,
			userMessageContent: [],
			say: async () => {},
			recordToolUsage: () => {},
			askApproval: async () => ({ response: "yesButtonClicked" }),
			pushToolResultToUserContent: (result) => {
				host.userMessageContent.push(result)
				return true
			},
		}
		const registry = new ToolRegistry({ includeBuiltIns: false })
		registry.register({
			...new ToolRegistry().resolve("read_file")!,
			execute: async ({ call, callbacks }) =>
				readFileTool.execute(call.nativeArgs as ReadFileToolParams, task as unknown as Task, callbacks),
		})
		const scheduler = new ToolScheduler({ executionHost: host, registry, mode: "code", validateCall: () => {} })
		const first = await scheduler.run([
			{ type: "tool_call", id: "bad-read", name: "read_file", arguments: { path: "template.md", offset: 180 } },
		])
		expect(first.results[0]).toMatchObject({ status: "error", content: expect.stringContaining("1-72") })
		expect(first.results[0].trustedProgress).toBeUndefined()
		expect(host.userMessageContent).toHaveLength(1)
		expect(host.userMessageContent[0]).toMatchObject({
			type: "tool_result",
			tool_use_id: "bad-read",
			is_error: true,
		})
		const corrected = await scheduler.run([
			{
				type: "tool_call",
				id: "corrected-read",
				name: "read_file",
				arguments: { path: "template.md", offset: 60 },
			},
		])
		expect(corrected.results[0]).toMatchObject({
			status: "success",
			content: expect.stringContaining("72 | line 72"),
		})
		expect(corrected.results[0].trustedProgress).toBeDefined()
		expect(host.userMessageContent).toHaveLength(2)
		expect(host.userMessageContent[1]).toMatchObject({ type: "tool_result", tool_use_id: "corrected-read" })
		expect(task.say).not.toHaveBeenCalledWith("error", expect.anything())
	})

	it("preserves the complete structural selection across pages", async () => {
		const { read } = harness(
			'import x from "x"\n\nfunction selected() {\n  first()\n  second()\n}\n\nfunction unrelated() {}',
		)
		const complete = await read({ path: "block.ts", mode: "indentation", indentation: { anchor_line: 4 } })
		let params: ReadFileToolParams = {
			path: "block.ts",
			mode: "indentation",
			limit: 2,
			indentation: { anchor_line: 4 },
		}
		const rows: string[] = []
		for (let page = 0; page < 8; page++) {
			const output = await read(params)
			rows.push(...[...output.matchAll(/^(\d+) \| (.*)$/gm)].map((match) => match[0]))
			if (!output.includes("Continuation:")) break
			params = continuation(output)
		}
		expect(rows).toEqual([...complete.matchAll(/^(\d+) \| (.*)$/gm)].map((match) => match[0]))
		expect(rows).toContain("5 |   second()")
		expect(rows.join("\n")).not.toContain("unrelated")
		expect(new Set(rows).size).toBe(rows.length)
	})

	it("returns a complete small selection even when no continuation envelope would fit", async () => {
		const { read } = harness("complete", 80)
		expect(await read({ path: "small.ts" })).toBe("File: small.ts\n1 | complete")
	})

	it.each(["not-a-cursor", Buffer.from(JSON.stringify({ v: 1, ranges: [[1, 0]] })).toString("base64url")])(
		"rejects malformed cursors: %s",
		async (cursor) => {
			const { read, task } = harness("source")
			expect(await read({ path: "one.ts", continuation: cursor })).toContain("Invalid read continuation")
			expect(task.say).not.toHaveBeenCalledWith("error", expect.anything())
		},
	)
	it("round-trips an oversized Unicode line without dropping its tail", async () => {
		const content = "🙂".repeat(3000) + "END\nlast line"
		const { read } = harness(content, 1800)
		let params: ReadFileToolParams = { path: "long.ts" }
		const fragments: string[] = []
		for (let page = 0; page < 20; page++) {
			const result = await read(params)
			expect(result.length).toBeLessThanOrEqual(1800)
			for (const match of result.matchAll(/^1(?::\d+)? \| (.*)$/gm))
				fragments.push(match[1].replace(/ \[partial line\]$/, ""))
			if (!result.includes("Continuation:")) break
			params = continuation(result)
		}
		expect(fragments.join("")).toBe(content.split("\n")[0])
	})

	it("rejects a continuation after the underlying content changes", async () => {
		const { read, task } = harness("first\nsecond\nthird")
		const next = continuation(await read({ path: "changed.ts", limit: 1 }))
		vi.mocked(fs.readFile).mockResolvedValue(Buffer.from("external change\nsecond\nthird"))
		expect(await read(next)).toContain("File changed since the previous read")
		expect(task.say).not.toHaveBeenCalledWith("error", expect.anything())
	})

	it("rejects using a continuation for another path", async () => {
		const { read, task } = harness("first\nsecond")
		const next = continuation(await read({ path: "one.ts", limit: 1 }))
		expect(await read({ ...next, path: "other.ts" })).toContain("belongs to a different file")
		expect(task.say).not.toHaveBeenCalledWith("error", expect.anything())
	})

	it("continues disjoint selected ranges without claiming the gap was read", async () => {
		const { read } = harness(Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"))
		const first = await read({
			files: [
				{
					path: "ranges.ts",
					line_ranges: [
						{ start: 2, end: 3 },
						{ start: 10, end: 11 },
					],
				},
			],
			limit: 2,
		})
		const second = await read(continuation(first))
		expect(first).toContain("2 | line 2\n3 | line 3")
		expect(second).toContain("10 | line 10\n11 | line 11")
		expect(second).not.toContain("Continuation:")
	})

	it("keeps every batch member visible within one shared allowance", async () => {
		const { read } = harness("long source line ".repeat(4) + "\n" + "more source\n".repeat(1000), 5000)
		const result = await read({ files: [{ path: "one.ts" }, { path: "two.ts" }, { path: "three.ts" }] })
		expect(result.length).toBeLessThanOrEqual(5000)
		for (const file of ["one.ts", "two.ts", "three.ts"]) expect(result).toContain(`File: ${file}\n1 |`)
		expect([...result.matchAll(/^Continuation:/gm)]).toHaveLength(3)
	})

	it("supports different selections of the same file in a batch", async () => {
		const { read } = harness("first\nsecond\nthird\nfourth")
		const result = await read({
			files: [
				{ path: "same.ts", offset: 1, limit: 1 },
				{ path: "same.ts", offset: 3, limit: 1 },
			],
		})
		expect(result).toContain("1 | first")
		expect(result).toContain("3 | third")
		expect(result).not.toContain("2 | second")
	})

	it("per-file nulls inherit batch defaults", async () => {
		const { read } = harness("first\nsecond\nthird")
		const result = await read({
			files: [{ path: "one.ts", offset: null, limit: null }],
			offset: 2,
			limit: 1,
		} as unknown as ReadFileToolParams)
		expect(result).toContain("2 | second")
		expect(result).not.toMatch(/^[13] \|/m)
	})
	it("fits complete lines inside the harness limit and resumes without a hole", async () => {
		const content = Array.from({ length: 2500 }, (_, i) => `source ${i + 1} ${"x".repeat(44)}`).join("\n")
		const { read } = harness(content)
		const first = await read({ path: "large.ts" })
		expect(first.length).toBeLessThanOrEqual(32_000)
		const lines = [...first.matchAll(/^\s*(\d+) \| (.*)$/gm)]
		expect(lines.length).toBeGreaterThan(0)
		for (const line of lines) expect(line[2]).toBe(`source ${line[1]} ${"x".repeat(44)}`)
		const second = await read(continuation(first))
		expect(Number(second.match(/^\s*(\d+) \|/m)![1])).toBe(Number(lines.at(-1)![1]) + 1)
	})

	it("honors batch defaults and nullable optional ranges", async () => {
		const { read } = harness(Array.from({ length: 320 }, (_, i) => `record ${i + 1}`).join("\n"))
		const result = await read({
			path: "one.ts",
			files: [{ path: "one.ts", line_ranges: null }, { path: "two.ts" }],
			offset: 220,
			limit: 3,
		} as unknown as ReadFileToolParams)
		expect(result).not.toContain("Error:")
		for (const line of [220, 221, 222])
			expect(result.match(new RegExp(`\\b${line} \\| record ${line}`, "g"))).toHaveLength(2)
		expect(result).not.toMatch(/\b(?:1|219|223) \| record /)
	})
})
