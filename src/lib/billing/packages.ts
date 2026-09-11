export interface CreditPackage {
  id: string;
  label: string;
  credits: number;
  priceThb: number;
}

export const CREDIT_PACKAGES: CreditPackage[] = [
  { id: "starter", label: "Starter", credits: 500, priceThb: 199 },
  { id: "creator", label: "Creator", credits: 1500, priceThb: 499 },
  { id: "pro", label: "Pro", credits: 5000, priceThb: 1499 },
];

export function getCreditPackage(id: string): CreditPackage | undefined {
  return CREDIT_PACKAGES.find((p) => p.id === id);
}
