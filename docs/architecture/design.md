# PlayCanvas 思路落地方案（原始 PLY 直读）

## 1. 目标与约束
- 目标：在 Chrome（桌面）中实现 WebGL2 3DGS 浏览器，支持加载 `data/400w_3jie.ply` 并进行简单第一人称漫游。
- 已锁定约束：
  - 运行时只使用原始 PLY（不做离线压缩格式）。
  - 首版着色先做 SH0（`f_dc_0..2`），高阶 SH 后续扩展。
  - 第一人称控制为简单浏览模式（无碰撞、无重力物理）。
  - 目标保留 1080p 60fps，但接受在该约束下可能无法完全达标。

## 2. 核心模块设计
1. `PlyHeaderParser`
- 解析 PLY header，输出字段偏移与布局信息。
- 固定每条记录 `stride = 62 * 4 = 248 bytes`。

2. `PlyStreamLoader`
- 采用批次流式读取（建议 `batchSize=65536 splats`）。
- 避免一次性创建全量对象，控制主线程内存峰值。

3. `RuntimeSpatialIndex`
- 按批次建立 chunk AABB，用于可见性筛选。
- 首版可用“每批次一块”的简化分块策略。

4. `VisibilityScheduler`
- 进行 frustum + 距离预算筛选，生成 active splats。
- 提供 `maxActiveSplats` 配置用于性能档位控制。

5. `DepthSorterWorker`
- Worker 中计算深度 key 并排序。
- 输出 `sortedIndices`（按 back-to-front）。

6. `SplatRendererWebGL2`
- 维护属性纹理、索引缓冲、shader program、draw call。
- 负责数据上传节奏控制与渲染统计。

7. `FpsController`
- 提供 WASD + 鼠标视角 + Shift 加速。
- 输出 `CameraState`（view/proj/position/forward）。

## 3. 每帧渲染流程
1. `fpsController.update(dt)` 更新相机状态。
2. `visibilityScheduler.update(camera)` 生成 `activeIndices`。
3. 判断是否触发重排：
- 位移 > `0.05m`，或
- 旋转 > `1.5°`，或
- 每 `8` 帧强制重排一次。
4. `depthSorterWorker.sort(activeIndices, camera)` 生成 `sortedIndices`。
5. `renderer.draw(sortedIndices, camera)` 执行 splat pass。
6. 更新调试指标：`fps/sort ms/upload ms/active splats`。

## 4. Shader 设计（首版）

### 4.1 Vertex Shader
- 通过 `gl_InstanceID + sortedIndices` 获取 splat id。
- 从纹理读取并解码：`position/scale/quat/opacity/sh0RGB`。
- 计算协方差：`Sigma3D = R(quat) * diag(scale^2) * R^T`。
- 投影为屏幕空间 `Sigma2D`，展开 unit quad 成椭圆 splat。
- 输出片元阶段所需局部坐标参数。

### 4.2 Fragment Shader
- 计算 `r2 = p^T * inv(Sigma2D) * p`。
- `alpha = opacity * exp(-0.5 * r2)`。
- `alpha < 1/255` 时 discard 降低 fill-rate。
- 颜色使用 SH0（常量 RGB）。
- 使用预乘 alpha 输出。

### 4.3 混合与顺序
- blend 固定：`SRC_ALPHA, ONE_MINUS_SRC_ALPHA`。
- 绘制顺序固定 back-to-front，依赖 worker 排序结果。

## 5. GPU 数据打包约定（首版）
- `T0 (RGBA32F)`: `pos.xyz, opacity`
- `T1 (RGBA16F)`: `scale.xyz, quat.x`
- `T2 (RGBA16F)`: `quat.yzw, sh0.r`
- `T3 (RGBA16F)`: `sh0.g, sh0.b, reserved, reserved`
- `sortedIndices`: `Uint32Array`（每轮重排后上传）

## 6. 建议公开接口
```ts
interface CameraState {
  view: Mat4;
  proj: Mat4;
  position: Vec3;
  forward: Vec3;
}

interface RendererConfig {
  targetFps: 60;
  maxActiveSplats: number;
  sortIntervalFrames: number;
}

interface PLYLayout {
  vertexCount: number;
  strideBytes: 248;
  offsets: Record<string, number>;
}

declare function initViewer(
  canvas: HTMLCanvasElement,
  plyUrl: string,
  config: RendererConfig
): Promise<ViewerHandle>;
```

## 7. 测试与验收

### 7.1 功能测试
1. PLY 解析正确（vertexCount/stride/offset 与样本记录一致）。
2. 第一人称操作可用（WASD、鼠标转向、Shift 加速）。
3. 排序正确（小样本下混合顺序符合 back-to-front）。
4. 快速转向时无明显黑屏/崩闪。

### 7.2 性能测试
1. Chrome 1080p 记录：`avg fps`、`p95 frame time`、`sort ms`、`active splats`。
2. 连续漫游 3 分钟观测稳定性与 GC 峰值。
3. 验证页面不会因全量读入导致长时间假死。

### 7.3 验收口径
- 必须：可加载并持续漫游，交互稳定，无长时间卡死。
- 目标：尽量逼近 60fps；若未达标，`balanced/safe` 档保持可交互稳定。

## 8. 已知风险与后续迭代
- 风险：原始 952MB PLY 会放大首帧和内存压力。
- 风险：4M 规模下排序开销在快速相机运动场景较高。
- 风险：仅 SH0 会在某些视角下损失颜色方向性。

后续优先级（如进入 V2）：
1. 接入压缩分块运行时格式（SOG/自定义容器思路）。
2. 增量接入高阶 SH。
3. 排序与可见性策略进一步 GPU 化。
