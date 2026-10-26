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

The active selection is problem-solving-v1@3, bound to frontier-v1@6. The six revised bank tasks have explicit v2
identities; the new outbox fixture requires changes in both source modules. The active T1 default is
`evals/subsets/frontier-t1-v6.yaml`. The original T1 file and prior task reports retain their historical identities.
Calibration readers prefer `<task-id>@<version>.keyless.json` and accept matching legacy reports; a revised task never
reuses another version's report or model admission. Keyless calibration does not establish model quality.
