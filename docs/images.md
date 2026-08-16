# Images

Framework-free image generation: OpenAI edit/generate, an optional Cloudinary
upload with a cache-before-spend check, and an optional caption helper.
Published as a subpath so the core install is unaffected by it:

```ts
import {
  resolveImageConfig,
  createOpenAIImageClient,
  createImageGenerator,
  resolveCloudinaryConfig,
  createCloudinaryUploadClient,
  createTursoImageCacheStore,
  createImageUploader,
} from "@diegoaltoworks/chatter/images";
```

Nothing in this module is chat-, persona- or bot-specific, and it adds no
required dependencies - the OpenAI client reuses the `openai` peer dependency
chatter already has, and the Cloudinary client talks to Cloudinary's signed
upload API over plain `fetch`, so no SDK is needed. **Prompt composition is
entirely the caller's job.** `ImageRequest.prompt` arrives fully composed;
this module holds no prompt templates, style rules or character content.

## Generating an image

```ts
const config = resolveImageConfig(process.env);
const generator = createImageGenerator(config, { client: createOpenAIImageClient(config) });

if (!generator.isConfigured()) {
  // no OPENAI_API_KEY - feature is off, server still boots
}

const image = await generator.generateImage({ prompt: composeYourOwnPrompt(request) });
// image.imageBytes, image.b64
```

A request with neither `baseImage` nor `inputImages` calls a pure
text-to-image generate; supplying either calls an edit instead, with input
photos sent ahead of the base image. Both are `{ bytes: Uint8Array, mimeType?:
string }` - `mimeType` defaults to `image/png`, so set it explicitly for a
JPEG or WebP photo. Failures come back as a typed `ImageGenerationError` with
one of four codes: `not_configured`, `invalid_request` (empty prompt),
`moderation`, or `api_error`.

`IMAGE_MODEL` defaults to a GPT image model (`gpt-image-1`), which always
returns base64 and ignores `response_format`. Pointing it at a DALL-E model
(`dall-e-2`/`dall-e-3`) works too - the client sets `response_format:
"b64_json"` automatically in that case - but their `quality` values differ
(`standard`/`hd` rather than `low`/`medium`/`high`), so set `IMAGE_QUALITY`
accordingly if you switch models.

## Cache-before-spend upload

`createImageUploader` hashes the request (prompt plus any base/input image
bytes) into a deterministic key **before** any paid work happens, checks it
against a cache, and only reaches the generator and Cloudinary on a miss or an
expired entry:

```ts
const cloudinaryConfig = resolveCloudinaryConfig(process.env);
const uploader = createImageUploader(cloudinaryConfig, {
  generator,
  uploadClient: createCloudinaryUploadClient(cloudinaryConfig),
  cacheStore: createTursoImageCacheStore(deps.db, "image_cache"),
});

const { url, cached } = await uploader.getOrCreateImage(request);
```

Call `uploader.peekCached(request)` first if you want to skip a
[usage](./usage.md) spend-guard reservation on a cache hit - a cached result
costs nothing, so it must never touch a daily cap:

```ts
import { createDailyLimiter, createTursoUsageStore, pickDailyLimit } from "@diegoaltoworks/chatter/usage";

const limiter = createDailyLimiter(
  { perKeyDailyLimit: pickDailyLimit(process.env.IMAGE_LIMIT_PER_DAY, 5), globalDailyLimit: 200 },
  { store: createTursoUsageStore(deps.db, "image_usage") },
);

if (!(await uploader.peekCached(request))) {
  const check = await limiter.checkAndReserve(senderId);
  if (!check.allowed) {
    // tell the caller they're over quota
  }
}
const { url } = await uploader.getOrCreateImage(request);
```

This module ships its own cache (deterministic keying is an images concern)
but no spend limiter of its own - compose with `./usage`, which already has
one.

`createTursoImageCacheStore(client, tableName)` is the shipped cache binding:
same idempotent-table-creation and plain-identifier-only table name pattern
as `./usage`'s Turso store. Any other backing store works too - `ImageCacheStore`
is a two-method structural interface (`get`/`set`). It does not prune expired
rows itself - an entry past `CACHE_TTL_MS` is simply treated as a miss and
overwritten on the next regenerate; a host that wants the table bounded should
sweep old rows on its own schedule.

## Configuration

`resolveImageConfig(env, overrides?)` reads `OPENAI_API_KEY`, `IMAGE_MODEL`,
`IMAGE_SIZE`, `IMAGE_QUALITY` (all optional, with `gpt-image-1` /
`1024x1024` / `medium` defaults). `isImageConfigured(config)` is false without
an API key.

`resolveCloudinaryConfig(env, overrides?)` reads `CLOUDINARY_CLOUD_NAME`,
`CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `CLOUDINARY_FOLDER`.
`isCloudinaryConfigured(config)` is false unless all three credentials are
set. Neither resolver touches `process.env` itself - a host passes an
env-shaped record in, which keeps the module liftable and lets tests describe
configured and unconfigured worlds without touching the real environment.

## Captions

`createCaptionComposer` is an optional helper for a caption to send alongside
a generated image. It ships no content - the pool and the compose step are
both caller-supplied:

```ts
const captions = createCaptionComposer({
  pool: ["Here's your {subject}.", "One {subject}, delivered."],
  compose: async (request) => {
    const { content } = await completeOnce({ client, system: yourPersonaLayer, messages: [...] });
    return content;
  },
});

await captions.composeCaption({ subject: "a cat" });
```

`composeCaption` races `compose` against a timeout (default 8s), and falls
back to `randomCaption` on a timeout, a thrown error, an empty result, or a
result over 300 characters. It never throws. `randomCaption` alone is
zero-cost and always available for a caller that has no LLM step to offer.
