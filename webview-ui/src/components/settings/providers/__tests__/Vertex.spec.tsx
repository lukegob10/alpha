import { fireEvent, render, screen } from "@testing-library/react"
import { Vertex } from "../Vertex"
import type { ProviderSettings } from "@alpha-code/types"
import { VERTEX_REGIONS } from "@alpha-code/types"

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ children, value, onInput, type, ...props }: any) => (
		<div>
			{children}
			<input type={type} value={value} onChange={(e) => onInput(e)} {...props} />
		</div>
	),
	VSCodeTextArea: ({ value, onInput, ...props }: any) => (
		<textarea value={value} onChange={(e) => onInput(e)} {...props} />
	),
	VSCodeLink: ({ children, href }: any) => <a href={href}>{children}</a>,
}))

vi.mock("vscrui", () => ({
	Checkbox: ({ children, checked, onChange, "data-testid": testId }: any) => (
		<label data-testid={testId}>
			<input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
			{children}
		</label>
	),
}))

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string) => {
			const translations: Record<string, string> = {
				"settings:providers.googleCloudSetup.title": "Google Cloud setup",
				"settings:providers.googleCloudSetup.step1": "Enable Vertex AI and model access",
				"settings:providers.googleCloudSetup.step2": "Set up Application Default Credentials",
				"settings:providers.googleCloudSetup.step3": "Create a service account key",
			}

			return translations[key] ?? key
		},
	}),
}))

vi.mock("@src/components/ui", () => ({
	SearchableSelect: ({ value, onValueChange, options, allowCustomValue, "data-testid": testId }: any) => (
		<div>
			<input
				value={value}
				onChange={(event) => onValueChange(event.target.value)}
				data-testid={testId}
				data-allow-custom-value={allowCustomValue ? "true" : "false"}
			/>
			{options.map((option: { value: string; label: string }) => (
				<div key={option.value} data-testid={`vertex-region-option-${option.value}`}>
					{option.label}
				</div>
			))}
		</div>
	),
	Select: ({ children, value, onValueChange }: any) => (
		<div data-value={value} data-onvaluechange={onValueChange}>
			{children}
		</div>
	),
	SelectContent: ({ children }: any) => <div>{children}</div>,
	SelectItem: ({ children, value }: any) => <div data-value={value}>{children}</div>,
	SelectTrigger: ({ children }: any) => <div>{children}</div>,
	SelectValue: ({ placeholder }: any) => <div>{placeholder}</div>,
}))

