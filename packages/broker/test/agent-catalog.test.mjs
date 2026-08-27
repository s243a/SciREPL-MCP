#!/usr/bin/env node
/**
 * agent-catalog.test.mjs — the remote-agent ToS catalog is well-formed and honest.
 *
 * The properties that matter: every agent the broker can advertise resolves to a
 * catalog entry (nothing dropped), every referenced category exists, the
 * provider-discouraged agent (agy) is flagged as such, and the disclaimer makes no
 * claim of compliance.
 */
import {
  AGENT_CATALOG,
  TOS_CATEGORIES,
  TOS_DISCLAIMER,
  TOS_DISCLAIMER_VERSION,
  catalogFor,
} from '../src/agent-catalog.mjs';

let passed = 0, failed = 0;
const ok = (condition, message) => {
  if (condition) { console.log('  ✓ ' + message); passed++; }
  else { console.log('  ✗ ' + message); failed++; }
};

console.log('Remote-agent ToS catalog\n');

// The broker's default TERM_CMDS — every one must resolve to a known entry.
const defaults = ['shell', 'claude', 'codex', 'gemini', 'agy'];
const entries = catalogFor(defaults);
ok(entries.length === defaults.length, 'catalogFor returns one entry per name');
ok(entries.every((e) => !e.unknown), 'every default agent is known (none fall through to the generic entry)');
ok(entries.every((e) => TOS_CATEGORIES[e.category]), 'every entry names a category that exists');
ok(entries.every((e) => typeof e.blurb === 'string' && e.blurb.length > 0), 'every entry carries its category blurb');

const byId = Object.fromEntries(catalogFor(Object.keys(AGENT_CATALOG)).map((e) => [e.id, e]));
ok(byId.agy.category === 'discouraged' && byId.agy.warn === true, 'agy is provider-discouraged and warns');
ok(/suspend/i.test(byId.agy.note || ''), 'agy note names the suspension risk');
ok(byId.shell.category === 'shell' && byId.shell.warn === true, 'shell is its own warned category, not an agent');
ok(['claude', 'codex', 'gemini'].every((id) => byId[id].category === 'first-party'), 'the vendor CLIs are first-party');
ok(['opencode', 'cline', 'roo'].every((id) => byId[id].category === 'byo-key'), 'the open tools are byo-key');

// An agent the catalog does not know is surfaced conservatively, never dropped.
const [unknown] = catalogFor(['some-new-agent']);
ok(unknown && unknown.unknown === true && unknown.category === 'byo-key', 'an unknown agent gets a conservative generic entry');
ok(/check/i.test(unknown.note || ''), 'the unknown entry tells the operator to check the terms themselves');

// The disclaimer is honest: it does not assert compliance.
ok(typeof TOS_DISCLAIMER === 'string' && TOS_DISCLAIMER.length > 0, 'a disclaimer exists');
ok(/not legal advice/i.test(TOS_DISCLAIMER), 'the disclaimer says it is not legal advice');
ok(/responsible/i.test(TOS_DISCLAIMER), 'the disclaimer puts responsibility on the operator');
ok(/not a guarantee/i.test(TOS_DISCLAIMER), 'the disclaimer disclaims any guarantee');
ok(!/\b(is compliant|meets the (requirements|terms)|we ensure|we guarantee)\b/i.test(TOS_DISCLAIMER),
   'the disclaimer never claims the app meets/ensures the terms');
ok(Number.isInteger(TOS_DISCLAIMER_VERSION) && TOS_DISCLAIMER_VERSION > 0, 'the disclaimer is versioned (for re-prompting on change)');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
