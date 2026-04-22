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

ctx.onmessage = (event: MessageEvent<SortRequest>) => {
  const data = event.data;
  if (data.type !== 'sort') {
    return;
  }

  const start = performance.now();
  const pairs = new Array<{ id: number; depth: number }>(data.activeIds.length);

  const m = data.view;
  for (let i = 0; i < data.activeIds.length; i += 1) {
    const id = data.activeIds[i];
    const base = id * 3;
    const x = data.positions[base];
    const y = data.positions[base + 1];
    const z = data.positions[base + 2];
    const depth = m[2] * x + m[6] * y + m[10] * z + m[14];
    pairs[i] = { id, depth };
  }

  pairs.sort((a, b) => a.depth - b.depth);

  const indices = new Uint32Array(pairs.length);
  for (let i = 0; i < pairs.length; i += 1) {
    indices[i] = pairs[i].id;
  }

  const response: SortResponse = {
    type: 'sorted',
    indices,
    sortMs: performance.now() - start
  };

  ctx.postMessage(response, [indices.buffer]);
};
