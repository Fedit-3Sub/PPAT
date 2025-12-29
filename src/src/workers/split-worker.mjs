// Mesh split worker (TypedArray + progress + cancel)
// Messages:
//  - { cmd: 'start', pos:ArrayBuffer, nor:ArrayBuffer|null, epsilon:number, minTriangles:number }
//  - { cmd: 'cancel' }
// Posts:
//  - { type: 'progress', value:number, phase:string }
//  - { type: 'done', parts:[{ positions:ArrayBuffer, normals:ArrayBuffer|null, min:number[], max:number[], triCount:number }] }
//  - { type: 'canceled' }
//  - { type: 'error', message:string }

let __canceled = false;

function postProgress(value, phase) {
    try { postMessage({ type: 'progress', value, phase }); } catch (_) {}
}

onmessage = (e) => {
    const msg = e.data || {};
    if (msg.cmd === 'cancel') { __canceled = true; return; }
    if (msg.cmd === 'start') {
        __canceled = false;
        try {
            const positions = new Float32Array(msg.pos);
            const normals = msg.nor ? new Float32Array(msg.nor) : null;
            const epsilon = (typeof msg.epsilon === 'number' && isFinite(msg.epsilon) && msg.epsilon > 0) ? msg.epsilon : 1e-4;
            const minTriangles = (msg.minTriangles|0) > 0 ? (msg.minTriangles|0) : 1;

            const result = splitMeshByConnectivity(positions, normals, { epsilon, minTriangles });
            if (__canceled) { try { postMessage({ type: 'canceled' }); } catch (_) {} return; }

            // Transfer buffers back
            const transfers = [];
            for (const p of result) {
                if (p.positions && p.positions.buffer) transfers.push(p.positions.buffer);
                if (p.normals && p.normals.buffer) transfers.push(p.normals.buffer);
            }
            postMessage({ type: 'done', parts: result.map(p => ({
                positions: p.positions.buffer,
                normals: p.normals ? p.normals.buffer : null,
                min: p.min, max: p.max, triCount: p.triCount
            })) }, transfers);
        } catch (err) {
            try { postMessage({ type: 'error', message: String(err && err.message || err) }); } catch (_) {}
        }
    }
};

