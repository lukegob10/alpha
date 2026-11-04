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
		version: "3.2.22",
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
			i18n.t("chat:announcement.release.welcome", { lng: "en", version: "3.2.22" }),
		)

		expect(screen.getByText("Welcome to Alpha v3.2.22")).toBeInTheDocument()
		expect(
			screen.getByText("Alpha v3.2.22 simplifies settings, skill access, and file review."),
		).toBeInTheDocument()
	})

	it("renders the release highlights", () => {
		renderAnnouncement()

		expect(screen.getAllByRole("listitem")).toHaveLength(4)
		expect(
			screen.getByText("Keep parallel reads moving with ordered approvals and reliable task recovery."),
		).toBeInTheDocument()
		expect(screen.getByText("Call skills with /skill-name without a separate command setup.")).toBeInTheDocument()
		expect(screen.getByText("Work in Code or Plan with a focused English interface.")).toBeInTheDocument()
		expect(
			screen.getByText("Review changes in VS Code and configure more embedding models for code search."),
		).toBeInTheDocument()
	})

	it("falls back to English release text when a retired locale is requested", () => {
		renderAnnouncement("de")

		expect(
			screen.getByText("Alpha v3.2.22 simplifies settings, skill access, and file review."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Keep parallel reads moving with ordered approvals and reliable task recovery."),
		).toBeInTheDocument()
	})
})
