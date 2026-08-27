import { fireEvent, render, screen } from "@testing-library/react"

import type { ProviderSettings } from "@alpha-code/types"

import { Stellar } from "../Stellar"
import { PROVIDERS } from "../../constants"

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ children, value, onInput, type, ...props }: any) => (
		<div>
			{children}
			<input type={type} value={value} onChange={(event) => onInput(event)} {...props} />
		</div>
	),
}))

vi.mock("vscrui", () => ({
	Checkbox: ({ children, checked, onChange, "data-testid": testId }: any) => (
		<label data-testid={testId}>
			<input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
			{children}
		</label>
	),
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock("@src/components/ui", () => ({
	Select: ({ children, value, onValueChange }: any) => (
		<div>
			<button data-testid="stellar-parse-mode-select" onClick={() => onValueChange("json_field")}>
				{value}
			</button>
			{children}
		</div>
	),
	SelectContent: ({ children }: any) => <div>{children}</div>,
	SelectItem: ({ children }: any) => <div>{children}</div>,
	SelectTrigger: ({ children }: any) => <div>{children}</div>,
	SelectValue: ({ placeholder }: any) => <div>{placeholder}</div>,
}))

describe("Stellar", () => {
	const configuration: ProviderSettings = {
		apiProvider: "stellar",
		stellarBaseUrl: "https://gateway.example.com/stellar/v1",
		stellarPemCaBundlePath: "C:\\certs\\corp.pem",
		stellarHelixCommand: "helix auth access-token print -a",
		stellarHelixParseMode: "json_field",
		stellarHelixTokenKey: "token.value",
		stellarTokenRefreshMinutes: 15,
		stellarStreamingEnabled: true,
	}

	const setApiConfigurationField = vi.fn()

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("is available in the standard provider list", () => {
		expect(PROVIDERS).toContainEqual({ value: "stellar", label: "Stellar", proxy: false })
	})

	it("renders values from the buffered API configuration", () => {
		render(<Stellar apiConfiguration={configuration} setApiConfigurationField={setApiConfigurationField} />)

		expect(screen.getByTestId("stellar-base-url")).toHaveValue("https://gateway.example.com/stellar/v1")
		expect(screen.getByTestId("stellar-ca-bundle-path")).toHaveValue("C:\\certs\\corp.pem")
		expect(screen.getByTestId("stellar-helix-command")).toHaveValue("helix auth access-token print -a")
		expect(screen.getByTestId("stellar-helix-token-key")).toHaveValue("token.value")
		expect(screen.getByTestId("stellar-token-refresh-minutes")).toHaveValue("15")
		expect(screen.getByTestId("checkbox-stellar-streaming-enabled").querySelector("input")).toBeChecked()
	})

	it("updates only through the cached configuration callback", () => {
		render(<Stellar apiConfiguration={configuration} setApiConfigurationField={setApiConfigurationField} />)

		fireEvent.change(screen.getByTestId("stellar-base-url"), {
			target: { value: "https://new.example.com/stellar/v1" },
		})
		fireEvent.change(screen.getByTestId("stellar-ca-bundle-path"), {
			target: { value: "C:\\certs\\new.pem" },
		})
		fireEvent.change(screen.getByTestId("stellar-token-refresh-minutes"), { target: { value: "20" } })
		fireEvent.click(screen.getByTestId("stellar-parse-mode-select"))
		fireEvent.click(screen.getByTestId("checkbox-stellar-streaming-enabled").querySelector("input")!)

		expect(setApiConfigurationField).toHaveBeenCalledWith("stellarBaseUrl", "https://new.example.com/stellar/v1")
		expect(setApiConfigurationField).toHaveBeenCalledWith("stellarPemCaBundlePath", "C:\\certs\\new.pem")
		expect(setApiConfigurationField).toHaveBeenCalledWith("stellarTokenRefreshMinutes", 20)
		expect(setApiConfigurationField).toHaveBeenCalledWith("stellarHelixParseMode", "json_field")
		expect(setApiConfigurationField).toHaveBeenCalledWith("stellarStreamingEnabled", false)
	})
})
