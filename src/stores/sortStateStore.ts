export class SortStateStore {
  private front: Uint32Array | null = null;
  private back: Uint32Array | null = null;

  getFront(): Uint32Array | null {
    return this.front;
  }

  setBack(indices: Uint32Array): void {
    this.back = indices;
  }

  swapIfReady(): boolean {
    if (!this.back) {
      return false;
    }

    this.front = this.back;
    this.back = null;
    return true;
  }
}
