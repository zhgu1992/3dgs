import type { CameraState, DecodedBatch, FrameStats, GpuHandleRange } from '../types';

type RendererConfig = {
  canvas: HTMLCanvasElement;
  useEllipseShader?: boolean;
};

const POINT_VERTEX = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec4 aColor;
uniform mat4 uViewProjection;
out vec4 vColor;
void main() {
  gl_Position = uViewProjection * vec4(aPosition, 1.0);
  gl_PointSize = 2.0;
  vColor = aColor;
}
`;

const POINT_FRAGMENT = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 outColor;
void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(uv, uv);
  float falloff = exp(-2.0 * r2);
  float alpha = vColor.a * falloff;
  if (alpha < 0.01) {
    discard;
  }
  outColor = vec4(vColor.rgb * alpha, alpha);
}
`;

const ELLIPSE_VERTEX = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec4 aColor;
layout(location = 2) in vec4 aEllipseParams;
layout(location = 3) in vec2 aCorner;
uniform mat4 uViewProjection;
uniform vec2 uViewport;
out vec4 vColor;
out vec2 vLocalUv;
out float vAlphaScale;
void main() {
  vec4 clip = uViewProjection * vec4(aPosition, 1.0);

  float angle = aEllipseParams.z;
  float c = cos(angle);
  float s = sin(angle);
  mat2 rot = mat2(c, -s, s, c);

  vec2 localPx = rot * (aCorner * aEllipseParams.xy);
  vec2 clipOffset = localPx * (2.0 / uViewport) * clip.w;

  gl_Position = clip + vec4(clipOffset, 0.0, 0.0);
  vColor = aColor;
  vLocalUv = aCorner;
  vAlphaScale = aEllipseParams.w;
}
`;

const ELLIPSE_FRAGMENT = `#version 300 es
precision highp float;
in vec4 vColor;
in vec2 vLocalUv;
in float vAlphaScale;
out vec4 outColor;

const float SIGMA_EXTENT = 3.0;

