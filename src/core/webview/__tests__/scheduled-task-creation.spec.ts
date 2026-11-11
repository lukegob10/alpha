import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"
import { EventEmitter } from "events"
import type { CreateScheduledTaskPayload, ExtensionMessage } from "@alpha-code/types"

import type { AlphaProvider } from "../AlphaProvider"
import { webviewMessageHandler } from "../webviewMessageHandler"
import { ScheduledTaskService } from "../../../services/scheduled-tasks/ScheduledTaskService"

vi.mock("../../../utils/storage", () => ({ getStorageBasePath: (base: string) => base }))

describe("scheduled task creation acknowledgement", () => {
	let directory: string
	let service: ScheduledTaskService
	let provider: AlphaProvider
	let postMessage: ReturnType<typeof vi.fn<(message: ExtensionMessage) => Promise<void>>>
	let payload: CreateScheduledTaskPayload

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "scheduled-create-"))
		Object.assign(vscode.workspace, { workspaceFolders: [{ uri: vscode.Uri.file(directory) }] })
		postMessage = vi.fn(async () => undefined)
		provider = Object.assign(new EventEmitter(), {
			postMessageToWebview: postMessage,
			getScheduledTaskService: () => service,
			log: vi.fn(),
		}) as unknown as AlphaProvider
		service = new ScheduledTaskService(
			{ globalStorageUri: { fsPath: directory } } as vscode.ExtensionContext,
			provider,
			{ appendLine: vi.fn() } as unknown as vscode.OutputChannel,
		)
		await service.initialize()
		postMessage.mockClear()
		payload = {
			creationRequestId: "d5b82d17-3f59-4ba9-883c-b9a865cd1234",
			name: "One job",
			prompt: "Review repository health",
			apiConfig: { id: "saved-profile", name: "Saved profile" },
			workspace: directory,
			schedule: { type: "daily", startAt: Date.now() + 3_600_000, timezone: "UTC", intervalDays: 1 },
		}
	})

	afterEach(async () => {
		await service.dispose()
		Object.assign(vscode.workspace, { workspaceFolders: [] })
		vi.restoreAllMocks()
		await fs.rm(directory, { recursive: true, force: true })
	})

	const results = () =>
		postMessage.mock.calls.flatMap(([message]) =>
			message.scheduledTaskCreationResult ? [message.scheduledTaskCreationResult] : [],
		)

	it("acknowledges duplicate wire requests with the same durable created identity", async () => {
		await Promise.all([
			webviewMessageHandler(provider, { type: "createScheduledTask", scheduledTask: payload }),
			webviewMessageHandler(provider, { type: "createScheduledTask", scheduledTask: payload }),
		])
		const [created] = service.getState().tasks
		expect(service.getState().tasks).toHaveLength(1)
		expect(results()).toEqual([
			{ requestId: payload.creationRequestId, status: "success", task: created },
			{ requestId: payload.creationRequestId, status: "success", task: created },
		])
	})

	it("does not report a committed creation as failed when acknowledgement delivery fails", async () => {
		postMessage
			.mockImplementationOnce(async () => undefined)
			.mockImplementationOnce(async () => {
				throw new Error("Webview detached")
			})
		await webviewMessageHandler(provider, { type: "createScheduledTask", scheduledTask: payload })
		expect(service.getState().tasks).toHaveLength(1)
		expect(results()).toHaveLength(1)
		expect(results()[0].status).toBe("success")
		await webviewMessageHandler(provider, { type: "createScheduledTask", scheduledTask: payload })
		expect(service.getState().tasks).toHaveLength(1)
		expect(results()).toHaveLength(2)
		expect(results()[1]).toEqual(results()[0])
	})

	it("keeps failure responses correlated and bounded, then permits the same intent to retry", async () => {
		vi.spyOn(service, "createTask").mockRejectedValueOnce(new Error("private storage details"))
		await webviewMessageHandler(provider, { type: "createScheduledTask", scheduledTask: payload })
		expect(results()).toEqual([{ requestId: payload.creationRequestId, status: "error", error: "save_failed" }])
		expect(service.getState().tasks).toEqual([])
		await webviewMessageHandler(provider, { type: "createScheduledTask", scheduledTask: payload })
		expect(results()[1]).toMatchObject({ requestId: payload.creationRequestId, status: "success" })
		expect(service.getState().tasks).toHaveLength(1)
		expect(JSON.stringify(results())).not.toContain("private storage details")
	})

	it("rejects an explicitly invalid creation ID without silently falling back to legacy creation", async () => {
		const create = vi.spyOn(service, "createTask")
		await webviewMessageHandler(provider, {
			type: "createScheduledTask",
			scheduledTask: { ...payload, creationRequestId: "" },
		})
		expect(create).not.toHaveBeenCalled()
		expect(service.getState().tasks).toEqual([])
	})

	it("acknowledges an unavailable service while keeping legacy creation requests readable", async () => {
		const unavailable = {
			getScheduledTaskService: () => undefined,
			postMessageToWebview: postMessage,
			log: vi.fn(),
		} as unknown as AlphaProvider
		await webviewMessageHandler(unavailable, { type: "createScheduledTask", scheduledTask: payload })
		expect(results()).toEqual([{ requestId: payload.creationRequestId, status: "error", error: "unavailable" }])
		postMessage.mockClear()
		const { creationRequestId: _creationRequestId, ...legacy } = payload
		await webviewMessageHandler(provider, { type: "createScheduledTask", scheduledTask: legacy })
		expect(service.getState().tasks).toHaveLength(1)
		expect(results()).toEqual([])
	})
})
