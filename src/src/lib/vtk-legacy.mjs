// Minimal Legacy VTK (BINARY) reader for STRUCTURED_POINTS datasets
// Supports:
// - DIMENSIONS nx ny nz
// - SPACING sx sy sz
// - ORIGIN ox oy oz
// - POINT_DATA N
// - SCALARS <name> float
//   LOOKUP_TABLE default
//   <binary float32 big-endian data for N points>
// - VECTORS <name> float
//   <binary float32 big-endian data for 3*N values>
//
// Returns an object:
// {
//   dims: [nx, ny, nz],
//   spacing: [sx, sy, sz],
//   origin: [ox, oy, oz],
//   count: N,
//   scalars?: Float32Array,
//   scalarsName?: string,
//   vectors?: Float32Array, // length 3*N in XYZ order per point
//   vectorsName?: string
// }

/**
 * Read a single ASCII line starting at byte offset. Returns { text, next }.
 * Handles both \n and \r\n.
 * @param {Uint8Array} bytes
 * @param {number} offset
 */
function readLine(bytes, offset) {
    const n = bytes.length;
    let i = offset;
    let start = offset;
    for (; i < n; i++) {
        const b = bytes[i];
        if (b === 10 /*\n*/ || b === 13 /*\r*/) {
            // consume \r\n pair
            let next = i + 1;
            if (b === 13 && next < n && bytes[next] === 10) next++;
            const text = new TextDecoder('ascii').decode(bytes.subarray(start, i)).trim();
            return { text, next };
        }
    }
    // EOF line
    const text = new TextDecoder('ascii').decode(bytes.subarray(start, n)).trim();
    return { text, next: n };
}

/** Swap endianness of a Float32Array view in-place (4-byte words). */
function swap32(buf) {
    const u32 = new Uint32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    for (let i = 0; i < u32.length; i++) {
        const v = u32[i];
        u32[i] = ((v & 0xFF) << 24) | ((v & 0xFF00) << 8) | ((v >>> 8) & 0xFF00) | ((v >>> 24) & 0xFF);
    }
}

// NOTE: Legacy VTK BINARY uses big-endian floats. JavaScript runs on little-endian.
// Therefore we should swap bytes unconditionally for BINARY data.
// We keep the old heuristic out to avoid accidentally skipping swap for "plausible" garbage values.

/**
 * Parse Legacy VTK BINARY STRUCTURED_POINTS from ArrayBuffer.
 * Only the subset we need is implemented.
 * @param {ArrayBuffer} buffer
 */
export function parseLegacyStructuredPoints(buffer) {
    const bytes = new Uint8Array(buffer);
    let off = 0;

    // Header line 1: # vtk DataFile Version x.x (ignored)
    let r = readLine(bytes, off); off = r.next;
    // Header line 2: comment (ignored)
    r = readLine(bytes, off); off = r.next;
    // Header line 3: BINARY / ASCII
    r = readLine(bytes, off); off = r.next;
    const isBinary = /BINARY/i.test(r.text);
    if (!isBinary) throw new Error('Only BINARY legacy VTK is supported');
    // Header line 4: DATASET STRUCTURED_POINTS
    r = readLine(bytes, off); off = r.next;
    if (!/DATASET\s+STRUCTURED_POINTS/i.test(r.text)) throw new Error('Only DATASET STRUCTURED_POINTS is supported');

    let dims = [1, 1, 1];
    let spacing = [1, 1, 1];
    let origin = [0, 0, 0];
    let pointCount = 0;
    let scalarsName = null;
    let vectorsName = null;
    /** @type {Float32Array|null} */
    let scalars = null;
    /** @type {Float32Array|null} */
    let vectors = null;

    // Parse metadata lines until POINT_DATA
    while (off < bytes.length) {
        r = readLine(bytes, off); off = r.next;
        const line = r.text;
        if (!line) continue;
        if (/^DIMENSIONS/i.test(line)) {
            const parts = line.split(/\s+/);
            dims = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
        } else if (/^SPACING/i.test(line)) {
            const parts = line.split(/\s+/);
            spacing = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
        } else if (/^ORIGIN/i.test(line)) {
            const parts = line.split(/\s+/);
            origin = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
        } else if (/^POINT_DATA/i.test(line)) {
            const parts = line.split(/\s+/);
            pointCount = Number(parts[1]);
            break;
        }
    }

    if (pointCount <= 0) throw new Error('Invalid or missing POINT_DATA');

    // Now parse attribute blocks (SCALARS + LOOKUP_TABLE + data, VECTORS + data)
    const dv = new DataView(buffer);
    const little = true; // JS is little-endian

    function readFloat32Array(count) {
        const bytesLen = count * 4;
        const arr = new Float32Array(buffer.slice(off, off + bytesLen));
        off += bytesLen;
        // Legacy VTK BINARY is big-endian → always swap on little-endian JS
        // (Allow developers to override for debugging with globalThis.__VTK_NO_SWAP__)
        try {
            const noSwap = typeof globalThis !== 'undefined' && !!globalThis.__VTK_NO_SWAP__;
            if (little && !noSwap) swap32(arr);
        } catch (_) {
            if (little) swap32(arr);
        }
        return arr;
    }

    while (off < bytes.length) {
        // Read next non-empty line (header of next block)
        r = readLine(bytes, off); off = r.next;
        let line = r.text;
        if (!line) continue;
        if (/^SCALARS/i.test(line)) {
            const parts = line.split(/\s+/);
            scalarsName = parts[1] || 'scalars';
            // Next line should be LOOKUP_TABLE ...
            r = readLine(bytes, off); off = r.next;
            // Then binary block of N float32
            scalars = readFloat32Array(pointCount);
        } else if (/^VECTORS/i.test(line)) {
            const parts = line.split(/\s+/);
            vectorsName = parts[1] || 'vectors';
            vectors = readFloat32Array(pointCount * 3);
        } else {
            // Unknown or end
            // If we encounter another keyword like CELL_DATA, stop.
            if (/^CELL_DATA/i.test(line)) break;
        }
    }

    return {
        dims, spacing, origin, count: pointCount,
        scalars, scalarsName: scalarsName || undefined,
        vectors, vectorsName: vectorsName || undefined
    };
}

/** Compute flat array index for (i,j,k) with x-fastest layout. */
export function idx(i, j, k, nx, ny, nz) { return i + j * nx + k * nx * ny; }
