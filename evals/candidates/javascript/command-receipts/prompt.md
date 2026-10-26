Repair commandReceipt's result classification. A numeric exit code of zero is success, a nonzero exit code is error,
and null is pending. Preserve the exact output text and exit code, including negative codes. Do not change tests.
This is a receipt-data repair, not a live subprocess-recovery test. Run node --test test/behavior.test.js after editing.
