# Windows elevated sandbox для NexusCode

Дата: 2026-07-30
Статус: реализовано и проверено на Windows Server 2022 x64; arm64 cross-built

## Цель

Windows-версия NexusCode должна обеспечивать тот же внешний контракт
`@nexuscode/sandbox`, что macOS Seatbelt и Linux bubblewrap/seccomp, но
использовать нативные механизмы Windows. Любая невозможность доказать активацию
защиты завершает запуск до старта недоверенной команды.

NexusCode остаётся самостоятельным продуктом: имена, протокол, каталоги,
установщик, диагностика и UX принадлежат NexusCode. Security-модель и часть
низкоуровневых решений адаптируются из Apache-2.0 реализации
`openai/codex/codex-rs/windows-sandbox-rs`; атрибуция сохраняется в исходниках и
`THIRD_PARTY_NOTICES.md`.

## Инварианты

1. Для запуска используются отдельные локальные учётные записи
   `NexusSandboxOffline` и `NexusSandboxOnline`, а не интерактивный пользователь.
2. Restricted token отключает максимальные привилегии и включает restricting
   SID только активных файловых полномочий текущего запроса.
3. ACL выдаются стабильным capability SID для канонического workspace/root.
   Старый workspace-capability не попадает в токен нового запуска.
4. Offline identity блокируется двумя независимыми persistent-слоями:
   user-scoped Windows Firewall rules и прямыми WFP block-фильтрами на
   `ALE_AUTH_CONNECT`/`ALE_RESOURCE_ASSIGNMENT` для IPv4/IPv6. Setup и
   `--audit` проверяют MpsSvc, включённые профили, разрешение локальных правил,
   точные rule names/action/direction/SID, а также provider, sublayer, filter
   shape и целевой offline SID. Online identity используется только при
   `network: "enabled"`.
5. Процесс входит в Job Object атомарно через
   `PROC_THREAD_ATTRIBUTE_JOB_LIST`; job закрывает всё дерево при завершении
   broker, отмене или таймауте.
6. Наследуются только stdin/stdout/stderr. Секреты setup, token handles и
   служебные handles не наследуются.
7. Командная строка строится по правилам `CommandLineToArgvW`, окружение
   сортируется без учёта регистра и передаётся Unicode-блоком.
8. Setup и refresh ACL выполняются до сообщения `started`. Ошибка setup,
   firewall, token, ACL, job или spawn публикуется как `sandbox_setup_failed` либо
   `spawn_failed`; несандбоксированный fallback запрещён.
9. `--check` проверяет не только наличие EXE, но marker/version, identities,
   защищённые credentials, firewall policy и пробный restricted spawn.
10. Все пути канонизируются, сравниваются без учёта регистра и обязаны быть
    абсолютными Windows-путями; UNC и reparse-point границы проверяются до ACL.

## Компоненты

### Внешний broker

`nexus-sandbox.exe` принимает существующий JSON protocol v1 через stdin и
пишет stdout/stderr команды напрямую. Control-сообщения `started`, `exited` и
`error` остаются совместимыми с CLI, server и VS Code.

Служебные команды:

- `--version` — версия и protocol;
- `--setup` — интерактивно запускает один UAC elevation и ожидает результат;
- `--setup-elevated` — внутренний административный entrypoint;
- `--check` — полная read-only проверка готовности и restricted self-probe;
- `--status-json` — машинно-читаемое состояние для doctor/UI.

### Setup

Setup создаёт или обновляет две локальные учётные записи со случайными
паролями, скрывает их из Windows sign-in UI, проверяет membership в отдельной
группе, получает SID, защищает credentials через DPAPI текущего пользователя и
атомарно пишет marker с `setupVersion`.

