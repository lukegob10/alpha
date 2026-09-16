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
		version: "2.1.44",
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

		expect(screen.getByText("Welcome to Alpha v2.1.44")).toBeInTheDocument()
		expect(
			screen.getByText(
				"Alpha v2.1.44 makes background editing safer and calmer while preserving the proven Code loop.",
			),
		).toBeInTheDocument()
	})

	it("renders the release highlights", () => {
		render(<Announcement hideAnnouncement={vi.fn()} />)

		expect(screen.getAllByRole("listitem")).toHaveLength(4)
		expect(
			screen.getByText("Background edits keep your focus, open tabs, cursor, and unsaved typing in place."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Cancelled or abandoned saves stop before a late write can change the workspace."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Directory reads explain how to continue with the list-files tool."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Background command results now report their actual exit status to the next model step."),
		).toBeInTheDocument()
	})
})
