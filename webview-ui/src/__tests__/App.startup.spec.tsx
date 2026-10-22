import React, { StrictMode } from "react"
import { cleanup, render, screen } from "@testing-library/react"

import type { ExtensionMessage, WebviewMessage } from "@alpha-code/types"

import { vscode } from "@src/utils/vscode"

import AppWithProviders from "../App"

vi.mock("@src/utils/vscode", () => ({
	vscode: { postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() },
}))

vi.mock("@src/components/chat/ChatView", async () => {
	const React = await import("react")
	const { useShellState } = await import("@src/context/ExtensionStateContext")
	return {
		default: React.forwardRef(function StartupChat() {
			const { customInstructions } = useShellState()
			return <div data-testid="startup-chat">{customInstructions}</div>
		}),
	}
})

vi.mock("@src/components/welcome/WelcomeViewProvider", () => ({ default: () => <div>Welcome</div> }))

vi.mock("@src/utils/TelemetryClient", () => ({
	telemetryClient: { capture: vi.fn(), updateTelemetryState: vi.fn() },
}))

vi.mock("@src/utils/sourceMapInitializer", () => ({
	initializeSourceMaps: vi.fn(),
	exposeSourceMapsForDebugging: vi.fn(),
}))

describe("App startup", () => {
	beforeEach(() => vi.clearAllMocks())
	afterEach(cleanup)

	it.each([false, true])("announces launch once with its state listener ready (StrictMode: %s)", (strictMode) => {
		let launches = 0
		vi.mocked(vscode.postMessage).mockImplementation((message: WebviewMessage) => {
			if (message.type !== "webviewDidLaunch") return
			launches++
			const response: ExtensionMessage = {
				type: "state",
				state: {
					apiConfiguration: { apiProvider: "openai", openAiModelId: "fixture-model" },
					customInstructions: `Hydrated on launch ${launches}`,
				},
			}
			window.dispatchEvent(new MessageEvent("message", { data: response }))
		})
		const app = strictMode ? (
			<StrictMode>
				<AppWithProviders />
			</StrictMode>
		) : (
			<AppWithProviders />
		)

		const firstMount = render(app)
		expect(launches).toBe(1)
		expect(screen.getByTestId("startup-chat")).toHaveTextContent("Hydrated on launch 1")

		firstMount.unmount()
		render(app)
		expect(launches).toBe(2)
		expect(screen.getByTestId("startup-chat")).toHaveTextContent("Hydrated on launch 2")
	})
})
