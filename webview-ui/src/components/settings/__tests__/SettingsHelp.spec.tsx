import type { FormEvent } from "react"
import userEvent from "@testing-library/user-event"

import { cleanup, render, screen, waitFor, within } from "@/utils/test-utils"
import { installNativeTestFocus } from "@/utils/test-native-focus"

import { SettingsHelp } from "../SettingsHelp"

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: { label?: string }) =>
			key === "settings:helpFor" ? `Help for ${options?.label}` : key,
	}),
}))

describe("SettingsHelp", () => {
	let restoreFocus: () => void

	beforeEach(() => {
		restoreFocus = installNativeTestFocus()
	})

	afterEach(() => {
		cleanup()
		restoreFocus()
	})

	it("keeps explanations hidden until requested and never submits the settings form", async () => {
		const user = userEvent.setup()
		const submit = vi.fn((event: FormEvent) => event.preventDefault())
		render(
			<form onSubmit={submit}>
				<SettingsHelp label="API key">The key is stored in VS Code secret storage.</SettingsHelp>
			</form>,
		)
		const trigger = screen.getByRole("button", { name: "Help for API key" })
		expect(trigger).toHaveAttribute("data-settings-help-trigger", "true")
		expect(trigger).toHaveAttribute("aria-expanded", "false")
		expect(screen.queryByText("The key is stored in VS Code secret storage.")).not.toBeInTheDocument()

		await user.click(trigger)

		const help = screen.getByRole("dialog", { name: "Help for API key" })
		expect(within(help).getByText("The key is stored in VS Code secret storage.")).toBeVisible()
		expect(trigger).toHaveAttribute("aria-expanded", "true")
		expect(submit).not.toHaveBeenCalled()

		await user.click(trigger)

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
		expect(submit).not.toHaveBeenCalled()
	})

	it("opens from the keyboard and restores trigger focus after Escape", async () => {
		const user = userEvent.setup()
		render(
			<SettingsHelp label="Approval mode">
				<p>Choose when Alpha asks before using tools.</p>
				<a href="https://code.visualstudio.com/docs">Read the documentation</a>
			</SettingsHelp>,
		)
		const trigger = screen.getByRole("button", { name: "Help for Approval mode" })

		await user.tab()
		expect(trigger).toHaveFocus()
		await user.keyboard("{Enter}")

		const help = screen.getByRole("dialog", { name: "Help for Approval mode" })
		await waitFor(() => expect(help).toHaveFocus())
		await user.tab()
		expect(within(help).getByRole("link")).toHaveFocus()
		await user.keyboard("{Escape}")

		await waitFor(() => expect(trigger).toHaveFocus())
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
	})

	it("opens help with a touch tap without requiring hover", async () => {
		const user = userEvent.setup()
		render(<SettingsHelp label="Sound effects">Play a sound when a task needs attention.</SettingsHelp>)
		const trigger = screen.getByRole("button", { name: "Help for Sound effects" })

		await user.pointer([
			{ keys: "[TouchA>]", target: trigger },
			{ keys: "[/TouchA]", target: trigger },
		])

		expect(screen.getByRole("dialog", { name: "Help for Sound effects" })).toHaveTextContent(
			"Play a sound when a task needs attention.",
		)
	})

	it("names the help action on hover without displaying the explanation", async () => {
		const user = userEvent.setup()
		render(<SettingsHelp label="Context">Compact older messages automatically.</SettingsHelp>)

		await user.hover(screen.getByRole("button", { name: "Help for Context" }))

		const tooltip = await screen.findByRole("tooltip")
		expect(tooltip).toHaveTextContent("Help for Context")
		const content = tooltip.closest('[data-slot="tooltip-content"]')
		expect(content).toHaveStyle({ maxWidth: "min(300px, calc(100vw - 2rem))" })
		expect(content).toHaveClass("whitespace-normal", "break-words")
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
		expect(screen.queryByText("Compact older messages automatically.")).not.toBeInTheDocument()
	})
})
