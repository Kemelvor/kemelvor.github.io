const BACKGROUND_SHADER_ENABLED = true; // master toggle
const BACKGROUND_SHADER_LOW_QUALITY = false; // low quality mode for performance
const BACKGROUND_SHADER_TIME_SCALE = 1.0; // speed multiplier
const BACKGROUND_SHADER_INTENSITY = 1.0; // parrallax intensity multiplier

const ARTWORK_BOX_ANIMATION_ENABLED = true; // master toggle
const ARTWORK_BOX_ANIMATION_BLUR_ENABLED = true; // blur effect toggle

const ARTWORK_BOX_SINGLEGIF_ENABLED = true; // single-GIF playback toggle, to prevent multiple simultaneous GIFs overloading CPU
const ARTWORK_BOX_PROGRESSIVE_ENABLED = true; // progressive image loading toggle (ULQ -> LQ -> HQ)

const COOKIES_ENABLED = true; // master toggle for cookies (if false, all cookie reads/writes are no-ops)

// setup cookie helpers
function setCookie(name, value, days) {
    if (!COOKIES_ENABLED) return;
    let expires = "";
    if (days) {
        const date = new Date();
        date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
        expires = "; expires=" + date.toUTCString();
    }
    document.cookie = name + "=" + (value || "") + expires + "; path=/";
}
function getCookie(name) {
    if (!COOKIES_ENABLED) return null;
    const nameEQ = name + "=";
    const ca = document.cookie.split(';');
    for (let i = 0; i < ca.length; i++) {
        let c = ca[i];
        while (c.charAt(0) == ' ') c = c.substring(1, c.length);
        if (c.indexOf(nameEQ) == 0) return c.substring(nameEQ.length, c.length);
    }
    return null;
}

function clearCookie(name) {
    if (!COOKIES_ENABLED) return;
    document.cookie = name + "=; Max-Age=-99999999;";
}

function clearAllCookies() {
    if (!COOKIES_ENABLED) return;
    const cookies = document.cookie.split("; ");
    for (const cookie of cookies) {
        const eqPos = cookie.indexOf("=");
        const name = eqPos > -1 ? cookie.substr(0, eqPos) : cookie;
        document.cookie = name + "=; Max-Age=-99999999;";
    }
}

function requestCookieConsent() {
    function acceptCookies() {
        setCookie('cookie_consent', 'accepted', 365);
    }
    function declineCookies() {
        setCookie('cookie_consent', 'declined', 365);
    }
    const consent = getCookie('cookie_consent');
    if (consent === 'accepted' || consent === 'declined') {
        return; // already decided
    }
    // Show consent banner
    const banner = document.createElement('div');
    banner.className = 'cookie_consent_banner';
    banner.innerHTML = `
        <div class="cookie_consent_message">
            This website uses cookies to enhance your experience. By continuing to use this site, you agree to our use of cookies.
        </div>
        <div class="cookie_consent_buttons">
            <button id="cookie_accept" class="cookie_consent_button">Accept</button>
            <button id="cookie_decline" class="cookie_consent_button">Decline</button>
        </div>
    `;
    document.body.appendChild(banner);

    document.getElementById('cookie_accept').addEventListener('click', () => {
        acceptCookies();
        document.body.removeChild(banner);
    });

    document.getElementById('cookie_decline').addEventListener('click', () => {
        declineCookies();
        document.body.removeChild(banner);
    });
}

function positionHighlightToItem(item) {
    const highlight = document.querySelector(".navbar_footer_highlight");
    const footer = document.querySelector(".navbar_footer");
    const navbar = document.querySelector('.navbar');
    if (!item || !highlight || !footer) return;
    // Suppress highlight in mobile mode (footer is hidden there)
    if (navbar && navbar.classList.contains('is-mobile')) return;

    const itemRect = item.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();

    // Position and size in pixels so it's resolution/viewport independent
    const leftPx = itemRect.left - footerRect.left;
    const widthPx = itemRect.width;

    highlight.style.left = `${leftPx}px`;
    highlight.style.width = `${widthPx}px`;
}

// Prioritized, limited-concurrency preloader for GIFs
const PreloadManager = (() => {
    const MAX_CONCURRENT = 2;
    const queue = []; // {url, priority, resolvers}
    const states = new Map(); // url -> { status: 'queued'|'loading'|'loaded', promise }
    let inFlight = 0;

    function runNext() {
        if (inFlight >= MAX_CONCURRENT) return;
        if (queue.length === 0) return;
        // Highest priority first ('high' > 'normal' > 'low')
        queue.sort((a, b) => ({ high: 3, normal: 2, low: 1 }[b.priority] - ({ high: 3, normal: 2, low: 1 }[a.priority])));
        const task = queue.shift();
        if (!task) return;
        const { url, resolvers } = task;
        const st = states.get(url);
        if (!st || st.status === 'loaded') {
            resolvers.forEach(r => r());
            runNext();
            return;
        }
        inFlight++;
        st.status = 'loading';
        const img = new Image();
        img.decoding = 'async';
        img.loading = 'eager';
        img.onload = () => {
            st.status = 'loaded';
            inFlight--;
            resolvers.forEach(r => r());
            runNext();
        };
        img.onerror = () => {
            // consider errored as resolved to avoid stalls
            st.status = 'loaded';
            inFlight--;
            resolvers.forEach(r => r());
            runNext();
        };
        img.src = url;
    }

    function preload(url, priority = 'normal') {
        if (!url) return Promise.resolve();
        const existing = states.get(url);
        if (existing && existing.status === 'loaded') return Promise.resolve();
        if (existing && existing.status !== 'loaded') {
            // Upgrade priority by reinserting with higher priority
            return new Promise(res => {
                queue.push({ url, priority, resolvers: [res] });
                runNext();
            });
        }
        // New entry
        let resolver;
        const prom = new Promise(res => { resolver = res; });
        states.set(url, { status: 'queued', promise: prom });
        queue.push({ url, priority, resolvers: [resolver] });
        runNext();
        return prom;
    }

    return { preload };
})();

// Given a GIF url, compute its poster path in compact_art_posters
function gifPosterUrlFromGif(gifUrl) {
    try {
        // Expecting path like /home/src/compact_art/name.gif
        const lastSlash = gifUrl.lastIndexOf('/')
        const base = gifUrl.substring(0, lastSlash);
        const file = gifUrl.substring(lastSlash + 1);
        const stem = file.replace(/\.[^.]+$/i, '');
        return {
            ulq: `${base}_posters_ulq/${stem}.png`,
            lq: `${base}_posters_lq/${stem}.png`,
            hq: `${base}_posters/${stem}.png`,
        };
    } catch (_) {
        return { ulq: gifUrl, lq: gifUrl, hq: gifUrl };
    }
}

function progressiveUrlsForImage(url) {
    // Given /home/src/compact_art/name.ext -> ulq/lq/hq variants
    const lastSlash = url.lastIndexOf('/')
    const base = url.substring(0, lastSlash);
    const file = url.substring(lastSlash + 1);
    return {
        ulq: `${base.replace('/compact_art', '/compact_art_ulq')}/${file}`,
        lq: `${base.replace('/compact_art', '/compact_art_lq')}/${file}`,
        hq: url,
    };
}

// --- Progressive upgrade observers (ULQ -> LQ -> HQ as you scroll) ---------
let __LQ_OBSERVER__ = null;
let __HQ_OBSERVER__ = null;

function ensureProgressiveObservers() {
    if (!('IntersectionObserver' in window)) return null;
    if (!__LQ_OBSERVER__) {
        // Start upgrading to LQ when near viewport
        __LQ_OBSERVER__ = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                const img = entry.target;
                if (!entry.isIntersecting && entry.intersectionRatio <= 0) return;
                const next = img.dataset.lq;
                if (next && img.dataset.resLevel === 'ulq') {
                    upgradeSrc(img, next, 'lq');
                }
                __LQ_OBSERVER__ && __LQ_OBSERVER__.unobserve(img);
            });
        }, { root: null, rootMargin: '800px 0px', threshold: 0.01 });
    }
    if (!__HQ_OBSERVER__) {
        // Upgrade to HQ when actually in/very close to viewport
        __HQ_OBSERVER__ = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                const img = entry.target;
                if (!entry.isIntersecting && entry.intersectionRatio <= 0.05) return;
                const next = img.dataset.hq;
                if (next && img.dataset.resLevel !== 'hq') {
                    // Jump to HQ directly; cancel pending LQ upgrade
                    img.dataset.lq = '';
                    try { __LQ_OBSERVER__ && __LQ_OBSERVER__.unobserve(img); } catch (_) { }
                    upgradeSrc(img, next, 'hq');
                }
                __HQ_OBSERVER__ && __HQ_OBSERVER__.unobserve(img);
            });
        }, { root: null, rootMargin: '200px 0px', threshold: 0.1 });
    }
    return { lq: __LQ_OBSERVER__, hq: __HQ_OBSERVER__ };
}

function upgradeSrc(img, nextUrl, nextLevel) {
    if (!nextUrl) return;
    const curLevel = img.dataset.resLevel || 'ulq';
    if (curLevel === nextLevel) return;
    const tmp = new Image();
    tmp.decoding = 'async';
    tmp.onload = () => {
        // Ensure animator refreshes when this image updates
        const onImgLoad = () => {
            try { ensureScrollAnimator().refresh(); } catch (_) { }
            img.removeEventListener('load', onImgLoad);
        };
        img.addEventListener('load', onImgLoad);
        img.src = nextUrl;
        img.dataset.resLevel = nextLevel;
    };
    tmp.onerror = () => {
        // Even on error, do not loop; skip upgrade silently
    };
    tmp.src = nextUrl;
}

// --- Image Viewer (modal) ---------------------------------------------------
let viewerStylesInjected = false;

