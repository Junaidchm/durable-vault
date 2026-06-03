export const ITEM_CATALOG: Record<string, number> = {
  sword: 100,
  shield: 150,
  potion: 50,
};

export function getCatalogPrice(itemId: string): number | null {
  const price = ITEM_CATALOG[itemId];
  return price !== undefined ? price : null;
}
