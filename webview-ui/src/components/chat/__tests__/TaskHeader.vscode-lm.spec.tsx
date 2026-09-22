import type { ExtensionState, LiveTaskMetadata, ProviderSettings } from "@alpha-code/types"
import { TaskLifecycleState, TaskStatus } from "@alpha-code/types"
import i18next from "i18next"

import { act, fireEvent, render, screen } from "@/utils/test-utils"
import { ExtensionStateContextProvider, useExtensionState } from "@/context/ExtensionStateContext"
import common from "@/i18n/locales/en/common.json"

import TaskHeader from "../TaskHeader"

vi.mock("../TaskActions", () => ({ TaskActions: () => null }))
vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
	initReactI18next: { type: "3rdParty", init: vi.fn() },
}))

const configuration = (vsCodeLmContextSize: number): ProviderSettings => ({
	apiProvider: "vscode-lm",
	vsCodeLmModelSelector: { vendor: "copilot", family: "claude-opus-4.7" },
	vsCodeLmContextSize,
})

const liveTask = (id: string, contextWindow: number): LiveTaskMetadata => ({
	id,
	model: {
		id: "copilot-claude-opus-4.7",
		info: { contextWindow, maxTokens: 64_000, contextWindowIncludesOutput: false, supportsPromptCache: false },
	},
	status: TaskStatus.Running,
	lifecycle: TaskLifecycleState.Running,
	isActive: id === "visible-task",
	isStreaming: false,
	isWaitingForInput: false,
	lastUpdatedAt: 1,
	queueCount: 0,
	tokensIn: 100_000,
	tokensOut: 0,
	totalCost: 0,
})

function sendState(state: Partial<ExtensionState>) {
	act(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "state", state } })))
}

function ContextBoundTaskHeader() {
	const { apiConfiguration, currentTaskItem, liveTasksById } = useExtensionState()
	return (
		<TaskHeader
			apiConfiguration={apiConfiguration}
			currentTaskItem={currentTaskItem}
			taskModel={currentTaskItem ? liveTasksById?.[currentTaskItem.id]?.model : undefined}
			tokensIn={100_000}
			tokensOut={0}
			totalCost={0}
			contextTokens={100_000}
			buttonsDisabled={false}
			handleCondenseContext={vi.fn()}
		/>
	)
}

function renderHeader() {
	render(
		<ExtensionStateContextProvider>
			<ContextBoundTaskHeader />
		</ExtensionStateContextProvider>,
	)
	sendState({
		apiConfiguration: configuration(200_000),
		currentTaskId: "visible-task",
		currentView: { type: "task", taskId: "visible-task" },
		currentTaskItem: {
			id: "visible-task",
			number: 1,
			ts: 1,
			task: "Context display",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		},
	})
	fireEvent.click(screen.getByRole("button", { name: "chat:task.expand" }))
}

describe("VS Code LM chat context metadata", () => {
	beforeAll(async () => {
		await i18next.init({ lng: "en", resources: { en: { common } } })
	})

	it("updates the displayed capacity and percentage when the saved context selection changes", () => {
		renderHeader()
		expect(screen.getByTestId("context-window-size")).toHaveTextContent("200.0k")

		sendState({ apiConfiguration: configuration(936_000) })
		expect(screen.getByTestId("context-window-size")).toHaveTextContent("936.0k")
		expect(screen.getByText("11%")).toBeVisible()

		sendState({ apiConfiguration: configuration(200_000) })
		expect(screen.getByTestId("context-window-size")).toHaveTextContent("200.0k")
		expect(screen.getByText("50%")).toBeVisible()
	})

	it("uses the visible task's live input limit and falls back to its saved selection on older hosts", () => {
		renderHeader()
		sendState({
			apiConfiguration: configuration(936_000),
			liveTasksById: {
				"visible-task": liveTask("visible-task", 935_793),
				"background-task": liveTask("background-task", 200_000),
			},
		})
		expect(screen.getByTestId("context-window-size")).toHaveTextContent("935.8k")
		expect(screen.getByText("11%")).toBeVisible()

		sendState({ liveTasksById: { "visible-task": liveTask("visible-task", 199_793) } })
		expect(screen.getByTestId("context-window-size")).toHaveTextContent("199.8k")
		expect(screen.getByText("50%")).toBeVisible()

		sendState({ liveTasksById: {} })
		expect(screen.getByTestId("context-window-size")).toHaveTextContent("936.0k")
	})
})
