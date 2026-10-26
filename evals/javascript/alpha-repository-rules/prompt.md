Nested repository instructions are merged in reverse order and protected-file rules are lost. Resolve instructions from root to leaf, with the nearest rule winning per key except protected paths, which accumulate as a de-duplicated union in first-seen order.

Do not edit tests. Preserve the exported API and run the declared validation command after the final edit.
