import type { DecodedBatch, GpuHandleRange, UploadDrainStats } from '../types';

export class GpuResidencyStore {
  private uploadedRanges: GpuHandleRange[] = [];

  private pendingBatches: DecodedBatch[] = [];

  private pendingHead = 0;

  private totalUploadedSplats = 0;

  enqueuePendingBatch(batch: DecodedBatch): void {
    this.pendingBatches.push(batch);
  }

  hasPendingBatches(): boolean {
    return this.pendingHead < this.pendingBatches.length;
  }

  pendingBatchCount(): number {
    return this.pendingBatches.length - this.pendingHead;
  }

  recordUploadedRange(range: GpuHandleRange): void {
    this.uploadedRanges.push(range);
    this.totalUploadedSplats += range.count;
  }

  drainPendingUploads(
    maxBatches: number,
    upload: (batch: DecodedBatch) => GpuHandleRange
  ): UploadDrainStats {
    const cappedBatches = Math.max(0, maxBatches);
    if (cappedBatches === 0 || !this.hasPendingBatches()) {
      return {
        uploadMs: 0,
        uploadedBatches: 0,
        uploadedSplats: 0,
        pendingBatches: this.pendingBatchCount(),
        totalUploadedSplats: this.totalUploadedSplats
      };
    }

    const startTime = performance.now();
    let uploadedBatches = 0;
    let uploadedSplats = 0;

    while (uploadedBatches < cappedBatches && this.pendingHead < this.pendingBatches.length) {
      const batch = this.pendingBatches[this.pendingHead];
      this.pendingHead += 1;

      const range = upload(batch);
      this.recordUploadedRange(range);

      uploadedBatches += 1;
      uploadedSplats += range.count;
    }

    if (this.pendingHead > 0 && this.pendingHead >= this.pendingBatches.length) {
      this.pendingBatches = [];
      this.pendingHead = 0;
    }

    return {
      uploadMs: performance.now() - startTime,
      uploadedBatches,
      uploadedSplats,
      pendingBatches: this.pendingBatchCount(),
      totalUploadedSplats: this.totalUploadedSplats
    };
  }

  getRanges(): GpuHandleRange[] {
    return this.uploadedRanges;
  }

  getTotalUploadedSplats(): number {
    return this.totalUploadedSplats;
  }
}
