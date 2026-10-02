import { describe, expect, it, vi } from "vitest"

import { createToolPolicySnapshot, isToolAllowed } from "../../agent/ToolPolicy"
import { buildNativeToolsArrayWithRestrictions, type BuildToolsOptions } from "../../task/build-tools"
import { TaskToolCatalogCache } from "../../task/TaskToolCatalogCache"

vi.mock("../../../services/code-index/manager", () => ({
	CodeIndexManager: {
		getInstance: () => ({ isFeatureEnabled: true, isFeatureConfigured: true, isInitialized: true }),
	},
}))

function namesOf(tools: { type: string; function?: { name: string } }[]): string[] {
	return tools.flatMap((tool) => (tool.type === "function" && tool.function ? [tool.function.name] : [])).sort()
}

function options(overrides: Partial<BuildToolsOptions> = {}): BuildToolsOptions {
	const provider = {
		context: {},
		getMcpHub: () => ({ getServers: () => [] }),
	}
	return {
		provider: provider as unknown as BuildToolsOptions["provider"],
		cwd: process.cwd(),
		mode: "code",
		customModes: undefined,
		experiments: {},
		apiConfiguration: { apiProvider: "openai" },
		catalogCache: new TaskToolCatalogCache(),
		discoveryHistory: [],
		...overrides,
	}
}

