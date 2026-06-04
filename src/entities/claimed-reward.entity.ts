import { Entity, PrimaryColumn, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Player } from './player.entity';

@Entity('claimed_rewards')
export class ClaimedReward {
  @PrimaryColumn({ type: 'varchar', length: 255, name: 'player_id' })
  playerId: string;

  @ManyToOne(() => Player, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'player_id' })
  player: Player;

  @PrimaryColumn({ type: 'varchar', length: 255, name: 'reward_id' })
  rewardId: string;

  @CreateDateColumn({ name: 'claimed_at', type: 'timestamp' })
  claimedAt: Date;
}
