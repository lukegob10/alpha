import { fireEvent, render, screen } from "@/utils/test-utils"
import promptsLocale from "@/i18n/locales/en/prompts.json"

import type { CustomModePrompts } from "@alpha-code/types"

import ModesView from "../ModesView"

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, values?: { modeName?: string }) =>
			key === "prompts:modes.planWorkflowDescription"
				? promptsLocale.modes.planWorkflowDescription
				: values?.modeName
					? `${key} ${values.modeName}`
					: key,
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
		expect(screen.getByTestId("architect-description-textfield")).toBeInTheDocument()
		expect(setCustomModePrompts).not.toHaveBeenCalled()
	})

	it("explains the canonical Plan workflow without offering ignored prompt editors", () => {
		const setCustomModePrompts = vi.fn()
		renderModesView({
			customModePrompts: {
				architect: {
					roleDefinition: "Saved legacy Plan role",
					whenToUse: "Saved legacy Plan guidance",
					customInstructions: "Saved legacy Plan workflow",
				},
			},
			setCustomModePrompts,
		})
		fireEvent.click(screen.getByTestId("mode-setup-architect"))

		expect(screen.getByText(promptsLocale.modes.planWorkflowDescription)).toBeInTheDocument()
		expect(screen.queryByTestId("architect-prompt-textarea")).not.toBeInTheDocument()
		expect(screen.queryByTestId("architect-when-to-use-textarea")).not.toBeInTheDocument()
		expect(screen.queryByTestId("architect-custom-instructions-textarea")).not.toBeInTheDocument()
		expect(screen.queryByTestId("architect-roleDefinition-reset")).not.toBeInTheDocument()
		expect(screen.getByTestId("global-custom-instructions-textarea")).toBeInTheDocument()
		expect(setCustomModePrompts).not.toHaveBeenCalled()
	})

	it("keeps Plan description edits separate from its canonical workflow and saved compatibility values", () => {
		const setCustomModePrompts = vi.fn()
		renderModesView({
			customModePrompts: { architect: { customInstructions: "Saved legacy Plan workflow" } },
			setCustomModePrompts,
		})
		fireEvent.click(screen.getByTestId("mode-setup-architect"))
		fireEvent.change(screen.getByTestId("architect-description-textfield"), {
			target: { value: "Explore a task before implementation" },
		})

		expect(setCustomModePrompts).toHaveBeenCalledWith({
			architect: {
				customInstructions: "Saved legacy Plan workflow",
				description: "Explore a task before implementation",
			},
		})
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
