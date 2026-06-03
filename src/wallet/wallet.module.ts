import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { Wallet } from '../entities/wallet.entity';
import { Player } from '../entities/player.entity';
import { Ledger } from '../entities/ledger.entity';
import { Inventory } from '../entities/inventory.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Wallet, Player, Ledger, Inventory])],
  controllers: [WalletController],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
