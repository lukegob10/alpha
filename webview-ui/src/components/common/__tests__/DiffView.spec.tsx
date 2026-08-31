import { act, render, screen, waitFor } from "@/utils/test-utils"

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
