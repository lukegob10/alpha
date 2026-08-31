import EventEmitter from "node:events"
import { Socket } from "node:net"
import * as crypto from "node:crypto"

import ipc from "node-ipc"

import {
	type IpcServerEvents,
	type RooCodeIpcServer,
	IpcOrigin,
	IpcMessageType,
	type IpcMessage,
	ipcMessageSchema,
} from "@alpha-code/types"

export class IpcServer extends EventEmitter<IpcServerEvents> implements RooCodeIpcServer {
	private readonly _socketPath: string
	private readonly _log: (...args: unknown[]) => void
	private readonly _clients: Map<string, Socket>
	private readonly _handleConnect = (socket: Socket) => this.onConnect(socket)
	private readonly _handleDisconnect = (socket: Socket) => this.onDisconnect(socket)
	private readonly _handleMessage = (data: unknown) => this.onMessage(data)
	private readonly _handleStart = () => this.onStart()

	private _isListening = false
	private _isDisposed = false
	private _serverStarted = false
	private _server?: typeof ipc.server

	constructor(socketPath: string, log = console.log) {
		super()

		this._socketPath = socketPath
		this._log = log
		this._clients = new Map()
	}

	public listen() {
		if (this._isListening || this._isDisposed) {
			return
		}

		this._isListening = true

		ipc.config.silent = true

		ipc.serve(this.socketPath, this._handleStart)

		const server = (this._server = ipc.server)

		try {
			server.start()
		} catch (error) {
			this._isListening = false
			this._server = undefined
			this.detachServerListeners(server, true)
			throw error
		}
	}

	private onStart() {
		const server = this._server

		if (!server) {
			return
		}

		this._serverStarted = true

		if (!this._isListening) {
			this.stopServer(server)
			this.releaseServer(server)
			return
		}

		server.on("connect", this._handleConnect)
		server.on("socket.disconnected", this._handleDisconnect)
		server.on("message", this._handleMessage)
	}

	private detachServerListeners(server: typeof ipc.server, includeStart = false) {
		server.off("connect", this._handleConnect)
		server.off("socket.disconnected", this._handleDisconnect)
		server.off("message", this._handleMessage)

		if (includeStart) {
			server.off("start", this._handleStart)
		}
	}

	private stopServer(server: typeof ipc.server) {
		try {
			server.stop()
		} catch (error) {
			this.log(
				`[server#dispose] error stopping server -> ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	private releaseServer(server: typeof ipc.server) {
		this.detachServerListeners(server, true)
		this._serverStarted = false

		if (this._server === server) {
			this._server = undefined
		}
	}

	private onConnect(socket: Socket) {
		const clientId = crypto.randomBytes(6).toString("hex")
		this._clients.set(clientId, socket)
		this.log(`[server#onConnect] clientId = ${clientId}, # clients = ${this._clients.size}`)

		this.send(socket, {
			type: IpcMessageType.Ack,
			origin: IpcOrigin.Server,
			data: { clientId, pid: process.pid, ppid: process.ppid },
		})

		this.emit(IpcMessageType.Connect, clientId)
	}

	private onDisconnect(destroyedSocket: Socket) {
		let disconnectedClientId: string | undefined

		for (const [clientId, socket] of this._clients.entries()) {
			if (socket === destroyedSocket) {
				disconnectedClientId = clientId
				this._clients.delete(clientId)
				break
			}
		}

		this.log(`[server#socket.disconnected] clientId = ${disconnectedClientId}, # clients = ${this._clients.size}`)

		if (disconnectedClientId) {
			this.emit(IpcMessageType.Disconnect, disconnectedClientId)
		}
	}

	private onMessage(data: unknown) {
		if (typeof data !== "object") {
			this.log(`[server#onMessage] invalid data -> ${JSON.stringify(data)}`)
			return
		}

		const result = ipcMessageSchema.safeParse(data)

		if (!result.success) {
			this.log(
				`[server#onMessage] invalid payload -> ${JSON.stringify(result.error.issues)} -> ${JSON.stringify(data)}`,
			)

			return
		}

		const payload = result.data

		if (payload.origin === IpcOrigin.Client) {
			switch (payload.type) {
				case IpcMessageType.TaskCommand:
					this.emit(IpcMessageType.TaskCommand, payload.clientId, payload.data)
					break
				default:
					this.log(`[server#onMessage] unhandled payload: ${JSON.stringify(payload)}`)
					break
			}
		}
	}

	private log(...args: unknown[]) {
		this._log(...args)
	}

	public broadcast(message: IpcMessage) {
		// this.log("[server#broadcast] message =", message)
		ipc.server.broadcast("message", message)
	}

	public send(client: string | Socket, message: IpcMessage) {
		// this.log("[server#send] message =", message)

		if (typeof client === "string") {
			const socket = this._clients.get(client)

			if (socket) {
				ipc.server.emit(socket, "message", message)
			}
		} else {
			ipc.server.emit(client, "message", message)
		}
	}

	public dispose() {
		const server = this._server

		this._isDisposed = true
		this._isListening = false

		if (server) {
			this.detachServerListeners(server)
		}

		for (const socket of this._clients.values()) {
			try {
				socket.destroy()
			} catch (error) {
				this.log(
					`[server#dispose] error destroying client socket -> ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}

		this._clients.clear()

		if (server && this._serverStarted) {
			this.stopServer(server)
			this.releaseServer(server)
		}

		this.removeAllListeners()
	}

	public get socketPath() {
		return this._socketPath
	}

	public get isListening() {
		return this._isListening
	}
}
