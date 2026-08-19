/**
 * Holding the reader's place while the chat mutates underneath them.
 *
 * Observed failure: a reader scrolled up into history, reading. An older page
 * lands, or a poll resolves, or an image preview finishes decoding somewhere
 * above them, and the sentence they were on slides away. The browser is doing
 * exactly what it is supposed to (keep scrollTop), which is why every one of
 * those is a jump: the content ABOVE the viewport got taller or shorter.
 *
 * The fake DOM below is deliberately dumb: rows are boxes with a height, the box
 * has a scrollTop, and a row's client rect is derived from the two. That is the
 * whole of the geometry the anchor uses, so it is enough to reproduce every case
 * (a prepend, an in-place growth, an image expanding, a row relocating) without
 * a browser.
 *
 * Run: node ./tests/scroll-anchor.cjs
 */

const assert = require('assert');
const { createScrollAnchor } = require('../dist/engine.cjs');

/* ---- a scroll container that behaves like the real one ------------------- */

function row(key, height, pos) {
    return {
        _key: key === null ? null : String(key),
        _pos: pos === undefined ? null : pos,
        _h: height,
        _box: null,
        get offsetHeight() { return this._h; },
        getAttribute(name) {
            if (name === 'data-row-key') return this._key;
            if (name === 'data-row-pos') return this._pos;
            return null;
        },
        get parentNode() { return this._box; },
        getBoundingClientRect() {
            const box = this._box;
            // Rows stack from the top of the content; the box's own top edge is
            // an arbitrary constant (BOX_TOP) so the code cannot get away with
            // treating viewport and content coordinates as the same thing.
            let y = box._top - box.scrollTop;
            for (const kid of box.children) {
                if (kid === this) break;
                y += kid._h;
            }
            return { top: y };
        },
    };
}

const BOX_TOP = 100;   // where the message box sits on the page
function makeBox(rows, clientHeight) {
    const box = {
        _top: BOX_TOP,
        children: [],
        clientHeight: clientHeight,
        _top_: 0,
        get scrollHeight() { return this.children.reduce((n, r) => n + r._h, 0); },
        get maxScrollTop() { return Math.max(0, this.scrollHeight - this.clientHeight); },
        // CLAMPED, like a real scroller. This is the single most important physical
        // fact in this bug and the harness used to hide it: a write past the end is
        // silently truncated, and a shrink BELOW the reader eats a correction that
        // the code has no way to notice unless it re-reads the value it just wrote.
        _writes: 0,
        get scrollTop() { return this._top_; },
        set scrollTop(v) {
            this._writes++;
            this._top_ = Math.min(Math.max(0, v), this.maxScrollTop);
        },
        getBoundingClientRect() { return { top: this._top }; },
        set(rows) {
            // Detached rows must stop claiming this box as their parent, exactly
            // as a real removal nulls parentNode. The anchor caches the element it
            // pinned and re-checks that it is still in the box before trusting it,
            // so a fake that keeps the link would let a stale node answer.
            for (const r of this.children) if (rows.indexOf(r) === -1) r._box = null;
            this.children = rows;
            for (const r of rows) r._box = this;
            // A shrink re-clamps whatever the box was already at. Not a write by
            // anyone: assign the backing field so _writes stays a count of
            // deliberate scrollTop sets.
            this._top_ = Math.min(Math.max(0, this._top_), this.maxScrollTop);
        },
    };
    box.set(rows);
    return box;
}

const results = [];
function test(name, fn) {
    try { fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err && err.message]); }
}

// The reader's viewport, expressed the way a reader experiences it: which row is
// under the top edge of the box, and how far into it they are.
function topRowKeyAndOffset(box) {
    for (const r of box.children) {
        const top = r.getBoundingClientRect().top - box._top;
        if (top + r._h > 0) return { key: r._key, top: top };
    }
    return null;
}

// A screenful of collapsed indexing rows over some scrollback: the only shape in
// which capture() legitimately falls back to a group row. A single trailing group
// row cannot be the topmost visible one (there is nothing below it to scroll
// against), which is why the fixtures below pad above and fill the viewport.
function groupScreen(count, pos) {
    const rows = [row('pad', 600)];
    const groups = [];
    for (let i = 0; i < count; i++) {
        const g = row('g' + i, 30, pos === undefined ? 'turn-' + i : pos);
        groups.push(g);
        rows.push(g);
    }
    return { rows, groups };
}

/* ---- the cases -----------------------------------------------------------*/

test('an older page prepended above the reader does not move the reader', () => {
    const box = makeBox([row('a', 200), row('b', 200), row('c', 200)], 300);
    let stuck = false;
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => stuck });
    box.scrollTop = 250;                       // reading 50px into row b
    const before = topRowKeyAndOffset(box);
    assert.strictEqual(before.key, 'b');

    anchor.preserve(() => box.set([row('old1', 400), row('old2', 400), ...box.children]));

    const after = topRowKeyAndOffset(box);
    assert.strictEqual(after.key, 'b');
    assert.strictEqual(after.top, before.top);
    assert.strictEqual(box.scrollTop, 250 + 800);
});

