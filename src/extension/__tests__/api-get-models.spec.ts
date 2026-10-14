import { beforeEach, describe, expect, it, vi } from "vitest"
import * as vscode from "vscode"

import {
	AlphaCodeEventName,
	IpcMessageType,
	IpcOrigin,
	stellarModels,
	TaskCommandName,
	vertexModels,
	vscodeLlmModels,
} from "@alpha-code/types"
import { API } from "../api"
import { AlphaProvider } from "../../core/webview/AlphaProvider"

const ipcMock = vi.hoisted(() => ({
	handler: undefined as undefined | ((clientId: string, command: unknown) => void | Promise<void>),
	listen: vi.fn(),
	send: vi.fn(),
	broadcast: vi.fn(),
	dispose: vi.fn(),
}))

vi.mock("vscode")
vi.mock("../../core/webview/AlphaProvider", () => ({ AlphaProvider: vi.fn() }))
vi.mock("@alpha-code/ipc", () => ({
	IpcServer: vi.fn().mockImplementation(() => ({
		listen: ipcMock.listen,
		send: ipcMock.send,
		broadcast: ipcMock.broadcast,
		dispose: ipcMock.dispose,
		on: vi.fn((_eventName, handler) => {
			ipcMock.handler = handler
		}),
	})),
}))

describe("API - GetModels command", () => {
	let mockProvider: AlphaProvider

	beforeEach(() => {
		ipcMock.handler = undefined
		ipcMock.listen.mockReset()
		ipcMock.send.mockReset()
		ipcMock.broadcast.mockReset()
		ipcMock.dispose.mockReset()

		mockProvider = {
			context: { subscriptions: [] } as unknown as vscode.ExtensionContext,
			on: vi.fn(),
			getCurrentTaskStack: vi.fn().mockReturnValue([]),
			getState: vi.fn().mockResolvedValue({ apiConfiguration: { apiProvider: "vertex" } }),
			viewLaunched: true,
		} as unknown as AlphaProvider
	})

	async function getModelsForProvider(apiProvider: string | undefined) {
		;(mockProvider.getState as ReturnType<typeof vi.fn>).mockResolvedValue({
			apiConfiguration: { apiProvider },
		})

		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		new API(outputChannel, mockProvider, "models-test-socket", false)

		expect(ipcMock.handler).toBeTypeOf("function")
		await ipcMock.handler!("client-1", { commandName: TaskCommandName.GetModels })

		const [, response] = ipcMock.send.mock.calls.at(-1) ?? []
		expect(response).toMatchObject({
			type: IpcMessageType.TaskEvent,
			origin: IpcOrigin.Server,
			data: {
				eventName: AlphaCodeEventName.ModelsResponse,
			},
		})
		return response.data.payload[0]
	}

	it.each([
		["vertex", vertexModels],
		["stellar", stellarModels],
		["vscode-lm", vscodeLlmModels],
	] as const)("returns the static catalog for %s", async (apiProvider, expectedModels) => {
		expect(await getModelsForProvider(apiProvider)).toBe(expectedModels)
	})

	it("returns an empty catalog for OpenAI Compatible discovery", async () => {
		expect(await getModelsForProvider("openai")).toEqual({})
	})

	it("returns an empty catalog when the configured provider is missing", async () => {
		expect(await getModelsForProvider(undefined)).toEqual({})
	})

	it("returns an empty catalog when state lookup fails", async () => {
		;(mockProvider.getState as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("state unavailable"))

		const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
		new API(outputChannel, mockProvider, "models-test-socket", false)

		await ipcMock.handler!("client-1", { commandName: TaskCommandName.GetModels })
		const [, response] = ipcMock.send.mock.calls.at(-1) ?? []

		expect(response.data.payload).toEqual([{}])
	})
})
