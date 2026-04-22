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
  useRadixSort: true,
  useVisibilityBudget: true,
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
  // 全屏 canvas：当前项目只有一个渲染目标，直接铺满视口。
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

  // 2C 之前先走线性 chunk，可见集在每次驻留更新后重算。
  const refreshVisibleSet = (): void => {
    if (!CONFIG.useVisibilityBudget) {
      const ids = new Uint32Array(uploadedSplats);
      for (let i = 0; i < uploadedSplats; i += 1) {
        ids[i] = i;
      }
      sceneSetStore.setActiveIds(ids);
      return;
    }

    const visibleSet = visibility.computeVisibleSet(cameraStore.get(), chunkTable, {
      maxActiveSplats: CONFIG.maxActiveSplats
    });
    sceneSetStore.setActiveIds(visibleSet.ids);
  };

  if (ingest instanceof RealPlyIngestScheduler) {
    // 实际 PLY 解码在后台持续产出批次，主线程只负责入队。
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
    // mock 路径保持同一套“先入队、再按帧上传”的节奏，便于回归对比。
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
  let lastSortedCount = 0;
  let sortStallFrames = 0;

  const tick = (): void => {
    const now = performance.now();
    const dtMs = now - previousTime;
    previousTime = now;

    const inputSnapshot = input.snapshot();
    const camera = fpsController.updateFpsController(inputSnapshot, dtMs / 1000);

    // 每帧限额上传，避免一次性上传导致主线程长时间阻塞。
    const uploadDrain = gpuResidencyStore.drainPendingUploads(CONFIG.maxUploadBatchesPerFrame, (batch) => {
      const range = renderer.uploadBatch(batch);
      chunkMeta.push({ id: chunkId, start: range.start, count: range.count });
      chunkId += 1;
      return range;
    });
    lastUploadMs = uploadDrain.uploadMs;
    pendingBatches = uploadDrain.pendingBatches;
    if (uploadDrain.uploadedBatches > 0) {
      // 只有驻留集合变化时才更新 chunk/visible，减少不必要计算。
      uploadedSplats = uploadDrain.totalUploadedSplats;
      chunkTable = chunkBuilder.buildChunkIndex(chunkMeta);
      refreshVisibleSet();
    }

    const shouldSort =
      CONFIG.useRadixSort &&
      now - camera.movedAtMs < 200 &&
      now - lastSortKick >= CONFIG.sortTargetIntervalMs &&
      !depthSorter.isBusy();

    if (shouldSort) {
      // 排序异步执行：渲染线程用 front buffer，worker 产出 back buffer。
      lastSortKick = now;
      void depthSorter.sort(sceneSetStore.getActiveIds(), renderer.getPositions(), camera).then((result) => {
        sortStateStore.setBack(result.indices);
        lastSortMs = result.sortMs;
        lastSortedCount = result.indices.length;
      });
    }

    const swapped = sortStateStore.swapIfReady();
    const frontIndices = CONFIG.useRadixSort ? sortStateStore.getFront() : null;

    if (CONFIG.useRadixSort && now - camera.movedAtMs < 200 && depthSorter.isBusy() && !swapped && frontIndices !== null) {
      sortStallFrames += 1;
    }

    const frameStats = renderer.renderFrame(camera, frontIndices, uploadedSplats, dtMs);
    frameStats.uploadMs = lastUploadMs;
    frameStats.pendingBatches = pendingBatches;
    frameStats.sortedCount = CONFIG.useRadixSort ? lastSortedCount : sceneSetStore.getActiveIds().length;
    frameStats.sortStallFrames = CONFIG.useRadixSort ? sortStallFrames : 0;
    overlay.update(frameStats, lastSortMs, ingestMetrics);

    requestAnimationFrame(tick);
  };

  requestAnimationFrame(tick);
}
