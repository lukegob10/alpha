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
		version: "2.0.5",
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

		expect(screen.getByText("Welcome to Alpha v2.0.5")).toBeInTheDocument()
		expect(
			screen.getByText(
				"Alpha v2.0.5 keeps long-running chats steady while streaming and adds clear separation between the transcript scrollbar and composer.",
			),
		).toBeInTheDocument()
	})

	it("renders the release highlights", () => {
		render(<Announcement hideAnnouncement={vi.fn()} />)

		expect(screen.getAllByRole("listitem")).toHaveLength(2)
		expect(
			screen.getByText("Streaming growth and layout changes now share one stable bottom-follow path."),
		).toBeInTheDocument()
		expect(
			screen.getByText("The transcript scrollbar now ends with breathing room above the composer."),
		).toBeInTheDocument()
	})
})
