/**
 * Reference data for the remote controls that a broker can advertise.
 *
 * This catalog describes integration surfaces and links to first-party material.
 * It deliberately does not decide whether a particular setup is permitted: the
 * broker cannot see which account, plan, credentials, or worker-host environment
 * an operator uses, and those details can change which terms apply.
 */

export const INTEGRATION_STATUSES = Object.freeze({
  'provider-documented': Object.freeze({
    label: 'Documented provider interface',
    blurb:
      'The provider documents a CLI, protocol, SDK, or non-interactive mode for integration or automation. This describes the interface, not the terms for every account or sign-in method.',
  }),
  community: Object.freeze({
    label: 'Community integration',
    blurb:
      'A third-party tool connects to one or more model providers. Review both the tool and the terms for the provider, plan, and credentials you select.',
  }),
  custom: Object.freeze({
    label: 'Custom integration',
    blurb:
      'The broker cannot identify this command. Review the tool, its connection method, and the terms for any service it uses.',
  }),
});

export const TERMS_REVIEW_LEVELS = Object.freeze({
  review: Object.freeze({
    label: 'Review applicable terms',
    blurb:
      'Check the current terms and plan rules for the service, account, authentication method, and way you intend to use it.',
  }),
  'specific-review': Object.freeze({
    label: 'Provider-specific terms to review',
    blurb:
      'The provider publishes guidance or terms specifically relevant to authentication or access through another application. Read the linked material for your setup.',
  }),
});

/**
 * One notice gates all remote controls in SciREPL Pro. The two paragraphs stay in
 * one acknowledgement while keeping provider terms distinct from host security.
 * Bump the version when the meaning changes so clients can ask again.
 */
export const REMOTE_ACCESS_NOTICE_VERSION = 1;
export const REMOTE_ACCESS_NOTICE = Object.freeze({
  title: 'Before enabling remote controls',
  terms:
    'Each provider sets its own terms for accounts, plans, authentication methods, and integrations, and those terms can change. Review the terms that apply to each agent and sign-in method you use. SciREPL provides the connection but cannot determine whether a particular setup is permitted.',
  security:
    'Remote controls can send notebook or tool data, prompts, terminal input, and commands through the broker. Commands run on the broker or worker computer with your operating-system account\'s permissions, and a raw shell is especially powerful. Enable remote controls only for people and systems you trust, protect the broker token, and restrict network access, workspaces, and commands.',
  acknowledgement:
    'I understand that I should review the applicable provider terms and protect the remote computer, and I want to enable remote controls.',
});

const REVIEWED_AT = '2026-08-27';
const source = (label, url) => Object.freeze({ label, url, reviewedAt: REVIEWED_AT });

/**
 * Known command names. A documented automation surface is evidence about the
 * interface only; it is not a compliance rating. Authentication remains
 * operator-supplied and may live on a reverse-worker host the broker cannot see.
 */
