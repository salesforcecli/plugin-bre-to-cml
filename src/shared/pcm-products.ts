import { Connection } from '@salesforce/core';
import { PCMProduct } from './pcm-products.types.js';

const PCM_PRODUCTS_BULK_LIMIT = 20;
const PCM_PRODUCTS_BULK_URI = '/connect/pcm/products/bulk';

export async function fetchProductsFromPcm(
  conn: Connection,
  allProductIds: string[],
): Promise<Map<string, PCMProduct>> {
  const chunk = (arr: string[], size: number): string[][] =>
    Array.from({ length: Math.ceil(arr.length / size) }, (v, i) => arr.slice(i * size, i * size + size));

  const getPostBulkBody = (
    productIds: string[],
  ): {
    correlationId: string;
    productIds: string[];
    uptoLevel?: number;
    additionalFields?: string[];
  } => ({
    correlationId: `${Date.now()}`,
    productIds,
  });

  const fetchPromises = chunk(allProductIds, PCM_PRODUCTS_BULK_LIMIT).map(async (productIds) =>
    conn.requestPost<{ products: PCMProduct[] }>(PCM_PRODUCTS_BULK_URI, getPostBulkBody(productIds)),
  );
  const allProducts = new Map<string, PCMProduct>();
  (await Promise.all(fetchPromises)).flatMap((resp) => resp.products).forEach((p) => allProducts.set(p.id, p));
  return allProducts;
}
