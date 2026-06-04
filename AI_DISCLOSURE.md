# AI Tool Usage Disclosure (AI_DISCLOSURE.md)

This document provides a factual declaration of the collaboration between the developer and the AI assistant (Google Gemini / Antigravity IDE) during the design, implementation, testing, and documentation of the Durable Game Economy Service.

---

## 1. Division of Labor & Scope of Assistance

The AI tool acted as a pair-programmer, providing code generation, automated test expansion, and architectural review under the direction and supervision of the developer.

### A. Architectural Discussions
* **AI Assistance**: Suggested database-backed, transaction-synchronized idempotency over Redis-based key storage to avoid out-of-sync split-brain states on crash. Assisted in designing the pessimistic row locking strategy (`SELECT ... FOR UPDATE`) to handle concurrency.
* **Human Decision**: Selected PostgreSQL as the database and Read Committed as the isolation level. Approved the overall transactional boundary structure.

### B. Implementation
* **AI Assistance**: Generated NestJS scaffolding, database entity properties (`Wallet`, `Inventory`, `ClaimedReward`, `Ledger`, `IdempotencyKey`), and standard service methods.
* **Bug Fixes & Refactoring (AI-assisted)**:
  * **Pipes and DTOs**: Assisted in implementing the custom `ParsePlayerIdPipe` to restrict path parameters to 255 characters and adding `@Length` constraints in body DTOs to protect database columns.
  * **Memory Leak Correction**: Assisted in refactoring the `IdempotencyInterceptor`'s `try...catch` block. When database pool connection errors occurred, the in-memory `activeKeys` Set previously leaked keys. The AI helped introduce local transaction tracking flags (`isTxStarted`) to ensure keys are cleaned up on database connection timeouts.
* **Human Decision**: Guided DTO validations, catalog price definitions, and the placement of check constraints.

### C. Test Creation
* **AI Assistance**:
  * Generated E2E test cases in `app.e2e-spec.ts` for concurrent request racing, completed retries, and composite primary key unique constraints.
  * Assisted in writing the E2E crash recovery test suite in `crash-recovery.e2e-spec.ts`, configuring child process spawning, sending `SIGKILL` (`kill -9`) mid-transaction via delay headers, restarting the server, and verifying database consistency.
* **Human Decision**: Defined E2E test scopes and isolated test databases by running CASCADE truncates before each test run.

### D. Documentation Drafting
* **AI Assistance**: Drafted `README.md`, `DESIGN.md`, and `RESILIENCE.md` based on files, database schemas, and E2E test suite logs.
* **Human Decision**: Reviewed and verified all documentation claims, and separated monolithic code design from hypothetical distributed outbox and saga designs.

---

## 2. Validation & Verification Methodology

Every code snippet, configuration, and documentation draft generated with the assistance of the AI was verified:
1. **Compilation Validation**: Local compilation was verified using `npm run build` to catch TypeScript type errors.
2. **Automated Testing Pass**: Integration, concurrency, and crash recovery behaviors were verified by executing the 26 E2E tests sequentially on the host machine (`npm run test:e2e -- --runInBand`).
3. **Docker Compose Verification**: Verified containerization, database health checks, and data volume persistence using Docker Compose.
