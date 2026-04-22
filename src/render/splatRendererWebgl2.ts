import type { CameraState, DecodedBatch, FrameStats, GpuHandleRange } from '../types';

type RendererConfig = {
  canvas: HTMLCanvasElement;
};

const VERTEX = `#version 300 es
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

const FRAGMENT = `#version 300 es
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

export class SplatRendererWebGL2 {
  private readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly positionBuffer: WebGLBuffer;
  private readonly colorBuffer: WebGLBuffer;
  private readonly indexBuffer: WebGLBuffer;
  private readonly uViewProjection: WebGLUniformLocation;

  private positions = new Float32Array(0);
  private colors = new Float32Array(0);
  private sortedIndices = new Uint32Array(0);
  private count = 0;

  constructor(config: RendererConfig) {
    const gl = config.canvas.getContext('webgl2', { antialias: false, alpha: false });
    if (!gl) {
      throw new Error('WebGL2 is required');
    }

    this.gl = gl;
    this.program = createProgram(gl, VERTEX, FRAGMENT);
    this.vao = requireObj(gl.createVertexArray());
    this.positionBuffer = requireObj(gl.createBuffer());
    this.colorBuffer = requireObj(gl.createBuffer());
    this.indexBuffer = requireObj(gl.createBuffer());
    this.uViewProjection = requireObj(gl.getUniformLocation(this.program, 'uViewProjection'));

    gl.bindVertexArray(this.vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bindVertexArray(null);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
  }

  resize(width: number, height: number): void {
    this.gl.viewport(0, 0, width, height);
  }

  uploadBatch(decodedBatch: DecodedBatch): GpuHandleRange {
    const start = this.count;
    const nextCount = this.count + decodedBatch.count;

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
    this.sortedIndices = new Uint32Array(this.count);
    for (let i = 0; i < this.count; i += 1) {
      this.sortedIndices[i] = i;
    }

    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.colors, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.sortedIndices, gl.DYNAMIC_DRAW);

    return { start, count: decodedBatch.count };
  }

  getPositions(): Float32Array {
    return this.positions;
  }

  updateSortedIndices(indices: Uint32Array): void {
    this.sortedIndices = new Uint32Array(indices);
    this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    this.gl.bufferData(this.gl.ELEMENT_ARRAY_BUFFER, this.sortedIndices, this.gl.DYNAMIC_DRAW);
  }

  renderFrame(camera: CameraState, sortedIndices: Uint32Array | null, uploadedSplats: number, dtMs: number): FrameStats {
    if (sortedIndices && sortedIndices.length > 0) {
      this.updateSortedIndices(sortedIndices);
    }

    const gl = this.gl;
    const drawStart = performance.now();

    gl.clearColor(0.04, 0.06, 0.1, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uViewProjection, false, camera.viewProjection);

    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.POINTS, this.count, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);

    const drawMs = performance.now() - drawStart;

    return {
      fps: dtMs > 0 ? 1000 / dtMs : 0,
      dtMs,
      drawMs,
      uploadedSplats,
      activeSplats: this.count,
      sortReady: sortedIndices !== null
    };
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

function requireObj<T>(value: T | null): T {
  if (!value) {
    throw new Error('WebGL allocation failed');
  }
  return value;
}
