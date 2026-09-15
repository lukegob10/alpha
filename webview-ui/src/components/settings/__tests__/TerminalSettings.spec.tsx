import { act, fireEvent, render, screen } from "@/utils/test-utils"

import { vscode } from "@/utils/vscode"

import { TerminalSettings } from "../TerminalSettings"

let messageHandler: ((event: MessageEvent) => void) | undefined

vi.mock("@/utils/vscode", () => ({
	vscode: { postMessage: vi.fn() },
}))

vi.mock("react-use", () => ({
	useMount: (callback: () => void) => callback(),
	useEvent: (_type: string, handler: (event: MessageEvent) => void) => {
		messageHandler = handler
	},
}))

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("react-i18next", () => ({
	Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ checked, onChange, children, ...props }: any) => (
		<label>
			<input type="checkbox" checked={checked} onChange={onChange} {...props} />
			{children}
		</label>
	),
	VSCodeLink: ({ children, ...props }: any) => <a {...props}>{children}</a>,
}))

vi.mock("../SectionHeader", () => ({
	SectionHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock("../Section", () => ({
	Section: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock("../SearchableSetting", () => ({
	SearchableSetting: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

describe("TerminalSettings", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		messageHandler = undefined
	})

	it("buffers inherit-environment edits without updating VS Code immediately", () => {
		const setCachedStateField = vi.fn()

		render(
			<TerminalSettings
				terminalShellIntegrationDisabled={false}
				terminalInheritEnv={true}
				onTerminalInheritEnvLoaded={vi.fn()}
				setCachedStateField={setCachedStateField}
			/>,
		)
		vi.mocked(vscode.postMessage).mockClear()

		fireEvent.click(screen.getByTestId("terminal-inherit-env-checkbox"))

		expect(setCachedStateField).toHaveBeenCalledWith("terminalInheritEnv", false)
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it("seeds the cached buffer from the requested VS Code setting", () => {
		const onTerminalInheritEnvLoaded = vi.fn()

		render(
			<TerminalSettings
				terminalShellIntegrationDisabled={false}
				terminalInheritEnv={true}
				onTerminalInheritEnvLoaded={onTerminalInheritEnvLoaded}
				setCachedStateField={vi.fn()}
			/>,
		)

		expect(vscode.postMessage).toHaveBeenCalledWith({
			type: "getVSCodeSetting",
			setting: "terminal.integrated.inheritEnv",
		})

		act(() => {
			messageHandler?.({
				data: {
					type: "vsCodeSetting",
					setting: "terminal.integrated.inheritEnv",
					value: false,
				},
			} as MessageEvent)
		})

		expect(onTerminalInheritEnvLoaded).toHaveBeenCalledWith(false)
	})
})
