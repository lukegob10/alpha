import type { AlphaMessage } from "@alpha-code/types"
import { fileChangeTurnsFromMessages, fileChangesFromMessages } from "../components/chat/utils/fileChangesFromMessages"

function msg(overrides: Partial<AlphaMessage> & { text: string }): AlphaMessage {
	return {
		type: "say",
		say: "tool",
		ts: Date.now(),
		partial: false,
		...overrides,
	}
}

function completedCommandEdit(
	path: string,
	diff: string,
	commandExecutionId: string,
	originalContent = "before\n",
	finalContent = "after\n",
): AlphaMessage {
	return msg({
		text: JSON.stringify({
			tool: "appliedDiff",
			path,
			diff,
			diffStats: { added: 1, removed: 1 },
			originalContent,
			finalContent,
			changeStatus: "applied",
			commandExecutionId,
		}),
	})
}

describe("fileChangesFromMessages", () => {
	it("returns empty array for undefined messages", () => {
		expect(fileChangesFromMessages(undefined)).toEqual([])
	})

	it("returns empty array for empty messages", () => {
		expect(fileChangesFromMessages([])).toEqual([])
	})

	it("ignores non-tool messages", () => {
		const messages: AlphaMessage[] = [
			msg({ type: "say", say: "text", text: "hello" }),
			msg({ type: "ask", ask: "followup", text: "world" }),
		]
		expect(fileChangesFromMessages(messages)).toEqual([])
	})

	it("ignores tool messages with non-file-edit tool type", () => {
		const messages: AlphaMessage[] = [
			msg({
				type: "ask",
				ask: "tool",
				text: JSON.stringify({ tool: "read_file", path: "a.ts" }),
			}),
		]
		expect(fileChangesFromMessages(messages)).toEqual([])
	})

	it("skips partial messages", () => {
		const messages: AlphaMessage[] = [
			msg({
				type: "ask",
				ask: "tool",
				partial: true,
				text: JSON.stringify({
					tool: "appliedDiff",
					path: "src/file.ts",
					diff: "+x",
				}),
			}),
		]
		expect(fileChangesFromMessages(messages)).toEqual([])
	})

	it("excludes ask tool file-edit when isAnswered is false or undefined", () => {
		const payload = JSON.stringify({
			tool: "appliedDiff",
			path: "src/foo.ts",
			diff: "+line",
		})
		expect(fileChangesFromMessages([msg({ type: "ask", ask: "tool", text: payload, isAnswered: false })])).toEqual(
			[],
		)
		expect(fileChangesFromMessages([msg({ type: "ask", ask: "tool", text: payload })])).toEqual([])
	})

	it("includes ask tool file-edit when isAnswered is true", () => {
		const messages: AlphaMessage[] = [
			msg({
				type: "ask",
				ask: "tool",
				isAnswered: true,
				text: JSON.stringify({
					tool: "appliedDiff",
					path: "src/foo.ts",
					diff: "+line",
				}),
			}),
		]
		const result = fileChangesFromMessages(messages)
		expect(result).toHaveLength(1)
		expect(result[0].path).toBe("src/foo.ts")
	})

	it("extracts single-file edit from ask tool message", () => {
		const messages: AlphaMessage[] = [
			msg({
				type: "ask",
				ask: "tool",
				isAnswered: true,
				text: JSON.stringify({
					tool: "appliedDiff",
					path: "src/foo.ts",
					diff: "@@ -1 +1 @@\n+line",
					diffStats: { added: 1, removed: 0 },
				}),
			}),
		]
		const result = fileChangesFromMessages(messages)
		expect(result).toHaveLength(1)
		expect(result[0]).toEqual({
			path: "src/foo.ts",
			diff: "@@ -1 +1 @@\n+line",
			diffStats: { added: 1, removed: 0 },
		})
	})

	it("extracts single-file edit from say tool message", () => {
		const messages: AlphaMessage[] = [
			msg({
				type: "say",
				say: "tool",
				text: JSON.stringify({
					tool: "editedExistingFile",
					path: "lib/bar.ts",
					diff: "-old\n+new",
				}),
			}),
		]
		const result = fileChangesFromMessages(messages)
		expect(result).toHaveLength(1)
		expect(result[0].path).toBe("lib/bar.ts")
		expect(result[0].diff).toBe("-old\n+new")
	})

	it("projects completed command edits with their captured before and after content", () => {
		const result = fileChangesFromMessages([
			completedCommandEdit("src/file.ts", "@@ -1 +1 @@\n-before\n+after", "run-1"),
		])

		expect(result).toEqual([
			{
				path: "src/file.ts",
				diff: "@@ -1 +1 @@\n-before\n+after",
				diffStats: { added: 1, removed: 1 },
				originalContent: "before\n",
				finalContent: "after\n",
				commandExecutionId: "run-1",
			},
		])
	})

	it("prefers the canonical unified content over a raw apply_diff instruction", () => {
		const result = fileChangesFromMessages([
			msg({
				text: JSON.stringify({
					tool: "appliedDiff",
					path: "src/file.ts",
					diff: "<<<<<<< SEARCH\n-old\n=======\n+new\n>>>>>>> REPLACE",
					content: "--- src/file.ts\n+++ src/file.ts\n@@ -1 +1 @@\n-old\n+new",
				}),
			}),
		])

		expect(result[0]?.diff).toBe("--- src/file.ts\n+++ src/file.ts\n@@ -1 +1 @@\n-old\n+new")
	})

	it("uses a completed record once instead of also counting its answered approval preview", () => {
		const diff = "@@ -1 +1 @@\n-before\n+after"
		const preview = msg({
			type: "ask",
			ask: "tool",
			isAnswered: true,
			text: JSON.stringify({
				tool: "appliedDiff",
				path: "./src/file.ts",
				diff,
				diffStats: { added: 9, removed: 9 },
			}),
		})
		const result = fileChangesFromMessages([preview, completedCommandEdit("src/file.ts", diff, "run-1")])

		expect(result).toHaveLength(1)
		expect(result[0]).toMatchObject({
			path: "src/file.ts",
			diffStats: { added: 1, removed: 1 },
			commandExecutionId: "run-1",
		})
	})

	it("retains separate edits to the same path across completed command executions", () => {
		const messages = [
			completedCommandEdit("src/file.ts", "-before\n+middle", "run-1", "before\n", "middle\n"),
			completedCommandEdit("src/file.ts", "-middle\n+after", "run-2", "middle\n", "after\n"),
		]

		expect(fileChangesFromMessages(messages).map((entry) => entry.commandExecutionId)).toEqual(["run-1", "run-2"])
	})

	it("matches at most one identical preview per completion and keeps unrelated edits", () => {
		const preview = (path: string, diff: string) =>
			msg({
				type: "ask",
				ask: "tool",
				isAnswered: true,
				text: JSON.stringify({ tool: "appliedDiff", path, diff }),
			})
		const result = fileChangesFromMessages([
			preview("src/file.ts", "-before\n+after"),
			preview("src/file.ts", "-before\n+after"),
			preview("src/file.ts", "-different\n+other"),
			completedCommandEdit("src/file.ts", "-before\n+after", "run-1"),
		])

		expect(result).toHaveLength(3)
		expect(result.filter((entry) => entry.commandExecutionId === "run-1")).toHaveLength(1)
		expect(result.filter((entry) => entry.diff === "-before\n+after")).toHaveLength(2)
		expect(result.some((entry) => entry.diff === "-different\n+other")).toBe(true)
	})

	it("does not merge identical diff text from different physical executions", () => {
		const preview = msg({
			type: "ask",
			ask: "tool",
			isAnswered: true,
			commandExecutionId: "run-1",
			text: JSON.stringify({ tool: "appliedDiff", path: "src/file.ts", diff: "-before\n+after" }),
		})
		const completed = completedCommandEdit("src/file.ts", "-before\n+after", "run-2")

		expect(fileChangesFromMessages([preview, completed])).toHaveLength(2)
	})

	it("ignores cancelled, incomplete, and empty command change records", () => {
		const applied = completedCommandEdit("src/file.ts", "-before\n+after", "run-1")
		const cancelled = msg({ ...applied, text: applied.text!.replace('"applied"', '"cancelled"') })
		const failed = msg({ ...applied, text: applied.text!.replace('"applied"', '"failed"') })
		const incomplete: AlphaMessage = { ...applied, partial: true }
		const empty = completedCommandEdit("src/file.ts", "", "run-2")

		expect(fileChangesFromMessages([cancelled, failed, incomplete, empty])).toEqual([])
	})

	it("uses content when diff is missing for single-file", () => {
		const messages: AlphaMessage[] = [
			msg({
				type: "ask",
				ask: "tool",
				isAnswered: true,
				text: JSON.stringify({
					tool: "newFileCreated",
					path: "new.ts",
					content: "full file content",
				}),
			}),
		]
		const result = fileChangesFromMessages(messages)
		expect(result).toHaveLength(1)
		expect(result[0].diff).toBe("full file content")
	})

	it("ignores single-file tool when path is missing", () => {
		const messages: AlphaMessage[] = [
			msg({
				type: "ask",
				ask: "tool",
				text: JSON.stringify({
					tool: "appliedDiff",
					diff: "something",
				}),
			}),
		]
		expect(fileChangesFromMessages(messages)).toEqual([])
	})

	it("ignores single-file tool when diff and content are empty", () => {
		const messages: AlphaMessage[] = [
			msg({
				type: "ask",
				ask: "tool",
				text: JSON.stringify({
					tool: "appliedDiff",
					path: "x.ts",
				}),
			}),
		]
		expect(fileChangesFromMessages(messages)).toEqual([])
	})

	it("extracts from batchDiffs", () => {
		const messages: AlphaMessage[] = [
			msg({
				type: "ask",
				ask: "tool",
				isAnswered: true,
				text: JSON.stringify({
					tool: "appliedDiff",
					batchDiffs: [
						{ path: "a.ts", content: "content a" },
						{ path: "b.ts", diffs: [{ content: "content b" }] },
						{ path: "c.ts" }, // no content
					],
				}),
			}),
		]
		const result = fileChangesFromMessages(messages)
		expect(result).toHaveLength(2)
		expect(result[0]).toEqual({ path: "a.ts", diff: "content a" })
		expect(result[1].path).toBe("b.ts")
		expect(result[1].diff).toBe("content b")
	})

	it("includes diffStats from batchDiffs when present", () => {
		const messages: AlphaMessage[] = [
			msg({
				type: "ask",
				ask: "tool",
				isAnswered: true,
				text: JSON.stringify({
					tool: "appliedDiff",
					batchDiffs: [
						{
							path: "f.ts",
							content: "x",
							diffStats: { added: 2, removed: 1 },
						},
					],
				}),
			}),
		]
		const result = fileChangesFromMessages(messages)
		expect(result[0].diffStats).toEqual({ added: 2, removed: 1 })
	})

	it("recognizes all supported file-edit tool names", () => {
		const tools = [
			"editedExistingFile",
			"appliedDiff",
			"newFileCreated",
			"insertContent",
			"searchAndReplace",
			"search_and_replace",
			"search_replace",
			"edit",
			"edit_file",
			"apply_patch",
			"apply_diff",
		]
		for (const tool of tools) {
			const messages: AlphaMessage[] = [
				msg({
					type: "ask",
					ask: "tool",
					isAnswered: true,
					text: JSON.stringify({
						tool,
						path: "f.ts",
						diff: "d",
					}),
				}),
			]
			const result = fileChangesFromMessages(messages)
			expect(result).toHaveLength(1)
			expect(result[0].path).toBe("f.ts")
		}
	})

	it("returns multiple entries for multiple file-edit messages", () => {
		const messages: AlphaMessage[] = [
			msg({
				type: "ask",
				ask: "tool",
				isAnswered: true,
				text: JSON.stringify({
					tool: "appliedDiff",
					path: "first.ts",
					diff: "a",
				}),
			}),
			msg({
				type: "ask",
				ask: "tool",
				isAnswered: true,
				text: JSON.stringify({
					tool: "editedExistingFile",
					path: "second.ts",
					diff: "b",
				}),
			}),
		]
		const result = fileChangesFromMessages(messages)
		expect(result).toHaveLength(2)
		expect(result[0].path).toBe("first.ts")
		expect(result[1].path).toBe("second.ts")
	})

	it("keeps applied edits attached to their own follow-up turn", () => {
		const messages: AlphaMessage[] = [
			msg({
				type: "ask",
				ask: "tool",
				ts: 1,
				isAnswered: true,
				text: JSON.stringify({ tool: "appliedDiff", path: "first.ts", diff: "+first" }),
			}),
			msg({ type: "say", say: "completion_result", ts: 2, text: "First response" }),
			msg({ type: "say", say: "user_feedback", ts: 3, text: "Now make another change" }),
			msg({
				type: "ask",
				ask: "tool",
				ts: 4,
				isAnswered: true,
				text: JSON.stringify({ tool: "appliedDiff", path: "second.ts", diff: "+second" }),
			}),
		]

		const turns = fileChangeTurnsFromMessages(messages, "task")

		expect(turns).toHaveLength(2)
		expect(turns.map((turn) => turn.key)).toEqual(["task:1", "task:3"])
		expect(turns.map((turn) => turn.endIndex)).toEqual([1, 3])
		expect(turns.map((turn) => fileChangesFromMessages(turn.messages).map((entry) => entry.path))).toEqual([
			["first.ts"],
			["second.ts"],
		])
	})

	it("skips invalid JSON in message text", () => {
		const messages: AlphaMessage[] = [
			msg({
				type: "ask",
				ask: "tool",
				text: "not json",
			}),
		]
		expect(fileChangesFromMessages(messages)).toEqual([])
	})
})