function splitMeshByConnectivity(positions, normals, options) {
    const eps = options.epsilon || 1e-4;
    const minTris = options.minTriangles || 1;
    const triCount = (positions.length / 9) | 0;
    const vertCount = triCount * 3;

    if (!triCount) return [];

    // 1) Spatial hash + welding
    const cell = (x) => Math.round(x / eps);
    const key = (ix, iy, iz) => `${ix},${iy},${iz}`;
    const buckets = new Map(); // key -> array of repr ids
    const reprPos = new Float32Array(Math.max(1, Math.min(vertCount, 1 << 24)) * 3); // will grow manually
    let reprPosLen = 0; // number of repr vertices
    const welded = new Int32Array(vertCount);

    const checkCanceledEvery = 50000;
    const reportEvery = Math.max(1, (vertCount / 20) | 0);

    for (let vi = 0; vi < vertCount; vi++) {
        if (__canceled && (vi % checkCanceledEvery === 0)) return [];
        if (vi % reportEvery === 0) postProgress(vi / vertCount * 0.33, 'welding');
        const x = positions[vi * 3];
        const y = positions[vi * 3 + 1];
        const z = positions[vi * 3 + 2];
        const ix = cell(x), iy = cell(y), iz = cell(z);
        let found = -1;
        for (let dx = -1; dx <= 1 && found < 0; dx++)
            for (let dy = -1; dy <= 1 && found < 0; dy++)
                for (let dz = -1; dz <= 1 && found < 0; dz++) {
                    const arr = buckets.get(key(ix + dx, iy + dy, iz + dz));
                    if (!arr) continue;
                    for (let k = 0; k < arr.length; k++) {
                        const rid = arr[k];
                        const ox = reprPos[rid * 3];
                        const oy = reprPos[rid * 3 + 1];
                        const oz = reprPos[rid * 3 + 2];
                        const dx2 = x - ox, dy2 = y - oy, dz2 = z - oz;
                        if (dx2 * dx2 + dy2 * dy2 + dz2 * dz2 <= eps * eps) { found = rid; break; }
                    }
                }
        if (found >= 0) {
            welded[vi] = found;
        } else {
            // ensure reprPos capacity
            const rid = reprPosLen++;
            reprPos[rid * 3] = x; reprPos[rid * 3 + 1] = y; reprPos[rid * 3 + 2] = z;
            const k = key(ix, iy, iz);
            let arr = buckets.get(k); if (!arr) { arr = []; buckets.set(k, arr); }
            arr.push(rid);
            welded[vi] = rid;
        }
    }

    // 2) Triangles → components (union via first-seen triangle per welded vertex)
    const parent = new Int32Array(triCount); for (let i = 0; i < triCount; i++) parent[i] = i;
    const find = (x) => parent[x] === x ? x : (parent[x] = find(parent[x]));
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };

    const firstTriOfVert = new Map(); // welded vert id -> first triangle index
    const reportEvery2 = Math.max(1, (triCount / 20) | 0);
    for (let ti = 0; ti < triCount; ti++) {
        if (__canceled && (ti % checkCanceledEvery === 0)) return [];
        if (ti % reportEvery2 === 0) postProgress(0.33 + (ti / triCount) * 0.33, 'connect');
        const a = welded[ti * 3], b = welded[ti * 3 + 1], c = welded[ti * 3 + 2];
        const verts = [a, b, c];
        for (let v = 0; v < 3; v++) {
            const w = verts[v];
            const ft = firstTriOfVert.get(w);
            if (ft === undefined) firstTriOfVert.set(w, ti); else union(ti, ft);
        }
    }

    // 3) Count components
    const groupCount = new Map(); // root -> triCount
    for (let ti = 0; ti < triCount; ti++) {
        const r = find(ti);
        groupCount.set(r, (groupCount.get(r) | 0) + 1);
    }
    // Filter by minTris and index groups
    const groups = [];
    for (const [root, cnt] of groupCount.entries()) {
        if (cnt >= minTris) groups.push({ root, triCount: cnt });
    }
    if (__canceled) return [];

    // 4) Allocate buffers per component
    for (const g of groups) {
        g.positions = new Float32Array(g.triCount * 9);
        g.normals = normals && normals.length ? new Float32Array(g.triCount * 9) : null;
        g.min = [Infinity, Infinity, Infinity];
        g.max = [-Infinity, -Infinity, -Infinity];
        g.write = 0; // number of triangles already written
    }
    const groupIndex = new Map(groups.map((g, i) => [g.root, i]));

    // 5) Fill
    const reportEvery3 = Math.max(1, (triCount / 20) | 0);
    for (let ti = 0; ti < triCount; ti++) {
        if (__canceled && (ti % checkCanceledEvery === 0)) return [];
        if (ti % reportEvery3 === 0) postProgress(0.66 + (ti / triCount) * 0.34, 'pack');
        const r = find(ti);
        const gi = groupIndex.get(r);
        if (gi === undefined) continue; // filtered out by minTris
        const g = groups[gi];
        const dstTri = g.write++;
        const dstP = dstTri * 9;
        const srcP = ti * 9;
        // copy positions (and normals)
        for (let k = 0; k < 9; k++) g.positions[dstP + k] = positions[srcP + k];
        if (g.normals) { for (let k = 0; k < 9; k++) g.normals[dstP + k] = normals[srcP + k]; }
        // bounds
        for (let v = 0; v < 3; v++) {
            const x = positions[srcP + v * 3], y = positions[srcP + v * 3 + 1], z = positions[srcP + v * 3 + 2];
            if (x < g.min[0]) g.min[0] = x; if (y < g.min[1]) g.min[1] = y; if (z < g.min[2]) g.min[2] = z;
            if (x > g.max[0]) g.max[0] = x; if (y > g.max[1]) g.max[1] = y; if (z > g.max[2]) g.max[2] = z;
        }
    }

    // 6) Build parts array
    const parts = groups.map(g => ({ positions: g.positions, normals: g.normals, min: g.min, max: g.max, triCount: g.triCount }));
    return parts;
}
