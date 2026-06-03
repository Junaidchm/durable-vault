import { Controller, Post, Get, Body, Param, HttpCode, HttpStatus, BadRequestException } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { CreditWalletDto } from '../dto/credit-wallet.dto';
import { PurchaseItemDto } from '../dto/purchase-item.dto';
import { ClaimRewardDto } from '../dto/claim-reward.dto';

@Controller()
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Post('v1/wallets/:playerId/credit')
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

  @Post('v1/wallets/:playerId/purchase')
  @HttpCode(HttpStatus.OK)
  async purchase(
    @Param('playerId') playerId: string,
    @Body() dto: PurchaseItemDto,
  ) {
    if (!playerId || playerId.trim() === '') {
      throw new BadRequestException('Player ID is required');
    }
    return await this.walletService.purchaseItem(playerId, dto.itemId, dto.price);
  }

  @Post('v1/rewards/:rewardId/claim')
  @HttpCode(HttpStatus.OK)
  async claimReward(
    @Param('rewardId') rewardId: string,
    @Body() dto: ClaimRewardDto,
  ) {
    if (!rewardId || rewardId.trim() === '') {
      throw new BadRequestException('Reward ID is required');
    }
    return await this.walletService.claimReward(rewardId, dto.playerId);
  }

  @Get('v1/wallets/:playerId')
  async getWallet(@Param('playerId') playerId: string) {
    if (!playerId || playerId.trim() === '') {
      throw new BadRequestException('Player ID is required');
    }
    return await this.walletService.getWalletState(playerId);
  }
}
