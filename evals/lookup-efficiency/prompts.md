# Frozen lookup prompt set

These prompts are frozen for the lookup-efficiency measurement. Do not tune them against a candidate. The same ids live in `cases.json`.

## symbol-definition

Where is the function computeReorderPoint defined? Cite the file path. Do not change files.

Workspace: `workspaces/catalog`. Expected answer key: `src/catalog.js`.

## output-path-writer

Which file writes the named output path events.ndjson? Cite the writer. Do not change files.

Workspace: `workspaces/recorder`. Expected answer key: `src/eventRecorder.js`. Generic recorder, not a product log path.

## missing-symbol

Does this repository contain a function named computeBackorderWindow? Answer yes or no. Do not change files.

Workspace: `workspaces/catalog`. Expected answer key: `absent`.

## config-default

What does the README-stated maxBatchSize config key default to? Cite the declaration. Do not change files.

Workspace: `workspaces/catalog`. Expected answer key: `maxBatchSize=50`.
