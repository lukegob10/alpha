import { fireEvent, render, screen, waitFor } from "@/utils/test-utils"

import type { TaskReasoningPreference, TaskReasoningProjection } from "@alpha-code/types"

import { useExtensionState } from "@/context/ExtensionStateContext"
import { vscode } from "@/utils/vscode"
import { ChatReasoningControl } from "../ChatReasoningControl"

vi.mock("@/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: vi.fn(),
}))

vi.mock("../ReasoningSelector", () => ({
	ReasoningSelector: ({
		state,
		loading,
		saving,
		error,
		onChange,
		scopeKey,
	}: {
		state?: TaskReasoningProjection
		loading?: boolean
		saving?: boolean
		error?: boolean
		onChange: (preference: TaskReasoningPreference) => void
		scopeKey: string
	}) => (
		<div
			data-testid="reasoning-selector"
			data-scope={scopeKey}
			data-loading={String(Boolean(loading))}
			data-saving={String(Boolean(saving))}
			data-error={String(Boolean(error))}
			data-effective={state?.effective.kind === "effort" ? state.effective.effort : state?.effective.kind}>
			<button data-testid="choose-high" onClick={() => onChange({ kind: "effort", effort: "high" })} />
			<button data-testid="choose-low" onClick={() => onChange({ kind: "effort", effort: "low" })} />
		</div>
	),
}))

const mockPostMessage = vscode.postMessage as ReturnType<typeof vi.fn>
const mockUseExtensionState = useExtensionState as ReturnType<typeof vi.fn>
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
})
