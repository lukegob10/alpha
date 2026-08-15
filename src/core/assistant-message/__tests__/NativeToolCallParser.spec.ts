import { NativeToolCallParser } from "../NativeToolCallParser"

describe("NativeToolCallParser", () => {
	beforeEach(() => {
		NativeToolCallParser.clearAllStreamingToolCalls()
		NativeToolCallParser.clearRawChunkState()
	})

	describe("parseToolCall", () => {
		it("preserves a structured sub-agent completion outcome", () => {
			const result = NativeToolCallParser.parseToolCall({
				id: "subagent-completion",
				name: "attempt_completion",
				arguments: JSON.stringify({
					result: "Write authority was unavailable.",
					outcome: "blocked",
				}),
			})

			expect(result?.type).toBe("tool_use")
			if (result?.type === "tool_use") {
				expect(result.nativeArgs).toEqual({
					result: "Write authority was unavailable.",
					outcome: "blocked",
				})
			}
		})

		it("accepts a null outcome from an OpenAI strict schema as omitted", () => {
			const result = NativeToolCallParser.parseToolCall({
				id: "primary-completion",
				name: "attempt_completion",
				arguments: JSON.stringify({ result: "Done.", outcome: null }),
			})

			expect(result?.type).toBe("tool_use")
			if (result?.type === "tool_use") {
				expect(result.nativeArgs).toEqual({ result: "Done." })
			}
		})

		it("rejects an unknown completion outcome instead of treating it as success", () => {
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
			const result = NativeToolCallParser.parseToolCall({
				id: "invalid-completion",
				name: "attempt_completion",
				arguments: JSON.stringify({ result: "Maybe done.", outcome: "partial" }),
			})

			expect(result).toBeNull()
			expect(errorSpy).toHaveBeenCalled()
			errorSpy.mockRestore()
		})

		describe("spawn_agent tool", () => {
			it.each([
				{
					label: "explore",
					payload: {
						objective: "Map the parser lifecycle.",
						agent_kind: "explore",
						write_scope: null,
						expected_output: null,
					},
				},
				{
					label: "review",
					payload: {
						objective: "Review the parser validation boundary.",
						agent_kind: "review",
						write_scope: null,
						expected_output: ["risk summary"],
					},
				},
				{
					label: "worker",
					payload: {
						objective: "Add focused parser coverage.",
						agent_kind: "worker",
						write_scope: ["src/core/assistant-message"],
						expected_output: [],
					},
				},
			])("parses a valid $label payload", ({ label, payload }) => {
				const result = NativeToolCallParser.parseToolCall({
					id: `spawn-${label}`,
					name: "spawn_agent",
					arguments: JSON.stringify(payload),
				})

				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					expect(result.nativeArgs).toEqual(payload)
				}
			})

			it.each([
				[
					"unknown role",
					{
						objective: "Inspect the parser.",
						agent_kind: "research",
						write_scope: null,
						expected_output: null,
					},
				],
				[
					"read-only role with write scope",
					{
						objective: "Inspect the parser.",
						agent_kind: "review",
						write_scope: ["src"],
						expected_output: null,
					},
				],
				[
					"worker with null write scope",
					{
						objective: "Fix the parser.",
						agent_kind: "worker",
						write_scope: null,
						expected_output: null,
					},
				],
				[
					"worker with empty write scope",
					{
						objective: "Fix the parser.",
						agent_kind: "worker",
						write_scope: [],
						expected_output: null,
					},
				],
				[
					"non-array expected output",
					{
						objective: "Inspect the parser.",
						agent_kind: "explore",
						write_scope: null,
						expected_output: "summary",
					},
				],
				[
					"empty expected output entry",
					{
						objective: "Inspect the parser.",
						agent_kind: "explore",
						write_scope: null,
						expected_output: [""],
					},
				],
				[
					"too many expected outputs",
					{
						objective: "Inspect the parser.",
						agent_kind: "explore",
						write_scope: null,
						expected_output: Array.from({ length: 13 }, (_, index) => `output-${index}`),
					},
				],
				[
					"additional property",
					{
						objective: "Inspect the parser.",
						agent_kind: "explore",
						write_scope: null,
						expected_output: null,
						mode: "code",
					},
				],
			])("rejects %s", (_label, payload) => {
				const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
				const result = NativeToolCallParser.parseToolCall({
					id: "invalid-spawn",
					name: "spawn_agent",
					arguments: JSON.stringify(payload),
				})

				expect(result).toBeNull()
				expect(errorSpy).toHaveBeenCalled()
				errorSpy.mockRestore()
			})
		})

		describe("search_files tool", () => {
			it("parses a bounded queries batch", () => {
				const result = NativeToolCallParser.parseToolCall({
					id: "search-batch",
					name: "search_files",
					arguments: JSON.stringify({
						queries: [
							{ path: "frontend/src", regex: "fetch|submit", file_pattern: "*.tsx" },
							{ path: "backend/app", regex: "@router|def ", file_pattern: "*.py" },
						],
					}),
				})

				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					expect(result.nativeArgs).toEqual({
						queries: [
							{ path: "frontend/src", regex: "fetch|submit", file_pattern: "*.tsx" },
							{ path: "backend/app", regex: "@router|def ", file_pattern: "*.py" },
						],
					})
				}
			})

			it("recovers concatenated query objects emitted for one tool call", () => {
				const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
				const result = NativeToolCallParser.parseToolCall({
					id: "search-concatenated",
					name: "search_files",
					arguments:
						'{"path":"frontend/src","regex":"fetch|submit","file_pattern":"*.tsx"}' +
						'{"path":"backend/app","regex":"@router|def ","file_pattern":"*.py"}',
				})

				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					expect(result.nativeArgs).toEqual({
						queries: [
							{ path: "frontend/src", regex: "fetch|submit", file_pattern: "*.tsx" },
							{ path: "backend/app", regex: "@router|def ", file_pattern: "*.py" },
						],
					})
				}
				expect(errorSpy).not.toHaveBeenCalled()
				errorSpy.mockRestore()
			})

			it("rejects batches beyond the bounded limit", () => {
				const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
				const result = NativeToolCallParser.parseToolCall({
					id: "search-too-large",
					name: "search_files",
					arguments: JSON.stringify({
						queries: Array.from({ length: 9 }, (_, index) => ({
							path: `src/${index}`,
							regex: "TODO",
						})),
					}),
				})

				expect(result).toBeNull()
				expect(errorSpy).toHaveBeenCalled()
				errorSpy.mockRestore()
			})
		})

		describe("read_file tool", () => {
			it("should parse minimal single-file read_file args", () => {
				const toolCall = {
					id: "toolu_123",
					name: "read_file" as const,
					arguments: JSON.stringify({
						path: "src/core/task/Task.ts",
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					expect(result.nativeArgs).toBeDefined()
					const nativeArgs = result.nativeArgs as { path: string }
					expect(nativeArgs.path).toBe("src/core/task/Task.ts")
				}
			})

			it("should parse slice-mode params", () => {
				const toolCall = {
					id: "toolu_123",
					name: "read_file" as const,
					arguments: JSON.stringify({
						path: "src/core/task/Task.ts",
						mode: "slice",
						offset: 10,
						limit: 20,
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					const nativeArgs = result.nativeArgs as {
						path: string
						mode?: string
						offset?: number
						limit?: number
					}
					expect(nativeArgs.path).toBe("src/core/task/Task.ts")
					expect(nativeArgs.mode).toBe("slice")
					expect(nativeArgs.offset).toBe(10)
					expect(nativeArgs.limit).toBe(20)
				}
			})

			it("should parse indentation-mode params", () => {
				const toolCall = {
					id: "toolu_123",
					name: "read_file" as const,
					arguments: JSON.stringify({
						path: "src/utils.ts",
						mode: "indentation",
						indentation: {
							anchor_line: 123,
							max_levels: 2,
							include_siblings: true,
							include_header: false,
						},
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					const nativeArgs = result.nativeArgs as {
						path: string
						mode?: string
						indentation?: {
							anchor_line?: number
							max_levels?: number
							include_siblings?: boolean
							include_header?: boolean
						}
					}
					expect(nativeArgs.path).toBe("src/utils.ts")
					expect(nativeArgs.mode).toBe("indentation")
					expect(nativeArgs.indentation?.anchor_line).toBe(123)
					expect(nativeArgs.indentation?.include_siblings).toBe(true)
					expect(nativeArgs.indentation?.include_header).toBe(false)
				}
			})

			// Legacy format backward compatibility tests
			describe("legacy format backward compatibility", () => {
				it("should parse legacy files array format with single file", () => {
					const toolCall = {
						id: "toolu_legacy_1",
						name: "read_file" as const,
						arguments: JSON.stringify({
							files: [{ path: "src/legacy/file.ts" }],
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBe(true)
						const nativeArgs = result.nativeArgs as { files: Array<{ path: string }>; _legacyFormat: true }
						expect(nativeArgs._legacyFormat).toBe(true)
						expect(nativeArgs.files).toHaveLength(1)
						expect(nativeArgs.files[0].path).toBe("src/legacy/file.ts")
					}
				})

				it("should parse legacy files array format with multiple files", () => {
					const toolCall = {
						id: "toolu_legacy_2",
						name: "read_file" as const,
						arguments: JSON.stringify({
							files: [{ path: "src/file1.ts" }, { path: "src/file2.ts" }, { path: "src/file3.ts" }],
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBe(true)
						const nativeArgs = result.nativeArgs as { files: Array<{ path: string }>; _legacyFormat: true }
						expect(nativeArgs.files).toHaveLength(3)
						expect(nativeArgs.files[0].path).toBe("src/file1.ts")
						expect(nativeArgs.files[1].path).toBe("src/file2.ts")
						expect(nativeArgs.files[2].path).toBe("src/file3.ts")
					}
				})

				it("should parse legacy line_ranges as tuples", () => {
					const toolCall = {
						id: "toolu_legacy_3",
						name: "read_file" as const,
						arguments: JSON.stringify({
							files: [
								{
									path: "src/task.ts",
									line_ranges: [
										[1, 50],
										[100, 150],
									],
								},
							],
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBe(true)
						const nativeArgs = result.nativeArgs as {
							files: Array<{ path: string; lineRanges?: Array<{ start: number; end: number }> }>
							_legacyFormat: true
						}
						expect(nativeArgs.files[0].lineRanges).toHaveLength(2)
						expect(nativeArgs.files[0].lineRanges?.[0]).toEqual({ start: 1, end: 50 })
						expect(nativeArgs.files[0].lineRanges?.[1]).toEqual({ start: 100, end: 150 })
					}
				})

				it("should parse legacy line_ranges as objects", () => {
					const toolCall = {
						id: "toolu_legacy_4",
						name: "read_file" as const,
						arguments: JSON.stringify({
							files: [
								{
									path: "src/task.ts",
									line_ranges: [
										{ start: 10, end: 20 },
										{ start: 30, end: 40 },
									],
								},
							],
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBe(true)
						const nativeArgs = result.nativeArgs as {
							files: Array<{ path: string; lineRanges?: Array<{ start: number; end: number }> }>
						}
						expect(nativeArgs.files[0].lineRanges).toHaveLength(2)
						expect(nativeArgs.files[0].lineRanges?.[0]).toEqual({ start: 10, end: 20 })
						expect(nativeArgs.files[0].lineRanges?.[1]).toEqual({ start: 30, end: 40 })
					}
				})

				it("should parse legacy line_ranges as strings", () => {
					const toolCall = {
						id: "toolu_legacy_5",
						name: "read_file" as const,
						arguments: JSON.stringify({
							files: [
								{
									path: "src/task.ts",
									line_ranges: ["1-50", "100-150"],
								},
							],
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBe(true)
						const nativeArgs = result.nativeArgs as {
							files: Array<{ path: string; lineRanges?: Array<{ start: number; end: number }> }>
						}
						expect(nativeArgs.files[0].lineRanges).toHaveLength(2)
						expect(nativeArgs.files[0].lineRanges?.[0]).toEqual({ start: 1, end: 50 })
						expect(nativeArgs.files[0].lineRanges?.[1]).toEqual({ start: 100, end: 150 })
					}
				})

				it("should parse double-stringified files array (model quirk)", () => {
					// This tests the real-world case where some models double-stringify the files array
					// e.g., { files: "[{\"path\": \"...\"}]" } instead of { files: [{path: "..."}] }
					const toolCall = {
						id: "toolu_double_stringify",
						name: "read_file" as const,
						arguments: JSON.stringify({
							files: JSON.stringify([
								{ path: "src/services/example/service.ts" },
								{ path: "src/services/mcp/McpServerManager.ts" },
							]),
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBe(true)
						const nativeArgs = result.nativeArgs as {
							files: Array<{ path: string }>
							_legacyFormat: true
						}
						expect(nativeArgs._legacyFormat).toBe(true)
						expect(nativeArgs.files).toHaveLength(2)
						expect(nativeArgs.files[0].path).toBe("src/services/example/service.ts")
						expect(nativeArgs.files[1].path).toBe("src/services/mcp/McpServerManager.ts")
					}
				})

				it("should NOT set usedLegacyFormat for new format", () => {
					const toolCall = {
						id: "toolu_new",
						name: "read_file" as const,
						arguments: JSON.stringify({
							path: "src/new/format.ts",
							mode: "slice",
							offset: 1,
							limit: 100,
						}),
					}

					const result = NativeToolCallParser.parseToolCall(toolCall)

					expect(result).not.toBeNull()
					expect(result?.type).toBe("tool_use")
					if (result?.type === "tool_use") {
						expect(result.usedLegacyFormat).toBeUndefined()
					}
				})
			})
		})

		describe("github_api tool", () => {
			it("should parse create_pull_request args with null placeholders", () => {
				const toolCall = {
					id: "call_QawDRvuALJVWw9VinUGjZCuu",
					name: "github_api" as const,
					arguments: JSON.stringify({
						action: "create_pull_request",
						owner: "lukegob10",
						repo: "ftp-sample",
						pull_number: null,
						issue_number: null,
						head: "update-readme",
						base: "main",
						title: "Update README: add contributing and license notes",
						body: "This PR updates README.md to add contributing instructions and reference the repository license.",
						sha: null,
						merge_method: null,
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					expect(result.name).toBe("github_api")
					expect(result.nativeArgs).toEqual({
						action: "create_pull_request",
						owner: "lukegob10",
						repo: "ftp-sample",
						head: "update-readme",
						base: "main",
						title: "Update README: add contributing and license notes",
						body: "This PR updates README.md to add contributing instructions and reference the repository license.",
					})
				}
			})

			it("should reject github_api create_pull_request without required branch fields", () => {
				const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
				const toolCall = {
					id: "call_missing_head",
					name: "github_api" as const,
					arguments: JSON.stringify({
						action: "create_pull_request",
						owner: "lukegob10",
						repo: "ftp-sample",
						head: null,
						base: "main",
						title: "Update README",
					}),
				}

				const result = NativeToolCallParser.parseToolCall(toolCall)

				expect(result).toBeNull()
				errorSpy.mockRestore()
			})
		})
	})

	describe("scoped streaming state", () => {
		it("attaches index-only argument deltas to a tool call started with an id", () => {
			const taskId = "orchestrator-task"
			let finalToolUse: ReturnType<typeof NativeToolCallParser.finalizeStreamingToolCall> = null

			const events = [
				...NativeToolCallParser.processRawChunk({ index: 0, id: "toolu_123", name: "new_task" }, taskId),
				...NativeToolCallParser.processRawChunk({ index: 0, arguments: '{"mode":"code",' }, taskId),
				...NativeToolCallParser.processRawChunk(
					{ index: 0, arguments: '"message":"Inspect the code path"}' },
					taskId,
				),
				...NativeToolCallParser.finalizeRawChunks(taskId),
			]

			for (const event of events) {
				if (event.type === "tool_call_start") {
					NativeToolCallParser.startStreamingToolCall(event.id, event.name, taskId)
				} else if (event.type === "tool_call_delta") {
					NativeToolCallParser.processStreamingChunk(event.id, event.delta, taskId)
				} else if (event.type === "tool_call_end") {
					finalToolUse = NativeToolCallParser.finalizeStreamingToolCall(event.id, taskId)
				}
			}

			expect(finalToolUse?.type).toBe("tool_use")
			if (finalToolUse?.type === "tool_use") {
				expect(finalToolUse.name).toBe("new_task")
				expect(finalToolUse.nativeArgs).toMatchObject({
					mode: "code",
					message: "Inspect the code path",
				})
			}
		})

		it("keeps concurrent task streams isolated even when chunk indices match", () => {
			const taskA = "task-a"
			const taskB = "task-b"

			expect(
				NativeToolCallParser.processRawChunk(
					{ index: 0, id: "call-a", name: "read_file", arguments: '{"path":"a.ts"}' },
					taskA,
				),
			).toEqual([
				{ type: "tool_call_start", id: "call-a", name: "read_file" },
				{ type: "tool_call_delta", id: "call-a", delta: '{"path":"a.ts"}' },
			])
			expect(
				NativeToolCallParser.processRawChunk(
					{ index: 0, id: "call-b", name: "read_file", arguments: '{"path":"b.ts"}' },
					taskB,
				),
			).toEqual([
				{ type: "tool_call_start", id: "call-b", name: "read_file" },
				{ type: "tool_call_delta", id: "call-b", delta: '{"path":"b.ts"}' },
			])

			NativeToolCallParser.startStreamingToolCall("call-a", "read_file", taskA)
			NativeToolCallParser.startStreamingToolCall("call-b", "read_file", taskB)
			NativeToolCallParser.processStreamingChunk("call-a", '{"path":"a.ts"}', taskA)
			NativeToolCallParser.processStreamingChunk("call-b", '{"path":"b.ts"}', taskB)

			const finalA = NativeToolCallParser.finalizeStreamingToolCall("call-a", taskA)
			const finalB = NativeToolCallParser.finalizeStreamingToolCall("call-b", taskB)

			expect(finalA?.type).toBe("tool_use")
			expect(finalB?.type).toBe("tool_use")
			if (finalA?.type === "tool_use" && finalB?.type === "tool_use") {
				expect(finalA.nativeArgs).toMatchObject({ path: "a.ts" })
				expect(finalB.nativeArgs).toMatchObject({ path: "b.ts" })
			}
		})

		it("clears only the requested task scope", () => {
			NativeToolCallParser.startStreamingToolCall("call-a", "read_file", "task-a")
			NativeToolCallParser.startStreamingToolCall("call-b", "read_file", "task-b")

			NativeToolCallParser.clearAllStreamingToolCalls("task-a")

			expect(NativeToolCallParser.hasActiveStreamingToolCalls("task-a")).toBe(false)
			expect(NativeToolCallParser.hasActiveStreamingToolCalls("task-b")).toBe(true)
		})
	})

	describe("processStreamingChunk", () => {
		describe("spawn_agent tool", () => {
			it("emits strict partial nativeArgs and preserves them on finalize", () => {
				const id = "spawn-streaming"
				const payload = {
					objective: "Review the streamed parser output.",
					agent_kind: "review",
					write_scope: null,
					expected_output: ["native argument shape"],
				}
				const encoded = JSON.stringify(payload)
				const splitAt = encoded.indexOf('"write_scope"')
				NativeToolCallParser.startStreamingToolCall(id, "spawn_agent")

				const incomplete = NativeToolCallParser.processStreamingChunk(id, encoded.slice(0, splitAt))
				expect(incomplete?.nativeArgs).toBeUndefined()

				const partial = NativeToolCallParser.processStreamingChunk(id, encoded.slice(splitAt))
				expect(partial?.partial).toBe(true)
				expect(partial?.nativeArgs).toEqual(payload)

				const finalized = NativeToolCallParser.finalizeStreamingToolCall(id)
				expect(finalized?.type).toBe("tool_use")
				if (finalized?.type === "tool_use") {
					expect(finalized.partial).toBe(false)
					expect(finalized.nativeArgs).toEqual(payload)
				}
			})
		})

		describe("read_file tool", () => {
			it("should emit a partial ToolUse with nativeArgs.path during streaming", () => {
				const id = "toolu_streaming_123"
				NativeToolCallParser.startStreamingToolCall(id, "read_file")

				// Simulate streaming chunks
				const fullArgs = JSON.stringify({ path: "src/test.ts" })

				// Process the complete args as a single chunk for simplicity
				const result = NativeToolCallParser.processStreamingChunk(id, fullArgs)

				expect(result).not.toBeNull()
				expect(result?.nativeArgs).toBeDefined()
				const nativeArgs = result?.nativeArgs as { path: string }
				expect(nativeArgs.path).toBe("src/test.ts")
			})
		})
	})

	describe("finalizeStreamingToolCall", () => {
		describe("read_file tool", () => {
			it("should parse read_file args on finalize", () => {
				const id = "toolu_finalize_123"
				NativeToolCallParser.startStreamingToolCall(id, "read_file")

				// Add the complete arguments
				NativeToolCallParser.processStreamingChunk(
					id,
					JSON.stringify({
						path: "finalized.ts",
						mode: "slice",
						offset: 1,
						limit: 10,
					}),
				)

				const result = NativeToolCallParser.finalizeStreamingToolCall(id)

				expect(result).not.toBeNull()
				expect(result?.type).toBe("tool_use")
				if (result?.type === "tool_use") {
					const nativeArgs = result.nativeArgs as { path: string; offset?: number; limit?: number }
					expect(nativeArgs.path).toBe("finalized.ts")
					expect(nativeArgs.offset).toBe(1)
					expect(nativeArgs.limit).toBe(10)
				}
			})
		})
	})
})
