import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { Wallet } from '../entities/wallet.entity';
import { Player } from '../entities/player.entity';
import { Ledger } from '../entities/ledger.entity';

@Injectable()
export class WalletService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Credits a player's wallet inside a transaction.
   * Can accept an existing EntityManager to participate in an outer transaction (e.g. shared idempotency transaction).
   */
  async creditWallet(
    playerId: string,
    amount: number,
    reason: string,
    existingManager?: EntityManager,
  ): Promise<{ balance: number }> {
    const manager = existingManager || this.dataSource.manager;

    // Use transaction execution context
    return await manager.transaction(async (transactionalEntityManager) => {
      // 1. Ensure Player exists
      let player = await transactionalEntityManager.findOne(Player, {
        where: { id: playerId },
      });
      if (!player) {
        player = transactionalEntityManager.create(Player, { id: playerId });
        await transactionalEntityManager.save(Player, player);
      }

      // 2. Lock/Retrieve Wallet (Pessimistic Row Lock)
      let wallet = await transactionalEntityManager.findOne(Wallet, {
        where: { playerId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!wallet) {
        // Create wallet if it does not exist
        wallet = transactionalEntityManager.create(Wallet, {
          playerId,
          balance: 0,
        });
        await transactionalEntityManager.save(Wallet, wallet);

        // Re-lock the newly created row to prevent race conditions on initialization
        wallet = await transactionalEntityManager.findOne(Wallet, {
          where: { playerId },
          lock: { mode: 'pessimistic_write' },
        });

        if (!wallet) {
          throw new Error('Fatal: failed to initialize and lock player wallet');
        }
      }

      // 3. Update Balance
      wallet.balance += amount;
      await transactionalEntityManager.save(Wallet, wallet);

      // 4. Write Ledger Entry (Audit Trail)
      const ledgerEntry = transactionalEntityManager.create(Ledger, {
        playerId,
        amount,
        reason,
      });
      await transactionalEntityManager.save(Ledger, ledgerEntry);

      return { balance: wallet.balance };
    });
  }
}
