// PCUI v5 styles: module injects CSS at runtime (replaces old SCSS import path)
import '@playcanvas/pcui/styles';

import * as pc from 'playcanvas';
import Split from 'split.js';
import React from 'react';
import {createRoot} from 'react-dom/client';
import {Observer} from '@playcanvas/observer';
import JSZip from 'jszip';

import {fragment, jsx} from './jsx.mjs';
import {controls} from './controls.mjs';
import {CameraControls} from './lib/camera-controls.mjs';
import {Grid} from './lib/grid.mjs';
import {GizmoHandler} from './gizmo-handler.mjs';
import {Selector} from './selector.mjs';
import {HistoryManager} from './history.mjs';
import {parseLegacyStructuredPoints} from './lib/vtk-legacy.mjs';
import {createScalarSampler, createVectorSampler, generateStreamlineRibbons} from './lib/streamlines.mjs';
import {buildScalarSlice, planeFromPoints} from './lib/scalar-slice.mjs';

// Canvas
const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('application-canvas'));
window.focus();

// Observer (shared UI <-> engine state)
const data = new Observer({});

// UI preferences (persisted)
// Help HUD visibility
try {
    const lsKey = 'se9.ui.showHelpHUD';
    const raw = localStorage.getItem(lsKey);
    const enabled = (raw === null) ? true : (raw === '1' || raw === 'true');
    data.set('ui.showHelpHUD', enabled);
    // persist on change
    if (typeof data.on === 'function') {
        // Observer callback signature differs between patterns:
        // - 'ui.showHelpHUD:set' → receives (value)
        // - '*:set' → receives (path, value)
        data.on('ui.showHelpHUD:set', function () {
            try {
                const v = arguments.length === 1 ? arguments[0] : arguments[1];
                const on = !!v;
                localStorage.setItem(lsKey, on ? '1' : '0');
            } catch (_) { /* ignore */
            }
        });
    }
} catch (_) { /* ignore */
}

// Shadows visibility (Settings → ON/OFF)
try {
    const lsKeySh = 'se9.ui.shadowsEnabled';
    const rawSh = localStorage.getItem(lsKeySh);
    const enabledSh = (rawSh === null) ? true : (rawSh === '1' || rawSh === 'true');
    data.set('ui.shadowsEnabled', enabledSh);
    if (typeof data.on === 'function') {
        data.on('ui.shadowsEnabled:set', function () {
            try {
                const v = arguments.length === 1 ? arguments[0] : arguments[1];
                const on = !!v;
                localStorage.setItem(lsKeySh, on ? '1' : '0');
            } catch (_) { /* ignore */
            }
        });
    }
} catch (_) { /* ignore */
}

// Create device/app
const gfxOptions = {deviceTypes: ['webgl2']};
const device = await pc.createGraphicsDevice(canvas, gfxOptions);
device.maxPixelRatio = Math.min(window.devicePixelRatio, 2);

const createOptions = new pc.AppOptions();
createOptions.graphicsDevice = device;
createOptions.componentSystems = [
    pc.RenderComponentSystem,
    pc.CameraComponentSystem,
    pc.LightComponentSystem,
    pc.ScriptComponentSystem
];
createOptions.resourceHandlers = [pc.TextureHandler, pc.ContainerHandler, pc.ScriptHandler, pc.FontHandler];

const app = new pc.AppBase(canvas);
app.init(createOptions);

// Canvas sizing will be controlled by the left pane size (Split.js)
app.setCanvasFillMode(pc.FILLMODE_NONE);
app.setCanvasResolution(pc.RESOLUTION_AUTO);

// Start
app.start();

// Initialize split layout (left: canvas, right: sidebar)
try {
    const leftSel = '#pane-left';
    const rightSel = '#pane-right';
    Split([leftSel, rightSel], {
        sizes: [78, 22],
        minSize: [200, 220],
        gutterSize: 6,
        snapOffset: 0,
    });
} catch (e) {
    console.warn('Split.js init failed (continuing without split):', e);
}

// Resize canvas to match the left pane
const leftPane = /** @type {HTMLElement} */(document.getElementById('pane-left'));

function resizeCanvasToPane() {
    if (!leftPane) return;
    const rect = leftPane.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    app.resizeCanvas(w, h);
}

if (leftPane && typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => resizeCanvasToPane());
    ro.observe(leftPane);
}
window.addEventListener('resize', resizeCanvasToPane);
// initial
setTimeout(resizeCanvasToPane, 0);


// Helper to create a simple colored StandardMaterial
/**
 * @param {pc.Color} color
 * @returns {pc.Material}
 */
const createColorMaterial = (color) => {
    const material = new pc.StandardMaterial();
    material.diffuse = color;
    material.update();
    return material;
};

// ---- Colormap utilities for wind ribbons ----
function clamp01(x) {
    return Math.max(0, Math.min(1, x));
}

function cm_blueRed(t) {
    return [t, 0.2, 1.0 - t, 1.0];
}

function cm_viridis(t) {
    // compact approximation
    const a = [0.267, 0.005, 0.329];
    const b = [0.255, 0.320, 0.196];
    const c = [0.130, 0.774, 0.019];
    const d = [0.0, 0.0, 0.0];
    return [a[0] + b[0] * t + c[0] * t * t, a[1] + b[1] * t + c[1] * t * t, a[2] + b[2] * t + c[2] * t * t, 1.0];
}

function cm_plasma(t) {
    const r = Math.max(0, Math.min(1, 2.0 * t));
    return [Math.pow(t, 0.5), 0.06 + 1.2 * t * (1.0 - t), 0.5 + 0.5 * (1.0 - t), 1.0];
}

function cm_coolwarm(t) {
    return [t, 0.5 + 0.5 * (1.0 - 2.0 * Math.abs(t - 0.5)), 1.0 - t, 1.0];
}

const COLORMAPS = {
    'blue-red': cm_blueRed,
    'viridis': cm_viridis,
    'plasma': cm_plasma,
    'coolwarm': cm_coolwarm
};

function mapFnByName(name) {
    return COLORMAPS[name] || COLORMAPS['blue-red'];
}

/** Build a simple StandardMaterial (no custom shader). */
function buildWindMaterial(meta) {
    // Custom shader removed: return a plain vertex-color material with optional opacity.
    const mat = new pc.StandardMaterial();
    mat.diffuse = new pc.Color(1, 1, 1);
    mat.vertexColors = true;
    const alpha = (meta?.colorParams?.opacity != null) ? Number(meta.colorParams.opacity) : 1.0;
    const baseOpacity = Math.max(0, Math.min(1, alpha));
    mat.opacity = baseOpacity;
    if (baseOpacity < 1.0) mat.blendType = pc.BLEND_NORMAL;
    mat.update();
    return mat;
}

// Unlit vertex-color material (for slices/colormaps so lighting doesn't darken them)
/**
 * @param {number} opacity 0..1
 * @returns {pc.StandardMaterial}
 */
function createUnlitVertexColorMaterial(opacity) {
    const mat = new pc.StandardMaterial();
    // Unlit path in StandardMaterial uses the emissive term.
    // Enable vertex colors on emissive and set emissive to white so per-vertex RGB shows as-is.
    mat.useLighting = false; // disable lighting
    mat.diffuse = new pc.Color(0, 0, 0); // ignore diffuse in unlit path
    mat.vertexColors = true; // keep for safety (diffuse path)
    try {
        mat.emissive = new pc.Color(1, 1, 1);
    } catch (_) {
    }
    try {
        mat.emissiveVertexColor = true;
    } catch (_) {
    }
    // Render both sides so a horizontal slice is visible from above/below
    try {
        mat.cull = pc.CULLFACE_NONE;
    } catch (_) {
    }
    const a = Math.max(0, Math.min(1, opacity == null ? 1 : Number(opacity)));
    mat.opacity = a;
    if (a < 1) mat.blendType = pc.BLEND_NORMAL;
    mat.update();
    return mat;
}

// Ultra-simple unlit shader that outputs per-vertex color directly.
// This bypasses StandardMaterial paths to guarantee vColor is used.
/**
 * @param {number} opacity 0..1
 * @returns {pc.Material}
 */
function createUnlitVertexColorShaderMaterial(opacity) {
    const VS = [
        'attribute vec3 vertex_position;',
        'attribute vec4 aColor;',
        // Use engine-provided uniform names (see grid.mjs):
        // matrix_model and matrix_viewProjection
        'uniform mat4 matrix_model;',
        'uniform mat4 matrix_viewProjection;',
        'varying vec4 vColor;',
        'void main(void){',
        '  vColor = aColor;',
        '  gl_Position = matrix_viewProjection * matrix_model * vec4(vertex_position, 1.0);',
        '}'
    ].join('\n');
    // If globalThis.__GLYPH_SOLID_COLOR is set (true or [r,g,b,a]),
    // use a solid color fill for debugging.
    const useSolid = (typeof globalThis !== 'undefined') && (globalThis.__GLYPH_SOLID_COLOR != null);
    const FS = useSolid ? [
        'precision mediump float;',
        'varying vec4 vColor;',
        'uniform float uOpacity;',
        'uniform vec4 uSolidColor;',
        'void main(void){',
        '  gl_FragColor = vec4(uSolidColor.rgb, uSolidColor.a * uOpacity);',
        '}'
    ].join('\n') : [
        'precision mediump float;',
        'varying vec4 vColor;',
        'uniform float uOpacity;',
        'void main(void){',
        '  // Ignore incoming alpha, use uniform opacity to ensure visibility',
        '  gl_FragColor = vec4(vColor.rgb, uOpacity);',
        '}'
    ].join('\n');
    // Use ShaderMaterial as in src/lib/grid.mjs
    const attributes = {vertex_position: pc.SEMANTIC_POSITION, aColor: pc.SEMANTIC_COLOR};
    let mat;
    try {
        mat = new pc.ShaderMaterial({
            uniqueName: 'unlit-vertex-color',
            vertexGLSL: VS,
            fragmentGLSL: FS,
            attributes
        });
    } catch (e) {
        // Fallback: StandardMaterial with vertex colors (may be affected by lighting paths)
        const m = new pc.StandardMaterial();
        m.useLighting = false;
        m.diffuse = new pc.Color(0, 0, 0);
        m.vertexColors = true;
        try {
            m.emissiveVertexColor = true;
        } catch (_) {
        }
        m.update();
        return m;
    }
    const a = Math.max(0, Math.min(1, opacity == null ? 1 : Number(opacity)));
    try {
        mat.setParameter('uOpacity', a);
    } catch (_) {
    }
    if (useSolid) {
        let col = [1, 0, 0, 1];
        try {
            const v = /** @type {any} */ (globalThis).__GLYPH_SOLID_COLOR;
            if (Array.isArray(v) && v.length >= 3) {
                col = [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0, Number(v[3] ?? 1)];
            }
        } catch (_) {
        }
        try {
            mat.setParameter('uSolidColor', col);
        } catch (_) {
        }
    }
    if (a < 1) {
        try {
            mat.blendType = pc.BLEND_NORMAL;
        } catch (_) {
        }
    }
    try {
        mat.cull = pc.CULLFACE_NONE;
    } catch (_) {
    }
    try {
        mat.update();
    } catch (_) {
    }
    return mat;
}

// Random color helper (avoid very dark colors)
/**
 * @returns {number[]} [r,g,b] each in [0,1]
 */
function randomColorArr() {
    const min = 0.25, max = 0.95;
    const r = min + Math.random() * (max - min);
    const g = min + Math.random() * (max - min);
    const b = min + Math.random() * (max - min);
    return [r, g, b];
}

// Scene settings
app.scene.ambientLight = new pc.Color(0.2, 0.2, 0.2);

// Scene content registry (Editor)
/** @typedef {{ id:number, name:string, type:'ground'|'building-box'|'building-cylinder'|'mesh-import'|'analysis-space', color:number[], meta:any }} ObjectInfo */
const registry = new Map();
let nextId = 1;

// Shared observer state for editor
data.set('objects', /** @type {ObjectInfo[]} */([]));
data.set('selectedId', /** @type {number|null} */ (null));
data.set('selected', /** @type {any} */ (null));
data.set('console', /** @type {any[]} */([]));
// History UI state
data.set('history', {canUndo: false, canRedo: false, undoLabel: '', redoLabel: ''});

// History manager
const history = new HistoryManager((state) => {
    data.set('history', state);
});

// Camera state defaults
data.set('camera', {
    proj: pc.PROJECTION_PERSPECTIVE + 1,
    dist: 1,
    fov: 45,
    orthoHeight: 10
});

// Camera entity
const camera = new pc.Entity('camera');
camera.addComponent('script');
camera.addComponent('camera', {
    clearColor: new pc.Color(0.1, 0.1, 0.1),
    // Increase far clipping distance to allow viewing the city at multi‑kilometer scale
    farClip: 20000
});
const cameraOffset = 4 * camera.camera.aspectRatio;
camera.setPosition(cameraOffset, cameraOffset, cameraOffset);
app.root.addChild(camera);

// Camera controls
const cc = /** @type {CameraControls} */ (camera.script.create(CameraControls));
Object.assign(cc, {focusPoint: pc.Vec3.ZERO, sceneSize: 5, rotateDamping: 0, moveDamping: 0});
let __gizmoActive = false;
let __gizmoStart = null; // { id:number, transform:any, label:string }
app.on('gizmo:pointer', (/** @type {boolean} */ hasPointer) => {
    cc.enabled = !hasPointer;
    const sid = data.get('selectedId');
    if (hasPointer) {
        __gizmoActive = true;
        if (sid != null && registry.has(sid)) {
            const rec = registry.get(sid);
            const labelMap = {translate: 'Move', rotate: 'Rotate', scale: 'Scale'};
            __gizmoStart = {
                id: sid,
                transform: getEntityTransform(rec.entity),
                label: labelMap[gizmoHandler.type] || 'Transform'
            };
        } else {
            __gizmoStart = null;
        }
    } else {
        if (__gizmoActive && __gizmoStart && sid === __gizmoStart.id && registry.has(sid)) {
            const rec = registry.get(sid);
            const end = getEntityTransform(rec.entity);
            const start = __gizmoStart.transform;
            const changed = JSON.stringify(start) !== JSON.stringify(end);
            if (changed) {
                const id = __gizmoStart.id;
                const label = __gizmoStart.label;
                history.commit({
                    label,
                    undo: () => applyTransformById(id, start),
                    redo: () => applyTransformById(id, end)
                });
            }
        }
        __gizmoActive = false;
        __gizmoStart = null;
    }
});

// Outline renderer
const outlineLayer = new pc.Layer({name: 'OutlineLayer'});
app.scene.layers.push(outlineLayer);
const immediateLayer = /** @type {pc.Layer} */ (app.scene.layers.getLayerByName('Immediate'));
const outlineRenderer = new pc.OutlineRenderer(app, outlineLayer);
app.on('update', () => {
    outlineRenderer.frameUpdate(camera, immediateLayer, false);
});

// 3D Cursor layer (so it is not selectable and renders separately)
const cursorLayer = new pc.Layer({name: 'CursorLayer'});
app.scene.layers.push(cursorLayer);
// ensure camera renders the cursor layer
if (camera.camera.layers.indexOf(cursorLayer.id) === -1) {
    camera.camera.layers.push(cursorLayer.id);
}

// Grid
// Base cell size (world units per one fine grid cell). We derive world size from it.
let __gridBaseCell = 0.1;
// Guard to avoid feedback loops when syncing grid.level <-> grid.divisions
let __gridSyncing = false;
const gridEntity = new pc.Entity('grid');
// Start with a 800m x 800m grid (1 unit = 1 meter)
gridEntity.setLocalScale(800, 1, 800);
app.root.addChild(gridEntity);
gridEntity.addComponent('script');
const grid = /** @type {Grid} */ (gridEntity.script.create(Grid));
// initialize grid observer state, including size (uses X/Z scale; square by design)
{
    const s = gridEntity.getLocalScale();
    const baseDiv = 80;
    // derive initial level from current divisions (80 * 2^(level-1))
    let initLevel = 1;
    if (grid.divisions > 0) {
        initLevel = Math.max(1, Math.min(5, Math.round(Math.log2(grid.divisions / baseDiv)) + 1));
    }
    data.set('grid', {
        colorX: Object.values(grid.colorX),
        colorZ: Object.values(grid.colorZ),
        resolution: grid.resolution + 1,
        size: s.x,
        divisions: grid.divisions,
        level: initLevel
    });
    // establish the invariant: keep per‑cell world size constant and grow world extent with divisions
    // base cell size = current world width (scale.x) / current cell count
    if (grid.divisions > 0) {
        __gridBaseCell = s.x / grid.divisions;
    }
}

// Light
const light = new pc.Entity('light');
light.addComponent('light', {
    // Sun-like directional light with high quality cascaded shadows
    type: 'directional',
    intensity: 1,
    castShadows: true,
    shadowType: pc.SHADOW_PCF5,
    shadowResolution: 2048,
    shadowDistance: 400,
    shadowBias: 0.02,
    normalOffsetBias: 1.5,
    numCascades: 4,
    cascadeDistribution: 0.7
});
app.root.addChild(light);
// keep existing orientation (tilt)
light.setEulerAngles(0, 0, -60);

// Apply current shadow toggle to the light (default ON if not set)
try {
    light.light.castShadows = !!data.get('ui.shadowsEnabled');
} catch (_) {
}
// React to runtime changes from Settings → Shadows toggle
try {
    data.on && data.on('ui.shadowsEnabled:set', function () {
        try {
            const v = arguments.length === 1 ? arguments[0] : arguments[1];
            light.light.castShadows = !!v;
        } catch (_) { /* ignore */
        }
    });
} catch (_) { /* ignore */
}

// -------- Dynamic shadow quality for city-scale scenes --------
// We keep near-field shadows sharp while the camera can still view up to many kilometers.
// Strategy:
//  - Use cascaded shadow maps (4 cascades)
//  - Dynamically scale shadowDistance based on camera height
//  - Quantize resolution to maintain roughly constant world-units-per-texel
//  - Optionally disable casting for far buildings

const SHADOW_Q = {
    // Smaller = sharper shadows (but needs higher resolution)
    WORLD_UNITS_PER_TEXEL: 0.18,
    // Distances are in meters (1 world unit = 1 m)
    DIST_MIN: 150,
    // Allow a bit farther shadows overall
    DIST_MAX: 3000,
    DIST_NEAR: 200,
    // Extend far range so shadows can reach farther when zoomed out / at higher altitude
    DIST_FAR: 2000,
    RES_MIN: 1024,
    RES_MAX: 4096,
    CSM_COUNT: 4,
    CSM_DISTRIBUTION: 0.7,
    BIAS: 0.02,
    NORMAL_BIAS: 1.5,
    // LOD for shadow casters (disable for distant buildings)
    ENABLE_CASTER_LOD: true,
    // Optional hard cap for caster culling (used only if lower than dynamic range)
    CASTER_CULL_DIST: 3000,
    // Hysteresis factors to avoid popping when toggling caster state
    CASTER_HYST_NEAR: 1.05, // enable again when within 105% of current shadow distance
    CASTER_HYST_FAR: 1.20,  // disable when beyond 120% of current shadow distance
    // Update throttling (seconds)
    UPDATE_INTERVAL: 0.15
};

let __shadowLast = {
    dist: light.light.shadowDistance,
    res: light.light.shadowResolution
};
let __shadowAccum = 0;

function __quantizeResForDistance(dist) {
    // choose power-of-two resolution so that dist / res ~= WORLD_UNITS_PER_TEXEL
    const target = Math.max(1, dist / SHADOW_Q.WORLD_UNITS_PER_TEXEL);
    let res = 1;
    while (res < target && res < SHADOW_Q.RES_MAX) res <<= 1;
    res = pc.math.clamp(res, SHADOW_Q.RES_MIN, SHADOW_Q.RES_MAX);
    // Clamp to sane values supported by the device (1024/2048/4096)
    if (res < 2048) return 1024;
    if (res < 4096) return 2048;
    return 4096;
}

function __computeTargetDistance() {
    // Use camera altitude above ground as a simple proxy for context/navigational scale
    const h = camera.getPosition().y;
    const t = pc.math.clamp((h - 50) / 500, 0, 1);
    const lerped = pc.math.lerp(SHADOW_Q.DIST_NEAR, SHADOW_Q.DIST_FAR, t);
    return pc.math.clamp(lerped, SHADOW_Q.DIST_MIN, SHADOW_Q.DIST_MAX);
}

function updateShadowQuality(dt) {
    // Skip shadow updates entirely when shadows are disabled via Settings
    if (!data.get('ui.shadowsEnabled')) return;
    __shadowAccum += dt;
    if (__shadowAccum < SHADOW_Q.UPDATE_INTERVAL) return;
    __shadowAccum = 0;

    const targetDist = Math.round(__computeTargetDistance());
    const targetRes = __quantizeResForDistance(targetDist);

    const L = light.light;

    // Apply base quality settings that should not change often
    if (L.numCascades !== SHADOW_Q.CSM_COUNT) L.numCascades = SHADOW_Q.CSM_COUNT;
    if (L.cascadeDistribution !== SHADOW_Q.CSM_DISTRIBUTION) L.cascadeDistribution = SHADOW_Q.CSM_DISTRIBUTION;
    if (L.shadowType !== pc.SHADOW_PCF5) L.shadowType = pc.SHADOW_PCF5;
    if (L.shadowBias !== SHADOW_Q.BIAS) L.shadowBias = SHADOW_Q.BIAS;
    if (L.normalOffsetBias !== SHADOW_Q.NORMAL_BIAS) L.normalOffsetBias = SHADOW_Q.NORMAL_BIAS;

    // Update distance/resolution only when changed enough to matter
    const needDist = Math.abs(targetDist - __shadowLast.dist) > 10;
    const needRes = targetRes !== __shadowLast.res;
    if (needDist) {
        // ease towards the target distance to reduce visible cascade popping
        const eased = Math.round(pc.math.lerp(L.shadowDistance || targetDist, targetDist, 0.5));
        L.shadowDistance = eased;
        __shadowLast.dist = eased;
    }
    if (needRes) {
        L.shadowResolution = targetRes;
        __shadowLast.res = targetRes;
    }
}

// Remember last casting state per target to implement hysteresis
const __casterState = new WeakMap();

function updateShadowCasters() {
    if (!data.get('ui.shadowsEnabled')) return;
    if (!SHADOW_Q.ENABLE_CASTER_LOD) return;
    const L = light.light;
    const camPos = camera.getPosition();
    // base cutoff derived from current effective shadow distance
    let base = Math.max(1, L.shadowDistance || SHADOW_Q.DIST_NEAR);
    // apply optional hard cap if smaller
    if (SHADOW_Q.CASTER_CULL_DIST && SHADOW_Q.CASTER_CULL_DIST > 0)
        base = Math.min(base, SHADOW_Q.CASTER_CULL_DIST);

    const nearCut = base * SHADOW_Q.CASTER_HYST_NEAR;
    const farCut = base * SHADOW_Q.CASTER_HYST_FAR;

    for (const rec of registry.values()) {
        if (!rec || !rec.entity) continue;
        if (rec.type === 'ground') continue;
        const root = rec.entity;
        /** @type {any} */ const target = /** @type {any} */ (root.render ? root : /** @type {any} */ (root)._meshChild);
        if (!target || !target.render) continue;

        const d = root.getPosition().distance(camPos);
        const state = __casterState.get(target) || {casting: true};
        let casting = state.casting;
        if (casting && d > farCut) casting = false;
        else if (!casting && d < nearCut) casting = true;

        if (casting !== state.casting) {
            target.render.castShadows = casting;
            state.casting = casting;
            __casterState.set(target, state);
        }
    }
}

// Hook into the app loop
app.on('update', (dt) => {
    updateShadowQuality(dt);
    if (SHADOW_Q.ENABLE_CASTER_LOD) updateShadowCasters();
});

// Gizmos
let skipObserverFire = false;
const gizmoHandler = new GizmoHandler(camera.camera);
const setGizmoControls = () => {
    skipObserverFire = true;
    data.set('gizmo', {
        type: gizmoHandler.type,
        size: gizmoHandler.gizmo.size,
        snapIncrement: gizmoHandler.gizmo.snapIncrement,
        colorAlpha: gizmoHandler.gizmo.colorAlpha,
        coordSpace: gizmoHandler.gizmo.coordSpace
    });
    skipObserverFire = false;
};
gizmoHandler.switch('translate');
setGizmoControls();

// View cube (axis gizmo in the bottom-right of the viewport only)
const viewCube = new pc.ViewCube(new pc.Vec4(0, 1, 1, 0));
// Mount the DOM into the viewport-only overlay so it stays left of the sidebar
try {
    const vp = document.getElementById('viewport-ui-native')
        || document.getElementById('viewport-ui')
        || document.getElementById('ui-root');
    if (vp && viewCube && viewCube.dom) {
        // ensure interactive inside pointer-events:none overlay
        viewCube.dom.setAttribute('data-interactive', '1');
        // position within the viewport container
        viewCube.dom.style.position = 'absolute';
        viewCube.dom.style.right = '16px';
        viewCube.dom.style.bottom = '16px';
        viewCube.dom.style.left = 'auto';
        viewCube.dom.style.top = 'auto';
        viewCube.dom.style.margin = '0';
        viewCube.dom.style.zIndex = '20';
        if (viewCube.dom.parentElement !== vp) vp.appendChild(viewCube.dom);
    }
} catch (_) {
}
data.set('viewCube', {
    colorX: Object.values(viewCube.colorX),
    colorY: Object.values(viewCube.colorY),
    colorZ: Object.values(viewCube.colorZ),
    radius: viewCube.radius,
    textSize: viewCube.textSize,
    lineThickness: viewCube.lineThickness,
    lineLength: viewCube.lineLength
});
const tmpV1 = new pc.Vec3();
let aligned = false;
viewCube.on(pc.ViewCube.EVENT_CAMERAALIGN, (/** @type {pc.Vec3} */ dir) => {
    const cameraPos = camera.getPosition();
    const focusPoint = cc.focusPoint;
    const cameraDist = focusPoint.distance(cameraPos);
    const cameraStart = tmpV1.copy(dir).mulScalar(cameraDist).add(focusPoint);
    cc.reset(focusPoint, cameraStart);
    aligned = true;
});
app.on('prerender', () => {
    viewCube.update(camera.getWorldTransform());
});

// Ensure no default geometry is present on first load
// The editor should start with an empty scene (no ground/box/cylinder) until the user creates them via the menu.
// If any renderable entities were added by prior hot-reload or external code, remove them now.
const removeStartupGeometry = () => {
    const toDestroy = [];
    for (const child of app.root.children) {
        // Keep our own utility entities (camera, light, grid)
        if (child === camera || child === light || child === gridEntity) continue;
        // Remove any renderable entities (e.g., demo primitives like box/cylinder/cone/plane)
        if (child.render) {
            toDestroy.push(child);
            continue;
        }
    }
    toDestroy.forEach(e => e.destroy());
};
removeStartupGeometry();

// Selector
const layers = app.scene.layers;
const selector = new Selector(app, camera.camera, [layers.getLayerByName('World')]);
selector.on('select', (/** @type {pc.Entity} */ node, /** @type {boolean} */ clear) => {
    // Determine if this is a managed object (root or its mesh child)
    const id = /** @type {any} */ (node)._sid;
    if (id != null && registry.has(id)) {
        const rec = registry.get(id);
        const root = rec.entity;
        // Visuals: gizmo on root pivot; outline on renderable entity (child if present)
        const outlineTarget = /** @type {any} */ (root.render ? root : /** @type {any} */ (root)._meshChild);
        gizmoHandler.add(root, clear);
        if (clear) outlineRenderer.removeAllEntities();
        // Skip outline rendering for animated wind-streamlines to avoid special-pass shader links
        const isWind = (rec.type === 'mesh-import') && (rec?.meta?.kind === 'wind-streamlines');
        if (outlineTarget && !isWind) outlineRenderer.addEntity(outlineTarget, pc.Color.WHITE);
        setSelectedId(id);
        updateSelectedInspector();
        return;
    }
    // Fallback: non‑managed entities
    gizmoHandler.add(node, clear);
    if (clear) outlineRenderer.removeAllEntities();
    outlineRenderer.addEntity(node, pc.Color.WHITE);
});
selector.on('deselect', () => {
    if (aligned) {
        aligned = false;
        return;
    }
    gizmoHandler.clear();
    outlineRenderer.removeAllEntities();
    setSelectedId(null);
    data.set('selected', null);
});

// ---------------- 3D Cursor (Blender-like) ----------------
// Shared state
data.set('cursor', {position: [0, 0, 0], visible: true});

// Visual marker: small RGB axis cross
const cursorRoot = new pc.Entity('Cursor3D');
const CURSOR_LEN = 5.0 * 5;
const CURSOR_THICK = 0.3 * 2;
/** @param {pc.Color} color */
const cursorMat = (color) => {
    const m = new pc.StandardMaterial();
    m.diffuse = color;
    // Make cursor a bit more noticeable by boosting emissive slightly
    m.emissive = color.clone().mulScalar(0.4);
    m.update();
    return m;
};
const cursorLayers = [cursorLayer.id];
// X axis
const cx = new pc.Entity('CursorX');
cx.addComponent('render', {
    type: 'box',
    material: cursorMat(new pc.Color(1, 0.1, 0.1)),
    castShadows: false,
    receiveShadows: false,
    layers: cursorLayers
});
cx.setLocalScale(CURSOR_LEN, CURSOR_THICK, CURSOR_THICK);
cursorRoot.addChild(cx);
// Y axis
const cy = new pc.Entity('CursorY');
cy.addComponent('render', {
    type: 'box',
    material: cursorMat(new pc.Color(0.1, 1, 0.1)),
    castShadows: false,
    receiveShadows: false,
    layers: cursorLayers
});
cy.setLocalScale(CURSOR_THICK, CURSOR_LEN, CURSOR_THICK);
cursorRoot.addChild(cy);
// Z axis
const cz = new pc.Entity('CursorZ');
cz.addComponent('render', {
    type: 'box',
    material: cursorMat(new pc.Color(0.1, 0.6, 1)),
    castShadows: false,
    receiveShadows: false,
    layers: cursorLayers
});
cz.setLocalScale(CURSOR_THICK, CURSOR_THICK, CURSOR_LEN);
cursorRoot.addChild(cz);
// Center dot to help visibility at small scales
const cdot = new pc.Entity('CursorDot');
cdot.addComponent('render', {
    type: 'sphere',
    material: cursorMat(new pc.Color(1, 1, 1)),
    castShadows: false,
    receiveShadows: false,
    layers: cursorLayers
});
cdot.setLocalScale(CURSOR_THICK * 1.3, CURSOR_THICK * 1.3, CURSOR_THICK * 1.3);
cursorRoot.addChild(cdot);
app.root.addChild(cursorRoot);

// Helper to set cursor position from array
function setCursorPosition(arr) {
    if (!Array.isArray(arr) || arr.length < 3) return;
    cursorRoot.setLocalPosition(arr[0], arr[1], arr[2]);
}

// Pointer shortcut: Shift + Right Click places cursor on ground plane (y = 0)
const tmpA = new pc.Vec3();
const tmpB = new pc.Vec3();
const tmpD = new pc.Vec3();

function placeCursorFromPointer(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    // PlayCanvas expects screen coords with origin at top-left.
    // Do not invert Y; just offset by the canvas rect.
    const y = clientY - rect.top;
    const cam = camera.camera;
    cam.screenToWorld(x, y, 0, tmpA); // near
    cam.screenToWorld(x, y, 1, tmpB); // far
    tmpD.sub2(tmpB, tmpA);
    const dy = tmpD.y;
    if (Math.abs(dy) < 1e-6) return; // parallel to ground
    const t = -tmpA.y / dy;
    tmpA.add(tmpD.mulScalar(t));
    // Snap small noise
    const pos = [tmpA.x, 0, tmpA.z];
    data.set('cursor.position', pos);
}

