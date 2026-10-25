import React, { useState } from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"

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
vi.mock("../Markdown", () => ({ Markdown: ({ markdown }: { markdown: string }) => <div>{markdown}</div> }))

describe("McpExecution", () => {
	it("restores response disclosure after the parent turn unmounts its body", () => {
		function FoldableTurn() {
			const [visible, setVisible] = useState(true)
			const [expanded, setExpanded] = useState<boolean>()
			return (
				<>
					<button onClick={() => setVisible((value) => !value)}>Toggle turn</button>
					{visible && (
						<McpExecution
							executionId="retained"
							useMcpServer={{
								type: "use_mcp_tool",
								serverName: "server",
								toolName: "search",
								arguments: "{}",
								response: "Retained response",
							}}
							isExpanded={expanded}
							onExpandedChange={setExpanded}
						/>
					)}
				</>
			)
		}
		render(<FoldableTurn />)
		const responseToggle = screen.getByRole("button", { name: "execution.expandResponse", expanded: false })
		expect(document.getElementById(responseToggle.getAttribute("aria-controls")!)).not.toBeVisible()
		fireEvent.click(responseToggle)
		expect(screen.getByText("Retained response")).toBeVisible()
		fireEvent.click(screen.getByRole("button", { name: "Toggle turn" }))
		expect(screen.queryByText("Retained response")).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Toggle turn" }))
		expect(screen.getByText("Retained response")).toBeVisible()
		fireEvent.click(screen.getByRole("button", { name: "execution.collapseResponse", expanded: true }))
		fireEvent.click(screen.getByRole("button", { name: "Toggle turn" }))
		fireEvent.click(screen.getByRole("button", { name: "Toggle turn" }))
		expect(screen.queryByText("Retained response")).not.toBeInTheDocument()
	})

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
