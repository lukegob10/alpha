import type { ReactElement } from "react"
import { describe, expect, it, vi } from "vitest"

import { fireEvent, render, screen } from "@/utils/test-utils"
import settingsLocale from "@/i18n/locales/en/settings.json"

import { DebugSettings } from "../DebugSettings"
import { NotificationSettings } from "../NotificationSettings"
import { UISettings } from "../UISettings"

const chatPreferences = {
	reasoningBlockCollapsed: true,
	enterBehavior: "send" as const,
	autoSteer: false,
	embedded: true,
}

type PreferenceChange = (...args: unknown[]) => void

type HelpCase = {
	name: string
	label: string
	helpText: string
	renderSetting: (onChange: PreferenceChange) => ReactElement
}

const primaryMod = navigator.platform.toUpperCase().includes("MAC") ? "⌘" : "Ctrl"
const cases: HelpCase[] = [
	{
		name: "reasoning visibility",
		label: settingsLocale.ui.collapseThinking.label,
		helpText: settingsLocale.ui.collapseThinking.description,
		renderSetting: (onChange) => <UISettings {...chatPreferences} setCachedStateField={onChange} />,
	},
	{
		name: "Enter behavior",
		label: settingsLocale.ui.requireCtrlEnterToSend.label,
		helpText: settingsLocale.ui.requireCtrlEnterToSend.description.replace("{{primaryMod}}", primaryMod),
		renderSetting: (onChange) => <UISettings {...chatPreferences} setCachedStateField={onChange} />,
	},
	{
		name: "message steering",
		label: settingsLocale.ui.autoSteer.label,
		helpText: settingsLocale.ui.autoSteer.description,
		renderSetting: (onChange) => <UISettings {...chatPreferences} setCachedStateField={onChange} />,
	},
	{
		name: "sound",
		label: settingsLocale.notifications.sound.label,
		helpText: settingsLocale.notifications.sound.description,
		renderSetting: (onChange) => <NotificationSettings embedded setCachedStateField={onChange} />,
	},
	{
		name: "diagnostics",
		label: settingsLocale.about.debugMode.label,
		helpText: settingsLocale.about.debugMode.description,
		renderSetting: (onChange) => <DebugSettings debug={false} setDebug={onChange} />,
	},
]

describe("compact preference help", () => {
	it.each(cases)(
		"keeps $name explanation behind its help button without changing the preference",
		async ({ label, helpText, renderSetting }) => {
			const onChange = vi.fn<PreferenceChange>()
			const { container } = render(renderSetting(onChange))
			const helpLabel = settingsLocale.helpFor.replace("{{label}}", label)

			expect(screen.getByRole("checkbox", { name: label })).toBeInTheDocument()
			expect(container).not.toHaveTextContent(helpText)
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument()

			fireEvent.click(screen.getByRole("button", { name: helpLabel }))

			expect(await screen.findByRole("dialog", { name: helpLabel })).toHaveTextContent(helpText)
			expect(onChange).not.toHaveBeenCalled()
		},
	)
})
