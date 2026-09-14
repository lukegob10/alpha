import { resolveDestination } from "./resolveDestination"
import { writeArchive, type ArchiveEntry, type ArchiveIO } from "./writeArchive"

export interface ExportTask {
	title: string
	entries: ArchiveEntry[]
}

export interface ExportUI {
	chooseFolder(): Promise<string | undefined>
	showMessage(message: string): void
}

/** Fictional command; no real filesystem adapter is supplied. */
export async function exportTask(task: ExportTask, ui: ExportUI, io: ArchiveIO): Promise<void> {
	const exportRoot = await ui.chooseFolder()
	if (!exportRoot) return
	const destination = resolveDestination(exportRoot, task.title)
	await writeArchive(destination, task.entries, io)
	ui.showMessage(`Exported task to ${destination}`)
}
