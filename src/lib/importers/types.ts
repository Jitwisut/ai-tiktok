export interface ProductData {
  name: string;
  description?: string;
  price?: number;
  currency?: string;
  images?: string[];
  sourceUrl?: string;
  sellerName?: string;
}

export interface ProductImporter {
  source: string;
  import(input: string): Promise<ProductData>;
}
