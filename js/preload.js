(function () {
    'use strict';

    // 1) Basic hardening: block eval/Function/document.write and enforce noopener on window.open
    try {
        Object.defineProperty(window, 'eval', { configurable: false, writable: false, value: function () { throw new Error('Blocked: eval'); } });
    } catch { }
    try {
        // Block Function constructor (new Function(...))
        const BlockedFunction = function () { throw new Error('Blocked: Function constructor'); };
        Object.setPrototypeOf(BlockedFunction, Function);
        Object.defineProperty(window, 'Function', { configurable: false, writable: false, value: BlockedFunction });
    } catch { }
    try {
        Document.prototype.write = function () { throw new Error('Blocked: document.write'); };
    } catch { }
    try {
        const _open = window.open;
        window.open = function (url, target, features) {
            const w = _open.call(window, url, target || '_blank', features);
            try { if (w && w.opener) w.opener = null; } catch { }
            return w;
        };
    } catch { }

    // 2) Framebusting: avoid clickjacking
    try {
        if (window.top !== window.self) {
            window.top.location = window.self.location;
        }
    } catch { }

    // 3) Inject a restrictive CSP via meta (best set on server). Only when running over http(s).
    try {
        if (/^https?:$/.test(location.protocol)) {
            const meta = document.createElement('meta');
            meta.httpEquiv = 'Content-Security-Policy';
            // Allow self, Google Fonts; block inline scripts, objects, framing. Keep inline styles for simplicity.
            meta.content = [
                "default-src 'self'",
                "script-src 'self'",
                "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
                "font-src 'self' https://fonts.gstatic.com",
                "img-src 'self' data: blob:",
                "object-src 'none'",
                "base-uri 'none'",
                "frame-ancestors 'none'",
                "upgrade-insecure-requests"
            ].join('; ');
            // Insert as first element of <head>
            (document.head || document.getElementsByTagName('head')[0]).prepend(meta);
        }
    } catch { }

    // 4) Prevent setting inline event attributes and strip <script> from dynamic HTML sinks
    try {
        const sanitizeHTML = (html) => String(html).replace(/<script\b[\s\S]*?>[\s\S]*?<\/script\s*>/gi, '');

        // innerHTML
        const ihDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
        if (ihDesc && ihDesc.set) {
            Object.defineProperty(Element.prototype, 'innerHTML', {
                configurable: true,
                get: ihDesc.get,
                set: function (value) { ihDesc.set.call(this, sanitizeHTML(value)); }
            });
        }
        // insertAdjacentHTML
        const _insertAdjacentHTML = Element.prototype.insertAdjacentHTML;
        Element.prototype.insertAdjacentHTML = function (position, text) {
            return _insertAdjacentHTML.call(this, position, sanitizeHTML(text));
        };
        // appendChild/insertBefore/replaceChild: block inline or cross-origin scripts
        const isBlockedScript = (node) => {
            if (!node || node.nodeType !== 1 || node.tagName !== 'SCRIPT') return false;
            if (!node.src) return true; // block inline script
            try {
                const u = new URL(node.src, location.href);
                return u.origin !== location.origin;
            } catch {
                return true;
            }
        };
        const wrapDomMethod = (proto, name) => {
            const orig = proto[name];
            Object.defineProperty(proto, name, {
                configurable: true,
                writable: true,
                value: function () {
                    const node = arguments[0];
                    if (isBlockedScript(node)) {
                        console.warn('Blocked script injection:', node.src || '[inline]');
                        return node;
                    }
                    return orig.apply(this, arguments);
                }
            });
        };
        wrapDomMethod(Node.prototype, 'appendChild');
        wrapDomMethod(Node.prototype, 'insertBefore');
        wrapDomMethod(Node.prototype, 'replaceChild');

        // setAttribute: disallow setting "on*" event attributes
        const _setAttribute = Element.prototype.setAttribute;
        Element.prototype.setAttribute = function (name, value) {
            if (typeof name === 'string' && /^on/i.test(name)) {
                console.warn('Blocked inline handler attribute:', name);
                return;
            }
            return _setAttribute.call(this, name, value);
        };

        // addEventListener: disallow string listeners
        const _addEventListener = EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener = function (type, listener, options) {
            if (typeof listener !== 'function') {
                console.warn('Blocked non-function event listener for', type);
                return;
            }
            return _addEventListener.call(this, type, listener, options);
        };
    } catch { }

    // 5) Mutation observer: remove dynamically inserted disallowed scripts
    try {
        const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                m.addedNodes && m.addedNodes.forEach((n) => {
                    try {
                        if (n.nodeType === 1 && n.tagName === 'SCRIPT') {
                            const blocked = (!n.src) || (new URL(n.src, location.href).origin !== location.origin);
                            if (blocked) {
                                n.remove();
                                console.warn('Removed injected script:', n.src || '[inline]');
                            }
                        }
                    } catch { }
                });
            }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch { }

    // 6) Remove existing inline "on*" handlers and re-wire known nav clicks safely
    document.addEventListener('DOMContentLoaded', () => {
        try {
            // Strip all inline event attributes
            const all = document.getElementsByTagName('*');
            for (let i = 0; i < all.length; i++) {
                const el = all[i];
                const toRemove = [];
                for (let j = 0; j < el.attributes.length; j++) {
                    const a = el.attributes[j];
                    if (/^on/i.test(a.name)) toRemove.push(a.name);
                }
                toRemove.forEach((n) => el.removeAttribute(n));
            }
        } catch { }

        // Re-attach safe handlers for navbar items that previously used inline onclick
        try {
            const allowed = new Set(['home', 'showcase', 'processes', 'commissions']);
            document.querySelectorAll('.navbar_item[name]').forEach((el) => {
                const name = el.getAttribute('name');
                if (!allowed.has(name)) return;
                el.addEventListener('click', (e) => {
                    e.preventDefault();
                    location.hash = '#' + name;
                }, { passive: true });
            });
        } catch { }
    });
})();