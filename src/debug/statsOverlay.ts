import type { FrameStats } from '../types';

export class StatsOverlay {
  private readonly node: HTMLDivElement;

  constructor() {
    this.node = document.createElement('div');
    Object.assign(this.node.style, {
      position: 'fixed',
      top: '12px',
      left: '12px',
      padding: '8px 10px',
      background: 'rgba(0,0,0,0.55)',
      color: '#d9f2ff',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: '12px',
      lineHeight: '1.5',
      border: '1px solid rgba(140,180,255,0.35)',
      borderRadius: '8px',
      pointerEvents: 'none'
    });
    document.body.appendChild(this.node);
  }

  update(stats: FrameStats, sortMs: number): void {
    this.node.textContent = [
      `fps: ${stats.fps.toFixed(1)}`,
      `dt_ms: ${stats.dtMs.toFixed(2)}`,
      `draw_ms: ${stats.drawMs.toFixed(2)}`,
      `sort_ms: ${sortMs.toFixed(2)}`,
      `active_splats: ${stats.activeSplats}`,
      `uploaded_splats: ${stats.uploadedSplats}`,
      `sort_ready: ${stats.sortReady ? 'yes' : 'no'}`
    ].join('\n');
    this.node.style.whiteSpace = 'pre';
  }
}
