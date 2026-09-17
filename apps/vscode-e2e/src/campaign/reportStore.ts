import * as fs from "node:fs/promises"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { assertSafeRoot, readBounded, rejectSymlinkComponents } from "../evidence/paths"
import type { CampaignReport } from "./types"

const ROOT_MARKER = ".alpha-vscode-campaign-root.json"

/** Dedicated root initialization never adopts a nonempty directory or follows a symlink. */
export async function openCampaignRoot(root: string, initialize: boolean): Promise<string> {
	const resolved = assertSafeRoot(root)
	await rejectSymlinkComponents(resolved)
	if (initialize) await fs.mkdir(resolved, { recursive: true, mode: 0o700 })
	const canonical = assertSafeRoot(await fs.realpath(resolved))
	const marker = path.join(canonical, ROOT_MARKER)
	try {
		const stat = await fs.lstat(marker)
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128) throw new Error("Invalid campaign root marker")
		if (
			(await readBounded(marker, 128)).toString("utf8") !== '{"schemaVersion":1,"kind":"alpha-vscode-campaign"}\n'
		) {
			throw new Error("Invalid campaign root marker")
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		if (!initialize || (await fs.readdir(canonical)).length !== 0)
			throw new Error("Initialize a new empty dedicated campaign root")
		await fs.writeFile(marker, '{"schemaVersion":1,"kind":"alpha-vscode-campaign"}\n', { flag: "wx", mode: 0o600 })
	}
	return canonical
}

export async function createReportStore(root: string, campaignId: string) {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(campaignId)) throw new Error("Invalid campaign identifier")
	const directory = path.join(await openCampaignRoot(root, false), campaignId)
	await rejectSymlinkComponents(directory)
	// A run ID is never reused: previous evidence cannot be overwritten by a rerun.
	await fs.mkdir(directory, { mode: 0o700 })
	let sequence = 0
	return {
		directory,
		async persistReport(report: CampaignReport): Promise<void> {
			const destination = path.join(directory, `report-${String(++sequence).padStart(5, "0")}.json`)
			await rejectSymlinkComponents(directory)
			const temporary = path.join(directory, `.report-${randomUUID()}.tmp`)
			const handle = await fs.open(temporary, "wx", 0o600)
			try {
				await handle.writeFile(JSON.stringify(report, null, 2) + "\n", "utf8")
				await handle.sync()
			} finally {
				await handle.close()
			}
			// Exclusive hard-link publication preserves earlier checkpoints and never exposes partial JSON.
			await fs.link(temporary, destination)
			await fs.unlink(temporary)
		},
	}
}
