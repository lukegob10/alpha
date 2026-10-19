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
		version: "3.2.4",
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
			i18n.t("chat:announcement.release.welcome", { lng: "en", version: "3.2.4" }),
		)

		expect(screen.getByText("Welcome to Alpha v3.2.4")).toBeInTheDocument()
		expect(
			screen.getByText("Alpha v3.2.4 improves task recovery, Copilot context, and skill reliability."),
		).toBeInTheDocument()
	})

	it("renders the release highlights", () => {
		renderAnnouncement()

		expect(screen.getAllByRole("listitem")).toHaveLength(4)
		expect(
			screen.getByText("Recover rewound chats and interrupted turns while preserving conversation history."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Preserve Copilot thinking state and command text across model requests."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Carry committed answers into sub-agent context and keep queued follow-ups consistent."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Load explicitly selected skills reliably and use the built-in review-agent skill."),
		).toBeInTheDocument()
	})

	it("falls back to English release text when a retired locale is requested", () => {
		renderAnnouncement("de")

		expect(
			screen.getByText("Alpha v3.2.4 improves task recovery, Copilot context, and skill reliability."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Recover rewound chats and interrupted turns while preserving conversation history."),
		).toBeInTheDocument()
	})
})
