import type { CameraState, ChunkTable, VisibleSet, VisibilityScheduler } from '../types';

export class BudgetVisibilityScheduler implements VisibilityScheduler {
  computeVisibleSet(_camera: CameraState, chunkTable: ChunkTable, config: { maxActiveSplats: number }): VisibleSet {
    const ids: number[] = [];
    let budget = config.maxActiveSplats;

    for (const chunk of chunkTable.chunks) {
      if (budget <= 0) {
        break;
      }
      const count = Math.min(chunk.count, budget);
      for (let i = 0; i < count; i += 1) {
        ids.push(chunk.start + i);
      }
      budget -= count;
    }

    return {
      ids: Uint32Array.from(ids),
      count: ids.length
    };
  }
}
