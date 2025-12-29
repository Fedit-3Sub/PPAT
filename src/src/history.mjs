// Simple history manager for undo/redo of editor actions

class HistoryManager {
    /** @param {(state:{canUndo:boolean, canRedo:boolean, undoLabel:string, redoLabel:string})=>void} [onChange] */
    constructor(onChange) {
        this._undo = [];
        this._redo = [];
        this._limit = 200;
        this._onChange = typeof onChange === 'function' ? onChange : null;
    }

    /** @returns {boolean} */ get canUndo() { return this._undo.length > 0; }
    /** @returns {boolean} */ get canRedo() { return this._redo.length > 0; }
    /** @returns {string} */ get undoLabel() { return this._undo.length ? (this._undo[this._undo.length - 1].label || '') : ''; }
    /** @returns {string} */ get redoLabel() { return this._redo.length ? (this._redo[this._redo.length - 1].label || '') : ''; }

    _notify() {
        if (this._onChange) {
            this._onChange({ canUndo: this.canUndo, canRedo: this.canRedo, undoLabel: this.undoLabel, redoLabel: this.redoLabel });
        }
    }

    /**
     * Commit an action to history.
     * @param {{label:string, undo:()=>void, redo:()=>void}} action
     */
    commit(action) {
        if (!action || typeof action.undo !== 'function' || typeof action.redo !== 'function') return;
        this._undo.push(action);
        // cap
        if (this._undo.length > this._limit) this._undo.shift();
        // new action clears redo stack
        this._redo.length = 0;
        this._notify();
    }

    undo() {
        if (!this.canUndo) return;
        const act = this._undo.pop();
        try { act.undo(); } finally {
            this._redo.push(act);
            this._notify();
        }
    }

    redo() {
        if (!this.canRedo) return;
        const act = this._redo.pop();
        try { act.redo(); } finally {
            this._undo.push(act);
            this._notify();
        }
    }
}

export { HistoryManager };
