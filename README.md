# Durable Game Economy Service

A robust, crash-durable, and concurrency-safe game economy microservice designed to handle critical player transactions without risk of double-spending, data corruption, or balance leakage under high load or sudden process termination.

---

## Technical Stack
* **Runtime**: Node.js (v18 Alpine)
* **Framework**: NestJS (v11)
* **Database**: PostgreSQL (v15 Alpine)
* **ORM**: TypeORM
* **Containerization**: Docker & Docker Compose

---

## Core Requirements Implemented & Verified
1. **Exactly-Once Semantics**: Dual-layer collision protection (in-memory fast-path set + PostgreSQL primary key constraint) ensures that duplicate HTTP requests with identical `Idempotency-Key` headers return the cached response without applying side-effects multiple times.
2. **Durability & Atomicity**: Database mutations (idempotency status update, wallet balance credit/debit, inventory item insertion, and ledger audit logging) are bound to a single transaction, ensuring all-or-nothing execution. Connection termination (`kill -9`) triggers an automatic PostgreSQL rollback.
3. **Concurrency Serialization**: Scoped pessimistic row-level write locks (`SELECT ... FOR UPDATE` on the wallet row) serialize concurrent modifications, preventing race conditions (lost updates, double-spending, or negative balances).
4. **Authoritative Economy**: Catalog item prices and reward payouts are owned and validated strictly by the server. Wallet balances are safeguarded by a database CHECK constraint (`balance >= 0`).
5. **Input Validation**: Hardened boundaries reject negative values, malformed JSON, missing fields, numeric overflows, and oversized strings (e.g. `playerId` length $> 255$) with a clear `400 Bad Request` prior to database execution.

---

## Setup & Running Instructions

### Prerequisites
* [Docker](https://www.docker.com/get-started) and Docker Compose installed on your host machine.
* Node.js (v18+) and npm installed (if running tests or compilation on the host).

### 1. Build and Run via Docker Compose
To build and start both the application and the database services:
```bash
docker compose up --build
```
* The application container runs on port `3000`.
* The database container runs on port `5432` and exposes port forwarding to the host.
* Database startup serialization is enforced via PostgreSQL container health checks (`pg_isready`). The NestJS container holds startup until the database is fully listening.

### 2. Shutdown & Clean Slate
To stop the services and completely wipe the database state (including volume persistence):
```bash
docker compose down -v
```

### 3. Compilation on Host
To verify TypeScript compilation locally:
```bash
npm run build
```

---

## Running the E2E Test Suite

E2E integration, concurrency, and crash recovery test suites execute against the database port exposed by the Docker container. 

> [!IMPORTANT]
> **Sequential Test Run Requirement**: Because E2E tests share the same database instance and truncate tables to isolate states, **you must execute the tests sequentially** to prevent parallel transaction deadlocks.

To run all 26 E2E tests sequentially:
```bash
npm run test:e2e -- --runInBand
```

---

## API Usage Examples

### 1. Credit Wallet
* **Method & Path**: `POST /v1/wallets/{playerId}/credit`
* **Headers**: 
  * `Content-Type: application/json`
  * `Idempotency-Key: <unique-string>`
* **Request Body**:
  ```json
  {
    "amount": 500,
    "reason": "BATTLE_PAYOUT"
  }
  ```
* **curl Command**:
  ```bash
  curl -i -X POST http://localhost:3000/v1/wallets/player_1/credit \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: credit-key-001" \
    -d '{"amount": 500, "reason": "BATTLE_PAYOUT"}'
  ```
* **Success Response (`200 OK`)**:
  ```json
  {
    "balance": 500
  }
  ```

---

### 2. Purchase Item
* **Method & Path**: `POST /v1/wallets/{playerId}/purchase`
* **Headers**: 
  * `Content-Type: application/json`
  * `Idempotency-Key: <unique-string>`
* **Request Body**:
  ```json
  {
    "itemId": "sword",
    "price": 100
  }
  ```
* **curl Command**:
  ```bash
  curl -i -X POST http://localhost:3000/v1/wallets/player_1/purchase \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: purchase-key-001" \
    -d '{"itemId": "sword", "price": 100}'
  ```
* **Success Response (`200 OK`)**:
  ```json
  {
    "balance": 400
  }
  ```

---

### 3. Claim Reward (Claim-Once)
* **Method & Path**: `POST /v1/rewards/{rewardId}/claim`
* **Headers**: 
  * `Content-Type: application/json`
  * `Idempotency-Key: <unique-string>`
* **Request Body**:
  ```json
  {
    "playerId": "player_1"
  }
  ```
* **curl Command**:
  ```bash
  curl -i -X POST http://localhost:3000/v1/rewards/welcome/claim \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: claim-key-001" \
    -d '{"playerId": "player_1"}'
  ```
* **Success Response (`200 OK`)**:
  ```json
  {
    "balance": 500
  }
  ```

---

### 4. Get Wallet State (Read-Only)
* **Method & Path**: `GET /v1/wallets/{playerId}`
* **curl Command**:
  ```bash
  curl -i http://localhost:3000/v1/wallets/player_1
  ```
* **Success Response (`200 OK`)**:
  ```json
  {
    "balance": 500,
    "inventory": ["sword"],
    "claimedRewards": ["welcome"]
  }
  ```

---

## Database Volume Persistence Verification

To manually verify that player balances and item grants persist across container shutdowns:

1. **Seed State**: Credit a new player with `500` gold coins:
   ```bash
   curl -i -X POST http://localhost:3000/v1/wallets/persist_test_player/credit \
     -H "Content-Type: application/json" \
     -H "Idempotency-Key: persist-key-100" \
     -d '{"amount": 500, "reason": "SETUP"}'
   ```
2. **Retrieve Balance**: Verify that the balance is successfully stored as `500`:
   ```bash
   curl http://localhost:3000/v1/wallets/persist_test_player
   ```
3. **Shutdown Containers**: Stop and remove the active containers **without** clearing volumes:
   ```bash
   docker compose down
   ```
4. **Restart Stack**: Start the containers up again:
   ```bash
   docker compose up --build
   ```
5. **Re-query Balance**: Verify that the player's balance has successfully outlived the container lifecycles and remains at `500`:
   ```bash
   curl http://localhost:3000/v1/wallets/persist_test_player
   ```
6. **Verify Idempotency Integrity**: Submit a duplicate request using the same key:
   ```bash
   curl -i -X POST http://localhost:3000/v1/wallets/persist_test_player/credit \
     -H "Content-Type: application/json" \
     -H "Idempotency-Key: persist-key-100" \
     -d '{"amount": 500, "reason": "SETUP"}'
   ```
   Verify that it catches the duplicate, returns the cached response, and does not apply the credit a second time (i.e. the balance stays at `500` instead of rising to `1000`).
