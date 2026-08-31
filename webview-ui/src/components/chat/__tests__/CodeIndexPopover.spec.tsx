import type { IndexingStatus } from "@alpha-code/types"

import { act, fireEvent, render, screen } from "@src/utils/test-utils"
import { PopoverTrigger } from "@src/components/ui"

import { CodeIndexPopover } from "../CodeIndexPopover"

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		codebaseIndexConfig: undefined,
		codebaseIndexModels: undefined,
		cwd: "/workspace",
		apiConfiguration: undefined,
	}),
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@src/utils/vscode", () => ({
	vscode: { postMessage: vi.fn() },
}))

vi.mock("@src/components/ui/hooks/useAlphaPortal", () => ({
	useAlphaPortal: () => document.body,
}))

vi.mock("@src/hooks/useEscapeKey", () => ({ useEscapeKey: vi.fn() }))

vi.mock("@src/components/ui/hooks/useOpenRouterModelProviders", () => ({
	OPENROUTER_DEFAULT_PROVIDER_NAME: "OpenRouter",
	useOpenRouterModelProviders: () => ({ data: undefined }),
}))

const indexingStatus: IndexingStatus = {
	systemStatus: "Standby",
	processedItems: 0,
	totalItems: 0,
}

describe("CodeIndexPopover", () => {
	it("keeps save errors visible for five seconds", async () => {
		render(
			<CodeIndexPopover indexingStatus={indexingStatus}>
				<PopoverTrigger asChild>
					<button type="button">Open code index</button>
				</PopoverTrigger>
			</CodeIndexPopover>,
		)
		fireEvent.click(screen.getByRole("button", { name: "Open code index" }))
		await screen.findByText("settings:codeIndex.title")

		vi.useFakeTimers()
		try {
			act(() => {
				window.dispatchEvent(
					new MessageEvent("message", {
						data: { type: "codeIndexSettingsSaved", success: false, error: "Save failed" },
					}),
				)
			})

			expect(screen.getByText("Save failed")).toBeInTheDocument()
			act(() => vi.advanceTimersByTime(4_999))
			expect(screen.getByText("Save failed")).toBeInTheDocument()
			act(() => vi.advanceTimersByTime(1))
			expect(screen.queryByText("Save failed")).not.toBeInTheDocument()
		} finally {
			vi.useRealTimers()
		}
	})
})
