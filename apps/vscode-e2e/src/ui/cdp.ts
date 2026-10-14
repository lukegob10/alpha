/** Small bounded transport for the owned test Electron instance, using Node's native WebSocket. */
export class CdpConnection {
	private sequence = 0
	private pending = new Map<
		number,
		{ resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
	>()
	private constructor(private readonly socket: WebSocket) {
		socket.addEventListener("message", (event) => {
			if (typeof event.data !== "string" || event.data.length > 16_777_216) return this.close()
			let response: { id?: number; result?: unknown; error?: unknown }
			try {
				response = JSON.parse(event.data)
			} catch {
				this.close()
				return
			}
			if (response.id === undefined) return
			const request = this.pending.get(response.id)
			if (!request) return
			this.pending.delete(response.id)
			clearTimeout(request.timer)
			if (response.error) request.reject(new Error("CDP command failed"))
			else request.resolve(response.result)
		})
		socket.addEventListener("close", () => this.rejectPending())
		socket.addEventListener("error", () => this.rejectPending())
	}
	static async connect(endpoint: string): Promise<CdpConnection> {
		const url = new URL(endpoint)
		if (
			url.protocol !== "ws:" ||
			url.hostname !== "127.0.0.1" ||
			url.username ||
			url.password ||
			!url.pathname.startsWith("/devtools/")
		)
			throw new Error("CDP requires an owned loopback endpoint")
		const socket = new WebSocket(url)
		const connection = new CdpConnection(socket)
		try {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					cleanup()
					reject(new Error("CDP connection timeout"))
				}, 5000)
				const cleanup = () => {
					clearTimeout(timer)
					socket.removeEventListener("open", opened)
					socket.removeEventListener("error", failed)
				}
				const opened = () => {
					cleanup()
					resolve()
				}
				const failed = () => {
					cleanup()
					reject(new Error("CDP connection failed"))
				}
				socket.addEventListener("open", opened)
				socket.addEventListener("error", failed)
			})
			return connection
		} catch (error) {
			connection.close()
			throw error
		}
	}
	request<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
		if (this.pending.size >= 32 || this.socket.readyState !== WebSocket.OPEN)
			return Promise.reject(new Error("CDP unavailable"))
		const id = ++this.sequence
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id)
				reject(new Error("CDP command timeout"))
			}, 5000)
			this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
			try {
				this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
			} catch {
				this.pending.delete(id)
				clearTimeout(timer)
				reject(new Error("CDP send failed"))
			}
		})
	}
	private rejectPending() {
		for (const request of this.pending.values()) {
			clearTimeout(request.timer)
			request.reject(new Error("CDP closed"))
		}
		this.pending.clear()
	}
	close() {
		this.rejectPending()
		this.socket.close()
	}
}
