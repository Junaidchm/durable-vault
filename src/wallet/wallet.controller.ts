import { Controller, Post, Body, Param, HttpCode, HttpStatus, BadRequestException } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { CreditWalletDto } from '../dto/credit-wallet.dto';

@Controller('v1/wallets')
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Post(':playerId/credit')
  @HttpCode(HttpStatus.OK)
  async credit(
    @Param('playerId') playerId: string,
    @Body() dto: CreditWalletDto,
  ) {
    if (!playerId || playerId.trim() === '') {
      throw new BadRequestException('Player ID is required');
    }
    return await this.walletService.creditWallet(playerId, dto.amount, dto.reason);
  }
}
