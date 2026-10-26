import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"

import { ToolRegistry } from "../../tools/ToolRegistry"
import { createTaskToolSurface } from "../../tools/TaskToolSurface"
import { ToolScheduler, type ToolExecutionHost } from "../ToolScheduler"

describe("scheduler patch command preflight", () => {
	it("closes a malformed subdirectory patch command with an invalid-arguments receipt", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-malformed-patch-command-"))
		try {
			await fs.mkdir(path.join(root, "src"))
			const target = path.join(root, "src", "foo.ts")
			await fs.writeFile(target, "original content\n")
			const host: ToolExecutionHost = {
				taskId: "malformed-patch-command",
				cwd: root,
				userMessageContent: [],
				askApproval: vi.fn(async () => ({ response: "yesButtonClicked" as const })),
				say: vi.fn(async () => undefined),
				recordToolUsage: vi.fn(),
				pushToolResultToUserContent(result) {
					host.userMessageContent.push(result)
					return true
				},
			}
			const surface = createTaskToolSurface({ registry: new ToolRegistry(), mode: "code", cwd: root })
			const onEffectStart = vi.fn()
			const outcome = await new ToolScheduler({
				executionHost: host,
				registry: surface.registry,
				policy: surface.policy,
				mode: "code",
				onEffectStart,
			}).run([
				{
					type: "tool_call",
					id: "malformed-patch",
					name: "exec_command",
					arguments: {
						cmd: "cd src && apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: foo.ts\n*** End Patch\nPATCH",
					},
				},
			])

			expect(outcome.results).toEqual([
				expect.objectContaining({
					callId: "malformed-patch",
					status: "error",
					failure: expect.objectContaining({ reason: "invalid_arguments", effectsStarted: "no" }),
				}),
			])
			expect(host.userMessageContent).toEqual([
				expect.objectContaining({ tool_use_id: "malformed-patch", is_error: true }),
			])
			expect(host.askApproval).not.toHaveBeenCalled()
			expect(host.recordToolUsage).not.toHaveBeenCalled()
			expect(onEffectStart).not.toHaveBeenCalled()
			expect(await fs.readFile(target, "utf8")).toBe("original content\n")
		} finally {
			await fs.rm(root, { recursive: true, force: true })
		}
	})
})
