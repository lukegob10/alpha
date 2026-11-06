import * as vscode from "vscode"
import { afterEach, describe, expect, it, vi } from "vitest"
import { captureProjectInstructionDiscoveryOptions } from "../project-instruction-settings"

function settings(values: Record<string, unknown>): void {
	vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
		inspect: (key: string) => values[key],
	} as unknown as vscode.WorkspaceConfiguration)
}

afterEach(() => vi.restoreAllMocks())

describe("user-owned project instruction boundary settings", () => {
	it.each([0, 64_000, 1_048_576])("captures a valid user byte budget %s instead of workspace overrides", (budget) => {
		settings({ projectDocMaxBytes: { globalValue: budget, workspaceValue: 1_048_576, workspaceFolderValue: 1 } })
		expect(captureProjectInstructionDiscoveryOptions().projectDocMaxBytes).toBe(budget)
	})

	it.each([-1, 1.5, 1_048_577, Number.NaN, Number.POSITIVE_INFINITY, "65536", null])(
		"uses the default budget for invalid user value %s",
		(value) => {
			settings({ projectDocMaxBytes: { globalValue: value } })
			expect(captureProjectInstructionDiscoveryOptions().projectDocMaxBytes).toBe(32_768)
		},
	)

	it("ignores workspace-only byte budgets", () => {
		settings({ projectDocMaxBytes: { workspaceValue: 1_048_576, workspaceFolderValue: 0 } })
		expect(captureProjectInstructionDiscoveryOptions().projectDocMaxBytes).toBe(32_768)
	})

	it("keeps the existing Git/default-filename contract when no settings are available", () => {
		settings({})
		expect(captureProjectInstructionDiscoveryOptions()).toEqual({
			projectDocMaxBytes: 32768,
			projectRootMarkers: [".git"],
			projectDocFallbackFilenames: [],
		})
	})

	it("uses conservative defaults if a lightweight host adapter has no inspect function", () => {
		vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
			get: () => ["WORKSPACE_MUST_NOT_INSTALL"],
		} as unknown as vscode.WorkspaceConfiguration)

		expect(captureProjectInstructionDiscoveryOptions()).toEqual({
			projectDocMaxBytes: 32768,
			projectRootMarkers: [".git"],
			projectDocFallbackFilenames: [],
		})
	})

	it("ignores workspace and workspace-folder settings that attempt to widen the boundary", () => {
		settings({
			projectRootMarkers: {
				defaultValue: [".git"],
				globalValue: [],
				workspaceValue: [".git"],
				workspaceFolderValue: [".git"],
			},
			projectDocFallbackFilenames: {
				defaultValue: [],
				workspaceValue: ["WORKFLOW.md"],
				workspaceFolderValue: ["AUTORUN.md"],
			},
		})

		expect(captureProjectInstructionDiscoveryOptions()).toEqual({
			projectDocMaxBytes: 32768,
			projectRootMarkers: [],
			projectDocFallbackFilenames: [],
		})
	})

	it("validates and deduplicates global basenames while preserving configured order", () => {
		settings({
			projectRootMarkers: {
				globalValue: [".workspace-root", "../.git", "C:.git", ".workspace-root", ".git"],
			},
			projectDocFallbackFilenames: {
				globalValue: ["WORKFLOW.md", "nested/AGENTS.md", "..\\SECRET.md", "WORKFLOW.md", "GUIDE.md"],
			},
		})

		expect(captureProjectInstructionDiscoveryOptions()).toEqual({
			projectDocMaxBytes: 32768,
			projectRootMarkers: [".workspace-root", ".git"],
			projectDocFallbackFilenames: ["WORKFLOW.md", "GUIDE.md"],
		})
	})

	it("freezes a detached snapshot so later settings edits cannot change an admitted boundary", () => {
		const markers = [".workspace-root"]
		const fallbacks = ["WORKFLOW.md"]
		settings({
			projectRootMarkers: { globalValue: markers },
			projectDocFallbackFilenames: { globalValue: fallbacks },
		})
		const captured = captureProjectInstructionDiscoveryOptions()
		markers.push(".git")
		fallbacks.push("GUIDE.md")

		expect(captured).toEqual({
			projectDocMaxBytes: 32768,
			projectRootMarkers: [".workspace-root"],
			projectDocFallbackFilenames: ["WORKFLOW.md"],
		})
		expect(Object.isFrozen(captured)).toBe(true)
		expect(Object.isFrozen(captured.projectRootMarkers)).toBe(true)
		expect(Object.isFrozen(captured.projectDocFallbackFilenames)).toBe(true)
	})
})
