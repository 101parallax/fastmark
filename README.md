# fastmark

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/101parallax/fastmark/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/101parallax/fastmark/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

fastmark is a fast, dependency-free drop-in for marked 18.1.3: it renders
byte-identical HTML for CommonMark 0.31.2 + GFM 0.29 input, for much less CPU.
A single-pass renderer handles the common constructs; anything it cannot
prove identical falls back to the vendored marked 18.1.3
(`vendor/marked/marked.esm.js`, MIT, unchanged).

## Run it

```sh
MAKEFUN_INPUT_DIR=./in MAKEFUN_OUTPUT_DIR=./out node main.ts
```

`main.ts` reads `cases.json` (`[{id, markdown}]`) from the input directory,
renders each case alone with `parse()` from `parse.js`, and writes
`html.json` (an array of HTML strings, in order) to the output directory.
No network, no clock, no reads outside the input/output directories.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