window.addEventListener('pointerdown', (e) => {
    if (e.button === 2 && e.shiftKey) {
        // place cursor
        e.preventDefault();
        e.stopPropagation();
        placeCursorFromPointer(e.clientX, e.clientY);
    }
});
window.addEventListener('contextmenu', (e) => {
    if (e.shiftKey) e.preventDefault();
});

// Resize + gizmo size in pixels
const resize = () => {
    app.resizeCanvas();
    const bounds = canvas.getBoundingClientRect();
    const dim = camera.camera.horizontalFov ? bounds.width : bounds.height;
    gizmoHandler.size = 1024 / dim;
    data.set('gizmo.size', gizmoHandler.size);
};
window.addEventListener('resize', resize);
resize();

// Keyboard handlers
// Helper: detect if a keyboard event should be ignored by the 3D scene because UI is focused/active
/**
 * @param {KeyboardEvent} e
 */
function isEventFromUI(e) {
    try {
        const t = /** @type {HTMLElement|null} */ (e.target);
        const ae = /** @type {HTMLElement|null} */ (document.activeElement);
        const inTextual = (el) => !!el && (
            el.tagName === 'INPUT' ||
            el.tagName === 'TEXTAREA' ||
            el.tagName === 'SELECT' ||
            el.isContentEditable ||
            el.getAttribute?.('role') === 'textbox'
        );
        const inUiContainers = (el) => !!el && (
            el.closest?.('#pane-right') || // sidebar (object list + inspector)
            el.closest?.('#viewport-ui')   // overlay UI on the viewport
        );
        if (e.defaultPrevented) return true; // UI already consumed
        if (inTextual(t) || inTextual(ae)) return true;
        if (inUiContainers(t) || inUiContainers(ae)) return true;
    } catch (_) { /* ignore */
    }
    return false;
}

const keydown = (/** @type {KeyboardEvent} */ e) => {
    if (isEventFromUI(e)) return;
    gizmoHandler.gizmo.snap = !!e.shiftKey;
    gizmoHandler.gizmo.uniform = !e.ctrlKey;
    switch (e.key) {
        case 'f': {
            // Shift+F → reset camera to fit whole scene/grid, F → focus selected
            if (e.shiftKey) {
                try {
                    api.resetCameraView && api.resetCameraView();
                } catch (_) {
                }
            } else {
                try {
                    api.focusSelectedObject && api.focusSelectedObject();
                } catch (_) {
                }
            }
            break;
        }
        case '0': {
            if (e.metaKey || e.ctrlKey) {
                e.preventDefault();
                try {
                    api.resetCameraView && api.resetCameraView();
                } catch (_) {
                }
            }
            break;
        }
        case 'r': {
            // legacy: keep quick reset to origin
            cc.focus(pc.Vec3.ZERO, true);
            break;
        }
    }
};
const keyup = (/** @type {KeyboardEvent} */ e) => {
    if (isEventFromUI(e)) return;
    gizmoHandler.gizmo.snap = !!e.shiftKey;
    gizmoHandler.gizmo.uniform = !e.ctrlKey;
};
const keypress = (/** @type {KeyboardEvent} */ e) => {
    if (isEventFromUI(e)) return;
    switch (e.key) {
        case 'q':
        case 'Q':
            // Unity-like: Q/W/E to switch transform modes → Q: Translate, W: Rotate, E: Scale
            data.set('gizmo.type', 'translate');
            break;
        case 'w':
        case 'W':
            data.set('gizmo.type', 'rotate');
            break;
        case 'e':
        case 'E':
            data.set('gizmo.type', 'scale');
            break;
        case 'x':
            data.set('gizmo.coordSpace', data.get('gizmo.coordSpace') === 'world' ? 'local' : 'world');
            break;
        case '1':
            data.set('gizmo.type', 'translate');
            break;
        case '2':
            data.set('gizmo.type', 'rotate');
            break;
        case '3':
            data.set('gizmo.type', 'scale');
            break;
        case 'p':
            data.set('camera.proj', pc.PROJECTION_PERSPECTIVE + 1);
            break;
        case 'o':
            data.set('camera.proj', pc.PROJECTION_ORTHOGRAPHIC + 1);
            break;
    }
};
window.addEventListener('keydown', keydown);
window.addEventListener('keyup', keyup);
window.addEventListener('keypress', keypress);

// ---- Keyboard shortcuts for Undo / Redo ----
window.addEventListener('keydown', (e) => {
    if (isEventFromUI(e)) return;
    // Cmd/Ctrl + Z => Undo, Shift+Cmd/Ctrl+Z or Cmd/Ctrl+Y => Redo
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    const key = e.key?.toLowerCase();
    if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        doUndo();
    } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        doRedo();
    }
}, true);

// Observer-driven updates
const tmpC1 = new pc.Color();
data.on('*:set', (/** @type {string} */ path, /** @type {any} */ value) => {
    const [category, key] = path.split('.');
    switch (category) {
        case 'camera': {
            switch (key) {
                case 'proj':
                    camera.camera.projection = value - 1;
                    break;
                case 'fov':
                    camera.camera.fov = value;
                    break;
            }
            break;
        }
        case 'cursor': {
            switch (key) {
                case 'position':
                    setCursorPosition(value);
                    break;
                case 'visible':
                    cursorRoot.enabled = !!value;
                    break;
            }
            break;
        }
        case 'selected': {
            // Apply inspector edits to the selected entity and record to history when appropriate
            const sid = data.get('selectedId');
            if (sid == null) break;
            const rec = registry.get(sid);
            if (!rec) break;
            const e = rec.entity;
            /** @type {any} */
            const meshChild = /** @type {any} */ (e)._meshChild;
            const shouldRecord = !__mirrorWrite && !__doingHistory;
            switch (key) {
                case 'name': {
                    const oldName = rec.name;
                    const newName = String(value || '');
                    if (oldName === newName) break;
                    rec.name = newName;
                    e.name = newName;
                    refreshObjects();
                    if (shouldRecord) {
                        history.commit({
                            label: 'Rename',
                            undo: () => setNameById(sid, oldName),
                            redo: () => setNameById(sid, newName)
                        });
                    }
                    break;
                }
                case 'position': {
                    if (Array.isArray(value) && value.length >= 3) {
                        const old = getEntityTransform(e).position;
                        const neu = [value[0], value[1], value[2]];
                        e.setLocalPosition(neu[0], neu[1], neu[2]);
                        if (shouldRecord && JSON.stringify(old) !== JSON.stringify(neu)) {
                            history.commit({
                                label: 'Move',
                                undo: () => applyTransformById(sid, {position: old}),
                                redo: () => applyTransformById(sid, {position: neu})
                            });
                        }
                    }
                    break;
                }
                case 'rotation': {
                    if (Array.isArray(value) && value.length >= 3) {
                        const old = getEntityTransform(e).rotation;
                        const neu = [value[0], value[1], value[2]];
                        e.setLocalEulerAngles(neu[0], neu[1], neu[2]);
                        if (shouldRecord && JSON.stringify(old) !== JSON.stringify(neu)) {
                            history.commit({
                                label: 'Rotate',
                                undo: () => applyTransformById(sid, {rotation: old}),
                                redo: () => applyTransformById(sid, {rotation: neu})
                            });
                        }
                    }
                    break;
                }
                case 'scale': {
                    if (Array.isArray(value) && value.length >= 3) {
                        const old = getEntityTransform(e).scale;
                        const neu = [value[0], value[1], value[2]];
                        e.setLocalScale(neu[0], neu[1], neu[2]);
                        if (shouldRecord && JSON.stringify(old) !== JSON.stringify(neu)) {
                            history.commit({
                                label: 'Scale',
                                undo: () => applyTransformById(sid, {scale: old}),
                                redo: () => applyTransformById(sid, {scale: neu})
                            });
                        }
                    }
                    break;
                }
                case 'color': {
                    if (Array.isArray(value) && value.length >= 3) {
                        const old = (rec.color || []).slice();
                        const neu = [value[0], value[1], value[2]];
                        const target = /** @type {any} */ (e.render ? e : meshChild);
                        if (target && target.render && target.render.meshInstances && target.render.meshInstances.length) {
                            const mi0 = target.render.meshInstances[0];
                            const mat = mi0 && mi0.material;
                            if (mat && mat.diffuse) {
                                mat.diffuse.set(neu[0], neu[1], neu[2]);
                                mat.update();
                            }
                            rec.color = neu;
                            if (shouldRecord && JSON.stringify(old) !== JSON.stringify(neu)) {
                                history.commit({
                                    label: 'Change Color',
                                    undo: () => setColorById(sid, old),
                                    redo: () => setColorById(sid, neu)
                                });
                            }
                        }
                    }
                    break;
                }
                case 'size': { // ground [w, d]
                    if (rec.type === 'ground' && Array.isArray(value) && value.length >= 2) {
                        const old = (rec.meta.size || []).slice();
                        const neu = [value[0], value[1]];
                        e.setLocalScale(neu[0], 1, neu[1]);
                        rec.meta.size = neu;
                        if (shouldRecord && JSON.stringify(old) !== JSON.stringify(neu)) {
                            history.commit({
                                label: 'Resize Ground',
                                undo: () => setGroundSizeById(sid, old),
                                redo: () => setGroundSizeById(sid, neu)
                            });
                        }
                    }
                    break;
                }
                case 'dimensions': { // box [w, h, d]
                    if (rec.type === 'building-box' && Array.isArray(value) && value.length >= 3) {
                        const old = (rec.meta.dimensions || []).slice();
                        const neu = [value[0], value[1], value[2]];
                        const target = /** @type {any} */ (meshChild || e);
                        if (target) {
                            target.setLocalScale(neu[0], neu[1], neu[2]);
                            // Keep pivot at base by moving mesh child to half height
                            if (target !== e) target.setLocalPosition(0, neu[1] / 2, 0);
                            rec.meta.dimensions = neu;
                            if (shouldRecord && JSON.stringify(old) !== JSON.stringify(neu)) {
                                history.commit({
                                    label: 'Resize Box',
                                    undo: () => setBoxDimById(sid, old),
                                    redo: () => setBoxDimById(sid, neu)
                                });
                            }
                        }
                    }
                    break;
                }
                case 'cyl': { // cylinder [radius, height]
                    if (rec.type === 'building-cylinder' && Array.isArray(value) && value.length >= 2) {
                        const old = (rec.meta.cyl || []).slice();
                        const neu = [value[0], value[1]];
                        const r = neu[0];
                        const h = neu[1];
                        const target = /** @type {any} */ (meshChild || e);
                        if (target) {
                            target.setLocalScale(r * 2, h, r * 2);
                            if (target !== e) target.setLocalPosition(0, h / 2, 0);
                            rec.meta.cyl = neu;
                            if (shouldRecord && JSON.stringify(old) !== JSON.stringify(neu)) {
                                history.commit({
                                    label: 'Resize Cylinder',
                                    undo: () => setCylinderById(sid, old),
                                    redo: () => setCylinderById(sid, neu)
                                });
                            }
                        }
                    }
                    break;
                }
                case 'min': { // analysis-space AABB min
                    if (rec.type === 'analysis-space' && Array.isArray(value) && value.length >= 3) {
                        const old = (rec.meta.min ? rec.meta.min.slice() : [-50, 0, -50]);
                        const neu = [Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0];
                        // apply and refresh visuals
                        rec.meta.min = neu;
                        const maxv = rec.meta.max || [50, 50, 50];
                        updateAnalysisSpaceVisual(rec, rec.meta.min, maxv);
                        if (shouldRecord && JSON.stringify(old) !== JSON.stringify(neu)) {
                            history.commit({
                                label: 'Set AABB Min',
                                undo: () => setAnalysisSpaceAABBById(sid, old, maxv.slice()),
                                redo: () => setAnalysisSpaceAABBById(sid, neu.slice(), maxv.slice())
                            });
                        }
                    }
                    break;
                }
                case 'max': { // analysis-space AABB max
                    if (rec.type === 'analysis-space' && Array.isArray(value) && value.length >= 3) {
                        const old = (rec.meta.max ? rec.meta.max.slice() : [50, 50, 50]);
                        const neu = [Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0];
                        rec.meta.max = neu;
                        const minv = rec.meta.min || [-50, 0, -50];
                        updateAnalysisSpaceVisual(rec, minv, rec.meta.max);
                        if (shouldRecord && JSON.stringify(old) !== JSON.stringify(neu)) {
                            history.commit({
                                label: 'Set AABB Max',
                                undo: () => setAnalysisSpaceAABBById(sid, minv.slice(), old.slice()),
                                redo: () => setAnalysisSpaceAABBById(sid, minv.slice(), neu.slice())
                            });
                        }
                    }
                    break;
                }
            }
            break;
        }
        case 'gizmo': {
            if (skipObserverFire) return;
            if (key === 'type') {
                gizmoHandler.switch(value);
                setGizmoControls();
                return;
            }
            // @ts-ignore dynamic property update
            gizmoHandler.gizmo[key] = value;
            break;
        }
        case 'grid': {
            switch (key) {
                case 'colorX':
                    grid.colorX = tmpC1.set(value[0], value[1], value[2]);
                    break;
                case 'colorZ':
                    grid.colorZ = tmpC1.set(value[0], value[1], value[2]);
                    break;
                case 'resolution':
                    grid.resolution = value - 1;
                    break;
                case 'level': {
                    // Map discrete level [1..5] to divisions: 80 * 2^(level-1)
                    const lvl = Math.max(1, Math.min(5, Math.floor(Number(value) || 1)));
                    const baseDiv = 80;
                    const mappedDivs = baseDiv * Math.pow(2, lvl - 1);
                    const curDivs = (data.get('grid') && data.get('grid').divisions) || 0;
                    if (mappedDivs !== curDivs) {
                        if (!__gridSyncing) {
                            __gridSyncing = true;
                            data.set('grid.divisions', mappedDivs);
                            __gridSyncing = false;
                        }
                    }
                    break;
                }
                case 'size': {
                    // apply uniform X/Z scaling for the grid plane; keep Y at 1
                    const v = Math.max(0.001, Number(value) || 0);
                    gridEntity.setLocalScale(v, 1, v);
                    break;
                }
                case 'divisions': {
                    const v = Math.max(1, Math.floor(Number(value) || 0));
                    grid.divisions = v;
                    // derive world size from divisions to keep per‑cell size constant
                    const newSize = __gridBaseCell * v;
                    const cur = (data.get('grid') && data.get('grid').size) || 0;
                    if (Math.abs(cur - newSize) > 1e-6) {
                        data.set('grid.size', newSize);
                    }
                    // back-calc and sync level so UI stays consistent
                    const baseDiv = 80;
                    let lvl = 1;
                    if (v > 0) {
                        lvl = Math.max(1, Math.min(5, Math.round(Math.log2(v / baseDiv)) + 1));
                    }
                    const curLvl = (data.get('grid') && data.get('grid').level) || 0;
                    if (lvl !== curLvl) {
                        if (!__gridSyncing) {
                            __gridSyncing = true;
                            data.set('grid.level', lvl);
                            __gridSyncing = false;
                        }
                    }
                    break;
                }
            }
            break;
        }
        case 'viewCube': {
            switch (key) {
                case 'colorX':
                    viewCube.colorX = tmpC1.set(value[0], value[1], value[2]);
                    break;
                case 'colorY':
                    viewCube.colorY = tmpC1.set(value[0], value[1], value[2]);
                    break;
                case 'colorZ':
                    viewCube.colorZ = tmpC1.set(value[0], value[1], value[2]);
                    break;
                case 'radius':
                    viewCube.radius = value;
                    break;
                case 'textSize':
                    viewCube.textSize = value;
                    break;
                case 'lineThickness':
                    viewCube.lineThickness = value;
                    break;
                case 'lineLength':
                    viewCube.lineLength = value;
                    break;
            }
            break;
        }
    }
});

// Periodically mirror selected entity transform back to inspector
const tmpEul = new pc.Vec3();
let __mirrorWrite = false;
let __doingHistory = false;

function mirrorSet(path, value) {
    __mirrorWrite = true;
    try {
        data.set(path, value);
    } finally {
        __mirrorWrite = false;
    }
}

app.on('update', () => {
    const sid = data.get('selectedId');
    if (sid == null) return;
    const rec = registry.get(sid);
    if (!rec) return;
    const e = rec.entity;
    const p = e.getLocalPosition();
    const s = e.getLocalScale();
    const r = e.getLocalEulerAngles(tmpEul);
    const cur = data.get('selected');
    if (!cur) return;
    // Only update if changed to avoid feedback
    const approxEq = (a, b) => Math.abs(a - b) > 1e-4;
    if (!cur.position || approxEq(cur.position[0], p.x) || approxEq(cur.position[1], p.y) || approxEq(cur.position[2], p.z)) {
        mirrorSet('selected.position', [p.x, p.y, p.z]);
    }
    if (!cur.rotation || approxEq(cur.rotation[0], r.x) || approxEq(cur.rotation[1], r.y) || approxEq(cur.rotation[2], r.z)) {
        mirrorSet('selected.rotation', [r.x, r.y, r.z]);
    }
    if (!cur.scale || approxEq(cur.scale[0], s.x) || approxEq(cur.scale[1], s.y) || approxEq(cur.scale[2], s.z)) {
        mirrorSet('selected.scale', [s.x, s.y, s.z]);
    }
});

function doUndo() {
    __doingHistory = true;
    try {
        history.undo();
    } finally {
        __doingHistory = false;
    }
}

function doRedo() {
    __doingHistory = true;
    try {
        history.redo();
    } finally {
        __doingHistory = false;
    }
}

// Destroy handlers
app.on('destroy', () => {
    gizmoHandler.destroy();
    selector.destroy();
    viewCube.destroy();
    window.removeEventListener('resize', resize);
    window.removeEventListener('keydown', keydown);
    window.removeEventListener('keyup', keyup);
    window.removeEventListener('keypress', keypress);
});

// Editor object helpers
function cloneArr(a) {
    return Array.isArray(a) ? a.slice() : a;
}

/**
 * @param {ObjectInfo} rec
 */
function makeDescriptorFromRecord(rec) {
    const e = rec.entity;
    const p = e.getLocalPosition();
    const r = e.getLocalEulerAngles();
    const s = e.getLocalScale();
    // Avoid deep cloning huge mesh meta (positions/normals). Keep a light, shallow meta copy.
    let metaCopy;
    if (rec.type === 'mesh-import') {
        const m = rec.meta || {};
        metaCopy = {
            // Keep references to arrays/typed arrays to prevent OOM from copies
            positions: m.positions,
            normals: m.normals,
            triCount: m.triCount | 0,
            bounds: m.bounds ? {
                min: Array.isArray(m.bounds.min) ? [...m.bounds.min] : m.bounds.min,
                max: Array.isArray(m.bounds.max) ? [...m.bounds.max] : m.bounds.max
            } : undefined,
            source: m.source ? {...m.source} : undefined,
            // Preserve lightweight building meta for meshes as well
            building: m.building ? {
                ratio: Number(m.building.ratio ?? 1),
                meshPath: String(m.building.meshPath ?? ''),
                boundaryScheme: Number(m.building.boundaryScheme ?? 128)
            } : undefined,
            kind: m.kind
        };
    } else if (rec.type === 'vtk-volume') {
        // Keep vtk-volume descriptor lightweight; exclude private heavy arrays like _vtkVectors
        const m = rec.meta || {};
        metaCopy = {
            source: m.source ? {...m.source} : undefined,
            field: m.field ? {
                dims: Array.isArray(m.field.dims) ? [...m.field.dims] : m.field.dims,
                spacing: Array.isArray(m.field.spacing) ? [...m.field.spacing] : m.field.spacing,
                origin: Array.isArray(m.field.origin) ? [...m.field.origin] : m.field.origin
            } : undefined,
            bounds: m.bounds ? {
                min: Array.isArray(m.bounds.min) ? [...m.bounds.min] : m.bounds.min,
                max: Array.isArray(m.bounds.max) ? [...m.bounds.max] : m.bounds.max
            } : undefined,
            importOptions: m.importOptions ? {
                scale: Number(m.importOptions.scale ?? 1),
                upAxis: (m.importOptions.upAxis === 'z') ? 'z' : 'y'
            } : undefined,
            kind: m.kind,
            colorParams: m.colorParams ? {...m.colorParams} : undefined,
            stride: m.stride | 0,
            count: m.count | 0,
            triCount: m.triCount | 0,
            scalarStats: m.scalarStats ? {...m.scalarStats} : undefined
        };
    } else {
        metaCopy = JSON.parse(JSON.stringify(rec.meta || {}));
    }
    return {
        id: rec.id,
        name: rec.name,
        type: rec.type,
        color: cloneArr(rec.color),
        meta: metaCopy,
        transform: {
            position: [p.x, p.y, p.z],
            rotation: [r.x, r.y, r.z],
            scale: [s.x, s.y, s.z]
        }
    };
}

/** Create and configure entity from descriptor (without adding to registry). */
function buildEntityFromDescriptor(desc) {
    /** @type {pc.Entity} */
    let e;
    if (desc.type === 'ground') {
        e = new pc.Entity(desc.name || 'Ground');
        e.addComponent('render', {
            type: 'plane',
            material: createColorMaterial(new pc.Color(desc.color?.[0] ?? 0.5, desc.color?.[1] ?? 0.5, desc.color?.[2] ?? 0.5)),
            castShadows: true,
            receiveShadows: true
        });
        const size = desc.meta?.size || [1000, 1000];
        e.setLocalScale(size[0], 1, size[1]);
    } else if (desc.type === 'building-box') {
        e = new pc.Entity(desc.name || 'Box Building');
        const mesh = new pc.Entity((desc.name || 'Box Building') + ' Mesh');
        mesh.addComponent('render', {
            type: 'box',
            material: createColorMaterial(new pc.Color(desc.color?.[0] ?? 0.3, desc.color?.[1] ?? 0.6, desc.color?.[2] ?? 0.9)),
            castShadows: true,
            receiveShadows: true
        });
        const dims = desc.meta?.dimensions || [2, 4, 2];
        mesh.setLocalScale(dims[0], dims[1], dims[2]);
        mesh.setLocalPosition(0, dims[1] / 2, 0);
        e.addChild(mesh);
        /** @type {any} */ (e)._meshChild = mesh;
    } else if (desc.type === 'building-cylinder') {
        e = new pc.Entity(desc.name || 'Cylinder Building');
        const mesh = new pc.Entity((desc.name || 'Cylinder Building') + ' Mesh');
        mesh.addComponent('render', {
            type: 'cylinder',
            material: createColorMaterial(new pc.Color(desc.color?.[0] ?? 0.9, desc.color?.[1] ?? 0.6, desc.color?.[2] ?? 0.3)),
            castShadows: true,
            receiveShadows: true
        });
        const cyl = desc.meta?.cyl || [1, 4];
        mesh.setLocalScale(cyl[0] * 2, cyl[1], cyl[0] * 2);
        mesh.setLocalPosition(0, cyl[1] / 2, 0);
        e.addChild(mesh);
        /** @type {any} */ (e)._meshChild = mesh;
    } else if (desc.type === 'mesh-import') {
        // Rebuild a custom imported mesh from descriptor meta
        e = new pc.Entity(desc.name || 'Imported Mesh');
        const meshNode = new pc.Entity((desc.name || 'Imported Mesh') + ' Mesh');
        // Recreate mesh from raw arrays
        let created = false;
        try {
            // Normalize arrays possibly saved as TypedArrays or {"0":..} objects
            /** @type {any} */ let posAny = desc.meta && desc.meta.positions;
            /** @type {any} */ let norAny = desc.meta && desc.meta.normals;
            const toNumArray = (v) => {
                if (!v) return null;
                if (Array.isArray(v)) return v;
                if (typeof v.length === 'number' && v.buffer instanceof ArrayBuffer && typeof v.BYTES_PER_ELEMENT === 'number') {
                    try {
                        return Array.from(v);
                    } catch {
                        return null;
                    }
                }
                if (typeof v === 'object') {
                    const keys = Object.keys(v).filter(k => /^\d+$/.test(k)).sort((a, b) => (a | 0) - (b | 0));
                    if (keys.length) return keys.map(k => Number(v[k]));
                }
                return null;
            };
            let positions = /** @type {number[]|null} */ (toNumArray(posAny));
            let normals = /** @type {number[]|null} */ (toNumArray(norAny));

            if (!positions || !positions.length) throw new Error('No positions');

            // If normals missing or length mismatch, compute flat normals
            if (!normals || normals.length !== positions.length) {
                const n = new Float32Array(positions.length);
                for (let i = 0; i < positions.length; i += 9) {
                    const ax = positions[i], ay = positions[i + 1], az = positions[i + 2];
                    const bx = positions[i + 3], by = positions[i + 4], bz = positions[i + 5];
                    const cx = positions[i + 6], cy = positions[i + 7], cz = positions[i + 8];
                    const ux = bx - ax, uy = by - ay, uz = bz - az;
                    const vx = cx - ax, vy = cy - ay, vz = cz - az;
                    let nx = uy * vz - uz * vy;
                    let ny = uz * vx - ux * vz;
                    let nz = ux * vy - uy * vx;
                    const len = Math.hypot(nx, ny, nz) || 1;
                    nx /= len;
                    ny /= len;
                    nz /= len;
                    n[i] = nx;
                    n[i + 1] = ny;
                    n[i + 2] = nz;
                    n[i + 3] = nx;
                    n[i + 4] = ny;
                    n[i + 5] = nz;
                    n[i + 6] = nx;
                    n[i + 7] = ny;
                    n[i + 8] = nz;
                }
                normals = Array.from(n);
            }

            const mesh = pc.createMesh(app.graphicsDevice, positions, {normals});
            const mat = createColorMaterial(new pc.Color(desc.color?.[0] ?? 0.75, desc.color?.[1] ?? 0.75, desc.color?.[2] ?? 0.75));
            const mi = new pc.MeshInstance(mesh, mat);
            // ensure the mesh instance both casts and receives shadows
            mi.castShadow = true;
            mi.receiveShadow = true;
            meshNode.addComponent('render', {castShadows: true, receiveShadows: true});
            meshNode.render.meshInstances = [mi];
            created = true;
            // Restore pivot offset using saved bounds so that reload matches pre-save placement
            try {
                const b = desc && desc.meta && desc.meta.bounds;
                if (b && Array.isArray(b.min) && Array.isArray(b.max)) {
                    const cx = (Number(b.min[0]) + Number(b.max[0])) / 2;
                    const cz = (Number(b.min[2]) + Number(b.max[2])) / 2;
                    const miny = Number(b.min[1]);
                    meshNode.setLocalPosition(-cx, -miny, -cz);
                } else if (positions && positions.length >= 3) {
                    // Fallback: compute bounds from positions
                    let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity,
                        maxz = -Infinity;
                    for (let i = 0; i < positions.length; i += 3) {
                        const x = positions[i], y = positions[i + 1], z = positions[i + 2];
                        if (x < minx) minx = x;
                        if (y < miny) miny = y;
                        if (z < minz) minz = z;
                        if (x > maxx) maxx = x;
                        if (y > maxy) maxy = y;
                        if (z > maxz) maxz = z;
                    }
                    const cx = (minx + maxx) / 2, cz = (minz + maxz) / 2;
                    meshNode.setLocalPosition(-cx, -miny, -cz);
                }
            } catch (_) { /* ignore */
            }
        } catch (err) {
            console.warn('Failed to rebuild imported mesh, using placeholder box:', err?.message || err);
        }
        // Fallback placeholder so the rest of the editor (outline, color edits) has a valid render target
        if (!created) {
            const color = new pc.Color(
                desc.color?.[0] ?? 0.75,
                desc.color?.[1] ?? 0.75,
                desc.color?.[2] ?? 0.75
            );
            meshNode.addComponent('render', {
                type: 'box',
                material: createColorMaterial(color),
                castShadows: true,
                receiveShadows: true
            });
            // Place pivot on the ground similarly to imported meshes (half height)
            meshNode.setLocalScale(1, 1, 1);
            meshNode.setLocalPosition(0, 0.5, 0);
            // Mark descriptor meta as invalid (non-destructive)
            try {
                if (desc.meta) desc.meta.invalid = true;
            } catch (_) {
            }
        }
        e.addChild(meshNode);
        /** @type {any} */ (e)._meshChild = meshNode;
    } else if (desc.type === 'vtk-volume') {
        // VTK Volume: visualize bounds as a translucent box (matches import path)
        e = new pc.Entity(desc.name || 'VTK Volume');
        const box = new pc.Entity((desc.name || 'VTK Volume') + ' Box');
        const m = new pc.StandardMaterial();
        m.diffuse = new pc.Color(
            desc.color?.[0] ?? 0.2,
            desc.color?.[1] ?? 0.6,
            desc.color?.[2] ?? 1.0
        );
        m.opacity = 0.12;
        m.blendType = pc.BLEND_NORMAL;
        m.update();
        box.addComponent('render', {type: 'box', material: m, castShadows: false, receiveShadows: false});
        e.addChild(box);
        /** @type {any} */ (e)._meshChild = box;
        try {
            const b = desc.meta?.bounds;
            if (b && Array.isArray(b.min) && Array.isArray(b.max)) {
                const min = b.min, max = b.max;
                const cx = (min[0] + max[0]) * 0.5;
                const cy = (min[1] + max[1]) * 0.5;
                const cz = (min[2] + max[2]) * 0.5;
                const sx = Math.max(0.000001, max[0] - min[0]);
                const sy = Math.max(0.000001, max[1] - min[1]);
                const sz = Math.max(0.000001, max[2] - min[2]);
                e.setLocalPosition(cx, cy, cz);
                box.setLocalPosition(0, 0, 0);
                box.setLocalScale(sx, sy, sz);
            } else {
                box.setLocalScale(1, 1, 1);
                box.setLocalPosition(0, 0, 0);
            }
        } catch (_) { /* ignore */ }
    } else if (desc.type === 'analysis-space') {
        // Analysis Space: visualize AABB as translucent box
        e = new pc.Entity(desc.name || 'Analysis Space');
        const mesh = new pc.Entity((desc.name || 'Analysis Space') + ' Box');
        const m = new pc.StandardMaterial();
        // Unlit, additive overlay so it never looks like a shadow
        m.diffuse = new pc.Color(0, 0, 0);
        // Tone down brightness and make it a bit more see‑through (match createAnalysisSpace)
        m.emissive = new pc.Color(0.18, 0.86, 0.92);
        mat.emissiveIntensity = 0.01;
        mat.opacity = 0.01;
        m.blendType = pc.BLEND_ADDITIVE; // avoid darkening objects behind
        m.useLighting = false; // unlit – not affected by lights/shadows
        m.depthWrite = false; // don't write to depth to reduce occlusion artifacts
        m.cull = pc.CULLFACE_NONE; // show both sides
        m.update();
        mesh.addComponent('render', {type: 'box', material: m, castShadows: false, receiveShadows: false});
        e.addChild(mesh);
        /** @type {any} */ (e)._meshChild = mesh;
        // default AABB if missing
        const amin = Array.isArray(desc.meta?.min) ? desc.meta.min.slice(0, 3) : [-50, 0, -50];
        const amax = Array.isArray(desc.meta?.max) ? desc.meta.max.slice(0, 3) : [50, 50, 50];
        // set visual from AABB
        const cx = (amin[0] + amax[0]) * 0.5;
        const cy = (amin[1] + amax[1]) * 0.5;
        const cz = (amin[2] + amax[2]) * 0.5;
        const sx = Math.max(0.0001, amax[0] - amin[0]);
        const sy = Math.max(0.0001, amax[1] - amin[1]);
        const sz = Math.max(0.0001, amax[2] - amin[2]);
        e.setLocalPosition(cx, cy, cz);
        mesh.setLocalPosition(0, 0, 0);
        mesh.setLocalScale(sx, sy, sz);
    } else {
        e = new pc.Entity(desc.name || 'Entity');
    }
    // Apply transform
    const t = desc.transform || {};
    const p = t.position || [0, 0, 0];
    const r = t.rotation || [0, 0, 0];
    const s = t.scale || [1, 1, 1];
    e.setLocalPosition(p[0], p[1], p[2]);
    e.setLocalEulerAngles(r[0], r[1], r[2]);
    e.setLocalScale(s[0], s[1], s[2]);
    return e;
}

