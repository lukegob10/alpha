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

export interface ShellCommandToken {
	value: string
	/** Expansions/globs cannot be compared with a literal configured argument. */
	dynamic: boolean
	redirection?: boolean
}

export interface ShellCommandTokenAnalysis {
	commands: Array<{ source: string; tokens: ShellCommandToken[] }>
	malformed: boolean
	unsupportedSyntax: boolean
	/** Supported quote notation whose execution differs between Windows shells. */
	ambiguousSyntax: boolean
	hasChainOperators: boolean
}

export type ShellCommandPlatform = "win32" | "posix"

function tokenizeShellCommandDetails(
	source: string,
	splitRedirections = false,
	platform: ShellCommandPlatform = process.platform === "win32" ? "win32" : "posix",
): ShellCommandTokenAnalysis {
	const analysis: ShellCommandTokenAnalysis = {
		commands: [],
		malformed: source.includes("\0"),
		unsupportedSyntax: false,
		ambiguousSyntax: false,
		hasChainOperators: false,
	}
	let tokens: ShellCommandToken[] = []
	let current = ""
	let tokenStarted = false
	let dynamic = false
	let quote: "single" | "double" | null = null
	let commandStart = 0
	let tokenStart = 0
	let requiresCommand = false
	let invocationOperator = false

	const pushToken = () => {
		if (tokenStarted) tokens.push({ value: current, dynamic })
		current = ""
		tokenStarted = false
		dynamic = false
	}
	const pushCommand = (end: number): boolean => {
		pushToken()
		const hasTokens = tokens.length > 0
		if (hasTokens) {
			const first = platform === "win32" ? tokens[0].value.toLowerCase() : tokens[0].value
			if (
				[
					"if",
					"then",
					"else",
					"elif",
					"fi",
					"for",
					"while",
					"until",
					"do",
					"done",
					"case",
					"esac",
					"select",
					"function",
					"!",
					"time",
					"coproc",
				].includes(first)
			) {
				analysis.unsupportedSyntax = true
			}
			for (let index = 0; index < tokens.length; index++) {
				if (
					tokens[index].redirection &&
					!/[<>]&[\d-]+$/.test(tokens[index].value) &&
					(!tokens[index + 1] || tokens[index + 1].redirection)
				) {
					analysis.malformed = true
				}
			}
			analysis.commands.push({ source: source.slice(commandStart, end).trim(), tokens })
			requiresCommand = false
			invocationOperator = false
		}
		tokens = []
		commandStart = end
		return hasTokens
	}

	for (let index = 0; index < source.length; index++) {
		const character = source[index]
		const nextCharacter = source[index + 1]

		if (
			platform === "win32" &&
			((character === "%" && /^(?:%[^%\r\n]+%|%[0-9*]|%~[A-Za-z$0-9:]+)/.test(source.slice(index))) ||
				(character === "!" && /^![^!\r\n]+!/.test(source.slice(index))))
		) {
			// cmd.exe expands variables even inside single quotes; a finite policy cannot assume PowerShell literals.
			dynamic = true
			analysis.ambiguousSyntax = true
		}
		if (quote === "single") {
			if (platform === "win32" && /[&|<>]/.test(character)) analysis.ambiguousSyntax = true
			if (platform === "win32" && character === "'" && nextCharacter === "'") {
				// PowerShell and POSIX shells disagree on doubled single quotes; a finite grant cannot assume a dialect.
				analysis.ambiguousSyntax = true
				current += "'"
				index++
			} else if (character === "'") quote = null
			else current += character
			continue
		}
		if (character === "\\" && nextCharacter !== undefined) {
			if (/[\r\n]/.test(nextCharacter)) {
				if (platform === "posix" && nextCharacter === "\n") {
					// POSIX removes the pair before argv parsing, including inside double quotes.
					index++
					continue
				}
				analysis.unsupportedSyntax = true
			}
			// Windows separators and UNC prefixes are executable identity, not escapes.
			const canEscape =
				quote === "double"
					? /["$`]/.test(nextCharacter) || (platform !== "win32" && nextCharacter === "\\")
					: platform === "win32"
						? /[ \t'"$`]/.test(nextCharacter)
						: true
			if (canEscape) {
				if (platform === "win32") analysis.ambiguousSyntax = true
				if (!tokenStarted) tokenStart = index
				current += nextCharacter
				tokenStarted = true
				index++
				continue
			}
		}
		if (character === "`" && findBacktickEnd(source, index) !== undefined) {
			if (!tokenStarted) tokenStart = index
			const end = findBacktickEnd(source, index)!
			current += source.slice(index, end + 1)
			tokenStarted = true
			dynamic = true
			index = end
			continue
		}
		if (character === "'" && quote === null) {
			if (!tokenStarted) tokenStart = index
			quote = "single"
			tokenStarted = true
			continue
		}
		if (character === '"') {
			if (!tokenStarted) tokenStart = index
			quote = quote === "double" ? null : "double"
			tokenStarted = true
			continue
		}
		if (
			(character === "$" && nextCharacter === "(") ||
			(quote === null && (character === "<" || character === ">") && nextCharacter === "(")
		) {
			if (!tokenStarted) tokenStart = index
			const end = findParenthesizedSubstitutionEnd(source, index)
			analysis.malformed ||= end === undefined
			current += source.slice(index, end === undefined ? source.length : end + 1)
			tokenStarted = true
			dynamic = true
			index = end ?? source.length
			continue
		}
		if (character === "$" && (nextCharacter === "{" || nextCharacter === "[")) {
			if (!tokenStarted) tokenStart = index
			const closing = nextCharacter === "{" ? "}" : "]"
			let depth = 1
			let end = index + 2
			for (; end < source.length && depth > 0; end++) {
				if (source[end] === nextCharacter) depth++
				if (source[end] === closing) depth--
			}
			analysis.malformed ||= depth !== 0
			current += source.slice(index, end)
			tokenStarted = true
			dynamic = true
			index = end - 1
			continue
		}
		if (quote === null) {
			if (character === "#" && !tokenStarted) {
				// PowerShell comments and cmd.exe arguments disagree; keep finite approval conservative.
				if (platform === "win32") analysis.unsupportedSyntax = true
				pushCommand(index)
				while (index + 1 < source.length && !/[\r\n]/.test(source[index + 1])) index++
				commandStart = index + 1
				continue
			}
			if (splitRedirections && (character === ">" || character === "<")) {
				// Keep descriptor duplication inert (2>&1) and expose file redirections, even without spaces.
				if (/^(?:\d+|\*)$/.test(source.slice(tokenStart, index))) {
					current = ""
					tokenStarted = false
				}
				pushToken()
				let operator = character
				if (nextCharacter === character || nextCharacter === "|") operator += source[++index]
				if (source[index + 1] === character) {
					operator += source[++index]
					analysis.unsupportedSyntax = true
				}
				if (operator === "<<") analysis.unsupportedSyntax = true
				if (source[index + 1] === "&") {
					operator += source[++index]
					while (/[\d-]/.test(source[index + 1] ?? "")) operator += source[++index]
				}
				tokens.push({ value: operator, dynamic: false, redirection: true })
				continue
			}
			const doubleSeparator =
				(character === "&" && nextCharacter === "&") || (character === "|" && nextCharacter === "|")
			if (doubleSeparator) {
				analysis.hasChainOperators = true
				if (!pushCommand(index)) analysis.malformed = true
				requiresCommand = true
				index++
				commandStart = index + 1
				continue
			}
			if ([";", "|", "&", "\n", "\r"].includes(character)) {
				// PowerShell's call operator introduces one executable; '&' after a command is a separator.
				if (
					character === "&" &&
					platform === "win32" &&
					!tokenStarted &&
					!tokens.length &&
					!invocationOperator &&
					/^(?:\s+\S|['"])/.test(source.slice(index + 1))
				) {
					invocationOperator = true
					requiresCommand = true
					continue
				}
				const newline = character === "\n" || character === "\r"
				analysis.hasChainOperators ||= !newline || tokens.length > 0 || tokenStarted
				const hasTokens = pushCommand(index)
				if (!newline && !hasTokens) analysis.malformed = true
				if (character === "|") requiresCommand = true
				commandStart = index + 1
				if (character === "|" && nextCharacter === "&") {
					index++
					commandStart++
				}
				continue
			}
			if (/\s/.test(character)) {
				pushToken()
				continue
			}
			if (/[(){}]/.test(character)) analysis.unsupportedSyntax = true
			if (/[*?\[]/.test(character)) dynamic = true
			if (platform === "win32" && character === "^") {
				// cmd.exe may remove caret escapes; without a shell dialect, literal argv cannot be guaranteed.
				analysis.unsupportedSyntax = true
				dynamic = true
			}
		}

		if (!tokenStarted) tokenStart = index
		if (character === "$") {
			dynamic = true
		}
		if (character === "`") {
			if (platform !== "win32") analysis.malformed = true
			dynamic = true
		}
		if (character === "\\" && nextCharacter === undefined && platform !== "win32") analysis.malformed = true
		current += character
		tokenStarted = true
	}

	pushCommand(source.length)
	analysis.malformed ||= quote !== null || requiresCommand || invocationOperator
	return analysis
}

/** Tokenize shell command chains while retaining quoted paths. */
export function tokenizeShellCommands(source: string): string[][] {
	return tokenizeShellCommandDetails(source).commands.map(({ tokens }) => tokens.map(({ value }) => value))
}

/** Distinguish file redirection operators from quoted text for command path preflight. */
export function tokenizeShellCommandPaths(source: string): Array<Array<{ value: string; redirection?: boolean }>> {
	return tokenizeShellCommandDetails(source, true).commands.map(({ tokens }) => tokens)
}

/** Approval matching needs both parsed argv and failure evidence; never reconstruct quoted tokens with join(' '). */
export function analyzeShellCommandTokens(source: string, platform?: ShellCommandPlatform): ShellCommandTokenAnalysis {
	return tokenizeShellCommandDetails(source, true, platform)
}

/** Redirection effects stay in path preflight; command policy compares only executable and argument tokens. */
export function shellCommandArgumentTokens(tokens: ShellCommandToken[]): ShellCommandToken[] {
	const args: ShellCommandToken[] = []
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]
		if (!token.redirection) args.push(token)
		else if (!/[<>]&[\d-]+$/.test(token.value)) index++
	}
	return args
}

export function containsDynamicExecutable(source: string, platform?: ShellCommandPlatform): boolean {
	const extracted = extractCommandSubstitutions(source)
	return [source, ...extracted.commands]
		.flatMap((command) => tokenizeShellCommandDetails(command, true, platform).commands)
		.some(({ tokens: rawTokens }) => {
			const tokens = shellCommandArgumentTokens(rawTokens)
			let commandIndex = 0
			while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[commandIndex]?.value ?? "")) commandIndex++
			const executable = tokens[commandIndex]
			return executable?.dynamic === true
		})
}
