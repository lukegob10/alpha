import { useState } from "react"
import userEvent from "@testing-library/user-event"

import { cleanup, render, screen } from "@/utils/test-utils"
import { installNativeTestFocus } from "@/utils/test-native-focus"
import { ActivityStep } from "../../chat/ActivityStep"
import CodeAccordion from "../CodeAccordion"

vi.mock("../CodeBlock", () => ({ default: ({ source }: { source: string }) => <pre>{source}</pre> }))
vi.mock("../DiffView", () => ({ default: ({ source }: { source: string }) => <pre>{source}</pre> }))

function AccordionHarness({ isFeedback = false, onJumpToFile }: { isFeedback?: boolean; onJumpToFile?: () => void }) {
	const [expanded, setExpanded] = useState(false)
	return (
		<CodeAccordion
			path={isFeedback ? undefined : "src/example.ts"}
			code="file change"
			language="diff"
			isFeedback={isFeedback}
			isExpanded={expanded}
			onToggleExpand={() => setExpanded((value) => !value)}
			onJumpToFile={onJumpToFile}
		/>
	)
}

function NestedAccordionHarness() {
	const [expanded, setExpanded] = useState(true)
	const toggle = () => setExpanded((value) => !value)
	return (
		<ActivityStep summary="Edited file" isExpanded={expanded} onToggleExpand={toggle}>
			<CodeAccordion
				path="src/example.ts"
				code="file change"
				language="diff"
				isExpanded={expanded}
				onToggleExpand={toggle}
			/>
		</ActivityStep>
	)
}

describe("CodeAccordion", () => {
	let restoreFocus: () => void

	beforeEach(() => {
		restoreFocus = installNativeTestFocus()
	})

	afterEach(() => {
		cleanup()
		restoreFocus()
	})

	it.each(["{Enter}", " "])("opens and closes a feedback diff with %s", async (key) => {
		const user = userEvent.setup()
		render(<AccordionHarness isFeedback />)
		const toggle = screen.getByRole("button", { name: "User Edits", expanded: false })
		const detailsId = toggle.getAttribute("aria-controls")!
		const details = document.getElementById(detailsId)
		expect(details).not.toBeVisible()
		expect(screen.queryByText("file change")).not.toBeInTheDocument()

		await user.tab()
		expect(toggle).toHaveFocus()
		await user.keyboard(key)
		expect(toggle).toHaveAttribute("aria-expanded", "true")
		expect(details).toBeVisible()
		expect(screen.getByText("file change")).toBeVisible()

		await user.keyboard(key)
		expect(toggle).toHaveAttribute("aria-expanded", "false")
		expect(toggle).toHaveAttribute("aria-controls", detailsId)
		expect(toggle).toHaveFocus()
		expect(details).not.toBeVisible()
		expect(screen.queryByText("file change")).not.toBeInTheDocument()
	})

	it.each(["{Enter}", " "])(
		"opens a file with %s without toggling its disclosure or submitting a form",
		async (key) => {
			const user = userEvent.setup()
			const onJumpToFile = vi.fn()
			const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault())
			const { container } = render(
				<form onSubmit={onSubmit}>
					<AccordionHarness onJumpToFile={onJumpToFile} />
				</form>,
			)
			const toggle = screen.getByRole("button", { expanded: false })
			const openFile = screen.getByRole("button", { name: "Open file: src/example.ts" })
			expect(openFile.parentElement).toBe(toggle.parentElement)
			expect(container.querySelector("button button")).toBeNull()

			await user.tab()
			expect(toggle).toHaveFocus()
			await user.keyboard("{Enter}")
			expect(toggle).toHaveAttribute("aria-expanded", "true")
			await user.tab()
			expect(openFile).toHaveFocus()
			await user.keyboard(key)

			expect(onJumpToFile).toHaveBeenCalledTimes(1)
			expect(toggle).toHaveAttribute("aria-expanded", "true")
			expect(openFile).toHaveFocus()
			expect(onSubmit).not.toHaveBeenCalled()
		},
	)

	it("keeps disclosure targets distinct and mounted while collapsed", () => {
		render(
			<>
				<AccordionHarness />
				<CodeAccordion
					header="Result details"
					code="server result"
					language="txt"
					isExpanded={false}
					onToggleExpand={vi.fn()}
				/>
			</>,
		)
		const toggles = screen.getAllByRole("button", { expanded: false })
		const targets = toggles.map((toggle) => toggle.getAttribute("aria-controls")!)
		expect(new Set(targets).size).toBe(2)
		for (const target of targets) {
			expect(document.getElementById(target)).toHaveAttribute("hidden")
		}
	})

	it("shows headerless output without a disclosure", () => {
		render(<CodeAccordion code="plain output" language="txt" isExpanded={false} onToggleExpand={vi.fn()} />)
		expect(screen.queryByRole("button")).not.toBeInTheDocument()
		expect(screen.getByText("plain output")).toBeVisible()
	})

	it("returns focus to the activity header when an inner disclosure closes the shared row", async () => {
		const user = userEvent.setup()
		render(<NestedAccordionHarness />)
		const outerToggle = screen.getByRole("button", { name: "Edited file", expanded: true })
		const innerToggle = screen.getByRole("button", { name: /src\/example\.ts/, expanded: true })
		await user.tab()
		expect(outerToggle).toHaveFocus()
		await user.tab()
		expect(innerToggle).toHaveFocus()

		await user.keyboard("{Enter}")

		expect(outerToggle).toHaveAttribute("aria-expanded", "false")
		expect(innerToggle).not.toBeVisible()
		expect(outerToggle).toHaveFocus()
	})
})
