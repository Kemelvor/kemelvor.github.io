function positionHighlightToItem(item) {
    const highlight = document.querySelector(".navbar_footer_highlight");
    const footer = document.querySelector(".navbar_footer");
    if (!item || !highlight || !footer) return;

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
    .iv_overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.75); z-index: 9999; display: flex; align-items: center; justify-content: center; }
    .iv_panel { position: relative; width: 96vw; height: 96vh; background: #0c0c0c; border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,0.6); display: flex; flex-direction: column; overflow: hidden; }
    .iv_header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; color: #eee; font: 500 14px/1.2 Rubik, system-ui, sans-serif; background: #111; border-bottom: 1px solid #222; }
    .iv_meta { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
    .iv_meta .iv_tag { background: #1a1a1a; border: 1px solid #2a2a2a; padding: 6px 10px; border-radius: 8px; color: #ddd; font-size: 12px; }
    .iv_title { color: #fafafa; font-size: 14px; font-weight: 600; margin-right: 8px; }
    .iv_close { cursor: pointer; border: none; background: #222; color: #ddd; padding: 6px 10px; border-radius: 8px; font-weight: 600; }
    .iv_close:hover { background: #2e2e2e; }
    .iv_toolbar { display: flex; gap: 8px; }
    .iv_btn { cursor: pointer; border: 1px solid #2a2a2a; background: #1a1a1a; color: #ddd; padding: 6px 10px; border-radius: 8px; font-weight: 600; }
    .iv_btn:hover { background: #232323; }
    .iv_viewport { position: relative; flex: 1; background: #0a0a0a; overflow: hidden; cursor: grab; }
    .iv_viewport.grabbing { cursor: grabbing; }
    .iv_canvas { position: absolute; left: 0; top: 0; will-change: transform; transform-origin: 0 0; }
    .iv_img { user-select: none; pointer-events: none; display: block; }
    .iv_progress { position: absolute; left: 0; right: 0; bottom: 0; height: 6px; background: rgba(255,255,255,0.06); }
    .iv_progress_bar { height: 100%; width: 0%; background: linear-gradient(90deg, #39f, #9cf); transition: width 90ms linear; }
    `;
    document.head.appendChild(style);
    viewerStylesInjected = true;
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

function openImageViewer({ fname, date }) {
    ensureViewerStyles();
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
    dateEl.textContent = `Date: ${date ? date.toLocaleString() : 'Unknown'}`;
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
    const btnFit = Object.assign(document.createElement('button'), { className: 'iv_btn', textContent: 'Fit' });
    const btn100 = Object.assign(document.createElement('button'), { className: 'iv_btn', textContent: '100%' });
    const btnMinus = Object.assign(document.createElement('button'), { className: 'iv_btn', textContent: '−' });
    const btnPlus = Object.assign(document.createElement('button'), { className: 'iv_btn', textContent: '+' });
    toolbar.append(btnFit, btn100, btnMinus, btnPlus);

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

    function applyTransform() {
        canvas.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
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

    // Wheel zoom
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

    // Toolbar
    btnFit.addEventListener('click', () => { scale = minScale; centerAtCurrentScale(); userInteracted = true; });
    btn100.addEventListener('click', () => { scale = Math.max(minScale, 1); centerAtCurrentScale(); userInteracted = true; });
    btnMinus.addEventListener('click', () => {
        const vw = viewport.getBoundingClientRect();
        zoomAt(vw.width / 2, vw.height / 2, 1 / 1.2); userInteracted = true;
    });
    btnPlus.addEventListener('click', () => {
        const vw = viewport.getBoundingClientRect();
        zoomAt(vw.width / 2, vw.height / 2, 1.2); userInteracted = true;
    });

    // Close handlers
    function close() { overlay.remove(); window.removeEventListener('keydown', onKey); }
    btnClose.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    function onKey(e) { if (e.key === 'Escape') close(); }
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
        img.src = fullUrl;
        progress.style.display = 'none';
    }
}

let artworksLoaded = false;
let artworksInitPromise = null; // single-flight fetch so we don't double-append
let renderedArtworkKeys = new Set(); // guard against dupes across calls
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

    artworksInitPromise = fetch("/home/src/art/artlist.txt")
        .then(response => response.json())
        .then(data => {
            if (!Array.isArray(data)) return; // defensive
            data.forEach(artwork => {
                // Build a stable dedup key; prefer unique filename, fallback to date+name
                const key = (artwork && artwork.fname) ? String(artwork.fname) : `${artwork?.date || ""}|${artwork?.title || ""}`;
                if (renderedArtworkKeys.has(key)) return; // skip duplicates

                renderedArtworkKeys.add(key);
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
                        openImageViewer({ fname: artwork.fname, date });
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
                    img.addEventListener('click', () => openImageViewer({ fname: artwork.fname, date }));
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

document.addEventListener("DOMContentLoaded", function () {

    const navbar = document.querySelector(".navbar");
    const items = document.querySelectorAll(".navbar_item");
    // Include hash so we can detect sections like #showcase on first load
    const getOnPage = () => window.location.pathname + window.location.hash;
    if (!navbar || items.length === 0) return;

    let activeIndex = 0;

    // Initial placement under the first item
    positionHighlightToItem(items[activeIndex]);

    items.forEach((item, index) => {
        item.addEventListener("mouseenter", () => {
            positionHighlightToItem(item);
        });
        item.addEventListener("click", () => {
            activeIndex = index;
            positionHighlightToItem(item);
            go_to_tab();
        });
    });

    // When leaving the navbar, snap back to the active item
    navbar.addEventListener("mouseleave", () => {
        positionHighlightToItem(items[activeIndex]);
    });

    // Recompute on resize to keep alignment correct
    window.addEventListener("resize", () => {
        positionHighlightToItem(items[activeIndex]);
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
                positionHighlightToItem(item);
            }
        });

        // Ensure the navbar banner plays (not paused): set src from data-gif
        const bannerImg = document.querySelector('img.banner');
        if (bannerImg) {
            const bannerGif = bannerImg.getAttribute('data-gif');
            if (bannerGif && !bannerImg.getAttribute('src')) {
                bannerImg.src = bannerGif;
            }
        }

    });
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
        showBlackout();
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
    // Visibility change (screen recording tools may trigger or not); best-effort deterrent
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            showBlackout();
        }
    });
    // Hide blackout on click (optional) so site is usable again
    document.addEventListener('click', () => hideBlackout(), { capture: true });
});

window.addEventListener("hashchange", () => {
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
        if (itemName == ON_PAGE) {
            activeIndex = index;
        }
    });

    positionHighlightToItem(items[activeIndex]);
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
    // if (ON_PAGE == "#processes") {
    //     show_processes();
    // } else {
    //     hide_processes();
    // }
}