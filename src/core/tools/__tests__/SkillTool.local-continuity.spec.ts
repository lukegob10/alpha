import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { subagentContextManifestSchema, type SubagentContextSkill } from "@alpha-code/types"

import type { Task } from "../../task/Task"
import type { AlphaProvider } from "../../webview/AlphaProvider"
import type { NativeToolArgs, ToolUse } from "../../../shared/tools"
import type { ToolCallbacks } from "../BaseTool"

const { host } = vi.hoisted(() => ({ host: { home: "" } }))
vi.mock("os", async (original) => ({
	...(await original<typeof import("os")>()),
	homedir: () => host.home,
}))
vi.mock("vscode", () => ({
	workspace: { getConfiguration: () => ({ get: () => undefined, inspect: () => undefined }) },
}))
vi.mock("ai-sdk-provider-poe/code", () => ({
	POE_DEFAULT_BASE_URL: "https://api.poe.com/v1",
	poeDefaultModelId: "poe-default-model",
	getPoeDefaultModelInfo: vi.fn(() => ({})),
}))
vi.mock("../../../i18n", () => ({ t: (key: string) => key }))

import { SkillsManager } from "../../../services/skills/SkillsManager"
import { buildSkillResult } from "../../../services/skills/skillInvocation"
import { SkillTool } from "../SkillTool"
import nativeSkillTool from "../../prompts/tools/native-tools/skill"
import { digestValue } from "../../agent/StepContext"
import { captureSubagentContext, serializeSubagentContextManifest } from "../../agent/SubagentContextCapture"

const instructionPageSchema = z.object({
	contents: z.string(),
	complete: z.boolean(),
	next_cursor: z.string().nullable(),
})

