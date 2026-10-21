import * as path from "node:path"
import { afterEach, expect, it, vi } from "vitest"

const nativeLoad = vi.hoisted(() => vi.fn())
const mkdir = vi.hoisted(() => vi.fn())

vi.mock("@lancedb/lancedb", () => {
	nativeLoad()
	throw new Error("Cannot find native binding")
})
vi.mock("fs/promises", () => ({ mkdir }))
vi.mock("../../../../i18n", () => ({
	t: (key: string, params: Record<string, string>) =>
		key.endsWith("lanceBackendUnavailable")
			? `Local indexing unavailable on ${params.platform}; select Qdrant. ${params.errorMessage}`
			: `Local indexing failed at ${params.indexPath}: ${params.errorMessage}`,
}))

afterEach(() => vi.restoreAllMocks())

it("loads an unavailable native backend only when indexing starts and retains the failure context", async () => {
	const { LanceDbVectorStore } = await import("../lancedb-client")
	const indexPath = path.resolve("workspace", ".alpha", "code-index", "lancedb")
	const store = new LanceDbVectorStore(path.resolve("workspace"), undefined, 3)
	expect(nativeLoad).not.toHaveBeenCalled()
	vi.spyOn(console, "error").mockImplementation(() => {})

	// Vitest wraps a failed mock factory; the indexing boundary must still retain its own path context.
	await expect(store.initialize()).rejects.toThrow(`Local indexing failed at ${indexPath}:`)
	await expect(store.initialize()).rejects.toThrow(
		`Local indexing unavailable on ${process.platform}-${process.arch}; select Qdrant`,
	)
	expect(nativeLoad).toHaveBeenCalledTimes(1)
	expect(mkdir).not.toHaveBeenCalled()
})
