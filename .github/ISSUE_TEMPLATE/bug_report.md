name: Bug report
description: Something breaks or behaves unexpectedly
labels: ['bug']
body:
  - type: textarea
    id: what-happened
    attributes:
      label: What happened?
      description: A clear description of the problem. If the memory panel is involved, what did it show?
    validations:
      required: true
  - type: textarea
    id: reproduce
    attributes:
      label: Steps to reproduce
      placeholder: |
        1. dsh --profile X (plugin version from npm ls / package.json)
        2. Said "remember ..." in a session
        3. Opened a new session, asked "what do you know about me?"
    validations:
      required: true
  - type: input
    id: versions
    attributes:
      label: Versions
      description: 'dsh-auto-memory version, dsh version (dsh --version), OS'
      placeholder: 'dsh-auto-memory 0.5.0, dsh 0.1.5-rc.2, Windows 11'
    validations:
      required: true
  - type: textarea
    id: logs
    attributes:
      label: Relevant logs
      description: Terminal output around the failure (redact any secrets first — the plugin redacts on write, logs may still contain them).
      render: shell
  - type: markdown
    attributes:
      value: |
        Tips: memory files live under `$DSH_HOME/memory/` and are plain Markdown —
        you can inspect/edit them directly. `MEMORY.md` is derived; it rebuilds on the next write.
