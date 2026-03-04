// ==UserScript==
// @name         YouTube Newest Comments
// @namespace    http://tampermonkey.net/
// @version      2
// @description  Adds a "Newest First" button to YouTube mobile comments
// @author       Robert-76468/ Altruistic_Day9101
// @match        https://m.youtube.com/*
// @match        https://www.youtube.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    let isRunning = false;
    let cachedPostSortMenu = null;

    // Intercept fetch on post pages to capture the sort menu token
    (function () {
        const origFetch = window.fetch;
        window.fetch = async function (...args) {
            const response = await origFetch.apply(this, args);
            // Bail immediately on non-post pages — no overhead on regular videos
            if (!window.location.pathname.includes('/post/')) return response;
            try {
                const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
                if (url.includes('youtubei/v1/browse') || url.includes('youtubei/v1/next')) {
                    response.clone().json().then(data => {
                        const menu = data ? findKey(data, 'sortFilterSubMenuRenderer') : null;
                        if (menu?.subMenuItems) cachedPostSortMenu = menu.subMenuItems;
                    }).catch(() => {});
                }
            } catch (_) {}
            return response;
        };
    })();

    // ── Utilities ─────────────────────────────────────────────────────────────────

    function el(tag, styles, text) {
        const e = document.createElement(tag);
        if (styles) e.style.cssText = styles;
        if (text !== undefined) e.textContent = text;
        return e;
    }

    function getVideoId() {
        const url = new URL(window.location.href);
        const v = url.searchParams.get('v');
        if (v) return v;
        const m = url.pathname.match(/\/shorts\/([^/?#]+)/);
        return m ? m[1] : null;
    }

    function getPostId() {
        const m = window.location.pathname.match(/\/post\/([^/?#]+)/);
        return m ? m[1] : null;
    }

    function findKey(obj, key) {
        if (!obj || typeof obj !== 'object') return undefined;
        if (key in obj) return obj[key];
        for (const v of Object.values(obj)) {
            const r = findKey(v, key);
            if (r !== undefined) return r;
        }
        return undefined;
    }

    function findAllKeys(obj, key, results = []) {
        if (!obj || typeof obj !== 'object') return results;
        if (key in obj) results.push(obj[key]);
        for (const v of Object.values(obj)) findAllKeys(v, key, results);
        return results;
    }

    // ── InnerTube API ─────────────────────────────────────────────────────────────

    async function innertubeCall(endpoint, body, clientName, clientVersion, clientHeaderNum, extra = {}) {
        const res = await fetch('https://www.youtube.com/youtubei/v1/' + endpoint + '?prettyPrint=false', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-YouTube-Client-Name': String(clientHeaderNum),
                'X-YouTube-Client-Version': clientVersion,
            },
            body: JSON.stringify({
                context: { client: { clientName, clientVersion, hl: 'en', gl: 'US', ...extra } },
                ...body,
            }),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
    }

    function innertubeTv(endpoint, body) {
        return innertubeCall(endpoint, body, 'TVHTML5', '7.20240101.00.00', 7, { utcOffsetMinutes: 0 });
    }

    function innertubeWeb(endpoint, body) {
        return innertubeCall(endpoint, body, 'WEB', '2.20240101.00.00', 1);
    }

    // ── Sort menu & token extraction ──────────────────────────────────────────────

    function extractSortMenu(data) {
        const menu = findKey(data, 'sortFilterSubMenuRenderer');
        return menu?.subMenuItems || null;
    }

    function extractNewestToken(sortMenuItems) {
        const item = sortMenuItems?.[1];
        if (!item) return null;
        return item?.continuation?.reloadContinuationData?.continuation
            || item?.serviceEndpoint?.continuationCommand?.token
            || item?.continuationEndpoint?.continuationCommand?.token
            || findKey(item, 'token')
            || null;
    }

    // ── Response analyser ─────────────────────────────────────────────────────────

    function analyseResponse(data) {
        const allArrays = [];
        let nextToken = null;

        const eps = data?.onResponseReceivedEndpoints;
        if (Array.isArray(eps)) {
            for (const ep of eps) {
                const action = ep?.appendContinuationItemsAction || ep?.reloadContinuationItemsCommand;
                if (Array.isArray(action?.continuationItems)) allArrays.push(action.continuationItems);
            }
        }

        const cc = data?.continuationContents;
        if (cc && typeof cc === 'object') {
            for (const section of Object.values(cc)) {
                if (!section || typeof section !== 'object') continue;
                if (Array.isArray(section.contents)) allArrays.push(section.contents);
                if (Array.isArray(section.items))    allArrays.push(section.items);

                if (Array.isArray(section.continuations)) {
                    for (const cont of section.continuations) {
                        if (!cont || typeof cont !== 'object') continue;
                        for (const v of Object.values(cont)) {
                            const t = v?.continuation;
                            if (typeof t === 'string' && t.length > 20) nextToken = t;
                        }
                    }
                }
            }
        }

        for (const arr of findAllKeys(data, 'continuationItems')) {
            if (!allArrays.includes(arr)) allArrays.push(arr);
        }

        for (const items of allArrays) {
            if (!Array.isArray(items)) continue;
            const threads = items
                .filter(i => {
                    if (!i?.commentThreadRenderer) return false;
                    const c = i.commentThreadRenderer?.comment?.commentRenderer
                        || i.commentThreadRenderer?.commentRenderer;
                    if (c?.pinnedCommentBadge) return false;
                    if (i.pinnedCommentThreadRenderer) return false;
                    return true;
                })
                .map(i => i.commentThreadRenderer);
            if (threads.length > 0) return { type: 'comments', threads, nextToken };
        }

        const seen = new Set();
        const tokens = [];

        if (cc && typeof cc === 'object') {
            for (const section of Object.values(cc)) {
                if (!Array.isArray(section?.continuations)) continue;
                for (const cont of section.continuations) {
                    if (!cont || typeof cont !== 'object') continue;
                    for (const v of Object.values(cont)) {
                        const t = v?.continuation;
                        if (typeof t === 'string' && t.length > 20 && !seen.has(t)) {
                            seen.add(t); tokens.push(t);
                        }
                    }
                }
            }
        }

        for (const arr of allArrays) {
            for (const t of findAllKeys(arr, 'token')) {
                if (t && !seen.has(t)) { seen.add(t); tokens.push(t); }
            }
        }
        for (const t of findAllKeys(data, 'token')) {
            if (t && !seen.has(t)) { seen.add(t); tokens.push(t); }
        }
        for (const v of findAllKeys(data, 'continuation')) {
            if (typeof v === 'string' && v.length > 20 && !seen.has(v)) {
                seen.add(v); tokens.push(v);
            }
        }

        if (tokens.length > 0) return { type: 'needMore', tokens };
        return { type: 'empty' };
    }

    // ── Comment parser ────────────────────────────────────────────────────────────

    function parseThreads(threads) {
        return threads.map(parseThread).filter(Boolean);
    }

    function parseThread(thread) {
        const c = thread?.comment?.commentRenderer
            || thread?.commentRenderer
            || findKey(thread, 'commentRenderer');
        if (!c) return null;

        const likes =
            c.voteCount?.simpleText ||
            c.voteCount?.runs?.[0]?.text ||
            c.likeCount?.simpleText ||
            (typeof c.likeCount === 'number' ? String(c.likeCount) : null) ||
            null;

        const repliesRenderer = thread?.replies?.commentRepliesRenderer;
        const replyCount =
            thread?.replyCount ??
            c?.replyCount ??
            repliesRenderer?.moreText?.runs?.map(r => r.text).join('') ??
            repliesRenderer?.viewReplies?.buttonRenderer?.text?.runs?.map(r => r.text).join('') ??
            c?.replyCountText?.runs?.map(r => r.text).join('') ??
            c?.replyCountText?.simpleText ??
            (c?.replies ? findKey(c.replies, 'replyCount') : null) ??
            null;

        const replyToken =
            findKey(repliesRenderer, 'continuation') ||
            findKey(repliesRenderer, 'token') ||
            findKey(c?.detailViewEndpoint, 'continuation') ||
            findKey(c?.detailViewEndpoint, 'token') ||
            null;

        return {
            text:      c.contentText?.runs?.map(r => r.text).join('') || '',
            author:    c.authorText?.runs?.[0]?.text || c.authorText?.simpleText || 'Unknown',
            time:      c.publishedTimeText?.runs?.[0]?.text || c.publishedTimeText?.simpleText || '',
            likes,
            thumb:     c.authorThumbnail?.thumbnails?.slice(-1)?.[0]?.url || '',
            replyCount,
            replyToken,
            commentId: c.commentId || null,
        };
    }

    // ── Core fetch logic ──────────────────────────────────────────────────────────

    async function fetchPage(token) {
        const data = await innertubeTv('next', { continuation: token });
        const result = analyseResponse(data);
        if (result.type === 'comments') {
            return { comments: parseThreads(result.threads), nextToken: result.nextToken };
        }
        return null;
    }

    async function fetchNewestComments(videoId) {
        for (const fn of [innertubeTv, innertubeWeb]) {
            try {
                const result = await tryClient(fn, videoId);
                if (result && result.comments.length > 0) return result;
            } catch (_) {}
        }
        return null;
    }

    async function tryClient(fn, videoId) {
        const resp = await fn('next', { videoId });
        const sortMenu = extractSortMenu(resp);
        if (!sortMenu) return null;

        const newestToken = extractNewestToken(sortMenu);
        if (!newestToken) return null;

        const visited = new Set();
        const queue = [newestToken];

        for (let depth = 0; queue.length > 0 && depth < 6; depth++) {
            const token = queue.shift();
            if (visited.has(token)) continue;
            visited.add(token);

            const data = await fn('next', { continuation: token });
            const result = analyseResponse(data);

            if (result.type === 'comments') {
                const comments = parseThreads(result.threads);
                if (comments.length > 0) return { comments, nextToken: result.nextToken };
                return null;
            }

            if (result.type === 'needMore') {
                for (const t of result.tokens) {
                    if (!visited.has(t)) queue.push(t);
                }
                queue.splice(8);
            }
        }

        return null;
    }

    // ── UI ────────────────────────────────────────────────────────────────────────

    function closeOverlay() {
        document.getElementById('ync-overlay')?.remove();
        isRunning = false;
        const btn = document.getElementById('ync-btn');
        if (btn) {
            btn.textContent = 'Newest first';
            btn.style.opacity = '1';
            btn.disabled = false;
        }
    }

    async function fetchReplies(replyToken, parentCommentId) {
        const data = await innertubeTv('next', { continuation: replyToken });
        const cc = data?.continuationContents;
        if (cc) {
            for (const section of Object.values(cc)) {
                if (Array.isArray(section?.contents)) {
                    return section.contents
                        .map(i => {
                            const c = i?.commentRenderer || findKey(i, 'commentRenderer');
                            if (!c) return null;
                            if (parentCommentId && c.commentId === parentCommentId) return null;
                            return {
                                text:   c.contentText?.runs?.map(r => r.text).join('') || '',
                                author: c.authorText?.runs?.[0]?.text || c.authorText?.simpleText || 'Unknown',
                                time:   c.publishedTimeText?.runs?.[0]?.text || c.publishedTimeText?.simpleText || '',
                                likes:  c.voteCount?.simpleText || null,
                                thumb:  c.authorThumbnail?.thumbnails?.slice(-1)?.[0]?.url || '',
                            };
                        })
                        .filter(Boolean);
                }
            }
        }
        return [];
    }

    function buildCommentRow(c, isReply = false) {
        const size = isReply ? '28' : '36';
        const row = el('div', 'display:flex; gap:12px; padding:' + (isReply ? '10px 16px 10px 52px' : '14px 16px') + '; border-bottom:1px solid #191919;' + (isReply ? ' background:#141414;' : ''));

        if (c.thumb) {
            const img = document.createElement('img');
            img.src = c.thumb;
            img.style.cssText = 'width:' + size + 'px; height:' + size + 'px; border-radius:50%; flex-shrink:0; object-fit:cover;';
            img.onerror = function () { this.style.display = 'none'; };
            row.appendChild(img);
        } else {
            row.appendChild(el('div', 'width:' + size + 'px; height:' + size + 'px; border-radius:50%; background:#2a2a2a; flex-shrink:0;'));
        }

        const body = el('div', 'flex:1; min-width:0;');

        const meta = el('div', 'display:flex; gap:8px; align-items:baseline; margin-bottom:5px; flex-wrap:wrap;');
        meta.appendChild(el('span', 'font-size:13px; font-weight:600; color:#3ea6ff;', c.author));
        if (c.time) meta.appendChild(el('span', 'font-size:12px; color:#666;', c.time));
        body.appendChild(meta);

        body.appendChild(el('p', 'margin:0; font-size:14px; line-height:1.55; white-space:pre-wrap; word-break:break-word; color:#e8e8e8;', c.text));

        const stats = el('div', 'margin-top:7px; font-size:12px; color:#666; display:flex; gap:16px; align-items:center;');
        stats.appendChild(el('span', '', '👍 ' + (c.likes || '0')));

        if (!isReply) {
            const replyCount = c.replyCount ?? 0;
            const replyLabel = typeof replyCount === 'string' ? replyCount : (replyCount + ' repl' + (replyCount === 1 ? 'y' : 'ies'));
            if (c.replyToken) {
                const replyBtn = el('button', 'background:none; border:none; color:#3ea6ff; font-size:12px; cursor:pointer; padding:0; -webkit-tap-highlight-color:transparent;', '💬 ' + replyLabel + ' ▾');
                let repliesLoaded = false;
                let repliesVisible = false;
                const repliesContainer = el('div', 'display:none;');
                replyBtn.addEventListener('click', async () => {
                    if (!repliesLoaded) {
                        replyBtn.textContent = '⏳ Loading replies...';
                        try {
                            const replies = await fetchReplies(c.replyToken, c.commentId);
                            repliesLoaded = true;
                            for (const r of replies) repliesContainer.appendChild(buildCommentRow(r, true));
                            if (replies.length === 0) {
                                repliesContainer.appendChild(el('div', 'padding:10px 16px 10px 52px; font-size:13px; color:#555;', 'No replies found.'));
                            }
                        } catch (_) {
                            replyBtn.textContent = '💬 ' + replyLabel + ' (error)';
                            return;
                        }
                    }
                    repliesVisible = !repliesVisible;
                    repliesContainer.style.display = repliesVisible ? 'block' : 'none';
                    replyBtn.textContent = '💬 ' + replyLabel + (repliesVisible ? ' ▴' : ' ▾');
                });
                stats.appendChild(replyBtn);
                row._repliesContainer = repliesContainer;
            } else {
                stats.appendChild(el('span', 'color:#555;', '💬 ' + replyLabel));
            }
        }

        body.appendChild(stats);
        row.appendChild(body);
        return row;
    }

    function attachAutoLoad(list, countEl, currentToken, appendFn) {
        let loading = false;
        let token = currentToken;
        let done = false;

        const sentinel = el('div', 'height:40px; flex-shrink:0;');
        list.appendChild(sentinel);

        const spinner = el('div', 'padding:12px; text-align:center; font-size:12px; color:#555; display:none;', 'Loading...');
        list.appendChild(spinner);

        async function loadNext() {
            if (loading || done || !token) return;
            loading = true;
            spinner.style.display = 'block';
            try {
                const result = await fetchPage(token);
                spinner.style.display = 'none';
                if (result && result.comments.length > 0) {
                    for (const c of result.comments) appendFn(c);
                    const newTotal = parseInt(countEl.dataset.count || '0') + result.comments.length;
                    countEl.dataset.count = newTotal;
                    countEl.textContent = 'Newest Comments (' + newTotal + ')';
                    token = result.nextToken || null;
                } else {
                    token = null;
                }
                if (!token) {
                    done = true;
                    sentinel.remove();
                    spinner.remove();
                    list.removeEventListener('scroll', onScroll);
                    list.appendChild(el('div', 'padding:20px; text-align:center; font-size:12px; color:#444;', '— end of comments —'));
                }
            } catch (_) {
                spinner.style.display = 'none';
                done = true;
                list.removeEventListener('scroll', onScroll);
            }
            loading = false;
        }

        function onScroll() {
            if (list.scrollHeight - list.scrollTop - list.clientHeight < 300) loadNext();
        }

        list.addEventListener('scroll', onScroll, { passive: true });

        try {
            const obs = new IntersectionObserver((entries) => {
                if (entries[0].isIntersecting) { loadNext(); obs.disconnect(); }
            }, { root: list, threshold: 0 });
            obs.observe(sentinel);
        } catch (_) {}
    }

    function renderComments(comments, nextToken) {
        document.getElementById('ync-overlay')?.remove();

        const isShorts = window.location.pathname.startsWith('/shorts/');
        const defaultHeight = isShorts ? 72 : 62;
        const overlay = el('div', `
            position:fixed; bottom:0; left:0; width:100%; height:${defaultHeight}%;
            background:#0f0f0f; color:#fff; z-index:2147483647;
            font-family:-apple-system,sans-serif; font-size:14px;
            display:flex; flex-direction:column; overflow:hidden;
            border-radius:14px 14px 0 0;
            box-shadow:0 -4px 24px rgba(0,0,0,0.6);
            transition:height 0.25s ease, border-radius 0.25s ease;
        `);
        overlay.id = 'ync-overlay';

        // ── Draggable header (full width = drag hitbox, like real comments) ───
        const hdr = el('div', `
            display:flex; flex-direction:column;
            border-bottom:1px solid #1e1e1e; flex-shrink:0;
            cursor:grab; touch-action:none;
        `);

        // Pip sits at top of header
        const pipRow = el('div', 'display:flex; justify-content:center; padding:14px 0 8px;');
        pipRow.appendChild(el('div', 'width:36px; height:4px; border-radius:2px; background:#444; pointer-events:none;'));
        hdr.appendChild(pipRow);

        // Title + close row
        const hdrRow = el('div', 'display:flex; justify-content:space-between; align-items:center; padding:0 16px 12px;');
        const countEl = el('span', 'font-size:15px; font-weight:600;', 'Newest Comments (' + comments.length + ')');
        countEl.dataset.count = comments.length;
        hdrRow.appendChild(countEl);
        const closeBtn = el('button', 'background:none; border:none; color:#888; font-size:22px; cursor:pointer; padding:0 4px; line-height:1; -webkit-tap-highlight-color:transparent; touch-action:manipulation;', '×');
        closeBtn.addEventListener('click', closeOverlay);
        hdrRow.appendChild(closeBtn);
        hdr.appendChild(hdrRow);
        overlay.appendChild(hdr);

        let dragStartY = 0;
        let dragStartHeight = 0;
        let isDragging = false;
        let isFullScreen = false;

        function onDragMove(e) {
            if (!isDragging) return;
            const deltaY = dragStartY - e.touches[0].clientY;
            const newHeight = Math.max(80, Math.min(window.innerHeight, dragStartHeight + deltaY));
            overlay.style.height = newHeight + 'px';
            overlay.style.borderRadius = newHeight > window.innerHeight * 0.9 ? '0' : '14px 14px 0 0';
            e.preventDefault();
        }

        function onDragEnd(e) {
            document.removeEventListener('touchmove', onDragMove);
            document.removeEventListener('touchend', onDragEnd);
            isDragging = false;
            overlay.style.transition = 'height 0.25s ease, border-radius 0.25s ease';

            const currentHeight = overlay.offsetHeight;
            const screenHeight = window.innerHeight;
            const deltaY = dragStartY - e.changedTouches[0].clientY;

            if (isFullScreen) {
                // Starting from full screen:
                // drag down past 60% of screen → snap to default half
                // drag down past 85% of screen → close
                if (currentHeight < screenHeight * 0.25) {
                    overlay.style.height = '0';
                    setTimeout(closeOverlay, 250);
                } else if (currentHeight < screenHeight * 0.95) {
                    overlay.style.height = defaultHeight + '%';
                    overlay.style.borderRadius = '14px 14px 0 0';
                    isFullScreen = false;
                } else {
                    // Snap back to full screen
                    overlay.style.height = screenHeight + 'px';
                    overlay.style.borderRadius = '0';
                }
            } else {
                // Starting from default half:
                // drag up past 120px or 88% → full screen
                // drag down past 80px or 28% → close
                // otherwise snap back to default
                if (deltaY > 120 || currentHeight > screenHeight * 0.88) {
                    overlay.style.height = screenHeight + 'px';
                    overlay.style.borderRadius = '0';
                    isFullScreen = true;
                } else if (deltaY < -120 || currentHeight < screenHeight * 0.22) {
                    overlay.style.height = '0';
                    setTimeout(closeOverlay, 250);
                } else {
                    overlay.style.height = defaultHeight + '%';
                    overlay.style.borderRadius = '14px 14px 0 0';
                }
            }
        }

        hdr.addEventListener('touchstart', function(e) {
            // Don't start drag if tapping the close button
            if (e.target === closeBtn || closeBtn.contains(e.target)) return;
            isDragging = true;
            dragStartY = e.touches[0].clientY;
            dragStartHeight = overlay.offsetHeight;
            overlay.style.transition = 'none';
            document.addEventListener('touchmove', onDragMove, { passive: false });
            document.addEventListener('touchend', onDragEnd);
        }, { passive: true });

        const list = el('div', 'overflow-y:auto; flex:1; -webkit-overflow-scrolling:touch;');

        function appendCommentToList(c) {
            const row = buildCommentRow(c);
            list.appendChild(row);
            if (row._repliesContainer) list.appendChild(row._repliesContainer);
        }

        for (const c of comments) appendCommentToList(c);

        if (!nextToken) {
            list.appendChild(el('div', 'padding:20px; text-align:center; font-size:12px; color:#444;', '— end of comments —'));
        }

        overlay.appendChild(list);
        document.documentElement.appendChild(overlay);

        if (nextToken) attachAutoLoad(list, countEl, nextToken, appendCommentToList);
    }

    function showError(msg) {
        document.getElementById('ync-overlay')?.remove();
        const overlay = el('div', `
            position:fixed; top:0; left:0; width:100%; height:100%;
            background:#0f0f0f; color:#fff; z-index:2147483647;
            font-family:-apple-system,sans-serif;
            display:flex; flex-direction:column; align-items:center;
            justify-content:center; gap:16px; padding:40px; text-align:center;
        `);
        overlay.id = 'ync-overlay';
        overlay.appendChild(el('div', 'font-size:36px;', '⚠️'));
        overlay.appendChild(el('div', 'font-size:15px; color:#bbb; line-height:1.6; max-width:320px;', msg));
        const closeBtn = el('button', 'background:#2a2a2a; border:1px solid #444; color:#fff; padding:10px 24px; border-radius:8px; font-size:15px; cursor:pointer;', 'Close');
        closeBtn.addEventListener('click', closeOverlay);
        overlay.appendChild(closeBtn);
        document.documentElement.appendChild(overlay);
    }

    // ── Main ──────────────────────────────────────────────────────────────────────

    async function run() {
        if (isPollPage()) return;

        const videoId = getVideoId();
        if (videoId) {
            const result = await fetchNewestComments(videoId);
            if (result && result.comments.length > 0) {
                renderComments(result.comments, result.nextToken);
            } else {
                showError('Could not load newest comments.\n\nYouTube may have updated their API.');
            }
            return;
        }

        const postId = getPostId();
        if (postId) {
            for (const fn of [innertubeWeb, innertubeTv]) {
                try {
                    const d1 = await fn('next', { continuation: postId });
                    const sm = extractSortMenu(d1);
                    if (sm) {
                        const nt = extractNewestToken(sm);
                        if (nt) {
                            const d2 = await fn('next', { continuation: nt });
                            const r2 = analyseResponse(d2);
                            if (r2.type === 'comments') {
                                const comments = parseThreads(r2.threads);
                                if (comments.length > 0) { renderComments(comments, r2.nextToken); return; }
                            }
                        }
                    }
                    const r1 = analyseResponse(d1);
                    if (r1.type === 'comments') {
                        const comments = parseThreads(r1.threads);
                        if (comments.length > 0) { renderComments(comments, r1.nextToken); return; }
                    }
                    if (r1.type === 'needMore') {
                        for (const t of r1.tokens.slice(0, 3)) {
                            const d2 = await fn('next', { continuation: t });
                            const sm2 = extractSortMenu(d2);
                            if (sm2) {
                                const nt2 = extractNewestToken(sm2);
                                if (nt2) {
                                    const d3 = await fn('next', { continuation: nt2 });
                                    const r3 = analyseResponse(d3);
                                    if (r3.type === 'comments') {
                                        const comments = parseThreads(r3.threads);
                                        if (comments.length > 0) { renderComments(comments, r3.nextToken); return; }
                                    }
                                }
                            }
                            const r2 = analyseResponse(d2);
                            if (r2.type === 'comments') {
                                const comments = parseThreads(r2.threads);
                                if (comments.length > 0) { renderComments(comments, r2.nextToken); return; }
                            }
                        }
                    }
                } catch (_) {}
            }
            showError('Could not load comments for this post.');
            return;
        }

        showError('No video or post ID found.\nNavigate to a YouTube video, short, or post first.');
    }

    function onButtonPress() {
        if (isRunning) return;
        isRunning = true;
        const btn = document.getElementById('ync-btn');
        if (btn) { btn.textContent = 'Loading...'; btn.style.opacity = '0.5'; btn.disabled = true; }
        run()
            .catch(() => showError('Unexpected error.'))
            .finally(() => {
                isRunning = false;
                const b = document.getElementById('ync-btn');
                if (b) { b.textContent = 'Newest first'; b.style.opacity = '1'; b.disabled = false; }
            });
    }

    // ── Init ──────────────────────────────────────────────────────────────────────

    const mainBtn = el('button', `
        position:fixed; top:0; left:50%; transform:translateX(-50%);
        z-index:2147483645;
        background:rgba(255,255,255,0.1); color:#fff; border:none;
        border-radius:18px; padding:0 14px; height:36px; font-size:13px;
        font-weight:500; font-family:-apple-system,sans-serif; cursor:pointer;
        display:none; align-items:center;
        -webkit-appearance:none; appearance:none;
        -webkit-tap-highlight-color:transparent; touch-action:manipulation;
    `, 'Newest first');
    mainBtn.id = 'ync-btn';
    mainBtn.addEventListener('click', onButtonPress);
    document.documentElement.appendChild(mainBtn);

    function isPollPage() {
        if (!window.location.pathname.startsWith('/post/')) return false;
        return !!document.querySelector('yt-poll-renderer');
    }

    function isCommentablePage() {
        const path = window.location.pathname;
        return path.startsWith('/watch') ||
               path.startsWith('/shorts/') ||
               path.startsWith('/post/');
    }

    function updateBtn() {
        const header = document.querySelector('ytm-comments-header-renderer');
        if (!header || !isCommentablePage() || isPollPage()) { mainBtn.style.display = 'none'; return; }
        const rect = header.getBoundingClientRect();
        if (rect.bottom <= 0 || rect.top >= window.innerHeight) { mainBtn.style.display = 'none'; return; }
        mainBtn.style.top = (rect.top - rect.height / 3 - 4) + 'px';
        mainBtn.style.transform = 'translate(-50%, -50%)';
        mainBtn.style.display = 'inline-flex';
    }

    let rafId = null;
    function startRaf() {
        if (rafId) return;
        function loop() { updateBtn(); rafId = requestAnimationFrame(loop); }
        rafId = requestAnimationFrame(loop);
    }
    function stopRaf() {
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        updateBtn();
    }

    document.addEventListener('touchstart', startRaf, { passive: true });
    document.addEventListener('touchend', stopRaf, { passive: true });
    document.addEventListener('touchcancel', stopRaf, { passive: true });

    // MutationObserver replaces setInterval — updateBtn only fires when the DOM
    // actually changes, instead of running 5x per second on every page forever.
    const btnObserver = new MutationObserver(updateBtn);
    btnObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style'],
    });
    updateBtn();

    window.addEventListener('yt-navigate-finish', () => {
        isRunning = false;
        if (!window.location.pathname.includes('/post/')) cachedPostSortMenu = null;
    });

})();
