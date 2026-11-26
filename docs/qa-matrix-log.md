# DDICBot P3 final-QA — local production matrix run

Run at: 2026-11-26T13:59:51.533Z
Target: local next start on a free 127.0.0.1 port (real npm run build output); pair matrix docs/final-qa-pairs.json re-verified against the live Neon ddi_pairs at startup.

Method: HTTP lane POSTs crafted Telegram updates (bot_command entities exactly as the Bot API emits them) to the prod route with a locally generated `x-telegram-bot-api-secret-token`; /lang effects are proven by reading the `chat_langs` row back from Neon. Reply-text lane drives the SAME crafted updates through the same grammY bot in-process with only the outbound `Api.prototype.sendMessage` stubbed (the scripts/simulate-check.ts pattern) — webhook HTTP cannot return reply text; Telegram webhooks reply `{ok:true}` at most.

Result: **117/117 cases pass**

| lane | case | verdict | detail |
|------|------|---------|--------|
| gate | npm run build green | PASS |                   0 B         113 kB ├ ƒ /api/cron/refresh                0 B            0 B └ ƒ /api/tg-webhook                  0 B            0 B + First Load JS shared by all     113 kB   ├ chunks/3a4c999da81d8f52.js   75.5 kB   ├ chunks/9f8427060b631bed.js   24.7 kB   └ other shared chunks (total)  13.4 kB   ○  (Static)   prerendered as static content ƒ  (Dynamic)  server-rendered on demand   |
| gate | next start: GET /api/tg-webhook 200 within 60s | PASS | — |
| http | GET health probe → 200 {status:'ok'} | PASS | status=200 |
| http | POST without secret token → 405 | PASS | status=405 |
| http | POST with wrong secret token → 405 | PASS | status=405 |
| http | /start → HTTP 200 through prod route | PASS | status=200 |
| http | /help → HTTP 200 through prod route | PASS | status=200 |
| http | /lang zh POSTed + chat_langs row reads back 'zh' | PASS | status=200 stored=zh |
| http | [zh] /check aspirin acalabrutinib (Major) → HTTP 200 | PASS | status=200 |
| http | [zh] /check warfarin aspirin (Major) → HTTP 200 | PASS | status=200 |
| http | [zh] /check 5-hydroxytryptophan tramadol (Major) → HTTP 200 | PASS | status=200 |
| http | [zh] /check fentanyl fluoxetine (Major) → HTTP 200 | PASS | status=200 |
| http | [zh] /check aspirin abciximab (Moderate) → HTTP 200 | PASS | status=200 |
| http | [zh] /check 5-hydroxytryptophan codeine (Moderate) → HTTP 200 | PASS | status=200 |
| http | [zh] /check alcohol fentanyl (Moderate) → HTTP 200 | PASS | status=200 |
| http | [zh] /check aspirin caffeine (Minor) → HTTP 200 | PASS | status=200 |
| http | [zh] /check aspirin acitretin (Unknown) → HTTP 200 | PASS | status=200 |
| http | [zh] /check simvastatin aspirin (Unknown) → HTTP 200 | PASS | status=200 |
| http | [zh] /check metformin caffeine (notfound) → HTTP 200 | PASS | status=200 |
| http | [zh] /check metformin sitagliptin (notfound) → HTTP 200 | PASS | status=200 |
| http | [zh] /check metformin colchicine (notfound) → HTTP 200 | PASS | status=200 |
| http | [zh] /check omeprazole caffeine (notfound) → HTTP 200 | PASS | status=200 |
| http | [zh] /check omeprazole sitagliptin (notfound) → HTTP 200 | PASS | status=200 |
| http | /lang en POSTed + chat_langs row reads back 'en' | PASS | status=200 stored=en |
| http | [en] /check aspirin acalabrutinib (Major) → HTTP 200 | PASS | status=200 |
| http | [en] /check warfarin aspirin (Major) → HTTP 200 | PASS | status=200 |
| http | [en] /check 5-hydroxytryptophan tramadol (Major) → HTTP 200 | PASS | status=200 |
| http | [en] /check fentanyl fluoxetine (Major) → HTTP 200 | PASS | status=200 |
| http | [en] /check aspirin abciximab (Moderate) → HTTP 200 | PASS | status=200 |
| http | [en] /check 5-hydroxytryptophan codeine (Moderate) → HTTP 200 | PASS | status=200 |
| http | [en] /check alcohol fentanyl (Moderate) → HTTP 200 | PASS | status=200 |
| http | [en] /check aspirin caffeine (Minor) → HTTP 200 | PASS | status=200 |
| http | [en] /check aspirin acitretin (Unknown) → HTTP 200 | PASS | status=200 |
| http | [en] /check simvastatin aspirin (Unknown) → HTTP 200 | PASS | status=200 |
| http | [en] /check metformin caffeine (notfound) → HTTP 200 | PASS | status=200 |
| http | [en] /check metformin sitagliptin (notfound) → HTTP 200 | PASS | status=200 |
| http | [en] /check metformin colchicine (notfound) → HTTP 200 | PASS | status=200 |
| http | [en] /check omeprazole caffeine (notfound) → HTTP 200 | PASS | status=200 |
| http | [en] /check omeprazole sitagliptin (notfound) → HTTP 200 | PASS | status=200 |
| http | /lang ja POSTed + chat_langs row reads back 'ja' | PASS | status=200 stored=ja |
| http | [ja] /check aspirin acalabrutinib (Major) → HTTP 200 | PASS | status=200 |
| http | [ja] /check warfarin aspirin (Major) → HTTP 200 | PASS | status=200 |
| http | [ja] /check 5-hydroxytryptophan tramadol (Major) → HTTP 200 | PASS | status=200 |
| http | [ja] /check fentanyl fluoxetine (Major) → HTTP 200 | PASS | status=200 |
| http | [ja] /check aspirin abciximab (Moderate) → HTTP 200 | PASS | status=200 |
| http | [ja] /check 5-hydroxytryptophan codeine (Moderate) → HTTP 200 | PASS | status=200 |
| http | [ja] /check alcohol fentanyl (Moderate) → HTTP 200 | PASS | status=200 |
| http | [ja] /check aspirin caffeine (Minor) → HTTP 200 | PASS | status=200 |
| http | [ja] /check aspirin acitretin (Unknown) → HTTP 200 | PASS | status=200 |
| http | [ja] /check simvastatin aspirin (Unknown) → HTTP 200 | PASS | status=200 |
| http | [ja] /check metformin caffeine (notfound) → HTTP 200 | PASS | status=200 |
| http | [ja] /check metformin sitagliptin (notfound) → HTTP 200 | PASS | status=200 |
| http | [ja] /check metformin colchicine (notfound) → HTTP 200 | PASS | status=200 |
| http | [ja] /check omeprazole caffeine (notfound) → HTTP 200 | PASS | status=200 |
| http | [ja] /check omeprazole sitagliptin (notfound) → HTTP 200 | PASS | status=200 |
| http | /lang (no arg) POSTed → HTTP 200, stored lang still 'ja' | PASS | status=200 stored=ja |
| reply | /lang no-arg on fresh chat reports 'Current: zh' + footer | PASS | 当前语言 Current: zh 用法 Usage: /lang en \| /lang zh \| /lang ja  ⚕️ 急症请立即拨打当地急救电话（中国大陆 120 / 美国 911 / 日本 119） ⚠️ 非医疗建议 / Not m |
| reply | /lang klingon rejected with usage hint | PASS | 无效语言 Invalid value. Use: /lang en \| /lang zh \| /lang ja  ⚕️ 急症请立即拨打当地急救电话（中国大陆 120 / 美国 911 / 日本 119） ⚠️ 非医疗建议 / Not med |
| reply | /start: usage + /lang en|zh|ja + command list + both mandatory lines | PASS | DDICBot — drug–drug interaction checker · 药物相互作用查询工具 用法 Usage: /check <drug1> <drug2> (e.g. /check simvastatin aspirin) 语言: /lang en 或 /lang zh 或 /lang ja（默认中文） |
| reply | /help: lists /check /lang /start + both mandatory lines | PASS | DDICBot commands /check <drug1> <drug2> — 查询药物相互作用 (space or comma separated) /lang en \| zh \| ja — 设置回复语言 / set reply language /help — 本帮助 / this help /start —  |
| reply | /lang zh confirms + footer | PASS | 语言已切换 Language set to: zh  ⚕️ 急症请立即拨打当地急救电话（中国大陆 120 / 美国 911 / 日本 119） ⚠️ 非医疗建议 / Not medical advic |
| reply | /lang (no arg) after /lang zh reports Current: zh | PASS | 当前语言 Current: zh 用法 Usage: /lang en \| /lang zh \| /lang ja  ⚕️ 急症请立即拨打当地急救电话（中国大陆 120 / 美国 911 / 日本 119） ⚠️ 非医疗建议 / Not m |
| reply | [zh] /check aspirin acalabrutinib → Major badge + mechanism shape + footer | PASS | — |
| reply | [zh] /check warfarin aspirin → Major badge + mechanism shape + footer | PASS | — |
| reply | [zh] /check 5-hydroxytryptophan tramadol → Major badge + mechanism shape + footer | PASS | — |
| reply | [zh] /check fentanyl fluoxetine → Major badge + mechanism shape + footer | PASS | — |
| reply | [zh] /check aspirin abciximab → Moderate badge + mechanism shape + footer | PASS | — |
| reply | [zh] /check 5-hydroxytryptophan codeine → Moderate badge + mechanism shape + footer | PASS | — |
| reply | [zh] /check alcohol fentanyl → Moderate badge + mechanism shape + footer | PASS | — |
| reply | [zh] /check aspirin caffeine → Minor badge + mechanism shape + footer | PASS | — |
| reply | [zh] /check aspirin acitretin → Unknown badge + mechanism shape + footer | PASS | — |
| reply | [zh] /check simvastatin aspirin → Unknown badge + mechanism shape + footer | PASS | — |
| reply | [zh] /check metformin caffeine → EXACT notfound lines (no 'no interaction') | PASS | — |
| reply | [zh] /check metformin sitagliptin → EXACT notfound lines (no 'no interaction') | PASS | — |
| reply | [zh] /check metformin colchicine → EXACT notfound lines (no 'no interaction') | PASS | — |
| reply | [zh] /check omeprazole caffeine → EXACT notfound lines (no 'no interaction') | PASS | — |
| reply | [zh] /check omeprazole sitagliptin → EXACT notfound lines (no 'no interaction') | PASS | — |
| reply | /lang en confirms + footer | PASS | 语言已切换 Language set to: en  ⚕️ 急症请立即拨打当地急救电话（中国大陆 120 / 美国 911 / 日本 119） ⚠️ 非医疗建议 / Not medical advic |
| reply | /lang (no arg) after /lang en reports Current: en | PASS | 当前语言 Current: en 用法 Usage: /lang en \| /lang zh \| /lang ja  ⚕️ 急症请立即拨打当地急救电话（中国大陆 120 / 美国 911 / 日本 119） ⚠️ 非医疗建议 / Not m |
| reply | [en] /check aspirin acalabrutinib → Major badge + mechanism shape + footer | PASS | — |
| reply | [en] /check warfarin aspirin → Major badge + mechanism shape + footer | PASS | — |
| reply | [en] /check 5-hydroxytryptophan tramadol → Major badge + mechanism shape + footer | PASS | — |
| reply | [en] /check fentanyl fluoxetine → Major badge + mechanism shape + footer | PASS | — |
| reply | [en] /check aspirin abciximab → Moderate badge + mechanism shape + footer | PASS | — |
| reply | [en] /check 5-hydroxytryptophan codeine → Moderate badge + mechanism shape + footer | PASS | — |
| reply | [en] /check alcohol fentanyl → Moderate badge + mechanism shape + footer | PASS | — |
| reply | [en] /check aspirin caffeine → Minor badge + mechanism shape + footer | PASS | — |
| reply | [en] /check aspirin acitretin → Unknown badge + mechanism shape + footer | PASS | — |
| reply | [en] /check simvastatin aspirin → Unknown badge + mechanism shape + footer | PASS | — |
| reply | [en] /check metformin caffeine → EXACT notfound lines (no 'no interaction') | PASS | — |
| reply | [en] /check metformin sitagliptin → EXACT notfound lines (no 'no interaction') | PASS | — |
| reply | [en] /check metformin colchicine → EXACT notfound lines (no 'no interaction') | PASS | — |
| reply | [en] /check omeprazole caffeine → EXACT notfound lines (no 'no interaction') | PASS | — |
| reply | [en] /check omeprazole sitagliptin → EXACT notfound lines (no 'no interaction') | PASS | — |
| reply | /lang ja confirms + footer | PASS | 语言已切换 Language set to: ja  ⚕️ 急症请立即拨打当地急救电话（中国大陆 120 / 美国 911 / 日本 119） ⚠️ 非医疗建议 / Not medical advic |
| reply | /lang (no arg) after /lang ja reports Current: ja | PASS | 当前语言 Current: ja 用法 Usage: /lang en \| /lang zh \| /lang ja  ⚕️ 急症请立即拨打当地急救电话（中国大陆 120 / 美国 911 / 日本 119） ⚠️ 非医疗建议 / Not m |
| reply | [ja] /check aspirin acalabrutinib → Major badge + mechanism shape + footer | PASS | — |
| reply | [ja] /check warfarin aspirin → Major badge + mechanism shape + footer | PASS | — |
| reply | [ja] /check 5-hydroxytryptophan tramadol → Major badge + mechanism shape + footer | PASS | — |
| reply | [ja] /check fentanyl fluoxetine → Major badge + mechanism shape + footer | PASS | — |
| reply | [ja] /check aspirin abciximab → Moderate badge + mechanism shape + footer | PASS | — |
| reply | [ja] /check 5-hydroxytryptophan codeine → Moderate badge + mechanism shape + footer | PASS | — |
| reply | [ja] /check alcohol fentanyl → Moderate badge + mechanism shape + footer | PASS | — |
| reply | [ja] /check aspirin caffeine → Minor badge + mechanism shape + footer | PASS | — |
| reply | [ja] /check aspirin acitretin → Unknown badge + mechanism shape + footer | PASS | — |
| reply | [ja] /check simvastatin aspirin → Unknown badge + mechanism shape + footer | PASS | — |
| reply | [ja] /check metformin caffeine → EXACT notfound lines (no 'no interaction') | PASS | — |
| reply | [ja] /check metformin sitagliptin → EXACT notfound lines (no 'no interaction') | PASS | — |
| reply | [ja] /check metformin colchicine → EXACT notfound lines (no 'no interaction') | PASS | — |
| reply | [ja] /check omeprazole caffeine → EXACT notfound lines (no 'no interaction') | PASS | — |
| reply | [ja] /check omeprazole sitagliptin → EXACT notfound lines (no 'no interaction') | PASS | — |
| reply | switch: /lang zh → pair renders zh chrome (🔴 Major / 严重) + no-mechanism zh placeholder | PASS | — |
| reply | switch: /lang ja → same pair now renders ja chrome (🔴 重大) | PASS | — |
| reply | switch: /lang en → same pair renders en chrome (🔴 Major / 严重) | PASS | — |
| reply | switch: ja notfound line EXACT in a post-switch reply | PASS | — |
| reply | ja unresolvable /check: re-prompt + all notfound lines + both mandatory lines | PASS | — |
| reply | usage path /check aspirin: usage line + both mandatory lines | PASS | — |

Pinned not-found strings asserted verbatim in every /check not-found reply of each language:
- zh: 数据库未收录该组合，不代表无相互作用。
- en: This combination is not in our database
- ja: この組み合わせはデータベースに収録されていません
Mandatory lines asserted in every reply: `EMERGENCY_LINE` + `DISCLAIMER_LINE`; forbidden wording ('no interaction'/'safe'/'no problem') asserted absent.
