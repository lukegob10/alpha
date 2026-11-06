import { memo } from "react"
import { act, cleanup, render, screen } from "@testing-library/react"
import { createInstance, type i18n } from "i18next"
import { I18nextProvider, initReactI18next } from "react-i18next"

import type { AlphaMessage, ExtensionMessage } from "@alpha-code/types"

import { ExtensionStateContextProvider, useExtensionState } from "@src/context/ExtensionStateContext"

import TranslationProvider, { useAppTranslation } from "../TranslationContext"

vi.mock("@src/utils/vscode", () => ({
	vscode: { postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() },
}))

const publish = (message: ExtensionMessage) =>
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data: message }))
	})

describe("TranslationContext render isolation", () => {
	let translations: i18n

	beforeEach(async () => {
		translations = createInstance()
		await translations.use(initReactI18next).init({
			lng: "en",
			fallbackLng: "en",
			initAsync: false,
			resources: {
				en: { translation: { title: "English title" } },
				"en-GB": { translation: { title: "Updated English title" } },
			},
		})
	})

	afterEach(() => {
		cleanup()
		vi.restoreAllMocks()
	})

	const renderProbe = (onTranslate: () => void) => {
		const TranslationProbe = memo(function TranslationProbe() {
			const { t } = useAppTranslation()
			onTranslate()
			return <div data-testid="translation">{t("title")}</div>
		})
		const TranscriptProbe = () => {
			const { alphaMessages, autoSteer } = useExtensionState()
			return (
				<>
					<div data-testid="transcript">{alphaMessages.at(-1)?.text}</div>
					<div data-testid="auto-steer">{String(autoSteer)}</div>
				</>
			)
		}
		render(
			<ExtensionStateContextProvider>
				<I18nextProvider i18n={translations}>
					<TranslationProvider>
						<TranslationProbe />
						<TranscriptProbe />
					</TranslationProvider>
				</I18nextProvider>
			</ExtensionStateContextProvider>,
		)
	}

	it("does not rerender translation consumers for 100 transcript updates across separate frames", () => {
		let frame: FrameRequestCallback | undefined
		const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
			frame = callback
			return 1
		})
		const onTranslate = vi.fn()
		renderProbe(onTranslate)
		const message: AlphaMessage = { ts: 1, type: "say", say: "text", text: "start", partial: true }
		publish({
			type: "state",
			state: { currentTaskId: "task-1", alphaMessages: [message], alphaMessagesSeq: 0 },
		})
		const rendersAfterHydration = onTranslate.mock.calls.length

		for (let index = 1; index <= 100; index++) {
			publish({
				type: "messageUpdated",
				taskId: "task-1",
				alphaMessage: { ...message, text: `stream ${index}` },
				alphaMessagesSeq: index,
			})
			const callback = frame
			frame = undefined
			expect(callback).toBeDefined()
			act(() => callback?.(index * 16))
		}

		expect(requestFrame).toHaveBeenCalledTimes(100)
		expect(screen.getByTestId("transcript")).toHaveTextContent("stream 100")
		expect(onTranslate).toHaveBeenCalledTimes(rendersAfterHydration)
	})

	it("does not broadcast unrelated shell preference updates to translation consumers", () => {
		const onTranslate = vi.fn()
		renderProbe(onTranslate)
		publish({ type: "state", state: { autoSteer: false } })
		const rendersAfterHydration = onTranslate.mock.calls.length

		for (let index = 0; index < 100; index++) {
			publish({ type: "state", state: { autoSteer: index % 2 === 0 } })
		}

		expect(screen.getByTestId("auto-steer")).toHaveTextContent("false")
		expect(onTranslate).toHaveBeenCalledTimes(rendersAfterHydration)
	})

	it("updates translations on languageChanged while the i18n instance stays the same", async () => {
		const onTranslate = vi.fn()
		renderProbe(onTranslate)
		expect(screen.getByTestId("translation")).toHaveTextContent("English title")
		const rendersBeforeLanguageChange = onTranslate.mock.calls.length

		await act(async () => {
			await translations.changeLanguage("en-GB")
		})

		expect(screen.getByTestId("translation")).toHaveTextContent("Updated English title")
		expect(onTranslate).toHaveBeenCalledTimes(rendersBeforeLanguageChange + 1)
	})
})
