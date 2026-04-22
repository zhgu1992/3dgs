import type { FrameStats } from '../types';
import type { PlyIngestMetrics } from '../ingest/plyProtocol';

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

  update(stats: FrameStats, sortMs: number, ingestMetrics?: PlyIngestMetrics | null): void {
    const lines = [
      `fps: ${stats.fps.toFixed(1)}`,
      `dt_ms: ${stats.dtMs.toFixed(2)}`,
      `draw_ms: ${stats.drawMs.toFixed(2)}`,
      `upload_ms: ${(stats.uploadMs ?? 0).toFixed(2)}`,
      `sort_ms: ${sortMs.toFixed(2)}`,
      `sorted_count: ${stats.sortedCount ?? 0}`,
      `sort_stall_frames: ${stats.sortStallFrames ?? 0}`,
      `active_splats: ${stats.activeSplats}`,
      `uploaded_splats: ${stats.uploadedSplats}`,
      `pending_batches: ${stats.pendingBatches ?? 0}`,
      `sort_ready: ${stats.sortReady ? 'yes' : 'no'}`
    ];
    if (typeof stats.discardRatio === 'number') {
      lines.push(`discard_ratio: ${(stats.discardRatio * 100).toFixed(1)}%`);
    }
    if (ingestMetrics) {
      lines.push(`decode_ms_per_batch: ${ingestMetrics.decodeMsPerBatch.toFixed(2)}`);
      lines.push(`decoded_splats_per_sec: ${ingestMetrics.decodedSplatsPerSec.toFixed(0)}`);
      lines.push(`header_layout_hash: ${ingestMetrics.headerLayoutHash}`);
    }
    this.node.textContent = lines.join('\n');
    this.node.style.whiteSpace = 'pre';
  }
}