function refreshObjects() {
    /** @type {ObjectInfo[]} */
    const arr = [];
    registry.forEach((rec, id) => {
        // Hide helper slice handles from the objects list
        if (rec.type === 'slice-handle') return;
        // IMPORTANT: Do NOT push heavy meta (positions/normals) into Observer state.
        // Observer deep‑clones arrays, which can OOM on large meshes.
        // Keep the objects list lightweight and include only a tiny summary.
        let summary = undefined;
        if (rec.type === 'mesh-import') {
            const tri = rec?.meta?.triCount | 0;
            const b = rec?.meta?.bounds;
            summary = b ? {triCount: tri, bounds: {min: [...b.min], max: [...b.max]}} : {triCount: tri};
        } else if (rec.type === 'vtk-volume') {
            const b = rec?.meta?.bounds;
            summary = b ? {bounds: {min: [...b.min], max: [...b.max]}} : undefined;
        }
        arr.push({id, name: rec.name, type: rec.type, color: rec.color, meta: summary});
    });
    arr.sort((a, b) => a.id - b.id);
    data.set('objects', arr);
}

function setSelectedId(id) {
    data.set('selectedId', id);
}

function setInspectorFromEntity(rec) {
    const e = rec.entity;
    const p = e.getLocalPosition();
    const s = e.getLocalScale();
    const r = e.getLocalEulerAngles();
    const color = rec.color;
    const base = {
        id: rec.id,
        name: rec.name,
        type: rec.type,
        position: [p.x, p.y, p.z],
        rotation: [r.x, r.y, r.z],
        scale: [s.x, s.y, s.z],
        color
    };
    if (rec.type === 'ground') base.size = rec.meta.size;
    if (rec.type === 'building-box') base.dimensions = rec.meta.dimensions;
    if (rec.type === 'building-cylinder') base.cyl = rec.meta.cyl;
    // Expose Building meta for buildings and imported meshes
    if (rec.type === 'building-box' || rec.type === 'building-cylinder' || rec.type === 'mesh-import') {
        try {
            // Ensure meta.building exists for editability
            if (!rec.meta) rec.meta = {};
            if (!rec.meta.building) {
                rec.meta.building = defBuildingMeta();
            }
            const bm = rec.meta.building;
            base.building = {
                ratio: Number(bm.ratio != null ? bm.ratio : 1),
                meshPath: String(bm.meshPath != null ? bm.meshPath : ''),
                boundaryScheme: Number(bm.boundaryScheme != null ? bm.boundaryScheme : 128)
            };
        } catch (_) { /* ignore */
        }
    }
    if (rec.type === 'analysis-space') {
        const m = rec.meta || {};
        base.min = Array.isArray(m.min) ? m.min.slice(0, 3) : [-50, 0, -50];
        base.max = Array.isArray(m.max) ? m.max.slice(0, 3) : [50, 50, 50];
        // provide a shallow copy of planes for UI
        try {
            base.planes = JSON.parse(JSON.stringify(m.planes || {}));
        } catch (_) {
            base.planes = m.planes || {};
        }
    }
    // Propagate lightweight meta so UI can react (e.g., colorbar for glyphs)
    if (rec.meta) {
        try {
            if (rec.meta.kind) base.kind = rec.meta.kind;
            if (rec.meta.colorParams) base.colorParams = {...rec.meta.colorParams};
        } catch (_) {
        }
    }
    if (rec.type === 'mesh-import' && rec.meta && rec.meta.kind === 'wind-streamlines') {
        // Expose lightweight params/info for inspector (avoid heavy arrays)
        try {
            base.streamParams = rec.meta.streamParams ? {...rec.meta.streamParams} : undefined;
            const f = rec.meta.field;
            if (f) base.windInfo = {dims: [...f.dims], spacing: [...f.spacing], origin: [...f.origin]};
            base.coloring = rec.meta.colorParams ? {...rec.meta.colorParams} : undefined;
            base.anim = rec.meta.anim ? {
                style: rec.meta.anim.style,
                speed: rec.meta.anim.speed,
                trail: rec.meta.anim.trail,
                repeat: rec.meta.anim.repeat,
                feather: rec.meta.anim.feather,
                playing: !!rec.meta.anim.playing
            } : undefined;
            base.hasScalars = !!rec.meta._scalars;
            base.scalarName = rec.meta.scalarStats?.name || undefined;
        } catch (_) { /* ignore */
        }
    } else if (rec.type === 'mesh-import' && rec.meta && rec.meta.kind === 'scalar-slice') {
        try {
            base.scalarSlice = true;
            const f = rec.meta.field;
            if (f) base.scalarInfo = {dims: [...f.dims], spacing: [...f.spacing], origin: [...f.origin]};
            base.sliceParams = rec.meta.sliceParams ? {...rec.meta.sliceParams} : undefined;
            base.coloring = rec.meta.colorParams ? {...rec.meta.colorParams} : undefined;
            base.scalarStats = rec.meta.scalarStats ? {...rec.meta.scalarStats} : undefined;
        } catch (_) {
        }
    } else if (rec.type === 'mesh-import' && rec.meta && rec.meta.kind === 'y-slice') {
        try {
            base.ySlice = true;
            const f = rec.meta.field;
            if (f) base.scalarInfo = {dims: [...f.dims], spacing: [...f.spacing], origin: [...f.origin]};
            base.sliceParams = rec.meta.sliceParams ? {...rec.meta.sliceParams} : undefined;
            base.coloring = rec.meta.colorParams ? {...rec.meta.colorParams} : undefined;
            base.scalarStats = rec.meta.scalarStats ? {...rec.meta.scalarStats} : undefined;
            base.heightT = rec.meta.heightT != null ? rec.meta.heightT : 0.5;
        } catch (_) {
        }
    }
    data.set('selected', base);
}

function updateSelectedInspector() {
    const sid = data.get('selectedId');
    if (sid == null) {
        data.set('selected', null);
        return;
    }
    const rec = registry.get(sid);
    if (rec) setInspectorFromEntity(rec);
}

function addRecord(entity, name, type, colorArr, meta, preferredId) {
    const id = (preferredId != null) ? preferredId : nextId++;
    if (id >= nextId) nextId = id + 1;
    /** @type {any} */ (entity)._sid = id;
    entity.name = name;
    // If this is a wrapper entity (pivot at bottom), store mesh child if present
    /** @type {any} */ (entity)._meshChild = /** @type {any} */ (entity)._meshChild || null;
    // Propagate id to mesh child so picking works on both root and mesh
    if (/** @type {any} */ (entity)._meshChild) {
        /** @type {any} */ (entity)._meshChild._sid = id;
    }
    const rec = {id, name, type, color: colorArr, meta, entity};
    registry.set(id, rec);
    refreshObjects();
    setSelectedId(id);
    // Select visually
    gizmoHandler.add(entity, true);
    outlineRenderer.removeAllEntities();
    // Skip outline for animated wind-streamlines to avoid special-pass shader issues
    const isWind = (type === 'mesh-import') && (meta && meta.kind === 'wind-streamlines');
    // Add outline to the mesh entity (child) if the root has no render
    if (!isWind) {
        const outlineTarget = /** @type {any} */ (entity.render ? entity : /** @type {any} */ (entity)._meshChild);
        if (outlineTarget) outlineRenderer.addEntity(outlineTarget, pc.Color.WHITE);
    }
    setInspectorFromEntity(rec);
}

function addRecordFromDescriptor(desc) {
    const e = buildEntityFromDescriptor(desc);
    app.root.addChild(e);
    addRecord(e, desc.name, desc.type, desc.color, desc.meta, desc.id);
    return registry.get(desc.id);
}

function getEntityTransform(e) {
    const p = e.getLocalPosition();
    const r = e.getLocalEulerAngles();
    const s = e.getLocalScale();
    return {position: [p.x, p.y, p.z], rotation: [r.x, r.y, r.z], scale: [s.x, s.y, s.z]};
}

function setEntityTransform(e, t) {
    if (!t) return;
    const p = t.position || null;
    const r = t.rotation || null;
    const s = t.scale || null;
    if (p) e.setLocalPosition(p[0], p[1], p[2]);
    if (r) e.setLocalEulerAngles(r[0], r[1], r[2]);
    if (s) e.setLocalScale(s[0], s[1], s[2]);
}

function applyTransformById(id, t) {
    const rec = registry.get(id);
    if (!rec) return;
    setEntityTransform(rec.entity, t);
    if (data.get('selectedId') === id) updateSelectedInspector();
}

function setNameById(id, name) {
    const rec = registry.get(id);
    if (!rec) return;
    rec.name = String(name || '');
    rec.entity.name = rec.name;
    refreshObjects();
    if (data.get('selectedId') === id) updateSelectedInspector();
}

function setColorById(id, colorArr) {
    const rec = registry.get(id);
    if (!rec) return;
    const e = rec.entity;
    /** @type {any} */ const target = /** @type {any} */ (e.render ? e : /** @type {any} */ (e)._meshChild);
    if (target && target.render && target.render.meshInstances && target.render.meshInstances.length) {
        const mi0 = target.render.meshInstances[0];
        const mat = mi0 && mi0.material;
        if (mat && mat.diffuse && Array.isArray(colorArr) && colorArr.length >= 3) {
            mat.diffuse.set(colorArr[0], colorArr[1], colorArr[2]);
            mat.update();
            rec.color = [colorArr[0], colorArr[1], colorArr[2]];
            if (data.get('selectedId') === id) updateSelectedInspector();
        }
    }
}

function setGroundSizeById(id, size) {
    const rec = registry.get(id);
    if (!rec || rec.type !== 'ground') return;
    const e = rec.entity;
    if (Array.isArray(size) && size.length >= 2) {
        e.setLocalScale(size[0], 1, size[1]);
        rec.meta.size = [size[0], size[1]];
        if (data.get('selectedId') === id) updateSelectedInspector();
    }
}

function setBoxDimById(id, dims) {
    const rec = registry.get(id);
    if (!rec || rec.type !== 'building-box') return;
    const e = rec.entity;
    /** @type {any} */ const target = /** @type {any} */ ((/** @type {any} */ (e))._meshChild || e);
    if (Array.isArray(dims) && dims.length >= 3 && target) {
        target.setLocalScale(dims[0], dims[1], dims[2]);
        if (target !== e) target.setLocalPosition(0, dims[1] / 2, 0);
        rec.meta.dimensions = [dims[0], dims[1], dims[2]];
        if (data.get('selectedId') === id) updateSelectedInspector();
    }
}

function setCylinderById(id, cyl) {
    const rec = registry.get(id);
    if (!rec || rec.type !== 'building-cylinder') return;
    const e = rec.entity;
    /** @type {any} */ const target = /** @type {any} */ ((/** @type {any} */ (e))._meshChild || e);
    if (Array.isArray(cyl) && cyl.length >= 2 && target) {
        const r = cyl[0], h = cyl[1];
        target.setLocalScale(r * 2, h, r * 2);
        if (target !== e) target.setLocalPosition(0, h / 2, 0);
        rec.meta.cyl = [r, h];
        if (data.get('selectedId') === id) updateSelectedInspector();
    }
}

// ---- Building meta helpers ----
function defBuildingMeta() {
    return {ratio: 1, meshPath: '', boundaryScheme: 128};
}

/**
 * Update Building meta for a record (buildings or imported meshes).
 * @param {number} id
 * @param {{ ratio?: number, meshPath?: string, boundaryScheme?: number }} props
 */
function setBuildingMetaById(id, props) {
    const rec = registry.get(id);
    if (!rec || (rec.type !== 'building-box' && rec.type !== 'building-cylinder' && rec.type !== 'mesh-import')) return;
    const m = rec.meta || (rec.meta = {});
    const before = JSON.parse(JSON.stringify(m.building || defBuildingMeta()));
    const b = (m.building = Object.assign(defBuildingMeta(), m.building || {}));
    if (props) {
        if (props.ratio != null && isFinite(Number(props.ratio))) b.ratio = Number(props.ratio);
        if (props.meshPath != null) b.meshPath = String(props.meshPath);
        if (props.boundaryScheme != null) b.boundaryScheme = Number(props.boundaryScheme) | 0;
    }
    if (data.get('selectedId') === id) updateSelectedInspector();
    history.commit({
        label: 'Edit Building Meta',
        undo: () => {
            const rec2 = registry.get(id);
            if (!rec2) return;
            rec2.meta = rec2.meta || {};
            rec2.meta.building = JSON.parse(JSON.stringify(before));
            if (data.get('selectedId') === id) updateSelectedInspector();
        },
        redo: () => {
            const rec2 = registry.get(id);
            if (!rec2) return;
            rec2.meta = rec2.meta || {};
            rec2.meta.building = JSON.parse(JSON.stringify(b));
            if (data.get('selectedId') === id) updateSelectedInspector();
        }
    });
}

// ---- Analysis Space helpers ----
/**
 * Ensure planes object has all 6 faces with defaults.
 */
function ensureAnalysisPlanes(planes) {
    const defPlane = () => ({
        boundaryScheme: 8, // NEQ
        wallType: 16, // Outlet
        valueType: 1, // Velocity
        velocity: [0, 0, 0],
        pressure: 0,
        concentration1: 0.1,
        concentration2: 0.2,
        concentration3: 0.3
    });
    const p = planes || {};
    const keys = ['X_min', 'X_max', 'Y_min', 'Y_max', 'Z_min', 'Z_max'];
    for (const k of keys) {
        if (!p[k]) p[k] = defPlane();
    }
    return p;
}

/** Update the visual box of an analysis-space record from min/max. */
function updateAnalysisSpaceVisual(rec, minv, maxv) {
    try {
        const e = rec.entity;
        const mesh = /** @type {any} */(e)._meshChild || e;
        const min = Array.isArray(minv) ? minv : rec.meta.min || [-50, 0, -50];
        const max = Array.isArray(maxv) ? maxv : rec.meta.max || [50, 50, 50];
        const cx = (min[0] + max[0]) * 0.5;
        const cy = (min[1] + max[1]) * 0.5;
        const cz = (min[2] + max[2]) * 0.5;
        const sx = Math.max(0.0001, max[0] - min[0]);
        const sy = Math.max(0.0001, max[1] - min[1]);
        const sz = Math.max(0.0001, max[2] - min[2]);
        e.setLocalPosition(cx, cy, cz);
        if (mesh) {
            mesh.setLocalPosition(0, 0, 0);
            mesh.setLocalScale(sx, sy, sz);
        }
    } catch (_) { /* ignore */
    }
}

function setAnalysisSpaceAABBById(id, minv, maxv) {
    const rec = registry.get(id);
    if (!rec || rec.type !== 'analysis-space') return;
    const m = rec.meta || (rec.meta = {});
    if (Array.isArray(minv) && minv.length >= 3) m.min = [Number(minv[0]) || 0, Number(minv[1]) || 0, Number(minv[2]) || 0];
    if (Array.isArray(maxv) && maxv.length >= 3) m.max = [Number(maxv[0]) || 0, Number(maxv[1]) || 0, Number(maxv[2]) || 0];
    updateAnalysisSpaceVisual(rec, m.min, m.max);
    if (data.get('selectedId') === id) updateSelectedInspector();
}

function setAnalysisPlaneById(id, face, props) {
    const rec = registry.get(id);
    if (!rec || rec.type !== 'analysis-space') return;
    const m = rec.meta || (rec.meta = {});
    m.planes = ensureAnalysisPlanes(m.planes);
    const tgt = m.planes[face];
    if (!tgt) return;
    if (props.boundaryScheme != null) tgt.boundaryScheme = Number(props.boundaryScheme) | 0;
    if (props.wallType != null) tgt.wallType = Number(props.wallType) | 0;
    if (props.valueType != null) tgt.valueType = Number(props.valueType) | 0;
    if (props.velocity && Array.isArray(props.velocity) && props.velocity.length >= 3) {
        tgt.velocity = [Number(props.velocity[0]) || 0, Number(props.velocity[1]) || 0, Number(props.velocity[2]) || 0];
    }
    if (props.pressure != null) tgt.pressure = Number(props.pressure) || 0;
    if (props.concentration1 != null) tgt.concentration1 = Number(props.concentration1) || 0;
    if (props.concentration2 != null) tgt.concentration2 = Number(props.concentration2) || 0;
    if (props.concentration3 != null) tgt.concentration3 = Number(props.concentration3) || 0;
    if (data.get('selectedId') === id) updateSelectedInspector();
}

function createAnalysisSpace() {
    const e = new pc.Entity('Analysis Space');
    const mesh = new pc.Entity('Analysis Space Box');
    const mat = new pc.StandardMaterial();
    // Unlit, additive overlay so it never looks like a shadow
    mat.diffuse = new pc.Color(0, 0, 0);
    // Match toned‑down visual used in descriptor path
    mat.emissive = new pc.Color(0.18, 0.86, 0.92);
    mat.emissiveIntensity = 0.01;
    mat.opacity = 0.01;
    mat.blendType = pc.BLEND_ADDITIVE;
    mat.useLighting = false;
    mat.depthWrite = false;
    mat.cull = pc.CULLFACE_NONE;
    mat.update();
    mesh.addComponent('render', {type: 'box', material: mat, castShadows: false, receiveShadows: false});
    e.addChild(mesh);
    /** @type {any} */ (e)._meshChild = mesh;
    const cp = data.get('cursor.position') || [0, 0, 0];
    // default AABB centered at cursor
    const size = [100, 50, 100];
    const minv = [cp[0] - size[0] / 2, cp[1], cp[2] - size[2] / 2];
    const maxv = [cp[0] + size[0] / 2, cp[1] + size[1], cp[2] + size[2] / 2];
    updateAnalysisSpaceVisual({entity: e}, minv, maxv);
    app.root.addChild(e);
    const color = [0.2, 0.9, 0.9];
    const meta = {min: minv.slice(), max: maxv.slice(), planes: ensureAnalysisPlanes({})};
    addRecord(e, 'Analysis Space', 'analysis-space', color, meta);
    const rec = registry.get(/** @type {any} */ (e)._sid);
    if (rec) {
        const descriptor = makeDescriptorFromRecord(rec);
        history.commit({
            label: 'Create Analysis Space',
            undo: () => {
                deleteById(descriptor.id);
            },
            redo: () => {
                addRecordFromDescriptor(descriptor);
            }
        });
    }
}

function createGround() {
    const e = new pc.Entity('Ground');
    const col = randomColorArr();
    e.addComponent('render', {
        type: 'plane',
        material: createColorMaterial(new pc.Color(col[0], col[1], col[2])),
        castShadows: true,
        receiveShadows: true
    });
    e.setLocalScale(1000, 1, 1000);
    const cp = data.get('cursor.position') || [0, 0, 0];
    e.setLocalPosition(cp[0], cp[1], cp[2]);
    app.root.addChild(e);
    addRecord(e, 'Ground', 'ground', col, {size: [1000, 1000]});
    // Commit to history
    const rec = registry.get(/** @type {any} */ (e)._sid);
    if (rec) {
        const descriptor = makeDescriptorFromRecord(rec);
        history.commit({
            label: 'Create Ground',
            undo: () => {
                deleteById(descriptor.id);
            },
            redo: () => {
                addRecordFromDescriptor(descriptor);
            }
        });
    }
}

function createBoxBuilding() {
    // Root entity is the pivot (at bottom). Mesh is a child offset by +H/2.
    const e = new pc.Entity('Box Building');
    const mesh = new pc.Entity('Box Building Mesh');
    const col = randomColorArr();
    mesh.addComponent('render', {
        type: 'box',
        material: createColorMaterial(new pc.Color(col[0], col[1], col[2])),
        castShadows: true,
        receiveShadows: true
    });
    // Default dimensions (scaled up 10x)
    const dims = [20, 40, 20];
    mesh.setLocalScale(dims[0], dims[1], dims[2]);
    mesh.setLocalPosition(0, dims[1] / 2, 0);
    e.addChild(mesh);
    /** @type {any} */ (e)._meshChild = mesh;
    const cp = data.get('cursor.position') || [0, 0, 0];
    e.setLocalPosition(cp[0], cp[1], cp[2]);
    app.root.addChild(e);
    addRecord(e, 'Box Building', 'building-box', col, {dimensions: dims, building: defBuildingMeta()});
    const rec = registry.get(/** @type {any} */ (e)._sid);
    if (rec) {
        const descriptor = makeDescriptorFromRecord(rec);
        history.commit({
            label: 'Create Box',
            undo: () => {
                deleteById(descriptor.id);
            },
            redo: () => {
                addRecordFromDescriptor(descriptor);
            }
        });
    }
}

function createCylinderBuilding() {
    const e = new pc.Entity('Cylinder Building');
    const mesh = new pc.Entity('Cylinder Building Mesh');
    const col = randomColorArr();
    mesh.addComponent('render', {
        type: 'cylinder',
        material: createColorMaterial(new pc.Color(col[0], col[1], col[2])),
        castShadows: true,
        receiveShadows: true
    });
    // radius 10, height 40 => diameter 20 (scaled up 10x)
    const cyl = [10, 40];
    mesh.setLocalScale(cyl[0] * 2, cyl[1], cyl[0] * 2);
    mesh.setLocalPosition(0, cyl[1] / 2, 0);
    e.addChild(mesh);
    /** @type {any} */ (e)._meshChild = mesh;
    const cp = data.get('cursor.position') || [0, 0, 0];
    e.setLocalPosition(cp[0], cp[1], cp[2]);
    app.root.addChild(e);
    addRecord(e, 'Cylinder Building', 'building-cylinder', col, {cyl, building: defBuildingMeta()});
    const rec = registry.get(/** @type {any} */ (e)._sid);
    if (rec) {
        const descriptor = makeDescriptorFromRecord(rec);
        history.commit({
            label: 'Create Cylinder',
            undo: () => {
                deleteById(descriptor.id);
            },
            redo: () => {
                addRecordFromDescriptor(descriptor);
            }
        });
    }
}

function deleteById(id) {
    const rec = registry.get(id);
    if (!rec) return;
    if (data.get('selectedId') === id) {
        outlineRenderer.removeAllEntities();
        gizmoHandler.clear();
        setSelectedId(null);
        data.set('selected', null);
    }
    rec.entity.destroy();
    registry.delete(id);
    refreshObjects();
}

function deleteSelected() {
    const sid = data.get('selectedId');
    if (sid == null) return;
    const rec = registry.get(sid);
    if (!rec) return;
    const descriptor = makeDescriptorFromRecord(rec);
    deleteById(sid);
    history.commit({
        label: 'Delete ' + (rec.type || 'Object'),
        undo: () => {
            const r = addRecordFromDescriptor(descriptor);
            if (r) selectById(descriptor.id);
        },
        redo: () => {
            deleteById(descriptor.id);
        }
    });
}

function selectById(id) {
    const rec = registry.get(id);
    if (!rec) return;
    setSelectedId(id);
    // Visuals
    const root = rec.entity;
    const isWind = (rec.type === 'mesh-import') && (rec?.meta?.kind === 'wind-streamlines');
    const outlineTarget = /** @type {any} */ (root.render ? root : /** @type {any} */ (root)._meshChild);
    gizmoHandler.add(root, true);
    outlineRenderer.removeAllEntities();
    if (!isWind && outlineTarget) outlineRenderer.addEntity(outlineTarget, pc.Color.WHITE);
    setInspectorFromEntity(rec);
}

// UI events from React controls
// Prefer custom events over data paths for actions
if (typeof data.on === 'function') {
    data.on('ui:create', (/** @type {string} */ what) => {
        switch (what) {
            case 'ground':
                createGround();
                break;
            case 'box':
                createBoxBuilding();
                break;
            case 'cylinder':
                createCylinderBuilding();
                break;
            case 'analysis-space':
                createAnalysisSpace();
                break;
        }
    });
    data.on('ui:delete', () => deleteSelected());
    data.on('ui:select', (/** @type {number} */ id) => selectById(id));
}

// Simple console capture
(function setupConsoleCapture() {
    const max = 200;
    let lastMsg = '';
    let lastTime = 0;
    const dedupeWindowMs = 100; // drop identical messages spammed within this window
    const brief = (v) => {
        try {
            if (v == null) return String(v);
            const t = Object.prototype.toString.call(v);
            // TypedArrays / Arrays — avoid huge JSON.stringify
            const isTA = /Array\]$/.test(t) && typeof v.length === 'number' && typeof v.BYTES_PER_ELEMENT === 'number';
            const isArr = Array.isArray(v);
            if ((isTA || isArr) && v.length > 200) {
                const name = v.constructor && v.constructor.name || (isTA ? 'TypedArray' : 'Array');
                return `[${name} len=${v.length}]`;
            }
            if (typeof v === 'object') {
                // Shallow stringify small objects only
                const json = JSON.stringify(v, (key, val) => {
                    if (val && (Array.isArray(val) || (val.buffer && typeof val.length === 'number'))) {
                        const name = val.constructor && val.constructor.name || 'Array';
                        const len = typeof val.length === 'number' ? val.length : 0;
                        return len > 200 ? `[${name} len=${len}]` : val;
                    }
                    return val;
                });
                return json.length > 2000 ? json.slice(0, 1997) + '…' : json;
            }
            return String(v);
        } catch {
            return String(v);
        }
    };
    const push = (level, args) => {
        const list = data.get('console') || [];
        const msg = Array.from(args).map(brief).join(' ');
        const now = Date.now();
        if (msg === lastMsg && (now - lastTime) < dedupeWindowMs) {
            return; // avoid tight log loops
        }
        lastMsg = msg;
        lastTime = now;
        list.push({level, msg, time: Date.now()});
        while (list.length > max) list.shift();
        data.set('console', list);
    };
    const orig = {log: console.log, warn: console.warn, error: console.error};
    console.log = (...args) => {
        push('log', args);
        orig.log.apply(console, args);
    };
    console.warn = (...args) => {
        push('warn', args);
        orig.warn.apply(console, args);
    };
    console.error = (...args) => {
        push('error', args);
        orig.error.apply(console, args);
    };
})();

// Initial focus
window.focus();

// Expose minimal API for UI (window.SimEdit9)
/** @type {any} */
const api = (window.SimEdit9 = window.SimEdit9 || {});
api.createGround = createGround;
api.createBoxBuilding = createBoxBuilding;
api.createCylinderBuilding = createCylinderBuilding;
api.createAnalysisSpace = createAnalysisSpace;
api.setAnalysisSpaceAABBById = setAnalysisSpaceAABBById;
api.setAnalysisPlaneById = setAnalysisPlaneById;
api.deleteSelected = deleteSelected;
api.selectById = selectById;
api.undo = () => doUndo();
api.redo = () => doRedo();
api.getCameraTransform = () => {
    try {
        const p = camera.getPosition();
        const a = camera.getEulerAngles();
        return {position: {x: p.x, y: p.y, z: p.z}, euler: {x: a.x, y: a.y, z: a.z}};
    } catch (e) {
        return null;
    }
};
api.exportToTofuJson = () => {
    exportToTofuJson();
};
api.setBuildingMetaById = (id, props) => {
    setBuildingMetaById(id, props || {});
};
// Export scene geometry clipped by Analysis Space AABB as STL
api.exportClippedSTL = (opts) => {
    exportClippedSTL(opts);
};
api.exportPreprocessedData = (opts) => {
    exportPreprocessedData(opts);
};


// -------- Scene initialize / save / load --------
function clearScene() {
    try {
        // Deselect and clear visuals
        try {
            outlineRenderer.removeAllEntities();
        } catch (_) {
        }
        try {
            gizmoHandler.clear && gizmoHandler.clear();
        } catch (_) {
        }
        data.set('selectedId', null);
        data.set('selected', null);

        // Destroy all entities from registry
        for (const rec of registry.values()) {
            try {
                rec.entity?.destroy?.();
            } catch (_) {
            }
        }
        registry.clear();
        nextId = 1;
        refreshObjects();
    } catch (err) {
        console.error('씬 비우기 실패:', err);
    }
}

// ---- Export: Tofu Preprocessing JSON ----
/**
 * @param {Object} [options]
 * @param {Map<number, string>} [options.meshPathMap] - Optional mapping from record ID to ZIP-relative STL path
 */
