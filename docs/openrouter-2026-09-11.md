# OpenRouter 事実確認メモ (justic 接続先設計用)

- 確認日: **2026-09-11** (以下すべての項目に共通)
- 一次情報として見たもの: `https://openrouter.ai/docs` 配下の各ページ (Fern が配信する `.md` 版。例: `https://openrouter.ai/docs/api_reference/parameters.md`。索引は `https://openrouter.ai/docs/llms.txt`)、`https://openrouter.ai/privacy`、`https://openrouter.ai/terms`、`https://openrouter.ai/google/gemini-3.8-flash`、および `GET https://openrouter.ai/api/v1/models` (キー無し・本文送信なし)。
- 送った要求は上記の GET のみ。POST は一切していない。API キーは使っていない。
- 引用は原文 (英語) を短く添える。ドキュメントに記載が見つからないものは「未確認」と書く。

---

## 1. ベース URL と認証

**事実**

- ベース URL は `https://openrouter.ai/api/v1`。OpenAPI の `servers` に本番サーバーとして記載されている。チャット補完は `POST /chat/completions`、すなわち `https://openrouter.ai/api/v1/chat/completions`。
- 認証は Bearer トークン。`Authorization: Bearer <OPENROUTER_API_KEY>` で良い。
- `HTTP-Referer` は任意ヘッダで、openrouter.ai 上でアプリを識別する。App Attribution ではこのヘッダが **必須** (これが無いとアプリページは作られずランキングにも出ない)。
- アプリ名のヘッダは現在のドキュメントでは `X-OpenRouter-Title`。`X-Title` も後方互換で受け付けると明記されている。`X-OpenRouter-Title` 単独ではアプリページは作られず、`HTTP-Referer` との併用が必要。
- 関連する任意ヘッダとして `X-OpenRouter-Categories`、`X-OpenRouter-App-Visibility`、`X-OpenRouter-Metadata` がある (後者は項目3参照)。
- エンタープライズ向けに地域限定ホスト `https://eu.openrouter.ai` / `https://us.openrouter.ai` がある (申請制)。

**出典**

- https://openrouter.ai/docs/api_reference/authentication
- https://openrouter.ai/docs/api_reference/overview (Headers 節)
- https://openrouter.ai/docs/app-attribution
- https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key (OpenAPI の `servers`)
- https://openrouter.ai/docs/guides/privacy/provider-logging (地域ホスト)

**原文の抜粋**

> "Our API authenticates requests using Bearer tokens. This allows you to use `curl` or the OpenAI SDK directly with OpenRouter."
> "If you're calling the OpenRouter API directly, set the `Authorization` header to a Bearer token with your API key."
> (OpenAPI) `servers: - description: Production server / url: https://openrouter.ai/api/v1`
> "`HTTP-Referer`: Identifies your app on openrouter.ai"
> "`X-OpenRouter-Title`: Sets/modifies your app's title (`X-Title` also accepted)"
> "The `X-OpenRouter-Title` header sets or modifies your app's display name in rankings and analytics. `X-Title` is still supported for backwards compatibility. This header alone does not create an app page. It must be paired with `HTTP-Referer`."
> "`HTTP-Referer` is **required** to create an app page and appear in rankings."

---

## 2. 要求の項目

**事実 (共通の前提)**

- サンプリング系のパラメータは、**送らなければ OpenRouter は上流に転送しない**。ドキュメントの「Default」は慣例値であって OpenRouter が注入する値ではない。明示送信は転送され、省略とは結果が変わりうる (プロバイダ側のキャッシュキーに影響する等)。
- モデルが対応していない要求パラメータは**無視される** (既定の routing では)。厳密にしたい場合は `provider.require_parameters: true`。

原文:
> "When a sampling parameter is absent from your request, OpenRouter omits it upstream rather than substituting a hardcoded value, so the provider applies its own default. The \"Default\" listed for each parameter below is the conventional value, not one OpenRouter injects. Explicitly sending it (e.g. `temperature: 1.0`) is still forwarded and may differ from omitting it (for example, it can affect provider-side cache keys)."
> "If the chosen model doesn't support a request parameter (such as `logit_bias` in non-OpenAI models, or `top_k` for OpenAI), then the parameter is ignored. The rest are forwarded to the underlying model API."

出典: https://openrouter.ai/docs/api_reference/parameters 、https://openrouter.ai/docs/api_reference/overview

### 2-1. `model` / `messages`

- `messages` か `prompt` のどちらかが必須。`model` は省略可で、省略するとユーザー/支払者の既定モデルが使われる。
- 原文: `// Either "messages" or "prompt" is required` / `// If "model" is unspecified, uses the user's default` / "If the `model` parameter is omitted, the user or payer's default is used."
- 出典: https://openrouter.ai/docs/api_reference/overview

### 2-2. `temperature`

- 型 **float**、範囲 0.0〜2.0、Optional。Default は 1.0 (ただし上の共通前提のとおり慣例値)。
- 原文: "* Key: `temperature` * Optional, **float**, 0.0 to 2.0 * Default: 1.0"
- OpenAPI 側: `temperature: description: Sampling temperature (0-2) / format: double / type: [number, 'null']`
- 出典: https://openrouter.ai/docs/api_reference/parameters 、https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion

### 2-3. `max_tokens` / `max_completion_tokens`

- `max_tokens`: Optional **integer**、1 以上。上限は「コンテキスト長 − プロンプト長」。
- **OpenAPI では `max_tokens` は deprecated 扱いで、`max_completion_tokens` の使用が案内されている**。プロバイダによっては最小 16 を強制する旨の注記あり。
- 原文 (Parameters): "* Key: `max_tokens` * Optional, **integer**, 1 or above ... The maximum value is the context length minus the prompt length."
- 原文 (OpenAPI): `max_tokens: description: Maximum tokens (deprecated, use max_completion_tokens). Note: some providers enforce a minimum of 16.`
- 出典: 同上

### 2-4. `response_format`

