# Durable Knowledge

## KC-0001: Проверка установки и TUI loader в OpenCode 1.18.25

- Kind: fact
- Status: active
- Created: 2026-08-31T09:03:05.045Z
- Updated: 2026-08-31T09:03:05.045Z
- Sources: ["package.json","bin/opencode-work-context.js","plugin/stages-tui.js","test/stages-tui.test.js","/tmp/opencode/lk2-real.f5eha9"]

Проверка stage 02 выполнена 2026-08-31. Проект lk2 в доступном workspace не найден, поэтому использован изолированный сторонний fixture /tmp/opencode/lk2-real.f5eha9. Окружение: opencode-work-context 0.1.9, OpenCode 1.18.25, Node v26.3.0, Bun отсутствует. Команда из корня проекта `npx --yes opencode-work-context@0.1.9 init --force` успешно установила пакет: devDependencies и node_modules имеют версию 0.1.9; созданы `.opencode/tui-plugins/work-context-stages.js` и `.opencode/tui.json` с plugin `./tui-plugins/work-context-stages.js`; повторный init --force также успешен и loader импортируется с id work-context-stages и tui function. Node-based test/stages-tui.test.js: 29 pass, 2 skip (реальные OpenTUI smoke tests требуют Bun). Проверены initial snapshot load, session.updated debounce, completed work_context_* tool event, canonical storage fs.watch, polling, session routing и cleanup; lifecycle stage list обновляется без remount на уровне host-contract tests. Полный npm test: 65 pass, 4 installer failures вызваны тестовым fake npm, использующим CommonJS require в ESM package scope при Node 26, а не реальным npm install; реальная установка прошла. Реальные npm audit warnings: 4 low vulnerabilities, deprecated glob, pending msgpackr-extract script approval. Runbook: запускать init строго из корня проекта; проверить package.json, node_modules/opencode-work-context/package.json, loader и tui.json; при исчезновении stages проверить TUI config path, импорт loader и перезапустить OpenCode; интерактивную OpenTUI проверку выполнить в окружении с Bun.
