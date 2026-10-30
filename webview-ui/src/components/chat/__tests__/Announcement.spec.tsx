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
		version: "3.2.18",
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
			i18n.t("chat:announcement.release.welcome", { lng: "en", version: "3.2.18" }),
		)

		expect(screen.getByText("Welcome to Alpha v3.2.18")).toBeInTheDocument()
		expect(
			screen.getByText(
				"Alpha v3.2.18 improves sub-agent reliability, conversation continuity, and the chat experience.",
			),
		).toBeInTheDocument()
	})

	it("renders the release highlights", () => {
		renderAnnouncement()

		expect(screen.getAllByRole("listitem")).toHaveLength(4)
		expect(
			screen.getByText(
				"Recover interrupted work and finish sub-agent runs without leaving stale running indicators.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Preserve provider history, reasoning settings, and tool results through recovery and follow-ups.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Delegate in the shared workspace with inherited permissions and visible model and reasoning labels.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Enjoy refreshed Alpha branding, clearer agent navigation, and more readable Markdown tables.",
			),
		).toBeInTheDocument()
	})

	it("falls back to English release text when a retired locale is requested", () => {
		renderAnnouncement("de")

		expect(
			screen.getByText(
				"Alpha v3.2.18 improves sub-agent reliability, conversation continuity, and the chat experience.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Recover interrupted work and finish sub-agent runs without leaving stale running indicators.",
			),
		).toBeInTheDocument()
	})
})
