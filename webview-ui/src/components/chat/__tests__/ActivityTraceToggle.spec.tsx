import { fireEvent, render, screen } from "@testing-library/react"
import { ActivityTraceToggle } from "../ActivityTraceToggle"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		i18n: { language: "en" },
		t: (_key: string, { duration }: { duration: string }) => `Worked for ${duration}`,
	}),
}))

describe("ActivityTraceToggle", () => {
	it.each([
		[0, "0s"],
		[82000, "1m 22s"],
		[3600000, "1h"],
		[3723000, "1h 2m 3s"],
	])("formats %i milliseconds as %s", (durationMs, duration) => {
		const onToggle = vi.fn()
		render(
			<ActivityTraceToggle
				traceId={1}
				durationMs={Number(durationMs)}
				expanded={false}
				controls="row-1 row-2"
				onToggle={onToggle}
			/>,
		)
		const button = screen.getByRole("button", { name: `Worked for ${duration}` })
		expect(button).toHaveAttribute("aria-expanded", "false")
		expect(button).toHaveAttribute("aria-controls", "row-1 row-2")
		fireEvent.click(button)
		expect(onToggle).toHaveBeenCalledTimes(1)
	})
})
