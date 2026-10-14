import * as fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { TicketStore } from "../../../services/tickets/TicketStore"
import { ToolScheduler, type ToolExecutionHost } from "../../agent/ToolScheduler"
import { Task } from "../../task/Task"
import { buildNativeToolsArrayWithRestrictions, type BuildToolsOptions } from "../../task/build-tools"
import { TaskToolCatalogCache } from "../../task/TaskToolCatalogCache"

vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: () => ({ isFeatureEnabled: false, isFeatureConfigured: false, isInitialized: false }),
	},
}))

describe("eager Alpha Tickets tools", () => {
	let profile: string
	let workspace: string
	let store: TicketStore

	beforeEach(async () => {
		profile = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-ticket-eager-"))
		workspace = path.join(profile, "project")
		await fs.mkdir(workspace)
		const forWorkspace = TicketStore.forWorkspace.bind(TicketStore)
		vi.spyOn(TicketStore, "forWorkspace").mockImplementation((cwd) => forWorkspace(cwd, profile))
		store = await TicketStore.forWorkspace(workspace)
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(profile, { recursive: true, force: true })
	})

	it.each([
		["GPT", "openai", false],
		["Copilot", "vscode-lm", false],
		["Anthropic", "anthropic", false],
		["Vertex", "vertex", true],
	] as const)(
		"advertises and completes a first-step ticket action for %s",
		async (_label, apiProvider, restricted) => {
			const provider = { context: {}, getMcpHub: () => ({ getServers: () => [] }) }
			const firstStep = await buildNativeToolsArrayWithRestrictions({
				provider: provider as unknown as BuildToolsOptions["provider"],
				cwd: workspace,
				mode: "code",
				customModes: undefined,
				experiments: {},
				apiConfiguration: { apiProvider },
				includeAllToolsWithRestrictions: restricted,
				catalogCache: new TaskToolCatalogCache(),
				discoveryHistory: [],
				userRequestText: "Could you add a ticket for an intermittent hang?",
			})
			const surface = firstStep.surface!
			const names = firstStep.tools.flatMap((tool) => (tool.type === "function" ? [tool.function.name] : []))
			const createTicketTool = firstStep.tools.find(
				(tool) => tool.type === "function" && tool.function.name === "create_ticket",
			)
			expect(createTicketTool).toMatchObject({
				function: {
					parameters: {
						properties: {
							type: {
								enum: ["bug", "feature", "improvement", "testing", "performance", "ux", null],
							},
							priority: { type: ["string", "null"], enum: ["high", "medium", "low", null] },
						},
					},
				},
			})
			for (const name of ["list_tickets", "read_ticket", "create_ticket", "update_ticket", "delete_ticket"]) {
				expect(names, name).toContain(name)
				expect(surface.isCallable(name), name).toBe(true)
				expect(surface.resolve(name)?.execute, name).toBeTypeOf("function")
				if (restricted) expect(firstStep.allowedFunctionNames, name).toContain(name)
			}

			const task = Object.assign(Object.create(Task.prototype), {
				workspacePath: workspace,
				abort: false,
				canMutateWorkspace: () => true,
				say: vi.fn(),
			}) as Task
			const host: ToolExecutionHost = {
				taskId: "ticket-eager-first-step",
				cwd: workspace,
				taskFacade: task,
				userMessageContent: [],
				say: async () => {},
				askApproval: async () => ({ response: "yesButtonClicked" }),
				recordToolUsage: () => {},
				pushToolResultToUserContent(result) {
					host.userMessageContent.push(result)
					return true
				},
			}
			const outcome = await new ToolScheduler({
				executionHost: host,
				registry: surface.registry,
				policy: surface.policy,
				mode: "code",
			}).run([
				{ type: "tool_call", id: "create-1", name: "create_ticket", arguments: { name: "Intermittent hang" } },
			])

			expect(outcome.results).toMatchObject([{ status: "success" }])
			expect((await store.list()).tickets).toMatchObject([{ name: "Intermittent hang" }])
			expect(host.userMessageContent).toHaveLength(1)
		},
	)
})
