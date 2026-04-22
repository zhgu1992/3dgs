export class SceneSetStore {
  private activeIds: Uint32Array = new Uint32Array();

  getActiveIds(): Uint32Array {
    return this.activeIds;
  }

  setActiveIds(ids: Uint32Array): void {
    this.activeIds = ids;
  }
}
