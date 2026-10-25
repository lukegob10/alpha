The inventory report CLI ignores the requested status and combines pending records into ready totals. Repair the
aggregation and CLI integration. CSV records have sku, status and a nonnegative integer quantity. By default report
ready records; --status selects another status. Sum quantities by SKU, order output rows by SKU and emit a JSON array
of {"sku": ..., "quantity": ...}. Empty input produces []. Preserve the existing CSV validation and entry point.
Do not change tests. Run python -B -m unittest discover -s test -v after the final edit.
