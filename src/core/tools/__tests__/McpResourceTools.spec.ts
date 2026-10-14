import { afterEach, describe, expect, it, vi } from "vitest"
import type { McpServer } from "@alpha-code/types"
import type { Task } from "../../task/Task"
import { listMcpResourcesTool, listMcpResourceTemplatesTool, readMcpResourceTool } from "../McpResourceTools"

function server(name = "docs", source: "global" | "project" = "project"): McpServer {
	return { name, config: "{}", status: "connected", source }
}

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: Error) => void
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, resolve, reject }
}

function fixture(approve = true, servers: McpServer[] = [server()]) {
	const listResources = vi.fn().mockResolvedValue({ resources: [{ uri: "doc://one", name: "One" }] })
	const listResourceTemplates = vi.fn().mockResolvedValue({
		resourceTemplates: [{ uriTemplate: "doc://{id}", name: "Document" }],
	})
	const readResource = vi.fn().mockResolvedValue({ contents: [{ uri: "doc://one", text: "content" }] })
	const hub = {
		getServers: () => servers,
		listResources,
		listResourceTemplates,
		readResource,
	}
	const task = {
		cwd: "/workspace",
		providerRef: { deref: () => ({ getMcpHub: () => hub }) },
	} as unknown as Task
	const callbacks = {
		askApproval: vi.fn().mockResolvedValue(approve),
		handleError: vi.fn(),
		pushToolResult: vi.fn(),
		setResultMetadata: vi.fn(),
	}
	return { task, callbacks, listResources, listResourceTemplates, readResource, hub, servers }
}

const catalogs = [
	{
		field: "resources",
		listMethod: "listResources",
		tool: listMcpResourcesTool,
		item: (index: number) => ({ uri: `doc://${index}`, name: `Document ${index}` }),
	},
	{
		field: "resourceTemplates",
		listMethod: "listResourceTemplates",
		tool: listMcpResourceTemplatesTool,
		item: (index: number) => ({ uriTemplate: `doc://${index}/{id}`, name: `Template ${index}` }),
	},
] as const