test('a ROW growing above the reader is absorbed by hold()', () => {
    const img = row('img', 0);                 // src-less preview: display:none
    const box = makeBox([row('a', 200), img, row('b', 200), row('c', 200)], 300);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    box.scrollTop = 250;
    anchor.remember();                         // what the scroll handler does
    const before = topRowKeyAndOffset(box);
    assert.strictEqual(before.key, 'b');

    img._h = 320;                              // the picture paints
    anchor.hold();                             // what the load event does

    const after = topRowKeyAndOffset(box);
    assert.strictEqual(after.key, 'b');
    assert.strictEqual(after.top, before.top);
    assert.strictEqual(box.scrollTop, 570);
});

test('a ROW shrinking above the reader is absorbed too', () => {
    const img = row('img', 320);
    const box = makeBox([row('a', 200), img, row('b', 200), row('c', 200)], 300);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    box.scrollTop = 570;
    anchor.remember();
    const before = topRowKeyAndOffset(box);

    img._h = 0;                                // the src is dropped for a retry
    anchor.hold();

    const after = topRowKeyAndOffset(box);
    assert.strictEqual(after.key, before.key);
    assert.strictEqual(after.top, before.top);
    assert.strictEqual(box.scrollTop, 250);
});

test('several rows settling one after another each start from a valid anchor', () => {
    const i1 = row('i1', 0), i2 = row('i2', 0);
    const box = makeBox([i1, i2, row('b', 200), row('c', 200)], 300);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    box.scrollTop = 50;
    anchor.remember();
    const before = topRowKeyAndOffset(box);
    assert.strictEqual(before.key, 'b');

    i1._h = 300; anchor.hold();
    i2._h = 150; anchor.hold();

    const after = topRowKeyAndOffset(box);
    assert.strictEqual(after.key, 'b');
    assert.strictEqual(after.top, before.top);
    assert.strictEqual(box.scrollTop, 500);
});

test('a bracketed restore re-arms hold(), so a later image still compensates', () => {
    // The widget's real sequence: renderMessages tears the list down and rebuilds
    // it with src-less (zero-height) previews, restores the anchor against THAT
    // layout, and only then hydrates. Without restore() re-stamping the
    // remembered anchor, every image that decodes afterwards would find a stale
    // scrollTop and be skipped.
    const box = makeBox([row('a', 200), row('img', 320), row('b', 200), row('c', 200)], 300);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false, rawFallback: true });
    box.scrollTop = 570;
    anchor.remember();
    const before = topRowKeyAndOffset(box);
    assert.strictEqual(before.key, 'b');

    const rebuilt = [row('a', 200), row('img', 0), row('b', 200), row('c', 200)];
    anchor.preserve(() => { box.scrollTop = 0; box.set(rebuilt); });   // teardown clamps to 0
    assert.strictEqual(topRowKeyAndOffset(box).key, 'b');

    rebuilt[1]._h = 320;                       // the warm-cache image decodes
    anchor.hold();

    const after = topRowKeyAndOffset(box);
    assert.strictEqual(after.key, 'b');
    assert.strictEqual(after.top, before.top);
    assert.strictEqual(box.scrollTop, 570);
});

test('hold() does not drag the reader back after they scroll themselves', () => {
    const img = row('img', 0);
    const box = makeBox([row('a', 200), img, row('b', 200), row('c', 200)], 300);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    box.scrollTop = 250;
    anchor.remember();

    box.scrollTop = 40;                        // the reader scrolls up; no remember() yet
    img._h = 320;
    anchor.hold();                             // must re-measure, not restore

    assert.strictEqual(box.scrollTop, 40);
});

test('nothing happens while the reader is pinned to the bottom', () => {
    const img = row('img', 0);
    const box = makeBox([row('a', 200), img, row('b', 200)], 300);
    let stuck = true;
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => stuck });
    box.scrollTop = 100;
    anchor.remember();
    assert.strictEqual(anchor.capture(), null);
    img._h = 320;
    anchor.hold();
    assert.strictEqual(box.scrollTop, 100);    // scrollToBottom* owns this case
});

test('the "Fetching history..." bar taking height at the top is absorbed', () => {
    // Sticky, therefore still in flow, therefore it really does add height above
    // every row. It carries no data-row-key, so it is never anchored ON.
    const bar = row(null, 40);
    const box = makeBox([row('a', 200), row('b', 200), row('c', 200)], 300);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    box.scrollTop = 250;
    anchor.remember();
    const before = topRowKeyAndOffset(box);

    anchor.preserve(() => box.set([bar, ...box.children]));

    const after = topRowKeyAndOffset(box);
    assert.strictEqual(after.key, before.key);
    assert.strictEqual(after.top, before.top);
    assert.strictEqual(box.scrollTop, 290);
});

test('a collapsed indexing row that RELOCATED is not pinned', () => {
    // data-row-pos names the turn the row currently renders at. When an older page
    // moves the run's start, the row itself moves; pinning it would drag the reader
    // to wherever the run now begins.
    const { rows, groups } = groupScreen(10);
    const box = makeBox(rows, 300);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    box.scrollTop = 600;                       // the whole viewport is group rows
    const a = anchor.capture();
    assert.strictEqual(a.key, 'g0');
    assert.strictEqual(a.pos, 'turn-0');

    groups[0]._pos = 'turn-99';                // re-anchored to the run's first pass
    box.set([row('older', 500), ...rows]);
    anchor.restore(a);

    // Not dragged along to wherever the run now starts. The row cannot be held,
    // but the page that moved it is 500px of new content ABOVE the reader, and
    // paying that keeps them on the same content they were looking at.
    assert.strictEqual(box.scrollTop, 1100);
});

