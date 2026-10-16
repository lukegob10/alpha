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
		version: "3.2.1",
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
			i18n.t("chat:announcement.release.welcome", { lng: "en", version: "3.2.1" }),
		)

		expect(screen.getByText("Welcome to Alpha v3.2.1")).toBeInTheDocument()
		expect(
			screen.getByText(
				"Alpha v3.2.1 makes chats easier to navigate and supports sub-agents in folders without a Git repository.",
			),
		).toBeInTheDocument()
	})

	it("renders the release highlights", () => {
		renderAnnouncement()

		expect(screen.getAllByRole("listitem")).toHaveLength(4)
		expect(
			screen.getByText(
				"See recent chats before starting, switch quickly between chats, and keep custom chat names across reloads.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Use the native Alpha toolbar, compact sub-agent controls, and file reviews that keep your expansion choices.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Copy or edit your messages, and keep the Send button visible when the draft cannot be sent yet.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Launch sub-agents in folders without a Git repository while keeping workspace isolation, approvals, and recovery.",
			),
		).toBeInTheDocument()
	})

	it("falls back to English release text when a retired locale is requested", () => {
		renderAnnouncement("de")

		expect(
			screen.getByText(
				"Alpha v3.2.1 makes chats easier to navigate and supports sub-agents in folders without a Git repository.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"See recent chats before starting, switch quickly between chats, and keep custom chat names across reloads.",
			),
		).toBeInTheDocument()
	})
})
