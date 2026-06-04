export const REWARD_CATALOG: Record<string, number> = {
  welcome: 100,
  special: 500,
};

export function getRewardPayout(rewardId: string): number | null {
  const payout = REWARD_CATALOG[rewardId];
  return payout !== undefined ? payout : null;
}