describe("request-independent tool authority", () => {
	it.each(["openai", "vscode-lm", "vertex"] as const)(
		"keeps authorized edits available across request wording and approval modes on %s",
		async (apiProvider) => {
			for (const approvalMode of ["ask", "auto", "bypass"] as const) {
				const base = options({
					apiConfiguration: { apiProvider },
					includeAllToolsWithRestrictions: apiProvider === "vertex",
					approvalMode,
				})
				const implementation = await buildNativeToolsArrayWithRestrictions({
					...base,
					userRequestText: "Write the exported document to reports/export.md.",
				})
				for (const userRequestText of [
					"Use the api-export skill.",
					"Use the api-export skill to retrieve the API export and save the document.",
					"Can you retrieve the API export and save the document?",
					"Where is retryLimit defined?",
				]) {
					const result = await buildNativeToolsArrayWithRestrictions({ ...base, userRequestText })
					expect(result.surface?.isCallable("apply_patch"), `${approvalMode}: ${userRequestText}`).toBe(true)
					expect(namesOf(result.tools)).toEqual(namesOf(implementation.tools))
					expect(result.digest).toBe(implementation.digest)
					expect(result.surface?.policy.approval.mode).toBe(approvalMode)
				}
			}
		},
	)

	it.each(["openai", "vscode-lm", "vertex"] as const)(
		"preserves mode, disabled-tool, captured-policy, and child authority limits on %s",
		async (apiProvider) => {
			for (const restrictions of [
				{ mode: "architect" },
				{ disabledTools: ["apply_patch"] },
				{ policy: createToolPolicySnapshot({ visibleTools: ["exec_command", "skill"] }) },
				{ taskKind: "subagent", allowedToolNames: ["exec_command", "skill"] },
			] satisfies Partial<BuildToolsOptions>[]) {
				for (const userRequestText of ["Use the api-export skill.", "Write the exported document."]) {
					const result = await buildNativeToolsArrayWithRestrictions(
						options({
							apiConfiguration: { apiProvider },
							includeAllToolsWithRestrictions: apiProvider === "vertex",
							approvalMode: "bypass",
							userRequestText,
							...restrictions,
						}),
					)
					expect(result.surface?.isCallable("apply_patch")).toBe(false)
					expect(isToolAllowed(result.surface?.policy, "apply_patch")).toBe(false)
				}
			}
		},
	)

	it("builds a diagnostic surface with only the redacted evidence reader", async () => {
		const getMcpHub = vi.fn(() => {
			throw new Error("diagnostic sessions must not inspect MCP state")
		})
		const result = await buildNativeToolsArrayWithRestrictions(
			options({
				provider: { context: {}, getMcpHub } as unknown as BuildToolsOptions["provider"],
				diagnosticSession: true,
				diagnosticSourceTaskId: "source-task-1",
				includeAllToolsWithRestrictions: true,
				experiments: { customTools: true },
				discoveryHistory: [
					{
						role: "assistant",
						content: [{ type: "tool_use", id: "historical-discovery", name: "discover_tools", input: {} }],
					},
				],
				userRequestText: "Run commands, create a task, and inspect MCP resources.",
			}),
		)
		expect(namesOf(result.tools)).toEqual(["read_diagnostic_evidence"])
		expect(result.surface?.includeAllToolsWithRestrictions).toBe(false)
		expect(result.surface?.allowedFunctionNames).toEqual(["read_diagnostic_evidence"])
		expect(result.surface?.policy.execution.sandboxMode).toBe("read-only")
		expect(result.surface?.isCallable("exec_command")).toBe(false)
		expect(result.surface?.isCallable("create_task")).toBe(false)
		expect(result.surface?.isCallable("read_mcp_resource")).toBe(false)
		expect(getMcpHub).not.toHaveBeenCalled()
	})

	it("keeps authorized workflow tools available for a question-only request", async () => {
		const result = await buildNativeToolsArrayWithRestrictions(
			options({ userRequestText: "Where is retryLimit defined?" }),
		)
		expect(namesOf(result.tools)).toEqual(
			expect.arrayContaining(["exec_command", "request_user_input", "apply_patch"]),
		)
		expect(result.surface?.isCallable("request_user_input")).toBe(true)
		expect(result.surface?.isCallable("spawn_agent")).toBe(true)
		expect(result.surface?.isCallable("update_todo_list")).toBe(true)
		expect(result.surface?.isCallable("attempt_completion")).toBe(false)
		expect(result.surface?.isCallable("write_to_file")).toBe(false)
		expect(result.surface?.isCallable("skill")).toBe(true)
		expect(result.surface?.isCallable("list_tickets")).toBe(true)
		expect(result.surface?.resolve("spawn_agent")).toBeDefined()
		expect(isToolAllowed(result.surface?.policy, "spawn_agent")).toBe(true)
		expect(result.surface?.isCallable("exec_command")).toBe(true)
		for (const name of ["read_file", "list_files", "search_files", "codebase_search"])
			expect(result.surface?.isCallable(name), name).toBe(false)
	})

	it("honors an explicit question-tool restriction on Code lookup turns", async () => {
		const result = await buildNativeToolsArrayWithRestrictions(
			options({ userRequestText: "Where is retryLimit defined?", disabledTools: ["request_user_input"] }),
		)
		expect(namesOf(result.tools)).toContain("exec_command")
		expect(namesOf(result.tools)).not.toContain("request_user_input")
		expect(result.surface?.isCallable("request_user_input")).toBe(false)
	})

	it("advertises VS Code LM's executable read command without widening its approval policy", async () => {
		const result = await buildNativeToolsArrayWithRestrictions(
			options({
				apiConfiguration: { apiProvider: "vscode-lm" },
				approvalMode: "ask",
				userRequestText:
					"Work only inside live-quality/late-span. Use bounded read-only commands to inspect files before answering. Do not modify files or delegate. What is the active record id?",
			}),
		)
		const command = result.tools.find((tool) => tool.type === "function" && tool.function.name === "exec_command")

		expect(command).toBeDefined()
		expect(namesOf(result.tools)).toEqual(
			expect.arrayContaining(["exec_command", "request_user_input", "apply_patch"]),
		)
		expect(result.surface?.isCallable("request_user_input")).toBe(true)
		expect(result.surface?.isCallable("exec_command")).toBe(true)
		expect(isToolAllowed(result.surface?.policy, "exec_command")).toBe(true)
		expect(result.surface?.policy.visibleTools).toContain("exec_command")
		expect(result.surface?.policy.allowedTools).toContain("exec_command")
		expect(result.surface?.policy.approval.mode).toBe("ask")
		expect(result.surface?.policy.capabilities.exec_command).toMatchObject({
			parallelCommandRead: true,
			requiresApproval: true,
			sideEffects: "workspace",
		})
		expect(result.surface?.resolve("exec_command")).toMatchObject({ name: "exec_command" })
		expect(result.surface?.resolve("exec_command")?.prepareParallelCommand).toEqual(expect.any(Function))
		for (const name of ["read_file", "list_files", "search_files", "codebase_search", "write_to_file"])
			expect(result.surface?.isCallable(name), name).toBe(false)
	})

	it("eagerly exposes the native Ticket toolset for an Alpha Tickets lookup", async () => {
		const result = await buildNativeToolsArrayWithRestrictions(
			options({ userRequestText: "Which Alpha tickets are still in progress?" }),
		)
		const names = namesOf(result.tools)

		const ticketTools = ["list_tickets", "read_ticket", "create_ticket", "update_ticket", "delete_ticket"]
		expect(names).toEqual(expect.arrayContaining(ticketTools))
		for (const name of ticketTools) expect(result.surface?.isCallable(name)).toBe(true)
		expect(names).toContain("spawn_agent")
		expect(names).not.toContain("write_to_file")
		expect(result.surface?.isCallable("spawn_agent")).toBe(true)
		expect(result.surface?.isCallable("write_to_file")).toBe(false)
	})

	it("keeps a Plan-mode Alpha Tickets lookup read-only", async () => {
		const result = await buildNativeToolsArrayWithRestrictions(
			options({ mode: "architect", userRequestText: "Which Alpha tickets are still in progress?" }),
		)
		const names = namesOf(result.tools)

		expect(names).toEqual(expect.arrayContaining(["list_tickets", "read_ticket"]))
		expect(names).toContain("request_user_input")
		expect(names).not.toContain("ask_followup_question")
		expect(names).not.toContain("update_plan")
		expect(names).not.toContain("update_todo_list")
		for (const name of ["create_ticket", "update_ticket", "delete_ticket"]) {
			expect(names).not.toContain(name)
			expect(result.surface?.isCallable(name)).toBe(false)
		}
	})

	it("keeps workflow tools on an implementation request", async () => {
		const result = await buildNativeToolsArrayWithRestrictions(
			options({ userRequestText: "Implement retry backoff in the scheduler." }),
		)
		const names = namesOf(result.tools)
		expect(names).toEqual(
			expect.arrayContaining(["spawn_agent", "apply_patch", "update_plan", "skill", "list_tickets"]),
		)
		expect(names).not.toContain("update_todo_list")
		expect(result.surface?.isCallable("spawn_agent")).toBe(true)
		expect(result.surface?.isCallable("update_plan")).toBe(true)
		expect(result.surface?.isCallable("update_todo_list")).toBe(true)
		expect(result.surface?.isCallable("write_to_file")).toBe(false)
		expect(result.surface?.isCallable("apply_patch")).toBe(true)
		expect(names).not.toContain("attempt_completion")
		expect(result.surface?.isCallable("attempt_completion")).toBe(false)
	})

	it("keeps Vertex declarations exact for legacy plan calls while hiding the legacy name", async () => {
		const fresh = await buildNativeToolsArrayWithRestrictions(
			options({
				apiConfiguration: { apiProvider: "vertex" },
				includeAllToolsWithRestrictions: true,
				userRequestText: "Implement the requested tool contract.",
			}),
		)
		const freshNames = namesOf(fresh.tools)
		expect(freshNames).toContain("update_plan")
		expect(freshNames).not.toContain("update_todo_list")
		expect(fresh.allowedFunctionNames).toContain("update_plan")
		expect(fresh.allowedFunctionNames).not.toContain("update_todo_list")

		const history = [
			{
				role: "assistant" as const,
				content: [
					{
						type: "tool_use" as const,
						id: "legacy-plan-call",
						name: "update_todo_list",
						input: { todos: "[-] Continue the saved task" },
					},
				],
			},
		]
		const result = await buildNativeToolsArrayWithRestrictions(
			options({
				apiConfiguration: { apiProvider: "vertex" },
				includeAllToolsWithRestrictions: true,
				discoveryHistory: history,
				userRequestText: "Implement the requested tool contract.",
			}),
		)
		const names = namesOf(result.tools)

		expect(names).toContain("update_plan")
		expect(names).not.toContain("update_todo_list")
		expect(result.allowedFunctionNames).toContain("update_plan")
		expect(result.allowedFunctionNames).not.toContain("update_todo_list")
		expect(result.surface?.isCallable("update_plan")).toBe(true)
		expect(result.surface?.isCallable("update_todo_list")).toBe(true)
	})

	it("does not advertise unavailable discovery on a fresh restricted-provider workflow", async () => {
		const result = await buildNativeToolsArrayWithRestrictions(
			options({
				apiConfiguration: { apiProvider: "vertex" },
				includeAllToolsWithRestrictions: true,
				userRequestText: "Implement the requested tool contract.",
			}),
		)
		expect(namesOf(result.tools)).not.toContain("tool_search")
		expect(namesOf(result.tools)).not.toContain("discover_tools")
		expect(result.allowedFunctionNames).not.toContain("tool_search")
		expect(result.surface?.isCallable("tool_search")).toBe(false)
	})

	it("retains saved discovery declarations without granting discovery on a restricted provider", async () => {
		const result = await buildNativeToolsArrayWithRestrictions(
			options({
				apiConfiguration: { apiProvider: "vertex" },
				includeAllToolsWithRestrictions: true,
				userRequestText: "Implement the requested tool contract.",
				discoveryHistory: [
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "saved-discovery",
								name: "discover_tools",
								input: { query: "docs" },
							},
						],
					},
				],
			}),
		)
		expect(namesOf(result.tools)).toEqual(expect.arrayContaining(["tool_search", "discover_tools"]))
		expect(result.allowedFunctionNames).not.toContain("tool_search")
		expect(result.surface?.isCallable("discover_tools")).toBe(false)
	})

	it("uses current MCP resource names and retains legacy access only for restricted history", async () => {
		const provider = {
			context: {},
			getMcpHub: () => ({
				getServers: () => [{ name: "docs", status: "connected", config: "{}", resources: [] }],
			}),
		} as unknown as BuildToolsOptions["provider"]
		const fresh = await buildNativeToolsArrayWithRestrictions(
			options({ provider, userRequestText: "Implement the requested resource workflow." }),
		)
		for (const name of ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]) {
			expect(namesOf(fresh.tools)).toContain(name)
			expect(fresh.surface?.isCallable(name)).toBe(true)
		}
		expect(namesOf(fresh.tools)).not.toContain("access_mcp_resource")

		const historical = await buildNativeToolsArrayWithRestrictions(
			options({
				provider,
				apiConfiguration: { apiProvider: "vertex" },
				includeAllToolsWithRestrictions: true,
				userRequestText: "Implement the requested resource workflow.",
				discoveryHistory: [
					{
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "old-read",
								name: "access_mcp_resource",
								input: { server_name: "docs", uri: "doc://one" },
							},
						],
					},
				],
			}),
		)
		expect(namesOf(historical.tools)).toContain("access_mcp_resource")
		expect(historical.allowedFunctionNames).not.toContain("access_mcp_resource")
		expect(historical.surface?.isCallable("access_mcp_resource")).toBe(false)
	})

	it("keeps resource tools available for an MCP lookup question", async () => {
		const provider = {
			context: {},
			getMcpHub: () => ({
				getServers: () => [{ name: "docs", status: "connected", config: "{}", resources: [] }],
			}),
		} as unknown as BuildToolsOptions["provider"]
		const result = await buildNativeToolsArrayWithRestrictions(
			options({ provider, userRequestText: "What MCP resources does docs provide?" }),
		)
		expect(namesOf(result.tools)).toEqual(
			expect.arrayContaining([
				"exec_command",
				"list_mcp_resource_templates",
				"list_mcp_resources",
				"read_mcp_resource",
				"request_user_input",
			]),
		)
	})

	it("does not advertise legacy checklist schemas on managed children", async () => {
		const result = await buildNativeToolsArrayWithRestrictions(
			options({
				taskKind: "subagent",
				allowedToolNames: ["read_file", "update_plan"],
				userRequestText: "Implement the requested tool contract.",
			}),
		)
		const names = namesOf(result.tools)

		expect(names).not.toContain("update_todo_list")
		expect(names).not.toContain("update_plan")
	})

	it("captures root cross-task tools as both visible and callable in Code mode", async () => {
		const names = ["create_task", "list_tasks", "wait_task", "send_task_message", "steer_task", "stop_task"]
		const result = await buildNativeToolsArrayWithRestrictions(
			options({
				crossTaskRole: "root",
				userRequestText: "Create one independent task and stop it when complete.",
			}),
		)

		expect(namesOf(result.tools)).toEqual(expect.arrayContaining(names))
		for (const name of names) {
			expect(result.surface?.policy.visibleTools).toContain(name)
			expect(result.surface?.policy.allowedTools).toContain(name)
			expect(result.surface?.isCallable(name)).toBe(true)
		}
	})

	it("offers create_task across providers for direct new-task requests", async () => {
		for (const apiProvider of ["openai", "vscode-lm", "vertex"] as const) {
			for (const userRequestText of [
				"Could you please launch a test thread?",
				"I want a new task for provider-neutral validation.",
			]) {
				const result = await buildNativeToolsArrayWithRestrictions(
					options({
						apiConfiguration: { apiProvider },
						includeAllToolsWithRestrictions: apiProvider === "vertex",
						approvalMode: "auto",
						crossTaskRole: "root",
						userRequestText,
					}),
				)

				expect(namesOf(result.tools), `${apiProvider}: ${userRequestText}`).toContain("create_task")
				expect(result.surface?.policy.visibleTools, `${apiProvider}: ${userRequestText}`).toContain(
					"create_task",
				)
				expect(result.surface?.isCallable("create_task"), `${apiProvider}: ${userRequestText}`).toBe(true)
			}
		}
	})

	it("hides create_task from an ordinary root work request, including after a prior authorized turn", async () => {
		const catalogCache = new TaskToolCatalogCache()
		const base = {
			crossTaskRole: "root" as const,
			catalogCache,
		}
		const authorized = await buildNativeToolsArrayWithRestrictions(
			options({ ...base, userRequestText: "Create a new thread for parser review." }),
		)
		expect(authorized.surface?.isCallable("create_task")).toBe(true)

		for (const apiProvider of ["openai", "vscode-lm", "vertex"] as const) {
			const result = await buildNativeToolsArrayWithRestrictions(
				options({
					...base,
					apiConfiguration: { apiProvider },
					includeAllToolsWithRestrictions: apiProvider === "vertex",
					userRequestText: "Fix the parser with managed sub-agents if useful.",
				}),
			)
			expect(namesOf(result.tools), apiProvider).not.toContain("create_task")
			expect(result.surface?.policy.visibleTools, apiProvider).not.toContain("create_task")
			expect(result.surface?.isCallable("create_task"), apiProvider).toBe(false)
			expect(result.surface?.resolve("create_task"), apiProvider).toBeUndefined()
			expect(result.surface?.isCallable("spawn_agent"), apiProvider).toBe(true)
		}
	})

	it("keeps an old create_task declaration for Vertex replay without allowing a new call", async () => {
		const result = await buildNativeToolsArrayWithRestrictions(
			options({
				apiConfiguration: { apiProvider: "vertex" },
				includeAllToolsWithRestrictions: true,
				crossTaskRole: "root",
				userRequestText: "Fix the parser with managed sub-agents if useful.",
				discoveryHistory: [
					{
						role: "assistant",
						content: [{ type: "tool_use", id: "prior-create", name: "create_task", input: {} }],
					},
				],
			}),
		)

		expect(namesOf(result.tools)).toContain("create_task")
		expect(result.allowedFunctionNames).not.toContain("create_task")
		expect(result.surface?.isCallable("create_task")).toBe(false)
		expect(result.surface?.resolve("create_task")).toBeUndefined()
	})

	it("keeps Plan and retired custom-mode cross-task access read-only", async () => {
		const names = ["create_task", "list_tasks", "wait_task", "send_task_message", "steer_task", "stop_task"]
		const plan = await buildNativeToolsArrayWithRestrictions(
			options({
				mode: "architect",
				crossTaskRole: "root",
				userRequestText: "Create one independent task and stop it when complete.",
			}),
		)
		const custom = await buildNativeToolsArrayWithRestrictions(
			options({
				mode: "review-only",
				customModes: [{ slug: "review-only", name: "Review", groups: ["read", "agents"] } as any],
				crossTaskRole: "root",
				userRequestText: "Create one independent task and stop it when complete.",
			}),
		)

		for (const name of names) {
			const readOnly = name === "list_tasks" || name === "wait_task"
			expect(plan.surface?.isCallable(name)).toBe(readOnly)
			expect(custom.surface?.isCallable(name)).toBe(readOnly)
		}
	})

	it("does not advertise a retired completion tool from provider history", async () => {
		const history = [
			{
				role: "assistant" as const,
				content: [
					{
						type: "tool_use" as const,
						id: "completion-1",
						name: "attempt_completion",
						input: { result: "done" },
					},
				],
			},
		]
		const result = await buildNativeToolsArrayWithRestrictions(
			options({
				apiConfiguration: { apiProvider: "vertex" },
				includeAllToolsWithRestrictions: true,
				discoveryHistory: history,
				userRequestText: "Implement retry backoff in the scheduler.",
			}),
		)
		expect(namesOf(result.tools)).not.toContain("attempt_completion")
		expect(result.allowedFunctionNames).not.toContain("attempt_completion")
		expect(result.surface?.isCallable("attempt_completion")).toBe(false)
	})

	it("keeps authorized Code tools available when the request is uncertain", async () => {
		const result = await buildNativeToolsArrayWithRestrictions(
			options({ userRequestText: "Handle the scheduler." }),
		)
		expect(namesOf(result.tools)).toEqual(expect.arrayContaining(["spawn_agent", "apply_patch"]))
		expect(result.surface?.isCallable("write_to_file")).toBe(false)
	})

	it("keeps authorized workflow schemas callable on Vertex lookup turns", async () => {
		const result = await buildNativeToolsArrayWithRestrictions(
			options({
				apiConfiguration: { apiProvider: "vertex" },
				includeAllToolsWithRestrictions: true,
				userRequestText: "Where is retryLimit defined?",
			}),
		)
		expect(namesOf(result.tools)).toEqual(
			expect.arrayContaining(["exec_command", "request_user_input", "apply_patch"]),
		)
		expect(result.allowedFunctionNames).toEqual(
			expect.arrayContaining(["exec_command", "request_user_input", "apply_patch"]),
		)
		expect(result.surface?.isCallable("spawn_agent")).toBe(true)
		expect(namesOf(result.tools)).toContain("spawn_agent")
	})

	it("keeps disabled historical Vertex declarations visible but not callable on a later lookup", async () => {
		const result = await buildNativeToolsArrayWithRestrictions(
			options({
				apiConfiguration: { apiProvider: "vertex" },
				includeAllToolsWithRestrictions: true,
				userRequestText: "Where is retryLimit defined?",
				disabledTools: ["spawn_agent"],
				discoveryHistory: [
					{
						role: "assistant",
						content: [{ type: "tool_use", id: "call-1", name: "spawn_agent", input: {} }],
					},
				],
			}),
		)
		expect(namesOf(result.tools)).toContain("spawn_agent")
		expect(result.allowedFunctionNames).not.toContain("spawn_agent")
		expect(result.surface?.isCallable("spawn_agent")).toBe(false)
		expect(result.surface?.isCallable("exec_command")).toBe(true)
	})

	it("keeps the same catalog when a lookup becomes an implementation request", async () => {
		const cache = new TaskToolCatalogCache()
		const lookup = await buildNativeToolsArrayWithRestrictions(
			options({ catalogCache: cache, userRequestText: "Where is retryLimit defined?" }),
		)
		const implement = await buildNativeToolsArrayWithRestrictions(
			options({ catalogCache: cache, userRequestText: "Implement retry backoff in the scheduler." }),
		)
		expect(lookup.surface?.isCallable("write_to_file")).toBe(false)
		expect(implement.surface?.isCallable("write_to_file")).toBe(false)
		expect(implement.surface?.isCallable("apply_patch")).toBe(true)
		expect(lookup.surface?.isCallable("apply_patch")).toBe(true)
		expect(lookup.digest).toBe(implement.digest)
	})

	it("does not grant write tools on a Plan-mode lookup", async () => {
		const result = await buildNativeToolsArrayWithRestrictions(
			options({ mode: "architect", userRequestText: "Where is retryLimit defined?" }),
		)
		expect(namesOf(result.tools)).toEqual(expect.arrayContaining(["exec_command", "request_user_input"]))
		for (const name of ["read_file", "list_files", "search_files", "codebase_search"])
			expect(result.surface?.isCallable(name), name).toBe(false)
		expect(result.surface?.isCallable("write_to_file")).toBe(false)
		expect(result.surface?.isCallable("apply_patch")).toBe(false)
	})

	it("keeps managed-child catalogs independent of lookup wording", async () => {
		const result = await buildNativeToolsArrayWithRestrictions(
			options({
				taskKind: "subagent",
				enableAgentLifecycleTools: false,
				userRequestText: "Where is retryLimit defined?",
			}),
		)
		expect(namesOf(result.tools)).toEqual(expect.arrayContaining(["exec_command", "apply_patch"]))
		expect(namesOf(result.tools)).not.toEqual(
			expect.arrayContaining(["read_file", "list_files", "search_files", "codebase_search"]),
		)
		expect(namesOf(result.tools)).not.toContain("wait_agent")
	})
})