test('the anchor is the topmost VISIBLE row, not the first ordinary row anywhere', () => {
    // A screenful of collapsed indexing rows with the conversation below it: the
    // preference for an ordinary row must not walk past the viewport to find one.
    const rows = [];
    for (let i = 0; i < 12; i++) rows.push(row('g' + i, 30, 'turn-' + i));
    rows.push(row('msg', 400));
    const box = makeBox(rows, 300);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    box.scrollTop = 0;
    const a = anchor.capture();
    assert.strictEqual(a.key, 'g0');
    assert.strictEqual(a.pos, 'turn-0');
});

test('an EMPTY data-row-pos is "cannot tell", not a relocation', () => {
    // A run:: stub has no anchorId until its real group loads, so it renders
    // data-row-pos="". Reading that as a position made every stub -> real-group
    // handoff look like the row had moved, and aborted the anchor — on a fresh open
    // that is a background resolution the reader hits every time.
    const { rows, groups } = groupScreen(10, '');
    const box = makeBox(rows, 300);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    box.scrollTop = 600;
    const a = anchor.capture();
    assert.strictEqual(a.key, 'g0');

    groups[0]._pos = 'turn-2';     // the real group arrives and names its turn
    anchor.restore(a);
    assert.strictEqual(box.scrollTop, 600);  // held, not abandoned
});

test('a row that had a position and now reports none is not treated as moved either', () => {
    const { rows, groups } = groupScreen(10);
    const box = makeBox(rows, 300);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    box.scrollTop = 600;
    const a = anchor.capture();
    groups[0]._pos = '';
    anchor.restore(a);
    assert.strictEqual(box.scrollTop, 600);
});

test('an ordinary row inside the viewport still wins over a group row above it', () => {
    const box = makeBox([row('g', 30, 'turn-9'), row('b', 200), row('c', 200)], 300);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    box.scrollTop = 0;
    assert.strictEqual(anchor.capture().key, 'b');
});

test('a row that RELOCATED across the conversation is not followed', () => {
    // A background refetch merges a run's passes into the middle of page 1, which
    // moves the anchored bubble thousands of pixels with almost no new content.
    // Following it would carry the reader clean across the chat.
    const moved = row('m', 100);
    const box = makeBox([row('a', 300), moved, row('c', 300)], 300);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    box.scrollTop = 300;
    const a = anchor.capture();
    assert.strictEqual(a.key, 'm');

    // Same total height give or take, but the row is now 5000px down.
    box.set([row('a', 300), row('filler', 5000), moved, row('c', 300)]);
    anchor.restore(a);

    // 5000 of growth is paid as a prepend (that is what it looks like from here),
    // never the row's own 5000px relocation on top of it.
    assert.strictEqual(box.scrollTop, 300 + 5000);
});

test('rows entirely above the fold are skipped', () => {
    // Four rows, not three: with three the box maxes out at 300 and scrollTop 400
    // is not a position this scroller can be in.
    const box = makeBox([row('a', 200), row('b', 200), row('c', 200), row('d', 200)], 300);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    box.scrollTop = 400;
    const a = anchor.capture();
    assert.strictEqual(a.key, 'c');
    assert.strictEqual(a.top, 0);
});

test('a vanished anchor row still gets the prepend paid for it', () => {
    // The pager's own page can carry the pass that re-identifies a collapsed row,
    // so the row the reader was held by is not there afterwards. Missing this
    // costs them a whole page of history in one jump.
    const box = makeBox([row('a', 200), row('b', 200), row('c', 200)], 300);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    box.scrollTop = 250;
    const a = anchor.capture();
    box.set([row('older', 700), row('x', 200), row('y', 200), row('z', 200)]);
    anchor.restore(a);
    assert.strictEqual(box.scrollTop, 950);
});

test('rawFallback restores the raw offset when nothing was gained', () => {
    const box = makeBox([row('a', 200), row('b', 200), row('c', 200)], 300);
    const withFallback = createScrollAnchor({ getBox: () => box, isStuck: () => false, rawFallback: true });
    box.scrollTop = 250;
    const a = withFallback.capture();
    box.scrollTop = 0;                                    // a teardown clamps to 0
    box.set([row('x', 200), row('y', 200), row('z', 200)]);
    withFallback.restore(a);
    assert.strictEqual(box.scrollTop, 250);
});

test('without rawFallback, and nothing gained, a missing anchor row is left alone', () => {
    const box = makeBox([row('a', 200), row('b', 200), row('c', 200)], 300);
    const plain = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    box.scrollTop = 250;
    const a = plain.capture();
    box.set([row('x', 200), row('y', 200), row('z', 200)]);
    plain.restore(a);
    // Vue patches in place, so the browser already kept a sane position and
    // re-imposing a stale offset would be worse than nothing.
    assert.strictEqual(box.scrollTop, 250);
});

test('forget() drops the reader place so the next chat starts clean', () => {
    const img = row('img', 0);
    const box = makeBox([row('a', 200), img, row('b', 200), row('c', 200)], 300);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    box.scrollTop = 250;
    anchor.remember();
    anchor.forget();
    img._h = 320;
    anchor.hold();                             // re-measures rather than restoring
    assert.strictEqual(box.scrollTop, 250);
});

