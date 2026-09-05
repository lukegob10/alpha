/** Normalize supported runner semantics without granting permission or losing the original command identity. */
export function pythonPytestArguments(tokens: readonly string[]): readonly string[] | undefined {
	const executable = tokens[0]?.toLowerCase().replace(/\.exe$/, "")
	if (executable === "pytest") return tokens.slice(1)
	let index = 1
	if (executable === "py") {
		if (/^-\d+(?:\.\d+)?(?:-32|-64)?$/.test(tokens[index] ?? "")) index++
	} else if (!/^python(?:\d+(?:\.\d+)*)?$/.test(executable ?? "")) {
		return undefined
	}
	return tokens[index] === "-m" && tokens[index + 1] === "pytest" ? tokens.slice(index + 2) : undefined
}
