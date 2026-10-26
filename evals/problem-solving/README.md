# Problem-solving task set

The versioned selection, source revisions, fixture digests, and budgets live in [v1.yaml](v1.yaml).
Core covers offline software and workflow tasks; development includes heavier in-scope work. Science, GPU, hardware,
and credential-dependent or required-network tasks are excluded. Keep holdout tasks out of tuning and preserve their
recorded identities. Scripted controls establish verifier behavior, not live model quality.

Use the [improvement loop](improvement-loop.md) for dedicated-profile setup, task selection, evidence capture,
prompt variants, and paired live comparisons. After configuring its absolute profile and attempt paths:

```sh
pnpm --filter @alpha-code/evals benchmark:problem-solving-live
pnpm --filter @alpha-code/evals benchmark:problem-solving-diagnose --report <run-root>/report.json --output <new-path>/diagnosis.json
```
