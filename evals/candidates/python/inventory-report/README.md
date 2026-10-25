# Inventory report CLI

An original synthetic repository pilot using Python's standard library. `inventory/records.py` owns CSV validation,
`inventory/report.py` owns aggregation, and `inventory/cli.py` adapts CLI arguments to that API. Run the CLI with
`python -B -m inventory.cli records.csv --status ready` from this directory. Tests exercise both library behavior and
the actual entry point in a subprocess. The fixture deliberately starts broken.
