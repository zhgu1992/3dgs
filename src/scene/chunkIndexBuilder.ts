import type { ChunkIndexBuilder, ChunkMeta, ChunkTable } from '../types';

export class LinearChunkIndexBuilder implements ChunkIndexBuilder {
  buildChunkIndex(batchMeta: ChunkMeta[]): ChunkTable {
    return { chunks: batchMeta };
  }
}
