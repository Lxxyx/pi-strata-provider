# Локальный форк pi-strata-provider: починить под Strata 0.1.63

## Root cause (замерено на живой машине, не догадка)

Strata 0.1.63 на Windows поднимает **два** HTTP-лица:

| Лицо | Порт | Что отдаёт |
|---|---|---|
| host gateway (`F:\strata\win\host\server\index.mjs`) | 8080 | `/v1/*` (chat/completions, models), `/api/native*`, `/api/*` управления. **Нет** `/props`, `/health`, `/models`, `/api/models`, `/api/version` |
| engine (`strata_cli.serve.server`) | 18500 (динамический) | `/v1/*`, **`/props`**, `/health`, `/slots` — со своим ключом из `~/.strata/data/native-instances/<id>.json` |

Замеры:

- `GET 127.0.0.1:8080/props` → **404** `{"error":"No route for GET /props"}`
- `GET 127.0.0.1:8080/health` → **404**, `/api/health` → 503 (там нет supervised-движка)
- `GET 127.0.0.1:18500/props?model=iq3_xxs&autoload=false` → **200**, есть `chat_template`, `default_generation_settings.n_ctx=131072`, `modalities.vision`
- gateway `/v1/models` → 200, `meta.n_ctx=131072`, `architecture.input_modalities=[text,image]`, **`max_generated` нет**
- ключ gateway: `~/.pi/agent/models.json` (`sk-strata-…`) совпадает с `AppData/Local/Strata/launch/*.json:api_key`; ключ engine — `~/.strata/data/native-instances/*.json:api_key`

Следствие для расширения (замерено end-to-end, `pi --no-extensions -e index.ts --list-models`):

```
local  iq3_xxs     131.1K  16.4K  thinking=no   ← должно быть thinking=yes
local  strata-auto   0      0     yes           ← мусор в каталоге рядом с живой моделью
```

Цепочка отказа: `/props` мёртв на gateway → `templateThinking` никогда не вызывается →
`reasoning:false`, `supportsReasoningEffort:false`, нет `thinkingLevelMap`, нет
`samplingParamsByThinkingLevel`; `maxTokens` берётся из конфига (16384), а не из модели;
итог сохраняется в `models-store.json` (`"reasoning": false`).

Дополнительно: `/props` не отдают и llama.cpp-совместимые серверы без props, поэтому
детект thinking нужен и там — но только по факту, а не по названию модели.

## Что делает форк

1. **`src/native.ts`** — читать локальное состояние Strata: `~/.strata/data/native-instances/*.json`
   (порт+ключ engine), `AppData/Local/Strata/launch/*.json` (URL+ключ gateway),
   `--pack <dir>` → `tokenizer/chat_template.jinja` (шаблон с диска, без ключей).
2. **Каскад метаданных** вместо одного мёртвого `/props`:
   legacy `/props` → engine-direct `/props` на порту инстанса → шаблон с диска →
   эмпирическая проба «есть ли `reasoning_content` в ответе» (одна крошечная запрос-проверка).
3. **Thinking-карта по реальным уровням Strata** (`low|medium|high|xhigh|max|none`,
   `minimal→low`), `supportsReasoningEffort:true`, бюджет thinking на `xhigh/max`.
4. **maxTokens/ctx из фактических полей** (`max_generated`, `n_ctx`, `metrics.engine.max_context`).
5. **Убрать `strata-auto`-PLACEHOLDER** из каталога, когда есть живые модели.
6. **auth**: сначала живой ключ из состояния Strata, иначе keyless (без фейкового `Bearer`).
7. Провайдер по умолчанию `strata` (под текущий `settings.json` пользователя), опции
   `readLocalState` / `engineDiscovery` / `capabilityProbe`.

## Проверка (обязательна перед «готово»)

1. `node --test test/*.test.ts` — включая новые тесты на формы 0.1.63 (фикстуры сняты живьём).
2. `pi --no-extensions -e index.ts --list-models` в изолированном `PI_CODING_AGENT_DIR`:
  -thinking=yes, output=32.8K, без `strata-auto`.
3. Реальный запрос `pi -p ... --thinking high` и проверка, что в сессии есть reasoning.
4. `GET /v1/chat/completions` с каждым уровнем reasoning_effort → 200 и не-пустой reasoning.
