/**
 * The settings panel's newsletter checkbox asks about ONE user: the signed-in visitor.
 *
 * getNewsletterSubscription has two very different answers behind one name. With a
 * "user_id" it returns that user's own subscription rows. WITHOUT one it returns the
 * caller's own rows for an ordinary user, but the WHOLE GROUP's subscriber list for the
 * project owner and for every admin in access groups 90 ~ 99. The widget runs inside a
 * CUSTOMER's site, so the caller is whoever is signed in there: when that visitor happens
 * to be an admin of the project, the user_id-less call pulled the project's subscriber
 * list into the page and set this checkbox from whichever row came back first, instead of
 * from that admin's own subscription.
 *
 * So the pin here is not a rendering detail, it is the scope of the request:
 *   1. the call always carries the signed-in user's user_id;
 *   2. with no signed-in user it makes NO request at all, because a request with no
 *      user_id is exactly the whole-list call;
 *   3. the active/inactive reading of the answer is unchanged.
 *
 * getNewsletterStatus lives in the widget IIFE (src/index.js), which is not importable:
 * it is a browser bundle with no exports. The function only touches `S`, so it is lifted
 * out of the source text and run against a fake skapi. The lift asserts its own markers,
 * so a rename fails this test loudly rather than passing on nothing.
 *
 * Run: node ./tests/newsletter-own-subscription.cjs
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const results = [];
async function test(name, fn) {
    try { await fn(); results.push([true, name]); }
    catch (err) { results.push([false, name, err && err.message]); }
}

/* ---- lift getNewsletterStatus out of the widget source ------------------- */

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
const OPEN = '\n    function getNewsletterStatus(user) {\n';
const CLOSE = '\n    }\n';               // the function's own 4-space closing brace

const start = SRC.indexOf(OPEN);
assert.notStrictEqual(start, -1, 'getNewsletterStatus(user) not found in src/index.js');
const end = SRC.indexOf(CLOSE, start + OPEN.length);
assert.notStrictEqual(end, -1, 'could not find the end of getNewsletterStatus');
const fnText = SRC.slice(start + 1, end + CLOSE.length - 1);
assert.ok(fnText.includes('Promise.resolve(false)'), 'lifted the wrong block of source');

function makeStatus(skapi) {
    // `S` is the widget's module-level state object; the function reads nothing else.
    return new Function('S', 'return (' + fnText + ');')({ skapi: skapi });
}

// A fake skapi that records every getNewsletterSubscription call it is given.
function fakeSkapi(answer) {
    const calls = [];
    return {
        calls: calls,
        getNewsletterSubscription: function (params) {
            calls.push(params);
            if (typeof answer === 'function') return answer(params);
            return Promise.resolve(answer);
        }
    };
}

const ME = '11111111-1111-1111-1111-111111111111';

async function main() {

    /* ---- the scope of the request --------------------------------------- */

    await test('THE FIX: the call carries the signed-in user\'s user_id', async () => {
        const skapi = fakeSkapi([]);
        await makeStatus(skapi)({ user_id: ME });
        assert.strictEqual(skapi.calls.length, 1);
        assert.strictEqual(skapi.calls[0].user_id, ME, 'user_id must scope the call to one user');
        assert.strictEqual(skapi.calls[0].group, 'authorized');
    });

    await test('THE BUG: no call is ever made without a user_id', async () => {
        // This is the whole-list request. An admin visitor of the customer's site would
        // get the project's subscriber list back from it.
        const skapi = fakeSkapi([]);
        await makeStatus(skapi)({ user_id: ME });
        await makeStatus(skapi)(null);
        await makeStatus(skapi)({});
        for (const params of skapi.calls) {
            assert.strictEqual(typeof params.user_id, 'string', 'a user_id-less call reached skapi');
            assert.ok(params.user_id, 'an empty user_id is still a whole-list call');
        }
    });

    await test('no signed-in user: false, and no request at all', async () => {
        const skapi = fakeSkapi([]);
        assert.strictEqual(await makeStatus(skapi)(null), false);
        assert.strictEqual(await makeStatus(skapi)(undefined), false);
        assert.strictEqual(await makeStatus(skapi)({}), false);
        assert.strictEqual(await makeStatus(skapi)({ user_id: 42 }), false, 'a non-string id is not an id');
        assert.strictEqual(skapi.calls.length, 0);
    });

    /* ---- reading the answer is unchanged --------------------------------- */

    await test('an active row in the authorized group (1) means subscribed', async () => {
        const skapi = fakeSkapi([{ active: true, group: 1, subscribed_email: 'a@b.com' }]);
        assert.strictEqual(await makeStatus(skapi)({ user_id: ME }), true);
    });

    await test('an UNSUBSCRIBED row still exists, and reads false', async () => {
        const skapi = fakeSkapi([{ active: false, group: 1, subscribed_email: 'a@b.com' }]);
        assert.strictEqual(await makeStatus(skapi)({ user_id: ME }), false);
    });

    await test('an active row in another group does not tick the box', async () => {
        const skapi = fakeSkapi([{ active: true, group: 0, subscribed_email: 'a@b.com' }]);
        assert.strictEqual(await makeStatus(skapi)({ user_id: ME }), false);
    });

    await test('a DatabaseResponse answer is read through .list', async () => {
        const skapi = fakeSkapi({ list: [{ active: true, group: 1 }], endOfList: true });
        assert.strictEqual(await makeStatus(skapi)({ user_id: ME }), true);
    });

    await test('an empty list reads false', async () => {
        assert.strictEqual(await makeStatus(fakeSkapi([]))({ user_id: ME }), false);
        assert.strictEqual(await makeStatus(fakeSkapi(null))({ user_id: ME }), false);
    });

    /* ---- failures never block the settings panel ------------------------- */

    await test('a rejected request reads false instead of throwing', async () => {
        const skapi = fakeSkapi(function () { return Promise.reject(new Error('No access.')); });
        assert.strictEqual(await makeStatus(skapi)({ user_id: ME }), false);
    });

    await test('a synchronous throw reads false too', async () => {
        const skapi = { getNewsletterSubscription: function () { throw new Error('not connected'); } };
        assert.strictEqual(await makeStatus(skapi)({ user_id: ME }), false);
    });

    /* ---- the call site hands it the profile it just fetched -------------- */

    await test('renderAccount resolves the profile BEFORE asking', async () => {
        // Promise.all would race: the lookup needs the user_id the profile carries.
        const site = SRC.slice(SRC.indexOf('function renderAccount()'));
        const body = site.slice(0, site.indexOf('\n    }\n'));
        assert.ok(/getProfile\(\)[\s\S]*getNewsletterStatus\(/.test(body),
            'renderAccount must chain the newsletter lookup after getProfile()');
        assert.ok(!/Promise\.all\(\[\s*getProfile\(\)\s*,\s*getNewsletterStatus\(\)/.test(body),
            'the parallel, user_id-less call is back');
    });

    let pass = 0;
    for (const [ok, name, msg] of results) {
        console.log(ok ? `ok    ${name}` : `FAIL  ${name}\n        ${msg}`);
        if (ok) pass++;
    }
    console.log(`\n${pass}/${results.length} passed`);
    process.exit(pass === results.length ? 0 : 1);
}

main();
