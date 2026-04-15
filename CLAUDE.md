# CLAUDE.md — wave-deploy-agent

## 專案資訊
- **專案名稱**：wave-deploy-agent
- **語言**：繁體中文
- **定位**：一人創業的 GCP 安全部署 agent（vibe-coded 專案的安全閘門 + Cloud Run 自動部署）

## 會話規則（Session Rules）

**每次新對話開始時，必須先讀取以下兩個檔案**：

1. `brain/SESSION_HANDOFF.md` — 上次會話的交接摘要（進度、待辦、重點）
2. `brain/decisions/index.md` — 所有架構／產品決策的目錄

讀完後再開始新任務，確保 context 延續。

## 記錄規則（Logging Rules）

**完成任務後，必須更新 `brain/SESSION_HANDOFF.md`**：

- 更新「上次進度」：這次完成了什麼
- 更新「待辦事項」：還沒做完的、下次要接續的
- 更新「重要資訊／重要關注」：遇到的坑、架構決策、使用者偏好

**若產生新的架構決策**，另外在 `brain/decisions/` 下新增對應的決策檔，並在 `index.md` 登記。

## 回應風格

- 全程繁體中文
- 保持誠實直白，不做討好式回應
- 技術判斷要明確，不要含糊

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health
