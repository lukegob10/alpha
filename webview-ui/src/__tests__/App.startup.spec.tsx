import React, { StrictMode } from "react"
import { cleanup, render, screen } from "@testing-library/react"

import type { ExtensionMessage, WebviewMessage } from "@alpha-code/types"
import type { ExtensionStateContextType } from "@src/context/ExtensionStateContext"

import { vscode } from "@src/utils/vscode"
import { initializeSourceMaps } from "@src/utils/sourceMapInitializer"

import AppWithProviders from "../App"

const captureStartupState = vi.hoisted(() => vi.fn<(state: ExtensionStateContextType) => void>())

vi.mock("@src/utils/vscode", () => ({
	vscode: { postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() },
}))

vi.mock("@src/components/chat/ChatView", async () => {
	const React = await import("react")
	const { useShellState } = await import("@src/context/ExtensionStateContext")
	return {
		default: React.forwardRef(function StartupChat() {
			const state = useShellState()
			captureStartupState(state)
			return <div data-testid="startup-chat">{state.customInstructions}</div>
		}),
	}
})

vi.mock("@src/components/welcome/WelcomeViewProvider", () => ({ default: () => <div>Welcome</div> }))

vi.mock("@src/utils/sourceMapInitializer", () => ({
	initializeSourceMaps: vi.fn(() => vi.fn()),
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
		const startupState = captureStartupState.mock.calls.at(-1)?.[0]
		for (const key of ["telemetrySetting", "telemetryKey", "machineId", "setTelemetrySetting"]) {
			expect(startupState).not.toHaveProperty(key)
		}
		expect(vi.mocked(vscode.postMessage).mock.calls.map(([message]) => message.type)).not.toContain(
			"telemetrySetting",
		)

		const disposeSourceMaps = vi.mocked(initializeSourceMaps).mock.results.at(-1)?.value
		firstMount.unmount()
		expect(disposeSourceMaps).toHaveBeenCalledTimes(1)
		expect(disposeSourceMaps).toHaveBeenCalledWith()
		render(app)
		expect(launches).toBe(2)
		expect(screen.getByTestId("startup-chat")).toHaveTextContent("Hydrated on launch 2")
	})
})
