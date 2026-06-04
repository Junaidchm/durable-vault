# System Architecture & Design Specification (DESIGN.md)

This document provides a technical explanation of the architecture, design choices, database schema, transaction boundaries, and safety limits implemented in the Durable Game Economy Service.

---

## 1. Datastore Choice & Justification

### Database: PostgreSQL (v15 Alpine)
We selected **PostgreSQL** as the authoritative datastore for the game economy. The reasons for this selection are:
1. **Strict ACID Compliance**: Crucial for financial logic where losing or duplicating currency/items is unacceptable.
2. **Robust Row-Level Locking**: PostgreSQL supports explicit pessimistic locks (`SELECT ... FOR UPDATE`) which serialize transactions targeting the same database rows.
3. **Transactional JSONB Support**: Allows caching structured HTTP response bodies directly inside the database transaction registry, guaranteeing that idempotency data and business state modifications remain synchronized.
4. **Dev/Prod Parity**: PostgreSQL is highly scalable and matches the production environments of enterprise gaming backends.

---

## 2. Exactly-Once Semantics & Idempotency Strategy

Mutating endpoints (`POST /v1/wallets/:playerId/credit`, `POST /v1/wallets/:playerId/purchase`, and `POST /v1/rewards/:rewardId/claim`) require the client to supply an `Idempotency-Key` header.

### 1. The Transaction-Synchronized Idempotency Key Engine
Instead of saving idempotency keys in an external store (like Redis) which risks out-of-sync split-brain states, **the key registration and the business state modifications are executed inside the exact same database transaction**.

```
Client                  IdempotencyInterceptor               Database (Single Transaction)
  |                                |                                       |
  |--- POST /credit (Key: XYZ) --->|                                       |
  |                                |--- Begin Transaction ---------------->|
  |                                |--- Insert Key "XYZ" (IN_PROGRESS) --->|
  |                                |    (If duplicate key error, rollback  |
  |                                |     and retrieve cached response)     |
  |                                |                                       |
  |                                |--- Execute Wallet Credit ------------>|
  |                                |--- Execute Ledger Log --------------->|
  |                                |                                       |
  |                                |--- Update Key "XYZ" (COMPLETED) ----->|
  |                                |    with response status & body        |
  |                                |                                       |
  |                                |--- Commit Transaction --------------->| (All changes saved)
  |<-- Return 200 OK --------------|                                       |
```

### 2. Idempotency Key Lifecycle & Execution States
Each key in the `idempotency_keys` registry transitions through two states:
1. **`IN_PROGRESS`**: Initialized immediately when a transaction starts.
2. **`COMPLETED`**: Transitioned upon successful downstream execution, saving the response status code and JSON response body.

### 3. Duplicate Request Handling & Execution Paths
The system handles duplicate requests through three distinct paths depending on the request timing and process distribution:

1. **Same-Process In-Flight Duplicate (Fast-Path Reject)**:
   * **Condition**: A duplicate request arrives on the same server instance while the first request is still executing.
   * **Behavior**: Intercepted at the application boundary by the in-memory `activeKeys` Set. The request is rejected immediately with a `409 Conflict` **before** initializing a database connection or starting a transaction, preventing database connection starvation under click storms.
2. **Cross-Process / Post-Restart In-Flight Duplicate (Database Lock Queueing)**:
   * **Condition**: A duplicate request is routed to a different server node (in a horizontally scaled cluster) or arrives after a process restart while the database transaction is still active.
   * **Behavior**: Bypasses the local `activeKeys` set. It establishes a database connection, starts a transaction, and attempts to insert the key. The database blocks the second insert on a PostgreSQL index lock, waiting for the first transaction to resolve.
     * *If Transaction 1 Commits*: Transaction 2 receives a unique constraint violation, rolls back its transaction, queries the database, reads `status = COMPLETED`, and returns the cached response.
     * *If Transaction 1 Rolls Back* (or the connection severs): The index lock is released, and Transaction 2 executes the request from scratch.
3. **Completed Request Retry (Cache Retrieval)**:
   * **Condition**: A request is retried after the original transaction has committed successfully.
   * **Behavior**: Bypasses the local `activeKeys` set (which was cleared upon commit). It starts a database transaction and attempts to insert the key. PostgreSQL immediately throws a unique constraint violation. The interceptor catches the violation, rolls back the transaction, releases the connection, queries the database for the cached response, and returns the stored status and response body.


### 4. Idempotency Key Retention Strategy
* **Current Implementation**: The key is created with an `expires_at` timestamp set to 24 hours in the future.
* **Current Tradeoff**: To keep the development setup minimal, **there is no active background worker or automatic TTL cleanup process running**. Old, expired keys remain in the database unless cleared manually.
* **Production Recommendation**: Set up a PostgreSQL scheduled job (using `pg_cron`) or an external lightweight worker to run a daily cleanup query:
  ```sql
  DELETE FROM idempotency_keys WHERE expires_at < NOW();
  ```

---

## 3. Atomicity, Durability & Crash Recovery Strategy