// Codex ac558e2: selection.rs retains selected source identity; skills/read.rs
// paginates one bounded snapshot. Alpha deliberately invalidates changed sources.
describe("local discovery through the native skill boundary", () => {
	let directory: string
	let cwd: string
	let extension: string
	let manager: SkillsManager
	let provider: AlphaProvider
	let callId: number

	beforeEach(async () => {
		directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-native-skill-")))
		host.home = path.join(directory, "home")
		cwd = path.join(directory, "repository")
		extension = path.join(directory, "extension")
		await fs.mkdir(path.join(cwd, ".git"), { recursive: true })
		await fs.mkdir(host.home)
		provider = {
			cwd,
			customModesManager: { getCustomModes: vi.fn(async () => []) },
			contextProxy: { extensionUri: { fsPath: extension }, getValue: () => [] },
			getSkillsManager: vi.fn(async () => manager),
			getState: vi.fn(() => {
				throw new Error("Skill loading must use the task's captured mode")
			}),
		} as unknown as AlphaProvider
		manager = new SkillsManager(provider, cwd)
		callId = 0
	})

	afterEach(async () => {
		await manager.dispose()
		host.home = ""
		await fs.rm(directory, { recursive: true, force: true })
	})

	async function writeSkill(root: string, name: string, instructions: string, explicitOnly = false) {
		const skillDirectory = path.join(root, name)
		await fs.mkdir(skillDirectory, { recursive: true })
		const skillPath = path.join(skillDirectory, "SKILL.md")
		await fs.writeFile(skillPath, `---\nname: ${name}\ndescription: Local ${name}\n---\n${instructions}\n`)
		if (explicitOnly) {
			await fs.mkdir(path.join(skillDirectory, "agents"), { recursive: true })
			await fs.writeFile(
				path.join(skillDirectory, "agents", "openai.yaml"),
				"policy:\n  allow_implicit_invocation: false\n",
			)
		}
		return skillPath
	}

	function taskFixture(skills?: readonly SubagentContextSkill[]) {
		const state = {
			taskKind: skills ? "subagent" : "primary",
			consecutiveMistakeCount: 0,
			didToolFailInCurrentTurn: false,
			providerRef: { deref: () => provider },
			getTaskMode: vi.fn(async () => "architect"),
			getInheritedSubagentSkillNames: () => skills?.map(({ name }) => name) ?? [],
			getInheritedSubagentSkill: (name: string) => skills?.find((skill) => skill.name === name),
			recordToolError: vi.fn(),
			recordLoadedSkill: vi.fn(async (_name: string, _path: string, _digest: string) => undefined),
			sayAndCreateMissingParamError: vi.fn(async () => "Missing skill"),
		}
		const callbacks = {
			askApproval: vi.fn<ToolCallbacks["askApproval"]>(async () => true),
			handleError: vi.fn<ToolCallbacks["handleError"]>(async () => undefined),
			pushToolResult: vi.fn<ToolCallbacks["pushToolResult"]>(),
			getRemainingOutputChars: vi.fn(() => 1_500),
			signal: new AbortController().signal,
		}
		return { state, callbacks }
	}

	async function invoke(tool: SkillTool, fixture: ReturnType<typeof taskFixture>, args: NativeToolArgs["skill"]) {
		fixture.callbacks.pushToolResult.mockClear()
		const block: ToolUse<"skill"> = {
			type: "tool_use",
			name: "skill",
			id: `native-skill-${++callId}`,
			params: {},
			partial: false,
			nativeArgs: args,
		}
		await tool.handle(fixture.state as unknown as Task, block, fixture.callbacks)
		const output = fixture.callbacks.pushToolResult.mock.calls[0]?.[0]
		return typeof output === "string" ? output : undefined
	}

	async function completeLoad(tool: SkillTool, fixture: ReturnType<typeof taskFixture>, name: string) {
		let cursor: string | null = null
		const pieces: string[] = []
		for (let page = 0; page < 100; page++) {
			const output = await invoke(tool, fixture, { action: "load", skill: name, args: null, cursor })
			expect(fixture.callbacks.handleError).not.toHaveBeenCalled()
			if (output === undefined) throw new Error("Native skill did not return instructions")
			expect(output.length).toBeLessThanOrEqual(1_500)
			if (!output.startsWith("{")) return pieces.join("") + output
			const result = instructionPageSchema.parse(JSON.parse(output))
			pieces.push(result.contents)
			cursor = result.next_cursor
			if (result.complete) {
				expect(cursor).toBeNull()
				return pieces.join("")
			}
			expect(fixture.state.recordLoadedSkill).not.toHaveBeenCalled()
			expect(cursor).not.toBeNull()
		}
		throw new Error("Native skill did not finish within its bounded fixture")
	}

	it("loads the exact local override completely once while keeping explicit-only metadata out of discovery", async () => {
		expect(nativeSkillTool.function.name).toBe("skill")
		await writeSkill(path.join(extension, "assets", "skills"), "review", "Built-in fallback")
		await writeSkill(path.join(host.home, ".agents", "skills"), "review", "Global fallback")
		const selectedPath = await writeSkill(
			path.join(cwd, ".alpha", "skills-architect"),
			"review",
			'Exact project rule 😀 "quoted"\n'.repeat(400),
			true,
		)
		await writeSkill(path.join(cwd, ".agents", "skills"), "ordinary", "Ordinary instructions")
		await manager.discoverSkills()
		const selected = await manager.getExplicitSkillContent(selectedPath, "architect")
		if (!selected) throw new Error("Local selected skill missing")
		expect(manager.getSkillsMetadata().every((skill) => !("instructions" in skill))).toBe(true)
		const fixture = taskFixture()
		const tool = new SkillTool()
		const catalog = await invoke(tool, fixture, { action: "list", skill: null, args: null, cursor: null })
		expect(JSON.parse(catalog!).skills.map(({ name }: { name: string }) => name)).toEqual(["ordinary"])
		expect(catalog).not.toContain(selectedPath)
		expect(fixture.state.recordLoadedSkill).not.toHaveBeenCalled()

		const delivered = await completeLoad(tool, fixture, selected.name)
		expect(delivered).toBe(buildSkillResult(selected.name, undefined, selected))
		expect(delivered).not.toContain("fallback")
		expect(fixture.state.recordLoadedSkill).toHaveBeenCalledExactlyOnceWith(
			selected.name,
			selectedPath,
			digestValue(selected.instructions),
		)
		expect(fixture.callbacks.askApproval).toHaveBeenCalledWith(
			"tool",
			expect.stringContaining('"source":"project"'),
		)
		expect(provider.getState).not.toHaveBeenCalled()
	})

	it("restarts an interrupted load after reload without treating a stale partial cursor as complete", async () => {
		await writeSkill(path.join(cwd, ".agents", "skills"), "review", "Complete local rule\n".repeat(400))
		await manager.discoverSkills()
		const selected = await manager.getSkillContent("review", "architect")
		if (!selected) throw new Error("Local selected skill missing")
		const original = taskFixture()
		const first = await invoke(new SkillTool(), original, {
			action: "load",
			skill: "review",
			args: null,
			cursor: null,
		})
		const partial = instructionPageSchema.parse(JSON.parse(first!))
		expect(partial.complete).toBe(false)
		expect(original.state.recordLoadedSkill).not.toHaveBeenCalled()

		const restored = taskFixture()
		const reloadedTool = new SkillTool()
		await invoke(reloadedTool, restored, {
			action: "load",
			skill: "review",
			args: null,
			cursor: JSON.parse(JSON.stringify(partial.next_cursor)),
		})
		expect(restored.callbacks.handleError).toHaveBeenCalledOnce()
		expect(restored.callbacks.pushToolResult).not.toHaveBeenCalled()
		expect(restored.callbacks.askApproval).not.toHaveBeenCalled()
		expect(restored.state.recordLoadedSkill).not.toHaveBeenCalled()
		restored.callbacks.handleError.mockClear()
		expect(await completeLoad(reloadedTool, restored, "review")).toBe(
			buildSkillResult("review", undefined, selected),
		)
		expect(restored.state.recordLoadedSkill).toHaveBeenCalledExactlyOnceWith(
			"review",
			selected.path,
			digestValue(selected.instructions),
		)
	})

	it.each(["changed", "removed", "read failure"])(
		"a reloaded child rejects a %s selected source instead of substituting a live override",
		async (change) => {
			const selectedPath = await writeSkill(
				path.join(cwd, ".alpha", "skills-architect"),
				"review",
				"Frozen rules",
				true,
			)
			await manager.discoverSkills()
			const selected = await manager.getSkillContent("review", "architect")
			if (!selected) throw new Error("Local selected skill missing")
			const captured = captureSubagentContext({
				parentTaskId: "native-skill-parent",
				capturedAt: 1,
				forkTurns: "none",
				history: [],
				instructions: {
					effectiveText: "Host instructions",
					sources: [{ kind: "aggregate", ref: "host", text: "Host instructions" }],
				},
				skills: [{ ...selected, content: selected.instructions }],
				cwd,
				workspaceRoots: [cwd],
				modelRoute: {
					source: "parent",
					resolution: "selected",
					profileName: "Default",
					provider: "vscode-lm",
					modelId: "test-model",
				},
				runtimePolicy: {
					role: "review",
					read: true,
					execute: false,
					mutate: false,
					delegate: false,
					network: false,
					externalSideEffects: false,
					requireApproval: true,
					allowedTools: ["skill"],
					workspaceRoots: [cwd],
				},
			})
			const restored = subagentContextManifestSchema.parse(
				JSON.parse(serializeSubagentContextManifest(captured.manifest)),
			)
			await writeSkill(path.join(cwd, ".alpha", "skills-code"), "review", "Wrong live override")
			await manager.discoverSkills()
			expect(await manager.getSkillContent("review", "code")).toMatchObject({
				instructions: "Wrong live override",
			})
			const child = taskFixture(restored.skills)
			child.state.getTaskMode.mockResolvedValue("code")
			const tool = new SkillTool()
			const policyBefore = structuredClone(restored.runtimePolicy)
			const catalog = await invoke(tool, child, { action: "list", skill: null, args: null, cursor: null })
			expect(JSON.parse(catalog!).skills).toEqual([])
			child.callbacks.getRemainingOutputChars.mockReturnValue(32_000)
			const unchanged = await invoke(tool, child, { action: "load", skill: "review", args: null, cursor: null })
			expect(unchanged).toBe(buildSkillResult("review", undefined, selected))
			expect(child.state.recordLoadedSkill).toHaveBeenCalledExactlyOnceWith(
				"review",
				selectedPath,
				digestValue(selected.instructions),
			)
			child.state.recordLoadedSkill.mockClear()
			child.callbacks.askApproval.mockClear()
			if (change === "changed") await fs.appendFile(selectedPath, "\nChanged after capture")
			else await fs.rm(selectedPath)
			// Keep the admitted metadata for the final case so the real read fails after discovery.
			if (change !== "read failure") await manager.discoverSkills()
			await invoke(tool, child, { action: "load", skill: "review", args: null, cursor: null })
			if (change === "read failure") {
				expect(child.callbacks.handleError).toHaveBeenCalledOnce()
				expect(child.callbacks.pushToolResult).not.toHaveBeenCalled()
			} else expect(child.callbacks.pushToolResult).toHaveBeenCalledOnce()
			expect(child.callbacks.pushToolResult).not.toHaveBeenCalledWith(
				expect.stringContaining("Wrong live override"),
			)
			expect(child.callbacks.pushToolResult).not.toHaveBeenCalledWith(
				expect.stringContaining("Changed after capture"),
			)
			expect(child.callbacks.askApproval).not.toHaveBeenCalled()
			expect(child.state.recordLoadedSkill).not.toHaveBeenCalled()
			expect(restored.runtimePolicy).toEqual(policyBefore)
		},
	)
})
