// Streamline generation over a vector field sampled on a STRUCTURED_POINTS (ImageData) grid.
// Inputs are in physical space using origin/spacing/dims. Output is a ribbon triangle mesh.

import { idx as index3 } from './vtk-legacy.mjs';

/**
 * Create a sampler for tri-linear interpolation of vector field.
 * @param {{dims:[number,number,number], spacing:[number,number,number], origin:[number,number,number], vectors:Float32Array}} field
 */
export function createVectorSampler(field) {
    const [nx, ny, nz] = field.dims;
    const [sx, sy, sz] = field.spacing;
    const [ox, oy, oz] = field.origin;
    const vec = field.vectors; // length 3*nx*ny*nz

    function getVecAt(i, j, k, out) {
        const n = nx * ny * nz;
        if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) {
            out[0] = out[1] = out[2] = 0; return out;
        }
        const id = index3(i, j, k, nx, ny, nz) * 3;
        out[0] = vec[id]; out[1] = vec[id + 1]; out[2] = vec[id + 2];
        return out;
    }

    /** Sample at world position (x,y,z); returns [vx,vy,vz]. */
    function sample(x, y, z, out) {
        // convert world to grid coords
        const gx = (x - ox) / sx;
        const gy = (y - oy) / sy;
        const gz = (z - oz) / sz;
        const i0 = Math.floor(gx), j0 = Math.floor(gy), k0 = Math.floor(gz);
        const i1 = i0 + 1, j1 = j0 + 1, k1 = k0 + 1;
        const tx = Math.min(1, Math.max(0, gx - i0));
        const ty = Math.min(1, Math.max(0, gy - j0));
        const tz = Math.min(1, Math.max(0, gz - k0));

        const c000 = tmp3(); getVecAt(i0, j0, k0, c000);
        const c100 = tmp3(); getVecAt(i1, j0, k0, c100);
        const c010 = tmp3(); getVecAt(i0, j1, k0, c010);
        const c110 = tmp3(); getVecAt(i1, j1, k0, c110);
        const c001 = tmp3(); getVecAt(i0, j0, k1, c001);
        const c101 = tmp3(); getVecAt(i1, j0, k1, c101);
        const c011 = tmp3(); getVecAt(i0, j1, k1, c011);
        const c111 = tmp3(); getVecAt(i1, j1, k1, c111);

        // interpolate
        for (let a = 0; a < 3; a++) {
            const x00 = c000[a] * (1 - tx) + c100[a] * tx;
            const x10 = c010[a] * (1 - tx) + c110[a] * tx;
            const x01 = c001[a] * (1 - tx) + c101[a] * tx;
            const x11 = c011[a] * (1 - tx) + c111[a] * tx;
            const y0 = x00 * (1 - ty) + x10 * ty;
            const y1 = x01 * (1 - ty) + x11 * ty;
            out[a] = y0 * (1 - tz) + y1 * tz;
        }
        return out;
    }

    return { sample };
}

/** Create a tri-linear sampler for a scalar field (Float32Array length nx*ny*nz). */
export function createScalarSampler(field, scalars) {
    const [nx, ny, nz] = field.dims;
    const [sx, sy, sz] = field.spacing;
    const [ox, oy, oz] = field.origin;
    function S(i, j, k) {
        if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return 0;
        return scalars[index3(i, j, k, nx, ny, nz)];
    }
    return {
        sample(x, y, z) {
            const gx = (x - ox) / sx;
            const gy = (y - oy) / sy;
            const gz = (z - oz) / sz;
            const i0 = Math.floor(gx), j0 = Math.floor(gy), k0 = Math.floor(gz);
            const i1 = i0 + 1, j1 = j0 + 1, k1 = k0 + 1;
            const tx = Math.min(1, Math.max(0, gx - i0));
            const ty = Math.min(1, Math.max(0, gy - j0));
            const tz = Math.min(1, Math.max(0, gz - k0));
            const x00 = S(i0, j0, k0) * (1 - tx) + S(i1, j0, k0) * tx;
            const x10 = S(i0, j1, k0) * (1 - tx) + S(i1, j1, k0) * tx;
            const x01 = S(i0, j0, k1) * (1 - tx) + S(i1, j0, k1) * tx;
            const x11 = S(i0, j1, k1) * (1 - tx) + S(i1, j1, k1) * tx;
            const y0 = x00 * (1 - ty) + x10 * ty;
            const y1 = x01 * (1 - ty) + x11 * ty;
            return y0 * (1 - tz) + y1 * tz;
        }
    };
}

