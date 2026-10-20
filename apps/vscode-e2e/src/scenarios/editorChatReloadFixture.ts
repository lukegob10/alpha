import assert from "node:assert/strict"
import { createServer, type IncomingMessage } from "node:http"
import type { Socket } from "node:net"
import { editorChatStateSchema } from "@alpha-code/types"

export const EDITOR_RELOAD_VERSION = "1.138.0"
export const EDITOR_RELOAD_MODEL = "editor-reload-fixture"
export const EDITOR_RELOAD_COMPLETION = "EDITOR_RELOAD_CONTINUATION_COMPLETE"
export const EDITOR_RELOAD_FRESH_INPUT = "Continue the first editor chat now. EDITOR_RELOAD_FRESH_INPUT"
export const EDITOR_RELOAD_MARKERS = ["EDITOR_RELOAD_FIRST_CHAT", "EDITOR_RELOAD_SECOND_CHAT"] as const
export const EDITOR_RELOAD_DRAFTS = ["EDITOR_RELOAD_FIRST_DRAFT", "EDITOR_RELOAD_SECOND_DRAFT"] as const

export interface EditorReloadRequest {
	freshContinuation: boolean
	firstDraft: boolean
	secondDraft: boolean
	streaming: boolean
}

export function parseEditorReloadTaskIds(value: unknown): readonly [string, string] {
	assert.ok(Array.isArray(value) && value.length === 2, "Two saved editor chat identities are required")
	const [first, second]: unknown[] = value
	assert.ok(typeof first === "string" && typeof second === "string")
	assert.notEqual(first, second, "The restored chats must have distinct identities")
	for (const taskId of [first, second])
		editorChatStateSchema.parse({ version: 1, currentView: { type: "task", taskId } })
	return [first, second]
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = []
	let bytes = 0
	for await (const chunk of request) {
		const buffer = Buffer.from(chunk)
		bytes += buffer.length
		if (bytes > 2 * 1024 * 1024) throw new Error("Editor reload fixture request limit")
		chunks.push(buffer)
	}
	const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
	assert.ok(value && typeof value === "object" && !Array.isArray(value))
	return value as Record<string, unknown>
}

/** One bounded local provider survives both owned hosts; no fake callback is re-injected after restart. */
export async function createEditorReloadProvider() {
	const requests: EditorReloadRequest[] = []
	const sockets = new Set<Socket>()
	const server = createServer((request, response) => {
		void (async () => {
			if (request.method === "GET" && request.url === "/v1/models") {
				response.writeHead(200, { "Content-Type": "application/json" })
				response.end(JSON.stringify({ object: "list", data: [{ id: EDITOR_RELOAD_MODEL, object: "model" }] }))
				return
			}
			if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
				response.writeHead(404).end()
				return
			}
			const body = await readBody(request)
			assert.ok(requests.length < 20, "Unexpected provider retry loop")
			const messages = JSON.stringify(body.messages)
			requests.push({
				freshContinuation: messages.includes(EDITOR_RELOAD_FRESH_INPUT),
				firstDraft: messages.includes(EDITOR_RELOAD_DRAFTS[0]),
				secondDraft: messages.includes(EDITOR_RELOAD_DRAFTS[1]),
				streaming: body.stream === true,
			})
			response.writeHead(200, { "Content-Type": "application/json" })
			response.end(
				JSON.stringify({
					id: `editor-reload-${requests.length}`,
					object: "chat.completion",
					created: 1,
					model: EDITOR_RELOAD_MODEL,
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: EDITOR_RELOAD_COMPLETION },
							finish_reason: "stop",
						},
					],
					usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
				}),
			)
		})().catch(() => {
			if (!response.headersSent) response.writeHead(500)
			response.end()
		})
	})
	server.on("connection", (socket) => {
		sockets.add(socket)
		socket.once("close", () => sockets.delete(socket))
	})
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(0, "127.0.0.1", resolve)
	})
	const address = server.address()
	assert.ok(address && typeof address !== "string")
	let closing: Promise<void> | undefined
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		requests,
		close() {
			return (closing ??= new Promise<void>((resolve) => {
				for (const socket of sockets) socket.destroy()
				server.close(() => resolve())
			}))
		},
	}
}
