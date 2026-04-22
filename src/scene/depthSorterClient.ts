import type { CameraState } from '../types';

type SortResponse = {
  type: 'sorted';
  indices: Uint32Array;
  sortMs: number;
};

export class DepthSorterClient {
  private worker: Worker;
  private busy = false;

  constructor() {
    this.worker = new Worker(new URL('../workers/depthSort.worker.ts', import.meta.url), { type: 'module' });
  }

  isBusy(): boolean {
    return this.busy;
  }

  sort(activeIds: Uint32Array, positions: Float32Array, camera: CameraState): Promise<{ indices: Uint32Array; sortMs: number }> {
    this.busy = true;
    return new Promise((resolve) => {
      const onMessage = (event: MessageEvent<SortResponse>): void => {
        const msg = event.data;
        if (msg.type !== 'sorted') {
          return;
        }

        this.worker.removeEventListener('message', onMessage);
        this.busy = false;
        resolve({ indices: msg.indices, sortMs: msg.sortMs });
      };

      this.worker.addEventListener('message', onMessage);
      this.worker.postMessage({
        type: 'sort',
        activeIds,
        positions,
        view: new Float32Array(camera.view)
      });
    });
  }

  dispose(): void {
    this.worker.terminate();
  }
}