Для offline SID создаётся fail-closed набор persistent Windows Firewall rules:
общий outbound guard и явные non-loopback/loopback TCP/UDP блокировки. Поскольку
Windows Firewall на Windows Server не гарантировал блокировку loopback для
локальной identity, setup также транзакционно устанавливает Nexus-owned WFP
provider/sublayer и четыре user-scoped block-фильтра: connect и resource
assignment для IPv4/IPv6. Ревизия network policy входит в setup marker, поэтому
старое состояние автоматически определяется как `stale`. Частично применённый
setup невалиден; повторный setup идемпотентно ремонтирует identities и оба слоя
policy.

### Filesystem

Capability SID генерируются криптографически и сохраняются по ключу
канонического root. Setup-refresh добавляет:

- read ACE для sandbox identities и restricting capability на readable roots;
- modify ACE для активного write capability на writable roots;
- deny ACE для sandbox identities на `deniedRoots`;
- read-only roots никогда не получают write ACE.

Токен включает только capability SID активных roots, поэтому накопленные ACL
других workspace не расширяют текущий запуск.

### Process

Broker запускает доверенный runner через `CreateProcessWithLogonW`, а runner
проверяет свой SID, удаляет request-файл до старта недоверенного кода и создаёт
restricted primary token, private desktop, stdio-файлы и Job Object с
`KILL_ON_JOB_CLOSE`. Job и явный handle allow-list передаются в
`STARTUPINFOEXW` до `CreateProcessAsUserW`.

Отмена сначала завершает job, затем ждёт процесс. Exit code и timeout
переводятся в существующий control protocol. Отдельный runner-service не
нужен: broker не передаёт child ни credentials, ни служебные handles.

### Поставка

Windows x64 и arm64 cross-build выполняется одним release/CI job; x64 helper
затем запускается на `windows-2022`, а arm64 остаётся compile/package target до
появления доступного arm64 runner.
Release job публикует `nexus-sandbox.exe` и SHA-256 manifest. Установщик и VSIX
берут только артефакт подходящих platform/arch, проверяют hash, `--version` и
`--check`; пользователю готового release не нужен Go/Rust toolchain. Локальный
`./install.sh` из source checkout остаётся contributor-build и требует Go,
потому что намеренно собирает доверенный helper из зафиксированных исходников.

Локальная cross-build проверяет PE-артефакт и platform-neutral тесты. Она не
подменяет Windows smoke suite.

## UX

- One-install на Windows вызывает `--setup` один раз и показывает системный UAC.
- `nexus doctor` различает `not-installed`, `stale`, `ready` и `broken`,
  печатает конкретное восстановление.
- VS Code показывает тот же статус и команду «Настроить песочницу»; любой
  локальный tool-spawn до успешного setup завершается fail-closed внутри общего
  native broker, без скрытого запуска напрямую.
- Отказ UAC не переключает NexusCode в unsandboxed mode. Пользователь может
  отдельно одобрить уже существующую одноразовую эскалацию конкретной команды.

## Проверка

Platform-neutral тесты проверяют protocol, canonical root/capability mapping,
setup-marker migration, command-line quoting и fail-closed state machine.
Windows Server 2022 x64 smoke проверяет разрешённую workspace-запись через
`cmd.exe`, PowerShell 7 и Windows PowerShell 5.1, запрет outside write, переход
workspace-write→read-only без наследования старого write capability,
запрещённую запись в `.git`, явный deny-read root, раздельные offline/online
identities на локальном HTTP-сервере, блокировку loopback прямыми WFP-фильтрами
и уничтожение grandchild по timeout через Job Object. Platform-neutral tests
отдельно проверяют строгий marker, stale capability, protocol и начало
`started` только после реального native spawn. Повреждённые DPAPI credentials
остаются следующим Windows-host negative test и не считаются уже доказанными.

x64 runtime boundary доказан CI. Windows arm64 helper имеет те же исходники,
проходит cross-build/vet и поставляется с SHA-256 manifest, но runtime parity
arm64 не заявляется до появления настоящего arm64 runner.

Доказательство x64:
[Native sandbox run 30558346395](https://github.com/we11as22/NexusCode/actions/runs/30558346395).