- 型は **map**。`{"type": "json_object"}` で JSON モード、`{"type":"json_schema","json_schema":{name, strict?, schema}}` で JSON Schema モード。
- OpenAPI の discriminator には `text` / `json_object` / `json_schema` / `grammar` / `python` の 5 種が並ぶ。
- `strict: true` の効き方はプロバイダ次第 (完全保証ではない)。
- ルーティングを対応エンドポイントに限定するには `provider.require_parameters: true` を併用する、と明記。ただし `response_format` は `require_parameters` が false でも「soft preference」として働く。
- 原文:
  > "Forces the model to produce specific output format. Setting to `{ \"type\": \"json_object\" }` enables JSON mode, which guarantees the message the model generates is valid JSON."
  > "**Use strict mode**: Set `strict: true` so that providers with a native strict mode enforce your schema exactly. Enforcement varies by provider: some guarantee schema-conforming output, while others translate your schema into their own structured-output format or treat it as a strong hint, so exact compliance is not guaranteed on every endpoint."
  > "Even when `require_parameters` is `false`, a small set of parameters is used as a soft preference when choosing between providers of the same model: `tools`, `response_format` (including structured outputs), and `verbosity`."
- 別パラメータとして `structured_outputs` (Optional, **boolean**) がある: "If the model can return structured outputs using response_format json_schema."
- 出典: https://openrouter.ai/docs/guides/features/structured-outputs 、https://openrouter.ai/docs/api_reference/parameters 、https://openrouter.ai/docs/guides/routing/provider-selection

### 2-5. `reasoning`

- 型は **map**。ガイドが示す形:
  > ```
  > "reasoning": {
  >   // One of the following (not both):
  >   "effort": "high", // Can be "max", "xhigh", "high", "medium", "low", "minimal" or "none" (OpenAI-style)
  >   "max_tokens": 2000, // Specific token limit (Anthropic-style)
  >   // Optional: Default is false. All models support this.
  >   "exclude": false, // Set to true to exclude reasoning tokens from response
  >   // Or enable reasoning with the default parameters:
  >   "enabled": true // Default: inferred from `effort` or `max_tokens`
  > }
  > ```
- `effort` と `max_tokens` は **どちらか一方** (not both)。
- `exclude` の既定は false、全モデル対応。`"exclude": true` で「思考は使うが応答には含めない」。
- `enabled: true` は「medium 相当・除外なしで reasoning を有効化」。原文: "`\"enabled\": true` - Enables reasoning at the \"medium\" effort level with no exclusions."
- 既定では「モデルが出力を決めたなら reasoning は応答に含まれる」。原文: "Reasoning tokens are included in the response by default if the model decides to output them. Reasoning tokens will appear in the `reasoning` field of each message, unless you decide to exclude them."
- reasoning トークンは**出力トークンとして課金**される。原文: "Reasoning tokens are considered output tokens and charged accordingly."
- ショートハンド `reasoning_effort` (enum: xhigh, high, medium, low, minimal, none。OpenAPI は max も含む) がある。原文: "Shorthand for setting reasoning effort. Equivalent to setting reasoning.effort. Cannot be used simultaneously with reasoning.effort if they differ."
- Gemini 3 系では `reasoning.effort` が Google の `thinkingLevel` に直接マップされる (`minimal`→`minimal`, `low`→`low`, `medium`→`medium`, `high`→`high`, `xhigh`→`high` に丸められる)。実消費トークン数は Google 側が決め、公開された境界値は無い。`reasoning.max_tokens` は `thinkingBudget` として渡されるが、Gemini 3 では Google が内部で thinkingLevel に写すため**精密なトークン制御にならない**。
  > "When using `thinkingLevel`, the actual number of reasoning tokens consumed is determined internally by Google. There are no publicly documented token limit breakpoints for each level."
  > "However, for Gemini 3 models, Google internally maps this budget value to a `thinkingLevel`, so you will not get precise token control."
- モデルごとの受け付け可能な effort は `GET /api/v1/models` の `reasoning` オブジェクト (`supported_efforts`, `default_effort`, `default_enabled`, `supports_max_tokens`, `mandatory`) で判る。`mandatory: true` のときは **`effort: "none"` を送ってはいけない (モデルが拒否する)**。
  > "**`mandatory`**: When `true`, hide disable controls and do not send `effort: \"none\"` — the model rejects it."
- 互換: `include_reasoning: true` は `reasoning: {}`、`include_reasoning: false` は `reasoning: { exclude: true }` と等価 (Deprecated alias)。
- **注意**: OpenAPI の `reasoning` スキーマには `effort` と `summary` しか列挙されていない (`max_tokens` / `exclude` / `enabled` はガイド側にのみ記載)。
- 出典: https://openrouter.ai/docs/guides/best-practices/reasoning-tokens 、https://openrouter.ai/docs/api_reference/parameters 、https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion

### 2-6. `usage: {include: true}`

- **廃止済み。効果は無い。** usage は常に自動で全応答に入る。`stream_options: {include_usage: true}` も同様。
- OpenAPI の `ChatRequest` の properties に `usage` は存在しない (`stream_options` は存在するが `include_usage` が `deprecated: true`)。
- 原文:
  > "**Deprecated Parameters** — The `usage: { include: true }` and `stream_options: { include_usage: true }` parameters are deprecated and have no effect. Full usage details are now always included automatically in every response."
  > (OpenAPI `ChatStreamOptions.include_usage`) `deprecated: true / description: "Deprecated: This field has no effect. Full usage details are always included."`
- 出典: https://openrouter.ai/docs/cookbook/administration/usage-accounting 、https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion

### 2-7. `provider` (プロバイダ選択)

ドキュメントの表をそのまま (型と既定値):

| Field | Type | Default | Description (原文) |
| --- | --- | --- | --- |
| `order` | string[] | - | "List of provider slugs to try in order (e.g. `[\"anthropic\", \"openai\"]`)." |
| `allow_fallbacks` | boolean | `true` | "Whether to allow backup providers when the primary is unavailable." |
| `require_parameters` | boolean | `false` | "Only use providers that support all parameters in your request." |
| `data_collection` | "allow" \| "deny" | "allow" | "Control whether to use providers that may store data." |
| `zdr` | boolean | - | "Restrict routing to only ZDR (Zero Data Retention) endpoints." |
| `enforce_distillable_text` | boolean | - | "Restrict routing to only models that allow text distillation." |
| `only` | string[] | - | "List of provider slugs to allow for this request." |
| `ignore` | string[] | - | "List of provider slugs to skip for this request." |
| `quantizations` | string[] | - | "List of quantization levels to filter by (e.g. `[\"int4\", \"int8\"]`)." |
| `sort` | string \| object | - | "Sort providers by price, throughput, or latency." |
| `preferred_min_throughput` | number \| object | - | "Preferred minimum throughput (tokens/sec)." |
| `preferred_max_latency` | number \| object | - | "Preferred maximum latency (seconds)." |
| `max_price` | object | - | "The maximum pricing you want to pay for this request." |

