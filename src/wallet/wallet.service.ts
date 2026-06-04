import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { Wallet } from '../entities/wallet.entity';
import { Player } from '../entities/player.entity';
import { Ledger } from '../entities/ledger.entity';
import { Inventory } from '../entities/inventory.entity';
import { ClaimedReward } from '../entities/claimed-reward.entity';
import { getCatalogPrice } from '../config/catalog.config';
import { getRewardPayout } from '../config/rewards.config';

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
   */
  async purchaseItem(
    playerId: string,
    itemId: string,
    clientPrice: number,
    existingManager?: EntityManager,
  ): Promise<{ balance: number }> {
    const catalogPrice = getCatalogPrice(itemId);
    if (catalogPrice === null) {
      throw new NotFoundException(`Item '${itemId}' not found in catalog`);
    }

    if (catalogPrice !== clientPrice) {
      throw new BadRequestException(
        `Price mismatch for item '${itemId}'. Catalog price is ${catalogPrice}, client sent ${clientPrice}`,
      );
    }

    const manager = existingManager || this.dataSource.manager;

    return await manager.transaction(async (transactionalEntityManager) => {
      const player = await transactionalEntityManager.findOne(Player, {
        where: { id: playerId },
      });
      if (!player) {
        throw new BadRequestException(`Player '${playerId}' does not exist`);
      }

      const wallet = await transactionalEntityManager.findOne(Wallet, {
        where: { playerId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!wallet) {
        throw new BadRequestException(`Wallet for player '${playerId}' not initialized`);
      }

      if (wallet.balance < catalogPrice) {
        throw new BadRequestException('Insufficient funds');
      }

      wallet.balance -= catalogPrice;
      await transactionalEntityManager.save(Wallet, wallet);

      const inventoryItem = transactionalEntityManager.create(Inventory, {
        playerId,
        itemId,
      });
      await transactionalEntityManager.save(Inventory, inventoryItem);

      const ledgerEntry = transactionalEntityManager.create(Ledger, {
        playerId,
        amount: -catalogPrice,
        reason: `PURCHASE:${itemId}`,
      });
      await transactionalEntityManager.save(Ledger, ledgerEntry);

      return { balance: wallet.balance };
    });
  }

  /**
   * Claims a reward once per player.
   * If valid, atomically flags the claim, credits the wallet balance, and writes a ledger entry.
   */
  async claimReward(
    rewardId: string,
    playerId: string,
    existingManager?: EntityManager,
  ): Promise<{ balance: number }> {
    // 1. Verify Reward ID against catalog
    const payout = getRewardPayout(rewardId);
    if (payout === null) {
      throw new NotFoundException(`Reward '${rewardId}' not found in catalog`);
    }

    const manager = existingManager || this.dataSource.manager;

    return await manager.transaction(async (transactionalEntityManager) => {
      // 2. Ensure Player exists
      let player = await transactionalEntityManager.findOne(Player, {
        where: { id: playerId },
      });
      if (!player) {
        player = transactionalEntityManager.create(Player, { id: playerId });
        await transactionalEntityManager.save(Player, player);
      }

      // 3. Lock/Retrieve Wallet (Pessimistic Row Lock)
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

      // 4. Check for duplicate claims at database level
      const existingClaim = await transactionalEntityManager.findOne(ClaimedReward, {
        where: { playerId, rewardId },
      });

      if (existingClaim) {
        throw new BadRequestException(`Reward '${rewardId}' has already been claimed by player '${playerId}'`);
      }

      // 5. Create Claim Record (Composite key guarantees uniqueness)
      const claim = transactionalEntityManager.create(ClaimedReward, {
        playerId,
        rewardId,
      });
      await transactionalEntityManager.save(ClaimedReward, claim);

      // 6. Credit wallet balance
      wallet.balance += payout;
      await transactionalEntityManager.save(Wallet, wallet);

      // 7. Write Ledger Audit Entry
      const ledgerEntry = transactionalEntityManager.create(Ledger, {
        playerId,
        amount: payout,
        reason: `CLAIM_REWARD:${rewardId}`,
      });
      await transactionalEntityManager.save(Ledger, ledgerEntry);

      return { balance: wallet.balance };
    });
  }

  /**
   * Retrieves player wallet state including balance, inventory items, and claimed rewards.
   */
  async getWalletState(playerId: string): Promise<{
    balance: number;
    inventory: string[];
    claimedRewards: string[];
  }> {
    const player = await this.dataSource.manager.findOne(Player, {
      where: { id: playerId },
    });
    if (!player) {
      throw new NotFoundException(`Player '${playerId}' not found`);
    }

    const wallet = await this.dataSource.manager.findOne(Wallet, {
      where: { playerId },
    });

    const inventoryItems = await this.dataSource.manager.find(Inventory, {
      where: { playerId },
      order: { acquiredAt: 'ASC' },
    });

    const claims = await this.dataSource.manager.find(ClaimedReward, {
      where: { playerId },
      order: { claimedAt: 'ASC' },
    });

    return {
      balance: wallet ? wallet.balance : 0,
      inventory: inventoryItems.map((item) => item.itemId),
      claimedRewards: claims.map((claim) => claim.rewardId),
    };
  }
}
