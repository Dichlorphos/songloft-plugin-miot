# Agent instructions

--默认回复时使用简体中文

## Agent skills

### Issue tracker

Issues are tracked as local markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default labels `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Use a single-context layout with root `CONTEXT.md` and ADRs in `docs/adr/`. See `docs/agents/domain.md`.

## 提交约定
- 用户要求的功能完成并通过可用验证后，自动创建 Git 提交，无需再次询问。