function ensureViewerStyles() {
    if (viewerStylesInjected) return;
    const style = document.createElement('style');
    style.id = 'imageViewerStyles';
    style.textContent = `
        .iv_overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.8); z-index: 9999; display: flex; align-items: center; justify-content: center; }
        .iv_panel { position: relative; width: 96vw; height: 96vh; background: #0b0b0b; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.6); display: flex; flex-direction: column; overflow: hidden; }
        .iv_header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; color: #eee; font: 500 14px/1.2 Rubik, system-ui, sans-serif; background: #0f0f10; border-bottom: 1px solid #1f1f22; }
    .iv_meta { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
    .iv_meta .iv_tag { background: #1a1a1a; border: 1px solid #2a2a2a; padding: 6px 10px; border-radius: 8px; color: #ddd; font-size: 12px; }
    .iv_title { color: #fafafa; font-size: 14px; font-weight: 600; margin-right: 8px; }
    .iv_close { cursor: pointer; border: none; background: #222; color: #ddd; padding: 6px 10px; border-radius: 8px; font-weight: 600; }
    .iv_close:hover { background: #2e2e2e; }
        .iv_toolbar { display: flex; gap: 8px; }
    .iv_btn { cursor: pointer; border: 1px solid #2a2a2a; background: #1a1a1a; color: #ddd; padding: 6px 10px; border-radius: 8px; font-weight: 600; }
    .iv_btn:hover { background: #232323; }
        .iv_viewport { position: relative; flex: 1; background: #0a0a0a; overflow: hidden; cursor: grab; touch-action: none; }
    .iv_viewport.grabbing { cursor: grabbing; }
    .iv_canvas { position: absolute; left: 0; top: 0; will-change: transform; transform-origin: 0 0; }
    .iv_img { user-select: none; pointer-events: none; display: block; }
    .iv_progress { position: absolute; left: 0; right: 0; bottom: 0; height: 6px; background: rgba(255,255,255,0.06); }
    .iv_progress_bar { height: 100%; width: 0%; background: linear-gradient(90deg, #39f, #9cf); transition: width 90ms linear; }
        /* Mobile safe-area padding */
        @supports(padding:max(0px)){
            .iv_panel{ padding-bottom: max(0px, env(safe-area-inset-bottom)); }
        }
        /* On-screen mobile controls */
        .iv_nav_btn{ position:absolute; top:50%; transform: translateY(-50%); width:44px; height:44px; border-radius:999px; border:1px solid #2a2a2a; background: rgba(20,20,20,0.7); color:#eee; display:flex; align-items:center; justify-content:center; z-index:3; backdrop-filter: blur(4px); }
        .iv_prev{ left:10px; }
        .iv_next{ right:10px; }
        .iv_nav_btn:hover{ background: rgba(40,40,40,0.7); }
    .iv_zoom_badge{ position:absolute; left:10px; bottom:10px; z-index:3; color:#ddd; background: rgba(20,20,20,0.7); border:1px solid #2a2a2a; border-radius:8px; padding:4px 8px; font: 600 12px/1 Rubik,system-ui,sans-serif; }

    /* Mobile simple viewer */
    .mv_overlay{ position: fixed; inset:0; background:#000; z-index:10000; display:flex; align-items:center; justify-content:center; touch-action:none; }
    .mv_topbar{ position:absolute; top:0; left:0; right:0; height:52px; display:flex; align-items:center; gap:12px; padding:8px 12px; color:#eee; font:600 13px/1 Rubik,system-ui,sans-serif; backdrop-filter: blur(8px); background: rgba(16,16,16,0.55); border-bottom:1px solid rgba(255,255,255,0.08); }
    .mv_tags{ display:flex; align-items:center; gap:8px; flex:1; min-width:0; }
    .mv_tag{ background: rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.14); color:#e6e6e6; padding:6px 10px; border-radius:999px; white-space:nowrap; font-weight:600; }
    .mv_close{ position:absolute; right:8px; top:8px; width:36px; height:36px; display:flex; align-items:center; justify-content:center; border-radius:999px; border:1px solid rgba(255,255,255,0.18); background: rgba(24,24,24,0.6); color:#eee; font:700 16px/1 Rubik,system-ui,sans-serif; }
    .mv_canvas{ position:absolute; left:0; top:0; right:0; bottom:0; overflow:hidden; }
    .mv_wrap{ position:absolute; left:50%; top:50%; transform: translate(-50%, -50%); width:0; height:0; }
    .mv_img{ position:absolute; left:50%; top:50%; transform: translate(-50%, -50%); transform-origin:50% 50%; user-select:none; touch-action:none; max-width:none; max-height:none; }
    /* Scroll-driven animation hooks (no CSS transitions; JS drives transforms) */
    .artwork_animated{ will-change: transform, opacity; }
    @media (prefers-reduced-motion: reduce){
        .artwork_animated{ will-change: auto; }
    }
    `;
    document.head.appendChild(style);
    viewerStylesInjected = true;
}

