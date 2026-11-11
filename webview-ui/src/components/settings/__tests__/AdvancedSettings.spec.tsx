import { expect } from "vitest"
import type { TextareaHTMLAttributes } from "react"

import { fireEvent, render, screen } from "@/utils/test-utils"
import { vscode } from "@/utils/vscode"

import { AdvancedSettings, type AdvancedSettingsValues } from "../AdvancedSettings"

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

vi.mock("@vscode/webview-ui-toolkit/react", async (importOriginal) => ({
	...(await importOriginal<typeof import("@vscode/webview-ui-toolkit/react")>()),
	VSCodeTextArea: ({
		resize: _resize,
		...props
	}: TextareaHTMLAttributes<HTMLTextAreaElement> & { resize?: string }) => <textarea {...props} />,
}))

const initialValues = {
	autoCondenseContext: true,
	autoCondenseContextPercent: 90,
	autoCondenseContextScope: "after-prefix",
	postTurnCondenseContextPercent: 0,
	maxOpenTabsContext: 12,
	maxWorkspaceFiles: 180,
	showAlphaIgnoredFiles: false,
	enableSubfolderRules: true,
	maxImageFileSize: 5,
	maxTotalImageSize: 20,
	includeDiagnosticMessages: true,
	maxDiagnosticMessages: 25,
	writeDelayMs: 1000,
	includeCurrentTime: true,
	includeCurrentCost: false,
	maxGitStatusFiles: 10,
	customSupportPrompts: { CONDENSE: "Retain my recovery notes.", ENHANCE: "Unrelated custom prompt" },
	enableCheckpoints: true,
	checkpointTimeout: 20,
	debug: false,
} satisfies AdvancedSettingsValues

describe("AdvancedSettings", () => {
	beforeEach(() => vi.clearAllMocks())

	it("shows context, recovery and diagnostics in one card without terminal setup or automatic writes", () => {
		const setCachedStateField = vi.fn()
		const { container } = render(
			<AdvancedSettings values={initialValues} setCachedStateField={setCachedStateField} />,
		)

		expect(screen.getAllByRole("heading", { level: 3, hidden: true })).toHaveLength(1)
		expect(screen.getByRole("heading", { name: "settings:sections.advanced" })).toBeInTheDocument()
		const groups = Array.from(container.querySelectorAll("[data-settings-group]"))
		expect(groups).toHaveLength(3)
		const pageCard = container.querySelector('[data-settings-page-card="advanced"]')
		expect(pageCard).toBeInTheDocument()
		expect(container.querySelectorAll(".surface-raised")).toHaveLength(1)
		expect(groups.map((group) => group.getAttribute("data-settings-group"))).toEqual([
			"context",
			"recovery",
			"diagnostics",
		])
		for (const group of groups) {
			expect(group.closest(".surface-raised")).toBe(pageCard)
			expect(group.closest("details")).toBeNull()
			expect(group.querySelector("h4")).toBeVisible()
		}
		for (const settingId of ["context-open-tabs", "checkpoints-enable", "about-debug-mode"]) {
			expect(container.querySelector(`[data-setting-id="${settingId}"]`)).toBeVisible()
		}
		expect(container.querySelector('[data-setting-id^="terminal-"]')).not.toBeInTheDocument()
		expect(screen.queryByText("settings:advanced.terminal")).not.toBeInTheDocument()
		expect(screen.getByTestId("condense-prompt-textarea")).not.toBeVisible()
		expect(setCachedStateField).not.toHaveBeenCalled()
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("embeds visible advanced sections without another page heading or introduction", () => {
		const { container } = render(<AdvancedSettings embedded values={initialValues} setCachedStateField={vi.fn()} />)

		expect(screen.queryByRole("heading", { level: 3, hidden: true })).not.toBeInTheDocument()
		expect(screen.queryByText("settings:advanced.description")).not.toBeInTheDocument()
		const groups = Array.from(container.querySelectorAll("[data-settings-group]"))
		expect(groups).toHaveLength(3)
		for (const group of groups) {
			expect(group.closest("details")).toBeNull()
			expect(group.querySelector("h4")).toBeVisible()
		}
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("routes recovery and debug changes through buffered callbacks without applying settings", () => {
		const setCachedStateField = vi.fn()
		const setDebug = vi.fn()
		render(
			<AdvancedSettings values={initialValues} setCachedStateField={setCachedStateField} setDebug={setDebug} />,
		)
		fireEvent.click(screen.getByRole("checkbox", { name: "settings:checkpoints.enable.label" }))
		expect(setCachedStateField).toHaveBeenCalledExactlyOnceWith("enableCheckpoints", false)

		fireEvent.click(screen.getByRole("checkbox", { name: "settings:about.debugMode.label" }))
		expect(setDebug).toHaveBeenCalledExactlyOnceWith(true)
		expect(setCachedStateField).toHaveBeenCalledTimes(1)
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("retains prompt edits through folding and buffered refreshes without changing other overrides", () => {
		const setCachedStateField = vi.fn()
		const { rerender } = render(
			<AdvancedSettings values={initialValues} setCachedStateField={setCachedStateField} />,
		)
		const summary = screen.getByText("prompts:supportPrompts.types.CONDENSE.label", { selector: "summary" })
		const editor = screen.getByTestId("condense-prompt-textarea")
		expect(editor).not.toBeVisible()
		fireEvent.click(summary)
		expect(editor).toBeVisible()
		fireEvent.input(editor, { target: { value: "Keep updated recovery notes." } })
		const prompts = { ...initialValues.customSupportPrompts, CONDENSE: "Keep updated recovery notes." }
		expect(setCachedStateField).toHaveBeenCalledExactlyOnceWith("customSupportPrompts", prompts)
		fireEvent.click(summary)
		expect(editor).not.toBeVisible()

		rerender(
			<AdvancedSettings
				values={{ ...initialValues, customSupportPrompts: prompts }}
				setCachedStateField={setCachedStateField}
			/>,
		)
		expect(editor).not.toBeVisible()
		fireEvent.click(summary)
		expect(screen.getByTestId("condense-prompt-textarea")).toBe(editor)
		expect(editor).toBeVisible()
		expect(editor).toHaveValue("Keep updated recovery notes.")
		expect(setCachedStateField).toHaveBeenCalledTimes(1)
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})
})
