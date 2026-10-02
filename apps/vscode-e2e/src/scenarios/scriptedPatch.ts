function patchLines(content: string): string[] {
	return content.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n")
}

export function updateFilePatch(file: string, before: string, after: string): string {
	return [
		"*** Begin Patch",
		`*** Update File: ${file}`,
		"@@",
		...patchLines(before).map((line) => `-${line}`),
		...patchLines(after).map((line) => `+${line}`),
		"*** End Patch",
	].join("\n")
}

export function addFilePatch(file: string, content: string): string {
	return [
		"*** Begin Patch",
		`*** Add File: ${file}`,
		...patchLines(content).map((line) => `+${line}`),
		"*** End Patch",
	].join("\n")
}
