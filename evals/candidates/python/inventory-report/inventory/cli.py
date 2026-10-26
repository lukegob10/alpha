"""Read a CSV file and write the selected inventory report to standard output."""

import argparse
import json

from .records import read_records
from .report import build_report


def main(argv=None):
    parser = argparse.ArgumentParser(description="Summarize inventory quantities by SKU")
    parser.add_argument("input")
    parser.add_argument("--status", default="ready")
    options = parser.parse_args(argv)
    with open(options.input, encoding="utf-8", newline="") as stream:
        records = read_records(stream)
    print(json.dumps(build_report(records)))


if __name__ == "__main__":
    main()