function tmp3() { return [0, 0, 0]; }
function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
function len(a) { return Math.hypot(a[0], a[1], a[2]); }
function norm(a) { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }

/**
 * Integrate a streamline with RK4.
 * @param {{sample:(x:number,y:number,z:number,out:number[])=>number[]}} sampler
 * @param {{seed:[number,number,number], step:number, maxSteps:number, minSpeed:number, bounds:[[number,number,number],[number,number,number]]}} opts
 */
export function integrateStreamline(sampler, opts) {
    const pts = [];
    let p = opts.seed.slice(0);
    const [bmin, bmax] = opts.bounds;
    for (let s = 0; s < opts.maxSteps; s++) {
        if (p[0] < bmin[0] || p[1] < bmin[1] || p[2] < bmin[2] || p[0] > bmax[0] || p[1] > bmax[1] || p[2] > bmax[2]) break;
        const v1 = sampler.sample(p[0], p[1], p[2], tmp3());
        const sp = len(v1);
        if (!isFinite(sp) || sp < opts.minSpeed) break;
        const dir1 = norm(v1);
        const h = opts.step;
        // RK4
        const k1 = mul(dir1, h);
        const v2 = sampler.sample(p[0] + k1[0] * 0.5, p[1] + k1[1] * 0.5, p[2] + k1[2] * 0.5, tmp3());
        const k2 = mul(norm(v2), h);
        const v3 = sampler.sample(p[0] + k2[0] * 0.5, p[1] + k2[1] * 0.5, p[2] + k2[2] * 0.5, tmp3());
        const k3 = mul(norm(v3), h);
        const v4 = sampler.sample(p[0] + k3[0], p[1] + k3[1], p[2] + k3[2], tmp3());
        const k4 = mul(norm(v4), h);
        const dp = mul(add(add(k1, mul(k2, 2)), add(mul(k3, 2), k4)), 1/6);
        pts.push(p[0], p[1], p[2]);
        p = add(p, dp);
    }
    return pts; // flat [x,y,z,...]
}

/**
 * Generate many streamlines and build a ribbon triangle mesh.
 * @param {{dims:[number,number,number], spacing:[number,number,number], origin:[number,number,number], vectors:Float32Array}} field
 * @param {{seedStride?:number, step?:number, maxSteps?:number, minSpeed?:number, width?:number}} options
 * @returns {{ positions: Float32Array, normals: Float32Array, triCount: number, stats: any }}
 */
