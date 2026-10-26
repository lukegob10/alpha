"""Parse inventory CSV without silently accepting invalid quantities."""

import csv


def read_records(stream):
    reader = csv.DictReader(stream)
    if reader.fieldnames != ["sku", "status", "quantity"]:
        raise ValueError("expected sku,status,quantity columns")
    records = []
    for row in reader:
        quantity = int(row["quantity"])
        if quantity < 0:
            raise ValueError("quantity must be nonnegative")
        records.append({"sku": row["sku"], "status": row["status"], "quantity": quantity})
    return records
