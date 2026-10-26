import { describe, expect, it, vi } from "vitest"

import { openAiModelInfoSaneDefaults } from "@alpha-code/types"

import { buildTaskToolSurface, type BuildToolsOptions } from "../../task/build-tools"
import { TaskToolCatalogCache } from "../../task/TaskToolCatalogCache"
import { isCommandDeniedByPolicy } from "../../agent/ToolPolicy"

vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: () => ({ isFeatureEnabled: false, isFeatureConfigured: false, isInitialized: false }),
	},
}))

const claudeFamilies = ["claude-sonnet-4.6", "claude-opus-4.7", "claude-haiku-4.5"] as const
const mutations = ["apply_patch", "edit", "write_to_file", "create_ticket", "update_ticket", "delete_ticket"]

function options(modelId: string, mode: string = "code"): BuildToolsOptions {
	const hub = { getServers: () => [] }
	const provider = { context: {}, getMcpHub: () => hub }
	return {
		provider: provider as unknown as BuildToolsOptions["provider"],
		cwd: process.cwd(),
		mode,
		customModes: undefined,
		experiments: {},
		apiConfiguration: {
			apiProvider: "vscode-lm",
			vsCodeLmModelSelector: { vendor: "copilot", family: modelId, id: modelId },
		},
		modelIdentity: { provider: "vscode-lm", vendor: "copilot", family: modelId, id: modelId },
		modelInfo: { ...openAiModelInfoSaneDefaults, supportsImages: true },
		approvalMode: "ask",
		autoApprovalEnabled: false,
		taskKind: "primary",
		execution: {
			workspaceRoots: [process.cwd()],
			command: { deniedPrefixes: ["git push"] },
		},
		catalogCache: new TaskToolCatalogCache(),
	}
}

describe("Claude through Copilot captured execution authority", () => {
	it.each(claudeFamilies)("keeps %s model routing independent of Code and Plan authority", async (family) => {
		for (const mode of ["code", "architect"]) {
			const reference = options("gpt-5.6-sol", mode)
			const gpt = await buildTaskToolSurface(reference)
			const claudeRoute = options(family, mode)
			// Reuse the task's real catalog cache across a provider-profile model change.
			const claude = await buildTaskToolSurface({
				...reference,
				apiConfiguration: claudeRoute.apiConfiguration,
				modelIdentity: claudeRoute.modelIdentity,
			})

			expect(claude.allowedFunctionNames).toEqual(gpt.allowedFunctionNames)
			expect(claude.schemas).toEqual(gpt.schemas)
			expect(claude.policy).toEqual(gpt.policy)
			expect(claude.policy.approval).toMatchObject({ mode: "ask", autoApprovalEnabled: false })
			expect(isCommandDeniedByPolicy(claude.policy, "git push origin main")).toBe(true)
			expect(claude.isCallable("exec_command")).toBe(true)
			expect(claude.isCallable("apply_patch")).toBe(mode === "code")
			expect(claude.isCallable("switch_mode")).toBe(false)
			if (mode === "architect") {
				for (const name of mutations) {
					expect(claude.isCallable(name), name).toBe(false)
					expect(claude.resolve(name), name).toBeUndefined()
				}
			}
		}
	})

	it.each(["ask", "debug", "orchestrator", "unknown-saved-mode"])(
		"resumes a saved %s mode with Claude using Plan's callable surface",
		async (savedMode) => {
			const planOptions = options("claude-sonnet-4.6", "architect")
			const plan = await buildTaskToolSurface(planOptions)
			const restored = await buildTaskToolSurface({ ...planOptions, mode: savedMode })

			expect(restored.allowedFunctionNames).toEqual(plan.allowedFunctionNames)
			for (const name of mutations) {
				expect(restored.isCallable(name), name).toBe(false)
				expect(restored.resolve(name), name).toBeUndefined()
			}
		},
	)

	it("retains a GPT parent's captured denials when a child uses a Claude Copilot profile", async () => {
		const parent = await buildTaskToolSurface({
			...options("gpt-5.6-sol"),
			allowedToolNames: ["exec_command", "read_ticket"],
			disabledTools: ["apply_patch"],
		})
		const child = await buildTaskToolSurface({
			...options("claude-opus-4.7"),
			taskKind: "subagent",
			policy: parent.policy,
			// The inherited policy remains authoritative over a broader requested catalog.
			allowedToolNames: ["exec_command", "read_ticket", "apply_patch", "create_ticket"],
		})

		expect(parent.allowedFunctionNames).toEqual(["exec_command", "read_ticket"])
		expect(child.allowedFunctionNames).toEqual(parent.allowedFunctionNames)
		expect(child.policy.disabledTools).toContain("apply_patch")
		expect(child.policy.approval).toEqual(parent.policy.approval)
		expect(child.policy.execution).toEqual(parent.policy.execution)
		expect(isCommandDeniedByPolicy(child.policy, "git push origin main")).toBe(true)
		for (const name of mutations) {
			expect(child.isCallable(name), name).toBe(false)
			expect(child.resolve(name), name).toBeUndefined()
		}
	})
})
