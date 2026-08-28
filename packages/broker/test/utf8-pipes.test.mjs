#!/usr/bin/env node
/**
 * Split multi-byte UTF-8 on child pipes, including the 500-code-point stderr
 * truncation boundary. Ported from the PR #9 helper so reverse-worker can use
 * it without assuming that branch has merged.
 */
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { configureUtf8Pipes, truncateCodePoints } from '../src/utf8-pipes.mjs';

const SENTINEL = 'côtés · 日本語 · বাংলা · 👩‍🔬';
const TWO_BYTE = 'ô';
const THREE_BYTE = '日';
const FOUR_BYTE = '👩';

let passed = 0, failed = 0;
const ok = (condition, message) => {
    if (condition) { console.log('  ✓ ' + message); passed++; }
    else { console.log('  ✗ ' + message); failed++; }
};

console.log('UTF-8 streaming pipes — reverse-worker helper\n');

function midSequenceCut(text) {
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length < 2) throw new Error('need a multi-byte sequence');
    const lead = bytes[0];
    const expected = (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xf8) === 0xf0 ? 4 : 0;
    if (expected < 2 || bytes.length < expected) throw new Error('fixture is not a 2/3/4-byte character');
    if ((bytes[1] & 0xc0) !== 0x80) throw new Error('cut is not inside a UTF-8 sequence');
    return 1;
}

async function decodeSplit(streamName, text, cut) {
    const child = { stdout: new PassThrough(), stderr: new PassThrough() };
    configureUtf8Pipes(child);
    const stream = child[streamName];
    let decoded = '';
    stream.on('data', chunk => { decoded += chunk; });
    const bytes = Buffer.from(text, 'utf8');
    stream.write(bytes.subarray(0, cut));
    stream.write(bytes.subarray(cut));
    stream.end();
    await once(stream, 'end');
    return decoded;
}

async function decodeOneByteAtATime(streamName, text) {
    const child = { stdout: new PassThrough(), stderr: new PassThrough() };
    configureUtf8Pipes(child);
    const stream = child[streamName];
    let decoded = '';
    stream.on('data', chunk => { decoded += chunk; });
    const bytes = Buffer.from(text);
    for (let index = 0; index < bytes.length; index++) stream.write(bytes.subarray(index, index + 1));
    stream.end();
    await once(stream, 'end');
    return decoded;
}

for (const streamName of ['stdout', 'stderr']) {
    const decoded = await decodeOneByteAtATime(streamName, SENTINEL);
    ok(decoded === SENTINEL && !decoded.includes('\uFFFD'),
        `${streamName} preserves 2-, 3-, and 4-byte characters across one-byte chunks`);
}

for (const [label, glyph] of [['2-byte', TWO_BYTE], ['3-byte', THREE_BYTE], ['4-byte', FOUR_BYTE]]) {
    const cut = midSequenceCut(glyph);
    const wrapped = `pre-${glyph}-post`;
    for (const streamName of ['stdout', 'stderr']) {
        const decoded = await decodeSplit(streamName, wrapped, Buffer.from(`pre-`, 'utf8').length + cut);
        ok(decoded === wrapped && !decoded.includes('\uFFFD'),
            `${streamName} reassembles a ${label} character split inside its byte sequence`);
    }
}

const boundaryDiagnostic = 'a'.repeat(499) + '😀' + 'tail';
const truncatedDiagnostic = truncateCodePoints(boundaryDiagnostic, 500);
ok(truncatedDiagnostic === 'a'.repeat(499) + '😀' && !truncatedDiagnostic.includes('\uFFFD'),
    'stderr diagnostics are bounded without splitting a surrogate pair at the 500-code-point limit');

const splitBoundary = await decodeSplit('stderr', boundaryDiagnostic, Buffer.from('a'.repeat(499), 'utf8').length + 1);
ok(splitBoundary === boundaryDiagnostic && !splitBoundary.includes('\uFFFD'),
    'split 4-byte character at the 500-code-point boundary decodes before truncation');
ok(truncateCodePoints(splitBoundary, 500) === 'a'.repeat(499) + '😀' && !truncateCodePoints(splitBoundary, 500).includes('\uFFFD'),
    'truncation after reassembling a split 4-byte character keeps 500 code points intact');

try {
    truncateCodePoints('x', 1.5);
    ok(false, 'truncateCodePoints rejects a non-integer maximum');
} catch (e) {
    ok(e instanceof TypeError, 'truncateCodePoints rejects a non-integer maximum');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
