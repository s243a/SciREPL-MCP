/**
 * Remote coding-agent catalog: what the broker can host, and the terms-of-service
 * posture a human should weigh before driving each one.
 *
 * The broker hosts whatever CLI is named in BROKER_AGENT profiles or BROKER_TERM_CMDS
 * — it does not, and should not, decide policy. This module is *reference data* the
 * SciREPL app renders so the person choosing an agent sees an honest note and a
 * consent step. It is advertised additively in the `/agent` and `/term` welcomes;
 * clients that do not use it ignore it.
 *
 * The categories are drawn on the axis that actually matters — **how the model
 * provider is being accessed** — not on whether the agent tool is open source. An
 * open BYO-key CLI is not "safe" because it is open; a first-party CLI is not
 * "risky" because it is proprietary. See docs/remote-agent-control.md.
 */

/**
 * ToS-posture categories, ordered roughly clearest→grayest. `warn: true` means the
 * app should show a stronger inline warning and (recommended) take a separate
 * acknowledgement for agents in it.
 */
export const TOS_CATEGORIES = {
  "byo-key": {
    label: "Bring-your-own-key tool",
    blurb:
      "You supply your own model API key, so the provider's API terms apply — and those generally permit programmatic use. The tool being open source does not, by itself, make any particular use compliant; the key and plan you supply do.",
  },
  "first-party": {
    label: "The vendor's own CLI",
    blurb:
      "The model vendor's own tool. Interactive use is intended and sanctioned; driving it headlessly, or under a consumer subscription rather than an API key, can go beyond that intended use. Check the provider's terms for the plan you are on — an API key is the clearest footing.",
  },
  discouraged: {
    label: "Provider discourages third-party driving",
    warn: true,
    blurb:
      "The provider's terms discourage driving this tool from third-party software or programmatically. There is a real account-suspension risk, and an in-app acknowledgement does not remove it — it only records that you were told.",
  },
  shell: {
    label: "Raw shell (not a coding agent)",
    warn: true,
    blurb:
      "Not a coding agent — a raw shell. No provider terms apply, but neither does any agent permission prompt; it is the most powerful and dangerous option the broker can expose.",
  },
};

/**
 * Known agents. `id` is the CLI/command name the broker would run. Entries exist for
 * agents the broker does not ship a profile for (opencode, cline, roo) so an operator
 * who adds one to BROKER_TERM_CMDS still gets an honest note in the app.
 */
export const AGENT_CATALOG = {
  // Bring-your-own-key open tools.
  opencode: { id: "opencode", label: "OpenCode", category: "byo-key" },
  cline: { id: "cline", label: "Cline", category: "byo-key" },
  roo: { id: "roo", label: "Roo Code", category: "byo-key" },
  // The vendors' own CLIs.
  claude: {
    id: "claude",
    label: "Claude Code",
    category: "first-party",
    note: "Anthropic's own CLI. API-key use is the clearest; a Pro/Max subscription driven headlessly is a grayer area.",
  },
  codex: {
    id: "codex",
    label: "Codex",
    category: "first-party",
    note: "OpenAI's own CLI. As with Claude Code, an API key is on the clearest footing.",
  },
  gemini: {
    id: "gemini",
    label: "Gemini CLI",
    category: "first-party",
    note: "Google's own CLI. Check your plan's terms for programmatic/third-party use.",
  },
  // Provider-discouraged.
  agy: {
    id: "agy",
    label: "Antigravity (agy)",
    category: "discouraged",
    note: "Antigravity's terms discourage driving the CLI from third-party tools, and accounts have been suspended for it. Choose it only where you accept that risk.",
  },
  // Not an agent; present because it can appear in BROKER_TERM_CMDS.
  shell: { id: "shell", label: "Shell", category: "shell" },
};

/**
 * The consent copy. Deliberately makes **no claim of compliance** — it states the
 * design's reasoning and pushes responsibility to the operator, which is where it
 * belongs. Bump `TOS_DISCLAIMER_VERSION` when the text changes so the app can
 * re-prompt an operator who acknowledged an older version.
 */
export const TOS_DISCLAIMER_VERSION = 1;
export const TOS_DISCLAIMER =
  "A human drives the agent, and it talks to SciREPL over MCP — closer to normal interactive use than headless automation. That is the reasoning for why this design is reasonable; it is not a guarantee of compliance, and it is not legal advice. Terms of service change, and enforcement is at each provider's discretion. You are responsible for ensuring your use fits the terms of the model provider and the agent you choose.";

/** A generic entry for an agent the catalog does not know. */
export function unknownEntry(id) {
  return {
    id: String(id),
    label: String(id),
    category: "byo-key",
    note: "Not in the catalog — check this agent's and its model provider's terms yourself before driving it.",
    unknown: true,
  };
}

/**
 * Resolve a list of command/agent names to catalog entries, each carrying its
 * category's label/blurb/warn so a client needs only this one payload to render the
 * consent gate. Unknown names get a conservative generic entry rather than being
 * dropped silently.
 * @param {string[]} names
 */
export function catalogFor(names) {
  return (names || []).map((name) => {
    const base = AGENT_CATALOG[name] || unknownEntry(name);
    const cat = TOS_CATEGORIES[base.category] || TOS_CATEGORIES["byo-key"];
    return {
      id: base.id,
      label: base.label,
      category: base.category,
      categoryLabel: cat.label,
      blurb: cat.blurb,
      warn: Boolean(cat.warn),
      ...(base.note ? { note: base.note } : {}),
      ...(base.unknown ? { unknown: true } : {}),
    };
  });
}
