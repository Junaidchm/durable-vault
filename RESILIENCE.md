# Distributed Systems Resilience & Post-Mortem Audit (RESILIENCE.md)

This document addresses how the system maintains exactly-once guarantees and financial correctness in two scenarios:
1. A distributed systems scenario where the inventory store is split into a separate service.
2. A post-mortem incident analysis of a double-grant currency bug.

> [!IMPORTANT]
> **Context Disclaimer**: The designs, schemas, and workflows presented in **Part 1** and **Part 2** below are proposed specifications for hypothetical scenarios. They are not implemented in the current monolithic codebase, which relies on a single relational database transaction for atomicity.

---

## PART 1 — Distributed Inventory Service Integration

### 1. The Challenge of Distributed State
In the current monolithic implementation, atomic consistency is guaranteed by database-level transactions: the wallet balance debit, inventory item insertion, and ledger log commit succeed or fail together. 

If the inventory store is moved to a separate **Inventory Service** with its own database, we lose local ACID guarantees.
* **Why local transactions fail**: A local database transaction cannot span physical networks or databases without introducing blocking protocols like Two-Phase Commit (2PC). 2PC is highly vulnerable to network latency, coordinator crashes, and database locking overhead, making it unsuitable for high-throughput game backends.
* **The Partial-Failure Window**: When calling the Inventory Service over an API, several failures can occur:
  1. The API call times out, but the Inventory Service successfully granted the item.
  2. The API call fails, and no item was granted.
  3. The Wallet Service crashes after debiting the player's balance but before sending the grant request.
  4. The Inventory Service processes the request twice due to client-side or network-level retries.

---

### 2. Proposed Solution: Transactional Outbox & Saga Orchestration

To maintain exactly-once guarantees without blocking transactions, we propose a combination of the **Transactional Outbox Pattern** and **Saga Orchestration** with compensating transactions.

```
Wallet Service (DB 1)                                   Inventory Service (DB 2)
  |                                                       |
  |-- [Local Transaction Start]                           |
  |   1. Verify and debit balance                         |
  |   2. Write to Outbox: ITEM_GRANT_REQUESTED            |
  |-- [Local Transaction Commit]                          |
  |                                                       |
  |-- Read Outbox Event & Publish                         |
  |   via Message Broker (RabbitMQ) --------------------->|
  |                                                       |-- [Local Transaction Start]
  |                                                       |   1. Check Idempotency Key
  |                                                       |   2. Insert Inventory Item
  |                                                       |-- [Local Transaction Commit]
  |                                                       |
  |<-- Publish Response: ITEM_GRANTED --------------------|
  |                                                       |
  |-- Mark Outbox Event as COMPLETED                      |
```
#### A. The Transactional Outbox Schema
Under this proposed design, the Wallet Service database would include an `outbox_events` table. The outbox table and the player's wallet balance would be updated in the **same local database transaction**:

```sql
CREATE TABLE "outbox_events" (
  "id" UUID PRIMARY KEY,
  "aggregate_type" VARCHAR(50) NOT NULL,
  "aggregate_id" VARCHAR(255) NOT NULL,
  "event_type" VARCHAR(50) NOT NULL,
  "payload" JSONB NOT NULL,
  "status" VARCHAR(20) DEFAULT 'PENDING', -- PENDING, COMPLETED, FAILED
  "created_at" TIMESTAMP DEFAULT now(),
  "updated_at" TIMESTAMP DEFAULT now()
);
```

#### B. Step-by-Step Execution Workflow (Saga Lifecycle)

1. **Step 1: Local Debit & Event Stage (Wallet Service)**:
   * Start a transaction on the Wallet DB.
   * Lock the wallet row (`SELECT ... FOR UPDATE`), check the balance, and debit the item price.
   * Write an audit ledger entry.
   * Insert a record into the proposed `outbox_events` table with type `ITEM_GRANT_REQUESTED`, containing the `playerId`, `itemId`, price, and a unique `eventId` (which acts as the cross-service idempotency key).
   * Commit the local transaction. **(This ensures the debit and event creation are atomic)**.
2. **Step 2: Message Publishing**:
   * A background worker (using a tailing engine or polling query) would read `PENDING` outbox events and publish them to a message broker (e.g., RabbitMQ or Kafka) with *At-Least-Once* delivery guarantees.
3. **Step 3: Idempotent Event Consumption (Inventory Service)**:
   * The Inventory Service receives the `ITEM_GRANT_REQUESTED` event.
   * Inside a transaction on the Inventory DB, it checks its own `idempotency_keys` table using the `eventId` as the primary key.
   * If the key already exists (duplicate delivery), it skips the grant and publishes a success event `ITEM_GRANTED`.
   * If the key does not exist, it inserts the key, inserts the item into the player's `inventories` table, commits the transaction, and publishes a success event `ITEM_GRANTED`.
4. **Step 4: Completion (Wallet Service)**:
   * The Wallet Service receives `ITEM_GRANTED`. It updates the outbox event status to `COMPLETED` and ceases retries.

