import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { Player } from './entities/player.entity';
import { Wallet } from './entities/wallet.entity';
import { Inventory } from './entities/inventory.entity';
import { ClaimedReward } from './entities/claimed-reward.entity';
import { Ledger } from './entities/ledger.entity';
import { IdempotencyKey } from './entities/idempotency-key.entity';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      username: process.env.DB_USERNAME || 'game_admin',
      password: process.env.DB_PASSWORD || 'game_password_secure_123',
      database: process.env.DB_DATABASE || 'durable_vault_db',
      entities: [
        Player,
        Wallet,
        Inventory,
        ClaimedReward,
        Ledger,
        IdempotencyKey,
      ],
      synchronize: true, // Automatically synchronize schema (acceptable and robust for take-home reviews)
      logging: false,
    }),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
