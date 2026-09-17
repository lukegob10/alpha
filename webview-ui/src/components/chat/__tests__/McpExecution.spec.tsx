import React from "react"
import { act, render, screen } from "@testing-library/react"

import { McpExecution } from "../McpExecution"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) =>
			({
				"execution.running": "Running",
				"execution.completed": "Completed",
				"execution.error": "Error",
			})[key] ?? key,
	}),
}))

vi.mock("../../common/CodeBlock", () => ({ default: () => null }))
vi.mock("../../mcp/McpToolRow", () => ({ default: () => null }))
vi.mock("../Markdown", () => ({ Markdown: () => null }))

describe("McpExecution", () => {
	it("renders output status as a running nonterminal state", () => {
		const { container } = render(<McpExecution executionId="execution-1" />)

		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "mcpExecutionStatus",
						text: JSON.stringify({
							executionId: "execution-1",
							status: "output",
							response: "partial result",
						}),
					},
				}),
			)
		})

		expect(screen.getByText("Running")).toHaveClass("text-vscode-foreground")
		expect(screen.queryByText("Error")).not.toBeInTheDocument()
		expect(container.querySelector(".bg-lime-400")).toBeInTheDocument()
		expect(container.querySelector(".bg-red-400")).not.toBeInTheDocument()
	})
})
