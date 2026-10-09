import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
	AlphaCodeEventName,
	IpcMessageType,
	IpcOrigin,
	TaskCommandName,
	type ExecutionIdentity,
	type TaskEvent,
} from "@alpha-code/types"
import { expect, it, vi } from "vitest"
import { IpcClient } from "../ipc-client.js"
import { IpcServer } from "../ipc-server.js"

const endpointForms = process.platform === "win32" ? ["logical", "qualified"] : ["logical"]

it.each(endpointForms)(
	"round-trips commands and scoped events over a real %s socket and releases both clients",
	async (form) => {
		const id = `alpha-ipc-${randomUUID()}`
		const socketPath =
			process.platform === "win32"
				? form === "qualified"
					? `\\\\.\\pipe\\${id}`
					: id
				: path.join(os.tmpdir(), `${id}.sock`)
		const identity: ExecutionIdentity = {
			schemaVersion: 1,
			hostVersion: "1.125.0",
			extensionId: "Alpha.alpha",
			extensionVersion: "1.0.0",
			entrypointDigest: `sha256:${"a".repeat(64)}`,
			manifestDigest: `sha256:${"b".repeat(64)}`,
			identityScope: "observed-entrypoint-and-manifest",
		}
		const server = new IpcServer(socketPath, vi.fn(), async () => identity)
		const signal = AbortSignal.timeout(8_000)
		let first: IpcClient | undefined
		let second: IpcClient | undefined
		let phase = "first acknowledgement"
		try {
			server.listen()
			first = new IpcClient(socketPath, vi.fn())
			await once(first, IpcMessageType.Ack, { signal })
			phase = "second acknowledgement"
			second = new IpcClient(socketPath, vi.fn())
			await once(second, IpcMessageType.Ack, { signal })
			expect(first.isReady).toBe(true)
			expect(second.isReady).toBe(true)
			const firstClientId = first.clientId
			const secondClientId = second.clientId
			if (!firstClientId || !secondClientId) throw new Error("Missing acknowledged client IDs")
			expect(firstClientId).not.toBe(secondClientId)
			expect(first.executionIdentity).toEqual(identity)
			expect(second.executionIdentity).toEqual(identity)
			expect(first.serverProcess).toEqual({ pid: process.pid, ppid: process.ppid })
			const firstCommand = once(server, IpcMessageType.TaskCommand, { signal })
			phase = "first command"
			first.sendTaskMessage("first message")
			expect(await firstCommand).toEqual([
				first.clientId,
				{ commandName: TaskCommandName.SendMessage, data: { text: "first message" } },
			])
			const secondCommand = once(server, IpcMessageType.TaskCommand, { signal })
			phase = "second command"
			second.deleteQueuedMessage("second queued message")
			expect(await secondCommand).toEqual([
				second.clientId,
				{ commandName: TaskCommandName.DeleteQueuedMessage, data: "second queued message" },
			])
			const firstEvent: TaskEvent = { eventName: AlphaCodeEventName.TaskStarted, payload: ["first-task"] }
			const secondEvent: TaskEvent = { eventName: AlphaCodeEventName.TaskAborted, payload: ["second-task"] }
			const receivedFirst = once(first, IpcMessageType.TaskEvent, { signal })
			phase = "scoped events"
			const receivedSecond = once(second, IpcMessageType.TaskEvent, { signal })
			server.send(firstClientId, {
				type: IpcMessageType.TaskEvent,
				origin: IpcOrigin.Server,
				data: firstEvent,
			})
			server.send(secondClientId, {
				type: IpcMessageType.TaskEvent,
				origin: IpcOrigin.Server,
				data: secondEvent,
			})
			expect(await receivedFirst).toEqual([firstEvent])
			expect(await receivedSecond).toEqual([secondEvent])
			const disconnected = [
				once(first, IpcMessageType.Disconnect, { signal }),
				once(second, IpcMessageType.Disconnect, { signal }),
			]
			server.dispose()
			phase = "disconnect"
			await Promise.all(disconnected)
			expect(server.isListening).toBe(false)
			for (const client of [first, second]) {
				expect(client.isReady).toBe(false)
				expect(client.clientId).toBeUndefined()
				expect(client.executionIdentity).toBeUndefined()
				expect(client.serverProcess).toBeUndefined()
			}
		} catch (error) {
			throw new Error(`IPC round-trip failed during ${phase}`, { cause: error })
		} finally {
			first?.disconnect()
			second?.disconnect()
			server.dispose()
			if (process.platform !== "win32") await rm(socketPath, { force: true })
		}
	},
	10_000,
)
