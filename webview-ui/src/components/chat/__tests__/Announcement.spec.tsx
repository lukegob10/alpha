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
		version: "3.2.8",
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
			i18n.t("chat:announcement.release.welcome", { lng: "en", version: "3.2.8" }),
		)

		expect(screen.getByText("Welcome to Alpha v3.2.8")).toBeInTheDocument()
		expect(
			screen.getByText("Alpha v3.2.8 restores file diff review and improves extension startup."),
		).toBeInTheDocument()
	})

	it("renders the release highlights", () => {
		renderAnnouncement()

		expect(screen.getAllByRole("listitem")).toHaveLength(4)
		expect(
			screen.getByText("Open chats with less startup work and keep initial state updates consistent."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Load document readers, code highlighting, and error details as you need them."),
		).toBeInTheDocument()
		expect(screen.getByText("Review saved file changes while task work continues.")).toBeInTheDocument()
		expect(
			screen.getByText(
				"Open the diff editor from Review or file change counts, with clear feedback if opening fails.",
			),
		).toBeInTheDocument()
	})

	it("falls back to English release text when a retired locale is requested", () => {
		renderAnnouncement("de")

		expect(
			screen.getByText("Alpha v3.2.8 restores file diff review and improves extension startup."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Open chats with less startup work and keep initial state updates consistent."),
		).toBeInTheDocument()
	})
})
