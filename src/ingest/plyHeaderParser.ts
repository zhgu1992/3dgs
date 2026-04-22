import type { PlyHeaderLayout } from './plyProtocol';

const REQUIRED_FLOAT_PROPERTIES = [
  'x',
  'y',
  'z',
  'scale_0',
  'scale_1',
  'scale_2',
  'rot_0',
  'rot_1',
  'rot_2',
  'rot_3',
  'opacity',
  'f_dc_0',
  'f_dc_1',
  'f_dc_2'
] as const;

const FLOAT_TYPES = new Set(['float', 'float32']);
const HEADER_END_TOKEN = 'end_header';

function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function computeHeaderLayoutHash(layout: PlyHeaderLayout): string {
  const orderedOffsets = layout.propertyNames.map((name) => `${name}:${layout.offsets[name]}`).join(',');
  return fnv1a32(`${layout.vertexCount}|${layout.stride}|${orderedOffsets}|${layout.headerByteLength}`);
}

function findHeaderEndByteLength(buffer: Uint8Array): number {
  const text = new TextDecoder('utf-8').decode(buffer);
  const tokenIndex = text.indexOf(HEADER_END_TOKEN);
  if (tokenIndex < 0) {
    return -1;
  }

  const afterToken = tokenIndex + HEADER_END_TOKEN.length;
  let lineEndIndex = afterToken;
  if (text[lineEndIndex] === '\r') {
    lineEndIndex += 1;
  }
  if (text[lineEndIndex] === '\n') {
    lineEndIndex += 1;
  }

  return new TextEncoder().encode(text.slice(0, lineEndIndex)).byteLength;
}

export function detectPlyHeaderByteLength(buffer: Uint8Array): number {
  return findHeaderEndByteLength(buffer);
}

function assertFloatProperty(type: string, name: string): void {
  if (!FLOAT_TYPES.has(type)) {
    throw new Error(`Unsupported PLY property type "${type}" for "${name}". Only float properties are supported.`);
  }
}

export function parsePlyHeader(buffer: ArrayBuffer): PlyHeaderLayout {
  const bytes = new Uint8Array(buffer);
  const headerByteLength = findHeaderEndByteLength(bytes);
  if (headerByteLength < 0) {
    throw new Error('PLY header is missing end_header.');
  }

  const headerText = new TextDecoder('utf-8').decode(bytes.subarray(0, headerByteLength));
  const lines = headerText.split(/\r?\n/).filter((line) => line.length > 0);

  if (lines[0] !== 'ply') {
    throw new Error('Invalid PLY file: missing ply magic.');
  }

  let formatSeen = false;
  let vertexCount = -1;
  let currentElement: string | null = null;
  const offsets: Record<string, number> = {};
  const propertyNames: string[] = [];
  let stride = 0;

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    const parts = line.trim().split(/\s+/);
    if (parts.length === 0) {
      continue;
    }

    if (parts[0] === 'comment' || parts[0] === 'obj_info') {
      continue;
    }

    if (parts[0] === 'format') {
      if (formatSeen) {
        throw new Error('PLY header declares format more than once.');
      }
      if (parts[1] !== 'binary_little_endian') {
        throw new Error(`Unsupported PLY format "${parts[1]}". Expected binary_little_endian.`);
      }
      formatSeen = true;
      continue;
    }

    if (parts[0] === 'element') {
      currentElement = parts[1] ?? null;
      if (currentElement === 'vertex') {
        const count = Number(parts[2]);
        if (!Number.isInteger(count) || count < 0) {
          throw new Error(`Invalid vertex count "${parts[2]}".`);
        }
        vertexCount = count;
      }
      continue;
    }

    if (parts[0] === 'property' && currentElement === 'vertex') {
      if (parts[1] === 'list') {
        throw new Error('PLY list properties are not supported for vertex decoding.');
      }
      const type = parts[1];
      const name = parts[2];
      if (!type || !name) {
        throw new Error(`Malformed PLY property line: "${line}".`);
      }
      assertFloatProperty(type, name);
      if (offsets[name] !== undefined) {
        throw new Error(`Duplicate vertex property "${name}".`);
      }
      offsets[name] = stride;
      propertyNames.push(name);
      stride += 4;
      continue;
    }
  }

  if (!formatSeen) {
    throw new Error('PLY header is missing a format declaration.');
  }
  if (vertexCount < 0) {
    throw new Error('PLY header is missing a vertex element.');
  }

  for (const propertyName of REQUIRED_FLOAT_PROPERTIES) {
    if (offsets[propertyName] === undefined) {
      throw new Error(`PLY vertex layout is missing required property "${propertyName}".`);
    }
  }

  return {
    vertexCount,
    stride,
    offsets,
    propertyNames,
    headerByteLength
  };
}