export function generateStreamlineRibbons(field, options = {}) {
    const [nx, ny, nz] = field.dims;
    const [sx, sy, sz] = field.spacing;
    const [ox, oy, oz] = field.origin;

    const seedStride = options.seedStride ?? 4; // in voxels
    const step = options.step ?? Math.min(sx, sy, sz) * 0.75;
    const maxSteps = options.maxSteps ?? 200;
    const minSpeed = options.minSpeed ?? 1e-5;
    const width = options.width ?? Math.min(sx, sy, sz) * 0.5;
    const seedPlane = options.seedPlane || 'XZ'; // 'XZ' | 'XY' | 'YZ'
    const seedOffset = options.seedOffset; // 0..1 optional
    const seedIndex = options.seedIndex; // integer optional (dominates offset)
    const seedJitter = options.seedJitter ?? 0; // in world units multiplier (0..1)

    const sampler = createVectorSampler(field);
    const bmin = [ox, oy, oz];
    const bmax = [ox + (nx - 1) * sx, oy + (ny - 1) * sy, oz + (nz - 1) * sz];

    const ribbons = [];
    let seedCount = 0;
    // Choose plane slice index
    const planeK = (n, off, idx) => {
        if (typeof idx === 'number' && isFinite(idx)) return Math.max(0, Math.min(n - 1, Math.round(idx)));
        const o = (typeof off === 'number' && isFinite(off)) ? off : 0.5;
        return Math.max(0, Math.min(n - 1, Math.round(o * (n - 1))));
    };
    if (seedPlane === 'XZ') {
        const j = planeK(ny, seedOffset, seedIndex);
        for (let i = 1; i < nx - 1; i += seedStride) for (let k = 1; k < nz - 1; k += seedStride) {
            const rx = (Math.random() - 0.5) * seedJitter * sx;
            const rz = (Math.random() - 0.5) * seedJitter * sz;
            const seed = [ox + i * sx + rx, oy + j * sy, oz + k * sz + rz];
            const pts = integrateStreamline(sampler, { seed, step, maxSteps, minSpeed, bounds: [bmin, bmax] });
            if (pts.length >= 6 * 3) ribbons.push(pts);
            seedCount++;
        }
    } else if (seedPlane === 'XY') {
        const k = planeK(nz, seedOffset, seedIndex);
        for (let j = 1; j < ny - 1; j += seedStride) for (let i = 1; i < nx - 1; i += seedStride) {
            const rx = (Math.random() - 0.5) * seedJitter * sx;
            const ry = (Math.random() - 0.5) * seedJitter * sy;
            const seed = [ox + i * sx + rx, oy + j * sy + ry, oz + k * sz];
            const pts = integrateStreamline(sampler, { seed, step, maxSteps, minSpeed, bounds: [bmin, bmax] });
            if (pts.length >= 6 * 3) ribbons.push(pts);
            seedCount++;
        }
    } else { // 'YZ'
        const i = planeK(nx, seedOffset, seedIndex);
        for (let j = 1; j < ny - 1; j += seedStride) for (let k = 1; k < nz - 1; k += seedStride) {
            const ry = (Math.random() - 0.5) * seedJitter * sy;
            const rz = (Math.random() - 0.5) * seedJitter * sz;
            const seed = [ox + i * sx, oy + j * sy + ry, oz + k * sz + rz];
            const pts = integrateStreamline(sampler, { seed, step, maxSteps, minSpeed, bounds: [bmin, bmax] });
            if (pts.length >= 6 * 3) ribbons.push(pts);
            seedCount++;
        }
    }

    // Build ribbons to triangles
    const positions = [];
    const normals = [];
    const uvs = [];
    let triCount = 0;
    const up = [0, 1, 0];
    for (const line of ribbons) {
        const npts = line.length / 3;
        if (npts < 2) continue;
        // precompute tangents
        const tangents = new Array(npts);
        // precompute cumulative distance for UV.t
        const cum = new Array(npts).fill(0);
        for (let p = 0; p < npts; p++) {
            const getP = (k) => [line[k*3], line[k*3+1], line[k*3+2]];
            const a = getP(Math.max(0, p - 1));
            const b = getP(Math.min(npts - 1, p + 1));
            tangents[p] = norm(sub(b, a));
            if (p > 0) {
                const prev = getP(p - 1);
                const cur = getP(p);
                cum[p] = cum[p-1] + Math.hypot(cur[0]-prev[0], cur[1]-prev[1], cur[2]-prev[2]);
            }
        }
        const totalLen = cum[npts - 1] || 1;
        let prevL = null, prevR = null;
        let tPrev = 0;
        for (let p = 0; p < npts; p++) {
            const pos = [line[p*3], line[p*3+1], line[p*3+2]];
            const t = tangents[p];
            let n = cross(t, up);
            if (len(n) < 1e-6) n = cross(t, [1,0,0]);
            n = norm(n);
            const L = [pos[0] - n[0]*width*0.5, pos[1] - n[1]*width*0.5, pos[2] - n[2]*width*0.5];
            const R = [pos[0] + n[0]*width*0.5, pos[1] + n[1]*width*0.5, pos[2] + n[2]*width*0.5];
            const tCur = (totalLen > 0 ? (cum[p] / totalLen) : 0);
            if (p > 0) {
                // create two triangles: prevL, prevR, R and prevL, R, L
                positions.push(
                    prevL[0], prevL[1], prevL[2],  prevR[0], prevR[1], prevR[2],  R[0], R[1], R[2],
                    prevL[0], prevL[1], prevL[2],  R[0], R[1], R[2],              L[0], L[1], L[2]
                );
                // approximate normals: use face normal from triangle planes or use n
                for (let m = 0; m < 6; m++) normals.push(n[0], n[1], n[2]);
                // UVs: u = progress along polyline, v = 0
                uvs.push(
                    tPrev, 0,   tPrev, 0,   tCur, 0,
                    tPrev, 0,   tCur, 0,    tCur, 0
                );
                triCount += 2;
            }
            prevL = L; prevR = R; tPrev = tCur;
        }
    }

    return {
        positions: new Float32Array(positions),
        normals: new Float32Array(normals),
        uvs: new Float32Array(uvs),
        triCount,
        stats: { ribbons: ribbons.length, seeds: seedCount }
    };
}
