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
		version: "2.0.4",
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

		expect(screen.getByText("Welcome to Alpha v2.0.4")).toBeInTheDocument()
		expect(screen.getByText("Alpha v2.0.4 keeps long-running chats steady and easy to follow.")).toBeInTheDocument()
	})

	it("renders the release highlights", () => {
		render(<Announcement hideAnnouncement={vi.fn()} />)

		expect(screen.getAllByRole("listitem")).toHaveLength(2)
		expect(screen.getByText("Long transcripts now open on the newest message.")).toBeInTheDocument()
		expect(screen.getByText("Recovery controls no longer shift the chat viewport.")).toBeInTheDocument()
	})
})
