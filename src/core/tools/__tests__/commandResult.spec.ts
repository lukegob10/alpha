import { describe, expect, it } from "vitest"

import type { CommandToolResult } from "@alpha-code/types"
import { boundCommandToolResult, formatCommandToolResult } from "../BaseTool"

describe("bounded command results", () => {
	it("keeps JSON parseable while retaining exit and artifact metadata", () => {
		const result = boundCommandToolResult(
			{
				wall_time_seconds: 1.5,
				output: `line ${"x".repeat(2_000)}`,
				exit_code: 7,
				artifact_id: "cmd-1706119234567.txt",
			},
			256,
		)
		const serialized = JSON.stringify(result)
		const parsed = JSON.parse(serialized) as CommandToolResult

		expect(serialized.length).toBeLessThanOrEqual(256)
		expect(parsed).toMatchObject({
			wall_time_seconds: 1.5,
			exit_code: 7,
			artifact_id: "cmd-1706119234567.txt",
		})
		expect(parsed.output).toContain("[output truncated]")
	})

	it("retains a running session in a bounded parseable envelope", () => {
		const result = boundCommandToolResult({ wall_time_seconds: 0.25, output: "still running", session_id: 42 }, 128)

		expect(JSON.parse(JSON.stringify(result))).toMatchObject({
			wall_time_seconds: 0.25,
			output: "still running",
			session_id: 42,
		})
		expect(result).not.toHaveProperty("exit_code")
	})

	it("matches Codex command headers and retains Alpha artifact retrieval", () => {
		expect(
			formatCommandToolResult(
				{
					wall_time_seconds: 1.25,
					output: "...",
					exit_code: 0,
					original_token_count: 10,
				},
				256,
				"abc123",
			),
		).toBe(
			"Chunk ID: abc123\nWall time: 1.2500 seconds\nProcess exited with code 0\nOriginal token count: 10\nOutput:\n...",
		)

		const running = formatCommandToolResult(
			{ wall_time_seconds: 0, output: "ready", session_id: 42 },
			256,
			"write-stdin-call",
		)
		expect(running).toContain("Process running with session ID 42")
		expect(running).not.toContain("Process exited with code")

		const artifact = formatCommandToolResult(
			{
				wall_time_seconds: 0.1,
				output: "x".repeat(1_000),
				artifact_id: "cmd-output.txt",
			},
			350,
			"abc123",
		)
		const artifactOutput = artifact
			.slice(artifact.indexOf("Output:\n") + "Output:\n".length)
			.split("\nOutput truncated.")[0]
		expect(artifactOutput.length).toBeLessThanOrEqual(350)
		expect(artifact).toContain("[output truncated]")
		expect(artifact).toContain("Read artifact cmd-output.txt with read_command_output")
	})

	it("preserves the complete Codex header under a small output cap", () => {
		const formatted = formatCommandToolResult(
			{ wall_time_seconds: 0.125, output: "x".repeat(1_000), exit_code: 0 },
			128,
			"abc123",
		)

		expect(formatted).toMatch(
			/^Chunk ID: abc123\nWall time: 0\.1250 seconds\nProcess exited with code 0\nOutput:\n/,
		)
		const formattedOutput = formatted.slice(formatted.indexOf("Output:\n") + "Output:\n".length)
		expect(formattedOutput.length).toBeLessThanOrEqual(128)
		expect(formattedOutput).toContain("[output truncated]")
	})

	it("keeps the minimum JSON envelope valid when the host budget is tiny", () => {
		const result = boundCommandToolResult({ wall_time_seconds: 0, output: "secret" }, 1)

		expect(JSON.parse(JSON.stringify(result))).toEqual({ wall_time_seconds: 0, output: "" })
	})
})
