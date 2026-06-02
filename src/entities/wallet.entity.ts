import { Entity, PrimaryColumn, Column, UpdateDateColumn, Check } from 'typeorm';

@Entity('wallets')
@Check(`"balance" >= 0`)
export class Wallet {
  @PrimaryColumn({ type: 'varchar', length: 255, name: 'player_id' })
  playerId: string;

  @Column({
    type: 'bigint',
    default: 0,
    transformer: {
      to: (value: number) => value,
      from: (value: string) => parseInt(value, 10),
    },
  })
  balance: number;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
  updatedAt: Date;
}
