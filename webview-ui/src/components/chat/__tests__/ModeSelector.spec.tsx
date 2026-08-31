import { fireEvent, render, screen } from "@/utils/test-utils"

import type { ModeConfig } from "@alpha-code/types"
import type { Mode } from "@alpha/modes"

import { ModeSelector } from "../ModeSelector"

vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		hasOpenedModeSelector: false,
		setHasOpenedModeSelector: vi.fn(),
	}),
}))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => key,
	}),
}))

vi.mock("@/components/ui/hooks/useAlphaPortal", () => ({
	useAlphaPortal: () => document.body,
}))

vi.mock("@/utils/TelemetryClient", () => ({
	telemetryClient: {
		capture: vi.fn(),
	},
}))

let mockModes: ModeConfig[] = []

vi.mock("@alpha/modes", async () => {
	const actual = await vi.importActual<typeof import("@alpha/modes")>("@alpha/modes")
	return {
		...actual,
		getAllModes: () => mockModes,
		defaultModeSlug: "code",
	}
})

const primaryAndCompatibilityModes: ModeConfig[] = [
	{
		slug: "architect",
		name: "Architect",
		description: "Plan work",
		roleDefinition: "Plan",
		groups: ["read"],
	},
	{
		slug: "code",
		name: "Code",
		description: "Implement work",
		roleDefinition: "Code",
		groups: ["read", "edit"],
	},
	{ slug: "ask", name: "Ask", roleDefinition: "Ask", groups: ["read"] },
	{ slug: "debug", name: "Debug", roleDefinition: "Debug", groups: ["read", "edit"] },
	{ slug: "orchestrator", name: "Orchestrator", roleDefinition: "Orchestrator", groups: [] },
	{
		slug: "security-review",
		name: "Security Review",
		roleDefinition: "Review",
		groups: ["read"],
	},
]

const renderSelector = (value: Mode = "code", onChange = vi.fn(), disabled = false) =>
	render(
		<ModeSelector
			title="Mode Selector"
			value={value}
			onChange={onChange}
			disabled={disabled}
			modeShortcutText="Shift + Tab"
			customModes={[primaryAndCompatibilityModes.at(-1)!]}
		/>,
	)

describe("ModeSelector", () => {
	beforeEach(() => {
		mockModes = primaryAndCompatibilityModes
	})

	it("offers only Plan and Code during normal switching", () => {
		const onChange = vi.fn()
		renderSelector("code", onChange)

		fireEvent.click(screen.getByTestId("mode-selector-trigger"))

		const items = screen.getAllByTestId("mode-selector-item")
		expect(items).toHaveLength(2)
		expect(items[0]).toHaveTextContent("Plan")
		expect(items[1]).toHaveTextContent("Code")
		expect(screen.queryByText("Ask")).not.toBeInTheDocument()
		expect(screen.queryByText("Debug")).not.toBeInTheDocument()
		expect(screen.queryByText("Orchestrator")).not.toBeInTheDocument()
		expect(screen.queryByText("Security Review")).not.toBeInTheDocument()
		expect(screen.queryByTestId("mode-search-input")).not.toBeInTheDocument()
		expect(document.querySelector(".codicon-extensions")).not.toBeInTheDocument()
		expect(screen.getByText(/Shift \+ Tab/)).toBeInTheDocument()

		fireEvent.click(items[0])
		expect(onChange).toHaveBeenCalledWith("architect")
	})

	it("renders mode choices as native buttons", () => {
		const onChange = vi.fn()
		renderSelector("code", onChange)
		fireEvent.click(screen.getByTestId("mode-selector-trigger"))
		const planButton = screen.getByRole("button", { name: /Plan/ })

		expect(planButton.tagName).toBe("BUTTON")
		expect(planButton).toHaveAttribute("type", "button")
		fireEvent.click(planButton)
		expect(onChange).toHaveBeenCalledWith("architect")
	})

	it("closes an open selector and blocks selection when switching becomes disabled", () => {
		const onChange = vi.fn()
		const { rerender } = renderSelector("code", onChange)

		fireEvent.click(screen.getByTestId("mode-selector-trigger"))
		expect(screen.getAllByTestId("mode-selector-item")).toHaveLength(2)

		rerender(
			<ModeSelector
				title="Mode Selector"
				value="code"
				onChange={onChange}
				disabled={true}
				modeShortcutText="Shift + Tab"
				customModes={[primaryAndCompatibilityModes.at(-1)!]}
			/>,
		)

		expect(screen.getByTestId("mode-selector-trigger")).toBeDisabled()
		expect(screen.queryByTestId("mode-selector-item")).not.toBeInTheDocument()
		fireEvent.click(screen.getByTestId("mode-selector-trigger"))
		expect(onChange).not.toHaveBeenCalled()
	})

	it("keeps an active legacy mode visible without coercing its slug", () => {
		const onChange = vi.fn()
		renderSelector("debug", onChange)

		expect(screen.getByTestId("mode-selector-trigger")).toHaveTextContent("Debug")
		expect(onChange).not.toHaveBeenCalled()

		fireEvent.click(screen.getByTestId("mode-selector-trigger"))
		expect(screen.getAllByTestId("mode-selector-item")).toHaveLength(3)
	})

	it("keeps an active custom mode visible but hides it from other tasks", () => {
		const { unmount } = renderSelector("security-review")
		expect(screen.getByTestId("mode-selector-trigger")).toHaveTextContent("Security Review")
		unmount()

		renderSelector("code")
		fireEvent.click(screen.getByTestId("mode-selector-trigger"))
		expect(screen.queryByText("Security Review")).not.toBeInTheDocument()
	})

	it("uses a cached description override for a primary setup", () => {
		render(
			<ModeSelector
				title="Mode Selector"
				value="code"
				onChange={vi.fn()}
				modeShortcutText="Shift + Tab"
				customModePrompts={{ code: { description: "Custom code description" } }}
			/>,
		)

		fireEvent.click(screen.getByTestId("mode-selector-trigger"))
		expect(screen.getByText("Custom code description")).toBeInTheDocument()
	})

	it("falls back to Code when the stored mode no longer exists", async () => {
		mockModes = primaryAndCompatibilityModes.slice(0, 2)
		const onChange = vi.fn()
		renderSelector("missing-mode", onChange)

		expect(screen.getByTestId("mode-selector-trigger")).toHaveTextContent("Code")
		await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith("code"))
	})
})