test('a growing bubble ABOVE the reader is absorbed; one below is not touched', () => {
    const above = row('a', 100), below = row('c', 100);
    // A trailing row so scrollTop 150 (and 310 after the growth) are reachable.
    const box = makeBox([above, row('b', 200), below, row('tail', 600)], 300);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    box.scrollTop = 150;
    anchor.remember();
    const before = topRowKeyAndOffset(box);

    above._h = 260;                            // a compact bubble hydrates
    anchor.hold();
    assert.strictEqual(box.scrollTop, 310);
    assert.deepStrictEqual(topRowKeyAndOffset(box), before);

    below._h = 900;                            // growth below costs nothing
    anchor.hold();
    assert.strictEqual(box.scrollTop, 310);
});

/* ---- absorb(): one element's own resize, including inside the anchored row --*/

// An <img> living inside a row. Its rect is the row's top plus whatever sits
// above it in that row, and the row's height grows with it.
function imgIn(box, rowEl, offsetInRow) {
    return {
        _h: 0,
        get offsetHeight() { return this._h; },
        getBoundingClientRect() {
            return { top: rowEl.getBoundingClientRect().top + offsetInRow };
        },
        grow(h) { rowEl._h += h - this._h; this._h = h; },
    };
}

test('an image INSIDE the anchored row, above the fold, is absorbed', () => {
    // The case the row anchor structurally cannot see: the reader is partway
    // through a reply taller than the viewport, so that reply IS the anchor row,
    // and a picture higher up inside it moves every line they are reading without
    // moving the row's own top by a pixel.
    const tall = row('tall', 900);
    const box = makeBox([tall, row('after', 200)], 300);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    const img = imgIn(box, tall, 100);
    anchor.absorb(img);                        // first sight: record 0, change nothing
    box.scrollTop = 600;                       // reading 600px into the reply
    anchor.remember();
    assert.strictEqual(anchor.capture().key, 'tall');

    img.grow(320);
    anchor.hold();
    assert.strictEqual(box.scrollTop, 600);    // the row's top never moved: hold() is blind here
    anchor.absorb(img);
    assert.strictEqual(box.scrollTop, 920);    // absorb sees the element itself
});

test('an image BELOW the fold is left alone', () => {
    const tall = row('tall', 900);
    const box = makeBox([tall, row('after', 200)], 300);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    const img = imgIn(box, tall, 700);
    anchor.absorb(img);
    box.scrollTop = 100;                       // the image is well below the reader
    anchor.remember();

    img.grow(320);
    anchor.absorb(img);
    assert.strictEqual(box.scrollTop, 100);
});

test('an image whose TOP is above the fold is absorbed even if it now straddles', () => {
    // A resize never moves the element's own top, so what decides is whether that
    // top is above the fold: everything below it (all of the reader's screen)
    // slid by exactly delta, however tall the element ended up.
    const tall = row('tall', 900);
    const box = makeBox([tall, row('after', 200)], 300);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    const img = imgIn(box, tall, 100);
    anchor.absorb(img);
    box.scrollTop = 200;                       // the image starts above the fold
    anchor.remember();

    img.grow(320);
    anchor.absorb(img);
    assert.strictEqual(box.scrollTop, 520);
});

test('an image starting exactly at the fold is left alone', () => {
    // It grows on screen, under a line the reader is looking at. Moving them is
    // what would be the jump.
    const tall = row('tall', 900);
    const box = makeBox([tall, row('after', 200)], 300);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    const img = imgIn(box, tall, 100);
    anchor.absorb(img);
    box.scrollTop = 100;                       // image top lands exactly on boxTop
    anchor.remember();

    img.grow(320);
    anchor.absorb(img);
    assert.strictEqual(box.scrollTop, 100);
});

test('an image never seen before counts as zero (markdown images have no hook)', () => {
    const tall = row('tall', 900);
    const box = makeBox([tall, row('after', 200)], 300);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    const img = imgIn(box, tall, 100);
    box.scrollTop = 600;
    anchor.remember();

    img.grow(260);
    anchor.absorb(img);                        // straight from the load event
    assert.strictEqual(box.scrollTop, 860);
});

test('a collapsing image (src dropped for a retry) is absorbed the other way', () => {
    const tall = row('tall', 900);
    const box = makeBox([tall, row('after', 200)], 300);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    const img = imgIn(box, tall, 100);
    img.grow(320);
    anchor.absorb(img);
    box.scrollTop = 700;
    anchor.remember();

    img.grow(0);
    anchor.absorb(img);
    assert.strictEqual(box.scrollTop, 380);
});

test('absorb keeps the remembered anchor usable afterwards', () => {
    // absorb WRITES scrollTop, which hold() would otherwise read as "the reader
    // scrolled" and answer by throwing the anchor away.
    const imgRow = row('imgrow', 0);
    const box = makeBox([imgRow, row('b', 200), row('c', 200)], 300);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    const img = imgIn(box, imgRow, 0);
    anchor.absorb(img);
    box.scrollTop = 50;
    anchor.remember();
    const before = topRowKeyAndOffset(box);

    img.grow(300);
    anchor.absorb(img);
    assert.strictEqual(box.scrollTop, 350);

    // Something non-image now changes above, on the anchor that absorb just
    // re-stamped: a stale scrollTop here would make hold() discard it instead.
    const laterImg = imgIn(box, imgRow, 0);
    laterImg._h = 0;
    imgRow._h += 120; anchor.hold();           // the row itself grows
    const after = topRowKeyAndOffset(box);
    assert.strictEqual(after.key, before.key);
    assert.strictEqual(after.top, before.top);
    assert.strictEqual(box.scrollTop, 470);
});

