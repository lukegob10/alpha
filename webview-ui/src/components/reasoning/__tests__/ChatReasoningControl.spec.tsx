import { act, fireEvent, render, screen, waitFor } from "@/utils/test-utils"

import type { ExtensionState, TaskReasoningPreference, TaskReasoningProjection } from "@alpha-code/types"

import { useExtensionState } from "@/context/ExtensionStateContext"
import { vscode } from "@/utils/vscode"
import { ChatReasoningControl } from "../ChatReasoningControl"

vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("@/context/ExtensionStateContext", () => {
	const useExtensionState = vi.fn()
	return {
		useExtensionState,
		useShellState: () => useExtensionState(),
	}
})

vi.mock("../ReasoningSelector", () => ({
	ReasoningSelector: ({
		state,
		loading,
		isVisible,
		saving,
		error,
		onChange,
		scopeKey,
	}: {
		state?: TaskReasoningProjection
		loading?: boolean
		isVisible?: boolean
		saving?: boolean
		error?: boolean
		onChange: (preference: TaskReasoningPreference) => void
		scopeKey: string
	}) => (
		<div
			data-testid="reasoning-selector"
			data-scope={scopeKey}
			data-loading={String(Boolean(loading))}
			data-visible={String(isVisible)}
			data-saving={String(Boolean(saving))}
			data-error={String(Boolean(error))}
			data-capability={state?.capabilities.kind}
			data-effective={state?.effective.kind === "effort" ? state.effective.effort : state?.effective.kind}>
			<button data-testid="choose-high" onClick={() => onChange({ kind: "effort", effort: "high" })} />
			<button data-testid="choose-low" onClick={() => onChange({ kind: "effort", effort: "low" })} />
		</div>
	),
}))

const mockPostMessage = vscode.postMessage as import("vitest").Mock
const mockUseExtensionState = useExtensionState as import("vitest").Mock
const request1 = "00000000-0000-0000-0000-000000000001"
const request2 = "00000000-0000-0000-0000-000000000002"

const stateFor = (taskId: string, effort: "low" | "medium" | "high" = "medium"): TaskReasoningProjection => ({
	taskId,
	requested: { kind: "effort", effort },
	effective: { kind: "effort", effort },
	capabilities: { kind: "effort", efforts: ["low", "medium", "high"], canDisable: true },
})

const hostAck = (
	requestId: string,
	taskId: string | undefined,
	state: TaskReasoningProjection,
	error?: "saveFailed",
) => ({
	type: "taskReasoningUpdated",
	taskReasoningResponse: { requestId, taskId, state, error },
})

const currentState = (taskId = "task-1", profile = "profile-a", effort: "low" | "medium" | "high" = "medium") => ({
	currentTaskId: taskId,
	currentApiConfigName: profile,
	apiConfiguration: { apiProvider: "openai", apiModelId: profile },
	taskReasoning: stateFor(taskId, effort),
})

