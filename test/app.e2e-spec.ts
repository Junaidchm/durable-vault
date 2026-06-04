import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, HttpStatus, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from './../src/app.module';

describe('Durable Game Economy Service (E2E Integration & Concurrency)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
    dataSource = app.get(DataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Isolate database: Truncate tables before each test run
    await dataSource.query(
      'TRUNCATE TABLE wallets, inventories, ledger, claimed_rewards, idempotency_keys CASCADE;',
    );
  });

  describe('A. Boundary Validations', () => {
    it('POST /v1/wallets/:playerId/credit - should reject negative amount', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/wallets/player1/credit')
        .set('idempotency-key', 'key-neg-credit')
        .send({ amount: -50, reason: 'Test payout' });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('POST /v1/wallets/:playerId/credit - should reject zero amount', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/wallets/player1/credit')
        .set('idempotency-key', 'key-zero-credit')
        .send({ amount: 0, reason: 'Test payout' });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('POST /v1/wallets/:playerId/credit - should reject overflow amount', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/wallets/player1/credit')
        .set('idempotency-key', 'key-overflow-credit')
        .send({ amount: 9999999999999999, reason: 'Test payout' });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('POST /v1/wallets/:playerId/credit - should reject missing reason', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/wallets/player1/credit')
        .set('idempotency-key', 'key-missing-reason')
        .send({ amount: 100 });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('POST /v1/wallets/:playerId/credit - should reject un-whitelisted extra keys', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/wallets/player1/credit')
        .set('idempotency-key', 'key-extra-keys')
        .send({ amount: 100, reason: 'Bonus', hack: 'exploit' });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('POST /v1/wallets/:playerId/purchase - should reject invalid itemId', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/wallets/player1/purchase')
        .set('idempotency-key', 'key-invalid-item')
        .send({ itemId: 'non-existent', price: 100 });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });

    it('POST /v1/wallets/:playerId/purchase - should reject pricing mismatch against authoritative catalog', async () => {
      // Catalog price for sword is 100. Let's send 50.
      const res = await request(app.getHttpServer())
        .post('/v1/wallets/player1/purchase')
        .set('idempotency-key', 'key-price-mismatch')
        .send({ itemId: 'sword', price: 50 });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.message).toContain('Price mismatch');
    });

    it('POST /v1/rewards/:rewardId/claim - should reject invalid rewardId', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/rewards/fake-reward/claim')
        .set('idempotency-key', 'key-invalid-reward')
        .send({ playerId: 'player1' });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });

    it('POST /v1/wallets/:playerId/credit - should reject missing idempotency-key header', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/wallets/player1/credit')
        .send({ amount: 100, reason: 'No key' });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.message).toContain('Idempotency-Key header is required');
    });

    it('POST /v1/wallets/:playerId/credit - should reject empty/whitespace idempotency-key header', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/wallets/player1/credit')
        .set('idempotency-key', '   ')
        .send({ amount: 100, reason: 'Empty key' });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.message).toContain('Idempotency-Key header is required');
    });

    it('POST /v1/wallets/:playerId/credit - should reject empty/whitespace playerId', async () => {
      const res = await request(app.getHttpServer())
        .post('/v1/wallets/%20/credit')
        .set('idempotency-key', 'key-empty-player')
        .send({ amount: 100, reason: 'Empty player' });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.message).toContain('Player ID is required');
    });
  });

  describe('B. Core End-to-End Success Paths', () => {
    it('should complete credit -> purchase -> claim -> get status flow', async () => {
      const playerId = 'player_e2e_1';

      // 1. Credit 500 gold
      const creditRes = await request(app.getHttpServer())
        .post(`/v1/wallets/${playerId}/credit`)
        .set('idempotency-key', 'key-flow-credit')
        .send({ amount: 500, reason: 'BATTLE_REWARD' });
      expect(creditRes.status).toBe(HttpStatus.OK);
      expect(creditRes.body.balance).toBe(500);

      // Verify DB ledger entries
      const ledgerCredits = await dataSource.query(`SELECT * FROM ledger WHERE player_id = '${playerId}';`);
      expect(ledgerCredits).toHaveLength(1);
      expect(parseInt(ledgerCredits[0].amount, 10)).toBe(500);

      // 2. Purchase a sword (cost 100)
      const purchaseRes = await request(app.getHttpServer())
        .post(`/v1/wallets/${playerId}/purchase`)
        .set('idempotency-key', 'key-flow-purchase')
        .send({ itemId: 'sword', price: 100 });
      expect(purchaseRes.status).toBe(HttpStatus.OK);
      expect(purchaseRes.body.balance).toBe(400);

      // Verify DB inventory
      const inventory = await dataSource.query(`SELECT * FROM inventories WHERE player_id = '${playerId}';`);
      expect(inventory).toHaveLength(1);
      expect(inventory[0].item_id).toBe('sword');

      // 3. Claim 'welcome' reward (grants 100 gold)
      const claimRes = await request(app.getHttpServer())
        .post('/v1/rewards/welcome/claim')
        .set('idempotency-key', 'key-flow-claim')
        .send({ playerId });
      expect(claimRes.status).toBe(HttpStatus.OK);
      expect(claimRes.body.balance).toBe(500);

      // 4. GET status
      const getRes = await request(app.getHttpServer())
        .get(`/v1/wallets/${playerId}`);
      expect(getRes.status).toBe(HttpStatus.OK);
      expect(getRes.body).toEqual({
        balance: 500,
        inventory: ['sword'],
        claimedRewards: ['welcome'],
      });
    });
  });

  describe('C. Concurrency Race Tests (Double-Spend Prevention)', () => {
    it('should allow only 1 purchase of sword (100) on a 100 balance, cleanly rejecting others', async () => {
      const playerId = 'player_race_1';

      // 1. Setup wallet balance to exactly 100
      await request(app.getHttpServer())
        .post(`/v1/wallets/${playerId}/credit`)
        .set('idempotency-key', 'key-race-setup')
        .send({ amount: 100, reason: 'Initial Setup' });

      // 2. Trigger 10 concurrent purchases (each with a unique idempotency key)
      const concurrentRequests = Array.from({ length: 10 }, (_, i) => {
        return request(app.getHttpServer())
          .post(`/v1/wallets/${playerId}/purchase`)
          .set('idempotency-key', `key-race-purchase-${i}`)
          .send({ itemId: 'sword', price: 100 });
      });

      const responses = await Promise.all(concurrentRequests);

      // Assertions:
      // Exactly 1 must return 200 OK (successful purchase)
      // Exactly 9 must return 400 Bad Request (Insufficient funds)
      const successCount = responses.filter(r => r.status === HttpStatus.OK).length;
      const rejectCount = responses.filter(r => r.status === HttpStatus.BAD_REQUEST).length;

      expect(successCount).toBe(1);
      expect(rejectCount).toBe(9);

      // Verify state via GET
      const getRes = await request(app.getHttpServer()).get(`/v1/wallets/${playerId}`);
      expect(getRes.body.balance).toBe(0); // Balance debited to 0
      expect(getRes.body.inventory).toEqual(['sword']); // Exactly 1 sword owned
    });
  });

  describe('D. Idempotency & Deduplication', () => {
    it('should block concurrent identical keys with 409 Conflict (In-Flight lock)', async () => {
      const playerId = 'player_idem_1';

      // Fire the first credit request with a 100ms artificial crash delay
      const req1Promise = request(app.getHttpServer())
        .post(`/v1/wallets/${playerId}/credit`)
        .set('idempotency-key', 'key-in-flight-test')
        .set('x-test-delay-ms', '100')
        .send({ amount: 100, reason: 'Slow Credit' });

      // Fire a duplicate request immediately with the same key
      const req2Promise = new Promise(resolve => setTimeout(resolve, 30)).then(() => {
        return request(app.getHttpServer())
          .post(`/v1/wallets/${playerId}/credit`)
          .set('idempotency-key', 'key-in-flight-test')
          .send({ amount: 100, reason: 'Retry Credit' });
      });

      const [res1, res2] = await Promise.all([req1Promise, req2Promise]);

      expect(res1.status).toBe(HttpStatus.OK);
      expect(res2.status).toBe(HttpStatus.CONFLICT); // 409 Conflict

      // Verify balance is only updated once (100, not 200)
      const state = await request(app.getHttpServer()).get(`/v1/wallets/${playerId}`);
      expect(state.body.balance).toBe(100);
    });

    it('should return identical cached response on completed retries (Exactly-Once)', async () => {
      const playerId = 'player_idem_2';

      // 1. Payout 200 gold
      const res1 = await request(app.getHttpServer())
        .post(`/v1/wallets/${playerId}/credit`)
        .set('idempotency-key', 'key-completed-test')
        .send({ amount: 200, reason: 'Salary Payout' });
      expect(res1.status).toBe(HttpStatus.OK);
      const firstResponse = res1.body;

      // 2. Payout retry with same key
      const res2 = await request(app.getHttpServer())
        .post(`/v1/wallets/${playerId}/credit`)
        .set('idempotency-key', 'key-completed-test')
        .send({ amount: 200, reason: 'Salary Payout' });
      
      expect(res2.status).toBe(HttpStatus.OK);
      expect(res2.body).toEqual(firstResponse); // Body is identical

      // Verify balance is credited only once (200, not 400)
      const state = await request(app.getHttpServer()).get(`/v1/wallets/${playerId}`);
      expect(state.body.balance).toBe(200);
    });

    it('should enforce claim-once reward block via composite key constraint', async () => {
      const playerId = 'player_idem_3';

      // First claim succeeds
      const res1 = await request(app.getHttpServer())
        .post('/v1/rewards/welcome/claim')
        .set('idempotency-key', 'key-claim-unique-1')
        .send({ playerId });
      expect(res1.status).toBe(HttpStatus.OK);

      // Second claim with DIFFERENT idempotency key (but same reward and player) fails
      const res2 = await request(app.getHttpServer())
        .post('/v1/rewards/welcome/claim')
        .set('idempotency-key', 'key-claim-unique-2')
        .send({ playerId });
      
      expect(res2.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res2.body.message).toContain('already been claimed');
    });

    it('should return identical cached response on completed claim retry with same key', async () => {
      const playerId = 'player_idem_claim_retry';

      // 1. Claim reward first time
      const res1 = await request(app.getHttpServer())
        .post('/v1/rewards/welcome/claim')
        .set('idempotency-key', 'key-claim-completed-retry')
        .send({ playerId });
      expect(res1.status).toBe(HttpStatus.OK);
      const firstResponse = res1.body;

      // 2. Retry the claim with the same key
      const res2 = await request(app.getHttpServer())
        .post('/v1/rewards/welcome/claim')
        .set('idempotency-key', 'key-claim-completed-retry')
        .send({ playerId });

      expect(res2.status).toBe(HttpStatus.OK);
      expect(res2.body).toEqual(firstResponse);

      // Verify balance is only updated once (100, not 200)
      const state = await request(app.getHttpServer()).get(`/v1/wallets/${playerId}`);
      expect(state.body.balance).toBe(100);
    });
  });

  describe('E. Database Invariants & Integrity', () => {
    it('should enforce CHECK constraint balance >= 0 at the database level', async () => {
      // 1. Initialize player and wallet with 100 gold
      const playerId = 'player_constraint_test';
      await request(app.getHttpServer())
        .post(`/v1/wallets/${playerId}/credit`)
        .set('idempotency-key', 'key-constraint-setup')
        .send({ amount: 100, reason: 'Setup' });

      // 2. Directly update the wallet balance to a negative number via direct SQL query to bypass application logic
      let queryError: any = null;
      try {
        await dataSource.query(
          `UPDATE wallets SET balance = -50 WHERE player_id = '${playerId}';`
        );
      } catch (err) {
        queryError = err;
      }

      // Assert that the database rejected the update due to check constraint violation
      expect(queryError).toBeDefined();
      expect(queryError.message).toContain('violates check constraint');
    });

    it('should cascade delete wallet, inventories, ledger, and claimed_rewards when player is deleted', async () => {
      const playerId = 'player_cascade_test';

      // 1. Credit player
      await request(app.getHttpServer())
        .post(`/v1/wallets/${playerId}/credit`)
        .set('idempotency-key', 'key-cascade-credit')
        .send({ amount: 500, reason: 'Salary' });

      // 2. Purchase item
      await request(app.getHttpServer())
        .post(`/v1/wallets/${playerId}/purchase`)
        .set('idempotency-key', 'key-cascade-purchase')
        .send({ itemId: 'sword', price: 100 });

      // 3. Claim reward
      await request(app.getHttpServer())
        .post('/v1/rewards/welcome/claim')
        .set('idempotency-key', 'key-cascade-claim')
        .send({ playerId });

      // 4. Verify they all exist in database
      const walletBefore = await dataSource.query(`SELECT * FROM wallets WHERE player_id = '${playerId}';`);
      const inventoryBefore = await dataSource.query(`SELECT * FROM inventories WHERE player_id = '${playerId}';`);
      const ledgerBefore = await dataSource.query(`SELECT * FROM ledger WHERE player_id = '${playerId}';`);
      const claimsBefore = await dataSource.query(`SELECT * FROM claimed_rewards WHERE player_id = '${playerId}';`);

      expect(walletBefore).toHaveLength(1);
      expect(inventoryBefore).toHaveLength(1);
      expect(ledgerBefore).toHaveLength(3); // credit, purchase, claim
      expect(claimsBefore).toHaveLength(1);

      // 5. Delete the player row
      await dataSource.query(`DELETE FROM players WHERE id = '${playerId}';`);

      // 6. Assert that all child records were deleted by database cascade constraint
      const walletAfter = await dataSource.query(`SELECT * FROM wallets WHERE player_id = '${playerId}';`);
      const inventoryAfter = await dataSource.query(`SELECT * FROM inventories WHERE player_id = '${playerId}';`);
      const ledgerAfter = await dataSource.query(`SELECT * FROM ledger WHERE player_id = '${playerId}';`);
      const claimsAfter = await dataSource.query(`SELECT * FROM claimed_rewards WHERE player_id = '${playerId}';`);

      expect(walletAfter).toHaveLength(0);
      expect(inventoryAfter).toHaveLength(0);
      expect(ledgerAfter).toHaveLength(0);
      expect(claimsAfter).toHaveLength(0);
    });
  });
});