test('a later hold() does not undo an absorb inside the anchored row', () => {
    // The anchored row's own top never moves when something inside it resizes, so
    // an anchor left holding its pre-absorb offset would faithfully scroll the
    // correction back off again on the next settle.
    const tall = row('tall', 900);
    const box = makeBox([tall, row('after', 200)], 300);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    const img = imgIn(box, tall, 100);
    anchor.absorb(img);
    box.scrollTop = 600;
    anchor.remember();

    img.grow(320);
    anchor.absorb(img);
    assert.strictEqual(box.scrollTop, 920);

    anchor.hold();
    anchor.hold();
    assert.strictEqual(box.scrollTop, 920);
});

test('absorb does nothing while the reader is pinned to the bottom', () => {
    const tall = row('tall', 900);
    const box = makeBox([tall], 300);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => true });
    const img = imgIn(box, tall, 100);
    anchor.absorb(img);
    box.scrollTop = 600;
    img.grow(320);
    anchor.absorb(img);
    assert.strictEqual(box.scrollTop, 600);
});

test('a no-op update does not write scrollTop (sub-pixel noise is not a jump)', () => {
    const box = makeBox([row('a', 200), row('b', 200), row('c', 200)], 300);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    box.scrollTop = 250;
    anchor.remember();
    let writes = 0;
    let raw = box.scrollTop;
    Object.defineProperty(box, 'scrollTop', {
        get() { return raw; },
        set(v) { writes++; raw = v; },
    });
    anchor.hold();
    anchor.hold();
    assert.strictEqual(writes, 0);
    assert.strictEqual(box.scrollTop, 250);
});

/* ---- standby anchors: the reader's own row did not survive ---------------*/

test('a standby row holds the reader when the anchored row is dropped', () => {
    // A refresh can drop the exact row the reader was on. lost() would guess from
    // the list's TOTAL growth, which includes everything added BELOW them.
    const box = makeBox([row('a', 200), row('b', 200), row('c', 200), row('d', 200)], 300);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    box.scrollTop = 250;
    const a = anchor.capture();
    assert.strictEqual(a.key, 'b');
    assert.ok(a.alts && a.alts.length, 'standbys are collected in the same walk');

    // 'b' is gone, 400px arrives ABOVE the reader and 600px BELOW them. lost() would
    // pay the list's whole growth (800); the standby 'c' pays only what actually
    // moved it: +400 above, -200 for the dropped row = 200.
    box.set([row('older', 400), row('a', 200), row('c', 200), row('d', 200), row('extra', 600)]);
    anchor.restore(a);
    assert.strictEqual(box.scrollTop, 450);
});

test('a standby that also vanished is skipped for the next one', () => {
    const box = makeBox([row('a', 200), row('b', 200), row('c', 200), row('d', 200)], 300);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    box.scrollTop = 250;
    const a = anchor.capture();
    box.set([row('older', 400), row('a', 200), row('d', 200)]);   // b AND c gone
    anchor.restore(a);
    // 'd' is the surviving standby, and the content above it is unchanged (a+b+c =
    // 600, now older+a = 600), so the reader does not move at all.
    assert.strictEqual(box.scrollTop, 250);
});

test('standbys do not fire while the anchored row is still there', () => {
    const box = makeBox([row('a', 200), row('b', 200), row('c', 200)], 300);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    box.scrollTop = 250;
    const a = anchor.capture();
    anchor.preserve(() => box.set([row('older', 300), ...box.children]));
    assert.strictEqual(box.scrollTop, 550);
});

/* ---- frozen: a hidden tab must not move the reader -----------------------*/

test('while FROZEN nothing writes, and the reader place survives the whole stretch', () => {
    // The tab-return bug: a hidden tab keeps refreshing the list, every refresh
    // wrote scrollTop against a layout nobody was looking at and re-stamped the
    // anchor on the way through, so the reader came back to wherever the LAST of
    // those writes landed and only the next correction put them right.
    let hidden = false;
    const box = makeBox([row('a', 200), row('b', 200), row('c', 200)], 300);
    const anchor = createScrollAnchor({
        getBox: () => box, isStuck: () => false, isFrozen: () => hidden,
    });
    box.scrollTop = 250;
    anchor.remember();
    const before = topRowKeyAndOffset(box);

    hidden = true;
    const writes0 = box._writes;
    // Two refreshes land while hidden: a surface page that drops rows, then the
    // deferred batch that brings them back, each of which would have moved us. The
    // assertion is that the ANCHOR does not write — the box itself legitimately
    // re-clamps when the shrink puts the current offset past the new end.
    anchor.preserve(() => box.set([row('b', 200), row('c', 200)]));
    anchor.hold();
    anchor.preserve(() => box.set([row('a', 200), row('b', 200), row('c', 200)]));
    assert.strictEqual(box._writes, writes0, 'frozen: the anchor must not write');

    // The tab comes forward. One hold() puts them back on the line they left.
    hidden = false;
    anchor.hold();
    const after = topRowKeyAndOffset(box);
    assert.strictEqual(after.key, before.key);
    assert.strictEqual(after.top, before.top);
});

