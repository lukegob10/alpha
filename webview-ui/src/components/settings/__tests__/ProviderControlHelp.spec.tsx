import type { ModelInfo } from "@alpha-code/types"

import { fireEvent, render, screen, waitFor } from "@/utils/test-utils"

import { ModelInfoView } from "../ModelInfoView"
import { R1FormatSetting } from "../R1FormatSetting"
import { RateLimitSecondsControl } from "../RateLimitSecondsControl"
import { SettingsHelp } from "../SettingsHelp"
import { Verbosity } from "../Verbosity"

describe("provider control help", () => {
	it("keeps R1 compatibility guidance in help without changing the option", () => {
		const onChange = vi.fn()
		render(<R1FormatSetting openAiR1FormatEnabled={false} onChange={onChange} />)
		const guidance = "Must be enabled when using R1 models such as QWQ to prevent 400 errors"
		expect(screen.queryByText(guidance)).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Help for Enable R1 model parameters" }))
		expect(screen.getByText(guidance)).toBeInTheDocument()
		expect(onChange).not.toHaveBeenCalled()
	})

	it("keeps rate-limit guidance in help while showing the current delay", () => {
		const onChange = vi.fn()
		render(<RateLimitSecondsControl value={7} onChange={onChange} />)
		expect(screen.getByText("7s")).toBeInTheDocument()
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
		const helpButton = screen.getByRole("button", { name: /^Help for / })
		fireEvent.click(helpButton)
		expect(screen.getByRole("dialog")).toHaveTextContent("Minimum time between API requests")
		expect(onChange).not.toHaveBeenCalled()
	})

	it("keeps verbosity guidance in help without changing its inherited value", () => {
		const setApiConfigurationField = vi.fn()
		render(
			<Verbosity
				apiConfiguration={{ apiProvider: "openai", openAiModelId: "gpt-5.4" }}
				modelInfo={{ contextWindow: 128_000, supportsPromptCache: false, supportsVerbosity: true }}
				setApiConfigurationField={setApiConfigurationField}
			/>,
		)
		expect(screen.getByTestId("verbosity")).toBeInTheDocument()
		expect(screen.queryByText(/Controls response detail on supported request routes/)).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: /^Help for / }))
		expect(screen.getByText(/Controls response detail on supported request routes/)).toBeInTheDocument()
		expect(setApiConfigurationField).not.toHaveBeenCalled()
	})

	it("keeps full model descriptions and capabilities accessible within model help", async () => {
		const info: ModelInfo = {
			description: "A long **provider description**.\n\nAdditional details remain available here.",
			contextWindow: 128_000,
			maxTokens: 8_192,
			supportsImages: true,
			supportsPromptCache: false,
			inputPrice: 1,
			outputPrice: 2,
		}
		render(
			<SettingsHelp label="Model">
				<ModelInfoView modelInfo={info} />
			</SettingsHelp>,
		)
		expect(screen.queryByText(/Additional details remain/)).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Help for Model" }))
		await waitFor(() => expect(screen.getByText(/Additional details remain/)).toBeInTheDocument())
		expect(screen.getByText("provider description")).toBeInTheDocument()
		expect(screen.getByText("Supports images")).toBeInTheDocument()
		expect(screen.getByText("Input price:")).toBeInTheDocument()
		expect(screen.queryByText("More")).not.toBeInTheDocument()
	})

	it("preserves hide-pricing behavior in model help", () => {
		render(
			<SettingsHelp label="Model">
				<ModelInfoView
					modelInfo={{ contextWindow: 128_000, supportsPromptCache: false, inputPrice: 1 }}
					hidePricing
				/>
			</SettingsHelp>,
		)
		fireEvent.click(screen.getByRole("button", { name: "Help for Model" }))
		expect(screen.getByText("Context Window:")).toBeInTheDocument()
		expect(screen.queryByText("Input price:")).not.toBeInTheDocument()
	})

	it("does not enable raw HTML or executable links in provider descriptions", () => {
		const { container } = render(
			<ModelInfoView
				modelInfo={{
					contextWindow: 128_000,
					supportsPromptCache: false,
					description: "[Unsafe](javascript:alert(1))\n\n<script>alert(1)</script>",
				}}
			/>,
		)
		expect(screen.getByText("Unsafe")).not.toHaveAttribute("href", "javascript:alert(1)")
		expect(container.querySelector("script")).toBeNull()
	})
})
