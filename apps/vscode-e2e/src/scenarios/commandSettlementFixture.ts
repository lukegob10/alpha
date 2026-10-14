import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import { assertOwnedTestRoot } from "../testProfile"
import { SETTLEMENT_ORACLE } from "./commandSettlement"

const IGNORE_CONTENT = ".alpha-*\n"
const WORKLOAD_FILES = ["index.html", "app.js", "style.css", "config.json", "README.md", "build-receipt.json"]

/** Shared host-owned files outlive individual tasks; workload files may be cleared only after task disposal. */
export class CommandSettlementFixture {
	private initialized = false
	private caseOpen = false

	constructor(
		private readonly workspace: string,
		private readonly artifactsDirectory: string,
	) {}

	async prepareCase(): Promise<void> {
		assert.equal(this.caseOpen, false, "The previous settlement task must be disposed before workspace reuse")
		await assertOwnedTestRoot(this.workspace, "workspace")
		if (this.initialized) {
			await this.assertHostFiles()
			for (const name of WORKLOAD_FILES) {
				const file = path.join(this.workspace, name)
				const stat = await this.stat(file)
				if (!stat) continue
				assert.ok(
					stat.isFile() && !stat.isSymbolicLink(),
					`Refusing to remove a non-file settlement fixture: ${name}`,
				)
				await fs.unlink(file)
			}
		} else {
			for (const name of WORKLOAD_FILES)
				assert.equal(
					await this.stat(path.join(this.workspace, name)),
					undefined,
					`Settlement file already exists: ${name}`,
				)
			await fs.writeFile(path.join(this.workspace, ".alphaignore"), IGNORE_CONTENT, { flag: "wx" })
			await fs.writeFile(path.join(this.workspace, ".alpha-receipt-oracle.cjs"), SETTLEMENT_ORACLE, {
				flag: "wx",
			})
			this.initialized = true
		}
		this.caseOpen = true
	}

	async finishCase(): Promise<void> {
		assert.equal(this.caseOpen, true, "No settlement case owns this workspace")
		await assertOwnedTestRoot(this.workspace, "workspace")
		await this.assertHostFiles()
		this.caseOpen = false
	}

	resultPath(terminalProvider: "execa" | "vscode"): string {
		return path.join(this.artifactsDirectory, `command-settlement-${terminalProvider}.json`)
	}

	private async assertHostFiles(): Promise<void> {
		for (const [name, content] of [
			[".alphaignore", IGNORE_CONTENT],
			[".alpha-receipt-oracle.cjs", SETTLEMENT_ORACLE],
		] as const) {
			const file = path.join(this.workspace, name)
			const stat = await this.stat(file)
			assert.ok(stat?.isFile() && !stat.isSymbolicLink(), `Missing regular host fixture: ${name}`)
			assert.equal(await fs.readFile(file, "utf8"), content, `Host fixture was changed: ${name}`)
		}
	}

	private async stat(file: string) {
		return fs.lstat(file).catch((error: unknown) => {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
				return undefined
			throw error
		})
	}
}
