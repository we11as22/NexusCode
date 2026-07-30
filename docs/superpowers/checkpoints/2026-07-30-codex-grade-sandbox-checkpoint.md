# Чекпоинт: Codex-grade OS sandbox в NexusCode

Дата проверки: 30 июля 2026 года.

## Что реализовано

NexusCode остаётся самостоятельным продуктом. Из Codex перенесена не
зависимость или брендинг, а модель исполнения: sandbox-first запуск,
fail-closed поведение, отдельное подтверждение точного повторного запуска вне
песочницы, защита процесса и единая граница между агентом и ОС.

Единый пакет `@nexuscode/sandbox` используется локальными host-реализациями CLI,
VS Code и NexusCode Server. Через тот же broker проходят:

- foreground и background Bash модели;
- командные plugin hooks;
- остановка фоновых process groups;
- точный одноразовый retry после классифицированного sandbox denial.

Обычное правило `allow` разрешает инструменту попытку запуска в песочнице. Оно
не превращается в постоянное разрешение на unsandboxed execution. Повтор вне
песочницы требует отдельной эфемерной capability, связанной с session, turn,
tool call и точной командой; capability нельзя сохранить как `always allow`,
повторить или использовать для другой команды.

Native helper использует версионированный control protocol, отделяет control
channel от stdout/stderr команды, очищает loader-injection переменные и
проверяет execution identity. Для дочернего процесса запрещён core dump;
macOS также включает `PT_DENY_ATTACH`, Linux — `no_new_privs`, dumpable=0 и
parent-death signal.

## Поддержка платформ

| Платформа | Backend | Доказанный статус |
|---|---|---|
| macOS arm64 | Seatbelt через фиксированный `/usr/bin/sandbox-exec` | Проверен end-to-end на текущем Mac: запись в workspace разрешена; запись вне workspace и в защищённые `.git/.nexus/.agents/.codex` запрещена; политика наследуется дочерним shell; сеть по умолчанию закрыта; явное сетевое и Unix-socket разрешение работает |
| macOS x64 | Seatbelt | Код и cross-build готовы; реальный x64 host в этом чекпоинте не использовался |
| Linux arm64/x64 | bundled Bubblewrap 0.11.2, seccomp, namespaces | Оба статических ELF cross-build проходят; TypeScript policy/protocol покрыты тестами. Реальный Linux host ещё не прогнан, поэтому production parity не заявляется |
| Windows arm64/x64 | отдельные offline/online identities, capability ACL, restricted token, private desktop, handle allow-list, Job Object, user-scoped Windows Firewall | Backend реализован и PE helper cross-build проходит для обеих архитектур. Windows 2022 workflow содержит setup/check и безопасный smoke workspace/outside write, write→read-only, protected/denied roots, offline/online network и kill всего process tree. Реальный результат workflow ещё нужен; скрытого unsandboxed fallback нет |

## Интеграция UI

CLI показывает sandbox denial как отдельное основание эскалации и спрашивает
разрешение только на точный one-shot retry. VS Code получает тот же
структурированный approval payload и показывает отдельную карточку, не смешивая
её с обычным подтверждением инструмента. Server проводит локальные команды через
тот же broker.

Проверка свежего VSIX в настоящем Cursor нашла и исправила двойной ready
handshake: `getState` и legacy `webviewDidLaunch` раньше оба повторно проигрывали
cached snapshots. Теперь первый сигнал переводит webview в ready и делает один
replay, второй совместимый alias игнорируется; последующие явные `getState`
остаются рабочими. После установки финального VSIX в
`/Users/mac/Projects/nexus/test` UI отрисовал сохранённую сессию, composer,
режим и preset; лог Extension Host содержит один replay и не содержит ошибок
NexusCode.

Горячая клавиша открытия панели больше не перекрывает стандартный New Window:
`Cmd+Alt+N` на macOS и `Ctrl+Alt+N` на Windows/Linux. Повторное нажатие
фокусирует существующую вкладку NexusCode.

## Проверки этого чекпоинта

- полный monorepo test: 1902 passed, 2 host-native skipped в обычном вложенном
  sandbox-прогоне;
- VS Code: 260/260;
- core: 1115/1115;
- CLI: 178 passed, 2 skipped; native CLI smoke отдельно прошёл;
- server: 105/105;
- webview: 84/84;
- state: 119/119;
- sandbox: 41/41;
- runtime/installer/storage: 13/13;
- typecheck: все семь исполняемых workspace-пакетов;
- deterministic feature census: 247 функций, проверка актуальности прошла;
- MCP/skills workflow: OK;
- production build: OK;
- VSIX: 170 файлов, 13.44 MB, `vendor/darwin-arm64/nexus-sandbox` и
  `SHA256SUMS` присутствуют;
- one-command installer: dependency install, CLI build/install, extension
  build/package/install и `doctor` прошли;
- финальный `nexus doctor --cwd /Users/mac/Projects/nexus/test` вне вложенной
  песочницы: `nexus-sandbox 0.1.0 protocol=1`, backend `seatbelt ready`.

## Что ещё нельзя назвать готовым паритетом

1. Нужен реальный Linux host E2E, хотя policy, протокол и cross-build зелёные.
2. Нужен зелёный прогон добавленного workflow на настоящем Windows runner.
   Реализация backend и smoke suite готовы, но macOS cross-build не является
   доказательством Windows runtime.
3. Доверенный JavaScript plugin worker изолирован процессом и capability
   проверками, однако ещё не помещён в отдельный kernel sandbox с полностью
   декларативным ABI.

Поэтому на текущем macOS можно утверждать end-to-end готовность sandbox broker
для CLI, VS Code и server. Утверждать идентичный runtime-паритет на всех ОС до
Linux/Windows host-проверок нельзя.
