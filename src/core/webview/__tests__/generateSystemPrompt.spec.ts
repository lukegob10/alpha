import * as vscode from "vscode"
import { buildApiHandler } from "../../../api"
import { resolveCodexModelPrompt } from "../../prompts/codex-model-instructions"
import { SYSTEM_PROMPT } from "../../prompts/system"
import { generateSystemPrompt } from "../generateSystemPrompt"
import { DEFAULT_MEMORY_SETTINGS } from "@alpha-code/types"

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(() => ({
			get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
		})),
	},
}))

vi.mock("../../../api", () => ({ buildApiHandler: vi.fn() }))

vi.mock("../../prompts/system", () => ({ SYSTEM_PROMPT: vi.fn() }))

vi.mock("../../diff/strategies/multi-search-replace", () => ({
	MultiSearchReplaceDiffStrategy: vi.fn(),
}))

describe("generateSystemPrompt", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(buildApiHandler).mockReturnValue({
			getModel: () => ({ id: "gpt-6-luna", info: {} }),
		} as any)
		vi.mocked(SYSTEM_PROMPT).mockImplementation(async (...args) => resolveCodexModelPrompt(args[14]).instructions)
	})

	it("previews the selected recognized GPT model's prompt", async () => {
		const provider = {
			context: {} as vscode.ExtensionContext,
			cwd: "F:/workspace",
			getState: vi.fn().mockResolvedValue({ apiConfiguration: { apiProvider: "openai" } }),
			customModesManager: { getCustomModes: vi.fn().mockResolvedValue([]) },
			getCurrentTask: vi.fn().mockReturnValue(undefined),
			getSkillsManager: vi.fn().mockReturnValue(undefined),
		}

		const preview = await generateSystemPrompt(provider as any, { mode: "code" } as any)

		expect(preview).toBe(resolveCodexModelPrompt("gpt-6-luna").instructions)
		expect(SYSTEM_PROMPT).toHaveBeenCalledOnce()
		expect(vi.mocked(SYSTEM_PROMPT).mock.calls[0]?.[14]).toBe("gpt-6-luna")
	})

	it("uses the resolved instruction model identity for a host model alias", async () => {
		vi.mocked(buildApiHandler).mockReturnValue({
			getModel: () => ({ id: "copilot-host-alias", instructionModelId: "gpt-6.1-sol", info: {} }),
		} as any)
		const provider = {
			context: {} as vscode.ExtensionContext,
			cwd: "F:/workspace",
			getState: vi.fn().mockResolvedValue({ apiConfiguration: { apiProvider: "vscode-lm" } }),
			customModesManager: { getCustomModes: vi.fn().mockResolvedValue([]) },
			getCurrentTask: vi.fn().mockReturnValue(undefined),
			getSkillsManager: vi.fn().mockReturnValue(undefined),
		}

		await generateSystemPrompt(provider as any, { mode: "code" } as any)

		expect(vi.mocked(SYSTEM_PROMPT).mock.calls[0]?.[14]).toBe("gpt-6.1-sol")
	})

	it("previews the current task's captured memory instead of the latest host summary", async () => {
		const getMemoryContext = vi.fn(async () => "Frozen task memory")
		const readSummary = vi.fn(async () => "New host memory")
		const provider = {
			context: {} as vscode.ExtensionContext,
			cwd: "F:/workspace",
			getState: vi.fn().mockResolvedValue({ apiConfiguration: { apiProvider: "openai" } }),
			customModesManager: { getCustomModes: vi.fn().mockResolvedValue([]) },
			getCurrentTask: vi.fn().mockReturnValue({ getMemoryContext }),
			getMemoryStore: vi.fn(() => ({ rootPath: "F:/alpha/memories_v2", readSummary })),
			getSkillsManager: vi.fn().mockReturnValue(undefined),
		}
		await generateSystemPrompt(provider as any, { mode: "code" } as any)
		expect(vi.mocked(SYSTEM_PROMPT).mock.calls[0]?.[12]?.memoryContext).toBe("Frozen task memory")
		expect(readSummary).not.toHaveBeenCalled()
	})

	it("previews enabled host memory when a thread has not been created", async () => {
		const readSummary = vi.fn(async () => "A learned preference")
		const provider = {
			context: {} as vscode.ExtensionContext,
			cwd: "F:/workspace",
			getState: vi.fn().mockResolvedValue({ apiConfiguration: { apiProvider: "openai" } }),
			customModesManager: { getCustomModes: vi.fn().mockResolvedValue([]) },
			getCurrentTask: vi.fn().mockReturnValue(undefined),
			getMemorySettings: vi.fn(() => ({ ...DEFAULT_MEMORY_SETTINGS, enabled: true })),
			getMemoryStore: vi.fn(() => ({ rootPath: "F:/alpha/memories_v2", readSummary })),
			getSkillsManager: vi.fn().mockReturnValue(undefined),
		}
		await generateSystemPrompt(provider as any, { mode: "code" } as any)
		expect(vi.mocked(SYSTEM_PROMPT).mock.calls[0]?.[12]?.memoryContext).toContain("A learned preference")
		expect(readSummary).toHaveBeenCalledOnce()
	})

	it.each([undefined, "default", "friendly", "pragmatic", "none"] as const)(
		"ignores a retired preference %s in stale state while preserving custom instructions",
		async (personality) => {
			const customInstructions = "# Personality\nKeep this user-owned style."
			const provider = {
				context: {} as vscode.ExtensionContext,
				cwd: "F:/workspace",
				getState: vi.fn().mockResolvedValue({
					apiConfiguration: { apiProvider: "openai" },
					customInstructions,
					personality,
				}),
				customModesManager: { getCustomModes: vi.fn().mockResolvedValue([]) },
				getCurrentTask: vi.fn().mockReturnValue(undefined),
				getSkillsManager: vi.fn().mockReturnValue(undefined),
			}

			const preview = await generateSystemPrompt(provider as any, { mode: "code" } as any)

			expect(preview).toBe(resolveCodexModelPrompt("gpt-6-luna").instructions)
			expect(vi.mocked(SYSTEM_PROMPT).mock.calls[0]?.[12]).not.toHaveProperty("personality")
			expect(vi.mocked(SYSTEM_PROMPT).mock.calls[0]?.[8]).toBe(customInstructions)
			expect(preview).toContain("# Personality\n")
		},
	)
})
