import { BasicFpsController } from '../interaction/fpsController';
import { InputController } from '../interaction/inputController';
import { MockIngestScheduler } from '../ingest/mockIngestScheduler';
import { createPlyIngestScheduler, RealPlyIngestScheduler } from '../ingest/plyIngestScheduler';
import type { PlyIngestMetrics } from '../ingest/plyProtocol';
import { SplatRendererWebGL2 } from '../render/splatRendererWebgl2';
import { LinearChunkIndexBuilder } from '../scene/chunkIndexBuilder';
import { DepthSorterClient } from '../scene/depthSorterClient';
import { BudgetVisibilityScheduler } from '../scene/visibilityScheduler';
import { CameraStateStore } from '../stores/cameraStateStore';
import { GpuResidencyStore } from '../stores/gpuResidencyStore';
import { SceneSetStore } from '../stores/sceneSetStore';
import { SortStateStore } from '../stores/sortStateStore';
import { StatsOverlay } from '../debug/statsOverlay';

const CONFIG = {
  useRealPly: true,
  useEllipseShader: true,
  plyUrl: '/data/400w_3jie.ply',
  batchSize: 65_536,
  maxActiveSplats: 90_000,
  maxUploadBatchesPerFrame: 1,
  sortTargetIntervalMs: 33,
  mockBatchSize: 20_000,
  mockBatchCount: 4,
  devicePixelRatioClamp: 1
} as const;

export async function bootstrap(): Promise<void> {
  const canvas = document.createElement('canvas');
  canvas.style.position = 'fixed';
  canvas.style.inset = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  document.body.style.margin = '0';
  document.body.appendChild(canvas);

  const renderer = new SplatRendererWebGL2({ canvas, useEllipseShader: CONFIG.useEllipseShader });
  const overlay = new StatsOverlay();

  const cameraStore = new CameraStateStore(window.innerWidth / window.innerHeight);
  const sceneSetStore = new SceneSetStore();
  const sortStateStore = new SortStateStore();
  const gpuResidencyStore = new GpuResidencyStore();

  const input = new InputController(canvas);
  const fpsController = new BasicFpsController(cameraStore);

  const ingest = createPlyIngestScheduler({
    useRealPly: CONFIG.useRealPly,
    batchSize: CONFIG.batchSize
  });
  const depthSorter = new DepthSorterClient();
  const chunkBuilder = new LinearChunkIndexBuilder();
  const visibility = new BudgetVisibilityScheduler();

  let chunkTable = chunkBuilder.buildChunkIndex([]);
  let uploadedSplats = 0;
  let pendingBatches = 0;
  let lastUploadMs = 0;
  let chunkId = 0;
  const chunkMeta: Array<{ id: number; start: number; count: number }> = [];
  let ingestMetrics: PlyIngestMetrics | null = null;

  const refreshVisibleSet = (): void => {
    const visibleSet = visibility.computeVisibleSet(cameraStore.get(), chunkTable, {
      maxActiveSplats: CONFIG.maxActiveSplats
    });
    sceneSetStore.setActiveIds(visibleSet.ids);
  };

  if (ingest instanceof RealPlyIngestScheduler) {
    void ingest
      .ingest(CONFIG.plyUrl, {
        onBatch: (batch) => {
          gpuResidencyStore.enqueuePendingBatch(batch);
          pendingBatches = gpuResidencyStore.pendingBatchCount();
        }
      })
      .then((metrics) => {
        ingestMetrics = metrics;
      })
      .catch((error: unknown) => {
        console.error('PLY ingest failed', error);
      });
  } else if (ingest instanceof MockIngestScheduler) {
    void (async () => {
      for (let i = 0; i < CONFIG.mockBatchCount; i += 1) {
        const start = i * CONFIG.mockBatchSize;
        const batch = await ingest.requestBatch(7, start, CONFIG.mockBatchSize);
        gpuResidencyStore.enqueuePendingBatch(batch);
        pendingBatches = gpuResidencyStore.pendingBatchCount();
      }
    })();
  }

  refreshVisibleSet();

  function resize(): void {
    const ratio = Math.min(window.devicePixelRatio || 1, CONFIG.devicePixelRatioClamp);
    const width = Math.max(1, Math.floor(window.innerWidth * ratio));
    const height = Math.max(1, Math.floor(window.innerHeight * ratio));
    canvas.width = width;
    canvas.height = height;
    renderer.resize(width, height);
    cameraStore.resize(width / height);
  }

  resize();
  window.addEventListener('resize', resize);

  let previousTime = performance.now();
  let lastSortKick = 0;
  let lastSortMs = 0;

  const tick = (): void => {
    const now = performance.now();
    const dtMs = now - previousTime;
    previousTime = now;

    const inputSnapshot = input.snapshot();
    const camera = fpsController.updateFpsController(inputSnapshot, dtMs / 1000);

    const uploadDrain = gpuResidencyStore.drainPendingUploads(CONFIG.maxUploadBatchesPerFrame, (batch) => {
      const range = renderer.uploadBatch(batch);
      chunkMeta.push({ id: chunkId, start: range.start, count: range.count });
      chunkId += 1;
      return range;
    });
    lastUploadMs = uploadDrain.uploadMs;
    pendingBatches = uploadDrain.pendingBatches;
    if (uploadDrain.uploadedBatches > 0) {
      uploadedSplats = uploadDrain.totalUploadedSplats;
      chunkTable = chunkBuilder.buildChunkIndex(chunkMeta);
      refreshVisibleSet();
    }

    const shouldSort =
      now - camera.movedAtMs < 200 &&
      now - lastSortKick >= CONFIG.sortTargetIntervalMs &&
      !depthSorter.isBusy();

    if (shouldSort) {
      lastSortKick = now;
      void depthSorter.sort(sceneSetStore.getActiveIds(), renderer.getPositions(), camera).then((result) => {
        sortStateStore.setBack(result.indices);
        lastSortMs = result.sortMs;
      });
    }

    sortStateStore.swapIfReady();
    const frameStats = renderer.renderFrame(camera, sortStateStore.getFront(), uploadedSplats, dtMs);
    frameStats.uploadMs = lastUploadMs;
    frameStats.pendingBatches = pendingBatches;
    overlay.update(frameStats, lastSortMs, ingestMetrics);

    requestAnimationFrame(tick);
  };

  requestAnimationFrame(tick);
}
