import { fireEvent, render, screen } from "@testing-library/react"
import { ActivityTraceToggle } from "../ActivityTraceToggle"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

describe("ActivityTraceToggle", () => {
	it.each([
		["working", "chat:activityTrace.working"],
		["commands", "chat:activityTrace.runningCommands"],
		["edits", "chat:activityTrace.editingFiles"],
	] as const)("labels %s actions", (kind, label) => {
		const onToggle = vi.fn()
		render(
			<ActivityTraceToggle
				traceId={1}
				kind={kind}
				count={2}
				expanded={false}
				controls="row-1 row-2"
				onToggle={onToggle}
			/>,
		)
		const button = screen.getByRole("button", { name: `${label} 2` })
		expect(button).toHaveAttribute("aria-expanded", "false")
		expect(button).toHaveAttribute("aria-controls", "row-1 row-2")
		if (kind === "commands") {
			expect(button.parentElement).toHaveClass("border-b")
		} else {
			expect(button.parentElement).not.toHaveClass("border-b")
		}
		fireEvent.click(button)
		expect(onToggle).toHaveBeenCalledTimes(1)
	})
})
