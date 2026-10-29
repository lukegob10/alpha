import { act, render, screen, waitFor } from "@/utils/test-utils"
import * as diffParser from "@src/utils/parseUnifiedDiff"

import DiffView from "../DiffView"

const highlightHunksMock = vi.hoisted(() => vi.fn())

vi.mock("@src/utils/highlightDiff", () => ({
	highlightHunks: highlightHunksMock,
}))

type HighlightResult = { oldLines: React.ReactNode[]; newLines: React.ReactNode[] }

const deferred = <T,>() => {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((promiseResolve) => {
		resolve = promiseResolve
	})
	return { promise, resolve }
}

const diff = (label: string) => `--- a/example.ts
+++ b/example.ts
@@ -1 +1 @@
-old ${label}
+new ${label}`

describe("DiffView", () => {
	beforeEach(() => {
		highlightHunksMock.mockReset()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("preserves independent old/new line ordering, gaps, and plain-text fallbacks", async () => {
		highlightHunksMock
			.mockResolvedValueOnce({
				oldLines: ["old start", "old one highlighted", "old two highlighted", "old fallback highlighted", ""],
				newLines: ["new start highlighted", "new one highlighted", "new two highlighted", "", ""],
			})
			.mockResolvedValueOnce({
				oldLines: ["tail old highlighted", "old tail context"],
				newLines: ["tail new highlighted", "tail context highlighted"],
			})
		const source = `--- a/example.ts
+++ b/example.ts
@@ -1,5 +1,5 @@
 context start
-old one
-old two
+new one
+new two
 context fallback
 context raw
@@ -10,2 +10,2 @@
-tail old
+tail new
 tail context`

		const { container } = render(<DiffView source={source} filePath="example.ts" />)
		await screen.findByText("tail context highlighted")

		const rows = Array.from(container.querySelectorAll("tbody > tr"))
		expect(rows.map((row) => row.lastElementChild?.textContent)).toEqual([
			"new start highlighted",
			"old one highlighted",
			"old two highlighted",
			"new one highlighted",
			"new two highlighted",
			"old fallback highlighted",
			"context raw",
			"4 hidden lines",
			"tail old highlighted",
			"tail new highlighted",
			"tail context highlighted",
		])
		expect(rows.map((row) => [row.children[0].textContent, row.children[1].textContent])).toEqual([
			["1", "1"],
			["2", ""],
			["3", ""],
			["", "2"],
			["", "3"],
			["4", "4"],
			["5", "5"],
			["", ""],
			["10", ""],
			["", "10"],
			["11", "11"],
		])
	})

	it("retains all raw lines when highlight results are unavailable", async () => {
		const pending = deferred<HighlightResult>()
		highlightHunksMock.mockReturnValue(pending.promise)
		const { container } = render(<DiffView source={diff("plain")} filePath="example.ts" />)

		await act(async () => {
			pending.resolve({ oldLines: [], newLines: [] })
		})

		expect(
			Array.from(container.querySelectorAll("tbody > tr"), (row) => row.lastElementChild?.textContent),
		).toEqual(["old plain", "new plain"])
	})

	it("reuses parse and highlight work when source and path are unchanged", async () => {
		const parseSpy = vi.spyOn(diffParser, "parseUnifiedDiff")
		highlightHunksMock.mockResolvedValue({ oldLines: ["old highlighted"], newLines: ["new highlighted"] })
		const source = diff("unchanged")
		const { rerender } = render(<DiffView source={source} filePath="example.ts" />)
		await screen.findByText("new highlighted")

		rerender(<DiffView source={source} filePath="example.ts" />)

		expect(parseSpy).toHaveBeenCalledTimes(1)
		expect(highlightHunksMock).toHaveBeenCalledTimes(1)
	})

	it("keeps highlighted line lookup work linear for a large mixed hunk", async () => {
		const rowCount = 900
		let lineTypeReads = 0
		const lines: diffParser.DiffLine[] = Array.from({ length: rowCount }, (_, index) => {
			const type = index % 3 === 0 ? "context" : index % 3 === 1 ? "deletion" : "addition"
			return {
				oldLineNum: null,
				newLineNum: null,
				get type() {
					lineTypeReads++
					return type
				},
				content: `line ${index}`,
			}
		})
		vi.spyOn(diffParser, "parseUnifiedDiff").mockReturnValue(lines)
		const pending = deferred<HighlightResult>()
		highlightHunksMock.mockReturnValue(pending.promise)
		const { container } = render(<DiffView source={diff("large")} filePath="example.ts" />)
		lineTypeReads = 0

		await act(async () => {
			pending.resolve({
				oldLines: Array.from({ length: 600 }, (_, index) => `old highlighted ${index}`),
				newLines: Array.from({ length: 600 }, (_, index) => `new highlighted ${index}`),
			})
		})

		expect(container.querySelectorAll("tbody > tr")).toHaveLength(rowCount)
		// Counting source-line inspections avoids a timing threshold while catching repeated prefix scans.
		expect(lineTypeReads).toBeLessThanOrEqual(rowCount * 16)
	})

	it("does not let an older highlight overwrite newer source", async () => {
		const pending: Array<ReturnType<typeof deferred<HighlightResult>>> = []
		highlightHunksMock.mockImplementation(() => {
			const result = deferred<HighlightResult>()
			pending.push(result)
			return result.promise
		})

		const { rerender } = render(<DiffView source={diff("A")} filePath="example.ts" />)
		await waitFor(() => expect(pending).toHaveLength(1))

		rerender(<DiffView source={diff("B")} filePath="example.ts" />)
		expect(screen.getByText("new B")).toBeInTheDocument()
		await waitFor(() => expect(pending).toHaveLength(2))

		await act(async () => {
			pending[1].resolve({ oldLines: ["old B highlighted"], newLines: ["new B highlighted"] })
		})
		expect(screen.getByText("new B highlighted")).toBeInTheDocument()

		await act(async () => {
			pending[0].resolve({ oldLines: ["old A highlighted"], newLines: ["new A highlighted"] })
		})

		expect(screen.getByText("new B highlighted")).toBeInTheDocument()
		expect(screen.queryByText("new A highlighted")).not.toBeInTheDocument()
	})
})
