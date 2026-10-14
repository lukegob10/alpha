import { fireEvent, render, screen } from "@/utils/test-utils"
import type { AlphaMessage, HistoryItem } from "@alpha-code/types"
import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"
import { vscode } from "@src/utils/vscode"
import ChatRow, { type ChatRowEnvironment } from "../ChatRow"

vi.mock("@src/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

const markdown = "# Current design\n\n- Implement the persisted approach."
const item: HistoryItem = {
	id: "plan-task",
	number: 1,
	ts: 1,
	task: "Design the change",
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	taskKind: "primary",
	designHandoff: { markdown, sourceTaskId: "plan-task", digest: "a".repeat(64), updatedAt: 1 },
}
const message: AlphaMessage = {
	ts: 2,
	type: "say",
	say: "completion_result",
	text: `<proposed_plan>\n${markdown}\n</proposed_plan>`,
}

function showPlan(options: { history?: HistoryItem; mode?: string; partial?: boolean; busy?: boolean } = {}) {
	const environment: ChatRowEnvironment = {
		mcpServers: [],
		alwaysAllowMcp: false,
		mode: options.mode ?? "architect",
		currentTaskId: item.id,
		currentTaskItem: options.history ?? item,
		reasoningBlockCollapsed: true,
		getAlphaMessages: () => [message],
	}
	return render(
		<ExtensionStateContextProvider>
			<ChatRow
				message={{ ...message, partial: options.partial }}
				environment={environment}
				isExpanded
				isLast
				isStreaming={options.busy ?? false}
				onToggleExpand={() => {}}
			/>
		</ExtensionStateContextProvider>,
	)
}

describe("stored plan action", () => {
	beforeEach(() => vi.clearAllMocks())

	it("sends the owning task and stored digest only after a user click", () => {
		showPlan()
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "implementPlan" }))
		fireEvent.click(screen.getByRole("button", { name: "Implement plan" }))
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "implementPlan",
			taskId: item.id,
			planDigest: item.designHandoff!.digest,
		})
	})

	it.each([
		{ history: { ...item, designHandoff: undefined } },
		{ history: { ...item, id: "another-task" } },
		{ history: { ...item, designHandoff: { ...item.designHandoff!, markdown: "# Replacement" } } },
		{ mode: "code" },
		{ partial: true },
	])("does not offer an action for absent, stale, or incomplete plans (%j)", (options) => {
		showPlan(options)
		expect(screen.queryByRole("button", { name: "Implement plan" })).not.toBeInTheDocument()
	})

	it("disables the action while work is running", () => {
		showPlan({ busy: true })
		const button = screen.getByRole("button", { name: "Implement plan" })
		expect(button).toBeDisabled()
		fireEvent.click(button)
		expect(vscode.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "implementPlan" }))
	})
})
