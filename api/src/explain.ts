// Bounded explanations. The model only rephrases a structured result that already
// exists; it never calculates, selects a recipe, or decides a status. Any failure
// falls back to the deterministic template, which is built from the same fields.
export const templateVersion = 'template-v1';
export const explanationLimit = 600;

export type ExplanationSource = 'llm' | 'template';
export type Explanation = { text: string; source: ExplanationSource; provider?: string; model?: string; templateVersion: string };

type EvidenceForExplanation = {
  recipe: string;
  recipeVersion: string;
  filters: Record<string, unknown>;
  inputRows: number;
  outputRows: number;
  validation: unknown;
  warnings: string[];
  limitations: string[];
  result: unknown;
};

const filterText = (filters: Record<string, unknown>) => {
  const entries = Object.entries(filters).filter(([, value]) => value !== undefined && value !== null && value !== '');
  return entries.length ? entries.map(([key, value]) => `${key}=${String(value)}`).join(', ') : 'no filters';
};

export const trimToLimit = (text: string, limit = explanationLimit) => (text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`);

// Fully deterministic, bounded, and correct with no network: this is what a reader
// always gets when the model is unavailable or misbehaves.
export function templateExplanation(evidence: EvidenceForExplanation): string {
  const validation = (evidence.validation as { status?: string } | undefined)?.status ?? 'Not run';
  const sentences = [
    `This ${evidence.recipe} analysis (v${evidence.recipeVersion}) covers ${evidence.inputRows} input rows with ${filterText(evidence.filters)}.`,
    `Validation reported ${validation}.`,
    evidence.warnings.length ? `Warnings: ${evidence.warnings.join('; ')}.` : 'No warnings were reported.',
    evidence.limitations.length ? `Limitations: ${evidence.limitations.join('; ')}.` : '',
    'The result below is the calculation; this description adds no new figures.',
  ];
  return trimToLimit(sentences.filter(Boolean).join(' '));
}

export type Provider = { name: string; model: string; endpoint: string; apiKey?: string };

// The provider receives only the bounded structured result and is asked for prose.
const buildPrompt = (evidence: EvidenceForExplanation) =>
  [
    'Explain the structured analysis result in at most three plain sentences.',
    'Use only numbers that appear in the JSON. Do not calculate, extrapolate, or give advice.',
    'Mention filters, validation, warnings, and limitations when present.',
    JSON.stringify({
      recipe: evidence.recipe,
      recipe_version: evidence.recipeVersion,
      filters: evidence.filters,
      input_rows: evidence.inputRows,
      output_rows: evidence.outputRows,
      validation: evidence.validation,
      warnings: evidence.warnings,
      limitations: evidence.limitations,
      result: evidence.result,
    }),
  ].join('\n\n');

export const providerPromptLimit = 20000;

function sanitize(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || text.length > explanationLimit) return undefined;
  return text;
}

export function createExplainer(options: {
  provider?: Provider;
  request?: typeof fetch;
  timeoutMs?: number;
}): { explain: (evidence: EvidenceForExplanation) => Promise<Explanation> } {
  const timeoutMs = options.timeoutMs ?? 8000;

  const fallback = (evidence: EvidenceForExplanation): Explanation => ({ text: templateExplanation(evidence), source: 'template', templateVersion });

  return {
    async explain(evidence) {
      const provider = options.provider;
      if (!provider) return fallback(evidence);
      const prompt = buildPrompt(evidence);
      // An oversized prompt would mean the model could see more than the reader
      // can; the template is the safe answer.
      if (prompt.length > providerPromptLimit) return fallback(evidence);
      const request = options.request ?? fetch;
      try {
        const response = await request(provider.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}) },
          body: JSON.stringify({ model: provider.model, messages: [{ role: 'user', content: prompt }], max_tokens: 200 }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) return fallback(evidence);
        const payload = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }>; content?: unknown };
        const raw = payload.choices?.[0]?.message?.content ?? payload.content;
        const text = sanitize(raw);
        if (!text) return fallback(evidence);
        return { text, source: 'llm', provider: provider.name, model: provider.model, templateVersion };
      } catch {
        // Network error, timeout, or malformed JSON all end the same way.
        return fallback(evidence);
      }
    },
  };
}