function buildTofuPreprocessingJson(options = {}) {
    const meshPathMap = options.meshPathMap || null;
    // meta
    const meta = {name: '', desc: 'Pre-processing data', solver_type: 'lbm', protocol: 'aero', version: 1};
    // Find analysis-space: prefer the currently selected one, fallback to first
    let analysis = null;
    try {
        const sid = data.get('selectedId');
        if (sid != null && registry.has(sid)) {
            const rec = registry.get(sid);
            if (rec && rec.type === 'analysis-space') analysis = rec;
        }
    } catch (_) { /* ignore */
    }
    if (!analysis) {
        for (const rec of registry.values()) {
            if (rec.type === 'analysis-space') {
                analysis = rec;
                break;
            }
        }
    }
    const defMin = [-50, 0, -50];
    const defMax = [50, 50, 50];
    // Use current world-space AABB of the analysis box if available
    let min = defMin, max = defMax;
    if (analysis) {
        let aabbNow = null;
        try {
            aabbNow = getEntityWorldAabb(analysis.entity);
        } catch (_) {
            aabbNow = null;
        }
        if (aabbNow && aabbNow.min && aabbNow.max) {
            min = aabbNow.min;
            max = aabbNow.max;
        } else {
            min = analysis?.meta?.min || defMin;
            max = analysis?.meta?.max || defMax;
        }
    }
    // Boundary conditions from planes or defaults
    const planes = ensureAnalysisPlanes(analysis?.meta?.planes || {});
    const faces = ['X_min', 'X_max', 'Y_min', 'Y_max', 'Z_min', 'Z_max'];
    const boundary = faces.map((name, idx) => {
        const p = planes[name] || {};
        return {
            BoundaryScheme: p.boundaryScheme != null ? p.boundaryScheme : 8,
            Dependency: 0,
            Position: idx,
            Pressure: p.pressure != null ? p.pressure : 0,
            TemperatureType: 0,
            TemperatureValue: 0,
            ValueType: p.valueType != null ? p.valueType : 1,
            Velocity: Array.isArray(p.velocity) ? [p.velocity[0] || 0, p.velocity[1] || 0, p.velocity[2] || 0] : [0, 0, 0],
            WallType: p.wallType != null ? p.wallType : 16,
            Concentration1: p.concentration1 != null ? p.concentration1 : 0.1,
            Concentration2: p.concentration2 != null ? p.concentration2 : 0.2,
            Concentration3: p.concentration3 != null ? p.concentration3 : 0.3
        };
    });

    // Helper: AABB intersection test
    function intersects(a, b) {
        if (!a || !b) return true;
        return !(a.max[0] < b.min[0] || a.min[0] > b.max[0] ||
            a.max[1] < b.min[1] || a.min[1] > b.max[1] ||
            a.max[2] < b.min[2] || a.min[2] > b.max[2]);
    }

    // Analysis-space AABB in world space
    let aabbAnalysis = null;
    if (analysis && analysis.entity) {
        try {
            aabbAnalysis = getEntityWorldAabb(analysis.entity);
        } catch (_) {
            aabbAnalysis = null;
        }
    }
    // Structs from buildings and imported meshes that intersect analysis-space
    const structs = [];
    for (const rec of registry.values()) {
        const type = rec.type;
        const isBld = (type === 'building-box' || type === 'building-cylinder');
        const isMesh = (type === 'mesh-import');
        if (!isBld && !isMesh) continue;
        // Skip special visualization meshes
        if (isMesh && rec.meta && (rec.meta.kind === 'wind-streamlines' || rec.meta.kind === 'scalar-slice' || rec.meta.kind === 'y-slice')) continue;
        const aabbEnt = getEntityWorldAabb(rec.entity);
        if (aabbAnalysis && aabbEnt && !intersects(aabbAnalysis, aabbEnt)) continue;
        // Compose Building struct using meta.building defaults
        const bm = (rec.meta && rec.meta.building) ? rec.meta.building : defBuildingMeta();
        const e = rec.entity;
        const p = e.getLocalPosition();
        
        let meshPath = (bm.meshPath && String(bm.meshPath)) || (rec.meta && rec.meta.source && rec.meta.source.name) || '';
        // If we have a provided mapping for ZIP export, override the mesh path
        if (meshPathMap && meshPathMap.has(rec.id)) {
            meshPath = meshPathMap.get(rec.id);
        }

        const ratio = isFinite(Number(bm.ratio)) ? Number(bm.ratio) : 1.0;
        const boundaryScheme = (bm.boundaryScheme != null) ? (Number(bm.boundaryScheme) | 0) : 128;
        structs.push({
            BoundaryScheme: boundaryScheme,
            LocalCenter: [p.x, p.y, p.z],
            MeshPath: meshPath,
            Ratio: ratio,
            SubdivisionBuffer: [0],
            SubdivisionDepth: 0,
            UsePressureGradient: false,
            WallModel: {UsePressureGradient: false, WallModelB: 5, WallModelKappa: 0.41}
        });
    }
    const doc = {
        meta,
        ui: {
            PreGridSetting: {
                LatRefLength: 1,
                LatRefTime: 1,
                Layer: [{Min: [min[0], min[1], min[2]], Max: [max[0], max[1], max[2]]}]
            },
            AnalysisSetting: {
                AllSave: true, AverageEndTime: 0, AverageInterval: 0, AverageStartTime: 0,
                ChemicalReactionSolverType: 1, EndTime: 0,
                ResultFileFormat: 1, SaveEndTime: 0, SaveInterval: 0,
                SaveResult: 6953557824861388008, SaveStartTime: 0, SolverType: 0, ThermalSolverType: 0,
                UseDevice: [true, false, false, false]
            },
            FlowSetting: {
                AngularVelocity: [0, 0, 0], CollisionType: 2, GravitationalAcceleration: [0, 0, 0], HRweight: 0.75,
                InitVelocity: [0, 0, 0], MomentumSource: [0, 0, 0], Origin: [0, 0, 0], RefPressure: 0,
                Smagorinsky: 0.4, Turbulence: true, TurbulenceType: 1
            },
            FluidProperty: {
                Concentration1Diffusivity: 2.22222e-07,
                Concentration2Diffusivity: 2.22222e-07,
                Concentration3Diffusivity: 2.22222e-07,
                Concentration4Diffusivity: 2.22222e-07,
                Concentration5Diffusivity: 2.22222e-07,
                Concentration6Diffusivity: 2.22222e-07,
                Density: 1,
                DynamicViscosity: 2.22222e-07
            },
            BoundaryCondition: boundary,
            Struct: structs
        }
    };
    return doc;
}

// ---- Export: Clipped STL by Analysis Space AABB ----
/**
 * Export scene geometry clipped by Analysis Space AABB as STL.
 * Now exports both a unified STL and individual clipped building STLs in a single ZIP.
 */
async function exportClippedSTL(options) {
    try {
        const upAxis = (options && (options.upAxis === 'z' || options.upAxis === 'y')) ? options.upAxis : 'y';

        // 1. Find analysis space (prefer current selection)
        let analysis = null;
        try {
            const sid = data.get('selectedId');
            if (sid != null && registry.has(sid)) {
                const r = registry.get(sid);
                if (r && r.type === 'analysis-space') analysis = r;
            }
        } catch (_) {}
        if (!analysis) {
            for (const rec of registry.values()) {
                if (rec.type === 'analysis-space') {
                    analysis = rec;
                    break;
                }
            }
        }
        if (!analysis) {
            console.warn('[STL] 분석 공간(해석공간)이 없습니다. 먼저 Analysis Space를 생성하세요.');
            return;
        }

        // 2. Compute current world-space AABB
        let aabbNow = null;
        try {
            aabbNow = getEntityWorldAabb(analysis.entity);
        } catch (_) {
            aabbNow = null;
        }
        const amin = (aabbNow && aabbNow.min) ? aabbNow.min : ((analysis.meta && Array.isArray(analysis.meta.min)) ? analysis.meta.min : [-50, 0, -50]);
        const amax = (aabbNow && aabbNow.max) ? aabbNow.max : ((analysis.meta && Array.isArray(analysis.meta.max)) ? analysis.meta.max : [50, 50, 50]);

        // Helpers for clipping against AABB
        const EPS = 1e-6;
        const planes = [
            {n: [1, 0, 0], d: amin[0]}, {n: [-1, 0, 0], d: -amax[0]},
            {n: [0, 1, 0], d: amin[1]}, {n: [0, -1, 0], d: -amax[1]},
            {n: [0, 0, 1], d: amin[2]}, {n: [0, 0, -1], d: -amax[2]}
        ];
        const inside = (nx, ny, nz, d, p) => (nx * p[0] + ny * p[1] + nz * p[2]) >= (d - EPS);
        const faceOutward = planes.map(pl => ([-pl.n[0], -pl.n[1], -pl.n[2]]));

        function intersect(p1, p2, nx, ny, nz, d) {
            const a = nx * p1[0] + ny * p1[1] + nz * p1[2] - d;
            const b = nx * p2[0] + ny * p2[1] + nz * p2[2] - d;
            const denom = (a - b);
            let t = (Math.abs(denom) < 1e-12) ? 0 : a / denom;
            if (t < 0) t = 0; else if (t > 1) t = 1;
            return [
                p1[0] + (p2[0] - p1[0]) * t,
                p1[1] + (p2[1] - p1[1]) * t,
                p1[2] + (p2[2] - p1[2]) * t
            ];
        }

        function clipPolyWithPlane(poly, nx, ny, nz, d) {
            if (!poly.length) return poly;
            const out = [];
            for (let i = 0; i < poly.length; i++) {
                const cur = poly[i];
                const prev = poly[(i + poly.length - 1) % poly.length];
                const curIn = inside(nx, ny, nz, d, cur);
                const prevIn = inside(nx, ny, nz, d, prev);
                if (curIn) {
                    if (!prevIn) out.push(intersect(prev, cur, nx, ny, nz, d));
                    out.push(cur);
                } else if (prevIn) {
                    out.push(intersect(prev, cur, nx, ny, nz, d));
                }
            }
            return out;
        }

        const QEPS = 1e-5;
        const faceSegs = [new Map(), new Map(), new Map(), new Map(), new Map(), new Map()];
        const planeSignedDist = (pl, p) => (pl.n[0] * p[0] + pl.n[1] * p[1] + pl.n[2] * p[2] - pl.d);

        function faceProject(faceIdx, p) {
            switch (faceIdx) {
                case 0: case 1: return [p[2], p[1]]; // X faces -> (z,y)
                case 2: case 3: return [p[0], p[2]]; // Y faces -> (x,z)
                case 4: case 5: return [p[0], p[1]]; // Z faces -> (x,y)
                default: return [p[0], p[1]];
            }
        }

        function quant2(u, v) {
            return Math.round(u / QEPS) + "," + Math.round(v / QEPS);
        }

        function addFaceSegment(faceIdx, a, b) {
            const du = b[0] - a[0], dv = b[1] - a[1], dw = b[2] - a[2];
            if ((du * du + dv * dv + dw * dw) < 1e-16) return;
            const [ua, va] = faceProject(faceIdx, a);
            const [ub, vb] = faceProject(faceIdx, b);
            const ak = quant2(ua, va), bk = quant2(ub, vb);
            if (ak === bk) return;
            const key = ak < bk ? (ak + '|' + bk) : (bk + '|' + ak);
            const map = faceSegs[faceIdx];
            if (map.has(key)) map.delete(key); else map.set(key, {a, b, ak, bk});
        }

        function addFaceSegmentsFromPoly(poly) {
            if (!poly || poly.length < 2) return;
            const faceEPS = 1e-5;
            for (let i = 0; i < poly.length; i++) {
                const A = poly[i], B = poly[(i + 1) % poly.length];
                for (let fi = 0; fi < 6; fi++) {
                    const pl = planes[fi];
                    if (Math.abs(planeSignedDist(pl, A)) <= faceEPS && Math.abs(planeSignedDist(pl, B)) <= faceEPS) {
                        addFaceSegment(fi, A, B);
                    }
                }
            }
        }

        function clipTriangleAABBPoly(p0, p1, p2) {
            let poly = [p0, p1, p2];
            for (const pl of planes) {
                poly = clipPolyWithPlane(poly, pl.n[0], pl.n[1], pl.n[2], pl.d);
                if (poly.length === 0) break;
            }
            return poly;
        }

        let orientFlips = 0;
        function triNormal(a, b, c) {
            const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
            const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
            return [aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx];
        }

        function triangulatePoly(poly, seedN) {
            if (!poly || poly.length < 3) return [];
            const tris = [];
            const useSeed = !!seedN && (Math.hypot(seedN[0], seedN[1], seedN[2]) > 1e-20);
            for (let i = 1; i < poly.length - 1; i++) {
                const a = poly[0], b = poly[i], c = poly[i + 1];
                const n = triNormal(a, b, c);
                if (Math.hypot(n[0], n[1], n[2]) <= 1e-12) continue;
                if (useSeed && (n[0] * seedN[0] + n[1] * seedN[1] + n[2] * seedN[2]) < 0) {
                    tris.push(a, c, b);
                    orientFlips++;
                } else {
                    tris.push(a, b, c);
                }
            }
            return tris;
        }

        function writeBinarySTL(tris, name = 'Clipped STL') {
            const triCount = Math.floor(tris.length / 3);
            const buffer = new ArrayBuffer(84 + 50 * triCount);
            const dv = new DataView(buffer);
            const enc = new TextEncoder();
            const h = enc.encode(name.substring(0, 80));
            const u8 = new Uint8Array(buffer, 0, 80);
            for (let i = 0; i < Math.min(80, h.length); i++) u8[i] = h[i];
            dv.setUint32(80, triCount, true);
            let off = 84;
            const mapV = (p) => (upAxis === 'z') ? [p[0], -p[2], p[1]] : p;
            const nrm = (a, b, c) => {
                const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
                const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
                let nx = ab[1] * ac[2] - ab[2] * ac[1], ny = ab[2] * ac[0] - ab[0] * ac[2], nz = ab[0] * ac[1] - ab[1] * ac[0];
                const len = Math.hypot(nx, ny, nz) || 1;
                return [nx / len, ny / len, nz / len];
            };
            for (let i = 0; i < triCount; i++) {
                const a0 = tris[i * 3 + 0], b0 = tris[i * 3 + 1], c0 = tris[i * 3 + 2];
                const n = nrm(a0, b0, c0);
                const a = mapV(a0), b = mapV(b0), c = mapV(c0), nm = mapV(n);
                dv.setFloat32(off + 0, nm[0], true); dv.setFloat32(off + 4, nm[1], true); dv.setFloat32(off + 8, nm[2], true);
                dv.setFloat32(off + 12, a[0], true); dv.setFloat32(off + 16, a[1], true); dv.setFloat32(off + 20, a[2], true);
                dv.setFloat32(off + 24, b[0], true); dv.setFloat32(off + 28, b[1], true); dv.setFloat32(off + 32, b[2], true);
                dv.setFloat32(off + 36, c[0], true); dv.setFloat32(off + 40, c[1], true); dv.setFloat32(off + 44, c[2], true);
                dv.setUint16(off + 48, 0, true); off += 50;
            }
            return buffer;
        }

        function buildUnitBoxTris() {
            const v = [[-0.5,-0.5,-0.5],[0.5,-0.5,-0.5],[0.5,0.5,-0.5],[-0.5,0.5,-0.5],[-0.5,-0.5,0.5],[0.5,-0.5,0.5],[0.5,0.5,0.5],[-0.5,0.5,0.5]];
            const t = [];
            t.push(v[0], v[3], v[2], v[0], v[2], v[1]); // back
            t.push(v[4], v[5], v[6], v[4], v[6], v[7]); // front
            t.push(v[0], v[3], v[7], v[0], v[7], v[4]); // left
            t.push(v[1], v[2], v[6], v[1], v[6], v[5]); // right
            t.push(v[3], v[7], v[6], v[3], v[6], v[2]); // top
            t.push(v[0], v[1], v[5], v[0], v[5], v[4]); // bottom
            return t;
        }

        function buildUnitCylinderTris(segments = 32) {
            const tris = [];
            const r = 0.5, y0 = -0.5, y1 = 0.5;
            for (let i = 0; i < segments; i++) {
                const t0 = (i / segments) * Math.PI * 2, t1 = ((i + 1) / segments) * Math.PI * 2;
                const x0 = Math.cos(t0) * r, z0 = Math.sin(t0) * r, x1 = Math.cos(t1) * r, z1 = Math.sin(t1) * r;
                tris.push([x0, y0, z0], [x1, y1, z1], [x1, y0, z1]);
                tris.push([x0, y0, z0], [x0, y1, z0], [x1, y1, z1]);
                tris.push([0, y0, 0], [x0, y0, z0], [x1, y0, z1]);
                tris.push([0, y1, 0], [x0, y1, z0], [x1, y1, z1]);
            }
            return tris;
        }

        const tmp = new pc.Vec3();
        function transformPoint(m, p) {
            tmp.set(p[0], p[1], p[2]);
            m.transformPoint(tmp, tmp);
            return [tmp.x, tmp.y, tmp.z];
        }

        function buildLoopsAndTriangulate(targetOutTris) {
            let capTrisLocal = 0;
            for (let fi = 0; fi < 6; fi++) {
                const segMap = faceSegs[fi];
                if (!segMap.size) continue;
                const adj = new Map(), keyToPoint = new Map(), unused = new Map();
                for (const {ak, bk, a, b} of segMap.values()) {
                    if (!adj.has(ak)) adj.set(ak, []); if (!adj.has(bk)) adj.set(bk, []);
                    adj.get(ak).push(bk); adj.get(bk).push(ak);
                    keyToPoint.set(ak, a); keyToPoint.set(bk, b);
                    if (!unused.has(ak)) unused.set(ak, new Set()); if (!unused.has(bk)) unused.set(bk, new Set());
                    unused.get(ak).add(bk); unused.get(bk).add(ak);
                }
                while (true) {
                    let first = null;
                    for (const [aK, nbrs] of unused.entries()) {
                        if (nbrs.size > 0) {
                            const bK = nbrs.values().next().value;
                            nbrs.delete(bK); unused.get(bK).delete(aK);
                            first = [aK, bK]; break;
                        }
                    }
                    if (!first) break;
                    const startKey = first[0], loopKeys = [startKey, first[1]];
                    let curr = first[1], guard = 0;
                    while (guard++ < 10000) {
                        const nbrs = unused.get(curr);
                        if (!nbrs || nbrs.size === 0) break;
                        let chosen = null;
                        for (const nkey of nbrs) { if (nkey !== loopKeys[loopKeys.length - 2]) { chosen = nkey; break; } }
                        if (!chosen) { if (loopKeys[0] !== curr) chosen = nbrs.values().next().value; else break; }
                        nbrs.delete(chosen); unused.get(chosen).delete(curr);
                        loopKeys.push(chosen); curr = chosen;
                        if (curr === startKey) break;
                    }
                    const pts = [];
                    for (const k of loopKeys) { const p = keyToPoint.get(k); if (p) pts.push(p); }
                    const cleaned = [];
                    for (let i = 0; i < pts.length; i++) {
                        const a = pts[i], b = pts[(i + 1) % pts.length];
                        if (Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]) > 1e-8) cleaned.push(a);
                    }
                    if (cleaned.length < 3) continue;
                    const outN = faceOutward[fi], a0 = cleaned[0];
                    for (let i = 1; i < cleaned.length - 1; i++) {
                        const b0 = cleaned[i], c0 = cleaned[i + 1];
                        const ab = [b0[0]-a0[0], b0[1]-a0[1], b0[2]-a0[2]], ac = [c0[0]-a0[0], c0[1]-a0[1], c0[2]-a0[2]];
                        const dot = (ab[1]*ac[2]-ab[2]*ac[1])*outN[0] + (ab[2]*ac[0]-ab[0]*ac[2])*outN[1] + (ab[0]*ac[1]-ab[1]*ac[0])*outN[2];
                        if (dot >= 0) targetOutTris.push(a0, b0, c0); else targetOutTris.push(a0, c0, b0);
                        capTrisLocal++;
                    }
                }
            }
            return capTrisLocal;
        }

        function processRecs(recs) {
            const outTris = [];
            for (let i = 0; i < 6; i++) faceSegs[i].clear();
            orientFlips = 0;
            let totalInLocal = 0;
            for (const rec of recs) {
                const e = rec.entity;
                const meshNode = e._meshChild || e;
                if (!meshNode) continue;
                const wm = meshNode.getWorldTransform();
                let unitTris = [];
                if (rec.type === 'mesh-import') {
                    const pos = rec.meta && rec.meta.positions;
                    if (pos) {
                        const arr = (pos instanceof Float32Array) ? pos : Array.from(pos);
                        for (let i = 0; i < arr.length; i += 9) {
                            unitTris.push([arr[i], arr[i+1], arr[i+2]], [arr[i+3], arr[i+4], arr[i+5]], [arr[i+6], arr[i+7], arr[i+8]]);
                        }
                    }
                } else if (rec.type === 'building-box') unitTris = buildUnitBoxTris();
                else if (rec.type === 'building-cylinder') unitTris = buildUnitCylinderTris(48);

                for (let i = 0; i < unitTris.length; i += 3) {
                    const p0 = transformPoint(wm, unitTris[i]), p1 = transformPoint(wm, unitTris[i+1]), p2 = transformPoint(wm, unitTris[i+2]);
                    const seedN = triNormal(p0, p1, p2);
                    totalInLocal++;
                    const poly = clipTriangleAABBPoly(p0, p1, p2);
                    if (!poly.length) continue;
                    addFaceSegmentsFromPoly(poly);
                    const clipped = triangulatePoly(poly, seedN);
                    for (const v of clipped) outTris.push(v);
                }
            }
            const caps = buildLoopsAndTriangulate(outTris);
            return { tris: outTris, inCount: totalInLocal, capCount: caps, flips: orientFlips };
        }

        // 3. Process data
        const buildings = Array.from(registry.values()).filter(r => r.type === 'mesh-import' || r.type === 'building-box' || r.type === 'building-cylinder');
        if (!buildings.length) {
            console.warn('[STL] 해석공간 내에 내보낼 대상이 없습니다.');
            return;
        }

        const zip = new JSZip();

        // 3a. Export individual clipped buildings
        for (const rec of buildings) {
            const res = processRecs([rec]);
            if (res.tris.length > 0) {
                const buffer = writeBinarySTL(res.tris, `Building ${rec.id}`);
                const safeName = (rec.name || 'building').replace(/[^a-z0-9ㄱ-ㅎㅏ-ㅣ가-힣]/gi, '_');
                zip.file(`individual/building_${rec.id}_${safeName}.stl`, buffer);
            }
        }

        // 3b. Export unified clipped model
        const totalRes = processRecs(buildings);
        if (totalRes.tris.length > 0) {
            const buffer = writeBinarySTL(totalRes.tris, 'Unified Clipped STL');
            zip.file('clipped_total.stl', buffer);
            console.log(`[STL] 내보내기 완료: 입력=${totalRes.inCount}, 출력=${totalRes.tris.length/3} (캡=${totalRes.capCount}, 방향수정=${totalRes.flips})`);
        }

        // 4. Generate and download ZIP
        const blob = await zip.generateAsync({type: 'blob'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'preprocessed_data_stl.zip';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);

    } catch (err) {
        console.error('Export Clipped STL 실패:', err);
    }
}

/**
 * 통합 전처리 데이터 내보내기: ZIP 파일 내에 개별 STL, 통합 STL, 그리고 MeshPath가 업데이트된 JSON을 포함합니다.
 */
async function exportPreprocessedData(options) {
    try {
        const upAxis = (options && (options.upAxis === 'z' || options.upAxis === 'y')) ? options.upAxis : 'y';

        // 1. Find analysis space (prefer current selection)
        let analysis = null;
        try {
            const sid = data.get('selectedId');
            if (sid != null && registry.has(sid)) {
                const r = registry.get(sid);
                if (r && r.type === 'analysis-space') analysis = r;
            }
        } catch (_) {}
        if (!analysis) {
            for (const rec of registry.values()) {
                if (rec.type === 'analysis-space') {
                    analysis = rec;
                    break;
                }
            }
        }
        if (!analysis) {
            console.warn('[Preprocess] 분석 공간(해석공간)이 없습니다. 먼저 Analysis Space를 생성하세요.');
            return;
        }

        // 2. Compute current world-space AABB
        let aabbNow = null;
        try {
            aabbNow = getEntityWorldAabb(analysis.entity);
        } catch (_) {
            aabbNow = null;
        }
        const amin = (aabbNow && aabbNow.min) ? aabbNow.min : ((analysis.meta && Array.isArray(analysis.meta.min)) ? analysis.meta.min : [-50, 0, -50]);
        const amax = (aabbNow && aabbNow.max) ? aabbNow.max : ((analysis.meta && Array.isArray(analysis.meta.max)) ? analysis.meta.max : [50, 50, 50]);

        // Helpers for clipping against AABB (Duplicated for independence)
        const EPS = 1e-6;
        const planes = [
            {n: [1, 0, 0], d: amin[0]}, {n: [-1, 0, 0], d: -amax[0]},
            {n: [0, 1, 0], d: amin[1]}, {n: [0, -1, 0], d: -amax[1]},
            {n: [0, 0, 1], d: amin[2]}, {n: [0, 0, -1], d: -amax[2]}
        ];
        const inside = (nx, ny, nz, d, p) => (nx * p[0] + ny * p[1] + nz * p[2]) >= (d - EPS);
        const faceOutward = planes.map(pl => ([-pl.n[0], -pl.n[1], -pl.n[2]]));

        function intersect(p1, p2, nx, ny, nz, d) {
            const a = nx * p1[0] + ny * p1[1] + nz * p1[2] - d;
            const b = nx * p2[0] + ny * p2[1] + nz * p2[2] - d;
            const denom = (a - b);
            let t = (Math.abs(denom) < 1e-12) ? 0 : a / denom;
            if (t < 0) t = 0; else if (t > 1) t = 1;
            return [p1[0] + (p2[0] - p1[0]) * t, p1[1] + (p2[1] - p1[1]) * t, p1[2] + (p2[2] - p1[2]) * t];
        }

        function clipPolyWithPlane(poly, nx, ny, nz, d) {
            if (!poly.length) return poly;
            const out = [];
            for (let i = 0; i < poly.length; i++) {
                const cur = poly[i];
                const prev = poly[(i + poly.length - 1) % poly.length];
                const curIn = inside(nx, ny, nz, d, cur);
                const prevIn = inside(nx, ny, nz, d, prev);
                if (curIn) {
                    if (!prevIn) out.push(intersect(prev, cur, nx, ny, nz, d));
                    out.push(cur);
                } else if (prevIn) {
                    out.push(intersect(prev, cur, nx, ny, nz, d));
                }
            }
            return out;
        }

        const QEPS = 1e-5;
        const faceSegs = [new Map(), new Map(), new Map(), new Map(), new Map(), new Map()];
        const planeSignedDist = (pl, p) => (pl.n[0] * p[0] + pl.n[1] * p[1] + pl.n[2] * p[2] - pl.d);

        function faceProject(faceIdx, p) {
            switch (faceIdx) {
                case 0: case 1: return [p[2], p[1]]; // X faces -> (z,y)
                case 2: case 3: return [p[0], p[2]]; // Y faces -> (x,z)
                case 4: case 5: return [p[0], p[1]]; // Z faces -> (x,y)
                default: return [p[0], p[1]];
            }
        }

        function quant2(u, v) {
            return Math.round(u / QEPS) + "," + Math.round(v / QEPS);
        }

        function addFaceSegment(faceIdx, a, b) {
            const du = b[0] - a[0], dv = b[1] - a[1], dw = b[2] - a[2];
            if ((du * du + dv * dv + dw * dw) < 1e-16) return;
            const [ua, va] = faceProject(faceIdx, a);
            const [ub, vb] = faceProject(faceIdx, b);
            const ak = quant2(ua, va), bk = quant2(ub, vb);
            if (ak === bk) return;
            const key = ak < bk ? (ak + '|' + bk) : (bk + '|' + ak);
            const map = faceSegs[faceIdx];
            if (map.has(key)) map.delete(key); else map.set(key, {a, b, ak, bk});
        }

        function addFaceSegmentsFromPoly(poly) {
            if (!poly || poly.length < 2) return;
            const faceEPS = 1e-5;
            for (let i = 0; i < poly.length; i++) {
                const A = poly[i], B = poly[(i + 1) % poly.length];
                for (let fi = 0; fi < 6; fi++) {
                    const pl = planes[fi];
                    if (Math.abs(planeSignedDist(pl, A)) <= faceEPS && Math.abs(planeSignedDist(pl, B)) <= faceEPS) {
                        addFaceSegment(fi, A, B);
                    }
                }
            }
        }

        function clipTriangleAABBPoly(p0, p1, p2) {
            let poly = [p0, p1, p2];
            for (const pl of planes) {
                poly = clipPolyWithPlane(poly, pl.n[0], pl.n[1], pl.n[2], pl.d);
                if (poly.length === 0) break;
            }
            return poly;
        }

        let orientFlips = 0;
        function triNormal(a, b, c) {
            const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
            const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
            return [aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx];
        }

        function triangulatePoly(poly, seedN) {
            if (!poly || poly.length < 3) return [];
            const tris = [];
            const useSeed = !!seedN && (Math.hypot(seedN[0], seedN[1], seedN[2]) > 1e-20);
            for (let i = 1; i < poly.length - 1; i++) {
                const a = poly[0], b = poly[i], c = poly[i + 1];
                const n = triNormal(a, b, c);
                if (useSeed && (n[0] * seedN[0] + n[1] * seedN[1] + n[2] * seedN[2]) < 0) {
                    tris.push(a, c, b);
                    orientFlips++;
                } else {
                    tris.push(a, b, c);
                }
            }
            return tris;
        }

        function writeBinarySTL(tris, name = 'Clipped STL') {
            const triCount = Math.floor(tris.length / 3);
            const buffer = new ArrayBuffer(84 + 50 * triCount);
            const dv = new DataView(buffer);
            const enc = new TextEncoder();
            const h = enc.encode(name.substring(0, 80));
            const u8 = new Uint8Array(buffer, 0, 80);
            for (let i = 0; i < Math.min(80, h.length); i++) u8[i] = h[i];
            dv.setUint32(80, triCount, true);
            let off = 84;
            const mapV = (p) => (upAxis === 'z') ? [p[0], -p[2], p[1]] : p;
            const nrm = (a, b, c) => {
                const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
                const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
                let nx = ab[1] * ac[2] - ab[2] * ac[1], ny = ab[2] * ac[0] - ab[0] * ac[2], nz = ab[0] * ac[1] - ab[1] * ac[0];
                const len = Math.hypot(nx, ny, nz) || 1;
                return [nx / len, ny / len, nz / len];
            };
            for (let i = 0; i < triCount; i++) {
                const a0 = tris[i * 3 + 0], b0 = tris[i * 3 + 1], c0 = tris[i * 3 + 2];
                const n = nrm(a0, b0, c0);
                const a = mapV(a0), b = mapV(b0), c = mapV(c0), nm = mapV(n);
                dv.setFloat32(off + 0, nm[0], true); dv.setFloat32(off + 4, nm[1], true); dv.setFloat32(off + 8, nm[2], true);
                dv.setFloat32(off + 12, a[0], true); dv.setFloat32(off + 16, a[1], true); dv.setFloat32(off + 20, a[2], true);
                dv.setFloat32(off + 24, b[0], true); dv.setFloat32(off + 28, b[1], true); dv.setFloat32(off + 32, b[2], true);
                dv.setFloat32(off + 36, c[0], true); dv.setFloat32(off + 40, c[1], true); dv.setFloat32(off + 44, c[2], true);
                dv.setUint16(off + 48, 0, true); off += 50;
            }
            return buffer;
        }

        function buildUnitBoxTris() {
            const v = [[-0.5,-0.5,-0.5],[0.5,-0.5,-0.5],[0.5,0.5,-0.5],[-0.5,0.5,-0.5],[-0.5,-0.5,0.5],[0.5,-0.5,0.5],[0.5,0.5,0.5],[-0.5,0.5,0.5]];
            const t = [];
            t.push(v[0], v[3], v[2], v[0], v[2], v[1]); // back
            t.push(v[4], v[5], v[6], v[4], v[6], v[7]); // front
            t.push(v[0], v[3], v[7], v[0], v[7], v[4]); // left
            t.push(v[1], v[2], v[6], v[1], v[6], v[5]); // right
            t.push(v[3], v[7], v[6], v[3], v[6], v[2]); // top
            t.push(v[0], v[1], v[5], v[0], v[5], v[4]); // bottom
            return t;
        }

        function buildUnitCylinderTris(segments = 32) {
            const tris = [];
            const r = 0.5, y0 = -0.5, y1 = 0.5;
            for (let i = 0; i < segments; i++) {
                const t0 = (i / segments) * Math.PI * 2, t1 = ((i + 1) / segments) * Math.PI * 2;
                const x0 = Math.cos(t0) * r, z0 = Math.sin(t0) * r, x1 = Math.cos(t1) * r, z1 = Math.sin(t1) * r;
                tris.push([x0, y0, z0], [x1, y1, z1], [x1, y0, z1]);
                tris.push([x0, y0, z0], [x0, y1, z0], [x1, y1, z1]);
                tris.push([0, y0, 0], [x0, y0, z0], [x1, y0, z1]);
                tris.push([0, y1, 0], [x0, y1, z0], [x1, y1, z1]);
            }
            return tris;
        }

        const tmp = new pc.Vec3();
        function transformPoint(m, p) {
            tmp.set(p[0], p[1], p[2]);
            m.transformPoint(tmp, tmp);
            return [tmp.x, tmp.y, tmp.z];
        }

        function buildLoopsAndTriangulate(targetOutTris) {
            for (let fi = 0; fi < 6; fi++) {
                const segMap = faceSegs[fi];
                if (!segMap.size) continue;
                const adj = new Map(), keyToPoint = new Map(), unused = new Map();
                for (const {ak, bk, a, b} of segMap.values()) {
                    if (!adj.has(ak)) adj.set(ak, []); if (!adj.has(bk)) adj.set(bk, []);
                    adj.get(ak).push(bk); adj.get(bk).push(ak);
                    keyToPoint.set(ak, a); keyToPoint.set(bk, b);
                    if (!unused.has(ak)) unused.set(ak, new Set()); if (!unused.has(bk)) unused.set(bk, new Set());
                    unused.get(ak).add(bk); unused.get(bk).add(ak);
                }
                while (true) {
                    let first = null;
                    for (const [aK, nbrs] of unused.entries()) {
                        if (nbrs.size > 0) {
                            const bK = nbrs.values().next().value;
                            nbrs.delete(bK); unused.get(bK).delete(aK);
                            first = [aK, bK]; break;
                        }
                    }
                    if (!first) break;
                    const startKey = first[0], loopKeys = [startKey, first[1]];
                    let curr = first[1], guard = 0;
                    while (guard++ < 10000) {
                        const nbrs = unused.get(curr);
                        if (!nbrs || nbrs.size === 0) break;
                        let chosen = null;
                        for (const nkey of nbrs) { if (nkey !== loopKeys[loopKeys.length - 2]) { chosen = nkey; break; } }
                        if (!chosen) { if (loopKeys[0] !== curr) chosen = nbrs.values().next().value; else break; }
                        nbrs.delete(chosen); unused.get(chosen).delete(curr);
                        loopKeys.push(chosen); curr = chosen;
                        if (curr === startKey) break;
                    }
                    const pts = [];
                    for (const k of loopKeys) { const p = keyToPoint.get(k); if (p) pts.push(p); }
                    const cleaned = [];
                    for (let i = 0; i < pts.length; i++) {
                        const a = pts[i], b = pts[(i + 1) % pts.length];
                        if (Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]) > 1e-8) cleaned.push(a);
                    }
                    if (cleaned.length < 3) continue;
                    const outN = faceOutward[fi], a0 = cleaned[0];
                    for (let i = 1; i < cleaned.length - 1; i++) {
                        const b0 = cleaned[i], c0 = cleaned[i + 1];
                        const ab = [b0[0]-a0[0], b0[1]-a0[1], b0[2]-a0[2]], ac = [c0[0]-a0[0], c0[1]-a0[1], c0[2]-a0[2]];
                        const dot = (ab[1]*ac[2]-ab[2]*ac[1])*outN[0] + (ab[2]*ac[0]-ab[0]*ac[2])*outN[1] + (ab[0]*ac[1]-ab[1]*ac[0])*outN[2];
                        if (dot >= 0) targetOutTris.push(a0, b0, c0); else targetOutTris.push(a0, c0, b0);
                    }
                }
            }
        }

        function processRecs(recs) {
            const outTris = [];
            for (let i = 0; i < 6; i++) faceSegs[i].clear();
            orientFlips = 0;
            for (const rec of recs) {
                const e = rec.entity;
                const meshNode = e._meshChild || e;
                if (!meshNode) continue;
                const wm = meshNode.getWorldTransform();
                let unitTris = [];
                if (rec.type === 'mesh-import') {
                    const pos = rec.meta && rec.meta.positions;
                    if (pos) {
                        const arr = (pos instanceof Float32Array) ? pos : Array.from(pos);
                        for (let i = 0; i < arr.length; i += 9) {
                            unitTris.push([arr[i], arr[i+1], arr[i+2]], [arr[i+3], arr[i+4], arr[i+5]], [arr[i+6], arr[i+7], arr[i+8]]);
                        }
                    }
                } else if (rec.type === 'building-box') unitTris = buildUnitBoxTris();
                else if (rec.type === 'building-cylinder') unitTris = buildUnitCylinderTris(48);

                for (let i = 0; i < unitTris.length; i += 3) {
                    const p0 = transformPoint(wm, unitTris[i]), p1 = transformPoint(wm, unitTris[i+1]), p2 = transformPoint(wm, unitTris[i+2]);
                    const seedN = triNormal(p0, p1, p2);
                    const poly = clipTriangleAABBPoly(p0, p1, p2);
                    if (!poly.length) continue;
                    addFaceSegmentsFromPoly(poly);
                    const clipped = triangulatePoly(poly, seedN);
                    for (const v of clipped) outTris.push(v);
                }
            }
            buildLoopsAndTriangulate(outTris);
            return { tris: outTris };
        }

        // 3. Process data
        const buildings = Array.from(registry.values()).filter(r => r.type === 'mesh-import' || r.type === 'building-box' || r.type === 'building-cylinder');
        if (!buildings.length) {
            console.warn('[Preprocess] 해석공간 내에 내보낼 대상이 없습니다.');
            return;
        }

        const zip = new JSZip();
        const meshPathMap = new Map();

        // 3a. Export individual clipped buildings and build meshPathMap
        for (const rec of buildings) {
            // Skip special visualization meshes
            if (rec.type === 'mesh-import' && rec.meta && (rec.meta.kind === 'wind-streamlines' || rec.meta.kind === 'scalar-slice' || rec.meta.kind === 'y-slice')) continue;
            
            const res = processRecs([rec]);
            if (res.tris.length > 0) {
                const safeName = (rec.name || 'building').replace(/[^a-z0-9ㄱ-ㅎㅏ-ㅣ가-힣]/gi, '_');
                const relPath = `individual/building_${rec.id}_${safeName}.stl`;
                const buffer = writeBinarySTL(res.tris, `Building ${rec.id} ${rec.name || ''}`);
                zip.file(relPath, buffer);
                meshPathMap.set(rec.id, relPath);
            }
        }

        // 3b. Export unified clipped model
        const totalRes = processRecs(buildings);
        if (totalRes.tris.length > 0) {
            const buffer = writeBinarySTL(totalRes.tris, 'Unified Clipped STL');
            zip.file('clipped_total.stl', buffer);
        }

        // 3c. Export JSON with updated MeshPaths
        const doc = buildTofuPreprocessingJson({ meshPathMap });
        zip.file('tofu-pre.json', JSON.stringify(doc, null, 2));

        // 4. Generate and download ZIP
        const blob = await zip.generateAsync({type: 'blob'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'preprocessed_data.zip';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        console.log('[Preprocess] 전처리 데이터 내보내기 완료 (JSON + STL)');

    } catch (err) {
        console.error('Export Preprocessed Data 실패:', err);
    }
}

