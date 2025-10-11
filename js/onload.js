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

// no watermark tile (removed per request)

function openImageViewer({ fname, date, index = null, list = null }) {
    ensureViewerStyles();
    // Route touch-first devices to a simpler mobile viewer
    if (isMobileLike()) {
        return openMobileViewer({ fname, date });
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
    function close() { overlay.remove(); window.removeEventListener('keydown', onKey); document.body.style.overflow = prevBodyOverflow; }
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
        const showCurrent = (i) => {
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
    }
}

let artworksLoaded = false;
let artworksInitPromise = null; // single-flight fetch so we don't double-append
let renderedArtworkKeys = new Set(); // guard against dupes across calls
let artworksList = []; // ordered list for viewer navigation [{fname, date}]
let artworkResizeHandler = null;
let artworkResizeAttached = false;

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
    container.innerHTML = "";
    renderedArtworkKeys.clear();
    artworksList = [];

    artworksInitPromise = fetch("/home/src/art/artlist.txt")
        .then(response => response.json())
        .then(data => {
            if (!Array.isArray(data)) return; // defensive
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
                    // Start with ULQ poster, then upgrade to LQ, then HQ silently
                    img.src = posterUrls.ulq;
                    const upgradeTo = (nextUrl) => {
                        const temp = new Image();
                        temp.onload = () => { img.src = nextUrl; };
                        temp.src = nextUrl;
                    };
                    upgradeTo(posterUrls.lq);
                    upgradeTo(posterUrls.hq);
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
                    img.src = p.ulq;
                    const u1 = new Image();
                    u1.onload = () => { img.src = p.lq; };
                    u1.src = p.lq;
                    const u2 = new Image();
                    u2.onload = () => { img.src = p.hq; };
                    u2.src = p.hq;
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
            });
            // Mark as loaded and set up resize handling once
            artworksLoaded = true;
            ensureArtworkResizeHandler();
            // Initial pass to ensure widths are correct
            requestAnimationFrame(() => artworkResizeHandler && artworkResizeHandler());
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

document.addEventListener("DOMContentLoaded", function () {

    const navbar = document.querySelector(".navbar");
    const items = document.querySelectorAll(".navbar_item");
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
        // Ensure the navbar banner plays (not paused): set src from data-gif
        const bannerImg = document.querySelector('img.banner');
        if (bannerImg) {
            const bannerGif = bannerImg.getAttribute('data-gif');
            if (bannerGif && !bannerImg.getAttribute('src')) {
                bannerImg.src = bannerGif;
            }
        }

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
    blockEvents.forEach(ev => document.addEventListener(ev, (e) => {
        e.preventDefault();
        if (ev === 'contextmenu' && e.target.tagName === 'A') {
            // Allow context menu on links
            return true;
        }
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
function openMobileViewer({ fname, date }) {
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
    function close() {
        overlay.remove();
        document.body.style.overflow = prevOverflow;
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
}