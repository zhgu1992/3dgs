import type { DecodedBatch } from '../types';
import { MockIngestScheduler } from './mockIngestScheduler';
import { computeHeaderLayoutHash, detectPlyHeaderByteLength, parsePlyHeader } from './plyHeaderParser';
import type {
  ByteRange,
  PlyDecodeRequest,
  PlyDecodeResponse,
  PlyHeaderLayout,
  PlyIngestMetrics,
  PlyIngestRunOptions,
  PlyIngestSchedulerOptions
} from './plyProtocol';
import { toByteRangeView } from './plyProtocol';

function emptyRange(): ByteRange {
  return {
    buffer: new ArrayBuffer(0),
    byteOffset: 0,
    byteLength: 0
  };
}

function concatUint8Arrays(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>
): Uint8Array<ArrayBufferLike> {
  const merged = new Uint8Array(left.byteLength + right.byteLength);
  merged.set(left, 0);
  merged.set(right, left.byteLength);
  return merged;
}

function copyToArrayBuffer(view: Uint8Array<ArrayBufferLike>): ArrayBuffer {
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy.buffer;
}

export class RealPlyIngestScheduler {
  private readonly worker: Worker;

  private readonly batchSize: number;

  private requestId = 1;

  private readonly pending = new Map<
    number,
    {
      resolve: (response: PlyDecodeResponse) => void;
      reject: (reason: unknown) => void;
    }
  >();

  constructor(options: PlyIngestSchedulerOptions = {}) {
    this.batchSize = options.batchSize ?? 65_536;
    this.worker = new Worker(new URL('../workers/plyDecode.worker.ts', import.meta.url), { type: 'module' });
    this.worker.addEventListener('message', (event: MessageEvent<PlyDecodeResponse>) => {
      const response = event.data;
      const pending = this.pending.get(response.requestId);
      if (!pending) {
        return;
      }
      this.pending.delete(response.requestId);
      pending.resolve(response);
    });
    this.worker.addEventListener('error', (event) => {
      const reason = event.error ?? new Error(event.message);
      for (const pending of this.pending.values()) {
        pending.reject(reason);
      }
      this.pending.clear();
    });
    this.worker.addEventListener('messageerror', () => {
      const reason = new Error('Failed to deserialize PLY decode worker message.');
      for (const pending of this.pending.values()) {
        pending.reject(reason);
      }
      this.pending.clear();
    });
  }

  dispose(): void {
    this.worker.terminate();
    this.pending.clear();
  }

  private decodeBatch(
    layout: PlyHeaderLayout,
    start: number,
    remainingVertices: number,
    chunk: ByteRange,
    carry: ByteRange | null
  ): Promise<PlyDecodeResponse> {
    const requestId = this.requestId;
    this.requestId += 1;

    return new Promise<PlyDecodeResponse>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      const request: PlyDecodeRequest = {
        type: 'decode',
        requestId,
        layout,
        chunk,
        carry,
        maxVertices: this.batchSize,
        remainingVertices,
        start
      };

      const transferables: ArrayBuffer[] = [];
      if (request.chunk.buffer instanceof ArrayBuffer) {
        transferables.push(request.chunk.buffer);
      }
      if (request.carry && request.carry.buffer instanceof ArrayBuffer) {
        transferables.push(request.carry.buffer);
      }
      this.worker.postMessage(request, transferables);
    });
  }

  private async flushBatchQueue(
    layout: PlyHeaderLayout,
    onBatch: (batch: DecodedBatch) => void,
    chunk: ByteRange,
    state: {
      carry: ByteRange | null;
      nextStart: number;
      totalDecodeMs: number;
      totalDecodedSplats: number;
      totalBatches: number;
    }
  ): Promise<void> {
    let currentChunk = chunk;
    while (true) {
      const remainingVertices = Math.max(0, layout.vertexCount - state.nextStart);
      if (remainingVertices === 0) {
        state.carry = null;
        return;
      }
      const response = await this.decodeBatch(layout, state.nextStart, remainingVertices, currentChunk, state.carry);
      if (response.batch.count === 0) {
        state.carry = response.nextCarry;
        state.totalDecodeMs += response.decodeMs;
        return;
      }

      onBatch(response.batch);
      state.totalDecodeMs += response.decodeMs;
      state.totalDecodedSplats += response.batch.count;
      state.totalBatches += 1;
      state.nextStart += response.batch.count;
      state.carry = response.nextCarry;

      if (
        !state.carry ||
        state.carry.byteLength < layout.stride ||
        response.batch.count < this.batchSize ||
        state.nextStart >= layout.vertexCount
      ) {
        return;
      }

      currentChunk = emptyRange();
    }
  }

  async ingest(url: string, options: PlyIngestRunOptions = {}): Promise<PlyIngestMetrics> {
    const onBatch = options.onBatch ?? (() => undefined);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch PLY source "${url}": ${response.status} ${response.statusText}`);
    }

    const state = {
      carry: null as ByteRange | null,
      nextStart: 0,
      totalDecodeMs: 0,
      totalDecodedSplats: 0,
      totalBatches: 0
    };

    let layout: PlyHeaderLayout | null = null;

    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      let headerAccumulator: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }

          if (!layout) {
            headerAccumulator = concatUint8Arrays(headerAccumulator, value);
            const headerByteLength = detectPlyHeaderByteLength(headerAccumulator);
            if (headerByteLength < 0) {
              continue;
            }

            const headerBytes = headerAccumulator.subarray(0, headerByteLength);
            layout = parsePlyHeader(copyToArrayBuffer(headerBytes));
            const bodyRemainder = headerAccumulator.subarray(layout.headerByteLength);
            headerAccumulator = new Uint8Array(0);
            if (bodyRemainder.byteLength > 0) {
              await this.flushBatchQueue(layout, onBatch, toByteRangeView(bodyRemainder), state);
            }
            continue;
          }

          await this.flushBatchQueue(layout, onBatch, toByteRangeView(value), state);
        }
      } finally {
        reader.releaseLock();
      }
    } else {
      const wholeBuffer = await response.arrayBuffer();
      layout = parsePlyHeader(wholeBuffer);
      const bodyByteLength = wholeBuffer.byteLength - layout.headerByteLength;
      if (bodyByteLength > 0) {
        await this.flushBatchQueue(
          layout,
          onBatch,
          {
            buffer: wholeBuffer,
            byteOffset: layout.headerByteLength,
            byteLength: bodyByteLength
          },
          state
        );
      }
    }

    if (!layout) {
      throw new Error(`PLY source "${url}" did not contain a valid header.`);
    }

    if (state.carry && state.carry.byteLength >= layout.stride) {
      await this.flushBatchQueue(layout, onBatch, emptyRange(), state);
    }

    const decodeMsPerBatch = state.totalBatches > 0 ? state.totalDecodeMs / state.totalBatches : 0;
    const decodedSplatsPerSec = state.totalDecodeMs > 0 ? (state.totalDecodedSplats / state.totalDecodeMs) * 1000 : 0;

    return {
      decodeMsPerBatch,
      decodedSplatsPerSec,
      headerLayoutHash: computeHeaderLayoutHash(layout),
      totalDecodedSplats: state.totalDecodedSplats,
      totalBatches: state.totalBatches
    };
  }
}

export function createIngestScheduler(options: PlyIngestSchedulerOptions = {}): MockIngestScheduler | RealPlyIngestScheduler {
  return options.useRealPly ? new RealPlyIngestScheduler(options) : new MockIngestScheduler();
}

export { RealPlyIngestScheduler as PlyIngestScheduler };
export { createIngestScheduler as createPlyIngestScheduler };
