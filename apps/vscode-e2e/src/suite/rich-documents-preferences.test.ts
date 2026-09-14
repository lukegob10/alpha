import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as vscode from "vscode"
import type { SkillMetadata } from "@alpha-code/types"

const OVERRIDE =
	"---\nname: rich-documents\ndescription: Owned installed-profile preference fixture.\n---\nAlpha NOR-67 installed-profile override fixture v1. Preserve this exact user-authored guidance across extension updates.\n"
const SNAPSHOT_NAME = ".alpha-rich-documents-preferences-fixture-v1.json"

interface SkillsProvider {
	getSkillsManager(): {
		refreshSkills(): Promise<SkillMetadata[]>
		getSkillsForMode(mode: string): SkillMetadata[]
	}
}

function parseOriginalPreference(bytes: string): string[] | undefined {
	const value: unknown = JSON.parse(bytes)
	assert.ok(value && typeof value === "object" && !Array.isArray(value))
	assert.deepEqual(Object.keys(value), ["disabledBuiltinSkills"])
	const preference: unknown = Reflect.get(value, "disabledBuiltinSkills")
	assert.ok(
		preference === null || (Array.isArray(preference) && preference.every((item) => typeof item === "string")),
	)
	return preference === null ? undefined : preference
}

suite("Rich document preferences in an installed profile", function () {
	this.timeout(60_000)
	for (const phase of ["prepare", "verify"] as const) {
		test(`${phase}: builtin disablement and project override survive installed-host restart`, async function () {
			if (process.env.TEST_FILE !== "rich-documents-preferences.test") this.skip()
			const requestedPhase = process.env.ALPHA_RICH_PREFERENCES_PHASE
			assert.ok(
				requestedPhase === "prepare" || requestedPhase === "verify",
				"Set ALPHA_RICH_PREFERENCES_PHASE explicitly",
			)
			if (requestedPhase !== phase) this.skip()
			const installedDirectory = process.env.ALPHA_E2E_INSTALLED_EXTENSION_DIR
			const installedVersion = process.env.ALPHA_E2E_INSTALLED_EXTENSION_VERSION
			const workspace = process.env.ALPHA_E2E_WORKSPACE
			assert.ok(
				installedDirectory && installedVersion && workspace,
				"An owned installed extension profile and workspace are required",
			)
			assert.equal(vscode.version, "1.122.1")
			assert.equal(vscode.workspace.workspaceFolders?.length, 1)
			const workspaceRoot = await fs.realpath(workspace)
			assert.equal(await fs.realpath(vscode.workspace.workspaceFolders![0]!.uri.fsPath), workspaceRoot)
			const extensions = vscode.extensions.all.filter((item) => item.id.toLowerCase() === "alphainc.alpha")
			assert.equal(extensions.length, 1, "Exactly one installed Alpha identity must be active")
			const extension = extensions[0]!
			assert.ok(extension.isActive)
			assert.equal(extension.exports, globalThis.api)
			assert.equal(await fs.realpath(extension.extensionPath), await fs.realpath(installedDirectory))
			assert.equal(extension.packageJSON.version, installedVersion)
			const manager = (
				globalThis.api as unknown as { sidebarProvider: SkillsProvider }
			).sidebarProvider.getSkillsManager()
			const overrideDirectory = path.join(workspaceRoot, ".alpha", "skills", "rich-documents")
			const overridePath = path.join(overrideDirectory, "SKILL.md")
			const snapshotPath = path.join(workspaceRoot, SNAPSHOT_NAME)
			const assertOwnedDirectory = async () => {
				const relative = path.relative(workspaceRoot, await fs.realpath(overrideDirectory))
				assert.ok(
					relative &&
						!path.isAbsolute(relative) &&
						relative !== ".." &&
						!relative.startsWith(`..${path.sep}`),
					"Fixture override must remain inside its owned workspace",
				)
			}
			const assertProjectOverride = async () => {
				await manager.refreshSkills()
				const selected = manager.getSkillsForMode("code").find((item) => item.name === "rich-documents")
				assert.equal(selected?.source, "project")
				assert.ok(selected)
				assert.equal(await fs.realpath(selected.path), await fs.realpath(overridePath))
			}
			if (phase === "prepare") {
				await fs.mkdir(overrideDirectory, { recursive: true })
				await assertOwnedDirectory()
				const original = globalThis.api.getConfiguration().disabledBuiltinSkills
				// The recovery snapshot contains this preference only, never credentials or provider configuration.
				await fs.writeFile(snapshotPath, JSON.stringify({ disabledBuiltinSkills: original ?? null }) + "\n", {
					flag: "wx",
				})
				await fs.writeFile(overridePath, OVERRIDE, { flag: "wx" })
				await globalThis.api.setConfiguration({
					...globalThis.api.getConfiguration(),
					disabledBuiltinSkills: ["rich-documents"],
				})
				assert.deepEqual(globalThis.api.getConfiguration().disabledBuiltinSkills, ["rich-documents"])
				await assertProjectOverride()
				// Deliberately retain both owned files and the preference for the next host process.
				return
			}
			await assertOwnedDirectory()
			const snapshotBytes = await fs.readFile(snapshotPath, "utf8")
			const original = parseOriginalPreference(snapshotBytes)
			assert.deepEqual(
				globalThis.api.getConfiguration().disabledBuiltinSkills,
				["rich-documents"],
				"A fresh installed host must retain builtin disablement",
			)
			assert.equal(
				await fs.readFile(overridePath, "utf8"),
				OVERRIDE,
				"Extension reinstall must not overwrite user guidance",
			)
			await assertProjectOverride()
			assert.equal(
				await fs.readFile(overridePath, "utf8"),
				OVERRIDE,
				"Only the exact owned override may be removed",
			)
			await fs.unlink(overridePath)
			await manager.refreshSkills()
			assert.ok(
				!manager.getSkillsForMode("code").some((item) => item.name === "rich-documents"),
				"Removing an override must not resurrect the disabled builtin",
			)
			await globalThis.api.setConfiguration({
				...globalThis.api.getConfiguration(),
				disabledBuiltinSkills: original,
			})
			assert.deepEqual(globalThis.api.getConfiguration().disabledBuiltinSkills, original)
			await manager.refreshSkills()
			assert.equal(
				await fs.readFile(snapshotPath, "utf8"),
				snapshotBytes,
				"Only the unchanged owned snapshot may be removed",
			)
			await fs.unlink(snapshotPath)
		})
	}
})
