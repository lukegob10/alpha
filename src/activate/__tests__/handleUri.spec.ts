import type * as vscode from "vscode"

import { AlphaProvider } from "../../core/webview/AlphaProvider"
import { handleUri } from "../handleUri"

vi.mock("../../core/webview/AlphaProvider", () => ({
	AlphaProvider: {
		getVisibleInstance: vi.fn(),
	},
}))

const createProvider = () =>
	({
		handleOpenRouterCallback: vi.fn().mockResolvedValue(undefined),
		handleRequestyCallback: vi.fn().mockResolvedValue(undefined),
	}) as unknown as AlphaProvider

const createUri = (path: string, query: string) => ({ path, query }) as vscode.Uri

describe("handleUri", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("routes an OpenRouter callback to the sidebar provider while Alpha is hidden", async () => {
		const sidebarProvider = createProvider()
		vi.mocked(AlphaProvider.getVisibleInstance).mockReturnValue(undefined)

		await handleUri(createUri("/openrouter", "code=hidden%20callback"), sidebarProvider)

		expect(sidebarProvider.handleOpenRouterCallback).toHaveBeenCalledWith("hidden callback")
	})

	it("routes a Requesty callback to the sidebar provider while preserving plus signs", async () => {
		const sidebarProvider = createProvider()
		vi.mocked(AlphaProvider.getVisibleInstance).mockReturnValue(undefined)

		await handleUri(
			createUri("/requesty", "code=requesty+token&baseUrl=https%3A%2F%2Frequesty.example%2Fv1"),
			sidebarProvider,
		)

		expect(sidebarProvider.handleRequestyCallback).toHaveBeenCalledWith(
			"requesty+token",
			"https://requesty.example/v1",
		)
	})

	it("keeps routing to a visible provider when one exists", async () => {
		const visibleProvider = createProvider()
		const sidebarProvider = createProvider()
		vi.mocked(AlphaProvider.getVisibleInstance).mockReturnValue(visibleProvider)

		await handleUri(createUri("/openrouter", "code=visible"), sidebarProvider)

		expect(visibleProvider.handleOpenRouterCallback).toHaveBeenCalledWith("visible")
		expect(sidebarProvider.handleOpenRouterCallback).not.toHaveBeenCalled()
	})
})
