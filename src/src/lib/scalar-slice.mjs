// Scalar slice utilities: build a colored slice mesh from 3 points over a STRUCTURED_POINTS scalar field
// Relies on tri-linear sampler from streamlines.mjs

import { createScalarSampler } from './streamlines.mjs';

/** Normalize a 3D vector. */
function norm(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0]/l, v[1]/l, v[2]/l]; }
function sub(a,b){ return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function add(a,b){ return [a[0]+b[0], a[1]+b[1], a[2]+b[2]]; }
function mul(a,s){ return [a[0]*s, a[1]*s, a[2]*s]; }
function dot(a,b){ return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
function cross(a,b){ return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }

/**
 * Compute plane frame from 3 points.
 * @param {[number,number,number]} p0
 * @param {[number,number,number]} p1
 * @param {[number,number,number]} p2
 * @returns {{origin:number[], u:number[], v:number[], n:number[]}}
 */
export function planeFromPoints(p0, p1, p2) {
    const e1 = sub(p1, p0);
    const e2 = sub(p2, p0);
    let n = cross(e1, e2);
    n = norm(n);
    // robust basis: u along e1 (unless degenerate), v = n x u
    let u = e1;
    if (Math.hypot(u[0], u[1], u[2]) < 1e-12) u = [1,0,0];
    u = norm(u);
    let v = cross(n, u);
    const lv = Math.hypot(v[0], v[1], v[2]);
    if (lv < 1e-12) { // fallback: pick arbitrary orthonormal
        u = [1,0,0]; v = [0,1,0]; n = [0,0,1];
    } else {
        v = [v[0]/lv, v[1]/lv, v[2]/lv];
    }
    return { origin: [...p0], u, v, n };
}

/**
 * Intersect plane with AABB; return convex polygon points on plane (3D).
 * Plane is given by {origin,u,v,n}. AABB by min[] and max[].
 * @returns {number[][]} array of 3D points ordered around centroid
 */
export function intersectPlaneAABB(plane, bmin, bmax) {
    const corners = [
        [bmin[0], bmin[1], bmin[2]], [bmax[0], bmin[1], bmin[2]],
        [bmin[0], bmax[1], bmin[2]], [bmax[0], bmax[1], bmin[2]],
        [bmin[0], bmin[1], bmax[2]], [bmax[0], bmin[1], bmax[2]],
        [bmin[0], bmax[1], bmax[2]], [bmax[0], bmax[1], bmax[2]]
    ];
    const edges = [
        [0,1],[0,2],[1,3],[2,3], // bottom square
        [4,5],[4,6],[5,7],[6,7], // top square
        [0,4],[1,5],[2,6],[3,7]  // verticals
    ];
    const d0 = dot(plane.n, plane.origin);
    function side(p){ return dot(plane.n, p) - d0; }
    /** @type {number[][]} */
    const pts = [];
    for (const [a,b] of edges) {
        const A = corners[a], B = corners[b];
        const sa = side(A), sb = side(B);
        if (Math.abs(sa) < 1e-8 && Math.abs(sb) < 1e-8) {
            // edge lies on plane — include endpoints
            pts.push([...A], [...B]);
        } else if (sa * sb <= 0) {
            const t = sa / (sa - sb + 1e-20);
            if (t >= -1e-6 && t <= 1+1e-6) {
                const P = [A[0] + (B[0]-A[0])*t, A[1] + (B[1]-A[1])*t, A[2] + (B[2]-A[2])*t];
                pts.push(P);
            }
        }
    }
    // dedupe close points
    const out = [];
    for (const p of pts) {
        if (!out.some(q => Math.hypot(p[0]-q[0], p[1]-q[1], p[2]-q[2]) < 1e-5)) out.push(p);
    }
    if (out.length < 3) return [];
    // order around centroid in plane UV coordinates
    const uv = out.map(p => {
        const r = sub(p, plane.origin);
        return [dot(r, plane.u), dot(r, plane.v)];
    });
    const cx = uv.reduce((s,v)=>s+v[0],0)/uv.length;
    const cy = uv.reduce((s,v)=>s+v[1],0)/uv.length;
    const idx = uv.map((v,i)=>({i, ang: Math.atan2(v[1]-cy, v[0]-cx)})).sort((a,b)=>a.ang-b.ang).map(o=>o.i);
    return idx.map(i=>out[i]);
}

/** Project 3D point to plane (u,v). */
export function projectToPlaneUV(plane, p){ const r = sub(p, plane.origin); return [dot(r, plane.u), dot(r, plane.v)]; }
export function uvToPoint(plane, u, v){ return add(plane.origin, add(mul(plane.u,u), mul(plane.v,v))); }

/** Point-in-convex-polygon test in UV (polygon CCW). */
function pointInPoly2(uv, poly) {
    // ray-casting for general polygon
    let c = false; const x = uv[0], y = uv[1];
    for (let i=0, j=poly.length-1; i<poly.length; j=i++){
        const xi = poly[i][0], yi = poly[i][1];
        const xj = poly[j][0], yj = poly[j][1];
        const inter = ((yi>y)!==(yj>y)) && (x < (xj-xi)*(y-yi)/(yj-yi+1e-20)+xi);
        if (inter) c = !c;
    }
    return c;
}

/**
 * Build a regular grid slice over the plane covering the AABB∩plane polygon.
 * @param {{dims:[number,number,number], spacing:[number,number,number], origin:[number,number,number]}} field
 * @param {Float32Array} scalars length nx*ny*nz
 * @param {{origin:number[],u:number[],v:number[],n:number[]}} plane
 * @param {number[]} bmin
 * @param {number[]} bmax
 * @param {{resU:number,resV:number, colorMap:(t:number)=>number[], min:number,max:number, reverse?:boolean}} opts
 * @returns {{ positions: Float32Array, normals: Float32Array, colors: Float32Array, triCount: number, stats:any, uvs: Float32Array }}
 */
export function buildScalarSlice(field, scalars, plane, bmin, bmax, opts){
    const poly3 = intersectPlaneAABB(plane, bmin, bmax);
    if (!poly3.length) return { positions: new Float32Array(), normals: new Float32Array(), colors: new Float32Array(), uvs: new Float32Array(), triCount: 0, stats: { verts:0, tris:0 } };
    const poly2 = poly3.map(p => projectToPlaneUV(plane, p));
    let uMin=Infinity,uMax=-Infinity,vMin=Infinity,vMax=-Infinity;
    for (const [u,v] of poly2){ if (u<uMin)uMin=u; if (u>uMax)uMax=u; if (v<vMin)vMin=v; if (v>vMax)vMax=v; }
    const resU = Math.max(2, Math.floor(opts.resU||128));
    const resV = Math.max(2, Math.floor(opts.resV||128));
    const du = (uMax-uMin) / (resU-1);
    const dv = (vMax-vMin) / (resV-1);
    const sampler = createScalarSampler(field, scalars);
    const positions = new Float32Array((resU*resV) * 3);
    const normals = new Float32Array((resU*resV) * 3);
    const colors = new Float32Array((resU*resV) * 4);
    const uvs = new Float32Array((resU*resV) * 2);
    const n = plane.n; // constant normal
    const inv = 1/(opts.max - opts.min + 1e-8);
    // build vertices
    let vi3=0, vi4=0, vi2=0;
    for (let j=0;j<resV;j++){
        for (let i=0;i<resU;i++){
            const u = uMin + du * i;
            const v = vMin + dv * j;
            const P = uvToPoint(plane, u, v);
            positions[vi3+0]=P[0]; positions[vi3+1]=P[1]; positions[vi3+2]=P[2];
            normals[vi3+0]=n[0]; normals[vi3+1]=n[1]; normals[vi3+2]=n[2];
            // color by scalar
            const val = sampler.sample(P[0], P[1], P[2]);
            let t = (val - opts.min) * inv; if (opts.reverse) t = 1 - t; t = Math.max(0, Math.min(1, t));
            const c = opts.colorMap(t);
            colors[vi4+0]=c[0]; colors[vi4+1]=c[1]; colors[vi4+2]=c[2];
            // alpha: inside polygon → 1, outside → 0 (for soft clipping)
            const inside = pointInPoly2([u,v], poly2);
            colors[vi4+3]= inside ? 1.0 : 0.0;
            // uv 0..1 across the rectangle (for future use)
            uvs[vi2+0] = (u - uMin) / (uMax - uMin + 1e-20);
            uvs[vi2+1] = (v - vMin) / (vMax - vMin + 1e-20);
            vi3 += 3; vi4 += 4; vi2 += 2;
        }
    }
    // indices as triangle list; we will expand to positions directly (no index) to match existing utilities
    const tris = [];
    let triCount = 0;
    const pushTri = (a,b,c) => { tris.push(a,b,c); triCount++; };
    const idx = (i,j)=> j*resU + i;
    for (let j=0;j<resV-1;j++){
        for (let i=0;i<resU-1;i++){
            const a=idx(i,j), b=idx(i+1,j), c=idx(i+1,j+1), d=idx(i,j+1);
            // Triangle filtering: include if any vertex alpha>0
            const aIn = colors[a*4+3]>0, bIn = colors[b*4+3]>0, cIn = colors[c*4+3]>0, dIn = colors[d*4+3]>0;
            if (aIn || bIn || cIn) { pushTri(a,b,c); }
            if (aIn || cIn || dIn) { pushTri(a,c,d); }
        }
    }
    // Expand to non-indexed buffers
    const outPos = new Float32Array(triCount * 3 * 3);
    const outNor = new Float32Array(triCount * 3 * 3);
    const outCol = new Float32Array(triCount * 3 * 4);
    const outUv  = new Float32Array(triCount * 3 * 2);
    for (let t=0, p3=0, n3=0, c4=0, u2=0; t<tris.length; t++){
        const k = tris[t];
        outPos[p3++]=positions[k*3+0]; outPos[p3++]=positions[k*3+1]; outPos[p3++]=positions[k*3+2];
        outNor[n3++]=normals[k*3+0]; outNor[n3++]=normals[k*3+1]; outNor[n3++]=normals[k*3+2];
        outCol[c4++]=colors[k*4+0]; outCol[c4++]=colors[k*4+1]; outCol[c4++]=colors[k*4+2]; outCol[c4++]=colors[k*4+3];
        outUv[u2++]=uvs[k*2+0]; outUv[u2++]=uvs[k*2+1];
    }
    return { positions: outPos, normals: outNor, colors: outCol, uvs: outUv, triCount, stats: { verts: resU*resV, tris: triCount } };
}
