import React from "react"

import { render, screen } from "@/utils/test-utils"
import { TranslationContext } from "@src/i18n/TranslationContext"
import i18n from "@src/i18n/setup"

import Announcement from "../Announcement"

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("@alpha/package", () => ({
	Package: {
		version: "3.2.9",
	},
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeLink: ({ children, href, onClick, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
		<a href={href} onClick={onClick} {...props}>
			{children}
		</a>
	),
}))

const renderAnnouncement = (language = "en") =>
	render(
		<TranslationContext.Provider value={{ i18n, t: (key, options) => i18n.t(key, { ...options, lng: language }) }}>
			<Announcement hideAnnouncement={vi.fn()} />
		</TranslationContext.Provider>,
	)

describe("Announcement", () => {
	it("renders the current release announcement", () => {
		renderAnnouncement()
		expect(screen.getByRole("dialog")).toHaveAccessibleDescription(
			i18n.t("chat:announcement.release.welcome", { lng: "en", version: "3.2.9" }),
		)

		expect(screen.getByText("Welcome to Alpha v3.2.9")).toBeInTheDocument()
		expect(screen.getByText("Alpha v3.2.9 improves long chat reliability and Worker handoffs.")).toBeInTheDocument()
	})

	it("renders the release highlights", () => {
		renderAnnouncement()

		expect(screen.getAllByRole("listitem")).toHaveLength(4)
		expect(
			screen.getByText(
				"Keep long chats responsive and recover their controls after compaction or a view reload.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText("Use updated Copilot model aliases and supported reasoning controls."),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Bring completed Worker changes back automatically while preserving conflict review and existing approvals.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText("Create Decision and Review tickets alongside existing ticket types."),
		).toBeInTheDocument()
	})

	it("falls back to English release text when a retired locale is requested", () => {
		renderAnnouncement("de")

		expect(screen.getByText("Alpha v3.2.9 improves long chat reliability and Worker handoffs.")).toBeInTheDocument()
		expect(
			screen.getByText(
				"Keep long chats responsive and recover their controls after compaction or a view reload.",
			),
		).toBeInTheDocument()
	})
})
