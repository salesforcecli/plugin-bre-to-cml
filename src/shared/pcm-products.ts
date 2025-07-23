import { Connection } from '@salesforce/core';
import { PCMProduct, PCMProductComponentGroup } from './pcm-products.types.js';

const PCM_PRODUCTS_BULK_LIMIT = 20;
const PCM_PRODUCTS_BULK_URI = '/connect/pcm/products/bulk';

export type ProductWithIds = {
  product: PCMProduct;
  productIds: string[];
};

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

export function reduceProducts(productMap: Map<string, PCMProduct>): Map<string, ProductWithIds> {
  const newMap = new Map<string, ProductWithIds>();
  for (const [productId, product] of productMap) {
    newMap.set(productId, { product, productIds: collectProductIds(product) });
  }
  for (const [productId] of productMap) {
    for (const [, bundleProduct] of newMap) {
      if (isBundleContainsProduct(bundleProduct.product, productId)) {
        newMap.delete(productId);
        break;
      }
    }
  }
  return newMap;
}

export function isBundleContainsProduct(bundleProduct: PCMProduct, productId: string): boolean {
  if (bundleProduct.nodeType !== 'bundleProduct') {
    return false;
  }
  for (const childProduct of bundleProduct.childProducts) {
    if (childProduct.id === productId) {
      return true;
    }
    const isContains = isBundleContainsProduct(childProduct, productId);
    if (isContains) {
      return true;
    }
  }
  return bundleProduct.productComponentGroups.some((pcg) => isProductComponentGroupContainsProductId(pcg, productId));
}

function isProductComponentGroupContainsProductId(
  productComponentGroup: PCMProductComponentGroup,
  productId: string,
): boolean {
  return (
    productComponentGroup.components.some(
      (comp) => comp.id === productId || isBundleContainsProduct(comp, productId),
    ) || productComponentGroup.childGroups.some((cg) => isProductComponentGroupContainsProductId(cg, productId))
  );
}

function collectProductIds(bundleProduct: PCMProduct): string[] {
  const productIds = new Set<string>([bundleProduct.id]);
  if (bundleProduct.nodeType === 'bundleProduct') {
    for (const childProduct of bundleProduct.childProducts) {
      productIds.add(childProduct.id);
      if (childProduct.nodeType === 'bundleProduct') {
        collectProductIds(childProduct).forEach((id) => productIds.add(id));
      }
    }
    for (const pcg of bundleProduct.productComponentGroups) {
      collectProductIdsInProductComponentGroup(pcg).forEach((id) => productIds.add(id));
    }
  }
  return Array.from(productIds);
}

function collectProductIdsInProductComponentGroup(productComponentGroup: PCMProductComponentGroup): Set<string> {
  const productIds = new Set<string>();
  for (const comp of productComponentGroup.components) {
    collectProductIds(comp).forEach((id) => productIds.add(id));
  }
  for (const cg of productComponentGroup.childGroups) {
    collectProductIdsInProductComponentGroup(cg).forEach((id) => productIds.add(id));
  }
  return productIds;
}
