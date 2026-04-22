/// <reference lib="webworker" />

export {};

type SortRequest = {
  type: 'sort';
  activeIds: Uint32Array;
  positions: Float32Array;
  view: Float32Array;
};

type SortResponse = {
  type: 'sorted';
  indices: Uint32Array;
  sortMs: number;
};

const ctx: DedicatedWorkerGlobalScope = self as DedicatedWorkerGlobalScope;
const RADIX = 256;
const PASSES = 4;

let capacity = 0;
let keysA = new Uint32Array(0);
let keysB = new Uint32Array(0);
let idsA = new Uint32Array(0);
let idsB = new Uint32Array(0);
const counts = new Uint32Array(RADIX);
const offsets = new Uint32Array(RADIX);
const depthBitsBuffer = new ArrayBuffer(4);
const depthBitsFloat = new Float32Array(depthBitsBuffer);
const depthBitsUint = new Uint32Array(depthBitsBuffer);

function nextPow2(value: number): number {
  let n = 1;
  while (n < value) {
    n <<= 1;
  }
  return n;
}

function ensureCapacity(required: number): void {
  if (required <= capacity) {
    return;
  }

  capacity = nextPow2(required);
  keysA = new Uint32Array(capacity);
  keysB = new Uint32Array(capacity);
  idsA = new Uint32Array(capacity);
  idsB = new Uint32Array(capacity);
}

function floatToSortableUint(value: number): number {
  // 把 float 深度映射到可按无符号整数比较的序空间。
  depthBitsFloat[0] = value;
  const bits = depthBitsUint[0];
  return (bits & 0x80000000) !== 0 ? (~bits >>> 0) : ((bits ^ 0x80000000) >>> 0);
}

ctx.onmessage = (event: MessageEvent<SortRequest>) => {
  const data = event.data;
  if (data.type !== 'sort') {
    return;
  }

  const start = performance.now();
  const count = data.activeIds.length;
  ensureCapacity(count);

  const m = data.view;
  for (let i = 0; i < count; i += 1) {
    const id = data.activeIds[i];
    const base = id * 3;
    const x = data.positions[base];
    const y = data.positions[base + 1];
    const z = data.positions[base + 2];
    const depth = m[2] * x + m[6] * y + m[10] * z + m[14];
    keysA[i] = floatToSortableUint(depth);
    idsA[i] = id;
  }

  let srcKeys = keysA;
  let srcIds = idsA;
  let dstKeys = keysB;
  let dstIds = idsB;

  for (let pass = 0; pass < PASSES; pass += 1) {
    // LSD radix：每轮处理 8bit，共 4 轮覆盖 uint32 key。
    counts.fill(0);
    const shift = pass * 8;

    for (let i = 0; i < count; i += 1) {
      counts[(srcKeys[i] >>> shift) & 0xff] += 1;
    }

    let total = 0;
    for (let bucket = 0; bucket < RADIX; bucket += 1) {
      offsets[bucket] = total;
      total += counts[bucket];
    }

    for (let i = 0; i < count; i += 1) {
      const key = srcKeys[i];
      const bucket = (key >>> shift) & 0xff;
      const outIndex = offsets[bucket];
      offsets[bucket] = outIndex + 1;
      dstKeys[outIndex] = key;
      dstIds[outIndex] = srcIds[i];
    }

    const tmpKeys = srcKeys;
    srcKeys = dstKeys;
    dstKeys = tmpKeys;
    const tmpIds = srcIds;
    srcIds = dstIds;
    dstIds = tmpIds;
  }

  const indices = new Uint32Array(count);
  indices.set(srcIds.subarray(0, count));

  const response: SortResponse = {
    type: 'sorted',
    indices,
    sortMs: performance.now() - start
  };

  ctx.postMessage(response, [indices.buffer]);
};
