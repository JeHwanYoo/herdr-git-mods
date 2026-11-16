# Research method

Organize research documents in this order: intent analysis, research topics, and findings by topic. Follow this order when revising existing documents.

## Intent analysis

State the decision the research should support and why it is needed. Define the scope, verification date, target version, and environment. Editing an earlier investigation does not count as new verification.

## Research topics

Break the intent into specific questions about implementation feasibility, API constraints, distribution requirements, or other relevant conditions. Put questions that depend on earlier answers after those questions.

## Findings by topic

Use subheadings in the same order as the research questions. For each topic, present the facts and evidence, then explain their effect on the original decision. Compare alternatives against the same criteria.

Distinguish results you observed by running commands from facts you read in documentation or code and conclusions you inferred. Resolve conflicting sources by comparing versions and verification dates. Record unresolved differences and describe how to verify open questions.

Preserve historical installation procedures and repository-state claims with their investigation dates. Keep current usage in README.md and shared rules in the relevant convention documents.

## Source footnotes

Place Markdown footnote references after the claims they support. Define the footnotes at the end of the document and reuse the same footnote for the same source.

Include the original URL and relevant section or file path. For local sources, record the path and inspected version. For command results, record the command and verification environment. If you could not inspect the original source, identify the secondary source and state that limit.

```markdown
The installed runtime does not expose this API.[^runtime]

[^runtime]: `~/.config/herdr-app/herdr.d.ts`, Herdr app 0.1.12, checked on 2026-11-03.
```

Before finishing, check that the findings answer the research questions, distinguish facts from inference, and connect each footnote reference to its definition. Remove claims that lack evidence or imply verification you did not perform.
