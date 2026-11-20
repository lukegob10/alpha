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
		await logger.close()
		expect(fs.readFileSync(logger.path, "utf8")).toContain('"message":"fixture digest mismatch"')
	} finally {
		await logger.close()
		fs.rmSync(directory, { recursive: true, force: true })
	}
})

it("reports an asynchronous file error and keeps logging to the console", async () => {
	const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
	const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined)
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "eval-logger-"))
	const filename = "test.log"
	const destination = path.join(directory, filename)
	fs.mkdirSync(destination)
	const logger = new Logger({ logDir: directory, filename, tag: "test" })
	try {
		logger.info("before file failure")
		await logger.close()
		logger.info("after file failure")
		expect(consoleError).toHaveBeenCalledExactlyOnceWith(
			`Failed to write to log file ${destination}:`,
			expect.any(Error),
		)
		expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining("after file failure"))
	} finally {
		await logger.close()
		fs.rmSync(directory, { recursive: true, force: true })
	}
})
