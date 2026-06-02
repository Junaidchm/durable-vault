import { Entity, PrimaryColumn, CreateDateColumn } from 'typeorm';

@Entity('claimed_rewards')
export class ClaimedReward {
  @PrimaryColumn({ type: 'varchar', length: 255, name: 'player_id' })
  playerId: string;

  @PrimaryColumn({ type: 'varchar', length: 255, name: 'reward_id' })
  rewardId: string;

  @CreateDateColumn({ name: 'claimed_at', type: 'timestamp' })
  claimedAt: Date;
}
