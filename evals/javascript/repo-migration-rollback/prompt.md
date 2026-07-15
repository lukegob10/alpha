A failed migration leaves earlier steps applied and records the version anyway. Roll back completed steps in reverse order and advance the version only after success.

Do not edit tests. Preserve the exported API and run the declared validation command after the final edit.
