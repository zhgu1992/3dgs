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
out vec4 vEllipseParams;
out vec2 vCorner;
void main() {
  vec4 clip = uViewProjection * vec4(aPosition, 1.0);
  vec2 radiiPx = aEllipseParams.xy;
  vec2 clipOffset = aCorner * radiiPx * (2.0 / uViewport) * clip.w;
  gl_Position = clip + vec4(clipOffset, 0.0, 0.0);
  vColor = aColor;
  vEllipseParams = aEllipseParams;
  vCorner = aCorner;
}
`;

const ELLIPSE_FRAGMENT = `#version 300 es
precision highp float;
in vec4 vColor;
in vec4 vEllipseParams;
in vec2 vCorner;
out vec4 outColor;
void main() {
  vec2 local = vCorner;
  float r2 = dot(local, local);
  float falloff = exp(-2.0 * r2);
  float alpha = vColor.a * vEllipseParams.w * falloff;
  if (alpha < 0.01) {
    discard;
  }
  outColor = vec4(vColor.rgb * alpha, alpha);
}
`;

const QUAD_VERTICES = new Float32Array([
  -1, -1,
  1, -1,
  -1, 1,
  -1, 1,
  1, -1,
  1, 1
]);

const ELLIPSE_RADIUS_SCALE = 18.0;
const ELLIPSE_MIN_RADIUS = 0.75;

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

  updateSortedIndices(indices: Uint32Array): void {
    this.sortedIndices = new Uint32Array(indices);
    this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, this.pointIndexBuffer);
    this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, this.sortedIndices, this.gl.DYNAMIC_DRAW);
  }

  renderFrame(camera: CameraState, sortedIndices: Uint32Array | null, uploadedSplats: number, dtMs: number): FrameStats {
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

  private updateEllipseBuffers(camera: CameraState, drawCount: number): { drawCount: number; discarded: number } {
    const count = Math.min(drawCount, this.count);
    if (count <= 0) {
      return { drawCount: 0, discarded: 0 };
    }

    this.ensureEllipseCapacity(count);
    const view = camera.view;
    let discarded = 0;

    for (let i = 0; i < count; i += 1) {
      const splatId = this.sortedIndices[i] ?? i;
      const srcPos = splatId * 3;
      const dstPos = i * 3;
      const x = this.positions[srcPos];
      const y = this.positions[srcPos + 1];
      const z = this.positions[srcPos + 2];
      const colorSrc = splatId * 4;

      this.ellipsePositions[dstPos] = x;
      this.ellipsePositions[dstPos + 1] = y;
      this.ellipsePositions[dstPos + 2] = z;

      this.ellipseColors[i * 4] = this.colors[colorSrc];
      this.ellipseColors[i * 4 + 1] = this.colors[colorSrc + 1];
      this.ellipseColors[i * 4 + 2] = this.colors[colorSrc + 2];
      this.ellipseColors[i * 4 + 3] = this.colors[colorSrc + 3];

      const viewX = view[0] * x + view[4] * y + view[8] * z + view[12];
      const viewY = view[1] * x + view[5] * y + view[9] * z + view[13];
      const viewZ = view[2] * x + view[6] * y + view[10] * z + view[14];
      const depth = -viewZ;

      if (depth <= 0.0001) {
        discarded += 1;
      }

      const safeDepth = Math.max(depth, 0.0001);
      const rawRadiusPx = ELLIPSE_RADIUS_SCALE / safeDepth;
      const radiusPx = clamp(rawRadiusPx, ELLIPSE_MIN_RADIUS, 24.0);
      const lateral = clamp(Math.hypot(viewX, viewY) / safeDepth, 0.0, 1.0);
      const stretch = 1.0 + lateral * 0.2;
      const rotation = Math.atan2(viewY, viewX) * 0.25;

      this.ellipseParams[i * 4] = radiusPx * stretch;
      this.ellipseParams[i * 4 + 1] = radiusPx / stretch;
      this.ellipseParams[i * 4 + 2] = rotation;
      this.ellipseParams[i * 4 + 3] = 1.0;
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

function makeIdentityIndices(count: number): Uint32Array {
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