describe("MCP resource tools", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it("settles approval before listing a cursor page", async () => {
		const { task, callbacks, listResources } = fixture()
		await listMcpResourcesTool.execute({ server: "docs", cursor: "page-2" }, task, callbacks)
		expect(callbacks.askApproval).toHaveBeenCalledWith(
			"use_mcp_server",
			expect.stringContaining('"uri":"resources/list"'),
		)
		expect(callbacks.askApproval.mock.invocationCallOrder[0]).toBeLessThan(
			listResources.mock.invocationCallOrder[0],
		)
		expect(listResources).toHaveBeenCalledWith("docs", "page-2", "project", undefined)
		expect(JSON.parse(callbacks.pushToolResult.mock.calls[0][0])).toEqual({
			server: "docs",
			resources: [{ server: "docs", uri: "doc://one", name: "One" }],
		})
	})

	it("denies resource and template listings without contacting the MCP server", async () => {
		const { task, callbacks, listResources, listResourceTemplates } = fixture(false)
		await listMcpResourcesTool.execute({}, task, callbacks)
		await listMcpResourceTemplatesTool.execute({}, task, callbacks)
		expect(listResources).not.toHaveBeenCalled()
		expect(listResourceTemplates).not.toHaveBeenCalled()
		expect(callbacks.setResultMetadata).toHaveBeenCalledTimes(2)
		expect(callbacks.setResultMetadata).toHaveBeenNthCalledWith(1, { status: "denied" })
		expect(callbacks.setResultMetadata).toHaveBeenNthCalledWith(2, { status: "denied" })
	})

	it("lists resource templates with their server names", async () => {
		const { task, callbacks, listResourceTemplates } = fixture()
		await listMcpResourceTemplatesTool.execute({}, task, callbacks)
		expect(listResourceTemplates).toHaveBeenCalledOnce()
		expect(JSON.parse(callbacks.pushToolResult.mock.calls[0][0])).toEqual({
			resourceTemplates: [{ server: "docs", uriTemplate: "doc://{id}", name: "Document" }],
		})
	})

	it("collects every page when no server is selected", async () => {
		const { task, callbacks, listResources } = fixture()
		listResources
			.mockResolvedValueOnce({ resources: [{ uri: "doc://one", name: "One" }], nextCursor: "page-2" })
			.mockResolvedValueOnce({ resources: [{ uri: "doc://two", name: "Two" }] })
		await listMcpResourcesTool.execute({}, task, callbacks)
		expect(listResources).toHaveBeenNthCalledWith(1, "docs", undefined, "project", expect.any(AbortSignal))
		expect(listResources).toHaveBeenNthCalledWith(2, "docs", "page-2", "project", expect.any(AbortSignal))
		expect(JSON.parse(callbacks.pushToolResult.mock.calls[0][0])).toEqual({
			resources: [
				{ server: "docs", uri: "doc://one", name: "One" },
				{ server: "docs", uri: "doc://two", name: "Two" },
			],
		})
	})

	it("stops a server that repeats a pagination cursor", async () => {
		const { task, callbacks, listResources } = fixture()
		listResources.mockResolvedValue({ resources: [], nextCursor: "same" })
		await listMcpResourcesTool.execute({}, task, callbacks)
		expect(listResources).toHaveBeenCalledTimes(2)
		expect(callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
		expect(callbacks.handleError).toHaveBeenCalledWith(
			"listing MCP resources",
			expect.objectContaining({ message: expect.stringContaining("repeated") }),
		)
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
	})

	it("bounds the number of resources returned across pages", async () => {
		const { task, callbacks, listResources } = fixture()
		listResources.mockResolvedValue({
			resources: Array.from({ length: 2_049 }, (_, index) => ({
				uri: `doc://${index}`,
				name: `Document ${index}`,
			})),
		})
		await listMcpResourcesTool.execute({}, task, callbacks)
		expect(listResources).toHaveBeenCalledOnce()
		expect(callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
	})

	for (const { field, listMethod, tool, item } of catalogs) {
		describe(field, () => {
			it("preserves an empty cursor and continuation on a selected server's single page", async () => {
				const context = fixture()
				const list = context[listMethod]
				list.mockResolvedValue({ [field]: [item(1)], nextCursor: "" })
				await tool.execute({ server: "docs", cursor: "" }, context.task, context.callbacks)
				expect(list).toHaveBeenCalledOnce()
				expect(list).toHaveBeenCalledWith("docs", "", "project", undefined)
				expect(JSON.parse(context.callbacks.pushToolResult.mock.calls[0][0])).toEqual({
					server: "docs",
					[field]: [{ ...item(1), server: "docs" }],
					nextCursor: "",
				})
			})

			it("requires a server even when the supplied cursor is empty", async () => {
				const context = fixture()
				await tool.execute({ cursor: "" }, context.task, context.callbacks)
				expect(context[listMethod]).not.toHaveBeenCalled()
				expect(context.callbacks.askApproval).not.toHaveBeenCalled()
				expect(context.callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
				expect(context.callbacks.pushToolResult).not.toHaveBeenCalled()
			})

			it("collects a valid empty continuation and preserves page order", async () => {
				const context = fixture()
				const list = context[listMethod]
				list.mockResolvedValueOnce({ [field]: [item(1)], nextCursor: "" })
					.mockResolvedValueOnce({ [field]: [], nextCursor: "last" })
					.mockResolvedValueOnce({ [field]: [item(2)] })
				await tool.execute({}, context.task, context.callbacks)
				expect(list).toHaveBeenNthCalledWith(1, "docs", undefined, "project", expect.any(AbortSignal))
				expect(list).toHaveBeenNthCalledWith(2, "docs", "", "project", expect.any(AbortSignal))
				expect(list).toHaveBeenNthCalledWith(3, "docs", "last", "project", expect.any(AbortSignal))
				expect(context.callbacks.pushToolResult).toHaveBeenCalledOnce()
				expect(JSON.parse(context.callbacks.pushToolResult.mock.calls[0][0])).toEqual({
					[field]: [item(1), item(2)].map((value) => ({ ...value, server: "docs" })),
				})
			})

			it("rejects a nonconsecutive repeated empty cursor without publishing earlier pages", async () => {
				const context = fixture()
				const list = context[listMethod]
				list.mockResolvedValueOnce({ [field]: [item(1)], nextCursor: "" })
					.mockResolvedValueOnce({ [field]: [item(2)], nextCursor: "later" })
					.mockResolvedValueOnce({ [field]: [item(3)], nextCursor: "" })
				await tool.execute({}, context.task, context.callbacks)
				expect(list).toHaveBeenCalledTimes(3)
				expect(context.callbacks.pushToolResult).not.toHaveBeenCalled()
				expect(context.callbacks.handleError).toHaveBeenCalledWith(
					"listing MCP resources",
					expect.objectContaining({ message: expect.stringContaining("repeated") }),
				)
			})

			it("accepts the exact item bound across pages", async () => {
				const context = fixture()
				const list = context[listMethod]
				list.mockResolvedValueOnce({
					[field]: Array.from({ length: 2_048 }, (_, index) => item(index)),
					nextCursor: "last",
				}).mockResolvedValueOnce({ [field]: [] })
				await tool.execute({}, context.task, context.callbacks)
				expect(list).toHaveBeenCalledTimes(2)
				expect(context.callbacks.handleError).not.toHaveBeenCalled()
				expect(JSON.parse(context.callbacks.pushToolResult.mock.calls[0][0])[field]).toHaveLength(2_048)
			})

			it("rejects an item overflow across individually valid pages", async () => {
				const context = fixture()
				const list = context[listMethod]
				list.mockResolvedValueOnce({
					[field]: Array.from({ length: 2_047 }, (_, index) => item(index)),
					nextCursor: "last",
				}).mockResolvedValueOnce({ [field]: [item(2_047), item(2_048)] })
				await tool.execute({}, context.task, context.callbacks)
				expect(list).toHaveBeenCalledTimes(2)
				expect(context.callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
				expect(context.callbacks.pushToolResult).not.toHaveBeenCalled()
			})

			it("bounds a selected server's single page to 2,048 items", async () => {
				const context = fixture()
				context[listMethod].mockResolvedValue({
					[field]: Array.from({ length: 2_049 }, (_, index) => item(index)),
				})
				await tool.execute({ server: "docs" }, context.task, context.callbacks)
				expect(context[listMethod]).toHaveBeenCalledOnce()
				expect(context.callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
				expect(context.callbacks.pushToolResult).not.toHaveBeenCalled()
			})

			it("accepts completion on the 100th page", async () => {
				const context = fixture()
				const list = context[listMethod]
				let page = 0
				list.mockImplementation(async () => ({
					[field]: [item(page)],
					nextCursor: ++page === 100 ? undefined : `page-${page}`,
				}))
				await tool.execute({}, context.task, context.callbacks)
				expect(list).toHaveBeenCalledTimes(100)
				expect(context.callbacks.handleError).not.toHaveBeenCalled()
				expect(JSON.parse(context.callbacks.pushToolResult.mock.calls[0][0])[field]).toHaveLength(100)
			})

			it("rejects a continuation after page 100 before sending page 101", async () => {
				const context = fixture()
				const list = context[listMethod]
				let page = 0
				list.mockImplementation(async () => ({ [field]: [], nextCursor: `page-${++page}` }))
				await tool.execute({}, context.task, context.callbacks)
				expect(list).toHaveBeenCalledTimes(100)
				expect(context.callbacks.pushToolResult).not.toHaveBeenCalled()
				expect(context.callbacks.handleError).toHaveBeenCalledWith(
					"listing MCP resources",
					expect.objectContaining({ message: expect.stringContaining("100 pages") }),
				)
			})

			it("accepts a cursor exactly 64 KiB in UTF-8 bytes", async () => {
				const context = fixture()
				const list = context[listMethod]
				const cursor = "é".repeat(32_768)
				list.mockResolvedValueOnce({ [field]: [], nextCursor: cursor }).mockResolvedValueOnce({
					[field]: [item(1)],
				})
				await tool.execute({}, context.task, context.callbacks)
				expect(list).toHaveBeenCalledTimes(2)
				expect(list).toHaveBeenNthCalledWith(2, "docs", cursor, "project", expect.any(AbortSignal))
				expect(context.callbacks.pushToolResult).toHaveBeenCalledOnce()
			})

			it.each([{}, { server: "docs" }])("rejects a UTF-8 oversized continuation for %j", async (params) => {
				const context = fixture()
				context[listMethod].mockResolvedValue({ [field]: [item(1)], nextCursor: "é".repeat(32_769) })
				await tool.execute(params, context.task, context.callbacks)
				expect(context[listMethod]).toHaveBeenCalledOnce()
				expect(context.callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
				expect(context.callbacks.pushToolResult).not.toHaveBeenCalled()
			})

			it("does not publish a partial result when a later page fails", async () => {
				const context = fixture()
				const error = new Error("second page failed")
				context[listMethod]
					.mockResolvedValueOnce({ [field]: [item(1)], nextCursor: "later" })
					.mockRejectedValueOnce(error)
				await tool.execute({}, context.task, context.callbacks)
				expect(context[listMethod]).toHaveBeenCalledTimes(2)
				expect(context.callbacks.pushToolResult).not.toHaveBeenCalled()
				expect(context.callbacks.handleError).toHaveBeenCalledWith("listing MCP resources", error)
			})

			it("rejects a UTF-8 oversized input cursor before contacting the selected server", async () => {
				const context = fixture()
				await tool.execute({ server: "docs", cursor: "é".repeat(32_769) }, context.task, context.callbacks)
				expect(context[listMethod]).not.toHaveBeenCalled()
				expect(context.callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
				expect(context.callbacks.pushToolResult).not.toHaveBeenCalled()
			})

			it("uses the projected project's source when a global server shares its name", async () => {
				const projectServer = server("docs", "project")
				const context = fixture(true, [server("docs", "global"), projectServer])
				// The real hub exposes only the project server for a name shared across scopes.
				context.hub.getServers = () => [projectServer]
				context[listMethod].mockResolvedValue({ [field]: [item(1)] })
				await tool.execute({}, context.task, context.callbacks)
				expect(context[listMethod]).toHaveBeenCalledOnce()
				expect(context[listMethod]).toHaveBeenCalledWith("docs", undefined, "project", expect.any(AbortSignal))
				expect(context.callbacks.askApproval).toHaveBeenCalledOnce()
				expect(JSON.parse(context.callbacks.pushToolResult.mock.calls[0][0])[field]).toHaveLength(1)
			})

			it("accepts exactly 10,000 aggregate items across valid server catalogs", async () => {
				const context = fixture(
					true,
					Array.from({ length: 5 }, (_, index) => server(`docs-${index}`)),
				)
				context[listMethod].mockImplementation(async (name) => ({
					[field]: Array.from({ length: name === "docs-4" ? 1_808 : 2_048 }, (_, index) => item(index)),
				}))
				await tool.execute({}, context.task, context.callbacks)
				expect(context[listMethod]).toHaveBeenCalledTimes(5)
				expect(context.callbacks.handleError).not.toHaveBeenCalled()
				expect(context.callbacks.pushToolResult).toHaveBeenCalledOnce()
				expect(JSON.parse(context.callbacks.pushToolResult.mock.calls[0][0])[field]).toHaveLength(10_000)
			})

			it("retains the 10,000-item aggregate output ceiling across valid server catalogs", async () => {
				const context = fixture(
					true,
					Array.from({ length: 5 }, (_, index) => server(`docs-${index}`)),
				)
				context[listMethod].mockResolvedValue({
					[field]: Array.from({ length: 2_048 }, (_, index) => item(index)),
				})
				await tool.execute({}, context.task, context.callbacks)
				expect(context[listMethod]).toHaveBeenCalledTimes(5)
				expect(context.callbacks.pushToolResult).not.toHaveBeenCalled()
				expect(context.callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
			})

			it("rejects a same-name server replacement after approval before contacting it", async () => {
				const context = fixture()
				const approval = deferred<boolean>()
				const started = deferred<void>()
				context.callbacks.askApproval.mockImplementation(() => {
					started.resolve()
					return approval.promise
				})
				const listing = tool.execute({}, context.task, context.callbacks)
				await started.promise
				context.servers[0] = server()
				approval.resolve(true)
				await listing
				expect(context[listMethod]).not.toHaveBeenCalled()
				expect(context.callbacks.pushToolResult).not.toHaveBeenCalled()
				expect(context.callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
			})

			it.each([undefined, "later"])(
				"rejects a server replacement during a pending page with cursor %j",
				async (nextCursor) => {
					const context = fixture()
					const page = deferred<Record<string, unknown>>()
					const started = deferred<void>()
					context[listMethod].mockImplementation(() => {
						started.resolve()
						return page.promise
					})
					const listing = tool.execute({}, context.task, context.callbacks)
					await started.promise
					context.servers[0] = server()
					page.resolve({ [field]: [item(1)], nextCursor })
					await listing
					expect(context[listMethod]).toHaveBeenCalledOnce()
					expect(context.callbacks.pushToolResult).not.toHaveBeenCalled()
					expect(context.callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
				},
			)

			it("rejects replacement of an already collected server before aggregate publication", async () => {
				const context = fixture(true, [server("a-docs"), server("z-docs")])
				const lastPage = deferred<Record<string, unknown>>()
				const started = deferred<void>()
				context[listMethod].mockImplementation((name) => {
					if (name === "a-docs") return Promise.resolve({ [field]: [item(1)] })
					started.resolve()
					return lastPage.promise
				})
				const listing = tool.execute({}, context.task, context.callbacks)
				await started.promise
				context.servers[0] = server("a-docs")
				lastPage.resolve({ [field]: [item(2)] })
				await listing
				expect(context[listMethod]).toHaveBeenCalledTimes(2)
				expect(context.callbacks.pushToolResult).not.toHaveBeenCalled()
				expect(context.callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
			})

			it("rejects a selected server replacement before publishing its pending page", async () => {
				const context = fixture()
				const page = deferred<Record<string, unknown>>()
				const started = deferred<void>()
				context[listMethod].mockImplementation(() => {
					started.resolve()
					return page.promise
				})
				const listing = tool.execute({ server: "docs" }, context.task, context.callbacks)
				await started.promise
				context.servers[0] = server()
				page.resolve({ [field]: [item(1)] })
				await listing
				expect(context[listMethod]).toHaveBeenCalledOnce()
				expect(context.callbacks.pushToolResult).not.toHaveBeenCalled()
				expect(context.callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
			})

			it("honors cancellation when no servers are available", async () => {
				const context = fixture(true, [])
				const controller = new AbortController()
				const reason = new Error("cancelled empty listing")
				controller.abort(reason)
				await expect(
					tool.execute({}, context.task, { ...context.callbacks, signal: controller.signal }),
				).rejects.toBe(reason)
				expect(context[listMethod]).not.toHaveBeenCalled()
				expect(context.callbacks.pushToolResult).not.toHaveBeenCalled()
				expect(context.callbacks.handleError).not.toHaveBeenCalled()
			})

			it("applies one default timeout across individually timely pages", async () => {
				vi.useFakeTimers()
				const context = fixture()
				const started = deferred<void>()
				let page = 0
				context[listMethod].mockImplementation(() => {
					started.resolve()
					const current = ++page
					return new Promise((resolve) =>
						setTimeout(() => resolve({ [field]: [item(current)], nextCursor: `page-${current}` }), 12_000),
					)
				})
				const listing = tool.execute({}, context.task, context.callbacks)
				await started.promise
				await vi.advanceTimersByTimeAsync(30_000)
				await listing
				expect(context[listMethod]).toHaveBeenCalledTimes(3)
				expect(context.callbacks.pushToolResult).not.toHaveBeenCalled()
				expect(context.callbacks.handleError).toHaveBeenCalledWith(
					"listing MCP resources",
					expect.objectContaining({ message: expect.stringContaining("timed out") }),
				)
				await vi.advanceTimersByTimeAsync(12_000)
				expect(context[listMethod]).toHaveBeenCalledTimes(3)
				expect(context.callbacks.pushToolResult).not.toHaveBeenCalled()
			})

			it("shares the 30-second deadline across individually timely server catalogs", async () => {
				vi.useFakeTimers()
				const context = fixture(true, [server("a-docs"), server("b-docs"), server("c-docs")])
				const started = deferred<void>()
				context[listMethod].mockImplementation(() => {
					started.resolve()
					return new Promise((resolve) => setTimeout(() => resolve({ [field]: [item(1)] }), 12_000))
				})
				const listing = tool.execute({}, context.task, context.callbacks)
				const settled = vi.fn()
				void listing.then(settled)
				await started.promise
				await vi.advanceTimersByTimeAsync(30_000)
				expect(settled).toHaveBeenCalledOnce()
				await listing
				expect(context[listMethod].mock.calls.map(([name]) => name)).toEqual(["a-docs", "b-docs", "c-docs"])
				expect(context.callbacks.pushToolResult).not.toHaveBeenCalled()
				expect(context.callbacks.handleError).toHaveBeenCalledWith(
					"listing MCP resources",
					expect.objectContaining({ message: expect.stringContaining("timed out") }),
				)
				await vi.advanceTimersByTimeAsync(6_000)
				expect(context[listMethod]).toHaveBeenCalledTimes(3)
				expect(context.callbacks.pushToolResult).not.toHaveBeenCalled()
			})

			it("settles a cancelled listing when the pending page ignores abort", async () => {
				const context = fixture()
				const controller = new AbortController()
				const started = deferred<void>()
				const page = deferred<Record<string, unknown>>()
				context[listMethod].mockImplementation(() => {
					started.resolve()
					return page.promise
				})
				const listing = tool.execute({}, context.task, { ...context.callbacks, signal: controller.signal })
				await started.promise
				const aborted = expect(listing).rejects.toThrow("cancelled pending page")
				controller.abort(new Error("cancelled pending page"))
				await aborted
				page.reject(new Error("late page error"))
				await Promise.resolve()
				expect(context.callbacks.pushToolResult).not.toHaveBeenCalled()
				expect(context.callbacks.handleError).not.toHaveBeenCalled()
			})
		})
	}

	it("approves and returns structured resource contents", async () => {
		const { task, callbacks, readResource } = fixture()
		await readMcpResourceTool.execute({ server: "docs", uri: "doc://one" }, task, callbacks)
		expect(callbacks.askApproval.mock.invocationCallOrder[0]).toBeLessThan(readResource.mock.invocationCallOrder[0])
		expect(readResource).toHaveBeenCalledWith("docs", "doc://one", "project", undefined)
		expect(JSON.parse(callbacks.pushToolResult.mock.calls[0][0])).toEqual({
			server: "docs",
			uri: "doc://one",
			contents: [{ uri: "doc://one", text: "content" }],
		})
		expect(callbacks.setResultMetadata).toHaveBeenCalledWith(expect.objectContaining({ status: "success" }))
	})

	it("stops after cancellation during resource listing approval", async () => {
		const { task, callbacks, listResources } = fixture()
		const controller = new AbortController()
		callbacks.askApproval.mockImplementation(async () => {
			controller.abort(new Error("cancelled"))
			return true
		})
		await expect(
			listMcpResourcesTool.execute({}, task, { ...callbacks, signal: controller.signal }),
		).rejects.toThrow("cancelled")
		expect(listResources).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
	})
})
