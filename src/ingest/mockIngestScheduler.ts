import type { DecodedBatch } from '../types';

type DecodeResponse = {
  type: 'decoded';
  start: number;
  count: number;
  positions: Float32Array;
  colors: Float32Array;
  opacities: Float32Array;
};

export class MockIngestScheduler {
  private worker: Worker;

  constructor() {
    this.worker = new Worker(new URL('../workers/mockDecode.worker.ts', import.meta.url), { type: 'module' });
  }

  requestBatch(seed: number, start: number, count: number): Promise<DecodedBatch> {
    return new Promise((resolve) => {
      const onMessage = (event: MessageEvent<DecodeResponse>): void => {
        const msg = event.data;
        if (msg.type !== 'decoded') {
          return;
        }

        this.worker.removeEventListener('message', onMessage);
        resolve({
          start: msg.start,
          count: msg.count,
          positions: msg.positions,
          colors: msg.colors,
          opacities: msg.opacities
        });
      };

      this.worker.addEventListener('message', onMessage);
      this.worker.postMessage({ type: 'decode', seed, start, count });
    });
  }

  dispose(): void {
    this.worker.terminate();
  }
}