test('a scroll event while frozen does not overwrite the remembered place', () => {
    let hidden = true;
    const box = makeBox([row('a', 200), row('b', 200), row('c', 200)], 300);
    const anchor = createScrollAnchor({
        getBox: () => box, isStuck: () => false, isFrozen: () => hidden,
    });
    box.scrollTop = 250;
    hidden = false; anchor.remember(); hidden = true;   // the reader's real place

    box.scrollTop = 0;            // something clamps the box while nobody is looking
    anchor.remember();            // must be ignored
    hidden = false;
    // The FIRST hold() after a frozen stretch behaves like thaw(): scrollTop moved,
    // but nothing that happened while hidden was the reader. It must not re-measure
    // either — that would destroy the only record of where they were, which is what
    // left them in the "middle".
    anchor.hold();
    assert.strictEqual(box.scrollTop, 250);
});

test('a hold() racing the visibility handler cannot destroy the remembered place', () => {
    // onUpdated -> hold() fires on every render, so one can land between the tab
    // becoming visible and the visibility handler's own thaw().
    let hidden = false;
    const box = makeBox([row('a', 400), row('b', 400), row('c', 400)], 300);
    const anchor = createScrollAnchor({
        getBox: () => box, isStuck: () => false, isFrozen: () => hidden,
    });
    box.scrollTop = 500;
    anchor.remember();
    hidden = true;
    anchor.hold();                         // a render while hidden: marks the stretch
    box.scrollTop = box.scrollHeight;      // an invisible scroll-to-bottom
    hidden = false;

    anchor.hold();                         // the racing render wins the first call
    assert.strictEqual(box.scrollTop, 500);
    anchor.thaw();                         // and the handler's thaw is then a no-op
    assert.strictEqual(box.scrollTop, 500);
});

test('thaw() puts the reader back after invisible writes moved the box', () => {
    // The reported symptom, in one test: the reader is mid-history, the tab is
    // hidden, a refresh lands and something scrolls the box to the bottom while
    // nobody is looking. On return they must be back on their line, immediately.
    let hidden = false;
    const box = makeBox([row('a', 400), row('b', 400), row('c', 400)], 300);
    const anchor = createScrollAnchor({
        getBox: () => box, isStuck: () => false, isFrozen: () => hidden,
    });
    box.scrollTop = 500;
    anchor.remember();
    const before = topRowKeyAndOffset(box);

    hidden = true;
    box.scrollTop = box.scrollHeight;      // an invisible scroll-to-bottom
    anchor.preserve(() => box.set([row('a', 400), row('b', 400), row('c', 400), row('d', 400)]));
    hidden = false;

    anchor.thaw();
    const after = topRowKeyAndOffset(box);
    assert.strictEqual(after.key, before.key);
    assert.strictEqual(after.top, before.top);
    assert.strictEqual(box.scrollTop, 500);
});

test('thaw() is a no-op while still frozen, and harmless with nothing remembered', () => {
    let hidden = true;
    const box = makeBox([row('a', 200), row('b', 200)], 300);
    const anchor = createScrollAnchor({
        getBox: () => box, isStuck: () => false, isFrozen: () => hidden,
    });
    box.scrollTop = 100;
    anchor.thaw();
    assert.strictEqual(box.scrollTop, 100);
    hidden = false;
    anchor.forget();
    anchor.thaw();
    assert.strictEqual(box.scrollTop, 100);
});

test('absorb still records a height while frozen, so it does not double-pay later', () => {
    let hidden = true;
    const tall = row('tall', 900);
    const box = makeBox([tall, row('after', 200)], 300);
    const anchor = createScrollAnchor({
        getBox: () => box, isStuck: () => false, isFrozen: () => hidden,
    });
    const img = imgIn(box, tall, 100);
    img.grow(320);
    anchor.absorb(img);                    // decoded while hidden: recorded, not paid
    assert.strictEqual(box.scrollTop, 0);

    hidden = false;
    box.scrollTop = 600;
    anchor.remember();
    img.grow(320);                         // no change now
    anchor.absorb(img);
    assert.strictEqual(box.scrollTop, 600, 'the hidden growth must not be paid twice');
});

/* ---- parked: away in another APP, where nothing goes hidden --------------*/

test('park/thaw survives an unfocused stretch in which compensation kept running', () => {
    // Switching to another application usually leaves this tab the ACTIVE tab:
    // visibilitychange never fires, the page keeps rendering, and the anchor keeps
    // compensating — which re-stamps the live anchor over and over. Only a place
    // parked at blur can still name where the reader actually was.
    const box = makeBox([row('a', 400), row('b', 400), row('c', 400)], 300);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    box.scrollTop = 500;
    anchor.remember();
    const before = topRowKeyAndOffset(box);

    anchor.park();                                  // window blur

    // Away. Background work keeps compensating (nothing is frozen) and keeps
    // re-stamping the live anchor, then something scrolls the box outright.
    anchor.preserve(() => box.set([row('older', 600), ...box.children]));
    anchor.hold();
    box.scrollTop = box.scrollHeight;               // an unwatched scroll-to-bottom

    anchor.thaw();                                  // window focus
    const after = topRowKeyAndOffset(box);
    assert.strictEqual(after.key, before.key);
    assert.strictEqual(after.top, before.top);
});

