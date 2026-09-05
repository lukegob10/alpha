# Rejected baseline: overlapping orchestrator lint

The [raw partial report](nor35-contaminated-baseline-20260905055146.json) preserves the run granted as
`nor31-corrected-baseline-20260905055146` at frozen commit `e04f34d80f69b98baed002747121151ac87f2846`.
It is invalid for performance acceptance because an orchestrator cherry-pick continuation unexpectedly started a
21.7-second repository lint hook during the measurement window. This is measurement contamination, not a production
failure. The orchestrator explicitly requested cancellation and a separately granted restart.

The runner had flushed three complete cases (1 child with 1 and 2 writers; 5000 children with 1 writer), totaling
240 measured cycles, 480 transactions, and 480 writes, with no reported command or transaction failures in those cases.
The 5000-child, two-writer case had started but did not flush a complete case. No samples from this run may be used in
the acceptance comparison. The raw report was renamed without modifying its contents.

Ctrl-C was sent to owned exec session 61797; it exited with code 1. A subsequent Windows process inventory confirmed
that no benchmark runner or worker processes remained. No source was changed during measurement, no failed samples
were discarded to obtain acceptance, and no automatic restart occurred. Any subsequent run requires a fresh explicit
start grant and keeps this evidence intact.
