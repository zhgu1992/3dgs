import type { InputSnapshot } from '../types';

export class InputController {
  private readonly keys = new Set<string>();
  private lookDeltaX = 0;
  private lookDeltaY = 0;
  private dragging = false;

  constructor(private readonly target: HTMLElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousemove', this.onMouseMove);
    target.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    this.target.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
  }

  snapshot(): InputSnapshot {
    const snapshot: InputSnapshot = {
      forward: Number(this.keys.has('KeyW')) - Number(this.keys.has('KeyS')),
      right: Number(this.keys.has('KeyD')) - Number(this.keys.has('KeyA')),
      up: Number(this.keys.has('Space')) - Number(this.keys.has('ShiftLeft')),
      lookDeltaX: this.lookDeltaX,
      lookDeltaY: this.lookDeltaY,
      speedBoost: this.keys.has('ShiftRight')
    };

    this.lookDeltaX = 0;
    this.lookDeltaY = 0;
    return snapshot;
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    this.keys.add(event.code);
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private onMouseMove = (event: MouseEvent): void => {
    if (!this.dragging) {
      return;
    }
    this.lookDeltaX += event.movementX;
    this.lookDeltaY += event.movementY;
  };

  private onMouseDown = (): void => {
    this.dragging = true;
  };

  private onMouseUp = (): void => {
    this.dragging = false;
  };
}