#### C. Compensation Workflow (Handling Rejections)
If the Inventory Service cannot grant the item (e.g. inventory limit exceeded, or item restricted):
1. The Inventory Service publishes an event `ITEM_GRANT_FAILED`.
2. The Wallet Service receives the event and initiates a **compensating transaction**:
   * Starts a local transaction on the Wallet DB.
   * Lock the wallet row, credit the player's balance with the refunded amount, and write a ledger log with reason `REVERSE_PURCHASE`.
   * Marks the outbox event status as `FAILED`.

#### D. Recovery After Crashes
* **Wallet Service Crashes**: Upon restart, the proposed outbox processor would scan the `outbox_events` table for `PENDING` records and republish them. Because the Inventory Service is idempotent, redundant events do not cause duplicate item grants.
* **Inventory Service Crashes**: If the Inventory Service crashes mid-execution, its local transaction rolls back. The Wallet Service's proposed outbox processor would continue retrying the message until the Inventory Service recovers and successfully commits the transaction.

---

## PART 2 — Post-Mortem Audit: Double-Granted Currency Incident

Last week, an application bug caused some players to receive double-granted currency. We must audit, reconcile, and prevent this recurrence.

### 1. Detection Strategy (Without Downtime)
Because all wallet balance modifications in our system write an audit record to the `ledger` table, we can identify anomalies by querying the ledger directly. 

To detect double-grants, we look for duplicate ledger entries for the same player, reason, and credit amount created within a tight timestamp window (e.g. 1 second):

```sql
SELECT 
  player_id, 
  amount, 
  reason, 
  count(*), 
  min(created_at) AS first_grant, 
  max(created_at) AS last_grant
FROM ledger
WHERE amount > 0 -- Focus only on credit transactions
GROUP BY player_id, amount, reason, date_trunc('second', created_at)
HAVING count(*) > 1;
```

---

### 2. Identifying Affected Players
To compile a list of affected players and calculate the exact excess credit they received, we execute:

```sql
CREATE TEMP TABLE double_grant_anomalies AS
SELECT 
  player_id, 
  reason, 
  amount,
  (count(*) - 1) * amount AS excess_amount
FROM ledger
WHERE amount > 0 AND reason LIKE 'CLAIM_REWARD:%' -- Example target: reward claims
GROUP BY player_id, reason, amount, date_trunc('minute', created_at)
HAVING count(*) > 1;

SELECT * FROM double_grant_anomalies;
```

---

### 3. Safe Balance Correction Strategy (Without Downtime)
Reconciling player balances must not take the system offline. We must perform updates per player inside localized transactions to avoid locking the entire `wallets` table.

For each affected player in our anomaly table:
1. Start a local transaction.
2. Retrieve the player's current wallet balance and lock the row:
   ```sql
   SELECT balance FROM wallets WHERE player_id = :playerId FOR UPDATE;
   ```
3. **Determine Recovery Path**:
   * **Case A (Sufficient Balance)**: If the player's current balance is $\ge$ the `excess_amount`, deduct the `excess_amount` directly, and write a ledger entry with reason `RECOVERY_ADJUSTMENT`.
   * **Case B (Insufficient Balance)**: If the player's current balance is less than the `excess_amount` (meaning they have already spent the double-granted currency):
     * We cannot set the balance negative due to the database `CHECK (balance >= 0)` constraint.
     * Instead, deduct the balance to exactly `0`.
     * Log the remaining unpaid debt in a `player_debts` table:
       ```sql
       INSERT INTO player_debts (player_id, unpaid_debt_amount) 
       VALUES (:playerId, :remainingUnpaidDebt);
       ```
     * When the player receives future credits (e.g. battle payouts), check the `player_debts` table, deduct the payout to clear the debt, and update the debt table.
4. Commit the local transaction.

This strategy ensures that the system remains online, no balances violate the negative-value invariant, and any spent currency is recovered over time.

---

### 4. Invariants to Prevent Recurrence
To prevent double-grant anomalies from reaching the database in the future:

1. **Unique Business Keys**: Enforce a unique constraint on the `ledger` table for mutating transactions by storing a unique transaction identifier (e.g. `battle_id` or `claim_reference`):
   ```sql
   ALTER TABLE ledger ADD COLUMN transaction_ref VARCHAR(255);
   CREATE UNIQUE INDEX idx_ledger_unique_ref ON ledger(transaction_ref);
   ```
2. **Reconciliation Invariant Checks**: Run a background sanity check query daily comparing the sum of ledger transactions against the actual wallet balance:
   ```sql
   SELECT w.player_id, w.balance, COALESCE(SUM(l.amount), 0) AS ledger_sum
   FROM wallets w
   LEFT JOIN ledger l ON w.player_id = l.player_id
   GROUP BY w.player_id, w.balance
   HAVING w.balance <> COALESCE(SUM(l.amount), 0);
   ```
   If this query returns any records, raise an alert immediately, as it indicates a balance corruption or unauthorized state change.
