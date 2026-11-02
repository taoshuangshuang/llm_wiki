import type { IngestScenario } from "./types"

/**
 * Ingest scenarios drive autoIngest end-to-end. Two LLM responses per
 * scenario (stage 1 analysis, stage 2 generation with FILE + REVIEW blocks).
 *
 * FILE block format (what stage 2 must emit to write a wiki file):
 *   ---FILE: wiki/path/to/page.md---
 *   (file content, usually with YAML frontmatter)
 *   ---END FILE---
 *
 * REVIEW block format (what stage 2 emits to inject a review item):
 *   ---REVIEW: missing-page | Short title---
 *   Description.
 *   OPTIONS: Approve | Skip
 *   PAGES: page1.md, page2.md
 *   ---END REVIEW---
 *
 * Stage 2 may emit arbitrary prose around blocks — the parser only
 * cares about the delimited blocks.
 */

const BASIC_PURPOSE = `# Purpose

This wiki tracks deep-learning research concepts.
`

const BASIC_INDEX = `# Index

## Concepts
- [[attention]]
`

const BASIC_SCHEMA = `# Schema

## wiki/concepts/
Each concept gets its own page.
`

export const ingestScenarios: IngestScenario[] = [
  // 1. basic-new-source — 生成知识页并直接引用原始来源，不生成摘要。
  {
    name: "basic-new-source",
    description:
      "Stage 2 emits a single concept page. No " +
      "REVIEW blocks. The runner must see the knowledge page on disk and zero " +
      "reviews in the store.",
    initialWiki: {
      "purpose.md": BASIC_PURPOSE,
      "schema.md": BASIC_SCHEMA,
      "wiki/index.md": BASIC_INDEX,
    },
    source: {
      path: "raw/sources/rope-paper.md",
      content: [
        "# Rotary Position Embedding",
        "",
        "Rotary Position Embedding (RoPE) encodes positional information by",
        "rotating pairs of dimensions in query and key vectors. It naturally",
        "supports variable-length contexts and is now standard in LLMs.",
      ].join("\n"),
    },
    analysisResponse: [
      "## Key Concepts",
      "- Rotary Position Embedding (RoPE): rotates pairs of dimensions",
      "",
      "## Main Arguments",
      "- RoPE naturally supports variable-length contexts",
      "",
      "## Recommendations",
      "- Create wiki/concepts/rope.md",
    ].join("\n"),
    generationResponse: [
      "I'll create one concept page citing the original source.",
      "",
      "---FILE: wiki/concepts/rope.md---",
      "---",
      "title: Rotary Position Embedding",
      "tags: [positional-encoding]",
      "sources: [rope-paper.md]",
      "---",
      "",
      "# Rotary Position Embedding",
      "",
      "RoPE rotates pairs of dimensions in [[attention]] queries and keys",
      "to encode absolute position while preserving relative-position invariance.",
      "---END FILE---",
      "",
    ].join("\n"),
    expected: {
      writtenPaths: [
        "wiki/concepts/rope.md",
      ],
      fileContains: {
        "wiki/concepts/rope.md": [
          "title: Rotary Position Embedding",
          "[[attention]]",
        ],
      },
      reviewsCreated: [],
    },
  },

  // 2. generates-review-items — REVIEW blocks in generation become store items
  {
    name: "defers-generation-review-items",
    description:
      "Stage 2 emits one FILE and two REVIEW blocks (missing-page + " +
      "suggestion). 生成阶段不发布正式事项，由写后后台核实。",
    initialWiki: {
      "purpose.md": BASIC_PURPOSE,
      "schema.md": BASIC_SCHEMA,
      "wiki/index.md": BASIC_INDEX,
    },
    source: {
      path: "raw/sources/flash-attention.md",
      content:
        "# FlashAttention\n\nFlashAttention is an IO-aware exact attention algorithm.\n",
    },
    analysisResponse: "## Key Concepts\n- FlashAttention\n",
    generationResponse: [
      "---FILE: wiki/concepts/io-aware-attention.md---",
      "---",
      "title: \"IO-aware attention\"",
      "sources: [flash-attention.md]",
      "---",
      "",
      "# IO-aware attention",
      "",
      "FlashAttention is mentioned here.",
      "---END FILE---",
      "",
      "---REVIEW: missing-page | FlashAttention---",
      "The source introduces FlashAttention but no dedicated page exists.",
      "OPTIONS: Create page | Skip",
      "PAGES: wiki/concepts/io-aware-attention.md",
      "---END REVIEW---",
      "",
      "---REVIEW: suggestion | Add IO-aware algorithms survey---",
      "Consider a survey page grouping IO-aware attention variants.",
      "---END REVIEW---",
    ].join("\n"),
    expected: {
      writtenPaths: ["wiki/concepts/io-aware-attention.md"],
      reviewsCreated: [],
    },
  },

  // 3. references-existing-wikilinks — generated pages link to existing pages
  {
    name: "references-existing-wikilinks",
    description:
      "The generated wiki page must include [[attention]] — linking back " +
      "to a page that already exists in the wiki. Runner asserts substring.",
    initialWiki: {
      "purpose.md": BASIC_PURPOSE,
      "schema.md": BASIC_SCHEMA,
      "wiki/index.md": BASIC_INDEX,
      "wiki/attention.md":
        "---\ntitle: Attention\n---\n\n# Attention\n\nThe attention mechanism.\n",
    },
    source: {
      path: "raw/sources/multi-head.md",
      content: "# Multi-Head Attention\n\nParallel attention heads.\n",
    },
    analysisResponse:
      "## Connections to Existing Wiki\n" +
      "- Multi-head attention is a variant of attention — existing [[attention]] page should be linked.\n",
    generationResponse: [
      "---FILE: wiki/concepts/multi-head-attention.md---",
      "---",
      "title: Multi-Head Attention",
      "---",
      "",
      "# Multi-Head Attention",
      "",
      "Multi-head [[attention]] runs several attention layers in parallel.",
      "---END FILE---",
      "",
    ].join("\n"),
    expected: {
      writtenPaths: [
        "wiki/concepts/multi-head-attention.md",
      ],
      fileContains: {
        "wiki/concepts/multi-head-attention.md": ["[[attention]]"],
      },
    },
  },

  // 4. chinese-source — Chinese content flows through to Chinese wiki pages
  {
    name: "chinese-source",
    description:
      "Chinese-language source document; LLM responses in Chinese. " +
      "UTF-8 round-trip through file write must be clean.",
    initialWiki: {
      "purpose.md": "# 用途\n\n深度学习研究笔记。\n",
      "schema.md": BASIC_SCHEMA,
      "wiki/index.md": "# 索引\n\n- [[注意力机制]]\n",
    },
    source: {
      path: "raw/sources/transformer-survey.md",
      content: "# Transformer 综述\n\nTransformer 是一种基于注意力机制的神经网络架构。\n",
    },
    analysisResponse: "## 核心概念\n- Transformer：基于注意力机制的架构\n",
    generationResponse: [
      "---FILE: wiki/concepts/transformer.md---",
      "---",
      "title: Transformer",
      "---",
      "",
      "# Transformer",
      "",
      "Transformer 是一种基于 [[注意力机制]] 的神经网络架构。",
      "---END FILE---",
      "",
    ].join("\n"),
    expected: {
      writtenPaths: [
        "wiki/concepts/transformer.md",
      ],
      fileContains: {
        "wiki/concepts/transformer.md": [
          "title: Transformer",
          "[[注意力机制]]",
        ],
      },
    },
  },
]
