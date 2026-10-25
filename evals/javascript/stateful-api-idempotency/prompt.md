A timed-out payment retry creates a second charge because idempotency is checked after the provider call. Reserve the
key before invoking the provider. Overlapping calls with the same key share one provider invocation. Completed retries
return the original result, including undefined. If the provider fails, retries with that key preserve the original
failure and must not silently issue another charge; callers may explicitly use a different key for a new attempt.

Do not edit tests. Preserve the exported API and run the declared validation command after the final edit.
