export function workerWebSocketUrl(host, port, pathname = '/worker') {
    const dial = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : String(host || '');
    const hostname = dial.includes(':') ? `[${dial}]` : dial;
    return `ws://${hostname}:${port}${pathname}`;
}
