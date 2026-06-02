import { Entity, PrimaryColumn, CreateDateColumn } from 'typeorm';

@Entity('players')
export class Player {
  @PrimaryColumn({ type: 'varchar', length: 255 })
  id: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt: Date;
}
