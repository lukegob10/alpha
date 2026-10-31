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
		version: "3.2.19",
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
			i18n.t("chat:announcement.release.welcome", { lng: "en", version: "3.2.19" }),
		)

		expect(screen.getByText("Welcome to Alpha v3.2.19")).toBeInTheDocument()
		expect(
			screen.getByText(
				"Alpha v3.2.19 improves reasoning controls, task handoffs, and reliability during long-running work.",
			),
		).toBeInTheDocument()
	})

	it("renders the release highlights", () => {
		renderAnnouncement()

		expect(screen.getAllByRole("listitem")).toHaveLength(4)
		expect(
			screen.getByText("Keep chats and sub-agents responsive through cancellation, completion, and reloads."),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Improve provider streaming, tool-result persistence, MCP discovery, and command cleanup.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Give new chats clear work assignments while preserving inherited approvals and workspace limits.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Preserve reasoning selections during background updates and improve typing, transcripts, and agent navigation.",
			),
		).toBeInTheDocument()
	})

	it("falls back to English release text when a retired locale is requested", () => {
		renderAnnouncement("de")

		expect(
			screen.getByText(
				"Alpha v3.2.19 improves reasoning controls, task handoffs, and reliability during long-running work.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText("Keep chats and sub-agents responsive through cancellation, completion, and reloads."),
		).toBeInTheDocument()
	})
})
