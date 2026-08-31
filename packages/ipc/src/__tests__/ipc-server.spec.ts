import type { Socket } from "node:net"

import { IpcMessageType } from "@alpha-code/types"
import { beforeEach, describe, expect, it, vi } from "vitest"

type BackendHandler = (...args: unknown[]) => void

const mocks = vi.hoisted(() => {
	const handlers = new Map<string, BackendHandler>()
	let deferStart = false
	const backendServer = {
		on: vi.fn((event: string, handler: BackendHandler) => {
			handlers.set(event, handler)
		}),
		off: vi.fn((event: string, handler: BackendHandler) => {
			if (handlers.get(event) === handler) {
				handlers.delete(event)
			}
		}),
		start: vi.fn(() => {
			if (!deferStart) {
				handlers.get("start")?.()
			}
		}),
		stop: vi.fn(),
		emit: vi.fn(),
		broadcast: vi.fn(),
	}
	const ipc = {
		config: { silent: false },
		serve: vi.fn((_path: string, callback: () => void) => {
			handlers.set("start", callback)
		}),
		server: backendServer,
	}

	return {
		backendServer,
		emitBackend(event: string, ...args: unknown[]) {
			handlers.get(event)?.(...args)
		},
		handlers,
		ipc,
		setDeferStart(value: boolean) {
			deferStart = value
		},
		reset() {
			handlers.clear()
			deferStart = false
			ipc.config.silent = false
		},
	}
})

vi.mock("node-ipc", () => ({ default: mocks.ipc }))

import { IpcServer } from "../ipc-server.js"

function createSocket() {
	return {
		destroy: vi.fn(),
		write: vi.fn(),
	} as unknown as Socket
}

describe("IpcServer disposal", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.reset()
	})

	it("stops the backend, destroys clients, and detaches listeners exactly once", () => {
		const server = new IpcServer("test.sock", vi.fn())
		const onConnect = vi.fn()
		const firstSocket = createSocket()
		const secondSocket = createSocket()

		server.on(IpcMessageType.Connect, onConnect)
		server.listen()
		mocks.emitBackend("connect", firstSocket)
		mocks.emitBackend("connect", secondSocket)

		expect(server.isListening).toBe(true)
		expect(onConnect).toHaveBeenCalledTimes(2)

		server.dispose()

		expect(firstSocket.destroy).toHaveBeenCalledOnce()
		expect(secondSocket.destroy).toHaveBeenCalledOnce()
		expect(mocks.backendServer.stop).toHaveBeenCalledOnce()
		expect(mocks.backendServer.off).toHaveBeenCalledWith("connect", expect.any(Function))
		expect(mocks.backendServer.off).toHaveBeenCalledWith("socket.disconnected", expect.any(Function))
		expect(mocks.backendServer.off).toHaveBeenCalledWith("message", expect.any(Function))
		expect(server.listenerCount(IpcMessageType.Connect)).toBe(0)
		expect(server.isListening).toBe(false)

		mocks.emitBackend("connect", createSocket())
		expect(onConnect).toHaveBeenCalledTimes(2)

		server.dispose()
		expect(mocks.backendServer.stop).toHaveBeenCalledOnce()
	})

	it("continues cleanup when a socket or backend throws", () => {
		const log = vi.fn()
		const server = new IpcServer("test.sock", log)
		const socket = createSocket()
		vi.mocked(socket.destroy).mockImplementationOnce(() => {
			throw new Error("socket failure")
		})
		mocks.backendServer.stop.mockImplementationOnce(() => {
			throw new Error("stop failure")
		})

		server.listen()
		mocks.emitBackend("connect", socket)

		expect(() => server.dispose()).not.toThrow()
		expect(server.isListening).toBe(false)
		expect(log).toHaveBeenCalledWith(expect.stringContaining("socket failure"))
		expect(log).toHaveBeenCalledWith(expect.stringContaining("stop failure"))
	})

	it("stops a backend that finishes starting after disposal", () => {
		mocks.setDeferStart(true)
		const server = new IpcServer("test.sock", vi.fn())

		server.listen()
		server.dispose()

		expect(mocks.backendServer.stop).not.toHaveBeenCalled()

		mocks.emitBackend("start")

		expect(mocks.backendServer.stop).toHaveBeenCalledOnce()
		expect(mocks.handlers.has("start")).toBe(false)
		expect(server.isListening).toBe(false)

		server.listen()
		expect(mocks.backendServer.start).toHaveBeenCalledOnce()
	})
})