補足事実:

- `data_collection` の意味: "`allow`: (default) allow providers which store user data non-transiently and may train on it" / "`deny`: use only providers which do not collect user data"
- `order` を指定しても、それだけでは他プロバイダへのフォールバックは残る。閉じたいなら `allow_fallbacks: false` を併用。原文: "OpenRouter will try them one at a time and proceed to other providers if none are operational. If you don't want to allow any other providers, you should disable fallbacks as well."
- `sort` または `order` を設定すると既定のロードバランスは無効化される。原文: "If you have `sort` or `order` set in your provider preferences, load balancing will be disabled."
- `only` はアカウント設定の許可リストとの **AND**。どちらも満たすプロバイダが無いと 404。原文: "your account-wide allowed providers act as the ceiling, and the request's `only` list narrows within it. If no provider satisfies both, the request fails with a 404."
- `ignore` はアカウント設定の無視リストと **マージ** される。原文: "the list of ignored providers is merged with your account-wide ignored providers."
- 出典: https://openrouter.ai/docs/guides/routing/provider-selection

---

## 3. 応答の項目

**事実 — 正常応答の型 (API Reference の TypeScript 型そのまま)**

```
type Response = {
  id: string;
  choices: (NonStreamingChoice | StreamingChoice | NonChatChoice)[];
  created: number; // Unix timestamp
  model: string;
  object: 'chat.completion' | 'chat.completion.chunk';
  system_fingerprint?: string; // Only present if the provider supports it
  usage?: ResponseUsage;
};
```

- `id`: OpenAPI では "Unique completion identifier"。ドキュメントの例では `gen-xxxxxxxxxxxxxx` 形式 (`/api/v1/generation` に渡すのはこれ)。
- **`model` は「実際に答えたモデル」**。OpenAPI の説明は "Model used for completion"、API Reference の例には次のコメントが付いている:
  > `"model": "openai/gpt-4o" // Could also be "anthropic/claude-sonnet-4.6", etc, depending on the "model" that ends up being used`
- **`provider`**: 正常応答のスキーマ (OpenAPI `ChatResult`、および API Reference の `type Response`) には **記載が無い**。一方でドキュメント中の応答例 (debug チャンク、mid-stream エラーチャンク) には `"provider": "Anthropic"` / `"provider":"openai"` のようにトップレベルで現れる。
  → **常に入るという記載は未確認。** ルーティング結果を確実に取るには `X-OpenRouter-Metadata: enabled` を送って `openrouter_metadata` を受け取る方法がドキュメント化されている (`openrouter_metadata.requested` = 要求した slug、`endpoints.available[].provider` / `attempts[].provider` = 実際のプロバイダ)。
  > "`requested` | `string` | The model slug (or alias) the client sent. May differ from the provider/model that actually served the request."
- `choices[].finish_reason` と `native_finish_reason`:
  > "OpenRouter normalizes each model's `finish_reason` to one of the following values: `tool_calls`, `stop`, `length`, `content_filter`, `error`."
  > "Some models and providers may have additional finish reasons. The raw finish_reason string returned by the model is available via the `native_finish_reason` property."
  型は両方とも `string | null`。

**`usage` の型 (原文そのまま)**

```
type ResponseUsage = {
  prompt_tokens: number;      /** Including images, input audio, and tools if any */
  completion_tokens: number;  /** The tokens generated */
  total_tokens: number;       /** Sum of the above two fields */
  prompt_tokens_details?: {
    cached_tokens: number;        // Tokens cached by the endpoint
    cache_write_tokens?: number;  // Tokens written to cache (models with explicit caching)
    audio_tokens?: number;
    video_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;    // Tokens generated for reasoning
    audio_tokens?: number;
    image_tokens?: number;
  };
  cost?: number;              /** Cost in credits (optional) */
  is_byok?: boolean;
  cost_details?: {
    upstream_inference_cost?: number;
    upstream_inference_prompt_cost: number;
    upstream_inference_completions_cost: number;
    server_tool_cost?: number | null;
  };
  server_tool_use?: { web_search_requests?: number };
};
```

- `cached_tokens` は**読んだ**キャッシュトークン数、`cache_write_tokens` は**書いた**トークン数。原文: "`cached_tokens` is the number of tokens that were *read* from the cache. `cache_write_tokens` is the number of tokens that were *written* to the cache".
- `cost` = "The total amount charged to your account"、`cost_details.upstream_inference_cost` = "The actual cost charged by the upstream AI provider"。
- 非ストリーミングでは常に返る。ストリーミングでは **`[DONE]` 直前の最終チャンクにちょうど 1 回**入り、そのチャンクの `choices` は空ではなく、内容の無い delta で finish_reason を繰り返す。
  > "Usage data is always returned for non-streaming. When streaming, usage is returned exactly once in the final chunk before the [DONE] message. Unlike OpenAI's spec, this chunk contains a non-empty choices array: a choice with a content-free delta that repeats the finish_reason of the stream."

**エラーの形**

```
type ErrorResponse = {
  error: {
    code: number;
    message: string;
    metadata?: Record<string, unknown>;
  };
};
```

- HTTP ステータスは `error.code` と同じになる — ただしそれは「要求自体が不正」「クレジット切れ」のとき。それ以外は **HTTP 200 を返し、エラーは本文または SSE イベントに入る**。
  > "The HTTP Response will have the same status code as `error.code`, forming a request error if: Your original request is invalid / Your API key/account is out of credits. Otherwise, the returned HTTP response status will be 200 and any error occurred while the LLM is producing the output will be emitted in the response body or as an SSE data event."
  > "Non-streaming requests send the status at the same point. If the provider returns headers and then fails, you receive a `200 OK` whose JSON body holds only an `error` object and no `choices` ... Check the body for an `error` field even on a `200`, rather than relying on the status alone."
