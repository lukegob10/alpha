import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from inventory.records import read_records
from inventory.report import build_report


class InventoryReportTests(unittest.TestCase):
    def test_filters_sums_and_sorts_without_mutating_records(self):
        records = [
            {"sku": "B", "status": "ready", "quantity": 3},
            {"sku": "A", "status": "pending", "quantity": 100},
            {"sku": "A", "status": "ready", "quantity": 2},
            {"sku": "B", "status": "ready", "quantity": 4},
        ]
        original = [dict(record) for record in records]
        self.assertEqual(build_report(records), [{"sku": "A", "quantity": 2}, {"sku": "B", "quantity": 7}])
        self.assertEqual(build_report(records, "pending"), [{"sku": "A", "quantity": 100}])
        self.assertEqual(build_report(records, "absent"), [])
        self.assertEqual(build_report([]), [])
        self.assertEqual(records, original)

    def test_preserves_input_validation(self):
        self.assertEqual(read_records(io.StringIO("sku,status,quantity\nA,ready,0\n")), [
            {"sku": "A", "status": "ready", "quantity": 0},
        ])
        for content in ["wrong,columns\n", "sku,status,quantity\nA,ready,-1\n", "sku,status,quantity\nA,ready,bad\n"]:
            with self.assertRaises(ValueError):
                read_records(io.StringIO(content))

    def test_cli_forwards_explicit_status_and_default(self):
        with tempfile.TemporaryDirectory() as directory:
            input_file = Path(directory) / "records.csv"
            input_file.write_text("sku,status,quantity\nB,ready,2\nA,pending,8\nB,ready,3\n", encoding="utf-8")
            for args, expected in [([], [{"sku": "B", "quantity": 5}]), (["--status", "pending"], [{"sku": "A", "quantity": 8}])]:
                result = subprocess.run(
                    [sys.executable, "-B", "-m", "inventory.cli", str(input_file), *args],
                    cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True, check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout), expected)


if __name__ == "__main__":
    unittest.main()
