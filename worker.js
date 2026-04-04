/**
 * gpt4free Cloudflare Worker
 *
 * Exposes an OpenAI-compatible POST /v1/chat/completions endpoint that
 * proxies requests to free upstream providers.
 *
 * Usage (drop-in for the OpenAI SDK):
 *   base_url = "https://<your-worker>.workers.dev/v1"
 *   api_key  = "unused"   # any non-empty string
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Provider",
};

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ status: "ok", providers: ["you"] });
    }

    if (url.pathname !== "/v1/chat/completions") {
      return json({ error: { message: "Not found", type: "invalid_request_error" } }, 404);
    }

    if (request.method !== "POST") {
      return json({ error: { message: "Method not allowed", type: "invalid_request_error" } }, 405);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, 400);
    }

    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return json({ error: { message: "messages must be a non-empty array", type: "invalid_request_error" } }, 400);
    }

    // Find the last user message — that becomes the prompt.
    // All prior user/assistant pairs become You.com chat history.
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") { lastUserIdx = i; break; }
    }
    if (lastUserIdx === -1) {
      return json({ error: { message: "No user message found in messages array", type: "invalid_request_error" } }, 400);
    }

    const prompt = messages[lastUserIdx].content;

    // Build You.com-style chat history from prior exchanges
    const chat = [];
    for (let i = 0; i < lastUserIdx - 1; i++) {
      if (messages[i].role === "user" && messages[i + 1].role === "assistant") {
        chat.push({ question: messages[i].content, answer: messages[i + 1].content });
        i++; // skip the paired assistant message
      }
    }

    try {
      const content = await fetchYou(prompt, chat);
      return json(buildOpenAIResponse(content, prompt));
    } catch (err) {
      return json({ error: { message: err.message, type: "upstream_error" } }, 502);
    }
  },
};

// ---------------------------------------------------------------------------
// You.com provider
// ---------------------------------------------------------------------------

async function fetchYou(prompt, chat = []) {
  const uuid = crypto.randomUUID();

  const params = new URLSearchParams({
    q:              prompt,
    page:           "1",
    count:          "10",
    safeSearch:     "Moderate",
    onShoppingPage: "false",
    mkt:            "",
    responseFilter: "WebPages,Translations,TimeZone,Computation,RelatedSearches",
    domain:         "youchat",
    queryTraceId:   crypto.randomUUID(),
    chat:           JSON.stringify(chat),
  });

  const response = await fetch(`https://you.com/api/streamingSearch?${params}`, {
    headers: {
      "authority":          "you.com",
      "accept":             "text/event-stream",
      "accept-language":    "en,fr-FR;q=0.9,fr;q=0.8,es-ES;q=0.7,es;q=0.6,en-US;q=0.5,am;q=0.4,de;q=0.3",
      "cache-control":      "no-cache",
      "referer":            "https://you.com/search?q=who+are+you&tbm=youchat",
      "sec-ch-ua":          '"Not_A Brand";v="99", "Google Chrome";v="109", "Chromium";v="109"',
      "sec-ch-ua-mobile":   "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest":     "empty",
      "sec-fetch-mode":     "cors",
      "sec-fetch-site":     "same-origin",
      "cookie":             `safesearch_guest=Moderate; uuid_guest=${uuid}`,
      "user-agent":         "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36",
    },
  });

  if (!response.ok) {
    throw new Error(`You.com returned HTTP ${response.status}`);
  }

  // Parse the SSE stream and collect youChatToken events
  const body = await response.text();
  const tokens = [];

  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const data = JSON.parse(line.slice(6));
      if (typeof data.youChatToken === "string") {
        tokens.push(data.youChatToken);
      }
    } catch {
      // non-JSON data lines (e.g. the "done" sentinel) — skip
    }
  }

  if (tokens.length === 0) {
    throw new Error("No tokens received from You.com — response may have changed format");
  }

  return tokens.join("");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildOpenAIResponse(content, prompt) {
  return {
    id:      `chatcmpl-${crypto.randomUUID()}`,
    object:  "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model:   "gpt-3.5-turbo",
    choices: [
      {
        index:         0,
        message:       { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens:     prompt.length,
      completion_tokens: content.length,
      total_tokens:      prompt.length + content.length,
    },
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
