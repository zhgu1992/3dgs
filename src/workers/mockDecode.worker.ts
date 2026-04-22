/// <reference lib="webworker" />

export {};

type DecodeRequest = {
  type: 'decode';
  seed: number;
  start: number;
  count: number;
};

type DecodeResponse = {
  type: 'decoded';
  start: number;
  count: number;
  positions: Float32Array;
  scales: Float32Array;
  rotations: Float32Array;
  colors: Float32Array;
  opacities: Float32Array;
};

const ctx: DedicatedWorkerGlobalScope = self as DedicatedWorkerGlobalScope;

function random(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) / 0xffffffff;
  };
}

ctx.onmessage = (event: MessageEvent<DecodeRequest>) => {
  const msg = event.data;
  if (msg.type !== 'decode') {
    return;
  }

  const rand = random(msg.seed + msg.start);
  const positions = new Float32Array(msg.count * 3);
  const scales = new Float32Array(msg.count * 3);
  const rotations = new Float32Array(msg.count * 4);
  const colors = new Float32Array(msg.count * 3);
  const opacities = new Float32Array(msg.count);

  for (let i = 0; i < msg.count; i += 1) {
    const base = i * 3;
    const radius = 2.5 + rand() * 2.5;
    const theta = rand() * Math.PI * 2;
    const y = (rand() - 0.5) * 2.5;

    positions[base] = Math.cos(theta) * radius;
    positions[base + 1] = y;
    positions[base + 2] = Math.sin(theta) * radius;

    // mock 数据保持和真实链路一致：scale 使用 log-space，rotation 使用四元数。
    scales[base] = -1.6 + rand() * 0.7;
    scales[base + 1] = -1.9 + rand() * 0.6;
    scales[base + 2] = -2.2 + rand() * 0.6;

    const rotationBase = i * 4;
    rotations[rotationBase] = 0;
    rotations[rotationBase + 1] = 0;
    rotations[rotationBase + 2] = 0;
    rotations[rotationBase + 3] = 1;

    colors[base] = 0.25 + rand() * 0.75;
    colors[base + 1] = 0.25 + rand() * 0.75;
    colors[base + 2] = 0.25 + rand() * 0.75;
    opacities[i] = 0.5 + rand() * 0.5;
  }

  const response: DecodeResponse = {
    type: 'decoded',
    start: msg.start,
    count: msg.count,
    positions,
    scales,
    rotations,
    colors,
    opacities
  };

  ctx.postMessage(response, [positions.buffer, scales.buffer, rotations.buffer, colors.buffer, opacities.buffer]);
};