test('a hidden tab parks on the way out, exactly as the clients do', () => {
    let hidden = false;
    const box = makeBox([row('a', 400), row('b', 400), row('c', 400)], 300);
    const anchor = createScrollAnchor({
        getBox: () => box, isStuck: () => false, isFrozen: () => hidden,
    });
    box.scrollTop = 500;
    anchor.remember();
    anchor.park();                 // both clients park on hide AND on blur
    hidden = true;
    box.scrollTop = 0;
    hidden = false;
    anchor.settleReturn();
    assert.strictEqual(box.scrollTop, 500);
});

test('settleReturn with nothing armed is a no-op, never a licence to re-impose', () => {
    const box = makeBox([row('a', 400), row('b', 400), row('c', 400)], 300);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    box.scrollTop = 500;
    anchor.remember();
    box.scrollTop = 900;           // the reader scrolls
    assert.strictEqual(anchor.settleReturn(), false);
    assert.strictEqual(box.scrollTop, 900);
});

test('a second thaw() does not move the reader again', () => {
    // Both handlers can fire on one return (a tab switch is also a focus change).
    const box = makeBox([row('a', 400), row('b', 400), row('c', 400)], 300);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    box.scrollTop = 500;
    anchor.remember();
    anchor.park();
    box.scrollTop = 1200;
    anchor.thaw();
    assert.strictEqual(box.scrollTop, 500);
    anchor.thaw();
    assert.strictEqual(box.scrollTop, 500);
});

test('a reader who left PINNED is put back on the bottom, and the host is told', () => {
    // capture() records nothing for a pinned reader (the bottom is the place, not a
    // row), so parkedStuck is the only note of it. Without it, a stickiness lost
    // during the absence had no fallback at all and the reader stayed wherever the
    // list happened to leave them.
    const box = makeBox([row('a', 400), row('b', 400)], 300);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => true });
    box.scrollTop = 500;
    anchor.park();
    box.scrollTop = 0;                              // something moved it while away
    assert.strictEqual(anchor.settleReturn(), true, 'the host must re-pin');
    assert.strictEqual(box.scrollTop, 500);
});

test('a pinned return STAYS armed, so it lands on the post-merge bottom', () => {
    // Phase 1 pins to the surface page's bottom; the deferred indexing batch then
    // adds rows. Re-pinning only once left the reader stranded above the newest
    // turn by exactly the batch's height.
    let stuck = true;
    const box = makeBox([row('a', 400), row('b', 400)], 300);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => stuck });
    box.scrollTop = 500;
    anchor.park();

    anchor.settleReturn();                          // phase 1
    assert.strictEqual(box.scrollTop, 500);
    assert.strictEqual(anchor.isReturning(), true, 'still armed for phase 2');

    box.set([row('a', 400), row('b', 400), row('batch', 600)]);   // phase 2 merges
    anchor.settleReturn();
    assert.strictEqual(box.scrollTop, 1100, 'the bottom that exists AFTER the merge');
});

/* ---- a correction the box could not take, retried when it can ------------*/

// 60 rows of 100px in a 600px box: the measured shape from the audit.
function longChat(n) {
    const rows = [];
    for (let i = 0; i < n; i++) rows.push(row('m' + i, 100));
    return rows;
}

test('THE BUG: a tail shrink clamps the return away, and phase 2 must retry it', () => {
    // Reader near the end of the loaded history. While they are away the TAIL loses
    // rows (a finished run collapsing its passes, the pending indicator going away),
    // so the box's maximum scrollTop drops below where they were and the browser
    // truncates the correction. Believing that write succeeded is what left them a
    // few hundred pixels off their line, permanently — the ~1s phase-2 correction
    // then slid the list under them and kept the error.
    const rows = longChat(60);
    const box = makeBox(rows, 600);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    box.scrollTop = 5300;                 // m53 sits at the top of the viewport
    anchor.remember();
    const before = topRowKeyAndOffset(box);
    assert.strictEqual(before.key, 'm53');
    assert.strictEqual(before.top, 0);

    anchor.park();
    box.set(rows.slice(0, 55));           // phase 1: five tail rows go away
    assert.strictEqual(box.scrollTop, 4900, 'the browser clamped us');

    anchor.settleReturn();                // the return lands short and knows it
    assert.strictEqual(box.scrollTop, 4900);
    assert.strictEqual(anchor.isReturning(), true, 'still armed: the write was clamped');

    box.set(rows);                        // phase 2: the batch brings them back
    anchor.settleReturn();
    const after = topRowKeyAndOffset(box);
    assert.strictEqual(after.key, 'm53');
    assert.strictEqual(after.top, 0);
    assert.strictEqual(box.scrollTop, 5300);
    assert.strictEqual(anchor.isReturning(), false, 'landed: the return retires');
});

test('a return that lands first time retires immediately', () => {
    const rows = longChat(60);
    const box = makeBox(rows, 600);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    box.scrollTop = 3000;
    anchor.remember();
    anchor.park();
    box.set([row('older', 400), ...rows]);
    anchor.settleReturn();
    assert.strictEqual(box.scrollTop, 3400);
    assert.strictEqual(anchor.isReturning(), false);
});