void main() {
  // vLocalUv 是归一化到 [-1,1] 的局部坐标；乘 3σ 后再做高斯衰减。
  float r2 = dot(vLocalUv, vLocalUv) * SIGMA_EXTENT * SIGMA_EXTENT;
  float alpha = vColor.a * vAlphaScale * exp(-0.5 * r2);
  // 低于 1/255 直接丢弃，避免远端尾部过度填充带来的 fill-rate 浪费。
  if (alpha < (1.0 / 255.0)) {
    discard;
  }
  outColor = vec4(vColor.rgb * alpha, alpha);
}
`;

const QUAD_VERTICES = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);

const ELLIPSE_SIGMA_EXTENT = 3.0;
const ELLIPSE_MIN_VARIANCE_PX2 = 0.05;
const ELLIPSE_MAX_RADIUS_PX = 96.0;
const MIN_DEPTH = 0.0001;
const MIN_Q_LEN = 1e-6;

export class SplatRendererWebGL2 {
  private readonly gl: WebGL2RenderingContext;
  private readonly useEllipseShader: boolean;

  private readonly pointProgram: WebGLProgram;
  private readonly pointVao: WebGLVertexArrayObject;
  private readonly pointPositionBuffer: WebGLBuffer;
  private readonly pointColorBuffer: WebGLBuffer;
  private readonly pointIndexBuffer: WebGLBuffer;
  private readonly uPointViewProjection: WebGLUniformLocation;

  private readonly ellipseProgram: WebGLProgram;
  private readonly ellipseVao: WebGLVertexArrayObject;
  private readonly ellipsePositionBuffer: WebGLBuffer;
  private readonly ellipseColorBuffer: WebGLBuffer;
  private readonly ellipseParamsBuffer: WebGLBuffer;
  private readonly ellipseQuadBuffer: WebGLBuffer;
  private readonly uEllipseViewProjection: WebGLUniformLocation;
  private readonly uEllipseViewport: WebGLUniformLocation;

  private positions = new Float32Array(0);
  private scales = new Float32Array(0);
  private rotations = new Float32Array(0);
  private colors = new Float32Array(0);
  private sortedIndices: Uint32Array<ArrayBufferLike> = new Uint32Array(0);
  private ellipsePositions = new Float32Array(0);
  private ellipseColors = new Float32Array(0);
  private ellipseParams = new Float32Array(0);
  private count = 0;
  private viewportWidth = 1;
  private viewportHeight = 1;

  constructor(config: RendererConfig) {
    const gl = config.canvas.getContext('webgl2', { antialias: false, alpha: false });
    if (!gl) {
      throw new Error('WebGL2 is required');
    }

    this.gl = gl;
    this.useEllipseShader = config.useEllipseShader ?? false;

    this.pointProgram = createProgram(gl, POINT_VERTEX, POINT_FRAGMENT);
    this.pointVao = requireObj(gl.createVertexArray());
    this.pointPositionBuffer = requireObj(gl.createBuffer());
    this.pointColorBuffer = requireObj(gl.createBuffer());
    this.pointIndexBuffer = requireObj(gl.createBuffer());
    this.uPointViewProjection = requireObj(gl.getUniformLocation(this.pointProgram, 'uViewProjection'));

    gl.bindVertexArray(this.pointVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointPositionBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointColorBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.pointIndexBuffer);
    gl.bindVertexArray(null);

    this.ellipseProgram = createProgram(gl, ELLIPSE_VERTEX, ELLIPSE_FRAGMENT);
    this.ellipseVao = requireObj(gl.createVertexArray());
    this.ellipsePositionBuffer = requireObj(gl.createBuffer());
    this.ellipseColorBuffer = requireObj(gl.createBuffer());
    this.ellipseParamsBuffer = requireObj(gl.createBuffer());
    this.ellipseQuadBuffer = requireObj(gl.createBuffer());
    this.uEllipseViewProjection = requireObj(gl.getUniformLocation(this.ellipseProgram, 'uViewProjection'));
    this.uEllipseViewport = requireObj(gl.getUniformLocation(this.ellipseProgram, 'uViewport'));

    gl.bindVertexArray(this.ellipseVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ellipsePositionBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(0, 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.ellipseColorBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.ellipseParamsBuffer);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(2, 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.ellipseQuadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD_VERTICES, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(3, 0);
    gl.bindVertexArray(null);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
  }

  resize(width: number, height: number): void {
    this.viewportWidth = Math.max(1, width);
    this.viewportHeight = Math.max(1, height);
    this.gl.viewport(0, 0, this.viewportWidth, this.viewportHeight);
  }

  uploadBatch(decodedBatch: DecodedBatch): GpuHandleRange {
    const start = this.count;
    const nextCount = this.count + decodedBatch.count;

    // 先扩容 CPU 侧连续数组，再整体上传到 GPU buffer。
    const nextPositions = new Float32Array(nextCount * 3);
    nextPositions.set(this.positions);
    nextPositions.set(decodedBatch.positions, start * 3);
    this.positions = nextPositions;

    const nextScales = new Float32Array(nextCount * 3);
    nextScales.set(this.scales);
    nextScales.set(decodedBatch.scales, start * 3);
    this.scales = nextScales;

    const nextRotations = new Float32Array(nextCount * 4);
    nextRotations.set(this.rotations);
    nextRotations.set(decodedBatch.rotations, start * 4);
    this.rotations = nextRotations;

    const nextColors = new Float32Array(nextCount * 4);
    nextColors.set(this.colors);
    for (let i = 0; i < decodedBatch.count; i += 1) {
      const src = i * 3;
      const dst = (start + i) * 4;
      nextColors[dst] = decodedBatch.colors[src];
      nextColors[dst + 1] = decodedBatch.colors[src + 1];
      nextColors[dst + 2] = decodedBatch.colors[src + 2];
      nextColors[dst + 3] = decodedBatch.opacities[i];
    }
    this.colors = nextColors;

    this.count = nextCount;
    // 新增数据后先回退为顺序索引，等待排序结果覆盖。
    this.sortedIndices = makeIdentityIndices(this.count);

    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointPositionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointColorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.colors, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.pointIndexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.sortedIndices, gl.DYNAMIC_DRAW);

    return { start, count: decodedBatch.count };
  }

  getPositions(): Float32Array {
    return this.positions;
  }

  updateSortedIndices(indices: Uint32Array<ArrayBufferLike>): void {
    this.sortedIndices = new Uint32Array(indices);
    this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, this.pointIndexBuffer);
    this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, this.sortedIndices, this.gl.DYNAMIC_DRAW);
  }

  renderFrame(
    camera: CameraState,
    sortedIndices: Uint32Array<ArrayBufferLike> | null,
    uploadedSplats: number,
    dtMs: number
  ): FrameStats {
    if (sortedIndices && sortedIndices.length > 0) {
      // 有新排序结果时，替换当前索引缓冲。
      this.updateSortedIndices(sortedIndices);
    } else if (this.sortedIndices.length !== this.count) {
      this.sortedIndices = makeIdentityIndices(this.count);
      this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, this.pointIndexBuffer);
      this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, this.sortedIndices, this.gl.DYNAMIC_DRAW);
    }

    const drawCount = this.count === 0 ? 0 : Math.min(this.count, this.sortedIndices.length || this.count);
    const gl = this.gl;
    const drawStart = performance.now();

    gl.clearColor(0.04, 0.06, 0.1, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (this.useEllipseShader) {
      // 椭圆路径先在 CPU 组装实例参数，再一次性 instanced draw。
      const discardStats = this.updateEllipseBuffers(camera, drawCount);
      gl.useProgram(this.ellipseProgram);
      gl.uniformMatrix4fv(this.uEllipseViewProjection, false, camera.viewProjection);
      gl.uniform2f(this.uEllipseViewport, this.viewportWidth, this.viewportHeight);
      gl.bindVertexArray(this.ellipseVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, drawCount);
      gl.bindVertexArray(null);

      const drawMs = performance.now() - drawStart;
      return {
        fps: dtMs > 0 ? 1000 / dtMs : 0,
        dtMs,
        drawMs,
        uploadedSplats,
        activeSplats: drawCount,
        sortReady: sortedIndices !== null,
        discardRatio: discardStats.drawCount > 0 ? discardStats.discarded / discardStats.drawCount : 0
      };
    }

    gl.useProgram(this.pointProgram);
    gl.uniformMatrix4fv(this.uPointViewProjection, false, camera.viewProjection);
    gl.bindVertexArray(this.pointVao);
    gl.drawElements(gl.POINTS, drawCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);

    const drawMs = performance.now() - drawStart;
    return {
      fps: dtMs > 0 ? 1000 / dtMs : 0,
      dtMs,
      drawMs,
      uploadedSplats,
      activeSplats: drawCount,
      sortReady: sortedIndices !== null
    };
  }

  /**
   * 基于当前排序结果生成椭圆实例缓冲。
   * 参数：
   * - camera：提供 view/projection，用于把 3D 协方差投影到屏幕空间。
   * - drawCount：本帧计划绘制的 splat 数量上限。
   * 返回：
   * - drawCount：实际写入实例缓冲的数量。
   * - discarded：因深度/数值异常被置零的实例计数（用于调试 discard_ratio）。
   * 失败条件：
   * - 不抛异常；遇到非法输入时将该实例参数置零并计入 discarded。
   */
  private updateEllipseBuffers(camera: CameraState, drawCount: number): { drawCount: number; discarded: number } {
    const count = Math.min(drawCount, this.count);
    if (count <= 0) {
      return { drawCount: 0, discarded: 0 };
    }

    this.ensureEllipseCapacity(count);

    const view = camera.view;
    const projection = camera.projection;
    const focalX = (projection[0] * this.viewportWidth) * 0.5;
    const focalY = (projection[5] * this.viewportHeight) * 0.5;

    let discarded = 0;

    for (let i = 0; i < count; i += 1) {
      const splatId = this.sortedIndices[i] ?? i;
      const srcPos = splatId * 3;
      const srcRot = splatId * 4;
      const dstPos = i * 3;
      const dstColor = i * 4;

      const x = this.positions[srcPos];
      const y = this.positions[srcPos + 1];
      const z = this.positions[srcPos + 2];

      this.ellipsePositions[dstPos] = x;
      this.ellipsePositions[dstPos + 1] = y;
      this.ellipsePositions[dstPos + 2] = z;

      this.ellipseColors[dstColor] = this.colors[splatId * 4];
      this.ellipseColors[dstColor + 1] = this.colors[splatId * 4 + 1];
      this.ellipseColors[dstColor + 2] = this.colors[splatId * 4 + 2];
      this.ellipseColors[dstColor + 3] = this.colors[splatId * 4 + 3];

      const viewX = view[0] * x + view[4] * y + view[8] * z + view[12];
      const viewY = view[1] * x + view[5] * y + view[9] * z + view[13];
      const viewZ = view[2] * x + view[6] * y + view[10] * z + view[14];
      const depth = -viewZ;

      if (depth <= MIN_DEPTH || !Number.isFinite(depth)) {
        this.ellipseParams[dstColor] = 0;
        this.ellipseParams[dstColor + 1] = 0;
        this.ellipseParams[dstColor + 2] = 0;
        this.ellipseParams[dstColor + 3] = 0;
        discarded += 1;
        continue;
      }

      // PLY 约定 rot_0..3 为四元数分量，运行时统一归一化，异常值回退到单位旋转。
      let qx = this.rotations[srcRot];
      let qy = this.rotations[srcRot + 1];
      let qz = this.rotations[srcRot + 2];
      let qw = this.rotations[srcRot + 3];
      const qLen = Math.hypot(qx, qy, qz, qw);
      if (!Number.isFinite(qLen) || qLen < MIN_Q_LEN) {
        qx = 0;
        qy = 0;
        qz = 0;
        qw = 1;
      } else {
        const inv = 1 / qLen;
        qx *= inv;
        qy *= inv;
        qz *= inv;
        qw *= inv;
      }

      const xx = qx * qx;
      const yy = qy * qy;
      const zz = qz * qz;
      const xy = qx * qy;
      const xz = qx * qz;
      const yz = qy * qz;
      const wx = qw * qx;
      const wy = qw * qy;
      const wz = qw * qz;

      const r00 = 1 - 2 * (yy + zz);
      const r01 = 2 * (xy - wz);
      const r02 = 2 * (xz + wy);
      const r10 = 2 * (xy + wz);
      const r11 = 1 - 2 * (xx + zz);
      const r12 = 2 * (yz - wx);
      const r20 = 2 * (xz - wy);
      const r21 = 2 * (yz + wx);
      const r22 = 1 - 2 * (xx + yy);

      // scale_0..2 视为 log-scale，渲染前 exp 还原，避免极值导致 NaN/Inf。
      const sx = Math.exp(clamp(this.scales[srcPos], -10, 10));
      const sy = Math.exp(clamp(this.scales[srcPos + 1], -10, 10));
      const sz = Math.exp(clamp(this.scales[srcPos + 2], -10, 10));

      const a0x = r00 * sx;
      const a0y = r10 * sx;
      const a0z = r20 * sx;
      const a1x = r01 * sy;
      const a1y = r11 * sy;
      const a1z = r21 * sy;
      const a2x = r02 * sz;
      const a2y = r12 * sz;
      const a2z = r22 * sz;

      const c0x = view[0] * a0x + view[4] * a0y + view[8] * a0z;
      const c0y = view[1] * a0x + view[5] * a0y + view[9] * a0z;
      const c0z = view[2] * a0x + view[6] * a0y + view[10] * a0z;

      const c1x = view[0] * a1x + view[4] * a1y + view[8] * a1z;
      const c1y = view[1] * a1x + view[5] * a1y + view[9] * a1z;
      const c1z = view[2] * a1x + view[6] * a1y + view[10] * a1z;

      const c2x = view[0] * a2x + view[4] * a2y + view[8] * a2z;
      const c2y = view[1] * a2x + view[5] * a2y + view[9] * a2z;
      const c2z = view[2] * a2x + view[6] * a2y + view[10] * a2z;

      // Sigma3D = R*diag(scale^2)*R^T，经 view 旋转后取到相机空间协方差。
      const sigmaXX = c0x * c0x + c1x * c1x + c2x * c2x;
      const sigmaXY = c0x * c0y + c1x * c1y + c2x * c2y;
      const sigmaXZ = c0x * c0z + c1x * c1z + c2x * c2z;
      const sigmaYY = c0y * c0y + c1y * c1y + c2y * c2y;
      const sigmaYZ = c0y * c0z + c1y * c1z + c2y * c2z;
      const sigmaZZ = c0z * c0z + c1z * c1z + c2z * c2z;

      const invDepth = 1 / depth;
      const invDepth2 = invDepth * invDepth;

      // Jacobian(透视投影)把 3D 协方差投影到 2D：Sigma2D = J * Sigma3D * J^T。
      const j00 = focalX * invDepth;
      const j02 = focalX * viewX * invDepth2;
      const j11 = focalY * invDepth;
      const j12 = focalY * viewY * invDepth2;

      let covXX = j00 * j00 * sigmaXX + 2 * j00 * j02 * sigmaXZ + j02 * j02 * sigmaZZ;
      let covXY =
        j00 * j11 * sigmaXY +
        j00 * j12 * sigmaXZ +
        j02 * j11 * sigmaYZ +
        j02 * j12 * sigmaZZ;
      let covYY = j11 * j11 * sigmaYY + 2 * j11 * j12 * sigmaYZ + j12 * j12 * sigmaZZ;

      covXX += ELLIPSE_MIN_VARIANCE_PX2;
      covYY += ELLIPSE_MIN_VARIANCE_PX2;

      if (!Number.isFinite(covXX) || !Number.isFinite(covXY) || !Number.isFinite(covYY)) {
        this.ellipseParams[dstColor] = 0;
        this.ellipseParams[dstColor + 1] = 0;
        this.ellipseParams[dstColor + 2] = 0;
        this.ellipseParams[dstColor + 3] = 0;
        discarded += 1;
        continue;
      }

      // 2x2 协方差做特征分解，得到主/次轴方差与屏幕旋转角。
      const trace = covXX + covYY;
      const det = covXX * covYY - covXY * covXY;
      if (det <= 0) {
        this.ellipseParams[dstColor] = 0;
        this.ellipseParams[dstColor + 1] = 0;
        this.ellipseParams[dstColor + 2] = 0;
        this.ellipseParams[dstColor + 3] = 0;
        discarded += 1;
        continue;
      }

      const disc = Math.sqrt(Math.max(0, trace * trace * 0.25 - det));
      const lambdaMajor = Math.max(trace * 0.5 + disc, ELLIPSE_MIN_VARIANCE_PX2);
      const lambdaMinor = Math.max(trace * 0.5 - disc, ELLIPSE_MIN_VARIANCE_PX2);

      let radiusMajor = Math.sqrt(lambdaMajor) * ELLIPSE_SIGMA_EXTENT;
      let radiusMinor = Math.sqrt(lambdaMinor) * ELLIPSE_SIGMA_EXTENT;

      if (!Number.isFinite(radiusMajor) || !Number.isFinite(radiusMinor) || radiusMajor <= 0 || radiusMinor <= 0) {
        this.ellipseParams[dstColor] = 0;
        this.ellipseParams[dstColor + 1] = 0;
        this.ellipseParams[dstColor + 2] = 0;
        this.ellipseParams[dstColor + 3] = 0;
        discarded += 1;
        continue;
      }

      const clampScale = radiusMajor > ELLIPSE_MAX_RADIUS_PX ? ELLIPSE_MAX_RADIUS_PX / radiusMajor : 1.0;
      radiusMajor *= clampScale;
      radiusMinor = Math.max(radiusMinor * clampScale, Math.sqrt(ELLIPSE_MIN_VARIANCE_PX2));

      const angle = 0.5 * Math.atan2(2 * covXY, covXX - covYY);

      this.ellipseParams[dstColor] = radiusMajor;
      this.ellipseParams[dstColor + 1] = radiusMinor;
      this.ellipseParams[dstColor + 2] = angle;
      this.ellipseParams[dstColor + 3] = 1.0;
    }

    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ellipsePositionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.ellipsePositions.subarray(0, count * 3), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ellipseColorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.ellipseColors.subarray(0, count * 4), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ellipseParamsBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.ellipseParams.subarray(0, count * 4), gl.DYNAMIC_DRAW);

    return { drawCount: count, discarded };
  }

  private ensureEllipseCapacity(count: number): void {
    const positionLength = count * 3;
    const colorLength = count * 4;
    if (this.ellipsePositions.length < positionLength) {
      this.ellipsePositions = new Float32Array(positionLength);
    }
    if (this.ellipseColors.length < colorLength) {
      this.ellipseColors = new Float32Array(colorLength);
    }
    if (this.ellipseParams.length < colorLength) {
      this.ellipseParams = new Float32Array(colorLength);
    }
  }
}

function createProgram(gl: WebGL2RenderingContext, vsSource: string, fsSource: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
  const program = requireObj(gl.createProgram());

  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    throw new Error(`Program link failed: ${log ?? 'unknown'}`);
  }

  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return program;
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = requireObj(gl.createShader(type));
  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    throw new Error(`Shader compile failed: ${log ?? 'unknown'}`);
  }

  return shader;
}

function makeIdentityIndices(count: number): Uint32Array<ArrayBufferLike> {
  const indices = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) {
    indices[i] = i;
  }
  return indices;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function requireObj<T>(value: T | null): T {
  if (!value) {
    throw new Error('WebGL allocation failed');
  }
  return value;
}
