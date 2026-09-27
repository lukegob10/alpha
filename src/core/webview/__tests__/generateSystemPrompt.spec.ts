import * as vscode from "vscode"
import { buildApiHandler } from "../../../api"
import { resolveCodexModelPrompt } from "../../prompts/codex-model-instructions"
import { SYSTEM_PROMPT } from "../../prompts/system"
import { generateSystemPrompt } from "../generateSystemPrompt"

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
})
