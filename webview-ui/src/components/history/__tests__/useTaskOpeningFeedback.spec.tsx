import { act, fireEvent, render, screen } from "@/utils/test-utils"
import { type AlphaMessage, type ExtensionState, TaskLifecycleState, TaskStatus } from "@alpha-code/types"

import { ExtensionStateContextProvider } from "@/context/ExtensionStateContext"
import { vscode } from "@/utils/vscode"
import { useTaskOpeningFeedback } from "../useTaskOpeningFeedback"

vi.mock("@/utils/vscode", () => ({ vscode: { postMessage: vi.fn() } }))

const publishState = (state: Partial<ExtensionState>) =>
	act(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "state", state } })))

describe("task opening transcript cache", () => {
	beforeEach(() => vi.clearAllMocks())

	it("does not re-render opening controls for 120 transcript-only updates", () => {
		let renders = 0
		const Probe = () => {
			renders++
			const { openTask } = useTaskOpeningFeedback("history-task")
			return <button onClick={openTask}>Open history</button>
		}
		render(
			<ExtensionStateContextProvider>
				<Probe />
			</ExtensionStateContextProvider>,
		)
		publishState({ currentTaskId: "streaming-task", alphaMessages: [], alphaMessagesSeq: 1 })
		const initialRenders = renders
		for (let index = 0; index < 120; index++) {
			publishState({
				alphaMessages: [{ ts: 1, type: "say", say: "text", text: `Partial ${index}`, partial: true }],
				alphaMessagesSeq: index + 2,
			})
		}
		expect(renders).toBe(initialRenders)
	})

	it("reads the latest cached revision on click after transcript-only hydration", () => {
		const Probe = () => {
			const { openTask } = useTaskOpeningFeedback("cached-task")
			return <button onClick={openTask}>Open cached chat</button>
		}
		render(
			<ExtensionStateContextProvider>
				<Probe />
			</ExtensionStateContextProvider>,
		)
		publishState({ currentTaskId: "cached-task", alphaMessages: [], alphaMessagesSeq: 1 })
		const messages: AlphaMessage[] = [{ ts: 1, type: "say", say: "text", text: "Restored transcript" }]
		publishState({
			currentTaskId: "cached-task",
			alphaMessages: messages,
			alphaMessagesSeq: 2,
			liveTasksById: {
				"cached-task": {
					id: "cached-task",
					transcriptRevision: 7,
					status: TaskStatus.Idle,
					lifecycle: TaskLifecycleState.Waiting,
					isActive: true,
					isStreaming: false,
					isWaitingForInput: false,
					lastUpdatedAt: 1,
					queueCount: 0,
					tokensIn: 0,
					tokensOut: 0,
					totalCost: 0,
				},
			},
		})
		fireEvent.click(screen.getByRole("button", { name: "Open cached chat" }))
		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "showTaskWithId",
			text: "cached-task",
			values: { cachedTranscriptRevision: 7 },
		})
	})
})
