# Durable Knowledge

## KC-0001: Результат этапа 01: исследование TUI-панели stages

- Kind: decision
- Status: active
- Created: 2026-08-27T09:12:17.535Z
- Updated: 2026-08-27T09:12:17.535Z
- Sources: ["https://opencode.ai/docs/plugins/","https://opencode.ai/docs/tui/"]

OpenCode 1.18.23 загружает project-local plugin; TUI API предоставляет sidebar_content slots и event bus. Рекомендуемый MVP: отдельный TUI plugin с stages-блоком в правой sidebar. Отдельный domain event work-context.updated отсутствует; обновление требует bridge или refresh по OpenCode/file events. Код и ADR не создавались.

## KC-0002: Решение этапа 02: read-only stages TUI panel

- Kind: decision
- Status: active
- Created: 2026-08-27T09:21:57.548Z
- Updated: 2026-08-27T09:21:57.548Z
- Sources: ["docs/adr/0002-read-only-stages-tui-panel.md"]

Предложен отдельный опциональный TUI adapter поверх read-only snapshot provider. Provider использует WorkContext.openExisting, возвращает schema 1 с workspace, stages, currentStage и generatedAt, не меняет storage и не вызывает mutating tools. MVP размещается в sidebar_content, обновляется initial load и debounce по поддержанным OpenCode session/file events; при отсутствии TUI API server plugin продолжает работать. Клавиатурные мутации отложены до отдельного ADR.

## KC-0003: Вопрос: осмысленное начальное название TUI-сессии

- Kind: risk
- Status: active
- Created: 2026-08-27T09:23:51.814Z
- Updated: 2026-08-27T09:23:51.814Z
- Sources: ["user-report: TUI screenshot and /wc resume 000001 02"]

При `/wc resume 000001 02` новая сессия получает summary по умолчанию `продолжение работы`, поэтому заголовок в TUI выглядит как `000001 02/01 (closed): продолжение работы`. Это теряет смысл заранее спланированного этапа и остаётся таким после завершения. Нужно решить, как инициализировать summary: выводить из названия/цели stage, запрашивать осмысленное название у пользователя при resume или использовать другой явный fallback. Решение должно сохранить явный lifecycle flow и обновлять session title через существующий adapter.
