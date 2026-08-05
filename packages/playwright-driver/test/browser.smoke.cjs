'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { chromium } = require('playwright');

test('launches the installed Chromium build', { timeout: 30000 }, async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent('<title>SciREPL MCP smoke</title><main>ready</main>');
        assert.equal(await page.title(), 'SciREPL MCP smoke');
        assert.equal(await page.locator('main').textContent(), 'ready');
    } finally {
        await browser.close();
    }
});
