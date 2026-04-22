import { mat4, vec3 } from 'gl-matrix';
import type { CameraState, FpsController, InputSnapshot } from '../types';
import { CameraStateStore } from '../stores/cameraStateStore';

export class BasicFpsController implements FpsController {
  constructor(private readonly cameraStore: CameraStateStore) {}

  updateFpsController(input: InputSnapshot, dt: number): CameraState {
    const state = this.cameraStore.get();
    const nextPosition = vec3.clone(state.position);
    const speed = input.speedBoost ? 8 : 3;
    const distance = speed * dt;

    const yaw = state.yaw - input.lookDeltaX * 0.0025;
    const pitch = Math.max(-1.4, Math.min(1.4, state.pitch - input.lookDeltaY * 0.0025));

    const forward = vec3.fromValues(
      Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      Math.cos(yaw) * Math.cos(pitch)
    );
    vec3.normalize(forward, forward);
    const right = vec3.fromValues(Math.cos(yaw), 0, -Math.sin(yaw));
    vec3.normalize(right, right);

    vec3.scaleAndAdd(nextPosition, nextPosition, forward, input.forward * distance);
    vec3.scaleAndAdd(nextPosition, nextPosition, right, input.right * distance);
    nextPosition[1] += input.up * distance;

    const target = vec3.create();
    vec3.add(target, nextPosition, forward);

    const view = mat4.create();
    mat4.lookAt(view, nextPosition, target, vec3.fromValues(0, 1, 0));

    const viewProjection = mat4.create();
    mat4.multiply(viewProjection, state.projection, view);

    const moved =
      input.forward !== 0 ||
      input.right !== 0 ||
      input.up !== 0 ||
      input.lookDeltaX !== 0 ||
      input.lookDeltaY !== 0;

    const next: CameraState = {
      ...state,
      position: nextPosition,
      yaw,
      pitch,
      view,
      viewProjection,
      movedAtMs: moved ? performance.now() : state.movedAtMs
    };

    this.cameraStore.set(next);
    return next;
  }
}
