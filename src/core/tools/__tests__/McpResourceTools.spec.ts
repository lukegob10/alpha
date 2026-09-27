import { describe, expect, it, vi } from "vitest"
import type { Task } from "../../task/Task"
import { listMcpResourcesTool, listMcpResourceTemplatesTool, readMcpResourceTool } from "../McpResourceTools"

function fixture(approve = true) {
	const listResources = vi.fn().mockResolvedValue({ resources: [{ uri: "doc://one", name: "One" }] })
	const listResourceTemplates = vi.fn().mockResolvedValue({
		resourceTemplates: [{ uriTemplate: "doc://{id}", name: "Document" }],
	})
	const readResource = vi.fn().mockResolvedValue({ contents: [{ uri: "doc://one", text: "content" }] })
	const hub = {
		getServers: () => [{ name: "docs", config: "{}", status: "connected", source: "project" }],
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
	return { task, callbacks, listResources, listResourceTemplates, readResource }
}

describe("MCP resource tools", () => {
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
		expect(listResources).toHaveBeenNthCalledWith(1, "docs", undefined, "project", undefined)
		expect(listResources).toHaveBeenNthCalledWith(2, "docs", "page-2", "project", undefined)
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
			expect.objectContaining({ message: expect.stringContaining("repeated a resource cursor") }),
		)
	})

	it("bounds the number of resources returned across pages", async () => {
		const { task, callbacks, listResources } = fixture()
		listResources.mockResolvedValue({
			resources: Array.from({ length: 10_001 }, (_, index) => ({ uri: `doc://${index}` })),
		})
		await listMcpResourcesTool.execute({}, task, callbacks)
		expect(listResources).toHaveBeenCalledOnce()
		expect(callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
	})

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
