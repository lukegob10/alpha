Repair the invoice integration across src/policy.js and src/invoice.js. Standard customers get no discount and members
get ten percent. An invoice exposes subtotal, discount (the money amount), and total, calculated from item price times
quantity. Empty invoices have zero totals. Preserve the API and input records; do not change tests. Run
node --test test/behavior.test.js after the final edit.
