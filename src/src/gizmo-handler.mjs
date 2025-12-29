import * as pc from 'playcanvas';

class GizmoHandler {
    /** @type {string} */
    _type = 'translate';

    /** @type {Record<string, pc.TransformGizmo>} */
    _gizmos;

    /** @type {pc.GraphNode[]} */
    _nodes = [];

    /**
     * @param {pc.CameraComponent} camera - The camera component.
     */
    constructor(camera) {
        const app = camera.system.app;
        const layer = pc.Gizmo.createLayer(app);
        this._gizmos = {
            translate: new pc.TranslateGizmo(camera, layer),
            rotate: new pc.RotateGizmo(camera, layer),
            scale: new pc.ScaleGizmo(camera, layer)
        };

        for (const type in this._gizmos) {
            const gizmo = this._gizmos[type];
            gizmo.on('pointer:down', (_x, _y, /** @type {pc.MeshInstance} */ meshInstance) => {
                app.fire('gizmo:pointer', !!meshInstance);
            });
            gizmo.on('pointer:up', () => {
                app.fire('gizmo:pointer', false);
            });
        }
    }

    get type() {
        return this._type;
    }

    get gizmo() {
        return this._gizmos[this._type];
    }

    set size(value) {
        for (const type in this._gizmos) {
            this._gizmos[type].size = value;
        }
    }

    get size() {
        return this.gizmo.size;
    }

    /**
     * Adds single node to active gizmo.
     * @param {pc.GraphNode} node - The node to add.
     * @param {boolean} [clear=false] - To clear the node array.
     */
    add(node, clear = false) {
        if (clear) {
            this._nodes.length = 0;
        }
        if (this._nodes.indexOf(node) === -1) {
            this._nodes.push(node);
        }
        this.gizmo.attach(this._nodes);
    }

    /** Clear all nodes. */
    clear() {
        this._nodes.length = 0;
        this.gizmo.detach();
    }

    /**
     * Switches between gizmo types
     * @param {string} type - The transform gizmo type.
     */
    switch(type) {
        this.gizmo.detach();
        const coordSpace = this.gizmo.coordSpace;
        this._type = type ?? 'translate';
        this.gizmo.attach(this._nodes);
        this.gizmo.coordSpace = coordSpace;
    }

    destroy() {
        for (const type in this._gizmos) {
            this._gizmos[type].destroy();
        }
    }
}

export { GizmoHandler };
