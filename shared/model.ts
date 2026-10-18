export interface Dimensions {
  width: number;
  height: number;
  depth: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  dimensions: Dimensions;
  revision: string;
  expiresAt: string;
  viewerUrl: string;
  assetUrl: string;
}

export const MAX_MODEL_BYTES = 25 * 1024 * 1024;
export const LIFETIME_MS = 24 * 60 * 60 * 1000;
