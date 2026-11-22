# dsh-keep-top

<img src="assets/icon.png" width="96" alt="dsh-keep-top icon">

A tiny DeepSeek Harness (DSH) web-client plugin that does **one** thing: while an answer streams in, the viewport follows it only until the **first line of that answer reaches the top of the screen**, then it stops there.

So when you want to scroll back a little and re-read the paragraph that just went by, you don't have to fight an output that keeps dragging you to the bottom.

No model calls, no network, no files, no extra DOM. One client-side file, ~300 lines.

---

## Why not an existing plugin?

`dsh-streamfold` (the popular folding plugin) covers a lot, but to fold process rows itself it has to force the official transcript mode to `transcriptView: verbose`. The side effect: every reasoning step becomes its own row, and the official compact `思考 · 已完成 N 步` grouping disappears — a big visual change.

`dsh-chat-answer-anchor` goes the other way: it freezes the whole viewport, so after the answer finishes you still have to scroll down by hand.

This plugin takes the narrow path: **official transcript mode stays `standard`** (process rows keep their official one-line grouping), and it only takes over scroll writes at the right moment.

---

## What it does

When a turn starts, the plugin takes over scrolling if **all** of these hold:

1. The turn's prose row (`data-chat-flow-kind="assistant-step"`, not a reasoning step, no tool block) **arrives** at the top of the viewport (within `topGap`);
2. It is not already far past the top — if it's more than `farPastPx` (400 px) above the viewport, this isn't a live arrival any more;
3. The content is still growing (text changed within the last `streamWindowMs`, default 2000 ms);
4. The viewport is near the bottom (within 64 px), and has been so for at least 250 ms.

While holding, it re-measures the prose row every frame instead of pinning a pixel value — at the end of a turn DSH collapses the process rows above into one line, and a pinned pixel would drag the view along with that reflow.

Any user input — wheel, touch, pointer down, PageUp/PageDown/↑/↓/Home/End — hands the write lock straight back, and the plugin stays out of the way for the rest of that turn.

Switching to another conversation and back does **not** snap you to the top of the turn: the route change resets state, and on re-entry the "content growing" + "near bottom" conditions are not met.

Under the hood it uses the same idea as `dsh-streamfold` — take the scroll-write lock, keep the native follow loop from fighting — but keeps only the minimal part of it.

---

## Install

```bash
dsh plugin --profile desktop add github:777wtmsb/dsh-keep-top
```

Then **restart DSH** (a new bundle needs a host-side entry) and open the web client. No settings screen, no menu — it works as soon as it loads.

To check it loaded, open DevTools and run:

```js
__dshKeepTop.state()
// { enabled: true, turn: "12", frozen: false, gap: 16, released: null, streamingMsAgo: 1873, nearBottomAgo: 40 }
```

---

## Configure

Settings live in `localStorage["dsh-keep-top"]`. Note that they are scoped per page origin — the desktop app picks a new port on every restart, so persisted overrides can look like they were forgotten. Defaults:

| key | default | meaning |
| --- | --- | --- |
| `enabled` | `true` | master switch |
| `topGap` | `16` | px between the answer's first line and the top edge |
| `streamWindowMs` | `2000` | content must have grown within this window to count as "still streaming" |
| `farPastPx` | `400` | once the first line is this far above the viewport, stop taking over |

In DevTools:

```js
__dshKeepTop.set({ topGap: 24 })   // change and persist
__dshKeepTop.state()               // current state
__dshKeepTop.trace()               // last 400 samples
__dshKeepTop.dump()                // JSON string, handy for bug reports
__dshKeepTop.clear()
__dshKeepTop.set({ enabled: false })   // turn it off (persisted!)
__dshKeepTop.dispose()                 // remove listeners
```

To change the defaults themselves, edit `DEFAULTS` in `lib/client.js`. A stale value in localStorage wins over the new default — remove the key and reload.

---

## Development notes

- Scroll container: `[data-conversation-scroll]`
- Rows: `[data-chat-flow-kind][data-chat-turn]`
- Row kinds observed on DSH 0.2.2-rc.5: `user`, `turn-process` (the `已完成，用时 X 秒` group), `assistant-step` (prose; a reasoning step is also `assistant-step` but carries `[data-variant="think"]` / `_thinkBody`), `tool-call`, `turn-tail` (`用量 … tok`).
- The prose test is an **allow-list**: only `assistant-step`, minus reasoning bodies and tool blocks. An earlier exclude-list version mistook the collapsed `turn-process` for prose, which made the viewport jump to "已完成" when a turn ended.
- The stop condition must be **arrival**, not crossing: fast streaming can push hundreds of pixels per frame, and a crossing test misses the sample — the pin then never latches.
- Reloading the page in the desktop app: `F5` / `Ctrl+R` / `Ctrl+Shift+R` are swallowed; use `location.reload()` from DevTools. Changing `package.json` or `cordis.patch.yml` needs a full app restart.

---

## Known limits

- Desktop web client only (`dsh.client.platform` is `web`).
- Depends on DSH's `data-chat-flow-kind` / `data-conversation-scroll` attributes; a DOM contract change upstream may need a matching update here.
- If a turn's prose gets split by tool calls into several `assistant-step` rows (the DSH desktop client does not do this — interim lines and reasoning live inside `assistant-step[think]`), only the first row is anchored.
- On very large windows a short answer may fit without ever reaching the stop condition. Expected.
- Tiny single-frame nudge at the exact moment a turn ends is a known, accepted trade-off; the fix was kept simple on purpose (better to miss one takeover than to freeze once).

---

## Uninstall

```bash
dsh plugin --profile desktop remove dsh-keep-top
```

The plugin does not modify any official config, so nothing else needs restoring.

---

## Changelog

### 0.1.1

- Takeover gated on three conditions: content growing (baseline frames excluded), near-bottom for ≥250 ms (restored positions excluded), and approaching from below (`prevDistance` must come from under the top).
- While holding, re-measure the prose row every frame instead of writing a stale pixel target.
- Handle `resize` so fullscreen / window changes don't hold the wrong offset.
- `why` field records which input event handed the write lock back (`wheel`, `touchstart`, `pointerdown`, `key:PageDown`, …).

### 0.1.0

- First release: take over scrolling when the answer's first line reaches the top; any user input returns control. Official transcript mode stays `standard`.

---

## 中文速览

一个只做一件事的小插件：**输出时视口跟到「本条回答的第一行」贴住顶部就停住，不再继续往底部追。** 想往上翻看刚过去的那段，不用跟还在往下跑的输出较劲。

官方展示档保持 `standard`（过程行仍是「思考 · 已完成 N 步」的一行合并），只在恰当时机接管滚动写权；任何用户输入（滚轮、触摸、点击、翻页键）立即交还，本轮不再抢。

装：

```bash
dsh plugin --profile desktop add github:777wtmsb/dsh-keep-top
```

然后重启 DSH。设置项见上面的表格，`__dshKeepTop.set({ topGap: 24 })` 可以改。

## License

MIT
