# Technical Research: webgl-3dgs-renderer

## Research Scope
- Problem: 用 WebGL 实现 3DGS 渲染器，加载 `data/400w_3jie.ply`（4,025,304 splats），支持第一人称漫游，保证高性能与视觉正确性。
- Constraints:
  - 当前数据为 binary little-endian PLY，约 952MB，字段包含 `f_rest_0..44`（SH）与 `scale/rot/opacity`。
  - 目标运行环境是浏览器（WebGL 优先）。
- Evaluation Criteria:
  - 大场景加载时延与首帧可见时间
  - 交互帧率（移动/转向时稳定性）
  - 深度排序和透明混合正确性
  - 工程可维护性（依赖活跃度、生态能力）

## Local Data Facts
- `data/400w_3jie.ply` 头信息显示 `element vertex 4025304`。
- 按 62 个 float/splat 粗估（248 bytes/splat），原始数据约 `998,275,392` bytes（约 0.93 GiB），与实际文件大小 `998,276,924` bytes 接近。

## Option Comparison

### Option A - Spark (THREE.js + WebGL2)
- Link:
  - https://sparkjs.dev/docs/overview/
  - https://sparkjs.dev/docs/system-design/
  - https://sparkjs.dev/docs/performance/
  - https://sparkjs.dev/docs/controls/
  - https://github.com/sparkjsdev/spark
- Pros:
  - 明确支持 WebGL2，且主打与 THREE.js 场景融合。
  - 有内建第一人称控制（`FpsMovement`）与指针控制，可直接满足“漫游”。
  - 文档公开了排序流水线（GPU 读回 + worker bucket sort）与性能调优参数。
  - 支持多种 splat 格式（PLY/SPZ/SPLAT/KSPLAT/SOG）。
- Cons:
  - 对 4M splats 属于高压场景，若直接吃原始 PLY，加载与排序成本高。
  - 透明对象排序本质仍有帧间滞后（官方文档说明排序结果通常至少滞后一帧）。
- Fitness (1-10): 9
- Core Logic (Pseudo-code):
```text
load PLY -> offline convert(compressed format) -> runtime SplatMesh(url)
create SparkRenderer + THREE camera
attach FpsMovement/PointerControls
per frame: controls.update(camera) + renderer.render(scene, camera)
background worker updates splat order for back-to-front blending
```

### Option B - PlayCanvas Engine + 压缩格式(SOG/Compressed PLY)
- Link:
  - https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/
  - https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/ply/
  - https://blog.playcanvas.com/compressing-gaussian-splats/
  - https://blog.playcanvas.com/playcanvas-open-sources-sog-format-for-gaussian-splatting/
- Pros:
  - 官方文档给出明确工作流：PLY 作为源格式，生产环境转压缩格式。
  - 压缩收益证据清晰：SOG 文中给出 4M 高斯可压到约 42MB（相对 1GB PLY）。
  - Engine 文档强调支持 GPU 加速排序和多格式导入。
- Cons:
  - 若项目必须“自己实现渲染核心”，PlayCanvas 方案更偏“集成型”而非底层自研。
  - 需要把现有工程栈迁移/绑定到 PlayCanvas 生态。
- Fitness (1-10): 8
- Core Logic (Pseudo-code):
```text
train/edit with PLY -> convert to SOG for delivery
load SOG in PlayCanvas GSplat pipeline
bind fly/walk camera controller
render loop with engine sort + blending
deploy via CDN for fast first load
```

### Option C - 自研 WebGL2 管线（参考 antimatter15 / kishimisu）
- Link:
  - https://github.com/antimatter15/splat
  - https://github.com/kishimisu/Gaussian-Splatting-WebGL
  - https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/
- Pros:
  - 可完全控制数据结构、排序策略、相机系统与性能取舍。
  - 可按你数据特征做特化（如 SH 降阶、分块加载、距离裁剪、LOD）。
- Cons:
  - 研发风险最高；4M 级别下排序、内存与移动端退化都需要自己兜底。
  - 参考仓库中有的偏教学性质（WIP），有的较简洁但不覆盖完整工程需求。
