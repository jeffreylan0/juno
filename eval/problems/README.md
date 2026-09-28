# Eval problems

One JSON file per problem; target is 100 by the end of week 2, spread across
calculus, algebra, physics, chemistry, statistics and programming, and across
page types (KaTeX, MathJax 2/3, tables, code, canvas, iframes, hidden text).

```jsonc
{
  "id": "katex-integral",              // file name without .json
  "subject": "calculus",
  "page": "tests/fixtures/pages/katex.html", // fixture page, relative to repo root
  "selector": "#problem",              // the element a student would select
  "crop": "eval/problems/crops/katex-integral.png", // made by `pnpm eval:crops`
  "question": "Evaluate the integral.",
  "answer": {
    "numeric": 0.3333,                 // optional: parsed from the "Answer:" line
    "tolerance": 0.001,                // absolute
    "accept": ["1/3", "0.333"]         // any of these substrings also count
  }
}
```

Routes compared by `pnpm eval:run`:

- `mock`: replay only (free); proves the pipeline.
- `local`: Ollama vision model with the planner's parts.
- `image-only`: just the crop, to the large model. The baseline Gate A is measured against.
- `planner`: the planner's exact parts (text, LaTeX, table, code) with a crop only where needed.

Gate A passes when `planner` accuracy is within 2 points of `image-only`.
