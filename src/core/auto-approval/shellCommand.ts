export interface ShellCommandAnalysis {
	commands: string[]
	malformedSubstitution: boolean
}

function findParenthesizedSubstitutionEnd(source: string, startIndex: number): number | undefined {
	let depth = 1
	let quote: "single" | "double" | null = null

	for (let index = startIndex + 2; index < source.length; index++) {
		const character = source[index]

		if (character === "\\" && quote !== "single") {
			index++
			continue
		}
		if (quote === "single") {
			if (character === "'") quote = null
			continue
		}
		if (quote === "double") {
			if (character === '"') quote = null
			continue
		}
		if (character === "'") {
			quote = "single"
			continue
		}
		if (character === '"') {
			quote = "double"
			continue
		}
		if (character === "(") depth++
		if (character === ")" && --depth === 0) return index
	}

	return undefined
}

function findBacktickEnd(source: string, startIndex: number): number | undefined {
	for (let index = startIndex + 1; index < source.length; index++) {
		if (source[index] === "\\") {
			index++
			continue
		}
		if (source[index] === "`") return index
	}
	return undefined
}

function extractCommandSubstitutions(source: string): { commands: string[]; malformed: boolean } {
	const commands: string[] = []
	let malformed = false
	let quote: "single" | "double" | null = null

	for (let index = 0; index < source.length; index++) {
		const character = source[index]
		const nextCharacter = source[index + 1]

		if (character === "\\" && quote !== "single") {
			index++
			continue
		}
		if (quote === "single") {
			if (character === "'") quote = null
			continue
		}
		if (character === "'" && quote === null) {
			quote = "single"
			continue
		}
		if (character === '"') {
			quote = quote === "double" ? null : "double"
			continue
		}

		const isCommandSubstitution = character === "$" && nextCharacter === "(" && source[index + 2] !== "("
		const isProcessSubstitution =
			quote === null && (character === "<" || character === ">") && nextCharacter === "("
		if (isCommandSubstitution || isProcessSubstitution) {
			const endIndex = findParenthesizedSubstitutionEnd(source, index)
			if (endIndex === undefined) {
				malformed = true
				const partialCommand = source.slice(index + 2).trim()
				if (partialCommand) {
					commands.push(partialCommand)
					const nested = extractCommandSubstitutions(partialCommand)
					commands.push(...nested.commands)
					malformed ||= nested.malformed
				}
				continue
			}

			const innerCommand = source.slice(index + 2, endIndex).trim()
			if (innerCommand) {
				commands.push(innerCommand)
				const nested = extractCommandSubstitutions(innerCommand)
				commands.push(...nested.commands)
				malformed ||= nested.malformed
			}
			index = endIndex
			continue
		}

		if (character === "`") {
			const endIndex = findBacktickEnd(source, index)
			if (endIndex === undefined) continue

			const innerCommand = source.slice(index + 1, endIndex).trim()
			if (innerCommand) {
				commands.push(innerCommand)
				const nested = extractCommandSubstitutions(innerCommand)
				commands.push(...nested.commands)
				malformed ||= nested.malformed
			}
			index = endIndex
		}
	}

	return { commands, malformed }
}

/**
 * Extract executable shell substitutions that the established top-level parser
 * intentionally preserves inside quoted or arithmetic expressions.
 */
export function analyzeShellCommands(source: string): ShellCommandAnalysis {
	const extracted = extractCommandSubstitutions(source)
	return {
		commands: extracted.commands,
		malformedSubstitution: extracted.malformed,
	}
}

interface ShellTokenDetail {
	value: string
	startsWithDynamicExpansion: boolean
}

function tokenizeShellCommandDetails(source: string): ShellTokenDetail[][] {
	const commands: ShellTokenDetail[][] = []
	let tokens: ShellTokenDetail[] = []
	let current = ""
	let tokenStarted = false
	let startsWithDynamicExpansion = false
	let quote: "single" | "double" | null = null
	let substitutionDepth = 0
	let inBackticks = false

	const pushToken = () => {
		if (tokenStarted) tokens.push({ value: current, startsWithDynamicExpansion })
		current = ""
		tokenStarted = false
		startsWithDynamicExpansion = false
	}
	const pushCommand = () => {
		pushToken()
		if (tokens.length > 0) commands.push(tokens)
		tokens = []
	}

	for (let index = 0; index < source.length; index++) {
		const character = source[index]
		const nextCharacter = source[index + 1]

		if (inBackticks) {
			current += character
			tokenStarted = true
			if (character === "`") inBackticks = false
			continue
		}
		if (quote === "single") {
			if (character === "'") quote = null
			else current += character
			continue
		}
		if (character === "\\" && nextCharacter !== undefined) {
			const canEscape = quote === "double" ? /["\\$`]/.test(nextCharacter) : /[\s'"\\$`]/.test(nextCharacter)
			if (canEscape) {
				current += nextCharacter
				tokenStarted = true
				index++
				continue
			}
		}
		if (character === "`" && findBacktickEnd(source, index) !== undefined) {
			if (current.length === 0) startsWithDynamicExpansion = true
			current += character
			tokenStarted = true
			inBackticks = true
			continue
		}
		if (character === "'" && quote === null) {
			quote = "single"
			tokenStarted = true
			continue
		}
		if (character === '"') {
			quote = quote === "double" ? null : "double"
			tokenStarted = true
			continue
		}
		if (character === "$" && nextCharacter === "(") {
			if (current.length === 0) startsWithDynamicExpansion = true
			current += "$("
			tokenStarted = true
			substitutionDepth++
			index++
			continue
		}
		if (quote === null && (character === "<" || character === ">") && nextCharacter === "(") {
			current += `${character}(`
			tokenStarted = true
			substitutionDepth++
			index++
			continue
		}
		if (substitutionDepth > 0) {
			if (character === "(") substitutionDepth++
			if (character === ")") substitutionDepth--
			current += character
			tokenStarted = true
			continue
		}
		if (quote === null) {
			const doubleSeparator =
				(character === "&" && nextCharacter === "&") || (character === "|" && nextCharacter === "|")
			if (doubleSeparator) {
				pushCommand()
				index++
				continue
			}
			if ([";", "|", "&", "\n", "\r"].includes(character)) {
				pushCommand()
				continue
			}
			if (/\s/.test(character)) {
				pushToken()
				continue
			}
		}

		if (current.length === 0 && character === "$" && quote !== "single") {
			startsWithDynamicExpansion = true
		}
		current += character
		tokenStarted = true
	}

	pushCommand()
	return commands
}

/** Tokenize shell command chains while retaining quoted paths. */
export function tokenizeShellCommands(source: string): string[][] {
	return tokenizeShellCommandDetails(source).map((tokens) => tokens.map(({ value }) => value))
}

export function containsDynamicExecutable(source: string): boolean {
	const extracted = extractCommandSubstitutions(source)
	return [source, ...extracted.commands].flatMap(tokenizeShellCommandDetails).some((tokens) => {
		let commandIndex = 0
		while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[commandIndex]?.value ?? "")) commandIndex++
		const executable = tokens[commandIndex]
		return executable?.startsWithDynamicExpansion === true && /^(?:\$|`)/.test(executable.value)
	})
}
