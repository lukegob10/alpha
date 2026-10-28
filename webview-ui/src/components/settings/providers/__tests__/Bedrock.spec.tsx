import { useState, type ComponentProps, type PropsWithChildren } from "react"
import type { ProviderSettings } from "@alpha-code/types"

import { fireEvent, render, screen } from "@/utils/test-utils"
import { Bedrock } from "../Bedrock"

vi.mock("@src/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({ children, ...props }: PropsWithChildren<ComponentProps<"input">>) => (
		<div>
			{children}
			<input {...props} />
		</div>
	),
}))
vi.mock("@src/components/ui", () => ({
	SearchableSelect: ({
		value,
		onValueChange,
		options,
		...props
	}: {
		value: string
		onValueChange: (value: string) => void
		options: Array<{ value: string; label: string }>
		"aria-label": string
	}) => (
		<select aria-label={props["aria-label"]} value={value} onChange={(event) => onValueChange(event.target.value)}>
			{options.map(({ value, label }) => (
				<option key={value} value={value}>
					{label}
				</option>
			))}
		</select>
	),
}))

function BufferedBedrock({ initial }: { initial: ProviderSettings }) {
	const [buffer, setBuffer] = useState(initial)
	return (
		<>
			<Bedrock
				apiConfiguration={buffer}
				setApiConfigurationField={(field, value) => setBuffer((previous) => ({ ...previous, [field]: value }))}
			/>
			<output data-testid="buffer">{JSON.stringify(buffer)}</output>
		</>
	)
}

describe("Bedrock settings buffer", () => {
	it("shows the default region and credential-chain fields without modifying the profile", () => {
		const initial: ProviderSettings = { apiProvider: "bedrock" }
		render(<BufferedBedrock initial={initial} />)

		expect(screen.getByLabelText("settings:providers.bedrock.region")).toHaveValue("us-east-1")
		expect(screen.getByLabelText("settings:providers.bedrock.accessKey")).toHaveValue("")
		expect(screen.getByTestId("buffer")).toHaveTextContent(JSON.stringify(initial))
		expect(initial).toEqual({ apiProvider: "bedrock" })
	})

	it.each([
		["accessKey", "awsAccessKey"],
		["secretKey", "awsSecretKey"],
		["sessionToken", "awsSessionToken"],
		["region", "awsRegion"],
		["inferenceProfile", "awsCustomArn"],
	] as const)("keeps %s edits in the caller's buffer", (label, field) => {
		const initial: ProviderSettings = { apiProvider: "bedrock" }
		render(<BufferedBedrock initial={initial} />)
		fireEvent.input(screen.getByLabelText(`settings:providers.bedrock.${label}`), {
			target: { value: "buffered-value" },
		})

		expect(screen.getByLabelText(`settings:providers.bedrock.${label}`)).toHaveValue("buffered-value")
		expect(JSON.parse(screen.getByTestId("buffer").textContent ?? "{}")).toHaveProperty(field, "buffered-value")
		expect(initial[field]).toBeUndefined()
	})

	it("selects AWS profile authentication without enabling API-key authentication", () => {
		const initial: ProviderSettings = { apiProvider: "bedrock", awsApiKey: "saved-api-key", awsUseApiKey: true }
		render(<BufferedBedrock initial={initial} />)
		fireEvent.change(screen.getByLabelText("settings:providers.bedrock.authMethod"), {
			target: { value: "profile" },
		})
		fireEvent.input(screen.getByLabelText("settings:providers.bedrock.profileName"), { target: { value: "team" } })

		expect(JSON.parse(screen.getByTestId("buffer").textContent ?? "{}")).toMatchObject({
			awsUseApiKey: false,
			awsUseProfile: true,
			awsProfile: "team",
			awsApiKey: "saved-api-key",
		})
		expect(initial.awsUseApiKey).toBe(true)
	})

	it("selects Bedrock API-key authentication and masks the buffered key", () => {
		render(<BufferedBedrock initial={{ apiProvider: "bedrock", awsUseProfile: true, awsProfile: "team" }} />)
		fireEvent.change(screen.getByLabelText("settings:providers.bedrock.authMethod"), {
			target: { value: "apiKey" },
		})
		const input = screen.getByLabelText("settings:providers.bedrock.apiKey")
		fireEvent.input(input, { target: { value: "example-bedrock-key" } })

		expect(input).toHaveAttribute("type", "password")
		expect(JSON.parse(screen.getByTestId("buffer").textContent ?? "{}")).toMatchObject({
			awsUseApiKey: true,
			awsUseProfile: false,
			awsApiKey: "example-bedrock-key",
		})
	})
})
