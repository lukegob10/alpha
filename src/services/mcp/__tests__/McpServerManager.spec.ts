const { createdHubs, startup } = vi.hoisted(() => ({
	createdHubs: [] as any[],
	startup: { readiness: undefined as Promise<void> | undefined },
}))

vi.mock("vscode", () => ({}))
vi.mock("../../../core/webview/AlphaProvider", () => ({}))
vi.mock("../McpHub", () => ({
	McpHub: class MockMcpHub {
		disposed = false
		clients = 0
		registerClient = vi.fn(() => {
			this.clients++
		})
		unregisterClient = vi.fn(async (disposeWhenUnused = true) => {
			this.clients--
			if (disposeWhenUnused && this.clients <= 0) await this.dispose()
		})
		waitUntilReady = vi.fn(() => startup.readiness ?? Promise.resolve())
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
	const provider = { context, postMessageToWebview: vi.fn().mockResolvedValue(undefined) } as any

	beforeEach(async () => {
		vi.clearAllMocks()
		createdHubs.length = 0
		startup.readiness = undefined
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

	it("retires the last provider even without a registered hub client", async () => {
		const hub = await McpServerManager.getInstance(context, provider)
		await McpServerManager.unregisterProvider(provider)
		expect(hub.dispose).toHaveBeenCalledOnce()
		expect(hub.disposed).toBe(true)
	})

	it("keeps a pending provider's hub alive when the previous client disconnects", async () => {
		const hub = await McpServerManager.getInstance(context, provider)
		hub.registerClient()
		const nextProvider = { context, postMessageToWebview: vi.fn() } as any
		const pending = McpServerManager.getInstance(context, nextProvider)
		await McpServerManager.unregisterProvider(provider, hub)
		expect(hub.unregisterClient).toHaveBeenCalledWith(false)
		expect(hub.dispose).not.toHaveBeenCalled()
		expect(await pending).toBe(hub)
		hub.registerClient()
		await McpServerManager.unregisterProvider(nextProvider, hub)
		expect(hub.dispose).toHaveBeenCalledOnce()
	})

	it("does not decrement a released client again when disposal is retried", async () => {
		const hub = await McpServerManager.getInstance(context, provider)
		hub.registerClient()
		vi.mocked(hub.dispose).mockRejectedValueOnce(new Error("transport did not close"))
		await expect(McpServerManager.unregisterProvider(provider, hub)).rejects.toThrow("transport did not close")
		await McpServerManager.unregisterProvider(provider, hub)
		expect(hub.unregisterClient).toHaveBeenCalledOnce()
		expect(hub.dispose).toHaveBeenCalledTimes(2)
	})

	it("joins pending initialization before cleanup releases its hub", async () => {
		let release!: () => void
		startup.readiness = new Promise<void>((resolve) => {
			release = resolve
		})
		const initializing = McpServerManager.getInstance(context, provider)
		const hub = createdHubs[0]
		const cleaning = McpServerManager.cleanup(context)
		let cleaned = false
		void cleaning.then(() => {
			cleaned = true
		})
		await Promise.resolve()
		const completedBeforeReadiness = cleaned
		release()
		await initializing
		await cleaning
		expect(completedBeforeReadiness).toBe(false)
		expect(hub.dispose).toHaveBeenCalledOnce()
		expect(hub.disposed).toBe(true)
	})

	it("disposes a newly constructed hub when publication fails", async () => {
		context.globalState.update.mockRejectedValueOnce(new Error("state unavailable"))
		await expect(McpServerManager.getInstance(context, provider)).rejects.toThrow("state unavailable")
		expect(createdHubs[0].dispose).toHaveBeenCalledOnce()
		const replacement = await McpServerManager.getInstance(context, provider)
		expect(replacement).not.toBe(createdHubs[0])
	})

	it("disposes an unpublished hub when readiness rejects", async () => {
		startup.readiness = Promise.reject(new Error("startup failed"))
		await expect(McpServerManager.getInstance(context, provider)).rejects.toThrow("startup failed")
		expect(createdHubs[0].dispose).toHaveBeenCalledOnce()
	})

	it("waits for concurrent cleanup before constructing a new hub", async () => {
		const first = await McpServerManager.getInstance(context, provider)
		let release!: () => void
		let entered!: () => void
		const disposing = new Promise<void>((resolve) => {
			entered = resolve
		})
		;(first as any).dispose.mockImplementationOnce(() => {
			entered()
			return new Promise<void>((resolve) => {
				release = resolve
			})
		})
		const cleaning = McpServerManager.cleanup(context)
		await disposing
		const secondCleanup = McpServerManager.cleanup(context)
		const acquiring = McpServerManager.getInstance(context, provider)
		await Promise.resolve()
		expect(createdHubs).toHaveLength(1)
		release()
		await Promise.all([cleaning, secondCleanup])
		const second = await acquiring
		expect(second).not.toBe(first)
		expect(createdHubs).toHaveLength(2)
		expect((first as any).dispose).toHaveBeenCalledOnce()
	})
})
