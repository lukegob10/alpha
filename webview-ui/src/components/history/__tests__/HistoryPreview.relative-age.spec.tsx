import { render, screen } from "@/utils/test-utils"

import { useExtensionState } from "@src/context/ExtensionStateContext"

import HistoryPreview from "../HistoryPreview"

vi.mock("@src/context/ExtensionStateContext")
vi.mock("@src/utils/vscode")
vi.mock("react-virtuoso", async () => {
	const React = await import("react")
	return {
		Virtuoso: ({
			data,
			itemContent,
		}: {
			data: unknown[]
			itemContent: (index: number, item: unknown) => React.ReactNode
		}) =>
			React.createElement(
				"div",
				null,
				data.map((item, index) =>
					React.createElement(React.Fragment, { key: index }, itemContent(index, item)),
				),
			),
	}
})
vi.mock("@/utils/format", () => ({
	formatTimeAgo: () => "2 hours ago",
}))
vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: { count: number }) => (key === "history:age.hour" ? `${options?.count}h` : key),
	}),
}))

const mockTaskHistory = [
	{
		id: "1",
		task: "Test task 1",
		ts: Date.UTC(2026, 8, 25, 10),
		tokensIn: 100,
		tokensOut: 50,
		totalCost: 0.002,
		workspace: "/test/workspace",
	},
	{
		id: "2",
		task: "Test task 2",
		ts: Date.UTC(2026, 8, 25, 10),
		tokensIn: 200,
		tokensOut: 100,
		totalCost: 0.003,
		workspace: "/test/workspace",
	},
]

describe("inline Chats relative task ages", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 8, 25, 12))
		;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
			taskHistory: mockTaskHistory,
			cwd: "/test/workspace",
		})
	})
	afterEach(() => vi.restoreAllMocks())

	it.each([false, true])("shows relative ages in collapsed and expanded history (expanded=%s)", (expanded) => {
		render(<HistoryPreview expanded={expanded} />)

		if (expanded) expect(screen.getByPlaceholderText("history:searchPlaceholder")).toBeInTheDocument()
		else expect(screen.queryByPlaceholderText("history:searchPlaceholder")).not.toBeInTheDocument()
		expect(screen.getAllByText("2h")).toHaveLength(mockTaskHistory.length)
		for (const age of screen.getAllByTestId("task-time-ago")) {
			expect(age).toHaveAttribute("aria-label", "2 hours ago")
			expect(age).toHaveAttribute("title", new Date(mockTaskHistory[0].ts).toLocaleString())
		}
	})
})
