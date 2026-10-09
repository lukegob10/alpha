import {
	AlphaCodeEventName,
	IpcMessageType,
	IpcOrigin,
	TaskCommandName,
	ipcMessageSchema,
	type ExecutionIdentity,
} from "@alpha-code/types"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
	function createConnection() {
		const handlers = new Map<string, (data?: unknown) => void>()
		return {
			on: vi.fn((event: string, handler: (data?: unknown) => void) => handlers.set(event, handler)),
			emit: vi.fn(),
			deliver(event: string, data?: unknown) {
				handlers.get(event)?.(data)
			},
		}
	}
	const of: Record<string, ReturnType<typeof createConnection>> = {}
	return {
		ipc: {
			config: { silent: false },
			of,
			connectTo: vi.fn((id: string, _socketPath: string, ready: () => void) => {
				of[id] = createConnection()
				ready()
			}),
			disconnect: vi.fn((id: string) => {
				of[id]?.deliver("disconnect")
				delete of[id]
			}),
		},
		reset() {
			for (const id of Object.keys(of)) delete of[id]
		},
	}
})

vi.mock("node-ipc", () => ({ default: mocks.ipc }))

import { IpcClient } from "../ipc-client.js"

const identity: ExecutionIdentity = {
	schemaVersion: 1,
	hostVersion: "1.125.0",
	extensionId: "Alpha.alpha",
	extensionVersion: "1.0.0",
	entrypointDigest: `sha256:${"a".repeat(64)}`,
	manifestDigest: `sha256:${"b".repeat(64)}`,
	identityScope: "observed-entrypoint-and-manifest",
}

function acknowledgement(clientId = "client-1", executionIdentity?: ExecutionIdentity) {
	return {
		type: IpcMessageType.Ack,
		origin: IpcOrigin.Server,
		data: { clientId, pid: 101, ppid: 100, ...(executionIdentity ? { executionIdentity } : {}) },
	}
}

function createClient(socketPath = "test.sock") {
	const log = vi.fn()
	const client = new IpcClient(socketPath, log)
	const call = mocks.ipc.connectTo.mock.calls.at(-1)
	if (!call) throw new Error("Client did not create a transport")
	const id = call[0]
	const backend = mocks.ipc.of[id]
	if (!backend) throw new Error("Client transport is missing")
	return { client, id, backend, log }
}

