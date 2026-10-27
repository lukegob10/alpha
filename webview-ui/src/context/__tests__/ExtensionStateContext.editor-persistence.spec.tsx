import { act, render } from "@/utils/test-utils"
import type { ExtensionState } from "@alpha-code/types"

import { vscode } from "@src/utils/vscode"
import { ExtensionStateContextProvider } from "../ExtensionStateContext"

const publish = (state: Partial<ExtensionState>) => {
	act(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "state", state } })))
}

describe("editor chat restore metadata", () => {
	afterEach(() => vi.restoreAllMocks())

	it("persists only accepted editor navigation while preserving unrelated webview state", () => {
		vi.spyOn(vscode, "getState").mockReturnValue({ scrollPosition: 20 })
		const save = vi.spyOn(vscode, "setState")
		render(
			<ExtensionStateContextProvider>
				<div />
			</ExtensionStateContextProvider>,
		)
		expect(save).not.toHaveBeenCalled()

		publish({
			renderContext: "editor",
			currentView: { type: "task", taskId: "new-task" },
			currentTaskId: "new-task",
			taskStateSeq: 2,
			alphaMessages: [{ ts: 1, type: "say", say: "text", text: "private transcript" }],
			apiConfiguration: { apiProvider: "openai", openAiApiKey: "private-key" },
		})
		expect(save).toHaveBeenLastCalledWith({
			scrollPosition: 20,
			alphaEditorChat: { version: 1, currentView: { type: "task", taskId: "new-task" } },
		})

		save.mockClear()
		publish({ currentView: { type: "task", taskId: "stale-task" }, currentTaskId: "stale-task", taskStateSeq: 1 })
		publish({ currentView: { type: "task", taskId: "new-task" }, currentTaskId: "new-task", taskStateSeq: 3 })
		expect(save).not.toHaveBeenCalled()

		publish({ currentView: { type: "newTaskDraft" }, taskStateSeq: 4 })
		expect(save).toHaveBeenLastCalledWith({
			scrollPosition: 20,
			alphaEditorChat: { version: 1, currentView: { type: "newTaskDraft" } },
		})
	})

	it("does not save sidebar selection or an unsequenced editor transport patch", () => {
		const save = vi.spyOn(vscode, "setState")
		render(
			<ExtensionStateContextProvider>
				<div />
			</ExtensionStateContextProvider>,
		)
		publish({ renderContext: "editor", messageQueueSeq: 1, messageQueue: [] })
		expect(save).not.toHaveBeenCalled()
		publish({ renderContext: "sidebar", currentView: { type: "task", taskId: "sidebar-task" }, taskStateSeq: 1 })
		expect(save).not.toHaveBeenCalled()
	})
})
