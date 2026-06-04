import { Entity, PrimaryColumn, Column, UpdateDateColumn, Check, OneToOne, JoinColumn } from 'typeorm';
import { Player } from './player.entity';

@Entity('wallets')
@Check(`"balance" >= 0`)
export class Wallet {
  @PrimaryColumn({ type: 'varchar', length: 255, name: 'player_id' })
  playerId: string;

  @OneToOne(() => Player, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'player_id' })
  player: Player;

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
