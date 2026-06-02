# Durable Game Economy Service

A robust, highly secure, crash-durable, and exactly-once transactional wallet/economy service for gaming backends.

## Stack
* NestJS (TypeScript/Node.js)
* PostgreSQL
* Docker & Docker Compose

## Core Features (In Progress)
* **Exactly-Once Processing**: Integrated idempotency key verification.
* **Concurrency Locking**: Scoped row-level locking (`SELECT FOR UPDATE`) on wallets.
* **Durability & Atomicity**: Atomic multi-row database updates under PostgreSQL ACID transactions.
* **Immutable Ledger**: Append-only transaction ledger auditing all wallet modifications.