- ステータスの意味 (原文):
  - 400: "Bad Request (invalid or missing params, CORS)"
  - 401: "Invalid credentials (OAuth session expired, disabled/invalid API key)"
  - 402: "Your account or API key has insufficient credits. Add more credits and retry the request."
  - 403: "Forbidden (insufficient permissions, guardrail block, or moderation flag)"
  - 408: "Your request timed out"
  - 429: "You are being rate limited"
  - 502: "Your chosen model is down or we received an invalid response from it"
  - 503: "There is no available model provider that meets your routing requirements"
- `error.metadata.error_type` に正規化済みの型付きコードが入る (Chat Completions の場合)。主な値と対応 HTTP: `context_length_exceeded`/`max_tokens_exceeded`/`token_limit_exceeded`/`string_too_long`→400、`authentication`→401、`permission_denied`→403、`payment_required`→402、`rate_limit_exceeded`→429、`provider_overloaded`→503、`provider_unavailable`→502、`invalid_request`/`invalid_prompt`→400、`not_found`→404、`content_policy_violation`/`refusal`→403、`server`/`unmapped`→500、`timeout`→504。
  > "Use this value, not the HTTP status code alone, to programmatically distinguish error categories."
- 非 500 のときは上流プロバイダ自身のコードが `error.metadata.provider_code` に出る。500 のときは message が汎用文字列に差し替えられ `provider_code` は省かれる。
- モデレーションで弾かれたときの `error.metadata` の形:
  ```
  type ModerationErrorMetadata = {
    reasons: string[];
    flagged_input: string; // limited to 100 characters
    provider_name: string;
    model_slug: string;
  };
  ```
- ストリーム開始後のエラーは HTTP 200 のまま SSE の `error` を含むチャンクで届き、`choices[].finish_reason` は `"error"`、そこでストリームは終了する。ストリームが始まったあとはフェイルオーバーしない。
  > "Failover also stops once part of the answer has reached you, since your application already holds output from the first provider."
- 出典: https://openrouter.ai/docs/api_reference/overview 、https://openrouter.ai/docs/api_reference/errors-and-debugging 、https://openrouter.ai/docs/guides/features/router-metadata 、https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion

---

## 4. `google/gemini-3.8-flash`

### 4-1. `GET https://openrouter.ai/api/v1/models` の該当エントリ (そのまま写し)

```json
{
  "id": "google/gemini-3.8-flash",
  "canonical_slug": "google/gemini-3.8-flash-20260902",
  "name": "Google: Gemini 3.8 Flash",
  "created": 1788362056,
  "context_length": 1048576,
  "architecture": {
    "modality": "text+image+file+audio+video->text",
    "input_modalities": ["text", "image", "video", "file", "audio"],
    "output_modalities": ["text"],
    "tokenizer": "Gemini",
    "instruct_type": null
  },
  "pricing": {
    "prompt": "0.00000075",
    "completion": "0.00000375",
    "image": "0.00000075",
    "audio": "0.00000075",
    "input_audio_cache": "0.000000075",
    "web_search": "0.014",
    "internal_reasoning": "0.00000375",
    "input_cache_read": "0.000000075",
    "input_cache_write": "0.0000000416666666666667"
  },
  "top_provider": {
    "context_length": 1048576,
    "max_completion_tokens": 65536,
    "is_moderated": false
  },
  "per_request_limits": null,
  "supported_parameters": [
    "include_reasoning",
    "max_tokens",
    "reasoning",
    "reasoning_effort",
    "response_format",
    "seed",
    "stop",
    "structured_outputs",
    "temperature",
    "tool_choice",
    "tools",
    "top_p"
  ],
  "default_parameters": {},
  "knowledge_cutoff": null,
  "expiration_date": null,
  "links": { "details": "/api/v1/models/google/gemini-3.8-flash-20260902/endpoints" },
  "reasoning": {
    "mandatory": true,
    "default_enabled": true,
    "supported_efforts": ["high", "medium", "low"],
    "default_effort": "medium"
  }
}
```

(`benchmarks` フィールドも存在する — `design_arena` の 7 件と `artificial_analysis: {intelligence_index: 41.2, coding_index: 76.3, agentic_index: 41.1}`。設計には効かないので省略せず存在だけ記す。)

**重要な読み取り**

- `reasoning.mandatory: true` かつ `default_enabled: true`。ガイドの規定により **`reasoning.effort: "none"` を送ってはいけない (モデルが拒否する)**。思考は止められない。
- `supported_efforts` は `["high","medium","low"]` の 3 段階のみ。`minimal` / `xhigh` / `max` は含まれない。
- `supported_parameters` に **`temperature` は含まれる**。`top_k`、`frequency_penalty`、`presence_penalty`、`logprobs` は含まれない。
- `supports_max_tokens` は出ていない → ガイドの規定では「このモデルは token-budget reasoning に対応していない」ことを意味する ("Omitted when the model does not support token-budget reasoning.")。
- `default_parameters` は空オブジェクト `{}` (推奨既定値の提示は無い)。

### 4-2. `:batch` 版

存在する。`id` は `google/gemini-3.8-flash:batch`、`name` は `"Google: Gemini 3.8 Flash (batch)"`。`canonical_slug` / `context_length` / `architecture` / `top_provider` / `reasoning` は非 batch 版と同一。異なるのは 2 点:

```json
"pricing": {
  "prompt": "0.000000375",
  "completion": "0.000001875",
  "image": "0.000000375",
  "audio": "0.000000375",
  "input_audio_cache": "0.0000000375",
  "web_search": "0.014",
  "internal_reasoning": "0.000001875",
  "input_cache_read": "0.0000000375",
  "input_cache_write": "0.0000000416666666666667"
},
"supported_parameters": [
  "include_reasoning", "max_tokens", "reasoning", "reasoning_effort",
  "response_format", "seed", "stop", "structured_outputs", "tool_choice", "tools"
]
```

