/** JSON values embedded in trusted probe code must also be safe in a script context. */
export function javascriptLiteral(value: unknown): string {
	const serialized = JSON.stringify(value)
	if (serialized === undefined) throw new TypeError("Browser probe values must be JSON serializable")
	return serialized.replace(
		/[<>&'\u2028\u2029]/g,
		(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	)
}
