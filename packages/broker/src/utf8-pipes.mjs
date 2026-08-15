/**
 * Decode child-process pipes incrementally so a UTF-8 code point split across
 * OS chunks is emitted once, intact. Readable#setEncoding uses Node's streaming
 * StringDecoder and flushes an incomplete terminal sequence when the pipe ends.
 */
export function configureUtf8Pipes(child) {
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    return child;
}

/** Keep a diagnostic bounded without splitting a UTF-16 surrogate pair. */
export function truncateCodePoints(text, maximum) {
    if (!Number.isSafeInteger(maximum) || maximum < 0) throw new TypeError('maximum must be a non-negative integer');
    let count = 0;
    let end = 0;
    for (const character of String(text)) {
        if (count++ >= maximum) break;
        end += character.length;
    }
    return String(text).slice(0, end);
}