// ---- Export: Clipped by a single plane (Analysis Plane / Slice) ----
function exportPlaneClippedSTL() {
    try {
        // 1) Find a plane source: prefer currently selected scalar-slice or y-slice
        /** @type {any} */ let planeRec = null;
        const sid = data.get('selectedId');
        if (sid != null && registry.has(sid)) {
            const r = registry.get(sid);
            if (r && r.type === 'mesh-import' && r.meta && (r.meta.kind === 'scalar-slice' || r.meta.kind === 'y-slice')) planeRec = r;
        }
        if (!planeRec) {
            for (const r of registry.values()) {
                if (r && r.type === 'mesh-import' && r.meta && (r.meta.kind === 'scalar-slice' || r.meta.kind === 'y-slice')) {
                    planeRec = r;
                    break;
                }
            }
        }
        if (!planeRec) {
            console.warn('[STL][Plane] 사용할 해석 평면(스칼라 슬라이스 또는 Y‑슬라이스)을 찾지 못했습니다.');
            return;
        }

        // 2) Build plane in world space: n · x >= d (we will pick the side that contains the analysis-space center if available)
        /** @type {number[]} */ let n = [0, 1, 0];
        /** @type {number} */ let d = 0;
        const EPS = 1e-6;
        const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
        const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        const norm = (v) => {
            const L = Math.hypot(v[0], v[1], v[2]) || 1;
            return [v[0] / L, v[1] / L, v[2] / L];
        };
        if (planeRec.meta.kind === 'y-slice') {
            // Horizontal plane at Y = y0
            let y0;
            if (planeRec.meta && planeRec.meta.bounds && planeRec.meta.bounds.min && planeRec.meta.bounds.max) {
                y0 = (Number(planeRec.meta.bounds.min[1]) + Number(planeRec.meta.bounds.max[1])) * 0.5;
            } else if (planeRec.meta && planeRec.meta.field && planeRec.meta.heightT != null) {
                const f = planeRec.meta.field;
                const t = planeRec.meta.heightT;
                const ny = f.dims?.[1] || 2;
                const sy = f.spacing?.[1] || 1;
                const oy = f.origin?.[1] || 0;
                y0 = oy + t * ((ny - 1) * sy);
            } else {
                // fallback to entity world Y
                const e = planeRec.entity;
                const p = e.getPosition();
                y0 = p.y;
            }
            n = [0, 1, 0];
            d = y0;
        } else {
            // scalar-slice: try handle positions first
            let p0 = null, p1 = null, p2 = null;
            try {
                const hids = planeRec.meta && planeRec.meta.handles;
                if (hids && hids.length >= 3) {
                    const e0 = registry.get(hids[0])?.entity;
                    const e1 = registry.get(hids[1])?.entity;
                    const e2 = registry.get(hids[2])?.entity;
                    if (e0 && e1 && e2) {
                        const P0 = e0.getPosition(), P1 = e1.getPosition(), P2 = e2.getPosition();
                        p0 = [P0.x, P0.y, P0.z];
                        p1 = [P1.x, P1.y, P1.z];
                        p2 = [P2.x, P2.y, P2.z];
                    }
                }
            } catch (_) {
            }
            if (!p0 || !p1 || !p2) {
                const arr = planeRec.meta && planeRec.meta._planePoints; // might already be in world coordinates
                if (Array.isArray(arr) && arr.length >= 3) {
                    p0 = arr[0];
                    p1 = arr[1];
                    p2 = arr[2];
                }
            }
            if (!p0 || !p1 || !p2) {
                console.warn('[STL][Plane] 평면 정의 점을 찾지 못했습니다.');
                return;
            }
            const u = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
            const v = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
            n = norm(cross(u, v));
            d = dot(n, p0);
        }

        // Choose kept side based on Analysis Space center if present
        let sign = 1;
        try {
            let analysis = null;
            for (const r of registry.values()) {
                if (r.type === 'analysis-space') {
                    analysis = r;
                    break;
                }
            }
            if (analysis && analysis.meta && analysis.meta.min && analysis.meta.max) {
                const amin = analysis.meta.min, amax = analysis.meta.max;
                const c = [(amin[0] + amax[0]) * 0.5, (amin[1] + amax[1]) * 0.5, (amin[2] + amax[2]) * 0.5];
                const s = dot(n, c) - d;
                sign = (s >= 0) ? 1 : -1;
            }
        } catch (_) {
        }

        const inside = (p) => (sign * (n[0] * p[0] + n[1] * p[1] + n[2] * p[2] - d)) >= -EPS;
        const intersect = (p1, p2) => {
            const a = n[0] * p1[0] + n[1] * p1[1] + n[2] * p1[2] - d;
            const b = n[0] * p2[0] + n[1] * p2[1] + n[2] * p2[2] - d;
            const denom = (a - b);
            let t;
            if (Math.abs(denom) < 1e-12) t = 0; else t = a / denom;
            if (t < 0) t = 0; else if (t > 1) t = 1;
            return [p1[0] + (p2[0] - p1[0]) * t, p1[1] + (p2[1] - p1[1]) * t, p1[2] + (p2[2] - p1[2]) * t];
        };
        const clipPoly = (poly) => {
            if (!poly.length) return poly;
            const out = [];
            for (let i = 0; i < poly.length; i++) {
                const cur = poly[i];
                const prev = poly[(i + poly.length - 1) % poly.length];
                const curIn = inside(cur);
                const prevIn = inside(prev);
                if (curIn) {
                    if (!prevIn) out.push(intersect(prev, cur));
                    out.push(cur);
                } else if (prevIn) {
                    out.push(intersect(prev, cur));
                }
            }
            return out;
        };

        // STL writer
        function writeBinarySTL(tris) {
            const triCount = Math.floor(tris.length / 3);
            const buffer = new ArrayBuffer(84 + 50 * triCount);
            const dv = new DataView(buffer);
            const enc = new TextEncoder();
            const h = enc.encode('Plane Clipped STL from SimEdit9');
            const u8 = new Uint8Array(buffer, 0, 80);
            for (let i = 0; i < Math.min(80, h.length); i++) u8[i] = h[i];
            dv.setUint32(80, triCount, true);
            let off = 84;
            const nrm = (a, b, c) => {
                const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
                const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
                let nx = ab[1] * ac[2] - ab[2] * ac[1], ny = ab[2] * ac[0] - ab[0] * ac[2],
                    nz = ab[0] * ac[1] - ab[1] * ac[0];
                const L = Math.hypot(nx, ny, nz) || 1;
                return [nx / L, ny / L, nz / L];
            };
            for (let i = 0; i < triCount; i++) {
                const a = tris[i * 3], b = tris[i * 3 + 1], c = tris[i * 3 + 2];
                const nn = nrm(a, b, c);
                dv.setFloat32(off + 0, nn[0], true);
                dv.setFloat32(off + 4, nn[1], true);
                dv.setFloat32(off + 8, nn[2], true);
                dv.setFloat32(off + 12, a[0], true);
                dv.setFloat32(off + 16, a[1], true);
                dv.setFloat32(off + 20, a[2], true);
                dv.setFloat32(off + 24, b[0], true);
                dv.setFloat32(off + 28, b[1], true);
                dv.setFloat32(off + 32, b[2], true);
                dv.setFloat32(off + 36, c[0], true);
                dv.setFloat32(off + 40, c[1], true);
                dv.setFloat32(off + 44, c[2], true);
                dv.setUint16(off + 48, 0, true);
                off += 50;
            }
            return buffer;
        }

        // Enumerate triangles for all relevant scene meshes (similar to AABB exporter)
        function buildUnitBoxTris() {
            const v = [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5], [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]];
            const faces = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 4, 7, 3], [1, 5, 6, 2], [3, 2, 6, 7], [0, 1, 5, 4]];
            const tris = [];
            for (const f of faces) {
                const a = v[f[0]], b = v[f[1]], c = v[f[2]], d = v[f[3]];
                tris.push(a, b, c, a, c, d);
            }
            return tris;
        }

        function buildUnitCylinderTris(segments = 48) {
            const tris = [];
            const r = 0.5, y0 = -0.5, y1 = 0.5;
            for (let i = 0; i < segments; i++) {
                const t0 = i / segments * 2 * Math.PI, t1 = (i + 1) / segments * 2 * Math.PI;
                const x0 = Math.cos(t0) * r, z0 = Math.sin(t0) * r, x1 = Math.cos(t1) * r, z1 = Math.sin(t1) * r;
                tris.push([x0, y0, z0], [x1, y0, z1], [x1, y1, z1]);
                tris.push([x0, y0, z0], [x1, y1, z1], [x0, y1, z0]);
                tris.push([0, y0, 0], [x1, y0, z1], [x0, y0, z0]);
                tris.push([0, y1, 0], [x0, y1, z0], [x1, y1, z1]);
            }
            return tris;
        }

        const outTris = [];
        let totalIn = 0;
        const tmp = new pc.Vec3();
        const transformPoint = (m, p) => {
            tmp.set(p[0], p[1], p[2]);
            m.transformPoint(tmp, tmp);
            return [tmp.x, tmp.y, tmp.z];
        };
        const clipTri = (p0, p1, p2) => {
            let poly = [p0, p1, p2];
            poly = clipPoly(poly);
            if (poly.length < 3) return [];
            const tris = [];
            for (let i = 1; i < poly.length - 1; i++) {
                const a = poly[0], b = poly[i], c = poly[i + 1];
                const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
                const cx = ab[1] * ac[2] - ab[2] * ac[1], cy = ab[2] * ac[0] - ab[0] * ac[2],
                    cz = ab[0] * ac[1] - ab[1] * ac[0];
                if (Math.hypot(cx, cy, cz) > 1e-12) tris.push(a, b, c);
            }
            return tris;
        };
        for (const rec of registry.values()) {
            if (rec.type !== 'mesh-import' && rec.type !== 'building-box' && rec.type !== 'building-cylinder') continue;
            const e = rec.entity;
            /** @type {any} */ const meshNode = /** @type {any} */ (e._meshChild || e);
            if (!meshNode) continue;
            const wm = meshNode.getWorldTransform();
            if (rec.type === 'mesh-import') {
                const pos = rec.meta && rec.meta.positions;
                if (!pos || !pos.length) continue;
                const arr = (pos instanceof Float32Array) ? pos : (Array.isArray(pos) ? pos : Array.from(pos));
                for (let i = 0; i < arr.length; i += 9) {
                    const p0 = transformPoint(wm, [arr[i], arr[i + 1], arr[i + 2]]);
                    const p1 = transformPoint(wm, [arr[i + 3], arr[i + 4], arr[i + 5]]);
                    const p2 = transformPoint(wm, [arr[i + 6], arr[i + 7], arr[i + 8]]);
                    totalIn++;
                    const clipped = clipTri(p0, p1, p2);
                    for (const vtx of clipped) outTris.push(vtx);
                }
            } else if (rec.type === 'building-box') {
                const unit = buildUnitBoxTris();
                for (let i = 0; i < unit.length; i += 3) {
                    const p0 = transformPoint(wm, unit[i]);
                    const p1 = transformPoint(wm, unit[i + 1]);
                    const p2 = transformPoint(wm, unit[i + 2]);
                    totalIn++;
                    const clipped = clipTri(p0, p1, p2);
                    for (const vtx of clipped) outTris.push(vtx);
                }
            } else if (rec.type === 'building-cylinder') {
                const unit = buildUnitCylinderTris(48);
                for (let i = 0; i < unit.length; i += 3) {
                    const p0 = transformPoint(wm, unit[i]);
                    const p1 = transformPoint(wm, unit[i + 1]);
                    const p2 = transformPoint(wm, unit[i + 2]);
                    totalIn++;
                    const clipped = clipTri(p0, p1, p2);
                    for (const vtx of clipped) outTris.push(vtx);
                }
            }
        }

        if (!outTris.length) {
            console.warn('[STL][Plane] 평면과 교차하는 삼각형이 없습니다.');
            return;
        }
        const buffer = writeBinarySTL(outTris);
        const blob = new Blob([buffer], {type: 'model/stl'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'clipped_plane.stl';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        console.log(`[STL][Plane] 내보내기 완료: 입력 삼각형=${totalIn}, 출력 삼각형=${outTris.length / 3}`);
    } catch (err) {
        console.error('Export Plane‑Clipped STL 실패:', err);
    }
}

