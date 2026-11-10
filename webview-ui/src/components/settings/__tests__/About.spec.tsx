import { expect } from "vitest"
import { fireEvent, render, screen } from "@/utils/test-utils"

import { vscode } from "@/utils/vscode"

import { About } from "../About"

vi.mock("@/utils/vscode", () => ({
	vscode: { postMessage: vi.fn() },
}))

vi.mock("@/i18n/TranslationContext", () => {
	return {
		useAppTranslation: () => ({
			t: (key: string, options?: { version: string }) =>
				key === "settings:about.version" ? `Version ${options?.version}` : key,
		}),
	}
})

vi.mock("@alpha/package", () => ({
	Package: {
		version: "2.0.3",
		sha: "abc12345",
	},
}))

describe("About", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders the About section header", () => {
		render(<About />)
		expect(screen.getByText("settings:sections.about")).toBeInTheDocument()
	})

	it("displays version information", () => {
		render(<About />)
		expect(screen.getByText("Version 2.0.3 (abc12345)")).toBeInTheDocument()
	})

	it("renders export, import, and reset buttons", () => {
		render(<About />)
		expect(screen.getByText("settings:footer.settings.export")).toBeInTheDocument()
		expect(screen.getByText("settings:footer.settings.import")).toBeInTheDocument()
		expect(screen.getByText("settings:footer.settings.reset")).toBeInTheDocument()
	})

	it("keeps buffered privacy and debug preferences out of data management", () => {
		render(<About />)

		expect(screen.queryByRole("checkbox")).not.toBeInTheDocument()
		expect(screen.getByText("settings:about.manageSettingsDescription")).toBeInTheDocument()
		expect(vscode.postMessage).not.toHaveBeenCalled()
	})

	it.each([
		["export", "exportSettings"],
		["import", "importSettings"],
		["reset", "resetState"],
	])("runs the explicit %s action without a settings Save", (action, type) => {
		render(<About />)

		fireEvent.click(screen.getByRole("button", { name: `settings:footer.settings.${action}` }))

		expect(vscode.postMessage).toHaveBeenCalledExactlyOnceWith({ type })
	})

	it("can embed below an application-owned page header", () => {
		render(<About embedded />)

		expect(screen.queryByText("settings:sections.about")).not.toBeInTheDocument()
		expect(screen.getByText("Version 2.0.3 (abc12345)")).toBeInTheDocument()
	})
})
