import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { Player } from './entities/player.entity';
import { Wallet } from './entities/wallet.entity';
import { Inventory } from './entities/inventory.entity';
import { ClaimedReward } from './entities/claimed-reward.entity';
import { Ledger } from './entities/ledger.entity';
import { IdempotencyKey } from './entities/idempotency-key.entity';
import { WalletModule } from './wallet/wallet.module';
import { IdempotencyInterceptor } from './interceptors/idempotency.interceptor';

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
      synchronize: true,
      logging: false,
    }),
    WalletModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_INTERCEPTOR,
      useClass: IdempotencyInterceptor,
    },
  ],
})
export class AppModule {}
