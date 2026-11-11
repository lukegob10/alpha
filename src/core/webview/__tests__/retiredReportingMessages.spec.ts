import type { WebviewMessage } from "@alpha-code/types"

import type { AlphaProvider } from "../AlphaProvider"
import { webviewMessageHandler } from "../webviewMessageHandler"

describe("retired reporting messages", () => {
	it.each(["enabled", "disabled", "unset", undefined])("ignores a stale reporting preference (%s)", async (text) => {
		const read = vi.fn()
		const write = vi.fn()
		const postState = vi.fn()
		const postMessage = vi.fn()
		const provider = {
			contextProxy: { getValue: read, setValue: write },
			postStateToWebview: postState,
			postMessageToWebview: postMessage,
		} as unknown as AlphaProvider

		// Older webviews can deliver retired variants at the untrusted message boundary.
		await expect(
			webviewMessageHandler(provider, { type: "telemetrySetting", text } as unknown as WebviewMessage),
		).resolves.toBeUndefined()

		expect(read).not.toHaveBeenCalled()
		expect(write).not.toHaveBeenCalled()
		expect(postState).not.toHaveBeenCalled()
		expect(postMessage).not.toHaveBeenCalled()
	})
})
