Orders and outbox messages are committed separately, so a crash can persist one without the other. Stage both writes in the provided transaction and preserve the event key.

Do not edit tests. Preserve the exported API and run the declared validation command after the final edit.
