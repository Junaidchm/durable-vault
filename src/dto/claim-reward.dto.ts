import { IsString, IsNotEmpty, Length } from 'class-validator';

export class ClaimRewardDto {
  @IsString()
  @IsNotEmpty()
  @Length(1, 255)
  playerId: string;
}