- 料金はトークン系がちょうど半額 (`input_cache_write` と `web_search` は同額)。Batch API のドキュメントの記述と整合する: "Batch requests are typically billed at 50% of the model's standard per-token pricing" / "Non-token pricing components aren't uniformly discounted."
- `supported_parameters` から **`temperature` と `top_p` が消えている**。
- `:batch` を `/chat/completions` の `model` にそのまま渡せるかは **ドキュメントに記載が見つからない = 未確認**。ドキュメント化されている使い方は Batch API (`endpoint` / `model` / `requests` を送る非同期エンドポイント、完了ウィンドウは 24h のみ、テキスト専用)。なお UI については "`:batch` endpoints are not usable interactively, so the picker hides their rows." という記述がある。`:free` `:extended` `:exacto` `:thinking` `:online` `:nitro` `:floor` には個別の Variant ドキュメントがあるが、`:batch` には無い。

### 4-3. 料金フィールドの単位

> "All pricing values are in USD per token/request/unit. A value of `\"0\"` indicates the feature is free."
> "`prompt`: Cost per input token / `completion`: Cost per output token / `input_cache_read`: Cost per cached input token read / `input_cache_write`: Cost per cached input token write / `internal_reasoning`: Cost for internal reasoning tokens"

また `top_provider.max_completion_tokens` について:
> "Input and output tokens share the model's context window, so `max_completion_tokens` is a ceiling for `max_tokens`, not a guaranteed output size."

### 4-4. モデルページ (https://openrouter.ai/google/gemini-3.8-flash) の記載

- 見出し: "Google: Gemini 3.8 Flash" / "google / gemini-3.8-flash"
- "Price 50% off $0.75 / $3.75 per 1M" / "Context 1.0M" / "Released Sep 2, 2026"
- FAQ: "Gemini 3.8 Flash costs $0.75/M input tokens and $3.75/M output tokens, with separate rates for Cache Read at $0.075/M tokens, Cache Write at $0.04167/M tokens, Image Input at $0.75/M tokens, Input Audio at $0.75/M tokens, Input Audio Cache at $0.075/M tokens and Web Search at $14.00/1K calls."
- FAQ: "Gemini 3.8 Flash has a 1,048,576 token context window. It supports up to 65,536 completion tokens."
- FAQ: "Yes. Gemini 3.8 Flash accepts tools and tool_choice for function calling. It also supports structured outputs via a JSON schema in response_format."
- FAQ: "Gemini 3.8 Flash is served by 2 providers on OpenRouter: Google AI Studio and Google Vertex."
- ページ上のプロバイダ表には `Google AI Studio Flex` / `Google AI Studio` / `Google Vertex` / `Google AI Studio Priority` / `Google Vertex Priority` / `Google Vertex Flex` の 6 行があり、表示価格 (Input/Output /M) は $0.75/$3.75 から $2.70/$13.50 まで**エンドポイントごとに異なる**。`/api/v1/models` の `pricing` はドキュメント上 "Pricing from the top provider for this model" と定義されており、この最安行と一致している。
- 出典: https://openrouter.ai/google/gemini-3.8-flash 、https://openrouter.ai/api/v1/models 、https://openrouter.ai/docs/guides/overview/models 、https://openrouter.ai/docs/batch-quickstart

---

## 5. データの扱い

### 5-1. OpenRouter 自身の保存

**事実**: 既定では OpenRouter はプロンプトも応答も保存しない。保存するのは**オプトインしたときだけ**で、2 種類ある。

> "OpenRouter does not store your prompts or responses, *unless* you opt in to one or both of the following:"
> "**Private Input & Output Logging:** Make your prompts and completions visible in your logs for debugging, comparing model responses, and optimizing prompts. OpenRouter does not access or use this data. For organizations, only admins can view logged data. **Off by default.** Enable it in your Observability settings."
> "**OpenRouter Use of Inputs/Outputs:** Allow OpenRouter to use your prompt and completion data to improve the product. In exchange, you receive a 1% discount on all model usage. **Off by default.** Enable it in your Privacy settings."
> "Any prompt retention on OpenRouter is always opt-in. OpenRouter has never shared, sold, or licensed underlying prompt data to any third party."
> "OpenRouter itself has a ZDR policy; your prompts are not retained unless you specifically opt in to prompt logging."

- ただし**メタデータは常に保存される**: "OpenRouter does store metadata (e.g. number of prompt and completion tokens, latency, etc) for each request. ... This metadata does not include the content of your prompts or responses, only information about the request itself."
- 匿名カテゴリ分類: "OpenRouter samples a small number of prompts for categorization... If you are not opted in to OpenRouter use of inputs/outputs, any categorization of your prompts is stored completely anonymously and never associated with your account or user ID. The categorization is done by model with a zero-data-retention policy."
- 出典: https://openrouter.ai/docs/guides/privacy/data-collection 、https://openrouter.ai/docs/guides/features/zdr

### 5-2. プロバイダ側の学習利用と `provider.data_collection: "deny"`

- 各プロバイダは独自のポリシーを持ち、OpenRouter はそれを構造化データとして持っている。アカウント設定で「学習しうるプロバイダへのルーティングを許すか」を有料モデル/無料モデル別に設定できる。オプトアウトするとそのプロバイダへはルーティングされない。
  > "On your account settings page, you can set whether you would like to allow routing to providers that may train on your data (according to their own policies). There are separate settings for paid and free models."
  > "If you opt out of training in your account settings, OpenRouter will not route to providers that train. This setting has no bearing on OpenRouter's own policies and what we do with your prompts."
- 要求単位では `provider.data_collection`:
  > "`allow`: (default) allow providers which store user data non-transiently and may train on it"
  > "`deny`: use only providers which do not collect user data"
- 出典: https://openrouter.ai/docs/guides/privacy/provider-logging 、https://openrouter.ai/docs/guides/routing/provider-selection

### 5-3. ZDR と `provider.zdr`

- 定義: "Zero Data Retention (ZDR) means that a provider will not store your data for any period of time."
- 保存しないプロバイダは学習もできない。ただし「学習はしないが保存はする」エンドポイントは存在し、両方を別々に制御できる。
  > "Providers that do not retain your data are also unable to train on your data. However we do have some endpoints & providers who do not train on your data but *do* retain it (e.g. to scan for abuse or for legal reasons). OpenRouter gives you controls over both of these policies."
