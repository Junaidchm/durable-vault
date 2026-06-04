import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index, ManyToOne, JoinColumn } from 'typeorm';
import { Player } from './player.entity';

@Entity('inventories')
@Index(['playerId'])
export class Inventory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255, name: 'player_id' })
  playerId: string;

  @ManyToOne(() => Player, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'player_id' })
  player: Player;

  @Column({ type: 'varchar', length: 255, name: 'item_id' })
  itemId: string;

  @CreateDateColumn({ name: 'acquired_at', type: 'timestamp' })
  acquiredAt: Date;
}
