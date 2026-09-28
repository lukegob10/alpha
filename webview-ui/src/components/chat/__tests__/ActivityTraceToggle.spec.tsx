import { fireEvent, render, screen } from "@testing-library/react"
import { ActivityTraceToggle } from "../ActivityTraceToggle"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: { duration?: string }) => (options?.duration ? `${key} ${options.duration}` : key),
	}),
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
		expect(button.parentElement).not.toHaveClass("border-b")
		fireEvent.click(button)
		expect(onToggle).toHaveBeenCalledTimes(1)
	})

	it("shows elapsed time without an action count for a completed turn", () => {
		render(
			<ActivityTraceToggle
				traceId={1}
				kind="worked"
				count={8}
				durationMs={12 * 60 * 1_000}
				expanded={false}
				controls="row-1 row-2"
				onToggle={vi.fn()}
			/>,
		)

		expect(screen.getByRole("button", { name: "chat:activityTrace.workedFor 12m" })).toBeInTheDocument()
		expect(screen.queryByText("8")).not.toBeInTheDocument()
	})
})
