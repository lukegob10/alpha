import { fireEvent, render, screen } from "@/utils/test-utils"

import type { CustomModePrompts } from "@alpha-code/types"

import ModesView from "../ModesView"

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, values?: { modeName?: string }) => (values?.modeName ? `${key} ${values.modeName}` : key),
	}),
}))

const renderModesView = ({
	customModePrompts = {},
	customInstructions = "Global instructions",
	setCustomModePrompts = vi.fn(),
	setCustomInstructions = vi.fn(),
}: {
	customModePrompts?: CustomModePrompts
	customInstructions?: string
	setCustomModePrompts?: (value: CustomModePrompts) => void
	setCustomInstructions?: (value: string | undefined) => void
} = {}) =>
	render(
		<ModesView
			customModePrompts={customModePrompts}
			customInstructions={customInstructions}
			setCustomModePrompts={setCustomModePrompts}
			setCustomInstructions={setCustomInstructions}
		/>,
	)

describe("ModesView", () => {
	it("shows only the local Plan and Code setup choices", () => {
		renderModesView()

		const setupButtons = screen.getAllByTestId(/^mode-setup-/)
		expect(setupButtons).toHaveLength(2)
		expect(screen.getByTestId("mode-setup-architect")).toHaveTextContent("Plan")
		expect(screen.getByTestId("mode-setup-code")).toHaveTextContent("Code")
		expect(screen.queryByText("Ask")).not.toBeInTheDocument()
		expect(screen.queryByText("Debug")).not.toBeInTheDocument()
		expect(screen.queryByText("Orchestrator")).not.toBeInTheDocument()
		expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
		expect(screen.queryByText(/marketplace/i)).not.toBeInTheDocument()
		expect(screen.queryByText(/import mode/i)).not.toBeInTheDocument()
		expect(screen.queryByText(/export mode/i)).not.toBeInTheDocument()
		expect(screen.queryByText(/create mode/i)).not.toBeInTheDocument()
	})

	it("navigates between setup editors without changing a task mode", () => {
		const setCustomModePrompts = vi.fn()
		renderModesView({ setCustomModePrompts })

		expect(screen.getByTestId("code-prompt-textarea")).toBeInTheDocument()
		fireEvent.click(screen.getByTestId("mode-setup-architect"))
		expect(screen.getByTestId("architect-prompt-textarea")).toBeInTheDocument()
		expect(setCustomModePrompts).not.toHaveBeenCalled()
	})

	it("updates a primary prompt while preserving compatibility records", () => {
		const setCustomModePrompts = vi.fn()
		const customModePrompts: CustomModePrompts = {
			code: { description: "Existing code description" },
			debug: { roleDefinition: "Legacy debug role" },
			"security-review": { customInstructions: "Saved custom instructions" },
		}
		renderModesView({ customModePrompts, setCustomModePrompts })

		fireEvent.change(screen.getByTestId("code-prompt-textarea"), {
			target: { value: "Updated code role" },
		})

		expect(setCustomModePrompts).toHaveBeenCalledWith({
			code: {
				description: "Existing code description",
				roleDefinition: "Updated code role",
			},
			debug: { roleDefinition: "Legacy debug role" },
			"security-review": { customInstructions: "Saved custom instructions" },
		})
	})

	it("resets one primary prompt field without deleting other or legacy values", () => {
		const setCustomModePrompts = vi.fn()
		const customModePrompts: CustomModePrompts = {
			code: { roleDefinition: "Custom role", whenToUse: "Custom guidance" },
			ask: { description: "Compatibility record" },
		}
		renderModesView({ customModePrompts, setCustomModePrompts })

		fireEvent.click(screen.getByTestId("code-roleDefinition-reset"))

		expect(setCustomModePrompts).toHaveBeenCalledWith({
			code: { whenToUse: "Custom guidance" },
			ask: { description: "Compatibility record" },
		})
	})

	it("does not dirty settings when resetting an unchanged prompt field", () => {
		const setCustomModePrompts = vi.fn()
		renderModesView({ setCustomModePrompts })

		fireEvent.click(screen.getByTestId("code-roleDefinition-reset"))

		expect(setCustomModePrompts).not.toHaveBeenCalled()
	})

	it("preserves an explicit empty value when clearing global instructions", () => {
		const setCustomInstructions = vi.fn()
		renderModesView({ customInstructions: "Existing", setCustomInstructions })

		fireEvent.change(screen.getByTestId("global-custom-instructions-textarea"), {
			target: { value: "" },
		})

		expect(setCustomInstructions).toHaveBeenCalledWith("")
	})
})