- 要求単位の `provider.zdr: true` は、アカウント設定・guardrail 設定との **OR**。つまり**有効化しかできず、無効化には使えない**。
  > "The request-level `zdr` parameter operates as an \"OR\" with your account-wide and guardrail ZDR settings. If any is enabled, ZDR enforcement will be applied. This means the per-request parameter can only be used to ensure ZDR is enabled for a specific request, not to override or disable account-wide or guardrail enforcement."
  > "When `zdr` is set to `true`, the request will only be routed to endpoints that have a Zero Data Retention policy."
- アカウント設定の ZDR はモデル群ごと (Anthropic / OpenAI / Google / SpaceXAI / All other models) に独立トグル。**Google 群で有効にすると AI Studio のエンドポイントが外れ、Vertex が残る**: "**Google** | Removes AI Studio endpoints (Vertex remains available)"
- ポリシー不明のときは保守的に「保存も学習もする」と見なす: "If OpenRouter is not able to establish or ascertain a clear policy for a provider or endpoint, we take a conservative stance and assume that the endpoint both retains and trains on data and mark it as such."
- 暗黙キャッシュは「保存」に当たらない扱い: "OpenRouter has taken the stance that in-memory caching of prompts is *not* considered \"retaining\" data, and we therefore allow endpoints/models with implicit caching to be hit when a ZDR routing policy is in effect."
- ZDR はプラグイン/ツール (web search 等) には及ばない: "ZDR enforcement only applies to provider routing for inference requests. It does not apply to plugins and tools you choose to enable".
- ZDR エンドポイント一覧は `https://openrouter.ai/api/v1/endpoints/zdr` で機械的に取れると明記されている (今回は呼んでいない)。
- 出典: https://openrouter.ai/docs/guides/features/zdr

### 5-4. Privacy Policy / Terms の該当箇所

Privacy Policy (Last Updated: August 31, 2026) — https://openrouter.ai/privacy

> "OpenRouter does not use your Inputs or Outputs for model training."
> "When you submit Inputs through the Service, those Inputs are transmitted to the Model Provider you select, or that is selected through automatic routing, as applicable. Different Model Providers have different data practices, including with respect to whether they retain or use your Inputs and Outputs to train, fine-tune, evaluate, or improve their Models. Some Model Providers may use your Inputs and Outputs for model training or improvement. ... If you do not want your Inputs used for model training, select a Model or Model Provider that commits to not using your data for that purpose."
> "We do not control, and are not responsible for, LLMs' handling of your Inputs or Outputs, including for use in their model training."
> "We contractually require Model Providers to comply with applicable data protection laws, but the Model Provider's own terms govern their independent use of your data to the extent permitted by our agreements."

Terms of Service (Last Updated: August 31, 2026) — https://openrouter.ai/terms

> "Some Models may store or train on your Inputs for improving their own large language models and may allow you to opt-out of model training, as described in their Model Terms. Where possible, OpenRouter has opted out of model training with the Models it uses. OpenRouter strives to accurately represent the status of prompt logging and training for each Model on our Site. However, OpenRouter is not liable for errors or misrepresentations made in any Model Terms."
> (6.2 Opt-In License for Prompt and Chat Logging) "If you have opted into prompt logging in your account settings, chat logging is also automatically enabled, and you grant OpenRouter a worldwide, perpetual, irrevocable, non-exclusive, royalty-free ... license ... for purposes of providing the Services to you and for our own commercial and business purposes."
> (6.5 License to Categorize Inputs) "Unless explicitly opted in to prompt logging, we do not store your Inputs after categorizing them and do not associate the categorized Inputs with any specific user or organizational accounts."
> "OPENROUTER MAKES NO REPRESENTATION OR WARRANTY REGARDING ANY MODEL PROVIDER'S DATA HANDLING, RETENTION, TRAINING, SECURITY, AVAILABILITY, OR INTELLECTUAL PROPERTY PRACTICES."

- **注意**: プロンプトログを有効にした場合の Terms 6.2 の許諾は「OpenRouter 自身の商業目的」を含む文言になっている。Data Collection ページの「Private Input & Output Logging」の説明 ("OpenRouter does not access or use this data") とは書きぶりが異なる。両方を併記しておく。

---

## 6. API キーの管理

**事実**

- 作成場所: https://openrouter.ai/keys 。名前を付け、任意で credit limit を設定できる。
  > "To use an API key, first create your key. Give it a name and you can optionally set a credit limit."
- 既存キーの管理 (削除・再作成) は https://openrouter.ai/settings/keys 。
- キーごとに設定できるもの (API 経由での作成時の request body。**API 経由の作成には management key が必要**):
  - `name` (必須)
  - `limit`: "Optional spending limit for the API key in USD" (number | null)
  - `limit_reset`: enum `daily` / `weekly` / `monthly` / null。"Resets happen automatically at midnight UTC, and weeks are Monday through Sunday."
  - `expires_at`: "Optional ISO 8601 UTC expiration timestamp. Must include seconds (YYYY-MM-DDTHH:MM:SSZ; fractional seconds allowed); minute-precision timestamps are rejected."
  - `include_byok_in_limit`, `workspace_id`, `creator_user_id`, `external`
  - 平文の `key` は作成応答でしか返らない: "The plaintext `key` is returned only in this response. Treat it as a write-only, sensitive value; it cannot be retrieved later."
- **残高・上限の読み出しは `GET https://openrouter.ai/api/v1/key`** (自分自身のキーで Bearer 認証。management key は不要)。`/auth/key` という綴りはドキュメントには無い。
  > "To check the rate limit or credits left on an API key, make a GET request to `https://openrouter.ai/api/v1/key`."
