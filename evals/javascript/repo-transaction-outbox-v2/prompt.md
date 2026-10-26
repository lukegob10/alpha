Orders and outbox events are persisted outside the transaction, and the event builder omits the stable event key. Repair both modules so `createOrder(db, order)` awaits one transaction containing the order and its event. `orderCreatedEvent(order)` must return `{ id: "order:<order.id>", type: "order.created", payload: order }` without changing the caller's object. Await both writes before committing; an event-write failure must roll back the order.

Do not edit tests. Preserve the exported APIs and run the declared validation command after the final edit.
