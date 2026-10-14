import { act, render, screen } from "@/utils/test-utils"

describe("ExtensionStateContext refresh boundary", () => {
	afterEach(() => {
		vi.doUnmock("../ExtensionStateContextStore")
	})

	it("keeps retained history consumers connected when the provider module is reloaded", async () => {
		const original = await import("../ExtensionStateContext")
		const { useTaskSearch } = await import("../../components/history/useTaskSearch")
		const store = await import("../ExtensionStateContextStore")
		const HistoryConsumer = () => {
			const { tasks } = useTaskSearch()
			return <div data-testid="history-count">{tasks.length}</div>
		}

		// Simulate Vite re-evaluating the provider and its runtime dependencies,
		// while retaining the unchanged context store and an existing consumer.
		vi.resetModules()
		vi.doMock("../ExtensionStateContextStore", () => store)
		const refreshed = await import("../ExtensionStateContext")
		expect(refreshed.ExtensionStateContext).toBe(original.ExtensionStateContext)

		render(
			<refreshed.ExtensionStateContextProvider>
				<HistoryConsumer />
			</refreshed.ExtensionStateContextProvider>,
		)
		expect(screen.getByTestId("history-count")).toHaveTextContent("0")
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "state",
						state: {
							cwd: "/workspace",
							taskHistory: [
								{
									id: "saved-task",
									number: 1,
									ts: 1,
									task: "Saved task",
									tokensIn: 0,
									tokensOut: 0,
									totalCost: 0,
									workspace: "/workspace",
								},
							],
						},
					},
				}),
			)
		})
		expect(screen.getByTestId("history-count")).toHaveTextContent("1")
	})
})