function isMobileLike() {
    try {
        const coarse = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
        const touch = ('ontouchstart' in window);
        const small = Math.min(window.innerWidth || 0, window.innerHeight || 0) < 700;
        return coarse || (touch && small);
    } catch (_) { return false; }
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let val = bytes;
    while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
    return `${val.toFixed(val >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

async function fetchFileSize(url) {
    // Try HEAD first
    try {
        const r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
        const len = r.headers.get('content-length');
        if (len) return parseInt(len, 10);
    } catch (_) { /* noop */ }
    // Fallback to a 0-0 range probe
    try {
        const r = await fetch(url, { method: 'GET', headers: { 'Range': 'bytes=0-0' }, cache: 'no-store' });
        const cr = r.headers.get('Content-Range');
        if (cr) {
            const m = /\/(\d+)\s*$/.exec(cr);
            if (m) return parseInt(m[1], 10);
        }
    } catch (_) { /* noop */ }
    return null;
}

// --- Viewer URL deep-linking helpers ---------------------------------------
// We use a query parameter (?viewer=<fname>) to avoid conflicting with hash tabs.
const ViewerURL = (() => {
    function get() {
        try {
            return new URLSearchParams(window.location.search).get('viewer');
        } catch (_) { return null; }
    }
    function setPush(fname) {
        try {
            const u = new URL(window.location.href);
            u.searchParams.set('viewer', fname);
            history.pushState({ viewer: fname }, '', u);
        } catch (_) { /* noop */ }
    }
    function setReplace(fname) {
        try {
            const u = new URL(window.location.href);
            u.searchParams.set('viewer', fname);
            history.replaceState({ viewer: fname }, '', u);
        } catch (_) { /* noop */ }
    }
    function clearReplace() {
        try {
            const u = new URL(window.location.href);
            u.searchParams.delete('viewer');
            history.replaceState({}, '', u);
        } catch (_) { /* noop */ }
    }
    return { get, setPush, setReplace, clearReplace };
})();

// Track whether the current viewer state was added with pushState (so Close should history.back())
let __viewerOpenedViaPush = false;
// Provide a handle for global close/destroy from popstate
window.__activeViewerDestroy = window.__activeViewerDestroy || null;

// no watermark tile (removed per request)

function openImageViewer({ fname, date, index = null, list = null, fromURL = false }) {
    ensureViewerStyles();
    // Route touch-first devices to a simpler mobile viewer
    if (isMobileLike()) {
        return openMobileViewer({ fname, date, fromURL });
    }
    const overlay = document.createElement('div');
    overlay.className = 'iv_overlay';

    const panel = document.createElement('div');
    panel.className = 'iv_panel';

    const header = document.createElement('div');
    header.className = 'iv_header';
    const meta = document.createElement('div');
    meta.className = 'iv_meta';
    const title = document.createElement('div');
    title.className = 'iv_title';
    title.textContent = fname;
    const dateEl = document.createElement('div');
    dateEl.className = 'iv_tag';
    dateEl.textContent = `Date: ${date ? date.toLocaleString().split(',')[0] : 'Unknown'}`;
    const sizeEl = document.createElement('div');
    sizeEl.className = 'iv_tag';
    sizeEl.textContent = 'Size: …';
    const resEl = document.createElement('div');
    resEl.className = 'iv_tag';
    resEl.textContent = 'Resolution: …';
    meta.appendChild(title);
    meta.appendChild(dateEl);
    meta.appendChild(sizeEl);
    meta.appendChild(resEl);

    const toolbar = document.createElement('div');
    toolbar.className = 'iv_toolbar';
    const btnFit = Object.assign(document.createElement('button'), { className: 'iv_btn', textContent: 'Fit' }); btnFit.setAttribute('aria-label', 'Fit to screen');
    const btnFill = Object.assign(document.createElement('button'), { className: 'iv_btn', textContent: 'Fill' }); btnFill.setAttribute('aria-label', 'Fill viewport');
    const btn100 = Object.assign(document.createElement('button'), { className: 'iv_btn', textContent: '100%' }); btn100.setAttribute('aria-label', 'Zoom 100%');
    const btnMinus = Object.assign(document.createElement('button'), { className: 'iv_btn', textContent: '−' }); btnMinus.setAttribute('aria-label', 'Zoom out');
    const btnPlus = Object.assign(document.createElement('button'), { className: 'iv_btn', textContent: '+' }); btnPlus.setAttribute('aria-label', 'Zoom in');
    const btnFullscreen = Object.assign(document.createElement('button'), { className: 'iv_btn', textContent: 'Fullscreen' }); btnFullscreen.setAttribute('aria-label', 'Toggle fullscreen');
    toolbar.append(btnFit, btnFill, btn100, btnMinus, btnPlus, btnFullscreen);

    const btnClose = Object.assign(document.createElement('button'), { className: 'iv_close', textContent: 'Close' });
    header.appendChild(meta);
    header.appendChild(toolbar);
    header.appendChild(btnClose);

    const viewport = document.createElement('div');
    viewport.className = 'iv_viewport';
    const canvas = document.createElement('div');
    canvas.className = 'iv_canvas';
    const img = document.createElement('img');
    img.className = 'iv_img';
    img.alt = fname;
    img.draggable = false;
    const fullUrl = `/home/src/art/${fname}`;
    const isGif = fname.toLowerCase().endsWith('.gif');
    const previewUrl = isGif ? fullUrl : `/home/src/compact_art/${fname}`;
    img.decoding = 'async';
    img.src = previewUrl;
    canvas.appendChild(img);
    viewport.appendChild(canvas);

    // Progress bar
    const progress = document.createElement('div');
    progress.className = 'iv_progress';
    const progressBar = document.createElement('div');
    progressBar.className = 'iv_progress_bar';
    progress.appendChild(progressBar);

    panel.appendChild(header);
    panel.appendChild(viewport);
    panel.appendChild(progress);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    // Blackout overlay (created on detection)
    let copyBlockOverlay = null;
    function ensureCopyBlock() {
        if (copyBlockOverlay) return copyBlockOverlay;
        const div = document.createElement('div');
        div.className = 'copy_block_overlay';
        const p = document.createElement('div');
        p.className = 'msg';
        p.textContent = 'DO NOT COPY';
        div.appendChild(p);
        document.body.appendChild(div);
        copyBlockOverlay = div;
        return div;
    }

    let natW = 0, natH = 0;
    let scale = 1, minScale = 1, maxScale = 8;
    let tx = 0, ty = 0; // translate
    let userInteracted = false;
    const zoomBadge = document.createElement('div');
    zoomBadge.className = 'iv_zoom_badge';
    zoomBadge.textContent = '100%';
    viewport.appendChild(zoomBadge);

    function applyTransform() {
        canvas.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
        try {
            const pct = Math.round(scale * 100);
            zoomBadge.textContent = `${pct}%`;
        } catch (_) { }
    }

    function clampPan() {
        const vw = viewport.clientWidth; const vh = viewport.clientHeight;
        const sw = natW * scale; const sh = natH * scale;
        // Horizontal
        if (sw <= vw) {
            tx = (vw - sw) / 2; // center, no drag
        } else {
            const minTx = vw - sw; // left-most (image right edge aligns to viewport right)
            const maxTx = 0;       // right-most (image left edge aligns to viewport left)
            tx = Math.min(maxTx, Math.max(minTx, tx));
        }
        // Vertical
        if (sh <= vh) {
            ty = (vh - sh) / 2; // center, no drag
        } else {
            const minTy = vh - sh;
            const maxTy = 0;
            ty = Math.min(maxTy, Math.max(minTy, ty));
        }
    }

    function computeFit() {
        const vw = viewport.clientWidth; const vh = viewport.clientHeight;
        if (!natW || !natH || !vw || !vh) return 1;
        return Math.min(vw / natW, vh / natH, 1);
    }

    function computeFill() {
        const vw = viewport.clientWidth; const vh = viewport.clientHeight;
        if (!natW || !natH || !vw || !vh) return 1;
        return Math.min(maxScale, Math.max(vw / natW, vh / natH));
    }

    function centerAtCurrentScale() {
        const vw = viewport.clientWidth; const vh = viewport.clientHeight;
        const sw = natW * scale; const sh = natH * scale;
        tx = (vw - sw) / 2; ty = (vh - sh) / 2;
        clampPan();
        applyTransform();
    }

    function zoomAt(cx, cy, factor) {
        const newScale = Math.max(minScale, Math.min(maxScale, scale * factor));
        if (newScale === scale) return;
        // keep point under cursor stable
        const ix = (cx - tx) / scale;
        const iy = (cy - ty) / scale;
        scale = newScale;
        tx = cx - ix * scale;
        ty = cy - iy * scale;
        clampPan();
        applyTransform();
    }

    function initFromImage() {
        natW = img.naturalWidth; natH = img.naturalHeight;
        resEl.textContent = `Resolution: ${natW} × ${natH}`;
        const prevMin = minScale;
        minScale = computeFit();
        // If user hasn't interacted and we were at previous fit, keep fitting
        if (!userInteracted && (Math.abs(scale - prevMin) < 0.001 || scale === 1)) {
            scale = minScale;
            centerAtCurrentScale();
        } else if (!userInteracted && scale === 1 && minScale < 1) {
            scale = minScale; centerAtCurrentScale();
        } else {
            // Keep current view, just apply (useful when swapping preview->full)
            clampPan();
            applyTransform();
        }
    }
    img.addEventListener('load', initFromImage, { once: true });

    // Wheel zoom (desktop)
    viewport.addEventListener('wheel', (e) => {
        e.preventDefault();
        const rect = viewport.getBoundingClientRect();
        const cx = e.clientX - rect.left; const cy = e.clientY - rect.top;
        const factor = Math.exp(-e.deltaY * 0.002);
        zoomAt(cx, cy, factor);
        userInteracted = true;
    }, { passive: false });

    // Pan with mouse drag
    let panning = false; let lx = 0, ly = 0;
    viewport.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        panning = true; lx = e.clientX; ly = e.clientY; viewport.classList.add('grabbing');
        userInteracted = true;
    });
    window.addEventListener('mousemove', (e) => {
        if (!panning) return;
        const dx = e.clientX - lx; const dy = e.clientY - ly;
        lx = e.clientX; ly = e.clientY;
        tx += dx; ty += dy; clampPan(); applyTransform();
    });
    window.addEventListener('mouseup', () => { if (panning) { panning = false; viewport.classList.remove('grabbing'); } });

    // Double-click to toggle zoom
    viewport.addEventListener('dblclick', (e) => {
        const rect = viewport.getBoundingClientRect();
        const cx = e.clientX - rect.left; const cy = e.clientY - rect.top;
        const targetScale = (scale <= minScale + 0.001) ? Math.min(1, maxScale) : minScale;
        const factor = targetScale / scale;
        zoomAt(cx, cy, factor);
    });

    // Touch gestures: pinch-zoom, pan, double-tap zoom, swipe-down to close
    let touchState = { touches: [], lastTap: 0, startY: 0, swipingDown: false, lastX: null, lastY: null };
    function getDistance(a, b) { const dx = b.clientX - a.clientX, dy = b.clientY - a.clientY; return Math.hypot(dx, dy); }
    function getMidpoint(a, b) { return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 }; }
    let pinchStart = null; // {scale, tx, ty, dist, mid}
    viewport.addEventListener('touchstart', (e) => {
        if (!e.changedTouches || e.changedTouches.length === 0) return;
        userInteracted = true;
        // Track active touches by identifier
        for (const t of e.changedTouches) { touchState.touches.push(t); }
        if (touchState.touches.length === 1) {
            // One-finger pan; record for swipe-down-to-close
            touchState.startY = touchState.touches[0].clientY;
            touchState.swipingDown = false;
            touchState.lastX = touchState.touches[0].clientX;
            touchState.lastY = touchState.touches[0].clientY;
        } else if (touchState.touches.length === 2) {
            // Pinch start snapshot
            const [a, b] = touchState.touches;
            pinchStart = { scale, tx, ty, dist: getDistance(a, b), mid: getMidpoint(a, b) };
        }
    }, { passive: false });
    viewport.addEventListener('touchmove', (e) => {
        if (!touchState.touches.length) return;
        e.preventDefault();
        // Update tracked touches
        const updates = new Map(); for (const t of e.changedTouches) updates.set(t.identifier, t);
        touchState.touches = touchState.touches.map(t => updates.get(t.identifier) || t);
        if (touchState.touches.length === 1) {
            // One finger: pan; also detect swipe down to close when at minScale and near top
            const t = touchState.touches[0];
            const dy = t.clientY - touchState.startY;
            if (scale <= minScale + 0.001 && dy > 24 && Math.abs(dy) > 2 * Math.abs((t.clientX - (viewport.clientWidth / 2)))) {
                touchState.swipingDown = true;
                overlay.style.transform = `translateY(${Math.min(120, dy)}px)`;
                overlay.style.opacity = String(Math.max(0.4, 1 - dy / 300));
            } else if (!touchState.swipingDown) {
                // Normal pan
                if (touchState.lastX == null) { touchState.lastX = t.clientX; touchState.lastY = t.clientY; }
                const dx = t.clientX - touchState.lastX; const ddy = t.clientY - touchState.lastY;
                touchState.lastX = t.clientX; touchState.lastY = t.clientY;
                tx += dx; ty += ddy; clampPan(); applyTransform();
            }
        } else if (touchState.touches.length >= 2 && pinchStart) {
            const [a, b] = touchState.touches;
            const dist = getDistance(a, b);
            const mid = getMidpoint(a, b);
            const factor = dist / Math.max(1, pinchStart.dist);
            // Zoom about initial midpoint
            const rect = viewport.getBoundingClientRect();
            const cx = mid.x - rect.left, cy = mid.y - rect.top;
            const newScale = Math.max(minScale, Math.min(maxScale, pinchStart.scale * factor));
            // Keep the pinchStart.midpoint stable
            const ix = (cx - pinchStart.tx) / pinchStart.scale;
            const iy = (cy - pinchStart.ty) / pinchStart.scale;
            scale = newScale;
            tx = cx - ix * scale; ty = cy - iy * scale;
            clampPan(); applyTransform();
        }
    }, { passive: false });
    viewport.addEventListener('touchend', (e) => {
        // Remove ended touches
        const ids = new Set(Array.from(e.changedTouches).map(t => t.identifier));
        touchState.touches = touchState.touches.filter(t => !ids.has(t.identifier));
        if (touchState.swipingDown) {
            const t = e.changedTouches[0];
            if (t && (t.clientY - touchState.startY) > 90) {
                overlay.style.transition = 'transform 0.2s ease, opacity 0.2s ease';
                overlay.style.transform = 'translateY(100vh)';
                overlay.style.opacity = '0';
                setTimeout(() => { close(); }, 180);
            } else {
                overlay.style.transition = 'transform 0.2s ease, opacity 0.2s ease';
                overlay.style.transform = '';
                overlay.style.opacity = '';
                setTimeout(() => { overlay.style.transition = ''; }, 220);
            }
            touchState.swipingDown = false;
        }
        if (touchState.touches.length < 2) { pinchStart = null; }
        // Double-tap zoom
        const now = Date.now();
        if (e.changedTouches.length === 1) {
            if (now - touchState.lastTap < 300) {
                const t = e.changedTouches[0];
                const rect = viewport.getBoundingClientRect();
                const cx = t.clientX - rect.left; const cy = t.clientY - rect.top;
                const targetScale = (scale <= minScale + 0.001) ? Math.min(1, maxScale) : minScale;
                zoomAt(cx, cy, targetScale / scale);
            }
            touchState.lastTap = now;
        }
    });
    viewport.addEventListener('touchcancel', () => { touchState.touches = []; pinchStart = null; touchState.swipingDown = false; touchState.lastX = touchState.lastY = null; });

    // Toolbar
    btnFit.addEventListener('click', () => { scale = minScale; centerAtCurrentScale(); userInteracted = true; });
    btnFill.addEventListener('click', () => { scale = computeFill(); centerAtCurrentScale(); userInteracted = true; });
    btn100.addEventListener('click', () => { scale = Math.max(minScale, 1); centerAtCurrentScale(); userInteracted = true; });
    btnMinus.addEventListener('click', () => {
        const vw = viewport.getBoundingClientRect();
        zoomAt(vw.width / 2, vw.height / 2, 1 / 1.2); userInteracted = true;
    });
    btnPlus.addEventListener('click', () => {
        const vw = viewport.getBoundingClientRect();
        zoomAt(vw.width / 2, vw.height / 2, 1.2); userInteracted = true;
    });
    // Fullscreen toggle
    function toggleFullscreen() {
        const el = panel;
        if (!document.fullscreenElement) { el.requestFullscreen?.(); }
        else { document.exitFullscreen?.(); }
    }
    btnFullscreen.addEventListener('click', toggleFullscreen);

    // Close handlers
    const prevBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Destroy overlay without touching history (used from popstate or replace clears)
    function destroy() {
        try { window.removeEventListener('keydown', onKey); } catch (_) { }
        try { window.removeEventListener('resize', onResize); } catch (_) { }
        overlay.remove();
        document.body.style.overflow = prevBodyOverflow;
        if (window.__activeViewerDestroy === destroy) window.__activeViewerDestroy = null;
    }
    // Close requested by user: coordinate with history/url state
    function close() {
        const hasParam = !!ViewerURL.get();
        if (__viewerOpenedViaPush && hasParam) {
            // Go back to previous history entry; popstate will call destroy()
            history.back();
            return;
        }
        // Not opened via push (e.g., deep-linked on first load) or no param -> just clear and destroy
        if (hasParam) ViewerURL.clearReplace();
        destroy();
    }
    btnClose.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    function onKey(e) {
        if (e.key === 'Escape') { close(); return; }
        if (e.key === '+' || e.key === '=') { const vw = viewport.getBoundingClientRect(); zoomAt(vw.width / 2, vw.height / 2, 1.2); }
        if (e.key === '-' || e.key === '_') { const vw = viewport.getBoundingClientRect(); zoomAt(vw.width / 2, vw.height / 2, 1 / 1.2); }
        if (e.key === '0') { scale = minScale; centerAtCurrentScale(); }
        if (e.key === '1') { scale = Math.max(minScale, 1); centerAtCurrentScale(); }
        if (e.key === 'f' || e.key === 'F') { toggleFullscreen(); }
    }
    window.addEventListener('keydown', onKey);

    // Keep fit on viewport resize if user hasn't changed view
    const onResize = () => {
        if (!userInteracted) {
            const prevMin = minScale; minScale = computeFit();
            scale = minScale; centerAtCurrentScale();
        }
    };
    window.addEventListener('resize', onResize);

    // Stream full-res image with progress (skip for GIF to avoid replay issues)
    async function streamImageWithProgress(url) {
        try {
            const r = await fetch(url);
            if (!r.ok || !r.body) {
                // Fallback: simple swap
                img.src = url; progress.style.display = 'none';
                // Update size meta
                try { const size = await fetchFileSize(url); sizeEl.textContent = `Size: ${size ? formatBytes(size) : 'Unknown'}`; } catch (_) { }
                return;
            }
            const contentLength = Number(r.headers.get('Content-Length')) || 0;
            const reader = r.body.getReader();
            const chunks = [];
            let received = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                received += value.byteLength;
                if (contentLength > 0) {
                    const pct = Math.max(0, Math.min(100, Math.round((received / contentLength) * 100)));
                    progressBar.style.width = pct + '%';
                } else {
                    // Indeterminate: animate slowly
                    const current = parseFloat(progressBar.style.width) || 0;
                    const next = Math.min(90, current + 2);
                    progressBar.style.width = next + '%';
                }
            }
            const blob = new Blob(chunks);
            const urlObj = URL.createObjectURL(blob);
            // Preserve current view; natural size may change so update meta and minScale
            const wasFit = !userInteracted && (Math.abs(scale - minScale) < 0.001);
            img.addEventListener('load', () => {
                // Update resolution and size once full loads via object URL
                initFromImage();
                try { sizeEl.textContent = `Size: ${formatBytes(blob.size)}`; } catch (_) { }
                if (wasFit) { scale = minScale; centerAtCurrentScale(); }
                progressBar.style.width = '100%';
                setTimeout(() => { progress.style.display = 'none'; }, 250);
            }, { once: true });
            img.src = urlObj;
        } catch (e) {
            // Fallback to direct src
            img.src = url; progress.style.display = 'none';
        }
    }

    // Start size meta early
    (async () => {
        try { const size = await fetchFileSize(fullUrl); sizeEl.textContent = `Size: ${size ? formatBytes(size) : 'Unknown'}`; } catch (_) { }
    })();

    if (!isGif) {
        // Begin streaming full image in background
        progress.style.display = '';
        progressBar.style.width = '0%';
        streamImageWithProgress(fullUrl);
    } else {
        // For GIF, just load directly (no progress)
        img.addEventListener('load', () => { initFromImage(); scale = minScale; centerAtCurrentScale(); }, { once: true });
        img.src = fullUrl;
        progress.style.display = 'none';
    }

    // Optional: gallery navigation if list and index provided
    if (Array.isArray(list) && Number.isInteger(index)) {
        const prevBtn = document.createElement('button'); prevBtn.className = 'iv_nav_btn iv_prev'; prevBtn.setAttribute('aria-label', 'Previous'); prevBtn.textContent = '‹';
        const nextBtn = document.createElement('button'); nextBtn.className = 'iv_nav_btn iv_next'; nextBtn.setAttribute('aria-label', 'Next'); nextBtn.textContent = '›';
        const canPrev = () => index > 0;
        const canNext = () => index < list.length - 1;
        let showCurrent = (i) => {
            index = i;
            const item = list[index];
            if (!item) return;
            const nextFname = item.fname || item;
            title.textContent = nextFname;
            try {
                const tsSec2 = parseFloat(item.date);
                const date2 = Number.isFinite(tsSec2) ? new Date(tsSec2 * 1000) : new Date(item.date);
                dateEl.textContent = `Date: ${date2 ? date2.toLocaleString() : 'Unknown'}`;
            } catch (_) { }
            // Defer reset until the new image loads so minScale uses its natural size
            userInteracted = false;
            // Swap URLs
            const nuFull = `/home/src/art/${nextFname}`;
            const isGif2 = nextFname.toLowerCase().endsWith('.gif');
            if (!isGif2) { progress.style.display = ''; progressBar.style.width = '0%'; streamImageWithProgress(nuFull); }
            else { img.addEventListener('load', () => { initFromImage(); scale = minScale; centerAtCurrentScale(); }, { once: true }); img.src = nuFull; progress.style.display = 'none'; }
            // Preload neighbors
            const neighbor = (k) => {
                if (k >= 0 && k < list.length) { const f = list[k].fname || list[k]; const u = `/home/src/art/${f}`; const tmp = new Image(); tmp.src = u; }
            };
            neighbor(index + 1); neighbor(index - 1);
            // Update buttons visibility
            prevBtn.style.display = canPrev() ? '' : 'none';
            nextBtn.style.display = canNext() ? '' : 'none';
        };
        prevBtn.addEventListener('click', (ev) => { ev.stopPropagation(); if (canPrev()) showCurrent(index - 1); });
        nextBtn.addEventListener('click', (ev) => { ev.stopPropagation(); if (canNext()) showCurrent(index + 1); });
        viewport.appendChild(prevBtn); viewport.appendChild(nextBtn);
        // Keyboard arrows
        function onKeyNav(e) { if (e.key === 'ArrowLeft' && canPrev()) { showCurrent(index - 1); } else if (e.key === 'ArrowRight' && canNext()) { showCurrent(index + 1); } }
        window.addEventListener('keydown', onKeyNav);
        const prevClose = close; close = function () { window.removeEventListener('keydown', onKeyNav); prevClose(); };
        // Initialize visibility and preload neighbors
        prevBtn.style.display = canPrev() ? '' : 'none';
        nextBtn.style.display = canNext() ? '' : 'none';
        // Preload
        const neighbor = (k) => { if (k >= 0 && k < list.length) { const f = list[k].fname || list[k]; const u = `/home/src/art/${f}`; const tmp = new Image(); tmp.src = u; } };
        neighbor(index + 1); neighbor(index - 1);

        // Update URL when moving within gallery
        const _origShowCurrent = showCurrent;
        showCurrent = (i) => {
            _origShowCurrent(i);
            try {
                const item = list[index];
                const curName = item && (item.fname || item);
                if (curName) ViewerURL.setReplace(curName);
            } catch (_) { }
        };
    }

    // Update URL state on open and register destroy handle
    if (fromURL) {
        __viewerOpenedViaPush = false;
        // Ensure URL reflects the current image (replace to normalize encoding)
        try { if (ViewerURL.get() !== fname) ViewerURL.setReplace(fname); } catch (_) { }
    } else {
        __viewerOpenedViaPush = true;
        try { ViewerURL.setPush(fname); } catch (_) { }
    }
    // Expose destroy for global handlers (popstate)
    window.__activeViewerDestroy = destroy;
}

let artworksLoaded = false;
let artworksInitPromise = null; // single-flight fetch so we don't double-append
let renderedArtworkKeys = new Set(); // guard against dupes across calls
let artworksList = []; // ordered list for viewer navigation [{fname, date}]
let artworkResizeHandler = null;
let artworkResizeAttached = false;
// Scroll-driven animator for artwork wrappers
let scrollAnimator = null;
function ensureScrollAnimator() {
    if (scrollAnimator) return scrollAnimator;
    const state = {
        items: new Set(),
        ticking: false,
        viewTop: 0,
        viewBottom: 0,
        viewH: 0,
        viewLeft: 0,
        viewRight: 0,
        container: null,
        reduceMotion: false,
        margin: 160,
        sources: new Set(),
    };
    const readEnv = () => {
        // Prefer the artwork container as the scrolling viewport
        state.container = document.getElementById('artwork_container') || state.container || null;
        if (state.container) {
            const cr = state.container.getBoundingClientRect();
            state.viewTop = cr.top;
            state.viewBottom = cr.bottom;
            state.viewH = Math.max(0, cr.height || (cr.bottom - cr.top));
            state.viewLeft = cr.left;
            state.viewRight = cr.right;
        } else {
            // Fallback to window viewport
            const vh = window.innerHeight || document.documentElement.clientHeight || 0;
            state.viewTop = 0;
            state.viewBottom = vh;
            state.viewH = vh;
            state.viewLeft = 0;
            state.viewRight = (window.innerWidth || document.documentElement.clientWidth || 0);
        }
        try { state.reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_) { state.reduceMotion = false; }
    };
    readEnv();

    function lerp(a, b, t) { return a + (b - a) * t; }
    function clamp01(x) { return Math.max(0, Math.min(1, x)); }

    function computeProgress(el) {
        const rect = el.getBoundingClientRect();
        const top = rect.top;
        const bottom = rect.bottom;
        const contTop = state.viewTop;
        const contBottom = state.viewBottom;
        const h = Math.max(1, rect.height);

        // Exit progress based on edges crossing container edges
        const pExitTop = top < contTop ? clamp01((contTop - top) / h) : 0;
        const pExitBottom = bottom > contBottom ? clamp01((bottom - contBottom) / h) : 0;

        // Enter progress (inverse mapping from outside towards fully inside)
        const pEnterFromTop = bottom < contTop ? clamp01((bottom - contTop) / h) : 1;
        const pEnterFromBottom = top > contBottom ? clamp01((contBottom - top) / h) : 1;

        // Visibility hint for culling
        const isVisible = bottom > contTop && top < contBottom;

        return {
            pExitTop, pExitBottom,
            pEnterFromTop, pEnterFromBottom,
            isVisible,
            h
        };
    }

    function apply(el) {
        if (state.reduceMotion) {
            el.style.opacity = '';
            el.style.transform = '';
            return;
        }
        const st = computeProgress(el);
        let opacity = 1, scale = 1, translateY = 0, translateX = 0, blurPx = 0;
        const maxMoveY = 24; // px vertical
        const maxMoveX = 120; // px horizontal spread
        const maxBlur = 10; // px
        const minOpacity = 0.55; // keep more visible
        const exitP = Math.max(st.pExitTop, st.pExitBottom);
        const pIn = Math.min(st.pEnterFromTop, st.pEnterFromBottom);
        const pEdge = exitP > 0 ? exitP : (1 - pIn); // 0..1 proximity to edge/outside
        // Flip curvature: keep effect low while on page, ramp as it moves off
        const gamma = 3.0;
        const expE = Math.min(1, Math.max(0, Math.pow(Math.max(0, pEdge), gamma)));

        // Opacity reduces but not fully transparent
        opacity = 1 - (1 - minOpacity) * expE;

        // Scale: upscale outwards based on edge proximity
        scale = lerp(1.0, 1.09, expE);

        // Vertical directional move
        if (exitP > 0) {
            // Exiting
            if (st.pExitBottom >= st.pExitTop) {
                translateY = lerp(0, maxMoveY, expE);
            } else {
                translateY = lerp(0, -maxMoveY, expE);
            }
        } else {
            // Entering: move from edge toward rest
            const fromBottom = st.pEnterFromBottom < st.pEnterFromTop;
            translateY = fromBottom ? lerp(maxMoveY, 0, pIn) : lerp(-maxMoveY, 0, pIn);
        }

        // Horizontal spread based on distance from container center
        const rect = el.getBoundingClientRect();
        const cx = (rect.left + rect.right) / 2;
        const contCx = (state.viewLeft + state.viewRight) / 2;
        const halfW = Math.max(1, (state.viewRight - state.viewLeft) / 2);
        const dxNorm = Math.max(-1, Math.min(1, (cx - contCx) / halfW)); // -1..1
        translateX = dxNorm * maxMoveX * expE;

        // Blur increases exponentially near edges
        blurPx = maxBlur * expE;

        el.style.opacity = String(opacity);
        el.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
        // Apply blur only to the image, not caption/overlay
        const img = el.querySelector('img');
        if (img) {
            img.style.filter = blurPx > 0 ? `blur(${blurPx}px)` : '';
        }
    }

    const updateAll = () => {
        if (state.ticking) return;
        state.ticking = true;
        requestAnimationFrame(() => {
            readEnv();
            state.items.forEach(el => {
                const rect = el.getBoundingClientRect();
                if (rect.bottom < -state.margin || rect.top > state.viewH + state.margin) {
                    return; // skip off-screen work
                }
                apply(el);
            });
            state.ticking = false;
        });
    };

    function addScrollSource(src) {
        if (!src || state.sources.has(src)) return;
        state.sources.add(src);
        src.addEventListener('scroll', updateAll, { passive: true });
    }

    // Default scroll sources
    // Prefer container if available; also keep window as a fallback
    if (state.container) addScrollSource(state.container);
    addScrollSource(window);
    window.addEventListener('resize', updateAll);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', updateAll);

    scrollAnimator = {
        add(el) { state.items.add(el); el.classList.add('artwork_animated'); apply(el); updateAll(); },
        remove(el) { state.items.delete(el); el.classList.remove('artwork_animated'); },
        refresh() { updateAll(); },
        observeScrollContainer(el) { addScrollSource(el); },
    };
    return scrollAnimator;
}

function scheduleScrollRefresh() {
    try {
        const anim = ensureScrollAnimator();
        // Batch into next frame
        requestAnimationFrame(() => anim.refresh());
    } catch (_) { }
}

function ensureArtworkResizeHandler() {
    if (!artworkResizeHandler) {
        artworkResizeHandler = () => {
            document.querySelectorAll('.artwork_image').forEach(wrapper => {
                const img = wrapper.querySelector('img');
                if (!img) return;
                const h = wrapper.clientHeight || parseFloat(getComputedStyle(wrapper).height) || 220;
                const w = img.naturalWidth;
                const nH = img.naturalHeight || 1;
                const ratio = w / nH;
                const widthPx = Math.max(140, Math.round(h * ratio));
                wrapper.style.width = `${widthPx}px`;
            });
        };
    }
    if (!artworkResizeAttached) {
        window.addEventListener('resize', artworkResizeHandler);
        artworkResizeAttached = true;
    }
}

function generateArtworks() {
    const container = document.getElementById("artwork_container");
    if (!container) return;
    container.style.opacity = "1";
    container.style.maxHeight = "100vh";

    // Toggle: if already loaded, just show and refresh layout
    if (artworksLoaded) {
        container.style.display = "";
        ensureArtworkResizeHandler();
        // Recompute widths in case layout changed while hidden
        requestAnimationFrame(() => artworkResizeHandler && artworkResizeHandler());
        return;
    }

    container.style.display = "";

    // If a load is already in progress, don't start another; just ensure visibility and layout refresh.
    if (artworksInitPromise) {
        ensureArtworkResizeHandler();
        requestAnimationFrame(() => artworkResizeHandler && artworkResizeHandler());
        return;
    }

    // Start fresh before the first (and only) load
    container.innerHTML = "<div class=\"artwork_spacer\"></div><div class=\"artwork_header\">Showcase</div>";
    renderedArtworkKeys.clear();
    artworksList = [];

    artworksInitPromise = fetch("/home/src/art/artlist.json", { cache: 'no-store' })
        .then(response => response.json())
        .then(data => {
            if (!Array.isArray(data)) return; // defensive
            const observers = ensureProgressiveObservers();
            data.forEach(artwork => {
                // Build a stable dedup key; prefer unique filename, fallback to date+name
                const key = (artwork && artwork.fname) ? String(artwork.fname) : `${artwork?.date || ""}|${artwork?.title || ""}`;
                if (renderedArtworkKeys.has(key)) return; // skip duplicates

                renderedArtworkKeys.add(key);
                artworksList.push({ fname: artwork.fname, date: artwork.date });
                const div = document.createElement("div");
                div.classList.add("artwork");
                div.dataset.key = key;
                const tsSec = parseFloat(artwork.date);
                const date = Number.isFinite(tsSec) ? new Date(tsSec * 1000) : new Date(artwork.date);
                const wrapper = document.createElement("div");
                wrapper.className = "artwork_image";

                const img = document.createElement("img");
                img.loading = "lazy";
                img.alt = artwork.fname;
                img.draggable = false;
                // Whenever the image updates, refresh animation frame
                img.addEventListener('load', scheduleScrollRefresh);

                const url = `/home/src/compact_art/${artwork.fname}`;
                const setWrapperWidthFromImage = () => {
                    const h = wrapper.clientHeight || parseFloat(getComputedStyle(wrapper).height) || 220;
                    const w = img.naturalWidth;
                    const nH = img.naturalHeight || 1;
                    const ratio = w / nH;
                    const widthPx = Math.max(140, Math.round(h * ratio));
                    wrapper.style.width = `${widthPx}px`;
                };

                const idx = artworksList.length - 1;
                wrapper.dataset.index = String(idx);
                if (artwork.fname.toLowerCase().endsWith(".gif")) {
                    // Show poster frame with overlay; only load/play GIF on click
                    const posterUrls = gifPosterUrlFromGif(url);
                    img.addEventListener('load', setWrapperWidthFromImage, { once: true });
                    // Start ultra-low first for fast first paint
                    img.src = posterUrls.ulq;
                    img.dataset.ulq = posterUrls.ulq;
                    img.dataset.lq = posterUrls.lq;
                    img.dataset.hq = posterUrls.hq;
                    img.dataset.resLevel = 'ulq';
                    // Observe for progressive upgrades
                    if (observers) {
                        observers.lq.observe(img);
                        observers.hq.observe(img);
                    }
                    img.alt = `${artwork.fname} (GIF)`;

                    // Build overlay with play button
                    const overlay = document.createElement('div');
                    overlay.className = 'gif_overlay';
                    const playBtn = document.createElement('div');
                    playBtn.className = 'gif_play_btn';
                    overlay.appendChild(playBtn);
                    wrapper.appendChild(overlay);

                    let loaded = false;
                    const play = async () => {
                        if (loaded) return;
                        loaded = true;
                        overlay.classList.add('loading');
                        await PreloadManager.preload(url, 'high');
                        const tryLoad = (src) => new Promise((resolve) => {
                            let settled = false;
                            const timeout = setTimeout(() => {
                                if (!settled) { settled = true; cleanup(); resolve(false); }
                            }, 8000);
                            const cleanup = () => {
                                clearTimeout(timeout);
                                img.removeEventListener('load', onLoad);
                                img.removeEventListener('error', onError);
                            };
                            const onLoad = () => { if (!settled) { settled = true; cleanup(); resolve(true); } };
                            const onError = () => { if (!settled) { settled = true; cleanup(); resolve(false); } };
                            img.addEventListener('load', onLoad, { once: true });
                            img.addEventListener('error', onError, { once: true });
                            img.src = src;
                        });

                        let ok = await tryLoad(url);
                        if (!ok) {
                            const busted = url + (url.includes('?') ? '&' : '?') + 'cb=' + Date.now();
                            ok = await tryLoad(busted);
                        }
                        overlay.remove();
                    };

                    overlay.addEventListener('click', play);
                    // Clicking the image opens the full viewer; overlay click keeps in-grid play
                    img.addEventListener('click', (ev) => {
                        ev.stopPropagation();
                        openImageViewer({ fname: artwork.fname, date, index: idx, list: artworksList });
                    });
                    // handled by global anti-copy handlers

                    // Hover preloading for faster click
                    let hoverPreloaded = false;
                    const maybePreloadOnHover = () => {
                        if (!hoverPreloaded) {
                            hoverPreloaded = true;
                            PreloadManager.preload(url, 'normal');
                        }
                    };
                    wrapper.addEventListener('mouseenter', maybePreloadOnHover, { passive: true });

                    // Near-viewport preloading using IntersectionObserver
                    if ('IntersectionObserver' in window) {
                        const io = new IntersectionObserver((entries) => {
                            entries.forEach((entry) => {
                                if (entry.isIntersecting || entry.intersectionRatio > 0) {
                                    PreloadManager.preload(url, 'low');
                                    io.disconnect();
                                }
                            });
                        }, { root: null, rootMargin: '200px 0px', threshold: 0.01 });
                        io.observe(wrapper);
                    }
                } else {
                    // Progressive non-GIF images: ULQ -> LQ -> HQ
                    const p = progressiveUrlsForImage(url);
                    img.addEventListener('load', setWrapperWidthFromImage, { once: true });
                    // Eager paint with ULQ, upgrade via observers near/in viewport
                    img.src = p.ulq;
                    img.dataset.ulq = p.ulq;
                    img.dataset.lq = p.lq;
                    img.dataset.hq = p.hq;
                    img.dataset.resLevel = 'ulq';
                    const obs = observers || ensureProgressiveObservers();
                    if (obs) {
                        obs.lq.observe(img);
                        obs.hq.observe(img);
                    }
                    // Click opens viewer
                    img.addEventListener('click', () => openImageViewer({ fname: artwork.fname, date, index: idx, list: artworksList }));
                    // handled by global anti-copy handlers
                }

                const caption = document.createElement("p");
                caption.textContent = date.toLocaleString().split(",")[0];

                wrapper.appendChild(img);
                wrapper.appendChild(caption);
                div.appendChild(wrapper);
                container.appendChild(div);

                // Register for scroll-driven animation
                const animator = ensureScrollAnimator();
                animator.add(wrapper);
            });
            // Mark as loaded and set up resize handling once
            artworksLoaded = true;
            ensureArtworkResizeHandler();
            // Initial pass to ensure widths are correct
            requestAnimationFrame(() => {
                artworkResizeHandler && artworkResizeHandler();
                const anim = ensureScrollAnimator();
                // Observe the artwork container scroll (if it is scrollable)
                const cont = document.getElementById('artwork_container');
                if (cont) anim.observeScrollContainer(cont);
                anim.refresh();
            });
        })
        .catch(err => {
            console.error("Failed to load artworks:", err);
        })
        .finally(() => {
            // Release the single-flight lock
            artworksInitPromise = null;
        });
}

function clear_and_hide_artworks() {
    const container = document.getElementById("artwork_container");
    if (!container) {
        console.log("Container not found");
        return;
    }
    // Toggle: just hide, keep DOM so we can reshow without reloading
    // Do not clear while a load is in-flight; allow single-flight to complete
    container.style.opacity = "0";
    container.style.maxHeight = "0";

    // Optional: detach resize handler while hidden
    if (artworkResizeAttached && artworkResizeHandler) {
        window.removeEventListener('resize', artworkResizeHandler);
        artworkResizeAttached = false;
    }
}

function show_homepage() {
    const home = document.getElementById("home_container");
    if (home) {
        home.style.opacity = "1";
        home.style.maxHeight = "100vh";
    }
}

function hide_homepage() {
    const home = document.getElementById("home_container");
    if (home) {
        home.style.opacity = "0";
        home.style.maxHeight = "0";
    }
}

function show_section(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.add('is-visible');
    el.setAttribute('aria-hidden', 'false');
}

function hide_section(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('is-visible');
    el.setAttribute('aria-hidden', 'true');
}


function createShaderProgram(canvas, vertexSrc, fragmentSrc) {
    const gl = canvas.getContext('webgl');
    if (!gl) {
        console.error("WebGL not supported");
        return null;
    }
    function compileShader(type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            console.error("Shader compile error:", gl.getShaderInfoLog(shader));
            gl.deleteShader(shader);
            return null;
        }
        return shader;
    }
    const vertexShader = compileShader(gl.VERTEX_SHADER, vertexSrc);
    const fragmentShader = compileShader(gl.FRAGMENT_SHADER, fragmentSrc);
    if (!vertexShader || !fragmentShader) return null;
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error('Program link error:', gl.getProgramInfoLog(program));
        return null;
    }
    return {
        use() {
            gl.useProgram(program);
            // Setup a full-screen quad
            const positionBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
            const positions = [-1, -1, 1, -1, -1, 1, 1, 1];
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
            const positionLocation = gl.getAttribLocation(program, 'a_position');
            gl.enableVertexAttribArray(positionLocation);
            gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
            gl.viewport(0, 0, canvas.width, canvas.height);
        },
        setFloat(name, value) {
            const location = gl.getUniformLocation(program, name);
            gl.uniform1f(location, value);
        },
        setVec2(name, value) {
            const location = gl.getUniformLocation(program, name);
            gl.uniform2fv(location, value);
        },
        setVec4(name, value) {
            const location = gl.getUniformLocation(program, name);
            gl.uniform4fv(location, value);
        },
        draw() {
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        },
    };
}


function build_background(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth * dpr;
    const h = canvas.clientHeight * dpr;
    canvas.width = w;
    canvas.height = h;
    const vertexShaderSrc = `
        attribute vec4 a_position;
        void main() {
            gl_Position = a_position;
        }
    `;
    const fragmentShaderSrc = `
        precision mediump float;
        uniform vec2 iResolution;   // viewport resolution (in pixels)
        uniform float iTime;        // time in seconds
        uniform vec4 iMouse;        // mouse xy: current pos (px)
        uniform float y_pos;        // scroll Y position (pixels)

        #define iterations 17
        #define formuparam 0.53

        #define volsteps 20
        #define stepsize 0.1

        #define zoom   0.800
        #define tile   0.850
        #define speed  0.0017

        #define brightness 0.0015
        #define darkmatter 0.300
        #define distfading 0.730
        #define saturation 0.850

        void main() {
            // get coords and direction
            vec2 uv = gl_FragCoord.xy / iResolution.xy - 0.5;
            uv.y *= iResolution.y / iResolution.x;
            // add subtle vertical parallax based on scroll
            float sScroll = y_pos / max(1.0, iResolution.y);
            vec3 dir=vec3(uv*zoom,1.);
            float time=iTime*(speed*0.05)+.25;

            //mouse rotation
            float a1=.5+iMouse.x/iResolution.x*2.;
            float a2=.8+iMouse.y/iResolution.y*2.;
            mat2 rot1=mat2(cos(a1),sin(a1),-sin(a1),cos(a1));
            mat2 rot2=mat2(cos(a2),sin(a2),-sin(a2),cos(a2));
            dir.xz*=rot1;
            dir.xy*=rot2;
            vec3 from=vec3(1.,.5,0.5);
            from+=vec3(time*2.,time,-2.);
            from.xz*=rot1;
            from.xy*=rot2;
            from.xy += sScroll * .01; // scroll-based vertical offset
            //volumetric rendering
            float s=0.1,fade=1.;
            vec3 v=vec3(0.);
            for (int r=0; r<volsteps; r++) {
                vec3 p=from+s*dir*.5;
                p = abs(vec3(tile)-mod(p,vec3(tile*2.))); // tiling fold
                float pa,a=pa=0.;
                for (int i=0; i<iterations; i++) { 
                    p=abs(p)/dot(p,p)-formuparam; // the magic formula
                    a+=abs(length(p)-pa); // absolute sum of average change
                    pa=length(p);
                }
                float dm=max(0.,darkmatter-a*a*.001); //dark matter
                a*=a*a; // add contrast
                if (r>6) fade*=1.-dm; // dark matter, don't render near
                //v+=vec3(dm,dm*.5,0.);
                v+=fade;
                v+=vec3(s*s, s*s, s)*a*brightness*fade; // coloring based on distance
                fade*=distfading; // distance fading
                s+=stepsize;
            }
            v=mix(vec3(length(v)),v,saturation)*vec3(0.85, 0.8, 1.0); //color adjust
            // gentle star twinkle using a simple analytical pattern
            float tw = 0.985 + (0.015 * sin(iTime*8.0 + uv.x*24.0 + uv.y*31.0));
            v *= (tw+1.0) *0.5;
            gl_FragColor = vec4(v*.01,1.); 	
            
        }
    `;

    const shader = createShaderProgram(canvas, vertexShaderSrc, fragmentShaderSrc);
    if (!shader) {
        console.error("Failed to create background shader");
        return { update: function () { } };
    }
    shader.use();

    let scrollY = 0;
    let start_offset = 5900;
    function update(y) {
        if (typeof y === 'number' && !isNaN(y)) {
            scrollY = y;
        }
        // Map uniforms expected by the shader
        shader.setVec2('iResolution', [w, h]);
        shader.setFloat('iTime', ((performance.now() || 0) / 1000.0) + start_offset);
        // We don't track mouse here; send zeros
        shader.setVec4('iMouse', [0.0, 0.0, 0.0, 0.0]);
        shader.setFloat('y_pos', scrollY);
        shader.draw();
    }
    // Draw once initially
    update(0);
    // Keep a very light animation loop so stars drift/twinkle even without scroll
    (function tick() { update(scrollY); requestAnimationFrame(tick); })();
    return { update };
}

document.addEventListener("DOMContentLoaded", function () {
    requestCookieConsent();
    const navbar = document.querySelector(".navbar");
    const items = document.querySelectorAll(".navbar_item");
    const context_menu_buttons = [
        document.getElementById('context_menu_view'),
        document.getElementById('context_menu_download'),
        document.getElementById('context_menu_info'),
        document.getElementById('context_menu_close')
    ]
    let canvas = document.getElementById('background_canvas');
    if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.id = 'background_canvas';
        canvas.className = 'background_canvas';
        document.body.appendChild(canvas);
    }

    let { update } = build_background(canvas);

    ['home_container', 'artwork_container', 'processes_container', 'commissions_container'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('scroll', (e) => {
                update(-e.target.scrollTop);
            });
        }
    });

    // Include hash so we can detect sections like #showcase on first load
    const getOnPage = () => window.location.pathname + window.location.hash;
    if (!navbar || items.length === 0) return;


    let activeIndex = 0;


    // Initialize active tab from current hash before any layout adjustments
    const setActiveFromHash = () => {
        const hash = window.location.hash || '#home';
        let found = 0;
        items.forEach((item, index) => {
            const itemName = item.getAttribute('name');
            if (itemName && hash === `#${itemName}`) {
                found = index;
            }
        });
        activeIndex = found;
        items.forEach((el, i) => el.classList.toggle('is-active', i === activeIndex));
        // Only draw the footer highlight in desktop mode
        if (!navbar.classList.contains('is-mobile')) {
            const activeItem = document.querySelector('.navbar_item.is-active') || items[activeIndex] || items[0];
            if (activeItem) positionHighlightToItem(activeItem);
        }
    };
    setActiveFromHash();

    items.forEach((item, index) => {
        item.addEventListener("mouseenter", () => {
            // avoid hover highlight when mobile menu is active
            if (navbar.classList.contains('is-mobile')) return;
            positionHighlightToItem(item);
        });
        item.addEventListener("click", () => {
            // immediate visual feedback; hashchange will perform section switch
            activeIndex = index;
            items.forEach((el, i) => el.classList.toggle('is-active', i === activeIndex));
            if (!navbar.classList.contains('is-mobile')) positionHighlightToItem(item);
        });
    });

    // When leaving the navbar, snap back to the active item
    navbar.addEventListener("mouseleave", () => {
        const activeItem = document.querySelector('.navbar_item.is-active') || items[activeIndex] || items[0];
        if (activeItem) positionHighlightToItem(activeItem);
    });

    // Recompute on resize to keep alignment correct
    window.addEventListener("resize", () => {
        if (!navbar.classList.contains('is-mobile')) {
            requestAnimationFrame(() => {
                const activeItem = document.querySelector('.navbar_item.is-active') || items[activeIndex] || items[0];
                if (activeItem) positionHighlightToItem(activeItem);
            });
        }
    });
    window.addEventListener("load", () => {
        const ON_PAGE = getOnPage();
        // On page load, check if any item matches the current URL path
        items.forEach((item, index) => {
            const itemPath = item.getAttribute("data-path");
            const itemName = item.getAttribute("name");
            // Match either by explicit data-path or by name attribute
            if (itemPath === ON_PAGE || (itemName && ON_PAGE.endsWith(`#${itemName}`))) {
                activeIndex = index;
                items.forEach((el, i) => el.classList.toggle('is-active', i === activeIndex));
                if (!navbar.classList.contains('is-mobile')) {
                    const activeItem = document.querySelector('.navbar_item.is-active') || item;
                    if (activeItem) positionHighlightToItem(activeItem);
                }
            }
        });


        // Adaptive navbar height: when page is zoomed in heavily, shrink navbar to free space
        let baseNavH = null;
        const root = document.documentElement;
        const getScale = () => (window.visualViewport && typeof window.visualViewport.scale === 'number')
            ? window.visualViewport.scale
            : (window.devicePixelRatio || 1);
        const updateNavHeight = () => {
            try {
                // Cache initial base from computed style on first run
                if (baseNavH == null) {
                    const cs = getComputedStyle(root).getPropertyValue('--nav-h').trim();
                    const px = parseFloat(cs);
                    baseNavH = Number.isFinite(px) ? px : 64;
                }
                const scale = getScale();
                // Only shrink when notably zoomed in
                if (scale > 1.15) {
                    // Shrink inversely with scale, but keep within [38px, base]
                    const target = Math.max(38, Math.min(baseNavH, Math.round(baseNavH / Math.min(scale, 2.2))));
                    root.style.setProperty('--nav-h', `${target}px`);
                } else {
                    root.style.setProperty('--nav-h', `${baseNavH}px`);
                }
            } catch (_) { /* noop */ }
        };
        updateNavHeight();
        // Listen for zoom/resize changes
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', updateNavHeight);
        }
        window.addEventListener('resize', updateNavHeight);

    });

    // Navbar mobile mode: keep banner/items visible until overflow, then switch to top-right button menu
    const itemsBar = document.querySelector('.navbar_items');
    const navToggle = document.querySelector('.nav_toggle');
    const updateNavbarMode = () => {
        if (!navbar || !itemsBar) return;
        // Measure in desktop state to detect real overflow
        const wasMobile = navbar.classList.contains('is-mobile');
        if (wasMobile) {
            navbar.classList.remove('is-mobile');
            itemsBar.removeAttribute('data-open');
        }
        // Using scrollWidth vs clientWidth to detect overflow of menu items
        const overflow = itemsBar.scrollWidth > (itemsBar.clientWidth + 1);
        if (overflow) {
            navbar.classList.add('is-mobile');
            itemsBar.removeAttribute('data-open');
        }
        // Reposition or hide highlight depending on mode
        if (!navbar.classList.contains('is-mobile')) {
            const activeItem = document.querySelector('.navbar_item.is-active') || items[activeIndex] || items[0];
            if (activeItem) positionHighlightToItem(activeItem);
        }
    };
    // Toggle dropdown in mobile mode
    if (navToggle) {
        navToggle.addEventListener('click', (e) => {
            if (!navbar.classList.contains('is-mobile')) return;
            e.stopPropagation();
            const open = itemsBar.getAttribute('data-open') === 'true';
            itemsBar.setAttribute('data-open', open ? 'false' : 'true');
            navToggle.setAttribute('aria-expanded', String(!open));
        });
    }
    // Close when clicking outside
    document.addEventListener('click', (e) => {
        if (!navbar.classList.contains('is-mobile')) return;
        if (itemsBar.getAttribute('data-open') === 'true' && !navbar.contains(e.target)) {
            itemsBar.setAttribute('data-open', 'false');
            if (navToggle) navToggle.setAttribute('aria-expanded', 'false');
        }
    }, { capture: true });
    // Close after selecting a menu item in mobile
    items.forEach((item) => item.addEventListener('click', () => {
        if (!navbar.classList.contains('is-mobile')) return;
        itemsBar.setAttribute('data-open', 'false');
        if (navToggle) navToggle.setAttribute('aria-expanded', 'false');
    }));
    // Re-evaluate on resize and load
    window.addEventListener('resize', updateNavbarMode);
    window.addEventListener('load', updateNavbarMode);
    // Initial evaluation
    requestAnimationFrame(updateNavbarMode);

    // Prioritize the banner immediately on DOM ready
    const bannerImg = document.querySelector('img.banner');
    if (bannerImg) {
        try { bannerImg.setAttribute('decoding', 'async'); } catch (_) { }
        try { bannerImg.setAttribute('loading', 'eager'); } catch (_) { }
        try { bannerImg.setAttribute('fetchpriority', 'high'); } catch (_) { }
        const bannerGif = bannerImg.getAttribute('data-gif');
        if (bannerGif) {
            // If no src yet or it's a placeholder, set it now to start network early
            const cur = bannerImg.getAttribute('src');
            if (!cur || cur === '#' || cur.startsWith('data:')) {
                bannerImg.src = bannerGif;
            }
        }
    }

    go_to_tab();
    // Global anti-copy handlers
    const blockEvents = ['copy', 'cut', 'contextmenu', 'dragstart'];
    const showBlackout = () => {
        // Try to find existing overlay from viewer scope
        let overlay = document.querySelector('.copy_block_overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'copy_block_overlay';
            const msg = document.createElement('div');
            msg.className = 'msg';
            msg.textContent = 'DO NOT COPY';
            overlay.appendChild(msg);
            document.body.appendChild(overlay);
        }
        overlay.style.display = '';
        // Attempt to clear clipboard (best-effort)
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText('');
        }
    };
    const hideBlackout = () => {
        const overlay = document.querySelector('.copy_block_overlay');
        if (overlay) overlay.style.display = 'none';
    };

    context_menu_buttons.forEach(btn => {
        if (!btn) return;
        btn.addEventListener('click', () => {
            const id = btn.id || '';
            const name =
                btn.getAttribute('data-name') ||
                (id.includes('_view') ? 'view' :
                    id.includes('_download') ? 'download' :
                        id.includes('_info') ? 'info' :
                            (id.includes('_share') || id.includes('_close')) ? 'share' : '');
            const menu = document.getElementById('context_menu');
            if (!name || !menu) return;
            let fname = menu.getAttribute('data-fname') || '';
            console.log(`Context menu action: ${name} on ${fname}`);
            if (!fname) return;
            if (fname.endsWith(' (GIF)')) {
                fname = fname.replace(/\ \(GIF\)$/, '');
            }
            if (name === 'view') {
                openImageViewer({ fname, list: artworksList });
            } else if (name === 'download') {
                const a = document.createElement('a');
                a.href = `/home/src/art/${fname}`;
                a.download = fname;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            } else if (name === 'info') {
                alert(`Filename: ${fname}`);
            } else if (name === 'share') {
                let url = window.location.origin + `/home/src/art/${fname}`;
                url = url.replace(/\ +/g, '%20'); // space to %20
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(url).then(() => {
                        alert('Image URL copied to clipboard');
                    }).catch(() => {
                        prompt('Copy the image URL:', url);
                    });
                } else {
                    prompt('Copy the image URL:', url);
                }
            }
            // Always close the menu after an action
            menu.style.opacity = '0';
            menu.removeAttribute('data-fname');
        });
    });

    blockEvents.forEach(ev => document.addEventListener(ev, (e) => {
        // Allow context menu on links and artwork containers; otherwise block (custom menu on artwork handled separately)
        if (ev === 'contextmenu') {
            const t = e.target;
            const isLink = (t && (t.closest && t.closest('a'))) || (t && t.tagName === 'A');
            const artworkEl = t && t.closest && t.closest('.artwork_image');
            const menu = document.getElementById('context_menu');

            function closeMenu() {
                if (!menu) return;
                menu.style.opacity = '0';
                menu.removeAttribute('data-fname');
                document.removeEventListener('click', onDocClick, true);
                window.removeEventListener('keydown', onKey, true);
                window.removeEventListener('scroll', closeMenu, true);
                window.removeEventListener('resize', closeMenu);
            }
            function onDocClick(evt) {
                if (!menu || !menu.contains(evt.target)) closeMenu();
            }
            function onKey(evt) {
                if (evt.key === 'Escape') closeMenu();
            }

            if (isLink) {
                // Allow native menu on links
                return;
            }

            if (artworkEl && menu) {
                // Open custom context menu for artworks
                const imgEl = artworkEl.querySelector('img');
                const fname =
                    (imgEl && (imgEl.getAttribute('data-fname') || imgEl.getAttribute('alt'))) ||
                    artworkEl.getAttribute('data-fname') ||
                    '';

                // Close any previous instance, then show
                closeMenu();
                menu.style.opacity = '1';
                menu.style.display = 'block';

                // Position within viewport
                const vw = window.innerWidth, vh = window.innerHeight;
                // Force layout to get dimensions once visible
                const rect = menu.getBoundingClientRect();
                const x = Math.min(e.pageX, vw - rect.width - 4);
                const y = Math.min(e.pageY, vh - rect.height - 4);
                menu.style.left = `${Math.max(4, x)}px`;
                menu.style.top = `${Math.max(4, y)}px`;
                menu.setAttribute('data-fname', fname);

                // Auto-close hooks
                setTimeout(() => {
                    document.addEventListener('click', onDocClick, { capture: true, once: true });
                }, 0);
                window.addEventListener('keydown', onKey, { capture: true });
                window.addEventListener('scroll', closeMenu, { capture: true });
                window.addEventListener('resize', closeMenu);

                e.preventDefault();
                return;
            }

            // Any other right-click closes our menu and blocks the native one
            if (menu) menu.style.opacity = '0';
            e.preventDefault();
            return;
        }
        // Block other restricted events
        e.preventDefault();
    }));
    // Detect PrintScreen key (PrtSc) and OS screenshot combos where possible
    window.addEventListener('keydown', (e) => {
        // PrintScreen on many layouts
        if (e.key === 'PrintScreen') {
            e.preventDefault();
            showBlackout();
        }
        // Common screenshot combos (best-effort; cannot reliably block)
        if ((e.ctrlKey && e.shiftKey && (e.key === 'S' || e.key === 's')) || // some tools
            (e.metaKey && e.shiftKey && (e.key === '3' || e.key === '4'))) { // macOS patterns
            showBlackout();
        }
    });
    // Hide blackout on click (optional) so site is usable again
    document.addEventListener('click', () => hideBlackout(), { capture: true });

    // Deep-link: If URL has ?viewer=... open the viewer right away.
    const handleViewerURL = () => {
        const v = ViewerURL.get();
        const active = typeof window.__activeViewerDestroy === 'function';
        if (v && !active) {
            openImageViewer({ fname: v, fromURL: true, list: artworksList });
        } else if (!v && active) {
            // Close any active viewer if URL no longer has the tag
            try { window.__activeViewerDestroy(); } catch (_) { }
        }
    };
    // Initial check after DOM is ready
    handleViewerURL();
    // Respond to back/forward
    window.addEventListener('popstate', handleViewerURL);
});

