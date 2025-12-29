import * as pc from 'playcanvas';
import * as PCUI from '@playcanvas/pcui';

/**
 * @param {import('./types').ControlOptions|any} options - The options.
 * @returns {JSX.Element} The returned JSX Element.
 */
export const controls = ({observer, ReactPCUI, React, jsx, fragment, variant}) => {
    // Plan A: Do NOT rely on PCUI React wrapper. Provide a safe stub for BindingTwoWay so
    // existing calls `new BindingTwoWay()` do not crash and are ignored by our fallbacks.
    const BindingTwoWay = (ReactPCUI && ReactPCUI.BindingTwoWay) || function BindingTwoWay() {
    };
    const {useState, useEffect, useRef} = React;

    // --------- Error Boundary to prevent full UI crash and surface details ---------
    // guard to prevent recursive console/state updates from ErrorBoundary
    let __ebPushing = false;

    class ErrorBoundary extends React.Component {
        constructor(props) {
            super(props);
            this.state = {hasError: false, error: null, info: null};
        }

        static getDerivedStateFromError(error) {
            return {hasError: true, error};
        }

        componentDidCatch(error, info) {
            try {
                // Do NOT use console.error here; it is captured by our console shim and can
                // create a feedback loop resulting in "Maximum update depth exceeded".
                if (__ebPushing) return;
                __ebPushing = true;
                const message = `UI Error: ${error?.message || error}` + (info?.componentStack ? `\n${info.componentStack}` : '');
                // push the error asynchronously to avoid nested updates during commit
                setTimeout(() => {
                    try {
                        const list = observer.get('console') || [];
                        list.push({level: 'error', msg: message, time: Date.now(), from: 'UI_EB'});
                        while (list.length > 200) list.shift();
                        observer.set('console', list);
                    } catch (_) { /* ignore */
                    } finally {
                        __ebPushing = false;
                    }
                }, 0);
            } catch (_) {
                __ebPushing = false;
            }
        }

        render() {
            if (this.state?.hasError) {
                return jsx('div', {
                    style: {
                        position: 'absolute', left: '8px', right: '8px', top: '8px',
                        background: '#5a1a1a', color: '#fff', padding: '8px', borderRadius: '4px',
                        zIndex: 1000, pointerEvents: 'auto'
                    }
                }, `UI Error: ${String(this.state?.error?.message || 'Unknown')}`);
            }
            return this.props.children;
        }
    }

    // Log mode once. In Plan A, ReactPCUI is disabled and we run via HTML/core fallbacks.
    // IMPORTANT: Do NOT call console.* synchronously during render — our console shim
    // mirrors logs into the in‑app console via observer.set(...), which will trigger
    // React state updates. Deferring logs avoids the React warning:
    // "Cannot update a component while rendering a different component".
    const deferredConsole = {
        log: (...args) => {
            try {
                setTimeout(() => {
                    try {
                        console.log(...args);
                    } catch (_) {
                    }
                }, 0);
            } catch (_) {
            }
        },
        warn: (...args) => {
            try {
                setTimeout(() => {
                    try {
                        console.warn(...args);
                    } catch (_) {
                    }
                }, 0);
            } catch (_) {
            }
        },
        error: (...args) => {
            try {
                setTimeout(() => {
                    try {
                        console.error(...args);
                    } catch (_) {
                    }
                }, 0);
            } catch (_) {
            }
        }
    };
    try {
        if (!window.__pcuiReactLogged) {
            window.__pcuiReactLogged = true;
            if (ReactPCUI) {
                const keys = Object.keys(ReactPCUI || {});
                deferredConsole.log('[PCUI React] exports:', keys.sort().join(', '));
                const expected = ['LabelGroup', 'Panel', 'SliderInput', 'SelectInput', 'ColorPicker', 'Button', 'Container', 'TextInput', 'VectorInput', 'Code'];
                const missing = expected.filter(k => !ReactPCUI || !ReactPCUI[k]);
                if (missing.length) deferredConsole.warn('[PCUI React] Missing components at runtime:', missing);
            } else {
                deferredConsole.log('[PCUI React] disabled: Plan A (core DOM / HTML fallbacks)');
            }
        }
    } catch (e) { /* ignore */
    }

    // ---------- Safe component resolver (native PCUI first, auto-fallback per-component) ----------
    // Dev toggle: force using HTML fallbacks to avoid PCUI internals if needed.
    // window.__PCUI_FORCE_FALLBACKS = true  -> always use HTML fallbacks
    // window.__PCUI_USE_PANEL = false       -> only Panel uses fallback (others native)
    // Plan A: 기본값을 true로 전환 — React 래퍼를 전혀 사용하지 않고 안전한 HTML/어댑터 경로만 사용
    // 필요 시 DevTools에서 window.__PCUI_FORCE_FALLBACKS = false 로 바꿔 시험 가능
    const FORCE_FALLBACKS = (typeof window !== 'undefined' && window.__PCUI_FORCE_FALLBACKS !== undefined)
        ? !!window.__PCUI_FORCE_FALLBACKS
        : true;

    // React element type 유효성 체크 (function/string 외에 forwardRef/memo 도 허용)
    const REACT_FORWARD_REF_TYPE = (typeof Symbol !== 'undefined' && Symbol.for) ? Symbol.for('react.forward_ref') : undefined;
    const REACT_MEMO_TYPE = (typeof Symbol !== 'undefined' && Symbol.for) ? Symbol.for('react.memo') : undefined;
    const isValidReactType = (t) => {
        if (!t) return false;
        const ty = typeof t;
        if (ty === 'string' || ty === 'function') return true;
        if (ty === 'object') {
            const tag = t.$$typeof;
            return tag === REACT_FORWARD_REF_TYPE || tag === REACT_MEMO_TYPE;
        }
        return false;
    };
    const warnedFallbacks = (typeof window !== 'undefined' && (window.__PCUI_WARNED = window.__PCUI_WARNED || {})) || {};

    const shouldUseFallback = (name, nativeComp) => {
        if (FORCE_FALLBACKS) return true;
        const flagName = `__PCUI_USE_${String(name).toUpperCase()}`;
        const perFlag = (typeof window !== 'undefined') ? window[flagName] : undefined;
        if (perFlag === false) return true; // explicitly disabled
        return !isValidReactType(nativeComp);
    };

    const resolveComponent = (name, nativeComp, fallbackRender) => {
        return (props) => {
            if (shouldUseFallback(name, nativeComp)) {
                if (!warnedFallbacks[name]) {
                    warnedFallbacks[name] = true;
                    // Defer logging to avoid state updates during render
                    deferredConsole.warn(`[PCUI React] Using fallback for ${name}`);
                }
                return fallbackRender(props);
            }
            // Use native PCUI React component (defensive: 실패 시 자동으로 fallback)
            try {
                const children = props?.children;
                return jsx(nativeComp, props, children);
            } catch (err) {
                try {
                    deferredConsole.warn(`[PCUI React] Failed to render ${name} natively. Falling back.`, err);
                } catch (_) {
                }
                return fallbackRender(props);
            }
        };
    };

    // Helpers for fallbacks that use Observer link
    const linkGet = (props) => {
        const link = props?.link;
        if (link && link.observer && link.path) return link.observer.get(link.path);
        return props?.value;
    };
    const linkSet = (props, value) => {
        const link = props?.link;
        if (link && link.observer && link.path) link.observer.set(link.path, value);
        if (typeof props?.onChange === 'function') props.onChange(value);
        if (typeof props?.onSelect === 'function') props.onSelect(value);
    };

    // PCUI Core DOM adapter: Panel (no React wrapper)
    const PanelCore = ({headerText, collapsible, style, className, children}) => {
        const rootRef = useRef(null);
        const contentRef = useRef(null);
        const panelRef = useRef(null);

        // create once
        useEffect(() => {
            const root = rootRef.current;
            const content = contentRef.current;
            if (!root || !content) return;
            // Ensure wrapper stretches so children can size to Split panes
            try {
                root.style.height = '100%';
                root.style.width = '100%';
                root.style.display = 'flex';
                root.style.flexDirection = 'column';
                // allow flex children to shrink properly inside Split areas
                root.style.minHeight = '0';
            } catch (_) { /* ignore */
            }
            // Ensure the content host can stretch to fill available height
            try {
                content.style.height = '100%';
                content.style.width = '100%';
                // scroll only the content area, not the header
                content.style.overflow = 'auto';
                content.style.minHeight = '0';
            } catch (_) { /* ignore */
            }
            // Create PCUI core Panel using provided content DOM node
            const panel = new PCUI.Panel({
                headerText: headerText || '',
                collapsible: !!collapsible,
                content
            });
            panelRef.current = panel;
            try {
                // mount panel DOM into root
                const dom = panel.dom ? panel.dom : (panel.dom && panel.dom());
                // Element.dom() returns HTMLElement; both patterns guarded
                const el = dom instanceof HTMLElement ? dom : panel.dom?.();
                if (el) root.appendChild(el);
            } catch (_) { /* ignore */
            }

            return () => {
                try {
                    panel.destroy && panel.destroy();
                } catch (_) { /* ignore */
                }
                panelRef.current = null;
                // contentRef will be removed/detached by destroy; ensure root is cleared
                try {
                    if (root) root.textContent = '';
                } catch (_) { /* ignore */
                }
            };
        }, []);

        // sync props
        useEffect(() => {
            const panel = panelRef.current;
            if (!panel) return;
            try {
                panel.headerText = headerText || '';
            } catch (_) { /* ignore */
            }
        }, [headerText]);
        useEffect(() => {
            const panel = panelRef.current;
            if (!panel) return;
            try {
                panel.collapsible = !!collapsible;
            } catch (_) { /* ignore */
            }
        }, [collapsible]);
        useEffect(() => {
            const panel = panelRef.current;
            if (!panel) return;
            try {
                const dom = panel.dom ? panel.dom : (panel.dom && panel.dom());
                const el = dom instanceof HTMLElement ? dom : panel.dom?.();
                if (el) {
                    // reset class to include pcui defaults and user className
                    if (className) el.classList.add(...String(className).split(/\s+/).filter(Boolean));
                    if (style && typeof style === 'object') Object.assign(el.style, style);
                }
            } catch (_) { /* ignore */
            }
        }, [style, className]);

        // Render placeholder root + content host with React children
        // PCUI Panel will adopt the contentRef element as its content container.
        return jsx('div', {ref: rootRef}, jsx('div', {ref: contentRef}, children));
    };

    // Fallback renderers
    const FallbackPanel = (props) => jsx(PanelCore, props);
    // PCUI Core DOM adapter: Container
    const ContainerCore = ({style, className, children, scrollable, resizable}) => {
        const rootRef = useRef(null);
        const hostRef = useRef(null);
        const contRef = useRef(null);

        useEffect(() => {
            const root = rootRef.current;
            const host = hostRef.current;
            if (!root || !host) return;
            const cont = new PCUI.Container({});
            contRef.current = cont;
            try {
                // direct DOM for content area
                if (cont.domContent) cont.domContent(host);
                const dom = cont.dom ? cont.dom : (cont.dom && cont.dom());
                const el = dom instanceof HTMLElement ? dom : cont.dom?.();
                if (el) root.appendChild(el);
                // Make internal host take full size so Split.js percentages work even with empty content
                host.style.height = '100%';
                host.style.width = '100%';
                host.style.display = 'flex';
                host.style.flexDirection = 'column';
            } catch (_) { /* ignore */
            }
            return () => {
                try {
                    cont.destroy && cont.destroy();
                } catch (_) { /* ignore */
                }
                contRef.current = null;
                try {
                    if (root) root.textContent = '';
                } catch (_) { /* ignore */
                }
            };
        }, []);

        useEffect(() => {
            const cont = contRef.current;
            if (!cont) return;
            try {
                const dom = cont.dom ? cont.dom : (cont.dom && cont.dom());
                const el = dom instanceof HTMLElement ? dom : cont.dom?.();
                if (el) {
                    if (className) el.classList.add(...String(className).split(/\s+/).filter(Boolean));
                    if (style && typeof style === 'object') Object.assign(el.style, style);
                }
                if (typeof scrollable === 'boolean' && cont.scrollable) cont.scrollable(!!scrollable);
                if (typeof resizable === 'boolean' && cont.resizable) cont.resizable(!!resizable);
            } catch (_) { /* ignore */
            }
        }, [style, className, scrollable, resizable]);

        // Ensure the outer wrapper participates in height calculations so that
        // vertical Split.js in the sidebar can compute sizes correctly.
        // Without an explicit 100% height here, ancestors may resolve to fit-content
        // and the splitter won't move.
        return jsx(
            'div',
            {
                ref: rootRef,
                style: {height: '100%', width: '100%', display: 'flex', flexDirection: 'column', minHeight: 0}
            },
            jsx('div', {ref: hostRef}, children)
        );
    };

    const FallbackContainer = (props) => jsx(ContainerCore, props);
    const FallbackButton = (props) => {
        const {text, title, onClick, style, className, children} = props || {};
        return jsx(
            'button',
            {
                onClick,
                title,
                className,
                style: {
                    padding: '6px 10px',
                    marginRight: '6px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center', ...style
                }
            },
            children || text || 'Button'
        );
    };
    // PCUI Core DOM adapter: LabelGroup (uses PCUI.LabelGroup + PCUI.Element field bridge)
    const LabelGroupCore = ({text, style, className, children, labelAlignTop, nativeTooltip}) => {
        const rootRef = useRef(null);
        const fieldHostRef = useRef(null);
        const groupRef = useRef(null);
        const fieldElRef = useRef(null);

        useEffect(() => {
            const root = rootRef.current;
            const host = fieldHostRef.current;
            if (!root || !host) return;
            // bridge: create a generic Element to act as the field; mount our host into its DOM
            const fieldEl = new PCUI.Element({});
            fieldElRef.current = fieldEl;
            try {
                const fd = fieldEl.dom ? fieldEl.dom : (fieldEl.dom && fieldEl.dom());
                const fdom = fd instanceof HTMLElement ? fd : fieldEl.dom?.();
                if (fdom) {
                    // ensure fdom contains host where React children are rendered
                    fdom.appendChild(host);
                }
            } catch (_) { /* ignore */
            }

            const group = new PCUI.LabelGroup({
                text: text || '',
                field: fieldEl,
                labelAlignTop: !!labelAlignTop,
                nativeTooltip: !!nativeTooltip
            });
            groupRef.current = group;
            try {
                const dom = group.dom ? group.dom : (group.dom && group.dom());
                const el = dom instanceof HTMLElement ? dom : group.dom?.();
                if (el) root.appendChild(el);
            } catch (_) { /* ignore */
            }
            return () => {
                try {
                    group.destroy && group.destroy();
                } catch (_) { /* ignore */
                }
                try {
                    fieldEl.destroy && fieldEl.destroy();
                } catch (_) { /* ignore */
                }
                groupRef.current = null;
                fieldElRef.current = null;
                try {
                    if (root) root.textContent = '';
                } catch (_) { /* ignore */
                }
            };
        }, []);

        useEffect(() => {
            const group = groupRef.current;
            if (!group) return;
            try {
                group.text = text || '';
            } catch (_) { /* ignore */
            }
        }, [text]);

        useEffect(() => {
            const group = groupRef.current;
            if (!group) return;
            try {
                const dom = group.dom ? group.dom : (group.dom && group.dom());
                const el = dom instanceof HTMLElement ? dom : group.dom?.();
                if (el) {
                    if (className) el.classList.add(...String(className).split(/\s+/).filter(Boolean));
                    if (style && typeof style === 'object') Object.assign(el.style, style);
                }
            } catch (_) { /* ignore */
            }
        }, [style, className]);

        return jsx('div', {ref: rootRef}, jsx('div', {ref: fieldHostRef}, children));
    };

    const FallbackLabelGroup = (props) => jsx(LabelGroupCore, props);
    // Utilities for core input adapters
    const ensureDom = (el) => {
        if (!el) return null;
        try {
            const dom = el.dom ? el.dom : (el.dom && el.dom());
            return dom instanceof HTMLElement ? dom : el.dom?.();
        } catch (_) {
            return null;
        }
    };
    const attachChange = (el, handler) => {
        try {
            el.on && el.on('change', handler);
        } catch (_) {
        }
        try {
            el.on && el.on('select', handler);
        } catch (_) {
        }
        try {
            el.on && el.on('input', handler);
        } catch (_) {
        }
    };

    // TextInput adapter
    const TextInputCore = (props) => {
        const rootRef = useRef(null);
        const inputRef = useRef(null);
        // create
        useEffect(() => {
            const root = rootRef.current;
            if (!root) return;
            const input = new PCUI.TextInput({});
            inputRef.current = input;
            const el = ensureDom(input);
            if (el) root.appendChild(el);
            // disabled/enabled
            try {
                if (props && props.enabled === false && input.enabled) input.enabled(false);
            } catch (_) {
            }
            attachChange(input, () => {
                try {
                    linkSet(props, input.value);
                } catch (_) {
                }
            });
            return () => {
                try {
                    input.destroy && input.destroy();
                } catch (_) {
                }
                inputRef.current = null;
                if (root) root.textContent = '';
            };
        }, []);
        // sync value from observer/props
        const v = linkGet(props) ?? '';
        useEffect(() => {
            const input = inputRef.current;
            if (input) {
                try {
                    input.value = String(v);
                } catch (_) {
                }
            }
        }, [v]);
        return jsx('div', {ref: rootRef});
    };

    // SelectInput adapter
    const SelectInputCore = (props) => {
        const rootRef = useRef(null);
        const selRef = useRef(null);
        useEffect(() => {
            const root = rootRef.current;
            if (!root) return;
            const sel = new PCUI.SelectInput({});
            selRef.current = sel;
            const el = ensureDom(sel);
            if (el) root.appendChild(el);
            attachChange(sel, () => {
                try {
                    linkSet(props, sel.value);
                } catch (_) {
                }
            });
            return () => {
                try {
                    sel.destroy && sel.destroy();
                } catch (_) {
                }
                selRef.current = null;
                if (root) root.textContent = '';
            };
        }, []);
        // sync options and value
        const opts = props?.options || [];
        const v = linkGet(props);
        useEffect(() => {
            const sel = selRef.current;
            if (!sel) return;
            try {
                sel.options = opts;
            } catch (_) {
            }
        }, [opts]);
        useEffect(() => {
            const sel = selRef.current;
            if (!sel) return;
            try {
                sel.value = v;
            } catch (_) {
            }
        }, [v]);
        return jsx('div', {ref: rootRef});
    };

    // SliderInput adapter
    const SliderInputCore = (props) => {
        const rootRef = useRef(null);
        const sRef = useRef(null);
        useEffect(() => {
            const root = rootRef.current;
            if (!root) return;
            const slider = new PCUI.SliderInput({
                min: props?.min ?? 0,
                max: props?.max ?? 100,
                precision: props?.precision
            });
            sRef.current = slider;
            const el = ensureDom(slider);
            if (el) root.appendChild(el);
            attachChange(slider, () => {
                try {
                    linkSet(props, slider.value);
                } catch (_) {
                }
            });
            return () => {
                try {
                    slider.destroy && slider.destroy();
                } catch (_) {
                }
                sRef.current = null;
                if (root) root.textContent = '';
            };
        }, []);
        const v = Number(linkGet(props) ?? 0);
        useEffect(() => {
            const s = sRef.current;
            if (!s) return;
            try {
                s.min = props?.min ?? s.min;
                s.max = props?.max ?? s.max;
                if (props?.precision !== undefined) s.precision = props.precision;
            } catch (_) {
            }
        }, [props?.min, props?.max, props?.precision]);
        useEffect(() => {
            const s = sRef.current;
            if (!s) return;
            try {
                s.value = v;
            } catch (_) {
            }
        }, [v]);
        return jsx('div', {ref: rootRef});
    };

    // ColorPicker adapter (expects [r,g,b] in 0..1). If PCUI.ColorPicker is not available,
    // fall back to a native <input type="color"> to avoid runtime crashes when opening Inspector.
    const ColorPickerCore = (props) => {
        const rootRef = useRef(null);
        const pcuiRef = useRef(null);
        const htmlRef = useRef(null);
        const useHtmlFallback = !(PCUI && PCUI.ColorPicker);

        useEffect(() => {
            const root = rootRef.current;
            if (!root) return;
            if (useHtmlFallback) {
                // Native color input fallback
                const input = document.createElement('input');
                input.type = 'color';
                input.style.width = '100%';
                input.style.height = '26px';
                input.style.padding = '0';
                input.style.border = '1px solid rgba(255,255,255,0.12)';
                input.style.background = 'transparent';
                const hexToRgb01 = (hex) => {
                    try {
                        const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '#ffffff');
                        if (!m) return [1, 1, 1];
                        const r = parseInt(m[1], 16) / 255;
                        const g = parseInt(m[2], 16) / 255;
                        const b = parseInt(m[3], 16) / 255;
                        return [r, g, b];
                    } catch (_) {
                        return [1, 1, 1];
                    }
                };
                input.addEventListener('input', () => {
                    try {
                        linkSet(props, hexToRgb01(input.value));
                    } catch (_) {
                    }
                });
                htmlRef.current = input;
                root.appendChild(input);
                return () => {
                    try {
                        input.remove();
                    } catch (_) {
                    }
                    htmlRef.current = null;
                    if (root) root.textContent = '';
                };
            } else {
                // PCUI widget path
                const picker = new PCUI.ColorPicker({});
                pcuiRef.current = picker;
                const el = ensureDom(picker);
                if (el) root.appendChild(el);
                attachChange(picker, () => {
                    try {
                        linkSet(props, picker.value);
                    } catch (_) {
                    }
                });
                return () => {
                    try {
                        picker.destroy && picker.destroy();
                    } catch (_) {
                    }
                    pcuiRef.current = null;
                    if (root) root.textContent = '';
                };
            }
        }, [useHtmlFallback]);

        // Sync value from observer/props
        const arr = linkGet(props) || [1, 1, 1];
        useEffect(() => {
            if (useHtmlFallback) {
                const el = htmlRef.current;
                if (!el) return;
                const toHex = (v) => {
                    const n = Math.max(0, Math.min(255, Math.round((v ?? 1) * 255)));
                    return n.toString(16).padStart(2, '0');
                };
                try {
                    el.value = `#${toHex(arr[0])}${toHex(arr[1])}${toHex(arr[2])}`;
                } catch (_) {
                }
            } else {
                const p = pcuiRef.current;
                if (!p) return;
                try {
                    p.value = arr;
                } catch (_) {
                }
            }
        }, [useHtmlFallback, arr && arr[0], arr && arr[1], arr && arr[2]]);

        return jsx('div', {ref: rootRef});
    };

    // VectorInput adapter (dimensions 2 or 3)
    const VectorInputCore = (props) => {
        const rootRef = useRef(null);
        const vRef = useRef(null);
        const dims = props?.dimensions ?? 3;
        useEffect(() => {
            const root = rootRef.current;
            if (!root) return;
            const vec = new PCUI.VectorInput({dimensions: dims});
            vRef.current = vec;
            const el = ensureDom(vec);
            if (el) root.appendChild(el);
            attachChange(vec, () => {
                try {
                    linkSet(props, vec.value);
                } catch (_) {
                }
            });
            return () => {
                try {
                    vec.destroy && vec.destroy();
                } catch (_) {
                }
                vRef.current = null;
                if (root) root.textContent = '';
            };
        }, [dims]);
        const cur = Array.isArray(linkGet(props)) ? linkGet(props).slice(0, dims) : new Array(dims).fill(0);
        useEffect(() => {
            const v = vRef.current;
            if (!v) return;
            try {
                v.value = cur;
            } catch (_) {
            }
        }, [cur && cur[0], cur && cur[1], cur && cur[2]]);
        return jsx('div', {ref: rootRef});
    };

    const FallbackTextInput = (props) => jsx(TextInputCore, props);
    const FallbackSelect = (props) => jsx(SelectInputCore, props);
    const FallbackSlider = (props) => jsx(SliderInputCore, props);
    const FallbackColor = (props) => jsx(ColorPickerCore, props);
    const FallbackVector = (props) => jsx(VectorInputCore, props);
    const FallbackCode = ({value}) => jsx('pre', {style: {whiteSpace: 'pre-wrap', margin: 0}}, value);

    // TreeView adapter (PCUI Core DOM)
    const TreeViewCore = ({items, selectedId, onSelect, style, className}) => {
        const rootRef = useRef(null);
        const treeRef = useRef(null);
        // id -> TreeViewItem
        const tviByIdRef = useRef(new Map());
        const prevIdsRef = useRef([]);
        const lastScrollSnapshotRef = useRef(null);

        // find nearest scrollable ancestor
        const getScrollParent = (node) => {
            try {
                let p = node && node.parentElement;
                while (p) {
                    const style = window.getComputedStyle(p);
                    const overflowY = style && style.overflowY;
                    if ((overflowY === 'auto' || overflowY === 'scroll') && p.scrollHeight > p.clientHeight) return p;
                    p = p.parentElement;
                }
            } catch (_) {
            }
            return node && node.parentElement;
        };

        const applyAriaAndClasses = (el, isSelected) => {
            try {
                if (!el) return;
                el.setAttribute('role', 'treeitem');
                el.setAttribute('aria-selected', isSelected ? 'true' : 'false');
                // add both common class variants to be safe for CSS hooks
                if (isSelected) {
                    el.classList.add('selected');
                    el.classList.add('pcui-selected');
                    el.classList.add('is-selected');
                } else {
                    el.classList.remove('selected');
                    el.classList.remove('pcui-selected');
                    el.classList.remove('is-selected');
                }
            } catch (_) { /* ignore */
            }
        };

        const buildItems = (tree, list) => {
            tviByIdRef.current.clear();
            try {
                (list || []).forEach((it) => {
                    const tvi = new PCUI.TreeViewItem({text: it && (it.text || it.name || String(it.id))});
                    const dom = ensureDom(tvi);
                    try {
                        if (dom) {
                            if (it && it.title) dom.title = String(it.title);
                            applyAriaAndClasses(dom, selectedId != null && it && it.id === selectedId);
                            // snapshot scroll state if the item is already visible when user starts clicking/touching
                            const snapshot = (ev) => {
                                try {
                                    const parent = getScrollParent(dom);
                                    if (!parent) return;
                                    const pr = parent.getBoundingClientRect();
                                    const ir = dom.getBoundingClientRect();
                                    const fullyVisible = ir.top >= pr.top && ir.bottom <= pr.bottom;
                                    if (fullyVisible) {
                                        lastScrollSnapshotRef.current = {parent, scrollTop: parent.scrollTop};
                                    } else {
                                        lastScrollSnapshotRef.current = null; // let auto-scroll work
                                    }
                                } catch (_) {
                                    lastScrollSnapshotRef.current = null;
                                }
                            };
                            try {
                                dom.addEventListener('mousedown', snapshot, {capture: true});
                            } catch (_) {
                            }
                            try {
                                dom.addEventListener('touchstart', snapshot, {capture: true, passive: true});
                            } catch (_) {
                            }
                        }
                    } catch (_) { /* ignore */
                    }
                    try {
                        // selection callback
                        tvi.on && tvi.on('select', () => {
                            try {
                                // locally reflect selection visuals for reliability in fallback
                                for (const [id, item] of tviByIdRef.current.entries()) {
                                    const el = ensureDom(item);
                                    applyAriaAndClasses(el, id === it.id);
                                }
                            } catch (_) {
                            }
                            // If the clicked item was already visible, restore previous scroll to prevent jump
                            try {
                                const snap = lastScrollSnapshotRef.current;
                                if (snap && snap.parent) {
                                    snap.parent.scrollTop = snap.scrollTop;
                                }
                            } catch (_) {
                            } finally {
                                lastScrollSnapshotRef.current = null;
                            }
                            try {
                                onSelect && onSelect(it);
                            } catch (_) {
                            }
                        });
                    } catch (_) { /* ignore */
                    }
                    try {
                        tree.append(tvi);
                    } catch (_) {
                        try {
                            tree.add && tree.add(tvi);
                        } catch (_) {
                        }
                    }
                    // remember
                    try {
                        tviByIdRef.current.set(it && it.id, tvi);
                    } catch (_) {
                    }
                });
            } catch (_) { /* ignore */
            }
        };

        const applySelection = (selId) => {
            try {
                for (const [id, tvi] of tviByIdRef.current.entries()) {
                    try {
                        tvi.selected = (id === selId);
                    } catch (_) {
                    }
                    const el = ensureDom(tvi);
                    applyAriaAndClasses(el, id === selId);
                }
            } catch (_) { /* ignore */
            }
        };

        useEffect(() => {
            const root = rootRef.current;
            if (!root) return;
            // create tree once
            const tree = new PCUI.TreeView({});
            treeRef.current = tree;
            const el = ensureDom(tree);
            if (el) {
                try {
                    el.setAttribute('role', 'tree');
                    if (className) el.classList.add(...String(className).split(/\s+/).filter(Boolean));
                    if (style && typeof style === 'object') Object.assign(el.style, style);
                } catch (_) { /* ignore */
                }
                root.appendChild(el);
            }
            // initial build
            buildItems(tree, items || []);
            applySelection(selectedId);
            try {
                prevIdsRef.current = (items || []).map(it => it && it.id);
            } catch (_) {
            }
            return () => {
                try {
                    tree.destroy && tree.destroy();
                } catch (_) {
                }
                treeRef.current = null;
                if (root) root.textContent = '';
            };
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, []);

        // items change → rebuild items only (preserve tree and outer scroll)
        useEffect(() => {
            const tree = treeRef.current;
            if (!tree) return;
            const newIds = (items || []).map(it => it && it.id);
            // shallow compare ids to avoid unnecessary rebuilds on selection-only changes
            try {
                const prev = prevIdsRef.current || [];
                if (prev.length === newIds.length && prev.every((v, i) => v === newIds[i])) {
                    return; // no structural change
                }
            } catch (_) {
            }
            const el = ensureDom(tree);
            // preserve parent scroll (outer container has overflow auto)
            const getScrollParent = (node) => {
                try {
                    let p = node && node.parentElement;
                    while (p) {
                        const style = window.getComputedStyle(p);
                        const overflowY = style && style.overflowY;
                        if ((overflowY === 'auto' || overflowY === 'scroll') && p.scrollHeight > p.clientHeight) return p;
                        p = p.parentElement;
                    }
                } catch (_) {
                }
                return node && node.parentElement;
            };
            const parent = getScrollParent(el);
            const prevScroll = parent ? parent.scrollTop : 0;
            try {
                // clear existing children in DOM (fallback-safe)
                if (el) {
                    while (el.firstChild) el.removeChild(el.firstChild);
                }
            } catch (_) {
            }
            // rebuild
            buildItems(tree, items || []);
            // restore scroll
            try {
                if (parent) parent.scrollTop = prevScroll;
            } catch (_) {
            }
            // also reapply selection because new items were created
            applySelection(selectedId);
            // remember ids
            try {
                prevIdsRef.current = newIds;
            } catch (_) {
            }
        }, [items]);

        // selection change → update aria/classes and tvi.selected without rebuilding
        useEffect(() => {
            applySelection(selectedId);
        }, [selectedId]);

        // style/className updates → apply to tree root element
        useEffect(() => {
            const tree = treeRef.current;
            const el = ensureDom(tree);
            if (!el) return;
            try {
                if (className) el.classList.add(...String(className).split(/\s+/).filter(Boolean));
            } catch (_) {
            }
            try {
                if (style && typeof style === 'object') Object.assign(el.style, style);
            } catch (_) {
            }
        }, [style, className]);

        return jsx('div', {ref: rootRef});
    };

    // Final component resolvers
    const PanelX = resolveComponent('Panel', ReactPCUI?.Panel, FallbackPanel);
    const ContainerX = resolveComponent('Container', ReactPCUI?.Container, FallbackContainer);
    const ButtonX = resolveComponent('Button', ReactPCUI?.Button, FallbackButton);
    const LabelGroupX = resolveComponent('LabelGroup', ReactPCUI?.LabelGroup, FallbackLabelGroup);
    const FallbackTreeView = (props) => jsx(TreeViewCore, props);
    const TreeViewX = resolveComponent('TreeView', ReactPCUI?.TreeView, FallbackTreeView);
    const TextInputX = resolveComponent('TextInput', ReactPCUI?.TextInput, FallbackTextInput);
    const SelectInputX = resolveComponent('SelectInput', ReactPCUI?.SelectInput, FallbackSelect);
    const SliderInputX = resolveComponent('SliderInput', ReactPCUI?.SliderInput, FallbackSlider);
    const ColorPickerX = resolveComponent('ColorPicker', ReactPCUI?.ColorPicker, FallbackColor);
    const VectorInputX = resolveComponent('VectorInput', ReactPCUI?.VectorInput, FallbackVector);
    const CodeLike = resolveComponent('Code', ReactPCUI?.Code, FallbackCode);

    const [type, setType] = useState('translate');
    const [proj, setProj] = useState(pc.PROJECTION_PERSPECTIVE);
    const [objects, setObjects] = useState(observer.get('objects') || []);
    const [selId, setSelId] = useState(observer.get('selectedId'));
    const [sel, setSel] = useState(observer.get('selected'));
    const [logs, setLogs] = useState(observer.get('console') || []);
    // UI prefs
    const [showHelpHUD, setShowHelpHUD] = useState(
        observer.get('ui') && typeof observer.get('ui').showHelpHUD === 'boolean'
            ? !!observer.get('ui').showHelpHUD
            : true
    );
    const [shadowsEnabled, setShadowsEnabled] = useState(
        observer.get('ui') && typeof observer.get('ui').shadowsEnabled === 'boolean'
            ? !!observer.get('ui').shadowsEnabled
            : true
    );
    const histInit = observer.get('history') || {};
    const [canUndo, setCanUndo] = useState(!!histInit.canUndo);
    const [canRedo, setCanRedo] = useState(!!histInit.canRedo);
    const [undoLabel, setUndoLabel] = useState(histInit.undoLabel || '');
    const [redoLabel, setRedoLabel] = useState(histInit.redoLabel || '');

    // ----- Menu open states (click to open) -----
    const [openFile, setOpenFile] = useState(false);
    // File > 전처리 데이터 내보내기 (submenu open state)
    const [openFileExport, setOpenFileExport] = useState(false);
    const [openCreate, setOpenCreate] = useState(false);
    const [openEdit, setOpenEdit] = useState(false);
    const [openView, setOpenView] = useState(false);
    const [openSettings, setOpenSettings] = useState(false);
    const [openCreateBuilding, setOpenCreateBuilding] = useState(false);
    const menuRef = useRef(null);

    // Whether current selection is an analysis-space (enables export submenu)
    const isAnalysisSelected = !!(sel && sel.type === 'analysis-space');

    const closeAllMenus = () => {
        setOpenFile(false);
        setOpenCreate(false);
        setOpenEdit(false);
        setOpenView(false);
        setOpenSettings(false);
        setOpenCreateBuilding(false);
        setOpenFileExport(false);
    };

    // Helper: check if any top-level menu is open
    const anyMenuOpen = () => (openFile || openCreate || openEdit || openView || openSettings);
    // Helper: open only one specific top-level menu (and close others)
    const openOnlyMenu = (name) => {
        setOpenFile(name === 'file');
        setOpenCreate(name === 'create');
        setOpenEdit(name === 'edit');
        setOpenView(name === 'view');
        setOpenSettings(name === 'settings');
        // whenever switching top-level menus, collapse nested submenus
        setOpenCreateBuilding(false);
        setOpenFileExport(false);
    };
    // Helper: toggle a specific top-level menu ensuring mutual exclusivity
    const toggleMenu = (name, currentlyOpen) => {
        if (currentlyOpen) {
            closeAllMenus();
        } else {
            openOnlyMenu(name);
        }
    };

    // Close menus on outside click / Escape
    useEffect(() => {
        const onDown = (e) => {
            try {
                const el = menuRef.current;
                if (!el) return;
                if (!el.contains(e.target)) closeAllMenus();
            } catch (_) { /* ignore */
            }
        };
        const onKey = (e) => {
            if (e.key === 'Escape') closeAllMenus();
        };
        // Use pointer events to avoid cases where click is suppressed by upstream handlers
        document.addEventListener('pointerdown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('pointerdown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, []);

    // Note: We intentionally rely on explicit handlers below (onPointerDown)
    // instead of capture-phase listeners to avoid double toggling.

    // observe changes (register after mount)
    useEffect(() => {
        const handler = (/** @type {string} */ path, /** @type {any} */ value) => {
            const [category, key] = path.split('.');
            switch (category) {
                case 'camera':
                    if (key === 'proj') setProj(value);
                    break;
                case 'gizmo':
                    if (key === 'type') setType(value);
                    break;
                case 'grid':
                    if (key === 'size') setGridSize(value);
                    if (key === 'divisions') setGridDivs(value);
                    break;
                case 'objects':
                    setObjects(observer.get('objects') || []);
                    break;
                case 'selectedId':
                    setSelId(value);
                    break;
                case 'selected':
                    setSel(observer.get('selected'));
                    break;
                case 'console':
                    setLogs(observer.get('console') || []);
                    break;
                case 'history': {
                    const h = observer.get('history') || {};
                    setCanUndo(!!h.canUndo);
                    setCanRedo(!!h.canRedo);
                    setUndoLabel(h.undoLabel || '');
                    setRedoLabel(h.redoLabel || '');
                    break;
                }
                case 'ui':
                    if (key === 'showHelpHUD') setShowHelpHUD(!!value);
                    if (key === 'shadowsEnabled') setShadowsEnabled(!!value);
                    break;
            }
        };
        observer.on('*:set', handler);
        // initial sync in case changes happened before mount
        setObjects(observer.get('objects') || []);
        setSelId(observer.get('selectedId'));
        setSel(observer.get('selected'));
        setLogs(observer.get('console') || []);
        const h0 = observer.get('history') || {};
        setCanUndo(!!h0.canUndo);
        setCanRedo(!!h0.canRedo);
        setUndoLabel(h0.undoLabel || '');
        setRedoLabel(h0.redoLabel || '');
        return () => {
            if (typeof observer.off === 'function') {
                observer.off('*:set', handler);
            }
        };
    }, [observer]);

    const api = (/** @type {any} */ (window)).SimEdit9 || {};
    const selectById = (id) => {
        api.selectById && api.selectById(id);
    };
    const createGround = () => {
        api.createGround && api.createGround();
    };
    const createBox = () => {
        api.createBoxBuilding && api.createBoxBuilding();
    };
    const createCylinder = () => {
        api.createCylinderBuilding && api.createCylinderBuilding();
    };
    const createAnalysisSpace = () => {
        api.createAnalysisSpace && api.createAnalysisSpace();
    };
    const deleteSelected = () => {
        api.deleteSelected && api.deleteSelected();
    };
    const undo = () => {
        api.undo && api.undo();
    };
    const redo = () => {
        api.redo && api.redo();
    };
    const initializeScene = () => {
        api.initializeScene && api.initializeScene();
    };
    const saveScene = () => {
        api.saveScene && api.saveScene();
    };
    const loadScene = () => {
        api.loadScene && api.loadScene();
    };
    const exportTofu = () => {
        api.exportToTofuJson && api.exportToTofuJson();
    };
    const exportClippedSTL = (options) => {
        api.exportClippedSTL && api.exportClippedSTL(options);
    };
    const exportPreprocessedData = (options) => {
        api.exportPreprocessedData && api.exportPreprocessedData(options);
    };

    // Track grid size for display
    const [gridSize, setGridSize] = useState((observer.get('grid') && observer.get('grid').size) || 8);
    // Track grid divisions (cell count) for display
    const [gridDivs, setGridDivs] = useState((observer.get('grid') && observer.get('grid').divisions) || 80);

    // Top Application Menu (PCUI) — hierarchical, inert (no handlers)
    // hidden file input for imports
    const fileInputRef = useRef(null);
    // Import dialog state
    const [showImportDlg, setShowImportDlg] = useState(false);
    const [pendingImportFiles, setPendingImportFiles] = useState(/** @type {File[]|null} */(null));
    /** @type {React.MutableRefObject<any>} */
        // For File System Access API: keep handles until user confirms import
    const [pendingImportHandles, setPendingImportHandles] = useState(/** @type {any[]|null} */(null));
    // Which importer is active for the options dialog: 'mesh' | 'vtk'
    const [importKind, setImportKind] = useState('mesh');
    const [importScale, setImportScale] = useState('1');
    const [importUpAxis, setImportUpAxis] = useState('z'); // 'y' | 'z'
    // Helper to close/clear import dialog state
    const closeImportDialog = () => {
        setShowImportDlg(false);
        setPendingImportFiles(null);
        setPendingImportHandles(null);
    };
    // Busy overlay state (for long operations like reading files / importing meshes)
    const [busy, setBusy] = useState(false);
    const [busyMsg, setBusyMsg] = useState('');
    const [busyCancelable, setBusyCancelable] = useState(null);
    // Mesh split params (Inspector for mesh-import)
    const [splitEpsilon, setSplitEpsilon] = useState('0.0001');
    const [splitMinTris, setSplitMinTris] = useState('10');
    const [splitKeepOriginal, setSplitKeepOriginal] = useState('no'); // 'yes' | 'no'
    const [splitNamePrefix, setSplitNamePrefix] = useState('');

    const [showExportPreDlg, setShowExportPreDlg] = useState(false);
    const [exportUpAxis, setExportUpAxis] = useState('z'); // default to z-up

    // Wind streamlines params (Inspector for VTK wind-streamlines)
    const [slSeedStride, setSlSeedStride] = useState('4');
    const [slStep, setSlStep] = useState('1');
    const [slMaxSteps, setSlMaxSteps] = useState('300');
    const [slMinSpeed, setSlMinSpeed] = useState('0.000001');
    const [slWidth, setSlWidth] = useState('1');
    const [slSeedPlane, setSlSeedPlane] = useState('XZ'); // XZ | XY | YZ
    const [slSeedOffset, setSlSeedOffset] = useState('0.5');
    const [slSeedIndex, setSlSeedIndex] = useState('');
    const [slSeedJitter, setSlSeedJitter] = useState('0');
    // Coloring params
    const [colSource, setColSource] = useState('scalar'); // 'scalar' | 'speed'
    const [colPreset, setColPreset] = useState('viridis');
    const [colReverse, setColReverse] = useState('no'); // 'yes' | 'no'
    const [colAuto, setColAuto] = useState('yes'); // 'yes' | 'no'
    const [colMin, setColMin] = useState('0');
    const [colMax, setColMax] = useState('1');
    const [colOpacity, setColOpacity] = useState('1');
    // Scalar slice params
    const [sliceRes, setSliceRes] = useState('128'); // use square res for simplicity
    // Y-slice params (horizontal slice over VTK speed)
    const [ySliceHeight, setYSliceHeight] = useState('0.5');
    // Animation params
    const [animStyle, setAnimStyle] = useState('head'); // 'off' | 'head' | 'pingpong' | 'dashes'
    const [animSpeed, setAnimSpeed] = useState('0.25');
    const [animTrail, setAnimTrail] = useState('0.08');
    const [animRepeat, setAnimRepeat] = useState('6');
    const [animFeather, setAnimFeather] = useState('0.12');
    const [animPlaying, setAnimPlaying] = useState('yes');
    // Building Meta editor state
    const [bRatio, setBRatio] = useState('1');
    const [bMeshPath, setBMeshPath] = useState('');
    const [bBS, setBBS] = useState('128');
    // Analysis Space plane editor states
    const [apFace, setApFace] = useState('X_min');
    const [apBS, setApBS] = useState('8');
    const [apWT, setApWT] = useState('16');
    const [apVT, setApVT] = useState('1');
    const [apVX, setApVX] = useState('0');
    const [apVY, setApVY] = useState('0');
    const [apVZ, setApVZ] = useState('0');
    const [apPR, setApPR] = useState('0');
    const [apC1, setApC1] = useState('0.1');
    const [apC2, setApC2] = useState('0.2');
    const [apC3, setApC3] = useState('0.3');
    useEffect(() => {
        if (sel && sel.streamParams) {
            try {
                const sp = sel.streamParams;
                setSlSeedStride(String(sp.seedStride ?? '4'));
                setSlStep(String(sp.step ?? '1'));
                setSlMaxSteps(String(sp.maxSteps ?? '300'));
                setSlMinSpeed(String(sp.minSpeed ?? '0.000001'));
                setSlWidth(String(sp.width ?? '1'));
                setSlSeedPlane(String(sp.seedPlane ?? 'XZ'));
                setSlSeedOffset(String(sp.seedOffset ?? '0.5'));
                setSlSeedIndex(sp.seedIndex != null ? String(sp.seedIndex) : '');
                setSlSeedJitter(String(sp.seedJitter ?? '0'));
            } catch (_) { /* ignore */
            }
        }
        // Sync coloring UI state from the selected record.
        // Prefer "colorParams" (current schema) and fall back to legacy "coloring".
        const coloring = sel && (sel.colorParams || sel.coloring);
        if (coloring) {
            try {
                const c = coloring;
                setColSource(String(c.source || 'scalar'));
                setColPreset(String(c.preset || 'viridis'));
                setColReverse(c.reverse ? 'yes' : 'no');
                setColAuto(c.autoRange ? 'yes' : 'no');
                if (c.min != null) setColMin(String(c.min));
                if (c.max != null) setColMax(String(c.max));
                setColOpacity(String(c.opacity != null ? c.opacity : '1'));
            } catch (_) {
            }
        }
        if (sel && sel.anim) {
            try {
                const a = sel.anim;
                setAnimStyle(String(a.style || 'off'));
                setAnimSpeed(String(a.speed != null ? a.speed : '0.25'));
                setAnimTrail(String(a.trail != null ? a.trail : '0.08'));
                setAnimRepeat(String(a.repeat != null ? a.repeat : '6'));
                setAnimFeather(String(a.feather != null ? a.feather : '0.12'));
                setAnimPlaying(a.playing ? 'yes' : 'no');
            } catch (_) {
            }
        }
    }, [sel && sel.id]);
    // Sync Analysis Space plane editor from selection/face
    useEffect(() => {
        if (sel && sel.type === 'analysis-space') {
            try {
                const P = (sel.planes && sel.planes[apFace]) || {};
                setApBS(String(P.boundaryScheme != null ? P.boundaryScheme : 8));
                setApWT(String(P.wallType != null ? P.wallType : 16));
                setApVT(String(P.valueType != null ? P.valueType : 1));
                const v = Array.isArray(P.velocity) ? P.velocity : [0, 0, 0];
                setApVX(String(v[0] != null ? v[0] : 0));
                setApVY(String(v[1] != null ? v[1] : 0));
                setApVZ(String(v[2] != null ? v[2] : 0));
                setApPR(String(P.pressure != null ? P.pressure : 0));
                setApC1(String(P.concentration1 != null ? P.concentration1 : 0.1));
                setApC2(String(P.concentration2 != null ? P.concentration2 : 0.2));
                setApC3(String(P.concentration3 != null ? P.concentration3 : 0.3));
            } catch (_) { /* ignore */
            }
        }
    }, [sel && sel.id, sel && sel.type, sel && sel.planes, apFace]);
    // When selecting a scalar-slice, sync resolution UI from selection
    useEffect(() => {
        if (sel && sel.scalarSlice && sel.sliceParams) {
            try {
                const p = sel.sliceParams;
                const r = (p.resU && p.resV && p.resU === p.resV) ? p.resU : (p.resU || 128);
                setSliceRes(String(r));
            } catch (_) {
            }
        }
        if (sel && sel.ySlice) {
            try {
                const p = sel.sliceParams || {resU: 128};
                const r = (p.resU && p.resV && p.resU === p.resV) ? p.resU : (p.resU || 128);
                setSliceRes(String(r));
                setYSliceHeight(String(sel.heightT != null ? sel.heightT : 0.5));
            } catch (_) {
            }
        }
    }, [sel && sel.id, sel && sel.scalarSlice, sel && sel.ySlice]);
    // Sync Building Meta editor when selection changes
    useEffect(() => {
        if (sel && (sel.type === 'building-box' || sel.type === 'building-cylinder' || sel.type === 'mesh-import')) {
            try {
                const b = sel.building || {};
                setBRatio(String(b.ratio != null ? b.ratio : 1));
                setBMeshPath(String(b.meshPath != null ? b.meshPath : ''));
                setBBS(String(b.boundaryScheme != null ? b.boundaryScheme : 128));
            } catch (_) { /* ignore */
            }
        }
    }, [sel && sel.id, sel && sel.type, sel && sel.building]);
    useEffect(() => {
        try {
            document.body && (document.body.style.cursor = busy ? 'progress' : '');
        } catch (_) { /* ignore */
        }
        return () => {
            try {
                document.body && (document.body.style.cursor = '');
            } catch (_) {
            }
        };
    }, [busy]);
    // ESC to close Import Options dialog
    useEffect(() => {
        if (!showImportDlg) return;
        const onKey = (e) => {
            if (e.key === 'Escape') closeImportDialog();
        };
        try {
            document.addEventListener('keydown', onKey);
        } catch (_) {
        }
        return () => {
            try {
                document.removeEventListener('keydown', onKey);
            } catch (_) {
            }
        };
    }, [showImportDlg]);
    // helper: use File System Access API when available (Electron/Chromium, secure contexts)
    const openImportPicker = async () => {
        try {
            const anyWin = /** @type {any} */ (window);
            if (anyWin && typeof anyWin.showOpenFilePicker === 'function') {
                const handles = await anyWin.showOpenFilePicker({
                    multiple: true,
                    types: [
                        {
                            description: 'Meshes (STL/OBJ/GLB/GLTF)',
                            accept: {
                                'model/stl': ['.stl', '.STL'],
                                'text/plain': ['.obj', '.OBJ'],
                                'model/gltf-binary': ['.glb', '.GLB'],
                                'model/gltf+json': ['.gltf', '.GLTF']
                            }
                        }
                    ]
                });
                // Show the import options dialog immediately to avoid pre-dialog delay.
                if (handles && handles.length) {
                    setPendingImportHandles(handles);
                    setPendingImportFiles(null);
                    setImportKind('mesh');
                    setShowImportDlg(true);
                    return true;
                }
            }
        } catch (err) {
            console.error('파일 선택 실패:', err);
        }
        return false;
    };

    // hidden file input for VTK wind field
    const vtkInputRef = useRef(null);
    // hidden file input for VTK Overlay (direct overlay rendering without options dialog)
    const overlayVtkInputRef = useRef(null);

    const TopMenu = jsx(
        ContainerX,
        {
            // Slim translucent bar at the very top
            style: {
                position: 'absolute', left: 0, right: 0, top: 0,
                height: '36px', padding: '0 10px', pointerEvents: 'auto', zIndex: 1000,
                background: 'linear-gradient(180deg, #1b1f24 0%, #14171b 100%)',
                borderBottom: '1px solid rgba(255,255,255,0.06)',
                boxShadow: '0 2px 10px rgba(0,0,0,0.35)',
                backdropFilter: 'blur(2px)'
            }
        },
        // Minimal CSS for hover and click-driven submenus (keeps it PCUI-themed enough)
        jsx('style', null, `
            .se9-topmenu { font-family: inherit; user-select: none; display: flex; align-items: center; height: 36px; }
            .se9-topmenu .menu-bar { display: inline-flex; gap: 4px; align-items: center; }
            .se9-topmenu .menu-root { position: relative; }
            .se9-topmenu .menu-title {
                padding: 6px 12px; color: #e6e6e6; font-weight: 600; cursor: pointer; border-radius: 6px;
                letter-spacing: 0.2px; transition: background 120ms ease;
            }
            .se9-topmenu .menu-title:hover { background: rgba(255,255,255,0.06); }
            .se9-topmenu .menu-root.open > .menu-title {
                background: rgba(255,255,255,0.10);
                box-shadow: inset 0 -2px 0 #4c8bf5;
                /* make the bottom edge flat so the highlight feels natural */
                border-bottom-left-radius: 0;
                border-bottom-right-radius: 0;
            }
            /* small icon toggle buttons for transform modes */
            .se9-topmenu .se9-toolbtn {
                width: 28px; height: 28px; padding: 0;
                display: inline-flex; align-items: center; justify-content: center;
                color: #e6e6e6; border-radius: 6px; cursor: pointer;
                background: transparent; border: 1px solid rgba(255,255,255,0.08);
            }
            .se9-topmenu .se9-toolbtn:hover { background: rgba(255,255,255,0.06); }
            .se9-topmenu .se9-toolbtn[data-active="true"] {
                background: #3a6ea5; color: #ffffff; border-color: transparent;
            }
            .se9-topmenu .se9-toolbtn:focus { outline: 1px solid #4c8bf5; outline-offset: 2px; }
            .se9-topmenu .submenu {
                display: none; position: absolute; top: calc(100% + 6px); left: 0; min-width: 240px;
                background: #1b1f24; border: 1px solid rgba(255,255,255,0.08);
                border-radius: 8px; padding: 6px; box-shadow: 0 14px 30px rgba(0,0,0,0.55), 0 2px 0 rgba(255,255,255,0.02) inset;
            }
            /* top-level menus open only via click/tap (no hover) to avoid dual-open */
            /* show on click-open */
            .se9-topmenu .menu-root.open > .submenu { display: block; }
            .se9-topmenu .submenu .item {
                padding: 8px 12px; color: #e0e0e0; white-space: nowrap; border-radius: 6px; cursor: default;
                display: flex; align-items: center; justify-content: space-between; gap: 16px;
            }
            .se9-topmenu .submenu .item:hover { background: rgba(255,255,255,0.08); }
            .se9-topmenu .submenu .item[aria-disabled="true"] { opacity: 0.5; cursor: not-allowed; }
            .se9-topmenu .submenu .sep { height: 1px; margin: 6px 4px; background: linear-gradient(90deg, transparent, rgba(255,255,255,0.14), transparent); }
            .se9-topmenu .submenu .has-sub { position: relative; padding-right: 22px; cursor: pointer; }
            .se9-topmenu .submenu .has-sub::after {
                content: '▸'; position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
                opacity: 0.7; font-size: 11px;
            }
            /* Slightly overlap nested submenu with parent to avoid hover gap */
            .se9-topmenu .submenu .submenu { top: -6px; left: 100%; margin-left: -6px; }
            /* nested submenu visibility */
            .se9-topmenu .submenu .has-sub:hover > .submenu { display: block; }
            .se9-topmenu .submenu .has-sub.open > .submenu { display: block; }
        `),
        jsx(
            'div',
            {className: 'se9-topmenu', ref: menuRef},
            // hidden file input element for importing meshes
            jsx('input', {
                type: 'file',
                multiple: true,
                accept: '.stl,.STL,.obj,.OBJ,.glb,.GLB,.gltf,.GLTF',
                style: {display: 'none'},
                ref: fileInputRef,
                onChange: (e) => {
                    try {
                        const input = /** @type {HTMLInputElement} */(e.target);
                        const files = Array.from(input.files || []);
                        if (files.length) {
                            try {
                                console.log('Importing files:', files.map(f => f.name));
                            } catch (_) {
                            }
                            // Open import options dialog
                            setPendingImportFiles(files);
                            setPendingImportHandles(null);
                            setImportKind('mesh');
                            setShowImportDlg(true);
                        }
                    } catch (err) {
                        console.error('파일 가져오기 실패:', err);
                    } finally {
                        // allow re-selecting the same file again
                        if (e?.target) e.target.value = '';
                    }
                }
            }),
            // hidden VTK input for wind field import
            jsx('input', {
                type: 'file',
                multiple: true,
                accept: '.vtk,.VTK',
                style: {display: 'none'},
                ref: vtkInputRef,
                onChange: async (e) => {
                    try {
                        const input = /** @type {HTMLInputElement} */(e.target);
                        const files = Array.from(input.files || []);
                        if (files.length) {
                            // Defer import until user chooses options
                            setPendingImportFiles(files);
                            setPendingImportHandles(null);
                            setImportKind('vtk');
                            setShowImportDlg(true);
                        }
                    } catch (err) {
                        console.error('VTK 파일 가져오기 실패:', err);
                    } finally {
                        if (e?.target) e.target.value = '';
                        setOpenCreate(false);
                    }
                }
            }),
            // hidden VTK input for overlay import (no options dialog)
            jsx('input', {
                type: 'file',
                multiple: true,
                accept: '.vtk,.VTK',
                style: {display: 'none'},
                ref: overlayVtkInputRef,
                onChange: async (e) => {
                    try {
                        const input = /** @type {HTMLInputElement} */(e.target);
                        const files = Array.from(input.files || []);
                        if (files.length) {
                            try {
                                await window.SimEdit9?.importVTKOverlay?.(files, {upAxis: 'y', scale: 1});
                            } catch (err) {
                                console.error('Overlay 불러오기 실패:', err);
                            }
                        }
                    } catch (err) {
                        console.error('VTK Overlay 파일 가져오기 실패:', err);
                    } finally {
                        if (e?.target) e.target.value = '';
                        setOpenCreate(false);
                    }
                }
            }),
            jsx(
                'div',
                {className: 'menu-bar', style: {width: '100%'}},
                // 파일 (top-level)
                jsx(
                    'div',
                    {className: 'menu-root' + (openFile ? ' open' : '')},
                    jsx('div', {
                        className: 'menu-title',
                        role: 'button',
                        tabIndex: 0,
                        'data-title': 'file',
                        onPointerEnter: () => {
                            if (anyMenuOpen()) openOnlyMenu('file');
                        },
                        onPointerDown: (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            toggleMenu('file', openFile);
                        },
                        onKeyDown: (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                toggleMenu('file', openFile);
                            }
                        }
                    }, '파일'),
                    jsx(
                        'div',
                        {className: 'submenu'},
                        jsx('div', {
                            className: 'item',
                            role: 'button',
                            tabIndex: 0,
                            title: '씬을 모두 지우고 초기 상태로 되돌립니다',
                            onPointerDown: (e) => {
                                e.preventDefault();
                                initializeScene();
                                setOpenFile(false);
                            },
                            onKeyDown: (e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    initializeScene();
                                    setOpenFile(false);
                                }
                            }
                        }, '씬 초기화'),
                        jsx('div', {className: 'sep'}),
                        jsx('div', {
                            className: 'item',
                            role: 'button',
                            tabIndex: 0,
                            title: '현재 씬을 파일로 저장',
                            onPointerDown: (e) => {
                                e.preventDefault();
                                saveScene();
                                setOpenFile(false);
                            },
                            onKeyDown: (e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    saveScene();
                                    setOpenFile(false);
                                }
                            }
                        }, '저장…'),
                        jsx('div', {
                            className: 'item',
                            role: 'button',
                            tabIndex: 0,
                            title: '파일에서 씬 불러오기',
                            onPointerDown: (e) => {
                                e.preventDefault();
                                loadScene();
                                setOpenFile(false);
                            },
                            onKeyDown: (e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    loadScene();
                                    setOpenFile(false);
                                }
                            }
                        }, '로드…')
                        , jsx('div', {className: 'sep'}),
                        // File > 전처리 데이터 내보내기 (Combined ZIP)
                        jsx(
                            'div',
                            {
                                className: 'item',
                                role: 'button',
                                tabIndex: 0,
                                'aria-disabled': isAnalysisSelected ? undefined : true,
                                title: isAnalysisSelected ? '선택된 해석공간 기준으로 전처리 데이터(JSON + STL)를 내보냅니다' : '해석공간을 먼저 선택하세요',
                                onPointerDown: (e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    if (!isAnalysisSelected) return; // disabled
                                    setShowExportPreDlg(true);
                                    closeAllMenus();
                                },
                                onKeyDown: (e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        if (!isAnalysisSelected) return;
                                        setShowExportPreDlg(true);
                                        closeAllMenus();
                                    }
                                }
                            },
                            '전처리 데이터 내보내기'
                        )
                    )
                ),
                // 생성 (top-level)
                jsx(
                    'div',
                    {className: 'menu-root' + (openCreate ? ' open' : '')},
                    jsx('div', {
                        className: 'menu-title',
                        role: 'button',
                        tabIndex: 0,
                        'data-title': 'create',
                        onPointerEnter: () => {
                            // If any top-level menu is already open, switch focus to this one
                            if (anyMenuOpen()) openOnlyMenu('create');
                        },
                        onPointerDown: (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            toggleMenu('create', openCreate);
                        },
                        onKeyDown: (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                toggleMenu('create', openCreate);
                            }
                        }
                    }, '생성'),
                    jsx(
                        'div',
                        {className: 'submenu'},
                        jsx('div', {
                            className: 'item',
                            role: 'button',
                            tabIndex: 0,
                            onPointerDown: (e) => {
                                e.preventDefault();
                                createGround();
                                setOpenCreate(false);
                                setOpenCreateBuilding(false);
                            },
                            onKeyDown: (e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    createGround();
                                    setOpenCreate(false);
                                    setOpenCreateBuilding(false);
                                }
                            }
                        }, '지면'),
                        jsx('div', {className: 'sep'}),
                        jsx('div', {
                            className: 'item',
                            role: 'button',
                            tabIndex: 0,
                            onPointerDown: (e) => {
                                e.preventDefault();
                                createAnalysisSpace();
                                setOpenCreate(false);
                                setOpenCreateBuilding(false);
                            },
                            onKeyDown: (e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    createAnalysisSpace();
                                    setOpenCreate(false);
                                    setOpenCreateBuilding(false);
                                }
                            }
                        }, '해석공간'),
                        jsx('div', {className: 'sep'}),
                        // Import from file(s)
                        jsx('div', {
                            className: 'item',
                            role: 'button',
                            tabIndex: 0,
                            title: 'STL/GLB 등 파일에서 가져오기',
                            onPointerDown: (e) => {
                                e.preventDefault();
                                // Try modern picker first; fall back to hidden input
                                openImportPicker().then((ok) => {
                                    if (!ok) {
                                        try {
                                            fileInputRef.current && fileInputRef.current.click();
                                        } catch (_) {
                                        }
                                    }
                                });
                                setOpenCreate(false);
                                setOpenCreateBuilding(false);
                            },
                            onKeyDown: (e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    openImportPicker().then((ok) => {
                                        if (!ok) {
                                            try {
                                                fileInputRef.current && fileInputRef.current.click();
                                            } catch (_) {
                                            }
                                        }
                                    });
                                    setOpenCreate(false);
                                    setOpenCreateBuilding(false);
                                }
                            }
                        }, '메시 (STL 파일) 가져오기…'),
                        // VTK wind field import
                        jsx('div', {
                            className: 'item',
                            role: 'button',
                            tabIndex: 0,
                            title: 'VTK(STRUCTURED_POINTS) 바람장 파일(.vtk)에서 스트림라인을 생성합니다',
                            onPointerDown: async (e) => {
                                e.preventDefault();
                                try {
                                    const anyWin = /** @type {any} */ (window);
                                    if (anyWin && typeof anyWin.showOpenFilePicker === 'function') {
                                        const handles = await anyWin.showOpenFilePicker({
                                            multiple: true,
                                            types: [{
                                                description: 'VTK (Legacy Binary)',
                                                accept: {'application/octet-stream': ['.vtk', '.VTK']}
                                            }]
                                        });
                                        if (handles && handles.length) {
                                            setPendingImportHandles(handles);
                                            setPendingImportFiles(null);
                                            setImportKind('vtk');
                                            setShowImportDlg(true);
                                        }
                                    } else {
                                        try {
                                            vtkInputRef.current && vtkInputRef.current.click();
                                        } catch (_) {
                                        }
                                    }
                                } catch (err) {
                                    console.error('VTK 파일 선택 실패:', err);
                                } finally {
                                    setOpenCreate(false);
                                    setOpenCreateBuilding(false);
                                }
                            },
                            onKeyDown: async (e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    try {
                                        const anyWin = /** @type {any} */ (window);
                                        if (anyWin && typeof anyWin.showOpenFilePicker === 'function') {
                                            const handles = await anyWin.showOpenFilePicker({
                                                multiple: true,
                                                types: [{
                                                    description: 'VTK (Legacy Binary)',
                                                    accept: {'application/octet-stream': ['.vtk', '.VTK']}
                                                }]
                                            });
                                            if (handles && handles.length) {
                                                setPendingImportHandles(handles);
                                                setPendingImportFiles(null);
                                                setImportKind('vtk');
                                                setShowImportDlg(true);
                                            }
                                        } else {
                                            try {
                                                vtkInputRef.current && vtkInputRef.current.click();
                                            } catch (_) {
                                            }
                                        }
                                    } catch (err) {
                                        console.error('VTK 파일 선택 실패:', err);
                                    } finally {
                                        setOpenCreate(false);
                                        setOpenCreateBuilding(false);
                                    }
                                }
                            }
                        }, '바람장 (VTK 파일) 가져오기…'),
                        jsx('div', {className: 'sep'}),
                        jsx(
                            'div',
                            {
                                className: 'item has-sub' + (openCreateBuilding ? ' open' : ''),
                                role: 'button',
                                tabIndex: 0,
                                'data-sub': 'building',
                                onPointerDown: (e) => {
                                    // toggle nested submenu; keep parent open
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setOpenCreate(true);
                                    setOpenCreateBuilding(!openCreateBuilding);
                                },
                                onKeyDown: (e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        setOpenCreate(true);
                                        setOpenCreateBuilding(!openCreateBuilding);
                                    }
                                }
                            },
                            '건물',
                            jsx(
                                'div',
                                {className: 'submenu'},
                                jsx('div', {
                                    className: 'item',
                                    role: 'button',
                                    tabIndex: 0,
                                    onPointerDown: (e) => {
                                        e.preventDefault();
                                        // Prevent bubbling to the parent "건물" has-sub toggle,
                                        // which would immediately re-open the submenu after we close it
                                        e.stopPropagation();
                                        createBox();
                                        closeAllMenus();
                                    },
                                    onKeyDown: (e) => {
                                        if (e.key === 'Enter' || e.key === ' ') {
                                            e.preventDefault();
                                            // Avoid triggering the parent has-sub key handler
                                            e.stopPropagation();
                                            createBox();
                                            closeAllMenus();
                                        }
                                    }
                                }, '직방형'),
                                jsx('div', {
                                    className: 'item',
                                    role: 'button',
                                    tabIndex: 0,
                                    onPointerDown: (e) => {
                                        e.preventDefault();
                                        // Prevent bubbling to the parent has-sub toggle
                                        e.stopPropagation();
                                        createCylinder();
                                        closeAllMenus();
                                    },
                                    onKeyDown: (e) => {
                                        if (e.key === 'Enter' || e.key === ' ') {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            createCylinder();
                                            closeAllMenus();
                                        }
                                    }
                                }, '원통형'),
                            )
                        )
                    )
                ),
                // 편집 (top-level)
                jsx(
                    'div',
                    {className: 'menu-root' + (openEdit ? ' open' : '')},
                    jsx('div', {
                        className: 'menu-title',
                        role: 'button',
                        tabIndex: 0,
                        'data-title': 'edit',
                        onPointerEnter: () => {
                            // If any top-level menu is already open, switch focus to this one
                            if (anyMenuOpen()) openOnlyMenu('edit');
                        },
                        onPointerDown: (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            toggleMenu('edit', openEdit);
                        },
                        onKeyDown: (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                toggleMenu('edit', openEdit);
                            }
                        }
                    }, '편집'),
                    jsx(
                        'div',
                        {className: 'submenu'},
                        // Undo
                        jsx('div', {
                            className: 'item',
                            role: 'button',
                            tabIndex: canUndo ? 0 : -1,
                            'aria-disabled': String(!canUndo),
                            onPointerDown: (e) => {
                                e.preventDefault();
                                if (!canUndo) return;
                                undo();
                                setOpenEdit(false);
                                setOpenCreate(false);
                                setOpenCreateBuilding(false);
                            },
                            onKeyDown: (e) => {
                                if ((e.key === 'Enter' || e.key === ' ') && canUndo) {
                                    e.preventDefault();
                                    undo();
                                    setOpenEdit(false);
                                    setOpenCreate(false);
                                    setOpenCreateBuilding(false);
                                }
                            }
                        }, `실행 취소${undoLabel ? ` (${undoLabel})` : ''}`),
                        // Redo
                        jsx('div', {
                            className: 'item',
                            role: 'button',
                            tabIndex: canRedo ? 0 : -1,
                            'aria-disabled': String(!canRedo),
                            onPointerDown: (e) => {
                                e.preventDefault();
                                if (!canRedo) return;
                                redo();
                                setOpenEdit(false);
                                setOpenCreate(false);
                                setOpenCreateBuilding(false);
                            },
                            onKeyDown: (e) => {
                                if ((e.key === 'Enter' || e.key === ' ') && canRedo) {
                                    e.preventDefault();
                                    redo();
                                    setOpenEdit(false);
                                    setOpenCreate(false);
                                    setOpenCreateBuilding(false);
                                }
                            }
                        }, `다시 실행${redoLabel ? ` (${redoLabel})` : ''}`),
                        jsx('div', {className: 'sep'}),
                        // Delete Selected
                        jsx('div', {
                            className: 'item',
                            role: 'button',
                            tabIndex: 0,
                            onPointerDown: (e) => {
                                e.preventDefault();
                                deleteSelected();
                                // close menus after action
                                setOpenEdit(false);
                                setOpenCreate(false);
                                setOpenCreateBuilding(false);
                            },
                            onKeyDown: (e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    deleteSelected();
                                    setOpenEdit(false);
                                    setOpenCreate(false);
                                    setOpenCreateBuilding(false);
                                }
                            }
                        }, '선택된 객체 삭제')
                    )
                ),
                // 보기 (top-level)
                jsx(
                    'div',
                    {className: 'menu-root' + (openView ? ' open' : '')},
                    jsx('div', {
                        className: 'menu-title',
                        role: 'button',
                        tabIndex: 0,
                        'data-title': 'view',
                        onPointerEnter: () => {
                            if (anyMenuOpen()) openOnlyMenu('view');
                        },
                        onPointerDown: (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            toggleMenu('view', openView);
                        },
                        onKeyDown: (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                toggleMenu('view', openView);
                            }
                        }
                    }, '보기'),
                    jsx(
                        'div',
                        {className: 'submenu'},
                        // 카메라 초기화
                        jsx('div', {
                            className: 'item',
                            role: 'button',
                            tabIndex: 0,
                            title: '현재 씬이 잘 보이는 배율/각도로 카메라 초기화 (⌘/Ctrl+0, Shift+F)',
                            onPointerDown: (e) => {
                                e.preventDefault();
                                try {
                                    console.log('[CAM][UI] View menu → 카메라 초기화 요청');
                                } catch (_) {
                                }
                                try {
                                    /** @type {any} */(window).SimEdit9?.resetCameraView?.();
                                } catch (_) {
                                }
                                closeAllMenus();
                            },
                            onKeyDown: (e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    try {
                                        console.log('[CAM][UI] View menu (kbd) → 카메라 초기화 요청');
                                    } catch (_) {
                                    }
                                    try {
                                        /** @type {any} */(window).SimEdit9?.resetCameraView?.();
                                    } catch (_) {
                                    }
                                    closeAllMenus();
                                }
                            }
                        }, jsx('span', null, '카메라 초기화'), jsx('span', {
                            style: {
                                opacity: 0.7,
                                fontSize: '11px'
                            }
                        }, navigator.platform.includes('Mac') ? '⌘ 0' : 'Ctrl 0')),
                        // 객체 포커스
                        jsx('div', {
                            className: 'item',
                            role: 'button',
                            tabIndex: 0,
                            title: '선택된 객체가 잘 보이도록 카메라를 맞춤 (F)',
                            onPointerDown: (e) => {
                                e.preventDefault();
                                try {
                                    console.log('[CAM][UI] View menu → 객체 포커스 요청');
                                } catch (_) {
                                }
                                try {
                                    /** @type {any} */(window).SimEdit9?.focusSelectedObject?.();
                                } catch (_) {
                                }
                                closeAllMenus();
                            },
                            onKeyDown: (e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    try {
                                        console.log('[CAM][UI] View menu (kbd) → 객체 포커스 요청');
                                    } catch (_) {
                                    }
                                    try {
                                        /** @type {any} */(window).SimEdit9?.focusSelectedObject?.();
                                    } catch (_) {
                                    }
                                    closeAllMenus();
                                }
                            }
                        }, jsx('span', null, '객체 포커스'), jsx('span', {style: {opacity: 0.7, fontSize: '11px'}}, 'F'))
                    )
                ),

                // 설정 (top-level)
                jsx(
                    'div',
                    {className: 'menu-root' + (openSettings ? ' open' : '')},
                    jsx('div', {
                        className: 'menu-title',
                        role: 'button',
                        tabIndex: 0,
                        'data-title': 'settings',
                        onPointerEnter: () => {
                            if (anyMenuOpen()) openOnlyMenu('settings');
                        },
                        onPointerDown: (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            toggleMenu('settings', openSettings);
                        },
                        onKeyDown: (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                toggleMenu('settings', openSettings);
                            }
                        }
                    }, '설정'),
                    jsx(
                        'div',
                        {className: 'submenu'},
                        // 도움말 HUD 표시 토글
                        jsx('div', {
                            className: 'item',
                            role: 'button',
                            tabIndex: 0,
                            title: '좌하단에 키 조작 도움말을 표시/숨김',
                            onPointerDown: (e) => {
                                e.preventDefault();
                                observer.set('ui.showHelpHUD', !showHelpHUD);
                            },
                            onKeyDown: (e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    observer.set('ui.showHelpHUD', !showHelpHUD);
                                }
                            }
                        }, jsx('span', null, '도움말(HUD) 표시'), jsx('span', {
                            style: {
                                opacity: 0.7,
                                fontSize: '11px'
                            }
                        }, showHelpHUD ? '켜짐' : '꺼짐')),
                        // 그림자 표시 토글
                        jsx('div', {
                            className: 'item',
                            role: 'button',
                            tabIndex: 0,
                            title: '그림자를 전역적으로 표시/숨김 (성능/가시성 조절)',
                            onPointerDown: (e) => {
                                e.preventDefault();
                                observer.set('ui.shadowsEnabled', !shadowsEnabled);
                            },
                            onKeyDown: (e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    observer.set('ui.shadowsEnabled', !shadowsEnabled);
                                }
                            }
                        }, jsx('span', null, '그림자 표시'), jsx('span', {
                            style: {
                                opacity: 0.7,
                                fontSize: '11px'
                            }
                        }, shadowsEnabled ? '켜짐' : '꺼짐')),
                        jsx('div', {className: 'sep'}),
                        // single control: grid level [1..5] → maps to divisions: 80 * 2^(level-1)
                        jsx('div', {className: 'item', style: {cursor: 'default'}},
                            jsx('div', {style: {flex: 1}}, '그리드 크기'),
                            jsx('div', {style: {minWidth: '180px', display: 'flex', alignItems: 'center', gap: '8px'}},
                                jsx(SliderInputX, {
                                    binding: new BindingTwoWay(),
                                    link: {observer, path: 'grid.level'},
                                    min: 1,
                                    max: 5,
                                    precision: 0
                                })
                            )
                        )
                    )
                ),
                // spacer to push toolbar + status to the right
                jsx('div', {style: {flex: 1}}),
                // Transform toolbar (Unity-like): Q/W/E shortcuts also supported — icon buttons
                jsx('div', {style: {display: 'flex', gap: '6px', alignItems: 'center', paddingRight: '8px'}},
                    // Translate icon (toggle button)
                    jsx(
                        'button',
                        {
                            className: 'se9-toolbtn',
                            title: '이동 (Q)',
                            'aria-pressed': String(type === 'translate'),
                            'data-active': String(type === 'translate'),
                            onPointerDown: (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                            },
                            onPointerUp: (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                            },
                            onClick: (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                observer.set('gizmo.type', 'translate');
                            }
                        },
                        jsx(
                            'svg',
                            {
                                width: 16,
                                height: 16,
                                viewBox: '0 0 16 16',
                                fill: 'none',
                                xmlns: 'http://www.w3.org/2000/svg'
                            },
                            jsx('path', {
                                d: 'M3 8h8M11 8l-2-2M11 8l-2 2M8 13V5M8 5l-2 2M8 5l2 2',
                                stroke: 'currentColor',
                                strokeWidth: 1.5,
                                strokeLinecap: 'round',
                                strokeLinejoin: 'round'
                            })
                        )
                    ),
                    // Rotate icon (toggle button)
                    jsx(
                        'button',
                        {
                            className: 'se9-toolbtn',
                            title: '회전 (W)',
                            'aria-pressed': String(type === 'rotate'),
                            'data-active': String(type === 'rotate'),
                            onPointerDown: (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                            },
                            onPointerUp: (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                            },
                            onClick: (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                observer.set('gizmo.type', 'rotate');
                            }
                        },
                        jsx(
                            'svg',
                            {
                                width: 16,
                                height: 16,
                                viewBox: '0 0 16 16',
                                fill: 'none',
                                xmlns: 'http://www.w3.org/2000/svg'
                            },
                            jsx('path', {
                                d: 'M12.5 8a4.5 4.5 0 1 1-1.32-3.18',
                                stroke: 'currentColor',
                                strokeWidth: 1.5,
                                strokeLinecap: 'round',
                                strokeLinejoin: 'round'
                            }),
                            jsx('path', {
                                d: 'M11.5 2.5v3h3',
                                stroke: 'currentColor',
                                strokeWidth: 1.5,
                                strokeLinecap: 'round',
                                strokeLinejoin: 'round'
                            })
                        )
                    ),
                    // Scale icon (toggle button)
                    jsx(
                        'button',
                        {
                            className: 'se9-toolbtn',
                            title: '스케일 (E)',
                            'aria-pressed': String(type === 'scale'),
                            'data-active': String(type === 'scale'),
                            onPointerDown: (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                            },
                            onPointerUp: (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                            },
                            onClick: (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                observer.set('gizmo.type', 'scale');
                            }
                        },
                        jsx(
                            'svg',
                            {
                                width: 16,
                                height: 16,
                                viewBox: '0 0 16 16',
                                fill: 'none',
                                xmlns: 'http://www.w3.org/2000/svg'
                            },
                            jsx('path', {
                                d: 'M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3',
                                stroke: 'currentColor',
                                strokeWidth: 1.5,
                                strokeLinecap: 'round',
                                strokeLinejoin: 'round'
                            })
                        )
                    )
                ),
                // right-aligned status next to toolbar
                jsx('div', {
                    style: {
                        color: '#aab3c0',
                        fontSize: '12px'
                    }
                }, `그리드: ${Math.round(gridDivs)}×${Math.round(gridDivs)} | 범위: ${Number(gridSize).toFixed(2)}`)
            )
        )
    );

    // Bottom-left on-screen help HUD (non-interactive)
    const HelpHUD = showHelpHUD ? jsx(
        'div',
        {
            style: {
                position: 'absolute', left: '8px', bottom: '8px', maxWidth: '46%',
                pointerEvents: 'none', zIndex: 900,
                color: '#e6e6e6', fontSize: '11px', lineHeight: 1.3,
                background: 'rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: '8px', padding: '8px 10px', boxShadow: '0 8px 18px rgba(0,0,0,0.35)'
            }
        },
        jsx('div', {style: {opacity: 0.9}},
            jsx('div', {
                style: {
                    marginBottom: '4px',
                    fontWeight: 600,
                    fontSize: '11px',
                    letterSpacing: '0.2px',
                    opacity: 0.9
                }
            }, '단축키 도움말'),
            jsx('div', null, '• 우클릭 + WASD/QE: 플라이 이동'),
            jsx('div', null, '• 좌클릭 드래그: 회전(오빗)'),
            jsx('div', null, '• 휠: 줌, 중클릭 드래그 또는 Shift+드래그: 패닝'),
            jsx('div', null, '• Shift: 가속, Ctrl: 미세 이동'),
            jsx('div', null, '• F: 선택 포커스, Shift+F 또는 ⌘/Ctrl+0: 카메라 초기화'),
            jsx('div', null, '• Q/W/E: 이동/회전/스케일 툴'),
            jsx('div', null, '• Shift+우클릭: 3D 커서 배치 (지면 y=0에 스냅)'),
            jsx('div', null, '• 가져오기(STL 등): 3D 커서 위치에 객체 생성')
        )
    ) : null;

    // ---------- Objects list (right side) ----------

    const TypeLabel = (t) => {
        switch (t) {
            case 'ground':
                return 'Ground';
            case 'building-box':
                return 'Building (Box)';
            case 'building-cylinder':
                return 'Building (Cylinder)';
            case 'mesh-import':
                return 'Imported Mesh';
            default:
                return t || 'Object';
        }
    };

    const ListItem = (o) => jsx(
        ButtonX,
        {
            key: o.id,
            text: `${o.name}`,
            title: `${TypeLabel(o.type)} #${o.id}`,
            style: {
                width: '100%', textAlign: 'left', marginBottom: '4px',
                background: selId === o.id ? '#3a6ea5' : undefined
            },
            onClick: () => selectById(o.id)
        }
    );

    const renderList = () => {
        const items = (objects || []).map((o) => ({
            id: o.id,
            name: o.name,
            text: o.name,
            title: `${TypeLabel(o.type)} #${o.id}`
        }));
        return jsx(TreeViewX, {
            items,
            selectedId: selId,
            onSelect: (it) => {
                try {
                    selectById(it && it.id);
                } catch (_) {
                }
            },
            style: {height: '100%'},
            className: 'se-objects-tree'
        });
    };

    // Sidebar variant: Tabs (Objects | Inspector), no PCUI.Container. Sidebar width remains resizable via main Split.js.
    const SidebarTabs = () => {
        // Restore previously opened tab to prevent unexpected jumps on remounts
        const initialTab = (() => {
            try {
                return localStorage.getItem('sidebar.tab') || 'objects';
            } catch (_) {
                return 'objects';
            }
        })();
        const [tab, setTab] = useState(initialTab);

        useEffect(() => {
            try {
                localStorage.setItem('sidebar.tab', tab);
            } catch (_) {
            }
        }, [tab]);

        // Tab bar/button styles (tab-like)
        const tabBarStyle = {
            display: 'flex',
            gap: '6px',
            marginBottom: '8px',
            flex: '0 0 auto',
            borderBottom: '1px solid rgba(255,255,255,0.12)'
        };
        const tabBtnBase = {
            borderTopLeftRadius: '6px',
            borderTopRightRadius: '6px',
            // Avoid React warning about mixing shorthand/non-shorthand border props
            // Use longhands only so we can safely override borderColor in active state
            borderWidth: '1px',
            borderStyle: 'solid',
            borderColor: 'transparent',
            borderBottomWidth: 0,
            padding: '6px 10px',
            marginBottom: '-1px',
            cursor: 'pointer'
        };
        const tabBtnActive = {
            background: '#2f3b52',
            borderColor: 'rgba(255,255,255,0.18)',
            color: '#ffffff'
        };
        const tabBtnInactive = {
            background: 'transparent',
            color: '#cfd3da'
        };

        return jsx(
            'div',
            {style: {height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, padding: '8px', gap: 0}},
            // Tab bar
            jsx('div', {style: tabBarStyle},
                jsx(ButtonX, {
                    text: 'Objects',
                    onClick: () => setTab('objects'),
                    role: 'tab',
                    'aria-selected': String(tab === 'objects'),
                    style: {...tabBtnBase, ...(tab === 'objects' ? tabBtnActive : tabBtnInactive)}
                }),
                jsx(ButtonX, {
                    text: 'Inspector',
                    onClick: () => setTab('inspector'),
                    role: 'tab',
                    'aria-selected': String(tab === 'inspector'),
                    style: {...tabBtnBase, ...(tab === 'inspector' ? tabBtnActive : tabBtnInactive)}
                })
            ),
            // Tab content fills remaining space
            jsx('div', {style: {flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex'}},
                tab === 'objects'
                    ? jsx(
                        'div',
                        {
                            style: {
                                height: '100%',
                                display: 'flex',
                                flexDirection: 'column',
                                overflow: 'hidden',
                                width: '100%'
                            }
                        },
                        // Objects tab specific styles (hover/selected states)
                        jsx('style', null, `
                            /* Objects tab tree view styles */
                            .se-objects-tree {
                                --se-obj-hover-bg: rgba(76,139,245,0.14);
                                --se-obj-selected-bg: #3a6ea5;
                                --se-obj-selected-border: rgba(255,255,255,0.14);
                                --se-obj-radius: 6px;
                            }
                            /* Base item styling */
                            .se-objects-tree .pcui-treeview-item,
                            .se-objects-tree li {
                                position: relative;
                                border-radius: var(--se-obj-radius);
                                transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease;
                            }
                            /* Hover state (clearly distinguishable from white) */
                            .se-objects-tree .pcui-treeview-item:hover,
                            .se-objects-tree li:hover {
                                background: var(--se-obj-hover-bg);
                            }
                            /* Selected states – try multiple class/attr variants used by PCUI */
                            .se-objects-tree .pcui-treeview-item.selected,
                            .se-objects-tree .pcui-treeview-item.pcui-selected,
                            .se-objects-tree .pcui-treeview-item.is-selected,
                            .se-objects-tree .pcui-treeview-item[aria-selected="true"],
                            .se-objects-tree li.selected,
                            .se-objects-tree li[aria-selected="true"] {
                                background: var(--se-obj-selected-bg);
                                color: #ffffff;
                                border: 1px solid var(--se-obj-selected-border);
                            }
                            /* Selected + hover: a tad brighter */
                            .se-objects-tree .pcui-treeview-item.selected:hover,
                            .se-objects-tree .pcui-treeview-item.pcui-selected:hover,
                            .se-objects-tree .pcui-treeview-item.is-selected:hover,
                            .se-objects-tree .pcui-treeview-item[aria-selected="true"]:hover,
                            .se-objects-tree li.selected:hover,
                            .se-objects-tree li[aria-selected="true"]:hover {
                                background: #447fb8;
                            }
                            /* Left-side indicator for selected item (use ::after to avoid clashing with PCUI's own ::before guides) */
                            .se-objects-tree .pcui-treeview-item.selected::after,
                            .se-objects-tree .pcui-treeview-item.pcui-selected::after,
                            .se-objects-tree .pcui-treeview-item.is-selected::after,
                            .se-objects-tree .pcui-treeview-item[aria-selected="true"]::after,
                            .se-objects-tree li.selected::after,
                            .se-objects-tree li[aria-selected="true"]::after {
                                content: '';
                                position: absolute;
                                left: 0;
                                top: 0;
                                bottom: 0;
                                width: 3px;
                                background: #9bc1ff;
                                border-top-left-radius: var(--se-obj-radius);
                                border-bottom-left-radius: var(--se-obj-radius);
                            }
                        `),
                        jsx('div', {style: {flex: 1, minHeight: 0, overflow: 'auto'}}, renderList())
                    )
                    : jsx(
                        'div',
                        {
                            style: {
                                height: '100%',
                                display: 'flex',
                                flexDirection: 'column',
                                overflow: 'hidden',
                                width: '100%'
                            }
                        },
                        jsx('div', {
                                style: {
                                    flex: 1,
                                    minHeight: 0,
                                    overflow: 'auto',
                                    display: 'flex',
                                    flexDirection: 'column'
                                }
                            },
                            sel ? fragment(
                                jsx(LabelGroupX, {text: 'Name'}, jsx(TextInputX, {
                                    binding: new BindingTwoWay(),
                                    link: {observer, path: 'selected.name'}
                                })),
                                jsx(LabelGroupX, {text: 'Type'}, jsx(TextInputX, {enabled: false, value: sel.type})),
                                // Hide Color for analysis-space per requirements
                                sel.type !== 'analysis-space' && jsx(LabelGroupX, {text: 'Color'}, jsx(ColorPickerX, {
                                    binding: new BindingTwoWay(),
                                    link: {observer, path: 'selected.color'}
                                })),
                                jsx(LabelGroupX, {text: 'Position'}, jsx(VectorInputX, {
                                    binding: new BindingTwoWay(),
                                    link: {observer, path: 'selected.position'},
                                    dimensions: 3
                                })),
                                jsx(LabelGroupX, {text: 'Rotation'}, jsx(VectorInputX, {
                                    binding: new BindingTwoWay(),
                                    link: {observer, path: 'selected.rotation'},
                                    dimensions: 3
                                })),
                                jsx(LabelGroupX, {text: 'Scale'}, jsx(VectorInputX, {
                                    binding: new BindingTwoWay(),
                                    link: {observer, path: 'selected.scale'},
                                    dimensions: 3
                                })),
                                sel.type === 'ground' && jsx(LabelGroupX, {text: 'Size [W,D]'}, jsx(VectorInputX, {
                                    binding: new BindingTwoWay(),
                                    link: {observer, path: 'selected.size'},
                                    dimensions: 2
                                })),
                                sel.type === 'building-box' && jsx(LabelGroupX, {text: 'Dimensions [W,H,D]'}, jsx(VectorInputX, {
                                    binding: new BindingTwoWay(),
                                    link: {observer, path: 'selected.dimensions'},
                                    dimensions: 3
                                })),
                                sel.type === 'building-cylinder' && jsx(LabelGroupX, {text: 'Cylinder [R,H]'}, jsx(VectorInputX, {
                                    binding: new BindingTwoWay(),
                                    link: {observer, path: 'selected.cyl'},
                                    dimensions: 2
                                })),
                                // Building Meta (for buildings and imported meshes)
                                (sel.type === 'building-box' || sel.type === 'building-cylinder' || sel.type === 'mesh-import') && fragment(
                                    jsx('div', {style: {height: '1px', background: 'rgba(255,255,255,0.06)', margin: '6px 0'}}),
                                    jsx('div', {
                                        style: {
                                            color: '#cfd3da',
                                            fontSize: '12px',
                                            fontWeight: 700,
                                            opacity: 0.9,
                                            margin: '2px 0 6px 0'
                                        }
                                    }, 'Building Meta'),
                                    jsx(LabelGroupX, {text: 'BoundaryScheme'}, jsx(SelectInputX, {
                                        type: 'string',
                                        options: [
                                            {v: '128', t: 'Default / FixedWall (128)'},
                                            {v: '1', t: 'HBB (1)'},
                                            {v: '2', t: 'FBB (2)'},
                                            {v: '4', t: 'EQ (4)'},
                                            {v: '8', t: 'NEQ (8)'}
                                        ],
                                        value: bBS,
                                        onChange: (v) => setBBS(String(v))
                                    })),
                                    jsx(LabelGroupX, {text: 'Ratio'}, jsx(TextInputX, {
                                        type: 'number',
                                        value: bRatio,
                                        onChange: (v) => setBRatio(String(v))
                                    })),
                                    jsx(LabelGroupX, {text: 'Mesh Path'}, jsx(TextInputX, {
                                        type: 'string',
                                        value: bMeshPath,
                                        onChange: (v) => setBMeshPath(String(v))
                                    })),
                                    jsx('div', {style: {display: 'flex', gap: '6px', marginTop: '4px'}},
                                        jsx('button', {
                                            className: 'se9-btn',
                                            onClick: () => {
                                                try {
                                                    const ratioNum = parseFloat(bRatio);
                                                    api.setBuildingMetaById && api.setBuildingMetaById(sel.id, {
                                                        boundaryScheme: parseInt(bBS, 10),
                                                        ratio: isFinite(ratioNum) ? ratioNum : 1,
                                                        meshPath: bMeshPath
                                                    });
                                                } catch (err) {
                                                    console.error('Building Meta 적용 실패:', err);
                                                }
                                            }
                                        }, 'Apply')
                                    )
                                ),
                                sel.type === 'analysis-space' && fragment(
                                    jsx('div', {style: {height: '1px', background: 'rgba(255,255,255,0.06)', margin: '6px 0'}}),
                                    jsx('div', {
                                        style: {
                                            color: '#cfd3da',
                                            fontSize: '12px',
                                            fontWeight: 700,
                                            opacity: 0.9,
                                            margin: '2px 0 6px 0'
                                        }
                                    }, 'Analysis Space'),
                                    jsx(LabelGroupX, {text: 'Min [x,y,z]'}, jsx(VectorInputX, {
                                        binding: new BindingTwoWay(),
                                        link: {observer, path: 'selected.min'},
                                        dimensions: 3
                                    })),
                                    jsx(LabelGroupX, {text: 'Max [x,y,z]'}, jsx(VectorInputX, {
                                        binding: new BindingTwoWay(),
                                        link: {observer, path: 'selected.max'},
                                        dimensions: 3
                                    })),
                                    // Simple per-face editor (compact): select face, then edit fields
                                    // Plane editor (uses component-level state)
                                    jsx('div', {style: {height: '1px', background: 'rgba(255,255,255,0.06)', margin: '6px 0'}}),
                                    jsx('div', {
                                        style: {
                                            color: '#cfd3da',
                                            fontSize: '12px',
                                            fontWeight: 700,
                                            opacity: 0.9,
                                            margin: '2px 0 6px 0'
                                        }
                                    }, 'Boundary Planes'),
                                    jsx(LabelGroupX, {text: 'Face'}, jsx(SelectInputX, {
                                        type: 'string',
                                        options: ['X_min', 'X_max', 'Y_min', 'Y_max', 'Z_min', 'Z_max'].map(f => ({
                                            v: f,
                                            t: f
                                        })),
                                        value: apFace,
                                        onChange: (v) => setApFace(String(v))
                                    })),
                                    jsx(LabelGroupX, {text: 'BoundaryScheme'}, jsx(SelectInputX, {
                                        type: 'string', options: [
                                            {v: '1', t: 'HBB (1)'}, {v: '2', t: 'FBB (2)'}, {v: '4', t: 'EQ (4)'}, {
                                                v: '8',
                                                t: 'NEQ (8)'
                                            }
                                        ], value: apBS, onChange: (v) => setApBS(String(v))
                                    })),
                                    jsx(LabelGroupX, {text: 'WallType'}, jsx(SelectInputX, {
                                        type: 'string',
                                        options: [{v: '8', t: 'Inlet (8)'}, {v: '16', t: 'Outlet (16)'}, {
                                            v: '32',
                                            t: 'FixedWall (32)'
                                        }],
                                        value: apWT,
                                        onChange: (v) => setApWT(String(v))
                                    })),
                                    jsx(LabelGroupX, {text: 'ValueType'}, jsx(SelectInputX, {
                                        type: 'string',
                                        options: [{v: '1', t: 'Velocity (1)'}, {v: '0', t: 'Pressure (0)'}],
                                        value: apVT,
                                        onChange: (v) => setApVT(String(v))
                                    })),
                                    jsx(LabelGroupX, {text: 'Velocity'}, jsx('div', {style: {display: 'flex', gap: '6px'}},
                                        jsx(TextInputX, {value: apVX, onChange: (v) => setApVX(String(v))}),
                                        jsx(TextInputX, {value: apVY, onChange: (v) => setApVY(String(v))}),
                                        jsx(TextInputX, {value: apVZ, onChange: (v) => setApVZ(String(v))})
                                    )),
                                    jsx(LabelGroupX, {text: 'Pressure'}, jsx(TextInputX, {
                                        value: apPR,
                                        onChange: (v) => setApPR(String(v))
                                    })),
                                    jsx(LabelGroupX, {text: 'Concentration1'}, jsx(TextInputX, {
                                        value: apC1,
                                        onChange: (v) => setApC1(String(v))
                                    })),
                                    jsx(LabelGroupX, {text: 'Concentration2'}, jsx(TextInputX, {
                                        value: apC2,
                                        onChange: (v) => setApC2(String(v))
                                    })),
                                    jsx(LabelGroupX, {text: 'Concentration3'}, jsx(TextInputX, {
                                        value: apC3,
                                        onChange: (v) => setApC3(String(v))
                                    })),
                                    jsx('div', {style: {display: 'flex', justifyContent: 'flex-end'}}, jsx(ButtonX, {
                                        text: '적용', onClick: () => {
                                            if (!sel) return;
                                            api.setAnalysisPlaneById && api.setAnalysisPlaneById(sel.id, apFace, {
                                                boundaryScheme: parseInt(apBS),
                                                wallType: parseInt(apWT),
                                                valueType: parseInt(apVT),

                                                velocity: [parseFloat(apVX) || 0, parseFloat(apVY) || 0, parseFloat(apVZ) || 0],
                                                pressure: parseFloat(apPR) || 0,
                                                concentration1: parseFloat(apC1) || 0,
                                                concentration2: parseFloat(apC2) || 0,
                                                concentration3: parseFloat(apC3) || 0
                                            });
                                        }
                                    }))
                                ),
                                // VTK Glyphs (Merged under vtk-volume): Colormap controls
                                // 위치: mesh-import 전역 블록 바깥에 두어 vtk-volume 타입에서도 표시되도록 함
                                (sel && sel.kind === 'vtk-glyphs-merged') && fragment(
                                    jsx('div', {style: {height: '1px', background: 'rgba(255,255,255,0.06)', margin: '6px 0'}}),
                                    jsx('div', {
                                        style: {
                                            color: '#cfd3da',
                                            fontSize: '12px',
                                            fontWeight: 700,
                                            opacity: 0.9,
                                            margin: '2px 0 6px 0'
                                        }
                                    }, 'VTK Glyphs Colormap'),
                                    sel.scalarStats && jsx('div', {
                                            style: {
                                                color: '#9aa4b2',
                                                fontSize: '11px',
                                                marginBottom: '4px'
                                            }
                                        }, `Scalars: ${sel.scalarStats.name || 'speed'}`
                                    ),
                                    jsx(LabelGroupX, {text: 'Preset'}, jsx(SelectInputX, {
                                        type: 'string',
                                        options: [
                                            {v: 'viridis', t: 'Viridis'}, {v: 'plasma', t: 'Plasma'},
                                            {v: 'coolwarm', t: 'Coolwarm'}, {v: 'blue-red', t: 'Blue→Red'}
                                        ],
                                        value: colPreset,
                                        onChange: (v) => {
                                            const s = String(v);
                                            setColPreset(s);
                                            api.setWindColoringById && api.setWindColoringById(sel.id, {preset: s});
                                        }
                                    })),
                                    jsx(LabelGroupX, {text: 'Reverse'}, jsx(SelectInputX, {
                                        type: 'string', options: [{v: 'no', t: 'No'}, {v: 'yes', t: 'Yes'}], value: colReverse,
                                        onChange: (v) => {
                                            const s = String(v);
                                            setColReverse(s);
                                            api.setWindColoringById && api.setWindColoringById(sel.id, {reverse: s === 'yes'});
                                        }
                                    })),
                                    jsx(LabelGroupX, {text: 'Auto Range'}, jsx(SelectInputX, {
                                        type: 'string', options: [{v: 'yes', t: 'Yes'}, {v: 'no', t: 'No'}], value: colAuto,
                                        onChange: (v) => {
                                            const s = String(v);
                                            setColAuto(s);
                                            api.setWindColoringById && api.setWindColoringById(sel.id, {autoRange: s === 'yes'});
                                        }
                                    })),
                                    jsx(LabelGroupX, {text: 'Min'}, jsx(TextInputX, {
                                        value: colMin, onChange: (v) => {
                                            const s = String(v);
                                            setColMin(s);
                                            const n = parseFloat(s);
                                            if (isFinite(n)) api.setWindColoringById && api.setWindColoringById(sel.id, {min: n});
                                        }
                                    })),
                                    jsx(LabelGroupX, {text: 'Max'}, jsx(TextInputX, {
                                        value: colMax, onChange: (v) => {
                                            const s = String(v);
                                            setColMax(s);
                                            const n = parseFloat(s);
                                            if (isFinite(n)) api.setWindColoringById && api.setWindColoringById(sel.id, {max: n});
                                        }
                                    })),
                                    jsx(LabelGroupX, {text: 'Opacity'}, jsx(TextInputX, {
                                        value: colOpacity, onChange: (v) => {
                                            const s = String(v);
                                            setColOpacity(s);
                                            const n = parseFloat(s);
                                            if (isFinite(n)) api.setWindColoringById && api.setWindColoringById(sel.id, {opacity: Math.max(0, Math.min(1, n))});
                                        }
                                    }))
                                    ,
                                    jsx('div', {style: {display: 'flex', justifyContent: 'flex-end', gap: '6px'}},
                                        jsx(ButtonX, {
                                            text: '적용', onClick: () => {
                                                if (!sel) return;
                                                const payload = {
                                                    preset: String(colPreset || 'viridis'),
                                                    reverse: colReverse === 'yes',
                                                    autoRange: colAuto === 'yes'
                                                };
                                                const mn = parseFloat(colMin);
                                                const mx = parseFloat(colMax);
                                                const op = parseFloat(colOpacity);
                                                if (isFinite(mn)) payload.min = mn;
                                                if (isFinite(mx)) payload.max = mx;
                                                if (isFinite(op)) payload.opacity = Math.max(0, Math.min(1, op));
                                                api.setWindColoringById && api.setWindColoringById(sel.id, payload);
                                            }
                                        }),
                                        jsx(ButtonX, {
                                            text: '재생성', onClick: () => {
                                                if (!sel) return;
                                                api.regenerateVTKGlyphsById && api.regenerateVTKGlyphsById(sel.id);
                                            }
                                        })
                                    )
                                ),
                                sel.type === 'mesh-import' && fragment(
                                    // Scalar Slice inspector (when kind === scalar-slice)
                                    sel.scalarSlice && fragment(
                                        jsx('div', {style: {height: '1px', background: 'rgba(255,255,255,0.06)', margin: '6px 0'}}),
                                        jsx('div', {
                                            style: {
                                                color: '#cfd3da',
                                                fontSize: '12px',
                                                fontWeight: 700,
                                                opacity: 0.9,
                                                margin: '2px 0 6px 0'
                                            }
                                        }, 'Scalar Slice'),
                                        sel.scalarInfo && jsx('div', {
                                                style: {
                                                    color: '#9aa4b2',
                                                    fontSize: '11px',
                                                    marginBottom: '6px'
                                                }
                                            },
                                            `dims ${sel.scalarInfo.dims?.join('×')} | spacing ${sel.scalarInfo.spacing?.map(v => Number(v).toFixed(3)).join(', ')} | origin ${sel.scalarInfo.origin?.map(v => Number(v).toFixed(3)).join(', ')}`
                                        ),
                                        jsx(LabelGroupX, {text: 'Resolution'}, jsx(SelectInputX, {
                                            type: 'string',
                                            options: [{v: '64', t: '64×64'}, {v: '128', t: '128×128'}, {v: '256', t: '256×256'}],
                                            value: sliceRes,
                                            onChange: (v) => {
                                                const s = String(v);
                                                setSliceRes(s);
                                                const n = Math.max(2, parseInt(s) || 128);
                                                api.setScalarSliceParamsById && api.setScalarSliceParamsById(sel.id, {
                                                    resU: n,
                                                    resV: n
                                                });
                                            }
                                        })),
                                        // Colormap controls (reuse existing coloring API)
                                        jsx('div', {style: {height: '1px', background: 'rgba(255,255,255,0.06)', margin: '8px 0'}}),
                                        jsx('div', {
                                            style: {
                                                color: '#cfd3da',
                                                fontSize: '12px',
                                                fontWeight: 700,
                                                opacity: 0.9,
                                                margin: '2px 0 6px 0'
                                            }
                                        }, 'Colormap'),
                                        sel.scalarStats && jsx('div', {
                                            style: {
                                                color: '#9aa4b2',
                                                fontSize: '11px',
                                                marginBottom: '4px'
                                            }
                                        }, `Scalars: ${sel.scalarStats.name || 'scalars'}`),
                                        jsx(LabelGroupX, {text: 'Preset'}, jsx(SelectInputX, {
                                            type: 'string', options: [
                                                {v: 'viridis', t: 'Viridis'}, {v: 'plasma', t: 'Plasma'},
                                                {v: 'coolwarm', t: 'Coolwarm'}, {v: 'blue-red', t: 'Blue→Red'}
                                            ], value: colPreset,
                                            onChange: (v) => {
                                                const s = String(v);
                                                setColPreset(s);
                                                api.setWindColoringById && api.setWindColoringById(sel.id, {preset: s});
                                            }
                                        })),
                                        jsx(LabelGroupX, {text: 'Reverse'}, jsx(SelectInputX, {
                                            type: 'string', options: [{v: 'no', t: 'No'}, {v: 'yes', t: 'Yes'}], value: colReverse,
                                            onChange: (v) => {
                                                const s = String(v);
                                                setColReverse(s);
                                                api.setWindColoringById && api.setWindColoringById(sel.id, {reverse: s === 'yes'});
                                            }
                                        })),
                                        jsx(LabelGroupX, {text: 'Auto Range'}, jsx(SelectInputX, {
                                            type: 'string', options: [{v: 'yes', t: 'Yes'}, {v: 'no', t: 'No'}], value: colAuto,
                                            onChange: (v) => {
                                                const s = String(v);
                                                setColAuto(s);
                                                api.setWindColoringById && api.setWindColoringById(sel.id, {autoRange: s === 'yes'});
                                            }
                                        })),
                                        jsx(LabelGroupX, {text: 'Min'}, jsx(TextInputX, {
                                            value: colMin, onChange: (v) => {
                                                const s = String(v);
                                                setColMin(s);
                                                const n = parseFloat(s);
                                                if (isFinite(n)) api.setWindColoringById && api.setWindColoringById(sel.id, {min: n});
                                            }
                                        })),
                                        jsx(LabelGroupX, {text: 'Max'}, jsx(TextInputX, {
                                            value: colMax, onChange: (v) => {
                                                const s = String(v);
                                                setColMax(s);
                                                const n = parseFloat(s);
                                                if (isFinite(n)) api.setWindColoringById && api.setWindColoringById(sel.id, {max: n});
                                            }
                                        })),
                                        jsx(LabelGroupX, {text: 'Opacity'}, jsx(TextInputX, {
                                            value: colOpacity, onChange: (v) => {
                                                const s = String(v);
                                                setColOpacity(s);
                                                const n = parseFloat(s);
                                                if (isFinite(n)) api.setWindColoringById && api.setWindColoringById(sel.id, {opacity: Math.max(0, Math.min(1, n))});
                                            }
                                        })),
                                        jsx('div', {style: {display: 'flex', justifyContent: 'flex-end', gap: '6px'}},
                                            jsx(ButtonX, {
                                                text: '색만 갱신', onClick: () => {
                                                    api.recolorScalarSliceById && api.recolorScalarSliceById(sel.id);
                                                }
                                            }),
                                            jsx(ButtonX, {
                                                text: '재생성', onClick: () => {
                                                    api.regenerateScalarSliceById && api.regenerateScalarSliceById(sel.id);
                                                }
                                            })
                                        )
                                    ),
                                    // Y-Slice (Horizontal Speed Slice)
                                    sel.ySlice && fragment(
                                        jsx('div', {style: {height: '1px', background: 'rgba(255,255,255,0.06)', margin: '6px 0'}}),
                                        jsx('div', {
                                            style: {
                                                color: '#cfd3da',
                                                fontSize: '12px',
                                                fontWeight: 700,
                                                opacity: 0.9,
                                                margin: '2px 0 6px 0'
                                            }
                                        }, 'Horizontal Slice (Speed)'),
                                        sel.scalarInfo && jsx('div', {
                                                style: {
                                                    color: '#9aa4b2',
                                                    fontSize: '11px',
                                                    marginBottom: '6px'
                                                }
                                            },
                                            `dims ${sel.scalarInfo.dims?.join('×')} | spacing ${sel.scalarInfo.spacing?.map(v => Number(v).toFixed(3)).join(', ')} | origin ${sel.scalarInfo.origin?.map(v => Number(v).toFixed(3)).join(', ')}`
                                        ),
                                        jsx(LabelGroupX, {text: 'Height (0..1)'}, jsx(TextInputX, {
                                            value: ySliceHeight,
                                            onChange: (v) => {
                                                const s = String(v);
                                                setYSliceHeight(s);
                                                const n0 = parseFloat(s);
                                                if (!isFinite(n0)) return;
                                                const n = Math.max(0, Math.min(1, n0));
                                                // Skip no-op updates that can happen on initial mount
                                                const cur = (sel && sel.heightT != null) ? Number(sel.heightT) : 0.5;
                                                if (Math.abs(n - cur) < 1e-6) return;
                                                api.setYSliceParamsById && api.setYSliceParamsById(sel.id, {heightT: n});
                                                api.regenerateYSliceById && api.regenerateYSliceById(sel.id);
                                            }
                                        })),
                                        jsx(LabelGroupX, {text: 'Resolution'}, jsx(SelectInputX, {
                                            type: 'string',
                                            options: [{v: '64', t: '64×64'}, {v: '128', t: '128×128'}, {v: '256', t: '256×256'}],
                                            value: sliceRes,
                                            onChange: (v) => {
                                                const s = String(v);
                                                setSliceRes(s);
                                                const n = Math.max(2, parseInt(s) || 128);
                                                const curRes = (sel && sel.sliceParams && sel.sliceParams.resU) ? Number(sel.sliceParams.resU) : 128;
                                                if (n === curRes) return; // avoid redundant regen on mount
                                                api.setYSliceParamsById && api.setYSliceParamsById(sel.id, {res: n});
                                                api.regenerateYSliceById && api.regenerateYSliceById(sel.id);
                                            }
                                        })),
                                        // Colormap controls
                                        jsx('div', {style: {height: '1px', background: 'rgba(255,255,255,0.06)', margin: '8px 0'}}),
                                        jsx('div', {
                                            style: {
                                                color: '#cfd3da',
                                                fontSize: '12px',
                                                fontWeight: 700,
                                                opacity: 0.9,
                                                margin: '2px 0 6px 0'
                                            }
                                        }, 'Colormap'),
                                        sel.scalarStats && jsx('div', {
                                            style: {
                                                color: '#9aa4b2',
                                                fontSize: '11px',
                                                marginBottom: '4px'
                                            }
                                        }, `Scalars: ${sel.scalarStats.name || 'speed'}`),
                                        jsx(LabelGroupX, {text: 'Preset'}, jsx(SelectInputX, {
                                            type: 'string', options: [
                                                {v: 'viridis', t: 'Viridis'}, {v: 'plasma', t: 'Plasma'},
                                                {v: 'coolwarm', t: 'Coolwarm'}, {v: 'blue-red', t: 'Blue→Red'}
                                            ], value: colPreset,
                                            onChange: (v) => {
                                                const s = String(v);
                                                setColPreset(s);
                                                api.setWindColoringById && api.setWindColoringById(sel.id, {preset: s});
                                            }
                                        })),
                                        jsx(LabelGroupX, {text: 'Reverse'}, jsx(SelectInputX, {
                                            type: 'string', options: [{v: 'no', t: 'No'}, {v: 'yes', t: 'Yes'}], value: colReverse,
                                            onChange: (v) => {
                                                const s = String(v);
                                                setColReverse(s);
                                                api.setWindColoringById && api.setWindColoringById(sel.id, {reverse: s === 'yes'});
                                            }
                                        })),
                                        jsx(LabelGroupX, {text: 'Auto Range'}, jsx(SelectInputX, {
                                            type: 'string', options: [{v: 'yes', t: 'Yes'}, {v: 'no', t: 'No'}], value: colAuto,
                                            onChange: (v) => {
                                                const s = String(v);
                                                setColAuto(s);
                                                api.setWindColoringById && api.setWindColoringById(sel.id, {autoRange: s === 'yes'});
                                            }
                                        })),
                                        jsx(LabelGroupX, {text: 'Min'}, jsx(TextInputX, {
                                            value: colMin, onChange: (v) => {
                                                const s = String(v);
                                                setColMin(s);
                                                const n = parseFloat(s);
                                                if (isFinite(n)) api.setWindColoringById && api.setWindColoringById(sel.id, {min: n});
                                            }
                                        })),
                                        jsx(LabelGroupX, {text: 'Max'}, jsx(TextInputX, {
                                            value: colMax, onChange: (v) => {
                                                const s = String(v);
                                                setColMax(s);
                                                const n = parseFloat(s);
                                                if (isFinite(n)) api.setWindColoringById && api.setWindColoringById(sel.id, {max: n});
                                            }
                                        })),
                                        jsx(LabelGroupX, {text: 'Opacity'}, jsx(TextInputX, {
                                            value: colOpacity, onChange: (v) => {
                                                const s = String(v);
                                                setColOpacity(s);
                                                const n = parseFloat(s);
                                                if (isFinite(n)) api.setWindColoringById && api.setWindColoringById(sel.id, {opacity: Math.max(0, Math.min(1, n))});
                                            }
                                        })),
                                        jsx('div', {style: {display: 'flex', justifyContent: 'flex-end', gap: '6px'}},
                                            jsx(ButtonX, {
                                                text: '색만 갱신', onClick: () => {
                                                    api.recolorYSliceById && api.recolorYSliceById(sel.id);
                                                }
                                            }),
                                            jsx(ButtonX, {
                                                text: '재생성', onClick: () => {
                                                    api.regenerateYSliceById && api.regenerateYSliceById(sel.id);
                                                }
                                            })
                                        )
                                    ),
                                    // Wind streamlines section (only when streamParams available)
                                    sel.streamParams && fragment(
                                        jsx('div', {style: {height: '1px', background: 'rgba(255,255,255,0.06)', margin: '6px 0'}}),
                                        jsx('div', {
                                            style: {
                                                color: '#cfd3da',
                                                fontSize: '12px',
                                                fontWeight: 700,
                                                opacity: 0.9,
                                                margin: '2px 0 6px 0'
                                            }
                                        }, 'Wind Streamlines'),
                                        sel.windInfo && jsx('div', {
                                                style: {
                                                    color: '#9aa4b2',
                                                    fontSize: '11px',
                                                    marginBottom: '6px'
                                                }
                                            },
                                            `dims ${sel.windInfo.dims?.join('×')} | spacing ${sel.windInfo.spacing?.map(v => Number(v).toFixed(3)).join(', ')} | origin ${sel.windInfo.origin?.map(v => Number(v).toFixed(3)).join(', ')}`
                                        ),
                                        jsx(LabelGroupX, {text: 'Seed Stride (voxels)'}, jsx(TextInputX, {
                                            value: slSeedStride,
                                            onChange: (v) => {
                                                const s = String(v);
                                                setSlSeedStride(s);
                                                const n = Math.max(1, parseInt(s) || 1);
                                                api.setStreamlineParamsById && api.setStreamlineParamsById(sel.id, {seedStride: n});
                                            }
                                        })),
                                        jsx(LabelGroupX, {text: 'Step (world units)'}, jsx(TextInputX, {
                                            value: slStep,
                                            onChange: (v) => {
                                                const s = String(v);
                                                setSlStep(s);
                                                const n = parseFloat(s);
                                                if (isFinite(n)) api.setStreamlineParamsById && api.setStreamlineParamsById(sel.id, {step: n});
                                            }
                                        })),
                                        jsx(LabelGroupX, {text: 'Max Steps'}, jsx(TextInputX, {
                                            value: slMaxSteps,
                                            onChange: (v) => {
                                                const s = String(v);
                                                setSlMaxSteps(s);
                                                const n = Math.max(1, parseInt(s) || 1);
                                                api.setStreamlineParamsById && api.setStreamlineParamsById(sel.id, {maxSteps: n});
                                            }
                                        })),
                                        jsx(LabelGroupX, {text: 'Min Speed'}, jsx(TextInputX, {
                                            value: slMinSpeed,
                                            onChange: (v) => {
                                                const s = String(v);
                                                setSlMinSpeed(s);
                                                const n = parseFloat(s);
                                                if (isFinite(n)) api.setStreamlineParamsById && api.setStreamlineParamsById(sel.id, {minSpeed: n});
                                            }
                                        })),
                                        jsx(LabelGroupX, {text: 'Ribbon Width'}, jsx(TextInputX, {
                                            value: slWidth,
                                            onChange: (v) => {
                                                const s = String(v);
                                                setSlWidth(s);
                                                const n = parseFloat(s);
                                                if (isFinite(n)) api.setStreamlineParamsById && api.setStreamlineParamsById(sel.id, {width: n});
                                            }
                                        })),
                                        // Advanced seeding controls
                                        jsx('div', {
                                            style: {
                                                color: '#9aa4b2',
                                                fontSize: '11px',
                                                margin: '6px 0 2px'
                                            }
                                        }, 'Seeding (Advanced)'),
                                        jsx(LabelGroupX, {text: 'Seed Plane'}, jsx(SelectInputX, {
                                            type: 'string',
                                            options: [{v: 'XZ', t: 'XZ (기본)'}, {v: 'XY', t: 'XY'}, {v: 'YZ', t: 'YZ'}],
                                            value: slSeedPlane,
                                            onChange: (v) => {
                                                const s = String(v).toUpperCase();
                                                setSlSeedPlane(s);
                                                api.setStreamlineParamsById && api.setStreamlineParamsById(sel.id, {seedPlane: s});
                                            }
                                        })),
                                        jsx(LabelGroupX, {text: 'Seed Offset (0..1)'}, jsx(TextInputX, {
                                            value: slSeedOffset,
                                            onChange: (v) => {
                                                const s = String(v);
                                                setSlSeedOffset(s);
                                                const n = parseFloat(s);
                                                if (isFinite(n)) api.setStreamlineParamsById && api.setStreamlineParamsById(sel.id, {seedOffset: n});
                                            }
                                        })),
                                        jsx(LabelGroupX, {text: 'Seed Index (정수)'}, jsx(TextInputX, {
                                            value: slSeedIndex,
                                            onChange: (v) => {
                                                const s = String(v);
                                                setSlSeedIndex(s);
                                                const n = parseInt(s);
                                                if (!isNaN(n)) api.setStreamlineParamsById && api.setStreamlineParamsById(sel.id, {seedIndex: n});
                                            }
                                        })),
                                        jsx(LabelGroupX, {text: 'Seed Jitter (0..1)'}, jsx(TextInputX, {
                                            value: slSeedJitter,
                                            onChange: (v) => {
                                                const s = String(v);
                                                setSlSeedJitter(s);
                                                const n = parseFloat(s);
                                                if (isFinite(n)) api.setStreamlineParamsById && api.setStreamlineParamsById(sel.id, {seedJitter: n});
                                            }
                                        })),
                                        jsx('div', {style: {display: 'flex', justifyContent: 'flex-end', gap: '6px'}},
                                            jsx(ButtonX, {
                                                text: '재생성', onClick: () => {
                                                    api.regenerateWindStreamlinesById && api.regenerateWindStreamlinesById(sel.id);
                                                }
                                            })
                                        )
                                    ),
                                    // Colormap controls
                                    sel.streamParams && fragment(
                                        jsx('div', {style: {height: '1px', background: 'rgba(255,255,255,0.06)', margin: '8px 0'}}),
                                        jsx('div', {
                                            style: {
                                                color: '#cfd3da',
                                                fontSize: '12px',
                                                fontWeight: 700,
                                                opacity: 0.9,
                                                margin: '2px 0 6px 0'
                                            }
                                        }, 'Colormap'),
                                        sel.hasScalars && jsx('div', {
                                            style: {
                                                color: '#9aa4b2',
                                                fontSize: '11px',
                                                marginBottom: '4px'
                                            }
                                        }, `Scalars: ${sel.scalarName || 'unknown'}`),
                                        jsx(LabelGroupX, {text: 'Source'}, jsx(SelectInputX, {
                                            type: 'string',
                                            options: [{v: 'scalar', t: 'Scalars'}, {v: 'speed', t: 'Speed |v|'}],
                                            value: colSource,
                                            onChange: (v) => {
                                                const s = String(v);
                                                setColSource(s);
                                                api.setWindColoringById && api.setWindColoringById(sel.id, {source: s});
                                            }
                                        })),
                                        jsx(LabelGroupX, {text: 'Preset'}, jsx(SelectInputX, {
                                            type: 'string', options: [
                                                {v: 'viridis', t: 'Viridis'}, {v: 'plasma', t: 'Plasma'},
                                                {v: 'coolwarm', t: 'Coolwarm'}, {v: 'blue-red', t: 'Blue→Red'}
                                            ], value: colPreset,
                                            onChange: (v) => {
                                                const s = String(v);
                                                setColPreset(s);
                                                api.setWindColoringById && api.setWindColoringById(sel.id, {preset: s});
                                            }
                                        })),
                                        jsx(LabelGroupX, {text: 'Reverse'}, jsx(SelectInputX, {
                                            type: 'string', options: [{v: 'no', t: 'No'}, {v: 'yes', t: 'Yes'}], value: colReverse,
                                            onChange: (v) => {
                                                const s = String(v);
                                                setColReverse(s);
                                                api.setWindColoringById && api.setWindColoringById(sel.id, {reverse: s === 'yes'});
                                            }
                                        })),
                                        jsx(LabelGroupX, {text: 'Auto Range'}, jsx(SelectInputX, {
                                            type: 'string', options: [{v: 'yes', t: 'Yes'}, {v: 'no', t: 'No'}], value: colAuto,
                                            onChange: (v) => {
                                                const s = String(v);
                                                setColAuto(s);
                                                api.setWindColoringById && api.setWindColoringById(sel.id, {autoRange: s === 'yes'});
                                            }
                                        })),
                                        jsx(LabelGroupX, {text: 'Min'}, jsx(TextInputX, {
                                            value: colMin, onChange: (v) => {
                                                const s = String(v);
                                                setColMin(s);
                                                const n = parseFloat(s);
                                                if (isFinite(n)) api.setWindColoringById && api.setWindColoringById(sel.id, {min: n});
                                            }
                                        })),
                                        jsx(LabelGroupX, {text: 'Max'}, jsx(TextInputX, {
                                            value: colMax, onChange: (v) => {
                                                const s = String(v);
                                                setColMax(s);
                                                const n = parseFloat(s);
                                                if (isFinite(n)) api.setWindColoringById && api.setWindColoringById(sel.id, {max: n});
                                            }
                                        })),
                                        jsx(LabelGroupX, {text: 'Opacity'}, jsx(TextInputX, {
                                            value: colOpacity, onChange: (v) => {
                                                const s = String(v);
                                                setColOpacity(s);
                                                const n = parseFloat(s);
                                                if (isFinite(n)) api.setWindColoringById && api.setWindColoringById(sel.id, {opacity: Math.max(0, Math.min(1, n))});
                                            }
                                        })),
                                        jsx('div', {style: {display: 'flex', justifyContent: 'flex-end', gap: '6px'}},
                                            jsx(ButtonX, {
                                                text: '색만 갱신', onClick: () => {
                                                    api.recolorWindStreamlinesById && api.recolorWindStreamlinesById(sel.id);
                                                }
                                            })
                                        )
                                    ),
                                    // Animation controls
                                    sel.streamParams && fragment(
                                        jsx('div', {style: {height: '1px', background: 'rgba(255,255,255,0.06)', margin: '8px 0'}}),
                                        jsx('div', {
                                            style: {
                                                color: '#cfd3da',
                                                fontSize: '12px',
                                                fontWeight: 700,
                                                opacity: 0.9,
                                                margin: '2px 0 6px 0'
                                            }
                                        }, 'Animation'),
                                        jsx(LabelGroupX, {text: 'Style'}, jsx(SelectInputX, {
                                            type: 'string', options: [
                                                {v: 'off', t: 'Off'}, {v: 'head', t: 'Head (one-way)'},
                                                {v: 'pingpong', t: 'Head (ping-pong)'}, {v: 'dashes', t: 'Dashes'}
                                            ], value: animStyle,
                                            onChange: (v) => {
                                                const s = String(v);
                                                setAnimStyle(s);
                                                api.setWindAnimationById && api.setWindAnimationById(sel.id, {style: s});
                                            }
                                        })),
                                        jsx(LabelGroupX, {text: 'Speed'}, jsx(TextInputX, {
                                            value: animSpeed, onChange: (v) => {
                                                const s = String(v);
                                                setAnimSpeed(s);
                                                const n = parseFloat(s);
                                                if (isFinite(n)) api.setWindAnimationById && api.setWindAnimationById(sel.id, {speed: n});
                                            }
                                        })),
                                        jsx(LabelGroupX, {text: 'Trail'}, jsx(TextInputX, {
                                            value: animTrail, onChange: (v) => {
                                                const s = String(v);
                                                setAnimTrail(s);
                                                const n = parseFloat(s);
                                                if (isFinite(n)) api.setWindAnimationById && api.setWindAnimationById(sel.id, {trail: n});
                                            }
                                        })),
                                        jsx(LabelGroupX, {text: 'Repeat (dashes)'}, jsx(TextInputX, {
                                            value: animRepeat, onChange: (v) => {
                                                const s = String(v);
                                                setAnimRepeat(s);
                                                const n = parseFloat(s);
                                                if (isFinite(n)) api.setWindAnimationById && api.setWindAnimationById(sel.id, {repeat: n});
                                            }
                                        })),
                                        jsx(LabelGroupX, {text: 'Feather (dashes)'}, jsx(TextInputX, {
                                            value: animFeather, onChange: (v) => {
                                                const s = String(v);
                                                setAnimFeather(s);
                                                const n = parseFloat(s);
                                                if (isFinite(n)) api.setWindAnimationById && api.setWindAnimationById(sel.id, {feather: n});
                                            }
                                        })),
                                        jsx(LabelGroupX, {text: 'Playing'}, jsx(SelectInputX, {
                                            type: 'string', options: [{v: 'yes', t: 'Yes'}, {v: 'no', t: 'No'}], value: animPlaying,
                                            onChange: (v) => {
                                                const s = String(v);
                                                setAnimPlaying(s);
                                                api.setWindAnimationById && api.setWindAnimationById(sel.id, {playing: s === 'yes'});
                                            }
                                        }))
                                    ),
                                    jsx('div', {style: {height: '1px', background: 'rgba(255,255,255,0.06)', margin: '6px 0'}}),
                                    jsx('div', {
                                        style: {
                                            color: '#cfd3da',
                                            fontSize: '12px',
                                            fontWeight: 700,
                                            opacity: 0.9,
                                            margin: '2px 0 6px 0'
                                        }
                                    }, 'Mesh Operations'),
                                    jsx(LabelGroupX, {text: 'Epsilon'}, jsx(TextInputX, {
                                        value: splitEpsilon,
                                        onChange: (v) => setSplitEpsilon(String(v)),
                                        placeholder: '0.0001'
                                    })),
                                    jsx(LabelGroupX, {text: 'Min Triangles'}, jsx(TextInputX, {
                                        value: splitMinTris,
                                        onChange: (v) => setSplitMinTris(String(v)),
                                        placeholder: '10'
                                    })),
                                    jsx(LabelGroupX, {text: 'Keep Original'}, jsx(SelectInputX, {
                                        type: 'string',
                                        options: [{v: 'yes', t: 'Yes'}, {v: 'no', t: 'No'}],
                                        value: splitKeepOriginal,
                                        onChange: (v) => setSplitKeepOriginal(String(v))
                                    })),
                                    jsx(LabelGroupX, {text: 'Name Prefix'}, jsx(TextInputX, {
                                        value: splitNamePrefix,
                                        onChange: (v) => setSplitNamePrefix(String(v)),
                                        placeholder: 'e.g. Building_'
                                    })),
                                    jsx('div', {style: {display: 'flex', justifyContent: 'flex-end', gap: '6px'}},
                                        jsx(ButtonX, {
                                            text: '연결 요소로 분리', onClick: () => {
                                                const eps = parseFloat(splitEpsilon);
                                                const mt = Math.max(1, parseInt(splitMinTris) || 10);
                                                setBusy(true);
                                                setBusyMsg('분리 준비…');
                                                setBusyCancelable(null);
                                                api.splitSelectedMesh && api.splitSelectedMesh({
                                                    epsilon: isFinite(eps) && eps > 0 ? eps : 1e-4,
                                                    minTriangles: mt,
                                                    keepOriginal: splitKeepOriginal === 'yes',
                                                    namePrefix: String(splitNamePrefix || '').trim()
                                                }, {
                                                    onCancelable: (fn) => setBusyCancelable(() => fn),
                                                    onProgress: (p, phase) => setBusyMsg(`분리 중… ${(Math.max(0, Math.min(1, p)) * 100).toFixed(1)}% ${phase ? '[' + phase + ']' : ''}`),
                                                    onDone: () => {
                                                        setBusy(false);
                                                        setBusyMsg('');
                                                        setBusyCancelable(null);
                                                    },
                                                    onError: (m) => {
                                                        console.error(m);
                                                        setBusy(false);
                                                        setBusyMsg('');
                                                        setBusyCancelable(null);
                                                    }
                                                });
                                            }
                                        })
                                    )
                                )
                            ) : jsx('div', null, 'No selection')
                        )
                    )
            )
        );
    };

    // Busy overlay element (shown during long ops)
    const BusyOverlay = busy && jsx('div', {
            style: {
                position: 'fixed', left: 0, top: 0, right: 0, bottom: 0,
                background: 'rgba(0,0,0,0.35)', zIndex: 3000,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                pointerEvents: 'auto'
            }
        },
        jsx('style', null, `
            @keyframes se9spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        `),
        jsx('div', {
                style: {
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: '10px',
                    padding: '16px',
                    background: 'rgba(20,22,26,0.9)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: '10px',
                    boxShadow: '0 18px 50px rgba(0,0,0,0.6)'
                }
            },
            jsx('div', {
                style: {
                    width: '26px',
                    height: '26px',
                    borderRadius: '50%',
                    border: '3px solid rgba(255,255,255,0.15)',
                    borderTopColor: '#4c8bf5',
                    animation: 'se9spin 0.8s linear infinite'
                }
            }),
            jsx('div', {style: {color: '#d4d8de', fontSize: '12px', whiteSpace: 'pre'}}, busyMsg || '로딩 중…'),
            !!busyCancelable && jsx(ButtonX, {
                text: '취소', onClick: () => {
                    try {
                        busyCancelable();
                    } catch (_) {
                    } finally {
                        setBusyCancelable(null);
                    }
                }
            })
        )
    );

    // Import Options overlay — rendered at top level (not inside menu DOM)
    const ImportOptionsOverlay = showImportDlg && jsx('div', {
        style: {
            position: 'fixed', left: 0, top: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.5)', zIndex: 2000,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'auto'
        },
        onPointerDown: (ev) => {
            if (ev.target === ev.currentTarget) closeImportDialog();
        }
    }, jsx('div', {
            style: {
                minWidth: '360px', maxWidth: '520px', background: '#1b1f24', color: '#e6e6e6',
                border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px',
                boxShadow: '0 20px 60px rgba(0,0,0,0.6)', padding: '14px'
            },
            onPointerDown: (e) => {
                e.stopPropagation();
            }
        },
        jsx('div', {style: {fontSize: '15px', fontWeight: 700, marginBottom: '10px'}}, '가져오기 옵션'),
        // Files/handles list
        jsx('div', {
                style: {
                    maxHeight: '120px',
                    overflow: 'auto',
                    marginBottom: '10px',
                    fontSize: '12px',
                    opacity: 0.9
                }
            },
            (pendingImportFiles
                    ? pendingImportFiles.map(f => jsx('div', {key: f.name}, f.name))
                    : (pendingImportHandles || []).map(h => jsx('div', {key: h.name || Math.random().toString(36).slice(2)}, h.name || '(알 수 없는 이름)'))
            )
        ),
        // Options
        jsx('div', {style: {display: 'grid', gridTemplateColumns: '120px 1fr', gap: '8px', alignItems: 'center'}},
            jsx('div', {style: {opacity: 0.9}}, 'Scale'),
            jsx(TextInputX, {
                value: importScale,
                onChange: (v) => setImportScale(String(v)),
                placeholder: '1'
            }),
            jsx('div', {style: {opacity: 0.9}}, 'Up 벡터'),
            jsx(SelectInputX, {
                type: 'string',
                options: [
                    {v: 'y', t: 'Y-up'},
                    {v: 'z', t: 'Z-up (기본)'}
                ],
                value: importUpAxis,
                onChange: (v) => setImportUpAxis(String(v))
            })
        ),
        // Actions
        jsx('div', {style: {display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '12px'}},
            jsx(ButtonX, {text: '취소', onClick: () => closeImportDialog()}),
            jsx(ButtonX, {
                text: '가져오기',
                onClick: async () => {
                    try {
                        let files = pendingImportFiles || [];
                        const haveHandles = !files.length && pendingImportHandles && pendingImportHandles.length;
                        if (haveHandles) {
                            setBusy(true);
                            setBusyMsg('파일 정보를 읽는 중…');
                            try {
                                const arr = [];
                                for (const h of pendingImportHandles) {
                                    try {
                                        const f = await h.getFile();
                                        if (f) arr.push(f);
                                    } catch (_) { /* ignore */
                                    }
                                }
                                files = arr;
                            } finally {
                                // keep busy; next step will update message
                            }
                        }
                        if (!files.length) return;
                        const api2 = (/** @type {any} */ (window)).SimEdit9 || {};
                        const scaleNum = parseFloat(importScale);
                        const scale = isFinite(scaleNum) && scaleNum > 0 ? scaleNum : 1;
                        const upAxis = (importUpAxis === 'z') ? 'z' : 'y';
                        if (!haveHandles) {
                            setBusy(true);
                        }
                        setBusyMsg(importKind === 'vtk' ? 'VTK를 불러오는 중…' : '메시를 불러오는 중…');
                        try {
                            if (importKind === 'vtk') {
                                if (typeof api2.importVTKWindField === 'function') {
                                    await api2.importVTKWindField(files, {scale, upAxis});
                                } else {
                                    console.warn('VTK Import API not available.');
                                }
                            } else {
                                if (typeof api2.importFiles === 'function') {
                                    await api2.importFiles(files, {scale, upAxis});
                                } else {
                                    console.warn('Mesh Import API not available.');
                                }
                            }
                        } finally {
                            setBusy(false);
                            setBusyMsg('');
                        }
                    } catch (err) {
                        console.error('가져오기 실행 실패:', err);
                    } finally {
                        closeImportDialog();
                    }
                }
            })
        )
    ));

    const ExportPreprocessedDataOverlay = showExportPreDlg && jsx('div', {
        style: {
            position: 'fixed', left: 0, top: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.5)', zIndex: 2000,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'auto'
        },
        onPointerDown: (ev) => {
            if (ev.target === ev.currentTarget) setShowExportPreDlg(false);
        }
    }, jsx('div', {
            style: {
                minWidth: '320px', maxWidth: '400px', background: '#1b1f24', color: '#e6e6e6',
                border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px',
                boxShadow: '0 20px 60px rgba(0,0,0,0.6)', padding: '16px'
            },
            onPointerDown: (e) => {
                e.stopPropagation();
            }
        },
        jsx('div', {style: {fontSize: '15px', fontWeight: 700, marginBottom: '14px'}}, '전처리 데이터 내보내기'),
        jsx('div', {style: {fontSize: '13px', marginBottom: '12px', color: '#b0b8c1'}}, 'STL 좌표계를 선택하세요. (JSON과 STL이 ZIP으로 묶여 내보내집니다)'),
        jsx(LabelGroupX, {text: 'Up-Axis'},
            jsx(SelectInputX, {
                options: [{v: 'y', t: 'Y-up'}, {v: 'z', t: 'Z-up'}],
                value: exportUpAxis,
                onChange: (v) => setExportUpAxis(String(v))
            })
        ),
        jsx('div', {style: {display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '20px'}},
            jsx(ButtonX, { text: '취소', onClick: () => setShowExportPreDlg(false) }),
            jsx(ButtonX, {
                text: '내보내기',
                onClick: () => {
                    setShowExportPreDlg(false);
                    exportPreprocessedData({ upAxis: exportUpAxis });
                }
            })
        )
    ));

    // Render per variant
    // Colorbar overlay for Scalar Slice (top-right, compact)
    // Build CSS gradient from preset (approx)
    const colorFromPreset = (preset, t) => {
        // simple approximations; keep in sync with engine side
        const blueRed = (tt) => [tt, 0.2, 1.0 - tt];
        const viridis = (tt) => {
            const a = [0.267, 0.005, 0.329], b = [0.255, 0.320, 0.196], c = [0.130, 0.774, 0.019];
            return [a[0] + b[0] * tt + c[0] * tt * tt, a[1] + b[1] * tt + c[1] * tt * tt, a[2] + b[2] * tt + c[2] * tt * tt];
        };
        const plasma = (tt) => [Math.pow(tt, 0.5), 0.06 + 1.2 * tt * (1.0 - tt), 0.5 + 0.5 * (1.0 - tt)];
        const coolwarm = (tt) => [tt, 0.5 + 0.5 * (1.0 - 2.0 * Math.abs(tt - 0.5)), 1.0 - tt];
        switch (preset) {
            case 'viridis':
                return viridis(t);
            case 'plasma':
                return plasma(t);
            case 'coolwarm':
                return coolwarm(t);
            case 'blue-red':
            default:
                return blueRed(t);
        }
    };
    const toCss = (rgb) => `rgb(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)})`;
    const buildGradient = (preset, reverse) => {
        const stops = [];
        const N = 12;
        for (let i = 0; i <= N; i++) {
            let t = i / N;
            if (reverse) t = 1 - t;
            const c = colorFromPreset(preset, t);
            stops.push(`${toCss(c)} ${(i / N * 100).toFixed(1)}%`);
        }
        return `linear-gradient(90deg, ${stops.join(', ')})`;
    };
    // Show colorbar for scalar slices and for VTK glyphs (speed coloring)
    const showColorbar = !!(sel && (sel.scalarSlice || sel.kind === 'vtk-glyphs-merged'));
    const colorbarMinMax = () => {
        if (!sel) return [0, 1];
        const c = (sel && (sel.colorParams || sel.coloring)) || {};
        const auto = (c.autoRange !== undefined) ? !!c.autoRange : true;
        if (auto && sel.scalarStats && sel.scalarStats.min !== undefined && sel.scalarStats.max !== undefined) {
            return [sel.scalarStats.min, sel.scalarStats.max];
        }
        // Manual range: prefer actual selection params, fall back to local UI state
        const mn0 = (c.min != null && isFinite(Number(c.min))) ? Number(c.min) : parseFloat(colMin);
        const mx0 = (c.max != null && isFinite(Number(c.max))) ? Number(c.max) : parseFloat(colMax);
        return [isFinite(mn0) ? mn0 : 0, isFinite(mx0) ? mx0 : 1];
    };
    const [cmin, cmax] = colorbarMinMax();
    // Use the active selection's actual color params for the gradient to avoid UI state desync
    const activeColoring = (sel && (sel.colorParams || sel.coloring)) || {};
    const gradPreset = activeColoring.preset || colPreset;
    const gradReverse = !!activeColoring.reverse;
    const ColorbarOverlay = showColorbar ? jsx('div', {
            style: {
                position: 'absolute', right: '10px', top: '46px', width: '220px', pointerEvents: 'none', zIndex: 900
            }
        },
        jsx('div', {
            style: {
                fontSize: '11px',
                color: '#cfd3da',
                marginBottom: '4px',
                textAlign: 'right'
            }
        }, (sel && sel.scalarStats && sel.scalarStats.name) || (sel && (sel.ySlice || sel.kind === 'vtk-glyphs-merged') ? 'speed' : 'scalars')),
        jsx('div', {style: {display: 'flex', alignItems: 'center', gap: '6px'}},
            jsx('div', {
                style: {
                    fontSize: '11px',
                    color: '#aab3c0',
                    width: '54px',
                    textAlign: 'right'
                }
            }, String(Number(cmin).toFixed(2))),
            jsx('div', {
                style: {
                    flex: 1,
                    height: '12px',
                    borderRadius: '6px',
                    border: '1px solid rgba(255,255,255,0.12)',
                    background: buildGradient(gradPreset, gradReverse)
                }
            }),
            jsx('div', {style: {fontSize: '11px', color: '#aab3c0', width: '54px'}}, String(Number(cmax).toFixed(2)))
        )
    ) : null;

    if (variant === 'sidebar') {
        return jsx(ErrorBoundary, null, fragment(
            jsx(SidebarTabs, null),
            ImportOptionsOverlay,
            ExportPreprocessedDataOverlay,
            // ColorbarOverlay는 사이드바 변형에서는 렌더하지 않습니다(중복 표시 방지)
            BusyOverlay
        ));
    }
    // default/top overlay menu
    return jsx(ErrorBoundary, null, fragment(TopMenu, HelpHUD, ImportOptionsOverlay, ExportPreprocessedDataOverlay, ColorbarOverlay, BusyOverlay));
};
