import * as pc from 'playcanvas';

const EPSILON = 1;
class Selector extends pc.EventHandler {
    /** @type {pc.CameraComponent} */
    _camera;
    /** @type {pc.Scene} */
    _scene;
    /** @type {pc.Picker} */
    _picker;
    /** @type {HTMLCanvasElement} */
    _canvas;
    /** @type {pc.Layer[]} */
    _layers;
    /** @type {pc.Vec2} */
    _start = new pc.Vec2();
    /** @type {boolean} */
    _uiPointerDown = false;

    /**
     * @param {pc.AppBase} app - The app.
     * @param {pc.CameraComponent} camera - The camera to pick from.
     * @param {pc.Layer[]} [layers] - The layers to pick from.
     */
    constructor(app, camera, layers = []) {
        super();
        this._camera = camera;
        this._scene = app.scene;
        const device = app.graphicsDevice;
        this._picker = new pc.Picker(app, device.canvas.width, device.canvas.height);
        this._canvas = device.canvas;
        this._layers = layers;

        this._onPointerDown = this._onPointerDown.bind(this);
        this._onPointerUp = this._onPointerUp.bind(this);

        this.bind();
    }

    /** @param {MouseEvent} e */
    _onPointerDown(e) {
        // If pointer down started on UI (top menu or interactive overlays like ViewCube), mark and ignore on release
        try {
            const target = /** @type {any} */(e.target);
            const isUI = !!(target && typeof target.closest === 'function' && (target.closest('.se9-topmenu') || target.closest('[data-interactive="1"]')));
            this._uiPointerDown = isUI;
        } catch (_) {
            this._uiPointerDown = false;
        }
        this._start.set(e.clientX, e.clientY);
    }

    /** @param {MouseEvent} e */
    async _onPointerUp(e) {
        // Ignore clicks that originated from UI (e.g., toolbar buttons)
        if (this._uiPointerDown) {
            this._uiPointerDown = false;
            return;
        }
        if (Math.abs(e.clientX - this._start.x) > EPSILON || Math.abs(e.clientY - this._start.y) > EPSILON) {
            return;
        }

        const device = this._picker.device;
        const canvas = device.canvas;
        // Ensure picker render target matches device pixel resolution
        this._picker.resize(canvas.width, canvas.height);
        this._picker.prepare(this._camera, this._scene, this._layers);

        // Convert window coordinates to canvas space, accounting for CSS scaling and DPI
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const x = Math.floor((e.clientX - rect.left) * scaleX);
        const y = Math.floor((e.clientY - rect.top) * scaleY);

        const selection = await this._picker.getSelectionAsync(x - 1, y - 1, 2, 2);

        if (!selection[0]) {
            this.fire('deselect');
            return;
        }

        this.fire('select', selection[0].node, !e.ctrlKey && !e.metaKey);
    }

    bind() {
        // Listen on the PlayCanvas canvas only. This prevents UI clicks outside
        // the viewport (e.g., right inspector/sidebar) from triggering selection
        // logic and accidentally clearing the selection.
        this._canvas.addEventListener('pointerdown', this._onPointerDown);
        this._canvas.addEventListener('pointerup', this._onPointerUp);
    }

    unbind() {
        this._canvas.removeEventListener('pointerdown', this._onPointerDown);
        this._canvas.removeEventListener('pointerup', this._onPointerUp);
    }

    destroy() {
        this.unbind();
    }
}

export { Selector };
