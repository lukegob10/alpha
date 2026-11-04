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

The active selection is problem-solving-v1@4, bound to frontier-v1@7. Revised bank tasks have explicit v2
identities; the plugin verifier wraps unexpected solution exceptions in an owned assertion, while its initial source
remains broken. The plugin v2 identity requires fresh calibration; its v1 report remains historical evidence.
The outbox fixture requires changes in both source modules. The active T1 default is
`evals/subsets/frontier-t1-v7.yaml`. Prior selections, fixtures, manifests, and task reports retain their historical identities.
Calibration readers prefer `<task-id>@<version>.keyless.json` and accept matching legacy reports; a revised task never
reuses another version's report or model admission. Keyless calibration does not establish model quality.
