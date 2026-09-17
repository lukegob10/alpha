import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, expect, it, vi } from "vitest"

import { Logger } from "../utils"

afterEach(() => vi.restoreAllMocks())

it("logs actionable Error details instead of an empty object", async () => {
	const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined)
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "eval-logger-"))
	const logger = new Logger({ logDir: directory, filename: "test.log", tag: "test" })
	try {
		logger.error("task failed", new Error("fixture digest mismatch"))
		expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('"message":"fixture digest mismatch"'))
	} finally {
		await new Promise((resolve) => setImmediate(resolve))
		logger.close()
		await new Promise((resolve) => setTimeout(resolve, 10))
		fs.rmSync(directory, { recursive: true, force: true })
	}
})
