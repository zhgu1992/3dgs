import type { mat4, vec3 } from 'gl-matrix';

export type PLYLayout = {
  stride: number;
  offsets: Record<string, number>;
  vertexCount: number;
};

export type DecodedBatch = {
  start: number;
  count: number;
  positions: Float32Array;
  colors: Float32Array;
  opacities: Float32Array;
};

export type ChunkMeta = {
  id: number;
  start: number;
  count: number;
};

export type ChunkTable = {
  chunks: ChunkMeta[];
};

export type VisibleSet = {
  ids: Uint32Array;
  count: number;
};

export type CameraState = {
  position: vec3;
  yaw: number;
  pitch: number;
  view: mat4;
  projection: mat4;
  viewProjection: mat4;
  movedAtMs: number;
};

export type FrameStats = {
  fps: number;
  dtMs: number;
  drawMs: number;
  uploadedSplats: number;
  activeSplats: number;
  sortReady: boolean;
};

export type GpuHandleRange = {
  start: number;
  count: number;
};

export interface PlyHeaderParser {
  parsePlyHeader(buffer: ArrayBuffer): PLYLayout;
}

export interface PlyBodyDecoder {
  decodeBatch(payload: { seed: number; count: number }): Promise<DecodedBatch>;
}

export interface ChunkIndexBuilder {
  buildChunkIndex(batchMeta: ChunkMeta[]): ChunkTable;
}

export interface VisibilityScheduler {
  computeVisibleSet(camera: CameraState, chunkTable: ChunkTable, config: { maxActiveSplats: number }): VisibleSet;
}

export interface DepthSorter {
  sortDepth(activeSplats: Uint32Array, camera: CameraState): Promise<Uint32Array>;
}

export interface GpuUploader {
  uploadBatch(decodedBatch: DecodedBatch): GpuHandleRange;
}

export interface FrameRenderer {
  renderFrame(camera: CameraState, sortedIndices: Uint32Array | null, gpuRanges: GpuHandleRange[]): FrameStats;
}

export interface FpsController {
  updateFpsController(input: InputSnapshot, dt: number): CameraState;
}

export type InputSnapshot = {
  forward: number;
  right: number;
  up: number;
  lookDeltaX: number;
  lookDeltaY: number;
  speedBoost: boolean;
};
