import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import PromptsSettings from "../PromptsSettings"

const { postMessage } = vi.hoisted(() => ({ postMessage: vi.fn() }))

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage } }))

vi.mock("@src/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		listApiConfigMeta: [{ id: "config-1", name: "Config 1" }],
	}),
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@src/components/ui", () => ({
	Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
		<button {...props}>{children}</button>
	),
	Select: ({ value, onValueChange }: { value: string; onValueChange: (value: string) => void }) => (
		<select
			data-testid={value === "ENHANCE" ? "support-prompt-type" : "enhancement-api-config"}
			value={value}
			onChange={(event) => onValueChange(event.target.value)}>
			<option value="ENHANCE">Enhance</option>
			<option value="-">Current configuration</option>
			<option value="config-1">Config 1</option>
		</select>
	),
	SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	SelectItem: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
	SelectValue: () => null,
	StandardTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ checked, onChange, children }: any) => (
		<label>
			<input type="checkbox" checked={checked} onChange={onChange} />
			{children}
		</label>
	),
	VSCodeTextArea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
}))

vi.mock("../SectionHeader", () => ({
	SectionHeader: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock("../Section", () => ({
	Section: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock("../SearchableSetting", () => ({
	SearchableSetting: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

describe("PromptsSettings buffering", () => {
	beforeEach(() => {
		postMessage.mockClear()
	})

	it("buffers enhancement settings without persisting before Save", () => {
		const setIncludeTaskHistoryInEnhance = vi.fn()
		const setEnhancementApiConfigId = vi.fn()

		const props = {
			customSupportPrompts: {},
			setCustomSupportPrompts: vi.fn(),
			includeTaskHistoryInEnhance: true,
			setIncludeTaskHistoryInEnhance,
			enhancementApiConfigId: "config-1",
			setEnhancementApiConfigId,
		}
		const { rerender } = render(<PromptsSettings {...props} />)

		fireEvent.click(screen.getByRole("checkbox"))
		fireEvent.change(screen.getByTestId("enhancement-api-config"), { target: { value: "-" } })

		expect(setIncludeTaskHistoryInEnhance).toHaveBeenCalledWith(false)
		expect(setEnhancementApiConfigId).toHaveBeenCalledWith("")
		expect(postMessage).not.toHaveBeenCalled()

		// SettingsView discards by restoring its original cached state. Controlled
		// inputs must therefore return to the original values without host writes.
		rerender(<PromptsSettings {...props} />)
		expect(screen.getByRole("checkbox")).toBeChecked()
		expect(screen.getByTestId("enhancement-api-config")).toHaveValue("config-1")
		expect(postMessage).not.toHaveBeenCalled()
	})

	it("previews with the buffered enhancement settings without persisting them", () => {
		render(
			<PromptsSettings
				customSupportPrompts={{ ENHANCE: "Buffered support prompt: {{userInput}}" }}
				setCustomSupportPrompts={vi.fn()}
				includeTaskHistoryInEnhance={false}
				setIncludeTaskHistoryInEnhance={vi.fn()}
				enhancementApiConfigId="config-1"
				setEnhancementApiConfigId={vi.fn()}
			/>,
		)

		fireEvent.change(screen.getByTestId("test-prompt-textarea"), { target: { value: "Preview me" } })
		fireEvent.click(screen.getByText("prompts:supportPrompts.enhance.previewButton"))

		expect(postMessage).toHaveBeenCalledTimes(1)
		expect(postMessage).toHaveBeenCalledWith({
			type: "enhancePrompt",
			text: "Preview me",
			enhancementOptions: {
				apiConfigId: "config-1",
				includeTaskHistory: false,
				supportPrompt: "Buffered support prompt: {{userInput}}",
			},
		})
	})
})