- 応答の形 (Limits ページの TypeScript 型そのまま):
  ```
  type Key = {
    data: {
      label: string;
      limit: number | null;          // Credit limit for the key, or null if unlimited
      limit_reset: string | null;    // Type of limit reset for the key, or null if never resets
      limit_remaining: number | null;// Remaining credits for the key, or null if unlimited
      include_byok_in_limit: boolean;
      usage: number;                 // Number of credits used (all time)
      usage_daily: number;           // current UTC day
      usage_weekly: number;          // current UTC week, starting Monday
      usage_monthly: number;         // current UTC month
      byok_usage: number; byok_usage_daily: number; byok_usage_weekly: number; byok_usage_monthly: number;
      is_free_tier: boolean;
      // rate_limit: { ... } // A deprecated object in the response, safe to ignore
    };
  };
  ```
  OpenAPI 側はこれに加えて `creator_user_id`, `expires_at` ("ISO 8601 UTC timestamp when the API key expires, or null if no expiration"), `is_management_key`, `is_provisioning_key` (deprecated) を持つ。`rate_limit` は `deprecated: true` で "Legacy rate limit information about a key. Will always return -1."
- 出典: https://openrouter.ai/docs/api_reference/authentication 、https://openrouter.ai/docs/api_reference/limits 、https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key 、https://openrouter.ai/docs/api/api-reference/api-keys/create-a-new-api-key

---

## 7. 料金の照会 (`GET /api/v1/generation?id=<id>`)

**事実**

- `GET https://openrouter.ai/api/v1/generation` にクエリ `id` (必須、例 `gen-1234567890`) を渡すと 1 回分のメタデータが取れる。応答は `{ "data": { ... } }`。
- 応答例に含まれるフィールド (OpenAPI の example そのまま、抜粋):
  ```yaml
  data:
    id: gen-3bhGkxlo4XFrqiabUM7NDtwDzWwG
    model: sao10k/l3-stheno-8b
    provider_name: Infermatic
    finish_reason: stop
    native_finish_reason: stop
    streamed: true
    is_byok: false
    created_at: '2024-07-15T23:33:19.433273+00:00'
    latency: 1250           # Total latency in milliseconds
    generation_time: 1200
    moderation_latency: 50
    tokens_prompt: 10
    tokens_completion: 25
    native_tokens_prompt: 10
    native_tokens_completion: 25
    native_tokens_cached: 3
    native_tokens_reasoning: 5
    total_cost: 0.0015      # Total cost of the generation in USD
    usage: 0.0015           # Usage amount in USD
    upstream_inference_cost: 0.0012  # Cost charged by the upstream provider
    cache_discount: null    # Discount applied due to caching
    upstream_id: chatcmpl-791bcf62-...
    app_id: 12345
    http_referer: https://openrouter.ai/
    data_region: global
    service_tier: priority
    router: openrouter/auto
    api_type: completions
    cancelled: false
  ```
  必須フィールドに `total_cost` / `cache_discount` / `upstream_inference_cost` が含まれる。
- `usage.cost` との関係: 応答本文の `usage` と同じ情報を**非同期にも**取れる、という位置づけ。
  > "You can also retrieve usage information asynchronously by using the generation ID returned from your API calls. This is particularly useful when you want to fetch usage statistics after the completion has finished or when you need to audit historical usage."
  > "You can also use the returned `id` to query for the generation stats (including token counts and cost) after the request is complete via the `/api/v1/generation` endpoint."
  > "When obtaining usage information via generation ID, the `upstream_inference_cost` field is only available for BYOK (Bring Your Own Key) requests. For all other requests it will be 0 or null."
- **`usage.cost` と `total_cost` / `usage` (生成メタデータ側) が同一値であるという明示的な記述は見つからない = 未確認。** ドキュメント上はどちらも「OpenRouter が課金する額」の説明だが (応答本文側: "`cost`: The total amount charged to your account"、生成側: "`total_cost`: Total cost of the generation in USD")、等価だとは書かれていない。
- 別エンドポイントとして「Get stored prompt, completion, and error content for a generation」があるが、これは本文を返すもの。今回は呼んでいない。
- 出典: https://openrouter.ai/docs/api/api-reference/generations/get-request-&-usage-metadata-for-a-generation 、https://openrouter.ai/docs/cookbook/administration/usage-accounting 、https://openrouter.ai/docs/api_reference/overview

---

## 8. レート制限と再試行

**事実**

- OpenRouter は 2 種類の制限を持つ:
  - Credit limits (残高とキーごとの上限) → 超過は **402**。確認先は `GET /api/v1/key` の `limit_remaining`。
  - Rate limits (回数) → 超過は **429**。確認先はエラー応答の `X-RateLimit-*` ヘッダ。
- 無料モデル (`:free`) にのみ、明示的な回数上限がある: 生涯購入クレジット 10 未満なら **20 RPM / 50 RPD**、10 以上なら **20 RPM / 1000 RPD**。加えて Cloudflare の DDoS 保護。**有料モデルについての具体的な RPM/RPD 数値はドキュメントに無い = 未確認** ("switch to the paid variant of the model, which has no platform-level request cap.")。
- アカウントやキーを増やしてもレート制限は変わらない: "Making additional accounts or API keys will not affect your rate limits, as we govern capacity globally."
- 429 は 2 箇所から来る: OpenRouter 自身のプラットフォーム制限と、上流プロバイダ。後者は `error.metadata.provider_code` に元コードが載り、フォールバックが自動で他プロバイダを試したあとに届く。
- ヘッダ:
  > "Successful inference responses do not include `X-RateLimit-*` headers. When OpenRouter itself returns a 429 error for a platform limit, the error response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` headers describing the limit that was hit. When every attempted provider returned a retry hint, the error response also carries a `Retry-After` header."
  > "On 429 and 503 responses, OpenRouter may include a standard HTTP `Retry-After` response header indicating how many seconds to wait before retrying."
- 推奨される再試行:
  > "**Retry with exponential backoff.** Rate limits are transient; wait and retry rather than immediately re-sending. Honor the `Retry-After` header when present."
  > "The OpenAI SDK, Anthropic SDK, Vercel AI SDK, and OpenRouter SDK already respect this header for backoff. If you're using `fetch` directly, honor it before retrying"
- 内容が生成されないことがある (コールドスタート/スケールアップ)。"consider implementing a simple retry mechanism or trying again with a different provider or model"。ただし "In some cases, you may still be charged for the prompt processing cost by the upstream provider, even if no content is generated."
- ストリーム開始後のレート制限は HTTP 429 ではなく SSE の `finish_reason: "error"` として届く。
- 出典: https://openrouter.ai/docs/api_reference/limits 、https://openrouter.ai/docs/api_reference/errors-and-debugging

