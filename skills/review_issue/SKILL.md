---
name: review_issue
description: Review a GitHub issue against the repository.
---

Assess the issue using the supplied context and repository code. Focus on relevant changes since any previous assessment.
Do not modify files. Return an assessment with evidence and unresolved questions.
If the issue is valid and you are confident it can be implemented without clarification, include a line containing exactly `SCRAT_READY`.
Scrat publishes the assessment and manages labels.
