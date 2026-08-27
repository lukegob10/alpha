import React from "react"

import { render, screen } from "@/utils/test-utils"

import Announcement from "../Announcement"

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("@alpha/package", () => ({
	Package: {
		version: "2.1.2",
	},
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeLink: ({ children, href, onClick, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
		<a href={href} onClick={onClick} {...props}>
			{children}
		</a>
	),
}))

vi.mock("react-i18next", () => ({
	Trans: ({ i18nKey }: { i18nKey: string }) => <span>{i18nKey}</span>,
}))

describe("Announcement", () => {
	it("renders the current release announcement", () => {
		render(<Announcement hideAnnouncement={vi.fn()} />)

		expect(screen.getByText("Welcome to Alpha v2.1.2")).toBeInTheDocument()
		expect(
			screen.getByText(
				"Alpha v2.1.2 expands reliable model access while keeping provider setup and task steering stable.",
			),
		).toBeInTheDocument()
	})

	it("renders the release highlights", () => {
		render(<Announcement hideAnnouncement={vi.fn()} />)

		expect(screen.getAllByRole("listitem")).toHaveLength(4)
		expect(
			screen.getByText("Stellar connects internal models through Helix authentication and enterprise PEM trust."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Anthropic, Gemini, OpenAI, Vertex AI, and VS Code LM model catalogs are current."),
		).toBeInTheDocument()
		expect(
			screen.getByText("OpenAI-compatible and Vertex AI native tool calls are more resilient."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Queued steering and custom model selection stay task-scoped and stable."),
		).toBeInTheDocument()
	})
})
