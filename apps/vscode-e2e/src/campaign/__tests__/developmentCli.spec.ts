import { strict as assert } from "node:assert"
import { test } from "node:test"
import * as path from "node:path"
import * as os from "node:os"
import * as fs from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { main } from "../../runCampaign"

test("suite CLI rejects ambiguous or unsafe selection before creating a campaign or launching a host", async () => {
	const root = path.join(os.tmpdir(), "not-created-development-cli")
	for (const args of [
		["--suite", "smoke"],
		["--suite", "smoke", "--provider", "other"],
		["--suite", "smoke", "--provider", "live-copilot"],
		["--suite", "smoke", "--provider", "scripted", "--model-id", "gpt-5.6-luna"],
		["--suite", "unknown", "--provider", "scripted"],
		["--suite", "smoke", "--provider", "scripted", "--vscode-version", "stable"],
		["--suite", "smoke", "--provider", "scripted", "--vscode-executable", path.join(root, "Code.exe")],
		[
			"--suite",
			"smoke",
			"--provider",
			"scripted",
			"--vscode-version",
			"1.122.1",
			"--vscode-executable",
			"relative.exe",
		],
		["--suite", "smoke", "--provider", "scripted", "--enable-reviewed-patches"],
		["--suite", "smoke", "--config", "unused.json"],
		["--suite", "smoke", "--storage-recovery-root", root],
		["--suite", "smoke", "--shared-storage-root", root],
		["--provider", "scripted", "--config", "unused.json"],
		["--provider", "scripted"],
		["--gate", "--suite", "smoke", "--provider", "live-copilot"],
		["--gate", "--suite", "development", "--provider", "scripted"],
		["--gate", "--config", "unused.json"],
		["--max-requests", "100", "--config", "unused.json"],
		["--suite", "smoke", "--provider", "scripted", "--max-requests", "1e3"],
		["--suite", "smoke", "--provider", "scripted", "--samples", "0"],
		["--suite", "smoke", "--provider", "scripted", "--samples", "1.5"],
		["--suite", "smoke", "--provider", "scripted", "--samples", "2", "--samples", "3"],
	])
		await assert.rejects(
			main(["--root", root, ...args]),
			(error: unknown) => error instanceof Error,
			JSON.stringify(args),
		)
})

test("core gate dry-run accepts an explicit budget and repeat count without live requests", async () => {
	const root = path.join(os.tmpdir(), `alpha-core-preview-${randomUUID()}`)
	assert.equal(
		await main([
			"--suite",
			"core",
			"--gate",
			"--provider",
			"live-copilot",
			"--model-id",
			"gpt-5.6-luna",
			"--effort",
			"high",
			"--samples",
			"3",
			"--max-requests",
			"100",
			"--root",
			root,
			"--dry-run",
		]),
		0,
	)
	await assert.rejects(fs.stat(root), (error: NodeJS.ErrnoException) => error.code === "ENOENT")
})

test("dry-run plans a live suite without creating directories or trying to execute the selected binary", async () => {
	const root = path.join(os.tmpdir(), `alpha-development-preview-${randomUUID()}`)
	assert.equal(
		await main([
			"--suite",
			"smoke",
			"--provider",
			"live-copilot",
			"--model-id",
			"gpt-5.6-luna",
			"--effort",
			"high",
			"--root",
			root,
			"--profile-dir",
			path.join(root, "not-initialized-profile"),
			"--init-root",
			"--dry-run",
			"--vscode-version",
			"1.122.1",
			"--vscode-executable",
			path.join(root, "does-not-exist", "Code.exe"),
		]),
		0,
	)
	await assert.rejects(fs.stat(root), (error: NodeJS.ErrnoException) => error.code === "ENOENT")
})

test("dry-run rejects structurally unsafe roots just like execution", async () => {
	for (const root of ["relative-root", os.homedir(), path.parse(os.tmpdir()).root]) {
		await assert.rejects(main(["--suite", "smoke", "--provider", "scripted", "--root", root, "--dry-run"]))
	}
})
