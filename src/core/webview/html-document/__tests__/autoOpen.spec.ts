import type { AlphaMessage, HtmlDocumentTarget } from "@alpha-code/types"
import { HtmlDocumentAutoOpen } from "../autoOpen"

type OpenDocument = (target: HtmlDocumentTarget, isCurrent: () => boolean) => Promise<void>

const link = (uri = "file:///workspace/review.html", task = "task-1") =>
	`[Open document](alpha-document://open?uri=${encodeURIComponent(uri)}&task=${task})`
const completion = (text = link()): AlphaMessage => ({
	ts: 1,
	type: "say",
	say: "completion_result",
	partial: false,
	text,
})

describe("live document delivery", () => {
	it("opens a completed document once across duplicate and concurrent message deliveries", async () => {
		let release!: () => void
		const open = vi.fn<OpenDocument>(() => new Promise<void>((resolve) => (release = resolve)))
		const autoOpen = new HtmlDocumentAutoOpen(open)
		const owner = {}
		const first = autoOpen.handle(owner, "task-1", completion(), () => true)
		await autoOpen.handle(owner, "task-1", completion(), () => true)
		expect(open).toHaveBeenCalledOnce()
		expect(open.mock.calls[0][0]).toEqual({ uri: "file:///workspace/review.html", taskId: "task-1" })
		release()
		await first
		await autoOpen.handle(owner, "task-1", { ...completion(), ts: 2 }, () => true)
		expect(open).toHaveBeenCalledOnce()
	})

	it("ignores streamed prose, background tasks, user/tool messages, and mismatched task links", async () => {
		const open = vi.fn<OpenDocument>(async () => {})
		const autoOpen = new HtmlDocumentAutoOpen(open)
		const owner = {}
		await autoOpen.handle(owner, "task-1", { ...completion(), partial: true }, () => true)
		await autoOpen.handle(owner, "task-1", { ...completion(), say: "text" }, () => true)
		await autoOpen.handle(owner, "task-1", { ...completion(), type: "ask", ask: "tool" }, () => true)
		await autoOpen.handle(owner, "task-1", completion(), () => false)
		await autoOpen.handle(owner, "task-1", completion(link(undefined, "other-task")), () => true)
		expect(open).not.toHaveBeenCalled()
		await autoOpen.handle(owner, "task-1", completion(), () => true)
		expect(open).toHaveBeenCalledOnce()
	})

	it("ignores code examples and images while retaining real inline links", async () => {
		const open = vi.fn<OpenDocument>(async () => {})
		const autoOpen = new HtmlDocumentAutoOpen(open)
		const text = [
			"````markdown",
			link(),
			"```",
			link(),
			"````",
			`\`${link()}\``,
			`    ${link()}`,
			`!${link()}`,
			`Your review is ready. ${link("file:///workspace/actual.html")}`,
		].join("\n")
		await autoOpen.handle({}, "task-1", completion(text), () => true)
		expect(open).toHaveBeenCalledOnce()
		expect(open.mock.calls[0][0]).toMatchObject({ uri: "file:///workspace/actual.html" })
	})

	it("rechecks visibility between documents and passes the live guard through to the viewer", async () => {
		let current = true
		const guard = () => current
		const open = vi.fn<OpenDocument>(async () => {
			current = false
		})
		await new HtmlDocumentAutoOpen(open).handle(
			{},
			"task-1",
			completion(`${link()}\n${link("file:///workspace/second.html")}`),
			guard,
		)
		expect(open).toHaveBeenCalledOnce()
		expect(open.mock.calls[0][1]).toBe(guard)
	})

	it("bounds automatic panels and keeps task instances independent", async () => {
		const open = vi.fn<OpenDocument>(async () => {})
		const autoOpen = new HtmlDocumentAutoOpen(open)
		await autoOpen.handle(
			{},
			"task-1",
			completion(Array.from({ length: 10 }, (_, i) => link(`file:///workspace/${i}.html`)).join("\n")),
			() => true,
		)
		expect(open).toHaveBeenCalledTimes(8)
		await autoOpen.handle({}, "task-1", completion(link("file:///workspace/0.html")), () => true)
		expect(open).toHaveBeenCalledTimes(9)
	})
})
