import { Entity, PrimaryColumn, Column, CreateDateColumn } from 'typeorm';

export enum IdempotencyStatus {
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
}

@Entity('idempotency_keys')
export class IdempotencyKey {
  @PrimaryColumn({ type: 'varchar', length: 255 })
  key: string;

  @Column({
    type: 'enum',
    enum: IdempotencyStatus,
    default: IdempotencyStatus.IN_PROGRESS,
  })
  status: IdempotencyStatus;

  @Column({ type: 'integer', name: 'response_status', nullable: true })
  responseStatus: number | null;

  @Column({ type: 'jsonb', name: 'response_body', nullable: true })
  responseBody: any | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt: Date;

  @Column({ name: 'expires_at', type: 'timestamp' })
  expiresAt: Date;
}
