# Evaluation inputs and evidence

Alpha's evaluations exercise the real VS Code extension. The directories have separate responsibilities:

| Path                                             | Responsibility                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `evals/`                                         | Versioned suites, prompts, workspaces, checksum manifests, and measurement contracts |
| [`packages/evals/`](../packages/evals/README.md) | Optional evaluator, grading, persistence, and benchmark commands                     |
| [`scripts/evals/`](../scripts/evals/)            | Paired-run orchestration and report generation used by the retained suites           |
| [`apps/vscode-e2e/`](../apps/vscode-e2e/)        | Exact VS Code 1.125.0 host tests and extension evaluation runner                     |
| [`artifacts/`](../artifacts/)                    | Ignored local host, UI, certification, and harness evidence                          |

## Retained suites

The [Frontier suite](frontier-v1.yaml), [smoke suite](smoke-v1.yaml), and
[problem-solving set](problem-solving/README.md) remain evaluator inputs. Frontier is a benchmark suite, not an
extension feature. Its loader, fixture checks, calibration, and governed model runs live in `packages/evals/`.

The [proportional-scope acceptance contract](proportional-scope/acceptance.md) and
[lookup measurement contract](lookup-efficiency/measurement.md) document their separate workloads. Historical NOR-36
reports are preserved byte-for-byte in [reports/nor36/](reports/nor36/).

## Historical campaigns

[archive/frontier-campaign/](archive/frontier-campaign/) preserves the former `.frontier-campaign/` configurations,
authoring reports, and milestone results. These are historical snapshots. Some configurations name retired packages
or missing design documents; they are not supported commands for the current checkout. Saved evidence, configuration
digests, timestamps, and relative attempt references retain their original values.

New campaign output defaults to `packages/evals/artifacts/campaigns/`. Explicitly configured legacy output roots remain
supported. `benchmark:author-check` defaults to `packages/evals/artifacts/authoring/`; `--output` still selects another
directory. Generated reports are ignored. Preserve run evidence while it is needed to investigate or compare results.

## Validation

```sh
pnpm test:evals:offline
pnpm --filter @alpha-code/evals benchmark:validate
pnpm --filter @alpha-code/evals benchmark:fixture-check
```

See the [testing workflow](../docs/testing-harness.md) for host gates and the
[evaluator guide](../packages/evals/README.md) for service and live-provider prerequisites. Keep fixture bytes and
checksum manifests stable; change individual exercises deliberately through the evaluator's authoring commands.

The retained developer probes `scripts/benchmarks/scoped-read.ts`, `scripts/measure-html-documents.ts`, and
`scripts/benchmarks/nor36-request-preflight.spec.ts` exercise extension boundaries. The two TypeScript probes run with
`pnpm exec tsx <script-path>` after `pnpm bundle`; the NOR-36 contract documents its dedicated Vitest command.