### 1. Atomicity & Durability
Every mutating HTTP request is wrapped in a single database transaction managed by the `IdempotencyInterceptor`.
* PostgreSQL write-ahead logging (WAL) guarantees that committed transactions are durably saved to disk.
* All changes—the idempotency status transition, wallet balance updates, inventory insertions, and ledger logging—succeed or fail together.

### 2. Crash Recovery Checkpoints (`kill -9`)
If the application process is terminated abruptly (e.g. `kill -9` or server power failure), the database maintains absolute consistency:

1. **Crash Mid-Transaction**: PostgreSQL automatically detects that the client TCP socket has been severed. It aborts the active transaction, discards all uncommitted changes (no partial balance credit/debit or item grant), and releases all row locks. The idempotency key is not saved. Upon restart, a client retry is treated as a clean first-time request and completes successfully.
2. **Crash During Commit**: PostgreSQL commits the entire transaction or rolls it back atomically. If committed, a subsequent retry retrieves the cached completed response. If rolled back, the retry executes the request from scratch.
3. **Crash After Commit (Before HTTP Response)**: The state modifications are committed. The client retry catches the unique key violation, retrieves the `COMPLETED` status, and returns the cached response.

---

## 4. Isolation, Locking & Concurrency Strategy

### 1. Database Isolation level
The database operates under PostgreSQL's default **`Read Committed`** isolation level. To prevent transaction anomalies under high contention, we supplement this isolation level with explicit row-level locking.

### 2. Pessimistic Row-Level Locking
 Mutating endpoints acquire a pessimistic write lock (`SELECT ... FOR UPDATE`) on the player's wallet row before validating or updating state:
```typescript
manager.findOne(Wallet, { where: { playerId }, lock: { mode: 'pessimistic_write' } })
```

### 3. Concurrency & Double-Spend Prevention
* **Lock Queueing**: If 100 concurrent purchases hit the same wallet, PostgreSQL queues the requests.
* **Execution Order**:
  1. Transaction 1 acquires the lock, reads the balance, validates funds, debits the balance, and commits.
  2. Transaction 2 acquires the lock, reads the updated balance (which is now reduced), fails validation (insufficient funds), and rolls back.
  3. Transactions 3-100 execute sequentially, reading the updated balance and rejecting immediately.
* **Deadlock Prevention**: Mutating transactions only lock a single player's wallet row. Because there are no multi-wallet transfers or circular dependencies, deadlocks are mathematically impossible.

---

## 5. API Contract & Validation Limits

### 1. Numeric Values & Overflow Guard
* **Database Type**: Wallet balances and ledger transaction amounts are stored as PostgreSQL `bigint` (64-bit signed integers).
* **Validation Bounds**: Payload validation in DTOs limits input amounts and prices:
  * Minimum: `1` (enforced via `@Min(1)`)
  * Maximum: `9,000,000,000,000,000` (9 Quadrillion, enforced via `@Max(9000000000000000)`)
* **Rationale**: Capping input at 9 Quadrillion keeps numeric representations safely within JavaScript's double-precision limit (`Number.MAX_SAFE_INTEGER` = `9,007,199,254,740,991`) and PostgreSQL's maximum `bigint` (`9,223,372,036,854,775,807`), preventing precision rounding errors or column overflow exceptions.

### 2. String Length Validation (Player IDs)
* **Parameter Validation**: Path parameters (`:playerId`) and body parameters are validated to ensure they are non-empty and have a length $\le 255$ characters. This protects the database's `varchar(255)` columns from truncation or overrun errors.

---

## 6. Monolithic Isolation vs. Distributed Systems

> [!IMPORTANT]
> **Monolithic Context**: The current codebase operates within a single monolithic NestJS process and a single PostgreSQL database instance. Transaction coordination relies on local TypeORM managers.
> **Distributed Systems Scenario**: Complex architectures, such as **Saga Patterns** or **Transactional Outbox Patterns** for coordinating purchases across a decoupled inventory service over network APIs, are strictly hypothetical and are discussed in detail in `RESILIENCE.md`. They do not exist in the active source code.

---

## 7. Production Recommendations

While the current implementation guarantees correctness, the following optimizations should be applied for production deployments:

1. **Disable Auto-Synchronization**:
   * *Dev Implementation*: TypeORM's `synchronize: true` is enabled in `app.module.ts` to automatically synchronize tables on boot.
   * *Production recommendation*: Disable `synchronize` and use standard PostgreSQL migration scripts to control schema changes and avoid locking tables.
2. **Query Lock Timeout**:
   * *Dev Implementation*: Pessimistic locks wait indefinitely for lock release.
   * *Production recommendation*: Set a transaction lock timeout (e.g. `SET lock_timeout = 2000`) so that requests fail fast under extreme database connection queueing, preventing connection pool exhaustion.
3. **Database Partitioning**:
   * *Dev Implementation*: The `ledger` and `idempotency_keys` tables grow indefinitely.
   * *Production recommendation*: Partition the `ledger` table by `created_at` or `player_id` to maintain query performance under millions of transactions.
