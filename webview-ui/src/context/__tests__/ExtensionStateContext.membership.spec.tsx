import { act, render } from "@/utils/test-utils"
import { type ExtensionState, type LiveTaskMetadata, TaskLifecycleState, TaskStatus } from "@alpha-code/types"

import { ExtensionStateContextProvider, useExtensionState } from "../ExtensionStateContext"

const metadata = (id: string, transcriptRevision = 1): LiveTaskMetadata => ({
	id,
	transcriptRevision,
	status: TaskStatus.Running,
	lifecycle: TaskLifecycleState.Running,
	isActive: false,
	isStreaming: true,
	isWaitingForInput: false,
	lastUpdatedAt: transcriptRevision,
	queueCount: 0,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
})

const renderState = () => {
	let current!: ReturnType<typeof useExtensionState>
	const Probe = () => {
		current = useExtensionState()
		return null
	}
	render(
		<ExtensionStateContextProvider>
			<Probe />
		</ExtensionStateContextProvider>,
	)
	return () => current
}

const publish = (data: unknown) => act(() => window.dispatchEvent(new MessageEvent("message", { data })))
const publishState = (state: Partial<ExtensionState>) => publish({ type: "state", state })

describe("incremental task membership", () => {
	afterEach(() => vi.unstubAllGlobals())

	it.each([
		{ type: "messageCreated", partial: false },
		{ type: "messageUpdated", partial: false },
		{ type: "messageUpdated", partial: true },
	])("does not restore a removed background task from $type (partial: $partial)", ({ type, partial }) => {
		let frame: FrameRequestCallback | undefined
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			frame = callback
			return 1
		})
		vi.stubGlobal("cancelAnimationFrame", vi.fn())
		const read = renderState()
		const foreground = metadata("foreground")
		publishState({
			currentTaskId: "foreground",
			taskStateSeq: 1,
			alphaMessagesSeq: 10,
			alphaMessages: [{ ts: 1, type: "say", say: "text", text: "visible transcript" }],
			liveTaskIds: ["foreground", "removed"],
			liveTasksById: { foreground, removed: metadata("removed") },
		})
		publishState({ taskStateSeq: 2, liveTaskIds: ["foreground"], liveTasksById: { foreground } })
		const removed = read()

		publish({
			type,
			taskId: "removed",
			alphaMessagesSeq: 9,
			alphaMessage: { ts: 2, type: "say", say: "text", text: "late background update", partial },
			liveTask: metadata("removed", 2),
		})
		if (partial) act(() => frame?.(0))

		expect(read().liveTasksById).toBe(removed.liveTasksById)
		expect(read().liveTasksById?.removed).toBeUndefined()
		expect(read().liveTaskIds).toEqual(["foreground"])
		expect(read().alphaMessages).toBe(removed.alphaMessages)
	})

	it.each([undefined, 1])(
		"accepts an initial update before host membership is known (sequence: %j)",
		(taskStateSeq) => {
			const read = renderState()
			publishState({ currentTaskId: "foreground", taskStateSeq, liveTasksById: undefined })
			const background = metadata("background")
			publish({
				type: "messageCreated",
				taskId: "background",
				alphaMessage: { ts: 2, type: "say", say: "text", text: "first update" },
				liveTask: background,
			})
			expect(read().liveTasksById?.background).toEqual(background)
		},
	)

	it("accepts background updates after the host explicitly readmits the task", () => {
		const read = renderState()
		publishState({ currentTaskId: "foreground", taskStateSeq: 1, liveTasksById: {}, liveTaskIds: [] })
		publishState({
			taskStateSeq: 2,
			liveTasksById: { background: metadata("background") },
			liveTaskIds: ["background"],
		})
		const background = metadata("background", 2)
		publish({
			type: "messageUpdated",
			taskId: "background",
			alphaMessage: { ts: 2, type: "say", say: "text", text: "readmitted update" },
			liveTask: background,
		})
		expect(read().liveTasksById?.background).toEqual(background)
		expect(read().alphaMessages).toEqual([])
	})
})
