import type { GpuHandleRange } from '../types';

export class GpuResidencyStore {
  private ranges: GpuHandleRange[] = [];

  addRange(range: GpuHandleRange): void {
    this.ranges.push(range);
  }

  getRanges(): GpuHandleRange[] {
    return this.ranges;
  }
}
