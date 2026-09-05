/** The default complete-response budget for read_command_output (40 KiB). */
export const READ_COMMAND_OUTPUT_DEFAULT_LIMIT_BYTES = 40 * 1024

/** The smallest complete-response budget that leaves room for truthful metadata. */
export const READ_COMMAND_OUTPUT_MIN_LIMIT_BYTES = 512

/** Hard cap for one read_command_output response. */
export const READ_COMMAND_OUTPUT_MAX_LIMIT_BYTES = 4 * 1024 * 1024

/** Search patterns are deliberately short because JavaScript regexes have no timeout. */
export const READ_COMMAND_OUTPUT_MAX_SEARCH_LENGTH = 256

/** Search does not retain an unterminated line beyond this bound. */
export const READ_COMMAND_OUTPUT_MAX_SEARCH_LINE_BYTES = 64 * 1024

/** Artifact identifiers are generated ASCII names; keep schema and runtime validation identical. */
export const READ_COMMAND_OUTPUT_ARTIFACT_ID_PATTERN = "^cmd-[0-9]+\\.txt$"

/** Maximum artifact identifier length accepted by the native schema and runtime. */
export const READ_COMMAND_OUTPUT_MAX_ARTIFACT_ID_LENGTH = 64

/** Keep the displayed pattern and generated metadata bounded independently of the input pattern. */
export const READ_COMMAND_OUTPUT_MAX_DISPLAY_PATTERN_BYTES = 32

/** JSON-schema-compatible bound for JavaScript's safe integer range. */
export const READ_COMMAND_OUTPUT_MAX_OFFSET = Number.MAX_SAFE_INTEGER