describe("Vertex", () => {
	const defaultApiConfiguration: ProviderSettings = {
		vertexKeyFile: "",
		vertexJsonCredentials: "",
		vertexProjectId: "",
		vertexRegion: "",
		vertexGatewayBaseUrl: "",
		vertexGatewayCaBundlePath: "",
		vertexGatewayHelixCommand: "",
		vertexGatewayTokenRefreshMinutes: undefined,
		vertexGatewayModelRoutingMap: "",
		apiModelId: "gemini-3.7-flash",
	}

	const mockSetApiConfigurationField = vi.fn()

	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("VERTEX_REGIONS", () => {
		it('should include the "global" region as the first entry', () => {
			expect(VERTEX_REGIONS[0]).toEqual({ value: "global", label: "global" })
		})

		it('should contain "global" region exactly once', () => {
			const globalRegions = VERTEX_REGIONS.filter((r: { value: string; label: string }) => r.value === "global")
			expect(globalRegions).toHaveLength(1)
		})

		it('should contain all expected regions including "global"', () => {
			// The expected list is the imported VERTEX_REGIONS itself
			expect(VERTEX_REGIONS).toEqual([
				{ value: "global", label: "global" },
				{ value: "us", label: "us" },
				{ value: "us-central1", label: "us-central1" },
				{ value: "us-east1", label: "us-east1" },
				{ value: "us-east4", label: "us-east4" },
				{ value: "us-east5", label: "us-east5" },
				{ value: "us-south1", label: "us-south1" },
				{ value: "us-west1", label: "us-west1" },
				{ value: "us-west2", label: "us-west2" },
				{ value: "us-west3", label: "us-west3" },
				{ value: "us-west4", label: "us-west4" },
				{ value: "northamerica-northeast1", label: "northamerica-northeast1" },
				{ value: "northamerica-northeast2", label: "northamerica-northeast2" },
				{ value: "southamerica-east1", label: "southamerica-east1" },
				{ value: "europe-west1", label: "europe-west1" },
				{ value: "europe-west2", label: "europe-west2" },
				{ value: "europe-west3", label: "europe-west3" },
				{ value: "europe-west4", label: "europe-west4" },
				{ value: "europe-west6", label: "europe-west6" },
				{ value: "europe-central2", label: "europe-central2" },
				{ value: "asia-east1", label: "asia-east1" },
				{ value: "asia-east2", label: "asia-east2" },
				{ value: "asia-northeast1", label: "asia-northeast1" },
				{ value: "asia-northeast2", label: "asia-northeast2" },
				{ value: "asia-northeast3", label: "asia-northeast3" },
				{ value: "asia-south1", label: "asia-south1" },
				{ value: "asia-south2", label: "asia-south2" },
				{ value: "asia-southeast1", label: "asia-southeast1" },
				{ value: "asia-southeast2", label: "asia-southeast2" },
				{ value: "australia-southeast1", label: "australia-southeast1" },
				{ value: "australia-southeast2", label: "australia-southeast2" },
				{ value: "me-west1", label: "me-west1" },
				{ value: "me-central1", label: "me-central1" },
				{ value: "africa-south1", label: "africa-south1" },
			])
		})

		it('should contain the "us" multi-region exactly once', () => {
			const usRegions = VERTEX_REGIONS.filter((region) => region.value === "us")

			expect(usRegions).toEqual([{ value: "us", label: "us" }])
		})

		it('should contain "asia-east1" region exactly once', () => {
			const asiaEast1Regions = VERTEX_REGIONS.filter(
				(r: { value: string; label: string }) => r.value === "asia-east1" && r.label === "asia-east1",
			)
			expect(asiaEast1Regions).toHaveLength(1)
			expect(asiaEast1Regions[0]).toEqual({ value: "asia-east1", label: "asia-east1" })
		})
	})

	it("should allow predefined and custom Vertex regions through cached api configuration callbacks", () => {
		render(
			<Vertex
				apiConfiguration={defaultApiConfiguration}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		const regionPicker = screen.getByTestId("vertex-region-picker")
		expect(regionPicker).toHaveAttribute("data-allow-custom-value", "true")
		expect(screen.getByTestId("vertex-region-option-us")).toHaveTextContent("us")

		fireEvent.change(regionPicker, { target: { value: "us" } })
		fireEvent.change(regionPicker, { target: { value: "custom-location1" } })

		expect(mockSetApiConfigurationField).toHaveBeenCalledWith("location", "us")
		expect(mockSetApiConfigurationField).toHaveBeenCalledWith("location", "custom-location1")
	})

	it("should not render URL context or grounding search checkboxes", () => {
		render(
			<Vertex
				apiConfiguration={defaultApiConfiguration}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		expect(screen.queryByTestId("checkbox-url-context")).not.toBeInTheDocument()
		expect(screen.queryByTestId("checkbox-grounding-search")).not.toBeInTheDocument()
	})

	it("should render Vertex gateway settings", () => {
		render(
			<Vertex
				apiConfiguration={{
					...defaultApiConfiguration,
					vertexGatewayBaseUrl: "https://gateway.example.com/vertex",
					vertexGatewayCaBundlePath: "/certs/corp.pem",
					vertexGatewayHelixCommand: "helix auth access-token print -a",
					vertexGatewayTokenRefreshMinutes: 15,
					vertexGatewayModelRoutingMap: '{"gemini-3.7-flash":"gateway-gemini-flash"}',
				}}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		expect(screen.getByText("settings:providers.vertexGatewayBaseUrl")).toBeInTheDocument()
		expect(screen.getByTestId("vertex-gateway-base-url")).toHaveValue("https://gateway.example.com/vertex")
		expect(screen.getByTestId("vertex-gateway-ca-bundle-path")).toHaveValue("/certs/corp.pem")
		expect(screen.getByTestId("vertex-gateway-helix-command")).toHaveValue("helix auth access-token print -a")
		expect(screen.getByTestId("vertex-gateway-token-refresh-minutes")).toHaveValue("15")
		expect(screen.getByTestId("vertex-gateway-model-routing-map")).toHaveValue(
			'{"gemini-3.7-flash":"gateway-gemini-flash"}',
		)
	})

	it("should render readable Google Cloud setup text", () => {
		render(
			<Vertex
				apiConfiguration={defaultApiConfiguration}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		expect(screen.getByText("Google Cloud setup")).toBeInTheDocument()
		expect(screen.getByText("Enable Vertex AI and model access")).toBeInTheDocument()
		expect(screen.getByText("Set up Application Default Credentials")).toBeInTheDocument()
		expect(screen.getByText("Create a service account key")).toBeInTheDocument()
		expect(screen.queryByText("settings:providers.googleCloudSetup.title")).not.toBeInTheDocument()
	})

	it("should render the streaming checkbox checked by default", () => {
		render(
			<Vertex
				apiConfiguration={defaultApiConfiguration}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		expect(screen.getByTestId("checkbox-vertex-streaming-enabled").querySelector("input")).toBeChecked()
	})

	it("should update the streaming setting through cached api configuration callbacks", () => {
		render(
			<Vertex
				apiConfiguration={defaultApiConfiguration}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		fireEvent.click(screen.getByTestId("checkbox-vertex-streaming-enabled").querySelector("input")!)

		expect(mockSetApiConfigurationField).toHaveBeenCalledWith("vertexStreamingEnabled", false)
	})

	it("should update Vertex gateway settings through cached api configuration callbacks", () => {
		render(
			<Vertex
				apiConfiguration={defaultApiConfiguration}
				setApiConfigurationField={mockSetApiConfigurationField}
			/>,
		)

		fireEvent.change(screen.getByTestId("vertex-gateway-base-url"), {
			target: { value: "https://gateway.example.com/vertex" },
		})
		fireEvent.change(screen.getByTestId("vertex-gateway-ca-bundle-path"), {
			target: { value: "/certs/corp.pem" },
		})
		fireEvent.change(screen.getByTestId("vertex-gateway-helix-command"), {
			target: { value: "helix auth access-token print -a" },
		})
		fireEvent.change(screen.getByTestId("vertex-gateway-token-refresh-minutes"), {
			target: { value: "20" },
		})
		fireEvent.change(screen.getByTestId("vertex-gateway-model-routing-map"), {
			target: { value: '{"gemini-3.7-flash":"gateway-gemini-flash"}' },
		})

		expect(mockSetApiConfigurationField).toHaveBeenCalledWith(
			"gatewayBaseUrl",
			"https://gateway.example.com/vertex",
		)
		expect(mockSetApiConfigurationField).toHaveBeenCalledWith("pemCaBundlePath", "/certs/corp.pem")
		expect(mockSetApiConfigurationField).toHaveBeenCalledWith("helixCommand", "helix auth access-token print -a")
		expect(mockSetApiConfigurationField).toHaveBeenCalledWith("refreshIntervalMinutes", 20)
		expect(mockSetApiConfigurationField).toHaveBeenCalledWith(
			"modelRoutingMap",
			'{"gemini-3.7-flash":"gateway-gemini-flash"}',
		)
	})
})
