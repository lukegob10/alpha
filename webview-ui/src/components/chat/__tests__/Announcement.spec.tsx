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
		version: "3.2.2",
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
			i18n.t("chat:announcement.release.welcome", { lng: "en", version: "3.2.2" }),
		)

		expect(screen.getByText("Welcome to Alpha v3.2.2")).toBeInTheDocument()
		expect(
			screen.getByText("Alpha v3.2.2 loads more quickly and improves follow-up reliability."),
		).toBeInTheDocument()
	})

	it("renders the release highlights", () => {
		renderAnnouncement()

		expect(screen.getAllByRole("listitem")).toHaveLength(4)
		expect(
			screen.getByText("Continue completed and reopened chats reliably, including replies to recovery prompts."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Start model requests and terminal commands with less preparation work."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Open settings and chat history with fewer unnecessary background loads."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Load diagrams when needed and preserve chat drafts and terminal preview preferences."),
		).toBeInTheDocument()
	})

	it("falls back to English release text when a retired locale is requested", () => {
		renderAnnouncement("de")

		expect(
			screen.getByText("Alpha v3.2.2 loads more quickly and improves follow-up reliability."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Continue completed and reopened chats reliably, including replies to recovery prompts."),
		).toBeInTheDocument()
	})
})