---

## 9. OpenAI 互換の範囲

**事実**

- 位置づけ: "OpenRouter's request and response schemas are very similar to the OpenAI Chat API, with a few small differences. At a high level, **OpenRouter normalizes the schema across models and providers** so you only need to learn one." / OpenAPI の info.description は "OpenAI-compatible API with additional OpenRouter features"。
- OpenAI SDK は `baseURL`/`base_url` を `https://openrouter.ai/api/v1` に、`apiKey` を OpenRouter のキーにするだけで使える (公式に TypeScript / Python の例あり)。
- **OpenRouter 独自のボディ項目** (OpenAI SDK からは `extra_body` などで渡す必要がある): `models`, `route`, `provider`, `plugins`, `reasoning`, `transforms` 系、`debug` など。Python の例に "pass extra_body to access OpenRouter-only arguments." と明記。
- **応答が OpenAI と異なる点**:
  - `choices[]` に `native_finish_reason` が追加される。
  - `usage` に `cost` / `cost_details` / `is_byok` / `prompt_tokens_details.cache_write_tokens` 等が追加される。
  - ストリーミング時の usage チャンクの形が OpenAI 仕様と異なる: "Unlike OpenAI's spec, this chunk contains a non-empty choices array".
  - 生成が始まったあとのエラーは HTTP ステータスではなく本文/SSE に入る (HTTP 200 のまま)。
  - `X-OpenRouter-Metadata: enabled` を付けると `openrouter_metadata` が増える。
- **意味が違う/効かない項目**:
  - `usage: {include: true}`、`stream_options: {include_usage: true}` — **効果なし** (常に usage が入る)。
  - `max_tokens` — OpenAPI 上 deprecated (`max_completion_tokens` を推奨)。
  - 会話途中で reasoning effort を変える書き方は "The Chat Completions form is an OpenRouter extension, since OpenAI's own Chat Completions API has no per-message equivalent."
  - モデルが対応しない項目は黙って無視される (`logit_bias`、`top_k` 等)。
- Anthropic Messages (`/api/v1/messages`)、OpenAI Responses (`/api/v1/responses`) の skin も提供されており、エラーの表現形がそれぞれ異なる。
- 出典: https://openrouter.ai/docs/api_reference/overview 、https://openrouter.ai/docs/guides/community/openai-sdk 、https://openrouter.ai/docs/api_reference/errors-and-debugging 、https://openrouter.ai/docs/cookbook/administration/usage-accounting 、https://openrouter.ai/docs/guides/features/router-metadata

---

## 10. Gemini 3 系の `temperature` 推奨 (Google 側の 1.0) について

**未確認。**

- OpenRouter のドキュメント全文 (`https://openrouter.ai/docs/llms-full.txt`、約 3.9 MB) を `temperature` と `Gemini 3` で走査したが、「Gemini 3 系では temperature を 1.0 にすべき」といった趣旨の記述は**見つからなかった**。
- Gemini 3 について OpenRouter が書いているのは reasoning (thinkingLevel / thinkingBudget) の扱いのみ (項目 2-5 参照)。
- `temperature` に関して OpenRouter が書いているのは一般論のみ:
  > "* Key: `temperature` * Optional, **float**, 0.0 to 2.0 * Default: 1.0"
  > "When a sampling parameter is absent from your request, OpenRouter omits it upstream rather than substituting a hardcoded value, so the provider applies its own default."
- また `GET /api/v1/models` の `google/gemini-3.8-flash` の `default_parameters` は `{}` で、推奨既定値の提示は無い。
- したがって「OpenRouter 経由でも Google 側の推奨を守る必要があるか」に対する OpenRouter 公式の回答は存在しない。ただし上の引用から確実に言える事実は 1 つだけ: **`temperature` を送らなければ OpenRouter は上流に転送しないので、Google 側の既定値が適用される。**
- 出典: https://openrouter.ai/docs/api_reference/parameters 、https://openrouter.ai/docs/guides/best-practices/reasoning-tokens 、https://openrouter.ai/api/v1/models

---

## 設計に効く要点

(1〜5 は上で確認した事実の要約、6〜10 は調査者の意見)

1. [事実] 実際に答えたモデルは応答本文の `model`、実際のプロバイダは `X-OpenRouter-Metadata: enabled` で付く `openrouter_metadata` から取る。トップレベル `provider` は応答スキーマに無い。
2. [事実] `google/gemini-3.8-flash` は `reasoning.mandatory: true`。思考は止められず、`effort: "none"` は拒否される。effort は high/medium/low の 3 値のみ、既定 medium。
3. [事実] reasoning トークンは出力トークンとして課金され、`usage.completion_tokens_details.reasoning_tokens` に出る。応答に載せたくないだけなら `reasoning.exclude: true` (課金は減らない)。
4. [事実] `usage` は常に自動で入る。`usage: {include: true}` は書いても無意味なので実装しない。費用は `usage.cost` (credits) で毎回取れる。
5. [事実] データ保持は OpenRouter 側が既定オフ、プロバイダ側は `provider.data_collection: "deny"` と `provider.zdr: true` で要求単位に絞れる。`zdr` は OR なので有効化専用。Google 群で ZDR を強制すると AI Studio が落ちて Vertex だけになる。
6. [意見] `max_tokens` は OpenAPI で deprecated なので、justic では `max_completion_tokens` を送り、上限は `top_provider.max_completion_tokens` (65536) から取るのが素直。
7. [意見] 構造化出力を使うなら `provider.require_parameters: true` を併用しないと、非対応エンドポイントに落ちて `response_format` が無視されうる。
8. [意見] エラー判定は HTTP ステータスだけで分けず、200 でも本文の `error` を見る。分岐は `error.metadata.error_type` を使う (ステータスより安定)。
9. [意見] 再試行は `Retry-After` を守る指数バックオフに限る。ストリーム開始後はフォールバックが効かないので、リトライは呼び出し側の責任になる。
10. [意見] `temperature` は「送らない」を既定にすると Google の既定が効く。値を固定したい設計なら、それは justic 側の方針として明記する (OpenRouter の推奨は存在しない)。