describe("ChatReasoningControl", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.spyOn(crypto, "randomUUID").mockReturnValue(request1)
		mockUseExtensionState.mockReturnValue(currentState())
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("posts a task-scoped preference with a request id and exposes saving state", () => {
		render(<ChatReasoningControl />)

		fireEvent.click(screen.getByTestId("choose-high"))

		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "setTaskReasoningPreference",
			taskReasoningUpdate: {
				requestId: request1,
				taskId: "task-1",
				preference: { kind: "effort", effort: "high" },
			},
		})
		expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-saving", "true")
		expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-visible", "true")
	})

	it.each([false, true])("retains the request scope while hidden (draft: %s)", async (isDraft) => {
		const { rerender } = render(<ChatReasoningControl isDraft={isDraft} />)
		const taskId = isDraft ? undefined : "task-1"
		const scope = screen.getByTestId("reasoning-selector").getAttribute("data-scope") ?? ""
		fireEvent.click(screen.getByTestId("choose-high"))

		rerender(<ChatReasoningControl isDraft={isDraft} isVisible={false} />)
		expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-visible", "false")
		expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-scope", scope)
		expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-saving", "true")
		expect(mockPostMessage).toHaveBeenCalledTimes(1)

		window.dispatchEvent(
			new MessageEvent("message", {
				data: hostAck(request1, taskId, { ...stateFor("task-1", "high"), taskId }),
			}),
		)
		await waitFor(() => {
			expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-saving", "false")
			expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-effective", "high")
		})

		rerender(<ChatReasoningControl isDraft={isDraft} />)
		expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-visible", "true")
		expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-scope", scope)
		expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-saving", "false")
		expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-effective", "high")
		expect(mockPostMessage).toHaveBeenCalledTimes(1)
		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "setTaskReasoningPreference",
			taskReasoningUpdate: {
				requestId: request1,
				taskId,
				preference: { kind: "effort", effort: "high" },
			},
		})
	})

	it("uses the taskless composer path and accepts its matching acknowledgement", async () => {
		const tasklessState = { ...stateFor("task-1", "medium"), taskId: undefined }
		mockUseExtensionState.mockReturnValue({
			currentTaskId: undefined,
			currentApiConfigName: "profile-a",
			apiConfiguration: { apiProvider: "openai", apiModelId: "profile-a" },
			taskReasoning: tasklessState,
		})
		render(<ChatReasoningControl />)

		fireEvent.click(screen.getByTestId("choose-high"))
		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "setTaskReasoningPreference",
			taskReasoningUpdate: {
				requestId: request1,
				taskId: undefined,
				preference: { kind: "effort", effort: "high" },
			},
		})

		window.dispatchEvent(
			new MessageEvent("message", {
				data: hostAck(request1, undefined, { ...tasklessState, effective: { kind: "effort", effort: "high" } }),
			}),
		)

		await waitFor(() => {
			expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-saving", "false")
			expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-effective", "high")
		})
	})

	it("addresses the draft before the host leaves the previous chat", async () => {
		render(<ChatReasoningControl isDraft />)
		expect(screen.getByTestId("reasoning-selector")).not.toHaveAttribute("data-effective")

		fireEvent.click(screen.getByTestId("choose-high"))
		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "setTaskReasoningPreference",
			taskReasoningUpdate: {
				requestId: request1,
				taskId: undefined,
				preference: { kind: "effort", effort: "high" },
			},
		})

		window.dispatchEvent(
			new MessageEvent("message", {
				data: hostAck(request1, undefined, { ...stateFor("task-1", "high"), taskId: undefined }),
			}),
		)
		await waitFor(() => {
			expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-saving", "false")
			expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-effective", "high")
		})
	})

	it("ignores a previous chat acknowledgement after the composer enters the draft", async () => {
		vi.mocked(crypto.randomUUID).mockReturnValueOnce(request1).mockReturnValueOnce(request2)
		const { rerender } = render(<ChatReasoningControl />)
		fireEvent.click(screen.getByTestId("choose-high"))
		rerender(<ChatReasoningControl isDraft />)

		window.dispatchEvent(
			new MessageEvent("message", { data: hostAck(request1, "task-1", stateFor("task-1", "high")) }),
		)
		await waitFor(() => {
			expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-saving", "false")
			expect(screen.getByTestId("reasoning-selector")).not.toHaveAttribute("data-effective")
		})

		fireEvent.click(screen.getByTestId("choose-low"))
		expect(mockPostMessage).toHaveBeenLastCalledWith({
			type: "setTaskReasoningPreference",
			taskReasoningUpdate: {
				requestId: request2,
				taskId: undefined,
				preference: { kind: "effort", effort: "low" },
			},
		})
		window.dispatchEvent(
			new MessageEvent("message", { data: hostAck(request2, "task-1", stateFor("task-1", "high")) }),
		)
		expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-saving", "true")

		window.dispatchEvent(
			new MessageEvent("message", {
				data: hostAck(request2, undefined, { ...stateFor("task-1", "low"), taskId: undefined }),
			}),
		)
		await waitFor(() => {
			expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-saving", "false")
			expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-effective", "low")
		})
	})

	it("ignores stale acknowledgements and applies only the latest matching response", async () => {
		vi.mocked(crypto.randomUUID).mockReturnValueOnce(request1).mockReturnValueOnce(request2)
		render(<ChatReasoningControl />)

		fireEvent.click(screen.getByTestId("choose-high"))
		fireEvent.click(screen.getByTestId("choose-low"))

		window.dispatchEvent(
			new MessageEvent("message", { data: hostAck(request1, "task-1", stateFor("task-1", "high")) }),
		)
		expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-saving", "true")
		expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-effective", "medium")

		window.dispatchEvent(
			new MessageEvent("message", { data: hostAck(request2, "task-1", stateFor("task-1", "low")) }),
		)

		await waitFor(() => {
			expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-saving", "false")
			expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-effective", "low")
		})
	})

	it("ignores an acknowledgement from a different task or profile scope", async () => {
		const { rerender } = render(<ChatReasoningControl />)
		fireEvent.click(screen.getByTestId("choose-high"))

		window.dispatchEvent(
			new MessageEvent("message", { data: hostAck(request1, "task-2", stateFor("task-2", "high")) }),
		)
		expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-saving", "true")

		mockUseExtensionState.mockReturnValue(currentState("task-1", "profile-b", "low"))
		rerender(<ChatReasoningControl />)
		await waitFor(() =>
			expect(screen.getByTestId("reasoning-selector")).toHaveAttribute(
				"data-scope",
				expect.stringContaining("profile-b"),
			),
		)

		window.dispatchEvent(
			new MessageEvent("message", { data: hostAck(request1, "task-1", stateFor("task-1", "high")) }),
		)
		expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-saving", "false")
		expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-effective", "low")
	})

	it("shows a matching save failure while retaining the host state", async () => {
		render(<ChatReasoningControl />)
		fireEvent.click(screen.getByTestId("choose-high"))

		window.dispatchEvent(
			new MessageEvent("message", {
				data: hostAck(request1, "task-1", stateFor("task-1", "medium"), "saveFailed"),
			}),
		)

		await waitFor(() => {
			expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-saving", "false")
			expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-error", "true")
			expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-effective", "medium")
		})
	})

	it("clears saving state for an invalid existing-task update when the response is task-addressed", async () => {
		render(<ChatReasoningControl />)
		fireEvent.click(screen.getByTestId("choose-high"))

		window.dispatchEvent(
			new MessageEvent("message", {
				data: {
					type: "taskReasoningUpdated",
					taskReasoningResponse: { requestId: request1, taskId: "task-1", error: "invalid" },
				},
			}),
		)

		await waitFor(() => {
			expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-saving", "false")
			expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-error", "true")
		})
	})

	it("resets pending acknowledgements when the task or profile changes", async () => {
		const { rerender } = render(<ChatReasoningControl profileLoading={false} />)
		fireEvent.click(screen.getByTestId("choose-high"))
		expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-saving", "true")

		mockUseExtensionState.mockReturnValue(currentState("task-2", "profile-b", "low"))
		rerender(<ChatReasoningControl profileLoading={true} />)

		await waitFor(() => {
			expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-saving", "false")
			expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-loading", "true")
			expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-effective", "low")
		})

		window.dispatchEvent(
			new MessageEvent("message", { data: hostAck(request1, "task-1", stateFor("task-1", "high")) }),
		)
		expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-effective", "low")
	})

	it("keeps the new-chat composer usable when a leftover task id survives a draft snapshot", async () => {
		const { rerender } = render(<ChatReasoningControl />)
		expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-effective", "medium")

		const draftReasoning = { ...stateFor("task-1", "high"), taskId: undefined }
		mockUseExtensionState.mockReturnValue({
			...currentState("task-1", "profile-a", "medium"),
			currentView: { type: "newTaskDraft" },
			taskReasoning: draftReasoning,
		})
		rerender(<ChatReasoningControl />)

		await waitFor(() => {
			expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-effective", "high")
			expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-loading", "false")
		})

		fireEvent.click(screen.getByTestId("choose-low"))
		expect(mockPostMessage).toHaveBeenCalledWith({
			type: "setTaskReasoningPreference",
			taskReasoningUpdate: {
				requestId: request1,
				taskId: undefined,
				preference: { kind: "effort", effort: "low" },
			},
		})
	})

	it("keeps draft reasoning through real compact state delivery and accepts an explicit capability downgrade", async () => {
		const { ExtensionStateContextProvider, useShellState } = await vi.importActual<
			typeof import("@/context/ExtensionStateContext")
		>("@/context/ExtensionStateContext")
		mockUseExtensionState.mockImplementation(useShellState)
		render(
			<ExtensionStateContextProvider>
				<ChatReasoningControl isDraft />
			</ExtensionStateContextProvider>,
		)
		const sendState = (state: Partial<ExtensionState>) => {
			act(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "state", state } })))
		}
		const draftReasoning = { ...stateFor("task-1", "high"), taskId: undefined }
		sendState({
			currentView: { type: "newTaskDraft" },
			currentApiConfigName: "profile-a",
			apiConfiguration: { apiProvider: "openai", apiModelId: "profile-a" },
			taskStateSeq: 1,
			taskReasoning: draftReasoning,
		})
		expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-effective", "high")

		// This is the host's lifecycle/usage patch: it carries navigation and sequence,
		// while omitting the unchanged provider settings and draft reasoning projection.
		sendState({
			currentView: { type: "newTaskDraft" },
			liveTaskIds: [],
			liveTasksById: {},
			taskStateSeq: 2,
		})
		expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-effective", "high")
		expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-capability", "effort")

		sendState({
			taskStateSeq: 3,
			taskReasoning: {
				requested: { kind: "default" },
				effective: { kind: "off" },
				capabilities: { kind: "unavailable", canDisable: false },
				fallbackReason: "unavailable",
			},
		})
		expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-capability", "unavailable")
		expect(screen.getByTestId("reasoning-selector")).toHaveAttribute("data-effective", "off")
	})
})
