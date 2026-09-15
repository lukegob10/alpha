# File search and multiline patterns

`search_files` uses the shared ripgrep service for both single queries and bounded query batches, across all providers.
Its input and result message shapes are unchanged.

## Newline recovery

Searches start in ripgrep's normal line-oriented mode. If compilation fails with the diagnostic that a literal newline
is not allowed, the service retries once with `--multiline`, keeping the same pattern, directory, glob, and cancellation
signal. Other errors propagate without retry. Cancellation prevents or stops the retry.

For example, this native tool call now searches across two adjacent source lines:

```json
{ "path": "src", "regex": "alpha\\nbeta", "file_pattern": "*.ts" }
```

Ripgrep recognizes literal newlines and escaped forms such as `\n`, `\x0A`, and `\u{A}`. Using its compilation diagnostic
avoids duplicating Rust regex parsing in JavaScript. Existing successful patterns keep their line-oriented semantics:
`alpha\s+beta` still matches on one line, and `alpha\\nbeta` still searches for a literal backslash followed by `n`.
`--multiline-dotall` is not enabled; explicit regex flags such as `(?s:...)` retain their normal meaning.

## Output and compatibility

One multiline JSON match can contain many source lines. The service numbers and truncates each source line separately,
preserves interior blank lines and CRLF input, and keeps surrounding context contiguous. `.alphaignore` filtering still
applies before results are returned.

Each subprocess's captured stdout is limited to 1 MiB and 1,500 JSON records. Parsing retains at most 1,500 source lines,
500 source characters per line (plus the truncation notice), and 300 result groups. The tool's existing 16,000-character
approval/result limit also continues to apply. The byte limit is enforced before buffering a complete JSON record.
An incomplete record at that limit is discarded, and partial output is explicitly marked as truncated, including when
no complete match fits.

Previously, explicit newline matches failed. They now succeed when supported by ripgrep, or report the retry's actual
error. Very large searches can return less text because the service now also bounds bytes and physical source lines.
Multiline matching may require ripgrep itself to map or read a complete file; the stdout limit bounds Alpha's retained
process output, not the child process's search memory.

## Evidence and validation

Verified on 2026-09-14 with ripgrep 15.2.0 (`e89fff89ac`), Node 20.19.2, and pnpm 10.8.1. The upstream
[multiline flag documentation](https://github.com/BurntSushi/ripgrep/blob/15.2.0/crates/core/flags/defs.rs)
describes the newline restriction, multiline semantics, and memory tradeoff.

```sh
pnpm --dir src test services/ripgrep/__tests__/index.spec.ts services/ripgrep/__tests__/execution.spec.ts core/tools/__tests__/SearchFilesTool.spec.ts
pnpm --dir src check-types
pnpm --dir src lint
pnpm --filter @alpha-code/vscode-e2e test:smoke:1221
```
