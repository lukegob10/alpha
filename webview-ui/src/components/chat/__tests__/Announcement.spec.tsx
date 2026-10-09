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
		version: "3.1.9",
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
			i18n.t("chat:announcement.release.welcome", { lng: "en", version: "3.1.9" }),
		)

		expect(screen.getByText("Welcome to Alpha v3.1.9")).toBeInTheDocument()
		expect(
			screen.getByText(
				"Alpha v3.1.9 keeps saved code searchable while indexing catches up and makes conversation steering more responsive.",
			),
		).toBeInTheDocument()
	})

	it("renders the release highlights", () => {
		renderAnnouncement()

		expect(screen.getAllByRole("listitem")).toHaveLength(4)
		expect(
			screen.getByText(
				"Saved edits remain searchable while embeddings catch up, with grouped updates and bounded embedding traffic.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Send a message during an active response to steer the conversation sooner, while keeping queued input safe.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Codebase search checks snippets against saved files and explains when search coverage is incomplete.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"See clearer activity in recent chats and keep using the Windows shortcuts for task navigation and reasoning.",
			),
		).toBeInTheDocument()
	})

	it("falls back to English release text when a retired locale is requested", () => {
		renderAnnouncement("de")

		expect(
			screen.getByText(
				"Alpha v3.1.9 keeps saved code searchable while indexing catches up and makes conversation steering more responsive.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Saved edits remain searchable while embeddings catch up, with grouped updates and bounded embedding traffic.",
			),
		).toBeInTheDocument()
	})
})