test('THE READER WINS: scrolling themselves after the return retires it at once', () => {
    // The regression the naive "keep retrying" fix caused, measured at -700px and
    // -4900px by the audit: a still-armed return that outlives the reader yanks
    // them back the next time anything merges. A scroll position this module did
    // not write is the reader, and that retires the return.
    const rows = longChat(60);
    const box = makeBox(rows, 600);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    box.scrollTop = 5300;
    anchor.remember();
    anchor.park();
    box.set(rows.slice(0, 55));
    anchor.settleReturn();
    assert.strictEqual(anchor.isReturning(), true);

    box.scrollTop = 300;          // the reader scrolls up to read something older
    anchor.remember();            // their own scroll event
    assert.strictEqual(anchor.isReturning(), false, 'the reader retired the return');

    box.set(rows);                // phase 2 lands anyway
    anchor.settleReturn();
    assert.strictEqual(box.scrollTop, 300, 'they are left exactly where they went');
});

test('THE READER WINS even scrolling to the very top, where the pager lives', () => {
    // The worst measured regression (-4900px): scroll-to-top is the ONLY pager
    // trigger, so dragging a reader off it also breaks paging.
    const rows = longChat(60);
    const box = makeBox(rows, 600);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    box.scrollTop = 5300;
    anchor.remember();
    anchor.park();
    box.set(rows.slice(0, 55));
    anchor.settleReturn();

    box.scrollTop = 0;
    anchor.remember();
    box.set([row('older', 900), ...rows]);   // the page the pager fetched
    anchor.settleReturn();
    assert.ok(box.scrollTop <= 900, 'not dragged back down the conversation');
});

test('the anchor own writes do NOT retire the return', () => {
    // Every write in this module records itself, so its own compensation cannot be
    // mistaken for the reader. Miss one and the return retires a settle too early.
    const rows = longChat(60);
    const box = makeBox(rows, 600);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    box.scrollTop = 5300;
    anchor.remember();
    anchor.park();
    box.set(rows.slice(0, 55));
    anchor.settleReturn();
    assert.strictEqual(anchor.isReturning(), true);

    // A page prepends and the bracketing restore compensates: its write is ours.
    anchor.preserve(() => box.set([row('older', 400), ...rows.slice(0, 55)]));
    anchor.remember();
    assert.strictEqual(anchor.isReturning(), true, 'our own write is not the reader');
});

test('pinBottom records its write, so a host pin does not retire the return either', () => {
    const box = makeBox(longChat(60), 600);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    box.scrollTop = 3000;
    anchor.remember();
    anchor.park();
    anchor.pinBottom();
    anchor.remember();
    assert.strictEqual(anchor.isReturning(), true);
});

/* ---- an armed return must never lie in wait ------------------------------*/

test('THE WIDGET BUG: a settle after the reader touches the scroll must not move them', () => {
    // Reported: come back to the browser, everything looks right, then START TO
    // INTERACT with the scroll and it throws you to some middle position. That
    // position is where you were BEFORE you left: a return was still armed, and the
    // next background settle acted on it. The scroll EVENT would eventually have
    // retired it, but a refresh can settle first — so the raw gesture has to.
    const rows = longChat(60);
    const box = makeBox(rows, 600);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    box.scrollTop = 5300;
    anchor.remember();
    anchor.park();                       // window blur
    box.set(rows.slice(0, 55));          // a refresh lands while away; write clamps
    anchor.settleReturn();               // window focus: lands short, stays armed
    assert.strictEqual(anchor.isReturning(), true);

    box.scrollTop = 1000;                // the reader starts scrolling
    anchor.release();                    // wheel / touch / key / scrollbar drag
    assert.strictEqual(anchor.isReturning(), false);

    box.set(rows);                       // the deferred batch merges a beat later
    anchor.settleReturn();
    assert.strictEqual(box.scrollTop, 1000, 'the reader stays exactly where they are');
});

test('an armed return expires rather than lying in wait', () => {
    // window blur fires for far more than "left the browser" — devtools, another
    // window, an iframe — and a blur with no matching focus must not arm something
    // that fires minutes later.
    const rows = longChat(60);
    const box = makeBox(rows, 600);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    box.scrollTop = 5300;
    anchor.remember();
    anchor.park();
    box.set(rows.slice(0, 55));          // keeps the return armed every time
    for (let i = 0; i < 3; i++) anchor.settleReturn();
    assert.strictEqual(anchor.isReturning(), false, 'the budget ran out');

    box.scrollTop = 1200;
    box.set(rows);
    anchor.settleReturn();
    assert.strictEqual(box.scrollTop, 1200);
});

test('release() during the absence does not break a later legitimate return', () => {
    const rows = longChat(60);
    const box = makeBox(rows, 600);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => false });
    box.scrollTop = 5300;
    anchor.remember();
    anchor.release();                    // a stray gesture with nothing armed
    anchor.park();                       // then a real absence
    box.set([row('older', 400), ...rows]);
    anchor.settleReturn();
    assert.strictEqual(box.scrollTop, 5700);
});

test('release() with a pinned reader drops the pin instruction too', () => {
    const box = makeBox([row('a', 400), row('b', 400)], 300);
    const anchor = createScrollAnchor({ getBox: () => box, isStuck: () => true });
    box.scrollTop = 500;
    anchor.park();
    box.scrollTop = 0;
    anchor.release();
    assert.strictEqual(anchor.settleReturn(), false, 'no re-pin after the reader acts');
    assert.strictEqual(box.scrollTop, 0);
});

/* ---- report --------------------------------------------------------------*/

let failed = 0;
for (const [ok, name, msg] of results) {
    console.log((ok ? 'ok   ' : 'FAIL ') + ' ' + name + (ok ? '' : '\n      ' + msg));
    if (!ok) failed++;
}
console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
process.exit(failed ? 1 : 0);
