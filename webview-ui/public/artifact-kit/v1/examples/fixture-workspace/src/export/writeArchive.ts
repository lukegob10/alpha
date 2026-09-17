/** Deliberately incomplete writer contract used only for source review. */
export interface ArchiveEntry {
	name: string
	content: Uint8Array
}

export interface ArchiveSink {
	writeEntry(entry: ArchiveEntry): Promise<void>
	close(): Promise<void>
}

export interface ArchiveIO {
	// Opening an existing destination truncates it.
	open(destination: string): Promise<ArchiveSink>
}

/** BUG: interruption leaves partial output under the final filename. */
export async function writeArchive(destination: string, entries: ArchiveEntry[], io: ArchiveIO): Promise<void> {
	const sink = await io.open(destination)
	for (const entry of entries) {
		await sink.writeEntry(entry)
	}
	await sink.close()
}
