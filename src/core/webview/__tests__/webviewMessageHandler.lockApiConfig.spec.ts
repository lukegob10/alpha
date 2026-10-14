// npx vitest run core/webview/__tests__/webviewMessageHandler.lockApiConfig.spec.ts

import { webviewMessageHandler } from "../webviewMessageHandler"
import type { AlphaProvider } from "../AlphaProvider"

describe("webviewMessageHandler - lockApiConfigAcrossModes", () => {
	let mockProvider: {
		context: {
			workspaceState: {
				get: import("vitest").Mock
				update: import("vitest").Mock
			}
		}
		getState: import("vitest").Mock
		postStateToWebview: import("vitest").Mock
		providerSettingsManager: {
			setModeConfig: import("vitest").Mock
		}
		postMessageToWebview: import("vitest").Mock
		getCurrentTask: import("vitest").Mock
	}

	beforeEach(() => {
		vi.clearAllMocks()

		mockProvider = {
			context: {
				workspaceState: {
					get: vi.fn(),
					update: vi.fn().mockResolvedValue(undefined),
				},
			},
			getState: vi.fn().mockResolvedValue({
				currentApiConfigName: "test-config",
				listApiConfigMeta: [{ name: "test-config", id: "config-123" }],
				customModes: [],
			}),
			postStateToWebview: vi.fn(),
			providerSettingsManager: {
				setModeConfig: vi.fn(),
			},
			postMessageToWebview: vi.fn(),
			getCurrentTask: vi.fn(),
		}
	})

	it("sets lockApiConfigAcrossModes to true and posts state without mode config fan-out", async () => {
		await webviewMessageHandler(mockProvider as unknown as AlphaProvider, {
			type: "lockApiConfigAcrossModes",
			bool: true,
		})

		expect(mockProvider.context.workspaceState.update).toHaveBeenCalledWith("lockApiConfigAcrossModes", true)
		expect(mockProvider.providerSettingsManager.setModeConfig).not.toHaveBeenCalled()
		expect(mockProvider.postStateToWebview).toHaveBeenCalled()
	})

	it("sets lockApiConfigAcrossModes to false without applying to all modes", async () => {
		await webviewMessageHandler(mockProvider as unknown as AlphaProvider, {
			type: "lockApiConfigAcrossModes",
			bool: false,
		})

		expect(mockProvider.context.workspaceState.update).toHaveBeenCalledWith("lockApiConfigAcrossModes", false)
		expect(mockProvider.providerSettingsManager.setModeConfig).not.toHaveBeenCalled()
		expect(mockProvider.postStateToWebview).toHaveBeenCalled()
	})
})
