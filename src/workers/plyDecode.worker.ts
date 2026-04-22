/// <reference lib="webworker" />

import type { ByteRange, PlyDecodeRequest, PlyDecodeResponse } from '../ingest/plyProtocol';

export {};

const ctx: DedicatedWorkerGlobalScope = self as DedicatedWorkerGlobalScope;

function viewFromRange(range: ByteRange): Uint8Array {
  return new Uint8Array(range.buffer, range.byteOffset, range.byteLength);
}

function readByte(carry: Uint8Array, chunk: Uint8Array, carryLength: number, absoluteOffset: number): number {
  if (absoluteOffset < carryLength) {
    return carry[absoluteOffset];
  }
  return chunk[absoluteOffset - carryLength];
}

function readFloat32LE(carry: Uint8Array, chunk: Uint8Array, carryLength: number, absoluteOffset: number): number {
  if (absoluteOffset + 4 <= carryLength) {
    return new DataView(carry.buffer, carry.byteOffset + absoluteOffset, 4).getFloat32(0, true);
  }

  const chunkOffset = absoluteOffset - carryLength;
  if (absoluteOffset >= carryLength) {
    return new DataView(chunk.buffer, chunk.byteOffset + chunkOffset, 4).getFloat32(0, true);
  }

  const temp = new Uint8Array(4);
  // 跨 carry/chunk 边界时拷贝 4 字节后再按 little-endian 读取。
  for (let i = 0; i < 4; i += 1) {
    temp[i] = readByte(carry, chunk, carryLength, absoluteOffset + i);
  }
  return new DataView(temp.buffer).getFloat32(0, true);
}

function makeNextCarry(
  carry: ByteRange | null,
  chunk: ByteRange,
  carryLength: number,
  consumedBytes: number,
  totalBytes: number
): ByteRange | null {
  const remaining = totalBytes - consumedBytes;
  if (remaining <= 0) {
    return null;
  }

  if (consumedBytes < carryLength) {
    const carryRemaining = carryLength - consumedBytes;
    if (remaining <= carryRemaining) {
      return {
        buffer: carry!.buffer,
        byteOffset: carry!.byteOffset + consumedBytes,
        byteLength: remaining
      };
    }
  } else {
    return {
      buffer: chunk.buffer,
      byteOffset: chunk.byteOffset + (consumedBytes - carryLength),
      byteLength: remaining
    };
  }

  const copy = new Uint8Array(remaining);
  const carryBytes = carry ? viewFromRange(carry) : new Uint8Array(0);
  const chunkBytes = viewFromRange(chunk);
  let writeOffset = 0;
  const carryTailOffset = consumedBytes;
  for (let i = carryTailOffset; i < carryLength; i += 1) {
    copy[writeOffset] = carryBytes[i];
    writeOffset += 1;
  }
  const chunkOffset = 0;
  for (let i = chunkOffset; i < chunkBytes.byteLength; i += 1) {
    if (writeOffset >= remaining) {
      break;
    }
    copy[writeOffset] = chunkBytes[i];
    writeOffset += 1;
  }

  return {
    buffer: copy.buffer,
    byteOffset: 0,
    byteLength: remaining
  };
}

ctx.onmessage = (event: MessageEvent<PlyDecodeRequest>) => {
  const msg = event.data;
  if (msg.type !== 'decode') {
    return;
  }

  const startMs = performance.now();
  const carryBytes = msg.carry ? viewFromRange(msg.carry) : new Uint8Array(0);
  const chunkBytes = viewFromRange(msg.chunk);
  const totalBytes = carryBytes.byteLength + chunkBytes.byteLength;
  const decodedCount = Math.min(msg.maxVertices, msg.remainingVertices, Math.floor(totalBytes / msg.layout.stride));

  // 首版 2E 渲染只消费以下字段：position / scale(log) / rotation(quat) / sh0(rgb) / opacity。
  const positions = new Float32Array(decodedCount * 3);
  const scales = new Float32Array(decodedCount * 3);
  const rotations = new Float32Array(decodedCount * 4);
  const colors = new Float32Array(decodedCount * 3);
  const opacities = new Float32Array(decodedCount);

  const offsets = msg.layout.offsets;
  const carryLength = carryBytes.byteLength;

  for (let i = 0; i < decodedCount; i += 1) {
    const vertexOffset = i * msg.layout.stride;
    const positionBase = i * 3;

    positions[positionBase] = readFloat32LE(carryBytes, chunkBytes, carryLength, vertexOffset + offsets.x);
    positions[positionBase + 1] = readFloat32LE(carryBytes, chunkBytes, carryLength, vertexOffset + offsets.y);
    positions[positionBase + 2] = readFloat32LE(carryBytes, chunkBytes, carryLength, vertexOffset + offsets.z);

    scales[positionBase] = readFloat32LE(carryBytes, chunkBytes, carryLength, vertexOffset + offsets.scale_0);
    scales[positionBase + 1] = readFloat32LE(carryBytes, chunkBytes, carryLength, vertexOffset + offsets.scale_1);
    scales[positionBase + 2] = readFloat32LE(carryBytes, chunkBytes, carryLength, vertexOffset + offsets.scale_2);

    // rot_0..3 按原始顺序透传，后续在渲染阶段统一归一化并按四元数使用。
    const rotationBase = i * 4;
    rotations[rotationBase] = readFloat32LE(carryBytes, chunkBytes, carryLength, vertexOffset + offsets.rot_0);
    rotations[rotationBase + 1] = readFloat32LE(carryBytes, chunkBytes, carryLength, vertexOffset + offsets.rot_1);
    rotations[rotationBase + 2] = readFloat32LE(carryBytes, chunkBytes, carryLength, vertexOffset + offsets.rot_2);
    rotations[rotationBase + 3] = readFloat32LE(carryBytes, chunkBytes, carryLength, vertexOffset + offsets.rot_3);

    colors[positionBase] = readFloat32LE(carryBytes, chunkBytes, carryLength, vertexOffset + offsets.f_dc_0);
    colors[positionBase + 1] = readFloat32LE(carryBytes, chunkBytes, carryLength, vertexOffset + offsets.f_dc_1);
    colors[positionBase + 2] = readFloat32LE(carryBytes, chunkBytes, carryLength, vertexOffset + offsets.f_dc_2);

    opacities[i] = readFloat32LE(carryBytes, chunkBytes, carryLength, vertexOffset + offsets.opacity);
  }

  const consumedBytes = decodedCount * msg.layout.stride;
  const response: PlyDecodeResponse = {
    type: 'decoded',
    requestId: msg.requestId,
    batch: {
      start: msg.start,
      count: decodedCount,
      positions,
      scales,
      rotations,
      colors,
      opacities
    },
    nextCarry: makeNextCarry(msg.carry, msg.chunk, carryLength, consumedBytes, totalBytes),
    decodeMs: performance.now() - startMs
  };

  const transferables: ArrayBuffer[] = [positions.buffer, scales.buffer, rotations.buffer, colors.buffer, opacities.buffer];
  // 批次数组与 carry 都走 transferable，减少 worker 往返拷贝成本。
  if (response.nextCarry && response.nextCarry.buffer instanceof ArrayBuffer) {
    transferables.push(response.nextCarry.buffer);
  }
  ctx.postMessage(response, transferables);
};
