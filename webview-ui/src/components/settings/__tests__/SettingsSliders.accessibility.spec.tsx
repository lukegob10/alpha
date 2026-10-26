import { fireEvent, render, screen } from "@/utils/test-utils"
import settingsLocale from "@/i18n/locales/en/settings.json"

import { NotificationSettings } from "../NotificationSettings"
import { RateLimitSecondsControl } from "../RateLimitSecondsControl"
import { ConsecutiveMistakeLimitControl } from "../ConsecutiveMistakeLimitControl"

function translateSetting(key: string) {
	let translation: unknown = settingsLocale
	for (const segment of key.replace(/^settings:/, "").split(".")) {
		if (typeof translation !== "object" || translation === null) return key
		translation = Reflect.get(translation, segment)
	}
	return typeof translation === "string" ? translation : key
}

vi.mock("@/i18n/TranslationContext", () => ({ useAppTranslation: () => ({ t: translateSetting }) }))

describe("settings slider accessibility", () => {
	it("names the notification volume slider and keeps keyboard changes in the settings edit buffer", () => {
		const setCachedStateField = vi.fn()
		render(<NotificationSettings soundEnabled soundVolume={0.4} setCachedStateField={setCachedStateField} />)

		const volume = screen.getByRole("slider", { name: settingsLocale.notifications.sound.volumeLabel })
		fireEvent.keyDown(volume, { key: "ArrowRight" })

		expect(setCachedStateField).toHaveBeenCalledWith("soundVolume", 0.41)
	})

	it("names the request interval slider and preserves keyboard editing", () => {
		const onChange = vi.fn()
		render(<RateLimitSecondsControl value={5} onChange={onChange} />)

		fireEvent.keyDown(screen.getByRole("slider", { name: settingsLocale.providers.rateLimitSeconds.label }), {
			key: "ArrowRight",
		})

		expect(onChange).toHaveBeenCalledWith(6)
	})

	it("names the mistake limit slider and preserves keyboard editing", () => {
		const onChange = vi.fn()
		render(<ConsecutiveMistakeLimitControl value={3} onChange={onChange} />)

		fireEvent.keyDown(
			screen.getByRole("slider", { name: settingsLocale.providers.consecutiveMistakeLimit.label }),
			{ key: "ArrowRight" },
		)

		expect(onChange).toHaveBeenCalledWith(4)
	})
})
