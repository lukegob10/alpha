const { createdHubs } = vi.hoisted(() => ({ createdHubs: [] as any[] }))

vi.mock("vscode", () => ({}))
vi.mock("../../../core/webview/ClineProvider", () => ({}))
vi.mock("../McpHub", () => ({
	McpHub: class MockMcpHub {
		disposed = false
		waitUntilReady = vi.fn().mockResolvedValue(undefined)
		dispose = vi.fn().mockImplementation(async () => {
			this.disposed = true
		})

		constructor() {
			createdHubs.push(this)
		}
	},
}))

import { McpServerManager } from "../McpServerManager"

describe("McpServerManager", () => {
	const context = {
		globalState: { update: vi.fn().mockResolvedValue(undefined) },
	} as any
	const provider = { postMessageToWebview: vi.fn().mockResolvedValue(undefined) } as any

	beforeEach(async () => {
		vi.clearAllMocks()
		createdHubs.length = 0
		await McpServerManager.cleanup(context)
	})

	afterEach(async () => {
		await McpServerManager.cleanup(context)
	})

	it("replaces a hub that disposed itself after its last client disconnected", async () => {
		const first = await McpServerManager.getInstance(context, provider)
		;(first as any).disposed = true

		const second = await McpServerManager.getInstance(context, provider)

		expect(second).not.toBe(first)
		expect(createdHubs).toHaveLength(2)
		expect((second as any).disposed).toBe(false)
	})
})