export const AGENT_CATALOG = Object.freeze({
  claude: Object.freeze({
    id: 'claude',
    label: 'Claude Code',
    kind: 'agent',
    integrationStatus: 'provider-documented',
    termsReview: 'specific-review',
    note:
      'Uses Anthropic\'s official Claude Code CLI and documented print/streaming interface. Review Anthropic\'s current authentication guidance for the plan and sign-in method you use.',
    sources: Object.freeze([
      source('Claude Code CLI reference', 'https://docs.anthropic.com/en/docs/claude-code/cli-usage'),
      source('Claude plan and Agent SDK guidance', 'https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan'),
    ]),
  }),
  codex: Object.freeze({
    id: 'codex',
    label: 'Codex',
    kind: 'agent',
    integrationStatus: 'provider-documented',
    termsReview: 'review',
    note:
      'Uses OpenAI\'s documented Codex CLI integration surface. Codex documents non-interactive use, an SDK, and app-server integrations; review the terms for your account and authentication method.',
    sources: Object.freeze([
      source('Codex non-interactive mode', 'https://developers.openai.com/codex/non-interactive-mode'),
      source('Codex app-server', 'https://developers.openai.com/codex/app-server'),
    ]),
  }),
  gemini: Object.freeze({
    id: 'gemini',
    label: 'Gemini CLI',
    kind: 'agent',
    integrationStatus: 'provider-documented',
    termsReview: 'review',
    note:
      'Uses Google\'s official Gemini CLI. ACP and headless modes are documented for developer tools and automation; review the terms linked to your selected authentication method.',
    sources: Object.freeze([
      source('Gemini CLI headless mode', 'https://geminicli.com/docs/cli/headless/'),
      source('Gemini CLI ACP mode', 'https://geminicli.com/docs/cli/acp-mode/'),
      source('Gemini CLI terms and privacy', 'https://geminicli.com/docs/resources/tos-privacy/'),
    ]),
  }),
  agy: Object.freeze({
    id: 'agy',
    label: 'Antigravity (agy)',
    kind: 'agent',
    integrationStatus: 'provider-documented',
    termsReview: 'specific-review',
    note:
      'Uses Google\'s official Antigravity CLI headless/streaming interface. Antigravity\'s terms contain specific language about third-party access, so review them for your setup and sign-in method.',
    sources: Object.freeze([
      source('Antigravity CLI headless mode', 'https://antigravity.google/docs/cli/headless/'),
      source('Google Antigravity terms', 'https://antigravity.google/terms'),
    ]),
  }),
  opencode: Object.freeze({
    id: 'opencode',
    label: 'OpenCode',
    kind: 'agent',
    integrationStatus: 'community',
    termsReview: 'review',
    note: 'OpenCode can use different providers and authentication methods; review the ones you configure.',
    sources: Object.freeze([source('OpenCode providers', 'https://opencode.ai/docs/providers/')]),
  }),
  cline: Object.freeze({
    id: 'cline',
    label: 'Cline',
    kind: 'agent',
    integrationStatus: 'community',
    termsReview: 'review',
    note: 'Cline can use different providers and authentication methods; review the ones you configure.',
    sources: Object.freeze([source('Cline model selection', 'https://docs.cline.bot/getting-started/selecting-your-model')]),
  }),
  roo: Object.freeze({
    id: 'roo',
    label: 'Roo Code',
    kind: 'agent',
    integrationStatus: 'community',
    termsReview: 'review',
    note: 'Roo Code can use different providers and authentication methods; review the ones you configure.',
    sources: Object.freeze([source('Roo Code providers', 'https://docs.roocode.com/providers/')]),
  }),
  shell: Object.freeze({
    id: 'shell',
    label: 'Shell',
    kind: 'shell',
    securityNote:
      'A raw shell is not a model-provider integration. It can run commands with the broker or worker account\'s permissions and does not add an agent permission prompt.',
    sources: Object.freeze([]),
  }),
});

export function unknownEntry(id) {
  return {
    id: String(id),
    label: String(id),
    kind: 'agent',
    integrationStatus: 'custom',
    termsReview: 'review',
    note:
      'Custom integration. Review the tool\'s license and terms, its connection method, and the model provider\'s terms before use.',
    sources: [],
    unknown: true,
  };
}

/** Resolve advertised command names without guessing their credentials or plan. */
export function catalogFor(names) {
  return (names || []).map((name) => {
    const base = AGENT_CATALOG[name] || unknownEntry(name);
    const integration = base.integrationStatus
      ? INTEGRATION_STATUSES[base.integrationStatus] || INTEGRATION_STATUSES.custom
      : null;
    const terms = base.termsReview ? TERMS_REVIEW_LEVELS[base.termsReview] : null;
    return {
      id: base.id,
      label: base.label,
      kind: base.kind,
      ...(integration ? {
        integrationStatus: base.integrationStatus,
        integrationStatusLabel: integration.label,
        integrationBlurb: integration.blurb,
      } : {}),
      ...(terms ? {
        termsReview: base.termsReview,
        termsReviewLabel: terms.label,
        termsBlurb: terms.blurb,
      } : {}),
      ...(base.note ? { note: base.note } : {}),
      ...(base.securityNote ? { securityNote: base.securityNote } : {}),
      sources: (base.sources || []).map((item) => ({ ...item })),
      ...(base.unknown ? { unknown: true } : {}),
    };
  });
}
