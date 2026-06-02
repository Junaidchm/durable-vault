import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('inventories')
@Index(['playerId'])
export class Inventory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255, name: 'player_id' })
  playerId: string;

  @Column({ type: 'varchar', length: 255, name: 'item_id' })
  itemId: string;

  @CreateDateColumn({ name: 'acquired_at', type: 'timestamp' })
  acquiredAt: Date;
}
