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

## 工具问题沉淀

每个任务完成、创建 Git 提交前，检查本次任务是否遇到可复用的工具问题；没有则无需记录。出现工具、CLI、构建、测试、依赖安装、开发环境或代理工具等非显然故障、限制或有效规避方案时，先搜索并更新 `docs/agents/tool-issues.md` 中的已有条目，再按该文档格式新增或补充记录。产品代码缺陷按 Issue tracker 处理。
