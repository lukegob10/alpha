import type { Socket } from "node:net"

import { IpcMessageType, type ExecutionIdentity } from "@alpha-code/types"
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
	it.each([
		["win32", "\\\\.\\pipe\\evals-fixture.sock", "evals-fixture.sock"],
		["win32", "evals-fixture.sock", "evals-fixture.sock"],
		["linux", "/tmp/evals-fixture.sock", "/tmp/evals-fixture.sock"],
		["darwin", "/tmp/evals-fixture.sock", "/tmp/evals-fixture.sock"],
	] as const)(
		"adapts the %s server transport while preserving the public endpoint %s",
		(platform, endpoint, transportPath) => {
			const original = Object.getOwnPropertyDescriptor(process, "platform")
			if (!original) throw new Error("Missing platform descriptor")
			let server: IpcServer | undefined
			try {
				// This transport is synchronous and mocked; platform substitution cannot start native sockets.
				Object.defineProperty(process, "platform", { ...original, value: platform })
				server = new IpcServer(endpoint, vi.fn())
				server.listen()
				expect(server.socketPath).toBe(endpoint)
				expect(mocks.ipc.serve).toHaveBeenCalledExactlyOnceWith(transportPath, expect.any(Function))
			} finally {
				server?.dispose()
				Object.defineProperty(process, "platform", original)
			}
		},
	)
	it("sends the observed installation receipt only after capture completes", async () => {
		const identity: ExecutionIdentity = {
			schemaVersion: 1,
			hostVersion: "1.125.0",
			extensionId: "Alpha.alpha",
			extensionVersion: "1.0.0",
			entrypointDigest: `sha256:${"a".repeat(64)}`,
			manifestDigest: `sha256:${"b".repeat(64)}`,
			identityScope: "observed-entrypoint-and-manifest",
		}
		let resolve!: (identity: ExecutionIdentity) => void
		const captured = new Promise<ExecutionIdentity>((done) => {
			resolve = done
		})
		const server = new IpcServer("test.sock", vi.fn(), () => captured)
		const socket = createSocket()
		server.listen()
		mocks.emitBackend("connect", socket)
		expect(mocks.backendServer.emit).not.toHaveBeenCalled()
		resolve(identity)
		await captured
		expect(mocks.backendServer.emit).toHaveBeenCalledWith(
			socket,
			"message",
			expect.objectContaining({
				type: IpcMessageType.Ack,
				data: expect.objectContaining({ executionIdentity: identity, pid: process.pid }),
			}),
		)
		server.dispose()
	})

	it.each(["disconnect", "dispose"])("discards a delayed identity after %s", async (ending) => {
		let resolve!: (identity: ExecutionIdentity) => void
		const captured = new Promise<ExecutionIdentity>((done) => {
			resolve = done
		})
		const server = new IpcServer("test.sock", vi.fn(), () => captured)
		const socket = createSocket()
		server.listen()
		mocks.emitBackend("connect", socket)
		if (ending === "disconnect") mocks.emitBackend("socket.disconnected", socket)
		else server.dispose()
		resolve({
			schemaVersion: 1,
			hostVersion: "1.125.0",
			extensionId: "Alpha.alpha",
			extensionVersion: "1.0.0",
			entrypointDigest: `sha256:${"a".repeat(64)}`,
			manifestDigest: `sha256:${"b".repeat(64)}`,
			identityScope: "observed-entrypoint-and-manifest",
		})
		await captured
		expect(mocks.backendServer.emit).not.toHaveBeenCalled()
		server.dispose()
	})

	it("preserves legacy connection readiness when optional capture fails", async () => {
		const onConnect = vi.fn()
		const server = new IpcServer("test.sock", vi.fn(), async () => {
			throw new Error("capture failed")
		})
		server.on(IpcMessageType.Connect, onConnect)
		server.listen()
		mocks.emitBackend("connect", createSocket())
		await Promise.resolve()
		expect(onConnect).toHaveBeenCalledOnce()
		expect(mocks.backendServer.emit.mock.calls[0]?.[2].data.executionIdentity).toBeUndefined()
		server.dispose()
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
