import * as path from "node:path"

import { createRipgrepPathOverlay } from "../ripgrepEnvironment"

const binDirectory = process.platform === "win32" ? "C:\\alpha-rg" : "/alpha-rg"
const rgPath = path.join(binDirectory, process.platform === "win32" ? "rg.exe" : "rg")
const resolution = {
	path: rgPath,
	source: "bundled" as const,
	reason: "using extension-bundled @vscode/ripgrep",
}

describe("createRipgrepPathOverlay", () => {
	it("preserves the existing PATH key and leaves the input environment unchanged", () => {
		const env = { Path: path.join(binDirectory, "other") }

		expect(createRipgrepPathOverlay(env, resolution)).toEqual({
			Path: `${binDirectory}${path.delimiter}${env.Path}`,
		})
		expect(env).toEqual({ Path: path.join(binDirectory, "other") })
	})

	it("does not add a duplicate binary directory", () => {
		const existing = process.platform === "win32" ? binDirectory.toUpperCase() : binDirectory
		expect(
			createRipgrepPathOverlay({ PATH: `${existing}${path.delimiter}${path.dirname(existing)}` }, resolution),
		).toEqual({})
	})

	it("leaves PATH alone when the resolved binary is already on PATH or unavailable", () => {
		expect(createRipgrepPathOverlay({ PATH: "" }, undefined)).toEqual({})
		expect(createRipgrepPathOverlay({ PATH: "" }, { ...resolution, source: "system" })).toEqual({})
		expect(createRipgrepPathOverlay({ PATH: "" }, { ...resolution, path: "rg" })).toEqual({})
	})
})
