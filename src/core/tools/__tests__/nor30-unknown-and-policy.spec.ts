import { getLegacyFileToolSchemas, getNativeTools } from "../../prompts/tools/native-tools"
import { afterEach, describe, expect, it, vi } from "vitest"

import { capturedSurface, makeExecutionHost, runToolCalls, toolResults } from "./nor30-tool-fixtures"
import { ToolRegistry } from "../ToolRegistry"
import { applyPatchTool } from "../ApplyPatchTool"

afterEach(() => vi.restoreAllMocks())

describe("NOR-30 captured tool execution: unknown calls and policy", () => {
	it("closes an unknown native call with one terminal error receipt", async () => {
		const schemas = getNativeTools()
		const registry = new ToolRegistry({ nativeTools: schemas })
		const surface = capturedSurface(registry)
		const harness = makeExecutionHost()

		const outcome = await runToolCalls(harness, surface, [
			{
				id: "unknown-1",
				name: "nor30_missing_tool",
				arguments: { value: "ignored" },
			},
		])

		expect(outcome.status).toBe("completed")
		expect(outcome.results[0]).toMatchObject({ callId: "unknown-1", name: "nor30_missing_tool", status: "error" })
		expect(String(outcome.results[0].content)).toContain("nor30_missing_tool")
		expect(String(outcome.results[0].content)).toContain("not registered")
		expect(harness.host.recordToolUsage).not.toHaveBeenCalled()
		expect(toolResults(harness)).toHaveLength(1)
		expect(toolResults(harness)[0]).toMatchObject({ tool_use_id: "unknown-1", is_error: true })
		expect(harness.host.userMessageContentReady).toBe(true)
	})

	it("returns a terminal unknown-tool receipt for a saved read_file call without executing it", async () => {
		const schemas = getNativeTools()
		const currentNames = schemas.flatMap((schema) => (schema.type === "function" ? [schema.function.name] : []))
		const savedReadFileSchema = getLegacyFileToolSchemas().find(
			(schema) => schema.type === "function" && schema.function.name === "read_file",
		)
		if (!savedReadFileSchema) throw new Error("Missing saved read_file compatibility schema")
		const registry = new ToolRegistry({
			nativeTools: [...schemas, savedReadFileSchema],
		})
		const surface = capturedSurface(registry)
		const harness = makeExecutionHost()
		expect(currentNames).not.toContain("read_file")

		const outcome = await runToolCalls(harness, surface, [
			{ id: "invalid-args-1", name: "read_file", arguments: null },
		])

		expect(registry.resolve("read_file")).toBeUndefined()
		expect(outcome.results[0]).toMatchObject({ callId: "invalid-args-1", name: "read_file", status: "error" })
		expect(String(outcome.results[0].content)).toContain("not registered")
		expect(harness.host.recordToolUsage).not.toHaveBeenCalled()
		expect(toolResults(harness)).toHaveLength(1)
	})

	it("does not duplicate a terminal receipt if the same accepted response is replayed", async () => {
		const schemas = getNativeTools()
		const registry = new ToolRegistry({ nativeTools: schemas })
		const surface = capturedSurface(registry)
		const harness = makeExecutionHost()
		const call = { id: "replayed-unknown-1", name: "nor30_missing_tool" }

		await runToolCalls(harness, surface, [call])
		await runToolCalls(harness, surface, [call])

		expect(toolResults(harness)).toHaveLength(1)
		expect(toolResults(harness)[0].tool_use_id).toBe(call.id)
	})

	it("enforces the captured Plan profile before a mutating call reaches a leaf", async () => {
		const schemas = getNativeTools()
		const registry = new ToolRegistry({ nativeTools: schemas })
		const surface = capturedSurface(registry, { schemas, profile: "plan" })
		const harness = makeExecutionHost()
		const handle = vi.spyOn(applyPatchTool, "handle")

		expect(surface.profile.id).toBe("plan")
		expect(surface.isCallable("apply_patch")).toBe(false)

		const outcome = await runToolCalls(
			harness,
			surface,
			[
				{
					id: "plan-denied-1",
					name: "apply_patch",
					arguments: { patch: "*** Begin Patch\n*** Add File: fixture.txt\n+must not write\n*** End Patch" },
				},
			],
			{ mode: "architect" },
		)

		expect(outcome.results[0].status).toBe("error")
		expect(String(outcome.results[0].content)).toContain("not allowed")
		expect(handle).not.toHaveBeenCalled()
		expect(harness.host.recordToolUsage).not.toHaveBeenCalled()
		expect(toolResults(harness)).toHaveLength(1)
	})
})
