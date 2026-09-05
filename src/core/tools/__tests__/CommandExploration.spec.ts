import fs from "fs/promises"
import os from "os"
import path from "path"

import { getTrustedCommandExploration } from "../CommandExploration"

describe("trusted command exploration", () => {
	let workspace: string

	beforeEach(async () => {
		workspace = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-command-exploration-"))
		await fs.mkdir(path.join(workspace, "src", "nested"), { recursive: true })
	})

	afterEach(async () => {
		await fs.rm(workspace, { recursive: true, force: true })
	})

	async function observe(command: string, overrides: Record<string, unknown> = {}) {
		return getTrustedCommandExploration({
			command,
			workspaceRoot: workspace,
			cwd: workspace,
			executionStatus: "succeeded",
			exitCode: 0,
			...overrides,
		})
	}

	it("canonicalizes equivalent ripgrep file inspections without using output", async () => {
		const short = await observe('rg --files -g "*.ts" ./src')
		const long = await observe("RG.EXE --glob '*.ts' --files src")

		expect(short).toEqual(long)
		expect(short).toEqual({
			scope: path.normalize(await fs.realpath(workspace)),
			semanticFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
		})
	})

	it("produces distinct stable identities for forty distinct supported inspections", async () => {
		const observations = await Promise.all(
			Array.from({ length: 40 }, (_, index) => observe(`rg --files --glob "file-${index}.ts"`)),
		)

		expect(observations.every(Boolean)).toBe(true)
		expect(new Set(observations.map((item) => item?.semanticFingerprint)).size).toBe(40)
	})

	it("canonicalizes supported git inspection spelling variants", async () => {
		const short = await observe("git --no-pager status -s")
		const long = await observe("GIT.EXE --no-pager status --short")

		expect(short).toEqual(long)
	})

	it("uses the workspace root for equivalent parent-target inspections from a nested cwd", async () => {
		const rootInspection = await observe("rg --files src")
		const nestedInspection = await observe("rg --files ..", { cwd: path.join(workspace, "src", "nested") })

		expect(nestedInspection).toEqual(rootInspection)
		expect(nestedInspection?.scope).toBe(path.normalize(await fs.realpath(workspace)))
	})

	it("collapses successful Git no-op path variants to one semantic identity", async () => {
		const first = await observe("git --no-pager status --short nonexistent-1")
		const second = await observe("git --no-pager status --short nonexistent-2")

		expect(first).toBeDefined()
		expect(second).toEqual(first)
	})

	it.each([
		["running", 0],
		["failed", 0],
		["succeeded", 1],
	] as const)("withholds observations for %s commands with exit %s", async (executionStatus, exitCode) => {
		expect(await observe("rg --files", { executionStatus, exitCode })).toBeUndefined()
	})

	it.each([
		"echo 2026-09-04T22:14:53Z",
		"rg pattern src",
		"rg --files --pre processor",
		"rg --files --follow",
		"rg --files ../outside",
		"rg --files src; echo changed",
	])("withholds progress metadata from unsupported or unsafe command %s", async (command) => {
		expect(await observe(command)).toBeUndefined()
	})

	it("requires the canonical command cwd to remain inside the workspace", async () => {
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-command-outside-"))
		try {
			expect(await observe("rg --files", { cwd: outside })).toBeUndefined()
		} finally {
			await fs.rm(outside, { recursive: true, force: true })
		}
	})
})
