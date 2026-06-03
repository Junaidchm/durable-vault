import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { Wallet } from '../entities/wallet.entity';
import { Player } from '../entities/player.entity';
import { Ledger } from '../entities/ledger.entity';
import { Inventory } from '../entities/inventory.entity';
import { getCatalogPrice } from '../config/catalog.config';

@Injectable()
export class WalletService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Credits a player's wallet inside a transaction.
   */
  async creditWallet(
    playerId: string,
    amount: number,
    reason: string,
    existingManager?: EntityManager,
  ): Promise<{ balance: number }> {
    const manager = existingManager || this.dataSource.manager;

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
        wallet = transactionalEntityManager.create(Wallet, {
          playerId,
          balance: 0,
        });
        await transactionalEntityManager.save(Wallet, wallet);

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

  /**
   * Atomically debits a player's wallet and grants an item inside a transaction.
   * Insufficient funds/catalog discrepancies result in rollback with no partial effects.
   */
  async purchaseItem(
    playerId: string,
    itemId: string,
    clientPrice: number,
    existingManager?: EntityManager,
  ): Promise<{ balance: number }> {
    // 1. Verify Item in Authoritative Catalog
    const catalogPrice = getCatalogPrice(itemId);
    if (catalogPrice === null) {
      throw new NotFoundException(`Item '${itemId}' not found in catalog`);
    }

    // 2. Authoritative Price Check (Prevents price forgery from client)
    if (catalogPrice !== clientPrice) {
      throw new BadRequestException(
        `Price mismatch for item '${itemId}'. Catalog price is ${catalogPrice}, client sent ${clientPrice}`,
      );
    }

    const manager = existingManager || this.dataSource.manager;

    return await manager.transaction(async (transactionalEntityManager) => {
      // 3. Ensure Player exists
      const player = await transactionalEntityManager.findOne(Player, {
        where: { id: playerId },
      });
      if (!player) {
        throw new BadRequestException(`Player '${playerId}' does not exist`);
      }

      // 4. Lock/Retrieve Wallet (Pessimistic Row Lock)
      const wallet = await transactionalEntityManager.findOne(Wallet, {
        where: { playerId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!wallet) {
        throw new BadRequestException(`Wallet for player '${playerId}' not initialized`);
      }

      // 5. Invariant balance check
      if (wallet.balance < catalogPrice) {
        throw new BadRequestException('Insufficient funds');
      }

      // 6. Debit balance
      wallet.balance -= catalogPrice;
      await transactionalEntityManager.save(Wallet, wallet);

      // 7. Grant Item to Inventory
      const inventoryItem = transactionalEntityManager.create(Inventory, {
        playerId,
        itemId,
      });
      await transactionalEntityManager.save(Inventory, inventoryItem);

      // 8. Write Debit Ledger Entry
      const ledgerEntry = transactionalEntityManager.create(Ledger, {
        playerId,
        amount: -catalogPrice, // Negative amount denotes debit
        reason: `PURCHASE:${itemId}`,
      });
      await transactionalEntityManager.save(Ledger, ledgerEntry);

      return { balance: wallet.balance };
    });
  }
}