window.addEventListener("hashchange", () => {
    // Keep active tab, blur highlight, and content in sync
    go_to_tab();
});

function go_to_tab() {
    const ON_PAGE = window.location.hash;
    const items = document.querySelectorAll(".navbar_item");
    if (items.length === 0) return;

    let activeIndex = 0;

    items.forEach((item, index) => {
        const itemName = item.getAttribute("name");
        // Match either by explicit data-path or by name attribute
        if (itemName && `#${itemName}` === ON_PAGE) {
            activeIndex = index;
        }
    });

    // Update active class and highlight (skip highlight in mobile mode)
    const navbar = document.querySelector('.navbar');
    items.forEach((el, i) => el.classList.toggle('is-active', i === activeIndex));
    if (!(navbar && navbar.classList.contains('is-mobile'))) {
        const activeItem = document.querySelector('.navbar_item.is-active') || items[activeIndex] || items[0];
        if (activeItem) positionHighlightToItem(activeItem);
    }
    if (ON_PAGE == "#showcase") {
        generateArtworks();
    } else {
        clear_and_hide_artworks();
    }
    if (ON_PAGE == "" || ON_PAGE == "#" || ON_PAGE == "#home") {
        show_homepage();
    } else {
        hide_homepage();
    }
    // Processes and Comm Info sections
    if (ON_PAGE == "#processes") {
        show_section('processes_container');
    } else {
        hide_section('processes_container');
    }
    if (ON_PAGE == "#commissions") {
        show_section('commissions_container');
    } else {
        hide_section('commissions_container');
    }
    // if (ON_PAGE == "#processes") {
    //     show_processes();
    // } else {
    //     hide_processes();
    // }
}

