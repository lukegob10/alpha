# File search modes and partial batches

`search_files` uses the shared ripgrep service for both single queries and bounded query batches, across all providers.
Use top-level `path`/`regex` for one query, or `queries` for 1–8 independent queries. Both forms accept nullable
`file_pattern`, `output_mode`, and `literal`. The native schema, parser, shared argument types, and captured
`TaskToolSurface` use the same contract.

## Output modes and literal text

| `output_mode`                   | Result                                                                    |
| ------------------------------- | ------------------------------------------------------------------------- |
| Omitted, `null`, or `"content"` | Existing numbered snippets with one surrounding context line on each side |
| `"files"`                       | Unique relative file paths, one per line, without source snippets         |
| `"count"`                       | `relative/path: count`, one per matching file, without source snippets    |

Counts represent non-overlapping occurrences, not matching lines or snippet groups: two matches on one line count as
two. A multiline match counts once. Truncated counts are lower bounds, and truncated file lists may omit matching files.
Complete empty results say `Found 0 results.`, `Found 0 files.`, or `Found 0 matches.`, respectively.

`literal: true` passes `--fixed-strings` to ripgrep, so characters such as `(` and `.` are searched as text.
Omitted, `false`, or `null` keeps Rust regex behavior, including newline recovery below.

```json
{
	"queries": [
		{ "path": "src", "regex": "foo(.bar", "literal": true, "output_mode": "files" },
		{ "path": "tests", "regex": "TODO|FIXME", "output_mode": "count" }
	]
}
```

Every mode uses the same bounded JSON capture and ignore filtering. Files mode stops after the first matching line in
each file with `--max-count 1`; files and count omit context capture. Ripgrep's `.gitignore` behavior is unchanged when
no glob is provided, and `.alphaignore` is applied before formatting in every mode.

## Independent batch outcomes

Each query completes with `success` and its selected output, or `error` and the actual ripgrep diagnostic. Results stay
in request order. A compilation or path error in one query does not discard the others. Batch text labels each query's
status, mode, and literal setting; the scheduler receives one terminal result, successful if any query succeeded
(including a valid search with no matches), and an error if all queries failed.

Approval messages retain `content` and add optional `outputMode`, `literal`, and `searchStatus` metadata to `searchFiles`
and `batchSearches` entries. Existing content-only messages remain readable by the unchanged search cards. Workspace
scope flags and approval remain in the existing tool path. Cancellation stops active subprocesses and prevents partial
search successes from being approved or published as a successful call.

## Newline recovery

Searches start in ripgrep's normal line-oriented mode. If compilation fails with the diagnostic that a literal newline
is not allowed, the service retries once with `--multiline`, keeping the same pattern, directory, glob, and cancellation
signal. Other errors propagate without retry. Cancellation prevents or stops the retry.

For example, this native tool call searches across two adjacent source lines:

```json
{ "path": "src", "regex": "alpha\\nbeta", "file_pattern": "*.ts" }
```

Ripgrep recognizes literal newlines and escaped forms such as `\n`, `\x0A`, and `\u{A}`. Using its compilation diagnostic
avoids duplicating Rust regex parsing in JavaScript. Existing successful patterns keep their line-oriented semantics:
`alpha\s+beta` still matches on one line, and `alpha\\nbeta` still searches for a literal backslash followed by `n`.
`--multiline-dotall` is not enabled; explicit regex flags such as `(?s:...)` retain their normal meaning.

## Limits and compatibility

One multiline JSON match can contain many source lines. The service numbers and truncates each source line separately,
preserves interior blank lines and CRLF input, and keeps surrounding context contiguous. `.alphaignore` filtering still
applies before results are returned.

Each subprocess's captured stdout is limited to 1 MiB and 1,500 JSON records. Parsing retains at most 1,500 source lines,
500 source characters per line (plus the truncation notice), and 300 result groups in content mode. Files and count
return at most 300 file entries. The tool's existing 16,000-character limit applies independently to the serialized
approval and model-facing result, including batch metadata and errors. Files/count keep complete entries when that
budget truncates output; snippets retain the previous character truncation. The byte limit is enforced before buffering a complete JSON record.
An incomplete record at that limit is discarded, and partial output is explicitly marked as truncated, including when
no complete match fits.

Omitting the new options preserves single-query snippet formatting and the existing regex behavior. The deliberate
batch change is failure isolation and explicit per-query status. The existing metadata caps and truncation notices
still apply, including a notice if pathological metadata leaves no room for some batch entries.
Multiline matching may require ripgrep itself to map or read a complete file; the stdout limit bounds Alpha's retained
process output, not the child process's search memory.

## Evidence and validation

Verified on 2026-09-15 with ripgrep 15.2.0 (`e89fff89ac`), Node 20.19.2, and pnpm 10.8.1. The installed `rg --help` and upstream
[multiline flag documentation](https://github.com/BurntSushi/ripgrep/blob/15.2.0/crates/core/flags/defs.rs)
describe fixed-string matching, JSON output, newline restrictions, and multiline memory tradeoffs.

The existing `tool-catalog-measurement` fixture was run before and after on its same no-MCP Code-mode snapshot
(27 effective functions). Only the search schema changed between these measurements:

| Effective schema payload | Before |  After |
| ------------------------ | -----: | -----: |
| Serialized JSON bytes    | 41,670 | 41,268 |
| Local token estimate     | 13,580 | 13,464 |

The estimate uses repository `countTokens` with `tiktoken/o200k_base` and its 1.5 fudge factor. It covers serialized JSON,
excludes provider framing, and is not billed usage. This is schema-size evidence only, with no live-model or solve-rate
claim. Shortening the existing description offsets the new option schemas.

```sh
pnpm --dir src test core/tools/__tests__/SearchFilesTool.spec.ts services/ripgrep/__tests__/index.spec.ts services/ripgrep/__tests__/execution.spec.ts
pnpm --dir src test core/task/__tests__/tool-catalog-measurement.spec.ts -t "records no-MCP" --no-silent
pnpm --dir src check-types
pnpm --dir src lint
pnpm --filter @alpha-code/types test
pnpm --filter @alpha-code/types check-types
pnpm --filter @alpha-code/types lint
```

The VS Code 1.122.1 host contract and webview search cards are unchanged; this change does not require the exact-host
smoke gate. Regression coverage includes real ripgrep fixtures, capture limits, cancellation on both attempts,
ignore rules in every mode, native option parsing, and single scheduler receipts for mixed and all-error batches.
