import { spawn, ChildProcess } from 'child_process';
import { Client } from 'pg';
import http from 'http';

describe('Durable Game Economy Service (Crash Recovery & kill -9)', () => {
  let child: ChildProcess | null = null;
  let dbClient: Client;
  const PORT = 3099;
  const BASE_URL = `http://localhost:${PORT}`;

  beforeAll(async () => {
    // Connect directly to the Postgres database to verify state independent of the application
    dbClient = new Client({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      user: process.env.DB_USERNAME || 'game_admin',
      password: process.env.DB_PASSWORD || 'game_password_secure_123',
      database: process.env.DB_DATABASE || 'durable_vault_db',
    });
    await dbClient.connect();
  });

  afterAll(async () => {
    await dbClient.end();
    if (child) {
      child.kill('SIGKILL');
    }
  });

  beforeEach(async () => {
    // Truncate tables to isolate database state
    await dbClient.query(
      'TRUNCATE TABLE wallets, inventories, ledger, claimed_rewards, idempotency_keys CASCADE;',
    );
  });

  const sendRequest = (
    path: string,
    idempotencyKey: string,
    body: any,
    delayMs?: number,
  ): Promise<{ status: number; data: any }> => {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload).toString(),
        'idempotency-key': idempotencyKey,
      };

      if (delayMs) {
        headers['x-test-delay-ms'] = delayMs.toString();
      }

      const req = http.request(
        {
          hostname: 'localhost',
          port: PORT,
          path,
          method: 'POST',
          headers,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            try {
              resolve({
                status: res.statusCode || 0,
                data: JSON.parse(data),
              });
            } catch {
              resolve({
                status: res.statusCode || 0,
                data: data,
              });
            }
          });
        },
      );

      req.on('error', (err) => {
        reject(err);
      });

      req.write(payload);
      req.end();
    });
  };

  const startServer = (): Promise<void> => {
    return new Promise((resolve, reject) => {
      child = spawn('node', ['dist/main.js'], {
        env: {
          ...process.env,
          PORT: PORT.toString(),
          DB_HOST: process.env.DB_HOST || 'localhost',
        },
      });

      let resolved = false;

      child.stdout?.on('data', (data) => {
        const output = data.toString();
        if (output.includes('Application is running') && !resolved) {
          resolved = true;
          resolve();
        }
      });

      child.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });

      child.on('exit', () => {
        child = null;
      });
    });
  };

  it('should roll back changes completely on kill -9 mid-transaction, and allow successful retry on restart', async () => {
    const playerId = 'player_crash_1';
    const idempotencyKey = 'key-crash-test-123';

    // 1. Build project first to make sure dist/ exists
    // (This is done externally or in build steps, we assume it compiles)

    // 2. Start the application server as a background child process
    await startServer();

    // 3. Send a credit request with an artificial 2-second sleep delay before commit
    let requestError: any = null;
    sendRequest(
      `/v1/wallets/${playerId}/credit`,
      idempotencyKey,
      { amount: 1000, reason: 'Salary' },
      2000, // 2-second delay
    ).catch((err) => {
      requestError = err; // We expect connection to be aborted
    });

    // 4. Sleep 500ms to ensure the request has hit the server and entered transaction sleep
    await new Promise((resolve) => setTimeout(resolve, 500));

    // 5. Simulate a hard crash: Send SIGKILL (kill -9) to the server
    if (child) {
      const pid = child.pid;
      console.log(`[Crash Test] Sending SIGKILL (kill -9) to server process with PID: ${pid}`);
      child.kill('SIGKILL');
    }

    // Wait a brief moment to ensure process cleanup completes
    await new Promise((resolve) => setTimeout(resolve, 500));

    // 6. Assert Database Consistency (Transaction Rollback Verification)
    // Check wallet balance - must NOT be credited (should be null or empty)
    const walletQuery = await dbClient.query(
      `SELECT * FROM wallets WHERE player_id = '${playerId}';`,
    );
    expect(walletQuery.rows).toHaveLength(0); // Wallet was never created/saved

    // Check ledger - must contain zero records
    const ledgerQuery = await dbClient.query(
      `SELECT * FROM ledger WHERE player_id = '${playerId}';`,
    );
    expect(ledgerQuery.rows).toHaveLength(0);

    // Check idempotency key - must NOT be committed
    const idempotencyQuery = await dbClient.query(
      `SELECT * FROM idempotency_keys WHERE key = '${idempotencyKey}';`,
    );
    expect(idempotencyQuery.rows).toHaveLength(0);

    // 7. Restart the application server
    console.log('[Crash Test] Restarting server process...');
    await startServer();

    // 8. Retry the request with the EXACT same idempotency key (WITHOUT delay)
    console.log('[Crash Test] Retrying request with same idempotency key...');
    const retryRes = await sendRequest(`/v1/wallets/${playerId}/credit`, idempotencyKey, {
      amount: 1000,
      reason: 'Salary',
    });

    expect(retryRes.status).toBe(200);
    expect(retryRes.data.balance).toBe(1000);

    // 9. Verify the final database state is correct
    const finalWallet = await dbClient.query(
      `SELECT * FROM wallets WHERE player_id = '${playerId}';`,
    );
    expect(finalWallet.rows).toHaveLength(1);
    expect(parseInt(finalWallet.rows[0].balance, 10)).toBe(1000);

    const finalIdempotency = await dbClient.query(
      `SELECT * FROM idempotency_keys WHERE key = '${idempotencyKey}';`,
    );
    expect(finalIdempotency.rows).toHaveLength(1);
    expect(finalIdempotency.rows[0].status).toBe('COMPLETED');
  });
});
