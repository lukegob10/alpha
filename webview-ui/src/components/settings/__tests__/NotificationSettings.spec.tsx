import { expect } from "vitest"
import { fireEvent, render, screen, waitFor } from "@/utils/test-utils"
import settingsLocale from "@/i18n/locales/en/settings.json"

import { NotificationSettings } from "../NotificationSettings"

function translateSetting(key: string) {
	let translation: unknown = settingsLocale
	for (const segment of key.replace(/^settings:/, "").split(".")) {
		if (typeof translation !== "object" || translation === null) return key
		translation = Reflect.get(translation, segment)
	}
	return typeof translation === "string" ? translation : key
}

vi.mock("@/i18n/TranslationContext", () => ({ useAppTranslation: () => ({ t: translateSetting }) }))

describe("NotificationSettings", () => {
	it("keeps sounds off by default and hides volume until enabled", () => {
		const setCachedStateField = vi.fn()
		render(<NotificationSettings embedded setCachedStateField={setCachedStateField} />)

		expect(screen.getByRole("checkbox", { name: settingsLocale.notifications.sound.label })).not.toBeChecked()
		expect(screen.queryByRole("slider")).not.toBeInTheDocument()
		expect(setCachedStateField).not.toHaveBeenCalled()
	})

	it("embeds sound preferences without a second top-level settings header", () => {
		const { rerender } = render(<NotificationSettings setCachedStateField={vi.fn()} />)
		expect(screen.getByRole("heading", { name: settingsLocale.sections.notifications })).toBeInTheDocument()

		rerender(<NotificationSettings embedded setCachedStateField={vi.fn()} />)

		expect(screen.queryByRole("heading")).not.toBeInTheDocument()
		expect(screen.getByRole("checkbox", { name: settingsLocale.notifications.sound.label })).toBeInTheDocument()
	})

	it("shares a parent card while retaining the conditional volume control", () => {
		const setCachedStateField = vi.fn()
		const { container } = render(
			<NotificationSettings
				embedded
				unframed
				soundEnabled
				soundVolume={0.4}
				setCachedStateField={setCachedStateField}
			/>,
		)

		expect(container.querySelector(".surface-raised")).not.toBeInTheDocument()
		expect(screen.getByRole("slider", { name: settingsLocale.notifications.sound.volumeLabel })).toHaveAttribute(
			"aria-valuenow",
			"0.4",
		)
		expect(setCachedStateField).not.toHaveBeenCalled()
	})

	it("routes sound edits through the parent edit buffer and waits for controlled state updates", () => {
		const setCachedStateField = vi.fn()
		const { rerender } = render(
			<NotificationSettings embedded soundEnabled={false} setCachedStateField={setCachedStateField} />,
		)

		fireEvent.click(screen.getByRole("checkbox", { name: settingsLocale.notifications.sound.label }))

		expect(setCachedStateField).toHaveBeenCalledExactlyOnceWith("soundEnabled", true)
		expect(screen.queryByRole("slider")).not.toBeInTheDocument()

		rerender(
			<NotificationSettings embedded soundEnabled soundVolume={0.4} setCachedStateField={setCachedStateField} />,
		)
		const volume = screen.getByRole("slider", { name: settingsLocale.notifications.sound.volumeLabel })
		expect(volume).toHaveAttribute("aria-valuenow", "0.4")
		fireEvent.keyDown(volume, { key: "ArrowRight" })

		expect(setCachedStateField).toHaveBeenLastCalledWith("soundVolume", 0.41)
		expect(screen.getByText("40%")).toBeInTheDocument()
	})

	it("preserves the saved volume when sounds are switched off", () => {
		const setCachedStateField = vi.fn()
		const { rerender } = render(
			<NotificationSettings embedded soundEnabled soundVolume={0.25} setCachedStateField={setCachedStateField} />,
		)
		fireEvent.click(screen.getByRole("checkbox", { name: settingsLocale.notifications.sound.label }))

		expect(setCachedStateField).toHaveBeenCalledExactlyOnceWith("soundEnabled", false)
		rerender(
			<NotificationSettings
				embedded
				soundEnabled={false}
				soundVolume={0.25}
				setCachedStateField={setCachedStateField}
			/>,
		)
		expect(screen.queryByRole("slider")).not.toBeInTheDocument()

		rerender(
			<NotificationSettings embedded soundEnabled soundVolume={0.25} setCachedStateField={setCachedStateField} />,
		)
		expect(screen.getByRole("slider", { name: settingsLocale.notifications.sound.volumeLabel })).toHaveAttribute(
			"aria-valuenow",
			"0.25",
		)
	})

	it("resynchronizes sound and volume without turning toolkit changes into buffered edits", async () => {
		const setCachedStateField = vi.fn()
		const { rerender } = render(
			<NotificationSettings
				embedded
				soundEnabled={false}
				soundVolume={0.25}
				setCachedStateField={setCachedStateField}
			/>,
		)

		rerender(
			<NotificationSettings embedded soundEnabled soundVolume={0.6} setCachedStateField={setCachedStateField} />,
		)
		await waitFor(() => expect(screen.getByTestId("sound-enabled-checkbox")).toBeChecked())
		expect(screen.getByRole("slider", { name: settingsLocale.notifications.sound.volumeLabel })).toHaveAttribute(
			"aria-valuenow",
			"0.6",
		)

		rerender(
			<NotificationSettings
				embedded
				soundEnabled={false}
				soundVolume={0.6}
				setCachedStateField={setCachedStateField}
			/>,
		)
		await waitFor(() => expect(screen.getByTestId("sound-enabled-checkbox")).not.toBeChecked())
		expect(screen.queryByRole("slider")).not.toBeInTheDocument()
		expect(setCachedStateField).not.toHaveBeenCalled()
	})
})