async function exportToTofuJson() {
    try {
        const doc = buildTofuPreprocessingJson();
        const text = JSON.stringify(doc, null, 2);
        // Prefer Electron dialog if available
        try {
            const anyWin = /** @type {any} */(window);
            if (anyWin?.se9?.saveJson) {
                const filePath = await anyWin.se9.saveJson('tofu-pre.json', text);
                if (filePath) console.log('Tofu JSON 저장됨:', filePath);
                return;
            }
        } catch (_) {
        }
        // Browser: try File System Access API
        try {
            const anyWin = /** @type {any} */(window);
            if (typeof anyWin.showSaveFilePicker === 'function') {
                const handle = await anyWin.showSaveFilePicker({
                    suggestedName: 'tofu-pre.json',
                    types: [{description: 'Tofu Preprocessing JSON', accept: {'application/json': ['.json']}}]
                });
                const writable = await handle.createWritable();
                await writable.write(text);
                await writable.close();
                console.log('Tofu JSON 저장 완료 (FS Access)');
                return;
            }
        } catch (err) {
            console.warn('File System Access API 저장 실패, 다운로드로 대체:', err);
        }
        // Fallback: download via anchor
        const blob = new Blob([text], {type: 'application/json'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'tofu-pre.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    } catch (err) {
        console.error('Tofu JSON 내보내기 실패:', err);
    }
}

function serializeScene() {
    try {
        const objects = Array.from(registry.values()).map(makeDescriptorFromRecord);
        // Prepare a JSON‑safe copy: convert TypedArrays to plain Arrays for portability
        const toArrayIfTA = (v) => {
            try {
                if (!v) return v;
                if (Array.isArray(v)) return v;
                if (typeof v.length === 'number' && v.buffer instanceof ArrayBuffer && typeof v.BYTES_PER_ELEMENT === 'number') {
                    return Array.from(v);
                }
                return v;
            } catch {
                return v;
            }
        };
        const objectsJson = objects.map(o => {
            if (o && o.type === 'mesh-import' && o.meta) {
                const m = {...o.meta};
                m.positions = toArrayIfTA(m.positions);
                m.normals = toArrayIfTA(m.normals);
                return {...o, meta: m};
            }
            return o;
        });
        // Camera snapshot (position + euler)
        let cam = null;
        try {
            const p = camera.getPosition();
            const a = camera.getEulerAngles();
            cam = {position: [p.x, p.y, p.z], euler: [a.x, a.y, a.z]};
        } catch (_) {
        }
        return {
            format: 'SimEdit9-Scene',
            version: 1,
            savedAt: new Date().toISOString(),
            camera: cam,
            objects: objectsJson
        };
    } catch (err) {
        console.error('씬 직렬화 실패:', err);
        return {format: 'SimEdit9-Scene', version: 1, objects: []};
    }
}

/**
 * @param {any} json
 */
function loadSceneFromJSON(json) {
    try {
        const payload = (typeof json === 'string') ? JSON.parse(json) : json;
        if (!payload || !Array.isArray(payload.objects)) {
            throw new Error('잘못된 씬 포맷');
        }

        clearScene();
        for (const desc of payload.objects) {
            try {
                addRecordFromDescriptor(desc);
            } catch (e) {
                console.error('객체 복원 실패:', e);
            }
        }
        // Restore camera if present
        try {
            if (payload.camera && Array.isArray(payload.camera.position) && Array.isArray(payload.camera.euler)) {
                const p = payload.camera.position;
                const a = payload.camera.euler;
                camera.setLocalPosition(p[0], p[1], p[2]);
                camera.setLocalEulerAngles(a[0], a[1], a[2]);
            } else {
                // Fallback: frame the scene or grid
                api.resetCameraView && api.resetCameraView();
            }
        } catch (_) {
            try {
                api.resetCameraView && api.resetCameraView();
            } catch (_) {
            }
        }
        refreshObjects();
    } catch (err) {
        console.error('씬 불러오기 실패:', err);
    }
}

async function saveSceneToFile() {
    const dataObj = serializeScene();
    const text = JSON.stringify(dataObj, null, 2);
    // Prefer Electron dialog if available
    try {
        const anyWin = /** @type {any} */(window);
        if (anyWin?.se9?.saveJson) {
            const filePath = await anyWin.se9.saveJson('scene.se9.json', text);
            if (filePath) console.log('씬 저장됨:', filePath);
            return;
        }
    } catch (_) {
    }
    // Browser: try File System Access API
    try {
        const anyWin = /** @type {any} */(window);
        if (typeof anyWin.showSaveFilePicker === 'function') {
            const handle = await anyWin.showSaveFilePicker({
                suggestedName: 'scene.se9.json',
                types: [{description: 'SimEdit9 Scene', accept: {'application/json': ['.json']}}]
            });
            const writable = await handle.createWritable();
            await writable.write(text);
            await writable.close();
            console.log('씬 저장 완료 (FS Access)');
            return;
        }
    } catch (err) {
        console.warn('File System Access API 저장 실패, 다운로드로 대체:', err);
    }
    // Fallback: download via anchor
    try {
        const blob = new Blob([text], {type: 'application/json'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'scene.se9.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    } catch (err) {
        console.error('다운로드 저장 실패:', err);
    }
}

async function loadSceneFromFile() {
    // Prefer Electron dialog
    try {
        const anyWin = /** @type {any} */(window);
        if (anyWin?.se9?.openJson) {
            const res = await anyWin.se9.openJson();
            if (res && res.data) {
                loadSceneFromJSON(res.data);
            }
            return;
        }
    } catch (_) {
    }
    // Browser: try File System Access API
    try {
        const anyWin = /** @type {any} */(window);
        if (typeof anyWin.showOpenFilePicker === 'function') {
            const handles = await anyWin.showOpenFilePicker({
                multiple: false,
                types: [{description: 'SimEdit9 Scene', accept: {'application/json': ['.json']}}]
            });
            if (handles && handles.length) {
                const file = await handles[0].getFile();
                const text = await file.text();
                loadSceneFromJSON(text);
                return;
            }
        }
    } catch (err) {
        console.warn('File System Access API 열기 실패, input으로 대체:', err);
    }
    // Fallback: hidden file input
    return new Promise((resolve) => {
        try {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,.se9.json,application/json';
            input.multiple = false;
            input.onchange = async () => {
                try {
                    const file = input.files && input.files[0];
                    if (file) {
                        const text = await file.text();
                        loadSceneFromJSON(text);
                    }
                } catch (e) {
                    console.error('파일 열기 실패:', e);
                } finally {
                    resolve();
                }
            };
            input.click();
        } catch (_) {
            resolve();
        }
    });
}

api.initializeScene = () => {
    const had = registry.size > 0;
    const snapshot = had ? Array.from(registry.values()).map(makeDescriptorFromRecord) : [];
    clearScene();
    history.commit({
        label: '씬 초기화',
        undo: () => {
            clearScene();
            for (const d of snapshot) addRecordFromDescriptor(d);
            refreshObjects();
            try {
                api.resetCameraView();
            } catch (_) {
            }
        },
        redo: () => {
            clearScene();
            refreshObjects();
            try {
                api.resetCameraView();
            } catch (_) {
            }
        }
    });
    try {
        api.resetCameraView();
    } catch (_) {
    }
};

api.saveScene = () => {
    return saveSceneToFile();
};
api.loadScene = () => {
    return loadSceneFromFile();
};

// -------- Camera framing helpers & public API --------
/**
 * Compute world-space AABB for a renderable entity (root or its mesh child).
 * @param {pc.Entity} entity
 * @returns {{ min:number[], max:number[] }|null}
 */
function getEntityWorldAabb(entity) {
    try {
        /** @type {any} */ const eAny = /** @type {any} */ (entity);
        /** @type {any} */ const target = /** @type {any} */ (eAny.render ? eAny : eAny._meshChild);
        if (!target || !target.render || !target.render.meshInstances || !target.render.meshInstances.length) return null;
        let minx = +Infinity, miny = +Infinity, minz = +Infinity;
        let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
        for (const mi of target.render.meshInstances) {
            const aabb = mi.aabb;
            if (!aabb) continue;
            const mn = aabb.getMin();
            const mx = aabb.getMax();
            if (!mn || !mx) continue;
            if (mn.x < minx) minx = mn.x;
            if (mn.y < miny) miny = mn.y;
            if (mn.z < minz) minz = mn.z;
            if (mx.x > maxx) maxx = mx.x;
            if (mx.y > maxy) maxy = mx.y;
            if (mx.z > maxz) maxz = mx.z;
        }
        if (!isFinite(minx) || !isFinite(maxx)) return null;
        return {min: [minx, miny, minz], max: [maxx, maxy, maxz]};
    } catch (_) {
        return null;
    }
}

/**
 * Compute world-space AABB for the whole scene based on registry contents.
 * @returns {{ min:number[], max:number[] }|null}
 */
function getSceneWorldAabb() {
    let minx = +Infinity, miny = +Infinity, minz = +Infinity;
    let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    for (const rec of registry.values()) {
        const aabb = getEntityWorldAabb(rec.entity);
        if (!aabb) continue;
        const mn = aabb.min, mx = aabb.max;
        if (mn[0] < minx) minx = mn[0];
        if (mn[1] < miny) miny = mn[1];
        if (mn[2] < minz) minz = mn[2];
        if (mx[0] > maxx) maxx = mx[0];
        if (mx[1] > maxy) maxy = mx[1];
        if (mx[2] > maxz) maxz = mx[2];
    }
    if (!isFinite(minx) || !isFinite(maxx)) return null;
    return {min: [minx, miny, minz], max: [maxx, maxy, maxz]};
}

/**
 * Given an AABB, compute a reasonable camera start position and focus such that the bounds fit the view.
 * @param {{min:number[], max:number[]}} aabb
 * @param {{ useCurrentView?: boolean, pad?: number }} [opts]
 * @returns {{ focus: pc.Vec3, position: pc.Vec3 }}
 */
function makeCameraFrameForAabb(aabb, opts = {}) {
    const cam = camera.camera;
    const horizontalFov = !!cam.horizontalFov;
    const aspect = cam.aspectRatio || 1;
    const fovDeg = cam.fov || 45;
    const fovRad = fovDeg * pc.math.DEG_TO_RAD;
    const pad = (typeof opts.pad === 'number' && isFinite(opts.pad)) ? Math.max(1, opts.pad) : 1.2;

    const cx = (aabb.min[0] + aabb.max[0]) * 0.5;
    const cy = (aabb.min[1] + aabb.max[1]) * 0.5;
    const cz = (aabb.min[2] + aabb.max[2]) * 0.5;
    const ex = (aabb.max[0] - aabb.min[0]) * 0.5;
    const ey = (aabb.max[1] - aabb.min[1]) * 0.5;
    const ez = (aabb.max[2] - aabb.min[2]) * 0.5;
    const focus = new pc.Vec3(cx, cy, cz);

    let dist = 1;
    if (horizontalFov) {
        const halfHFov = fovRad * 0.5;
        const needW = ex; // half width along X (approx)
        const needH = Math.max(ey, ez); // vertical extent approx (Y or Z)
        const dByW = needW / Math.tan(halfHFov);
        const dByH = (needH * aspect) / Math.tan(halfHFov);
        dist = Math.max(dByW, dByH) * pad;
    } else {
        const halfVFov = fovRad * 0.5;
        const needH = ey; // half height in Y
        const needW = Math.max(ex, ez); // horizontal extent approx (X or Z)
        const dByH = needH / Math.tan(halfVFov);
        const dByW = (needW / aspect) / Math.tan(halfVFov);
        dist = Math.max(dByH, dByW) * pad;
    }
    if (!isFinite(dist) || dist <= 0) dist = 1;

    let position = new pc.Vec3();
    if (opts.useCurrentView) {
        // keep current view direction, only adjust distance
        position.copy(camera.forward).mulScalar(-dist).add(focus);
    } else {
        // pleasant diagonal angle from above
        const dir = new pc.Vec3(1, 0.9, 1).normalize();
        position.copy(dir).mulScalar(dist).add(focus);
    }
    return {focus, position};
}

/** Reset camera to frame the whole scene; if empty, use grid size as fallback. */
api.resetCameraView = () => {
    try {
        try {
            console.log('[CAM][API] resetCameraView 호출');
        } catch (_) {
        }
        let aabb = getSceneWorldAabb();
        if (!aabb) {
            // Fallback to grid: use current grid size centered at origin
            const s = gridEntity.getLocalScale();
            const half = Math.max(s.x, s.z) * 0.5;
            aabb = {min: [-half, -0.01, -half], max: [half, 0.01, half]};
        }
        try {
            console.log('[CAM][API] reset aabb =', aabb);
        } catch (_) {
        }
        const {focus, position} = makeCameraFrameForAabb(aabb, {useCurrentView: false, pad: 1.25});
        try {
            console.log('[CAM][API] reset target → focus=', {
                x: focus.x,
                y: focus.y,
                z: focus.z
            }, ' position=', {x: position.x, y: position.y, z: position.z});
        } catch (_) {
        }
        cc.reset(focus, position);
    } catch (err) {
        console.error('카메라 초기화 실패:', err);
    }
};

/** Focus camera to frame the currently selected object. If nothing is selected, frames the scene. */
api.focusSelectedObject = () => {
    try {
        try {
            console.log('[CAM][API] focusSelectedObject 호출');
        } catch (_) {
        }
        const sid = data.get('selectedId');
        let aabb = null;
        if (sid != null && registry.has(sid)) {
            const rec = registry.get(sid);
            aabb = getEntityWorldAabb(rec.entity);
        }
        if (!aabb) {
            aabb = getSceneWorldAabb();
        }
        if (!aabb) {
            // fallback to origin/grid if absolutely nothing
            const s = gridEntity.getLocalScale();
            const half = Math.max(s.x, s.z) * 0.5;
            aabb = {min: [-half, -0.01, -half], max: [half, 0.01, half]};
        }
        try {
            console.log('[CAM][API] focus aabb =', aabb, ' selectedId=', sid);
        } catch (_) {
        }
        const {focus, position} = makeCameraFrameForAabb(aabb, {useCurrentView: true, pad: 1.2});
        try {
            console.log('[CAM][API] focus target → focus=', {
                x: focus.x,
                y: focus.y,
                z: focus.z
            }, ' position=', {x: position.x, y: position.y, z: position.z});
        } catch (_) {
        }
        cc.reset(focus, position);
    } catch (err) {
        console.error('객체 포커스 실패:', err);
    }
};

// Ensure camera starts at the initialized position on first page load
// Defer to the first frame so all scene entities/layers are ready
try {
    app.once('update', () => {
        try {
            console.log('[CAM][INIT] First-frame resetCameraView');
        } catch (_) {
        }
        try {
            api.resetCameraView && api.resetCameraView();
        } catch (e) {
            console.error('초기 카메라 리셋 실패:', e);
        }
    });
} catch (_) { /* ignore */
}

// Listen for native app menu commands (Electron)
try {
    const anyWin = /** @type {any} */ (window);
    if (anyWin.se9 && typeof anyWin.se9.onCommand === 'function') {
        anyWin.se9.onCommand((cmd) => {
            try {
                console.log('[CAM][IPC] editor:command 수신:', cmd);
            } catch (_) {
            }
            switch (cmd) {
                case 'view:resetCamera':
                    try {
                        api.resetCameraView();
                    } catch (_) {
                    }
                    break;
                case 'view:focusSelected':
                    try {
                        api.focusSelectedObject();
                    } catch (_) {
                    }
                    break;
            }
        });
    }
} catch (_) { /* ignore */
}

// -------- Mesh split (Web Worker) integration --------
let __currentWorker = null;
api.cancelLongOp = () => {
    try {
        __currentWorker && __currentWorker.postMessage({cmd: 'cancel'});
    } catch (_) {
    }
};
/**
 * Split currently selected imported mesh into connected components using a Web Worker.
 * @param {{ epsilon?: number, minTriangles?: number, keepOriginal?: boolean, namePrefix?: string }} options
 * @param {{ onProgress?: (p:number, phase?:string)=>void, onCancelable?: (fn:()=>void)=>void, onDone?: (parts:any[])=>void, onError?: (msg:string)=>void }} hooks
 */
api.splitSelectedMesh = (options = {}, hooks = {}) => {
    const sid = data.get('selectedId');
    if (sid == null) {
        hooks.onError && hooks.onError('선택된 오브젝트가 없습니다.');
        return;
    }
    const rec = registry.get(sid);
    if (!rec || rec.type !== 'mesh-import') {
        hooks.onError && hooks.onError('선택된 항목이 가져온 메시가 아닙니다.');
        return;
    }

    const bounds = rec.meta && rec.meta.bounds;
    const diag = bounds ? Math.hypot(
        (bounds.max[0] - bounds.min[0]),
        (bounds.max[1] - bounds.min[1]),
        (bounds.max[2] - bounds.min[2])
    ) : 1;
    const epsilon = (typeof options.epsilon === 'number' && isFinite(options.epsilon) && options.epsilon > 0)
        ? options.epsilon : (Math.max(1e-9, diag * 1e-6));
    const minTriangles = (options.minTriangles | 0) > 0 ? (options.minTriangles | 0) : 10;
    const keepOriginal = !!options.keepOriginal;
    const namePrefix = (typeof options.namePrefix === 'string' ? options.namePrefix : '').trim();

    // Typed views (transferable). Stored meta may be JS arrays.
    let pos = rec.meta.positions;
    let nor = rec.meta.normals;
    const posTA = (pos instanceof Float32Array) ? pos : new Float32Array(pos);
    const norTA = (nor && nor instanceof Float32Array) ? nor : (nor && nor.length ? new Float32Array(nor) : null);

    try {
        const worker = new Worker(new URL('./workers/split-worker.mjs', import.meta.url), {type: 'module'});
        __currentWorker = worker;
        hooks.onCancelable && hooks.onCancelable(() => {
            try {
                worker.postMessage({cmd: 'cancel'});
            } catch (_) {
            }
        });
        worker.onmessage = (ev) => {
            const msg = ev.data || {};
            if (msg.type === 'progress') {
                hooks.onProgress && hooks.onProgress(Math.max(0, Math.min(1, msg.value || 0)), msg.phase || '');
            } else if (msg.type === 'canceled') {
                try {
                    worker.terminate();
                } catch (_) {
                }
                __currentWorker = null;
                hooks.onError && hooks.onError('취소됨');
            } else if (msg.type === 'error') {
                try {
                    worker.terminate();
                } catch (_) {
                }
                __currentWorker = null;
                hooks.onError && hooks.onError(String(msg.message || '알 수 없는 오류'));
            } else if (msg.type === 'done') {
                // Rebuild entities for parts
                try {
                    worker.terminate();
                } catch (_) {
                }
                __currentWorker = null;

                const parts = /** @type {{positions:ArrayBuffer, normals:ArrayBuffer|null, min:number[], max:number[], triCount:number}[]} */ (msg.parts || []);
                if (!parts.length) {
                    hooks.onError && hooks.onError('유효한 파트를 찾지 못했습니다. (필터/epsilon을 조정해 보세요)');
                    return;
                }

                const created = [];
                // original root info
                const root = rec.entity;
                const rootPos = root.getLocalPosition();
                const minT = bounds?.min || [0, 0, 0];
                const maxT = bounds?.max || [0, 0, 0];
                const cxT = (minT[0] + maxT[0]) / 2, czT = (minT[2] + maxT[2]) / 2, minyT = minT[1];
                const offsetTotal = [-cxT, -minyT, -czT];

                const baseName = (rec.name || 'Imported');
                // helper: generate a pleasant random color (avoid too dark/too bright extremes)
                const randColor = () => {
                    const r = 0.35 + Math.random() * 0.6;
                    const g = 0.35 + Math.random() * 0.6;
                    const b = 0.35 + Math.random() * 0.6;
                    return [r, g, b];
                };
                for (let i = 0; i < parts.length; i++) {
                    const p = parts[i];
                    const posArr = new Float32Array(p.positions);
                    const norArr = p.normals ? new Float32Array(p.normals) : undefined;
                    const idxStr = String(i + 1).padStart(3, '0');
                    const partName = namePrefix ? `${namePrefix}${idxStr}` : `${baseName}_part${idxStr}`;
                    const {entity} = createImportedMeshEntity(partName, posArr, norArr);
                    // assign a random color to this sub-mesh's material before adding to registry
                    const col = randColor();
                    try {
                        /** @type {any} */ (entity);
                        /** @type {any} */ const meshChild = /** @type {any} */ ((/** @type {any} */ (entity))._meshChild || entity);
                        if (meshChild && meshChild.render && meshChild.render.meshInstances && meshChild.render.meshInstances[0]) {
                            const mat = meshChild.render.meshInstances[0].material;
                            if (mat && mat.diffuse) {
                                mat.diffuse.set(col[0], col[1], col[2]);
                                mat.update();
                            }
                        }
                    } catch (_) { /* ignore color assignment errors */
                    }
                    // compute offset for this part bounds
                    const cx = (p.min[0] + p.max[0]) / 2, cz = (p.min[2] + p.max[2]) / 2, miny = p.min[1];
                    const offsetI = [-cx, -miny, -cz];
                    const newPos = new pc.Vec3(
                        rootPos.x + (offsetTotal[0] - offsetI[0]),
                        rootPos.y + (offsetTotal[1] - offsetI[1]),
                        rootPos.z + (offsetTotal[2] - offsetI[2])
                    );
                    entity.setLocalPosition(newPos);
                    app.root.addChild(entity);
                    const meta = {
                        positions: posArr,
                        normals: norArr,
                        triCount: p.triCount,
                        bounds: {min: p.min, max: p.max},
                        source: {splitFrom: rec.id}
                    };
                    // store the random color in the registry so it persists through history/redo
                    addRecord(entity, entity.name, 'mesh-import', col, meta);
                    const r = registry.get(/** @type {any} */ (entity)._sid);
                    if (r) created.push(r);
                }

                // Optionally delete original
                const originalDescriptor = makeDescriptorFromRecord(rec);
                if (!keepOriginal) {
                    deleteById(rec.id);
                }

                // History commit (grouped)
                const partDescriptors = created.map(r => makeDescriptorFromRecord(r));
                history.commit({
                    label: `Split Mesh (${parts.length} parts)`,
                    undo: () => {
                        // delete parts
                        for (const d of partDescriptors) deleteById(d.id);
                        // restore original if removed
                        if (!keepOriginal) addRecordFromDescriptor(originalDescriptor);
                    },
                    redo: () => {
                        // remove original if needed
                        if (!keepOriginal) deleteById(originalDescriptor.id);
                        for (const d of partDescriptors) addRecordFromDescriptor(d);
                    }
                });

                hooks.onDone && hooks.onDone(created);
            }
        };

        hooks.onProgress && hooks.onProgress(0, 'start');
        const transfers = [posTA.buffer];
        if (norTA) transfers.push(norTA.buffer);
        worker.postMessage({
            cmd: 'start',
            pos: posTA.buffer,
            nor: norTA ? norTA.buffer : null,
            epsilon,
            minTriangles
        }, transfers);
    } catch (err) {
        hooks.onError && hooks.onError(String(err && err.message || err));
    }
};

// ---------------- Importers ----------------
/**
 * Detect if ArrayBuffer content is binary STL.
 * @param {ArrayBuffer} buffer
 */
function isBinarySTL(buffer) {
    if (buffer.byteLength < 84) return false;
    const dv = new DataView(buffer);
    const triCount = dv.getUint32(80, true);
    const expected = 84 + triCount * 50;
    if (expected === buffer.byteLength) return true;
    // check header for non-ASCII
    const u8 = new Uint8Array(buffer, 0, Math.min(80, buffer.byteLength));
    for (let i = 0; i < u8.length; i++) {
        if (u8[i] > 127) return true;
    }
    return false;
}

/**
 * @param {ArrayBuffer} buffer
 * @returns {{ positions: number[], normals: number[], triCount: number, bounds: {min:number[], max:number[]} }}
 */
function parseBinarySTL(buffer) {
    const dv = new DataView(buffer);
    const triCount = dv.getUint32(80, true);
    const positions = new Array(triCount * 9);
    const normals = new Array(triCount * 9);
    /** @type {number[]} */
    const min = [Infinity, Infinity, Infinity];
    /** @type {number[]} */
    const max = [-Infinity, -Infinity, -Infinity];
    let off = 84;
    let pIndex = 0;
    let nIndex = 0;
    const cross = (ax, ay, az, bx, by, bz) => [
        ay * bz - az * by,
        az * bx - ax * bz,
        ax * by - ay * bx
    ];
    const normalize = (x, y, z) => {
        const len = Math.hypot(x, y, z) || 1;
        return [x / len, y / len, z / len];
    };
    for (let t = 0; t < triCount; t++) {
        const nx = dv.getFloat32(off + 0, true);
        const ny = dv.getFloat32(off + 4, true);
        const nz = dv.getFloat32(off + 8, true);
        const v1x = dv.getFloat32(off + 12, true);
        const v1y = dv.getFloat32(off + 16, true);
        const v1z = dv.getFloat32(off + 20, true);
        const v2x = dv.getFloat32(off + 24, true);
        const v2y = dv.getFloat32(off + 28, true);
        const v2z = dv.getFloat32(off + 32, true);
        const v3x = dv.getFloat32(off + 36, true);
        const v3y = dv.getFloat32(off + 40, true);
        const v3z = dv.getFloat32(off + 44, true);
        // attribute byte count at off+48, off+49 (ignored)
        off += 50;

        // compute normal if provided is zero
        let nnx = nx, nny = ny, nnz = nz;
        if (!isFinite(nnx + nny + nnz) || (Math.abs(nnx) + Math.abs(nny) + Math.abs(nnz)) < 1e-20) {
            const abx = v2x - v1x, aby = v2y - v1y, abz = v2z - v1z;
            const acx = v3x - v1x, acy = v3y - v1y, acz = v3z - v1z;
            const c = cross(abx, aby, abz, acx, acy, acz);
            const n = normalize(c[0], c[1], c[2]);
            nnx = n[0];
            nny = n[1];
            nnz = n[2];
        } else {
            const n = normalize(nnx, nny, nnz);
            nnx = n[0];
            nny = n[1];
            nnz = n[2];
        }

        // write vertices and normals
        positions[pIndex++] = v1x;
        positions[pIndex++] = v1y;
        positions[pIndex++] = v1z;
        positions[pIndex++] = v2x;
        positions[pIndex++] = v2y;
        positions[pIndex++] = v2z;
        positions[pIndex++] = v3x;
        positions[pIndex++] = v3y;
        positions[pIndex++] = v3z;
        for (let i = 0; i < 3; i++) {
            normals[nIndex++] = nnx;
            normals[nIndex++] = nny;
            normals[nIndex++] = nnz;
        }

        // bounds
        const upd = (x, y, z) => {
            if (x < min[0]) min[0] = x;
            if (y < min[1]) min[1] = y;
            if (z < min[2]) min[2] = z;
            if (x > max[0]) max[0] = x;
            if (y > max[1]) max[1] = y;
            if (z > max[2]) max[2] = z;
        };
        upd(v1x, v1y, v1z);
        upd(v2x, v2y, v2z);
        upd(v3x, v3y, v3z);
    }
    return {positions, normals, triCount, bounds: {min, max}};
}

/**
 * @param {string} text
 * @returns {{ positions: number[], normals: number[], triCount: number, bounds: {min:number[], max:number[]} }}
 */
function parseAsciiSTL(text) {
    const positions = [];
    const normals = [];
    /** @type {number[]} */
    const min = [Infinity, Infinity, Infinity];
    /** @type {number[]} */
    const max = [-Infinity, -Infinity, -Infinity];
    const cross = (ax, ay, az, bx, by, bz) => [
        ay * bz - az * by,
        az * bx - ax * bz,
        ax * by - ay * bx
    ];
    const normalize = (x, y, z) => {
        const len = Math.hypot(x, y, z) || 1;
        return [x / len, y / len, z / len];
    };
    const upd = (x, y, z) => {
        if (x < min[0]) min[0] = x;
        if (y < min[1]) min[1] = y;
        if (z < min[2]) min[2] = z;
        if (x > max[0]) max[0] = x;
        if (y > max[1]) max[1] = y;
        if (z > max[2]) max[2] = z;
    };

    const facetRe = /facet\s+normal\s+([-+eE0-9\.]+)\s+([-+eE0-9\.]+)\s+([-+eE0-9\.]+)[\s\S]*?outer\s+loop\s+vertex\s+([-+eE0-9\.]+)\s+([-+eE0-9\.]+)\s+([-+eE0-9\.]+)\s+vertex\s+([-+eE0-9\.]+)\s+([-+eE0-9\.]+)\s+([-+eE0-9\.]+)\s+vertex\s+([-+eE0-9\.]+)\s+([-+eE0-9\.]+)\s+([-+eE0-9\.]+)\s+endloop\s+endfacet/gi;
    let m;
    let triCount = 0;
    while ((m = facetRe.exec(text)) !== null) {
        const nx = parseFloat(m[1]);
        const ny = parseFloat(m[2]);
        const nz = parseFloat(m[3]);
        const v1x = parseFloat(m[4]);
        const v1y = parseFloat(m[5]);
        const v1z = parseFloat(m[6]);
        const v2x = parseFloat(m[7]);
        const v2y = parseFloat(m[8]);
        const v2z = parseFloat(m[9]);
        const v3x = parseFloat(m[10]);
        const v3y = parseFloat(m[11]);
        const v3z = parseFloat(m[12]);
        let [nnx, nny, nnz] = (Math.abs(nx) + Math.abs(ny) + Math.abs(nz)) < 1e-20 ? normalize(...cross(v2x - v1x, v2y - v1y, v2z - v1z, v3x - v1x, v3y - v1y, v3z - v1z)) : normalize(nx, ny, nz);
        positions.push(v1x, v1y, v1z, v2x, v2y, v2z, v3x, v3y, v3z);
        normals.push(nnx, nny, nnz, nnx, nny, nnz, nnx, nny, nnz);
        upd(v1x, v1y, v1z);
        upd(v2x, v2y, v2z);
        upd(v3x, v3y, v3z);
        triCount++;
    }
    return {positions, normals, triCount, bounds: {min, max}};
}

/**
 * Create an entity for imported triangle mesh with bottom-aligned pivot and mesh child.
 * @param {string} name
 * @param {number[]} positions
 * @param {number[]} normals
 * @param {{ colors?: number[], uvs?: number[], material?: pc.Material, castShadow?: boolean, receiveShadow?: boolean }=} extra
 */
function createImportedMeshEntity(name, positions, normals, extra) {
    const mesh = pc.createMesh(app.graphicsDevice, positions, {
        normals: (normals && normals.length) ? normals : undefined,
        colors: (extra && extra.colors && extra.colors.length) ? extra.colors : undefined,
        uvs: (extra && extra.uvs && extra.uvs.length) ? extra.uvs : undefined
    });
    /** @type {pc.Material} */
    let mat = extra && extra.material ? extra.material : null;
    if (!mat) {
        const m = new pc.StandardMaterial();
        m.diffuse = new pc.Color(1, 1, 1);
        // enable vertex colors if provided
        if (extra && extra.colors && extra.colors.length) m.vertexColors = true;
        m.update();
        mat = m;
    }
    const mi = new pc.MeshInstance(mesh, mat);
    const castSh = extra && typeof extra.castShadow === 'boolean' ? extra.castShadow : true;
    const recvSh = extra && typeof extra.receiveShadow === 'boolean' ? extra.receiveShadow : true;
    mi.castShadow = castSh;
    mi.receiveShadow = recvSh;

    const root = new pc.Entity(name || 'Imported Mesh');
    const meshNode = new pc.Entity((name || 'Imported Mesh') + ' Mesh');
    meshNode.addComponent('render', {castShadows: castSh, receiveShadows: recvSh});
    meshNode.render.meshInstances = [mi];

    // compute bounds from positions
    let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i], y = positions[i + 1], z = positions[i + 2];
        if (x < minx) minx = x;
        if (y < miny) miny = y;
        if (z < minz) minz = z;
        if (x > maxx) maxx = x;
        if (y > maxy) maxy = y;
        if (z > maxz) maxz = z;
    }
    const cx = (minx + maxx) / 2, cz = (minz + maxz) / 2;
    const offset = [-cx, -miny, -cz]; // center in XZ, bottom on Y=0
    meshNode.setLocalPosition(offset[0], offset[1], offset[2]);

    root.addChild(meshNode);
    /** @type {any} */ (root)._meshChild = meshNode;
    return {entity: root, bounds: {min: [minx, miny, minz], max: [maxx, maxy, maxz]}};
}

/**
 * Import selected files. Currently supports: .stl (binary & ASCII).
 * @param {File[]} files
 * @param {{ scale?: number, upAxis?: 'y'|'z' }=} options
 */
api.importFiles = async (files, options) => {
    try {
        console.log('[Import] importFiles invoked. files:', Array.isArray(files) ? files.map(f => f && f.name) : files);
    } catch (_) {
    }
    if (!files || !files.length) return;
    const scale = (options && typeof options.scale === 'number' && isFinite(options.scale) && options.scale > 0) ? options.scale : 1;
    const upAxis = (options && (options.upAxis === 'z' || options.upAxis === 'y')) ? options.upAxis : 'y';

    /**
     * Apply import transforms (axis conversion and scale) to positions and normals in-place.
     * - If upAxis === 'z', treat source as Z-up and convert to Y-up by rotating -90° about X: (x, y, z) -> (x, z, -y)
     * - Apply uniform scale to positions only.
     * @param {number[]} positions
     * @param {number[]|undefined} normals
     */
    function applyImportTransforms(positions, normals) {
        const doRotate = upAxis === 'z';
        if (positions && positions.length) {
            for (let i = 0; i < positions.length; i += 3) {
                const x = positions[i];
                const y = positions[i + 1];
                const z = positions[i + 2];
                let nx = x, ny = y, nz = z;
                if (doRotate) {
                    // -90° around X: y' = z, z' = -y
                    ny = z;
                    nz = -y;
                    nx = x;
                }
                // scale positions
                positions[i] = nx * scale;
                positions[i + 1] = ny * scale;
                positions[i + 2] = nz * scale;
            }
        }
        if (normals && normals.length) {
            for (let i = 0; i < normals.length; i += 3) {
                const x = normals[i];
                const y = normals[i + 1];
                const z = normals[i + 2];
                let nx = x, ny = y, nz = z;
                if (doRotate) {
                    ny = z;
                    nz = -y;
                    nx = x;
                }
                // re-normalize just in case
                const len = Math.hypot(nx, ny, nz) || 1;
                normals[i] = nx / len;
                normals[i + 1] = ny / len;
                normals[i + 2] = nz / len;
            }
        }
    }

    for (const file of files) {
        const name = file.name || 'Imported';
        const lower = name.toLowerCase();
        try {
            if (lower.endsWith('.stl')) {
                try {
                    console.log('[Import] reading STL file:', name, 'size:', file.size);
                } catch (_) {
                }
                const buffer = await file.arrayBuffer();
                let parsed;
                if (isBinarySTL(buffer)) {
                    parsed = parseBinarySTL(buffer);
                } else {
                    const text = new TextDecoder('utf-8').decode(buffer);
                    parsed = parseAsciiSTL(text);
                }
                if (!parsed || !parsed.positions || !parsed.positions.length) {
                    console.warn('[Import] STL parsed but no triangles found for', name);
                    throw new Error('삼각형 데이터가 없습니다.');
                }

                // Apply import transforms
                applyImportTransforms(parsed.positions, parsed.normals);

                const {
                    entity,
                    bounds
                } = createImportedMeshEntity(name.replace(/\.[^.]+$/, ''), parsed.positions, parsed.normals);
                const cp = data.get('cursor.position') || [0, 0, 0];
                entity.setLocalPosition(cp[0], cp[1], cp[2]);
                app.root.addChild(entity);

                const color = [0.75, 0.75, 0.75];
                const meta = {
                    source: {name, ext: 'stl', size: file.size},
                    positions: parsed.positions,
                    normals: parsed.normals,
                    triCount: parsed.triCount,
                    bounds,
                    importOptions: {scale, upAxis}
                };
                addRecord(entity, name.replace(/\.[^.]+$/, ''), 'mesh-import', color, meta);
                const rec = registry.get(/** @type {any} */ (entity)._sid);
                if (rec) {
                    const descriptor = makeDescriptorFromRecord(rec);
                    history.commit({
                        label: `Import STL (scale=${scale}${upAxis === 'z' ? ', Z-up' : ', Y-up'})`,
                        undo: () => {
                            deleteById(descriptor.id);
                        },
                        redo: () => {
                            addRecordFromDescriptor(descriptor);
                        }
                    });
                }
                console.log(`STL 가져오기 완료: ${name} (삼각형: ${parsed.triCount})`);
            } else if (lower.endsWith('.glb') || lower.endsWith('.gltf') || lower.endsWith('.obj')) {
                console.warn(`아직 지원하지 않는 포맷입니다: ${name}. 우선 STL(.stl) 파일을 사용해 주세요.`);
            } else {
                console.warn(`알 수 없는 포맷: ${name}`);
            }
        } catch (err) {
            console.error('가져오기 실패:', name, err);
        }
    }
};

/**
 * Import a Legacy VTK (BINARY) STRUCTURED_POINTS file and generate wind streamlines as a triangle mesh.
 * @param {File[]|File} filesOne
 * @param {{ scale?: number, upAxis?: 'y'|'z' }=} options
 */
api.importVTKWindField = async (filesOne, options) => {
    try {
        console.log('[VTK] importVTKWindField invoked.');
    } catch (_) {
    }
    const files = Array.isArray(filesOne) ? filesOne : (filesOne ? [filesOne] : []);
    if (!files.length) return;
    const scale = (options && typeof options.scale === 'number' && isFinite(options.scale) && options.scale > 0) ? options.scale : 1;
    const upAxis = (options && (options.upAxis === 'z' || options.upAxis === 'y')) ? options.upAxis : 'y';

    // Transform a point by import settings (axis + scale)
    function xf(p) {
        let x = p[0], y = p[1], z = p[2];
        if (upAxis === 'z') {
            const ny = z;
            const nz = -y;
            y = ny;
            z = nz;
        }
        return [x * scale, y * scale, z * scale];
    }

    for (const file of files) {
        if (!file || typeof file.name !== 'string') continue;
        const name = file.name;
        if (!/\.vtk$/i.test(name)) {
            console.warn('[VTK] Skipping non-.vtk file:', name);
            continue;
        }
        try {
            const buffer = await file.arrayBuffer();
            const vtk = parseLegacyStructuredPoints(buffer);
            if (!vtk || !vtk.dims || !vtk.spacing || !vtk.origin) throw new Error('VTK 메타데이터를 파싱하지 못했습니다.');

            // Compute original bounds from VTK metadata
            const nx = vtk.dims[0], ny = vtk.dims[1], nz = vtk.dims[2];
            try {
                console.log(`[VTK] Parsed STRUCTURED_POINTS: dims=${nx}x${ny}x${nz} spacing=[${vtk.spacing[0]}, ${vtk.spacing[1]}, ${vtk.spacing[2]}] origin=[${vtk.origin[0]}, ${vtk.origin[1]}, ${vtk.origin[2]}]`);
            } catch (_) {
            }
            const bmin0 = [vtk.origin[0], vtk.origin[1], vtk.origin[2]];
            const bmax0 = [
                vtk.origin[0] + (nx - 1) * vtk.spacing[0],
                vtk.origin[1] + (ny - 1) * vtk.spacing[1],
                vtk.origin[2] + (nz - 1) * vtk.spacing[2]
            ];
            // Transform 8 corners to import space and compute AABB
            const corners = [
                [bmin0[0], bmin0[1], bmin0[2]],
                [bmax0[0], bmin0[1], bmin0[2]],
                [bmin0[0], bmax0[1], bmin0[2]],
                [bmax0[0], bmax0[1], bmin0[2]],
                [bmin0[0], bmin0[1], bmax0[2]],
                [bmax0[0], bmin0[1], bmax0[2]],
                [bmin0[0], bmax0[1], bmax0[2]],
                [bmax0[0], bmax0[1], bmax0[2]]
            ].map(xf);
            let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
            for (const c of corners) {
                const x = c[0], y = c[1], z = c[2];
                if (x < minx) minx = x;
                if (y < miny) miny = y;
                if (z < minz) minz = z;
                if (x > maxx) maxx = x;
                if (y > maxy) maxy = y;
                if (z > maxz) maxz = z;
            }
            const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2, cz = (minz + maxz) / 2;
            const dx = (maxx - minx), dy = (maxy - miny), dz = (maxz - minz);

            // Create a translucent box representing the volume bounds
            const baseName = name.replace(/\.[^.]+$/, '');
            const visName = `${baseName} - VTK Volume`;
            // Parent group (identity scale) to avoid scaling child glyphs inadvertently
            const e = new pc.Entity(visName);
            e.setLocalPosition(cx, cy, cz);
            e.setLocalScale(1, 1, 1);
            app.root.addChild(e);
            // Create visual box as a child so that only the box is scaled
            const mat = new pc.StandardMaterial();
            mat.diffuse = new pc.Color(0.2, 0.6, 1.0);
            mat.opacity = 0.12;
            mat.blendType = pc.BLEND_NORMAL;
            mat.update();
            const boxNode = new pc.Entity('Volume Box');
            boxNode.addComponent('render', {type: 'box', castShadows: false, receiveShadows: false, material: mat});
            boxNode.setLocalScale(Math.max(dx, 1e-6), Math.max(dy, 1e-6), Math.max(dz, 1e-6));
            e.addChild(boxNode);
            // Expose mesh child for picking/outline purposes
            /** @type {any} */ (e)._meshChild = boxNode;

            // Register record (we will later enrich this meta with glyph info so that only ONE object appears)
            const color = [0.2, 0.6, 1.0];
            const meta = {
                source: {name, ext: 'vtk', size: file.size},
                kind: 'vtk-volume',
                field: {dims: vtk.dims, spacing: vtk.spacing, origin: vtk.origin},
                bounds: {min: [minx, miny, minz], max: [maxx, maxy, maxz]},
                importOptions: {scale, upAxis}
            };
            addRecord(e, visName, 'vtk-volume', color, meta);
            const recVol = registry.get(/** @type {any} */ (e)._sid);

            // Determine if vector data exists (compute BEFORE any usage)
            const hasVectors = !!vtk.vectors && vtk.vectors.length >= (vtk.count || (nx * ny * nz)) * 3;

            // Keep a private reference to the raw VTK vectors for later regeneration (do NOT expose to Observer)
            try {
                if (recVol && recVol.meta && hasVectors) {
                    // Store under a private key; will be excluded from history/descriptor
                    recVol.meta._vtkVectors = vtk.vectors;
                }
            } catch (_) { /* ignore */ }


            // Optional glyphs: Build arrow glyphs at regular grid intervals to show vector direction and speed
            if (hasVectors) {
                try {
                    const count = (vtk.count || (nx * ny * nz));
                    // Compute speed range + median(sampled)
                    let smin = Infinity, smax = -Infinity;
                    const sample = [];
                    const sampleCap = 1024;
                    const stepSample = Math.max(1, Math.floor(count / sampleCap));
                    for (let i = 0, vi = 0; i < count; i++, vi += 3) {
                        const vx = vtk.vectors[vi], vy = vtk.vectors[vi + 1], vz = vtk.vectors[vi + 2];
                        const mag = Math.hypot(vx, vy, vz);
                        if (mag < smin) smin = mag;
                        if (mag > smax) smax = mag;
                        if ((i % stepSample) === 0 && sample.length < sampleCap) sample.push(mag);
                    }
                    if (!isFinite(smin) || !isFinite(smax) || smin === smax) {
                        smin = 0;
                        smax = 1;
                    }
                    let smed = (smin + smax) * 0.5;
                    if (sample.length) {
                        const sorted = sample.slice().sort((a, b) => a - b);
                        const mid = Math.floor(sorted.length / 2);
                        smed = (sorted.length % 2) ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) * 0.5;
                    }
                    try {
                        console.log(`[VTK] Vector speed stats: min=${smin}, median=${smed}, max=${smax}`);
                    } catch (_) {
                    }

                    const colorParams = {
                        preset: 'viridis',
                        reverse: false,
                        autoRange: true,
                        min: smin,
                        max: smax,
                        opacity: 1.0
                    };
                    const map = mapFnByName(colorParams.preset);
                    const inv = 1 / (colorParams.max - colorParams.min + 1e-8);

                    // Helper: rotate vector/point for Z-up import and scale for display
                    const doRotate = upAxis === 'z';

                    function rotP(p) {
                        let x = p[0], y = p[1], z = p[2];
                        if (doRotate) {
                            const ny = z;
                            z = -y;
                            y = ny;
                        }
                        return [x * scale, y * scale, z * scale];
                    }

                    function rotV(v) {
                        let x = v[0], y = v[1], z = v[2];
                        if (doRotate) {
                            const ny = z;
                            z = -y;
                            y = ny;
                        }
                        return [x, y, z];
                    }

                    // Build MERGED MESH glyphs as one entity under the volume group
                    const glyphRoot = new pc.Entity(`${baseName} - Glyphs (Merged)`);
                    e.addChild(glyphRoot);

                    // Decide stride so glyph count is reasonable
                    const sx0 = vtk.spacing[0], sy0 = vtk.spacing[1], sz0 = vtk.spacing[2];
                    const h = Math.min(sx0, sy0, sz0);
                    // Choose stride from target glyph count (~6000..8000)
                    // Increase default density by ~10x as requested
                    const targetGlyphs = 600000;

                    function estCount(str) {
                        return Math.ceil(nx / str) * Math.ceil(ny / str) * Math.ceil(nz / str);
                    }

                    let stride = 1;
                    while (estCount(stride) > targetGlyphs && stride < Math.max(nx, ny, nz)) stride++;
                    stride = Math.max(1, stride);

                    // Arrow geometry parameters (pyramid head)
                    const minLen = 0.3 * h * scale;
                    const maxLen = 1.0 * h * scale;
                    const radiusRatio = 0.18; // radius relative to length

                    // Rotation from up(0,1,0) to direction
                    function quatFromUpToDir(dir) {
                        const up = [0, 1, 0];
                        // axis = up x dir
                        const ax = up[1] * dir[2] - up[2] * dir[1];
                        const ay = up[2] * dir[0] - up[0] * dir[2];
                        const az = up[0] * dir[1] - up[1] * dir[0];
                        const dot = up[0] * dir[0] + up[1] * dir[1] + up[2] * dir[2];
                        if (Math.hypot(ax, ay, az) < 1e-6) {
                            // parallel or opposite
                            if (dot > 0) return new pc.Quat(); // identity
                            // 180 deg around X axis
                            const q = new pc.Quat();
                            q.setFromAxisAngle(new pc.Vec3(1, 0, 0), 180);
                            return q;
                        }
                        const q = new pc.Quat(ax, ay, az, 1 + dot);
                        q.normalize();
                        return q;
                    }

                    // Geometry buffers (non-indexed triangles)
                    const positions = [];
                    const normals = [];
                    const colors = [];
                    // helpers
                    const pushTri = (a, b, c, col) => {
                        positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
                        // face normal
                        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
                        const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
                        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
                        const L = Math.hypot(nx, ny, nz) || 1;
                        nx /= L;
                        ny /= L;
                        nz /= L;
                        for (let t = 0; t < 3; t++) {
                            normals.push(nx, ny, nz);
                            colors.push(col[0] * 255, col[1] * 255, col[2] * 255, (col.length > 3 ? col[3] : 1));
                        }
                    };
                    const placedColorsPreview = (typeof globalThis !== 'undefined' && !!globalThis.__GLYPH_DEBUG__);
                    let placed = 0;
                    let debugPrinted = 0;
                    for (let k = 0; k < nz; k += stride) {
                        for (let j = 0; j < ny; j += stride) {
                            for (let i = 0; i < nx; i += stride) {
                                const id = (i + j * nx + k * nx * ny) * 3;
                                const vx = vtk.vectors[id], vy = vtk.vectors[id + 1], vz = vtk.vectors[id + 2];
                                const spd = Math.hypot(vx, vy, vz);
                                if (!isFinite(spd) || spd <= 0) continue;
                                // sample position at voxel center
                                const px = vtk.origin[0] + i * vtk.spacing[0];
                                const py = vtk.origin[1] + j * vtk.spacing[1];
                                const pz = vtk.origin[2] + k * vtk.spacing[2];
                                const posW = rotP([px, py, pz]);
                                const dirW = rotV([vx, vy, vz]);
                                const t = Math.max(0, Math.min(1, (spd - colorParams.min) * inv));
                                const col = map(colorParams.reverse ? (1 - t) : t);
                                // Convert to parent group's local coords
                                const posL = [posW[0] - cx, posW[1] - cy, posW[2] - cz];
                                // direction basis
                                const dlen = Math.hypot(dirW[0], dirW[1], dirW[2]);
                                if (dlen <= 1e-8) continue;
                                const dn = [dirW[0] / dlen, dirW[1] / dlen, dirW[2] / dlen];
                                const ref = (Math.abs(dn[1]) < 0.999) ? [0, 1, 0] : [1, 0, 0];
                                // X = normalize(ref x dn), Z = dn x X
                                let Xx = ref[1] * dn[2] - ref[2] * dn[1];
                                let Xy = ref[2] * dn[0] - ref[0] * dn[2];
                                let Xz = ref[0] * dn[1] - ref[1] * dn[0];
                                let XL = Math.hypot(Xx, Xy, Xz) || 1;
                                Xx /= XL;
                                Xy /= XL;
                                Xz /= XL;
                                let Zx = dn[1] * Xz - dn[2] * Xy;
                                let Zy = dn[2] * Xx - dn[0] * Xz;
                                let Zz = dn[0] * Xy - dn[1] * Xx;
                                // dimensions
                                const len = Math.max(minLen, Math.min(maxLen, t * (maxLen - minLen) + minLen));
                                const radius = Math.max(0.05 * h * scale, len * radiusRatio);
                                // vertices: square base (y=0) and tip (y=len)
                                const b0 = [posL[0] + (-radius) * Xx + (-radius) * Zx, posL[1] + 0, posL[2] + (-radius) * Xz + (-radius) * Zz];
                                const b1 = [posL[0] + (+radius) * Xx + (-radius) * Zx, posL[1] + 0, posL[2] + (+radius) * Xz + (-radius) * Zz];
                                const b2 = [posL[0] + (+radius) * Xx + (+radius) * Zx, posL[1] + 0, posL[2] + (+radius) * Xz + (+radius) * Zz];
                                const b3 = [posL[0] + (-radius) * Xx + (+radius) * Zx, posL[1] + 0, posL[2] + (-radius) * Xz + (+radius) * Zz];
                                const tip = [posL[0] + dn[0] * len, posL[1] + dn[1] * len, posL[2] + dn[2] * len];
                                // sides (ensure CCW from outside)
                                pushTri(b0, b1, tip, col);
                                pushTri(b1, b2, tip, col);
                                pushTri(b2, b3, tip, col);
                                pushTri(b3, b0, tip, col);
                                // base (two triangles)
                                pushTri(b0, b2, b1, col);
                                pushTri(b0, b3, b2, col);
                                if (placedColorsPreview && debugPrinted < 100) {
                                    try {
                                        console.log(`[Glyph] i=${i} j=${j} k=${k} pos=(${posW[0].toFixed(3)}, ${posW[1].toFixed(3)}, ${posW[2].toFixed(3)}) len=${len.toFixed(3)} radius=${radius.toFixed(3)} speed=${spd.toFixed(6)}`);
                                    } catch (_) {
                                    }
                                    debugPrinted++;
                                }
                                placed++;
                            }
                        }
                    }
                    // Create single mesh & material
                    const mesh = pc.createMesh(app.graphicsDevice, positions, {normals, colors});
                    // 속력(Point Field) 기반으로 산출된 정점 컬러(colors)를 그대로 화면에 출력하는
                    // Unlit 셰이더 머티리얼을 사용합니다. (엔진 경로 차이와 무관하게 확실하게 동작)
                    const mat = createUnlitVertexColorShaderMaterial(Math.max(0, Math.min(1, colorParams.opacity)));
                    try {
                        console.log(`[VTK] Glyph colors: preset=${colorParams.preset}${colorParams.reverse ? " (rev)" : ""} range=[${colorParams.min}, ${colorParams.max}]`);
                    } catch (_) {
                    }
                    try {
                        if (globalThis.__GLYPH_DEBUG__) {
                            const nvert = positions.length / 3;
                            const cverts = colors.length / 4;
                            console.log(`[DEBUG] Merged glyphs vertex counts: pos=${nvert}, col=${cverts}`);
                            const sampleCols = [];
                            for (let s = 0; s < Math.min(5, cverts); s++) sampleCols.push([colors[s * 4], colors[s * 4 + 1], colors[s * 4 + 2], colors[s * 4 + 3]]);
                            console.log('[DEBUG] first vertex colors:', sampleCols);
                            console.log('[DEBUG] mat props: vertexColors=', mat.vertexColors, ' emissiveVertexColor=', mat.emissiveVertexColor, ' useLighting?', mat.useLighting);
                        }
                    } catch (_) {
                    }
                    const mi = new pc.MeshInstance(mesh, mat);
                    mi.castShadow = false;
                    mi.receiveShadow = false;
                    glyphRoot.addComponent('render', {castShadows: false, receiveShadows: false});
                    glyphRoot.render.meshInstances = [mi];

                    // Do NOT add a separate record for glyphs.
                    // Instead, attach glyph metadata to the parent record so the UI treats it as a single object.
                    if (recVol && recVol.meta) {
                        try {
                            recVol.meta.kind = 'vtk-glyphs-merged';
                            recVol.meta.colorParams = {...colorParams};
                            recVol.meta.stride = stride;
                            recVol.meta.count = placed;
                            recVol.meta.triCount = (positions.length / 9) | 0;
                            recVol.meta.scalarStats = {min: smin, max: smax, median: smed, name: 'speed'};
                        } catch (_) {}
                        // Refresh inspector to reflect updated meta on the single object
                        try { setInspectorFromEntity(recVol); } catch (_) {}
                    }
                    try {
                        console.log(`[VTK] Glyphs merged: tris=${(positions.length / 9) | 0}, glyphs=${placed}, stride=${stride}, dims=${nx}x${ny}x${nz}`);
                    } catch (_) {
                    }
                } catch (e2) {
                    console.warn('Glyph build failed:', e2);
                }
            }

            // History entry: remove the single (parent) object on undo
            if (recVol) {
                const descVol = makeDescriptorFromRecord(recVol);
                history.commit({
                    label: 'Import VTK (Wind Field)',
                    undo: () => {
                        deleteById(descVol.id);
                    },
                    redo: () => {
                        addRecordFromDescriptor(descVol);
                    }
                });
            }
            console.log(`[VTK] VTK 볼륨 및 글리프 생성 완료: ${name} (size: ${nx}x${ny}x${nz})`);
        } catch (err) {
            console.error('[VTK] 가져오기 실패:', name, err);
        }
    }
};

// ---- SCALARS-ONLY: Scalar Slice creation ----
async function createScalarSliceFromVTK(name, sizeBytes, vtk, importOptions) {
    try {
        const baseName = name.replace(/\.[^.]+$/, '');
        const visName = `${baseName} - Scalar Slice`;
        const field = {dims: vtk.dims, spacing: vtk.spacing, origin: vtk.origin};
        const nx = vtk.dims[0], ny = vtk.dims[1], nz = vtk.dims[2];
        const bmin = [field.origin[0], field.origin[1], field.origin[2]];
        const bmax = [field.origin[0] + (nx - 1) * field.spacing[0], field.origin[1] + (ny - 1) * field.spacing[1], field.origin[2] + (nz - 1) * field.spacing[2]];
        const cx = (bmin[0] + bmax[0]) / 2, cy = (bmin[1] + bmax[1]) / 2, cz = (bmin[2] + bmax[2]) / 2;
        const dx = (bmax[0] - bmin[0]), dy = (bmax[1] - bmin[1]), dz = (bmax[2] - bmin[2]);
        // Default 3 points on mid-Y plane
        const P0 = [cx - dx * 0.25, cy, cz - dz * 0.25];
        const P1 = [cx + dx * 0.25, cy, cz - dz * 0.25];
        const P2 = [cx, cy, cz + dz * 0.25];

        // Build initial slice
        const plane = planeFromPoints(P0, P1, P2);
        // determine scalar range
        let smin = Infinity, smax = -Infinity;
        const S = vtk.scalars;
        for (let i = 0; i < S.length; i++) {
            const v = S[i];
            if (v < smin) smin = v;
            if (v > smax) smax = v;
        }
        if (!isFinite(smin) || !isFinite(smax) || smin === smax) {
            smin = 0;
            smax = 1;
        }
        const colorParams = {preset: 'viridis', reverse: false, autoRange: true, min: smin, max: smax, opacity: 1.0};
        const slice = buildScalarSlice(field, vtk.scalars, plane, bmin, bmax, {
            resU: 128,
            resV: 128,
            colorMap: mapFnByName(colorParams.preset),
            min: colorParams.min,
            max: colorParams.max,
            reverse: colorParams.reverse
        });

        // Apply import transforms (axis + scale) to positions/normals
        const positionsTA = slice.positions instanceof Float32Array ? slice.positions : new Float32Array(slice.positions);
        const normalsTA = slice.normals instanceof Float32Array ? slice.normals : new Float32Array(slice.normals);
        (function applyImportTransformsTA(positions, normals) {
            const doRotate = importOptions?.upAxis === 'z';
            const scale = (typeof importOptions?.scale === 'number' && isFinite(importOptions.scale) && importOptions.scale > 0) ? importOptions.scale : 1;
            if (positions && positions.length) {
                for (let i = 0; i < positions.length; i += 3) {
                    let x = positions[i], y = positions[i + 1], z = positions[i + 2];
                    if (doRotate) {
                        const ny = y;
                        y = z;
                        z = -ny;
                    }
                    positions[i] = x * scale;
                    positions[i + 1] = y * scale;
                    positions[i + 2] = z * scale;
                }
            }
            if (normals && normals.length) {
                for (let i = 0; i < normals.length; i += 3) {
                    let x = normals[i], y = normals[i + 1], z = normals[i + 2];
                    if (doRotate) {
                        const ny = y;
                        y = z;
                        z = -ny;
                    }
                    const l = Math.hypot(x, y, z) || 1;
                    normals[i] = x / l;
                    normals[i + 1] = y / l;
                    normals[i + 2] = z / l;
                }
            }
        })(positionsTA, normalsTA);

        // Material: unlit vertex colors + opacity
        const mat = createUnlitVertexColorMaterial(Math.max(0, Math.min(1, colorParams.opacity)));
        const {
            entity,
            bounds
        } = createImportedMeshEntity(visName, Array.from(positionsTA), Array.from(normalsTA), {
            colors: Array.from(slice.colors),
            uvs: Array.from(slice.uvs),
            material: mat
        });
        // Place entity so that world matches absolute coords
        try {
            if (bounds && bounds.min && bounds.max) {
                const ccx = (bounds.min[0] + bounds.max[0]) / 2;
                const ccz = (bounds.min[2] + bounds.max[2]) / 2;
                const miny = bounds.min[1];
                entity.setLocalPosition(ccx, miny, ccz);
            }
        } catch (_) {
        }
        app.root.addChild(entity);

        // Create a translucent AABB box child for reference
        try {
            const box = new pc.Entity('Scalar Volume Bounds');
            box.addComponent('render', {type: 'box'});
            const m = new pc.StandardMaterial();
            m.diffuse = new pc.Color(0.2, 0.6, 1.0);
            m.opacity = 0.08;
            m.blendType = pc.BLEND_NORMAL;
            m.update();
            box.render.material = m;
            box.render.castShadows = false;
            box.render.receiveShadows = false;
            const sx = dx, sy = dy, sz = dz;
            box.setLocalScale(sx, sy, sz);
            // Position at center relative to slice root pivot
            const centerLocal = new pc.Vec3(cx, cy, cz);
            const rootPos = entity.getLocalPosition();
            box.setLocalPosition(centerLocal.x - rootPos.x, centerLocal.y - rootPos.y, centerLocal.z - rootPos.z);
            entity.addChild(box);
        } catch (_) {
        }

        // Add record
        const color = [1, 1, 1];
        const meta = {
            source: {name, ext: 'vtk', size: sizeBytes},
            positions: positionsTA,
            normals: normalsTA,
            triCount: slice.triCount,
            bounds,
            field,
            stats: slice.stats,
            kind: 'scalar-slice',
            importOptions: {...(importOptions || {})},
            _scalars: vtk.scalars,
            _positionsRaw: slice.positions, // raw before transforms
            _planePoints: [P0, P1, P2],
            sliceParams: {resU: 128, resV: 128},
            colorParams,
            scalarStats: {name: vtk.scalarsName || 'scalars', min: smin, max: smax}
        };
        addRecord(entity, visName, 'mesh-import', color, meta);
        const rec = registry.get(/** @type {any} */ (entity)._sid);

        // Create 3 draggable handles (register as hidden records)
        const handleColor = new pc.Color(1, 0.6, 0.1);

        function createHandle(pos, label) {
            const h = new pc.Entity(label);
            h.addComponent('render', {
                type: 'sphere',
                castShadows: false,
                receiveShadows: false,
                material: createColorMaterial(handleColor)
            });
            h.setLocalScale(Math.max(dx, dy, dz) * 0.02, Math.max(dx, dy, dz) * 0.02, Math.max(dx, dy, dz) * 0.02);
            h.setLocalPosition(pos[0], pos[1], pos[2]);
            app.root.addChild(h);
            const hidColor = [handleColor.r, handleColor.g, handleColor.b];
            addRecord(h, label, 'slice-handle', hidColor, {parent: rec?.id});
            return /** @type {any} */ (h)._sid;
        }

        const hid0 = createHandle(P0, visName + ' P0');
        const hid1 = createHandle(P1, visName + ' P1');
        const hid2 = createHandle(P2, visName + ' P2');
        if (rec) {
            rec.meta.handles = [hid0, hid1, hid2];
            const descriptor = makeDescriptorFromRecord(rec);
            history.commit({
                label: 'Import VTK (Scalar Slice)',
                undo: () => {
                    // delete handles then slice
                    deleteById(hid0);
                    deleteById(hid1);
                    deleteById(hid2);
                    deleteById(descriptor.id);
                },
                redo: () => {
                    const r = addRecordFromDescriptor(descriptor); /* handles won't be recreated on redo in this simple path */
                }
            });
        }
        console.log(`[VTK] 스칼라 단면 생성 완료: ${name} (tris: ${slice.triCount})`);
    } catch (e) {
        console.error('createScalarSliceFromVTK failed:', e);
    }
}

// Scalar-slice APIs
api.setScalarSliceParamsById = (id, params) => {
    const rec = registry.get(id);
    if (!rec) return;
    const m = rec.meta;
    if (!m || m.kind !== 'scalar-slice') return;
    const p = {...(m.sliceParams || {})};
    if (params.resU != null) p.resU = Math.max(2, Math.floor(Number(params.resU) || 128));
    if (params.resV != null) p.resV = Math.max(2, Math.floor(Number(params.resV) || 128));
    m.sliceParams = p;
    if (data.get('selectedId') === id) updateSelectedInspector();
};

// ---- Y-slice (horizontal plane using VECTORS speed) APIs ----
api.setYSliceParamsById = (id, params) => {
    const rec = registry.get(id);
    if (!rec) return;
    const m = rec.meta;
    if (!m || m.kind !== 'y-slice') return;
    if (!params) return;
    let changed = false;
    if (params.heightT != null) {
        let t = Number(params.heightT);
        if (!isFinite(t)) t = (m.heightT != null ? m.heightT : 0.5);
        t = Math.max(0, Math.min(1, t));
        if (!(Math.abs(t - (m.heightT != null ? m.heightT : 0.5)) < 1e-6)) {
            m.heightT = t;
            changed = true;
        }
    }
    if (params.res != null) {
        const res = Math.max(2, Math.floor(Number(params.res) || 128));
        const curU = m.sliceParams?.resU ?? 128;
        const curV = m.sliceParams?.resV ?? 128;
        if (res !== curU || res !== curV) {
            m.sliceParams = {resU: res, resV: res};
            changed = true;
        }
    }
    if (params.resU != null || params.resV != null) {
        const ru = params.resU != null ? Math.max(2, Math.floor(Number(params.resU) || 128)) : (m.sliceParams?.resU || 128);
        const rv = params.resV != null ? Math.max(2, Math.floor(Number(params.resV) || 128)) : (m.sliceParams?.resV || 128);
        const curU = m.sliceParams?.resU ?? 128;
        const curV = m.sliceParams?.resV ?? 128;
        if (ru !== curU || rv !== curV) {
            m.sliceParams = {resU: ru, resV: rv};
            changed = true;
        }
    }
    if (changed && data.get('selectedId') === id) updateSelectedInspector();
};

api.recolorYSliceById = (id) => {
    const rec = registry.get(id);
    if (!rec) return;
    const m = rec.meta;
    if (!m || m.kind !== 'y-slice') return;
    const e = rec.entity;
    /** @type {any} */ const meshNode = /** @type {any} */ (e._meshChild || e);
    if (!meshNode || !meshNode.render || !meshNode.render.meshInstances || !meshNode.render.meshInstances[0]) return;
    const raw = m._positionsRaw;
    if (!raw) return;
    const field = m.field;
    const scalars = m._scalars;
    if (!field || !scalars) return;
    const sampler = createScalarSampler(field, scalars);
    const p = m.colorParams || {preset: 'viridis', reverse: false, min: 0, max: 1, autoRange: true, opacity: 1};
    let min = p.min, max = p.max;
    if (p.autoRange) {
        let smin = Infinity, smax = -Infinity;
        for (let i = 0; i < scalars.length; i++) {
            const v = scalars[i];
            if (v < smin) smin = v;
            if (v > smax) smax = v;
        }
        if (!isFinite(smin) || !isFinite(smax) || smin === smax) {
            smin = 0;
            smax = 1;
        }
        min = smin;
        max = smax;
        m.scalarStats = {...(m.scalarStats || {}), min, max};
    }
    const inv = 1 / (max - min + 1e-8);
    const map = mapFnByName(p.preset);
    const colors = new Float32Array((raw.length / 3) * 4);
    for (let i = 0, vi = 0; i < raw.length; i += 3, vi += 4) {
        const x = raw[i], y = raw[i + 1], z = raw[i + 2];
        let t = (sampler.sample(x, y, z) - min) * inv;
        if (p.reverse) t = 1 - t;
        t = Math.max(0, Math.min(1, t));
        const c = map(t);
        colors[vi] = c[0];
        colors[vi + 1] = c[1];
        colors[vi + 2] = c[2];
        colors[vi + 3] = 1.0;
    }
    const gd = app.graphicsDevice;
    const positions = Array.from(m.positions || []);
    const normals = Array.from(m.normals || []);
    const uvs = m._uvs ? Array.from(m._uvs) : undefined;
    const mesh = pc.createMesh(gd, positions, {normals, colors: Array.from(colors), uvs});
    const mi = meshNode.render.meshInstances[0];
    mi.mesh = mesh;
    mi.material = createUnlitVertexColorMaterial(Math.max(0, Math.min(1, p.opacity || 1)));
    // Ensure unlit slices don't interact with shadows and are visible from both sides
    try {
        mi.castShadow = false;
        mi.receiveShadow = false;
    } catch (_) {
    }
    try {
        meshNode.render.castShadows = false;
        meshNode.render.receiveShadows = false;
    } catch (_) {
    }
    if (data.get('selectedId') === id) updateSelectedInspector();
};

api.regenerateYSliceById = (id) => {
    try {
        const rec = registry.get(id);
        if (!rec) return;
        const m = rec.meta;
        if (!m || m.kind !== 'y-slice') return;
        const field = m.field;
        const scalars = m._scalars;
        if (!field || !scalars) return;
        const nx = field.dims[0], ny = field.dims[1], nz = field.dims[2];
        const bmin = [field.origin[0], field.origin[1], field.origin[2]];
        const bmax = [field.origin[0] + (nx - 1) * field.spacing[0], field.origin[1] + (ny - 1) * field.spacing[1], field.origin[2] + (nz - 1) * field.spacing[2]];
        const t = (m.heightT != null ? m.heightT : 0.5);
        const up = (m.importOptions && (m.importOptions.upAxis === 'z' || m.importOptions.upAxis === 'y')) ? m.importOptions.upAxis : 'y';
        let P0, P1, P2;
        if (up === 'z') {
            const z0 = bmin[2] + t * (bmax[2] - bmin[2]);
            P0 = [bmin[0], bmin[1], z0];
            P1 = [bmax[0], bmin[1], z0];
            P2 = [bmin[0], bmax[1], z0];
        } else {
            const y0 = bmin[1] + t * (bmax[1] - bmin[1]);
            P0 = [bmin[0], y0, bmin[2]];
            P1 = [bmax[0], y0, bmin[2]];
            P2 = [bmin[0], y0, bmax[2]];
        }
        const plane = planeFromPoints(P0, P1, P2);
        const p = m.colorParams || {preset: 'viridis', reverse: false, min: 0, max: 1, autoRange: true, opacity: 1};
        let min = p.min, max = p.max;
        if (p.autoRange) {
            let smin = Infinity, smax = -Infinity;
            for (let i = 0; i < scalars.length; i++) {
                const v = scalars[i];
                if (v < smin) smin = v;
                if (v > smax) smax = v;
            }
            if (!isFinite(smin) || !isFinite(smax) || smin === smax) {
                smin = 0;
                smax = 1;
            }
            min = smin;
            max = smax;
        }
        const resU = m.sliceParams?.resU || 128;
        const resV = m.sliceParams?.resV || 128;
        const slice = buildScalarSlice(field, scalars, plane, bmin, bmax, {
            resU,
            resV,
            colorMap: mapFnByName(p.preset),
            min,
            max,
            reverse: p.reverse
        });
        // store raw
        m._positionsRaw = slice.positions;
        m._uvs = slice.uvs;
        // import transforms
        const imp = m.importOptions || {scale: 1, upAxis: 'y'};
        const doRotate = imp.upAxis === 'z';
        const scl = (typeof imp.scale === 'number' && isFinite(imp.scale) && imp.scale > 0) ? imp.scale : 1;
        const posTA = slice.positions;
        const norTA = slice.normals;
        for (let i2 = 0; i2 < posTA.length; i2 += 3) {
            let x = posTA[i2], y = posTA[i2 + 1], z = posTA[i2 + 2];
            if (doRotate) {
                const ny = y;
                y = z;
                z = -ny;
            }
            posTA[i2] = x * scl;
            posTA[i2 + 1] = y * scl;
            posTA[i2 + 2] = z * scl;
        }
        for (let i2 = 0; i2 < norTA.length; i2 += 3) {
            let x = norTA[i2], y = norTA[i2 + 1], z = norTA[i2 + 2];
            if (doRotate) {
                const ny = y;
                y = z;
                z = -ny;
            }
            const l = Math.hypot(x, y, z) || 1;
            norTA[i2] = x / l;
            norTA[i2 + 1] = y / l;
            norTA[i2 + 2] = z / l;
        }

        const e = rec.entity;
        /** @type {any} */ const meshNode = /** @type {any} */ (e._meshChild || e);
        const gd = app.graphicsDevice;
        const positions = Array.from(slice.positions);
        const normals = Array.from(slice.normals);
        const colors = Array.from(slice.colors);
        const uvs = Array.from(slice.uvs);
        const newMesh = pc.createMesh(gd, positions, {normals, colors, uvs});
        if (meshNode && meshNode.render && meshNode.render.meshInstances && meshNode.render.meshInstances.length) {
            meshNode.render.meshInstances[0].mesh = newMesh;
            const op = Math.max(0, Math.min(1, (m.colorParams?.opacity) || 1));
            const matUnlit = createUnlitVertexColorMaterial(op);
            meshNode.render.meshInstances[0].material = matUnlit;
            try {
                meshNode.render.meshInstances[0].castShadow = false;
                meshNode.render.meshInstances[0].receiveShadow = false;
            } catch (_) {
            }
        } else {
            const mi = new pc.MeshInstance(newMesh, createUnlitVertexColorMaterial(1));
            if (!meshNode.render) meshNode.addComponent('render', {castShadows: false, receiveShadows: false});
            meshNode.render.meshInstances = [mi];
            try {
                mi.castShadow = false;
                mi.receiveShadow = false;
                meshNode.render.castShadows = false;
                meshNode.render.receiveShadows = false;
            } catch (_) {
            }
        }
        // recompute bounds and recenter pivot
        let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
        for (let i3 = 0; i3 < positions.length; i3 += 3) {
            const x = positions[i3], y = positions[i3 + 1], z = positions[i3 + 2];
            if (x < minx) minx = x;
            if (y < miny) miny = y;
            if (z < minz) minz = z;
            if (x > maxx) maxx = x;
            if (y > maxy) maxy = y;
            if (z > maxz) maxz = z;
        }
        const ccx = (minx + maxx) / 2, ccz = (minz + maxz) / 2;
        meshNode.setLocalPosition(-ccx, -miny, -ccz);
        m.positions = slice.positions;
        m.normals = slice.normals;
        m.triCount = slice.triCount;
        m.bounds = {min: [minx, miny, minz], max: [maxx, maxy, maxz]};
        m.stats = slice.stats;
        // Avoid refreshing the whole objects list here to prevent sidebar remounts
        if (data.get('selectedId') === id) updateSelectedInspector();
        console.log(`[VTK] Y-slice 재생성 완료: id=${id} (tris: ${slice.triCount})`);
    } catch (e) {
        console.error('regenerateYSliceById failed:', e);
    }
};

api.recolorScalarSliceById = (id) => {
    const rec = registry.get(id);
    if (!rec) return;
    const m = rec.meta;
    if (!m || m.kind !== 'scalar-slice') return;
    const e = rec.entity;
    /** @type {any} */ const meshNode = /** @type {any} */ (e._meshChild || e);
    if (!meshNode || !meshNode.render || !meshNode.render.meshInstances || !meshNode.render.meshInstances[0]) return;
    // Recompute colors over raw positions
    const raw = m._positionsRaw;
    if (!raw) return;
    const field = m.field;
    const scalars = m._scalars;
    if (!field || !scalars) return;
    const sampler = createScalarSampler(field, scalars);
    const p = m.colorParams || {preset: 'viridis', reverse: false, min: 0, max: 1, autoRange: true, opacity: 1};
    let min = p.min, max = p.max;
    if (p.autoRange) {
        let smin = Infinity, smax = -Infinity;
        for (let i = 0; i < scalars.length; i++) {
            const v = scalars[i];
            if (v < smin) smin = v;
            if (v > smax) smax = v;
        }
        if (!isFinite(smin) || !isFinite(smax) || smin === smax) {
            smin = 0;
            smax = 1;
        }
        min = smin;
        max = smax;
        m.scalarStats = {...(m.scalarStats || {}), min, max};
    }
    const inv = 1 / (max - min + 1e-8);
    const map = mapFnByName(p.preset);
    const colors = new Float32Array((raw.length / 3) * 4);
    for (let i = 0, vi = 0; i < raw.length; i += 3, vi += 4) {
        const x = raw[i], y = raw[i + 1], z = raw[i + 2];
        let t = (sampler.sample(x, y, z) - min) * inv;
        if (p.reverse) t = 1 - t;
        t = Math.max(0, Math.min(1, t));
        const c = map(t);
        colors[vi] = c[0];
        colors[vi + 1] = c[1];
        colors[vi + 2] = c[2];
        colors[vi + 3] = 1.0;
    }
    const gd = app.graphicsDevice;
    const positions = Array.from(m.positions || []);
    const normals = Array.from(m.normals || []);
    const uvs = m._uvs ? Array.from(m._uvs) : undefined;
    const mesh = pc.createMesh(gd, positions, {normals, colors: Array.from(colors), uvs});
    const mi = meshNode.render.meshInstances[0];
    mi.mesh = mesh;
    // apply material opacity (unlit)
    mi.material = createUnlitVertexColorMaterial(Math.max(0, Math.min(1, p.opacity || 1)));
    if (data.get('selectedId') === id) updateSelectedInspector();
};

api.regenerateScalarSliceById = (id) => {
    try {
        const rec = registry.get(id);
        if (!rec) return;
        const m = rec.meta;
        if (!m || m.kind !== 'scalar-slice') return;
        const handles = (m.handles || []).map(hid => registry.get(hid)).filter(Boolean);
        if (handles.length < 3) {
            console.warn('regenerateScalarSliceById: missing handles');
            return;
        }
        const P0 = handles[0].entity.getLocalPosition();
        const P1 = handles[1].entity.getLocalPosition();
        const P2 = handles[2].entity.getLocalPosition();
        const plane = planeFromPoints([P0.x, P0.y, P0.z], [P1.x, P1.y, P1.z], [P2.x, P2.y, P2.z]);
        const field = m.field;
        const scalars = m._scalars;
        const nx = field.dims[0], ny = field.dims[1], nz = field.dims[2];
        const bmin = [field.origin[0], field.origin[1], field.origin[2]];
        const bmax = [field.origin[0] + (nx - 1) * field.spacing[0], field.origin[1] + (ny - 1) * field.spacing[1], field.origin[2] + (nz - 1) * field.spacing[2]];
        const p = m.colorParams || {preset: 'viridis', reverse: false, min: 0, max: 1, autoRange: true, opacity: 1};
        let min = p.min, max = p.max;
        if (p.autoRange) {
            let smin = Infinity, smax = -Infinity;
            for (let i = 0; i < scalars.length; i++) {
                const v = scalars[i];
                if (v < smin) smin = v;
                if (v > smax) smax = v;
            }
            if (!isFinite(smin) || !isFinite(smax) || smin === smax) {
                smin = 0;
                smax = 1;
            }
            min = smin;
            max = smax;
        }
        const slice = buildScalarSlice(field, scalars, plane, bmin, bmax, {
            resU: m.sliceParams?.resU || 128,
            resV: m.sliceParams?.resV || 128,
            colorMap: mapFnByName(p.preset),
            min,
            max,
            reverse: p.reverse
        });
        // store raw for recolor
        m._positionsRaw = slice.positions;
        m._uvs = slice.uvs;
        // import transforms same as import time
        const imp = m.importOptions || {scale: 1, upAxis: 'y'};
        const doRotate = imp.upAxis === 'z';
        const scl = (typeof imp.scale === 'number' && isFinite(imp.scale) && imp.scale > 0) ? imp.scale : 1;
        const posTA = slice.positions;
        const norTA = slice.normals;
        for (let i2 = 0; i2 < posTA.length; i2 += 3) {
            let x = posTA[i2], y = posTA[i2 + 1], z = posTA[i2 + 2];
            if (doRotate) {
                const ny = y;
                y = z;
                z = -ny;
            }
            posTA[i2] = x * scl;
            posTA[i2 + 1] = y * scl;
            posTA[i2 + 2] = z * scl;
        }
        for (let i2 = 0; i2 < norTA.length; i2 += 3) {
            let x = norTA[i2], y = norTA[i2 + 1], z = norTA[i2 + 2];
            if (doRotate) {
                const ny = y;
                y = z;
                z = -ny;
            }
            const l = Math.hypot(x, y, z) || 1;
            norTA[i2] = x / l;
            norTA[i2 + 1] = y / l;
            norTA[i2 + 2] = z / l;
        }

        const e = rec.entity;
        /** @type {any} */ const meshNode = /** @type {any} */ (e._meshChild || e);
        const gd = app.graphicsDevice;
        const positions = Array.from(slice.positions);
        const normals = Array.from(slice.normals);
        const colors = Array.from(slice.colors);
        const uvs = Array.from(slice.uvs);
        const newMesh = pc.createMesh(gd, positions, {normals, colors, uvs});
        if (meshNode && meshNode.render && meshNode.render.meshInstances && meshNode.render.meshInstances.length) {
            meshNode.render.meshInstances[0].mesh = newMesh;
            const mat = new pc.StandardMaterial();
            mat.diffuse = new pc.Color(1, 1, 1);
            mat.vertexColors = true;
            const op = Math.max(0, Math.min(1, (m.colorParams?.opacity) || 1));
            mat.opacity = op;
            if (op < 1) mat.blendType = pc.BLEND_NORMAL;
            mat.update();
            meshNode.render.meshInstances[0].material = mat;
        } else {
            const mat = new pc.StandardMaterial();
            mat.diffuse = new pc.Color(1, 1, 1);
            mat.vertexColors = true;
            mat.update();
            const mi = new pc.MeshInstance(newMesh, mat);
            if (!meshNode.render) meshNode.addComponent('render', {castShadows: true, receiveShadows: true});
            meshNode.render.meshInstances = [mi];
        }
        // recompute bounds and recenter pivot
        let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
        for (let i3 = 0; i3 < positions.length; i3 += 3) {
            const x = positions[i3], y = positions[i3 + 1], z = positions[i3 + 2];
            if (x < minx) minx = x;
            if (y < miny) miny = y;
            if (z < minz) minz = z;
            if (x > maxx) maxx = x;
            if (y > maxy) maxy = y;
            if (z > maxz) maxz = z;
        }
        const ccx = (minx + maxx) / 2, ccz = (minz + maxz) / 2;
        meshNode.setLocalPosition(-ccx, -miny, -ccz);
        m.positions = slice.positions;
        m.normals = slice.normals;
        m.triCount = slice.triCount;
        m.bounds = {min: [minx, miny, minz], max: [maxx, maxy, maxz]};
        m.stats = slice.stats;
        refreshObjects();
        if (data.get('selectedId') === id) updateSelectedInspector();
        console.log(`[VTK] 스칼라 단면 재생성 완료: id=${id} (tris: ${slice.triCount})`);
    } catch (e) {
        console.error('regenerateScalarSliceById failed:', e);
    }
};

// ----- Wind streamlines: parameter update and regeneration -----
/**
 * Update streamline parameters for a wind-streamlines object by id (runtime-only) and refresh Inspector.
 * @param {number} id
 * @param {{seedStride?:number, step?:number, maxSteps?:number, minSpeed?:number, width?:number}} params
 */
api.setStreamlineParamsById = (id, params) => {
    try {
        const rec = registry.get(id);
        if (!rec || rec.type !== 'mesh-import' || rec?.meta?.kind !== 'wind-streamlines') return;
        const m = rec.meta;
        const p = {...(m.streamParams || {})};
        const clampNum = (v, lo, hi, def) => {
            const n = Number(v);
            if (!isFinite(n)) return def;
            return Math.min(hi, Math.max(lo, n));
        };
        if (params.seedStride != null) p.seedStride = Math.max(1, Math.floor(Number(params.seedStride) || 1));
        if (params.step != null) p.step = clampNum(params.step, 1e-6, 1e6, p.step || 1);
        if (params.maxSteps != null) p.maxSteps = Math.max(1, Math.min(20000, Math.floor(Number(params.maxSteps) || 1)));
        if (params.minSpeed != null) p.minSpeed = clampNum(params.minSpeed, 0, 1e9, p.minSpeed || 1e-6);
        if (params.width != null) p.width = clampNum(params.width, 1e-6, 1e6, p.width || 1);
        if (params.seedPlane != null) {
            const sp = String(params.seedPlane).toUpperCase();
            p.seedPlane = (sp === 'XY' || sp === 'YZ' || sp === 'XZ') ? sp : (p.seedPlane || 'XZ');
        }
        if (params.seedOffset != null) p.seedOffset = clampNum(params.seedOffset, 0, 1, p.seedOffset ?? 0.5);
        if (params.seedIndex != null) {
            const n = Math.floor(Number(params.seedIndex));
            if (isFinite(n)) p.seedIndex = n;
        }
        if (params.seedJitter != null) p.seedJitter = clampNum(params.seedJitter, 0, 1, p.seedJitter ?? 0);
        m.streamParams = p;
        if (data.get('selectedId') === id) {
            // reflect back to inspector state
            updateSelectedInspector();
        }
    } catch (e) {
        console.error('[VTK] setStreamlineParamsById failed:', e);
    }
};

/**
 * Regenerate wind streamlines mesh for object id using cached field and parameters.
 * Keeps the existing entity and transform; updates mesh geometry, bounds, and meta.
 * @param {number} id
 */
api.regenerateWindStreamlinesById = (id) => {
    try {
        const rec = registry.get(id);
        if (!rec || rec.type !== 'mesh-import' || rec?.meta?.kind !== 'wind-streamlines') {
            console.warn('[VTK] regenerate: 대상이 wind-streamlines 가 아닙니다. id=', id);
            return;
        }
        const m = rec.meta || {};
        const field = m.field;
        const vectors = m._vectors;
        if (!field || !vectors) {
            console.warn('[VTK] regenerate: 필드 또는 벡터 캐시가 없습니다.');
            return;
        }
        const params = m.streamParams || {
            seedStride: 4,
            step: Math.min(field.spacing[0], field.spacing[1], field.spacing[2]) * 0.8,
            maxSteps: 300,
            minSpeed: 1e-6,
            width: Math.min(field.spacing[0], field.spacing[1], field.spacing[2]) * 0.6
        };

        const ribbons = generateStreamlineRibbons({
            dims: field.dims,
            spacing: field.spacing,
            origin: field.origin,
            vectors: vectors
        }, params);

        if (!ribbons.positions || ribbons.positions.length === 0) {
            console.warn('[VTK] regenerate: 결과 포지션이 비어 있습니다.');
            return;
        }

        // Keep raw positions/uvs for recoloring (before transforms)
        m._positionsRaw = new Float32Array(ribbons.positions);
        m._uvs = ribbons.uvs;

        // Apply the same import transforms used at first import
        const imp = m.importOptions || {scale: 1, upAxis: 'y'};
        const doRotate = imp.upAxis === 'z';
        const scl = (typeof imp.scale === 'number' && isFinite(imp.scale) && imp.scale > 0) ? imp.scale : 1;
        const positionsTA = ribbons.positions;
        const normalsTA = ribbons.normals;
        if (positionsTA && positionsTA.length) {
            for (let i = 0; i < positionsTA.length; i += 3) {
                const x = positionsTA[i], y = positionsTA[i + 1], z = positionsTA[i + 2];
                let nx = x, ny = y, nz = z;
                if (doRotate) {
                    ny = z;
                    nz = -y;
                }
                positionsTA[i] = nx * scl;
                positionsTA[i + 1] = ny * scl;
                positionsTA[i + 2] = nz * scl;
            }
        }
        if (normalsTA && normalsTA.length) {
            for (let i = 0; i < normalsTA.length; i += 3) {
                const x = normalsTA[i], y = normalsTA[i + 1], z = normalsTA[i + 2];
                let nx = x, ny = y, nz = z;
                if (doRotate) {
                    ny = z;
                    nz = -y;
                }
                const l = Math.hypot(nx, ny, nz) || 1;
                normalsTA[i] = nx / l;
                normalsTA[i + 1] = ny / l;
                normalsTA[i + 2] = nz / l;
            }
        }

        // Build new mesh and swap on entity's mesh node
        const e = rec.entity;
        /** @type {any} */ const meshNode = /** @type {any} */ (e._meshChild || e);
        const gd = app.graphicsDevice;
        const positions = Array.from(ribbons.positions);
        const normals = Array.from(ribbons.normals);
        // Recompute colors using current colorParams and raw positions
        const colors = Array.from(computeWindColors(m));
        const uvs = m._uvs ? Array.from(m._uvs) : undefined;
        const newMesh = pc.createMesh(gd, positions, {normals, colors, uvs});

        if (meshNode && meshNode.render && meshNode.render.meshInstances && meshNode.render.meshInstances.length) {
            const mi = meshNode.render.meshInstances[0];
            mi.mesh = newMesh;
            // refresh material to ensure chunks/opacity/vertexColors are correct
            const mat = buildWindMaterial(m);
            mi.material = mat;
        } else {
            const mat = buildWindMaterial(m);
            const mi = new pc.MeshInstance(newMesh, mat);
            mi.castShadow = true;
            mi.receiveShadow = true;
            if (!meshNode.render) meshNode.addComponent('render', {castShadows: true, receiveShadows: true});
            meshNode.render.meshInstances = [mi];
        }

        // Recompute bounds and re-center mesh child pivot (XZ center, bottom aligned)
        let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
        for (let i2 = 0; i2 < positions.length; i2 += 3) {
            const x = positions[i2], y = positions[i2 + 1], z = positions[i2 + 2];
            if (x < minx) minx = x;
            if (y < miny) miny = y;
            if (z < minz) minz = z;
            if (x > maxx) maxx = x;
            if (y > maxy) maxy = y;
            if (z > maxz) maxz = z;
        }
        const cx = (minx + maxx) / 2, cz = (minz + maxz) / 2;
        meshNode.setLocalPosition(-cx, -miny, -cz);

        // Update record meta
        m.positions = ribbons.positions;
        m.normals = ribbons.normals;
        m.triCount = ribbons.triCount;
        m.bounds = {min: [minx, miny, minz], max: [maxx, maxy, maxz]};
        m.stats = ribbons.stats;

        refreshObjects();
        if (data.get('selectedId') === id) updateSelectedInspector();
        console.log(`[VTK] 스트림라인 재생성 완료: id=${id} (triangles: ${ribbons.triCount}, ribbons: ${ribbons.stats?.ribbons})`);
    } catch (e) {
        console.error('[VTK] regenerateWindStreamlinesById failed:', e);
    }
};

// ---- Wind ribbon coloring helpers ----
function computeWindColors(meta) {
    try {
        const raw = meta._positionsRaw; // Float32Array of xyz before transforms
        if (!raw || !raw.length) return new Float32Array();
        const field = meta.field;
        if (!field) return new Float32Array();
        const vecSampler = createVectorSampler({...field, vectors: meta._vectors});
        const hasScalars = !!meta._scalars && meta._scalars.length;
        const sclSampler = hasScalars ? createScalarSampler(field, meta._scalars) : null;
        const p = meta.colorParams || {
            source: hasScalars ? 'scalar' : 'speed',
            preset: 'viridis',
            min: 0,
            max: 1,
            reverse: false,
            opacity: 1
        };
        const map = COLORMAPS[p.preset] || COLORMAPS['blue-red'];
        let min = p.min, max = p.max;
        if (p.autoRange) {
            let vmin = Infinity, vmax = -Infinity;
            const tmp = [0, 0, 0];
            for (let i = 0; i < raw.length; i += 3) {
                const x = raw[i], y = raw[i + 1], z = raw[i + 2];
                let val;
                if (p.source === 'scalar' && sclSampler) val = sclSampler.sample(x, y, z); else {
                    vecSampler.sample(x, y, z, tmp);
                    val = Math.hypot(tmp[0], tmp[1], tmp[2]);
                }
                if (val < vmin) vmin = val;
                if (val > vmax) vmax = val;
            }
            if (!isFinite(vmin) || !isFinite(vmax) || vmin === vmax) {
                vmin = 0;
                vmax = 1;
            }
            min = vmin;
            max = vmax;
            meta.scalarStats = {...(meta.scalarStats || {}), min, max};
        }
        const inv = 1 / (max - min + 1e-8);
        const out = new Float32Array((raw.length / 3) * 4);
        const tmp = [0, 0, 0];
        for (let i = 0, vi = 0; i < raw.length; i += 3, vi += 4) {
            const x = raw[i], y = raw[i + 1], z = raw[i + 2];
            let val;
            if (p.source === 'scalar' && sclSampler) val = sclSampler.sample(x, y, z); else {
                vecSampler.sample(x, y, z, tmp);
                val = Math.hypot(tmp[0], tmp[1], tmp[2]);
            }
            let t = (val - min) * inv;
            if (p.reverse) t = 1 - t;
            t = Math.max(0, Math.min(1, t));
            const c = map(t);
            out[vi] = c[0];
            out[vi + 1] = c[1];
            out[vi + 2] = c[2];
            out[vi + 3] = 1.0;
        }
        return out;
    } catch (e) {
        console.warn('computeWindColors failed:', e);
        return new Float32Array();
    }
}

/** Update color params for an object and recolor its mesh (no geometry change). */
api.setWindColoringById = (id, params) => {
    try {
        const rec = registry.get(id);
        if (!rec) return;
        const m = rec.meta;
            if (!m) return;
        const kind = m.kind;
        // 지원하는 kind: 스트림라인, 스칼라 슬라이스, Y-슬라이스, VTK 글리프(병합)
        if (kind !== 'wind-streamlines' && kind !== 'scalar-slice' && kind !== 'y-slice' && kind !== 'vtk-glyphs-merged') return;
        m.colorParams = {...(m.colorParams || {}), ...(params || {})};
        // 즉시 반영
        if (kind === 'wind-streamlines') api.recolorWindStreamlinesById(id);
        else if (kind === 'scalar-slice') api.recolorScalarSliceById(id);
        else if (kind === 'y-slice') api.recolorYSliceById(id);
        else if (kind === 'vtk-glyphs-merged') {
            // 현재 글리프는 정점 컬러로 구워져 있으므로 프리셋/리버스는 컬러바 및 메타만 갱신.
            // opacity는 즉시 머티리얼에 반영한다.
            try {
                const a = Math.max(0, Math.min(1, Number(m.colorParams?.opacity ?? 1)));
                const e = rec.entity;
                // glyph 엔티티 찾기: 이름/머티리얼 타입으로 휴리스틱
                let glyphNode = null;
                for (let i = 0; i < e.children.length; i++) {
                    const c = e.children[i];
                    if (!c || !c.render || !c.render.meshInstances || !c.render.meshInstances[0]) continue;
                    const mi = c.render.meshInstances[0];
                    const isStandard = (mi.material instanceof pc.StandardMaterial);
                    if ((c.name && /Glyphs/i.test(c.name)) || !isStandard) {
                        glyphNode = c;
                        break;
                    }
                }
                if (glyphNode) {
                    const mi = glyphNode.render.meshInstances[0];
                    const mat = mi.material;
                    // ShaderMaterial 경로
                    try { if (typeof mat.setParameter === 'function') mat.setParameter('uOpacity', a); } catch (_) {}
                    try { mat.blendType = (a < 1) ? pc.BLEND_NORMAL : pc.BLEND_NONE; } catch (_) {}
                    try { mat.update && mat.update(); } catch (_) {}
                }
            } catch (_) { /* ignore */ }
        }
        if (data.get('selectedId') === id) updateSelectedInspector();
    } catch (e) {
        console.error('setWindColoringById failed:', e);
    }
};

/** Rebuild merged VTK glyphs mesh using current color params. */
api.regenerateVTKGlyphsById = (id) => {
    try {
        const rec = registry.get(id);
        if (!rec) return;
        if (rec.type !== 'vtk-volume') return;
        const m = rec.meta || {};
        if (m.kind !== 'vtk-glyphs-merged') return;
        const field = m.field || {};
        const vectors = m._vtkVectors;
        const bounds = m.bounds;
        const opts = m.importOptions || {};
        if (!vectors || !field.dims || !field.spacing || !field.origin || !bounds) return;

        const nx = field.dims[0] | 0, ny = field.dims[1] | 0, nz = field.dims[2] | 0;
        const spacing = field.spacing;
        const origin = field.origin;
        const scale = (typeof opts.scale === 'number' && isFinite(opts.scale) && opts.scale > 0) ? opts.scale : 1;
        const upAxis = (opts.upAxis === 'z') ? 'z' : 'y';
        const doRotate = upAxis === 'z';
        const rotP = (p) => {
            let x = p[0], y = p[1], z = p[2];
            if (doRotate) { const ny = z; z = -y; y = ny; }
            return [x * scale, y * scale, z * scale];
        };
        const rotV = (v) => {
            let x = v[0], y = v[1], z = v[2];
            if (doRotate) { const ny = z; z = -y; y = ny; }
            return [x, y, z];
        };

        // Bounds center for local coords
        const min = bounds.min, max = bounds.max;
        const cx = (min[0] + max[0]) * 0.5;
        const cy = (min[1] + max[1]) * 0.5;
        const cz = (min[2] + max[2]) * 0.5;

        // Decide stride
        let stride = (m.stride | 0) || 1;
        if (stride < 1) stride = 1;

        // Speed stats
        let smin = Infinity, smax = -Infinity;
        const count = nx * ny * nz;
        const sampleCap = 1024;
        const stepSample = Math.max(1, Math.floor(count / sampleCap));
        for (let i = 0, vi = 0; i < count; i++, vi += 3) {
            const vx = vectors[vi], vy = vectors[vi + 1], vz = vectors[vi + 2];
            const mag = Math.hypot(vx, vy, vz);
            if (mag < smin) smin = mag;
            if (mag > smax) smax = mag;
        }
        if (!isFinite(smin) || !isFinite(smax) || smin === smax) { smin = 0; smax = 1; }

        // Params
        const cp = m.colorParams || {preset: 'viridis', reverse: false, autoRange: true, min: smin, max: smax, opacity: 1};
        const minV = (cp.autoRange ? smin : (isFinite(cp.min) ? Number(cp.min) : smin));
        const maxV = (cp.autoRange ? smax : (isFinite(cp.max) ? Number(cp.max) : smax));
        const preset = String(cp.preset || 'viridis');
        const reverse = !!cp.reverse;
        const map = mapFnByName(preset);
        const inv = 1 / (maxV - minV + 1e-8);

        // Geometry params
        const h = Math.min(spacing[0], spacing[1], spacing[2]);
        const minLen = 0.3 * h * scale;
        const maxLen = 1.0 * h * scale;
        const radiusRatio = 0.18;

        // Buffers
        const positions = [];
        const normals = [];
        const colors = [];
        const pushTri = (a, b, c, col) => {
            positions.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
            const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
            const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
            let nx0 = uy * vz - uz * vy, ny0 = uz * vx - ux * vz, nz0 = ux * vy - uy * vx;
            const L = Math.hypot(nx0, ny0, nz0) || 1; nx0 /= L; ny0 /= L; nz0 /= L;
            for (let t = 0; t < 3; t++) {
                normals.push(nx0, ny0, nz0);
                colors.push(col[0] * 255, col[1] * 255, col[2] * 255, (col.length > 3 ? col[3] : 1));
            }
        };

        let placed = 0;
        for (let k = 0; k < nz; k += stride) {
            for (let j = 0; j < ny; j += stride) {
                for (let i = 0; i < nx; i += stride) {
                    const id3 = (i + j * nx + k * nx * ny) * 3;
                    const vx = vectors[id3], vy = vectors[id3 + 1], vz = vectors[id3 + 2];
                    const spd = Math.hypot(vx, vy, vz);
                    if (!isFinite(spd) || spd <= 0) continue;
                    // voxel center position
                    const px = origin[0] + i * spacing[0];
                    const py = origin[1] + j * spacing[1];
                    const pz = origin[2] + k * spacing[2];
                    const posW = rotP([px, py, pz]);
                    const dirW = rotV([vx, vy, vz]);
                    let t = (spd - minV) * inv; if (reverse) t = 1 - t; t = Math.max(0, Math.min(1, t));
                    const col = map(t);
                    const posL = [posW[0] - cx, posW[1] - cy, posW[2] - cz];
                    const dlen = Math.hypot(dirW[0], dirW[1], dirW[2]);
                    if (dlen <= 1e-8) continue;
                    const dn = [dirW[0] / dlen, dirW[1] / dlen, dirW[2] / dlen];
                    const ref = (Math.abs(dn[1]) < 0.999) ? [0, 1, 0] : [1, 0, 0];
                    let Xx = ref[1] * dn[2] - ref[2] * dn[1];
                    let Xy = ref[2] * dn[0] - ref[0] * dn[2];
                    let Xz = ref[0] * dn[1] - ref[1] * dn[0];
                    let XL = Math.hypot(Xx, Xy, Xz) || 1; Xx /= XL; Xy /= XL; Xz /= XL;
                    let Zx = dn[1] * Xz - dn[2] * Xy;
                    let Zy = dn[2] * Xx - dn[0] * Xz;
                    let Zz = dn[0] * Xy - dn[1] * Xx;
                    const len = Math.max(minLen, Math.min(maxLen, t * (maxLen - minLen) + minLen));
                    const radius = Math.max(0.05 * h * scale, len * radiusRatio);
                    const b0 = [posL[0] + (-radius) * Xx + (-radius) * Zx, posL[1] + 0, posL[2] + (-radius) * Xz + (-radius) * Zz];
                    const b1 = [posL[0] + (+radius) * Xx + (-radius) * Zx, posL[1] + 0, posL[2] + (+radius) * Xz + (-radius) * Zz];
                    const b2 = [posL[0] + (+radius) * Xx + (+radius) * Zx, posL[1] + 0, posL[2] + (+radius) * Xz + (+radius) * Zz];
                    const b3 = [posL[0] + (-radius) * Xx + (+radius) * Zx, posL[1] + 0, posL[2] + (-radius) * Xz + (+radius) * Zz];
                    const tip = [posL[0] + dn[0] * len, posL[1] + dn[1] * len, posL[2] + dn[2] * len];
                    pushTri(b0, b1, tip, col);
                    pushTri(b1, b2, tip, col);
                    pushTri(b2, b3, tip, col);
                    pushTri(b3, b0, tip, col);
                    pushTri(b0, b2, b1, col);
                    pushTri(b0, b3, b2, col);
                    placed++;
                }
            }
        }

        // Build mesh and attach to glyph node
        const mesh = pc.createMesh(app.graphicsDevice, positions, {normals, colors});
        const e = rec.entity;
        let glyphNode = null;
        for (let i = 0; i < e.children.length; i++) {
            const c = e.children[i];
            if (!c || !c.render || !c.render.meshInstances || !c.render.meshInstances[0]) continue;
            const mi = c.render.meshInstances[0];
            const isStandard = (mi.material instanceof pc.StandardMaterial);
            if ((c.name && /Glyphs/i.test(c.name)) || !isStandard) { glyphNode = c; break; }
        }
        if (!glyphNode) return;
        const mi = glyphNode.render.meshInstances[0];
        mi.mesh = mesh;
        // refresh opacity parameter on shader material
        try {
            const a = Math.max(0, Math.min(1, Number((m.colorParams && m.colorParams.opacity) ?? 1)));
            if (typeof mi.material.setParameter === 'function') mi.material.setParameter('uOpacity', a);
            mi.material.blendType = (a < 1) ? pc.BLEND_NORMAL : pc.BLEND_NONE;
            mi.material.update && mi.material.update();
        } catch (_) { /* ignore */ }

        // Update meta info
        m.count = placed;
        m.triCount = (positions.length / 9) | 0;
        m.scalarStats = {min: smin, max: smax, median: (smin + smax) * 0.5, name: 'speed'};
        if (data.get('selectedId') === id) updateSelectedInspector();
        console.log(`[VTK] Glyphs regenerated: tris=${m.triCount}, glyphs=${placed}, stride=${stride}`);
    } catch (e) {
        console.error('regenerateVTKGlyphsById failed:', e);
    }
};

api.recolorWindStreamlinesById = (id) => {
    try {
        const rec = registry.get(id);
        if (!rec) return;
        const m = rec.meta;
        if (!m) return;
        if (m.kind === 'scalar-slice') {
            api.recolorScalarSliceById(id);
            return;
        }
        if (m.kind !== 'wind-streamlines') return;
        const e = rec.entity;
        /** @type {any} */ const meshNode = /** @type {any} */ (e._meshChild || e);
        if (!meshNode || !meshNode.render || !meshNode.render.meshInstances || !meshNode.render.meshInstances[0]) return;
        const mi = meshNode.render.meshInstances[0];
        const gd = app.graphicsDevice;
        const positions = Array.from(m.positions || []);
        const normals = Array.from(m.normals || []);
        const colors = Array.from(computeWindColors(m));
        const uvs = m._uvs ? Array.from(m._uvs) : undefined;
        const mesh = pc.createMesh(gd, positions, {normals, colors, uvs});
        mi.mesh = mesh;
        // refresh material with updated settings
        mi.material = buildWindMaterial(m);
        if (data.get('selectedId') === id) updateSelectedInspector();
        console.log('[VTK] 색상 갱신 완료 for id=', id);
    } catch (e) {
        console.error('recolorWindStreamlinesById failed:', e);
    }
};

// ---- Animation controls ----
api.setWindAnimationById = (id, params) => {
    try {
        const rec = registry.get(id);
        if (!rec) return;
        const m = rec.meta;
        if (!m || m.kind !== 'wind-streamlines') return;
        m.anim = {...(m.anim || {style: 'off'}), ...(params || {})};
        // apply material changes immediately
        const e = rec.entity;
        /** @type {any} */ const meshNode = /** @type {any} */ (e._meshChild || e);
        if (meshNode && meshNode.render && meshNode.render.meshInstances && meshNode.render.meshInstances[0]) {
            const mi = meshNode.render.meshInstances[0];
            mi.material = buildWindMaterial(m);
        }
        if (data.get('selectedId') === id) updateSelectedInspector();
    } catch (e) {
        console.error('setWindAnimationById failed:', e);
    }
};

// Drive animation per-frame
app.on('update', (dt) => {
    try {
        registry.forEach((rec) => {
            if (!rec || rec.type !== 'mesh-import') return;
            const m = rec.meta;
            if (!m || m.kind !== 'wind-streamlines') return;
            const anim = m.anim;
            if (!anim || anim.style === 'off' || !anim.playing) return;
            const e = rec.entity;
            /** @type {any} */ const meshNode = /** @type {any} */ (e._meshChild || e);
            if (!meshNode || !meshNode.render || !meshNode.render.meshInstances || !meshNode.render.meshInstances[0]) return;
            const mi = meshNode.render.meshInstances[0];
            const mat = mi.material;
            if (!mat) return;
            if (anim.style === 'head') {
                anim._t = (anim._t + dt * (anim.speed || 0.25)) % 1.0;
                mat.setParameter('uHead', anim._t);
                mat.setParameter('uTrail', anim.trail || 0.08);
            } else if (anim.style === 'pingpong') {
                const sp = anim.speed || 0.25;
                anim._t += dt * sp * (anim._dir || 1);
                if (anim._t > 1) {
                    anim._t = 1;
                    anim._dir = -1;
                }
                if (anim._t < 0) {
                    anim._t = 0;
                    anim._dir = 1;
                }
                mat.setParameter('uHead', anim._t);
                mat.setParameter('uTrail', anim.trail || 0.08);
            } else if (anim.style === 'dashes') {
                anim._t = (anim._t + dt * (anim.speed || 0.5)) % 1.0;
                mat.setParameter('uMove', anim._t);
                mat.setParameter('uRepeat', anim.repeat || 6);
                mat.setParameter('uFeather', anim.feather || 0.12);
            }
        });
    } catch (_) {
    }
});

// Auto-regenerate scalar slice when its handles move (throttled)
app.on('update', (dt) => {
    try {
        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        registry.forEach((rec) => {
            if (!rec || rec.type !== 'mesh-import') return;
            const m = rec.meta;
            if (!m || m.kind !== 'scalar-slice') return;
            const handles = (m.handles || []).map(hid => registry.get(hid)).filter(Boolean);
            if (handles.length < 3) return;
            const last = m._lastHandlePositions || [];
            let moved = false;
            for (let i = 0; i < 3; i++) {
                const p = handles[i].entity.getLocalPosition();
                const lp = last[i];
                if (!lp || Math.hypot(p.x - (lp[0] || 0), p.y - (lp[1] || 0), p.z - (lp[2] || 0)) > 1e-3) {
                    moved = true;
                }
            }
            if (moved) {
                m._lastHandlePositions = handles.map(h => {
                    const p = h.entity.getLocalPosition();
                    return [p.x, p.y, p.z];
                });
                const lastT = m._lastSliceUpdateT || 0;
                if (now - lastT > 160) { // ~6 fps while dragging
                    m._lastSliceUpdateT = now;
                    api.regenerateScalarSliceById(rec.id);
                }
            }
        });
    } catch (_) {
    }
});

// Mount UI (React + PCUI)
// 1) Top overlay for application menu (mount to viewport-only overlay first)
let rootEl = document.getElementById('viewport-ui-react')
    || document.getElementById('viewport-ui')
    || document.getElementById('ui-root');
if (rootEl) {
    const root = createRoot(rootEl);
    // Plan A: do not pass ReactPCUI; controls() will run in fallback/core mode
    root.render(React.createElement(controls, {observer: data, React, jsx, fragment, variant: 'top'}));
}
// 2) Right docked sidebar for Objects list/inspector
const sidebarEl = document.getElementById('sidebar-root');
if (sidebarEl) {
    const sroot = createRoot(sidebarEl);
    // Plan A: do not pass ReactPCUI; controls() will run in fallback/core mode
    sroot.render(React.createElement(controls, {observer: data, React, jsx, fragment, variant: 'sidebar'}));
}

// Export app if needed (debug)
export {app};
