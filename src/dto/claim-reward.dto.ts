import { IsString, IsNotEmpty } from 'class-validator';

export class ClaimRewardDto {
  @IsString()
  @IsNotEmpty()
  playerId: string;
}
