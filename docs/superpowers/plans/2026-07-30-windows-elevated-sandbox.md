# План реализации Windows elevated sandbox

> Выполнять TDD-циклами: каждый поведенческий тест сначала должен упасть по
> ожидаемой причине, затем пройти после минимальной реализации.

## 1. Контракт состояния setup

Файлы:

- `native/sandbox/internal/windowsmodel/state.go`
- `native/sandbox/internal/windowsmodel/state_test.go`
- `native/sandbox/cmd/nexus-sandbox/setup_windows.go`

Шаги:

1. Добавить literal fixtures для missing/stale/corrupt/ready marker и тесты,
   что только совпадающие version, identities, credential и firewall revisions дают
   `ready`.
2. Реализовать строгий decoder, atomic marker model и диагностические коды.
3. Добавить JSON status contract без секретов.

## 2. Capability и пути

Файлы:

- `native/sandbox/internal/windowsmodel/capability.go`
- `native/sandbox/internal/windowsmodel/capability_test.go`

Шаги:

1. Тестами зафиксировать case-insensitive canonical keys, разные SID для
   разных roots, стабильность сохранённого SID и отсутствие stale SID в active
   token plan.
2. Реализовать SID registry и pure ACL/token plan.
3. Проверить malformed, duplicate, UNC/reparse и denied/write conflicts.

## 3. Windows API backend

Файлы:

- `native/sandbox/internal/windowsnative/api_windows.go`
- `native/sandbox/internal/windowsnative/setup_windows.go`
- `native/sandbox/internal/windowsnative/acl_windows.go`
- `native/sandbox/internal/windowsnative/runner_windows.go`
- `native/sandbox/internal/windowsnative/stub_nonwindows.go`

Шаги:

1. Добавить compile-time contracts и тесты pure builders до API вызовов.
2. Реализовать identities/DPAPI/marker и UAC setup.
3. Реализовать ACL/capability refresh и persistent user-scoped Windows
   Firewall policy.
4. Реализовать restricted token, private desktop, handle list, atomic Job
   Object spawn и termination.
5. Каждая API ошибка должна иметь stage/code и никогда не продолжать spawn.

## 4. Broker и protocol

Файлы:

- `native/sandbox/internal/runner/runner.go`
- `native/sandbox/internal/platform/command_windows.go`
- `native/sandbox/cmd/nexus-sandbox/main.go`
- `native/sandbox/internal/windowsnative/api_windows_test.go`

Шаги:

1. Тестом доказать, что `started` появляется только после native spawn.
2. Подключить Windows executor без изменения macOS/Linux пути.
3. Добавить `--setup`, `--setup-elevated`, `--status-json`, полноценный
   `--check`.
4. Проверить timeout, cancellation, exit/error mapping и secret-free control.

## 5. Installer, doctor и UI

Файлы:

- `scripts/one-install.js`
- `packages/cli/src/doctor-report.ts`
- `packages/cli/src/entrypoints/cli.tsx`
- `packages/vscode/src/extension.ts`
- связанные protocol/UI tests

Шаги:

1. Тестом зафиксировать setup-state сообщения и отсутствие auto-fallback.
2. One-install вызывает Windows setup до `--check`.
3. Doctor и extension показывают actionable state; VS Code может запустить
   setup и повторить readiness probe.
4. CLI и extension используют один status contract.

## 6. Build, release и smoke suite

Файлы:

- `packages/sandbox/scripts/build-native.mjs`
- `packages/sandbox/scripts/copy-native.mjs`
- `packages/sandbox/src/locator.ts`
- `.github/workflows/native-sandbox.yml`
- `scripts/windows-sandbox-smoke.mjs`
- `THIRD_PARTY_NOTICES.md`

Шаги:

1. Добавить x64/arm64 Windows jobs, hash manifest и package verification.
2. Cross-build обе архитектуры и проверить PE headers/embedded protocol.
3. Добавить безопасный Windows smoke suite с временными roots.
4. Не маркировать Windows runtime verified, пока workflow не прошёл на
   реальном Windows runner.

## 7. Общая регрессия и публикация

1. `gofmt`, Go tests и cross-build.
2. Полные TypeScript tests/typecheck/build.
3. VSIX/package/install dry-run и artifact census.
4. Обновить README, русское сравнение источников и checkpoint.
5. Просмотреть diff, закоммитить scoped files и push `main`.
