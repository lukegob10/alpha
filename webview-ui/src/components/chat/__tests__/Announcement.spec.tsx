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
		version: "3.2.12",
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
			i18n.t("chat:announcement.release.welcome", { lng: "en", version: "3.2.12" }),
		)

		expect(screen.getByText("Welcome to Alpha v3.2.12")).toBeInTheDocument()
		expect(
			screen.getByText("Alpha v3.2.12 improves chat controls, saved-chat navigation, and diagram previews."),
		).toBeInTheDocument()
	})

	it("renders the release highlights", () => {
		renderAnnouncement()

		expect(screen.getAllByRole("listitem")).toHaveLength(4)
		expect(
			screen.getByText("Browse older and newer saved chats in a stable workspace history."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Steer queued messages in order while keeping unsent text and images intact."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Cycle approval modes and keep questions open until you answer by default."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Open readable Mermaid diagrams in vector previews with native editor zoom controls."),
		).toBeInTheDocument()
	})

	it("falls back to English release text when a retired locale is requested", () => {
		renderAnnouncement("de")

		expect(
			screen.getByText("Alpha v3.2.12 improves chat controls, saved-chat navigation, and diagram previews."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Browse older and newer saved chats in a stable workspace history."),
		).toBeInTheDocument()
	})
})
