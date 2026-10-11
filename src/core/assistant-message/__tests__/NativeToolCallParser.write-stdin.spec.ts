import { afterEach, describe, expect, it, vi } from "vitest"

import { NativeToolCallParser } from "../NativeToolCallParser"
import { ToolScheduler, type ToolExecutionHost } from "../../agent/ToolScheduler"
import type { Task } from "../../task/Task"
import { getNativeTools } from "../../prompts/tools/native-tools"
import { commandSessionRegistry } from "../../tools/CommandSessionRegistry"
import { createTaskToolSurface } from "../../tools/TaskToolSurface"
import { readCommandOutputTool } from "../../tools/ReadCommandOutputTool"
import type { ToolUse } from "../../../shared/tools"

const artifactId = "cmd-1791686360029.txt"
const inactiveSessionFields = { session_id: null, chars: null, yield_time_ms: null, max_output_tokens: null }
const inactiveArtifactFields = { artifact_id: null, search: null, offset: null, limit: null }

afterEach(() => {
	vi.restoreAllMocks()
	NativeToolCallParser.clearAllStreamingToolCalls()
})

function parse(args: Record<string, unknown>): ToolUse<"write_stdin"> {
	const call = NativeToolCallParser.parseToolCall({
		id: "parsed-stdin",
		name: "write_stdin",
		arguments: JSON.stringify(args),
	})
	expect(call?.type).toBe("tool_use")
	if (!call || call.type !== "tool_use") throw new Error("write_stdin did not parse")
	return call
}

function schedulerFixture(mode: "code" | "architect") {
	const taskId = "parsed-artifact-task"
	const cwd = process.cwd()
	const task = {
		taskId,
		cwd,
		abort: false,
		consecutiveMistakeCount: 0,
		say: vi.fn(async () => undefined),
		recordToolError: vi.fn(),
		providerRef: { deref: () => undefined },
	} as unknown as Task
	const host: ToolExecutionHost = {
		taskId,
		cwd,
		taskFacade: task,
		userMessageContent: [],
		askApproval: vi.fn(async () => ({ response: "yesButtonClicked" as const })),
		say: vi.fn(async () => undefined),
		recordToolUsage: vi.fn(),
		pushToolResultToUserContent: (result) => {
			host.userMessageContent.push(result)
			return true
		},
	}
	const surface = createTaskToolSurface({ schemas: getNativeTools({ planMode: mode === "architect" }), mode, cwd })
	return {
		host,
		task,
		run: (args: Record<string, unknown>) => {
			const call = parse(args)
			return new ToolScheduler({
				executionHost: host,
				registry: surface.registry,
				policy: surface.policy,
				mode,
			}).run([{ type: "tool_call", id: "parsed-stdin", name: call.name, arguments: call.nativeArgs }])
		},
	}
}

describe("native write_stdin argument branches", () => {
	it.each([
		{ label: "artifact receipt guidance", args: { artifact_id: artifactId } },
		{
			label: "artifact search and pagination",
			args: { artifact_id: artifactId, search: "ASTRA_ARTIFACT_TAIL_ANSWER", offset: 0, limit: 1_024 },
		},
		{
			label: "nullable artifact options and inactive session fields",
			args: { ...inactiveSessionFields, artifact_id: artifactId, search: null, offset: null, limit: null },
		},
		{ label: "numeric session poll", args: { session_id: 17 } },
		{
			label: "numeric session input",
			args: { session_id: 17, chars: "yes\n", yield_time_ms: 750, max_output_tokens: 256 },
		},
		{
			label: "nullable session options and inactive artifact fields",
			args: {
				...inactiveArtifactFields,
				session_id: 17,
				chars: null,
				yield_time_ms: null,
				max_output_tokens: null,
			},
		},
	])("preserves $label in complete and streaming provider calls", ({ args }) => {
		expect(parse(args)).toMatchObject({ name: "write_stdin", nativeArgs: args, partial: false })
		const encoded = JSON.stringify(args)
		const split = Math.floor(encoded.length / 2)
		NativeToolCallParser.startStreamingToolCall("stream-stdin", "write_stdin")
		NativeToolCallParser.processStreamingChunk("stream-stdin", encoded.slice(0, split))
		expect(NativeToolCallParser.processStreamingChunk("stream-stdin", encoded.slice(split))).toMatchObject({
			name: "write_stdin",
			nativeArgs: args,
			partial: true,
		})
		expect(NativeToolCallParser.finalizeStreamingToolCall("stream-stdin")).toMatchObject({
			name: "write_stdin",
			nativeArgs: args,
			partial: false,
		})
		expect(NativeToolCallParser.hasActiveStreamingToolCalls()).toBe(false)
	})

	it.each([
		{ label: "missing target", args: {} },
		{ label: "null targets", args: { session_id: null, artifact_id: null } },
		{ label: "empty artifact", args: { artifact_id: "" } },
		{ label: "numeric artifact", args: { artifact_id: 17 } },
		{ label: "both targets", args: { artifact_id: artifactId, session_id: 17 } },
		{ label: "artifact plus empty stdin", args: { artifact_id: artifactId, chars: "" } },
		{ label: "artifact plus session yield", args: { artifact_id: artifactId, yield_time_ms: 0 } },
		{ label: "artifact plus token budget", args: { artifact_id: artifactId, max_output_tokens: 0 } },
		{ label: "artifact plus hidden action", args: { artifact_id: artifactId, action: "stop" } },
		{ label: "artifact plus string offset", args: { artifact_id: artifactId, offset: "0" } },
		{ label: "artifact plus numeric search", args: { artifact_id: artifactId, search: 17 } },
		{ label: "session plus search", args: { session_id: 17, search: "tail" } },
		{ label: "session plus offset", args: { session_id: 17, offset: 0 } },
		{ label: "session plus artifact budget", args: { session_id: 17, limit: 512 } },
		{ label: "string session", args: { session_id: "17" } },
		{ label: "zero session", args: { session_id: 0 } },
		{ label: "fractional session", args: { session_id: 1.5 } },
		{ label: "unsafe session integer", args: { session_id: Number.MAX_SAFE_INTEGER + 1 } },
		{ label: "oversized stdin", args: { session_id: 17, chars: "x".repeat(16_385) } },
		{ label: "negative session yield", args: { session_id: 17, yield_time_ms: -1 } },
		{ label: "excessive session yield", args: { session_id: 17, yield_time_ms: 300_001 } },
		{ label: "negative token budget", args: { session_id: 17, max_output_tokens: -1 } },
		{ label: "excessive token budget", args: { session_id: 17, max_output_tokens: 100_001 } },
	])("rejects $label in complete and streaming provider calls", ({ args }) => {
		vi.spyOn(console, "error").mockImplementation(() => undefined)
		const encoded = JSON.stringify(args)
		expect(
			NativeToolCallParser.parseToolCall({ id: "invalid-stdin", name: "write_stdin", arguments: encoded }),
		).toBeNull()
		NativeToolCallParser.startStreamingToolCall("invalid-stream", "write_stdin")
		expect(NativeToolCallParser.processStreamingChunk("invalid-stream", encoded)?.nativeArgs).toBeUndefined()
		expect(NativeToolCallParser.finalizeStreamingToolCall("invalid-stream")).toBeNull()
		expect(NativeToolCallParser.hasActiveStreamingToolCalls()).toBe(false)
	})
})

