import React, { useState } from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"
import type { McpExecutionStatus } from "@alpha-code/types"

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

function publishStatus(status: McpExecutionStatus) {
	act(() => {
		window.dispatchEvent(
			new MessageEvent("message", {
				data: { type: "mcpExecutionStatus", text: JSON.stringify(status) },
			}),
		)
	})
}

describe("McpExecution", () => {
	it("prefers the correlated saved full response over its bounded streaming preview", () => {
		render(
			<McpExecution
				executionId="full"
				isExpanded
				isArguments
				executionStatus={{ executionId: "full", status: "completed" }}
				executionResponse="Truncated preview"
				useMcpServer={{ type: "use_mcp_tool", serverName: "server", response: "Full saved response" }}
			/>,
		)
		expect(screen.getByText("Full saved response")).toBeVisible()
		expect(screen.queryByText("Truncated preview")).not.toBeInTheDocument()
	})

	it.each(["completed", "error", "cancelled"] as const)("restores %s status and response after remount", (status) => {
		const card = (
			<McpExecution
				executionId="retained-status"
				isArguments
				executionStatus={{ executionId: "retained-status", status }}
				executionResponse="Retained response"
				isExpanded
			/>
		)
		const first = render(card)
		first.unmount()
		render(card)
		expect(
			screen.getByText(
				status === "completed" ? "Completed" : status === "error" ? "Error" : "execution.cancelled",
			),
		).toBeVisible()
		expect(screen.getByText("Retained response")).toBeVisible()
	})

	it("does not present invocation arguments as a response before output arrives", () => {
		render(
			<McpExecution
				executionId="pending"
				text={'{"query":"search"}'}
				isArguments
				useMcpServer={{
					type: "use_mcp_tool",
					serverName: "server",
					toolName: "search",
					arguments: '{"query":"search"}',
				}}
			/>,
		)

		expect(screen.queryByRole("button", { name: "execution.expandResponse" })).not.toBeInTheDocument()
	})

	it("keeps streamed and failed output separate from invocation arguments", () => {
		render(
			<McpExecution
				executionId="streamed"
				text={'{"query":"search"}'}
				isArguments
				useMcpServer={{
					type: "use_mcp_tool",
					serverName: "server",
					toolName: "search",
					arguments: '{"query":"search"}',
				}}
			/>,
		)

		publishStatus({ executionId: "streamed", status: "output", response: "First " })
		publishStatus({ executionId: "streamed", status: "output", response: "result" })
		fireEvent.click(screen.getByRole("button", { name: "execution.expandResponse" }))
		expect(screen.getByText("First result")).toBeVisible()
		publishStatus({ executionId: "streamed", status: "error", error: "The request failed" })
		expect(screen.getByText("Error")).toBeVisible()
		expect(screen.getByText("First result")).toBeVisible()
	})

	it("retains response-only text without invocation arguments", () => {
		render(<McpExecution executionId="response-only" text="Saved response" />)

		fireEvent.click(screen.getByRole("button", { name: "execution.expandResponse" }))
		expect(screen.getByText("Saved response")).toBeVisible()
	})

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
