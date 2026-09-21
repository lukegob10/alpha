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
		version: "3.0.1",
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

		expect(screen.getByText("Welcome to Alpha v3.0.1")).toBeInTheDocument()
		expect(
			screen.getByText("Alpha v3.0.1 improves verification, command control, and task continuity."),
		).toBeInTheDocument()
	})

	it("renders the release highlights", () => {
		renderAnnouncement()

		expect(screen.getAllByRole("listitem")).toHaveLength(4)
		expect(
			screen.getByText("Reuse passing checks while their declared inputs remain unchanged."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Wait for, send input to, and stop background commands owned by the task."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Preserve task constraints and skill context across reload and compaction."),
		).toBeInTheDocument()
		expect(
			screen.getByText("Use clearer chat actions and select a provider after task completion."),
		).toBeInTheDocument()
	})

	it("uses localized release text with the current package version", () => {
		renderAnnouncement("de")

		expect(
			screen.getByText(
				"Alpha v3.0.1 verbessert die Überprüfung, die Befehlssteuerung und die Fortführung von Aufgaben.",
			),
		).toBeInTheDocument()
		expect(
			screen.getByText(
				"Erfolgreiche Prüfungen wiederverwenden, solange ihre angegebenen Eingaben unverändert bleiben.",
			),
		).toBeInTheDocument()
	})
})
