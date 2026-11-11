import { expect } from "vitest"
import type { InputHTMLAttributes, ReactNode } from "react"

import { fireEvent, render, screen } from "@/utils/test-utils"

import { CheckpointSettings } from "../CheckpointSettings"

vi.mock("@/i18n/TranslationContext", () => ({
	useAppTranslation: () => ({
		t: (key: string, options?: { label?: string }) =>
			key === "settings:helpFor" ? `${key}:${options?.label}` : key,
	}),
}))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ children, ...props }: InputHTMLAttributes<HTMLInputElement>) => (
		<label>
			<input type="checkbox" {...props} />
			{children}
		</label>
	),
}))
vi.mock("@/components/ui", async () => {
	const { Slider } = await vi.importActual<typeof import("@/components/ui/slider")>("@/components/ui/slider")
	return { Slider }
})
vi.mock("../SearchableSetting", () => ({
	SearchableSetting: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

describe("CheckpointSettings recovery preferences", () => {
	it.each(["enable", "timeout"])("keeps recovery explanations in the %s help control", (control) => {
		const setCachedStateField = vi.fn()
		render(
			<CheckpointSettings enableCheckpoints checkpointTimeout={25} setCachedStateField={setCachedStateField} />,
		)
		const helpLabel = `settings:helpFor:settings:checkpoints.${control}.label`
		const explanation = `settings:checkpoints.${control}.description`
		expect(screen.queryByText(explanation)).not.toBeInTheDocument()

		fireEvent.click(screen.getByRole("button", { name: helpLabel }))

		expect(screen.getByRole("dialog", { name: helpLabel })).toHaveTextContent(explanation)
		expect(screen.getByRole("checkbox")).toBeChecked()
		expect(screen.getByRole("slider")).toHaveAttribute("aria-valuenow", "25")
		expect(setCachedStateField).not.toHaveBeenCalled()
	})

	it("embeds recovery without a sticky section header and preserves saved opt-outs", () => {
		const setCachedStateField = vi.fn()
		render(<CheckpointSettings embedded enableCheckpoints={false} setCachedStateField={setCachedStateField} />)

		expect(
			screen.getByRole("heading", { level: 4, name: "settings:checkpoints.recoveryTitle" }),
		).toBeInTheDocument()
		expect(screen.queryByRole("heading", { level: 3 })).not.toBeInTheDocument()
		expect(screen.getByRole("checkbox")).not.toBeChecked()
		expect(screen.queryByRole("slider")).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "settings:helpFor:settings:checkpoints.enable.label" }))
		expect(screen.getByRole("checkbox")).not.toBeChecked()
		expect(screen.queryByRole("slider")).not.toBeInTheDocument()
		expect(setCachedStateField).not.toHaveBeenCalled()
	})

	it("uses production defaults without writing them to the edit buffer", () => {
		const setCachedStateField = vi.fn()
		render(<CheckpointSettings setCachedStateField={setCachedStateField} />)

		expect(screen.getByRole("checkbox")).toBeChecked()
		expect(screen.getByRole("slider", { name: "settings:checkpoints.timeout.label" })).toHaveAttribute(
			"aria-valuenow",
			"15",
		)
		expect(setCachedStateField).not.toHaveBeenCalled()
	})

	it("keeps the timeout slider synchronized with the cached edit buffer after reset", () => {
		const setCachedStateField = vi.fn()
		const { rerender } = render(
			<CheckpointSettings enableCheckpoints checkpointTimeout={30} setCachedStateField={setCachedStateField} />,
		)
		expect(screen.getByRole("slider")).toHaveAttribute("aria-valuenow", "30")

		rerender(
			<CheckpointSettings enableCheckpoints checkpointTimeout={15} setCachedStateField={setCachedStateField} />,
		)

		expect(screen.getByRole("slider")).toHaveAttribute("aria-valuenow", "15")
		expect(setCachedStateField).not.toHaveBeenCalled()
		fireEvent.click(screen.getByRole("checkbox"))
		expect(setCachedStateField).toHaveBeenCalledExactlyOnceWith("enableCheckpoints", false)
	})
})
