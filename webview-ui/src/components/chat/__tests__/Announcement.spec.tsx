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
		version: "3.1.10",
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
			i18n.t("chat:announcement.release.welcome", { lng: "en", version: "3.1.10" }),
		)

		expect(screen.getByText("Welcome to Alpha v3.1.10")).toBeInTheDocument()
		expect(
			screen.getByText(
				"Alpha v3.1.10 recovers abandoned task-storage locks so chats can resume after an interrupted session.",
			),
		).toBeInTheDocument()
	})

	it("renders the release highlights", () => {
		renderAnnouncement()

		expect(screen.getAllByRole("listitem")).toHaveLength(4)
		expect(
			screen.getByText("Interrupted sessions can resume without manually deleting a leftover task lock."),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Abandoned locks from older versions recover automatically once other Alpha hosts have stopped.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Recovery preserves saved task history and protects storage still used by an active host.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText("Storage delays show a specific recovery message with guidance for resuming."),
		).toBeInTheDocument()
	})

	it("falls back to English release text when a retired locale is requested", () => {
		renderAnnouncement("de")

		expect(
			screen.getByText(
				"Alpha v3.1.10 recovers abandoned task-storage locks so chats can resume after an interrupted session.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText("Interrupted sessions can resume without manually deleting a leftover task lock."),
		).toBeInTheDocument()
	})
})
