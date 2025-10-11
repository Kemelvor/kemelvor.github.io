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

function generateArtworks() {
    const container = document.getElementById("artwork_container");
    if (!container) return;
    fetch("/home/src/art/artlist.txt").then(response => response.json()).then(data => {
        data.forEach(artwork => {
            const div = document.createElement("div");
            div.classList.add("artwork");
            const tsSec = parseFloat(artwork.date);
            const date = Number.isFinite(tsSec) ? new Date(tsSec * 1000) : new Date(artwork.date);
            const wrapper = document.createElement("div");
            wrapper.className = "artwork_image";

            const img = document.createElement("img");
            img.loading = "lazy";
            img.alt = artwork.fname;

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
                // Schedule upgrades
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
                    // Show loading state
                    overlay.classList.add('loading');
                    // Prioritize the clicked GIF
                    await PreloadManager.preload(url, 'high');
                    // Swap source and wait for load event before removing overlay
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
                        // Retry with cache-bust if first attempt fails or times out
                        const busted = url + (url.includes('?') ? '&' : '?') + 'cb=' + Date.now();
                        ok = await tryLoad(busted);
                    }
                    overlay.remove();
                };

                // Click to load+play (supports both overlay and image click)
                overlay.addEventListener('click', play);
                img.addEventListener('click', play);

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
            }

            const caption = document.createElement("p");
            caption.textContent = date.toLocaleString().split(",")[0];

            wrapper.appendChild(img);
            wrapper.appendChild(caption);
            div.appendChild(wrapper);
            container.appendChild(div);
        });
        // Recompute widths on resize
        window.addEventListener('resize', () => {
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
        });
    });
}

document.addEventListener("DOMContentLoaded", function () {
    const navbar = document.querySelector(".navbar");
    const items = document.querySelectorAll(".navbar_item");
    const ON_PAGE = window.location.pathname
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
        // On page load, check if any item matches the current URL path
        items.forEach((item, index) => {
            const itemPath = item.getAttribute("data-path");
            if (itemPath === ON_PAGE) {
                activeIndex = index;
                positionHighlightToItem(item);
            }
        });

        generateArtworks();

        // Ensure the navbar banner plays (not paused): set src from data-gif
        const bannerImg = document.querySelector('img.banner');
        if (bannerImg) {
            const bannerGif = bannerImg.getAttribute('data-gif');
            if (bannerGif && !bannerImg.getAttribute('src')) {
                bannerImg.src = bannerGif;
            }
        }

    });
});