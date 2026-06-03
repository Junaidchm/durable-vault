import { IsInt, Min, Max, IsString, IsNotEmpty } from 'class-validator';

export class CreditWalletDto {
  @IsInt()
  @Min(1)
  @Max(9000000000000000) // 9 Quadrillion (Safe limit for PostgreSQL bigint & JS Number)
  amount: number;

  @IsString()
  @IsNotEmpty()
  reason: string;
}
