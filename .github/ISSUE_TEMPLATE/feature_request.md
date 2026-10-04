name: Feature request
description: Suggest a capability or improvement
labels: ['enhancement']
body:
  - type: textarea
    id: problem
    attributes:
      label: What problem does this solve?
      description: The use case, not the solution — what were you trying to do?
    validations:
      required: true
  - type: textarea
    id: proposal
    attributes:
      label: Your proposal
      description: What should happen instead? Any prior art (Mem0/Letta/Zep/ChatGPT memory) worth referencing?
  - type: checkboxes
    id: constraints
    attributes:
      label: Project positioning (please check what you're aware of)
      options:
        - label: I know this project deliberately avoids vector DBs / external services (plain Markdown files only)
          required: false
        - label: I know writes go through a locked store — proposals must respect the hard constraints in CONTRIBUTING.md
          required: false