describe("IpcClient transport contracts", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.reset()
	})

	it("becomes ready only after both transport connection and acknowledgement", () => {
		const { client, backend } = createClient("socket with spaces.sock")
		const connected = vi.fn()
		client.on(IpcMessageType.Connect, connected)
		expect(client.socketPath).toBe("socket with spaces.sock")
		expect(client.isConnected).toBe(false)
		expect(client.isReady).toBe(false)
		backend.deliver("connect")
		backend.deliver("connect")
		expect(connected).toHaveBeenCalledOnce()
		expect(client.isConnected).toBe(true)
		expect(client.isReady).toBe(false)
		backend.deliver("message", acknowledgement())
		expect(client.isReady).toBe(true)
	})

	it("preserves the observed extension identity and server process from a validated handshake", () => {
		const { client, backend } = createClient()
		const acknowledged = vi.fn()
		client.on(IpcMessageType.Ack, acknowledged)
		backend.deliver("connect")
		backend.deliver("message", acknowledgement("observed-client", identity))
		expect(acknowledged).toHaveBeenCalledExactlyOnceWith(acknowledgement("observed-client", identity).data)
		expect(client.clientId).toBe("observed-client")
		expect(client.executionIdentity).toEqual(identity)
		expect(client.serverProcess).toEqual({ pid: 101, ppid: 100 })
		expect(client.isReady).toBe(true)
	})

	it("keeps legacy acknowledgements usable without inventing execution identity", () => {
		const { client, backend } = createClient()
		backend.deliver("connect")
		backend.deliver("message", acknowledgement())
		expect(client.isReady).toBe(true)
		expect(client.executionIdentity).toBeUndefined()
		expect(client.serverProcess).toEqual({ pid: 101, ppid: 100 })
	})

	const invalidHandshakes = [
		["null", null],
		["primitive", "not an IPC message"],
		["array", []],
		["unknown message", { type: "Unknown", origin: IpcOrigin.Server, data: {} }],
		["wrong origin", { ...acknowledgement(), origin: IpcOrigin.Client }],
		["missing process", { ...acknowledgement(), data: { clientId: "client-1" } }],
		[
			"invalid identity",
			{
				...acknowledgement(),
				data: { ...acknowledgement().data, executionIdentity: { ...identity, entrypointDigest: "invalid" } },
			},
		],
	] as const

	it.each(invalidHandshakes)("ignores a %s handshake and accepts a later valid one", (_name, invalid) => {
		const { client, backend } = createClient()
		const acknowledged = vi.fn()
		client.on(IpcMessageType.Ack, acknowledged)
		backend.deliver("connect")
		expect(() => backend.deliver("message", invalid)).not.toThrow()
		expect(acknowledged).not.toHaveBeenCalled()
		expect(client.isReady).toBe(false)
		expect(client.clientId).toBeUndefined()
		expect(client.executionIdentity).toBeUndefined()
		expect(client.serverProcess).toBeUndefined()
		backend.deliver("message", acknowledgement("valid-client", identity))
		expect(acknowledged).toHaveBeenCalledOnce()
		expect(client.isReady).toBe(true)
		expect(client.clientId).toBe("valid-client")
	})

	it("delivers validated task events in transport order and rejects malformed or client-origin events", () => {
		const { client, backend } = createClient()
		const event = vi.fn()
		client.on(IpcMessageType.TaskEvent, event)
		const first = { eventName: AlphaCodeEventName.TaskStarted, payload: ["task-1"] }
		const second = { eventName: AlphaCodeEventName.TaskAborted, payload: ["task-1"] }
		const message = { type: IpcMessageType.TaskEvent, origin: IpcOrigin.Server, data: first }
		backend.deliver("message", { ...message, origin: IpcOrigin.Client })
		backend.deliver("message", { ...message, data: { ...first, payload: [7] } })
		backend.deliver("message", { ...message, data: { eventName: "Unknown", payload: [] } })
		backend.deliver("message", message)
		backend.deliver("message", { ...message, data: second })
		expect(event.mock.calls).toEqual([[first], [second]])
	})

	it("sends schema-valid commands with the acknowledged client ID and intact message data", () => {
		const { client, backend } = createClient()
		backend.deliver("connect")
		backend.deliver("message", acknowledgement("command-client"))
		client.sendCommand({ commandName: TaskCommandName.ResumeTask, data: "saved-task" })
		client.sendTaskMessage("follow-up\nwith details", ["data:image/png;base64,fixture"])
		client.deleteQueuedMessage("queued-message")
		const commands = [
			{ commandName: TaskCommandName.ResumeTask, data: "saved-task" },
			{
				commandName: TaskCommandName.SendMessage,
				data: { text: "follow-up\nwith details", images: ["data:image/png;base64,fixture"] },
			},
			{ commandName: TaskCommandName.DeleteQueuedMessage, data: "queued-message" },
		]
		expect(backend.emit.mock.calls).toEqual(
			commands.map((data) => [
				"message",
				{ type: IpcMessageType.TaskCommand, origin: IpcOrigin.Client, clientId: "command-client", data },
			]),
		)
		for (const [, message] of backend.emit.mock.calls)
			expect(ipcMessageSchema.safeParse(message).success).toBe(true)
	})

	it("clears handshake state exactly once on disconnect and requires a fresh acknowledgement on reconnect", () => {
		const { client, backend } = createClient()
		const disconnected = vi.fn()
		client.on(IpcMessageType.Disconnect, disconnected)
		backend.deliver("connect")
		backend.deliver("message", acknowledgement("old-client", identity))
		backend.deliver("disconnect")
		backend.deliver("disconnect")
		expect(disconnected).toHaveBeenCalledOnce()
		expect(client.isConnected).toBe(false)
		expect(client.isReady).toBe(false)
		expect(client.clientId).toBeUndefined()
		expect(client.executionIdentity).toBeUndefined()
		expect(client.serverProcess).toBeUndefined()
		backend.deliver("connect")
		expect(client.isReady).toBe(false)
		backend.deliver("message", acknowledgement("new-client"))
		expect(client.isReady).toBe(true)
		expect(client.clientId).toBe("new-client")
		expect(client.executionIdentity).toBeUndefined()
	})

	it("isolates clients sharing a socket, including commands and disconnects", () => {
		const first = createClient()
		const second = createClient()
		expect(first.id).not.toBe(second.id)
		first.backend.deliver("connect")
		second.backend.deliver("connect")
		first.backend.deliver("message", acknowledgement("first-client", identity))
		second.backend.deliver("message", acknowledgement("second-client"))
		first.client.sendTaskMessage("first")
		expect(second.backend.emit).not.toHaveBeenCalled()
		second.client.sendTaskMessage("second")
		expect(first.backend.emit.mock.calls[0]?.[1]).toMatchObject({
			clientId: "first-client",
			data: { data: { text: "first" } },
		})
		expect(second.backend.emit.mock.calls[0]?.[1]).toMatchObject({
			clientId: "second-client",
			data: { data: { text: "second" } },
		})
		first.client.disconnect()
		expect(mocks.ipc.disconnect).toHaveBeenCalledExactlyOnceWith(first.id)
		expect(first.client.isReady).toBe(false)
		expect(second.client.isReady).toBe(true)
	})

	it("reports backend disconnect errors without throwing to cleanup callers", () => {
		const { client, log } = createClient()
		mocks.ipc.disconnect.mockImplementationOnce(() => {
			throw new Error("transport cleanup failed")
		})
		expect(() => client.disconnect()).not.toThrow()
		expect(log).toHaveBeenCalledExactlyOnceWith(
			"[client#disconnect] error disconnecting -> transport cleanup failed",
		)
	})
})
