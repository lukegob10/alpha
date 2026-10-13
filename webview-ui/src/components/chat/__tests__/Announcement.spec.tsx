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
		version: "3.1.11",
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
			i18n.t("chat:announcement.release.welcome", { lng: "en", version: "3.1.11" }),
		)

		expect(screen.getByText("Welcome to Alpha v3.1.11")).toBeInTheDocument()
		expect(
			screen.getByText("Alpha v3.1.11 improves agent coordination, task goals, and the chat experience."),
		).toBeInTheDocument()
	})

	it("renders the release highlights", () => {
		renderAnnouncement()

		expect(screen.getAllByRole("listitem")).toHaveLength(4)
		expect(
			screen.getByText(
				"Sub-agents deliver results automatically and retain messages across follow-up turns and recovery.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText("Saved task goals keep progress and usage accounting connected across delegated work."),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Answer questions one at a time, revisit your choices, and review completed answers in the chat.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Choose automatic steering or queued messages, with clearer Agents settings and activity indicators.",
			),
		).toBeInTheDocument()
	})

	it("falls back to English release text when a retired locale is requested", () => {
		renderAnnouncement("de")

		expect(
			screen.getByText("Alpha v3.1.11 improves agent coordination, task goals, and the chat experience."),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Sub-agents deliver results automatically and retain messages across follow-up turns and recovery.",
			),
		).toBeInTheDocument()
	})
})