// Mobile simple viewer: pinch-zoom, pan, rotate, close button, top blurred bar
function openMobileViewer({ fname, date, fromURL = false }) {
    const overlay = document.createElement('div');
    overlay.className = 'mv_overlay';
    const topbar = document.createElement('div');
    topbar.className = 'mv_topbar';
    const tags = document.createElement('div');
    tags.className = 'mv_tags';
    const resTag = document.createElement('div');
    resTag.className = 'mv_tag';
    resTag.textContent = 'Resolution: …';
    const dateTag = document.createElement('div');
    dateTag.className = 'mv_tag';
    try { dateTag.textContent = `Date: ${date ? date.toLocaleString() : 'Unknown'}`; } catch (_) { dateTag.textContent = 'Date: Unknown'; }
    tags.append(resTag, dateTag);
    const btnClose = document.createElement('button');
    btnClose.className = 'mv_close';
    btnClose.setAttribute('aria-label', 'Close');
    btnClose.textContent = '✕';
    const canvas = document.createElement('div');
    canvas.className = 'mv_canvas';
    const wrap = document.createElement('div');
    wrap.className = 'mv_wrap';
    const img = document.createElement('img');
    img.className = 'mv_img';
    img.alt = fname;
    img.draggable = false;
    img.decoding = 'async';
    const fullUrl = `/home/src/art/${fname}`;
    img.src = fullUrl;
    wrap.appendChild(img);
    canvas.appendChild(wrap);
    topbar.appendChild(tags);
    overlay.appendChild(canvas);
    overlay.appendChild(topbar);
    overlay.appendChild(btnClose);
    document.body.appendChild(overlay);

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function destroy() {
        overlay.remove();
        document.body.style.overflow = prevOverflow;
        if (window.__activeViewerDestroy === destroy) window.__activeViewerDestroy = null;
    }
    function close() {
        const hasParam = !!ViewerURL.get();
        if (__viewerOpenedViaPush && hasParam) { history.back(); return; }
        if (hasParam) ViewerURL.clearReplace();
        destroy();
    }
    btnClose.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    let natW = 0, natH = 0;
    let scale = 1, rotate = 0; // radians
    let tx = 0, ty = 0; // translation in px (apply to wrap)
    let minScale = 1;
    let touches = [];
    let pinch = null; // { s0, r0, dist0, angle0, qAnchor:[x,y], ids:[idA,idB] }

    function apply() {
        wrap.style.transform = `translate(-50%, -50%) translate(${tx}px, ${ty}px) rotate(${rotate}rad) scale(${scale})`;
    }
    function computeMin() {
        const vw = canvas.clientWidth, vh = canvas.clientHeight;
        if (!natW || !natH || !vw || !vh) return 1;
        return Math.min(vw / natW, vh / natH, 1);
    }
    function toLocal(px, py) {
        // Map canvas point p -> image local coordinates q (origin at image center)
        // wrap is centered at canvas center; tx,ty are offset from that center
        const cos = Math.cos(rotate), sin = Math.sin(rotate);
        const dx = px - (canvas.clientWidth / 2) - tx;
        const dy = py - (canvas.clientHeight / 2) - ty;
        // inverse rotate then inverse scale
        const rx = cos * dx + sin * dy;
        const ry = -sin * dx + cos * dy;
        return [rx / scale, ry / scale];
    }
    function solveTranslateForAnchor(px, py, qx, qy) {
        // Given desired p and current r,s, compute tx,ty keeping q fixed under p
        const cos = Math.cos(rotate), sin = Math.sin(rotate);
        const sx = qx * scale, sy = qy * scale;
        const rx = cos * sx - sin * sy;
        const ry = sin * sx + cos * sy;
        // wrap is centered; translate relative to canvas center
        tx = (px - (canvas.clientWidth / 2)) - rx;
        ty = (py - (canvas.clientHeight / 2)) - ry;
    }
    function setPinchBaseline(a, b) {
        const rect = canvas.getBoundingClientRect();
        const midx = ((a.clientX + b.clientX) / 2) - rect.left;
        const midy = ((a.clientY + b.clientY) / 2) - rect.top;
        const dist0 = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
        const angle0 = Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX);
        const [qx, qy] = toLocal(midx, midy);
        pinch = { s0: scale, r0: rotate, dist0, angle0, qAnchor: [qx, qy], ids: [a.identifier, b.identifier] };
        // reset last pan deltas
        delete img._lx; delete img._ly;
    }

    img.addEventListener('load', () => {
        natW = img.naturalWidth; natH = img.naturalHeight;
        resTag.textContent = `Resolution: ${natW} × ${natH}`;
        minScale = computeMin();
        scale = minScale; tx = 0; ty = 0; rotate = 0; apply();
    }, { once: true });

    overlay.addEventListener('touchstart', (e) => {
        for (const t of e.changedTouches) touches.push(t);
        if (touches.length > 2) touches = touches.slice(-2);
        if (touches.length === 2) {
            setPinchBaseline(touches[0], touches[1]);
        }
    }, { passive: true });
    overlay.addEventListener('touchmove', (e) => {
        if (!touches.length) return;
        e.preventDefault();
        const updates = new Map();
        for (const t of e.changedTouches) updates.set(t.identifier, t);
        touches = touches.map(t => updates.get(t.identifier) || t);
        if (touches.length === 1) {
            const t = touches[0];
            const cx = t.clientX, cy = t.clientY;
            if (img._lx == null) { img._lx = cx; img._ly = cy; }
            tx += (cx - img._lx); ty += (cy - img._ly);
            img._lx = cx; img._ly = cy; apply();
        } else if (touches.length >= 2) {
            const [a, b] = touches;
            // Reset baseline if ids changed or missing
            if (!pinch || !pinch.ids || pinch.ids[0] !== a.identifier || pinch.ids[1] !== b.identifier) {
                setPinchBaseline(a, b);
            }
            const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
            const angle = Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX);
            const rect = canvas.getBoundingClientRect();
            const midx = ((a.clientX + b.clientX) / 2) - rect.left;
            const midy = ((a.clientY + b.clientY) / 2) - rect.top;
            // Update scale and rotate from baseline
            const rawScale = pinch.s0 * (dist / Math.max(1, pinch.dist0));
            scale = Math.max(minScale * 0.5, Math.min(8, rawScale));
            rotate = pinch.r0 + (angle - pinch.angle0);
            // Keep the anchor point under the midpoint
            const [qx, qy] = pinch.qAnchor;
            solveTranslateForAnchor(midx, midy, qx, qy);
            apply();
        }
    }, { passive: false });
    overlay.addEventListener('touchend', (e) => {
        const ids = new Set(Array.from(e.changedTouches).map(t => t.identifier));
        touches = touches.filter(t => !ids.has(t.identifier));
        if (touches.length < 2) { pinch = null; }
        if (!touches.length) { delete img._lx; delete img._ly; }
    });
    overlay.addEventListener('touchcancel', () => { touches = []; pinch = null; delete img._lx; delete img._ly; });

    // Update URL state on open and register destroy handle
    if (fromURL) {
        __viewerOpenedViaPush = false;
        try { if (ViewerURL.get() !== fname) ViewerURL.setReplace(fname); } catch (_) { }
    } else {
        __viewerOpenedViaPush = true;
        try { ViewerURL.setPush(fname); } catch (_) { }
    }
    window.__activeViewerDestroy = destroy;
}