- Fitness (1-10): 7
- Core Logic (Pseudo-code):
```text
parse PLY header + stream body -> pack SoA textures/buffers
precompute covariance/color (or SH0 fallback)
worker sorts splats by camera depth each frame threshold
vertex shader emits quad per splat; fragment shader gaussian alpha blend
fps controller updates camera matrix and triggers incremental re-sort
```

## Benchmarks & Risks
- Performance Evidence:
  - 原始论文页描述可在 1080p 达到高质量实时渲染（>=100 fps，论文场景条件下）。
  - Spark 文档给出经验预算：桌面常见 1-5M splats（部分高端可 10M+），移动端更低。
  - PlayCanvas 文档/博客强调 PLY 仅适合作为源文件，运行时建议压缩格式以降低加载与内存压力。
- Breaking Changes / Known Issues:
  - `mkkellogg/GaussianSplats3D` README 明确“no longer in active development”，不宜作为长期主干依赖。
  - 透明 splat 渲染依赖排序，快速相机运动下容易出现短暂伪影（多实现共同难点）。
- Security / Compatibility Notes:
  - WebGL2 兼容性总体高，但极端大场景在低端设备可能出现显存/内存峰值失败。
  - 大文件跨域加载需 CORS 正确配置。

## Recommendation
- Chosen Option: A（Spark + THREE.js）作为主实现路线，结合 B 的“离线压缩工作流”。
- Why:
  - 你要求“第一人称漫游 + 高性能 + 效果正确”，Spark 在这三点上都有现成能力与文档化调优抓手。
  - 保持 Web 技术栈灵活，且较自研方案明显降低交付风险。
- Why Not Others:
  - 不选纯 B：更偏平台集成，若你要保留当前工程主导权与可定制性，A 更平衡。
  - 不选纯 C：从零实现在 4M 规模下调通排序/加载/视觉正确性的成本和不确定性最高。
- Top 3 Risks + Mitigations:
  - 风险1: 直接加载 952MB PLY 导致首帧时间过长与内存峰值过高。
    - Mitigation: 建立离线转换，生产格式改为 SOG/SPZ/KSPLAT；保留 PLY 仅作母版。
  - 风险2: 相机快速移动时排序滞后产生闪烁。
    - Mitigation: 使用 worker 排序 + 运动阈值触发策略 + 降低单帧相机角速度上限。
  - 风险3: 高 DPI 和抗锯齿导致 fill-rate 爆炸。
    - Mitigation: 关闭 MSAA（`antialias:false`），按设备动态下调 pixelRatio 与 splat 渲染半径。

## Execution Blueprint (for this project)
1. 预处理阶段: 编写离线脚本将 `data/400w_3jie.ply` 转为运行时格式（首选 SOG/SPZ，备选 KSPLAT）。
2. 运行时渲染: 搭建 THREE.js + Spark 最小 viewer，先跑通加载、相机、排序。
3. 第一人称控制: 接入 `FpsMovement + PointerControls`，加入速度、惯性、碰撞（可后续）。
4. 质量/性能双档: 提供 `quality=high|balanced|mobile` 参数集。
5. 验收基线: 在目标机器记录 FPS、首帧时间、内存峰值、快速转向伪影情况。

## Evidence Level
- 证据等级: 中-高（来自项目官方文档/README/论文主页，时效性较好）。
- 缺失项:
  - 缺少你“目标硬件配置”（桌面/移动/GPU 型号），无法给出最终参数定值。
  - 未对 `400w_3jie.ply` 做真实浏览器基准测试（本次为方案调研，不含实测）。

## Sources
- https://repo-sam.inria.fr/fungraph/3d-gaussian-splatting/
- https://github.com/antimatter15/splat
- https://github.com/kishimisu/Gaussian-Splatting-WebGL
- https://github.com/mkkellogg/GaussianSplats3D
- https://github.com/sparkjsdev/spark
- https://sparkjs.dev/docs/overview/
- https://sparkjs.dev/docs/system-design/
- https://sparkjs.dev/docs/performance/
- https://sparkjs.dev/docs/controls/
- https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/
- https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/ply/
- https://blog.playcanvas.com/compressing-gaussian-splats/
- https://blog.playcanvas.com/playcanvas-open-sources-sog-format-for-gaussian-splatting/
