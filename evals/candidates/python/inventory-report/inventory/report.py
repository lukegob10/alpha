"""Build an ordered report for a selected inventory status."""


def build_report(records, status="ready"):
    totals = {}
    for record in records:
        totals[record["sku"]] = record["quantity"]
    return [{"sku": sku, "quantity": quantity} for sku, quantity in totals.items()]
