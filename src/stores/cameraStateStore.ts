import { mat4, vec3 } from 'gl-matrix';
import type { CameraState } from '../types';

export class CameraStateStore {
  private state: CameraState;

  constructor(aspect: number) {
    const position = vec3.fromValues(0, 0, 5);
    const view = mat4.create();
    const projection = mat4.create();
    const viewProjection = mat4.create();
    mat4.perspective(projection, Math.PI / 3, aspect, 0.01, 200);
    mat4.lookAt(view, position, vec3.fromValues(0, 0, 0), vec3.fromValues(0, 1, 0));
    mat4.multiply(viewProjection, projection, view);

    this.state = {
      position,
      yaw: 0,
      pitch: 0,
      view,
      projection,
      viewProjection,
      movedAtMs: performance.now()
    };
  }

  get(): CameraState {
    return this.state;
  }

  set(next: CameraState): void {
    this.state = next;
  }

  resize(aspect: number): void {
    mat4.perspective(this.state.projection, Math.PI / 3, aspect, 0.01, 200);
    mat4.multiply(this.state.viewProjection, this.state.projection, this.state.view);
  }
}
