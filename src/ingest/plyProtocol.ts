import type { DecodedBatch } from '../types';

export type ByteRange = {
  buffer: ArrayBufferLike;
  byteOffset: number;
  byteLength: number;
};

export type PlyHeaderLayout = {
  vertexCount: number;
  stride: number;
  offsets: Record<string, number>;
  propertyNames: string[];
  headerByteLength: number;
};

export type PlyDecodeRequest = {
  type: 'decode';
  requestId: number;
  layout: PlyHeaderLayout;
  chunk: ByteRange;
  carry: ByteRange | null;
  maxVertices: number;
  remainingVertices: number;
  start: number;
};

export type PlyDecodeResponse = {
  type: 'decoded';
  requestId: number;
  batch: DecodedBatch;
  nextCarry: ByteRange | null;
  decodeMs: number;
};

export type PlyIngestMetrics = {
  decodeMsPerBatch: number;
  decodedSplatsPerSec: number;
  headerLayoutHash: string;
  totalDecodedSplats: number;
  totalBatches: number;
};

export type PlyIngestSchedulerOptions = {
  useRealPly?: boolean;
  batchSize?: number;
};

export type PlyIngestRunOptions = {
  onBatch?: (batch: DecodedBatch) => void;
};

export function toByteRange(buffer: ArrayBufferLike): ByteRange {
  return {
    buffer,
    byteOffset: 0,
    byteLength: buffer.byteLength
  };
}

export function toByteRangeView(view: Uint8Array): ByteRange {
  return {
    buffer: view.buffer,
    byteOffset: view.byteOffset,
    byteLength: view.byteLength
  };
}

export function byteRangeLength(range: ByteRange | null): number {
  return range ? range.byteLength : 0;
}
