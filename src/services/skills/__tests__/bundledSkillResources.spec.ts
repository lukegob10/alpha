import fs from "fs/promises"
import os from "os"
import path from "path"

import { isBundledSkillResource } from "../bundledSkillResources"

describe("bundled skill resources", () => {
	let extensionPath: string

	beforeEach(async () => {
		extensionPath = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-skill-resources-"))
	})

	afterEach(async () => {
		await fs.rm(extensionPath, { recursive: true, force: true })
	})

	async function createResource(relative: string): Promise<string> {
		const resource = path.join(extensionPath, ...relative.split("/"))
		await fs.mkdir(path.dirname(resource), { recursive: true })
		await fs.writeFile(resource, "Packaged reference")
		return resource
	}

	it.each(["evaluation.md", "standard-and-hosts.md"])(
		"allows the exact skill-builder reference %s",
		async (fileName) => {
			const resource = await createResource(`assets/skills/skill-builder/references/${fileName}`)
			await expect(isBundledSkillResource(extensionPath, resource)).resolves.toBe(true)
		},
	)

	it("does not widen access to adjacent, missing, relative, or traversal paths", async () => {
		const adjacent = await createResource("assets/skills/skill-builder/references/private.md")
		const references = path.dirname(adjacent)

		await expect(isBundledSkillResource(extensionPath, adjacent)).resolves.toBe(false)
		await expect(
			isBundledSkillResource(
				extensionPath,
				`${references}${path.sep}..${path.sep}references${path.sep}standard-and-hosts.md`,
			),
		).resolves.toBe(false)
		await expect(
			isBundledSkillResource(
				extensionPath,
				path.join(extensionPath, "assets/skills/skill-builder/references/evaluation.md"),
			),
		).resolves.toBe(false)
		await expect(
			isBundledSkillResource(extensionPath, "assets/skills/skill-builder/references/evaluation.md"),
		).resolves.toBe(false)
	})
})
