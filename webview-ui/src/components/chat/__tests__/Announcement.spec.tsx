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
		version: "3.2.3",
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
			i18n.t("chat:announcement.release.welcome", { lng: "en", version: "3.2.3" }),
		)

		expect(screen.getByText("Welcome to Alpha v3.2.3")).toBeInTheDocument()
		expect(
			screen.getByText("Alpha v3.2.3 refines the chat experience and improves thread reliability."),
		).toBeInTheDocument()
	})

	it("renders the release highlights", () => {
		renderAnnouncement()

		expect(screen.getAllByRole("listitem")).toHaveLength(4)
		expect(
			screen.getByText("Keep follow-ups and chat history reliable across task updates and recovery."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Coordinate work across threads with integrated orchestration tools."),
		).toBeInTheDocument()
		expect(screen.getByText("Keep task titles and cross-thread chat delivery consistent.")).toBeInTheDocument()
		expect(
			screen.getByText("Compose ticket mentions and long messages with stable previews and chat layouts."),
		).toBeInTheDocument()
	})

	it("falls back to English release text when a retired locale is requested", () => {
		renderAnnouncement("de")

		expect(
			screen.getByText("Alpha v3.2.3 refines the chat experience and improves thread reliability."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Keep follow-ups and chat history reliable across task updates and recovery."),
		).toBeInTheDocument()
	})
})
