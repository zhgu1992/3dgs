题目背景：
使用 WebGL 实现 3DGS 渲染器，目标支持加载 [400w_3jie.ply](data/400w_3jie.ply) 数据，并提供第一人称漫游。

当前进度：阶段一（Skeleton）已落地
- 已完成：`init -> mock ingest(worker) -> upload -> draw -> fps camera -> frame stats` 全链路。
- 当前渲染数据：mock splat（尚未接入真实 PLY 解析）。
- 当前排序：worker 异步深度排序骨架（阶段二替换为全量 radix）。

运行方式：
- 安装依赖：`npm install`
- 本地开发：`npm run dev`
- 类型检查：`npm run typecheck`
- 构建：`npm run build`

操作说明：
- 光标始终可见；按住鼠标左键拖拽可转动视角。
- `W/A/S/D` 平移，`Space` 上升，`ShiftLeft` 下降，`ShiftRight` 加速。
