#!/usr/bin/env node
/** Regression tests for neutral, source-backed remote-access guidance. */
import {
  AGENT_CATALOG,
  INTEGRATION_STATUSES,
  REMOTE_ACCESS_NOTICE,
  REMOTE_ACCESS_NOTICE_VERSION,
  TERMS_REVIEW_LEVELS,
  catalogFor,
} from '../src/agent-catalog.mjs';

let passed = 0, failed = 0;
const ok = (condition, message) => {
  if (condition) { console.log('  ✓ ' + message); passed++; }
  else { console.log('  ✗ ' + message); failed++; }
};

console.log('Remote-access catalog\n');

const defaults = ['shell', 'claude', 'codex', 'gemini', 'agy'];
const entries = catalogFor(defaults);
ok(entries.map((entry) => entry.id).join(',') === defaults.join(','),
  'catalog preserves the advertised IDs and order');
ok(entries.every((entry) => !entry.unknown), 'every default command has a known entry');

const byId = Object.fromEntries(catalogFor(Object.keys(AGENT_CATALOG)).map((entry) => [entry.id, entry]));
ok(['claude', 'codex', 'gemini', 'agy'].every((id) => byId[id].integrationStatus === 'provider-documented'),
  'all four official CLIs are described as provider-documented interfaces');
ok(['opencode', 'cline', 'roo'].every((id) => byId[id].integrationStatus === 'community'),
  'multi-provider community tools are not mislabeled as API-key access');
ok(byId.agy.termsReview === 'specific-review' && /third-party access/i.test(byId.agy.note),
  'Antigravity points neutrally to its provider-specific terms language');
ok(!/suspend|forbid|prohibit|discourag|account risk/i.test(byId.agy.note),
  'Antigravity copy makes no categorical enforcement or prohibition claim');
ok(byId.shell.kind === 'shell' && !byId.shell.integrationStatus && !byId.shell.termsReview,
  'shell is outside the model-provider terms taxonomy');
ok(/raw shell|permissions/i.test(byId.shell.securityNote || ''),
  'shell carries a separate host-security explanation');

const allSources = Object.values(byId).flatMap((entry) => entry.sources || []);
ok(allSources.length > 0 && allSources.every((item) => /^https:\/\//.test(item.url)),
  'catalog references use HTTPS URLs');
ok(allSources.every((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.reviewedAt)),
  'every external reference records its review date');
ok(byId.codex.sources.some((item) => /non-interactive|app-server/.test(item.url)),
  'Codex links to an official documented integration surface');
ok(byId.gemini.sources.some((item) => /headless|acp-mode/.test(item.url)),
  'Gemini links to an official documented integration surface');
ok(byId.claude.sources.some((item) => /cli-usage/.test(item.url)),
  'Claude Code links to its documented print/streaming interface');
ok(byId.agy.sources.some((item) => /\/terms/.test(item.url)) &&
   byId.agy.sources.some((item) => /headless/.test(item.url)),
  'Antigravity links to both integration documentation and current terms');

const [unknown] = catalogFor(['some-new-agent']);
ok(unknown.unknown === true && unknown.integrationStatus === 'custom' && unknown.termsReview === 'review',
  'an unknown command is custom and requires operator review');
ok(!/api key|generally permit|sanction/i.test(JSON.stringify(unknown)),
  'an unknown command never inherits optimistic API-key or permission language');
ok(INTEGRATION_STATUSES[unknown.integrationStatus] && TERMS_REVIEW_LEVELS[unknown.termsReview],
  'unknown entries resolve to defined neutral labels');

ok(typeof REMOTE_ACCESS_NOTICE.terms === 'string' && /review the terms/i.test(REMOTE_ACCESS_NOTICE.terms),
  'the combined notice contains a provider-terms reminder');
ok(typeof REMOTE_ACCESS_NOTICE.security === 'string' && /broker token|raw shell/i.test(REMOTE_ACCESS_NOTICE.security),
  'the same notice contains a distinct remote-host security warning');
ok(/want to enable remote controls/i.test(REMOTE_ACCESS_NOTICE.acknowledgement),
  'the acknowledgement enables remote controls without certifying compliance');
ok(!/i certify|i agree that|is compliant|meets the terms|we ensure|we guarantee/i.test(JSON.stringify(REMOTE_ACCESS_NOTICE)),
  'the notice makes no compliance claim or legal certification');
ok(Number.isInteger(REMOTE_ACCESS_NOTICE_VERSION) && REMOTE_ACCESS_NOTICE_VERSION > 0,
  'notice content is versioned for re-acknowledgement');

const first = catalogFor(['codex'])[0];
first.sources.push({ label: 'mutated', url: 'https://example.invalid', reviewedAt: '2026-01-01' });
ok(catalogFor(['codex'])[0].sources.every((item) => item.label !== 'mutated'),
  'serialized source arrays cannot mutate the catalog');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
