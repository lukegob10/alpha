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
		version: "1.0.3",
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
	it("renders the v1.0.3 welcome announcement", () => {
		render(<Announcement hideAnnouncement={vi.fn()} />)

		expect(screen.getByText("Welcome to Alpha v1.0.3")).toBeInTheDocument()
		expect(
			screen.getByText("Alpha v1 is here. Welcome to the first release of the Alpha-branded extension."),
		).toBeInTheDocument()
	})

	it("does not render release highlight bullets", () => {
		render(<Announcement hideAnnouncement={vi.fn()} />)

		expect(screen.queryAllByRole("listitem")).toHaveLength(0)
	})
})
