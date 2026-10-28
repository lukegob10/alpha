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
		version: "3.2.16",
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
			i18n.t("chat:announcement.release.welcome", { lng: "en", version: "3.2.16" }),
		)

		expect(screen.getByText("Welcome to Alpha v3.2.16")).toBeInTheDocument()
		expect(
			screen.getByText("Alpha v3.2.16 fixes reasoning availability and incorrect next-step indicators."),
		).toBeInTheDocument()
	})

	it("renders the release highlights", () => {
		renderAnnouncement()

		expect(screen.getAllByRole("listitem")).toHaveLength(4)
		expect(screen.getByText("Keep the resolved reasoning level visible throughout a chat.")).toBeInTheDocument()
		expect(
			screen.getByText("Copilot chats retain their model's resolved reasoning capabilities."),
		).toBeInTheDocument()
		expect(
			screen.getByText("See next step only when the applied reasoning settings change during a request."),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Restore each task's saved reasoning choice without replacing it with the new-chat default.",
			),
		).toBeInTheDocument()
	})

	it("falls back to English release text when a retired locale is requested", () => {
		renderAnnouncement("de")

		expect(
			screen.getByText("Alpha v3.2.16 fixes reasoning availability and incorrect next-step indicators."),
		).toBeInTheDocument()
		expect(screen.getByText("Keep the resolved reasoning level visible throughout a chat.")).toBeInTheDocument()
	})
})
