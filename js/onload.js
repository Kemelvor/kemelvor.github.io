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

// Create a PNG data URL of the first frame of a GIF
function createGifFirstFrameDataUrl(gifUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        // Same-origin assets, but keep anonymous to allow canvas export
        img.crossOrigin = "anonymous";
        img.onload = () => {
            try {
                const canvas = document.createElement("canvas");
                canvas.width = img.naturalWidth || img.width;
                canvas.height = img.naturalHeight || img.height;
                const ctx = canvas.getContext("2d");
                ctx.drawImage(img, 0, 0);
                const dataUrl = canvas.toDataURL("image/png");
                resolve(dataUrl);
            } catch (e) {
                reject(e);
            }
        };
        img.onerror = reject;
        img.src = gifUrl;
    });
}

// Given an <img> and its gif url, set it to show a still image until hover
async function enableGifPlayOnHover(imgEl, gifUrl) {
    try {
        const stillUrl = await createGifFirstFrameDataUrl(gifUrl);
        // Start paused with still frame
        imgEl.src = stillUrl;
        imgEl.dataset.gifSrc = gifUrl;
        imgEl.dataset.stillSrc = stillUrl;

        // Play on hover, pause on leave
        imgEl.addEventListener("mouseenter", () => {
            imgEl.src = imgEl.dataset.gifSrc;
        });
        imgEl.addEventListener("mouseleave", () => {
            imgEl.src = imgEl.dataset.stillSrc;
        });

        // For touch, toggle play on tap
        imgEl.addEventListener("click", () => {
            const isPlaying = imgEl.src.endsWith(".gif") || imgEl.src.includes(".gif?");
            imgEl.src = isPlaying ? imgEl.dataset.stillSrc : imgEl.dataset.gifSrc;
        });
    } catch (e) {
        // If we fail to create a still, just leave the GIF as-is
        imgEl.src = gifUrl;
    }
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

            const url = `/home/src/art/${artwork.fname}`;
            const setWrapperWidthFromImage = () => {
                const h = wrapper.clientHeight || parseFloat(getComputedStyle(wrapper).height) || 220;
                const w = img.naturalWidth;
                const nH = img.naturalHeight || 1;
                const ratio = w / nH;
                const widthPx = Math.max(140, Math.round(h * ratio));
                wrapper.style.width = `${widthPx}px`;
            };

            if (artwork.fname.toLowerCase().endsWith(".gif")) {
                // Start paused; generate still and wire hover behavior
                enableGifPlayOnHover(img, url).finally(() => {
                    // After image has a still/gif set, wait for load to compute width
                    if (img.complete) {
                        setWrapperWidthFromImage();
                    } else {
                        img.addEventListener('load', setWrapperWidthFromImage, { once: true });
                    }
                });
            } else {
                img.addEventListener('load', setWrapperWidthFromImage, { once: true });
                img.src = url;
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

        // Only pause/hover-play GIFs within the artwork section
        const artworkContainer = document.getElementById('artwork_container');
        if (artworkContainer) {
            const gifImgs = Array.from(artworkContainer.querySelectorAll('img'))
                .filter(img => (img.getAttribute('src') || '').toLowerCase().endsWith('.gif'));
            gifImgs.forEach(img => {
                const gifUrl = img.getAttribute('src');
                if (!img.dataset || (!img.dataset.gifSrc && !img.dataset.stillSrc)) {
                    enableGifPlayOnHover(img, gifUrl);
                }
            });

            const dataGifImgs = Array.from(artworkContainer.querySelectorAll('img[data-gif]'));
            dataGifImgs.forEach(img => {
                const gifUrl = img.getAttribute('data-gif');
                if (gifUrl) {
                    enableGifPlayOnHover(img, gifUrl);
                }
            });
        }
    });
});