describe.each(["code", "architect"] as const)("parsed write_stdin dispatch in %s", (mode) => {
	it("routes artifact reads through the reader with nullable session fields omitted", async () => {
		const fixture = schedulerFixture(mode)
		const resolveSession = vi.spyOn(commandSessionRegistry, "resolve")
		const read = vi.spyOn(readCommandOutputTool, "execute").mockImplementation(async (_args, _task, callbacks) => {
			callbacks.pushToolResult("ASTRA_ARTIFACT_TAIL_ANSWER")
		})
		const outcome = await fixture.run({
			...inactiveSessionFields,
			artifact_id: artifactId,
			search: "ASTRA_ARTIFACT_TAIL_ANSWER",
			offset: null,
			limit: 1_024,
		})
		expect(outcome.results).toEqual([
			expect.objectContaining({
				callId: "parsed-stdin",
				name: "write_stdin",
				status: "success",
				content: "ASTRA_ARTIFACT_TAIL_ANSWER",
			}),
		])
		expect(read).toHaveBeenCalledOnce()
		expect(read).toHaveBeenCalledWith(
			{ action: "read", artifact_id: artifactId, search: "ASTRA_ARTIFACT_TAIL_ANSWER", limit: 1_024 },
			fixture.task,
			expect.anything(),
		)
		expect(fixture.host.userMessageContent).toEqual([
			expect.objectContaining({ type: "tool_result", tool_use_id: "parsed-stdin", is_error: false }),
		])
		expect(resolveSession).not.toHaveBeenCalled()
	})

	it.each([
		{ label: "artifact traversal", args: { artifact_id: "../cmd-1.txt" }, error: "Invalid artifact_id" },
		{
			label: "excessive offset",
			args: { artifact_id: artifactId, offset: Number.MAX_SAFE_INTEGER + 1 },
			error: "Invalid offset",
		},
		{ label: "undersized output budget", args: { artifact_id: artifactId, limit: 511 }, error: "Invalid limit" },
		{
			label: "oversized search",
			args: { artifact_id: artifactId, search: "x".repeat(257) },
			error: "Invalid search pattern",
		},
	])("preserves runtime rejection of $label", async ({ args, error }) => {
		const fixture = schedulerFixture(mode)
		const resolveSession = vi.spyOn(commandSessionRegistry, "resolve")
		const outcome = await fixture.run(args)
		expect(outcome.results).toEqual([
			expect.objectContaining({ status: "error", content: expect.stringContaining(error) }),
		])
		expect(fixture.host.userMessageContent).toEqual([
			expect.objectContaining({ type: "tool_result", tool_use_id: "parsed-stdin", is_error: true }),
		])
		expect(resolveSession).not.toHaveBeenCalled()
	})
})

it.each([undefined, "yes\n"])("denies parsed session control in Plan with chars=%s", async (chars) => {
	const fixture = schedulerFixture("architect")
	const resolveSession = vi.spyOn(commandSessionRegistry, "resolve")
	const outcome = await fixture.run({ ...inactiveArtifactFields, session_id: 17, chars })
	expect(outcome.results).toEqual([
		expect.objectContaining({
			status: "error",
			content: expect.stringContaining("not allowed"),
			failure: expect.objectContaining({ reason: "policy_denied", effectsStarted: "no" }),
		}),
	])
	expect(resolveSession).not.toHaveBeenCalled()
})
